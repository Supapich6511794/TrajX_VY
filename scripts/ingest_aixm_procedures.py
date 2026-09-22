"""Build the SID / STAR / approach layers from an AIXM 5.1.1 export.

The terminal procedures used to come from a one-off ARINC 424 "DFD" GeoJSON
export (``sid_waypoint_thai.geojson`` and friends) that cannot be refreshed
from the AIP URL. This reads the SWIM AIXM subset instead
(``aixm_export_2608_VT_v5.1.1.xml``) and writes the SAME DFD-schema files, so the
navdata loader, the map layers and the holdings reader all keep working
unchanged -- only the AIRAC behind them moves.

    python scripts/ingest_aixm_procedures.py

Outputs (under ``web/public/data/aixm/``):
    sid_waypoint.geojson / sid_line.geojson     -- StandardInstrumentDeparture
    star_waypoint.geojson / star_line.geojson   -- StandardInstrumentArrival
    pbn_waypoint.geojson / pbn_leg.geojson      -- RNAV/RNP approaches
    ils_wp.geojson / ils_leg.geojson            -- every approach type

``pbn`` is the RNAV subset and ``ils`` is the full set, mirroring how the two
files relate today: :class:`~trajectory_sim.navdata.NavData` reads PBN first
and folds ILS in only for the aerodromes PBN does not publish.

AIXM -> ARINC 424 mapping
-------------------------
* A procedure's legs live in ``ProcedureTransition`` groups whose ``type``
  (RWY / COMMON / EN_ROUTE, APPROACH / FINAL / MISSED) becomes the DFD
  ``route_type`` code the leg-segment classifier buckets on.
* Each ``ProcedureTransitionLeg`` points at a leg feature (Departure/Initial/
  Arrival/Final/MissedApproach) carrying the ARINC path terminator, course,
  altitude/speed limits and its end fix.
* AIXM does not carry the ARINC waypoint description code, so it is rebuilt
  from what it does state: fly-over from ``flyOver``, and the approach fix
  roles (IAF / IF / FAF / MAPt) from each fix's position in its transition --
  the 2nd and 4th characters the rest of the codebase reads.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator
from xml.etree import ElementTree as ET

_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_INPUT = _ROOT / "aixm_export_2608_VT_v5.1.1.xml"
_DEFAULT_OUT = _ROOT / "web" / "public" / "data" / "aixm"

_XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
_GML_POS = "{http://www.opengis.net/gml/3.2}pos"
_GML_IDENTIFIER = "{http://www.opengis.net/gml/3.2}identifier"

#: Leg features a ProcedureTransitionLeg can point at.
_LEG_FEATURES = frozenset(
    {
        "DepartureLeg",
        "InitialLeg",
        "ArrivalLeg",
        "FinalLeg",
        "MissedApproachLeg",
    }
)

#: AIXM approach type -> the ARINC 424 approach-identifier letter the DFD
#: export uses (VTSP "VOR/DME Z RWY 09" is D09-Z, "VOR Y RWY 09" is S09-Y).
_APPROACH_LETTER = {
    "ILS": "I",
    "LOC": "L",
    "RNAV": "R",
    "RNP": "R",
    "GLS": "J",
    "MLS": "M",
    "VOR_DME": "D",
    "VOR": "S",
    "NDB_DME": "Q",
    "NDB": "N",
    "LDA": "X",
    "SDF": "U",
    "GNSS": "P",
}

#: Circling-only approaches carry no runway, so the DFD export identifies them
#: by the approach type spelled out plus the circling letter (VTCH "RNVA").
_CIRCLING_PREFIX = {
    "RNAV": "RNV",
    "RNP": "RNV",
    "GNSS": "RNV",
    "VOR": "VOR",
    "VOR_DME": "VDM",
    "NDB": "NDB",
    "NDB_DME": "NDM",
    "ILS": "ILS",
    "LOC": "LOC",
}

#: Approach types that belong in the PBN file as well as the ILS one.
_RNAV_TYPES = frozenset({"RNAV", "RNP", "GNSS"})

#: ProcedureTransition type -> DFD route_type, per procedure kind. The codes
#: are the ones ``navdata._segment_of`` buckets into runway/common/transition.
_SID_ROUTE_TYPE = {"RWY": "4", "COMMON": "5", "EN_ROUTE": "6"}
_STAR_ROUTE_TYPE = {"EN_ROUTE": "4", "COMMON": "5", "RWY": "6"}

#: Altitude/speed interpretation -> the ARINC description character
#: ``navdata.parse_altitude_constraint`` / ``parse_speed_constraint`` read.
_ALT_DESC = {
    "ABOVE_LOWER": "+",
    "BELOW_UPPER": "-",
    "AT_LOWER": "@",
    "BETWEEN": "B",
}
_SPEED_DESC = {"BELOW_UPPER": "-", "AT_LOWER": "@", "ABOVE_LOWER": "+"}

#: Leg types that fly a racetrack -- the holdings reader picks them out of
#: these files by path_termination.
_HOLD_LEGS = frozenset({"HM", "HF", "HA"})

_EARTH_RADIUS_NM = 3440.065

#: Shortest final approach segment considered plausible. AIXM does not publish
#: WHICH fix is the FAF, so it is inferred by walking back from the MAPt to the
#: first fix at least this far out -- anything inside it is a step-down fix.
#: 3 NM reproduces the ARINC coding on 88% of the approaches this AIP also
#: publishes in the superseded DFD export (the fix before the MAPt: 84%).
_MIN_FINAL_NM = 3.0


def _local(tag: str) -> str:
    """'{ns}StandardInstrumentDeparture' -> 'StandardInstrumentDeparture'."""
    return tag.rsplit("}", 1)[-1]


def _child(elem: ET.Element, name: str) -> ET.Element | None:
    for c in elem:
        if _local(c.tag) == name:
            return c
    return None


def _find(elem: ET.Element, name: str) -> ET.Element | None:
    """First descendant with this local name (document order)."""
    for c in elem.iter():
        if _local(c.tag) == name:
            return c
    return None


def _text(elem: ET.Element | None, name: str) -> str | None:
    if elem is None:
        return None
    node = _find(elem, name)
    if node is None or node.text is None:
        return None
    return node.text.strip() or None


def _num(elem: ET.Element | None, name: str) -> float | None:
    t = _text(elem, name)
    if t is None:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _alt_ft(elem: ET.Element | None, name: str) -> float | None:
    """Altitude in feet, honouring the ``uom`` the export tags the value with.

    The 2608 v5.1.1 subset states the higher procedure limits in flight levels
    (``uom="FL"``), so the raw number has to be scaled or FL130 lands as 130 ft.
    """
    if elem is None:
        return None
    node = _find(elem, name)
    if node is None or node.text is None:
        return None
    try:
        value = float(node.text.strip())
    except ValueError:
        return None
    return value * 100.0 if node.get("uom", "").upper() == "FL" else value


def _uuid(href: str | None) -> str | None:
    """'urn:uuid:abc' -> 'abc'."""
    return href.rsplit(":", 1)[-1] if href else None


def _ref(elem: ET.Element | None, name: str) -> str | None:
    if elem is None:
        return None
    node = _find(elem, name)
    return _uuid(node.get(_XLINK_HREF)) if node is not None else None


def _identifier(feature: ET.Element) -> str | None:
    node = feature.find(_GML_IDENTIFIER)
    return node.text.strip() if node is not None and node.text else None


def _timeslice(feature: ET.Element) -> ET.Element | None:
    """The feature's BASELINE time slice (this export has exactly one)."""
    for ts in feature.iter():
        if _local(ts.tag).endswith("TimeSlice"):
            return ts
    return None


