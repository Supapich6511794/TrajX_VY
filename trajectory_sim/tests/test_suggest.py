"""Tests for SID/STAR auto-suggestion — the best-connecting procedure for a
route (``api.server._suggest_procedure``).

Uses the real bundled VY navdata (``aip_VY.json`` airways + SID/STAR GeoJSON)
because the ranking depends on real airway membership and each procedure's
exit fix — the whole point is picking the SID whose exit lands ON the filed
route even when the route is filed off a VOR that names no SID.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SID = _ROOT / "web" / "public" / "data" / "aixm_vy" / "sid_waypoint.geojson"
_AIP = _ROOT / "web" / "public" / "data" / "aip_VY.json"

pytestmark = pytest.mark.skipif(
    not (_SID.is_file() and _AIP.is_file()),
    reason="bundled navdata not present",
)


def _ctx(route: str, proc_type):
    from api.server import _airway_waypoint_index, _expand_airways, _route_ctx
    from trajectory_sim.fpl import parse_route

    idx = _airway_waypoint_index()
    pts = [(i, *idx[i]) for i in parse_route(_expand_airways(route)) if i in idx]
    return _route_ctx(pts, proc_type)


def test_sid_whose_exit_lies_on_the_route_wins() -> None:
    # VYYY SIDs are named for their exit fix (VISA1A→VISAM, BOSP1A→BOSPO, …)
    # and routes are often filed off the BGO VOR, which no SID exits at. The
    # SID that delivers ONTO the filed path (one of its enroute transitions
    # ends on an expanded route fix) must win over the one merely nearest BGO.
    from api import server
    from api.server import _suggest_procedure
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    # A581 runs BGO → BOMAS; VISA1A's BOMAS transition ends there.
    r_a581 = "BGO A581 BOMAS"
    assert (
        _suggest_procedure(nav, "VYYY", PT.SID, _ctx(r_a581, PT.SID), "RW21")
        == "VISA1A"
    )
    # V6 runs BGO → MM; BOSP1A's MM transition ends there.
    r_v6 = "BGO V6 MM"
    assert (
        _suggest_procedure(nav, "VYYY", PT.SID, _ctx(r_v6, PT.SID), "RW21")
        == "BOSP1A"
    )


def test_sid_exact_first_fix_match() -> None:
    # When the route's first fix IS a SID exit, that SID is picked (tier 0).
    from api import server
    from api.server import _suggest_procedure
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    ctx = _ctx("PARLA DCT NPT W13 MIA", PT.SID)
    assert _suggest_procedure(nav, "VYYY", PT.SID, ctx, "RW21") == "PARL1A"


def test_suggest_none_without_route() -> None:
    from api import server
    from api.server import _suggest_procedure
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    assert _suggest_procedure(nav, "VYYY", PT.SID, None, "RW21") is None


def test_approach_iaf_scored_on_its_entry_not_the_mapt() -> None:
    # An approach's IAF (its FIRST fix) — not the shared MAPt (its last fix) —
    # must drive transition scoring, else every IAF looks identical. A route
    # arriving at NPT from the south then picks the IAF nearest that fix
    # (WUNNA), giving the AIP flow NPT → WUNNA(IAF) → NT913(IF) → HAYKO(FAF)
    # → RW34.
    from api import server
    from api.server import _resolve_procedure_auto
    from trajectory_sim.navdata import ProcedureType as PT

    nav = server._navdata()
    proc, _ = _resolve_procedure_auto(
        nav, "VYNT", "R34", proc_type=PT.APPROACH,
        route_ctx=_ctx("BGO W13 NPT", PT.APPROACH),
    )
    assert proc.transition == "WUNNA"
    assert [w.ident for w in proc.waypoints()] == [
        "WUNNA", "NT913", "HAYKO", "RW34",
    ]
