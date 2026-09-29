"""Open-STAR classification and the vector-to-final path builder.

Every published VY STAR is closed, so the geometry cases use the synthetic
open arrival at VYYY RW21 from ``_synthetic_open_star``: the OPNE1C/OPNS1C
STARs end at YS501 on a published heading of 034°M, and the R21-V approach's
FAF is YS705, 4.9 NM out on the real runway's extended centreline.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from trajectory_sim.geodesy import compute_bearing, haversine_distance
from trajectory_sim.navdata import (
    AltitudeConstraint,
    AltitudeConstraintType,
    AmbiguousProcedureError,
    NavData,
    Procedure,
    ProcedureLeg,
    ProcedureType,
    RouteWaypoint,
    RunwayEnd,
    SpeedConstraint,
    SpeedConstraintType,
)

from trajectory_sim.tests._synthetic_open_star import build_navdata
from trajectory_sim.vectors import (
    MAX_INTERCEPT_DEG,
    faf_of,
    plan_open_star_join,
    vector_to_final,
)

_DATA = Path(__file__).resolve().parents[2] / "web" / "public" / "data"
_STAR_SRC = _DATA / "aixm_vy" / "star_waypoint.geojson"
_PBN_SRC = _DATA / "aixm_vy" / "pbn_waypoint.geojson"


@pytest.fixture(scope="module")
def nav_both(tmp_path_factory: pytest.TempPathFactory) -> NavData:
    """The real VY STARs/approaches plus the synthetic open arrivals."""
    return build_navdata(
        tmp_path_factory.mktemp("open_star_vectors"),
        sid_source=None,
        star_source=_STAR_SRC,
        approach_source=_PBN_SRC,
        ils_source=None,
    )


@pytest.fixture(scope="module")
def nav_star(nav_both: NavData) -> NavData:
    return nav_both

# --- VYYY RW21 (real runway) and the synthetic open arrival onto it -------
VYYY_RW21 = RunwayEnd(
    icao="VYYY",
    ident="RW21",
    lat=16.92373611,
    lon=96.14445556,
    magnetic_bearing=214.0,
    true_bearing=213.0,
)
YS501 = RouteWaypoint(ident="YS501", lat=17.158908, lon=96.409411)
FAF_NM = 4.9  # R21-V's FAF, on the extended centreline
VECTOR_HEADING_TRUE = 034.0 + (VYYY_RW21.true_bearing - VYYY_RW21.magnetic_bearing)


def _no_alt() -> AltitudeConstraint:
    return AltitudeConstraint(type=AltitudeConstraintType.NONE)


def _no_spd() -> SpeedConstraint:
    return SpeedConstraint(type=SpeedConstraintType.NONE)


def _leg(seq: int, term: str, ident: str | None, lat=None, lon=None, desc=None):
    return ProcedureLeg(
        seqno=seq,
        path_terminator=term,
        ident=ident,
        lat=lat,
        lon=lon,
        altitude=_no_alt(),
        speed=_no_spd(),
        desc_code=desc,
    )


def _star(*legs: ProcedureLeg) -> Procedure:
    return Procedure(
        airport="VYYY",
        name="OPNE1C",
        proc_type=ProcedureType.STAR,
        runway="RW21",
        transition=None,
        legs=tuple(legs),
    )


# --- B: open vs closed ----------------------------------------------------
class TestOpenStarClassification:
    def test_vm_terminated_star_is_open(self) -> None:
        """OPNE1C RW21: ... -> YS501 -> VM. The VM leg is coded with the
        AERODROME as its waypoint, which is why it must not be taken as a fix."""
        star = _star(
            _leg(10, "TF", "YS502", 17.264152, 96.242424),
            _leg(20, "TF", "YS501", 17.158908, 96.409411),
            _leg(30, "VM", "VYYY", 16.918806, 96.127921),
        )
        assert star.is_open is True
        assert star.vector_termination is not None
        assert star.vector_termination.path_terminator == "VM"
        # The vector leg contributes no waypoint, so the last FLYABLE fix is
        # where the assigned heading begins.
        assert star.last_fix().ident == "YS501"
        assert [w.ident for w in star.waypoints()] == ["YS502", "YS501"]

    def test_fix_terminated_star_is_closed(self) -> None:
        star = _star(
            _leg(10, "TF", "BAGOO", 17.3185, 96.51986111),
            _leg(20, "TF", "PAKSU", 17.2, 96.4),
        )
        assert star.is_open is False
        assert star.vector_termination is None
        assert star.last_fix().ident == "PAKSU"

    @pytest.mark.parametrize("term", ["VM", "FM", "VI", "VR"])
    def test_every_vector_terminator_counts_as_open(self, term: str) -> None:
        star = _star(_leg(10, "TF", "YS502", 17.26, 96.24), _leg(20, term, None))
        assert star.is_open is True

    def test_empty_procedure_is_not_open(self) -> None:
        assert _star().is_open is False
        assert _star().last_fix() is None

    def test_only_the_LAST_leg_opens_a_procedure(self) -> None:
        """A vector leg in the middle (rare, but codeable) does not make the
        arrival open — it still ends at a fix the aircraft can fly to."""
        star = _star(
            _leg(10, "VI", None),
            _leg(20, "TF", "YS501", 17.158908, 96.409411),
        )
        assert star.is_open is False


class TestFafLookup:
    def test_finds_the_fix_flagged_F_in_the_description_code(self) -> None:
        approach = Procedure(
            airport="VYYY",
            name="R21-V",
            proc_type=ProcedureType.APPROACH,
            runway="RW21",
            transition=None,
            legs=(
                _leg(10, "IF", "YS715", 17.134137, 96.28707, desc="E  I"),
                _leg(15, "TF", "YS710", 17.064064, 96.239525, desc="E S"),
                _leg(20, "TF", "YS705", 16.992014, 96.190691, desc="E  F"),
                _leg(30, "TF", "YS700", 16.923736, 96.144456, desc="EY M"),
            ),
        )
        faf = faf_of(approach)
        assert faf is not None and faf.ident == "YS705"

    def test_returns_none_when_no_leg_is_flagged(self) -> None:
        approach = Procedure(
            airport="VYYY",
            name="R21-V",
            proc_type=ProcedureType.APPROACH,
            runway="RW21",
            transition=None,
            legs=(_leg(10, "IF", "YS715", 17.11, 96.25, desc="E  I"),),
        )
        assert faf_of(approach) is None


# --- C: the vector path ---------------------------------------------------
def _centreline_offset_nm(point: RouteWaypoint) -> float:
    """Perpendicular distance from the RW21 extended centreline (NM)."""
    d = haversine_distance(
        VYYY_RW21.lat, VYYY_RW21.lon, point.lat, point.lon
    )
    brg = compute_bearing(VYYY_RW21.lat, VYYY_RW21.lon, point.lat, point.lon)
    outbound = (VYYY_RW21.true_bearing + 180.0) % 360.0
    return abs(d * math.sin(math.radians(brg - outbound)))


class TestVectorToFinal:
    def test_builds_a_join_for_the_VYYY_RW21_downwind(self) -> None:
        v = vector_to_final(
            start=YS501,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
        )
        assert v is not None
        assert v.downwind_nm >= 1.0
        assert v.base_nm >= 1.0
        assert v.track_nm == pytest.approx(v.downwind_nm + v.base_nm)

    def test_the_intercept_lands_ON_the_extended_centreline(self) -> None:
        v = vector_to_final(
            start=YS501,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
        )
        assert _centreline_offset_nm(v.intercept_point) == pytest.approx(0, abs=0.05)

    def test_turn_point_lies_on_the_assigned_heading_from_the_STAR_fix(self) -> None:
        """The downwind IS the published clearance — the turn must happen on
        that heading, not on a convenient bearing of the solver's choosing."""
        v = vector_to_final(
            start=YS501,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
        )
        flown = compute_bearing(
            YS501.lat, YS501.lon, v.turn_point.lat, v.turn_point.lon
        )
        assert flown == pytest.approx(VECTOR_HEADING_TRUE, abs=0.5)
        assert haversine_distance(
            YS501.lat, YS501.lon, v.turn_point.lat, v.turn_point.lon
        ) == pytest.approx(v.downwind_nm, abs=0.05)

    def test_base_leg_meets_final_at_the_requested_intercept_angle(self) -> None:
        v = vector_to_final(
            start=YS501,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
            intercept_deg=30.0,
        )
        base_track = compute_bearing(
            v.turn_point.lat, v.turn_point.lon,
            v.intercept_point.lat, v.intercept_point.lon,
        )
        delta = abs((base_track - VYYY_RW21.true_bearing + 180) % 360 - 180)
        assert delta == pytest.approx(30.0, abs=0.5)
        assert v.intercept_angle_deg == pytest.approx(30.0)

    def test_intercept_angle_is_capped_at_the_Doc4444_45_degrees(self) -> None:
        v = vector_to_final(
            start=YS501,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
            intercept_deg=80.0,  # illegal ask
        )
        assert v.intercept_angle_deg == pytest.approx(MAX_INTERCEPT_DEG)

    def test_joins_outside_the_FAF_so_the_glide_path_is_met_established(self) -> None:
        """§8.9.3.6 — established on the final approach track BEFORE the glide
        path, which is intercepted at the FAF."""
        v = vector_to_final(
            start=YS501,
            heading_deg=VECTOR_HEADING_TRUE,
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
            established_nm=2.0,
        )
        assert v.established_nm >= 2.0
        # The intercept is further from the threshold than the FAF is.
        d_icpt = haversine_distance(
            VYYY_RW21.lat, VYYY_RW21.lon,
            v.intercept_point.lat, v.intercept_point.lon,
        )
        assert d_icpt > FAF_NM

    def test_a_longer_established_leg_pushes_the_intercept_further_out(self) -> None:
        near = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM, established_nm=2.0,
        )
        far = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM, established_nm=8.0,
        )
        assert far.established_nm > near.established_nm


