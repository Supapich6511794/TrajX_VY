"""Enrich the real VY track/FPL export with SID, STAR, approach and runway.

``vy_2025_07_01_to_07_track.csv`` (dep/dest/acid/actype/rfl/dof/time/entry_fl/
wp1/wp2/wp3 + WKB geometry) already imports and generates on its own — the web
importer builds an eobt from dof+time and a route from wp1..wp3 (matched
against real ATS routes) with no help from this script. What it CANNOT know
from three enroute fixes alone is which SID/STAR/approach/runway the flight
actually used, so every import currently flies "None (direct
departure/arrival)" even into the Myanmar aerodromes that publish real
terminal procedures — and Arrival Sequencing needs a resolved runway to have
anything to sequence (see `useArrivals.ts`: "only flights ... with a known
runway threshold take part"). The full chain this fills in end to end is:

    ADEP -> SID -> SID fixes -> ATS route/DCT -> en-route -> STAR ->
    STAR fixes -> approach (IAF -> IF -> FAF -> MAPt) -> runway -> ADES

This adds five columns the importer already recognises by name
(`web/lib/flightFile.ts`'s `fromObject()`): ``sid``, ``star``, ``approach``,
``dep_rwy``, ``arr_rwy``. Every original column is kept as-is, so the
enriched file imports through the exact same path as the plain one — wp1..wp3
still drive the enroute route match (already matched against the real ATS
route network, e.g. `matchAtsRoute()`); this only adds the terminal ends
around it.

Matching, per row:

  * **SID** (only when ``dep`` is one of the 6 procedure-published
    aerodromes): among that aerodrome's SIDs, the one whose EN_ROUTE
    transition (AIXM/DFD ``route_type`` 6 — see
    ``scripts/ingest_aixm_procedures.py``) EXITS at ``wp1``, the flight's
    first crossing fix. That transition's own COMMON leg (route_type 5)
    names the runway it was flown from.
  * **STAR** (only when ``dest`` is procedure-published): the STAR whose
    EN_ROUTE transition (route_type 4) ENTERS at the flight's LAST crossing
    fix. Same COMMON-leg runway read.
  * **Runway with no matching procedure**: the runway end that points the
    way the flight goes (``runway_vy.csv`` true bearings — covers all 48 VY
    aerodromes, procedures or not), the same rule the generator's "Auto"
    uses: a departure takes the end closest to the track from the aerodrome
    to its first crossing fix (or to ``dest`` when the only "fixes" are the
    two aerodromes), an arrival the end closest to the track from its last
    crossing fix (or from ``dep``) into the aerodrome. So a domestic hop with
    no SID/STAR still gets a runway Arrival Sequencing can use, and never one
    that takes off away from its route. A foreign ADEP/ADES (not in the VY
    runway table at all) is left blank, same as an unfiled runway today.
  * **Approach**: whichever resolved arrival runway (from a STAR match or
    the fallback above) has a published PBN approach at ``dest`` — the AIXM
    procedure identifier is just "R" + the runway number (``pbn_waypoint.
    geojson``: RW03 -> "R03", RW21 -> "R21"), each with its own IAF(s) ->
    IF -> FAF -> MAPt chain the generator already knows how to splice in
    (same field the UI's own approach picker writes). Left blank where the
    runway has no published IAP, same as leaving the picker on "None" today.

A flight with no SID/STAR match at either end (e.g. the crossing fix isn't
any published transition's exit/entry — a common case for a straight
overflight far from any transition) simply gets no sid/star, same fallback
runway logic, and imports exactly as it does today.

    python scripts/make_vy_track_sid_star.py

Output: vy_2025_07_01_to_07_dummy.csv (repo root, alongside the source file)
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
from collections import defaultdict
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_SRC = _ROOT / "vy_2025_07_01_to_07_track.csv"
_SID = _ROOT / "web" / "public" / "data" / "aixm_vy" / "sid_waypoint.geojson"
_STAR = _ROOT / "web" / "public" / "data" / "aixm_vy" / "star_waypoint.geojson"
_APPROACH = _ROOT / "web" / "public" / "data" / "aixm_vy" / "pbn_waypoint.geojson"
_RUNWAYS = _ROOT / "web" / "public" / "data" / "airports" / "runway_vy.csv"
_AIP = _ROOT / "web" / "public" / "data" / "aip_VY.json"
_OUT = _ROOT / "vy_2025_07_01_to_07_dummy.csv"

# DFD route_type per procedure kind (scripts/ingest_aixm_procedures.py):
#   SID:  RWY=4, COMMON=5, EN_ROUTE=6  (EN_ROUTE is where it exits to the ATS network)
#   STAR: EN_ROUTE=4, COMMON=5, RWY=6  (EN_ROUTE is where it enters from the ATS network)
_SID_ENROUTE, _SID_COMMON = "6", "5"
_STAR_ENROUTE, _STAR_COMMON = "4", "5"


def _load_features(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def _procedures(
    features: list[dict], enroute_type: str, common_type: str
) -> dict[str, list[dict]]:
    """airport -> list of {procedure, exit_or_entry_fix, runway}.

    One entry per (procedure, en-route transition) — a procedure with several
    entry/exit transitions (one per fix a controller might clear a flight via)
    yields one candidate per fix, each carrying the runway its own COMMON leg
    was coded for.
    """
    by_proc: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for f in features:
        p = f["properties"]
        by_proc[(p["airport_identifier"], p["procedure_identifier"])].append(p)

    out: dict[str, list[dict]] = defaultdict(list)
    for (airport, proc), legs in by_proc.items():
        enroute = [l for l in legs if l["route_type"] == enroute_type]
        common = [l for l in legs if l["route_type"] == common_type]
        if not common:
            continue
        # The runway the COMMON leg was coded for — its own transition_identifier
        # names it directly (e.g. "RW21"), whether or not a separate RWY-only
        # group also exists.
        runway = common[0]["transition_identifier"]
        if not (runway or "").upper().startswith("RW"):
            continue
        # Per en-route transition, the fix at the network end is the one with
        # the extreme seqno within that transition: MIN for a SID exit
        # (walking away from the runway), MAX for a STAR entry (walking away
        # from the network, toward the runway) — but since STAR transitions
        # here run network->runway with seqno ascending from the entry fix,
        # the entry fix is the MIN seqno too (see ingest sample: BETNO@10,
        # ENSIT@20). Both kinds want the transition's OWN first point.
        by_transition: dict[str, list[dict]] = defaultdict(list)
        for l in enroute:
            by_transition[l["transition_identifier"]].append(l)
        for _, points in by_transition.items():
            points.sort(key=lambda l: l["seqno"])
            fix = points[0]["waypoint_identifier"]
            out[airport].append({"procedure": proc, "fix": fix, "runway": runway})
    return out


def _runway_ends(path: Path) -> dict[str, list[tuple[str, float]]]:
    """airport -> [(runway ARINC ident e.g. "RW21L", true bearing deg), ...]."""
    out: dict[str, list[tuple[str, float]]] = defaultdict(list)
    with path.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            ap = row["airport_identifier"].strip().upper()
            rwy = row["runway_identifier"].strip().upper()
            brg = (row.get("runway_true_bearing") or "").strip()
            if ap and rwy and brg:
                out[ap].append((rwy, float(brg)))
    return out


def _airports(path: Path) -> dict[str, tuple[float, float]]:
    """ICAO -> (lat, lon), from the AIP extract the generator also reads."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: (v["lat"], v["lon"]) for k, v in data["airports"].items()}


