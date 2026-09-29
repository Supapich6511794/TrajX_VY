"""Flight-time validation against a performance-derived reference.

Compares a simulated total flight time with a reference time for the same
route, computes the delta in minutes and applies the acceptance criterion:

    delta = simulated_time − reference_time      (signed, minutes)
    PASS  if |delta| < 5 minutes
    FAIL  if |delta| ≥ 5 minutes

The reference is derived from the aircraft's own Thai APM performance (see
:func:`estimate_reference_min`); there is no measured city-pair table. The
``cat62_min`` field name on :class:`FlightTimeValidation` is kept for API
compatibility -- it holds whichever reference was used.

Typical loop:

    1. build a timeline → simulated minutes  (trajectory.build_flight_timeline)
    2. validate_against_estimate(...)        → PASS / FAIL + delta
    3. if FAIL, tune the speed schedule       (performance.tune_speed_schedule)
    4. rebuild + re-validate until PASS

This module has no third-party dependencies and does no I/O. It does depend
on :mod:`trajectory_sim.performance`, because the reference time is derived
from the aircraft's own Thai APM performance rather than a fixed curve.
"""

from __future__ import annotations

from dataclasses import dataclass

from .performance import (
    UnknownAircraftPerformance,
    average_phase_tas_kt,
    reachable_ceiling_ft,
    require_apm_performance,
    time_to_climb_s,
    time_to_descend_s,
)

#: Acceptance threshold — a flight passes when |delta| is strictly below
#: this many minutes.
ACCEPTANCE_THRESHOLD_MIN = 5.0

# --- Reference flight time, derived from the aircraft's own performance ----
# This used to be a measured distance-to-time curve for a B738 to RFL350,
# applied to EVERY airframe. It made the check grade an ATR 72 against 737
# numbers: a real 285 NM domestic leg simulated at 70 min was compared to a
# 49 min "reference" (349 kt average -- a jet) and reported FAIL, though the
# simulation was right and matched real ATR 72 block times.
#
# The reference is now built from the SAME data the simulator flies: the
# type's own Thai APM climb/descent rates and its own operational CAS/Mach
# schedule. A three-phase analytic profile (climb -> cruise -> descent) is
# cheap enough to run per candidate route, while tracking the airframe.
#
# There is deliberately NO fallback: a type without its own Thai APM rates
# AND its own speed schedule raises UnknownAircraftPerformance rather than
# borrowing the B738's. See performance.require_apm_performance.

#: Reference = predicted sim time + this terminal-area margin, so a nominal
#: route lands a few minutes UNDER the reference (PASS) instead of failing.
REFERENCE_MARGIN_MIN = 3.0

#: Bisection tolerance (feet) when solving the top a short hop can reach.
_TOP_SOLVE_TOL_FT = 50.0


@dataclass(frozen=True)
class ProfileEstimate:
    """Analytic climb/cruise/descent breakdown for one route."""

    aircraft_type: str
    distance_nm: float
    #: Altitude actually reached -- the requested cruise level, or lower on a
    #: hop too short to get there.
    top_ft: float
    #: False when the leg is too short to level off at ``cruise_alt_ft``.
    reached_cruise: bool
    climb_min: float
    cruise_min: float
    descent_min: float
    #: Provenance of the numbers used, for the acceptance check.
    dataset: str

    @property
    def total_min(self) -> float:
        return self.climb_min + self.cruise_min + self.descent_min

    def to_dict(self) -> dict[str, object]:
        """JSON-friendly dict (for an API response or a report file)."""
        return {
            "aircraft_type": self.aircraft_type,
            "distance_nm": round(self.distance_nm, 1),
            "top_ft": round(self.top_ft, 0),
            "reached_cruise": self.reached_cruise,
            "climb_min": round(self.climb_min, 1),
            "cruise_min": round(self.cruise_min, 1),
            "descent_min": round(self.descent_min, 1),
            "total_min": round(self.total_min, 1),
            "dataset": self.dataset,
        }


