"""Build the AIP Myanmar reference layers in web/public/data/VY_AIP/.

The AIXM export (aixm_export_2609_VY_v5.1.1.xml) carries neither aerodrome
transition altitudes nor any activation data for the 110 P/R/D airspaces, so
both come from the AIP itself:

  * transition_altitudes.json -- AIP Myanmar Table 3.6 "Transition Altitude and
    Transition Level for aerodromes", transcribed below (the published table is
    an image). Keyed by ICAO code via Airport_with_AP_Main_vy.csv.
  * restricted_areas.geojson  -- the AIXM P/R/D geometry (aixm_vy/
    restricted_areas.geojson) with each area's ENR 5.1 remark and the
    activation reading derived from it.
  * pdr_activity.json         -- the same activation data in the shape the web
    app's PDR check reads (web/lib/pdr/types.ts `PdrActivityFile`).

Activation reading of an ENR 5.1 remark ("time of activity" column):
  * mentions NOTAM ("Times notified by NOTAM", "Notified by NOTAM when area is
    active", ...)  -> "NOTAM": no timesheet; the web app treats it as INACTIVE
    until a NOTAM activates it.
  * otherwise "Active: Permanent" / "H24" -> "H24": active every day 00:00-24:00.
  * no ENR 5.1 table row at all (VYR40A/B appear only on the training-area
    chart) -> "UNPUBLISHED": no timesheet, no note; the web app assumes active.

Run from the repo root:
    python scripts/build_vy_aip.py [--enr51 web/ENR-5.1.pdf]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web" / "public" / "data"
OUT = DATA / "VY_AIP"

# AIP Myanmar Table 3.6 -- (aerodrome as printed, TA ft, TA m, TL FL, TL m).
# None = the table prints "-" (Kyauktu). Mong-hsat's TA metre column prints
# 1524, which contradicts its 11 000 ft; 3353 m (= 11 000 ft, as for Heho and
# Kengtung) is used and the discrepancy is recorded in the output.
_TA_TABLE = [
    ("Ann", 7000, 2133, 85, 2590),
    ("Anisakan", 9000, 2743, 105, 3200),
    ("Bagan/Nyaung U", 8000, 2438, 95, 2895),
    ("Banmaw", 10000, 3048, 115, 3505),
    ("Bokpyinn", 7000, 2133, 85, 2590),
    ("Dawei", 6000, 1828, 75, 2286),
    ("Heho", 11000, 3353, 125, 3810),
    ("Hommalinn", 13000, 3965, 145, 4420),
    ("Hpa-an", 9000, 2743, 105, 3200),
    ("Kalay", 12000, 3658, 135, 4115),
    ("Kanti", 13000, 3965, 145, 4420),
    ("Kawthoung", 4000, 1220, 55, 1676),
    ("Kengtung", 11000, 3353, 125, 3810),
    ("Kyaukpyu", 5000, 1524, 65, 1981),
    ("Kyauktu", None, None, None, None),
    ("Lashio", 10000, 3048, 115, 3505),
    ("Loikaw", 10000, 3048, 115, 3505),
    ("Magwe", 7000, 2133, 85, 2590),
    ("Mandalay International", 6000, 1828, 75, 2286),
    ("Mawlamyine", 5000, 1524, 65, 1981),
    ("Mong-hsat", 11000, 3353, 125, 3810),
    ("Monywar", 7000, 2133, 85, 2590),
    ("Myeik", 5000, 1524, 65, 1981),
    ("Myitkyina", 12000, 3658, 135, 4115),
    ("Nampong", 12000, 3658, 135, 4115),
    ("Naypyitaw International", 9000, 2743, 105, 3200),
    ("Pathein", 4000, 1220, 55, 1676),
    ("Pakhokku", 7000, 2133, 85, 2590),
    ("Putao", 17000, 5182, 185, 5639),
    ("Sittwe", 4000, 1220, 55, 1676),
    ("Tachileik", 9000, 2743, 105, 3200),
    ("Thandwe", 6000, 1828, 75, 2286),
    ("Yangon International", 6000, 1828, 75, 2286),
]

# Table 3.6 spells some aerodromes differently from the AIXM airport names.
_NAME_ALIASES = {
    "BAGAN/NYAUNG U": "NYAUNG U",
    "MAGWE": "MAGWAY",
    "MANDALAY INTERNATIONAL": "MANDALAY INTL",
    "NAYPYITAW INTERNATIONAL": "NAYPYITAW INTL",
    "YANGON INTERNATIONAL": "YANGON INTL",
    "NAMPONG": "WEST NAMPONG",
}


def build_transition_altitudes() -> dict:
    by_name = {}
    with open(DATA / "airports" / "Airport_with_AP_Main_vy.csv", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            by_name[row["airport_name"].strip().upper()] = row["airport_identifier"]
    rows = []
    for name, ta_ft, ta_m, tl_fl, tl_m in _TA_TABLE:
        key = _NAME_ALIASES.get(name.upper(), name.upper())
        icao = by_name.get(key)
        if icao is None:
            raise SystemExit(f"Table 3.6 aerodrome {name!r} has no match in Airport_with_AP_Main_vy.csv")
        row = {
            "icao": icao,
            "aerodrome": name,
            "transition_altitude_ft": ta_ft,
            "transition_altitude_m": ta_m,
            "transition_level_fl": tl_fl,
            "transition_level_m": tl_m,
        }
        if name == "Mong-hsat":
            row["note"] = "AIP prints TA 1524 m; 3353 m (= 11 000 ft) used"
        rows.append(row)
    return {
        "source": "AIP Myanmar, Table 3.6 Transition Altitude and Transition Level for aerodromes",
        "aerodromes": sorted(rows, key=lambda r: r["icao"]),
    }


# --- ENR 5.1 ------------------------------------------------------------------

_FURNITURE = re.compile(
    r"AIRAC AMDT|DepartmentofCivil|Department of Civil|AIPMYANMAR|AIP MYANMAR|ENR 5\.1-\d")
_DATE = re.compile(r"\b\d{1,2}\s+[A-Z]{3}\s+\d{4}\b")


def _ident_at(line: str, known: list[str]) -> str | None:
    """The area identifier starting a table row, matched against the AIXM
    designators (longest first) because the PDF sometimes glues the ident to
    the name: "VYP31PARLIAMENT", "VYD23ACOMBAT"."""
    m = re.match(r"^\s{0,3}(VY[PRD])\s?(\S+)", line)
    if not m:
        return None
    tail = m.group(2)
    for k in known:  # sorted longest first
        if (m.group(1) + tail).startswith(k) or (m.group(1) + tail).startswith(k.replace(" ", "")):
            return k
    return None


def parse_enr51(pdf: Path, known: list[str]) -> dict[str, str]:
    """Remark text ("time of activity" column) per area ident.

    Uses the layout-preserving text so the Remarks column can be cut out by
    x position. Within a page the n-th "Active..." remark belongs to the n-th
    area row; remarks left over at the top of a page continue the previous
    page's last area (an area whose sectors run across a page break)."""
    reader = PdfReader(str(pdf))
    remarks: dict[str, list[str]] = {}
    last_ident: str | None = None
    for page in reader.pages:
        lines = (page.extract_text(extraction_mode="layout") or "").split("\n")
        col = next((ln.find("Remarks") for ln in lines if "Remarks" in ln), -1)
        if col < 0:
            continue  # chart or blank page
        col -= 4
        idents: list[str] = []
        segments: list[list[str]] = []
        for ln in lines:
            if _FURNITURE.search(ln):
                continue
            ident = _ident_at(ln, known)
            if ident and ident not in idents:
                idents.append(ident)
            right = _DATE.sub("", ln[col:]).strip() if len(ln) > col else ""
            if not right or re.match(r"^(Remarks|restriction|interception|\d)\b", right):
                continue
            if re.match(r"^Active", right) or not segments:
                segments.append([right])
            else:
                segments[-1].append(right)
        # Text above the page's first "Active..." continues the previous
        # page's last remark.
        if segments and not re.match(r"^Active", segments[0][0]):
            head = segments.pop(0)
            if last_ident:
                remarks.setdefault(last_ident, []).extend(head)
        extra = len(segments) - len(idents)
        if extra > 0 and last_ident:
            for s in segments[:extra]:
                remarks.setdefault(last_ident, []).extend(s)
            segments = segments[extra:]
        for ident, seg in zip(idents, segments):
            remarks.setdefault(ident, []).extend(seg)
        if idents:
            last_ident = idents[-1]
    return {k: _clean(" ".join(v)) for k, v in remarks.items()}


