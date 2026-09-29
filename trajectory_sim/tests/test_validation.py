"""Tests for the flight-time validation module + speed tuning."""

from __future__ import annotations

from trajectory_sim.performance import (
    VerticalProfile,
    aircraft_speeds,
    get_speed_restriction,
    service_ceiling_ft,
    set_speed_restriction,
    tune_speed_schedule,
)
from trajectory_sim.validation import (
    FlightTimeValidation,
    cab_cruising_level,
    validate_cruise_level,
    validate_cruising_level,
    validate_against_estimate,
    validate_flight_time,
)


def test_delta_and_pass_within_threshold() -> None:
    v = validate_flight_time("VYYY-VYMD", cat62_min=128, simulated_min=131)
    assert v.delta_min == 3
    assert v.status == "PASS"
    assert v.passed is True


def test_fail_at_or_beyond_threshold() -> None:
    # Exactly 5 minutes is a FAIL (acceptance is strictly < 5).
    v = validate_flight_time("A-B", cat62_min=100, simulated_min=105)
    assert v.delta_min == 5
    assert v.status == "FAIL"
    # 5+ also fails, and a negative (too fast) delta fails symmetrically.
    assert validate_flight_time("A-B", 100, 94).status == "FAIL"
    assert validate_flight_time("A-B", 100, 96).status == "PASS"


def test_report_matches_spec_example() -> None:
    v = validate_flight_time("VYYY-VYMD", 128, 131)
    assert v.report() == (
        "Route: VYYY-VYMD\n"
        "CAT62 Time: 128 min\n"
        "Simulated Time: 131 min\n"
        "Delta: +3 min\n"
        "Status: PASS"
    )


def test_report_negative_delta_sign() -> None:
    v = validate_flight_time("VYYY-VYMD", cat62_min=70, simulated_min=66)
    assert "Delta: -4 min" in v.report()
    assert v.passed is True


def test_estimate_validation_grades_a_supported_type() -> None:
    """With no measured reference table, the check is graded against the
    airframe's own performance estimate (source "estimate")."""
    v = validate_against_estimate(
        "VYYY", "VYMD", 60.0, distance_nm=320.0, aircraft_type="B738"
    )
    assert isinstance(v, FlightTimeValidation)
    assert v.source == "estimate"
    assert v.route == "VYYY-VYMD"


def test_estimate_validation_needs_a_distance_and_a_type() -> None:
    assert validate_against_estimate(
        "VYYY", "VYMD", 60.0, distance_nm=None, aircraft_type="B738"
    ) is None
    assert validate_against_estimate(
        "VYYY", "VYMD", 60.0, distance_nm=320.0, aircraft_type=None
    ) is None


def test_tune_speed_schedule_partial_override() -> None:
    try:
        base = aircraft_speeds("B738")
        tuned = tune_speed_schedule("B738", cruise_mach=0.74)
        assert tuned.cruise_mach == 0.74
        # Untouched fields are preserved.
        assert tuned.climb_cas_kt == base.climb_cas_kt
        # The override is now what aircraft_speeds returns.
        assert aircraft_speeds("B738").cruise_mach == 0.74
    finally:
        # Restore so other tests see the baseline schedule.
        tune_speed_schedule(
            "B738",
            climb_cas_kt=290.0,
            climb_mach=0.78,
            cruise_mach=0.785,
            descent_mach=0.78,
            descent_cas_kt=290.0,
        )


def test_set_speed_restriction_roundtrip() -> None:
    orig_cas, orig_alt = get_speed_restriction()
    try:
        set_speed_restriction(cas_kt=280.0, below_alt_ft=8000.0)
        assert get_speed_restriction() == (280.0, 8000.0)
    finally:
        set_speed_restriction(cas_kt=orig_cas, below_alt_ft=orig_alt)


# --- Cruise level vs FPL RFL -------------------------------------------------


def test_cruise_level_exact_match_passes() -> None:
    v = validate_cruise_level(35000.0, 35000.0, route="VYYY-VYMD")
    assert v.reason == "exact"
    assert v.passed is True
    assert v.delta_ft == 0.0
    assert v.is_exact is True


def test_cruise_level_within_tolerance_is_exact() -> None:
    v = validate_cruise_level(35000.0, 34999.5)
    assert v.reason == "exact" and v.passed


def test_cruise_level_ceiling_limited_passes() -> None:
    # FPL asked FL450 but the airframe tops out at its service ceiling.
    v = validate_cruise_level(
        45000.0, 41000.0, service_ceiling_ft=41000.0, climb_top_ft=41000.0
    )
    assert v.reason == "ceiling_limited"
    assert v.passed is True
    assert v.delta_ft == -4000.0


def test_cruise_level_climb_limited_passes() -> None:
    # Below the service ceiling, but above what the climb schedule reaches.
    v = validate_cruise_level(
        43000.0, 41000.0, service_ceiling_ft=45000.0, climb_top_ft=41000.0
    )
    assert v.reason == "climb_limited" and v.passed


def test_cruise_level_distance_limited_passes() -> None:
    # Level is within reach, but the flight is too short to get there.
    v = validate_cruise_level(
        35000.0,
        28000.0,
        service_ceiling_ft=41000.0,
        climb_top_ft=41000.0,
        reaches_rfl=False,
    )
    assert v.reason == "distance_limited" and v.passed