def _position(elem: ET.Element | None) -> tuple[float, float] | None:
    """(lat, lon) from the first gml:pos under `elem`."""
    if elem is None:
        return None
    for node in elem.iter():
        if node.tag == _GML_POS and node.text:
            parts = node.text.split()
            if len(parts) >= 2:
                return float(parts[0]), float(parts[1])
    return None


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


class AixmIndex:
    """Everything a procedure needs, keyed by the UUID it is referenced with."""

    def __init__(self) -> None:
        self.airports: dict[str, str] = {}  # uuid -> ICAO designator
        self.fixes: dict[str, tuple[str, float, float]] = {}  # -> ident, lat, lon
        self.legs: dict[str, dict[str, Any]] = {}
        self.sids: list[dict[str, Any]] = []
        self.stars: list[dict[str, Any]] = []
        self.approaches: list[dict[str, Any]] = []

    def load(self, path: Path) -> None:
        for feature in iter_features(path):
            kind = _local(feature.tag)
            uuid = _identifier(feature)
            ts = _timeslice(feature)
            if uuid is None or ts is None:
                continue
            if kind == "AirportHeliport":
                designator = _text(ts, "locationIndicatorICAO") or _text(
                    ts, "designator"
                )
                if designator:
                    self.airports[uuid] = designator.upper()
            elif kind in ("DesignatedPoint", "Navaid"):
                ident = _text(ts, "designator") or _text(ts, "name")
                pos = _position(_child(ts, "location"))
                if ident and pos:
                    self.fixes[uuid] = (ident.upper(), pos[0], pos[1])
            elif kind in _LEG_FEATURES:
                self.legs[uuid] = self._parse_leg(ts)
            elif kind == "StandardInstrumentDeparture":
                self.sids.append(self._parse_procedure(uuid, ts))
            elif kind == "StandardInstrumentArrival":
                self.stars.append(self._parse_procedure(uuid, ts))
            elif kind == "InstrumentApproachProcedure":
                proc = self._parse_procedure(uuid, ts)
                proc["approach_type"] = _text(ts, "approachType")
                proc["multiple_id"] = _text(ts, "multipleIdentification")
                self.approaches.append(proc)

    @staticmethod
    def _parse_leg(ts: ET.Element) -> dict[str, Any]:
        """One leg feature's time slice -> the fields a DFD row needs."""
        end_point = _child(ts, "endPoint")
        fly_over = (_text(end_point, "flyOver") or "").upper() == "YES"
        fix_ref = _ref(end_point, "pointChoice_fixDesignatedPoint") or _ref(
            end_point, "pointChoice_navaidSystem"
        )
        arc = _child(ts, "arcCentre")
        return {
            "path_termination": (_text(ts, "legTypeARINC") or "").upper(),
            "fix_ref": fix_ref,
            "fly_over": fly_over,
            "course": _num(ts, "course"),
            "course_type": _text(ts, "courseType"),
            "lower_alt": _alt_ft(ts, "lowerLimitAltitude"),
            "upper_alt": _alt_ft(ts, "upperLimitAltitude"),
            "alt_interpretation": _text(ts, "altitudeInterpretation"),
            "speed_limit": _num(ts, "speedLimit"),
            "speed_interpretation": _text(ts, "speedInterpretation"),
            "turn_direction": _text(ts, "turnDirection"),
            "rnp": _num(ts, "requiredNavigationPerformance"),
            "vertical_angle": _num(ts, "verticalAngle"),
            "length_nm": _num(ts, "length"),
            "duration_min": _num(ts, "duration"),
            "arc_centre_ref": _ref(arc, "pointChoice_fixDesignatedPoint")
            or _ref(arc, "pointChoice_navaidSystem"),
        }

    @staticmethod
    def _parse_procedure(uuid: str, ts: ET.Element) -> dict[str, Any]:
        transitions: list[dict[str, Any]] = []
        for holder in ts:
            if _local(holder.tag) != "flightTransition":
                continue
            for tr in holder:
                legs = []
                for leg_holder in tr:
                    if _local(leg_holder.tag) != "transitionLeg":
                        continue
                    for tl in leg_holder:
                        legs.append(
                            {
                                "seqno": int(
                                    float(_text(tl, "seqNumberARINC") or 0)
                                ),
                                "leg_ref": _ref(tl, "theSegmentLeg"),
                            }
                        )
                transitions.append(
                    {
                        "id": _text(tr, "transitionId"),
                        "type": (_text(tr, "type") or "").upper(),
                        "legs": sorted(legs, key=lambda lg: lg["seqno"]),
                    }
                )
        return {
            "uuid": uuid,
            "designator": _text(ts, "designator") or _text(ts, "name"),
            "name": _text(ts, "name"),
            "airport_ref": _ref(ts, "airportHeliport"),
            "transitions": transitions,
        }