def _clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    # Some rows are extracted without inter-word spaces
    # ("Active:Permanent,AirforceandArmy"); restore the ones that matter.
    for word in ("Active:", "Permanent,", "NOTAM", "training", "area", "Air", "Army", "firing"):
        text = re.sub(rf"(?<=[a-z,.]){re.escape(word)}", " " + word, text)
    return re.sub(r"\s+", " ", text.replace(":P", ": P").replace(",", ", ")).replace(" ,", ",").strip()


# ENR 5.1-18 (danger areas) extracts with its words run together and the
# vertical-limit column bleeding in; these remarks are transcribed verbatim.
_REMARK_OVERRIDES = {
    "VYD1": "Active: Permanent, Air to Air firing, Effective dates and times will be notified "
            "in advance through NOTAM and Mingaladon Approach control as necessary.",
    "VYD9": "Active: Permanent, Air to Ground firing, Heights and time of activation notified by NOTAM.",
    "VYD10": "Active: Permanent, Airforce and Army training area, Times notified by NOTAM",
    "VYD23A": "Active: Permanent, Airforce and Army training area, Times notified by NOTAM",
}


def _tidy(ident: str, remark: str) -> str:
    if ident in _REMARK_OVERRIDES:
        return _REMARK_OVERRIDES[ident]
    # Vertical-limit fragments caught in the P-area rows ("ingFL 240 STD GND ARP").
    remark = re.sub(r"\s*\b\w*(FL ?\d+ STD|\d+ STD|GND|ARP)\b.*$", "", remark)
    # A remark repeated for a second group of sectors (VYR30).
    sentences = [s.strip() for s in re.split(r"(?<=\.)\s+", remark) if s.strip()]
    return " ".join(dict.fromkeys(sentences))


