"""Acceptance criteria: flight-time validation must use the REAL aircraft.

The flight-time check used to score every airframe against a hard-coded
distance-to-time curve measured on a B738 to RFL350. A 285 NM domestic leg
flown by an AT76 (ATR 72-600) simulated correctly at 70 min was compared to a
49 min "reference" -- 349 kt average, a jet -- and reported FAIL. The
simulation was right; the reference was another aircraft.

These tests pin the two properties that stop it coming back:

  1. the numbers behind a reference time are pulled from the Thai APM for the
     aircraft type actually being flown, traceable to the dataset on disk; and
  2. no airframe is ever substituted -- a type without its own data yields NO
     check rather than a confident PASS/FAIL computed from a 737.

They are deliberately data-driven: several assert against the shipped Thai APM
CSV rather than constants in the code, so editing the source alone cannot make
them pass.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from trajectory_sim.performance import (
    PERFORMANCE_SOURCE,
    SUBSTITUTE_TYPE,
    UnknownAircraftPerformance,
    dataset_is_thai_apm,
    estimator_types,
    performance_provenance,
    reachable_ceiling_ft,
    require_apm_performance,
)
from trajectory_sim.validation import (
    ACCEPTANCE_THRESHOLD_MIN,
    estimate_profile,
    estimate_sim_min,
    validate_against_estimate,
)

#: The reported flight: an AT76 on a 285 NM domestic leg.
_ATR = "AT76"
_ATR_CRUISE_FT = 18000.0
#: A type WITH Thai APM rates but no operational speed schedule of its own --
#: the subtler substitution, since the rates look fine and only the speeds
#: would silently become a 737's M0.78.
_RATES_ONLY_TYPE = "SF34"
#: A type in neither table.
_UNKNOWN_TYPE = "ZZZZ"

_APM_CSV = Path(__file__).resolve().parents[1] / "data" / "thaiapm_performance.csv"


def _climb_minutes_from_csv(actype: str, to_ft: float, isa_offset: int = 15) -> float:
    """Integrate the climb to ``to_ft`` straight out of the shipped CSV.

    An independent path to the same number: reads the dataset file, averages
    each consecutive FL pair's ``rocd_nom`` into a constant-rate band and
    integrates. If the estimator ever stops sourcing its rates from this
    dataset, this disagrees.
    """
    with _APM_CSV.open(encoding="utf-8-sig", newline="") as fh:
        pts = sorted(
            (int(float(r["fl"])), float(r["rocd_nom"]))
            for r in csv.DictReader(fh)
            if r["actype"] == actype
            and r["phase"] == "climb"
            and int(r["isa_offset"]) == isa_offset
            and r["rocd_nom"]
        )
    seconds = 0.0
    for (fl0, rate0), (fl1, rate1) in zip(pts, pts[1:]):
        rate = (rate0 + rate1) / 2.0
        lo, hi = fl0 * 100.0, min(fl1 * 100.0, to_ft)
        if hi > lo and rate > 1.0:
            seconds += (hi - lo) / rate * 60.0
    return seconds / 60.0


class TestPerformanceComesFromTheThaiAPM:
    """Criterion 1 -- the reference is built from the Thai APM, per type."""

    def test_the_loaded_dataset_is_the_thai_apm(self) -> None:
        """Not the hand-coded _LEGACY_PERF_TABLES last resort."""
        assert dataset_is_thai_apm(), PERFORMANCE_SOURCE
        assert PERFORMANCE_SOURCE.startswith("Thai APM")

    def test_estimates_are_offered_only_for_thai_apm_types(self) -> None:
        types = estimator_types()
        assert types, "no airframe can be validated at all"
        assert _ATR in types
        for actype in types:
            prov = performance_provenance(actype)
            assert prov.rates_exact, f"{actype} borrows another type's rates"
            assert prov.speeds_exact, f"{actype} borrows another type's speeds"
            assert prov.usable_for_validation
            assert not prov.substituted

    def test_the_climb_time_traces_back_to_the_dataset_file(self) -> None:
        """The estimate's climb is the APM's own rates, not a code constant.

        Compares against an integration done here, off the CSV on disk.
        """
        expected = _climb_minutes_from_csv(_ATR, _ATR_CRUISE_FT)
        got = estimate_profile(
            285.4, _ATR, cruise_alt_ft=_ATR_CRUISE_FT
        ).climb_min
        assert expected > 0
        assert got == pytest.approx(expected, abs=0.05)

    def test_the_estimate_reports_the_dataset_it_used(self) -> None:
        est = estimate_profile(285.4, _ATR, cruise_alt_ft=_ATR_CRUISE_FT)
        assert est.dataset.startswith("Thai APM")
        assert est.aircraft_type == _ATR

    def test_the_reachable_ceiling_is_the_types_own_observed_top(self) -> None:
        """AT76 tops out at FL180 in the Thai APM data, well under its FL250
        service ceiling -- so a filed FL250 is clamped, not extrapolated."""
        assert reachable_ceiling_ft(_ATR) == pytest.approx(_ATR_CRUISE_FT)


class TestNoFallbackToTheHardCodedB738:
    """Criterion 2 -- refuse to substitute, never guess."""

    def test_an_unknown_type_raises_instead_of_borrowing_the_b738(self) -> None:
        with pytest.raises(UnknownAircraftPerformance):
            estimate_sim_min(285.4, _UNKNOWN_TYPE)

    def test_rates_without_a_speed_schedule_also_raise(self) -> None:
        """The subtle case: APM rates exist, so only the SPEEDS would be
        substituted -- a 737's M0.78 on a Saab 340."""
        prov = performance_provenance(_RATES_ONLY_TYPE)
        assert prov.rates_exact, f"{_RATES_ONLY_TYPE} should have APM rates"
        assert not prov.speeds_exact
        with pytest.raises(UnknownAircraftPerformance):
            estimate_sim_min(285.4, _RATES_ONLY_TYPE)

    def test_the_refusal_names_the_substitution_it_declined(self) -> None:
        with pytest.raises(UnknownAircraftPerformance) as exc:
            require_apm_performance(_UNKNOWN_TYPE)
        assert SUBSTITUTE_TYPE in str(exc.value)

    def test_validate_reports_no_check_rather_than_a_b738_number(self) -> None:
        """An unsupported type must get NO verdict. A wrong PASS/FAIL is
        worse than none."""
        assert (
            validate_against_estimate(
                "VYYY", "VYMD", 70.0,
                distance_nm=285.4, aircraft_type=_UNKNOWN_TYPE,
            )
            is None
        )

    def test_validate_still_declines_when_no_type_is_given(self) -> None:
        assert validate_against_estimate(
            "VYYY", "VYMD", 70.0, distance_nm=285.4, aircraft_type=None
        ) is None

    def test_no_hard_coded_distance_time_curve_survives(self) -> None:
        """Source guard: the B738 lookup table must stay deleted."""
        src = (
            Path(__file__).resolve().parents[1] / "validation.py"
        ).read_text(encoding="utf-8")
        assert "_SIM_TIME_TABLE" not in src