def _wkb_point(hexstr: str) -> tuple[float, float] | None:
    """(lat, lon) of a hex (E)WKB POINT, as the ``wpN_geom`` columns hold."""
    try:
        raw = bytes.fromhex((hexstr or "").strip())
    except ValueError:
        return None
    if len(raw) < 21:
        return None
    order = "<" if raw[0] == 1 else ">"
    (geom_type,) = struct.unpack(order + "I", raw[1:5])
    off = 9 if geom_type & 0x20000000 else 5  # EWKB carries a 4-byte SRID
    if len(raw) < off + 16:
        return None
    lon, lat = struct.unpack(order + "dd", raw[off:off + 16])
    return lat, lon


def _bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial great-circle bearing a -> b, degrees true."""
    la1, la2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlon)
    return math.degrees(math.atan2(y, x)) % 360.0


def _runway_for_track(ends: list[tuple[str, float]], track: float) -> str:
    """The end whose true bearing is closest to ``track`` — the one that
    points the way the flight goes."""
    return min(ends, key=lambda e: abs((e[1] - track + 180.0) % 360.0 - 180.0))[0]


def _approaches_by_airport(features: list[dict]) -> dict[str, set[str]]:
    """airport -> its published PBN approach identifiers (e.g. {"R03", "R21"})."""
    out: dict[str, set[str]] = defaultdict(set)
    for f in features:
        p = f["properties"]
        out[p["airport_identifier"]].add(p["procedure_identifier"])
    return out


def _approach_for_runway(rwy: str, approaches: set[str]) -> str:
    """The published approach whose name encodes ``rwy`` (RW03 -> "R03"), or ""."""
    digits = "".join(ch for ch in rwy.upper().removeprefix("RW") if ch.isdigit())
    if not digits:
        return ""
    ident = f"R{digits}"
    return ident if ident in approaches else ""


def enrich(rows: list[dict]) -> tuple[list[dict], dict[str, int]]:
    sid_by_airport = _procedures(_load_features(_SID), _SID_ENROUTE, _SID_COMMON)
    star_by_airport = _procedures(_load_features(_STAR), _STAR_ENROUTE, _STAR_COMMON)
    approaches_by_airport = _approaches_by_airport(_load_features(_APPROACH))
    runway_ends = _runway_ends(_RUNWAYS)
    airports = _airports(_AIP)

    stats = {
        "sid_matched": 0,
        "star_matched": 0,
        "dep_rwy_from_sid": 0,
        "arr_rwy_from_star": 0,
        "dep_rwy_fallback": 0,
        "arr_rwy_fallback": 0,
        "approach_matched": 0,
    }

    out_rows: list[dict] = []
    for row in rows:
        dep = row["dep"].strip().upper()
        dest = row["dest"].strip().upper()
        chain = [row.get(f"wp{i}", "").strip().upper() for i in (1, 2, 3)]
        chain = [w for w in chain if w]
        # Each crossing fix with its position; an aerodrome resolves to the
        # aerodrome itself.
        points: list[tuple[str, tuple[float, float] | None]] = []
        for i in (1, 2, 3):
            ident = row.get(f"wp{i}", "").strip().upper()
            if ident:
                pos = airports.get(ident) or _wkb_point(row.get(f"wp{i}_geom", ""))
                points.append((ident, pos))

        sid = star = dep_rwy = arr_rwy = ""

        if chain:
            first = chain[0]
            for cand in sid_by_airport.get(dep, []):
                if cand["fix"] == first:
                    sid = cand["procedure"]
                    dep_rwy = cand["runway"]
                    stats["sid_matched"] += 1
                    stats["dep_rwy_from_sid"] += 1
                    break

            last = chain[-1]
            for cand in star_by_airport.get(dest, []):
                if cand["fix"] == last:
                    star = cand["procedure"]
                    arr_rwy = cand["runway"]
                    stats["star_matched"] += 1
                    stats["arr_rwy_from_star"] += 1
                    break

        dep_ll, dest_ll = airports.get(dep), airports.get(dest)
        if not dep_rwy and runway_ends.get(dep) and dep_ll:
            # Towards the first crossing fix that is not the field itself.
            toward = next(
                (pos for ident, pos in points if ident != dep and pos), dest_ll
            )
            # Nothing to say which way it goes (a track whose only fixes are
            # the field, to a destination outside the AIP): the first runway.
            dep_rwy = (
                _runway_for_track(runway_ends[dep], _bearing(dep_ll, toward))
                if toward
                else runway_ends[dep][0][0]
            )
            stats["dep_rwy_fallback"] += 1
        if not arr_rwy and runway_ends.get(dest) and dest_ll:
            # From the last crossing fix that is not the field itself.
            source = next(
                (pos for ident, pos in reversed(points) if ident != dest and pos),
                dep_ll,
            )
            arr_rwy = (
                _runway_for_track(runway_ends[dest], _bearing(source, dest_ll))
                if source
                else runway_ends[dest][0][0]
            )
            stats["arr_rwy_fallback"] += 1

        # Approach: STAR fixes -> IAF -> IF -> FAF -> MAPt -> runway. Only
        # meaningful once a runway is resolved at all, whichever way it got
        # there (a real STAR match or the direction pick above).
        approach = ""
        if arr_rwy:
            approach = _approach_for_runway(arr_rwy, approaches_by_airport.get(dest, set()))
            if approach:
                stats["approach_matched"] += 1

        out_rows.append(
            {
                **row,
                "sid": sid,
                "star": star,
                "approach": approach,
                "dep_rwy": dep_rwy,
                "arr_rwy": arr_rwy,
            }
        )

    return out_rows, stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=_SRC)
    ap.add_argument("--output", type=Path, default=_OUT)
    args = ap.parse_args()

    if not args.input.exists():
        raise SystemExit(f"Source track not found: {args.input}")

    with args.input.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    out_rows, stats = enrich(rows)

    out_fields = fieldnames + ["sid", "star", "approach", "dep_rwy", "arr_rwy"]
    with args.output.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=out_fields)
        w.writeheader()
        w.writerows(out_rows)

    n = len(rows)
    print(f"{n} rows -> {args.output}")
    print(f"  SID matched:  {stats['sid_matched']:4d}  (dep_rwy from SID: {stats['dep_rwy_from_sid']})")
    print(f"  STAR matched: {stats['star_matched']:4d}  (arr_rwy from STAR: {stats['arr_rwy_from_star']})")
    print(f"  dep_rwy by direction (no SID match, aerodrome known): {stats['dep_rwy_fallback']}")
    print(f"  arr_rwy by direction (no STAR match, aerodrome known): {stats['arr_rwy_fallback']}")
    total_dep_rwy = stats["dep_rwy_from_sid"] + stats["dep_rwy_fallback"]
    total_arr_rwy = stats["arr_rwy_from_star"] + stats["arr_rwy_fallback"]
    print(f"  rows with a dep_rwy at all: {total_dep_rwy}/{n}   arr_rwy: {total_arr_rwy}/{n}")
    print(f"  approach matched (published IAP for the resolved arr_rwy): {stats['approach_matched']}/{n}")


if __name__ == "__main__":
    main()