def activation_of(remark: str) -> str:
    return "NOTAM" if re.search(r"NOTAM", remark, re.I) else "H24"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--enr51", type=Path, default=ROOT / "web" / "ENR-5.1.pdf")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)

    ta = build_transition_altitudes()
    (OUT / "transition_altitudes.json").write_text(
        json.dumps(ta, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    fc = json.loads((DATA / "aixm_vy" / "restricted_areas.geojson").read_text(encoding="utf-8"))
    known = sorted({"VY" + f["properties"]["type"] + f["properties"]["designator"]
                    for f in fc["features"]}, key=len, reverse=True)
    remarks = parse_enr51(args.enr51, known)
    missing = sorted(set(known) - set(remarks))
    if missing:
        print(f"no ENR 5.1 table row (activation UNPUBLISHED): {', '.join(missing)}")

    activity_meta = json.loads((DATA / "aixm_vy" / "pdr_activity.json").read_text(encoding="utf-8"))
    areas, seen = [], set()
    for f in fc["features"]:
        p = f["properties"]
        ident = "VY" + p["type"] + p["designator"]
        remark = _tidy(ident, remarks.get(ident, ""))
        act = activation_of(remark) if remark else "UNPUBLISHED"
        p["enr51_remark"] = remark
        p["activation"] = act
        p["activity_note"] = {"NOTAM": "Notified by NOTAM", "H24": "H24"}.get(act, "")
        if ident in seen:
            continue  # AIXM splits one area into sectors; one timetable per area
        seen.add(ident)
        areas.append({
            "designator": p["designator"],
            "type": p["type"],
            "name": p["name"],
            "sheets": [] if act != "H24" else [{
                "day": "ANY", "dayTil": None, "start": "00:00", "end": "24:00",
                "startEvent": None, "endEvent": None, "excluded": False, "timeReference": "UTC",
            }],
            "activityNote": "Notified by NOTAM" if act == "NOTAM" else "",
            "restriction": "",
            "hazard": "",
            "remarks": remark,
        })
    fc["name"] = "restricted_areas_enr51"
    (OUT / "restricted_areas.geojson").write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    (OUT / "pdr_activity.json").write_text(json.dumps({
        "source": "AIP Myanmar ENR 5.1 (AIRAC AMDT 01/2025, 10 JUL 2025) + " + activity_meta["source"],
        "validFrom": activity_meta["validFrom"],
        "validTo": activity_meta["validTo"],
        "areas": areas,
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    n_notam = sum(a["activityNote"] != "" for a in areas)
    n_h24 = sum(bool(a["sheets"]) for a in areas)
    print(f"transition_altitudes.json: {len(ta['aerodromes'])} aerodromes")
    print(f"pdr_activity.json: {len(areas)} areas ({n_notam} NOTAM, {n_h24} H24, "
          f"{len(areas) - n_notam - n_h24} unpublished)")
    print(f"restricted_areas.geojson: {len(fc['features'])} features")


if __name__ == "__main__":
    main()
