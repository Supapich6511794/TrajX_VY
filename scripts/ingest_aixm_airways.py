"""Build the "Airway" map layer's Myanmar data — the ATS route network as
drawn LineString segments, and the VOR/DME stations along it — for the
Layer Options "Airway" tab (`aixm_vy/airway_segments_vy.geojson` /
`aixm_vy/airway_vor_vy.geojson`).

Two outputs, two sources:

  * **airway_segments_vy.geojson** — one LineString feature per ROUTE SEGMENT
    (not per stitched airway — the map draws individual legs; it doesn't need
    the file-resolution chains `ingest_aixm_waypoints.py` builds for "<fix>
    <airway> <fix>" FPL splicing). Built from `route_segments.json` (already
    ingested by `ingest_aixm_route_segments_vy.py`) plus this file's own
    extracted point positions — the same two inputs `ingest_aixm_waypoints.py`
    already reads, just reshaped for drawing: each feature carries BOTH
    endpoints' own coordinates, matching the map layer's schema
    (`web/lib/types.ts`'s `AirwaySegmentProperties`).
  * **airway_vor_vy.geojson** — every `aixm:VOR` feature's own position, name
    and frequency, in the same shape the map's VOR layer already reads
    (`waypoint_identifier` on a Point feature).

There is no VY equivalent of a "reporting point" designation in this AIXM
export (it is an ENR-chart convention with no structured AIXM field) — this
deliberately does not invent one; `fetchAirwayReporting()` stays empty.

    python scripts/ingest_aixm_airways.py

Output (under web/public/data/aixm_vy/):
    airway_segments_vy.geojson
    airway_vor_vy.geojson
"""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET

_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_INPUT = _ROOT / "aixm_export_2609_VY_v5.1.1.xml"
_SEGMENTS = _ROOT / "web" / "public" / "data" / "aixm_vy" / "route_segments.json"
_OUT_DIR = _ROOT / "web" / "public" / "data" / "aixm_vy"

#: Same point-feature set `ingest_aixm_waypoints.py` extracts — every fix
#: `route_segments.json` names comes from one of these.
_POINT_FEATURES = ("DesignatedPoint", "Navaid", "VOR", "NDB", "DME", "TACAN")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def iter_features(path: Path) -> Iterator[ET.Element]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as fh:
        for _event, elem in ET.iterparse(fh, events=("end",)):
            if _local(elem.tag) != "hasMember":
                continue
            for feature in elem:
                yield feature
            elem.clear()


def _text(elem: ET.Element | None, name: str) -> str:
    if elem is None:
        return ""
    for child in elem.iter():
        if _local(child.tag) == name and child.text:
            return child.text.strip()
    return ""


def _pos(elem: ET.Element) -> tuple[float, float] | None:
    """The feature's own position — `<Point>`/`<ElevatedPoint>` both carry a
    plain `gml:pos` child, "lat lon" space-separated."""
    for child in elem.iter():
        if _local(child.tag) == "pos" and child.text:
            parts = child.text.split()
            if len(parts) == 2:
                try:
                    return float(parts[0]), float(parts[1])
                except ValueError:
                    return None
    return None


def extract_points(path: Path) -> dict[str, dict[str, float]]:
    """ident -> {lat, lon} for every navigable point — the same extraction
    `ingest_aixm_waypoints.py` does, kept separate here so this script has no
    import-time dependency on that one (each ingest script in this project is
    self-contained)."""
    out: dict[str, dict[str, float]] = {}
    for feature in iter_features(path):
        if _local(feature.tag) not in _POINT_FEATURES:
            continue
        ident = _text(feature, "designator") or _text(feature, "name")
        if not ident or ident in out:
            continue
        pos = _pos(feature)
        if pos is None:
            continue
        out[ident] = {"lat": pos[0], "lon": pos[1]}
    return out


