"""Aircraft vertical performance — Phase 2 (BADA-style segmented model).

Builds a climb → cruise → descent altitude profile and labels each
trajectory sample's flight phase using a BADA-3-style piecewise model
keyed on altitude band: real airframes climb faster low than high and
descend at a roughly constant rate. The data tables here mirror the
shape of BADA OPF entries for the in-scope airframes; values are
typical published performance, not the licensed BADA dataset.

The public surface stays the contract output.py was already written
against — :class:`VerticalProfile` with :meth:`build` and :meth:`at` —
so swapping the old constant-rate placeholder for this segmented model
needed no caller changes.

Units: altitude in feet, rates in ft/min, time in seconds.
"""

from __future__ import annotations

import csv
import math
import sqlite3
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

#: Flight phase along the vertical profile.
Phase = Literal["climb", "cruise", "descent"]


# ---------------------------------------------------------------------------
# ISA atmosphere — used for Phase 3 CAS ↔ Mach ↔ TAS conversions.
#
# Two layers per the International Standard Atmosphere (ICAO Doc 7488 /
# ISO 2533):
#
#   * Troposphere (0 – 11 000 m): linear lapse rate of 6.5 K/km from 15 °C.
#   * Stratosphere (11 000 – 20 000 m): isothermal at −56.5 °C.
#
# Wind model: zero-wind throughout Phase 3 (GS = TAS). The simulator
# interface accepts a wind vector but the default is None and all
# conversion helpers below return airspeeds, not ground speeds.
# ---------------------------------------------------------------------------

_T0_K = 288.15            # ISA sea-level temperature (K)
_P0_PA = 101_325.0        # ISA sea-level pressure (Pa)
_A0_M_S = 340.294         # ISA sea-level speed of sound (m/s)
_LAPSE_K_PER_M = 0.0065   # Tropospheric lapse rate (K/m)
_TROPOPAUSE_M = 11_000.0  # Tropopause altitude (m, geopotential)
_TROPOPAUSE_T_K = _T0_K - _LAPSE_K_PER_M * _TROPOPAUSE_M  # 216.65 K
_GAMMA = 1.4              # Ratio of specific heats for dry air
_R_AIR = 287.05287        # Specific gas constant for dry air (J/(kg·K))
_G0 = 9.80665             # Standard gravity (m/s²)

_FT_TO_M = 0.3048
_MS_TO_KT = 3600.0 / 1852.0  # 1 m/s in knots


def isa_temperature_k(altitude_ft: float) -> float:
    """ISA static air temperature at altitude.

    Args:
        altitude_ft: Geometric altitude in feet AMSL.

    Returns:
        Temperature in kelvin. Constant at 216.65 K above the tropopause.
    """
    h_m = altitude_ft * _FT_TO_M
    if h_m <= _TROPOPAUSE_M:
        return _T0_K - _LAPSE_K_PER_M * h_m
    return _TROPOPAUSE_T_K


def isa_pressure_pa(altitude_ft: float) -> float:
    """ISA static pressure at altitude (Pa)."""
    h_m = altitude_ft * _FT_TO_M
    if h_m <= _TROPOPAUSE_M:
        exp = _G0 / (_LAPSE_K_PER_M * _R_AIR)
        return _P0_PA * (1.0 - _LAPSE_K_PER_M * h_m / _T0_K) ** exp
    # Isothermal layer above the tropopause.
    p_trop = _P0_PA * (
        1.0 - _LAPSE_K_PER_M * _TROPOPAUSE_M / _T0_K
    ) ** (_G0 / (_LAPSE_K_PER_M * _R_AIR))
    return p_trop * math.exp(
        -_G0 * (h_m - _TROPOPAUSE_M) / (_R_AIR * _TROPOPAUSE_T_K)
    )


def isa_density_kg_m3(altitude_ft: float) -> float:
    """ISA air density at altitude (kg/m³)."""
    return isa_pressure_pa(altitude_ft) / (
        _R_AIR * isa_temperature_k(altitude_ft)
    )


def speed_of_sound_kt(altitude_ft: float) -> float:
    """Speed of sound at altitude using ISA temperature, in knots."""
    a_ms = math.sqrt(_GAMMA * _R_AIR * isa_temperature_k(altitude_ft))
    return a_ms * _MS_TO_KT


def mach_to_tas_kt(mach: float, altitude_ft: float) -> float:
    """Convert Mach number to true airspeed (knots) at the given altitude."""
    return mach * speed_of_sound_kt(altitude_ft)


def tas_to_mach(tas_kt: float, altitude_ft: float) -> float:
    """Convert true airspeed (knots) to Mach at the given altitude."""
    a = speed_of_sound_kt(altitude_ft)
    return tas_kt / a if a > 0 else 0.0


def cas_to_tas_kt(cas_kt: float, altitude_ft: float) -> float:
    """Convert calibrated airspeed to true airspeed in knots (CAS → TAS).

    Uses the compressible-flow relation through the ISA atmosphere
    (Anderson, *Introduction to Flight*, §3.6) — accurate to ≲ 1 kt
    across the FL100 – FL400 envelope where this sim flies.

    Args:
        cas_kt: Calibrated airspeed in knots.
        altitude_ft: Altitude in feet AMSL.

    Returns:
        True airspeed in knots.
    """
    cas_ms = cas_kt / _MS_TO_KT
    # Impact pressure from CAS at sea-level reference conditions.
    qc_pa = _P0_PA * ((1.0 + 0.2 * (cas_ms / _A0_M_S) ** 2) ** 3.5 - 1.0)
    # Recover Mach from impact pressure at the actual altitude.
    p_pa = isa_pressure_pa(altitude_ft)
    mach = math.sqrt(5.0 * ((qc_pa / p_pa + 1.0) ** (1.0 / 3.5) - 1.0))
    return mach_to_tas_kt(mach, altitude_ft)


def tas_to_cas_kt(tas_kt: float, altitude_ft: float) -> float:
    """Inverse of :func:`cas_to_tas_kt` — TAS → CAS, both in knots."""
    mach = tas_to_mach(tas_kt, altitude_ft)
    p_pa = isa_pressure_pa(altitude_ft)
    qc_pa = p_pa * ((1.0 + 0.2 * mach * mach) ** 3.5 - 1.0)
    cas_ratio_sq = ((qc_pa / _P0_PA + 1.0) ** (1.0 / 3.5) - 1.0) / 0.2
    cas_ms = math.sqrt(max(0.0, cas_ratio_sq)) * _A0_M_S
    return cas_ms * _MS_TO_KT


