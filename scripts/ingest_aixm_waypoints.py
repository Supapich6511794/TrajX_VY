"""Build a VY navdata cache (waypoints + airways + airports) in the SAME
shape as the retired Thai `aip_VT.json`, so the one hardcoded consumer of
that shape (`api/server.py`'s `_aip()`) works unchanged — only the data
underneath it moves from Thailand to Myanmar.

Why this exists: `api/server.py`'s FPL/route-string generation path
(`_expand_airways` -> `_airway_waypoint_index`) has NO coordinate source for
plain ENR 4 significant points (AKSAG, MDY, APAGO, ...). `NavData` (the other
navdata loader) only carries SID/STAR/approach-specific fixes for the 6
Myanmar aerodromes with published procedures — nothing for the ~135 enroute
fixes a filed/matched Item-15 route actually names. Without this, every
`/api/generate` call in "fpl" mode 500s with:

    RuntimeError: AIP navdata cache missing at .../aip_VT.json

Three pieces, three sources:

  * **waypoints** -- every `DesignatedPoint` / `Navaid` (VOR/NDB/DME/TACAN)
    feature's own `gml:pos`, read straight from the raw AIXM export. This is
    the actual fix (the missing piece above).
  * **airways** -- `route_segments.json` (already ingested by
    `ingest_aixm_route_segments.py`) stores one row per SEGMENT, not one
    ordered sequence per route, and a route can be several disjoint chains.
    This stitches each route designator's segments into ordered fix chains
    (repeatedly extending from an already-placed endpoint) so
    `_expand_airways`'s "<fix> <airway> <fix>, splice what's between them"
    logic has something to walk. Best-effort: a route whose segments don't
    resolve to simple chains keeps each chain separate rather than guessing
    a join between them.
  * **airports** -- `Airport_with_AP_Main_vy.csv` (already ingested by
    `ingest_aixm_airports.py`), reshaped from CSV rows to the
    `{ICAO: {lat, lon, elev_ft, name}}` map `_airports()`/`_airport_ll`
    expect.

    python scripts/ingest_aixm_waypoints.py

Output: web/public/data/aip_VY.json
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET

_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_INPUT = _ROOT / "aixm_export_2609_VY_v5.1.1.xml"
_SEGMENTS = _ROOT / "web" / "public" / "data" / "aixm_vy" / "route_segments.json"
_AIRPORTS_CSV = _ROOT / "web" / "public" / "data" / "airports" / "Airport_with_AP_Main_vy.csv"
_DEFAULT_OUT = _ROOT / "web" / "public" / "data" / "aip_VY.json"

#: Same point-feature set `ingest_aixm_route_segments.py` resolves segment
#: endpoints against — every fix `route_segments.json` names comes from one
#: of these, so this is the complete set worth extracting.
_POINT_FEATURES = ("DesignatedPoint", "Navaid", "VOR", "NDB", "DME", "TACAN")
_M_TO_FT = 3.28084


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
    """The feature's own position -- `<Point>`/`<ElevatedPoint>` both carry
    a plain `gml:pos` child, "lat lon" space-separated."""
    for child in elem.iter():
        if _local(child.tag) == "pos" and child.text:
            parts = child.text.split()
            if len(parts) == 2:
                try:
                    return float(parts[0]), float(parts[1])
                except ValueError:
                    return None
    return None


def extract_waypoints(path: Path) -> dict[str, dict[str, float]]:
    """ident -> {lat, lon}, first sighting wins (later timeslices/dupes of the
    same designator are the same point, not a reason to overwrite it)."""
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


def build_airways(segments: list[dict]) -> dict[str, list[str]]:
    """designator -> ordered ident chain(s), stitched from segment pairs.

    Segments for one route form an undirected graph; a real airway is
    (almost always) a simple path, so repeatedly extending a chain from
    whichever endpoint currently has an unused edge reconstructs it. A
    designator whose segments don't reduce to one simple path yields several
    chains concatenated -- `_expand_airways` only needs BOTH fixes of a
    filed span to be in the same list and in the right relative order,
    which holds within each real chain even if two unrelated chains
    happen to share a designator.
    """
    by_route: dict[str, list[tuple[str, str]]] = {}
    for s in segments:
        by_route.setdefault(s["route"], []).append((s["from"], s["to"]))

    airways: dict[str, list[str]] = {}
    for route, edges in by_route.items():
        remaining = list(edges)
        chains: list[list[str]] = []
        while remaining:
            a, b = remaining.pop(0)
            chain = [a, b]
            # Extend from either end while a connecting edge remains.
            extended = True
            while extended:
                extended = False
                for i, (x, y) in enumerate(remaining):
                    if x == chain[-1]:
                        chain.append(y)
                    elif y == chain[-1]:
                        chain.append(x)
                    elif x == chain[0]:
                        chain.insert(0, y)
                    elif y == chain[0]:
                        chain.insert(0, x)
                    else:
                        continue
                    remaining.pop(i)
                    extended = True
                    break
            chains.append(chain)
        # Longest chain first -- the most useful one for a typical filed span.
        chains.sort(key=len, reverse=True)
        merged: list[str] = []
        for c in chains:
            merged.extend(c)
        airways[route] = merged
    return airways


def build_airports(csv_path: Path) -> dict[str, dict[str, object]]:
    out: dict[str, dict[str, object]] = {}
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            icao = (row.get("airport_identifier") or "").strip().upper()
            if not icao:
                continue
            try:
                lat = float(row["airport_ref_latitude"])
                lon = float(row["airport_ref_longitude"])
            except (KeyError, ValueError):
                continue
            entry: dict[str, object] = {"lat": lat, "lon": lon}
            name = (row.get("airport_name") or "").strip()
            if name:
                entry["name"] = name
            elev = (row.get("elevation") or "").strip()
            if elev:
                try:
                    entry["elev_ft"] = float(elev)
                except ValueError:
                    pass
            out[icao] = entry
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    ap.add_argument("--segments", type=Path, default=_SEGMENTS)
    ap.add_argument("--airports-csv", type=Path, default=_AIRPORTS_CSV)
    ap.add_argument("--output", type=Path, default=_DEFAULT_OUT)
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"AIXM export not found: {args.input}")

    print(f"Reading {args.input.name} for point positions ...")
    waypoints = extract_waypoints(args.input)
    print(f"  {len(waypoints)} waypoints (DesignatedPoint/Navaid) with a position")

    seg_file = json.loads(args.segments.read_text(encoding="utf-8"))
    airways = build_airways(seg_file["segments"])
    named_fixes = {f for seq in airways.values() for f in seq}
    missing = named_fixes - waypoints.keys()
    print(f"  {len(airways)} airways stitched from {len(seg_file['segments'])} segments")
    if missing:
        print(f"  WARNING: {len(missing)} airway fixes have no position: {sorted(missing)[:10]}...")

    airports = build_airports(args.airports_csv)
    print(f"  {len(airports)} airports from {args.airports_csv.name}")

    out = {
        "airac": seg_file.get("validFrom", ""),
        "waypoint_count": len(waypoints),
        "airway_count": len(airways),
        "waypoints": waypoints,
        "airways": airways,
        "airports": airports,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
