"""Airspace sector membership for exports — Python twin of web/lib/airspace.ts.

Tags each trajectory sample with the airspace volume that contains it, so the
download formats (CSV / GeoPackage / GeoJSON) can carry a per-timestamp
"sector" column that matches what the web UI shows on the map and the
altitude-profile chart. Reads the SAME Myanmar (Yangon FIR) AIXM GeoJSON the
web app renders (web/public/data/aixm_vy/):

  * ``airspace_boundaries.geojson`` — split by its ``type`` property into
    Control Zones (CTR), Terminal Areas (TMA), Control Areas (CTA) and the FIR;
  * ``restricted_areas.geojson`` — Prohibited/Danger/Restricted areas (PDR,
    ``type`` P/D/R).

Membership is ALTITUDE-AWARE: a point belongs only to volumes whose vertical
band contains its altitude ("which sector is the aircraft IN") — a plane at
FL350 is not in a TMA that tops at FL170.

Every feature carries AIP-style ``lower``/``upper`` strings: ``"GND SFC"``,
``"130 STD"`` (a flight level), ``"1500 MSL"`` / ``"2000 SFC"`` (feet) and
``"UNL STD"`` — see :func:`parse_vy_alt_ft`. Labels come from ``name`` (and,
for a PDR area, ``type`` + ``designator``, e.g. ``"R13 SHANTE"``). Layer hits
follow the web's rule: first feature in file order wins (PDR areas overlap, so
they are all listed).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import shapely
from shapely.geometry import shape

# Airspace GeoJSONs live with the web app's static data so both sides of the
# stack read the one dataset (built from the VY AIXM 5.1.1 export).
_AIXM_DIR = (
    Path(__file__).resolve().parents[1]
    / "web"
    / "public"
    / "data"
    / "aixm_vy"
)
_BOUNDARIES_FILE = "airspace_boundaries.geojson"
_RESTRICTED_FILE = "restricted_areas.geojson"

#: layer key -> (source file, feature ``type`` values that belong to it).
_LAYERS: list[tuple[str, str, frozenset[str]]] = [
    ("pdr", _RESTRICTED_FILE, frozenset({"P", "R", "D"})),
    ("ctr", _BOUNDARIES_FILE, frozenset({"CTR"})),
    ("tma", _BOUNDARIES_FILE, frozenset({"TMA"})),
    ("cta", _BOUNDARIES_FILE, frozenset({"CTA"})),
    ("fir", _BOUNDARIES_FILE, frozenset({"FIR"})),
]

# Abbreviations kept upper-case when title-casing a zone name for display.
_ZONE_ABBR = {"CTR", "TMA", "FIR", "ACC", "CTA", "ATZ", "TCA", "MTMA", "APP"}

#: Airspace hierarchy — an aircraft is in exactly ONE airspace at a time, so a
#: point inside several overlapping volumes resolves to one (highest priority
#: first):
#:
#:   1. ``pdr`` — prohibited/danger/restricted. Not an ATS unit, but being
#:                inside one is the fact that matters, so it overrides.
#:   2. ``ctr`` — Control Zone, worked by Aerodrome Control (Tower).
#:   3. ``tma`` — Terminal Control Area, worked by Approach Control.
#:   4. ``cta`` — Control Area, worked by Area Control.
#:   5. ``fir`` — the Yangon FIR itself, the catch-all outside every
#:                controlled volume above.
#:
#: Annex 11 airspace / ATS-unit structure, applied AFTER the lateral and
#: vertical tests, so an aircraft above a CTR's ceiling has already dropped out
#: of it and falls through to the TMA/CTA below.
#: Must stay in step with HIERARCHY in web/lib/airspace.ts.
_HIERARCHY = ("pdr", "ctr", "tma", "cta", "fir")


def parse_alt_ft(v: object, is_fl: bool = False) -> float:
    """Feet from a generic vertical-limit value (mirror of the web's parseAltFt).

    ``is_fl`` treats a bare number as a flight level. Strings: GND/SFC/MSL ->
    0, UNL -> +inf, "FL 120" -> 12000, "ALT 2000"/bare digits -> feet.
    """
    if v is None:
        return math.nan
    if isinstance(v, (int, float)):
        if isinstance(v, float) and math.isnan(v):
            return math.nan
        return float(v) * 100.0 if is_fl else float(v)
    s = str(v).strip().upper()
    if not s:
        return math.nan
    if s in ("GND", "SFC", "MSL", "SURFACE"):
        return 0.0
    if s.startswith("UNL"):
        return math.inf
    fl = re.search(r"FL\s*(\d+)", s)
    if fl:
        return float(fl.group(1)) * 100.0
    n = re.search(r"(\d+)", s)
    return float(n.group(1)) if n else math.nan


_VY_FL_RE = re.compile(r"^FL\s*(\d+)")
_VY_NUM_RE = re.compile(r"^(\d+)\s*(STD|MSL|SFC)?")


def parse_vy_alt_ft(v: object) -> float:
    """Feet from a Myanmar AIP-style limit (mirror of the web's parseVyAltFt).

    ``"GND SFC"``/``"SFC"`` -> 0, ``"UNL STD"`` -> +inf, ``"<n> STD"`` or
    ``"FL <n>"`` -> that flight level in feet (n * 100), ``"<n> MSL"`` /
    ``"<n> SFC"`` / a bare number -> n feet. NaN when unparseable.
    """
    if v is None:
        return math.nan
    if isinstance(v, (int, float)):
        return math.nan if isinstance(v, float) and math.isnan(v) else float(v)
    s = str(v).strip().upper()
    if not s:
        return math.nan
    if s.startswith("GND") or s.startswith("SFC"):
        return 0.0
    if s.startswith("UNL"):
        return math.inf
    fl = _VY_FL_RE.match(s)
    if fl:
        return float(fl.group(1)) * 100.0
    m = _VY_NUM_RE.match(s)
    if not m:
        return math.nan
    n = float(m.group(1))
    return n * 100.0 if m.group(2) == "STD" else n


def _band(props: dict) -> tuple[float, float]:
    """(lo, hi) feet for a feature — every aixm_vy layer shares one format."""
    return parse_vy_alt_ft(props.get("lower")), parse_vy_alt_ft(props.get("upper"))


def _label(props: dict, layer: str) -> str:
    if layer == "pdr":
        # restricted_areas.geojson has no combined ident: "R" + "13" + "SHANTE".
        ident = (
            str(props.get("type") or "").strip()
            + str(props.get("designator") or "").strip()
        ).strip()
        name = str(props.get("name") or "").strip()
        return " ".join(p for p in (ident, name) if p) or "PDR"
    name = str(props.get("name") or props.get("designator") or "").strip()
    # The FIR feature is named just "YANGON" — say what it is.
    if layer == "fir" and name and not re.search(r"\bFIR\b", name, re.I):
        return f"{name} FIR"
    return name or layer.upper()


def _title_zone(name: str) -> str:
    """"MINGALADON TMA" -> "Mingaladon TMA"; idents with digits (R13) kept."""
    out = []
    for w in name.split():
        if any(ch.isdigit() for ch in w):
            out.append(w)
        elif w.upper() in _ZONE_ABBR:
            out.append(w.upper())
        else:
            out.append(w[:1].upper() + w[1:].lower())
    return " ".join(out)


@dataclass
class _Entry:
    label: str
    lo: float
    hi: float


class AirspaceIndex:
    """Per-layer feature metadata + an STRtree over the polygons.

    Whole flights are tagged in one vectorized tree query per layer, then the
    (point, feature) candidate pairs are resolved in file order so the label
    matches the web engine exactly.
    """

    def __init__(
        self,
        entries: dict[str, list[_Entry]],
        trees: dict[str, "shapely.STRtree | None"],
    ):
        self.entries = entries
        self.trees = trees

    def tag(
        self,
        lons: Sequence[float],
        lats: Sequence[float],
        alts_ft: Sequence[float | None],
    ) -> list[str]:
        """Altitude-aware compact sector label for every point of a flight — the
        volume that actually CONTAINS the aircraft at its altitude (a plane at
        FL350 is not in a TMA that tops at FL170)."""
        n = len(lons)
        pts = shapely.points(
            np.asarray(lons, dtype=float), np.asarray(lats, dtype=float)
        )
        # hits[layer][point] -> labels the point is inside, in file order.
        hits: dict[str, list[list[str]]] = {}
        for layer, _, _ in _LAYERS:
            per: list[list[str]] = [[] for _ in range(n)]
            tree = self.trees.get(layer)
            entries = self.entries.get(layer, [])
            if tree is not None and n:
                pt_i, ft_i = tree.query(pts, predicate="intersects")
                # Resolve candidates in ascending feature order per point —
                # the web's "first feature wins" rule for non-PDR layers.
                for k in np.lexsort((ft_i, pt_i)):
                    p = int(pt_i[k])
                    e = entries[int(ft_i[k])]
                    alt = alts_ft[p]
                    in_band = alt is None or (e.lo <= alt <= e.hi)
                    if in_band and (layer == "pdr" or not per[p]):
                        per[p].append(e.label)
            hits[layer] = per

        def compact(p: int) -> str:
            """The ONE airspace that owns the aircraft here, by _HIERARCHY."""
            for layer in _HIERARCHY:
                got = hits[layer][p]
                if not got:
                    continue
                if layer == "pdr":
                    return ",".join(s.split(" ")[0] for s in got)
                return _title_zone(got[0])
            return ""

        return [compact(p) for p in range(n)]


_INDEX: AirspaceIndex | None = None
_INDEX_FAILED = False


def _load_index() -> AirspaceIndex | None:
    """Build the singleton index; None (and stay quiet) if the data files are
    absent so exports still work in a deployment without the web assets."""
    global _INDEX, _INDEX_FAILED
    if _INDEX is not None or _INDEX_FAILED:
        return _INDEX
    entries: dict[str, list[_Entry]] = {}
    trees: dict[str, shapely.STRtree | None] = {}
    try:
        files: dict[str, dict] = {}
        for layer, fname, types in _LAYERS:
            if fname not in files:
                path = _AIXM_DIR / fname
                files[fname] = json.loads(path.read_text(encoding="utf-8"))
            fc = files[fname]
            es: list[_Entry] = []
            geoms = []
            for f in fc.get("features", []):
                geom_json = f.get("geometry")
                if not geom_json or geom_json.get("type") not in (
                    "Polygon",
                    "MultiPolygon",
                ):
                    continue
                props = f.get("properties") or {}
                if str(props.get("type") or "").strip().upper() not in types:
                    continue
                lo, hi = _band(props)
                es.append(
                    _Entry(
                        label=_label(props, layer),
                        lo=lo if not math.isnan(lo) else -math.inf,
                        hi=hi if not math.isnan(hi) else math.inf,
                    )
                )
                geoms.append(shape(geom_json))
            entries[layer] = es
            trees[layer] = shapely.STRtree(geoms) if geoms else None
        _INDEX = AirspaceIndex(entries, trees)
    except (OSError, ValueError, KeyError):
        _INDEX_FAILED = True
        return None
    return _INDEX


def sector_columns(
    lons: Sequence[float],
    lats: Sequence[float],
    alts_ft: Sequence[float | None],
) -> list[str]:
    """Per-point altitude-aware sector label for a whole flight — one compact
    string per input point ("" when the point is outside every volume at its
    altitude, or when the airspace data isn't available)."""
    lons = list(lons)
    lats = list(lats)
    alts = list(alts_ft)
    idx = _load_index()
    if idx is None:
        return [""] * len(lons)
    return idx.tag(lons, lats, alts)
