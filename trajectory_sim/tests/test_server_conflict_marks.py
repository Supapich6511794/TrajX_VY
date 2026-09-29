"""Loss-of-separation annotation of the downloadable exports.

CD&R detection runs in the browser (only it holds every flight's trajectory at
once), so the export is TOLD which timestamps are in conflict via
``POST /api/conflict_marks``. These tests pin the contract the download files
have to keep:

  * a flight with an unresolved conflict downloads with the breach window in
    the CSV header AND every affected track sample flagged in the ``conflict``
    column (also present in the GeoJSON point properties);
  * resolving it (posting no windows) clears the mark from an ALREADY
    materialised file — otherwise a post-fix download would still accuse the
    flight of a conflict it no longer has.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from api import server as srv  # noqa: E402
from trajectory_sim.output import build_trajectory_gdf  # noqa: E402

_KEY = "TEST_CONFLICT_MARKS"
_EOBT = datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc)


@pytest.fixture()
def client() -> TestClient:
    return TestClient(srv.app)


@pytest.fixture()
def seeded(client: TestClient):
    """A cached export standing in for a generated flight."""
    gdf = build_trajectory_gdf(
        waypoint_sequence=[(16.91, 96.13), (19.3, 96.1), (21.70, 95.98)],
        eobt=_EOBT,
        callsign="UBA204",
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
    )
    route_feature = {
        "type": "Feature",
        "properties": {"feature_type": "route", "route": "BGO W13 MIA"},
        "geometry": {"type": "LineString", "coordinates": [[96.13, 16.91], [95.98, 21.70]]},
    }
    srv._cache_export(_KEY, gdf, "BGO W13 MIA", 330.0, route_feature)
    yield gdf
    srv._EXPORT_CACHE.pop(_KEY, None)
    srv._drop_files(_KEY)


def _span(gdf, i0: int, i1: int) -> dict[str, object]:
    ts = list(gdf["epoch_ts"])
    iso = lambda t: t.to_pydatetime().isoformat().replace("+00:00", "Z")  # noqa: E731
    return {
        "with_callsign": "TGW122",
        "with_flight_key": "TGW122_20260103T0815Z",
        "start_ts": iso(ts[i0]),
        "end_ts": iso(ts[i1]),
        "min_sep_nm": 2.1,
        "min_vert_ft": 200,
        "sep_min_nm": 5,
        "sep_min_ft": 1000,
    }


def _csv_rows(text: str) -> list[list[str]]:
    lines = text.splitlines()
    hdr = next(i for i, ln in enumerate(lines) if ln.startswith("Timestamp,"))
    return [ln.split(",") for ln in lines[hdr + 1:] if ln.strip()]


def test_unresolved_conflict_is_written_into_the_csv(client, seeded) -> None:
    span = _span(seeded, 1, 3)
    r = client.post(
        "/api/conflict_marks",
        json={"marks": [{"flight_key": _KEY, "spans": [span]}]},
    )
    assert r.status_code == 200
    assert r.json()["updated"] == 1

    text = client.get(f"/api/download/{_KEY}.csv").text
    # The window, up front in the header.
    assert "CONFLICT: LOSS OF SEPARATION vs TGW122" in text
    assert span["start_ts"] in text
    assert span["end_ts"] in text
    # …and per sample, so the exact timestamps are readable off the table.
    rows = _csv_rows(text)
    flagged = [i for i, c in enumerate(rows) if c[-1] == "LOS TGW122"]
    assert flagged == [1, 2, 3]


def test_conflict_marks_reach_the_geojson_points(client, seeded) -> None:
    span = _span(seeded, 2, 2)
    client.post(
        "/api/conflict_marks",
        json={"marks": [{"flight_key": _KEY, "spans": [span]}]},
    )
    fc = json.loads(client.get(f"/api/download/{_KEY}.geojson").text)
    # The route feature (first) carries the summary; the points carry the marks.
    assert fc["features"][0]["properties"]["unresolved_conflicts"][0][
        "with_callsign"
    ] == "TGW122"
    marked = [
        f
        for f in fc["features"][1:]
        if (f["properties"] or {}).get("conflict")
    ]
    assert len(marked) == 1
    assert marked[0]["properties"]["conflict"] == "LOS TGW122"


def test_resolving_clears_a_previously_written_mark(client, seeded) -> None:
    client.post(
        "/api/conflict_marks",
        json={"marks": [{"flight_key": _KEY, "spans": [_span(seeded, 1, 3)]}]},
    )
    assert "CONFLICT:" in client.get(f"/api/download/{_KEY}.csv").text

    # The controller applies a fix -> the client posts no windows for it.
    client.post(
        "/api/conflict_marks", json={"marks": [{"flight_key": _KEY, "spans": []}]}
    )
    text = client.get(f"/api/download/{_KEY}.csv").text
    assert "CONFLICT:" not in text
    assert all(c[-1] == "" for c in _csv_rows(text))


def test_marks_for_an_unknown_flight_are_ignored(client) -> None:
    r = client.post(
        "/api/conflict_marks",
        json={"marks": [{"flight_key": "NOPE_20260101T0000Z", "spans": []}]},
    )
    assert r.status_code == 200
    assert r.json()["updated"] == 0
