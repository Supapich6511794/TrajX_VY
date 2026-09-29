"""Radar vectors to final — the path an OPEN STAR does not publish.

A closed arrival is fully coded: the STAR delivers the aircraft to the
approach's IAF and the approach flies it to the runway. An **open** STAR stops
short. Its last leg is a VM ("fly heading 034, expect vectors"), and from there
the controller — not the chart — puts the aircraft on final. Every published
VY STAR is closed, so this is dormant on the current data (see
:attr:`navdata.Procedure.vector_termination`); it runs whenever an open STAR
is loaded.

This module builds that missing piece: the downwind the aircraft holds, the
turn onto base, and the point where it joins the extended runway centreline.

    STAR ends (hand-over fix, "fly heading 034")
        │
        │  downwind — the "maintain heading" leg. Lengthening it is how
        │  spacing is bought: 1 NM more downwind also moves the intercept
        │  1 NM further out, so it buys ~2 NM of distance to touchdown.
        ▼
       turn point
        │
        │  base — flown at `intercept_deg` to the final approach track
        ▼
    intercept  ─────────────►  FAF  ─────────────►  threshold
               established           the approach procedure takes over

Constraints, from ICAO Doc 4444:

  * **§8.9.3.6** — "The final vector shall enable the aircraft to be
    established on the final approach track prior to intercepting the specified
    or nominal glide path of the approach procedure from below, and should
    provide an intercept angle with the final approach track of 45 degrees or
    less." So the intercept angle is capped (default 30°, the usual working
    value) and the join is placed `min_established_nm` outside the FAF, which is
    where the glide path is intercepted.
  * **§8.9.4.2** — the aircraft maintains its last assigned level until it
    intercepts the glide path. That is a vertical-profile rule; this module
    reports the intercept point so the profile builder can hold level to it.

Pure geometry: no I/O, no navdata lookups beyond the dataclasses passed in.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .geodesy import compute_bearing, haversine_distance, project_point
from .navdata import Procedure, RouteWaypoint, RunwayEnd

#: Doc 4444 §8.9.3.6 — the intercept angle with the final approach track must
#: not exceed this.
MAX_INTERCEPT_DEG = 45.0

#: Working intercept angle. Doc 4444 sets only the 45° ceiling; 30° is the
#: usual value flown, leaving room to steepen when spacing demands it.
DEFAULT_INTERCEPT_DEG = 30.0

#: How far outside the FAF the aircraft must be established on the final
#: approach track. §8.9.3.6 requires "established … prior to intercepting the
#: glide path", and the glide path is intercepted at the FAF; 2 NM is the
#: customary margin.
DEFAULT_ESTABLISHED_NM = 2.0

#: An assigned heading has to be flown for long enough to be a clearance rather
#: than a jink; also keeps the turn point clear of the STAR's last fix.
MIN_DOWNWIND_NM = 1.0

#: The base leg likewise needs enough length to roll out on before the turn to
#: final begins.
MIN_BASE_NM = 1.0

#: Longest assigned-heading leg that may be flown. A real downwind is bounded
#: by the TMA and by fuel; without a cap the solver would absorb any deficit by
#: vectoring towards the horizon.
MAX_DOWNWIND_NM = 40.0


@dataclass(frozen=True)
class VectorToFinal:
    """A radar-vector path from an open STAR's termination onto final."""

    #: End of the assigned-heading (downwind) leg — where the turn to base is.
    turn_point: RouteWaypoint
    #: Where the aircraft joins the extended runway centreline.
    intercept_point: RouteWaypoint
    #: Length of the assigned-heading leg (NM).
    downwind_nm: float
    #: Length of the base leg, turn point to intercept (NM).
    base_nm: float
    #: Angle at which the base leg meets the final approach track (°).
    intercept_angle_deg: float
    #: Distance from the intercept point to the FAF along the centreline (NM) —
    #: how much straight final the aircraft gets before the glide path.
    established_nm: float
    #: Track distance from the STAR termination to the intercept (NM) — the
    #: vector legs only.
    track_nm: float
    #: Track distance all the way to the threshold: the vector legs PLUS the
    #: final. This is the number spacing is bought in, because it is what sets
    #: the landing time. Note it moves at TWICE the rate of the downwind: a
    #: downwind extended by 1 NM also joins final 1 NM further out.
    total_nm: float
    #: ``total_nm`` of the SHORTEST legal join for this geometry. The delay
    #: actually achieved is ``total_nm - shortest_total_nm``; when that is less
    #: than the ``extend_nm`` asked for, the downwind hit its limit and the
    #: spacing has to be bought some other way (speed, or a hold).
    shortest_total_nm: float

    @property
    def points(self) -> tuple[RouteWaypoint, ...]:
        """The two fixes to splice between the STAR and the approach."""
        return (self.turn_point, self.intercept_point)


