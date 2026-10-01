"""Tests for the synthetic runway-heuristic turns
(:func:`expand_runway_departure_heuristic` / :func:`runway_arrival_pattern`)
— the plausible departure/arrival ground track used when a runway is known
but no coded SID/STAR/approach can be resolved — and the direction-based
runway pick (:func:`pick_runway_for_track`).

Modelled on VYNT RW16 / VYTL RW04 (ARINC runway table), the exact pair a
straight "VYNT DCT VYTL" filing has no published procedure for.
"""

from __future__ import annotations

import pytest

from trajectory_sim.geodesy import compute_bearing, project_point
from trajectory_sim.navdata import (
    RUNWAY_HEURISTIC_SOURCE,
    RunwayEnd,
    _RUNWAY_ENDS,
    expand_runway_departure_heuristic,
    pick_runway_for_track,
    register_runways,
    runway_arrival_pattern,
)
from trajectory_sim.navdata import RUNWAY_BASE_OFFSET_NM, RUNWAY_FINAL_NM
from trajectory_sim.geodesy import haversine_distance

# VYNT RW16, from the ARINC runway table (runway_vy.csv).
_RW16 = RunwayEnd(
    icao="VYNT", ident="RW16",
    lat=19.63878611, lon=96.19425556,
    magnetic_bearing=158, true_bearing=157,
)
# VYTL RW04.
_RW04 = RunwayEnd(
    icao="VYTL", ident="RW04",
    lat=20.47717500, lon=99.92856667,
    magnetic_bearing=38, true_bearing=37,
)
# Roughly the true bearing from VYNT to VYTL (~76 deg, ENE) — a fix out that
# way is a plausible "next fix on the actual route", not a reversal.
_ENROUTE_FIX = (20.30, 99.40)

_TURN_SPEED_KT = 180.0


def test_departure_starts_on_the_runway_threshold():
    pts = expand_runway_departure_heuristic(_RW16, _ENROUTE_FIX, _TURN_SPEED_KT)
    assert pts is not None
    assert pts[0] == (_RW16.ident, _RW16.lat, _RW16.lon)


def test_departure_flies_runway_heading_before_turning():
    pts = expand_runway_departure_heuristic(_RW16, _ENROUTE_FIX, _TURN_SPEED_KT)
    assert pts is not None
    # The second point is the end of the wings-level initial leg: its bearing
    # FROM the threshold must be the runway's own true bearing, not something
    # already bent towards the fix.
    brg = compute_bearing(_RW16.lat, _RW16.lon, pts[1][1], pts[1][2])
    assert brg == pytest.approx(_RW16.true_bearing, abs=0.5)


def test_departure_turn_is_smooth_and_goes_the_short_way():
    """Every consecutive-triple heading change is small and steps the same
    direction throughout — a continuous banked turn, not a corner or a turn
    the long way round."""
    pts = expand_runway_departure_heuristic(_RW16, _ENROUTE_FIX, _TURN_SPEED_KT)
    assert pts is not None
    bearings = [
        compute_bearing(a[1], a[2], b[1], b[2]) for a, b in zip(pts, pts[1:])
    ]
    deltas = []
    for a, b in zip(bearings, bearings[1:]):
        d = (b - a + 180.0) % 360.0 - 180.0
        if abs(d) > 0.01:
            deltas.append(d)
    assert deltas, "expected at least one turning step"
    # No single step re-courses by more than a steep-but-flyable bank would
    # (a discontinuous jump would show up as one huge outlier here).
    assert all(abs(d) < 45.0 for d in deltas)
    # All turning the same way (all left, or all right) — a continuous arc.
    signs = {d > 0 for d in deltas}
    assert len(signs) == 1
    # And it is the SHORT way: VYNT's runway heading (157) to the fix's real
    # bearing (~76, ENE) is an ~81 deg turn one way; going the other way would
    # be ~279 deg. Total sweep must match the short way, not the long one.
    total = sum(deltas)
    assert abs(total) < 180.0


def test_departure_ends_established_towards_the_fix():
    pts = expand_runway_departure_heuristic(_RW16, _ENROUTE_FIX, _TURN_SPEED_KT)
    assert pts is not None
    last = pts[-1]
    track = compute_bearing(last[1], last[2], *_ENROUTE_FIX)
    bearing_now = compute_bearing(pts[-2][1], pts[-2][2], last[1], last[2])
    assert abs(((track - bearing_now + 180.0) % 360.0) - 180.0) < 5.0


def test_departure_already_on_track_needs_no_turn():
    """A fix already dead ahead on runway heading gets no arc — just the
    threshold and the wings-level leg."""
    dead_ahead = project_point(_RW16.lat, _RW16.lon, _RW16.true_bearing, 20.0)
    pts = expand_runway_departure_heuristic(_RW16, dead_ahead, _TURN_SPEED_KT)
    assert pts is not None
    assert len(pts) == 2


