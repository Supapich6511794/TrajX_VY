"""Integration tests for the two arrival flows in api.server.

An arrival off an OPEN STAR (one ending in a VM "expect vectors" leg) can be
flown two ways, and which one is a controller decision:

  NO CONFLICT  the aircraft stays on the published path — the STAR to its last
               fix, then the approach from its IAF:
                   ... YS406 -> YS501 -> YS720 -> YS715 -> YS710 -> FAF -> MAPt

  CONFLICT     it leaves the procedure at the STAR's end, holds the published
               heading until the spacing is there, then turns to intercept the
               extended centreline:
                   ... YS406 -> YS501 -> TURN -> INTC -> YS710 -> FAF -> MAPt

Flow 1 is the default; flow 2 is opt-in via ``vector_to_final`` (or implicitly
by asking to extend the downwind). Every published VY STAR is closed, so the
open arrivals here are a SYNTHETIC in-memory fixture laid out around VYYY's
real runway 03/21 (see ``_synthetic_open_star``); the real, closed VYYY STARs
and approaches stay loaded alongside it. The pure geometry is tested in
``test_vectors``.
"""

from __future__ import annotations

import math
from datetime import datetime

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

import api.server as server  # noqa: E402
import trajectory_sim.navdata as navdata_mod  # noqa: E402
from api.server import app  # noqa: E402
from trajectory_sim.geodesy import haversine_distance  # noqa: E402
from trajectory_sim.tests._synthetic_open_star import (  # noqa: E402
    RW03_THRESHOLD,
    build_navdata,
)

BASE = {
    "source": "fpl",
    "callsign": "UBA100",
    "actype": "A320",
    "adep": "VYMD",
    "ades": "VYYY",
    "route": "DOGIP DCT MOXIS B463 IKUGI",
    "eobt": "2025-12-23T02:00",
    "rfl": 320,
    "star": "OPNE1C",
    "star_transition": "YS301",
    "star_runway": "RW21",
    "approach": "R21-V",
}
#: R21-V's published approach, outermost first, with each fix's distance from
#: the threshold along the centreline.
R21_ENTRY_NM = {"YS720": 20.0, "YS715": 15.0, "YS710": 10.0}
#: OPNE1C's hand-over fix (the open STAR's last fix), and R21-V's FAF / MAPt.
HANDOVER = "YS501"
FAF_21, MAPT_21 = "YS705", "YS700"
#: A genuinely CLOSED arrival from the real VY data: OROM1A entered at NPT,
#: into the real R21 approach.
CLOSED = {
    "route": "DOGIP DCT NPT",
    "star": "OROM1A",
    "star_transition": "NPT",
    "star_runway": "RW21",
    "approach": "R21",
}


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> TestClient:
    """A TestClient whose navdata also carries the synthetic open arrivals."""
    nav = build_navdata(
        tmp_path_factory.mktemp("open_star"),
        sid_source=server._SID_SOURCE,
        star_source=server._STAR_SOURCE,
        approach_source=server._APPROACH_SOURCE,
        ils_source=server._ILS_SOURCE,
    )
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(server, "_navdata", lambda: nav)
        mp.setitem(navdata_mod._RUNWAY_ENDS, ("VYYY", "RW03"), RW03_THRESHOLD)
        yield TestClient(app)


class TestNoConflictFlowIsTheDefault:
    """With nothing to resolve, an open-STAR arrival flies the FULL published
    path. Vectoring is a controller action, not a property of the procedure —
    generating a plan must not silently take the aircraft off the chart."""

    def test_the_whole_published_procedure_is_flown(
        self, client: TestClient
    ) -> None:
        idents = _idents(_generate(client))
        assert HANDOVER in idents  # the STAR's last fix
        tail = idents[idents.index(HANDOVER) + 1 :]
        assert tail == ["YS720", "YS715", "YS710", FAF_21, MAPT_21]

    def test_no_vector_legs_are_invented(self, client: TestClient) -> None:
        idents = _idents(_generate(client))
        assert "TURN" not in idents
        assert "INTC" not in idents

    def test_asking_for_vectors_on_a_CLOSED_star_is_refused_with_a_warning(
        self, client: TestClient
    ) -> None:
        """There is no published heading to hold, so the request cannot be
        honoured — and must say so rather than being ignored in silence."""
        # A real VY arrival: every VY STAR is fix-terminated (no VM leg).
        payload = _generate(client, **CLOSED, vector_to_final=True)
        idents = _idents(payload)
        assert "TURN" not in idents and "INTC" not in idents
        assert idents[-1] not in ("TURN", "INTC")
        assert any(
            "does not end in radar vectors" in w for w in payload["warnings"]
        )


