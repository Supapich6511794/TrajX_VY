"""Tests for the turn geometry (:mod:`trajectory_sim.turns`).

Joining fixes with straight lines makes every course change an instant pivot —
the aircraft's track jumps 90° between one surveillance sample and the next.
These pin the two turns ARINC 424 actually defines: the fly-by that cuts an
ordinary corner, and the fly-over capture that curves round a fix which must be
crossed (a runway departure end, or a leg published with a turn direction).
"""

from __future__ import annotations

import math

import pytest

from trajectory_sim.geodesy import (
    compute_bearing,
    haversine_distance,
    project_point,
)
from trajectory_sim.turns import (
    bank_angle_deg,
    flyby_arc,
    generate_arc_points,
    signed_turn_deg,
    turn_arc,
    turn_radius_nm,
)

# A corner near Yangon: fly north, turn 90° right at the fix, fly east.
_PREV = (16.90, 96.00)
_FIX = (17.10, 96.00)
_NEXT = (17.10, 96.30)


def _track(a: tuple[float, float], b: tuple[float, float]) -> float:
    return compute_bearing(a[0], a[1], b[0], b[1])


def test_radius_grows_with_the_square_of_the_speed() -> None:
    """R = V²/(g·tan φ), ICAO Doc 8168 § 2.2.3 — doubling the speed quadruples
    the radius, which is why a cruise turn needs miles and a departure one does
    not."""
    assert turn_radius_nm(200.0) == pytest.approx(1.24, abs=0.05)
    assert turn_radius_nm(400.0) / turn_radius_nm(200.0) == pytest.approx(4.0)
    assert turn_radius_nm(0.0) == 0.0


def test_a_shallower_bank_makes_a_wider_turn() -> None:
    """PANS-OPS Table 2-1 caps final approach at 15° where the en-route
    structure allows 25° — the same speed then needs a much wider turn."""
    assert bank_angle_deg("final_approach") == 15.0
    assert bank_angle_deg("missed_approach") == 15.0
    assert bank_angle_deg("sid") == 25.0
    assert bank_angle_deg("star") == 25.0
    assert bank_angle_deg("enroute") == 25.0
    assert bank_angle_deg("anything_else") == 25.0

    slow = turn_radius_nm(180.0, bank_deg=bank_angle_deg("final_approach"))
    steep = turn_radius_nm(180.0, bank_deg=bank_angle_deg("star"))
    assert slow > steep


def test_the_rate_of_turn_limit_widens_a_slow_turn() -> None:
    """PANS-OPS offers a 3°/s rate of turn as the alternative to the bank angle
    and takes whichever needs LESS bank — the wider radius. Below ~170 kt that
    is the rate-one turn, so it, not the 25° bank, sets the radius."""
    slow_kt = 120.0
    banked_only = turn_radius_nm(slow_kt, rate_deg_s=0.0)
    with_rate_cap = turn_radius_nm(slow_kt)
    assert with_rate_cap > banked_only
    # A rate-one turn is 360° in 120 s, so its radius is V·120/(2π) — 0.64 NM
    # at 120 kt.
    assert with_rate_cap == pytest.approx(120.0 * 120.0 / 3600.0 / (2 * math.pi), abs=0.01)

    # Fast enough and the 25° bank is the gentler cap again — it binds instead.
    assert turn_radius_nm(300.0) == pytest.approx(
        turn_radius_nm(300.0, rate_deg_s=0.0)
    )


def test_arc_points_run_from_entry_to_roll_out() -> None:
    """generate_arc_points sweeps a bearing about the centre: positive is a
    right turn, negative a left one, and both ends are included."""
    centre = (13.90, 100.60)
    arc = generate_arc_points(*centre, 2.0, 0.0, 90.0, step_deg=30.0)
    assert len(arc) == 4  # 0°, 30°, 60°, 90°
    for lat, lon in arc:
        assert haversine_distance(*centre, lat, lon) == pytest.approx(2.0, abs=0.01)
    assert compute_bearing(*centre, *arc[0]) == pytest.approx(0.0, abs=0.1)
    assert compute_bearing(*centre, *arc[-1]) == pytest.approx(90.0, abs=0.1)
    # A negative sweep runs the other way round.
    left = generate_arc_points(*centre, 2.0, 0.0, -90.0, step_deg=30.0)
    assert compute_bearing(*centre, *left[-1]) == pytest.approx(270.0, abs=0.1)


