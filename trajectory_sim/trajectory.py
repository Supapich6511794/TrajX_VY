"""Phase 3 — variable-speed flight timeline.

Stitches together the Phase 1 horizontal great-circle and the Phase 2
vertical profile into a per-second-accurate 4D timeline, replacing the
Phase 1 constant-ground-speed timing.

Three speed bands run end-to-end:

  * **Climb**   — time-weighted average TAS over the BADA climb
    schedule. Honours the 250 kt CAS restriction below FL100 and the
    CAS→Mach crossover above the crossover altitude.
  * **Cruise**  — constant cruise Mach (converted to TAS at the cruise
    altitude).
  * **Descent** — same logic as climb, in reverse.

Each emitted sample carries its own ``tas_kt`` and ``gs_kt``. With the
default zero-wind model, ``gs_kt == tas_kt``; a wind layer can be slotted
in later by feeding a ``WindModel`` into :func:`build_flight_timeline`.

UTC timestamps are assigned by adding the elapsed seconds-from-EOBT to
the supplied ``eobt`` (which must already be timezone-aware UTC).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, Sequence

import pyproj

from trajectory_sim.geodesy import haversine_distance
from trajectory_sim.performance import (
    Phase,
    VerticalProfile,
    average_phase_tas_kt,
    cas_to_tas_kt,
    mach_to_tas_kt,
    aircraft_speeds,
    runway_threshold_elevation_ft,
    target_tas_kt,
)

_GEOD = pyproj.Geod(ellps="WGS84")
_M_PER_NM = 1852.0

#: How far before a descent fix (NM) a procedure speed limit starts slowing the
#: aircraft, so it crosses the fix already at/under the limit.
_SPD_LEAD_NM = 40.0

#: Closest two emitted samples may be (seconds). The sample grid is the output
#: cadence PLUS a sample at every route vertex, and a cadence tick can fall all
#: but on top of a vertex; anything tighter than this is one plot, not two.
_MIN_SAMPLE_GAP_S = 0.25


@dataclass(frozen=True)
class RouteConstraint:
    """A SID/STAR crossing restriction, mapped to its along-track distance.

    Built by the server from the spliced procedure legs (see
    ``_route_constraints``). ``phase`` is "climb" for a SID fix, "descent" for
    a STAR fix — it sets which side of the fix the altitude/speed limit shapes.
    """

    distance_nm: float
    phase: Phase  # "climb" | "descent"
    # Altitude bounds in feet (None = unbounded that side).
    alt_floor_ft: float | None = None
    alt_ceil_ft: float | None = None
    # Procedure speed limit (CAS kt; AT / AT-or-below only — an upper cap).
    spd_max_kt: float | None = None


@dataclass(frozen=True)
class TimelineSample:
    """One emitted 4D point along the trajectory."""

    elapsed_s: float
    epoch_ts: datetime
    lat: float
    lon: float
    altitude_ft: float
    phase: Phase
    tas_kt: float
    gs_kt: float
    track_deg: float


@dataclass(frozen=True)
class FlightTimeline:
    """Full variable-speed timeline for one flight.

    The horizontal route is sliced into 3 logical phases each with a
    constant *average* ground speed; the vertical profile (built with
    the right total_time_s) supplies altitude + phase per sample.
    """

    waypoints: list[tuple[float, float]]
    profile: VerticalProfile
    total_distance_nm: float
    climb_distance_nm: float
    cruise_distance_nm: float
    descent_distance_nm: float
    climb_avg_tas_kt: float
    cruise_tas_kt: float
    descent_avg_tas_kt: float
    samples: list[TimelineSample]

    @property
    def total_time_s(self) -> float:
        return self.profile.total_time_s


def _leg_distances_nm(
    waypoints: list[tuple[float, float]],
) -> list[float]:
    return [
        haversine_distance(
            waypoints[i][0], waypoints[i][1],
            waypoints[i + 1][0], waypoints[i + 1][1],
        )
        for i in range(len(waypoints) - 1)
    ]


#: A leg shorter than this (NM) is treated as degenerate: a duplicated fix
#: (e.g. the runway threshold repeated as the ADES anchor, or a turn-arc vertex
#: sitting on top of its fix). pyproj's forward azimuth between two coincident
#: points is 0°, so a sample landing on such a leg would otherwise report a due-
#: north heading — the touchdown point darting to 000° instead of the runway
#: track. Roughly 2 mm, far below any real leg.
_MIN_LEG_NM = 1e-6


def _leg_track_deg(
    waypoints: list[tuple[float, float]],
    leg_distances_nm: list[float],
    seg_index: int,
) -> float:
    """Forward azimuth (deg) of leg ``seg_index`` — or of the most recent leg
    before it that actually covers ground, when that leg is degenerate — so a
    zero-length leg never collapses a sample's heading to 0°."""
    for i in range(min(seg_index, len(leg_distances_nm) - 1), -1, -1):
        if leg_distances_nm[i] > _MIN_LEG_NM:
            lat_a, lon_a = waypoints[i]
            lat_b, lon_b = waypoints[i + 1]
            az, _, _ = _GEOD.inv(lon_a, lat_a, lon_b, lat_b)
            return az % 360.0
    return 0.0


