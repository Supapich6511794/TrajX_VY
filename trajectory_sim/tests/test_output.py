"""Tests for output.py."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pytest

from trajectory_sim.output import (
    build_trajectory_gdf,
    write_csv,
    write_geopackage,
)

_WAYPOINTS = [
    (16.9073, 96.1332),   # near VYYY
    (19.3, 96.1),          # mid
    (21.7011, 95.9775),    # near VYMD
]
_EOBT = datetime(2026, 1, 3, 8, 15, tzinfo=timezone.utc)

_EXPECTED_COLS = {
    "flight_key", "callsign", "aircraft_type", "adep", "ades",
    "epoch_ts", "altitude_ft", "tas_kt", "gs_kt", "track_deg",
    "phase", "geometry",
}


def _build_default_gdf() -> gpd.GeoDataFrame:
    return build_trajectory_gdf(
        waypoint_sequence=_WAYPOINTS,
        eobt=_EOBT,
        callsign="UBA204",
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
    )


# --- build_trajectory_gdf --------------------------------------------------

def test_gdf_has_required_columns() -> None:
    gdf = _build_default_gdf()
    assert _EXPECTED_COLS.issubset(set(gdf.columns))


def test_gdf_has_rows() -> None:
    gdf = _build_default_gdf()
    assert len(gdf) > 0


def test_gdf_crs_is_4326() -> None:
    gdf = _build_default_gdf()
    assert gdf.crs is not None
    assert gdf.crs.to_epsg() == 4326


def test_gdf_flight_key_format() -> None:
    gdf = _build_default_gdf()
    assert gdf["flight_key"].iloc[0] == "UBA204_20260103T0815Z"
    assert (gdf["flight_key"] == "UBA204_20260103T0815Z").all()


def test_gdf_first_timestamp_equals_eobt() -> None:
    gdf = _build_default_gdf()
    first_ts = gdf["epoch_ts"].iloc[0]
    # pandas may convert to Timestamp; compare via to_pydatetime where possible
    if hasattr(first_ts, "to_pydatetime"):
        first_ts = first_ts.to_pydatetime()
    assert first_ts == _EOBT


def test_gdf_timestamps_are_monotonic() -> None:
    gdf = _build_default_gdf()
    assert gdf["epoch_ts"].is_monotonic_increasing


def test_gdf_phase_is_cruise_for_phase1() -> None:
    gdf = _build_default_gdf()
    assert (gdf["phase"] == "cruise").all()


def test_gdf_altitude_and_tas_are_none_for_phase1() -> None:
    gdf = _build_default_gdf()
    assert gdf["altitude_ft"].isna().all()
    assert gdf["tas_kt"].isna().all()


def test_gdf_gs_kt_constant() -> None:
    gdf = _build_default_gdf()
    assert (gdf["gs_kt"] == 450.0).all()


def test_gdf_rejects_naive_eobt() -> None:
    with pytest.raises(ValueError, match="UTC"):
        build_trajectory_gdf(
            waypoint_sequence=_WAYPOINTS,
            eobt=datetime(2026, 1, 3, 8, 15),
            callsign="UBA204",
            aircraft_type="B738",
            adep="VYYY",
            ades="VYMD",
        )


def test_gdf_rejects_single_waypoint() -> None:
    with pytest.raises(ValueError, match="at least 2"):
        build_trajectory_gdf(
            waypoint_sequence=[(16.9, 96.1)],
            eobt=_EOBT,
            callsign="UBA204",
            aircraft_type="B738",
            adep="VYYY",
            ades="VYMD",
        )


# --- write_geopackage ------------------------------------------------------

def test_write_geopackage_roundtrip(tmp_path: Path) -> None:
    gdf = _build_default_gdf()
    out = tmp_path / "test_output.gpkg"
    write_geopackage(gdf, out)
    assert out.exists()

    read_back = gpd.read_file(out, layer="trajectory")
    assert len(read_back) == len(gdf)
    assert read_back.crs.to_epsg() == 4326


def test_write_geopackage_full_y8_route_no_pk_conflict(tmp_path: Path) -> None:
    """Regression: a multi-leg route where any leg's duration falls
    just above a 4-s grid boundary used to produce two trajectory rows
    inside the same 1-ms GPKG-precision slot, breaking the new UNIQUE
    (flight_key, epoch_ts) index. Run the 11-fix airway sequence that
    exposed it end to end — it failed before the geodesy fix and must succeed
    now. The leg lengths are what reproduce the bug, so the coordinates are
    kept exactly as they were found (a real airway from an earlier data set);
    only the labels are placeholders."""
    y8 = [
        (13.89355556, 100.59619444),
        (13.18615, 100.38491389),
        (12.99959167, 100.19014722),
        (12.58640278, 99.76043056),
        (11.72832222, 99.76120833),
        (11.14186111, 99.76183333),
        (9.52955278, 99.25888889),
        (9.12951111, 99.13474722),
        (8.80486667, 98.86893333),
        (8.50444444, 98.62459167),
        (8.11397222, 98.307),
    ]
    gdf = build_trajectory_gdf(
        waypoint_sequence=y8,
        eobt=_EOBT,
        callsign="FLT1",
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        ground_speed_kt=450.0,
        rfl=330,
    )
    out = tmp_path / "y8_route.gpkg"
    # Must not raise sqlite3.IntegrityError on the UNIQUE index.
    write_geopackage(gdf, out)
    assert out.exists()


def test_write_geopackage_has_brief_indices(tmp_path: Path) -> None:
    """The brief's §6.2 schema mandates PRIMARY KEY (flight_key, epoch_ts)
    and a separate index on epoch_ts — write_geopackage adds both."""
    import sqlite3

    gdf = _build_default_gdf()
    out = tmp_path / "test_output.gpkg"
    write_geopackage(gdf, out)

    with sqlite3.connect(out) as conn:
        rows = conn.execute(
            "SELECT name, sql FROM sqlite_master "
            "WHERE type='index' AND tbl_name='trajectory'"
        ).fetchall()
    names = {r[0] for r in rows}
    assert "trajectory_pk_idx" in names
    assert "trajectory_ts_idx" in names
    # PK index must be UNIQUE and cover both columns.
    pk_sql = next(sql for name, sql in rows if name == "trajectory_pk_idx")
    assert "UNIQUE" in pk_sql.upper()
    assert "flight_key" in pk_sql and "epoch_ts" in pk_sql


def test_gdf_carries_terminal_procedures() -> None:
    gdf = build_trajectory_gdf(
        waypoint_sequence=_WAYPOINTS,
        eobt=_EOBT,
        callsign="UBA204",
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        sid="PARL1A",
        star="OKIK1A",
        dep_rwy="RW21",
        arr_rwy="RW17",
    )
    for col in ("dep_rwy", "arr_rwy", "sid", "star"):
        assert col in gdf.columns
    assert (gdf["sid"] == "PARL1A").all()
    assert (gdf["star"] == "OKIK1A").all()
    assert (gdf["dep_rwy"] == "RW21").all()
    assert (gdf["arr_rwy"] == "RW17").all()


def test_gdf_terminal_cols_blank_by_default() -> None:
    gdf = _build_default_gdf()
    for col in ("dep_rwy", "arr_rwy", "sid", "star"):
        assert (gdf[col] == "").all()


# --- write_csv -------------------------------------------------------------

_DATA_COLS = [
    "timestamp", "utc", "callsign", "lat", "lon", "alt", "speed", "dir",
    "phase", "sector", "event", "waypoint", "conflict",
]


def _read_csv_data(path: Path) -> pd.DataFrame:
    """Read the data section of the ATC-format CSV (skips the metadata
    header block; the 13 column names line up 1-to-1 with the 13 fields
    of each data row)."""
    with path.open() as f:
        lines = f.readlines()
    header_idx = next(
        i for i, line in enumerate(lines) if line.startswith("Timestamp,")
    )
    return pd.read_csv(
        path, skiprows=header_idx + 1, header=None, names=_DATA_COLS
    )


def test_write_csv_has_metadata_header(tmp_path: Path) -> None:
    gdf = _build_default_gdf()
    out = tmp_path / "test_output.csv"
    write_csv(gdf, out, route_str="BGO W13 MIA", rfl=330)
    assert out.exists()

    text = out.read_text()
    assert "ROUTE: BGO W13 MIA" in text
    assert "DEP: VYYY" in text
    assert "DEST: VYMD" in text
    assert "ACTYPE: B738" in text
    assert "FL: F330" in text
    assert "ATD: 2026-01-03 08:15:00" in text
    # Terminal-procedure header lines are always present (blank here).
    assert "DEP RWY:" in text
    assert "ARR RWY:" in text
    assert "SID:" in text
    assert "STAR:" in text
    assert (
        "Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction,"
        "Phase,Sector,Event" in text
    )


def test_write_csv_terminal_header_values(tmp_path: Path) -> None:
    gdf = build_trajectory_gdf(
        waypoint_sequence=_WAYPOINTS,
        eobt=_EOBT,
        callsign="UBA204",
        aircraft_type="B738",
        adep="VYYY",
        ades="VYMD",
        sid="PARL1A",
        star="OKIK1A",
        dep_rwy="RW21",
        arr_rwy="RW17",
    )
    out = tmp_path / "term.csv"
    write_csv(gdf, out, route_str="BGO W13 MIA", rfl=330)
    text = out.read_text()
    assert "DEP RWY: RW21" in text
    assert "ARR RWY: RW17" in text
    assert "SID: PARL1A" in text
    assert "STAR: OKIK1A" in text


def test_write_csv_data_rows_match_gdf(tmp_path: Path) -> None:
    gdf = _build_default_gdf()
    out = tmp_path / "test_output.csv"
    write_csv(gdf, out, route_str="BGO W13 MIA", rfl=330)

    df = _read_csv_data(out)
    assert len(df) == len(gdf)
    assert df["lat"].iloc[0] == pytest.approx(gdf.geometry.y.iloc[0], abs=1e-5)
    assert df["lon"].iloc[0] == pytest.approx(gdf.geometry.x.iloc[0], abs=1e-5)
    assert (df["callsign"] == "UBA204").all()
    # Timestamp is integer epoch seconds; UTC ends with the Z suffix.
    assert df["timestamp"].dtype.kind == "i"
    assert str(df["utc"].iloc[0]).endswith("Z")
    # Phase rides along per row; sector/event columns are blank when the
    # gdf was built without the enrichment (read defensively).
    assert list(df["phase"]) == list(gdf["phase"])
    assert df["sector"].isna().all()
    assert df["event"].isna().all()


def test_write_csv_sector_and_event_columns(tmp_path: Path) -> None:
    """Sector/Event columns round-trip, incl. CSV-quoting of a comma-joined
    Sector value (overlapping PDR areas)."""
    gdf = _build_default_gdf()
    gdf["sector"] = ["R13,R47"] * len(gdf)
    events = [""] * len(gdf)
    events[1] = "TOC"
    events[-1] = "TOD"
    gdf["event"] = events
    out = tmp_path / "sector.csv"
    write_csv(gdf, out, route_str="BGO W13 MIA", rfl=330)

    df = _read_csv_data(out)
    assert len(df) == len(gdf)  # quoting keeps the comma inside one field
    assert (df["sector"] == "R13,R47").all()
    assert df["event"].iloc[1] == "TOC"
    assert df["event"].iloc[len(df) - 1] == "TOD"


def test_write_csv_conflict_marks_unresolved_los(tmp_path: Path) -> None:
    """An unresolved loss of separation is reported twice: as a CONFLICT header
    line naming the other aircraft and the window, and per-sample in the
    Conflict column so the exact timestamps are readable off the table."""
    gdf = _build_default_gdf()
    ts = list(gdf["epoch_ts"])
    # Mark the 2nd..4th samples as the breach window.
    start, end = ts[1], ts[3]
    span = {
        "with_callsign": "TGW122",
        "start_ts": start.isoformat().replace("+00:00", "Z"),
        "end_ts": end.isoformat().replace("+00:00", "Z"),
        "min_sep_nm": 2.1,
        "min_vert_ft": 300,
        "sep_min_nm": 5,
        "sep_min_ft": 1000,
    }
    gdf["conflict"] = [
        "LOS TGW122" if start <= t <= end else "" for t in ts
    ]
    out = tmp_path / "conflict.csv"
    write_csv(gdf, out, route_str="BGO W13 MIA", rfl=330, conflicts=[span])

    text = out.read_text()
    assert "CONFLICT: LOSS OF SEPARATION vs TGW122" in text
    assert span["start_ts"] in text and span["end_ts"] in text
    assert "min 2.1 NM / 300 ft" in text
    assert "UNRESOLVED" in text

    df = _read_csv_data(out)
    assert len(df) == len(gdf)
    flagged = df[df["conflict"] == "LOS TGW122"]
    assert list(flagged.index) == [1, 2, 3]
    assert df["conflict"].isna().iloc[0]  # blank outside the window


def test_write_csv_no_conflict_lines_when_none(tmp_path: Path) -> None:
    """A flight with no outstanding conflict keeps the column (blank) and gets
    no CONFLICT header — the file must not imply one."""
    gdf = _build_default_gdf()
    out = tmp_path / "clean.csv"
    write_csv(gdf, out, route_str="BGO W13 MIA", rfl=330, conflicts=[])
    text = out.read_text()
    assert "CONFLICT:" not in text
    assert "Event,Waypoint,Conflict" in text
    assert _read_csv_data(out)["conflict"].isna().all()


def test_write_csv_fl_line_omitted_when_rfl_none(tmp_path: Path) -> None:
    gdf = _build_default_gdf()
    out = tmp_path / "test_output.csv"
    write_csv(gdf, out, route_str="DCT DCT")
    text = out.read_text()
    assert "FL:" not in text
    assert "ROUTE: DCT DCT" in text