def test_cruise_level_mismatch_fails() -> None:
    # Reachable and time allows it, yet cruise came out lower — a bug → FAIL.
    v = validate_cruise_level(
        35000.0,
        28000.0,
        service_ceiling_ft=41000.0,
        climb_top_ft=41000.0,
        reaches_rfl=True,
    )
    assert v.reason == "mismatch" and not v.passed


def test_cruise_level_overshoot_fails() -> None:
    # Simulated cruise ABOVE the requested level is never a valid clamp.
    v = validate_cruise_level(35000.0, 37000.0, service_ceiling_ft=41000.0)
    assert v.reason == "overshoot" and not v.passed


def test_cruise_level_report_format() -> None:
    v = validate_cruise_level(35000.0, 35000.0, route="VYYY-VYMD")
    assert v.report() == (
        "Route: VYYY-VYMD\n"
        "Requested Level: FL350\n"
        "Simulated Cruise: FL350\n"
        "Delta: +0 ft\n"
        "Status: PASS (exact)"
    )


# --- CAB cruising-level (hemispheric) check ----------------------------------


def test_cruising_level_eastbound_needs_odd() -> None:
    # Track 090° (eastbound, 000-179) → odd FL only.
    assert validate_cruising_level(90.0, 35000.0).passed      # FL350 odd → OK
    assert not validate_cruising_level(90.0, 34000.0).passed  # FL340 even → FAIL
    v = validate_cruising_level(90.0, 34000.0, route="A-B")
    assert v.direction == "E" and v.nearest_valid_fl in (330, 350)


def test_cruising_level_westbound_needs_even() -> None:
    # Track 270° (westbound, 180-359) → even FL only.
    assert validate_cruising_level(270.0, 34000.0).passed      # FL340 even → OK
    assert not validate_cruising_level(270.0, 35000.0).passed  # FL350 odd → FAIL
    assert validate_cruising_level(270.0, 35000.0).direction == "W"


def test_cruising_level_above_fl410_uses_published_sets() -> None:
    # Non-RVSM band: FL430/470/510 are WEST, FL450/490 are EAST (not parity).
    assert validate_cruising_level(270.0, 43000.0).passed      # FL430 west → OK
    assert validate_cruising_level(90.0, 45000.0).passed       # FL450 east → OK
    assert not validate_cruising_level(90.0, 43000.0).passed   # FL430 not east


def test_cab_cruising_level_snaps_to_direction() -> None:
    # Eastbound wants odd near FL340 → FL330 or FL350.
    assert cab_cruising_level(90.0, 340) in (330, 350)
    # Westbound wants even near FL350 → FL340 or FL360.
    assert cab_cruising_level(270.0, 350) in (340, 360)
    # An already-valid level is unchanged.
    assert cab_cruising_level(270.0, 340) == 340
    assert cab_cruising_level(90.0, 350) == 350


def test_cab_cruising_level_capped_respects_ceiling() -> None:
    from trajectory_sim.validation import cab_cruising_level_capped

    # Westbound wants FL400 but the airframe tops at FL380 → highest even
    # compliant level at/under the cap.
    fl = cab_cruising_level_capped(270.0, 400, 380)
    assert fl <= 380 and fl % 2 == 0
    # Below the cap, it behaves like the uncapped snap.
    assert cab_cruising_level_capped(270.0, 350, 400) == cab_cruising_level(270.0, 350)
    # An exactly-reachable requested level is kept.
    assert cab_cruising_level_capped(90.0, 350, 380) == 350


def test_reachable_ceiling_below_service_ceiling() -> None:
    # Thai APM caps the B738 climb table at FL380, below its FL410 service
    # ceiling — this is the level a flight planner must not file above.
    from trajectory_sim.performance import (
        reachable_ceiling_ft,
        service_ceiling_ft as svc,
    )

    assert reachable_ceiling_ft("B738") == 38000.0
    assert reachable_ceiling_ft("B738") <= svc("B738")


def test_cruise_level_with_real_profile_exact_and_short() -> None:
    ac = "B738"
    ceil = service_ceiling_ft(ac)

    # Long flight → reaches FL350 exactly.
    long_p = VerticalProfile.build(7200.0, 35000.0, ac, 0.0, 0.0)
    assert long_p.reaches_ft(35000.0) is True
    v_long = validate_cruise_level(
        35000.0,
        long_p.cruise_alt_ft,
        service_ceiling_ft=ceil,
        climb_top_ft=long_p.climb_top_ft,
        reaches_rfl=long_p.reaches_ft(35000.0),
    )
    assert v_long.reason == "exact" and v_long.passed

    # Very short flight → clamped below FL350, but PASS as distance_limited.
    short_p = VerticalProfile.build(600.0, 35000.0, ac, 0.0, 0.0)
    assert short_p.cruise_alt_ft < 35000.0
    assert short_p.reaches_ft(35000.0) is False
    v_short = validate_cruise_level(
        35000.0,
        short_p.cruise_alt_ft,
        service_ceiling_ft=ceil,
        climb_top_ft=short_p.climb_top_ft,
        reaches_rfl=short_p.reaches_ft(35000.0),
    )
    assert v_short.reason == "distance_limited" and v_short.passed