def _vertical_legs(
    aircraft_type: str,
    top_ft: float,
    dep_elev_ft: float,
    arr_elev_ft: float,
) -> tuple[float, float, float, float]:
    """(climb_min, climb_nm, descent_min, descent_nm) for a given top.

    Distances use each phase's time-weighted average TAS -- the same law
    :func:`~trajectory_sim.performance.climb_distance_nm` and the timeline
    builder use, so the estimate and the simulation agree by construction.
    """
    climb_s = time_to_climb_s(aircraft_type, dep_elev_ft, top_ft)
    desc_s = time_to_descend_s(aircraft_type, top_ft, arr_elev_ft)
    climb_nm = 0.0
    desc_nm = 0.0
    if climb_s > 0:
        tas = average_phase_tas_kt(aircraft_type, dep_elev_ft, top_ft, "climb")
        climb_nm = tas * climb_s / 3600.0
    if desc_s > 0:
        tas = average_phase_tas_kt(aircraft_type, top_ft, arr_elev_ft, "descent")
        desc_nm = tas * desc_s / 3600.0
    return climb_s / 60.0, climb_nm, desc_s / 60.0, desc_nm


def _solve_top_ft(
    aircraft_type: str,
    distance_nm: float,
    floor_ft: float,
    ceiling_ft: float,
    dep_elev_ft: float,
    arr_elev_ft: float,
) -> float:
    """Highest top whose climb + descent still fits inside ``distance_nm``.

    Bisection, because climb/descent distance rises monotonically with the
    top. Mirrors the simulator's behaviour on a hop too short to reach the
    filed level (a 51 NM leg tops out around 8 600 ft, not at cruise).
    """
    lo, hi = floor_ft, ceiling_ft
    while hi - lo > _TOP_SOLVE_TOL_FT:
        mid = (lo + hi) / 2.0
        _, c_nm, _, d_nm = _vertical_legs(
            aircraft_type, mid, dep_elev_ft, arr_elev_ft
        )
        if c_nm + d_nm <= distance_nm:
            lo = mid
        else:
            hi = mid
    return lo


def estimate_profile(
    distance_nm: float,
    aircraft_type: str,
    *,
    cruise_alt_ft: float | None = None,
    dep_elev_ft: float = 0.0,
    arr_elev_ft: float = 0.0,
) -> ProfileEstimate:
    """Analytic flight profile for ``aircraft_type`` over ``distance_nm``.

    Args:
        distance_nm: Along-route distance.
        aircraft_type: ICAO designator. Must have its OWN Thai APM rates
            and speed schedule -- no airframe is substituted.
        cruise_alt_ft: Planned cruise level. Clamped to the type's
            reachable ceiling; defaults to that ceiling.
        dep_elev_ft: Departure threshold elevation.
        arr_elev_ft: Arrival threshold elevation.

    Returns:
        The phase breakdown, including the top actually reached.

    Raises:
        UnknownAircraftPerformance: if using this type's numbers would mean
            falling back to another airframe's.
    """
    prov = require_apm_performance(aircraft_type)
    ac = prov.aircraft_type
    d = max(0.0, float(distance_nm))

    ceiling = reachable_ceiling_ft(ac)
    top = ceiling if cruise_alt_ft is None else min(float(cruise_alt_ft), ceiling)
    floor = max(dep_elev_ft, arr_elev_ft)
    top = max(top, floor)

    climb_min, climb_nm, desc_min, desc_nm = _vertical_legs(
        ac, top, dep_elev_ft, arr_elev_ft
    )

    if climb_nm + desc_nm <= d:
        cruise_nm = d - climb_nm - desc_nm
        cruise_tas = average_phase_tas_kt(ac, top, top, "cruise")
        cruise_min = cruise_nm / cruise_tas * 60.0 if cruise_tas > 0 else 0.0
        return ProfileEstimate(
            aircraft_type=ac,
            distance_nm=d,
            top_ft=top,
            reached_cruise=True,
            climb_min=climb_min,
            cruise_min=cruise_min,
            descent_min=desc_min,
            dataset=prov.dataset,
        )

    # Too short to level off: find the top the leg can actually reach.
    solved = _solve_top_ft(ac, d, floor, top, dep_elev_ft, arr_elev_ft)
    climb_min, _, desc_min, _ = _vertical_legs(
        ac, solved, dep_elev_ft, arr_elev_ft
    )
    return ProfileEstimate(
        aircraft_type=ac,
        distance_nm=d,
        top_ft=solved,
        reached_cruise=False,
        climb_min=climb_min,
        cruise_min=0.0,
        descent_min=desc_min,
        dataset=prov.dataset,
    )