def cas_mach_crossover_ft(cas_kt: float, mach: float) -> float:
    """Altitude (ft) where a constant-CAS profile reaches a given Mach.

    Below this altitude a fixed calibrated airspeed maps to a Mach number
    lower than ``mach``; above it, higher. It is the CAS→Mach crossover of
    a BADA-style speed schedule — the point the climb/descent switches from
    holding ``cas_kt`` to holding ``mach``. Both conversions go through the
    ISA atmosphere, so the crossover is consistent with
    :func:`target_tas_kt` (the target TAS is continuous across it).

    Args:
        cas_kt: Held calibrated airspeed, knots.
        mach: Held Mach number.

    Returns:
        Crossover altitude in feet AMSL, within ``[0, 60000]``. Returns the
        60 000 ft ceiling when the CAS never reaches the Mach in that band
        (e.g. a turboprop whose CAS schedule stays sub-Mach).
    """
    lo, hi = 0.0, 60000.0
    # Mach of a fixed CAS rises monotonically with altitude → bisection.
    if tas_to_mach(cas_to_tas_kt(cas_kt, hi), hi) < mach:
        return hi
    for _ in range(60):
        mid = (lo + hi) / 2.0
        if tas_to_mach(cas_to_tas_kt(cas_kt, mid), mid) < mach:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


@dataclass(frozen=True)
class _Segment:
    """One altitude band with a constant vertical rate (fpm)."""

    alt_lo_ft: float
    alt_hi_ft: float
    rate_fpm: float


# Legacy hand-coded BADA-*style* climb / descent schedules. These are now
# the FALLBACK only — the Thai APM dataset is loaded below and takes
# precedence (see _load_perf_tables). They are kept so the engine still
# runs if neither Thai APM data file ships with the package.
# Climb ROC drops with altitude; descent ROD is roughly constant. Numbers
# are representative published performance inside the brief's 1500–2500
# ft/min band.
_B738_CLIMB: tuple[_Segment, ...] = (
    _Segment(0,     10000, 2400.0),
    _Segment(10000, 20000, 2200.0),
    _Segment(20000, 30000, 2000.0),
    _Segment(30000, 37000, 1800.0),
    _Segment(37000, 41000, 1600.0),
)
# Descent mirrors the climb (brief), all rates inside the 1500-2500 band:
# steeper up high, easing under FL100 where the 250 kt limit + config slow
# it. (The old flat 1800 fpm made descent ~20 min — unrealistically slow.)
_B738_DESCENT: tuple[_Segment, ...] = (
    _Segment(0,     10000, 1800.0),
    _Segment(10000, 24000, 2200.0),
    _Segment(24000, 41000, 2400.0),
)

# A320 — same family of numbers, slightly weaker climb at altitude.
_A320_CLIMB: tuple[_Segment, ...] = (
    _Segment(0,     10000, 2300.0),
    _Segment(10000, 20000, 2100.0),
    _Segment(20000, 30000, 1900.0),
    _Segment(30000, 37000, 1700.0),
    _Segment(37000, 41000, 1550.0),
)
_A320_DESCENT: tuple[_Segment, ...] = (
    _Segment(0,     10000, 1700.0),
    _Segment(10000, 24000, 2100.0),
    _Segment(24000, 41000, 2300.0),
)

# B77W — heavy long-haul; lower fpm but higher ceiling.
_B77W_CLIMB: tuple[_Segment, ...] = (
    _Segment(0,     10000, 2200.0),
    _Segment(10000, 20000, 2000.0),
    _Segment(20000, 30000, 1800.0),
    _Segment(30000, 37000, 1600.0),
    _Segment(37000, 43000, 1500.0),
)
_B77W_DESCENT: tuple[_Segment, ...] = (
    _Segment(0,     10000, 1700.0),
    _Segment(10000, 24000, 2100.0),
    _Segment(24000, 43000, 2300.0),
)

_LEGACY_PERF_TABLES: dict[
    str, tuple[tuple[_Segment, ...], tuple[_Segment, ...]]
] = {
    "B738": (_B738_CLIMB, _B738_DESCENT),
    "A320": (_A320_CLIMB, _A320_DESCENT),
    "B77W": (_B77W_CLIMB, _B77W_DESCENT),
}


# ---------------------------------------------------------------------------
# Thai APM performance data (BADA-format export from Bangkok FIR radar).
#
# Replaces the hand-coded rate tables above. "Thai APM" is a BADA-shaped
# kinematic table fitted to ~350 days of real Mode-S surveillance in the
# Bangkok FIR (2022–2026), laid out like a BADA PTF but NOT a EUROCONTROL
# product. See data/THAIAPM_SQLITE_GUIDE.md and data/DERIVABILITY.md.
#
# We use ROCD only — climb/descent rates (`rocd_nom`) — and keep the
# brief's operational CAS/Mach speed schedule for TAS (project-lead
# decision). Project decisions baked in here:
#   * `rocd_nom` (the p50 typical rate) is used as-is, even where it sits
#     outside the brief's 1500–2500 ft/min planning band (that is the
#     fleet's real observed performance — the band is a planning average,
#     not a physical limit). The inverted `rocd_lo`/`rocd_hi` mass bands
#     are deliberately ignored — nom is the "typical" value to use.
#   * The single ISA+15 variant is used (the dataset's only isa_offset,
#     labelling the ~ISA+15 warm Bangkok conditions).
#   * Climb tables stop at the highest FL actually observed in Bangkok, so
#     a flight filed above that observed top is capped there rather than
#     extrapolated to the published service ceiling (see VerticalProfile.
#     build's reachable-ceiling clamp).
#
# Loaded from the SQLite package by default; the CSV export is an
# equivalent fallback, and the hand-coded _LEGACY_PERF_TABLES are the
# last resort if neither data file ships.
# ---------------------------------------------------------------------------

_THAIAPM_VERSION = "thaiapm-202607"
_THAIAPM_ISA_OFFSET = 15
_DATA_DIR = Path(__file__).resolve().parent / "data"
_THAIAPM_SQLITE_PATH = _DATA_DIR / "thaiapm_bada.sqlite"
_THAIAPM_CSV_PATH = _DATA_DIR / "thaiapm_performance.csv"


def _segments_from_fl_rates(
    fl_rates: list[tuple[int, float]],
) -> tuple[_Segment, ...]:
    """Build constant-rate altitude bands from (FL, ROCD) sample points.

    Each band spans two consecutive flight levels; its rate is the mean of
    the two endpoints' ROCD, which smooths the discrete PTF steps. A band
    whose mean rate is non-positive is dropped — it marks the airframe
    ceiling (and would divide-by-zero in the time integrators).
    """
    pts = sorted(fl_rates)
    segs: list[_Segment] = []
    for (fl0, r0), (fl1, r1) in zip(pts, pts[1:]):
        rate = (r0 + r1) / 2.0
        if fl1 > fl0 and rate > 1.0:
            segs.append(_Segment(fl0 * 100.0, fl1 * 100.0, rate))
    return tuple(segs)


