"""Tests for navdata.py — NavData GeoPackage accessor.

Uses an in-memory GeoDataFrame fixture so tests do not depend on the
real bearcat_navdata.gpkg file.
"""

from __future__ import annotations

import geopandas as gpd
import pytest
from shapely.geometry import Point

from trajectory_sim.navdata import NavData, WaypointNotFoundError


@pytest.fixture
def fake_waypoints_gdf() -> gpd.GeoDataFrame:
    """Tiny in-memory waypoints layer (3 synthetic fixes)."""
    rows = [
        # shapely Point takes (x, y) = (lon, lat)
        {"ident": "KARBI", "name": "KARBI", "type": "ENRT",
         "geometry": Point(100.5, 13.5)},
        {"ident": "VIBUN", "name": "VIBUN", "type": "ENRT",
         "geometry": Point(99.0, 8.0)},
        {"ident": "LUSMO", "name": "LUSMO", "type": "ENRT",
         "geometry": Point(101.0, 12.25)},
    ]
    return gpd.GeoDataFrame(rows, crs="EPSG:4326")


@pytest.fixture
def navdata(
    monkeypatch: pytest.MonkeyPatch,
    fake_waypoints_gdf: gpd.GeoDataFrame,
) -> NavData:
    """NavData instance backed by the in-memory fixture."""
    import trajectory_sim.navdata as navdata_mod

    monkeypatch.setattr(
        navdata_mod.gpd,
        "read_file",
        lambda path, layer: fake_waypoints_gdf.copy(),
    )
    return NavData("ignored-path.gpkg")


def test_lookup_known_waypoint(navdata: NavData) -> None:
    lat, lon = navdata.lookup_waypoint("KARBI")
    assert lat == pytest.approx(13.5)
    assert lon == pytest.approx(100.5)


def test_lookup_unknown_raises_with_ident(navdata: NavData) -> None:
    with pytest.raises(WaypointNotFoundError) as excinfo:
        navdata.lookup_waypoint("ZZZZZ")
    assert excinfo.value.ident == "ZZZZZ"


def test_lookup_bulk_returns_all_requested(navdata: NavData) -> None:
    result = navdata.lookup_waypoints_bulk(["KARBI", "VIBUN"])
    assert set(result.keys()) == {"KARBI", "VIBUN"}
    assert result["KARBI"][0] == pytest.approx(13.5)
    assert result["KARBI"][1] == pytest.approx(100.5)
    assert result["VIBUN"][0] == pytest.approx(8.0)
    assert result["VIBUN"][1] == pytest.approx(99.0)


def test_lookup_bulk_preserves_input_order(navdata: NavData) -> None:
    result = navdata.lookup_waypoints_bulk(["LUSMO", "KARBI", "VIBUN"])
    assert list(result.keys()) == ["LUSMO", "KARBI", "VIBUN"]


def test_lookup_bulk_unknown_raises(navdata: NavData) -> None:
    with pytest.raises(WaypointNotFoundError) as excinfo:
        navdata.lookup_waypoints_bulk(["KARBI", "ZZZZZ"])
    assert excinfo.value.ident == "ZZZZZ"


def test_gdf_loaded_once_not_per_lookup(
    monkeypatch: pytest.MonkeyPatch,
    fake_waypoints_gdf: gpd.GeoDataFrame,
) -> None:
    """read_file should be called exactly once at construction."""
    import trajectory_sim.navdata as navdata_mod

    call_count = 0

    def fake_read_file(path: object, layer: str) -> gpd.GeoDataFrame:
        nonlocal call_count
        call_count += 1
        return fake_waypoints_gdf.copy()

    monkeypatch.setattr(navdata_mod.gpd, "read_file", fake_read_file)
    nd = NavData("ignored-path.gpkg")
    nd.lookup_waypoint("KARBI")
    nd.lookup_waypoint("VIBUN")
    nd.lookup_waypoints_bulk(["KARBI", "LUSMO"])
    assert call_count == 1
