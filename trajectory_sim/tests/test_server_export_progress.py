"""What the download dialog needs in order to show real progress.

An export is slow in one place — writing each route's file — and that used to
happen invisibly inside the download request, so the dialog could only show a
spinner. Two things make it measurable, and both are contracts the client
depends on:

  * ``POST /api/export_prepare`` renders the per-route files WITHOUT sending
    them, so the dialog can render them in batches and count "route N of M";
  * the download responses carry a ``Content-Length``, so the browser can show
    a transfer percentage. Starlette omits it for a StreamingResponse, which
    left every export download indeterminate.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from api import server as srv  # noqa: E402
from trajectory_sim.output import build_trajectory_gdf  # noqa: E402

_KEYS = ("TEST_EXPORT_PROGRESS_A", "TEST_EXPORT_PROGRESS_B")
_EOBT = datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc)


@pytest.fixture()
def client() -> TestClient:
    return TestClient(srv.app)


@pytest.fixture()
def seeded():
    """Two cached exports standing in for generated flights."""
    for key in _KEYS:
        gdf = build_trajectory_gdf(
            waypoint_sequence=[(16.91, 96.13), (19.3, 96.1), (21.70, 95.98)],
            eobt=_EOBT,
            callsign=key[-1],
            aircraft_type="B738",
            adep="VYYY",
            ades="VYMD",
        )
        route_feature = {
            "type": "Feature",
            "properties": {"feature_type": "route", "route": "BGO W13 MIA"},
            "geometry": {
                "type": "LineString",
                "coordinates": [[96.13, 16.91], [95.98, 21.70]],
            },
        }
        srv._cache_export(key, gdf, "BGO W13 MIA", 330.0, route_feature)
    yield
    for key in _KEYS:
        srv._EXPORT_CACHE.pop(key, None)
        srv._drop_files(key)


class TestExportPrepare:
    def test_renders_the_files_and_reports_their_size(
        self, client: TestClient, seeded: None
    ) -> None:
        res = client.post(
            "/api/export_prepare",
            json={"files": [{"flight_key": k, "ext": "csv"} for k in _KEYS]},
        )
        assert res.status_code == 200
        files = res.json()["files"]
        assert [f["flight_key"] for f in files] == list(_KEYS)
        assert all(f["ready"] for f in files)
        # A size is the whole point — it is what the dialog totals up.
        assert all(f["bytes"] > 0 for f in files)
        for key in _KEYS:
            assert (srv._OUT_DIR / f"{key}.csv").is_file()

    def test_is_idempotent(self, client: TestClient, seeded: None) -> None:
        """Preparing then downloading must not do the work twice."""
        body = {"files": [{"flight_key": _KEYS[0], "ext": "gpkg"}]}
        first = client.post("/api/export_prepare", json=body).json()["files"]
        path = srv._OUT_DIR / f"{_KEYS[0]}.gpkg"
        mtime = path.stat().st_mtime_ns
        second = client.post("/api/export_prepare", json=body).json()["files"]
        assert second == first
        assert path.stat().st_mtime_ns == mtime  # untouched, not rewritten

    def test_reports_an_unknown_route_instead_of_failing(
        self, client: TestClient
    ) -> None:
        # One bad key must not sink the batch — the dialog counts it as done
        # and lets the download endpoint decide what to do about it.
        res = client.post(
            "/api/export_prepare",
            json={"files": [{"flight_key": "NOPE_NOT_GENERATED", "ext": "csv"}]},
        )
        assert res.status_code == 200
        assert res.json()["files"] == [
            {
                "flight_key": "NOPE_NOT_GENERATED",
                "ext": "csv",
                "ready": False,
                "bytes": 0,
            }
        ]

    def test_rejects_a_traversing_key(self, client: TestClient) -> None:
        res = client.post(
            "/api/export_prepare",
            json={"files": [{"flight_key": "../../etc/passwd", "ext": "csv"}]},
        )
        assert res.status_code == 200
        assert res.json()["files"] == []


class TestDownloadsStateTheirSize:
    """Content-Length is the one download header that is CORS-safelisted, so
    it is what the web app can read to show a percentage."""

    def test_combined_single_format(
        self, client: TestClient, seeded: None
    ) -> None:
        res = client.post(
            "/api/download_combined",
            json={"flight_keys": list(_KEYS), "formats": ["csv"]},
        )
        assert res.status_code == 200
        assert int(res.headers["content-length"]) == len(res.content)

    def test_combined_multi_format_zip(
        self, client: TestClient, seeded: None
    ) -> None:
        res = client.post(
            "/api/download_combined",
            json={"flight_keys": list(_KEYS), "formats": ["csv", "geojson"]},
        )
        assert res.status_code == 200
        assert res.headers["content-type"] == "application/zip"
        assert int(res.headers["content-length"]) == len(res.content)

    def test_zip_bundle(self, client: TestClient, seeded: None) -> None:
        res = client.post(
            "/api/download_zip",
            json={"files": [{"flight_key": k, "ext": "csv"} for k in _KEYS]},
        )
        assert res.status_code == 200
        assert int(res.headers["content-length"]) == len(res.content)