def _perf_tables_from_rows(
    rows: "list[tuple[str, str, object, object]]",
) -> dict[str, tuple[tuple[_Segment, ...], tuple[_Segment, ...]]]:
    """Build per-airframe (climb, descent) segment tables from raw rows.

    Each row is ``(actype, phase, fl, rocd_nom)``. Cruise rows and rows
    with a NULL/blank ROCD are ignored (Thai APM leaves cruise `rocd_*`
    NULL, and descent populates only `rocd_nom`). Keyed by upper-case ICAO
    type; a type is kept only if it has both a climb and a descent table.
    """
    climb: dict[str, list[tuple[int, float]]] = {}
    descent: dict[str, list[tuple[int, float]]] = {}
    for actype, phase, fl, rocd in rows:
        if phase == "cruise" or rocd is None or rocd == "":
            continue
        try:
            fl_i = int(float(fl))  # type: ignore[arg-type]
            rate = float(rocd)  # type: ignore[arg-type]
        except (ValueError, TypeError):
            continue
        bucket = climb if phase == "climb" else descent
        bucket.setdefault(actype.upper(), []).append((fl_i, rate))

    tables: dict[
        str, tuple[tuple[_Segment, ...], tuple[_Segment, ...]]
    ] = {}
    for ac in set(climb) | set(descent):
        c = _segments_from_fl_rates(climb.get(ac, []))
        d = _segments_from_fl_rates(descent.get(ac, []))
        if c and d:
            tables[ac] = (c, d)
    return tables


def _load_thaiapm_sqlite(
    path: Path = _THAIAPM_SQLITE_PATH,
    isa_offset: int = _THAIAPM_ISA_OFFSET,
) -> dict[str, tuple[tuple[_Segment, ...], tuple[_Segment, ...]]]:
    """Load the Thai APM SQLite package into per-airframe segment tables.

    Opens the database read-only and reads `rocd_nom` for climb/descent.
    Raises on I/O or SQL failure so the caller can fall back to the CSV.
    """
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT actype, phase, fl, rocd_nom FROM thaiapm_performance "
            "WHERE isa_offset = ? AND phase IN ('climb', 'descent') "
            "AND rocd_nom IS NOT NULL",
            (isa_offset,),
        ).fetchall()
    finally:
        con.close()
    return _perf_tables_from_rows(rows)


def _load_thaiapm_csv(
    path: Path = _THAIAPM_CSV_PATH,
    isa_offset: int = _THAIAPM_ISA_OFFSET,
) -> dict[str, tuple[tuple[_Segment, ...], tuple[_Segment, ...]]]:
    """Load the Thai APM CSV export — the SQLite fallback (same shape)."""
    with path.open(encoding="utf-8", newline="") as fh:
        rows = [
            (row["actype"], row["phase"], row["fl"], row["rocd_nom"])
            for row in csv.DictReader(fh)
            if int(row["isa_offset"]) == isa_offset
        ]
    return _perf_tables_from_rows(rows)


def _load_perf_tables() -> tuple[
    dict[str, tuple[tuple[_Segment, ...], tuple[_Segment, ...]]], str
]:
    """Load the performance tables, preferring SQLite → CSV → legacy.

    Returns ``(tables, source_label)``. A loaded dataset must contain the
    in-scope B738; otherwise the next source is tried. Falls back to the
    hand-coded tables only if neither Thai APM data file is usable.
    """
    isa = _THAIAPM_ISA_OFFSET
    label = f"Thai APM ({_THAIAPM_VERSION}, ISA+{isa})"
    for loader, tag in (
        (_load_thaiapm_sqlite, "sqlite"),
        (_load_thaiapm_csv, "csv"),
    ):
        try:
            tables = loader()
        except (OSError, sqlite3.Error, ValueError, KeyError):
            continue
        if "B738" in tables:  # in-scope airframe must be present
            return tables, f"{label} [{tag}]"
    return (
        _LEGACY_PERF_TABLES,
        "built-in BADA-style tables (Thai APM dataset unavailable)",
    )


_PERF_TABLES, PERFORMANCE_SOURCE = _load_perf_tables()


@dataclass(frozen=True)
class SpeedSchedule:
    """BADA-style climb / cruise / descent speed schedule.

    Units:
      - ``climb_cas_kt`` — calibrated airspeed in knots below the climb
        crossover altitude (typically below FL280).
      - ``climb_mach`` — Mach number above the crossover (climb-out at
        high altitude flies a constant Mach, not constant CAS).
      - ``cruise_mach`` — long-range or normal cruise Mach number.
      - ``descent_mach`` — Mach number above the crossover.
      - ``descent_cas_kt`` — CAS in knots below the crossover.
    The 250 KCAS / FL100 ATC speed limit is applied on top of this schedule
    by :func:`target_tas_kt` (not stored on the dataclass); the CAS→Mach
    crossover altitude lives in :func:`crossover_altitude_ft`.
    """

    climb_cas_kt: float
    climb_mach: float
    cruise_mach: float
    descent_mach: float
    descent_cas_kt: float


# Per-airframe OPERATIONAL speed schedules (typical airline long-range
# cruise). These are AUTHORITATIVE for the CAS/Mach speeds — BADA supplies
# only the climb/descent RATES (ROCD), not the schedule. This split is
# deliberate: BADA's PTF `tas` is a nominal/high-speed profile (B738 cruise
# ~M0.816) that runs faster than real ops, so simulated flight time came out
# below even the fastest real CAT062 flight. The values here are calibrated
# to the real CAT062 tracks (B738: cruise ~M0.78, climb ~290 kt, descent
# ~290 kt vs measured 0.776 / 289 / 258), so the clean direct trajectory
# lands next to a delay-free real flight. See [[project-bada-dataset]].
#
# Grouped by family — the 737/A320 narrow-bodies share a ~290 kt / M0.78
# profile, the A330/777/787 wide-bodies a faster ~300-310 kt / M0.80-0.85
# one, and the ATR/Dash-8 turboprops a much slower CAS-only profile that
# never reaches the jet Mach regime. Any ICAO type not listed falls back
# to the B738 schedule (see :func:`aircraft_speeds`).
_NARROWBODY_JET = SpeedSchedule(
    climb_cas_kt=290.0, climb_mach=0.78,
    cruise_mach=0.78,
    descent_mach=0.78, descent_cas_kt=290.0,
)
_NARROWBODY_NEO = SpeedSchedule(  # A320neo / 737 MAX — slightly higher Mach
    climb_cas_kt=290.0, climb_mach=0.79,
    cruise_mach=0.79,
    descent_mach=0.79, descent_cas_kt=290.0,
)
_WIDEBODY_A330 = SpeedSchedule(
    climb_cas_kt=300.0, climb_mach=0.81,
    cruise_mach=0.82,
    descent_mach=0.81, descent_cas_kt=300.0,
)
_WIDEBODY_TWIN = SpeedSchedule(  # 777 / 787 / A350 long-haul
    climb_cas_kt=310.0, climb_mach=0.84,
    cruise_mach=0.85,
    descent_mach=0.84, descent_cas_kt=300.0,
)
_REGIONAL_JET = SpeedSchedule(  # E-Jets
    climb_cas_kt=290.0, climb_mach=0.77,
    cruise_mach=0.78,
    descent_mach=0.77, descent_cas_kt=290.0,
)
_TURBOPROP = SpeedSchedule(  # ATR / Dash-8 — CAS-only; Mach is a cap, never hit
    climb_cas_kt=170.0, climb_mach=0.55,
    cruise_mach=0.44,
    descent_mach=0.44, descent_cas_kt=235.0,
)

