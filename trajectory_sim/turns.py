"""Constant-radius turns for procedure legs that publish a turn direction.

A route is a list of fixes, and joining them with straight lines makes every
course change an instantaneous corner — the aircraft pivots on the spot. Real
aircraft roll into a banked turn and fly an arc, which is what the AIP charts
draw (e.g. a departure curving off the runway track onto the first fix).

ARINC 424 says how each of them is flown, and there are two kinds:

* **Fly-by** (the default) — the aircraft cuts the corner: it starts turning
  *before* the fix and rolls out *after* it, never quite crossing it. This is
  every ordinary en-route and TF-leg course change.
* **Fly-over** — the aircraft must cross the fix before turning, then curves
  round onto the next one. The data flags these three ways: the second character
  of ``waypoint_description_code`` is ``Y`` (e.g. the runway departure end
  ``DE21L`` is coded ``EY`` — you cannot cut the corner off the runway); the leg
  TERMINATES ON AN ALTITUDE (``CA``/``VA``/``FA``), which ends exactly where the
  altitude is made, so a turn started before it would be a turn started below
  the altitude the procedure requires (a SID's "climb on 015° to 700 ft"
  turns AT 700 ft, not on the way up to it); and a leg coded ``turn_direction``
  L/R is a "turn that way, then direct to my fix" leg (``DF``), which is a turn
  made after leaving the previous fix.

This module turns those rules into geometry:

    :func:`signed_turn_deg` — which way, and how far, a corner turns
    :func:`turn_radius_nm`  — how tight the aircraft can turn at a given speed
    :func:`flyby_arc`       — the corner-cutting arc through an ordinary fix
    :func:`turn_arc`        — the capture arc flown after crossing a fly-over fix

Each is emitted as a short polyline the caller splices into the route, so the
rest of the pipeline keeps treating the path as straight legs.
"""

from __future__ import annotations

import math

from .geodesy import compute_bearing, haversine_distance, project_point

_G_M_S2 = 9.80665
_M_PER_NM = 1852.0

#: Maximum bank angle by segment of operation — ICAO Doc 8168 (PANS-OPS)
#: Vol I, Table 2-1. A turn low and slow on final is flown gently (15°); one
#: in the en-route/terminal structure may be banked to 25°.
BANK_ANGLE_DEG: dict[str, float] = {
    "enroute": 25.0,
    "sid": 25.0,
    "star": 25.0,
    "initial_approach": 25.0,
    "intermediate_approach": 25.0,
    "final_approach": 15.0,
    "missed_approach": 15.0,
}

#: Bank angle for a segment not named in the table.
DEFAULT_BANK_DEG = 25.0

#: PANS-OPS offers a rate of turn as the alternative to a bank angle, and takes
#: whichever needs the LESS bank — i.e. the WIDER radius, so a procedure is
#: never designed round a turn tighter than the aircraft will really fly. Below
#: ~170 kt a 3°/s (rate-one) turn is the gentler of the two and this is what
#: binds; above it, the 25° bank does.
MAX_RATE_OF_TURN_DEG_S = 3.0

#: Angular spacing of the emitted arc points. 5° keeps the chord error under a
#: metre at the radii flown here while adding few points to the route.
_ARC_STEP_DEG = 5.0

#: Below this the "turn" is just course-keeping noise — emit no arc.
MIN_TURN_DEG = 2.0

#: Beyond this a fly-by is geometrically impossible: cutting a near-reversal
#: corner would start the turn an unbounded distance before the fix. Such a
#: corner is flown over and captured (:func:`turn_arc`) instead.
MAX_FLYBY_DEG = 175.0

#: A fly-by turn may eat at most this fraction of either leg it joins, so the
#: arcs at two adjacent fixes can never overlap. A corner too tight for the
#: nominal radius is flown at a smaller one (as an FMS does) rather than
#: skipped — the turn stays smooth, it is just banked harder.
_MAX_LEG_FRACTION = 0.45

