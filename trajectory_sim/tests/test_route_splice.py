"""Tests for splicing SID/STAR procedures around the enroute route.

Covers :func:`trajectory_sim.navdata.splice_procedures`:
the SID lands just after ADEP, the STAR just before ADES, and the shared
boundary fixes (SID enroute-transition fix; STAR enroute-entry fix) collapse
into the enroute portion rather than being listed twice.

The SID/STAR fixtures reuse the DFD-schema rows from
``test_navdata_procedures`` so the procedures here are assembled by the real
loader, not hand-built — the spliced sequence is checked end-to-end.
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import Point

from trajectory_sim.navdata import (
    NavData,
    Procedure,
    ProcedureLeg,
    ProcedureType,
    RouteWaypoint,
    AltitudeConstraint,
    SpeedConstraint,
    splice_procedures,
)

from trajectory_sim.tests.test_navdata_procedures import (
    _SID_ROWS,
    _STAR_ROWS,
    _proc_df,
    _waypoints_gdf,
)


@pytest.fixture
def navdata(monkeypatch: pytest.MonkeyPatch) -> NavData:
    """NavData backed by the shared in-memory SID/STAR fixtures.

    SID BIDA2A (VYYY) exits enroute at DAGAB/TONUS; STAR SARI1A (VYYY)
    enters enroute at LADAR. We reuse VYYY for both ends purely so the one
    fixture serves the departure-SID and arrival-STAR roles in these tests.
    """
    import trajectory_sim.navdata as navdata_mod

    sids = _proc_df(_SID_ROWS, "VYYY", "BIDA2A")
    stars = _proc_df(_STAR_ROWS, "VYYY", "SARI1A")

    def fake_read_file(path: object, layer: str) -> pd.DataFrame:
        if layer == "waypoints":
            return _waypoints_gdf()
        if layer == "sids":
            return sids.copy()
        if layer == "stars":
            return stars.copy()
        raise ValueError(f"no layer {layer}")

    monkeypatch.setattr(navdata_mod.gpd, "read_file", fake_read_file)
    return NavData("ignored.gpkg")


def _wp(ident: str, lat: float = 0.0, lon: float = 0.0) -> RouteWaypoint:
    return RouteWaypoint(ident=ident, lat=lat, lon=lon)


def _sid(navdata: NavData) -> Procedure:
    return navdata.lookup_procedure(
        "VYYY", "BIDA2A", runway="RW19L", transition="DAGAB"
    )


def _star(navdata: NavData) -> Procedure:
    return navdata.lookup_procedure(
        "VYYY", "SARI1A", runway="RW01L", transition="LADAR"
    )


# --- subtask 1: known city-pair example ------------------------------------


def test_known_city_pair_full_splice(navdata: NavData) -> None:
    """SID BIDA2A → DAGAB ... LADAR ← STAR SARI1A, as an FPL would file it.

    The Item-15 route starts on the SID exit fix (DAGAB) and ends on the
    STAR entry fix (LADAR); both must appear exactly once after splicing.
    """
    enroute = [_wp("DAGAB"), _wp("WULTA"), _wp("LADAR")]
    spliced = splice_procedures(
        enroute, sid=_sid(navdata), star=_star(navdata)
    )

    assert [w.ident for w in spliced] == [
        "SAVUS",  # SID runway-transition fix (after ADEP)
        "BIDAK",
        "DOGAR",
        "BIDA",
        "DAGAB",  # SID enroute-transition fix == first enroute fix (joined)
        "WULTA",  # enroute
        "LADAR",  # STAR entry fix == last enroute fix (joined)
        "RECID",
        "FINAL",  # STAR runway-transition fix (before ADES)
    ]


def test_splice_preserves_procedure_coordinates(navdata: NavData) -> None:
    """The kept boundary fix carries the SID/enroute coordinates, in order."""
    enroute = [_wp("DAGAB", 18.3, 97.2), _wp("LADAR", 18.8, 96.4)]
    spliced = splice_procedures(
        enroute, sid=_sid(navdata), star=_star(navdata)
    )
    by_ident = {w.ident: w for w in spliced}
    # SID's SAVUS keeps its procedure-leg coordinates.
    assert (by_ident["SAVUS"].lat, by_ident["SAVUS"].lon) == (16.90, 96.10)
    # Monotonic, no duplicate idents.
    idents = [w.ident for w in spliced]
    assert len(idents) == len(set(idents))


# --- subtask 5: SID enroute-transition fix joins first enroute fix ---------


def test_sid_transition_fix_dedupes_against_first_enroute(
    navdata: NavData,
) -> None:
    enroute = [_wp("DAGAB"), _wp("WULTA")]
    spliced = splice_procedures(enroute, sid=_sid(navdata))
    idents = [w.ident for w in spliced]
    assert idents == ["SAVUS", "BIDAK", "DOGAR", "BIDA", "DAGAB", "WULTA"]
    assert idents.count("DAGAB") == 1


def test_sid_transition_kept_when_route_starts_elsewhere(
    navdata: NavData,
) -> None:
    """If the route does not start on the SID exit fix, both are kept."""
    enroute = [_wp("WULTA"), _wp("LADAR")]
    spliced = splice_procedures(enroute, sid=_sid(navdata))
    idents = [w.ident for w in spliced]
    # DAGAB (SID exit) is followed by WULTA — a direct join, nothing dropped.
    assert idents == ["SAVUS", "BIDAK", "DOGAR", "BIDA", "DAGAB", "WULTA", "LADAR"]


# --- subtask 4: STAR entry fix joins last enroute fix ----------------------


def test_star_entry_fix_dedupes_against_last_enroute(navdata: NavData) -> None:
    enroute = [_wp("WULTA"), _wp("LADAR")]
    spliced = splice_procedures(enroute, star=_star(navdata))
    idents = [w.ident for w in spliced]
    assert idents == ["WULTA", "LADAR", "RECID", "FINAL"]
    assert idents.count("LADAR") == 1


def test_star_entry_kept_when_route_ends_elsewhere(navdata: NavData) -> None:
    enroute = [_wp("DAGAB"), _wp("WULTA")]
    spliced = splice_procedures(enroute, star=_star(navdata))
    idents = [w.ident for w in spliced]
    assert idents == ["DAGAB", "WULTA", "LADAR", "RECID", "FINAL"]


def test_star_multi_fix_overlap_collapses_no_backtrack(navdata: NavData) -> None:
    """A route whose TAIL re-lists more than the STAR's single entry fix joins
    the STAR at the fix reached — no fly-out-and-back. Enroute ends LADAR, RECID
    and STAR SARI1A begins LADAR, RECID, FINAL; the shared LADAR, RECID run must
    appear once, not twice (regression for a route ending … HOTEL, SABAI,
    HOTEL, SABAI, ARMUS into a STAR entered at SABAI — a consecutive-dup
    collapse can't fix it)."""
    enroute = [_wp("MOTNA"), _wp("LADAR"), _wp("RECID")]
    spliced = splice_procedures(enroute, star=_star(navdata))
    idents = [w.ident for w in spliced]
    assert idents == ["MOTNA", "LADAR", "RECID", "FINAL"]
    assert idents.count("LADAR") == 1
    assert idents.count("RECID") == 1


# --- subtask 2: edge cases -------------------------------------------------


def test_no_sid_no_star_is_enroute_unchanged(navdata: NavData) -> None:
    """Direct routing: with neither procedure the enroute list passes through."""
    enroute = [_wp("DAGAB"), _wp("WULTA"), _wp("LADAR")]
    spliced = splice_procedures(enroute)
    assert [w.ident for w in spliced] == ["DAGAB", "WULTA", "LADAR"]


def test_sid_only(navdata: NavData) -> None:
    enroute = [_wp("DAGAB"), _wp("WULTA")]
    spliced = splice_procedures(enroute, sid=_sid(navdata))
    assert [w.ident for w in spliced][:1] == ["SAVUS"]
    assert spliced[-1].ident == "WULTA"


def test_star_only(navdata: NavData) -> None:
    enroute = [_wp("WULTA"), _wp("LADAR")]
    spliced = splice_procedures(enroute, star=_star(navdata))
    assert spliced[0].ident == "WULTA"
    assert spliced[-1].ident == "FINAL"


def test_empty_enroute_joins_sid_directly_to_star(navdata: NavData) -> None:
    """Terminal-to-terminal hop: SID exit flows straight into STAR entry."""
    spliced = splice_procedures([], sid=_sid(navdata), star=_star(navdata))
    assert [w.ident for w in spliced] == [
        "SAVUS", "BIDAK", "DOGAR", "BIDA", "DAGAB",  # SID
        "LADAR", "RECID", "FINAL",  # STAR
    ]


def test_empty_everything_is_empty() -> None:
    assert splice_procedures([]) == []


def test_overlapping_consecutive_fixes_collapse() -> None:
    """A fix repeated across the enroute boundary collapses to one point."""
    enroute = [_wp("DAGAB"), _wp("DAGAB"), _wp("WULTA"), _wp("WULTA")]
    spliced = splice_procedures(enroute)
    assert [w.ident for w in spliced] == ["DAGAB", "WULTA"]


def test_splice_does_not_mutate_inputs(navdata: NavData) -> None:
    enroute = [_wp("DAGAB"), _wp("LADAR")]
    before = list(enroute)
    splice_procedures(enroute, sid=_sid(navdata), star=_star(navdata))
    assert enroute == before


def test_fixless_sid_legs_excluded_from_splice(navdata: NavData) -> None:
    """The SID's fixless CA leg never reaches the spliced sequence."""
    spliced = splice_procedures([_wp("DAGAB")], sid=_sid(navdata))
    assert all(w.ident is not None for w in spliced)
    # CA leg sits between SAVUS and BIDAK in the raw legs; it is absent here.
    assert "SAVUS" in [w.ident for w in spliced]


def test_star_first_fix_collapses_even_with_hand_built_procedure() -> None:
    """Splice works on any Procedure, not only loader-produced ones."""
    star = Procedure(
        airport="VYSW",
        name="DCT1A",
        proc_type=ProcedureType.STAR,
        runway="RW29",
        transition="ENTRY",
        legs=(
            ProcedureLeg(
                seqno=10, path_terminator="IF", ident="ENTRY",
                lat=20.0, lon=93.0,
                altitude=AltitudeConstraint(), speed=SpeedConstraint(),
            ),
            ProcedureLeg(
                seqno=20, path_terminator="TF", ident="THRES",
                lat=20.1, lon=92.9,
                altitude=AltitudeConstraint(), speed=SpeedConstraint(),
            ),
        ),
    )
    spliced = splice_procedures([_wp("UPALL"), _wp("ENTRY")], star=star)
    assert [w.ident for w in spliced] == ["UPALL", "ENTRY", "THRES"]
