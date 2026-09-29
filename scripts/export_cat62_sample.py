"""Export the real CAT062 track for a city pair as a `cat62_sample` layer.

Produces a GeoPackage that overlays cleanly on the simulated trajectory in
QGIS (criterion 3 — "visually indistinguishable from real CAT62"). Two
layers, both EPSG:4326 to match the sim output (trajectory_sim.output):

  * ``cat62_sample``       — POINT Z per surveillance return (Z = altitude
                             in metres), with time / altitude / IAS fields.
  * ``cat62_sample_lines`` — one LineString per flight (the flown path),
                             with per-flight summary fields.

The real log (``web/Data/cat062_20251223.csv``) is large and git-ignored, so
only the requested pair is streamed (see trajectory_sim.cat62_track).

Examples::

    # every VYYY-VYMD flight
    python scripts/export_cat62_sample.py --adep VYYY --ades VYMD

    # just the 3 fastest (clean) flights, custom output path
    python scripts/export_cat62_sample.py --adep VYYY --ades VYMD \
        --limit 3 --out cat62_vyyy_vymd.gpkg
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from shapely.geometry import LineString, Point

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from trajectory_sim.cat62_track import (  # noqa: E402
    RawFlight,
    _cruise_alt_ft,
    load_track_points,
)

_DEFAULT_CAT62 = _ROOT / "web" / "Data" / "cat062_20251223.csv"
_M_PER_FT = 0.3048


def _point_records(flights: list[RawFlight]) -> list[dict]:
    """One POINT Z record per surveillance return, across all flights."""
    records: list[dict] = []
    for f in flights:
        for p in f.points:
            records.append(
                {
                    "flight_key": f.flight_key,
                    "callsign": f.acid,
                    "adep": f.adep,
                    "ades": f.ades,
                    # Naive UTC — QGIS reads it as a datetime; drop tz so the
                    # GPKG driver doesn't choke on an offset-aware value.
                    "epoch_ts": p.epoch_utc.replace(tzinfo=None),
                    "time_utc": p.epoch_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "altitude_ft": round(p.fl_ft, 1),
                    "ias_kt": None if p.ias_kt is None else round(p.ias_kt, 1),
                    "source": "cat62",
                    "geometry": Point(p.lon, p.lat, p.fl_ft * _M_PER_FT),
                }
            )
    return records


def _line_records(flights: list[RawFlight]) -> list[dict]:
    """One LineString record per flight (the flown ground path)."""
    records: list[dict] = []
    for f in flights:
        ts = [p.epoch_utc.timestamp() for p in f.points]
        records.append(
            {
                "flight_key": f.flight_key,
                "callsign": f.acid,
                "adep": f.adep,
                "ades": f.ades,
                "n_points": len(f.points),
                "airborne_min": round((max(ts) - min(ts)) / 60.0, 1),
                "cruise_ft": _cruise_alt_ft([p.fl_ft for p in f.points]),
                "source": "cat62",
                "geometry": LineString([(p.lon, p.lat) for p in f.points]),
            }
        )
    return records


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--adep", required=True, help="Departure ICAO, e.g. VYYY")
    ap.add_argument("--ades", required=True, help="Destination ICAO, e.g. VYMD")
    ap.add_argument(
        "--cat62",
        type=Path,
        default=_DEFAULT_CAT62,
        help="Raw CAT062 CSV (default: web/Data/cat062_20251223.csv)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output .gpkg (default: cat62_sample_<ADEP>-<ADES>.gpkg)",
    )
    ap.add_argument(
        "--flight-key",
        default=None,
        help="Keep only flights whose flight_key contains this substring",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Keep at most N flights (0 = all); the fastest are kept first",
    )
    ap.add_argument(
        "--min-points",
        type=int,
        default=10,
        help="Drop flights with fewer track points (default 10)",
    )
    ap.add_argument(
        "--points-only",
        action="store_true",
        help="Skip the per-flight LineString layer",
    )
    args = ap.parse_args(argv)

    if not args.cat62.exists():
        print(f"[error] CAT062 log not found: {args.cat62}", file=sys.stderr)
        return 2

    # geopandas is heavy; import only once we know we'll write.
    import geopandas as gpd

    flights_by_key = load_track_points(
        args.cat62, pairs=[(args.adep, args.ades)], min_points=args.min_points
    )
    flights = list(flights_by_key.values())
    if args.flight_key:
        needle = args.flight_key.upper()
        flights = [f for f in flights if needle in f.flight_key.upper()]
    if not flights:
        print(
            f"[error] no CAT062 flights for {args.adep.upper()}-{args.ades.upper()}"
            + (f" matching '{args.flight_key}'" if args.flight_key else ""),
            file=sys.stderr,
        )
        return 1
    # "Fastest first" so --limit keeps the cleanest (least-delayed) flights —
    # the fair visual reference for a delay-free simulated trajectory.
    flights.sort(key=lambda f: (f.points[-1].epoch_utc - f.points[0].epoch_utc))
    if args.limit and args.limit > 0:
        flights = flights[: args.limit]

    out_path = args.out or (
        _ROOT / f"cat62_sample_{args.adep.upper()}-{args.ades.upper()}.gpkg"
    )
    out_path = Path(out_path)

    pts = gpd.GeoDataFrame(
        _point_records(flights), crs="EPSG:4326", geometry="geometry"
    )
    pts.to_file(out_path, layer="cat62_sample", driver="GPKG")
    n_layers = 1
    if not args.points_only:
        lines = gpd.GeoDataFrame(
            _line_records(flights), crs="EPSG:4326", geometry="geometry"
        )
        lines.to_file(out_path, layer="cat62_sample_lines", driver="GPKG")
        n_layers = 2

    print(
        f"[ok] {len(flights)} flight(s), {len(pts)} points -> {out_path}\n"
        f"     layers: cat62_sample"
        + ("" if args.points_only else " + cat62_sample_lines")
    )
    print(
        "     Open in QGIS alongside the simulated trajectory GeoPackage "
        "(trajectory_sim.output.write_geopackage) to compare side-by-side."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