def estimate_sim_min(
    distance_nm: float,
    aircraft_type: str,
    *,
    cruise_alt_ft: float | None = None,
    dep_elev_ft: float = 0.0,
    arr_elev_ft: float = 0.0,
) -> float:
    """Predicted *simulated* flight time (minutes) for this type and route.

    Raises:
        UnknownAircraftPerformance: see :func:`estimate_profile`.
    """
    return estimate_profile(
        distance_nm,
        aircraft_type,
        cruise_alt_ft=cruise_alt_ft,
        dep_elev_ft=dep_elev_ft,
        arr_elev_ft=arr_elev_ft,
    ).total_min


def estimate_reference_min(
    distance_nm: float,
    aircraft_type: str,
    *,
    margin_min: float = REFERENCE_MARGIN_MIN,
    cruise_alt_ft: float | None = None,
    dep_elev_ft: float = 0.0,
    arr_elev_ft: float = 0.0,
) -> float:
    """Reference estimate (minutes) for a pair with no real CAT62 sample.

    Predicted sim time plus a small terminal-area margin, so the simulator
    passes its own self-consistency check while still flagging gross
    outliers (huge detours) as FAIL. Surfaced as ``source="estimate"``.

    Raises:
        UnknownAircraftPerformance: see :func:`estimate_profile`.
    """
    return (
        estimate_sim_min(
            distance_nm,
            aircraft_type,
            cruise_alt_ft=cruise_alt_ft,
            dep_elev_ft=dep_elev_ft,
            arr_elev_ft=arr_elev_ft,
        )
        + margin_min
    )


def _route_key(adep: str, ades: str) -> str:
    return f"{adep.strip().upper()}-{ades.strip().upper()}"


@dataclass(frozen=True)
class FlightTimeValidation:
    """Result of comparing one simulated flight time to its reference."""

    route: str                 # "VYYY-VYMD"
    cat62_min: float           # reference minutes (real sample OR estimate)
    simulated_min: float       # simulated minutes
    delta_min: float           # signed: simulated − reference
    threshold_min: float       # acceptance threshold used
    status: str                # "PASS" | "FAIL"
    source: str = "cat62"      # "cat62" (real sample) | "estimate" (distance)

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    @property
    def is_estimate(self) -> bool:
        return self.source == "estimate"

    def report(self) -> str:
        """Human-readable report block (matches the spec's example)."""
        sign = "+" if self.delta_min >= 0 else "-"
        label = "Estimated Time" if self.is_estimate else "CAT62 Time"
        return (
            f"Route: {self.route}\n"
            f"{label}: {self.cat62_min:.0f} min"
            + (" (estimate)" if self.is_estimate else "")
            + "\n"
            f"Simulated Time: {self.simulated_min:.0f} min\n"
            f"Delta: {sign}{abs(self.delta_min):.0f} min\n"
            f"Status: {self.status}"
        )

    def to_dict(self) -> dict[str, object]:
        """JSON-friendly dict (for an API response or a report file)."""
        return {
            "route": self.route,
            "cat62_min": round(self.cat62_min, 1),
            "simulated_min": round(self.simulated_min, 1),
            "delta_min": round(self.delta_min, 1),
            "threshold_min": self.threshold_min,
            "status": self.status,
            "passed": self.passed,
            "source": self.source,
        }