def test_departure_falls_back_to_none_for_degenerate_geometry():
    """A target coincident with the end of the initial leg has no defined
    bearing to turn towards — the caller must fall back to DCT rather than
    receive broken geometry."""
    initial_pt = project_point(_RW16.lat, _RW16.lon, _RW16.true_bearing, 1.0)
    pts = expand_runway_departure_heuristic(_RW16, initial_pt, _TURN_SPEED_KT)
    assert pts is None


def _track(p, q):
    return compute_bearing(p[1], p[2], q[1], q[2])


def _off_deg(a, b):
    return abs((a - b + 180.0) % 360.0 - 180.0)


def test_arrival_always_ends_on_final_into_the_threshold():
    """Whatever side it comes from, the last leg is the final: from the join
    point on the extended centreline, along the runway's own bearing, onto the
    threshold — never across the runway or to the aerodrome point."""
    for from_ll in [(19.75, 96.60), (21.5, 99.5), (20.9, 100.3), (19.9, 99.3)]:
        pts = runway_arrival_pattern(_RW04, from_ll)
        assert pts[-1][1:] == (_RW04.lat, _RW04.lon)
        assert _off_deg(_track(pts[-2], pts[-1]), _RW04.true_bearing) < 1.0
        join_nm = haversine_distance(pts[-2][1], pts[-2][2], _RW04.lat, _RW04.lon)
        assert join_nm == pytest.approx(RUNWAY_FINAL_NM, abs=0.01)


def test_arrival_from_the_approach_side_flies_straight_in():
    reciprocal = (_RW04.true_bearing + 180.0) % 360.0
    far_out = project_point(_RW04.lat, _RW04.lon, reciprocal + 20.0, 40.0)
    pts = runway_arrival_pattern(_RW04, far_out)
    assert len(pts) == 2  # join point, threshold


def test_arrival_from_abeam_flies_a_base_on_its_own_side():
    """From off to the side, a base leg perpendicular to final first, on the
    side the aircraft is already on — it never crosses the final to get there."""
    reciprocal = (_RW04.true_bearing + 180.0) % 360.0
    # Off to the right, still on the approach side of the threshold (exactly
    # abeam or beyond, it flies a downwind first — see the next test).
    abeam_right = project_point(_RW04.lat, _RW04.lon, reciprocal + 80.0, 30.0)
    pts = runway_arrival_pattern(_RW04, abeam_right)
    assert len(pts) == 3  # base, join, threshold
    base, join = pts[0], pts[1]
    assert _off_deg(_track(base, join), reciprocal - 90.0) < 1.0
    side = (compute_bearing(join[1], join[2], base[1], base[2]) - reciprocal) % 360.0
    assert side == pytest.approx(90.0, abs=1.0)
    assert haversine_distance(base[1], base[2], join[1], join[2]) == pytest.approx(
        RUNWAY_BASE_OFFSET_NM, abs=0.01
    )


def test_arrival_from_beyond_the_runway_flies_a_downwind_first():
    """From past the far end: downwind abeam the threshold, base, final — not
    a cut straight across the runway."""
    beyond = project_point(_RW04.lat, _RW04.lon, _RW04.true_bearing + 10.0, 30.0)
    pts = runway_arrival_pattern(_RW04, beyond)
    assert len(pts) == 4  # downwind, base, join, threshold
    reciprocal = (_RW04.true_bearing + 180.0) % 360.0
    assert _off_deg(_track(pts[0], pts[1]), reciprocal) < 1.0  # downwind leg


@pytest.fixture
def vymd_runways():
    ends = [
        RunwayEnd("VYMD", "RW17", 21.72005833, 95.97401111, 171, 171),
        RunwayEnd("VYMD", "RW35", 21.68203333, 95.98074444, 351, 351),
    ]
    saved = dict(_RUNWAY_ENDS)
    register_runways(ends)
    yield
    _RUNWAY_ENDS.clear()
    _RUNWAY_ENDS.update(saved)


def test_pick_runway_takes_the_end_pointing_the_way_the_flight_goes(vymd_runways):
    assert pick_runway_for_track("VYMD", 340.0).ident == "RW35"  # northbound
    assert pick_runway_for_track("VYMD", 190.0).ident == "RW17"  # southbound
    # VYMD -> VYTL is ~107 deg (ESE): RW17 (171) is 64 deg off, RW35 (351) 116.
    assert pick_runway_for_track("VYMD", 107.0).ident == "RW17"


def test_pick_runway_without_runways_on_record_is_none():
    assert pick_runway_for_track("ZZZZ", 90.0) is None


def test_trajectory_source_label_is_distinct_from_published_procedures():
    assert RUNWAY_HEURISTIC_SOURCE not in ("SID", "STAR", "APPROACH")
    assert RUNWAY_HEURISTIC_SOURCE == "RUNWAY_HEURISTIC"
