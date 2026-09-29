"""Tests for the synthetic runway-heuristic turns
(:func:`expand_runway_departure_heuristic` / :func:`expand_runway_arrival_
heuristic`) — the plausible departure/arrival ground track used when a
runway is known but no coded SID/STAR/approach can be resolved.

Modelled on VYNT RW16 / VYTL RW04 (ARINC runway table), the exact pair a
straight "VYNT DCT VYTL" filing has no published procedure for.
"""

from __future__ import annotations

import pytest

from trajectory_sim.geodesy import compute_bearing, project_point
from trajectory_sim.navdata import (
    RUNWAY_HEURISTIC_SOURCE,
    RunwayEnd,
    expand_runway_arrival_heuristic,
    expand_runway_departure_heuristic,
)

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


def test_arrival_turns_onto_the_extended_runway_centreline():
    prev_fix = (19.75, 96.60)  # somewhere en route, west of VYTL
    last_fix = (20.30, 99.40)  # the route's last filed fix, still off to one side
    pts = expand_runway_arrival_heuristic(_RW04, prev_fix, last_fix, _TURN_SPEED_KT)
    assert pts is not None and len(pts) > 0
    # Rolling out, the track must point along the runway's own bearing (i.e.
    # towards the threshold from the extended centreline), not at some other
    # angle that would cross the numbers sideways.
    rollout_track = compute_bearing(pts[-2][1], pts[-2][2], pts[-1][1], pts[-1][2])
    diff = (rollout_track - _RW04.true_bearing + 180.0) % 360.0 - 180.0
    assert abs(diff) < 10.0


def test_arrival_already_aligned_needs_no_turn():
    """A last fix already on the extended centreline gets no synthetic arc —
    the caller keeps its existing straight-in-to-threshold behaviour."""
    reciprocal = (_RW04.true_bearing + 180.0) % 360.0
    on_centreline = project_point(_RW04.lat, _RW04.lon, reciprocal, 15.0)
    farther_back = project_point(_RW04.lat, _RW04.lon, reciprocal, 25.0)
    pts = expand_runway_arrival_heuristic(
        _RW04, farther_back, on_centreline, _TURN_SPEED_KT
    )
    assert pts is None


def test_trajectory_source_label_is_distinct_from_published_procedures():
    assert RUNWAY_HEURISTIC_SOURCE not in ("SID", "STAR", "APPROACH")
    assert RUNWAY_HEURISTIC_SOURCE == "RUNWAY_HEURISTIC"