def validate_flight_time(
    route: str,
    cat62_min: float,
    simulated_min: float,
    threshold_min: float = ACCEPTANCE_THRESHOLD_MIN,
    source: str = "cat62",
) -> FlightTimeValidation:
    """Build a :class:`FlightTimeValidation` from raw times.

    Args:
        route: Display label, e.g. ``"VYYY-VYMD"``.
        cat62_min: Reference flight time in minutes (real or estimated).
        simulated_min: Simulated flight time in minutes.
        threshold_min: PASS if ``abs(delta) < threshold_min``.
        source: ``"cat62"`` for a real sample, ``"estimate"`` for the
            distance-based fallback.

    Returns:
        The populated validation result.
    """
    delta = simulated_min - cat62_min
    status = "PASS" if abs(delta) < threshold_min else "FAIL"
    return FlightTimeValidation(
        route=route,
        cat62_min=cat62_min,
        simulated_min=simulated_min,
        delta_min=delta,
        threshold_min=threshold_min,
        status=status,
        source=source,
    )


# --- Cruise level vs FPL RFL --------------------------------------------------
# The simulated cruise altitude must match the FPL Requested Flight Level
# exactly. When it does not, the mismatch is only acceptable if a *physical*
# limit forced it lower — the aircraft's service ceiling, the top the climb
# schedule can reach, or a flight too short to reach the level in time. Those
# clamps PASS (with a reason); a cruise ABOVE the RFL, or below it with no
# limit binding, is an unexplained mismatch and FAILs.

#: Cruise level counts as an exact RFL match within this tolerance (feet).
LEVEL_MATCH_TOL_FT = 1.0


@dataclass(frozen=True)
class CruiseLevelValidation:
    """Result of comparing a simulated cruise altitude to the FPL RFL."""

    route: str
    rfl_ft: float           # FPL-requested level (feet)
    cruise_alt_ft: float    # simulated cruise altitude (feet)
    delta_ft: float         # signed: cruise − rfl (0 = exact, <0 = below)
    status: str             # "PASS" | "FAIL"
    reason: str             # exact | ceiling_limited | climb_limited
    #                         | distance_limited | overshoot | mismatch

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    @property
    def is_exact(self) -> bool:
        return self.reason == "exact"

    def report(self) -> str:
        """Human-readable report block (mirrors FlightTimeValidation)."""
        sign = "+" if self.delta_ft >= 0 else "-"
        return (
            f"Route: {self.route}\n"
            f"Requested Level: FL{self.rfl_ft / 100:.0f}\n"
            f"Simulated Cruise: FL{self.cruise_alt_ft / 100:.0f}\n"
            f"Delta: {sign}{abs(self.delta_ft):.0f} ft\n"
            f"Status: {self.status} ({self.reason})"
        )

    def to_dict(self) -> dict[str, object]:
        """JSON-friendly dict (for an API response or a report file)."""
        return {
            "route": self.route,
            "rfl_ft": round(self.rfl_ft, 1),
            "cruise_alt_ft": round(self.cruise_alt_ft, 1),
            "delta_ft": round(self.delta_ft, 1),
            "status": self.status,
            "passed": self.passed,
            "reason": self.reason,
        }