_SPEED_SCHEDULES: dict[str, SpeedSchedule] = {
    # 737 family
    "B738": _NARROWBODY_JET,
    "B739": _NARROWBODY_JET,
    "B737": _NARROWBODY_JET,
    "B38M": _NARROWBODY_NEO,
    "B39M": _NARROWBODY_NEO,
    # A320 family
    "A319": _NARROWBODY_JET,
    "A320": _NARROWBODY_JET,
    "A321": _NARROWBODY_JET,
    "A20N": _NARROWBODY_NEO,
    "A21N": _NARROWBODY_NEO,
    # A330 wide-body
    "A332": _WIDEBODY_A330,
    "A333": _WIDEBODY_A330,
    # 777 / 787 / A350 long-haul twins
    "B772": _WIDEBODY_TWIN,
    "B77W": _WIDEBODY_TWIN,
    "B77L": _WIDEBODY_TWIN,
    "B788": _WIDEBODY_TWIN,
    "B789": _WIDEBODY_TWIN,
    "A359": _WIDEBODY_TWIN,
    # Regional jets
    "E190": _REGIONAL_JET,
    "E290": _REGIONAL_JET,
    # Turboprops
    "AT75": _TURBOPROP,
    "AT76": _TURBOPROP,
    "DH8D": _TURBOPROP,
}

# Manufacturer-published service ceilings (feet). The segmented climb
# tables above stop at these altitudes; an aircraft asked to climb past
# its ceiling is clipped there.
_SERVICE_CEILING_FT: dict[str, float] = {
    # 737 family
    "B738": 41000.0,
    "B739": 41000.0,
    "B737": 41000.0,
    "B38M": 41000.0,
    "B39M": 41000.0,
    # A320 family
    "A319": 41000.0,
    "A320": 41000.0,
    "A321": 39800.0,
    "A20N": 41000.0,
    "A21N": 41000.0,
    # A330 wide-body
    "A332": 41100.0,
    "A333": 41100.0,
    # 777 / 787 / A350 long-haul twins
    "B772": 43100.0,
    "B77W": 43100.0,
    "B77L": 43100.0,
    "B788": 43000.0,
    "B789": 43000.0,
    "A359": 43100.0,
    # Regional jets
    "E190": 41000.0,
    "E290": 41000.0,
    # Turboprops
    "AT75": 25000.0,
    "AT76": 25000.0,
    "DH8D": 25000.0,
}

# CAS → Mach crossover altitude per airframe (BADA convention). Below
# this altitude the climb / descent flies a constant CAS; above it,
# constant Mach. Typical narrow-body crossover sits around FL280–300.
# Consistent with the operational schedule above (cas_mach_crossover_ft of
# the climb CAS + Mach lands near these).
_CROSSOVER_FT: dict[str, float] = {
    # 737 / A320 narrow-bodies cross over around FL280.
    "B738": 28000.0,
    "B739": 28000.0,
    "B737": 28000.0,
    "B38M": 30000.0,
    "B39M": 30000.0,
    "A319": 28000.0,
    "A320": 28000.0,
    "A321": 28000.0,
    "A20N": 30000.0,
    "A21N": 30000.0,
    # Wide-body twins cross over higher (~FL300).
    "A332": 30000.0,
    "A333": 30000.0,
    "B772": 30000.0,
    "B77W": 30000.0,
    "B77L": 30000.0,
    "B788": 30000.0,
    "B789": 30000.0,
    "A359": 30000.0,
    "E190": 28000.0,
    "E290": 28000.0,
    # Turboprops effectively never reach the Mach regime; keep at ceiling.
    "AT75": 25000.0,
    "AT76": 25000.0,
    "DH8D": 25000.0,
}

# ATC speed restriction below FL100 (10 000 ft). 250 kt CAS is the
# global default, applied to *both* climb and descent. The constant is
# named so the value is searchable and easy to tweak per state.
_BELOW_FL100_CAS_KT = 250.0
_RESTRICTION_ALT_FT = 10000.0


# The CAS/Mach speed schedule is operational (defined above), NOT dataset-
# derived — nominal BADA-style speeds run faster than real ops. Thai APM
# still drives the climb/descent RATES (see _load_perf_tables /
# PERFORMANCE_SOURCE).
SPEED_SCHEDULE_SOURCE = "operational (airline LRC), calibrated to CAT062 tracks"


def crossover_altitude_ft(aircraft_type: str) -> float:
    """CAS → Mach crossover altitude in feet for an aircraft type.

    Falls back to the B738 value (FL280) when unknown.
    """
    return _CROSSOVER_FT.get(
        aircraft_type.upper(), _CROSSOVER_FT["B738"]
    )


# ---------------------------------------------------------------------------
# Tuning API — the speed schedule + 250 kt restriction are configurable at
# runtime so a caller (e.g. the flight-time validator) can adjust climb
# CAS / cruise Mach / descent CAS-Mach / the below-FL100 limit and re-run
# the simulation until total time matches the CAT62 reference. All setters
# mutate module state in place; `target_tas_kt` reads them on every call,
# so a change takes effect on the next `build_flight_timeline`.
# ---------------------------------------------------------------------------


def set_speed_schedule(aircraft_type: str, schedule: SpeedSchedule) -> None:
    """Replace the whole speed schedule for an aircraft type."""
    _SPEED_SCHEDULES[aircraft_type.upper()] = schedule


def tune_speed_schedule(
    aircraft_type: str,
    *,
    climb_cas_kt: float | None = None,
    climb_mach: float | None = None,
    cruise_mach: float | None = None,
    descent_mach: float | None = None,
    descent_cas_kt: float | None = None,
) -> SpeedSchedule:
    """Override individual speed-schedule fields, keeping the rest.

    Any argument left as ``None`` is unchanged. Returns the new schedule
    (also stored, so subsequent :func:`aircraft_speeds` calls see it).
    Unknown aircraft types seed from the B738 baseline before tuning.
    """
    base = aircraft_speeds(aircraft_type)
    updates = {
        k: v
        for k, v in {
            "climb_cas_kt": climb_cas_kt,
            "climb_mach": climb_mach,
            "cruise_mach": cruise_mach,
            "descent_mach": descent_mach,
            "descent_cas_kt": descent_cas_kt,
        }.items()
        if v is not None
    }
    new = replace(base, **updates)
    _SPEED_SCHEDULES[aircraft_type.upper()] = new
    return new


