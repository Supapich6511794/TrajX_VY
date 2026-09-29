"""Tests for PBN instrument-approach (IAP) loading, assembly and splicing.

The approach data is the real VY (Myanmar) PBN export
(``web/public/data/aixm_vy/pbn_waypoint.geojson``) — the same ARINC-424 "DFD"
leg schema as SID/STAR. An approach flies its chosen IAF transition into the
common final segment and, for a landing trajectory, stops at the Missed Approach
Point (the missed-approach legs and hold are dropped). VYYY's RNP RWY21
(``R21``) has three IAFs — BAGOO (via PAKSU), DANSO and GONAS — converging on
the IF HLEGU, the FAF SULAP and the MAPt on the RW21 threshold.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from trajectory_sim.navdata import (
    AltitudeConstraint,
    NavData,
    Procedure,
    ProcedureLeg,
    ProcedureType,
    RouteWaypoint,
    SpeedConstraint,
    splice_procedures,
)

_PBN = (
    Path(__file__).resolve().parents[2]
    / "web" / "public" / "data" / "aixm_vy" / "pbn_waypoint.geojson"
)

pytestmark = pytest.mark.skipif(
    not _PBN.is_file(), reason="PBN approach source not present"
)

# Real fix positions (aip_VY.json), for hand-built arrivals.
_OKIKO = RouteWaypoint("OKIKO", 17.84839167, 95.771625)
_BAGOO = RouteWaypoint("BAGOO", 17.3185, 96.51986111)


@pytest.fixture(scope="module")
def nav() -> NavData:
    return NavData(approach_source=_PBN)


def _r21(nav: NavData, iaf: str = "BAGOO") -> Procedure:
    return nav.lookup_procedure(
        "VYYY", "R21", proc_type=ProcedureType.APPROACH, transition=iaf
    )


def test_approach_types_listed(nav: NavData) -> None:
    aps = nav.list_procedures("VYYY", ProcedureType.APPROACH)
    assert set(aps) >= {"R21", "R03"}
    # Approaches must NOT leak into the SID/STAR lists.
    assert "R21" not in nav.list_procedures("VYYY", ProcedureType.STAR)


def test_r21_assembles_and_truncates_at_mapt(nav: NavData) -> None:
    # RNP RWY21 via BAGOO: IAF -> PAKSU -> IF(HLEGU) -> FAF(SULAP) -> MAPt(RW21).
    idents = [w.ident for w in _r21(nav).waypoints()]
    assert idents == ["BAGOO", "PAKSU", "HLEGU", "SULAP", "RW21"]
    # The missed approach (YY901, then the PUKIS hold) after the MAPt is dropped.
    assert "YY901" not in idents and "PUKIS" not in idents


def test_r03_assembles_and_truncates_at_mapt(nav: NavData) -> None:
    # The opposite runway flies its own track: PALPO -> YY902 -> LUNGO -> RW03,
    # with its missed approach to BODIN dropped.
    p = nav.lookup_procedure(
        "VYYY", "R03", proc_type=ProcedureType.APPROACH, transition="PALPO"
    )
    idents = [w.ident for w in p.waypoints()]
    assert idents == ["PALPO", "YY902", "LUNGO", "RW03"]
    assert "BODIN" not in idents


def test_approach_transition_selectable(nav: NavData) -> None:
    # Each IAF is its own entry into the same common final segment.
    for iaf in ("DANSO", "GONAS"):
        idents = [w.ident for w in _r21(nav, iaf).waypoints()]
        assert idents[0] == iaf
        assert idents[1:] == ["HLEGU", "SULAP", "RW21"]  # all converge


def test_approach_runway_is_in_the_name(nav: NavData) -> None:
    # The landing runway is encoded in the procedure name, not a runway group —
    # so no runway needs to be specified to resolve it.
    p = _r21(nav)
    assert p.runway is None  # nothing to disambiguate
    assert p.transition == "BAGOO"


def test_splice_star_end_collapses_into_approach_iaf(nav: NavData) -> None:
    # The approach IAF (BAGOO) coincides with the arrival's last fix, so the
    # boundary collapses to a single point when spliced.
    out = [w.ident for w in splice_procedures([_OKIKO, _BAGOO], approach=_r21(nav))]
    assert out == ["OKIKO", "BAGOO", "PAKSU", "HLEGU", "SULAP", "RW21"]
    assert out.count("BAGOO") == 1  # boundary fix not duplicated


def test_splice_arrival_inside_the_iaf_transition_no_zigzag(nav: NavData) -> None:
    # The VYYY STARs (OKIK1A, OROM1A, RELA1A, …) end at PAKSU — the SECOND fix
    # of R21's BAGOO transition. Splicing the approach must NOT re-fly the
    # transition from its IAF (out to BAGOO and back: …BAGOO, PAKSU, BAGOO,
    # PAKSU, HLEGU); it joins at PAKSU and continues down the final segment.
    arrival = [
        _OKIKO,
        _BAGOO,
        RouteWaypoint("PAKSU", 17.2, 96.4),
    ]
    out = [w.ident for w in splice_procedures(arrival, approach=_r21(nav))]
    assert out == ["OKIKO", "BAGOO", "PAKSU", "HLEGU", "SULAP", "RW21"]
    assert out.count("PAKSU") == 1
    assert out.count("BAGOO") == 1  # flown once, not out-and-back


def test_splice_arrival_via_other_iaf_still_no_backtrack(nav: NavData) -> None:
    # The arrival reaches the IF via ANOTHER IAF (DANSO) while the approach was
    # resolved on the BAGOO transition. Reaching the IF still drops the BAGOO
    # transition — no fly-out to BAGOO and back.
    arrival = [
        RouteWaypoint("DANSO", 16.9, 96.5),
        RouteWaypoint("HLEGU", 17.0, 96.25),
    ]
    out = [w.ident for w in splice_procedures(arrival, approach=_r21(nav))]
    assert out == ["DANSO", "HLEGU", "SULAP", "RW21"]
    assert "BAGOO" not in out


def test_splice_direct_arrival_flies_full_iaf_transition(nav: NavData) -> None:
    # A direct arrival that ends SHORT of the approach flies the whole thing,
    # IAF transition included — nothing overlaps, so nothing is collapsed.
    arrival = [RouteWaypoint("ENSIT", 16.37297778, 97.01456667)]
    out = [w.ident for w in splice_procedures(arrival, approach=_r21(nav))]
    assert out == ["ENSIT", "BAGOO", "PAKSU", "HLEGU", "SULAP", "RW21"]


def test_splice_star_overshooting_iaf_drops_overshoot_no_loop(
    nav: NavData,
) -> None:
    # An arrival that ends a fix PAST the IAF the approach re-enters at —
    # …BAGOO, CI21 (a made-up centreline fix the approach does not fly) — must
    # not append the whole approach and re-fly BAGOO (…BAGOO, CI21, BAGOO,
    # PAKSU: a visible loop). The join drops the overshoot (CI21) AND the
    # approach's re-entry BAGOO: …BAGOO, PAKSU.
    arrival = [
        RouteWaypoint("YY918", 17.5, 96.3),
        _BAGOO,
        RouteWaypoint("CI21", 17.25, 96.45),
    ]
    out = [w.ident for w in splice_procedures(arrival, approach=_r21(nav))]
    assert out[:3] == ["YY918", "BAGOO", "PAKSU"]
    assert "CI21" not in out  # overshoot dropped
    assert out.count("BAGOO") == 1  # no out-and-back loop


def _tf(seqno: int, wp: RouteWaypoint) -> ProcedureLeg:
    return ProcedureLeg(
        seqno=seqno, path_terminator="TF", ident=wp.ident, lat=wp.lat,
        lon=wp.lon, altitude=AltitudeConstraint(), speed=SpeedConstraint(),
    )


def test_splice_star_joins_approach_at_chosen_early_entry_fix(
    nav: NavData,
) -> None:
    # The pilot may join the approach at an EARLIER entry fix the STAR passes,
    # not just its last shared one. A STAR that flies OKIKO, BAGOO, SX001,
    # SX002 can be joined to R21 at BAGOO: the STAR must be trimmed back to
    # BAGOO — dropping SX001, SX002 — not flown in full and looped back
    # (OKIKO, BAGOO, SX001, SX002, BAGOO, PAKSU).
    star = Procedure(
        airport="VYYY",
        name="TEST1A",
        proc_type=ProcedureType.STAR,
        runway="RW21",
        transition=None,
        legs=(
            _tf(10, _OKIKO),
            _tf(20, _BAGOO),
            _tf(30, RouteWaypoint("SX001", 17.1, 96.6)),
            _tf(40, RouteWaypoint("SX002", 17.0, 96.5)),
        ),
    )
    out = [
        w.ident
        for w in splice_procedures([_OKIKO], star=star, approach=_r21(nav))
    ]
    assert out[:3] == ["OKIKO", "BAGOO", "PAKSU"]
    assert "SX001" not in out and "SX002" not in out
    assert out.count("BAGOO") == 1  # joined once, no loop back through the STAR
