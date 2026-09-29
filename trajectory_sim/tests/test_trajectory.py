"""Phase 3 — variable-speed timeline tests.

Covers:
  * ISA atmosphere sanity (sea-level, FL350, tropopause).
  * Round-trip CAS ↔ TAS / Mach ↔ TAS conversion via ISA.
  * 250 kt CAS restriction below FL100 and CAS→Mach crossover.
  * Monotonic, strictly-increasing per-point timestamps.
  * VYYY -> VYMD total flight time within 5 min of the performance-derived
    reference (the analytic climb/cruise/descent estimate for the B738).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from trajectory_sim.performance import (
    aircraft_speeds,
    average_phase_tas_kt,
    cas_to_tas_kt,
    crossover_altitude_ft,
    isa_density_kg_m3,
    isa_pressure_pa,
    isa_temperature_k,
    mach_to_tas_kt,
    speed_of_sound_kt,
    tas_to_cas_kt,
    tas_to_mach,
    target_tas_kt,
)
from trajectory_sim.trajectory import (
    _leg_distances_nm,
    _locate_along_route,
    build_flight_timeline,
)

# VYYY → VYMD — both endpoints, no enroute waypoints.
_VYYY = (16.9073, 96.1332)
_VYMD = (21.7011, 95.9775)
_EOBT = datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc)


# ---- ISA atmosphere --------------------------------------------------------


def test_isa_sea_level_matches_standard() -> None:
    assert isa_temperature_k(0.0) == pytest.approx(288.15, abs=0.01)
    assert isa_pressure_pa(0.0) == pytest.approx(101_325.0, rel=1e-6)
    assert isa_density_kg_m3(0.0) == pytest.approx(1.225, rel=1e-3)


def test_isa_tropopause_temperature_floor() -> None:
    # ISA stratosphere is isothermal at 216.65 K.
    assert isa_temperature_k(36_089.0) == pytest.approx(216.65, abs=0.1)
    assert isa_temperature_k(45_000.0) == pytest.approx(216.65, abs=0.1)


def test_speed_of_sound_drops_with_altitude() -> None:
    a_sl = speed_of_sound_kt(0.0)
    a_fl350 = speed_of_sound_kt(35_000.0)
    assert a_sl > a_fl350  # colder → slower a
    # Sea-level a ≈ 661 kt, FL350 a ≈ 573 kt.
    assert 660 < a_sl < 663
    assert 570 < a_fl350 < 580


# ---- Speed conversions -----------------------------------------------------


def test_cas_to_tas_round_trip() -> None:
    # Round-trip CAS → TAS → CAS at several altitudes should be exact.
    for alt in (0.0, 10_000.0, 28_000.0, 35_000.0, 40_000.0):
        for cas in (200.0, 250.0, 290.0, 320.0):
            tas = cas_to_tas_kt(cas, alt)
            back = tas_to_cas_kt(tas, alt)
            assert back == pytest.approx(cas, rel=1e-3, abs=0.5)


def test_mach_to_tas_round_trip() -> None:
    for alt in (0.0, 35_000.0):
        for m in (0.3, 0.78, 0.85):
            tas = mach_to_tas_kt(m, alt)
            back = tas_to_mach(tas, alt)
            assert back == pytest.approx(m, abs=1e-4)


def test_cas_equals_tas_at_sea_level() -> None:
    # By construction CAS = TAS at MSL ISA — useful sanity check.
    for cas in (150.0, 250.0, 320.0):
        assert cas_to_tas_kt(cas, 0.0) == pytest.approx(cas, abs=0.5)


def test_tas_higher_than_cas_at_altitude() -> None:
    # CAS held constant, TAS rises with altitude (density decreases).
    tas_sl = cas_to_tas_kt(290.0, 0.0)
    tas_high = cas_to_tas_kt(290.0, 35_000.0)
    assert tas_high > tas_sl + 100  # ≈ 290 → ~460 kt at FL350


# ---- Speed-schedule application -------------------------------------------


def test_250_kt_restriction_below_fl100() -> None:
    # The B738 climb CAS is 290 kt, but ATC caps to 250 kt below FL100.
    # → target TAS at SL must be ≤ 250 kt TAS (which is also 250 kt CAS).
    tas_5000 = target_tas_kt("B738", 5000.0, "climb")
    cas_equiv = tas_to_cas_kt(tas_5000, 5000.0)
    assert cas_equiv <= 250.5


def test_climb_cas_above_fl100_below_crossover() -> None:
    # Between FL100 and the crossover we fly the schedule's climb CAS
    # (BADA-derived, so pin to the schedule rather than a literal). FL200
    # is below the B738 crossover (~FL295).
    sched = aircraft_speeds("B738")
    assert 20_000.0 < crossover_altitude_ft("B738")
    cas = tas_to_cas_kt(
        target_tas_kt("B738", 20_000.0, "climb"), 20_000.0
    )
    assert cas == pytest.approx(sched.climb_cas_kt, abs=1.0)


def test_climb_mach_above_crossover() -> None:
    # Above the crossover the climb flies the schedule's climb Mach — TAS
    # at crossover+4000 ft should match mach_to_tas_kt(climb_mach, that alt).
    sched = aircraft_speeds("B738")
    crossover = crossover_altitude_ft("B738")
    high = crossover + 4000.0
    expected = mach_to_tas_kt(sched.climb_mach, high)
    assert target_tas_kt("B738", high, "climb") == pytest.approx(
        expected, abs=0.5
    )


def test_cruise_uses_cruise_mach() -> None:
    sched = aircraft_speeds("B738")
    expected = mach_to_tas_kt(sched.cruise_mach, 35_000.0)
    assert target_tas_kt("B738", 35_000.0, "cruise") == pytest.approx(
        expected, abs=0.5
    )


def test_average_phase_tas_within_band() -> None:
    # Climb avg TAS from MSL→FL350 should sit between the slowest band
    # (250 kt under FL100) and the fastest (cruise-altitude Mach).
    avg = average_phase_tas_kt("B738", 0.0, 35_000.0, "climb")
    assert 280 <= avg <= 460


# ---- Timeline integration --------------------------------------------------


def test_timeline_timestamps_strictly_increasing() -> None:
    tl = build_flight_timeline(
        waypoint_sequence=[_VYYY, _VYMD],
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        rfl_ft=35_000.0,
        eobt=_EOBT,
    )
    for a, b in zip(tl.samples, tl.samples[1:]):
        assert b.epoch_ts > a.epoch_ts
        assert b.elapsed_s > a.elapsed_s


def test_timeline_first_sample_at_eobt() -> None:
    tl = build_flight_timeline(
        waypoint_sequence=[_VYYY, _VYMD],
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        rfl_ft=35_000.0,
        eobt=_EOBT,
    )
    assert tl.samples[0].epoch_ts == _EOBT
    assert tl.samples[0].elapsed_s == 0.0


def test_timeline_speeds_match_phase_targets() -> None:
    tl = build_flight_timeline(
        waypoint_sequence=[_VYYY, _VYMD],
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        rfl_ft=35_000.0,
        eobt=_EOBT,
    )
    # First sample is at takeoff — should honor the 250 kt restriction.
    first = tl.samples[0]
    cas = tas_to_cas_kt(first.gs_kt, first.altitude_ft)
    assert cas <= 251.0

    # A cruise sample (find one) should match the cruise Mach TAS.
    cruise_samples = [s for s in tl.samples if s.phase == "cruise"]
    assert cruise_samples, "expected at least one cruise sample"
    cruise = cruise_samples[len(cruise_samples) // 2]
    expected = mach_to_tas_kt(
        aircraft_speeds("B738").cruise_mach, cruise.altitude_ft
    )
    assert cruise.tas_kt == pytest.approx(expected, abs=2.0)


def test_vyyy_vymd_flight_time_within_5_min_of_reference() -> None:
    # Phase 3 acceptance criterion: simulated total flight time within
    # 5 min of the reference for the same city pair.
    #
    # No measured reference table ships with the repo, so the reference is
    # the performance-derived analytic estimate (validation.estimate_sim_min)
    # for the same airframe, distance, cruise level and field elevations.
    from trajectory_sim.geodesy import route_distance_nm
    from trajectory_sim.performance import field_elevation_ft
    from trajectory_sim.validation import estimate_sim_min

    tl = build_flight_timeline(
        waypoint_sequence=[_VYYY, _VYMD],
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        rfl_ft=35_000.0,
        eobt=_EOBT,
    )
    minutes = tl.total_time_s / 60.0
    reference = estimate_sim_min(
        route_distance_nm([_VYYY, _VYMD]),
        "B738",
        cruise_alt_ft=35_000.0,
        dep_elev_ft=field_elevation_ft("VYYY"),
        arr_elev_ft=field_elevation_ft("VYMD"),
    )
    assert abs(minutes - reference) < 5.0, (
        f"VYYY→VYMD simulated time {minutes:.1f} min is not within 5 min of "
        f"the {reference:.1f} min reference; tune the speed schedule"
    )


def test_timeline_endpoints_anchored_to_route() -> None:
    tl = build_flight_timeline(
        waypoint_sequence=[_VYYY, _VYMD],
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        rfl_ft=35_000.0,
        eobt=_EOBT,
    )
    # Start within ~1 NM of ADEP, end within ~1 NM of ADES.
    from trajectory_sim.geodesy import haversine_distance

    assert haversine_distance(
        tl.samples[0].lat, tl.samples[0].lon, *_VYYY
    ) < 1.0
    assert haversine_distance(
        tl.samples[-1].lat, tl.samples[-1].lon, *_VYMD
    ) < 1.0


def test_endpoint_track_carries_over_a_trailing_zero_length_leg() -> None:
    """A path whose final fix is duplicated (e.g. the runway threshold repeated
    as the ADES anchor) has a zero-length last leg. The endpoint sample's track
    must carry the real inbound heading, not snap to due north — the touchdown
    heading darting to 000° was an approach "cut" artifact."""
    # Two legs heading due east (~090°) then a coincident final point.
    waypoints = [(20.0, 93.0), (20.0, 93.1), (20.0, 93.1)]
    legs = _leg_distances_nm(waypoints)
    assert legs[-1] == pytest.approx(0.0, abs=1e-9)
    total = sum(legs)
    # A sample AT the end and one PAST it both report the eastbound heading.
    for d in (total, total + 5.0):
        _lat, _lon, track = _locate_along_route(waypoints, legs, d)
        assert track == pytest.approx(90.0, abs=1.0)


def test_sample_on_a_mid_route_zero_length_leg_keeps_prior_heading() -> None:
    """A duplicated fix mid-sequence must not zero the heading either: a sample
    landing on it keeps the last ground-covering leg's track."""
    waypoints = [(8.0, 98.0), (8.0, 98.1), (8.0, 98.1), (8.0, 98.2)]
    legs = _leg_distances_nm(waypoints)
    total = sum(legs)
    # Land exactly on the duplicated fix (end of legs[0], on the zero leg[1]).
    _lat, _lon, track = _locate_along_route(waypoints, legs, legs[0])
    assert track == pytest.approx(90.0, abs=1.0)