def approach_identifier(
    approach_type: str | None, name: str | None, multiple_id: str | None
) -> str | None:
    """ARINC 424 approach ident: 'RNP Z RWY 09' -> 'R09-Z', 'ILS RWY 02L' -> 'I02L'.

    The identifier is the approach-type letter, the runway, then the multiple
    indicator -- with a '-' filler when the runway has no L/C/R side letter to
    take that column (the DFD export writes I01-Z but I02RZ).

    A circling-only approach ("RNP A") names no runway; with no runway column
    to fill it is identified by the approach type spelled out and its circling
    letter, as the DFD export writes it: 'RNVA'.
    """
    upper = (name or "").upper()
    kind = (approach_type or "").upper()
    letter = _APPROACH_LETTER.get(kind, "R")
    match = re.search(r"RWY\s*(\d{1,2})\s*([LCR]?)", upper)
    if not match:
        circling = re.search(r"\s([A-Z])$", upper)
        if not circling:
            return None
        return _CIRCLING_PREFIX.get(kind, letter) + circling.group(1)
    runway = f"{int(match.group(1)):02d}{match.group(2)}"
    ident = f"{letter}{runway}"
    if multiple_id:
        ident += ("" if match.group(2) else "-") + multiple_id.upper()
    return ident


def _route_type(
    proc_kind: str, transition: dict[str, Any], approach_letter: str
) -> str:
    """DFD route_type for a transition group."""
    ttype = transition["type"]
    if proc_kind == "SID":
        return _SID_ROUTE_TYPE.get(ttype, "5")
    if proc_kind == "STAR":
        return _STAR_ROUTE_TYPE.get(ttype, "5")
    # An approach's IAF transitions are 'A'; its final + missed segments are
    # the common group, coded with the approach's own type letter.
    return "A" if ttype == "APPROACH" else approach_letter