def set_speed_restriction(
    *,
    cas_kt: float | None = None,
    below_alt_ft: float | None = None,
) -> None:
    """Tune the ATC speed restriction (default 250 kt CAS below FL100).

    The restriction is applied as ``min(phase_cas, cas_kt)`` below
    ``below_alt_ft``, so pass a very high ``cas_kt`` (e.g. 9999) to
    effectively disable the cap; ``below_alt_ft`` moves the altitude the
    cap applies under (set 0 to disable by altitude).
    """
    global _BELOW_FL100_CAS_KT, _RESTRICTION_ALT_FT
    if cas_kt is not None:
        _BELOW_FL100_CAS_KT = float(cas_kt)
    if below_alt_ft is not None:
        _RESTRICTION_ALT_FT = float(below_alt_ft)


def get_speed_restriction() -> tuple[float, float]:
    """Return the current ``(cas_kt, below_alt_ft)`` restriction values."""
    return _BELOW_FL100_CAS_KT, _RESTRICTION_ALT_FT


def target_tas_kt(
    aircraft_type: str,
    altitude_ft: float,
    phase: Phase,
) -> float:
    """Target true airspeed (knots) at the given altitude for a phase.

    Applies, in order:
      1. The **250 kt CAS** ATC speed restriction below 10 000 ft.
      2. The aircraft's climb / descent CAS between FL100 and the
         CAS→Mach crossover altitude.
      3. The aircraft's climb / descent Mach above the crossover.
      4. The cruise Mach above the crossover for the cruise phase.

    Args:
        aircraft_type: ICAO type. Falls back to B738 when unknown.
        altitude_ft: Current altitude in feet AMSL.
        phase: ``"climb"``, ``"cruise"`` or ``"descent"``.

    Returns:
        Target TAS in knots — i.e. the speed the aircraft would be
        flying at this point in the profile. Wind not applied (zero-wind
        assumed; GS = TAS).
    """
    sched = aircraft_speeds(aircraft_type)
    crossover_ft = crossover_altitude_ft(aircraft_type)

    if phase == "cruise":
        return mach_to_tas_kt(sched.cruise_mach, altitude_ft)

    if phase == "climb":
        cas, mach = sched.climb_cas_kt, sched.climb_mach
    else:  # descent
        cas, mach = sched.descent_cas_kt, sched.descent_mach

    if altitude_ft < _RESTRICTION_ALT_FT:
        # 250 kt ATC speed limit below FL100 (or the aircraft's own CAS
        # if it's somehow slower).
        return cas_to_tas_kt(min(cas, _BELOW_FL100_CAS_KT), altitude_ft)
    if altitude_ft < crossover_ft:
        return cas_to_tas_kt(cas, altitude_ft)
    return mach_to_tas_kt(mach, altitude_ft)


def average_phase_tas_kt(
    aircraft_type: str,
    from_alt_ft: float,
    to_alt_ft: float,
    phase: Phase,
) -> float:
    """Time-weighted average TAS while climbing or descending between two
    altitudes.

    Integrates :func:`target_tas_kt` over the segmented vertical schedule
    so a climb that lingers in the 250 kt band gets correctly weighted
    against the high-altitude Mach band.

    Returns the cruise TAS directly when ``phase == "cruise"``.
    """
    if phase == "cruise":
        return mach_to_tas_kt(
            aircraft_speeds(aircraft_type).cruise_mach,
            (from_alt_ft + to_alt_ft) / 2.0,
        )

    if to_alt_ft == from_alt_ft:
        return target_tas_kt(aircraft_type, from_alt_ft, phase)

    climb_segs, desc_segs = _segments_for(aircraft_type)
    segs = climb_segs if phase == "climb" else desc_segs
    lo_alt = min(from_alt_ft, to_alt_ft)
    hi_alt = max(from_alt_ft, to_alt_ft)

    total_time_s = 0.0
    tas_x_time = 0.0
    for s in segs:
        lo = max(s.alt_lo_ft, lo_alt)
        hi = min(s.alt_hi_ft, hi_alt)
        if hi <= lo or s.rate_fpm <= 0:
            continue
        # Sub-sample the segment so the 250 kt / crossover boundaries
        # inside it are captured. 1 000-ft slices are plenty since the
        # BADA bands are 7 000–10 000 ft wide.
        n = max(1, int((hi - lo) / 1000.0))
        dt_s = ((hi - lo) / n) / s.rate_fpm * 60.0
        for k in range(n):
            mid_alt = lo + (hi - lo) * (k + 0.5) / n
            tas_x_time += target_tas_kt(aircraft_type, mid_alt, phase) * dt_s
            total_time_s += dt_s

    if total_time_s <= 0:
        return target_tas_kt(aircraft_type, (lo_alt + hi_alt) / 2.0, phase)
    return tas_x_time / total_time_s


def climb_distance_nm(
    aircraft_type: str,
    from_alt_ft: float,
    to_alt_ft: float,
    cruise_alt_ft: float,
) -> float:
    """Along-track distance at which a climb passes ``to_alt_ft``.

    Placing a fix here — e.g. the terminator of a SID's "climb on 209° to
    1 500 ft" leg — makes it a fix the aircraft genuinely crosses at that
    altitude, so its published restriction is already satisfied and the
    vertical profile has nothing to bend.

    That only holds if this uses the SAME distance/time law
    :func:`~trajectory_sim.trajectory.build_flight_timeline` flies: the time
    comes from the segmented climb schedule, but the whole climb is covered at
    ONE phase-average TAS (threshold → cruise), not at the local speed in the
    altitude band being crossed. Averaging over the band instead — or applying
    the procedure's own low-altitude speed limit — would place the fix short of
    where the aircraft actually reaches the altitude, and the profile would then
    have to lift the aircraft to meet it and sink back afterwards.

    Args:
        aircraft_type: ICAO designator, e.g. ``"B738"``. Case-insensitive.
        from_alt_ft: Altitude the climb starts at (the departure threshold).
        to_alt_ft: Altitude to reach.
        cruise_alt_ft: Altitude the climb ends at — sets the phase-average TAS.

    Returns:
        Distance in nautical miles from the start of the climb; 0.0 when
        ``to_alt_ft <= from_alt_ft``.
    """
    climb_segs, _ = _segments_for(aircraft_type)
    time_s = _time_to_climb(climb_segs, from_alt_ft, to_alt_ft)
    if time_s <= 0:
        return 0.0
    tas_kt = average_phase_tas_kt(
        aircraft_type, from_alt_ft, max(cruise_alt_ft, to_alt_ft), "climb"
    )
    return tas_kt * time_s / 3600.0