def faf_of(approach: Procedure) -> RouteWaypoint | None:
    """The approach's final approach fix.

    ARINC 424 flags it in the 4th character of the waypoint description code
    (``F``) — the same test the server's leg-segment classifier uses.
    """
    for leg in approach.legs:
        desc = leg.desc_code or ""
        if len(desc) > 3 and desc[3] == "F" and leg.has_fix:
            return RouteWaypoint(
                ident=leg.ident,  # type: ignore[arg-type]
                lat=leg.lat,  # type: ignore[arg-type]
                lon=leg.lon,  # type: ignore[arg-type]
            )
    return None


def final_segment(approach: Procedure) -> list[RouteWaypoint]:
    """The approach from its FAF to the end (the MAPt)."""
    out: list[RouteWaypoint] = []
    on_final = False
    for leg in approach.legs:
        desc = leg.desc_code or ""
        on_final = on_final or (len(desc) > 3 and desc[3] == "F")
        if on_final and leg.has_fix:
            out.append(
                RouteWaypoint(
                    ident=leg.ident,  # type: ignore[arg-type]
                    lat=leg.lat,  # type: ignore[arg-type]
                    lon=leg.lon,  # type: ignore[arg-type]
                )
            )
    return out


def approach_from(
    approach: Procedure, runway: RunwayEnd, join_nm: float
) -> list[RouteWaypoint]:
    """The approach fixes the aircraft actually flies after joining final
    ``join_nm`` from the threshold.

    A vectored arrival does not fly the approach's IAF entry — Doc 4444
    §8.9.4.1 has vectoring terminate when the aircraft turns onto the final
    approach track. But it does not follow that everything before the FAF is
    skipped: a straight-in procedure can lay its IAF (20 NM), two step-down
    fixes (15 and 10 NM) and the FAF along one centreline, so an aircraft
    joining at 12 NM physically overflies the 10 NM fix. Dropping it would drop its published crossing
    minimum (2 000 ft, there for obstacle clearance) from a leg still being
    flown.

    So the cut is by DISTANCE, not by the FAF: keep every published fix at or
    inside the join, discard the ones outside it that belong to the entry the
    aircraft never flew.
    """
    out: list[RouteWaypoint] = []
    for w in approach.waypoints():
        if haversine_distance(runway.lat, runway.lon, w.lat, w.lon) < join_nm:
            out.append(w)
    return out


def plan_open_star_join(
    star: Procedure,
    approach: Procedure,
    runway: RunwayEnd,
    *,
    extend_nm: float = 0.0,
    **kwargs: float,
) -> tuple[list[RouteWaypoint], VectorToFinal] | None:
    """Fixes for a vectored arrival: STAR, then the vector legs, then final.

    Replaces the approach's IAF/intermediate entry with the radar vectors an
    open STAR actually hands over to. Returns ``None`` — leaving the caller to
    fly the arrival as if it were closed — when anything needed is missing: a
    closed STAR, no published vector course, no FAF, or a geometry that will
    not close.
    """
    leg = star.vector_termination
    start = star.last_fix()
    if leg is None or start is None or leg.magnetic_course is None:
        return None
    faf = faf_of(approach)
    if faf is None or not final_segment(approach):
        return None

    heading_true = (leg.magnetic_course + runway.magnetic_variation) % 360.0
    faf_nm = haversine_distance(runway.lat, runway.lon, faf.lat, faf.lon)
    vtf = vector_to_final(
        start=start,
        heading_deg=heading_true,
        runway=runway,
        faf_nm=faf_nm,
        extend_nm=extend_nm,
        **kwargs,  # type: ignore[arg-type]
    )
    if vtf is None:
        return None
    # Everything inside the intercept — the step-down fixes the aircraft
    # overflies keep their crossing minima; the IAF entry it never flew is cut.
    join_nm = haversine_distance(
        runway.lat, runway.lon,
        vtf.intercept_point.lat, vtf.intercept_point.lon,
    )
    tail = approach_from(approach, runway, join_nm)
    if not tail:
        return None
    return [*star.waypoints(), *vtf.points, *tail], vtf