def _locate_along_route(
    waypoints: list[tuple[float, float]],
    leg_distances_nm: list[float],
    distance_nm: float,
) -> tuple[float, float, float]:
    """Find (lat, lon, track_deg) at a given along-track distance.

    Walks the leg list to find which great-circle segment the distance
    falls in, then asks pyproj to step that segment forward by the
    residual distance. The heading is taken from the last leg that actually
    covers ground (see :func:`_leg_track_deg`), so a trailing duplicated fix
    doesn't snap the point's track to due north.
    """
    if distance_nm <= 0:
        lat0, lon0 = waypoints[0]
        return lat0, lon0, _leg_track_deg(waypoints, leg_distances_nm, 0)

    total = sum(leg_distances_nm)
    if distance_nm >= total:
        # Past the last waypoint — return the endpoint with the inbound track
        # of the final ground-covering leg.
        lat_b, lon_b = waypoints[-1]
        return lat_b, lon_b, _leg_track_deg(
            waypoints, leg_distances_nm, len(leg_distances_nm) - 1
        )

    consumed = 0.0
    for i, leg_nm in enumerate(leg_distances_nm):
        if distance_nm <= consumed + leg_nm:
            track = _leg_track_deg(waypoints, leg_distances_nm, i)
            lat_a, lon_a = waypoints[i]
            if leg_nm <= _MIN_LEG_NM:
                # Degenerate leg: the point is the fix itself; its heading is
                # carried over from the last real leg (track, above).
                return lat_a, lon_a, track
            residual_nm = distance_nm - consumed
            lat_b, lon_b = waypoints[i + 1]
            fwd_az, _, _ = _GEOD.inv(lon_a, lat_a, lon_b, lat_b)
            lon, lat, _ = _GEOD.fwd(
                lon_a, lat_a, fwd_az, residual_nm * _M_PER_NM
            )
            return lat, lon, track
        consumed += leg_nm

    # Safety net — should be unreachable given the early return above.
    lat_b, lon_b = waypoints[-1]
    return lat_b, lon_b, _leg_track_deg(
        waypoints, leg_distances_nm, len(leg_distances_nm) - 1
    )