# Field elevations (ft AMSL) — fallback for when the AIP airports layer
# isn't loaded. The API overwrites these with the full AIP set at startup
# (see api.server._register_field_elevations); default 0 elsewhere. Values
# are the published AIP elevations.
_FIELD_ELEV_FT: dict[str, float] = {
    "VYYY": 110.0,   # Yangon Intl
    "VYMD": 301.0,   # Mandalay Intl
    "VYNT": 295.0,   # Naypyitaw Intl
}


def field_elevation_ft(icao: str) -> float:
    """Published field elevation in feet, or 0.0 if unknown."""
    return _FIELD_ELEV_FT.get(icao.upper(), 0.0)


def register_field_elevations(mapping: dict[str, float]) -> None:
    """Merge externally-sourced field elevations (e.g. the VY AIP AD
    section) into the lookup used by :func:`field_elevation_ft`.

    Lets the API inject real aerodrome elevations for every VY (Myanmar)
    airport at startup without this pure-engine module reading any data files.
    Keys are upper-cased; existing entries are overwritten so the AIP is
    authoritative over the small hardcoded fallback set.
    """
    for icao, elev_ft in mapping.items():
        _FIELD_ELEV_FT[icao.upper()] = float(elev_ft)


# Runway-threshold elevations (ft AMSL), keyed ``(ICAO, runway)`` where the
# runway is the bare designator without the "RW" prefix — e.g.
# ``("VYTL", "04") -> 1275.0``. Sourced from the AIXM export's per-runway
# ``landing_threshold_elevation`` (runway_vy.csv) and injected by the API at
# startup (see api.server._register_runway_elevations); empty otherwise, in
# which case :func:`runway_threshold_elevation_ft` falls back to the field
# elevation.
_RUNWAY_ELEV_FT: dict[tuple[str, str], float] = {}


def _norm_runway(runway: str) -> str:
    """Normalise a runway ident to the bare designator used as a key.

    Strips an optional ``RW`` prefix and surrounding space and upper-cases
    the side letter: ``"RW09"`` -> ``"09"``, ``"rw21l"`` -> ``"21L"``.
    """
    r = runway.strip().upper()
    return r[2:] if r.startswith("RW") else r


def register_runway_elevations(mapping: dict[tuple[str, str], float]) -> None:
    """Merge runway-threshold elevations into the lookup used by
    :func:`runway_threshold_elevation_ft`.

    Keys are ``(ICAO, runway)`` and are normalised (upper-cased ICAO, bare
    runway designator). Lets the API inject the VY (Myanmar) per-runway
    ``landing_threshold_elevation`` from ``runway_vy.csv`` (AIXM export,
    matching eAIP AD 2.12 column 6 converted from metres to feet) at
    startup without this pure-engine module reading data files.
    """
    for (icao, runway), elev_ft in mapping.items():
        _RUNWAY_ELEV_FT[(icao.upper(), _norm_runway(runway))] = float(elev_ft)


def runway_threshold_elevation_ft(
    icao: str, runway: str | None = None
) -> float:
    """Threshold elevation (ft AMSL) of a specific runway end.

    Returns the AIP threshold elevation for ``runway`` at ``icao`` when
    known, so the climb starts / descent ends at the actual runway threshold
    rather than the aerodrome's single published elevation. Falls back to
    :func:`field_elevation_ft` when the runway is unset or has no threshold
    elevation on record (an "Auto" runway, or a strip with no AIP data).
    """
    if runway:
        elev = _RUNWAY_ELEV_FT.get((icao.upper(), _norm_runway(runway)))
        if elev is not None:
            return elev
    return field_elevation_ft(icao)


def _segments_for(aircraft_type: str) -> tuple[tuple[_Segment, ...], tuple[_Segment, ...]]:
    """Return (climb_segments, descent_segments) for an aircraft type.

    Unknown types fall back to the B738 table — the brief only flies the
    B738; A320/B77W are forward-compat slots.
    """
    return _PERF_TABLES.get(aircraft_type.upper(), _PERF_TABLES["B738"])


def _time_to_climb(
    segs: tuple[_Segment, ...], from_ft: float, to_ft: float
) -> float:
    """Seconds to climb between two altitudes through a segmented schedule."""
    if to_ft <= from_ft:
        return 0.0
    total_s = 0.0
    for s in segs:
        lo = max(s.alt_lo_ft, from_ft)
        hi = min(s.alt_hi_ft, to_ft)
        if hi > lo and s.rate_fpm > 0:
            total_s += (hi - lo) / s.rate_fpm * 60.0
    return total_s


def _altitude_after_climb(
    segs: tuple[_Segment, ...],
    from_ft: float,
    elapsed_s: float,
    cap_ft: float,
) -> float:
    """Altitude reached after climbing for `elapsed_s` from `from_ft`."""
    if elapsed_s <= 0:
        return min(from_ft, cap_ft)
    remaining_s = elapsed_s
    cur = from_ft
    for s in segs:
        if s.alt_hi_ft <= cur:
            continue
        lo = max(s.alt_lo_ft, cur)
        seg_time_s = (s.alt_hi_ft - lo) / s.rate_fpm * 60.0
        if remaining_s >= seg_time_s:
            cur = s.alt_hi_ft
            remaining_s -= seg_time_s
        else:
            cur = lo + s.rate_fpm * remaining_s / 60.0
            return min(cur, cap_ft)
    return min(cur, cap_ft)


def _altitude_after_descent(
    segs: tuple[_Segment, ...],
    from_ft: float,
    elapsed_s: float,
    floor_ft: float,
) -> float:
    """Altitude reached after descending for `elapsed_s` from `from_ft`."""
    if elapsed_s <= 0:
        return max(from_ft, floor_ft)
    remaining_s = elapsed_s
    cur = from_ft
    # Walk the table top-down so highest-altitude segment burns first.
    for s in reversed(segs):
        if s.alt_lo_ft >= cur:
            continue
        hi = min(s.alt_hi_ft, cur)
        seg_time_s = (hi - s.alt_lo_ft) / s.rate_fpm * 60.0
        if remaining_s >= seg_time_s:
            cur = s.alt_lo_ft
            remaining_s -= seg_time_s
        else:
            cur = hi - s.rate_fpm * remaining_s / 60.0
            return max(cur, floor_ft)
    return max(cur, floor_ft)


