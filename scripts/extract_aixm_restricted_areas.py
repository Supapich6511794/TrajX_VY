"""Extract the prohibited / restricted / danger areas and their activity times.

Reads the Yangon FIR AIXM export (``aixm_export_2609_VY_v5.1.1.xml``) and writes a
flat table of every ``Airspace`` whose ``type`` is P, R, D or TRA, together
with the schedule that says when it is active.

    python scripts/extract_aixm_restricted_areas.py

Outputs (under ``web/public/data/aixm_vy/``):
    prdt_areas_2609.csv     -- one row per area, schedule resolved to text
    pdr_activity.json       -- the same schedules unresolved, for the web app's
                               PDR conflict check (web/lib/pdr/schedule.ts)

Where the activity time lives
-----------------------------
AIXM states it two ways and this export uses both:

* ``AirspaceActivation/timeInterval/Timesheet`` -- the structured form. A sheet
  is a day (or ``day``..``dayTil`` span, plus the ``ANY`` / ``HOL`` codes) and
  either a clock window (``startTime``/``endTime``) or a solar one
  (``startEvent``/``endEvent``, SR = sunrise, SS = sunset). An area can carry
  several sheets, and a sheet marked ``excluded=YES`` carves time OUT of the
  others (e.g. MON-FRI 0130-0930 *except public holidays*).
* An ``activity:`` LinguisticNote -- free text, used for the schedules that do
  not reduce to a timesheet at all, almost always "Notified by NOTAM".

Both columns are emitted rather than merged: ``timesheet`` is machine-usable,
``activity_note`` keeps the caveats the structured form drops.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET

_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_INPUT = _ROOT / "aixm_export_2609_VY_v5.1.1.xml"
_DEFAULT_OUT = _ROOT / "web" / "public" / "data" / "aixm_vy" / "prdt_areas_2609.csv"
_DEFAULT_JSON = _ROOT / "web" / "public" / "data" / "aixm_vy" / "pdr_activity.json"

#: Airspace types that carry a flight restriction.
_TYPES = ("P", "R", "D", "TRA")

#: Solar event codes AIXM uses in place of a clock time.
_EVENTS = {"SR": "sunrise", "SS": "sunset"}

_FIELDS = (
    "type",
    "designator",
    "name",
    "lower",
    "upper",
    "timesheet",
    "activity_note",
    "restriction",
    "hazard",
    "remarks",
)


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


def _text(elem: ET.Element, name: str) -> str:
    for child in elem.iter():
        if _local(child.tag) == name and child.text:
            return child.text.strip()
    return ""


def _format_sheet(sheet: ET.Element) -> str:
    """Render one Timesheet as ``DAY[-DAY] start-end [UTC] [(excluded)]``."""
    get = lambda name: _text(sheet, name)  # noqa: E731 - local shorthand

    days = get("day")
    if get("dayTil"):
        days = f"{days}-{get('dayTil')}"

    start = get("startTime") or _EVENTS.get(get("startEvent"), get("startEvent"))
    end = get("endTime") or _EVENTS.get(get("endEvent"), get("endEvent"))
    window = f"{start}-{end}" if start and end else start or end

    out = " ".join(part for part in (days, window, get("timeReference")) if part)
    if get("excluded").upper() == "YES":
        out += " (excluded)"
    return out


def _sheet_fields(sheet: ET.Element) -> dict[str, object]:
    """One Timesheet as plain data, for the web app to evaluate itself.

    Kept unresolved on purpose: "sunset to sunrise" only becomes a clock time
    once you know the date and where the area is, and only the client knows
    which day the flight is being planned for.
    """
    get = lambda name: _text(sheet, name)  # noqa: E731 - local shorthand
    return {
        "day": get("day"),
        "dayTil": get("dayTil") or None,
        "start": get("startTime") or None,
        "end": get("endTime") or None,
        "startEvent": get("startEvent") or None,
        "endEvent": get("endEvent") or None,
        "excluded": get("excluded").upper() == "YES",
        "timeReference": get("timeReference") or "UTC",
    }


def _note(airspace: ET.Element, prefix: str) -> str:
    """Pull the ``<prefix>: ...`` LinguisticNote the export packs notes into."""
    for elem in airspace.iter():
        if _local(elem.tag) != "note" or not elem.text:
            continue
        text = elem.text.strip()
        if text.startswith(f"{prefix}: "):
            return text[len(prefix) + 2 :]
    return ""


def _limit(volume: ET.Element | None, bound: str) -> str:
    if volume is None:
        return ""
    value = _text(volume, f"{bound}Limit")
    reference = _text(volume, f"{bound}LimitReference")
    return " ".join(part for part in (value, reference) if part)


def extract(path: Path) -> tuple[list[dict], dict[str, str]]:
    """The P/R/D/TRA areas, plus the AIRAC window their TimeSlices are valid for."""
    rows: list[dict] = []
    validity: dict[str, str] = {}
    for feature in iter_features(path):
        if _local(feature.tag) != "Airspace":
            continue
        kind = _text(feature, "type")
        if kind not in _TYPES:
            continue

        if not validity:
            period = next(
                (e for e in feature.iter() if _local(e.tag) == "TimePeriod"), None
            )
            if period is not None:
                validity = {
                    "from": _text(period, "beginPosition"),
                    "to": _text(period, "endPosition"),
                }

        volume = next(
            (e for e in feature.iter() if _local(e.tag) == "AirspaceVolume"), None
        )
        sheets = [e for e in feature.iter() if _local(e.tag) == "Timesheet"]
        rows.append(
            {
                "sheets": [_sheet_fields(s) for s in sheets],
                "type": kind,
                "designator": _text(feature, "designator"),
                "name": _text(feature, "name"),
                "lower": _limit(volume, "lower"),
                "upper": _limit(volume, "upper"),
                "timesheet": "; ".join(_format_sheet(s) for s in sheets),
                "activity_note": _note(feature, "activity"),
                "restriction": _note(feature, "restriction"),
                "hazard": _note(feature, "hazard"),
                "remarks": _note(feature, "remarks"),
            }
        )

    def sort_key(row: dict) -> tuple[int, str, int]:
        # D8B after D8A but before D20: split the trailing digits out.
        match = re.match(r"^\D*(\d+)", row["designator"])
        return (_TYPES.index(row["type"]), row["designator"][:3], int(match.group(1)) if match else 0)

    rows.sort(key=lambda r: (sort_key(r), r["designator"]))
    return rows, validity


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=_DEFAULT_OUT)
    parser.add_argument("--json-output", type=Path, default=_DEFAULT_JSON)
    args = parser.parse_args()

    rows, validity = extract(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # utf-8-sig: these get opened in Excel, which needs the BOM to read non-ASCII names.
    with args.output.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(_FIELDS), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    areas = [
        {
            "designator": r["designator"],
            "type": r["type"],
            "name": r["name"],
            "sheets": r["sheets"],
            "activityNote": r["activity_note"],
            "restriction": r["restriction"],
            "hazard": r["hazard"],
            "remarks": r["remarks"],
        }
        for r in rows
    ]
    args.json_output.write_text(
        json.dumps(
            {
                "source": args.input.name,
                "validFrom": validity.get("from", ""),
                "validTo": validity.get("to", ""),
                "areas": areas,
            },
            indent=1,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    scheduled = sum(1 for r in rows if r["timesheet"])
    noted = sum(1 for r in rows if r["activity_note"] and not r["timesheet"])
    print(f"{len(rows)} areas -> {args.output}")
    print(f"{len(areas)} areas -> {args.json_output} (valid {validity.get('from', '?')} .. {validity.get('to', '?')})")
    print(f"  {scheduled} with a Timesheet, {noted} with only an activity note")
    missing = [r["designator"] for r in rows if not r["timesheet"] and not r["activity_note"]]
    if missing:
        print(f"  no activity time: {', '.join(missing)}")


if __name__ == "__main__":
    main()