def test_signed_turn_is_positive_right_negative_left() -> None:
    assert signed_turn_deg(350.0, 20.0) == pytest.approx(30.0)  # right, over north
    assert signed_turn_deg(20.0, 350.0) == pytest.approx(-30.0)  # left
    # A reversal has no side; it comes back at the -180 end of the range.
    assert abs(signed_turn_deg(90.0, 270.0)) == pytest.approx(180.0)


# --- fly-by: the corner is cut ------------------------------------------------


def test_flyby_cuts_the_corner_and_never_crosses_the_fix() -> None:
    arc = flyby_arc(*_PREV, *_FIX, *_NEXT, radius_nm=2.0)
    assert arc
    # The fix is bypassed — the turn is inside it.
    assert min(haversine_distance(*_FIX, lat, lon) for lat, lon in arc) > 0.1


def test_flyby_is_tangent_to_both_legs() -> None:
    """It leaves the inbound leg already on the inbound track and rejoins the
    outbound one already on the outbound track — so there is no corner left."""
    # Radius kept below the corner-cut cap so it exercises pure tangency
    # (r·(sec45°−1) = 0.41 NM < the 0.5 NM cap, so the radius is used verbatim).
    r = 1.0
    arc = flyby_arc(*_PREV, *_FIX, *_NEXT, radius_nm=r)
    inbound, outbound = _track(_PREV, _FIX), _track(_FIX, _NEXT)

    assert _track(_PREV, arc[0]) == pytest.approx(inbound, abs=0.5)
    assert _track(arc[-1], _NEXT) == pytest.approx(outbound, abs=0.5)
    # Entry and exit sit the same distance either side of the fix (r·tan(Δ/2)).
    tangent_nm = r * math.tan(math.radians(abs(signed_turn_deg(inbound, outbound)) / 2))
    assert haversine_distance(*_FIX, *arc[0]) == pytest.approx(tangent_nm, abs=0.05)
    assert haversine_distance(*_FIX, *arc[-1]) == pytest.approx(tangent_nm, abs=0.05)


def test_flyby_cut_is_pulled_towards_the_fix_but_not_past_the_bank_floor() -> None:
    """A wide, fast turn is tightened so the arc hugs the waypoint instead of
    bowing ~2.5 NM inside it — but only as far as the aircraft can bank. The cut
    cap on its own would demand a 1.2 NM radius here; the floor keeps the turn
    at something a jet actually flies, and the arc still comes in much closer
    than the uncapped one."""
    from trajectory_sim.turns import _MAX_FLYBY_CUT_NM, _MIN_RADIUS_FRACTION

    wide = 6.0  # ~cruise-speed radius
    pure_cut = wide * (1.0 / math.cos(math.radians(45.0)) - 1.0)
    assert pure_cut > 2.0  # uncapped, this turn bows miles inside the fix

    arc = flyby_arc(*_PREV, *_FIX, *_NEXT, radius_nm=wide)
    closest = min(haversine_distance(*_FIX, lat, lon) for lat, lon in arc)
    # Pulled in from the uncapped bow, but not to the cap itself — the floor
    # stops the tightening first.
    assert closest < pure_cut
    assert closest > _MAX_FLYBY_CUT_NM
    floor_cut = wide * _MIN_RADIUS_FRACTION * (1.0 / math.cos(math.radians(45.0)) - 1.0)
    assert closest == pytest.approx(floor_cut, abs=0.05)
    # Still a real fly-by: tangent to both legs, fix not crossed.
    assert _track(_PREV, arc[0]) == pytest.approx(_track(_PREV, _FIX), abs=0.5)
    assert closest > 0.1


def test_flyby_turns_the_short_way() -> None:
    """Cutting a corner is by definition the short way round — the track sweeps
    only through the course change, never the long way about."""
    arc = flyby_arc(*_PREV, *_FIX, *_NEXT, radius_nm=2.0)
    swept = sum(
        abs(signed_turn_deg(_track(a, b), _track(b, c)))
        for a, b, c in zip(arc, arc[1:], arc[2:])
    )
    assert swept < 95.0  # the corner is 90°, not 270°


def test_flyby_radius_shrinks_rather_than_overrunning_a_short_leg() -> None:
    """A tight corner between short legs is flown at a smaller radius (banked
    harder), so its turn can never eat into the neighbouring fix's."""
    near = project_point(*_FIX, 180.0, 3.0)  # inbound leg 3 NM: nominal won't fit
    arc = flyby_arc(*near, *_FIX, *_NEXT, radius_nm=2.0)
    assert arc
    assert haversine_distance(*_FIX, *arc[0]) < 3.0  # stayed on its own leg
    # Tighter than asked for, but still a turn: the shrink stopped at the floor.
    from trajectory_sim.turns import _MIN_RADIUS_FRACTION

    tangent_nm = haversine_distance(*_FIX, *arc[0])
    radius_nm = tangent_nm / math.tan(math.radians(45.0))
    assert radius_nm < 2.0
    assert radius_nm >= 2.0 * _MIN_RADIUS_FRACTION - 0.01


