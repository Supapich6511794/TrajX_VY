"""Tests for the real-CAT062 track loader + top-of-climb validation.

The real log (web/Data/cat062_20251223.csv) is large and git-ignored, so
these tests build a tiny synthetic CSV in the same format instead.
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

from trajectory_sim.cat62_track import (
    aggregate,
    load_real_tracks,
    load_track_points,
    pair_cruise_reference_ft,
    pair_time_reference_min,
)
from trajectory_sim.validation import validate_toc_altitude

# The export script lives under scripts/ (not a package) — make it importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from export_cat62_sample import _line_records, _point_records  # noqa: E402

_HEADER = "flight_key,acid,time_of_track,latitude,longitude,measured_fl,dep,dest,ias_dap"


def _rows(flight_key, acid, dep, dest, fls, *, start="2025-12-23 05:00:00", step_s=60):
    """One CSV row per FL sample, 60 s apart (measured_fl is a flight level)."""
    t0 = dt.datetime.strptime(start, "%Y-%m-%d %H:%M:%S")
    out = []
    for i, fl in enumerate(fls):
        t = (t0 + dt.timedelta(seconds=i * step_s)).strftime("%Y-%m-%d %H:%M:%S")
        out.append(f"{flight_key},{acid},{t},16.9,96.1,{fl},{dep},{dest},300")
    return out


# Climb through an intermediate ATC level-off at FL100, cruise FL350, descend.
_CLIMB_TO_350 = [0, 50, 100, 100, 100, 150, 250, 350, 350, 350, 350, 250, 100, 0]
_CLIMB_TO_370 = [0, 60, 100, 100, 180, 300, 370, 370, 370, 370, 370, 200, 0]


def _write(tmp_path, *flights):
    p = tmp_path / "cat62.csv"
    lines = [_HEADER]
    for f in flights:
        lines.extend(_rows(*f))
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


def test_cruise_alt_ignores_intermediate_levels(tmp_path) -> None:
    # The FL100 ATC level-off must not be mistaken for the cruise level.
    path = _write(tmp_path, ("A_VYYY_VYMD_1", "A", "VYYY", "VYMD", _CLIMB_TO_350))
    tracks = load_real_tracks(path, pairs=[("VYYY", "VYMD")])
    assert len(tracks) == 1
    t = tracks["A_VYYY_VYMD_1"]
    assert t.cruise_alt_ft == 35000.0  # FL350, not FL100
    # 14 samples, 60 s apart → 13 min span.
    assert t.airborne_min == 13.0
    assert t.adep == "VYYY" and t.ades == "VYMD"


def test_pairs_filter_and_direction_agnostic(tmp_path) -> None:
    path = _write(
        tmp_path,
        ("A_VYYY_VYMD_1", "A", "VYYY", "VYMD", _CLIMB_TO_350),
        ("B_VYMD_VYYY_1", "B", "VYMD", "VYYY", _CLIMB_TO_370),  # reverse dir
        ("C_VYYY_VYNT_1", "C", "VYYY", "VYNT", _CLIMB_TO_350),  # other pair
    )
    tracks = load_real_tracks(path, pairs=[("VYYY", "VYMD")])
    # Both directions of VYYY-VYMD kept; the VYNT flight excluded.
    assert set(tracks) == {"A_VYYY_VYMD_1", "B_VYMD_VYYY_1"}


def test_min_points_drops_truncated_tracks(tmp_path) -> None:
    path = _write(tmp_path, ("SHORT_VYYY_VYMD", "S", "VYYY", "VYMD", [0, 100, 200]))
    tracks = load_real_tracks(path, pairs=[("VYYY", "VYMD")], min_points=10)
    assert tracks == {}


def test_pair_reference_aggregations(tmp_path) -> None:
    # A: 13 min / FL350, B: 12 min / FL370.
    path = _write(
        tmp_path,
        ("A_VYYY_VYMD_1", "A", "VYYY", "VYMD", _CLIMB_TO_350),  # 14 pts → 13 min
        ("B_VYMD_VYYY_1", "B", "VYMD", "VYYY", _CLIMB_TO_370),  # 13 pts → 12 min
    )
    tracks = load_real_tracks(path, pairs=[("VYYY", "VYMD")])
    assert pair_time_reference_min(tracks, "VYYY", "VYMD", "min") == 12.0
    assert pair_time_reference_min(tracks, "VYYY", "VYMD", "median") == 12.5
    # Cruise median of FL350 and FL370 = FL360.
    assert pair_cruise_reference_ft(tracks, "VYYY", "VYMD", "median") == 36000.0
    # Unknown pair → None.
    assert pair_time_reference_min(tracks, "VYYY", "VYNT", "min") is None


def test_aggregate_methods() -> None:
    vals = [10.0, 20.0, 30.0, 40.0]
    assert aggregate(vals, "min") == 10.0
    assert aggregate(vals, "max") == 40.0
    assert aggregate(vals, "mean") == 25.0
    assert aggregate(vals, "median") == 25.0
    assert aggregate(vals, "p0") == 10.0
    assert aggregate(vals, "p100") == 40.0
    # p10 interpolates between the two lowest (10 and 20): 10 + 0.3*10 = 13.
    assert aggregate(vals, "p10") == 13.0


def test_load_track_points_utc_order_and_fields(tmp_path) -> None:
    path = _write(tmp_path, ("A_VYYY_VYMD_1", "AAA", "VYYY", "VYMD", _CLIMB_TO_350))
    flights = load_track_points(path, pairs=[("VYYY", "VYMD")])
    f = flights["A_VYYY_VYMD_1"]
    assert f.acid == "AAA" and f.adep == "VYYY" and f.ades == "VYMD"
    assert len(f.points) == len(_CLIMB_TO_350)
    # Points sorted ascending by (UTC) time.
    times = [p.epoch_utc for p in f.points]
    assert times == sorted(times)
    # time_of_track 05:00 Myanmar local → 22:30 UTC the previous day (−6:30).
    first = f.points[0].epoch_utc
    assert first.tzinfo is not None
    assert (first.day, first.hour, first.minute) == (22, 22, 30)
    # measured_fl is a flight level → feet ×100; ias_dap carried through.
    assert f.points[2].fl_ft == 10000.0  # FL100
    assert f.points[0].ias_kt == 300.0


def test_export_record_builders(tmp_path) -> None:
    path = _write(tmp_path, ("A_VYYY_VYMD_1", "AAA", "VYYY", "VYMD", _CLIMB_TO_350))
    flights = list(load_track_points(path, pairs=[("VYYY", "VYMD")]).values())

    pts = _point_records(flights)
    assert len(pts) == len(_CLIMB_TO_350)
    assert pts[0]["source"] == "cat62" and pts[0]["callsign"] == "AAA"
    assert pts[0]["geometry"].has_z  # POINT Z carries altitude (metres)
    assert pts[2]["altitude_ft"] == 10000.0

    lines = _line_records(flights)
    assert len(lines) == 1
    assert lines[0]["geometry"].geom_type == "LineString"
    assert lines[0]["n_points"] == len(_CLIMB_TO_350)
    assert lines[0]["cruise_ft"] == 35000.0


def test_validate_toc_within_and_beyond_threshold() -> None:
    # 35000 vs 36000 = 1000 ft < 2000 → PASS.
    v = validate_toc_altitude(35000.0, 36000.0, route="VYYY-VYMD")
    assert v.delta_ft == -1000.0 and v.passed
    # 35000 vs 38000 = 3000 ft ≥ 2000 → FAIL (e.g. RFL below what was flown).
    v2 = validate_toc_altitude(35000.0, 38000.0, route="VYYY-VYNT")
    assert v2.status == "FAIL" and not v2.passed
    # Exactly 2000 ft is a FAIL (acceptance is strictly < 2000).
    assert not validate_toc_altitude(35000.0, 37000.0).passed
