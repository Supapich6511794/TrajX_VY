"""Tests for fpl.py — FlightPlan dataclass and route parser."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from trajectory_sim.fpl import FlightPlan, parse_route


# --- parse_route -----------------------------------------------------------

def test_simple_dct_route() -> None:
    assert parse_route("DCT KARBI DCT VIBUN DCT") == ["KARBI", "VIBUN"]


def test_mixed_airway_route() -> None:
    assert parse_route("DCT KARBI A1 VIBUN M750 LUSMO DCT") == [
        "KARBI",
        "VIBUN",
        "LUSMO",
    ]


def test_route_with_latlon_waypoint() -> None:
    assert parse_route("DCT 1330N10030E DCT VIBUN") == ["1330N10030E", "VIBUN"]


def test_empty_route_returns_empty_list() -> None:
    assert parse_route("") == []


def test_whitespace_only_route_returns_empty_list() -> None:
    assert parse_route("   \t  ") == []


def test_sid_star_logged_and_discarded(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING", logger="trajectory_sim.fpl"):
        result = parse_route("SID KARBI STAR")
    assert result == ["KARBI"]
    messages = " ".join(r.message for r in caplog.records)
    assert "SID" in messages
    assert "STAR" in messages


def test_unrecognized_token_logged(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING", logger="trajectory_sim.fpl"):
        result = parse_route("DCT ??? KARBI")
    assert result == ["KARBI"]
    assert any("???" in r.message for r in caplog.records)


# --- FlightPlan ------------------------------------------------------------

def _valid_kwargs(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = dict(
        callsign="THA204",
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        eobt=datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc),
        rfl=330,
        route="DCT KARBI DCT VIBUN DCT",
    )
    base.update(overrides)
    return base


def test_flightplan_accepts_utc_eobt() -> None:
    fp = FlightPlan(**_valid_kwargs())  # type: ignore[arg-type]
    assert fp.callsign == "THA204"
    assert fp.eobt.utcoffset() == timedelta(0)


def test_flightplan_rejects_naive_eobt() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        FlightPlan(**_valid_kwargs(eobt=datetime(2026, 1, 3, 8, 15)))  # type: ignore[arg-type]


def test_flightplan_rejects_non_utc_eobt() -> None:
    yangon = timezone(timedelta(hours=6, minutes=30))
    with pytest.raises(ValueError, match="UTC"):
        FlightPlan(
            **_valid_kwargs(eobt=datetime(2026, 1, 3, 15, 15, tzinfo=yangon))  # type: ignore[arg-type]
        )


def test_flightplan_is_frozen() -> None:
    fp = FlightPlan(**_valid_kwargs())  # type: ignore[arg-type]
    with pytest.raises(Exception):  # FrozenInstanceError
        fp.callsign = "OTHER"  # type: ignore[misc]