def validate_cruise_level(
    rfl_ft: float,
    cruise_alt_ft: float,
    *,
    service_ceiling_ft: float | None = None,
    climb_top_ft: float | None = None,
    reaches_rfl: bool | None = None,
    route: str = "",
) -> CruiseLevelValidation:
    """Validate a simulated cruise altitude against the FPL RFL.

    Args:
        rfl_ft: FPL Requested Flight Level, in feet (e.g. FL350 → 35000).
        cruise_alt_ft: Simulated cruise altitude, in feet.
        service_ceiling_ft: Airframe service ceiling; a level above it that
            is clamped lower PASSes as ``ceiling_limited``.
        climb_top_ft: Highest altitude the climb schedule reaches; a level
            above it PASSes as ``climb_limited``.
        reaches_rfl: Whether the flight is long enough to reach ``rfl_ft`` in
            time. ``False`` (or ``None`` when unknown) treats a below-RFL
            cruise as a legitimate ``distance_limited`` clamp; ``True`` marks
            it an unexplained ``mismatch`` (FAIL).
        route: Display label, e.g. ``"VYYY-VYMD"``.

    Returns:
        A :class:`CruiseLevelValidation`. Exact match and every physically
        justified clamp PASS; a cruise above the RFL (``overshoot``) or a
        below-RFL cruise with no limit binding (``mismatch``) FAIL.
    """
    delta = cruise_alt_ft - rfl_ft
    if abs(delta) <= LEVEL_MATCH_TOL_FT:
        reason, status = "exact", "PASS"
    elif delta > LEVEL_MATCH_TOL_FT:
        # Simulated cruise ABOVE the requested level — never a valid clamp.
        reason, status = "overshoot", "FAIL"
    elif service_ceiling_ft is not None and rfl_ft > service_ceiling_ft + LEVEL_MATCH_TOL_FT:
        reason, status = "ceiling_limited", "PASS"
    elif climb_top_ft is not None and rfl_ft > climb_top_ft + LEVEL_MATCH_TOL_FT:
        reason, status = "climb_limited", "PASS"
    elif reaches_rfl is True:
        # Level is within reach and time allows it, yet cruise came out lower.
        reason, status = "mismatch", "FAIL"
    else:
        # Too short to reach the level in time (or reachability unknown).
        reason, status = "distance_limited", "PASS"
    return CruiseLevelValidation(
        route=route,
        rfl_ft=rfl_ft,
        cruise_alt_ft=cruise_alt_ft,
        delta_ft=delta,
        status=status,
        reason=reason,
    )


# --- Top-of-climb altitude vs real track -------------------------------------
# The simulated top-of-climb altitude (its cruise level) must be within
# 2000 ft of the real track's cruise level for the same city pair. The real
# reference comes from trajectory_sim.cat62_track (the dominant cruise FL of
# the CAT062 surveillance track).

#: A simulated top-of-climb altitude passes within this many feet of the real.
TOC_THRESHOLD_FT = 2000.0


@dataclass(frozen=True)
class TocAltitudeValidation:
    """Result of comparing a simulated top-of-climb altitude to a real track."""

    route: str
    real_toc_ft: float       # real track's cruise level (feet)
    sim_toc_ft: float        # simulated top-of-climb altitude (feet)
    delta_ft: float          # signed: sim − real
    threshold_ft: float
    status: str              # "PASS" | "FAIL"

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    def report(self) -> str:
        """Human-readable report block (mirrors FlightTimeValidation)."""
        sign = "+" if self.delta_ft >= 0 else "-"
        return (
            f"Route: {self.route}\n"
            f"Real TOC: FL{self.real_toc_ft / 100:.0f}\n"
            f"Simulated TOC: FL{self.sim_toc_ft / 100:.0f}\n"
            f"Delta: {sign}{abs(self.delta_ft):.0f} ft "
            f"(threshold {self.threshold_ft:.0f} ft)\n"
            f"Status: {self.status}"
        )

    def to_dict(self) -> dict[str, object]:
        """JSON-friendly dict (for an API response or a report file)."""
        return {
            "route": self.route,
            "real_toc_ft": round(self.real_toc_ft, 1),
            "sim_toc_ft": round(self.sim_toc_ft, 1),
            "delta_ft": round(self.delta_ft, 1),
            "threshold_ft": self.threshold_ft,
            "status": self.status,
            "passed": self.passed,
        }