#: How far *inside* the fix a fly-by arc is allowed to bow — the corner cut,
#: ``d = R·(sec(Δ/2) − 1)`` measured along the turn bisector. A pure PANS-OPS
#: fly-by grows this with the radius, so a wide cruise-speed turn passes miles
#: short of the fix; capping it keeps the curve hugging the waypoint (the FMS
#: banks harder than the nominal 25° for the close fix). Only the wide/fast
#: turns are tightened — a slow SID turn already cuts less than this and is
#: left untouched.
_MAX_FLYBY_CUT_NM = 0.5

#: A fly-by may be tightened by the two caps above, but only so far: past
#: this fraction of the nominal radius the aircraft would have to bank
#: harder than it ever does (0.8 x nominal is 25 deg -> 30 deg). A corner
#: that cannot be cut inside that budget is not a fly-by at all — it is
#: flown OVER and captured, which is what a 150 deg downwind-to-base turn
#: really is. Without this floor the caps kept shrinking the radius until
#: the turn became a hairpin: a 150 deg corner came out at 0.28 NM radius,
#: an 80 deg bank, drawn as a spike on the map.
#: The hardest a cap-tightened turn may be banked. PANS-OPS designs to 25
#: deg and that is what the nominal radius uses; an FMS will bank harder to
#: make a close fix, but not past this. The floor radius is the nominal
#: scaled by tan(nominal)/tan(max) — 0.67 x, i.e. a turn half again as
#: tight, and no tighter.
MAX_TURN_BANK_DEG = 35.0
_MIN_RADIUS_FRACTION = math.tan(math.radians(DEFAULT_BANK_DEG)) / math.tan(
    math.radians(MAX_TURN_BANK_DEG)
)


def signed_turn_deg(from_track_deg: float, to_track_deg: float) -> float:
    """Course change in (-180, 180]: negative = left, positive = right."""
    return (to_track_deg - from_track_deg + 180.0) % 360.0 - 180.0


def bank_angle_deg(segment: str) -> float:
    """Maximum bank for a segment of operation (PANS-OPS Vol I, Table 2-1)."""
    return BANK_ANGLE_DEG.get(segment, DEFAULT_BANK_DEG)


def turn_radius_nm(
    tas_kt: float,
    bank_deg: float = DEFAULT_BANK_DEG,
    rate_deg_s: float = MAX_RATE_OF_TURN_DEG_S,
) -> float:
    """Radius of a level turn at ``tas_kt``, in NM — ICAO Doc 8168, § 2.2.3.

    The coordinated-turn relation ``R = V² / (g · tan φ)`` (V in m/s), so the
    radius grows with the SQUARE of the speed: the same 25° bank that turns a
    200 kt departure in 1.3 NM needs 6.6 NM at cruise.F

    PANS-OPS caps the turn two ways and takes whichever calls for the less bank
    — the wider radius: the bank angle above, or a rate of turn ``R = V / ω``.
    Below roughly 170 kt the rate-one turn is the gentler one and binds; above
    it the bank angle does. ``rate_deg_s = 0`` disables the rate limit.

    Args:
        tas_kt: True airspeed in knots.
        bank_deg: Maximum bank for the segment — see :func:`bank_angle_deg`.
        rate_deg_s: Maximum rate of turn, degrees per second.

    Returns:
        Radius in nautical miles; 0.0 for a non-positive speed or an
        out-of-range bank.
    """
    if tas_kt <= 0 or not 0 < bank_deg < 90:
        return 0.0
    v_ms = tas_kt * _M_PER_NM / 3600.0
    radius_m = v_ms**2 / (_G_M_S2 * math.tan(math.radians(bank_deg)))
    if rate_deg_s > 0:
        radius_m = max(radius_m, v_ms / math.radians(rate_deg_s))
    return radius_m / _M_PER_NM


def generate_arc_points(
    centre_lat: float,
    centre_lon: float,
    radius_nm: float,
    start_deg: float,
    sweep_deg: float,
    step_deg: float = _ARC_STEP_DEG,
) -> list[tuple[float, float]]:
    """Points along a circular arc about a centre, in flight order.

    ``start_deg`` is the bearing from the centre to the aircraft when the turn
    begins; ``sweep_deg`` is how far that bearing travels — positive clockwise
    (a right turn), negative anticlockwise (a left turn). Both endpoints are
    included, so the first point is where the turn is entered and the last is
    where it rolls out.
    """
    if radius_nm <= 0 or step_deg <= 0:
        return []
    n_steps = max(1, math.ceil(abs(sweep_deg) / step_deg))
    return [
        project_point(
            centre_lat, centre_lon, start_deg + sweep_deg * k / n_steps, radius_nm
        )
        for k in range(n_steps + 1)
    ]