def build_flight_timeline(
    waypoint_sequence: list[tuple[float, float]],
    aircraft_type: str,
    adep: str,
    ades: str,
    rfl_ft: float,
    eobt: datetime,
    output_every_s: float = 4.0,
    wind_kt: Optional[float] = None,
    constraints: "Optional[list[RouteConstraint]]" = None,
    dep_runway: Optional[str] = None,
    ades_runway: Optional[str] = None,
    fix_indices: "Optional[Sequence[int]]" = None,
    dep_elev_ft: Optional[float] = None,
    des_elev_ft: Optional[float] = None,
) -> FlightTimeline:
    """Construct a variable-speed flight timeline from EOBT.

    Args:
        waypoint_sequence: Ordered (lat, lon) waypoints, ADEP at index 0,
            ADES at index -1. Must have ≥ 2 points. May carry points that are
            not fixes — the vertices approximating a turn arc — in which case
            ``fix_indices`` says which ones are the real fixes.
        aircraft_type: ICAO type designator (e.g. ``"B738"``).
        adep, ades: ICAO codes for ADEP / ADES; used to look up field
            elevations.
        rfl_ft: Requested flight level in feet (e.g. 35 000 for FL350).
        eobt: Estimated Off-Block Time, timezone-aware UTC.
        output_every_s: Sampling cadence in seconds (default 4 s — the
            CAT62 surveillance rate).
        wind_kt: Optional **head-wind** component along the route, in
            knots. None ⇒ zero-wind (GS = TAS).
        dep_runway, ades_runway: ICAO runway idents (e.g. ``"RW09"``,
            ``"RW21L"``) for the departure/arrival ends. When given, the
            profile starts/ends at that runway's AIP threshold elevation
            instead of the aerodrome field elevation. None ⇒ field elevation.
        dep_elev_ft, des_elev_ft: Override the altitude the vertical profile
            starts / ends at. Default ``None`` derives them from the aerodrome
            (or runway threshold). A flight that is only PASSING THROUGH the
            area — already at cruise when it reaches the first fix and still at
            cruise at the last — sets both to its cruise level, which makes the
            climb / descent zero-length instead of inventing a climb from the
            ground at a fix that is nowhere near an aerodrome.
        fix_indices: Indices into ``waypoint_sequence`` that are real fixes.
            An extra sample is emitted as each of these is crossed (so the
            track lands exactly on every fix); the rest of the sequence — the
            vertices approximating a turn arc — is flown but not sampled, so
            arcs don't inject off-cadence points into the surveillance track.
            None ⇒ every point is a fix (the behaviour when no arcs are spliced
            in).

    Returns:
        A :class:`FlightTimeline` whose ``samples`` list carries one
        :class:`TimelineSample` per emitted point.
    """
    if len(waypoint_sequence) < 2:
        raise ValueError("waypoint_sequence must contain at least 2 points")

    leg_distances = _leg_distances_nm(waypoint_sequence)
    total_distance_nm = sum(leg_distances)

    # Start the climb at the departure runway threshold and end the descent
    # at the arrival runway threshold (Thai AIP AD 2 elevations) when a
    # runway is known; otherwise fall back to the aerodrome field elevation.
    dep_elev = (
        dep_elev_ft
        if dep_elev_ft is not None
        else runway_threshold_elevation_ft(adep, dep_runway)
    )
    des_elev = (
        des_elev_ft
        if des_elev_ft is not None
        else runway_threshold_elevation_ft(ades, ades_runway)
    )

    # Use cruise TAS as the first guess for total_time_s — only used to
    # bootstrap VerticalProfile.build, which itself caps cruise_alt to
    # the airframe's ceiling and to a length-of-flight envelope.
    cruise_tas_at_rfl = mach_to_tas_kt(
        aircraft_speeds(aircraft_type).cruise_mach, rfl_ft
    )
    rough_total_s = total_distance_nm / max(cruise_tas_at_rfl, 1.0) * 3600.0

    profile = VerticalProfile.build(
        total_time_s=rough_total_s,
        rfl_ft=rfl_ft,
        aircraft_type=aircraft_type,
        dep_elev_ft=dep_elev,
        des_elev_ft=des_elev,
    )
    cruise_alt = profile.cruise_alt_ft
    climb_time_s = profile.toc_time_s
    descent_time_s = rough_total_s - profile.tod_time_s

    # Phase-average ground speeds. Wind (head-wind only, optional) is
    # applied uniformly to all phases — refining to per-altitude wind
    # would need a real wind grid.
    climb_avg_tas = average_phase_tas_kt(
        aircraft_type, dep_elev, cruise_alt, "climb"
    )
    cruise_tas = mach_to_tas_kt(
        aircraft_speeds(aircraft_type).cruise_mach, cruise_alt
    )
    descent_avg_tas = average_phase_tas_kt(
        aircraft_type, des_elev, cruise_alt, "descent"
    )

    wind = wind_kt or 0.0
    climb_gs = max(60.0, climb_avg_tas - wind)
    cruise_gs = max(60.0, cruise_tas - wind)
    descent_gs = max(60.0, descent_avg_tas - wind)

    climb_distance_nm = climb_gs * climb_time_s / 3600.0
    descent_distance_nm = descent_gs * descent_time_s / 3600.0
    cruise_distance_nm = max(
        0.0, total_distance_nm - climb_distance_nm - descent_distance_nm
    )
    cruise_time_s = (cruise_distance_nm / cruise_gs) * 3600.0
    total_time_s = climb_time_s + cruise_time_s + descent_time_s

    # Rebuild the vertical profile with the *corrected* total time so
    # ``profile.at()`` returns the right phase at every sample.
    profile = VerticalProfile.build(
        total_time_s=total_time_s,
        rfl_ft=rfl_ft,
        aircraft_type=aircraft_type,
        dep_elev_ft=dep_elev,
        des_elev_ft=des_elev,
    )
    # The corrected (longer) total time can lift the length-capped cruise
    # altitude, so refresh it from the rebuilt profile — the constraint envelope
    # below (TOD anchor, gradients) must match the altitude ``profile.at()``
    # actually flies, or the descent would step down at top-of-descent.
    cruise_alt = profile.cruise_alt_ft

    # --- Procedure crossing restrictions (Phase 4) -----------------------
    # Shape the BADA altitude/speed profile to the SID/STAR constraints. When
    # there are none this is a no-op, so the engine's default output is
    # unchanged. Altitude is clamped into a per-distance [floor, ceiling]
    # envelope; a descent ceiling rises backward along the descent gradient so
    # the aircraft starts down early enough (i.e. TOD is pulled in), a climb
    # ceiling holds the climb until the fix is passed. Conflicts resolve in
    # favour of the ceiling (don't bust an at-or-below). Speed caps the TAS to
    # the procedure CAS limit (+ the existing 250/FL100 already in the BADA
    # speed). See `RouteConstraint`.
    cons = constraints or []
    g_climb = cruise_alt / max(climb_distance_nm, 1.0)
    g_desc = cruise_alt / max(descent_distance_nm, 1.0)

    # Top of Descent for a STAR is anchored per descent crossing restriction,
    # following the planning rule applied to each one:
    #     anchor = constraint_distance − (cruise_alt − constraint_alt)
    #               ÷ descent_gradient
    # Each restriction holds cruise until its own anchor, then its ceiling falls
    # backward along the descent gradient — so every backward line starts at
    # exactly cruise altitude at its anchor (no step). The lowest/earliest one
    # binds, so the descent begins at the first fix that requires it and still
    # meets every later, lower fix via the clamp below. See ``_alt_bounds``.

    def _bada_alt_at_dist(d: float) -> float:
        """Unconstrained BADA altitude (ft) at along-track distance ``d`` (NM)."""
        if d <= climb_distance_nm:
            t = d * 3600.0 / climb_gs
        elif d <= climb_distance_nm + cruise_distance_nm:
            t = climb_time_s + (d - climb_distance_nm) * 3600.0 / cruise_gs
        else:
            t = (
                climb_time_s
                + cruise_time_s
                + (d - climb_distance_nm - cruise_distance_nm) * 3600.0 / descent_gs
            )
        return profile.at(t)[0]

    # Local BADA vertical gradient (ft/NM) at each crossing fix. When a
    # restriction releases, the climb/descent resumes *from the held altitude*
    # at this real (steep, near-fix) rate and so catches up to and rejoins the
    # BADA curve — instead of snapping straight up/down to it (a vertical step).
    # Floored at the phase average so a fix sitting in a level segment still
    # releases on a sane slope.
    _grad_at_fix: dict[RouteConstraint, float] = {}
    for _c in cons:
        _near = _bada_alt_at_dist(min(total_distance_nm, _c.distance_nm + 1.0))
        _far = _bada_alt_at_dist(max(0.0, _c.distance_nm - 1.0))
        _g = abs(_near - _far) / 2.0
        _grad_at_fix[_c] = max(_g, g_climb if _c.phase == "climb" else g_desc)

    # Where the natural climb catches back up to each climb floor. A floor
    # that LIFTS the path at its fix (BADA still below the restriction there)
    # must release LEVEL — the aircraft holds the restriction altitude until
    # the natural climb rejoins it. Releasing on a falling gradient straight
    # from the fix (the old rule) let the track sag ~50 ft back onto the BADA
    # curve: a physically-impossible one-sample "descent" mid-climb.
    _floor_catchup: dict[RouteConstraint, float] = {}
    for _c in cons:
        if _c.alt_floor_ft is None or _c.phase != "climb":
            continue
        _lo = _c.distance_nm
        _hi = max(_c.distance_nm, climb_distance_nm)
        if _bada_alt_at_dist(_hi) < _c.alt_floor_ft:
            _floor_catchup[_c] = _hi  # floor ≥ cruise: hold to TOC, then decay
        else:
            for _ in range(40):  # bisect the crossing to sub-metre precision
                _mid = (_lo + _hi) / 2.0
                if _bada_alt_at_dist(_mid) < _c.alt_floor_ft:
                    _lo = _mid
                else:
                    _hi = _mid
            _floor_catchup[_c] = _hi

    def _alt_bounds(d: float) -> tuple[float, float]:
        floor = 0.0
        ceil = float("inf")
        for c in cons:
            if c.alt_ceil_ft is not None:
                if c.phase == "descent":
                    # Hold cruise until this restriction's own TOD anchor, then
                    # let its ceiling fall backward along the descent gradient
                    # (the line meets cruise exactly at the anchor → no step).
                    anchor = c.distance_nm - (cruise_alt - c.alt_ceil_ft) / g_desc
                    if d < anchor:
                        v = float("inf")  # before this fix's TOD: hold cruise
                    elif d <= c.distance_nm:
                        v = c.alt_ceil_ft + g_desc * (c.distance_nm - d)
                    else:
                        v = c.alt_ceil_ft
                else:  # climb: hold ≤ ceiling to the fix, then climb on from it
                    # Past the fix the cap rises at the fix's real BADA rate, so
                    # the aircraft resumes climbing *from* the held altitude and
                    # rejoins the BADA curve (no vertical step on release).
                    v = (
                        c.alt_ceil_ft
                        if d <= c.distance_nm
                        else c.alt_ceil_ft + _grad_at_fix[c] * (d - c.distance_nm)
                    )
                ceil = min(ceil, v)
            if c.alt_floor_ft is not None:
                if c.phase == "climb":
                    # Straight line from field level at departure (d=0 → 0) up to
                    # the floor at the fix, so the floor lifts the climb AT the
                    # fix but NEVER pins the START above field elevation. Any
                    # fixed backward gradient (the shallow g_climb, or even the
                    # steep near-fix rate) can stay positive all the way back to
                    # d=0 for a high or near-departure "at or above" fix and pin
                    # the start at thousands of feet. Anchoring the ramp at the
                    # departure guarantees it reaches 0 there. Past the fix the
                    # floor RELEASES at the fix's real climb rate — holding it
                    # flat would keep the minimum in force through cruise and
                    # descent and stop the aircraft descending below it (a
                    # flight that "landed" at FL130 because a SID said ≥13000).
                    if c.distance_nm <= 0.0:
                        v = 0.0  # a floor AT the departure fix can't pin the ground
                    elif d <= c.distance_nm:
                        v = c.alt_floor_ft * (d / c.distance_nm)
                    elif d <= _floor_catchup[c]:
                        # Hold LEVEL at the restriction until the natural climb
                        # catches up — never sag back down onto the BADA curve.
                        v = c.alt_floor_ft
                    else:
                        v = max(
                            0.0,
                            c.alt_floor_ft
                            - _grad_at_fix[c] * (d - _floor_catchup[c]),
                        )
                else:  # descent: stay ≥ floor from this fix's TOD anchor to the
                    # fix, then descend on from it. WITHOUT the anchor the floor
                    # would apply backward across the whole climb + cruise and,
                    # where a SID's low ceiling near departure conflicts, pin the
                    # start at that ceiling (a flight that began at 6000 ft, not
                    # its field elevation). Mirrors the descent-ceiling anchor
                    # above: the floor rises backward along the descent gradient
                    # and meets cruise exactly at the anchor (no step), and does
                    # not bind before it (climb/cruise stay free).
                    anchor = c.distance_nm - (cruise_alt - c.alt_floor_ft) / g_desc
                    if d < anchor:
                        v = 0.0  # before this fix's TOD: no floor
                    elif d <= c.distance_nm:
                        v = c.alt_floor_ft + g_desc * (c.distance_nm - d)
                    else:
                        v = max(0.0, c.alt_floor_ft - _grad_at_fix[c] * (d - c.distance_nm))
                floor = max(floor, v)
        return floor, ceil

    def _spd_cap(d: float) -> float:
        cap = float("inf")
        for c in cons:
            if c.spd_max_kt is None:
                continue
            if c.phase == "descent" and d >= c.distance_nm - _SPD_LEAD_NM:
                cap = min(cap, c.spd_max_kt)
            elif c.phase == "climb" and d <= c.distance_nm:
                cap = min(cap, c.spd_max_kt)
        return cap

    def _shape(alt: float, tas: float, dist_nm: float) -> tuple[float, float]:
        """Clamp one sample's altitude + TAS to the constraints (no-op when
        there are none). Ceiling wins over floor on conflict."""
        if cons:
            floor, ceil = _alt_bounds(dist_nm)
            alt = min(ceil, max(floor, alt))
            cap_cas = _spd_cap(dist_nm)
            if cap_cas != float("inf"):
                tas = min(tas, cas_to_tas_kt(cap_cas, alt))
        return alt, tas

    def _phase_for(alt: float, prev_alt: float | None, default: Phase) -> Phase:
        """Re-derive phase from the (possibly clamped) altitude trend: a
        constraint that makes the path rise/fall against BADA is reflected,
        but a level-off keeps the BADA phase — so a climb/descent restriction
        that briefly levels the aircraft is NOT mislabelled cruise (which would
        corrupt the top-of-climb / top-of-descent detection)."""
        if not cons or prev_alt is None:
            return default
        if alt > prev_alt + 1.0:
            return "climb"
        if alt < prev_alt - 1.0:
            return "descent"
        return default

    # --- Along-track distance <-> elapsed time ---------------------------
    # The phase-average ground speeds above set each phase's distance and time
    # BUDGET. Placing samples with those averages, however, would move the
    # aircraft at a constant rate through a climb or descent while the speed
    # reported for it (``target_tas_kt`` at the current altitude) varies by a
    # factor of two — so a trajectory's positions and its own speed column
    # disagreed. Anything measuring distance-over-time (arrival spacing, in
    # particular) then contradicts the speeds in the same file.
    #
    # So distance is integrated from the INSTANTANEOUS speed and normalised
    # back onto each phase's budget. Phase boundaries, phase distances and the
    # total flight time are unchanged — only the distribution WITHIN a phase
    # moves. And because ``average_phase_tas_kt`` is by construction the
    # time-average of ``target_tas_kt`` over the same altitude band, the
    # normalisation factor is ~1 and the implied speed comes out equal to the
    # reported one.
    _INTEG_STEP_S = 1.0
    #: Passes over the integration. The speed at a sample depends on the SHAPED
    #: altitude, which depends on along-track distance, which is what we are
    #: integrating — so it is a fixed point. The coupling is weak (only the
    #: constrained parts of the terminal area differ), and two refinement passes
    #: are past the point where the table stops moving.
    _INTEG_PASSES = 3
    #: Distance the along-track table may still move between passes and count
    #: as converged (NM). 0.005 NM is 9 m — a hundredth of the spacing between
    #: two output samples, and far below anything the trajectory is read at.
    _INTEG_TOL_NM = 0.005

    _PHASES = (
        (0.0, climb_time_s, climb_distance_nm),
        (climb_time_s, climb_time_s + cruise_time_s, cruise_distance_nm),
        (climb_time_s + cruise_time_s, total_time_s, descent_distance_nm),
    )

    def _speed_at(tt: float, dist_guess: "float | None") -> float:
        """Ground speed (kt) the sample loop will REPORT at this instant."""
        alt, ph = profile.at(tt)
        tas = target_tas_kt(aircraft_type, alt, ph)
        if dist_guess is not None:
            # Same shaping the emitted sample gets, so the speed we integrate is
            # the speed that ends up in the file.
            _alt, tas = _shape(alt, tas, dist_guess)
        return max(60.0, tas - wind)

    def _build_tables(
        prev_t: "list[float] | None", prev_d: "list[float] | None"
    ) -> tuple[list[float], list[float]]:
        t_tab: list[float] = [0.0]
        d_tab: list[float] = [0.0]
        for t0, t1, target_nm in _PHASES:
            span = max(0.0, t1 - t0)
            base = d_tab[-1]
            if span <= 0 or target_nm <= 0:
                if span > 0:
                    t_tab.append(t1)
                    d_tab.append(base + target_nm)
                continue
            n = max(1, int(math.ceil(span / _INTEG_STEP_S)))
            dt = span / n
            ts = [t0 + i * dt for i in range(n + 1)]
            raw = [0.0]
            for i in range(n):
                mid = ts[i] + dt / 2.0
                guess = (
                    _interp(prev_t, prev_d, mid)
                    if prev_t is not None and prev_d is not None
                    else None
                )
                # Midpoint rule — second-order, and cheap at a 1 s step.
                raw.append(raw[-1] + _speed_at(mid, guess) * dt / 3600.0)
            scale = target_nm / raw[-1] if raw[-1] > 1e-9 else 0.0
            for tt, dd in zip(ts[1:], raw[1:]):
                t_tab.append(tt)
                d_tab.append(base + dd * scale)
        return t_tab, d_tab

    def _interp(xs: list[float], ys: list[float], x: float) -> float:  # noqa: E306
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        lo, hi = 0, len(xs) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if xs[mid] <= x:
                lo = mid
            else:
                hi = mid
        span = xs[hi] - xs[lo]
        f = 0.0 if span <= 0 else (x - xs[lo]) / span
        return ys[lo] + (ys[hi] - ys[lo]) * f

    # Run the fixed point: the first pass integrates the unshaped speed, each
    # later one re-reads the shaped speed at the distances the previous pass
    # produced.
    #
    # It is a fixed point, so it is run until it STOPS MOVING rather than a set
    # number of times: on a normal profile the second pass already lands within
    # a few metres of the first and the third only repeats it. `_INTEG_PASSES`
    # stays as the ceiling, for the terminal-area shapes that are still moving.
    _t_tab, _d_tab = _build_tables(None, None)
    for _ in range(max(0, _INTEG_PASSES - 1)):
        prev_d = _d_tab
        _t_tab, _d_tab = _build_tables(_t_tab, _d_tab)
        if len(prev_d) == len(_d_tab) and all(
            abs(a - b) <= _INTEG_TOL_NM for a, b in zip(prev_d, _d_tab)
        ):
            break

    # Mutual inverses (the table is monotone because speed is always > 0), so a
    # sample placed at a waypoint's time still lands exactly on that waypoint.
    def _dist_at_time(tt: float) -> float:
        return _interp(_t_tab, _d_tab, tt)

    def _time_at_dist(d: float) -> float:
        return _interp(_d_tab, _t_tab, d)

    # Sample every `output_every_s`, PLUS a sample at every route FIX (leg
    # boundary) so the drawn path runs exactly through each one — enroute, SID,
    # STAR and PBN-approach alike — AND at every vertex of a turn arc, so a turn
    # is traced point by point instead of chorded across. Both are already in
    # `waypoint_sequence`; we fold each one's crossing time into the sample grid.
    # The ADEP/ADES endpoints come from {0, total}.
    #
    # `fix_indices` narrows this to the fixes alone, leaving the arcs flown but
    # unsampled — a strictly-cadenced track, at the cost of a turn drawn as a
    # handful of long chords. The API doesn't use it: an arc vertex is a place
    # the aircraft really is, so a sample there is a real plot, and the grid is
    # already off-cadence at every fix anyway.
    fixes = None if fix_indices is None else set(fix_indices)
    wp_times: list[float] = []
    _acc = 0.0
    for _i, _ld in enumerate(leg_distances[:-1]):  # interior only (skip ADES)
        _acc += _ld
        if fixes is None or (_i + 1) in fixes:
            wp_times.append(_time_at_dist(_acc))

    n_grid = int(total_time_s / output_every_s) if output_every_s > 0 else 0
    grid = {i * output_every_s for i in range(n_grid + 1)}
    grid |= {0.0, total_time_s}
    grid |= {t for t in wp_times if 0.0 < t < total_time_s}
    # Two plots a fraction of a second apart are the same plot — a cadence tick
    # landing all but on top of a fix or an arc vertex would otherwise emit both,
    # metres apart in the same second. Collapse them (the earlier one wins).
    times: list[float] = []
    for tt in sorted(grid):
        tt = min(max(tt, 0.0), total_time_s)
        if not times or tt - times[-1] > _MIN_SAMPLE_GAP_S:
            times.append(tt)

    samples: list[TimelineSample] = []
    for t in times:
        alt, phase = profile.at(t)
        dist_nm = _dist_at_time(t)
        lat, lon, track = _locate_along_route(
            waypoint_sequence, leg_distances, dist_nm
        )
        tas = target_tas_kt(aircraft_type, alt, phase)
        alt, tas = _shape(alt, tas, dist_nm)
        phase = _phase_for(
            alt, samples[-1].altitude_ft if samples else None, phase
        )
        gs = max(60.0, tas - wind)
        samples.append(TimelineSample(
            elapsed_s=t,
            epoch_ts=eobt + timedelta(seconds=t),
            lat=lat,
            lon=lon,
            altitude_ft=round(alt, 1),
            phase=phase,
            tas_kt=tas,
            gs_kt=gs,
            track_deg=track,
        ))

    return FlightTimeline(
        waypoints=list(waypoint_sequence),
        profile=profile,
        total_distance_nm=total_distance_nm,
        climb_distance_nm=climb_distance_nm,
        cruise_distance_nm=cruise_distance_nm,
        descent_distance_nm=descent_distance_nm,
        climb_avg_tas_kt=climb_avg_tas,
        cruise_tas_kt=cruise_tas,
        descent_avg_tas_kt=descent_avg_tas,
        samples=samples,
    )