class TestDownwindExtension:
    """`extend_nm` is the spacing deficit from the arrival sequencer — the
    "maintain heading until separation" instruction, in track miles."""

    def test_extending_the_downwind_lengthens_the_total_track(self) -> None:
        base = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM,
        )
        longer = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM, extend_nm=6.0,
        )
        assert longer.track_nm > base.track_nm
        assert longer.downwind_nm > base.downwind_nm

    def test_the_stretch_delivers_the_DISTANCE_TO_TOUCHDOWN_asked_for(self) -> None:
        """`extend_nm` is a spacing deficit, so it has to be measured in the
        distance that sets the landing time — all the way to the threshold, not
        just the vector legs. Extending the downwind also moves the intercept
        out, so the final grows too; counting only the vector legs would
        deliver half the spacing that was asked for."""
        base = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM,
        )
        for want in (2.0, 5.0, 10.0):
            v = vector_to_final(
                start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
                faf_nm=FAF_NM, extend_nm=want,
            )
            assert v.total_nm - base.total_nm == pytest.approx(want, abs=0.1)
            # And it stays legal while doing it.
            assert v.intercept_angle_deg <= MAX_INTERCEPT_DEG
            assert _centreline_offset_nm(v.intercept_point) == pytest.approx(
                0, abs=0.05
            )

    def test_the_downwind_grows_by_about_HALF_the_requested_distance(self) -> None:
        """The 2:1 rule: on this geometry the downwind runs parallel to the
        centreline, so 1 NM more downwind also puts the intercept 1 NM further
        out — 2 NM of extra distance to touchdown for 1 NM of heading."""
        base = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM,
        )
        v = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM, extend_nm=10.0,
        )
        assert v.downwind_nm - base.downwind_nm == pytest.approx(5.0, abs=0.2)

    def test_shortest_total_reports_what_a_stretch_actually_achieved(self) -> None:
        v = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM, extend_nm=7.0,
        )
        assert v.total_nm - v.shortest_total_nm == pytest.approx(7.0, abs=0.1)

    def test_an_impossible_stretch_is_reported_short_not_invented(self) -> None:
        """Past the downwind limit the extension cannot be delivered. The path
        must come back SHORT of the request so the caller can hold instead —
        silently returning a path that looks like it worked would hide the
        one case where a hold is the right answer."""
        v = vector_to_final(
            start=YS501, heading_deg=VECTOR_HEADING_TRUE, runway=VYYY_RW21,
            faf_nm=FAF_NM, extend_nm=500.0, max_downwind_nm=10.0,
        )
        assert v is not None
        assert v.total_nm - v.shortest_total_nm < 500.0
        # It stopped because the downwind hit its limit, not for some other
        # reason — and it did not overrun that limit to fake the request.
        assert v.downwind_nm == pytest.approx(10.0, abs=0.05)