def test_flyby_hands_back_a_corner_too_tight_to_bank_into() -> None:
    """0.6 NM of inbound leg cannot absorb a 90 deg turn at cruise radius: cutting
    it would need a hairpin no aircraft flies. The fly-by declines, and the
    caller flies the fix over and captures the next leg instead — which is what
    used to be drawn as a spike on the map."""
    near = project_point(*_FIX, 180.0, 0.6)
    assert flyby_arc(*near, *_FIX, *_NEXT, radius_nm=5.0) == []


def test_no_arc_when_the_course_barely_changes() -> None:
    straight = project_point(*_FIX, _track(_PREV, _FIX), 10.0)
    assert flyby_arc(*_PREV, *_FIX, *straight, radius_nm=2.0) == []


def test_a_reversal_cannot_be_cut() -> None:
    """Cutting a 180° corner would start the turn infinitely far back — the
    caller falls back to crossing the fix and capturing the next one."""
    back = project_point(*_FIX, _track(_FIX, _PREV), 10.0)
    assert flyby_arc(*_PREV, *_FIX, *back, radius_nm=2.0) == []


# --- fly-over: the fix is crossed, then captured ------------------------------


def test_capture_turn_rolls_out_pointing_at_the_target() -> None:
    """The point of the capture: the turn ends the moment the aircraft's track
    is straight at the next fix, so the leg after it is the published one."""
    inbound = _track(_PREV, _FIX)
    arc = turn_arc(*_FIX, inbound, *_NEXT, "R", radius_nm=2.0)
    assert arc
    # The last chord's bearing is the roll-out track (to within the half-step
    # the chord lags the tangent by), and it points at the target.
    assert _track(arc[-1], _NEXT) == pytest.approx(
        _track(arc[-2], arc[-1]), abs=3.0
    )


def test_capture_turn_starts_at_the_fix_it_crossed() -> None:
    inbound = _track(_PREV, _FIX)
    arc = turn_arc(*_FIX, inbound, *_NEXT, "R", radius_nm=2.0)
    # The first point continues on the inbound track — the aircraft is over the
    # fix and only just rolling in.
    assert _track(_FIX, arc[0]) == pytest.approx(inbound, abs=6.0)


def test_capture_turn_obeys_the_published_direction() -> None:
    """The target is 90° to the RIGHT, but a SID published "turn LEFT" means the
    aircraft goes the long way round — which is exactly why the direction is
    coded. Honouring it is what makes a departure turn back over the field."""
    inbound = _track(_PREV, _FIX)
    left = turn_arc(*_FIX, inbound, *_NEXT, "L", radius_nm=2.0)
    right = turn_arc(*_FIX, inbound, *_NEXT, "R", radius_nm=2.0)
    assert len(left) > len(right)  # 270° the long way vs 90° the short way
    # It really does start by turning left (west of the inbound track).
    assert signed_turn_deg(inbound, _track(*[_FIX, left[1]])) < 0


def test_capture_tightens_rather_than_giving_up_on_a_close_target() -> None:
    """A fix nearer than the turn radius falls inside the circle the aircraft
    would fly: no tangent to it exists, so the turn could never roll out onto it.
    Tighten the turn until it can (an FMS banks harder) — giving up would leave
    exactly the sharp corner the arc is here to remove. A STAR turning 94° at a
    fix onto another 1.7 NM away used to do it as an instant pivot."""
    inbound = _track(_PREV, _FIX)
    close = project_point(*_FIX, 90.0, 0.5)  # 0.5 NM away, radius asked for 5 NM
    arc = turn_arc(*_FIX, inbound, *close, "R", radius_nm=5.0)
    assert arc
    # It still rolls out pointing at the target — that is what makes it a capture.
    assert _track(arc[-1], close) == pytest.approx(_track(arc[-2], arc[-1]), abs=5.0)
    # And it did so by flying a tighter circle than asked for.
    assert max(haversine_distance(*_FIX, lat, lon) for lat, lon in arc) < 5.0


def test_unknown_turn_direction_is_not_a_turn() -> None:
    inbound = _track(_PREV, _FIX)
    assert turn_arc(*_FIX, inbound, *_NEXT, "", radius_nm=2.0) == []