# ---------------------------------------------------------------------------
# Performance provenance — which dataset actually backs a given airframe.
#
# Three lookups in this module silently substitute the B738 when a type is
# unknown: :func:`_segments_for` (climb/descent RATES), :func:`aircraft_speeds`
# (the CAS/Mach schedule) and :func:`service_ceiling_ft`. That substitution is
# fine for *drawing* a trajectory — better a plausible 737 profile than no
# flight — but it is NOT acceptable for validating one, because the flight-time
# check would then grade an ATR 72 against 737 numbers and report a bogus
# FAIL (the original symptom this API exists to prevent).
#
# So anything that validates must go through :func:`require_apm_performance`,
# which refuses to substitute. The rule it enforces:
#
#   * the loaded dataset really is the Thai APM (not the hand-coded
#     ``_LEGACY_PERF_TABLES`` last resort), AND
#   * the exact ICAO type has its own rate table in it (no B738 stand-in), AND
#   * the type has its OWN operational speed schedule (no B738 M0.78 on a
#     turboprop).
#
# The rates cover 66 types and the speed schedules 23, so the usable set is
# the intersection — see :func:`estimator_types`.
# ---------------------------------------------------------------------------

#: The airframe every unknown type would otherwise be substituted with.
SUBSTITUTE_TYPE = "B738"


class UnknownAircraftPerformance(LookupError):
    """A type's performance is not available without substituting another.

    Raised instead of quietly returning :data:`SUBSTITUTE_TYPE` data, so a
    caller that needs *this* airframe's numbers fails loudly.
    """


@dataclass(frozen=True)
class PerformanceProvenance:
    """Where one airframe's performance numbers actually come from."""

    aircraft_type: str
    #: Label of the loaded rate dataset (:data:`PERFORMANCE_SOURCE`).
    dataset: str
    #: The loaded dataset is the Thai APM, not the hand-coded last resort.
    dataset_is_thai_apm: bool
    #: This exact type has its own rate table (no substitution).
    rates_exact: bool
    #: This exact type has its own CAS/Mach schedule (no substitution).
    speeds_exact: bool

    @property
    def substituted(self) -> bool:
        """Would any lookup fall back to :data:`SUBSTITUTE_TYPE`?"""
        return not (self.rates_exact and self.speeds_exact)

    @property
    def usable_for_validation(self) -> bool:
        """Safe to derive a reference flight time from this airframe."""
        return self.dataset_is_thai_apm and not self.substituted

    def why_not(self) -> str:
        """Human-readable reason :attr:`usable_for_validation` is False."""
        if not self.dataset_is_thai_apm:
            return f"performance dataset is not the Thai APM ({self.dataset})"
        missing = []
        if not self.rates_exact:
            missing.append("climb/descent rates")
        if not self.speeds_exact:
            missing.append("speed schedule")
        if missing:
            return (
                f"{self.aircraft_type} has no own "
                + " or ".join(missing)
                + f" — would substitute {SUBSTITUTE_TYPE}"
            )
        return ""


def dataset_is_thai_apm() -> bool:
    """True when the loaded rate tables came from the Thai APM dataset."""
    return PERFORMANCE_SOURCE.startswith("Thai APM")


def thai_apm_types() -> frozenset[str]:
    """ICAO types with their own climb/descent rates in the loaded dataset."""
    return frozenset(_PERF_TABLES)


def estimator_types() -> frozenset[str]:
    """Types a reference flight time can honestly be derived for.

    The intersection of the rate tables and the operational speed
    schedules — both must be the type's own for the estimate to mean
    anything. Empty when the Thai APM is not the loaded dataset.
    """
    if not dataset_is_thai_apm():
        return frozenset()
    return frozenset(_PERF_TABLES) & frozenset(_SPEED_SCHEDULES)


def performance_provenance(aircraft_type: str) -> PerformanceProvenance:
    """Report where ``aircraft_type``'s performance numbers come from.

    Never raises — use it to decide whether to validate. Call
    :func:`require_apm_performance` when you need the numbers themselves.
    """
    t = aircraft_type.strip().upper()
    return PerformanceProvenance(
        aircraft_type=t,
        dataset=PERFORMANCE_SOURCE,
        dataset_is_thai_apm=dataset_is_thai_apm(),
        rates_exact=t in _PERF_TABLES,
        speeds_exact=t in _SPEED_SCHEDULES,
    )


def require_apm_performance(aircraft_type: str) -> PerformanceProvenance:
    """Assert this airframe's own Thai APM performance is available.

    Returns:
        The provenance record when every lookup resolves to
        ``aircraft_type`` itself.

    Raises:
        UnknownAircraftPerformance: when any lookup would substitute
            :data:`SUBSTITUTE_TYPE`, or the Thai APM is not loaded.
    """
    prov = performance_provenance(aircraft_type)
    if not prov.usable_for_validation:
        raise UnknownAircraftPerformance(prov.why_not())
    return prov


def time_to_climb_s(aircraft_type: str, from_ft: float, to_ft: float) -> float:
    """Seconds to climb ``from_ft`` → ``to_ft`` on this type's rate table."""
    climb_segs, _ = _segments_for(aircraft_type)
    return _time_to_climb(climb_segs, from_ft, to_ft)


def time_to_descend_s(aircraft_type: str, from_ft: float, to_ft: float) -> float:
    """Seconds to descend ``from_ft`` → ``to_ft`` on this type's rate table.

    The descent table is banded by altitude exactly like the climb one, so
    the same band integration applies with the endpoints swapped.
    """
    _, desc_segs = _segments_for(aircraft_type)
    return _time_to_climb(desc_segs, to_ft, from_ft)


def aircraft_speeds(aircraft_type: str) -> SpeedSchedule:
    """Return the climb / cruise / descent speed schedule for an airframe.

    Args:
        aircraft_type: ICAO designator, e.g. ``"B738"``. Case-insensitive.

    Returns:
        A :class:`SpeedSchedule` with CAS in knots and Mach numbers as
        floats. Falls back to the B738 schedule when the type is unknown
        (sensible default per the spec).
    """
    return _SPEED_SCHEDULES.get(aircraft_type.upper(), _SPEED_SCHEDULES["B738"])


def service_ceiling_ft(aircraft_type: str) -> float:
    """Manufacturer-published service ceiling in feet AMSL.

    Args:
        aircraft_type: ICAO designator. Case-insensitive.

    Returns:
        Service ceiling in feet (e.g. 41 000 for B738). Falls back to
        the B738 value when the type is unknown.
    """
    return _SERVICE_CEILING_FT.get(
        aircraft_type.upper(), _SERVICE_CEILING_FT["B738"]
    )


def reachable_ceiling_ft(aircraft_type: str) -> float:
    """Highest altitude the loaded climb schedule can actually reach.

    The top of the type's climb table — which, with the Thai APM dataset, is
    the highest FL *observed* in Bangkok and can sit below the published
    :func:`service_ceiling_ft` (e.g. B738 tops at FL380). This is the ceiling
    :meth:`VerticalProfile.build` clamps a requested level to, so a flight
    planner should cap filed levels here to keep cruise == RFL. Falls back to
    the service ceiling when the type has no climb table.
    """
    climb_segs, _ = _segments_for(aircraft_type)
    if climb_segs:
        return climb_segs[-1].alt_hi_ft
    return service_ceiling_ft(aircraft_type)