def flyby_arc(
    prev_lat: float,
    prev_lon: float,
    fix_lat: float,
    fix_lon: float,
    next_lat: float,
    next_lon: float,
    radius_nm: float,
    step_deg: float = _ARC_STEP_DEG,
    min_radius_nm: float | None = None,
) -> list[tuple[float, float]]:
    """The corner-cutting arc an aircraft flies *through* an ordinary fix.

    The turn is tangent to both legs: it leaves the inbound leg ``r·tan(Δ/2)``
    before the fix and rejoins the outbound leg the same distance after it, so
    the aircraft rolls out already on course and never crosses the fix itself.
    This is what an FMS does at a fly-by waypoint, and what makes a route of
    straight legs into one continuous track.

    The turn is taken the short way round — a fly-by is by definition the corner
    being cut, so there is no long way. A fix that must be crossed, or turned
    away from in a published direction, is not a fly-by: use :func:`turn_arc`.

    Args:
        prev_lat, prev_lon: Fix the aircraft is coming from.
        fix_lat, fix_lon: The fix being cut.
        next_lat, next_lon: Fix it is heading to.
        radius_nm: Nominal turn radius, e.g. from :func:`turn_radius_nm`. It is
            reduced if the corner is too tight for the legs to absorb it.
        step_deg: Angular spacing of the emitted points.

    Returns:
        Points from where the turn leaves the inbound leg to where it rejoins
        the outbound one, REPLACING the fix. Empty when the course change is
        negligible, or too close to a reversal to cut — the caller then keeps
        the fix as it is.
    """
    if radius_nm <= 0 or step_deg <= 0:
        return []
    # The tightest this particular turn may be flown. Everything below
    # narrows the radius to make the corner fit; this is the floor.
    if min_radius_nm is None:
        min_radius_nm = radius_nm * _MIN_RADIUS_FRACTION

    inbound_deg = compute_bearing(prev_lat, prev_lon, fix_lat, fix_lon)
    outbound_deg = compute_bearing(fix_lat, fix_lon, next_lat, next_lon)
    turn_deg = signed_turn_deg(inbound_deg, outbound_deg)
    if not MIN_TURN_DEG <= abs(turn_deg) <= MAX_FLYBY_DEG:
        return []

    sign = 1.0 if turn_deg > 0 else -1.0  # + = right
    half = math.radians(abs(turn_deg) / 2.0)

    # Shrink the radius if the corner can't absorb the nominal one, so adjacent
    # turns never eat into each other's legs.
    shortest_leg_nm = min(
        haversine_distance(prev_lat, prev_lon, fix_lat, fix_lon),
        haversine_distance(fix_lat, fix_lon, next_lat, next_lon),
    )
    tangent_nm = radius_nm * math.tan(half)
    max_tangent_nm = _MAX_LEG_FRACTION * shortest_leg_nm
    if tangent_nm > max_tangent_nm:
        tangent_nm = max_tangent_nm
        radius_nm = tangent_nm / math.tan(half)

    # Keep the arc near the fix: cap the corner cut d = R·(sec(Δ/2) − 1) so a
    # wide, fast turn doesn't bow miles short of the waypoint. Back-solve the
    # radius from the cap and re-derive the tangent; only bites when the
    # nominal turn cuts more than the cap (slow SID turns are left as they are).
    sec_half = 1.0 / math.cos(half)
    if sec_half > 1.0 and radius_nm * (sec_half - 1.0) > _MAX_FLYBY_CUT_NM:
        radius_nm = _MAX_FLYBY_CUT_NM / (sec_half - 1.0)
        tangent_nm = radius_nm * math.tan(half)
    # Both caps above shape the arc for the ROUTE's sake — keeping it near
    # its fix and clear of the neighbouring turn. Neither may override what
    # the aircraft can physically fly, so the radius comes back up to the
    # bank floor here. (It is what turned a 150 deg corner into a 0.28 NM
    # hairpin at 80 deg of bank: the cut cap alone forces R <= 0.175 NM at
    # that angle, and nothing was checking the result was still a turn.)
    radius_nm = max(radius_nm, min_radius_nm)
    tangent_nm = radius_nm * math.tan(half)
    if radius_nm <= 0:
        return []
    # …and if the corner cannot absorb even that, it is not a fly-by at all:
    # hand it back so the caller flies OVER the fix and captures the next leg,
    # which is how a near-reversal is really flown.
    if tangent_nm > max_tangent_nm:
        return []

    # Roll in `tangent_nm` short of the fix, with the centre abeam.
    entry_lat, entry_lon = project_point(
        fix_lat, fix_lon, inbound_deg + 180.0, tangent_nm
    )
    centre_lat, centre_lon = project_point(
        entry_lat, entry_lon, inbound_deg + 90.0 * sign, radius_nm
    )
    entry_deg = inbound_deg - 90.0 * sign  # bearing centre -> entry point

    return generate_arc_points(
        centre_lat, centre_lon, radius_nm, entry_deg, turn_deg, step_deg
    )