def _enu(
    origin: tuple[float, float], lat: float, lon: float
) -> tuple[float, float]:
    """(east, north) in NM of a point relative to an origin — a local flat
    frame, exact enough over the ~40 NM a vectoring pattern spans."""
    brg = compute_bearing(origin[0], origin[1], lat, lon)
    d = haversine_distance(origin[0], origin[1], lat, lon)
    r = math.radians(brg)
    return d * math.sin(r), d * math.cos(r)


def _unit(bearing_deg: float) -> tuple[float, float]:
    """(east, north) unit vector on a true bearing."""
    r = math.radians(bearing_deg)
    return math.sin(r), math.cos(r)


def _raw_legs(
    start: tuple[float, float],
    heading: tuple[float, float],
    target: tuple[float, float],
    intercept: tuple[float, float],
) -> tuple[float, float] | None:
    """Split ``target - start`` into ``d`` along ``heading`` then ``L`` along
    ``intercept``: solve ``d·h + L·i = target - start``.

    Returns the raw ``(d, L)`` — either may be NEGATIVE, meaning the join would
    run backwards along that leg. Callers test the sign themselves, because the
    distance at which it flips is exactly what has to be solved for. ``None``
    only when the two directions are parallel and never cross.
    """
    det = heading[0] * intercept[1] - heading[1] * intercept[0]
    if abs(det) < 1e-9:
        return None
    dx = target[0] - start[0]
    dy = target[1] - start[1]
    return (
        (dx * intercept[1] - dy * intercept[0]) / det,
        (heading[0] * dy - heading[1] * dx) / det,
    )


def _feasible_range(
    coeff_b: float, coeff_k: float, minimum: float, lo: float, hi: float
) -> tuple[float, float]:
    """Narrow ``[lo, hi]`` to where the affine ``coeff_b + coeff_k·s`` is at
    least ``minimum``. An empty result comes back as ``lo > hi``."""
    if abs(coeff_k) < 1e-12:
        return (lo, hi) if coeff_b >= minimum else (1.0, -1.0)
    bound = (minimum - coeff_b) / coeff_k
    return (max(lo, bound), hi) if coeff_k > 0 else (lo, min(hi, bound))


def _feasible_range_max(
    coeff_b: float, coeff_k: float, maximum: float, lo: float, hi: float
) -> tuple[float, float]:
    """Narrow ``[lo, hi]`` to where the affine ``coeff_b + coeff_k·s`` is at
    most ``maximum``. An empty result comes back as ``lo > hi``."""
    if abs(coeff_k) < 1e-12:
        return (lo, hi) if coeff_b <= maximum else (1.0, -1.0)
    bound = (maximum - coeff_b) / coeff_k
    return (lo, min(hi, bound)) if coeff_k > 0 else (max(lo, bound), hi)


