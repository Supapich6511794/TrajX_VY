"""Derive an airport + runway-threshold table from an AIXM 5.1.1 export.

The output keeps the column layout of an ARINC 424 "DFD" airport/runway
table, but fields that only a DFD source carries (``ifr_capability``,
transition altitude/level, speed limits, runway surface) are absent from
this AIXM export and stay blank. There is no DFD source for VY, so the table
is built purely from what AIXM DOES carry:

    AirportHeliport               -- ICAO identifier, name, ARP position/elev
    Runway                        -- nominal length/width, parent airport
    RunwayDirection                -- per-threshold designator + true/mag bearing
    RunwayCentrelinePoint (THR)    -- per-threshold position + elevation

The ARINC-424-only columns are left blank rather than guessed. The CSV
schema otherwise matches ``Airport_with_AP_Main.csv`` / ``runway.csv``
exactly, so ``web/lib/atcLayers.ts`` reads either file unchanged.

    python scripts/ingest_aixm_airports.py

Outputs (under web/public/data/airports/):
    Airport_with_AP_Main_vy.csv
    runway_vy.csv
"""

from __future__ import annotations

import argparse
import csv
import gzip
from pathlib import Path
from typing import Any, Iterator
from xml.etree import ElementTree as ET

_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_INPUT = _ROOT / "aixm_export_2609_VY_v5.1.1.xml"
_DEFAULT_OUT = _ROOT / "web" / "public" / "data" / "airports"

_XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
_GML_POS = "{http://www.opengis.net/gml/3.2}pos"
_GML_IDENTIFIER = "{http://www.opengis.net/gml/3.2}identifier"

_M_TO_FT = 3.28084

_AIRPORT_FIELDS = [
    "fid", "area_code", "icao_code", "airport_identifier",
    "airport_identifier_3letter", "airport_name", "airport_ref_latitude",
    "airport_ref_longitude", "ifr_capability", "longest_runway_surface_code",
    "elevation", "transition_altitude", "transition_level", "speed_limit",
    "speed_limit_altitude", "iata_ata_designator", "id", "AP", "Main",
]
_RUNWAY_FIELDS = [
    "fid", "area_code", "icao_code", "airport_identifier",
    "runway_identifier", "runway_latitude", "runway_longitude",
    "runway_gradient", "runway_magnetic_bearing", "runway_true_bearing",
    "landing_threshold_elevation", "displaced_threshold_distance",
    "threshold_crossing_height", "runway_length", "runway_width",
    "llz_identifier", "llz_mls_gls_category", "surface_code", "id",
]


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


def _identifier(feature: ET.Element) -> str | None:
    node = feature.find(_GML_IDENTIFIER)
    return node.text.strip() if node is not None and node.text else None


def _timeslice(feature: ET.Element) -> ET.Element | None:
    """The feature's BASELINE time slice (this export has exactly one)."""
    for ts in feature.iter():
        if _local(ts.tag).endswith("TimeSlice"):
            return ts
    return None


def _ref(parent: ET.Element, name: str) -> str | None:
    """Bare UUID an ``xlink:href="urn:uuid:..."`` child points at."""
    child = _child(parent, name)
    href = child.get(_XLINK_HREF) if child is not None else None
    return href.rsplit(":", 1)[-1] if href else None


def _elevated_point(
    container: ET.Element | None,
) -> tuple[float, float, float | None] | None:
    """(lat, lon, elevation_ft|None) from an ElevatedPoint's gml:pos +
    aixm:elevation, searched under `container` (e.g. an ARP or location)."""
    if container is None:
        return None
    pos_text = None
    elev_text = None
    for node in container.iter():
        if node.tag == _GML_POS and node.text:
            pos_text = node.text
        elif _local(node.tag) == "elevation" and node.text:
            elev_text = node.text
    if not pos_text:
        return None
    parts = pos_text.split()
    if len(parts) < 2:
        return None
    return float(parts[0]), float(parts[1]), (float(elev_text) if elev_text else None)


