"""Tests for geodesy.py."""

from __future__ import annotations

import pytest

from trajectory_sim.geodesy import (
    compute_bearing,
    haversine_distance,
    interpolate_great_circle,
)

# Validation city pair from the brief
VYYY_LAT, VYYY_LON = 16.9073, 96.1332
VYMD_LAT, VYMD_LON = 21.7011, 95.9775


# --- haversine_distance ----------------------------------------------------

def test_haversine_distance_vyyy_to_vymd_matches_reference() -> None:
    # Yangon (VYYY) to Mandalay (VYMD) is ~287 NM (~531 km) by WGS-84
    # geodesic between the two aerodrome reference points.
    distance_nm = haversine_distance(VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON)
    assert distance_nm == pytest.approx(287.0, abs=5.0)


def test_haversine_distance_zero_for_same_point() -> None:
    assert haversine_distance(13.0, 100.0, 13.0, 100.0) == pytest.approx(
        0.0, abs=1e-6
    )


def test_haversine_distance_symmetric() -> None:
    d_ab = haversine_distance(VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON)
    d_ba = haversine_distance(VYMD_LAT, VYMD_LON, VYYY_LAT, VYYY_LON)
    assert d_ab == pytest.approx(d_ba)


# --- compute_bearing -------------------------------------------------------

def test_compute_bearing_vyyy_to_vymd_north() -> None:
    bearing = compute_bearing(VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON)
    assert 350.0 <= bearing <= 360.0


def test_compute_bearing_due_north() -> None:
    bearing = compute_bearing(13.0, 100.0, 14.0, 100.0)
    assert bearing == pytest.approx(0.0, abs=0.1)


def test_compute_bearing_due_west_in_zero_to_360_range() -> None:
    # At lat=13°, an initial geodesic heading toward a point 1° west is
    # slightly north of 270° because the geodesic bows toward the
    # equator — it doesn't follow the parallel. ±0.5° tolerance covers
    # this for short legs at mid-latitudes.
    bearing = compute_bearing(13.0, 100.0, 13.0, 99.0)
    assert 0.0 <= bearing < 360.0
    assert bearing == pytest.approx(270.0, abs=0.5)


# --- interpolate_great_circle ----------------------------------------------

def test_interpolate_first_point_at_start() -> None:
    points = interpolate_great_circle(VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON)
    assert points[0]["lat"] == pytest.approx(VYYY_LAT, abs=0.01)
    assert points[0]["lon"] == pytest.approx(VYYY_LON, abs=0.01)
    assert points[0]["elapsed_s"] == pytest.approx(0.0, abs=1e-6)


def test_interpolate_last_point_at_end() -> None:
    points = interpolate_great_circle(VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON)
    assert points[-1]["lat"] == pytest.approx(VYMD_LAT, abs=0.01)
    assert points[-1]["lon"] == pytest.approx(VYMD_LON, abs=0.01)


def test_interpolate_elapsed_matches_distance_over_speed() -> None:
    points = interpolate_great_circle(
        VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON, ground_speed_kt=450.0
    )
    distance_nm = haversine_distance(VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON)
    expected_time_s = (distance_nm / 450.0) * 3600.0
    assert points[-1]["elapsed_s"] == pytest.approx(expected_time_s, abs=5.0)


def test_interpolate_emits_on_4s_grid_except_endpoint() -> None:
    points = interpolate_great_circle(
        VYYY_LAT, VYYY_LON, VYMD_LAT, VYMD_LON,
        ground_speed_kt=450.0,
        output_every_s=4.0,
    )
    # Drop the (potentially off-grid) endpoint
    grid_points = points[:-1]
    assert len(grid_points) > 0
    for p in grid_points:
        assert p["elapsed_s"] % 4.0 == pytest.approx(0.0, abs=1e-6)


def test_interpolate_zero_distance_leg_returns_single_point() -> None:
    points = interpolate_great_circle(13.0, 100.0, 13.0, 100.0)
    assert len(points) == 1
    assert points[0]["elapsed_s"] == pytest.approx(0.0, abs=1e-6)


def test_interpolate_endpoint_within_1ms_of_grid_replaces_not_appends() -> None:
    """A leg whose duration sits just above a 4-s grid point must not
    emit both the grid point and the endpoint — GeoPackage stores
    timestamps at ms precision, so a ~µs-apart pair collides on the
    (flight_key, epoch_ts) primary key. Engineer a leg whose duration
    is 16.0 + 0.0001 s by picking the distance directly from ground
    speed: at 450 kt → 1 step of 4 s ≈ 0.926 km."""
    gs_ms = 450.0 * 1852.0 / 3600.0  # ~231.5 m/s
    # Target leg duration: 16.0001 s → bias the grid-vs-endpoint case.
    target_t = 16.0 + 1e-4
    distance_m = gs_ms * target_t
    # Walk that distance due east from (0, 0) using a flat
    # approximation — exact distance doesn't need to match target_t to
    # the µs, only land within the (4 s, 4 s + 1 ms) window.
    lon2 = distance_m / 111_320.0
    points = interpolate_great_circle(
        0.0, 0.0, 0.0, lon2,
        ground_speed_kt=450.0,
        output_every_s=4.0,
    )
    # No two consecutive points should fall within the GPKG ms-precision
    # window — otherwise the trajectory writer's unique index breaks.
    for a, b in zip(points, points[1:]):
        assert b["elapsed_s"] - a["elapsed_s"] >= 1e-3, (
            f"near-duplicate emission at {a} / {b} (Δ = "
            f"{b['elapsed_s'] - a['elapsed_s']:.6f}s)"
        )
