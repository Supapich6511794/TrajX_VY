"""Extract the ATS route segments, their direction of travel and level band.

An airway is not automatically two-way. The AIP's ENR 3 prints, per route,
a "Route availability" line and a direction note — a *uni-directional* route
may be flown one way only, or the reverse leg may be reserved for flights
between particular aerodromes. Filing a route the wrong way up such an
airway is a real planning error that a fix-list check cannot see, because every
fix on it is perfectly valid.

AIXM states this on each ``RouteSegment``:

    <aixm:availability>
      <aixm:RouteAvailability><aixm:direction>FORWARD</aixm:direction></...>

where the direction is relative to the segment's own ``start`` -> ``end``:

    BOTH      either way
    FORWARD   start -> end only
    BACKWARD  end -> start only

One-way segments are a sizeable share of the en-route network, not an edge
case (the script prints the count for the export it reads).

    python scripts/ingest_aixm_route_segments.py

Output (under ``web/public/data/aixm_vy/``):
    route_segments.json  -- one entry per segment: route designator, the two
                            fixes, the permitted direction, and the level band
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
_DEFAULT_OUT = _ROOT / "web" / "public" / "data" / "aixm_vy" / "route_segments.json"

_XLINK_HREF = "{http://www.w3.org/1999/xlink}href"

#: Features that can be the end of a route segment.
_POINT_FEATURES = ("DesignatedPoint", "Navaid", "VOR", "NDB", "DME", "TACAN")


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


def _text(elem: ET.Element | None, name: str) -> str:
    if elem is None:
        return ""
    for child in elem.iter():
        if _local(child.tag) == name and child.text:
            return child.text.strip()
    return ""


def _uuid(elem: ET.Element) -> str:
    """The feature's own uuid, from its gml:identifier."""
    for child in elem.iter():
        if _local(child.tag) == "identifier" and child.text:
            return child.text.strip().rsplit(":", 1)[-1]
    return ""


def _ref(elem: ET.Element | None, name: str) -> str:
    """'urn:uuid:abc' on the named child -> 'abc'."""
    if elem is None:
        return ""
    for child in elem.iter():
        if _local(child.tag) != name:
            continue
        href = child.get(_XLINK_HREF)
        if href:
            return href.rsplit(":", 1)[-1]
    return ""


def _child(elem: ET.Element, name: str) -> ET.Element | None:
    for child in elem.iter():
        if _local(child.tag) == name:
            return child
    return None


def _limit_ft(elem: ET.Element | None, name: str) -> float | None:
    """A limit in FEET, honouring the uom the export tags it with.

    Route segments mix the two freely -- an upper limit of ``FL 460`` beside a
    lower limit of ``9000 FT`` -- so the unit has to be read, not assumed.
    """
    if elem is None:
        return None
    for child in elem.iter():
        if _local(child.tag) != name or not child.text:
            continue
        raw = child.text.strip().upper()
        if raw in {"GND", "SFC", "MSL"}:
            return 0.0
        if raw.startswith("UNL"):
            return float("inf")
        try:
            value = float(raw)
        except ValueError:
            return None
        return value * 100.0 if (child.get("uom") or "").upper() == "FL" else value
    return None


def extract(path: Path) -> tuple[list[dict], dict[str, str]]:
    """Route segments with their endpoints resolved to fix idents."""
    routes: dict[str, str] = {}          # uuid -> designator ("Y8")
    points: dict[str, str] = {}          # uuid -> ident ("MOTNA")
    raw: list[dict] = []
    validity: dict[str, str] = {}

    for feature in iter_features(path):
        kind = _local(feature.tag)

        if kind == "Route":
            name = _text(feature, "name") or (
                _text(feature, "designatorSecondLetter") + _text(feature, "designatorNumber")
            )
            routes[_uuid(feature)] = name
            continue

        if kind in _POINT_FEATURES:
            ident = _text(feature, "designator") or _text(feature, "name")
            if ident:
                points[_uuid(feature)] = ident
            continue

        if kind != "RouteSegment":
            continue

        if not validity:
            period = _child(feature, "TimePeriod")
            if period is not None:
                validity = {
                    "from": _text(period, "beginPosition"),
                    "to": _text(period, "endPosition"),
                }

        start = _child(feature, "start")
        end = _child(feature, "end")
        length = _text(feature, "length")
        raw.append(
            {
                "route_ref": _ref(feature, "routeFormed"),
                "from_ref": _ref(start, "pointChoice_fixDesignatedPoint")
                or _ref(start, "pointChoice_navaidSystem"),
                "to_ref": _ref(end, "pointChoice_fixDesignatedPoint")
                or _ref(end, "pointChoice_navaidSystem"),
                "direction": (_text(feature, "direction") or "BOTH").upper(),
                "lowerFt": _limit_ft(feature, "lowerLimit"),
                "upperFt": _limit_ft(feature, "upperLimit"),
                "lengthNm": float(length) if length else None,
            }
        )

    segments: list[dict] = []
    for r in raw:
        frm = points.get(r["from_ref"], "")
        to = points.get(r["to_ref"], "")
        route = routes.get(r["route_ref"], "")
        # A segment whose route or either end could not be resolved cannot be
        # matched against a filed route, so it is dropped rather than emitted
        # half-formed.
        if not route or not frm or not to:
            continue
        upper = r["upperFt"]
        segments.append(
            {
                "route": route,
                "from": frm,
                "to": to,
                "direction": r["direction"],
                "lowerFt": r["lowerFt"],
                # JSON has no infinity; UNL becomes null and reads as "no ceiling".
                "upperFt": None if upper == float("inf") else upper,
                "lengthNm": r["lengthNm"],
            }
        )

    segments.sort(key=lambda s: (s["route"], s["from"], s["to"]))
    return segments, validity


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=_DEFAULT_OUT)
    args = parser.parse_args()

    segments, validity = extract(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "source": args.input.name,
                "validFrom": validity.get("from", ""),
                "validTo": validity.get("to", ""),
                "segments": segments,
            },
            indent=1,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    one_way = [s for s in segments if s["direction"] != "BOTH"]
    routes = sorted({s["route"] for s in segments})
    print(f"{len(segments)} segments on {len(routes)} routes -> {args.output}")
    print(f"  {len(one_way)} one-way ({len(segments) - len(one_way)} bidirectional)")
    uni = sorted({s["route"] for s in one_way})
    print(f"  routes with a one-way segment: {', '.join(uni)}")


if __name__ == "__main__":
    main()