def extract_vor(path: Path) -> list[dict[str, object]]:
    """Every `aixm:VOR` station's own designator, name, position and
    frequency — not folded into the generic point set above, since the VOR
    layer wants to draw only these, not every DesignatedPoint too."""
    out: list[dict[str, object]] = []
    for feature in iter_features(path):
        if _local(feature.tag) != "VOR":
            continue
        ident = _text(feature, "designator")
        pos = _pos(feature)
        if not ident or pos is None:
            continue
        entry: dict[str, object] = {
            "ident": ident,
            "name": _text(feature, "name"),
            "lat": pos[0],
            "lon": pos[1],
        }
        freq = _text(feature, "frequency")
        if freq:
            try:
                entry["frequency_mhz"] = float(freq)
            except ValueError:
                pass
        out.append(entry)
    return out


def build_segment_features(
    segments: list[dict], points: dict[str, dict[str, float]]
) -> tuple[list[dict], int]:
    """One LineString feature per segment, matching `AirwaySegmentProperties`
    (`web/lib/types.ts`) — both endpoints' idents AND coordinates embedded.
    A segment whose endpoint has no known position is
    dropped rather than drawn with a guessed coordinate."""
    features: list[dict] = []
    seqno_by_route: dict[str, int] = {}
    missing = 0
    for i, seg in enumerate(segments):
        a = points.get(seg["from"])
        b = points.get(seg["to"])
        if a is None or b is None:
            missing += 1
            continue
        route = seg["route"]
        seqno_by_route[route] = seqno_by_route.get(route, 0) + 1
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "fid": i,
                    "route_identifier": route,
                    "seqno": seqno_by_route[route],
                    "icao_code": "VY",
                    "waypoint_identifier": seg["from"],
                    "waypoint_latitude": a["lat"],
                    "waypoint_longitude": a["lon"],
                    "waypoint_identifier_2": seg["to"],
                    "waypoint_latitude_2": b["lat"],
                    "waypoint_longitude_2": b["lon"],
                    "minimum_altitude1": seg.get("lowerFt"),
                    "maximum_altitude": seg.get("upperFt"),
                    "inbound_distance": seg.get("lengthNm"),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [a["lon"], a["lat"]],
                        [b["lon"], b["lat"]],
                    ],
                },
            }
        )
    return features, missing


def build_vor_features(stations: list[dict[str, object]]) -> list[dict]:
    return [
        {
            "type": "Feature",
            "properties": {
                "fid": i,
                "waypoint_identifier": s["ident"],
                "name": s.get("name"),
                "frequency_mhz": s.get("frequency_mhz"),
            },
            "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
        }
        for i, s in enumerate(stations)
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    ap.add_argument("--segments", type=Path, default=_SEGMENTS)
    ap.add_argument("--out-dir", type=Path, default=_OUT_DIR)
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"AIXM export not found: {args.input}")
    if not args.segments.exists():
        raise SystemExit(f"Route segments not found: {args.segments}")

    print(f"Reading {args.input.name} ...")
    points = extract_points(args.input)
    print(f"  {len(points)} point positions (DesignatedPoint/Navaid/VOR/...)")

    seg_file = json.loads(args.segments.read_text(encoding="utf-8"))
    segment_features, missing = build_segment_features(seg_file["segments"], points)
    print(
        f"  {len(segment_features)}/{len(seg_file['segments'])} segments drawn"
        + (f" ({missing} skipped — endpoint has no position)" if missing else "")
    )

    vor_stations = extract_vor(args.input)
    print(f"  {len(vor_stations)} VOR stations")

    args.out_dir.mkdir(parents=True, exist_ok=True)

    segments_out = args.out_dir / "airway_segments_vy.geojson"
    segments_out.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": segment_features},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {segments_out}")

    vor_out = args.out_dir / "airway_vor_vy.geojson"
    vor_out.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": build_vor_features(vor_stations)},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {vor_out}")


if __name__ == "__main__":
    main()