class TestAgainstTheOpenStarFixture:
    """End-to-end through the DFD loader, not hand-built legs: load VYYY's
    STARs (the real, closed ones plus the synthetic open ones) and the R21-V
    approach through NavData, find the open ones, and vector them onto final."""

    @staticmethod
    def _resolve(nav: NavData, name: str, **kw) -> Procedure | None:
        """A STAR with several enroute transitions needs one naming; pick the
        first, since the vector termination is on the shared runway leg."""
        try:
            return nav.lookup_procedure("VYYY", name, **kw)
        except AmbiguousProcedureError as exc:
            if exc.kind != "transition":
                return None
            return nav.lookup_procedure(
                "VYYY", name, transition=sorted(exc.candidates)[0], **kw
            )
        except LookupError:
            return None

    # An open-STAR chart carries the hand-over as a note naming the fixes
    # explicitly. For the fixture's RWY21 (the …1C arrivals):
    #
    #   "After YS501, YS502 maintain heading 034° or as directed by ATC.
    #    Do not proceed Instrument Approach Procedure without ATC clearance."
    #
    # RWY03 (the …1D arrivals) says the same for YS503, YS504 on heading 214°.
    # Vectoring therefore begins at ONE of those fixes — not at any waypoint an
    # aircraft happens to be over. This table is that note.
    CHART_HANDOVER = {
        "RW21": ({"YS501", "YS502"}, 34.0),
        "RW03": ({"YS503", "YS504"}, 214.0),
    }

    @pytest.mark.parametrize("runway", ["RW21", "RW03"])
    def test_the_handover_matches_the_fixes_printed_on_the_STAR_chart(
        self, nav_star: NavData, runway: str
    ) -> None:
        """Every open VYYY arrival must hand over to vectors at a fix the chart
        names, on the heading the chart prints."""
        expect_fixes, expect_course = self.CHART_HANDOVER[runway]
        seen: set[str] = set()
        for name in nav_star.list_procedures("VYYY", ProcedureType.STAR):
            proc = self._resolve(
                nav_star, name, proc_type=ProcedureType.STAR, runway=runway
            )
            if proc is None or not proc.is_open:
                continue
            start = proc.last_fix()
            leg = proc.vector_termination
            assert start is not None and leg is not None
            # Where the aircraft stops following the STAR.
            assert start.ident in expect_fixes, (
                f"{name} {runway} hands over at {start.ident}, but the chart "
                f"names {sorted(expect_fixes)}"
            )
            # And the heading it then holds.
            assert leg.magnetic_course == pytest.approx(expect_course), name
            seen.add(start.ident)
        assert seen == expect_fixes, (
            f"{runway}: chart names {sorted(expect_fixes)} but the coded "
            f"procedures only hand over at {sorted(seen)}"
        )

    def test_only_the_fixture_arrivals_are_open(
        self, nav_star: NavData
    ) -> None:
        nav = nav_star
        open_names = []
        for name in nav.list_procedures("VYYY", ProcedureType.STAR):
            proc = self._resolve(
                nav, name, proc_type=ProcedureType.STAR, runway="RW21"
            )
            if proc is not None and proc.is_open:
                open_names.append(name)
        # The fixture's OPN…1C serve RW21 and all end in vectors; every real
        # VY STAR (OKIK1A, OROM1A, …) is closed.
        assert open_names, "expected the fixture's RW21 arrivals to be open"
        assert all(n.startswith("OPN") and n.endswith("1C") for n in open_names)

    def test_an_open_STAR_vectors_onto_the_R21_final(
        self, nav_both: NavData
    ) -> None:
        nav = nav_both
        star = self._resolve(
            nav, "OPNE1C", proc_type=ProcedureType.STAR, runway="RW21"
        )
        assert star is not None and star.is_open
        approach = self._resolve(
            nav, "R21-V", proc_type=ProcedureType.APPROACH, runway="RW21"
        )
        assert approach is not None
        faf = faf_of(approach)
        assert faf is not None
        faf_nm = haversine_distance(
            VYYY_RW21.lat, VYYY_RW21.lon, faf.lat, faf.lon
        )

        start = star.last_fix()
        leg = star.vector_termination
        assert leg is not None and leg.magnetic_course is not None
        heading_true = (
            leg.magnetic_course + VYYY_RW21.magnetic_variation
        ) % 360.0

        v = vector_to_final(
            start=start,
            heading_deg=heading_true,
            runway=VYYY_RW21,
            faf_nm=faf_nm,
        )
        assert v is not None
        assert v.intercept_angle_deg <= MAX_INTERCEPT_DEG
        assert _centreline_offset_nm(v.intercept_point) == pytest.approx(0, abs=0.05)
        # The join is outside the FAF, so the glide path is met established.
        assert v.established_nm >= 2.0
        # And the whole pattern is a sane size for a TMA, not a excursion.
        assert 5.0 < v.total_nm < 60.0