def validate_toc_altitude(
    sim_toc_ft: float,
    real_toc_ft: float,
    threshold_ft: float = TOC_THRESHOLD_FT,
    route: str = "",
) -> TocAltitudeValidation:
    """Validate a simulated top-of-climb altitude against a real track.

    Args:
        sim_toc_ft: Simulated top-of-climb altitude (the cruise level), feet.
        real_toc_ft: Real track's dominant cruise level, feet.
        threshold_ft: PASS if ``abs(sim − real) < threshold_ft`` (default
            2000 ft).
        route: Display label, e.g. ``"VYYY-VYMD"``.

    Returns:
        The populated :class:`TocAltitudeValidation`.
    """
    delta = sim_toc_ft - real_toc_ft
    status = "PASS" if abs(delta) < threshold_ft else "FAIL"
    return TocAltitudeValidation(
        route=route,
        real_toc_ft=real_toc_ft,
        sim_toc_ft=sim_toc_ft,
        delta_ft=delta,
        threshold_ft=threshold_ft,
        status=status,
    )


# --- Table of cruising levels (hemispheric rule) -----------------------------
# ICAO Annex 2 (Rules of the Air), Appendix 3 "Tables of cruising levels", RVSM
# column — the IFR cruising level depends on the magnetic track. (The ``cab_``
# prefix on the helpers below is historical; the table is the ICAO one.)
#   * track 000°–179° (eastbound): FL110, 130, 150 … 410, then 450, 490
#   * track 180°–359° (westbound): FL120, 140, 160 … 400, then 430, 470, 510
# Below FL410 this is the familiar odd-FL-east / even-FL-west parity; above
# FL410 the spacing widens to 2000 ft, so the exact published sets are used
# rather than a parity test. (VFR levels — the +500 ft variants — are not
# modelled; the sim flies IFR.)
_EAST_IFR_FL: frozenset[int] = frozenset(
    {110, 130, 150, 170, 190, 210, 230, 250, 270, 290, 310, 330, 350, 370, 390, 410, 450, 490}
)
_WEST_IFR_FL: frozenset[int] = frozenset(
    {120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400, 430, 470, 510}
)


def _is_eastbound(track_deg: float) -> bool:
    """True for track 000°–179° (the eastbound half of the table)."""
    return 0.0 <= (track_deg % 360.0) < 180.0


def cruising_levels_for(track_deg: float) -> list[int]:
    """The valid IFR cruising levels (FL) for a track, per the ICAO table."""
    return sorted(_EAST_IFR_FL if _is_eastbound(track_deg) else _WEST_IFR_FL)


def cab_cruising_level(track_deg: float, desired_fl: int) -> int:
    """Snap a desired FL to the nearest valid ICAO cruising level for a track.

    Ties break to the lower level. Lets a flight-plan generator pick a level
    that complies with the hemispheric rule instead of an arbitrary one.
    """
    levels = cruising_levels_for(track_deg)
    return min(levels, key=lambda fl: (abs(fl - desired_fl), fl))


def cab_cruising_level_capped(
    track_deg: float, desired_fl: int, max_fl: int
) -> int:
    """ICAO cruising level nearest ``desired_fl`` but never above ``max_fl``.

    Snaps like :func:`cab_cruising_level`, then — if that lands above
    ``max_fl`` (the highest level the airframe can actually reach; see
    :func:`performance.reachable_ceiling_ft`) — drops to the highest
    compliant level ``<= max_fl`` so a flight planner keeps cruise == RFL.
    Falls back to the plain nearest level when none fit under the cap.
    """
    fl = cab_cruising_level(track_deg, min(desired_fl, max_fl))
    if fl > max_fl:
        fits = [lv for lv in cruising_levels_for(track_deg) if lv <= max_fl]
        return max(fits) if fits else fl
    return fl


