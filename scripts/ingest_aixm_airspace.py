"""Extract Airspace polygon geometry from an AIXM 5.1.1 export.

``extract_aixm_restricted_areas.py`` reads the same P/R/D/TRA areas but only
as a flat attribute table -- it never touches the polygon itself. This walks
each Airspace's AirspaceVolume(s) for their actual horizontal projection, so
the areas can be drawn on the map instead of just listed.

    python scripts/ingest_aixm_airspace.py --input <xml> --out <dir>

Outputs:
    restricted_areas.geojson    -- P / R / D / TRA polygons (one feature per
                                    AirspaceVolume, so an area published as
                                    several stacked altitude bands keeps each
                                    band's own limits rather than losing all
                                    but the first)
    airspace_boundaries.geojson -- FIR / CTA / TMA / CTR polygons, same shape

Both carry the same properties as the CSV row (``designator``/``name``/
``type``/``lower``/``upper``) plus the note fields, so front-end formatting
can be shared with the attribute-only table.
"""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
from typing import Any, Iterator
from xml.etree import ElementTree as ET

_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_INPUT = _ROOT / "aixm_export_2608_VT_v5.1.1.xml"
_DEFAULT_OUT = _ROOT / "web" / "public" / "data" / "aixm"

#: Airspace types that carry a flight restriction (mirrors
#: extract_aixm_restricted_areas.py's ``_TYPES``).
_RESTRICTED_TYPES = ("P", "R", "D", "TRA")
#: Published airspace-classification boundaries.
_BOUNDARY_TYPES = ("FIR", "CTA", "TMA", "CTR")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def iter_features(path: Path) -> Iterator[ET.Element]:
    """Stream the AIXM features, clearing each once it has been handed over."""
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as fh:
        for _event, elem in ET.iterparse(fh, events=("end",)):
            if _local(elem.tag) != "hasMember":
                continue
            for feature in elem:
                yield feature
            elem.clear()


def _child(elem: ET.Element, name: str) -> ET.Element | None:
    for c in elem:
        if _local(c.tag) == name:
            return c
    return None


def _text(elem: ET.Element | None, name: str) -> str:
    if elem is None:
        return ""
    for child in elem.iter():
        if _local(child.tag) == name and child.text:
            return child.text.strip()
    return ""


def _note(airspace_ts: ET.Element, prefix: str) -> str:
    """Pull the ``<prefix>: ...`` LinguisticNote the export packs notes into."""
    for elem in airspace_ts.iter():
        if _local(elem.tag) != "note" or not elem.text:
            continue
        text = elem.text.strip()
        if text.startswith(f"{prefix}: "):
            return text[len(prefix) + 2 :]
    return ""


def _limit(volume: ET.Element, bound: str) -> str:
    value = _text(volume, f"{bound}Limit")
    reference = _text(volume, f"{bound}LimitReference")
    return " ".join(part for part in (value, reference) if part)


def _ring(pos_list: ET.Element) -> list[list[float]] | None:
    """AIXM ``gml:posList`` is a flat ``lat lon lat lon ...`` run -- GeoJSON
    wants ``[lon, lat]`` pairs, the same swap ``ingest_aixm_procedures.py``
    does for a single ``gml:pos``."""
    if pos_list.text is None:
        return None
    nums = [float(v) for v in pos_list.text.split()]
    if len(nums) < 6:
        return None
    return [[nums[i + 1], nums[i]] for i in range(0, len(nums), 2)]


def _polygon_patches(surface: ET.Element) -> list[list[list[list[float]]]]:
    """Every PolygonPatch under a Surface -> MultiPolygon-shaped ring lists
    (exterior ring first, then any interior/hole rings)."""
    polygons: list[list[list[list[float]]]] = []
    patches = _child(surface, "patches")
    if patches is None:
        return polygons
    for patch in patches:
        if _local(patch.tag) != "PolygonPatch":
            continue
        rings: list[list[list[float]]] = []
        for part in patch:
            name = _local(part.tag)
            if name not in ("exterior", "interior"):
                continue
            ring_elem = _child(part, "LinearRing")
            pos_list = _child(ring_elem, "posList") if ring_elem is not None else None
            ring = _ring(pos_list) if pos_list is not None else None
            if ring is None:
                continue
            if name == "exterior":
                rings.insert(0, ring)
            else:
                rings.append(ring)
        if rings:
            polygons.append(rings)
    return polygons


def extract(path: Path, types: tuple[str, ...]) -> list[dict[str, Any]]:
    """One GeoJSON Feature per AirspaceVolume whose Airspace type matches."""
    features: list[dict[str, Any]] = []
    for feature in iter_features(path):
        if _local(feature.tag) != "Airspace":
            continue
        ts = next(
            (e for e in feature.iter() if _local(e.tag) == "AirspaceTimeSlice"),
            None,
        )
        if ts is None:
            continue
        kind = _text(ts, "type")
        if kind not in types:
            continue
        designator = _text(ts, "designator")
        name = _text(ts, "name")
        for gc in ts.iter():
            if _local(gc.tag) != "AirspaceGeometryComponent":
                continue
            volume = next(
                (e for e in gc.iter() if _local(e.tag) == "AirspaceVolume"), None
            )
            if volume is None:
                continue
            surface = next(
                (e for e in volume.iter() if _local(e.tag) == "Surface"), None
            )
            if surface is None:
                continue
            polygons = _polygon_patches(surface)
            if not polygons:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "type": kind,
                        "designator": designator,
                        "name": name,
                        "lower": _limit(volume, "lower"),
                        "upper": _limit(volume, "upper"),
                        "activity_note": _note(ts, "activity"),
                        "restriction": _note(ts, "restriction"),
                        "hazard": _note(ts, "hazard"),
                        "remarks": _note(ts, "remarks"),
                    },
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": polygons,
                    },
                }
            )
    return features


def _write(path: Path, name: str, features: list[dict[str, Any]]) -> None:
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": name,
                "crs": {
                    "type": "name",
                    "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"},
                },
                "features": features,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"  {path.name}: {len(features)} features")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    parser.add_argument("--out", type=Path, default=_DEFAULT_OUT)
    args = parser.parse_args()

    print(f"Reading {args.input.name} ...")
    restricted = extract(args.input, _RESTRICTED_TYPES)
    boundaries = extract(args.input, _BOUNDARY_TYPES)

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"Writing to {args.out} ...")
    _write(args.out / "restricted_areas.geojson", "restricted_areas", restricted)
    _write(args.out / "airspace_boundaries.geojson", "airspace_boundaries", boundaries)


if __name__ == "__main__":
    main()