class TestOpenStarJoin:
    """The whole spliced arrival: STAR fixes, vector legs, then the approach
    from its FAF in — the initial/intermediate approach is NOT flown, because
    vectoring terminates when the aircraft turns onto final (§8.9.4.1)."""

    def test_splices_star_then_vectors_then_the_approach_inside_the_join(
        self, nav_both: NavData
    ) -> None:
        nav = nav_both
        star = TestAgainstTheOpenStarFixture._resolve(
            nav, "OPNE1C", proc_type=ProcedureType.STAR, runway="RW21"
        )
        approach = TestAgainstTheOpenStarFixture._resolve(
            nav, "R21-V", proc_type=ProcedureType.APPROACH, runway="RW21"
        )
        result = plan_open_star_join(star, approach, VYYY_RW21)
        assert result is not None
        fixes, vtf = result
        idents = [w.ident for w in fixes]

        # The STAR's own fixes lead, ending at the vector termination.
        assert idents[: len(star.waypoints())] == [
            w.ident for w in star.waypoints()
        ]
        # Then the two vector legs.
        assert idents[len(star.waypoints()) : len(star.waypoints()) + 2] == [
            "TURN",
            "INTC",
        ]
        # Then the approach, cut at the intercept: fixes INSIDE the join are
        # kept (the aircraft overflies them, and their crossing minima still
        # apply); the ones outside belong to the IAF entry it never flew.
        faf = faf_of(approach)
        assert faf.ident in idents
        join_nm = haversine_distance(
            VYYY_RW21.lat, VYYY_RW21.lon,
            vtf.intercept_point.lat, vtf.intercept_point.lon,
        )
        kept, cut = [], []
        for w in approach.waypoints():
            d = haversine_distance(VYYY_RW21.lat, VYYY_RW21.lon, w.lat, w.lon)
            (kept if d < join_nm else cut).append(w.ident)
        assert cut, "expected some approach fixes to sit outside the join"
        for ident in kept:
            assert ident in idents
        for ident in cut:
            assert ident not in idents

        # The path only ever moves closer to the threshold once on final.
        d_intc = haversine_distance(
            VYYY_RW21.lat, VYYY_RW21.lon, vtf.intercept_point.lat,
            vtf.intercept_point.lon,
        )
        assert d_intc > haversine_distance(
            VYYY_RW21.lat, VYYY_RW21.lon, faf.lat, faf.lon
        )

    def test_extending_the_join_delays_the_arrival(self, nav_both: NavData) -> None:
        nav = nav_both
        star = TestAgainstTheOpenStarFixture._resolve(
            nav, "OPNE1C", proc_type=ProcedureType.STAR, runway="RW21"
        )
        approach = TestAgainstTheOpenStarFixture._resolve(
            nav, "R21-V", proc_type=ProcedureType.APPROACH, runway="RW21"
        )
        _f0, v0 = plan_open_star_join(star, approach, VYYY_RW21)
        _f1, v1 = plan_open_star_join(star, approach, VYYY_RW21, extend_nm=8.0)
        assert v1.total_nm - v0.total_nm == pytest.approx(8.0, abs=0.15)

    def test_returns_none_for_a_closed_star(self) -> None:
        closed = _star(
            _leg(10, "TF", "BAGOO", 17.3185, 96.51986111),
            _leg(20, "TF", "PAKSU", 17.2, 96.4),
        )
        approach = Procedure(
            airport="VYYY", name="R21-V", proc_type=ProcedureType.APPROACH,
            runway="RW21", transition=None,
            legs=(_leg(20, "TF", "YS705", 16.992014, 96.190691, desc="E  F"),),
        )
        assert plan_open_star_join(closed, approach, VYYY_RW21) is None

    def test_returns_none_when_the_approach_has_no_FAF(self) -> None:
        open_star = _star(
            _leg(20, "TF", "YS501", 17.158908, 96.409411),
            ProcedureLeg(
                seqno=30, path_terminator="VM", ident="VYYY", lat=16.92, lon=96.12,
                altitude=_no_alt(), speed=_no_spd(), magnetic_course=34.0,
            ),
        )
        approach = Procedure(
            airport="VYYY", name="R21-V", proc_type=ProcedureType.APPROACH,
            runway="RW21", transition=None,
            legs=(_leg(10, "IF", "YS715", 17.13, 96.28, desc="E  I"),),
        )
        assert plan_open_star_join(open_star, approach, VYYY_RW21) is None


class TestInfeasibleGeometry:
    def test_a_heading_parallel_to_final_never_closes(self) -> None:
        """Flying the final approach track itself, offset to one side, the two
        lines never meet — there is no vector solution, and the caller must
        re-sequence rather than be handed a fabricated join."""
        offset = RouteWaypoint(ident="OFF", lat=YS501.lat, lon=YS501.lon)
        v = vector_to_final(
            start=offset,
            heading_deg=VYYY_RW21.true_bearing,  # straight down the FAT
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
            intercept_deg=0.0,  # and no intercept angle to close with
        )
        assert v is None

    def test_returns_none_rather_than_a_backwards_join(self) -> None:
        """Started well inside the FAF and flying away, nothing legal remains
        within a short downwind limit."""
        inside = RouteWaypoint(ident="IN", lat=16.947719, lon=96.162489)
        v = vector_to_final(
            start=inside,
            heading_deg=(VYYY_RW21.true_bearing + 180.0) % 360.0,
            runway=VYYY_RW21,
            faf_nm=FAF_NM,
            max_downwind_nm=0.5,
        )
        assert v is None