def _generate(client: TestClient, **overrides: object) -> dict:
    body = {**BASE, **overrides}
    resp = client.post("/api/generate", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _idents(payload: dict) -> list[str]:
    return [w["ident"] for w in payload.get("route", [])]


def _distance_nm(payload: dict) -> float:
    stats = payload["stats"]
    return float(stats.get("distance_nm", stats.get("distanceNm")))


class TestConflictFlowIsVectored:
    """`vector_to_final` is the conflict branch: leave the procedure at the
    STAR's end, hold the published heading, then intercept."""

    def test_the_route_flies_the_vector_legs_after_the_STAR(
        self, client: TestClient
    ) -> None:
        idents = _idents(_generate(client, vector_to_final=True))
        # The STAR's vector termination, then the two vector legs.
        assert HANDOVER in idents
        i = idents.index(HANDOVER)
        assert idents[i + 1 : i + 3] == ["TURN", "INTC"]

    def test_it_cuts_the_approach_at_the_intercept_not_at_the_IAF(
        self, client: TestClient
    ) -> None:
        """Vectoring terminates when the aircraft turns onto final (§8.9.4.1),
        so the IAF entry is never flown. But R21-V is a straight-in procedure —
        YS720/YS715/YS710/FAF all sit on one centreline — so a fix INSIDE the
        join is overflown and keeps its crossing minimum."""
        idents = _idents(_generate(client, vector_to_final=True))
        assert FAF_21 in idents  # the R21-V FAF
        assert "INTC" in idents
        # Joining ~12 NM out: YS710 (10 NM) is flown, YS715 (15) and YS720 (20)
        # belong to the entry that was replaced by vectors.
        assert "YS710" in idents
        assert idents.index("YS710") > idents.index("INTC")
        for skipped in ("YS720", "YS715"):
            assert skipped not in idents

    def test_a_longer_downwind_keeps_MORE_of_the_approach(
        self, client: TestClient
    ) -> None:
        """Joining further out means overflying more published fixes, so the
        cut has to move with the intercept rather than being fixed at the FAF."""
        idents = _idents(_generate(client, extend_downwind_nm=12))
        assert "YS715" in idents  # 15 NM out, now inside the ~18 NM join
        assert "YS710" in idents
        assert "YS720" not in idents  # 20 NM, still outside

    def test_the_arrival_still_ends_at_the_runway(
        self, client: TestClient
    ) -> None:
        idents = _idents(_generate(client, vector_to_final=True))
        assert idents[-1] == MAPT_21  # the MAPt, on the RW21 threshold

    def test_no_warning_is_raised_when_the_join_succeeds(
        self, client: TestClient
    ) -> None:
        warnings = _generate(client, vector_to_final=True).get("warnings") or []
        assert not any("no path could be planned" in w for w in warnings)


class TestDownwindExtension:
    def test_extending_the_downwind_lengthens_the_flown_trajectory(
        self, client: TestClient
    ) -> None:
        """`extend_downwind_nm` is the arrival sequencer's spacing deficit; it
        has to show up as real extra distance, or the fix buys nothing."""
        base = _distance_nm(_generate(client, vector_to_final=True))
        for want in (5.0, 10.0):
            got = _distance_nm(_generate(client, extend_downwind_nm=want))
            # Turn smoothing shaves the corners, so the delivered distance runs
            # a little under the request — but it must be most of it, and it
            # must never overshoot.
            delivered = got - base
            assert want * 0.85 <= delivered <= want + 0.1

    def test_the_extension_leaves_the_STAR_and_vector_legs_in_place(
        self, client: TestClient
    ) -> None:
        """Stretching the downwind must not re-route the arrival: the STAR and
        the two vector legs keep their identity and order. Only the geometry
        moves — and, since the join lands further out, the approach tail can
        pick up a published fix it now overflies (covered separately)."""
        plain = _idents(_generate(client, vector_to_final=True))
        stretched = _idents(_generate(client, extend_downwind_nm=12))
        head = plain[: plain.index("INTC") + 1]
        assert stretched[: len(head)] == head
        assert stretched[-2:] == plain[-2:]  # FAF, MAPt

    def test_a_longer_downwind_turns_further_from_the_field(
        self, client: TestClient
    ) -> None:
        def turn_point(ext: float) -> tuple[float, float]:
            route = _generate(
                client, vector_to_final=True, extend_downwind_nm=ext
            )["route"]
            w = next(w for w in route if w["ident"] == "TURN")
            return w["lat"], w["lon"]

        near = turn_point(0)
        far = turn_point(12)
        # RW21 arrivals hold a 034° downwind, so a longer one turns further
        # north (and east).
        assert far[0] > near[0]
        assert far[1] > near[1]


class TestOppositeRunwayDirection:
    """The …1D arrivals land NORTH-EASTBOUND on RW03 and hold heading 214 —
    the mirror of the RW21 case. Every sign in the intercept geometry flips, so
    a solver that only ever ran one direction would look fine and be wrong."""

    NORTH = {
        "star_transition": None,
        "star_runway": "RW03",
        "approach": "R03-V",
    }
    #: R03-V's FAF and MAPt.
    FAF, MAPT = "YS605", "YS600"

    @pytest.mark.parametrize("star", ["OPNN1D", "OPNE1D"])
    def test_no_conflict_flies_the_published_R03_approach(
        self, client: TestClient, star: str
    ) -> None:
        idents = _idents(_generate(client, **self.NORTH, star=star))
        assert "TURN" not in idents and "INTC" not in idents
        # Reaches the runway via the published approach fixes.
        assert idents[-3:] == [self.FAF, "YS603", self.MAPT]

    @pytest.mark.parametrize(
        "star,handover", [("OPNN1D", "YS503"), ("OPNE1D", "YS504")]
    )
    def test_the_conflict_flow_vectors_from_the_chart_named_fix(
        self, client: TestClient, star: str, handover: str
    ) -> None:
        idents = _idents(
            _generate(client, **self.NORTH, star=star, vector_to_final=True)
        )
        assert handover in idents
        i = idents.index(handover)
        assert idents[i + 1 : i + 3] == ["TURN", "INTC"]

    @pytest.mark.parametrize("star", ["OPNN1D", "OPNE1D"])
    def test_the_intercept_is_outside_the_FAF_landing_north(
        self, client: TestClient, star: str
    ) -> None:
        """Same §8.9.3.6 rule, opposite direction: established on the final
        approach track before the glide path."""
        payload = _generate(client, **self.NORTH, star=star, vector_to_final=True)
        route = {w["ident"]: (w["lat"], w["lon"]) for w in payload["route"]}
        thr = (RW03_THRESHOLD.lat, RW03_THRESHOLD.lon)
        nm = lambda p: math.hypot(  # noqa: E731
            (p[0] - thr[0]) * 60,
            (p[1] - thr[1]) * 60 * math.cos(math.radians(thr[0])),
        )
        icpt = nm(route["INTC"])
        faf = nm(route[self.FAF])
        assert icpt > faf, "intercept must sit outside the FAF"
        assert icpt - faf >= 1.9  # the established margin, allowing rounding

    @pytest.mark.parametrize("star", ["OPNN1D", "OPNE1D"])
    def test_extending_the_downwind_works_landing_north_too(
        self, client: TestClient, star: str
    ) -> None:
        base = _distance_nm(
            _generate(client, **self.NORTH, star=star, vector_to_final=True)
        )
        longer = _distance_nm(
            _generate(client, **self.NORTH, star=star, extend_downwind_nm=8)
        )
        assert 8 * 0.85 <= longer - base <= 8 + 0.1


class TestArrivalClearanceIsRecorded:
    """An open-STAR chart prints, against its hand-over fixes:

        "Do not proceed Instrument Approach Procedure without ATC clearance."

    So neither flow is the aircraft navigating itself into the approach — both
    are clearances, and the generated flight has to record WHICH one it was
    flown under, or the data cannot be audited against the chart.
    """

    def _clearance(self, client: TestClient, **kw) -> str:
        return _generate(client, **kw)["meta"]["clearance"]

    def test_the_no_conflict_flow_records_a_direct_to_the_IAF(
        self, client: TestClient
    ) -> None:
        assert self._clearance(client) == "DIRECT YS720, CLEARED R21-V APPROACH"

    def test_the_conflict_flow_records_the_heading_and_the_fix(
        self, client: TestClient
    ) -> None:
        got = self._clearance(client, vector_to_final=True)
        assert got == "AFTER YS501 MAINTAIN HEADING 034, VECTORS R21-V"

    def test_the_heading_is_MAGNETIC_as_the_chart_prints_it(
        self, client: TestClient
    ) -> None:
        """The geometry is solved in TRUE (033 here, 1°W variation); the
        clearance a controller reads is the published magnetic course, 034."""
        payload = _generate(client, vector_to_final=True)
        assert "034" in payload["meta"]["clearance"]
        assert payload["meta"]["vector_heading_deg"] == pytest.approx(33.0, abs=0.2)

    @pytest.mark.parametrize(
        "star,fix", [("OPNN1C", "YS502"), ("OPNW1C", "YS502"), ("OPNS1C", "YS501")]
    )
    def test_the_clearance_names_that_STARs_own_handover_fix(
        self, client: TestClient, star: str, fix: str
    ) -> None:
        got = self._clearance(
            client, star=star, star_transition=None, vector_to_final=True
        )
        assert got == f"AFTER {fix} MAINTAIN HEADING 034, VECTORS R21-V"

    def test_landing_north_records_the_214_heading(
        self, client: TestClient
    ) -> None:
        got = self._clearance(
            client, star="OPNN1D",
            star_transition=None, star_runway="RW03", approach="R03-V",
            vector_to_final=True,
        )
        assert got == "AFTER YS503 MAINTAIN HEADING 214, VECTORS R03-V"

    def test_the_clearance_is_written_into_the_downloads(
        self, client: TestClient
    ) -> None:
        """It has to survive into the exported files, not just the API reply —
        that is what makes a generated bank auditable after the fact."""
        key = _generate(client, vector_to_final=True)["flight_key"]
        csv = client.get(f"/api/download/{key}.csv").text
        assert "CLEARANCE: AFTER YS501 MAINTAIN HEADING 034, VECTORS R21-V" in csv
        gj = client.get(f"/api/download/{key}.geojson").json()
        route = next(
            f for f in gj["features"]
            if f["properties"].get("feature_type") == "route"
        )
        assert route["properties"]["clearance"].startswith("AFTER YS501")


class TestTacticalExtension:
    """`extend_downwind_nm` as an INSTRUCTION, not a re-plan.

    An aircraft told to extend its downwind is already at the hand-over fix.
    Re-planning the flight from EOBT with a longer route moves top-of-descent,
    so the aircraft passes that fix thousands of feet higher and flies the extra
    track in the cruise band — the delay the extension was meant to buy is then
    mostly lost.
    """

    def _at(self, payload: dict, ident: str) -> dict:
        route = {w["ident"]: (w["lat"], w["lon"]) for w in payload["route"]}
        la, lo = route[ident]
        return min(
            payload["points"],
            key=lambda p: (p["lat"] - la) ** 2 + (p["lon"] - lo) ** 2,
        )

    def test_the_flight_before_the_handover_fix_is_untouched(
        self, client: TestClient
    ) -> None:
        plain = _generate(client, vector_to_final=True, tactical_extend=True)
        long = _generate(client, extend_downwind_nm=12, tactical_extend=True)
        a, b = self._at(plain, HANDOVER), self._at(long, HANDOVER)
        assert a["altitude_ft"] == pytest.approx(b["altitude_ft"], abs=1.0)
        assert a["epoch_ts"] == b["epoch_ts"]
        assert a["gs_kt"] == pytest.approx(b["gs_kt"], abs=0.5)

    def test_a_REPLAN_moves_the_handover_state_which_is_why_it_is_wrong(
        self, client: TestClient
    ) -> None:
        """The behaviour the tactical mode exists to avoid — recorded so the
        difference is visible rather than folklore."""
        plain = _generate(client, vector_to_final=True)
        replanned = _generate(client, extend_downwind_nm=12)
        a, b = self._at(plain, HANDOVER), self._at(replanned, HANDOVER)
        assert abs(b["altitude_ft"] - a["altitude_ft"]) > 1000

    def test_the_extension_buys_the_delay_it_should(
        self, client: TestClient
    ) -> None:
        """12 NM of extra track at ~200 kt terminal speed is ~3.5 min. A re-plan
        flies it at cruise speed and buys well under half of that."""
        plain = _generate(client, vector_to_final=True, tactical_extend=True)
        long = _generate(client, extend_downwind_nm=12, tactical_extend=True)
        extra_min = long["stats"]["time_minutes"] - plain["stats"]["time_minutes"]
        extra_nm = long["stats"]["distance_nm"] - plain["stats"]["distance_nm"]
        assert extra_nm == pytest.approx(12, abs=1.5)
        # Distance over time for the added track = a terminal-area speed.
        marginal_kt = extra_nm / extra_min * 60
        assert 150 <= marginal_kt <= 260, f"{marginal_kt:.0f} kt"

    def test_it_still_lands_on_the_runway(self, client: TestClient) -> None:
        long = _generate(client, extend_downwind_nm=12, tactical_extend=True)
        assert _idents(long)[-1] == MAPT_21
        assert long["points"][-1]["altitude_ft"] < 200

    def test_the_clock_never_runs_backwards(self, client: TestClient) -> None:
        pts = _generate(
            client, extend_downwind_nm=12, tactical_extend=True
        )["points"]
        stamps = [p["epoch_ts"] for p in pts]
        assert stamps == sorted(stamps)

    def test_it_says_what_it_did(self, client: TestClient) -> None:
        payload = _generate(client, extend_downwind_nm=12, tactical_extend=True)
        assert payload["meta"]["tactical_handover"] == HANDOVER
        assert payload["meta"]["tactical_extend_nm"] == pytest.approx(12)
        assert any(f"tactically from {HANDOVER}" in w for w in payload["warnings"])


class TestExtendEndpoint:
    """`/api/extend/{flight_key}` — issuing a downwind extension by flight key.

    The browser cannot rebuild the originating request from a trajectory (the
    resolved route is a fix list, not the Item-15 string, and a vectored
    arrival's TURN/INTC are not routable input), so the server keeps it.
    """

    def test_extends_a_flight_from_its_key_alone(
        self, client: TestClient
    ) -> None:
        key = _generate(client)["flight_key"]
        resp = client.post(f"/api/extend/{key}", json={"extend_nm": 6})
        assert resp.status_code == 200, resp.text
        out = resp.json()
        assert out["meta"]["tactical_extend_nm"] == pytest.approx(6)
        assert out["meta"]["tactical_handover"] == HANDOVER
        assert "TURN" in _idents(out) and "INTC" in _idents(out)

    def test_a_bigger_extension_flies_further(self, client: TestClient) -> None:
        key = _generate(client)["flight_key"]
        small = client.post(f"/api/extend/{key}", json={"extend_nm": 2}).json()
        big = client.post(f"/api/extend/{key}", json={"extend_nm": 12}).json()
        assert _distance_nm(big) > _distance_nm(small) + 5

    def test_re_extending_uses_the_ORIGINAL_request_not_the_last_result(
        self, client: TestClient
    ) -> None:
        """Each call must start from the flight as filed. If the endpoint
        extended whatever it produced last, issuing 6 NM twice would silently
        give 12 — a controller re-issuing the same instruction would double it.
        """
        key = _generate(client)["flight_key"]
        first = client.post(f"/api/extend/{key}", json={"extend_nm": 6}).json()
        again = client.post(f"/api/extend/{key}", json={"extend_nm": 6}).json()
        assert _distance_nm(again) == pytest.approx(_distance_nm(first), abs=0.05)

    def test_an_unknown_flight_key_is_refused(self, client: TestClient) -> None:
        assert client.post(
            "/api/extend/NOPE_20251223T0200Z", json={"extend_nm": 6}
        ).status_code == 404

    def test_a_traversal_attempt_is_refused(self, client: TestClient) -> None:
        assert client.post(
            "/api/extend/..%2F..%2Fetc", json={"extend_nm": 6}
        ).status_code in (400, 404)

    def test_the_download_serves_the_extended_path(
        self, client: TestClient
    ) -> None:
        """The export cache is keyed by flight_key, so it must end up holding
        the EXTENDED flight — otherwise the download hands back the pre-fix
        path after the controller has issued the instruction."""
        key = _generate(client)["flight_key"]
        plain_csv = client.get(f"/api/download/{key}.csv").text
        client.post(f"/api/extend/{key}", json={"extend_nm": 12})
        after_csv = client.get(f"/api/download/{key}.csv").text
        assert after_csv != plain_csv
        assert "CLEARANCE: AFTER YS501 MAINTAIN HEADING 034" in after_csv


class TestClosedStarUnaffected:
    def test_a_closed_STAR_still_flies_its_approach_from_the_IAF(
        self, client: TestClient
    ) -> None:
        """A real, closed VY arrival: the regression guard is that
        non-vectored arrivals are untouched by the open-STAR machinery."""
        idents = _idents(_generate(client, **CLOSED))
        # The STAR delivers the aircraft to the approach (PAKSU, on R21's BAGOO
        # transition) and the real R21 flies it to its MAPt on the threshold.
        assert idents[-4:] == ["PAKSU", "HLEGU", "SULAP", "RW21"]
        # No stray vector fix left over from another arrival.
        assert "TURN" not in idents and "INTC" not in idents

    def test_extend_downwind_is_ignored_without_a_vector_leg(
        self, client: TestClient
    ) -> None:
        """A closed arrival has no downwind to stretch, so the parameter must
        be a no-op rather than silently distorting the path."""
        plain = _distance_nm(_generate(client, **CLOSED, extend_downwind_nm=0))
        asked = _distance_nm(_generate(client, **CLOSED, extend_downwind_nm=15))
        assert "TURN" not in _idents(_generate(client, **CLOSED))
        assert asked == pytest.approx(plain, abs=0.01)


class TestTheResponseSaysWhichSidWasFlown:
    """The meta echoes the DEPARTURE procedure as well as the arrival one.

    A flight flown on a SID is not the same climb-out as a DCT off the
    aerodrome — it turns and levels where the chart says to, so it enters the
    en-route structure at a different point and at a different time. Anything
    reading a generated flight back (the dummy-file generators, a re-import of
    a downloaded flight) therefore has to be able to see which it was; the
    response used to carry the STAR and the approach but silently drop the SID.
    """

    def test_the_sid_and_its_runway_come_back_in_the_meta(
        self, client: TestClient
    ) -> None:
        meta = _generate(client, sid="DOGI1S")["meta"]
        assert meta["sid"] == "DOGI1S"
        assert meta["dep_rwy"] == "RW17"

    def test_the_meta_matches_the_path_actually_flown(
        self, client: TestClient
    ) -> None:
        payload = _generate(client, sid="DOGI1S")
        idents = _idents(payload)
        # The route starts at the departure runway the meta names, then flies
        # the SID's own fixes — the label is not decoration.
        assert idents[0] == payload["meta"]["dep_rwy"]
        assert idents[1:4] == ["MDS02", "ZIDAW", "DOGIP"]

    def test_no_sid_asked_for_means_no_sid_claimed(
        self, client: TestClient
    ) -> None:
        meta = _generate(client)["meta"]
        assert meta["sid"] is None
        # A runway is still flown — picked by direction (DOGIP lies south of
        # VYMD, so RW17) — but it is a runway, not a SID.
        assert meta["dep_rwy"] == "RW17"
        assert meta["dep_trajectory_source"] == "RUNWAY_HEURISTIC"


def _alt_at(payload: dict, ident: str) -> float:
    """Altitude of the sample nearest the named route fix."""
    w = next(x for x in payload["route"] if x["ident"] == ident)
    p = min(
        payload["points"],
        key=lambda q: (q["lat"] - w["lat"]) ** 2 + (q["lon"] - w["lon"]) ** 2,
    )
    return float(p["altitude_ft"])


def _nm(a: dict, b: dict) -> float:
    return math.hypot(
        (a["lat"] - b["lat"]) * 60,
        (a["lon"] - b["lon"]) * 60 * math.cos(math.radians(a["lat"])),
    )


class TestTheAssignedHeadingIsFlownLEVEL:
    """A radar heading comes with no descent clearance.

    An open-STAR chart note is a heading and nothing else — "After YS501,
    maintain heading 034 or as directed by ATC" — and Doc 4444 §8.9.4.2 keeps
    the aircraft at its last assigned level until it is established. Carrying
    the STAR's descent on down an open-ended downwind is the wrong shape, and
    it gets worse the further the downwind is extended for spacing: the delay
    is supposed to cost track miles, not altitude.
    """

    def test_the_downwind_is_flown_level(self, client: TestClient) -> None:
        p = _generate(client, vector_to_final=True)
        assert _alt_at(p, "TURN") == pytest.approx(_alt_at(p, HANDOVER), abs=1.0)

    def test_it_stays_level_however_far_the_downwind_is_extended(
        self, client: TestClient
    ) -> None:
        # The whole point: 12 NM of extra track must not become 12 NM of extra
        # descent. Both extensions leave the aircraft at the SAME level.
        short = _generate(client, vector_to_final=True, extend_downwind_nm=4)
        long = _generate(client, vector_to_final=True, extend_downwind_nm=12)
        assert _alt_at(short, "TURN") == pytest.approx(
            _alt_at(short, HANDOVER), abs=1.0
        )
        assert _alt_at(long, "TURN") == pytest.approx(
            _alt_at(long, HANDOVER), abs=1.0
        )

    def test_it_is_still_above_the_handover_fix_s_published_minimum(
        self, client: TestClient
    ) -> None:
        # OPNE1C codes YS501 at or above 5000 ft; levelling off must not be an
        # excuse to sit below the published constraint.
        p = _generate(client, vector_to_final=True)
        assert _alt_at(p, HANDOVER) >= 5000.0
        assert _alt_at(p, "TURN") >= 5000.0

    def test_the_altitude_comes_off_on_the_BASE_leg_at_a_flyable_gradient(
        self, client: TestClient
    ) -> None:
        """What the downwind no longer gives away has to be lost on the base.

        If that made the base leg unflyable, levelling would just be moving the
        error rather than fixing it — so the gradient is the thing to assert,
        not merely that the numbers changed.
        """
        p = _generate(client, vector_to_final=True)
        turn = next(w for w in p["route"] if w["ident"] == "TURN")
        intc = next(w for w in p["route"] if w["ident"] == "INTC")
        drop = _alt_at(p, "TURN") - _alt_at(p, "INTC")
        grad = drop / _nm(turn, intc)
        assert drop > 0, "the base leg has to descend"
        assert grad < 700, f"base leg {grad:.0f} ft/NM is not flyable"

    def test_the_published_flow_is_untouched(self, client: TestClient) -> None:
        # No vectors, no levelling — the STAR's own descent profile stands.
        p = _generate(client)
        assert _alt_at(p, HANDOVER) > _alt_at(p, "YS720") > _alt_at(p, "YS715")


class TestTheHeadingIsQuotedAsTheChartPrintsIt:
    def test_the_meta_carries_BOTH_headings(self, client: TestClient) -> None:
        """The geometry needs true; an instruction needs magnetic. Publishing
        only the true course made the arrival panel read out "heading 033" for
        a chart that says 034."""
        meta = _generate(client, vector_to_final=True)["meta"]
        assert meta["vector_heading_mag_deg"] == pytest.approx(34.0, abs=0.1)
        assert meta["vector_heading_deg"] == pytest.approx(33.0, abs=0.2)

    def test_landing_north_publishes_214_magnetic(self, client: TestClient) -> None:
        meta = _generate(
            client, star="OPNN1D",
            star_transition=None, star_runway="RW03", approach="R03-V",
            vector_to_final=True,
        )["meta"]
        assert meta["vector_heading_mag_deg"] == pytest.approx(214.0, abs=0.1)

    def test_a_closed_star_publishes_neither(self, client: TestClient) -> None:
        meta = _generate(client, **CLOSED)["meta"]
        assert meta["vector_heading_mag_deg"] is None
        assert meta["vector_heading_deg"] is None


class TestVectorTurnIsFlyable:
    """The downwind-to-base turn is a ~150 deg course reversal, and it has to be
    flown as a turn — a radius, at a bank a jet can hold.

    It used to come out as a spike on the map. Two things did it: the corner-cut
    cap kept tightening the arc without ever asking whether the result was still
    a turn (at 150 deg it forces R <= 0.175 NM, an 80 deg bank), and the invented
    TURN/INTC fixes had no published segment, so they were priced at CRUISE speed
    — a 6.3 NM radius for a turn flown at 190 kt over the outer marker.
    """

    #: The hardest a turn may be banked before it stops being one a jet flies.
    #: The engine's own floor is 35 deg; allow a little slack for the sampled
    #: track being quantised by the arc step.
    MAX_BANK_DEG = 40.0

    @staticmethod
    def _vector_samples(payload: dict, pad_nm: float = 8.0) -> list[dict]:
        """Just the samples flown around the vectoring pattern.

        The rest of the flight has its own turns — a SID can be tighter than
        anything here — and this is a test about the base turn.
        """
        route = {w["ident"]: w for w in payload["route"]}
        turn = route["TURN"]
        return [
            p
            for p in payload["points"]
            if haversine_distance(turn["lat"], turn["lon"], p["lat"], p["lon"])
            <= pad_nm
        ]

    @staticmethod
    def _worst_bank_deg(points: list[dict], span: int = 6) -> float:
        """Steepest sustained bank on the flown path.

        Measured over a WINDOW of samples: the reported track steps in whole arc
        increments, so differentiating adjacent samples reads the discretisation
        rather than the turn.
        """
        worst = 0.0
        for i in range(len(points) - span):
            t0 = datetime.fromisoformat(points[i]["epoch_ts"])
            t1 = datetime.fromisoformat(points[i + span]["epoch_ts"])
            dt = (t1 - t0).total_seconds()
            if dt <= 0:
                continue
            swept = abs(
                (points[i + span]["track_deg"] - points[i]["track_deg"] + 180.0)
                % 360.0
                - 180.0
            )
            rate = swept / dt
            if rate < 0.05:
                continue
            gs = sum(p["gs_kt"] or 0.0 for p in points[i : i + span]) / span
            radius_nm = gs / (20.0 * math.pi * rate)
            v = gs * 1852.0 / 3600.0
            worst = max(
                worst,
                math.degrees(math.atan(v * v / (9.80665 * radius_nm * 1852.0))),
            )
        return worst

    def test_the_base_turn_is_a_turn_not_a_spike(self, client: TestClient) -> None:
        payload = _generate(client, vector_to_final=True)
        idents = [w["ident"] for w in payload["route"]]
        assert "TURN" in idents and "INTC" in idents
        samples = self._vector_samples(payload)
        assert len(samples) > 10  # the pattern really is in there
        assert self._worst_bank_deg(samples) <= self.MAX_BANK_DEG

    @pytest.mark.parametrize("extend_nm", [0.0, 0.6, 3.0, 8.0])
    def test_extending_the_downwind_keeps_it_flyable(
        self, client: TestClient, extend_nm: float
    ) -> None:
        """The spacing fix lengthens the downwind, which moves the turn but must
        never sharpen it — this is the path the arrival panel previews."""
        payload = _generate(
            client,
            vector_to_final=True,
            tactical_extend=True,
            extend_downwind_nm=extend_nm,
        )
        assert self._worst_bank_deg(self._vector_samples(payload)) <= self.MAX_BANK_DEG