def aircraft_roc_rod(aircraft_type: str) -> tuple[float, float]:
    """Return (average ROC, average ROD) in ft/min for an aircraft type.

    Kept for callers / tests that want a single planning number. Internally
    the vertical profile uses the full segmented schedule (see
    :class:`VerticalProfile`); this function averages the schedule over
    its full altitude band and clamps to the brief's 1500–2500 ft/min
    envelope so the long-standing API contract still holds.
    """
    climb_segs, desc_segs = _segments_for(aircraft_type)

    def _avg(segs: tuple[_Segment, ...]) -> float:
        num = sum(s.rate_fpm * (s.alt_hi_ft - s.alt_lo_ft) for s in segs)
        den = sum(s.alt_hi_ft - s.alt_lo_ft for s in segs) or 1.0
        return num / den

    def _clamp(v: float) -> float:
        return max(1500.0, min(2500.0, v))

    return _clamp(_avg(climb_segs)), _clamp(_avg(desc_segs))


@dataclass(frozen=True)
class VerticalProfile:
    """Climb/cruise/descent altitude profile over a flight's timeline.

    Construct with :meth:`build`, then call :meth:`at` per trajectory
    sample to get its altitude and phase. The profile uses a BADA-style
    segmented climb/descent schedule so ROC drops realistically with
    altitude rather than a single constant rate.
    """

    total_time_s: float
    dep_elev_ft: float
    des_elev_ft: float
    cruise_alt_ft: float
    toc_time_s: float  # end of climb (Top Of Climb)
    tod_time_s: float  # start of descent (Top Of Descent)
    _climb_segs: tuple[_Segment, ...]
    _desc_segs: tuple[_Segment, ...]

    @classmethod
    def build(
        cls,
        total_time_s: float,
        rfl_ft: float,
        aircraft_type: str,
        dep_elev_ft: float,
        des_elev_ft: float,
    ) -> VerticalProfile:
        climb_segs, desc_segs = _segments_for(aircraft_type)

        # Clamp the requested level to the airframe's service ceiling AND to
        # the top of the loaded climb schedule — an FL above either is
        # physically unreachable. The BADA climb table can top out below the
        # published ceiling (e.g. the B77W ends at FL390), so without this a
        # cruise altitude could be set higher than the climb can actually
        # reach, leaving a vertical jump at the climb→cruise join.
        reachable_ft = (
            climb_segs[-1].alt_hi_ft
            if climb_segs
            else service_ceiling_ft(aircraft_type)
        )
        rfl_ft = min(rfl_ft, service_ceiling_ft(aircraft_type), reachable_ft)

        climb_time = _time_to_climb(climb_segs, dep_elev_ft, rfl_ft)
        descent_time = _time_to_climb(desc_segs, des_elev_ft, rfl_ft)
        cruise_alt = rfl_ft

        if (
            total_time_s > 0
            and climb_time + descent_time >= total_time_s
        ):
            # Flight too short to reach RFL: binary-search the highest
            # cruise altitude where climb_t + descent_t fits in the slot.
            # The BADA schedule is monotonic in altitude so this is well-
            # behaved.
            lo = max(dep_elev_ft, des_elev_ft)
            hi = rfl_ft
            for _ in range(48):
                mid = (lo + hi) / 2.0
                t = _time_to_climb(climb_segs, dep_elev_ft, mid) + _time_to_climb(
                    desc_segs, des_elev_ft, mid
                )
                if t <= total_time_s:
                    lo = mid
                else:
                    hi = mid
            cruise_alt = lo
            climb_time = _time_to_climb(climb_segs, dep_elev_ft, cruise_alt)
            descent_time = _time_to_climb(desc_segs, des_elev_ft, cruise_alt)

        return cls(
            total_time_s=total_time_s,
            dep_elev_ft=dep_elev_ft,
            des_elev_ft=des_elev_ft,
            cruise_alt_ft=cruise_alt,
            toc_time_s=climb_time,
            tod_time_s=total_time_s - descent_time,
            _climb_segs=climb_segs,
            _desc_segs=desc_segs,
        )

    def at_distance(
        self,
        along_track_nm: float,
        total_distance_nm: float,
    ) -> tuple[float, Phase]:
        """Return ``(altitude_ft, phase)`` at an along-track distance.

        Args:
            along_track_nm: Distance flown from ADEP along the great-circle,
                in nautical miles.
            total_distance_nm: Total route length, in nautical miles. Used
                to map distance back to the time grid (constant ground
                speed in Phase 1).

        Returns:
            ``(altitude_ft, phase)`` exactly as :meth:`at`, but indexed
            by distance instead of time. Convenience for the Phase 2
            acceptance criterion ("altitude vs. along-track distance").
        """
        if total_distance_nm <= 0:
            return self.at(0.0)
        f = max(0.0, min(1.0, along_track_nm / total_distance_nm))
        return self.at(f * self.total_time_s)

    @property
    def climb_top_ft(self) -> float:
        """Highest altitude the loaded climb schedule can reach (top of its
        last segment) — the ceiling the climb table itself imposes, which
        can sit below the airframe's service ceiling."""
        return self._climb_segs[-1].alt_hi_ft if self._climb_segs else self.cruise_alt_ft

    def reaches_ft(self, alt_ft: float) -> bool:
        """True when climbing to and descending from ``alt_ft`` fits within
        ``total_time_s``.

        Mirrors the short-flight clamp in :meth:`build`: a level that fits
        in time is cruised at; one that does not was clamped lower for
        distance. Lets a caller tell a legitimate distance clamp from an
        unexplained cruise-level mismatch. Altitudes above the climb table
        are treated as time-reachable here (the ceiling/climb limit is the
        binding one and is judged separately).
        """
        if self.total_time_s <= 0:
            return True
        climb_s = _time_to_climb(self._climb_segs, self.dep_elev_ft, alt_ft)
        desc_s = _time_to_climb(self._desc_segs, self.des_elev_ft, alt_ft)
        return climb_s + desc_s <= self.total_time_s

    def at(self, elapsed_s: float) -> tuple[float, Phase]:
        """Return (altitude_ft, phase) at an elapsed time into the flight."""
        if elapsed_s <= self.toc_time_s:
            alt = _altitude_after_climb(
                self._climb_segs,
                self.dep_elev_ft,
                elapsed_s,
                self.cruise_alt_ft,
            )
            return round(alt, 1), "climb"
        if elapsed_s >= self.tod_time_s:
            time_since_tod = elapsed_s - self.tod_time_s
            alt = _altitude_after_descent(
                self._desc_segs,
                self.cruise_alt_ft,
                time_since_tod,
                self.des_elev_ft,
            )
            return round(alt, 1), "descent"
        return round(self.cruise_alt_ft, 1), "cruise"