@dataclass(frozen=True)
class CruisingLevelValidation:
    """Result of checking an RFL against the ICAO table of cruising levels."""

    route: str
    track_deg: float
    fl: int                 # requested flight level (RFL / 100)
    direction: str          # "E" (000–179°) | "W" (180–359°)
    compliant: bool
    status: str             # "PASS" | "FAIL"
    nearest_valid_fl: int   # the table level it should have used

    @property
    def passed(self) -> bool:
        return self.status == "PASS"

    def report(self) -> str:
        band = "000-179 (E)" if self.direction == "E" else "180-359 (W)"
        line = (
            f"Route: {self.route}\n"
            f"Track: {self.track_deg:.0f}° [{band}]\n"
            f"Requested Level: FL{self.fl}\n"
            f"Status: {self.status}"
        )
        if not self.compliant:
            line += f" (should be FL{self.nearest_valid_fl} per ICAO Annex 2 App 3)"
        return line

    def to_dict(self) -> dict[str, object]:
        return {
            "route": self.route,
            "track_deg": round(self.track_deg, 1),
            "fl": self.fl,
            "direction": self.direction,
            "compliant": self.compliant,
            "status": self.status,
            "nearest_valid_fl": self.nearest_valid_fl,
        }


def validate_cruising_level(
    track_deg: float,
    rfl_ft: float,
    route: str = "",
) -> CruisingLevelValidation:
    """Check whether an RFL is a legal IFR cruising level for its track.

    Args:
        track_deg: Route track (great-circle bearing ADEP→ADES), degrees true.
        rfl_ft: Requested Flight Level in feet (FL350 → 35000).
        route: Display label, e.g. ``"VYYY-VYMD"``.

    Returns:
        A :class:`CruisingLevelValidation`. PASS when the FL is in the ICAO
        set for the track's hemisphere; FAIL (wrong odd/even for the
        direction) otherwise, with the nearest compliant level.
    """
    fl = round(rfl_ft / 100.0)
    east = _is_eastbound(track_deg)
    valid = fl in (_EAST_IFR_FL if east else _WEST_IFR_FL)
    return CruisingLevelValidation(
        route=route,
        track_deg=track_deg,
        fl=fl,
        direction="E" if east else "W",
        compliant=valid,
        status="PASS" if valid else "FAIL",
        nearest_valid_fl=cab_cruising_level(track_deg, fl),
    )


def validate_against_estimate(
    adep: str,
    ades: str,
    simulated_min: float,
    *,
    distance_nm: float | None,
    aircraft_type: str | None,
    cruise_alt_ft: float | None = None,
    dep_elev_ft: float = 0.0,
    arr_elev_ft: float = 0.0,
    threshold_min: float = ACCEPTANCE_THRESHOLD_MIN,
) -> FlightTimeValidation | None:
    """Grade a simulated time against the airframe's own performance estimate.

    The reference is :func:`estimate_reference_min` for this route distance,
    type and cruise level (``source="estimate"``). There is no measured
    city-pair table behind it: the retired CAT062 reference table was built
    for the previous deployment and has no Yangon FIR equivalent.

    Returns ``None`` -- no verdict at all -- when the distance or the type is
    missing, or when the type has no performance data of its own. A check
    computed from a borrowed airframe's numbers is worse than no check, since
    it reports a confident PASS/FAIL that means nothing.
    """
    if distance_nm is None or distance_nm <= 0 or not aircraft_type:
        return None
    try:
        estimate = estimate_reference_min(
            distance_nm,
            aircraft_type,
            cruise_alt_ft=cruise_alt_ft,
            dep_elev_ft=dep_elev_ft,
            arr_elev_ft=arr_elev_ft,
        )
    except UnknownAircraftPerformance:
        return None
    return validate_flight_time(
        route=_route_key(adep, ades),
        cat62_min=estimate,
        simulated_min=simulated_min,
        threshold_min=threshold_min,
        source="estimate",
    )