def _description_code(
    ident: str | None, fly_over: bool, role: str | None
) -> str | None:
    """Rebuild the ARINC waypoint description code.

    Only two of its four columns are read downstream: the 2nd ('Y' = fly-over,
    which widens the turn) and the 4th (the approach fix role -- 'F' at the
    FAF, 'M' at the MAPt, where the landing trajectory stops).
    """
    if ident is None:
        return None
    runway_fix = bool(re.fullmatch(r"RW\d{2}[LCR]?", ident))
    code = ("G" if runway_fix else "E") + ("Y" if fly_over else " ") + " "
    code += role or " "
    return code.rstrip() or None


def _distance_nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance between two (lat, lon) pairs, in NM."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_NM * math.asin(math.sqrt(h))


class RowBuilder:
    """Turns resolved procedures into DFD-schema waypoint + line features."""

    def __init__(self, index: AixmIndex, icao_region: str = "VT") -> None:
        self.index = index
        self.icao_region = icao_region
        self.fid = 0
        self.unresolved_fixes = 0
        self.unnamed_procedures = 0

    def _next_fid(self) -> int:
        self.fid += 1
        return self.fid

    def _fix_roles(
        self, transition: dict[str, Any], legs: list[dict[str, Any]]
    ) -> dict[int, str]:
        """Position -> ARINC fix-role letter for one approach transition group."""
        ttype = transition["type"]
        roles: dict[int, str] = {}
        if not legs:
            return roles
        if ttype == "APPROACH":
            roles[0] = "A"  # IAF -- where the approach is joined
            return roles
        if ttype != "FINAL":
            return roles
        roles[0] = "I"  # the final approach course fix / intermediate fix
        roles[len(legs) - 1] = "M"  # MAPt -- the final segment ends at it
        faf = self._faf_index(legs)
        if faf is not None and faf < len(legs) - 1:
            # A two-leg final starts AT the FAF, so 'F' takes the 'I' slot.
            roles[faf] = "F"
        return roles

    def _faf_index(self, legs: list[dict[str, Any]]) -> int | None:
        """Which leg of a final segment ends at the FAF.

        AIXM states no fix role, and the vertical path angle does not separate
        the FAF from the step-down fixes inside it (identical leg shapes are
        coded both ways in the AIP). Distance does: walking back from the MAPt,
        the FAF is the first fix at least :data:`_MIN_FINAL_NM` before it.
        """
        if len(legs) < 2:
            return None
        mapt = self.index.fixes.get(legs[-1]["fix_ref"] or "")
        if mapt is not None:
            for i in range(len(legs) - 2, -1, -1):
                fix = self.index.fixes.get(legs[i]["fix_ref"] or "")
                if fix is None:
                    continue
                if _distance_nm(fix[1:], mapt[1:]) >= _MIN_FINAL_NM:
                    return i
        return len(legs) - 2

    def rows_for(
        self, proc: dict[str, Any], proc_kind: str
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """(waypoint features, line features) for one procedure."""
        airport = self.index.airports.get(proc["airport_ref"] or "")
        if proc_kind == "APPROACH":
            name = approach_identifier(
                proc.get("approach_type"),
                proc.get("name"),
                proc.get("multiple_id"),
            )
            letter = _APPROACH_LETTER.get(
                (proc.get("approach_type") or "").upper(), "R"
            )
        else:
            name = proc.get("designator")
            letter = ""
        if not airport or not name:
            self.unnamed_procedures += 1
            return [], []

        points: list[dict[str, Any]] = []
        lines: list[dict[str, Any]] = []
        for transition in proc["transitions"]:
            legs = [
                {**self.index.legs[lg["leg_ref"]], "seqno": lg["seqno"]}
                for lg in transition["legs"]
                if lg["leg_ref"] in self.index.legs
            ]
            if not legs:
                continue
            route_type = _route_type(proc_kind, transition, letter)
            roles = (
                self._fix_roles(transition, legs)
                if proc_kind == "APPROACH"
                else {}
            )
            track: list[list[float]] = []
            for i, leg in enumerate(legs):
                role = roles.get(i) or (
                    "H" if leg["path_termination"] in _HOLD_LEGS else None
                )
                feature, coord = self._point_feature(
                    airport, name, route_type, transition, leg, role
                )
                points.append(feature)
                if coord is not None:
                    track.append(coord)
            if len(track) >= 2:
                lines.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "fid": self._next_fid(),
                            "area_code": "PAC",
                            "airport_identifier": airport,
                            "procedure_identifier": name,
                            "transition_identifier": transition["id"],
                        },
                        "geometry": {
                            "type": "MultiLineString",
                            "coordinates": [track],
                        },
                    }
                )
        return points, lines

    def _point_feature(
        self,
        airport: str,
        name: str,
        route_type: str,
        transition: dict[str, Any],
        leg: dict[str, Any],
        role: str | None,
    ) -> tuple[dict[str, Any], list[float] | None]:
        fix = self.index.fixes.get(leg["fix_ref"] or "")
        if leg["fix_ref"] and fix is None:
            self.unresolved_fixes += 1
        ident, lat, lon = fix if fix else (None, None, None)

        alt_desc = _ALT_DESC.get(leg["alt_interpretation"] or "")
        if alt_desc == "-":
            alt1, alt2 = leg["upper_alt"], None
        elif alt_desc == "B":
            alt1, alt2 = leg["upper_alt"], leg["lower_alt"]
        else:
            alt1, alt2 = leg["lower_alt"], None

        # One column carries either a leg distance or a holding time; a second
        # says which ("D" = NM). A racetrack is timed, everything else measured.
        if leg["path_termination"] in _HOLD_LEGS and leg["duration_min"] is not None:
            leg_value: float | None = leg["duration_min"]
            leg_unit: str | None = "T"
        elif leg["length_nm"] is not None:
            leg_value, leg_unit = leg["length_nm"], "D"
        else:
            leg_value = leg["duration_min"]
            leg_unit = "T" if leg_value is not None else None

        centre = self.index.fixes.get(leg["arc_centre_ref"] or "")
        turn = (leg["turn_direction"] or "")[:1].upper() or None
        # The vertical path angle is a descent: the DFD export signs it negative.
        angle = leg["vertical_angle"]
        if angle is not None and angle > 0:
            angle = -angle

        properties = {
            "fid": self._next_fid(),
            "area_code": "PAC",
            "airport_identifier": airport,
            "procedure_identifier": name,
            "route_type": route_type,
            "transition_identifier": transition["id"],
            "seqno": leg["seqno"],
            "waypoint_icao_code": self.icao_region if ident else None,
            "waypoint_identifier": ident,
            "waypoint_latitude": lat,
            "waypoint_longitude": lon,
            "waypoint_description_code": _description_code(
                ident, leg["fly_over"], role
            ),
            "turn_direction": turn,
            "rnp": leg["rnp"],
            "path_termination": leg["path_termination"],
            "recommanded_navaid": None,
            "recommanded_navaid_latitude": None,
            "recommanded_navaid_longitude": None,
            "arc_radius": None,
            "theta": None,
            "rho": None,
            "magnetic_course": leg["course"],
            "route_distance_holding_distance_time": leg_value,
            "distance_time": leg_unit,
            "altitude_description": alt_desc,
            "altitude1": alt1,
            "altitude2": alt2,
            "transition_altitude": None,
            "speed_limit_description": _SPEED_DESC.get(
                leg["speed_interpretation"] or ""
            ),
            "speed_limit": leg["speed_limit"],
            "vertical_angle": angle,
            "center_waypoint": centre[0] if centre else None,
            "center_waypoint_latitude": centre[1] if centre else None,
            "center_waypoint_longitude": centre[2] if centre else None,
            "aircraft_category": None,
        }
        coord = [lon, lat] if lat is not None and lon is not None else None
        feature = {
            "type": "Feature",
            "properties": properties,
            # A fixless leg (CA/VA/VM...) keeps its row and its constraints but
            # has nothing to draw -- the DFD export writes an empty MultiPoint.
            "geometry": {
                "type": "MultiPoint",
                "coordinates": [coord] if coord else [],
            },
        }
        return feature, coord