def vector_to_final(
    *,
    start: RouteWaypoint,
    heading_deg: float,
    runway: RunwayEnd,
    faf_nm: float,
    extend_nm: float = 0.0,
    intercept_deg: float = DEFAULT_INTERCEPT_DEG,
    established_nm: float = DEFAULT_ESTABLISHED_NM,
    min_downwind_nm: float = MIN_DOWNWIND_NM,
    min_base_nm: float = MIN_BASE_NM,
    max_downwind_nm: float = MAX_DOWNWIND_NM,
) -> VectorToFinal | None:
    """Build the vector path from an open STAR's termination onto final.

    Args:
        start: The STAR's last fix — where the assigned heading begins.
        heading_deg: The published vector heading, degrees TRUE. (STAR legs
            carry it magnetic; add ``runway.magnetic_variation``.)
        runway: Landing runway. Its ``true_bearing`` IS the final approach
            track, and its threshold anchors the extended centreline.
        faf_nm: Distance from the threshold to the FAF along the centreline.
        extend_nm: Extra distance TO TOUCHDOWN the path must absorb — the
            spacing deficit from the arrival sequencer, in NM. 0 flies the
            shortest legal join; a positive value stretches the downwind,
            which is exactly the "maintain heading until separation"
            instruction. Because a longer downwind also joins final further
            out, the downwind itself only grows by about half of this.
        intercept_deg: Angle at which to meet the final approach track. Capped
            at :data:`MAX_INTERCEPT_DEG` (Doc 4444 §8.9.3.6).
        established_nm: Straight final required outside the FAF.
        min_downwind_nm: Shortest assigned-heading leg worth issuing.
        min_base_nm: Shortest base leg worth issuing.
        max_downwind_nm: Longest assigned-heading leg that may be flown. A
            real downwind is limited by the TMA boundary and by fuel, and
            without the cap the solver would "solve" any deficit by vectoring
            towards the horizon.

    Returns:
        The path, or ``None`` when the geometry cannot be closed — the aircraft
        is already inside the intercept, or the assigned heading diverges from
        the centreline so the two never cross. A caller that gets ``None``
        should re-sequence (hold, or a different runway) rather than vector.
    """
    angle = min(abs(intercept_deg), MAX_INTERCEPT_DEG)
    fat = runway.true_bearing % 360.0
    thr = (runway.lat, runway.lon)
    outbound = (fat + 180.0) % 360.0
    out_u = _unit(outbound)

    s0 = (start.lat, start.lon)
    p_start = _enu(thr, start.lat, start.lon)
    h_u = _unit(heading_deg % 360.0)

    # The intercept point sits on the extended centreline `s` NM from the
    # threshold. The nearest legal join is just outside the FAF.
    s_min = faf_nm + established_nm

    def centreline(s: float) -> tuple[float, float]:
        return (out_u[0] * s, out_u[1] * s)

    # Both leg lengths are AFFINE in `s` (the intercept point moves linearly
    # along the centreline), so sampling two values of `s` gives their exact
    # slopes — and the whole feasible range can then be solved rather than
    # searched. This matters: on a downwind the aircraft flies AWAY from the
    # field, so at the nearest legal intercept the join runs backwards. The
    # geometry only closes past a critical distance, which is what these
    # inequalities find.
    # (track, total, s, downwind, base, signed angle, shortest total)
    best: tuple[float, float, float, float, float, float, float] | None = None
    for signed in (angle, -angle):
        i_u = _unit((fat + signed) % 360.0)
        at0 = _raw_legs(p_start, h_u, centreline(0.0), i_u)
        at1 = _raw_legs(p_start, h_u, centreline(1.0), i_u)
        if at0 is None or at1 is None:
            continue
        d_b, ell_b = at0
        d_k, ell_k = at1[0] - d_b, at1[1] - ell_b

        # `s` is bounded below by the FAF + established leg, and above by how
        # long a downwind may be flown. The absolute sentinel only keeps the
        # range finite when the downwind length happens not to vary with `s`.
        lo, hi = s_min, s_min + 500.0
        lo, hi = _feasible_range(d_b, d_k, min_downwind_nm, lo, hi)
        lo, hi = _feasible_range(ell_b, ell_k, min_base_nm, lo, hi)
        lo, hi = _feasible_range_max(d_b, d_k, max_downwind_nm, lo, hi)
        if lo > hi:
            continue  # this turn direction never closes

        # Distance to TOUCHDOWN is what spacing is bought in: the two vector
        # legs plus the final (the intercept sits `s` NM from the threshold, and
        # all of it is flown). Its slope includes that +1·s, which is why an
        # extension of the downwind buys twice its own length in delay.
        slope = d_k + ell_k + 1.0
        s_short = lo if slope >= 0 else hi
        shortest_total = (d_b + ell_b) + slope * s_short
        s_use = s_short
        if extend_nm > 0 and slope > 1e-6:
            s_use = min(hi, max(lo, s_short + extend_nm / slope))
        d_use = d_b + d_k * s_use
        ell_use = ell_b + ell_k * s_use
        total = d_use + ell_use + s_use
        # Prefer the direction that gets closest to the REQUESTED delay, not
        # simply the shortest — a stretch that fell short is worse than one
        # that made it.
        want = shortest_total + max(0.0, extend_nm)
        if best is None or abs(total - want) < abs(best[1] - want):
            best = (d_use + ell_use, total, s_use, d_use, ell_use, signed,
                    shortest_total)
    if best is None:
        return None

    (track_nm, total_nm, s_final, downwind_nm, base_nm, signed_angle,
     shortest_total) = best

    turn_lat, turn_lon = project_point(
        s0[0], s0[1], heading_deg % 360.0, downwind_nm
    )
    icpt_lat, icpt_lon = project_point(thr[0], thr[1], outbound, s_final)
    return VectorToFinal(
        turn_point=RouteWaypoint(ident="TURN", lat=turn_lat, lon=turn_lon),
        intercept_point=RouteWaypoint(ident="INTC", lat=icpt_lat, lon=icpt_lon),
        downwind_nm=downwind_nm,
        base_nm=base_nm,
        intercept_angle_deg=abs(signed_angle),
        established_nm=max(0.0, s_final - faf_nm),
        track_nm=track_nm,
        total_nm=total_nm,
        shortest_total_nm=shortest_total,
    )