def turn_arc(
    start_lat: float,
    start_lon: float,
    inbound_track_deg: float,
    target_lat: float,
    target_lon: float,
    direction: str,
    radius_nm: float,
    step_deg: float = _ARC_STEP_DEG,
) -> list[tuple[float, float]]:
    """The arc flown from a fix until established direct to the next one.

    The aircraft crosses ``(start_lat, start_lon)`` on ``inbound_track_deg``,
    rolls into a ``direction`` ("L"/"R") turn of ``radius_nm``, and holds it
    until its track points at the target — the tangent from the turn circle to
    the target. It then flies straight, which is the leg the caller already has.

    Honouring the published direction matters: it is what makes a SID turn back
    over the field the way the chart draws it instead of taking the shorter way
    round.

    Args:
        start_lat, start_lon: Fix the turn begins over.
        inbound_track_deg: True track the aircraft arrives on.
        target_lat, target_lon: Fix being turned onto.
        direction: "L" or "R" (case-insensitive); anything else means no turn.
        radius_nm: Turn radius, e.g. from :func:`turn_radius_nm`.
        step_deg: Angular spacing of the emitted points.

    Returns:
        Points along the arc in flight order, EXCLUDING the start fix and
        ENDING at the roll-out point. Empty when no arc can or should be flown:
        the aircraft is already pointing at the target, or the target lies
        inside the turn circle (it cannot be captured by turning — the caller
        falls back to the straight leg).
    """
    turn = (direction or "").strip().upper()
    if turn not in ("L", "R") or radius_nm <= 0 or step_deg <= 0:
        return []

    sign = 1.0 if turn == "R" else -1.0
    # The turn centre lies abeam the aircraft, on the side it turns towards. If
    # the target is nearer than the radius, it falls INSIDE the circle the
    # aircraft would fly and no tangent to it exists — the turn could never roll
    # out onto it, and it would spiral instead. Tighten the turn until the target
    # is outside it (an FMS banks harder for a fix this close), rather than give
    # up and leave the leg straight, which is the sharp corner we came to remove.
    #
    # With the centre abeam at radius r, the target at distance d and ψ off the
    # bearing to the centre, the law of cosines puts it outside the circle when
    # d > 2·r·cos ψ. So r < d / (2·cos ψ) — and when cos ψ ≤ 0 the target is on
    # the far side of the aircraft from the centre and is never inside.
    to_target_nm = haversine_distance(start_lat, start_lon, target_lat, target_lon)
    psi_deg = signed_turn_deg(
        inbound_track_deg + 90.0 * sign,
        compute_bearing(start_lat, start_lon, target_lat, target_lon),
    )
    cos_psi = math.cos(math.radians(psi_deg))
    if cos_psi > 0:
        # Stay clear of the tangent-less limit, or the roll-out point sits at the
        # very edge and the geometry is numerically fragile.
        #
        # No bank floor here, unlike the fly-by. A capture is already the last
        # resort — the fly-by has handed the corner over — and its alternative
        # is not a wider turn, it is no turn at all: the raw corner, pivoted on
        # the spot. A STAR that turns 94 deg at BARON onto a fix 1.7 NM away,
        # and a hard turn there is closer to the truth than an instant one.
        radius_nm = min(radius_nm, 0.9 * to_target_nm / (2.0 * cos_psi))
    if radius_nm <= 0:
        return []

    centre_lat, centre_lon = project_point(
        start_lat, start_lon, inbound_track_deg + 90.0 * sign, radius_nm
    )
    centre_to_target_nm = haversine_distance(
        centre_lat, centre_lon, target_lat, target_lon
    )
    if centre_to_target_nm <= radius_nm:
        return []  # geodesic residual on top of the flat-earth bound above

    # Roll-out is where the radius to the aircraft is perpendicular to its
    # track, i.e. where the track is tangent to the circle and hits the target.
    half_angle_deg = math.degrees(math.acos(radius_nm / centre_to_target_nm))
    bearing_to_target = compute_bearing(
        centre_lat, centre_lon, target_lat, target_lon
    )
    rollout_deg = bearing_to_target - half_angle_deg * sign
    entry_deg = inbound_track_deg - 90.0 * sign  # bearing centre -> start fix

    # Angle swept, measured the way the aircraft actually turns.
    swept_deg = ((rollout_deg - entry_deg) * sign) % 360.0
    if swept_deg < MIN_TURN_DEG or swept_deg > 360.0 - MIN_TURN_DEG:
        # Already established on the target: nothing to capture. The upper guard
        # matters — a published turn direction on a leg whose fix is dead ahead
        # would otherwise be obeyed to the letter and fly a full 360° orbit.
        return []

    # The aircraft is already AT the entry point (it just crossed the fix), so
    # drop it and hand back only what it flies from there.
    return generate_arc_points(
        centre_lat, centre_lon, radius_nm, entry_deg, sign * swept_deg, step_deg
    )[1:]