def _collection(name: str, features: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "name": name,
        "crs": {
            "type": "name",
            "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"},
        },
        "features": features,
    }


def _write(path: Path, name: str, features: list[dict[str, Any]]) -> None:
    path.write_text(
        json.dumps(_collection(name, features), ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"  {path.name}: {len(features)} features")


def build(
    input_path: Path, out_dir: Path, icao_region: str = "VT"
) -> dict[str, list[dict[str, Any]]]:
    """Parse the AIXM export and return the eight layers, keyed by file stem."""
    print(f"Reading {input_path.name} ...")
    index = AixmIndex()
    index.load(input_path)
    print(
        f"  {len(index.airports)} airports, {len(index.fixes)} fixes, "
        f"{len(index.legs)} legs, {len(index.sids)} SIDs, "
        f"{len(index.stars)} STARs, {len(index.approaches)} approaches"
    )

    builder = RowBuilder(index, icao_region)
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for proc in index.sids:
        pts, lines = builder.rows_for(proc, "SID")
        out["sid_waypoint"] += pts
        out["sid_line"] += lines
    for proc in index.stars:
        pts, lines = builder.rows_for(proc, "STAR")
        out["star_waypoint"] += pts
        out["star_line"] += lines
    for proc in index.approaches:
        pts, lines = builder.rows_for(proc, "APPROACH")
        # Every approach lands in the ILS file; the PBN file is the RNAV subset
        # NavData prefers, so a PBN-served aerodrome never falls back.
        out["ils_wp"] += pts
        out["ils_leg"] += lines
        if (proc.get("approach_type") or "").upper() in _RNAV_TYPES:
            out["pbn_waypoint"] += pts
            out["pbn_leg"] += lines

    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Writing to {out_dir} ...")
    for name in (
        "sid_waypoint",
        "sid_line",
        "star_waypoint",
        "star_line",
        "pbn_waypoint",
        "pbn_leg",
        "ils_wp",
        "ils_leg",
    ):
        _write(out_dir / f"{name}.geojson", name, out[name])
    if builder.unresolved_fixes:
        print(f"  {builder.unresolved_fixes} leg end fixes could not be resolved")
    if builder.unnamed_procedures:
        print(f"  {builder.unnamed_procedures} procedures skipped (no ident)")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert an AIXM 5.1.1 export into the DFD procedure layers."
    )
    parser.add_argument("--input", type=Path, default=_DEFAULT_INPUT)
    parser.add_argument("--out", type=Path, default=_DEFAULT_OUT)
    parser.add_argument(
        "--icao-region",
        default="VT",
        help="ICAO region prefix stamped on each waypoint (e.g. VT, VY).",
    )
    args = parser.parse_args()
    build(args.input, args.out, args.icao_region)


if __name__ == "__main__":
    main()