class TestTheEstimateTracksTheAirframe:
    """The point of all of it: different aircraft, different reference."""

    def test_a_turboprop_and_a_jet_differ_over_the_same_route(self) -> None:
        atr = estimate_sim_min(285.4, _ATR, cruise_alt_ft=_ATR_CRUISE_FT)
        jet = estimate_sim_min(285.4, "B738", cruise_alt_ft=35000.0)
        assert atr - jet > 15.0, (
            f"AT76 {atr:.1f} min vs B738 {jet:.1f} min -- the estimate is "
            "not tracking the airframe"
        )

    def test_the_atr72_leg_that_used_to_fail_now_matches_the_simulation(
        self,
    ) -> None:
        """The regression. 285.4 NM at FL180 simulates at ~70 min; the old
        B738 curve predicted 46 (49 with margin) and reported FAIL."""
        simulated_min = 70.0
        predicted = estimate_sim_min(
            285.4, _ATR, cruise_alt_ft=_ATR_CRUISE_FT
        )
        assert abs(predicted - simulated_min) < ACCEPTANCE_THRESHOLD_MIN

    def test_a_short_hop_never_reaches_the_filed_level(self) -> None:
        est = estimate_profile(60.0, _ATR, cruise_alt_ft=_ATR_CRUISE_FT)
        assert not est.reached_cruise
        assert est.top_ft < _ATR_CRUISE_FT
        assert est.cruise_min == 0.0

    def test_a_long_route_reaches_it_and_cruises(self) -> None:
        est = estimate_profile(600.0, _ATR, cruise_alt_ft=_ATR_CRUISE_FT)
        assert est.reached_cruise
        assert est.top_ft == pytest.approx(_ATR_CRUISE_FT)
        assert est.cruise_min > 0

    def test_time_rises_with_distance(self) -> None:
        times = [
            estimate_sim_min(d, _ATR, cruise_alt_ft=_ATR_CRUISE_FT)
            for d in (50, 100, 200, 400, 800)
        ]
        assert times == sorted(times)

    def test_a_filed_level_above_the_ceiling_is_clamped_not_extrapolated(
        self,
    ) -> None:
        """BKP211 filed FL250; the AT76 can only be flown to FL180 here."""
        filed = estimate_profile(285.4, _ATR, cruise_alt_ft=25000.0)
        clamped = estimate_profile(285.4, _ATR, cruise_alt_ft=_ATR_CRUISE_FT)
        assert filed.top_ft == pytest.approx(_ATR_CRUISE_FT)
        assert filed.total_min == pytest.approx(clamped.total_min)