def turn_to_heading(
    start_lat: float,
    start_lon: float,
    inbound_track_deg: float,
    target_track_deg: float,
    radius_nm: float,
    step_deg: float = _ARC_STEP_DEG,
) -> list[tuple[float, float]]:
    """The arc flown from a fix until established on a GIVEN heading.

    :func:`turn_arc` turns until pointed AT A FIX — its target is a place. This
    turns until pointed along a fixed COURSE — its target is a direction, e.g.
    a runway's own extended centreline, which is a line, not a point on it.
    Aiming a :func:`turn_arc` at a point near that line only approximates the
    heading (worse the farther the point actually reached is placed to make it
    converge), and using a point far along the line does the same for a
    different reason: a geodesic does not hold a constant true bearing over
    long distances the way a rhumb line does, so "far enough to look like a
    fixed heading" and "far enough that the geodesic itself has curved" fight
    each other. Solving for the heading directly has neither problem.

    Takes the SHORT way round — same convention as :func:`turn_arc`'s single
    turn direction, and there is no reason to publish the long way for a
    course-establishment turn.

    Args:
        start_lat, start_lon: Fix the turn begins over.
        inbound_track_deg: True track the aircraft arrives on.
        target_track_deg: True track to roll out established on.
        radius_nm: Turn radius, e.g. from :func:`turn_radius_nm`.
        step_deg: Angular spacing of the emitted points.

    Returns:
        Points along the arc in flight order, EXCLUDING the start fix and
        ENDING at the roll-out point, where the track is exactly
        ``target_track_deg``. Empty when the course change is negligible (the
        aircraft is already on the target heading) or the radius/step is
        non-positive.
    """
    if radius_nm <= 0 or step_deg <= 0:
        return []
    turn_deg = signed_turn_deg(inbound_track_deg, target_track_deg)
    if abs(turn_deg) < MIN_TURN_DEG:
        return []

    sign = 1.0 if turn_deg > 0 else -1.0
    centre_lat, centre_lon = project_point(
        start_lat, start_lon, inbound_track_deg + 90.0 * sign, radius_nm
    )
    entry_deg = inbound_track_deg - 90.0 * sign  # bearing centre -> start fix

    # The aircraft is already AT the start fix, so drop the first point (as
    # turn_arc does) and hand back only what it flies from there.
    return generate_arc_points(
        centre_lat, centre_lon, radius_nm, entry_deg, turn_deg, step_deg
    )[1:]