class Index:
    """Airports, runways, directions and thresholds, keyed by AIXM UUID so
    the four feature types (which arrive in no particular order) can be
    joined once the whole export has been read."""

    def __init__(self) -> None:
        self.airports: dict[str, dict[str, Any]] = {}
        self.runways: dict[str, dict[str, Any]] = {}
        self.directions: list[dict[str, Any]] = []
        # RunwayDirection uuid -> (lat, lon, elev_ft). Despite the name,
        # RunwayCentrelinePoint's `onRunway` xlink actually targets the
        # RunwayDirection (one threshold per direction), not the shared
        # Runway feature both directions point at via `usedRunway`.
        self.thresholds: dict[str, tuple[float, float, float | None]] = {}

    def load(self, path: Path) -> None:
        for feature in iter_features(path):
            kind = _local(feature.tag)
            uuid = _identifier(feature)
            ts = _timeslice(feature)
            if uuid is None or ts is None:
                continue

            if kind == "AirportHeliport":
                code = _text(ts, "locationIndicatorICAO") or _text(ts, "designator")
                pt = _elevated_point(_child(ts, "ARP"))
                if code and pt:
                    lat, lon, elev_ft = pt
                    self.airports[uuid] = {
                        "code": code.upper(),
                        "name": _text(ts, "name"),
                        "lat": lat,
                        "lon": lon,
                        "elev_ft": elev_ft,
                    }
            elif kind == "Runway":
                length = _text(ts, "nominalLength")
                width = _text(ts, "nominalWidth")
                self.runways[uuid] = {
                    "airport_uuid": _ref(ts, "associatedAirportHeliport"),
                    "length_m": float(length) if length else None,
                    "width_m": float(width) if width else None,
                }
            elif kind == "RunwayDirection":
                designator = _text(ts, "designator")
                runway_uuid = _ref(ts, "usedRunway")
                if designator and runway_uuid:
                    true_brg = _text(ts, "trueBearing")
                    mag_brg = _text(ts, "magneticBearing")
                    self.directions.append(
                        {
                            "uuid": uuid,
                            "designator": designator,
                            "runway_uuid": runway_uuid,
                            "true_brg": float(true_brg) if true_brg else None,
                            "mag_brg": float(mag_brg) if mag_brg else None,
                        }
                    )
            elif kind == "RunwayCentrelinePoint":
                if _text(ts, "role") != "THR":
                    continue
                direction_uuid = _ref(ts, "onRunway")
                pt = _elevated_point(_child(ts, "location"))
                if direction_uuid and pt:
                    self.thresholds[direction_uuid] = pt


#: An aerodrome counts as "Main" when its AIP name is flagged INTL
#: (YANGON INTL, MANDALAY INTL, NAYPYITAW INTL).
def _is_main(name: str) -> bool:
    return "INTL" in name.upper()


def build_airport_rows(idx: Index) -> list[dict[str, Any]]:
    rows = []
    for i, airport in enumerate(
        sorted(idx.airports.values(), key=lambda a: a["code"]), start=1
    ):
        rows.append(
            {
                "fid": i,
                "area_code": "PAC",
                "icao_code": "VY",
                "airport_identifier": airport["code"],
                "airport_identifier_3letter": "",
                "airport_name": airport["name"],
                "airport_ref_latitude": f"{airport['lat']:.8f}",
                "airport_ref_longitude": f"{airport['lon']:.8f}",
                "ifr_capability": "",
                "longest_runway_surface_code": "",
                "elevation": (
                    round(airport["elev_ft"]) if airport["elev_ft"] is not None else ""
                ),
                "transition_altitude": "",
                "transition_level": "",
                "speed_limit": "",
                "speed_limit_altitude": "",
                "iata_ata_designator": "",
                "id": f"VY{airport['code']}",
                "AP": airport["name"],
                "Main": "Y" if _is_main(airport["name"]) else "N",
            }
        )
    return rows


def build_runway_rows(idx: Index) -> list[dict[str, Any]]:
    rows = []
    fid = 0
    for d in sorted(idx.directions, key=lambda d: (d["runway_uuid"], d["designator"])):
        runway = idx.runways.get(d["runway_uuid"])
        airport = idx.airports.get(runway["airport_uuid"]) if runway else None
        thr = idx.thresholds.get(d["uuid"])
        if runway is None or airport is None or thr is None:
            continue
        lat, lon, elev_ft = thr
        fid += 1
        rows.append(
            {
                "fid": fid,
                "area_code": "PAC",
                "icao_code": "VY",
                "airport_identifier": airport["code"],
                "runway_identifier": f"RW{d['designator']}",
                "runway_latitude": f"{lat:.8f}",
                "runway_longitude": f"{lon:.8f}",
                "runway_gradient": "",
                "runway_magnetic_bearing": (
                    round(d["mag_brg"]) if d["mag_brg"] is not None else ""
                ),
                "runway_true_bearing": (
                    round(d["true_brg"]) if d["true_brg"] is not None else ""
                ),
                "landing_threshold_elevation": (
                    round(elev_ft) if elev_ft is not None else ""
                ),
                "displaced_threshold_distance": "",
                "threshold_crossing_height": "",
                "runway_length": (
                    round(runway["length_m"] * _M_TO_FT)
                    if runway["length_m"]
                    else ""
                ),
                "runway_width": (
                    round(runway["width_m"] * _M_TO_FT) if runway["width_m"] else ""
                ),
                "llz_identifier": "",
                "llz_mls_gls_category": "",
                "surface_code": "",
                "id": "",
            }
        )
    return rows


def _write_csv(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  {path.name}: {len(rows)} rows")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    parser.add_argument("--out", type=Path, default=_DEFAULT_OUT)
    args = parser.parse_args()

    print(f"Reading {args.input.name} ...")
    idx = Index()
    idx.load(args.input)

    airport_rows = build_airport_rows(idx)
    runway_rows = build_runway_rows(idx)

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"Writing to {args.out} ...")
    _write_csv(args.out / "Airport_with_AP_Main_vy.csv", _AIRPORT_FIELDS, airport_rows)
    _write_csv(args.out / "runway_vy.csv", _RUNWAY_FIELDS, runway_rows)


if __name__ == "__main__":
    main()
