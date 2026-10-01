"""Navigation data lookup from the BearCat GeoPackage.

Loads the `waypoints` layer once at construction and exposes
identifier-based lookups for downstream trajectory generation. All
coordinates are returned as (latitude_deg, longitude_deg) in WGS-84
(EPSG:4326).
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Callable

import geopandas as gpd
import pandas as pd

from .geodesy import compute_bearing, haversine_distance, project_point
from .turns import (
    MIN_TURN_DEG,
    bank_angle_deg,
    signed_turn_deg,
    turn_arc,
    turn_radius_nm,
)

logger = logging.getLogger(__name__)

_WAYPOINTS_LAYER = "waypoints"


class WaypointNotFoundError(LookupError):
    """Raised when a waypoint identifier is not present in the navdata."""

    def __init__(self, ident: str) -> None:
        self.ident = ident
        super().__init__(f"Waypoint {ident!r} not found in navdata")


class NavData:
    """Read-only accessor for the BearCat navigation GeoPackage.

    The waypoints layer is loaded once at construction; an in-memory
    ident → (lat, lon) index is built for O(1) lookups. Coordinates are
    WGS-84 degrees.
    """

    def __init__(
        self,
        gpkg_path: str | Path | None = None,
        *,
        sid_source: str | Path | None = None,
        star_source: str | Path | None = None,
        approach_source: str | Path | None = None,
        ils_source: str | Path | None = None,
        procedure_schema: "SidStarSchema | None" = None,
    ) -> None:
        """Load the waypoints layer and/or SID/STAR/approach procedure sources.

        Args:
            gpkg_path: Filesystem path to the BearCat navdata GeoPackage
                (e.g. "bearcat_navdata.gpkg") containing a "waypoints"
                layer with column `ident` (str) and POINT geometry in
                EPSG:4326. Optional — omit it to build a procedures-only
                accessor (the procedure legs carry their own coordinates).
            sid_source / star_source / approach_source: Explicit path to a
                SID / STAR / PBN-approach source that GeoPandas can read (e.g.
                the DFD ``sid_waypoint.geojson`` / ``star_waypoint.geojson``
                / ``pbn_waypoint.geojson``). When given, these override the
                GeoPackage layers. When omitted, procedures are read from the
                GeoPackage's ``sids``/``stars``/``approaches`` layers if a
                ``gpkg_path`` is set.
            procedure_schema: Overrides the layer/column names used to read
                the SID/STAR data (defaults to the ARINC 424 "DFD" schema —
                see :data:`DEFAULT_SIDSTAR_SCHEMA`).

        Procedures load lazily on the first ``lookup_procedure`` /
        ``list_procedures`` call; a missing source is not an error.
        """
        self._gpkg_path = Path(gpkg_path) if gpkg_path is not None else None
        if self._gpkg_path is not None:
            self._wpt_gdf: gpd.GeoDataFrame | None = gpd.read_file(
                self._gpkg_path, layer=_WAYPOINTS_LAYER
            )
            self._index: dict[str, tuple[float, float]] = self._build_index(
                self._wpt_gdf
            )
        else:
            self._wpt_gdf = None
            self._index = {}
        # SID/STAR state — loaded lazily so a waypoints-only source (or a
        # procedures-only accessor) still constructs without all layers.
        self._proc_schema: SidStarSchema = (
            procedure_schema or DEFAULT_SIDSTAR_SCHEMA
        )
        self._sid_source = Path(sid_source) if sid_source else None
        self._star_source = Path(star_source) if star_source else None
        self._approach_source = Path(approach_source) if approach_source else None
        # ILS / conventional approaches — merged INTO the approach layer as a
        # fallback so aerodromes with no published PBN approach (e.g. VYKP) are
        # still landable. Same DFD waypoint schema as the PBN source.
        self._ils_source = Path(ils_source) if ils_source else None
        self._proc_loaded = False
        # (airport, ProcedureType, procedure_name) -> list[_RawLeg], ordered
        # by seqno. Built on first procedure lookup.
        self._proc_index: dict[
            tuple[str, "ProcedureType", str], list["_RawLeg"]
        ] = {}

    @staticmethod
    def _build_index(
        gdf: gpd.GeoDataFrame,
    ) -> dict[str, tuple[float, float]]:
        """Build an ident → (lat_deg, lon_deg) lookup from the waypoints gdf.

        On duplicate idents, the first occurrence wins and subsequent
        rows are logged at DEBUG level. Real navdata can contain
        ambiguous idents across regions; disambiguation by country/type
        is out of scope for Phase 1.
        """
        index: dict[str, tuple[float, float]] = {}
        for ident, geom in zip(gdf["ident"], gdf.geometry, strict=True):
            if ident in index:
                logger.debug(
                    "Duplicate waypoint ident %s — keeping first occurrence",
                    ident,
                )
                continue
            index[ident] = (float(geom.y), float(geom.x))
        return index

    def lookup_waypoint(self, ident: str) -> tuple[float, float]:
        """Return (latitude_deg, longitude_deg) for a waypoint ident.

        Args:
            ident: ICAO waypoint identifier, e.g. "KARBI".

        Returns:
            (latitude_deg, longitude_deg) in WGS-84.

        Raises:
            WaypointNotFoundError: if `ident` is not in the navdata.
        """
        try:
            return self._index[ident]
        except KeyError:
            raise WaypointNotFoundError(ident) from None

    def lookup_waypoints_bulk(
        self, idents: list[str]
    ) -> dict[str, tuple[float, float]]:
        """Look up multiple waypoints at once, preserving input order.

        Args:
            idents: List of ICAO waypoint identifiers.

        Returns:
            Dict mapping each input ident to (latitude_deg,
            longitude_deg) in WGS-84. Insertion order matches `idents`.

        Raises:
            WaypointNotFoundError: on the first missing ident.
        """
        return {ident: self.lookup_waypoint(ident) for ident in idents}

    # --- SID/STAR procedures ---------------------------------------------

    def list_procedures(
        self, airport: str, proc_type: "ProcedureType | None" = None
    ) -> list[str]:
        """Procedure names published at an aerodrome (optionally one type).

        Returns an empty list if the GeoPackage has no procedure layers or
        none for that aerodrome.
        """
        self._load_procedures()
        airport_u = airport.strip().upper()
        return sorted(
            {
                n
                for (a, t, n) in self._proc_index
                if a == airport_u and (proc_type is None or t == proc_type)
            }
        )

    def lookup_procedure(
        self,
        airport: str,
        name: str,
        *,
        proc_type: "ProcedureType | None" = None,
        runway: str | None = None,
        transition: str | None = None,
    ) -> "Procedure":
        """Resolve a SID/STAR to ordered legs carrying alt/speed constraints.

        Args:
            airport: Aerodrome ICAO, e.g. "VYYY".
            name: Procedure identifier, e.g. "PARL1A".
            proc_type: Restrict to SID or STAR. If omitted and the name
                exists as both, :class:`AmbiguousProcedureError` is raised.
            runway: Runway designator for the runway-transition legs, e.g.
                "RW19L" or "19L". Required only when the procedure has
                runway-specific legs for more than one runway.
            transition: Enroute transition name (a fix). Required only when
                the procedure publishes more than one enroute transition.

        Returns:
            A :class:`Procedure` whose ``legs`` are ordered for the selected
            runway/transition (SID: runway -> common -> transition;
            STAR: transition -> common -> runway).

        Raises:
            ProcedureNotFoundError: no procedure matches (or the requested
                runway/transition is absent).
            AmbiguousProcedureError: the name resolves to both a SID and a
                STAR, or a runway/transition must be chosen but wasn't.
        """
        self._load_procedures()
        airport_u = airport.strip().upper()
        name_u = name.strip().upper()

        types = [proc_type] if proc_type is not None else list(ProcedureType)
        matches = [
            t for t in types if (airport_u, t, name_u) in self._proc_index
        ]
        if not matches:
            avail = sorted(
                {n for (a, _t, n) in self._proc_index if a == airport_u}
            )
            raise ProcedureNotFoundError(airport_u, name_u, available=avail)
        if len(matches) > 1:
            raise AmbiguousProcedureError(
                airport_u, name_u, [t.value for t in matches], "procedure type"
            )

        resolved_type = matches[0]
        raw_legs = self._proc_index[(airport_u, resolved_type, name_u)]
        return self._assemble_procedure(
            airport_u, name_u, resolved_type, raw_legs, runway, transition
        )

    def _read_proc_source(
        self, proc_type: "ProcedureType"
    ) -> "gpd.GeoDataFrame | None":
        """Read one procedure source — an explicit file path if given, else
        the matching layer of the GeoPackage. None if neither is available."""
        s = self._proc_schema
        explicit = {
            ProcedureType.SID: self._sid_source,
            ProcedureType.STAR: self._star_source,
            ProcedureType.APPROACH: self._approach_source,
        }[proc_type]
        layer = {
            ProcedureType.SID: s.sid_layer,
            ProcedureType.STAR: s.star_layer,
            ProcedureType.APPROACH: s.approach_layer,
        }[proc_type]
        try:
            if explicit is not None:
                gdf = gpd.read_file(explicit)
                # Fold the ILS/conventional approaches in as a FALLBACK: keep
                # every PBN approach as-is and add only ILS procedures that PBN
                # doesn't already publish (the ILS file also carries RNAV-named
                # approaches, so a blind concat would duplicate/clash them). PBN
                # wins; ILS fills the gaps (e.g. VYKP, which has no PBN approach).
                if (
                    proc_type is ProcedureType.APPROACH
                    and self._ils_source is not None
                    and self._ils_source.is_file()
                ):
                    try:
                        ils = gpd.read_file(self._ils_source)
                        ac = self._proc_schema.airport
                        pc = self._proc_schema.procedure
                        if ils is not None and len(ils) and ac in gdf.columns:
                            have = set(
                                zip(gdf[ac].astype(str), gdf[pc].astype(str))
                            )
                            mask = [
                                (str(a), str(p)) not in have
                                for a, p in zip(ils[ac], ils[pc])
                            ]
                            ils = ils[mask]
                            if len(ils):
                                gdf = gpd.GeoDataFrame(
                                    pd.concat([gdf, ils], ignore_index=True)
                                )
                    except Exception as exc:  # noqa: BLE001
                        logger.info("ILS approach source not available: %s", exc)
                return gdf
            if self._gpkg_path is not None:
                return gpd.read_file(self._gpkg_path, layer=layer)
        except Exception as exc:  # noqa: BLE001 — fiona raises various types
            logger.info(
                "Procedure source for %s not available: %s",
                proc_type.value,
                exc,
            )
        return None

    def _load_procedures(self) -> None:
        """Lazily read + index the SID / STAR / approach sources (once)."""
        if self._proc_loaded:
            return
        self._proc_loaded = True
        for proc_type in ProcedureType:
            gdf = self._read_proc_source(proc_type)
            if gdf is None or len(gdf) == 0:
                continue
            self._index_proc_layer(proc_type, gdf)
        # Each procedure's legs must be in published sequence order.
        for legs in self._proc_index.values():
            legs.sort(key=lambda lg: lg.seqno)

    def _index_proc_layer(
        self, proc_type: "ProcedureType", gdf: "pd.DataFrame"
    ) -> None:
        """Fold one SID/STAR layer into ``self._proc_index`` as _RawLegs."""
        s = self._proc_schema
        required = (s.airport, s.procedure, s.seqno)
        missing = [c for c in required if c not in gdf.columns]
        if missing:
            logger.warning(
                "%s layer missing required columns %s — skipped",
                proc_type.value,
                missing,
            )
            return
        for _, row in gdf.iterrows():
            get = row.get
            airport = _clean_str(get(s.airport)).upper()
            name = _clean_str(get(s.procedure)).upper()
            if not airport or not name:
                continue
            ident = _clean_str(get(s.waypoint_ident)) or None
            lat = _to_float(get(s.latitude))
            lon = _to_float(get(s.longitude))
            if ident is None or lat is None or lon is None:
                # Fixless leg (e.g. CA/VA/FM) or a data gap: keep the leg and
                # its constraints, but it carries no resolvable waypoint.
                ident, lat, lon = ident, None, None
            seqno = _to_float(get(s.seqno))
            leg = _RawLeg(
                seqno=int(seqno) if seqno is not None else 0,
                route_type=_clean_str(get(s.route_type)),
                transition=_clean_str(get(s.transition)),
                path_terminator=_clean_str(get(s.path_termination)).upper(),
                desc_code=_clean_str(get(s.waypoint_description_code)).upper()
                or None,
                ident=ident,
                lat=lat,
                lon=lon,
                altitude=parse_altitude_constraint(
                    get(s.altitude_description),
                    get(s.altitude1),
                    get(s.altitude2),
                ),
                speed=parse_speed_constraint(
                    get(s.speed_limit_description), get(s.speed_limit)
                ),
                turn_direction=_clean_str(get(s.turn_direction)) or None,
                magnetic_course=_to_float(get(s.magnetic_course)),
            )
            self._proc_index.setdefault(
                (airport, proc_type, name), []
            ).append(leg)

    def _assemble_procedure(
        self,
        airport: str,
        name: str,
        proc_type: "ProcedureType",
        raw_legs: "list[_RawLeg]",
        runway: str | None,
        transition: str | None,
    ) -> "Procedure":
        """Concatenate runway/common/transition leg groups in flight order."""
        runway_groups: dict[str, list[_RawLeg]] = {}
        trans_groups: dict[str, list[_RawLeg]] = {}
        common: list[_RawLeg] = []
        for leg in raw_legs:
            seg = _segment_of(proc_type, leg)
            if seg == "runway":
                runway_groups.setdefault(leg.transition.upper(), []).append(leg)
            elif seg == "transition":
                trans_groups.setdefault(leg.transition.upper(), []).append(leg)
            else:
                common.append(leg)

        chosen_runway = self._select_group(
            airport, name, runway_groups, runway, "runway"
        )
        chosen_trans = self._select_group(
            airport, name, trans_groups, transition, "transition"
        )
        rwy_legs = (
            runway_groups.get(chosen_runway, [])
            if chosen_runway is not None
            else []
        )
        trn_legs = (
            trans_groups.get(chosen_trans, [])
            if chosen_trans is not None
            else []
        )

        if proc_type is ProcedureType.SID:
            ordered = [*rwy_legs, *common, *trn_legs]
        elif proc_type is ProcedureType.APPROACH:
            # An approach flies the chosen IAF transition into the common
            # final segment. The runway is baked into the procedure name
            # (R09-Z), so there is no runway group. The common segment runs
            # past the runway/MAPt into the missed-approach hold; a landing
            # trajectory stops AT the MAPt, so truncate there.
            ordered = [*trn_legs, *_truncate_at_mapt(common)]
        else:  # STAR flies transition -> common -> runway
            ordered = [*trn_legs, *common, *rwy_legs]

        legs = tuple(
            ProcedureLeg(
                seqno=r.seqno,
                path_terminator=r.path_terminator,
                ident=r.ident,
                lat=r.lat,
                lon=r.lon,
                altitude=r.altitude,
                speed=r.speed,
                transition=r.transition or None,
                turn_direction=r.turn_direction,
                desc_code=r.desc_code,
                magnetic_course=r.magnetic_course,
            )
            for r in ordered
        )

        def _label(key: str | None) -> str | None:
            return None if key in (None, "", "ALL") else key

        return Procedure(
            airport=airport,
            name=name,
            proc_type=proc_type,
            runway=_label(chosen_runway),
            transition=_label(chosen_trans),
            legs=legs,
        )

    @staticmethod
    def _select_group(
        airport: str,
        name: str,
        groups: "dict[str, list[_RawLeg]]",
        requested: str | None,
        kind: str,
    ) -> str | None:
        """Pick the runway/transition group key; handle missing/ambiguous.

        A group keyed "" or "ALL" applies to every selection (it is the
        common case for procedures with a single runway/transition).
        """
        if not groups:
            return None  # procedure has no legs of this kind
        keys = set(groups)
        wildcard = next((k for k in keys if k in ("", "ALL")), None)
        if requested is not None:
            req = requested.strip().upper()
            # Accept "19L" as a match for "RW19L" on runway selection.
            primary = {req, f"RW{req}"} if kind == "runway" else {req}
            # A procedure serving both parallels of a pair is coded with the
            # ARINC "both" suffix (e.g. a STAR for 21L/21R is one RW21B group).
            # A request for either side (RW21L / RW21R) must match it — but
            # only after an exact same-side group, so a real per-side group
            # still wins. See the AIP: one STAR chart covers "RWY 21L/21R".
            both: set[str] = set()
            if kind == "runway":
                digits = "".join(ch for ch in req if ch.isdigit())
                if digits:
                    both.add(f"RW{digits}B")
            for cands in (primary, both):
                for k in keys:
                    if k in cands:
                        return k
            if wildcard is not None:
                return wildcard
            raise ProcedureNotFoundError(
                airport,
                name,
                detail=f"no {kind} {requested!r}",
                available=[k for k in keys if k not in ("", "ALL")],
            )
        real = [k for k in keys if k not in ("", "ALL")]
        if not real:
            return wildcard  # only a common/ALL group exists
        if len(real) == 1:
            return real[0]
        raise AmbiguousProcedureError(airport, name, real, kind)


@dataclass(frozen=True)
class RouteWaypoint:
    """One ordered point on an already-resolved route.

    Attributes:
        ident: ICAO waypoint identifier, e.g. "PARLA".
        lat: Latitude in decimal degrees, WGS-84.
        lon: Longitude in decimal degrees, WGS-84.
    """

    ident: str
    lat: float
    lon: float


# Columns the supervisor's airway-segment CSV must contain. Each row is one
# leg of a published airway: (waypoint_identifier -> waypoint_identifier_2),
# with both endpoints' coordinates and a `seqno` giving the leg order.
_CSV_REQUIRED_COLS = (
    "seqno",
    "waypoint_identifier",
    "waypoint_latitude",
    "waypoint_longitude",
    "waypoint_identifier_2",
    "waypoint_latitude_2",
    "waypoint_longitude_2",
)


def load_route_csv(
    csv_path: str | Path, *, reverse: bool = False
) -> list[RouteWaypoint]:
    """Load an already-resolved route from an airway-segment CSV.

    This is an alternative to ``NavData`` + ``parse_route`` for the case
    where the route is delivered pre-resolved as consecutive airway legs
    (e.g. ``VTPStoVTBS.csv``) instead of as an FPL route string plus a
    waypoint GeoPackage. Each CSV row is one leg
    ``waypoint_identifier -> waypoint_identifier_2``; rows are chained in
    ascending ``seqno`` order into a single ordered waypoint list.

    No coordinate is invented — every (lat, lon) is read straight from the
    CSV's ``waypoint_*`` / ``waypoint_*_2`` columns.

    Args:
        csv_path: Path to the airway-segment CSV.
        reverse: If True, return the route in reverse leg order. The CSV's
            natural ``seqno`` order is the airway's published order; pass
            ``reverse=True`` to fly it the other way.

    Returns:
        Ordered list of :class:`RouteWaypoint`. For N legs this yields the
        first leg's start fix followed by every leg's end fix (N + 1
        points), with consecutive duplicate idents collapsed.

    Raises:
        FileNotFoundError: if ``csv_path`` does not exist.
        ValueError: if required columns are missing or the file is empty.
    """
    path = Path(csv_path)
    if not path.is_file():
        raise FileNotFoundError(f"Route CSV not found: {path}")

    df = pd.read_csv(path)
    missing = [c for c in _CSV_REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(
            f"Route CSV {path} missing required columns: {missing}"
        )
    if df.empty:
        raise ValueError(f"Route CSV {path} contains no rows")

    # Order the legs. seqno is the airway sequence number; sorting on it
    # gives the canonical (published) leg order.
    df = df.sort_values("seqno").reset_index(drop=True)

    route: list[RouteWaypoint] = []

    def _append(ident: str, lat: float, lon: float) -> None:
        # Collapse the shared boundary fix between consecutive legs
        # (leg i's end == leg i+1's start).
        if route and route[-1].ident == ident:
            return
        route.append(RouteWaypoint(ident=ident, lat=float(lat), lon=float(lon)))

    prev_end_ident: str | None = None
    for row in df.itertuples(index=False):
        start_ident = str(row.waypoint_identifier)
        end_ident = str(row.waypoint_identifier_2)

        # Sanity check: legs should chain (this leg starts where the
        # previous one ended). Warn but keep going so a single data gap
        # doesn't abort the whole route.
        if prev_end_ident is not None and start_ident != prev_end_ident:
            logger.warning(
                "Route discontinuity: leg starts at %s but previous leg "
                "ended at %s — inserting a direct segment between them",
                start_ident,
                prev_end_ident,
            )

        _append(start_ident, row.waypoint_latitude, row.waypoint_longitude)
        _append(end_ident, row.waypoint_latitude_2, row.waypoint_longitude_2)
        prev_end_ident = end_ident

    if reverse:
        route.reverse()

    logger.info(
        "Loaded %d-waypoint route from %s (%s -> %s)",
        len(route),
        path.name,
        route[0].ident if route else "?",
        route[-1].ident if route else "?",
    )
    return route


# ===========================================================================
# SID/STAR terminal procedures (ARINC 424 "DFD" schema)
# ===========================================================================
#
# SUBTASK 5 — source schema. Coded terminal procedures are NOT in the
# airways/waypoints AIP cache, so they come from ARINC 424 "DFD" layers
# (for VY: converted from the AIXM 5.1.1 export). We target the Navigraph "DFD" layout — the schema the
# repo's existing column names (waypoint_identifier / waypoint_latitude /
# seqno) already follow — but every layer and column name is overridable via
# :class:`SidStarSchema`, so pointing this at a differently-named GeoPackage
# (or the real bearcat_navdata.gpkg when it lands) is a one-line change.
#
# Each row in a `sids`/`stars` layer is ONE leg of a procedure. A full
# procedure for a chosen runway + enroute transition is assembled by
# concatenating three leg groups, split by ``route_type``:
#   SID : runway-transition legs -> common legs -> enroute-transition legs
#   STAR: enroute-transition legs -> common legs -> runway-transition legs
# Legs are ordered within each group by ``seqno``.


@dataclass(frozen=True)
class SidStarSchema:
    """Layer + column names for the SID/STAR procedure layers.

    Defaults match the ARINC 424 "DFD" GeoPackage. Override any field to
    adapt to a GeoPackage that names things differently.
    """

    sid_layer: str = "sids"
    star_layer: str = "stars"
    approach_layer: str = "approaches"
    airport: str = "airport_identifier"
    procedure: str = "procedure_identifier"
    route_type: str = "route_type"
    transition: str = "transition_identifier"
    seqno: str = "seqno"
    waypoint_ident: str = "waypoint_identifier"
    latitude: str = "waypoint_latitude"
    longitude: str = "waypoint_longitude"
    path_termination: str = "path_termination"
    waypoint_description_code: str = "waypoint_description_code"
    altitude_description: str = "altitude_description"
    altitude1: str = "altitude1"
    altitude2: str = "altitude2"
    speed_limit: str = "speed_limit"
    speed_limit_description: str = "speed_limit_description"
    turn_direction: str = "turn_direction"
    magnetic_course: str = "magnetic_course"


DEFAULT_SIDSTAR_SCHEMA = SidStarSchema()


class ProcedureType(str, Enum):
    """Kind of terminal procedure."""

    SID = "SID"
    STAR = "STAR"
    APPROACH = "APPROACH"


#: ARINC 424 leg types that end on a HEADING or a manual termination rather
#: than on a fix: VM/FM (fly a heading/course until ATC intervenes — how an
#: "open" STAR hands the arrival to radar vectors), VI (heading to an intercept)
#: and VR (heading to a radial). Nothing on the ground marks where they end, so
#: they contribute no waypoint — see :attr:`ProcedureLeg.has_fix`.
VECTOR_TERMINATED = frozenset({"VM", "FM", "VI", "VR"})


class AltitudeConstraintType(str, Enum):
    """How a leg's altitude(s) constrain the crossing altitude."""

    NONE = "NONE"
    AT = "AT"
    AT_OR_ABOVE = "AT_OR_ABOVE"
    AT_OR_BELOW = "AT_OR_BELOW"
    BETWEEN = "BETWEEN"  # alt1 = upper bound, alt2 = lower bound


class SpeedConstraintType(str, Enum):
    """How a leg's speed limit constrains the crossing speed."""

    NONE = "NONE"
    AT = "AT"
    AT_OR_ABOVE = "AT_OR_ABOVE"
    AT_OR_BELOW = "AT_OR_BELOW"


@dataclass(frozen=True)
class AltitudeConstraint:
    """A crossing-altitude constraint (feet)."""

    type: AltitudeConstraintType = AltitudeConstraintType.NONE
    alt1_ft: float | None = None
    alt2_ft: float | None = None  # only meaningful for BETWEEN (lower bound)

    @property
    def is_constrained(self) -> bool:
        return self.type is not AltitudeConstraintType.NONE


@dataclass(frozen=True)
class SpeedConstraint:
    """A crossing-speed constraint (knots)."""

    type: SpeedConstraintType = SpeedConstraintType.NONE
    speed_kt: float | None = None

    @property
    def is_constrained(self) -> bool:
        return self.type is not SpeedConstraintType.NONE


@dataclass(frozen=True)
class ProcedureLeg:
    """One leg of a terminal procedure, in published sequence order.

    A leg may be "fixless": ARINC path/terminators such as CA (Course to
    Altitude), VA (Heading to Altitude) or FM/VM (manual termination) end on
    an altitude/heading rather than a named fix. Such legs still carry their
    constraints but have ``ident``/``lat``/``lon`` = None and are skipped by
    :meth:`Procedure.waypoints`.
    """

    seqno: int
    path_terminator: str  # ARINC 424 leg type, e.g. "IF", "TF", "CF", "CA"
    ident: str | None
    lat: float | None
    lon: float | None
    altitude: AltitudeConstraint
    speed: SpeedConstraint
    transition: str | None = None
    turn_direction: str | None = None
    #: ARINC 424 waypoint description code (4 chars). Its 4th char flags the
    #: approach fix role — ``F`` = FAF, ``M`` = MAPt. Present on PBN approach
    #: legs; ``None`` for SID/STAR sources that don't carry the column.
    desc_code: str | None = None
    #: Published course to fly, degrees MAGNETIC. Carried by the leg types that
    #: are defined by a course rather than by a fix (CA/CF/VA); ``None``
    #: otherwise. :func:`expand_sid_departure` converts it to true.
    magnetic_course: float | None = None

    @property
    def has_fix(self) -> bool:
        """Does this leg end on a fix the aircraft can actually fly to?

        A vector-terminated leg does not, however the source data is filled in.
        An "open" STAR ends its runway transition with a VM ("heading to a
        manual termination") — the arrival is handed to radar vectors there —
        and the DFD export codes that leg with the AERODROME as its waypoint
        (e.g. ``<fix> -> VM <aerodrome>``). Taken at face value the aircraft
        flies over the middle of the airport, then back out to the approach's
        IAF and round again. It is not a fix; it is the absence of one.
        """
        if self.path_terminator in VECTOR_TERMINATED:
            return False
        return (
            self.ident is not None
            and self.lat is not None
            and self.lon is not None
        )


@dataclass(frozen=True)
class Procedure:
    """A resolved SID or STAR for a specific runway + transition selection."""

    airport: str
    name: str
    proc_type: ProcedureType
    runway: str | None
    transition: str | None
    legs: tuple[ProcedureLeg, ...]

    @property
    def vector_termination(self) -> "ProcedureLeg | None":
        """The vector-terminated leg this procedure ENDS on, if any.

        An arrival is either *closed* — every leg ends on a fix, so the STAR
        delivers the aircraft to the approach's IAF and no controller input is
        needed — or *open*: its last leg is a VM/FM ("fly this heading until
        further advised"), which is the published hand-off to radar vectors.
        Doc 4444 §8.9.3.5 calls that leg the start of the vectored initial and
        intermediate approach phases.

        Every published VY (Myanmar) STAR is closed; the open case is kept
        for data that has it (and is exercised by a synthetic VYYY fixture in
        the tests: arrivals handed over on a published heading of 034° when
        landing on 21, 214° when landing on 03 — the downwind the aircraft
        holds until turned onto final). Returns ``None`` for a closed
        procedure.
        """
        if not self.legs:
            return None
        last = self.legs[-1]
        return last if last.path_terminator in VECTOR_TERMINATED else None

    @property
    def is_open(self) -> bool:
        """True when the procedure ends in radar vectors rather than at a fix —
        i.e. it cannot reach the runway without a vector-to-final path."""
        return self.vector_termination is not None

    def last_fix(self) -> "RouteWaypoint | None":
        """The final flyable fix — where an open procedure's vector leg begins
        (the hand-over fix), and the last fix of a closed one."""
        pts = self.waypoints()
        return pts[-1] if pts else None

    def waypoints(self) -> list[RouteWaypoint]:
        """Ordered fix waypoints (fixless legs dropped, dup idents collapsed)."""
        out: list[RouteWaypoint] = []
        for leg in self.legs:
            if not leg.has_fix:
                continue
            if out and out[-1].ident == leg.ident:
                continue
            out.append(
                RouteWaypoint(
                    ident=leg.ident,  # type: ignore[arg-type]
                    lat=leg.lat,  # type: ignore[arg-type]
                    lon=leg.lon,  # type: ignore[arg-type]
                )
            )
        return out


@dataclass(frozen=True)
class RunwayEnd:
    """A runway's landing threshold: where a departure's take-off roll starts.

    Sourced from the ARINC 424 runway table (``runway.csv``), which publishes
    the threshold coordinates and the runway's bearing both magnetic and true —
    the pair gives the local magnetic variation for free.
    """

    icao: str
    ident: str  # e.g. "RW21L"
    lat: float
    lon: float
    magnetic_bearing: float
    true_bearing: float

    @property
    def magnetic_variation(self) -> float:
        """Degrees to ADD to a magnetic course to make it true (east +)."""
        return (self.true_bearing - self.magnetic_bearing + 180.0) % 360.0 - 180.0


#: (ICAO, normalised runway ident) -> RunwayEnd. Populated at startup from the
#: ARINC runway table (see api.server._register_runways); empty otherwise, in
#: which case a departure simply isn't anchored to its threshold.
_RUNWAY_ENDS: dict[tuple[str, str], RunwayEnd] = {}


def _norm_runway_ident(runway: str) -> str:
    """'21L' / 'RW21L' / 'rw21l' -> 'RW21L' — the key _RUNWAY_ENDS is held on."""
    r = (runway or "").strip().upper().replace(" ", "")
    if r and not r.startswith("RW"):
        r = "RW" + r
    return r


def register_runways(runways: "list[RunwayEnd]") -> None:
    """Merge runway threshold geometry into the lookup :func:`runway_end` uses."""
    for rwy in runways:
        _RUNWAY_ENDS[(rwy.icao.upper(), _norm_runway_ident(rwy.ident))] = rwy


def runway_ends(icao: str) -> list[RunwayEnd]:
    """Every runway end on record at an aerodrome, in ident order. An ARINC
    "both" group (``RW21B``) is not an end of its own and is left out."""
    key = icao.upper()
    return sorted(
        (
            r
            for (ap, ident), r in _RUNWAY_ENDS.items()
            if ap == key and not re.fullmatch(r"RW\d{2}B", ident)
        ),
        key=lambda r: r.ident,
    )


def pick_runway_for_track(icao: str, track_deg: float) -> RunwayEnd | None:
    """The runway end whose true bearing is closest to ``track_deg``.

    With no wind or ATC assignment to go on, the runway a synthetic flight
    should use is the one that points the way it is going: a departure takes
    off towards its first fix (bearing from the field to that fix), an arrival
    lands straight on from the direction it arrives (bearing from its last
    fix to the field). Picking any other end makes it take off away from its
    route, or fly round the field to land. ``None`` when the aerodrome has no
    runway on record.
    """
    ends = runway_ends(icao)
    if not ends:
        return None
    return min(ends, key=lambda r: abs(signed_turn_deg(r.true_bearing, track_deg)))


def runway_end(icao: str, runway: str | None) -> RunwayEnd | None:
    """Threshold geometry for a runway, or ``None`` if it isn't on record.

    An ARINC "both" group (``RW21B``, meaning 21L *and* 21R) has no single
    threshold and resolves to ``None`` — the caller falls back to not anchoring
    the departure.
    """
    if not runway:
        return None
    return _RUNWAY_ENDS.get((icao.upper(), _norm_runway_ident(runway)))


#: ARINC 424 leg types that terminate on an ALTITUDE rather than on a fix: CA
#: (course to altitude), VA (heading to altitude), FA (fix to altitude). The
#: source data carries them with no coordinates, so they are the legs
#: :func:`expand_sid_departure` has to give a position to.
#:
#: Such a leg is ALWAYS flown over: it ends the moment the altitude is made, so
#: the turn onto the next fix cannot begin before that point — an aircraft that
#: cut the corner would be turning below the altitude the procedure requires.
ALTITUDE_TERMINATED = frozenset({"CA", "VA", "FA"})

#: A course-to-altitude leg is never allowed to collapse to nothing: even if the
#: climb model says the altitude is already made, keep the aircraft on the
#: runway track this far past the previous fix before it may turn.
_MIN_ALT_LEG_NM = 0.5

#: Fallback length for an altitude-terminated leg whose target altitude or climb
#: model is unavailable — roughly a jet's distance to 1 500 ft at 200 kt.
_NOMINAL_ALT_LEG_NM = 2.5


def expand_sid_departure(
    sid: "Procedure",
    runway: "RunwayEnd | None",
    climb_distance_nm: "Callable[[float], float] | None" = None,
) -> "Procedure":
    """Give a SID's departure legs the ground track the AIP actually depicts.

    DFD SID data codes the initial climb as a fixless CA leg — e.g. VYYY
    PARL1A's RW21 "course to 610 ft" — which :meth:`Procedure.waypoints`
    drops because it has no coordinates. What's left is the runway-end fix
    (DE21L) followed straight by the first en-route fix, so the aircraft turns
    the moment it leaves the ground and cuts diagonally back across the runway.

    This restores the published geometry by:

    * **prepending the departure threshold** (``RW21L``) as the SID's first fix,
      so the take-off roll runs down the runway centreline instead of starting
      at the aerodrome reference point (which sits off to one side); and
    * **giving each altitude-terminated leg a fix**, projected from the previous
      fix along the leg's course — converted from magnetic to true using the
      runway's own published bearings — at the distance the climb model needs to
      reach the leg's altitude. The aircraft therefore flies runway heading
      until it genuinely has 1 500 ft, and only then turns for the first fix.

    The synthesised legs keep their published altitude/speed restrictions, so
    the "at or above 1 500 ft" and "MAX IAS 200 KT" limits now reach the
    vertical/speed profile as well — before, they were discarded with the leg.

    Args:
        sid: The resolved departure procedure.
        runway: Threshold geometry for the departure runway (:func:`runway_end`).
            ``None`` — unknown runway — leaves the procedure untouched.
        climb_distance_nm: ``altitude_ft -> NM from the threshold at which the
            climb passes it``, normally
            :func:`trajectory_sim.performance.climb_distance_nm` bound to the
            aircraft type, departure elevation and cruise level. ``None`` falls
            back to a nominal leg length.

    Returns:
        A new :class:`Procedure` with the same identity and the expanded legs.
        Returned unchanged when there is no runway to anchor to.
    """
    if runway is None or sid.proc_type is not ProcedureType.SID:
        return sid

    thr = RouteWaypoint(ident=runway.ident, lat=runway.lat, lon=runway.lon)
    legs: list[ProcedureLeg] = [
        ProcedureLeg(
            seqno=0,
            path_terminator="IF",
            ident=thr.ident,
            lat=thr.lat,
            lon=thr.lon,
            altitude=AltitudeConstraint(),
            speed=SpeedConstraint(),
            transition=runway.ident,
        )
    ]
    # Where the aircraft is when it starts the leg being placed, and how far it
    # has flown from the threshold to get there — the climb model measures its
    # distance-to-altitude from the threshold, so the leg only has to cover
    # what's left of it.
    prev_lat, prev_lon = thr.lat, thr.lon
    flown_nm = 0.0

    for leg in sid.legs:
        if leg.has_fix:
            flown_nm += haversine_distance(
                prev_lat, prev_lon, leg.lat, leg.lon  # type: ignore[arg-type]
            )
            prev_lat, prev_lon = leg.lat, leg.lon  # type: ignore[assignment]
            legs.append(leg)
            continue
        if leg.path_terminator not in ALTITUDE_TERMINATED:
            legs.append(leg)  # VI/VM/FM — still fixless, still skipped downstream
            continue

        # Course is published magnetic; the runway's magnetic/true bearing pair
        # gives the local variation. A leg with no course flies runway heading.
        course = (
            (leg.magnetic_course + runway.magnetic_variation) % 360.0
            if leg.magnetic_course is not None
            else runway.true_bearing
        )
        target_ft = leg.altitude.alt1_ft or leg.altitude.alt2_ft
        if climb_distance_nm is not None and target_ft is not None:
            leg_nm = max(climb_distance_nm(target_ft) - flown_nm, _MIN_ALT_LEG_NM)
        else:
            leg_nm = _NOMINAL_ALT_LEG_NM
        lat, lon = project_point(prev_lat, prev_lon, course, leg_nm)
        legs.append(
            replace(
                leg,
                ident=f"({int(target_ft)})" if target_ft else f"({leg.path_terminator})",
                lat=lat,
                lon=lon,
            )
        )
        flown_nm += leg_nm
        prev_lat, prev_lon = lat, lon

    return replace(sid, legs=tuple(legs))


#: How far the aircraft flies straight on runway heading before the synthetic
#: departure turn starts — long enough that the turn doesn't begin before the
#: wheels are up, short enough to stay close to the field. Not derived from
#: anything published (there is no procedure to publish it): a nominal
#: wings-level segment, roughly 15-20s at the low-altitude turn speed this
#: heuristic uses. The arrival side has its own geometry, a final approach
#: on the extended centreline (see :func:`runway_arrival_pattern`).
RUNWAY_HEURISTIC_INITIAL_LEG_NM = 1.0

#: A synthetic-turn source that is NOT a published procedure. Every point
#: :func:`expand_runway_departure_heuristic` / :func:`runway_arrival_pattern`
#: invent carries an empty ident except the runway threshold
#: itself (same convention as :func:`expand_sid_departure`'s prepended
#: threshold) — callers that need to tell a heuristic track apart from a real
#: SID/STAR/approach do it from whether these functions were even called, not
#: from anything on the points themselves; see ``dep_trajectory_source`` /
#: ``arr_trajectory_source`` in ``api/server.py``.
RUNWAY_HEURISTIC_SOURCE = "RUNWAY_HEURISTIC"

def expand_runway_departure_heuristic(
    runway: "RunwayEnd",
    first_fix: "tuple[float, float]",
    turn_speed_kt: float,
    bank_deg: float | None = None,
    initial_leg_nm: float = RUNWAY_HEURISTIC_INITIAL_LEG_NM,
) -> "list[tuple[str, float, float]] | None":
    """A plausible departure ground track off a runway with no coded SID.

    Sparse Myanmar procedure coverage means most domestic departures have a
    known runway but nothing published to fly off it, and without this the
    aircraft starts at the aerodrome reference point and cuts straight for the
    first en-route fix — a straight line through the runway rather than a
    departure. This gives it the same SHAPE a coded SID would (runway
    threshold, a short leg on runway heading, then a turn onto track) using
    only the runway's own geometry — never a fabricated procedure: nothing
    here is stored or reported as a SID (see ``RUNWAY_HEURISTIC_SOURCE``).

    Built from :func:`~trajectory_sim.turns.turn_arc` — the same "cross a fix
    on an inbound track, roll into a banked turn, hold it until established on
    the target" primitive :mod:`trajectory_sim.turns` already uses for a
    published DF leg — so a bad or degenerate geometry (the first fix falls
    inside the turn circle, the turn would have to be a near-reversal) is
    already handled: :func:`turn_arc` returns no points and this returns
    ``None``, telling the caller to keep its existing straight-line fallback
    rather than splice in broken geometry.

    Args:
        runway: Departure threshold geometry (:func:`runway_end`).
        first_fix: ``(lat, lon)`` of the first fix the route actually files —
            what the turn has to roll out established on.
        turn_speed_kt: TAS to fly the turn at — sets its radius. The caller
            derives this the same way as any other turn in the route (see
            ``_turn_speed_kt`` in ``api/server.py``), so a heavy jet still
            turns wider than a turboprop.
        bank_deg: Maximum bank for the turn. Defaults to the same PANS-OPS
            SID/terminal figure (25°, see :func:`bank_angle_deg`) an actual
            coded departure turn would be limited to — not a new number.
        initial_leg_nm: Length of the wings-level segment flown on runway
            heading before the turn starts.

    Returns:
        ``[(runway.ident, thr_lat, thr_lon), ("", lat, lon), ...]`` — the
        runway threshold, the point ``initial_leg_nm`` down the runway
        heading, and (when a turn is needed) the arc from there to established
        on ``first_fix``. The caller still flies the final straight leg from
        the last of these points to ``first_fix`` itself. ``None`` when no
        safe turn geometry exists — fall back to the existing DCT behaviour.
    """
    if bank_deg is None:
        bank_deg = bank_angle_deg("sid")

    initial_lat, initial_lon = project_point(
        runway.lat, runway.lon, runway.true_bearing, initial_leg_nm
    )
    points: list[tuple[str, float, float]] = [
        (runway.ident, runway.lat, runway.lon),
        ("", initial_lat, initial_lon),
    ]

    bearing_to_fix = compute_bearing(initial_lat, initial_lon, *first_fix)
    turn_deg = signed_turn_deg(runway.true_bearing, bearing_to_fix)
    if abs(turn_deg) < MIN_TURN_DEG:
        # Already tracking toward the fix on runway heading — nothing to turn.
        return points

    direction = "R" if turn_deg > 0 else "L"
    radius_nm = turn_radius_nm(turn_speed_kt, bank_deg=bank_deg)
    arc = turn_arc(
        initial_lat, initial_lon, runway.true_bearing,
        first_fix[0], first_fix[1],
        direction, radius_nm,
    )
    if not arc:
        return None
    points.extend(("", lat, lon) for lat, lon in arc)
    return points


#: Where the synthetic arrival joins the extended centreline, from the
#: threshold. 10 NM on a 3° glide is ~3 000 ft above the runway — a normal
#: final approach fix height — so the aircraft is established on final, wings
#: level, well before it lands. Not published for any runway (there is no
#: procedure to publish it); a nominal straight-in final.
RUNWAY_FINAL_NM = 10.0

#: How far to the side of the centreline the base leg (and the downwind, when
#: one is flown) runs. Wide enough for a 90° turn onto final at circuit speed
#: to fit without cutting inside the join point.
RUNWAY_BASE_OFFSET_NM = 5.0

#: Largest angle at which the arrival may join the final directly. Beyond
#: this the join is a turn too steep to roll out on the centreline, so the
#: aircraft flies a base leg (and a downwind, from the far side) first.
_STRAIGHT_IN_MAX_DEG = 60.0


def runway_arrival_pattern(
    runway: "RunwayEnd",
    from_ll: "tuple[float, float]",
    final_nm: float = RUNWAY_FINAL_NM,
    base_nm: float = RUNWAY_BASE_OFFSET_NM,
) -> "list[tuple[str, float, float]]":
    """The corners of a synthetic arrival onto a runway with no coded
    STAR/approach, ending on the threshold.

    The aircraft never lands across the runway or at the aerodrome reference
    point: it always finishes on ``final_nm`` of the extended centreline,
    flown on the runway's own true bearing to the threshold. How it gets onto
    that final depends on where it comes from (``from_ll``: the route's last
    en-route fix, or the departure aerodrome when there is none):

    * **straight-in** — already within ``_STRAIGHT_IN_MAX_DEG`` of the final
      course: direct to the join point, then final;
    * **base** — off to one side: a base leg ``base_nm`` out on that side,
      perpendicular to final, then a 90° turn onto it;
    * **downwind** — from beyond the far end of the runway: a downwind abeam
      the threshold on the side it is already on, then base, then final.

    Only corners — the caller turns them into arcs like any other route, at
    the speed of an aircraft low in the circuit. Same convention as the
    departure heuristic: every point carries an empty ident (nothing here is a
    published fix), and it is never reported as a STAR or approach (see
    ``RUNWAY_HEURISTIC_SOURCE``).

    Returns:
        ``[("", lat, lon), ..., ("", thr_lat, thr_lon)]`` — the join point is
        always the second-to-last corner and the threshold the last.
    """
    recip = (runway.true_bearing + 180.0) % 360.0
    join = project_point(runway.lat, runway.lon, recip, final_nm)
    threshold = ("", runway.lat, runway.lon)

    to_join = compute_bearing(from_ll[0], from_ll[1], join[0], join[1])
    beyond_join = haversine_distance(
        runway.lat, runway.lon, from_ll[0], from_ll[1]
    ) > final_nm
    if beyond_join and abs(signed_turn_deg(runway.true_bearing, to_join)) <= _STRAIGHT_IN_MAX_DEG:
        return [("", *join), threshold]

    # Which side of the centreline the aircraft is on, seen looking out along
    # the final from the threshold: the base (and downwind) run on that side,
    # so the aircraft never crosses the final to reach them.
    side_deg = signed_turn_deg(
        recip, compute_bearing(runway.lat, runway.lon, from_ll[0], from_ll[1])
    )
    lateral = recip + (90.0 if side_deg >= 0 else -90.0)
    base = project_point(join[0], join[1], lateral, base_nm)
    corners = [("", *base), ("", *join), threshold]
    if abs(side_deg) > 90.0:
        # From the far side of the field: fly down its side first, abeam the
        # threshold, rather than cut across the runway to reach the base.
        downwind = project_point(runway.lat, runway.lon, lateral, base_nm)
        corners.insert(0, ("", *downwind))
    return corners


def _collapse_consecutive_idents(
    waypoints: "list[RouteWaypoint]",
) -> list[RouteWaypoint]:
    """Drop a waypoint whose ident equals the one immediately before it.

    The first occurrence wins (its coordinates are kept). This is the single
    primitive every join in this module relies on: a shared boundary fix
    listed by both sides of a join collapses to one point. Same rule used by
    :meth:`Procedure.waypoints` and :func:`load_route_csv`.
    """
    out: list[RouteWaypoint] = []
    for wp in waypoints:
        if out and out[-1].ident == wp.ident:
            continue
        out.append(wp)
    return out


#: How far into ``addition``'s head the overshoot fallback looks for the shared
#: join fix — an IAF/entry fix sits at the very start, so a small window keeps a
#: coincidental match deep in the procedure from triggering the trim.
_OVERLAP_HEAD_WINDOW = 4


def _join_collapsing_overlap(
    base: "list[RouteWaypoint]",
    addition: "list[RouteWaypoint]",
    *,
    max_overshoot: int = 0,
) -> list[RouteWaypoint]:
    """Append ``addition`` to ``base``, collapsing a shared boundary that spans
    more than one fix.

    A procedure often *re-lists* fixes the arriving/departing route already
    flew, and those fixes can appear one or two deep into the procedure, not
    just as its first fix:

    * **enroute → STAR**: the route ends ``… HOTEL, SABAI`` and STAR SABA1B
      begins ``HOTEL, SABAI, ARMUS`` → a plain concatenation gives
      ``… HOTEL, SABAI, HOTEL, SABAI, ARMUS`` (fly back and forth).
    * **… → approach**: the STAR ends at the IF (``PILEX``) and the approach's
      IAF transition is ``MESUX → PILEX`` → ``… PILEX, MESUX, PILEX, …``.

    A consecutive-duplicate collapse can't fix either — the repeated run isn't
    two *adjacent* equal idents. So: if ``base``'s LAST fix already appears
    anywhere in ``addition``, start ``addition`` right *after* its first
    occurrence — the route joins the procedure at the fix it has actually
    reached, dropping the lead-in it would otherwise re-fly. With no such
    overlap (a route that ends short of the procedure) the whole thing is
    appended as published. The shared fix's coordinates come from ``base``
    (first-occurrence wins, the rule every join here uses).

    ``max_overshoot`` handles the mirror case, where ``base`` runs *past* the
    shared fix. A STAR can end a fix or two beyond the IAF the approach
    re-enters at — e.g. a STAR that ends ``… BARON, CI27`` (CI27 a runway-
    centreline fix) while the approach begins ``BARON, HK580, …``. Anchoring on
    ``base[-1]`` (CI27, absent from the approach) would append the whole
    approach and re-fly BARON: ``… BARON, CI27, BARON, HK580`` — a loop. When
    ``base``'s last fix isn't found, look back up to ``max_overshoot`` fixes
    into ``base``'s tail for one that reappears at the head of ``addition``;
    join there, dropping both ``base``'s overshoot (CI27) and ``addition``'s
    lead-in → ``… BARON, HK580``. Bounded so it only trims a genuine procedure
    overshoot, never legitimate route fixes. Idents compare case-insensitively:
    the two sides come from different source files with no shared casing
    guarantee.
    """
    if not base or not addition:
        return list(base) + list(addition)
    last = base[-1].ident.upper()
    for i, wp in enumerate(addition):
        if wp.ident.upper() == last:
            return list(base) + list(addition[i + 1 :])
    # Overshoot fallback: a fix a little before base's end re-enters at the
    # head of the addition. Nearest-to-the-end match wins (drops the least).
    head = addition[:_OVERLAP_HEAD_WINDOW]
    for b in range(2, max_overshoot + 2):
        if b > len(base):
            break
        bf = base[-b].ident.upper()
        for i, wp in enumerate(head):
            if wp.ident.upper() == bf:
                return list(base[: len(base) - b + 1]) + list(addition[i + 1 :])
    return list(base) + list(addition)


def splice_procedures(
    enroute: "list[RouteWaypoint]",
    *,
    sid: "Procedure | None" = None,
    star: "Procedure | None" = None,
    approach: "Procedure | None" = None,
) -> list[RouteWaypoint]:
    """Splice a SID before, and a STAR + approach after, the enroute fixes.

    Produces the ordered fix sequence that runs *between* the aerodromes —
    SID fixes first (they begin just after ADEP), then the enroute fixes,
    then the STAR fixes, then the PBN approach fixes (which end at the runway/
    MAPt, just before ADES). The caller anchors ADEP and ADES around the
    result; this function never invents an aerodrome point.

    The joins are where a SID/STAR meets the enroute portion:

    * **SID → enroute** (subtask 5): a SID's last fix is its enroute
      transition fix (e.g. DAGAB). An Item-15 route conventionally *starts*
      at that same fix, so listing it on both sides would duplicate it; the
      duplicate is collapsed. If the route starts elsewhere, both are kept
      and the leg between them stands as a direct join.
    * **enroute → STAR** (subtask 4): a STAR's first fix is its enroute
      entry fix (e.g. LADAR), which an Item-15 route conventionally *ends*
      on — same collapse on the trailing boundary.

    Args:
        enroute: Resolved enroute fixes, in flight order (may be empty for a
            terminal-to-terminal hop with no published enroute portion).
        sid: Departure procedure for ADEP, already resolved to a runway +
            transition. ``None`` when no SID applies (direct departure).
        star: Arrival procedure for ADES, likewise resolved. ``None`` when no
            STAR applies (direct arrival).
        approach: PBN instrument-approach for ADES, resolved to the landing
            runway + IAF transition and already truncated at the MAPt. Its IAF
            typically coincides with the STAR's last fix (e.g. PAKSU), so the
            boundary collapses. ``None`` when no approach applies.

    Returns:
        The spliced :class:`RouteWaypoint` sequence with shared boundary
        fixes (and any other consecutive duplicate idents) collapsed. When
        both ``sid`` and ``star`` are ``None`` this is the enroute list with
        consecutive duplicates removed — i.e. direct routing is a no-op join.
    """
    # Every join uses the overlap collapse (not a plain extend): a procedure
    # that re-lists fixes the route already flew joins at the fix actually
    # reached, so a shared multi-fix boundary (e.g. the route's tail HOTEL,
    # SABAI vs STAR SABA1B's lead-in HOTEL, SABAI, or a STAR ending at the IF
    # vs an approach's IAF transition into that IF) never doubles back.
    sequence: list[RouteWaypoint] = []
    if sid is not None:
        sequence = _join_collapsing_overlap(sequence, sid.waypoints())
    sequence = _join_collapsing_overlap(sequence, enroute)
    if star is not None:
        sequence = _join_collapsing_overlap(sequence, star.waypoints())
    if approach is not None:
        # Join the approach where its IAF entry fix sits on the arrival, trimming
        # the STAR back to that fix. The STAR can run SEVERAL fixes past the
        # entry the approach re-enters at — e.g. a STAR that flies
        # STONE, CIDER, BARON, CI27 while an approach entered at STONE begins
        # STONE, MALIN, …; without the trim the splice loops back
        # (STONE, CIDER, BARON, CI27, STONE, MALIN). Bound the look-back to the
        # STAR's own length so it can reach any STAR fix but never trims an
        # enroute one.
        star_len = len(star.waypoints()) if star is not None else 0
        sequence = _join_collapsing_overlap(
            sequence, approach.waypoints(), max_overshoot=max(2, star_len)
        )
    return _collapse_consecutive_idents(sequence)


class ProcedureNotFoundError(LookupError):
    """Raised when no procedure matches the requested key."""

    def __init__(
        self,
        airport: str,
        name: str,
        *,
        detail: str = "",
        available: list[str] | None = None,
    ) -> None:
        self.airport = airport
        self.name = name
        self.available = available or []
        msg = f"Procedure {name!r} not found at {airport!r}"
        if detail:
            msg += f": {detail}"
        if self.available:
            msg += f" (available: {', '.join(sorted(self.available))})"
        super().__init__(msg)


class AmbiguousProcedureError(LookupError):
    """Raised when a lookup matches several procedures/runways/transitions."""

    def __init__(
        self, airport: str, name: str, candidates: list[str], kind: str
    ) -> None:
        self.airport = airport
        self.name = name
        self.candidates = candidates
        self.kind = kind
        super().__init__(
            f"Ambiguous {kind} for procedure {name!r} at {airport!r}: "
            f"specify one of {', '.join(sorted(candidates))}"
        )


@dataclass(frozen=True)
class _RawLeg:
    """Untyped leg row (post-schema-mapping) used during assembly."""

    seqno: int
    route_type: str
    transition: str
    path_terminator: str
    ident: str | None
    lat: float | None
    lon: float | None
    altitude: AltitudeConstraint
    speed: SpeedConstraint
    turn_direction: str | None
    desc_code: str | None = None
    magnetic_course: float | None = None


def _clean_str(value: object) -> str:
    """NaN/None-safe string, surrounding whitespace stripped."""
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value).strip()


def _to_float(value: object) -> float | None:
    """Best-effort float; returns None for blank/NaN/non-numeric input."""
    s = _clean_str(value)
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return None if math.isnan(f) else f


def parse_altitude_constraint(
    description: object, altitude1: object, altitude2: object
) -> AltitudeConstraint:
    """Map ARINC ``altitude_description`` + altitude1/2 to a typed constraint.

    Description codes (ARINC 424 5.29):
        "@"/blank -> AT       "+" -> AT_OR_ABOVE      "-" -> AT_OR_BELOW
        "B"       -> BETWEEN  (altitude1 = upper bound, altitude2 = lower)
    Other codes (G/H/I/J/V/X/Y — glideslope/step-down variants) collapse to
    AT on altitude1, a safe over-constraint for a fast-time sim.
    """
    a1 = _to_float(altitude1)
    a2 = _to_float(altitude2)
    desc = _clean_str(description)
    if a1 is None and a2 is None:
        return AltitudeConstraint(AltitudeConstraintType.NONE)
    if desc == "+":
        return AltitudeConstraint(AltitudeConstraintType.AT_OR_ABOVE, a1)
    if desc == "-":
        return AltitudeConstraint(AltitudeConstraintType.AT_OR_BELOW, a1)
    if desc == "B":
        return AltitudeConstraint(AltitudeConstraintType.BETWEEN, a1, a2)
    # "@", blank, or an unhandled code: a hard AT on the primary altitude.
    return AltitudeConstraint(AltitudeConstraintType.AT, a1)


def parse_speed_constraint(
    description: object, speed_limit: object
) -> SpeedConstraint:
    """Map ARINC ``speed_limit`` + description to a typed speed constraint.

    A SID/STAR speed limit is conventionally a maximum; DFD encodes the
    sense in ``speed_limit_description``:
        blank/"-" -> AT_OR_BELOW      "+" -> AT_OR_ABOVE      "@" -> AT
    A zero/blank ``speed_limit`` means no constraint.
    """
    spd = _to_float(speed_limit)
    if spd is None or spd <= 0:
        return SpeedConstraint(SpeedConstraintType.NONE)
    desc = _clean_str(description)
    if desc == "+":
        return SpeedConstraint(SpeedConstraintType.AT_OR_ABOVE, spd)
    if desc == "@":
        return SpeedConstraint(SpeedConstraintType.AT, spd)
    # blank or "-": the usual "at or below" terminal speed restriction.
    return SpeedConstraint(SpeedConstraintType.AT_OR_BELOW, spd)


# route_type segmentation. ARINC 424 5.7 route types group a procedure's
# legs; the exact code letters vary between source datasets, so we classify
# into three buckets and fall back to the transition_identifier shape when a
# code is unrecognised.
_SID_RUNWAY_TYPES = frozenset({"0", "1", "4", "F", "T"})
_SID_COMMON_TYPES = frozenset({"2", "5", "M", "S"})
_SID_TRANS_TYPES = frozenset({"3", "6", "V"})
_STAR_TRANS_TYPES = frozenset({"1", "4", "7", "F"})
_STAR_COMMON_TYPES = frozenset({"2", "5", "8", "M", "S"})
_STAR_RUNWAY_TYPES = frozenset({"3", "6", "9", "R"})
# PBN approach: route_type 'A' = an IAF transition (IAF -> IF), 'R' = the
# common final segment (transition None: IF -> FAF -> MAPt -> missed). The
# landing runway is encoded in the procedure name (R09-Z), so there is no
# separate runway group.
_APPROACH_TRANS_TYPES = frozenset({"A"})
_APPROACH_COMMON_TYPES = frozenset({"R"})


def _is_runway_transition(name: str) -> bool:
    """True if a transition_identifier names a runway (e.g. RW19L, RW27)."""
    return name.upper().startswith("RW")


def _is_mapt_leg(leg: _RawLeg) -> bool:
    """True if an approach leg is the Missed Approach Point.

    The ARINC 424 waypoint description code's 4th column is ``M`` at the MAPt
    (e.g. ``EY M`` at MR09, ``GY M`` at RW09).
    """
    dc = leg.desc_code or ""
    return len(dc) >= 4 and dc[3] == "M"


def _truncate_at_mapt(common: list[_RawLeg]) -> list[_RawLeg]:
    """Cut an approach's final segment at the MAPt (inclusive).

    A landing trajectory ends at the runway/MAPt; everything after it is the
    missed-approach (hold), which is dropped. If no MAPt marker is present the
    segment is returned unchanged (defensive — better a full path than none).
    """
    for i, leg in enumerate(common):
        if _is_mapt_leg(leg):
            return common[: i + 1]
    return common


def _segment_of(proc_type: ProcedureType, raw: _RawLeg) -> str:
    """Classify a leg into 'runway' | 'common' | 'transition'."""
    rt = raw.route_type.upper()
    seg: str | None = None
    if proc_type is ProcedureType.SID:
        if rt in _SID_RUNWAY_TYPES:
            seg = "runway"
        elif rt in _SID_TRANS_TYPES:
            seg = "transition"
        elif rt in _SID_COMMON_TYPES:
            seg = "common"
    elif proc_type is ProcedureType.APPROACH:
        if rt in _APPROACH_TRANS_TYPES:
            seg = "transition"
        elif rt in _APPROACH_COMMON_TYPES:
            seg = "common"
    else:
        if rt in _STAR_RUNWAY_TYPES:
            seg = "runway"
        elif rt in _STAR_TRANS_TYPES:
            seg = "transition"
        elif rt in _STAR_COMMON_TYPES:
            seg = "common"
    # A "common" leg that names a RUNWAY in its transition_identifier is not
    # common at all. A DFD export (the VY one included) can code each
    # runway-specific SID/STAR variant as a single route_type 5 group and
    # state the runway only in transition_identifier — so the procedure ends
    # up with no runway group, and a requested runway has nothing to be
    # checked against: a SID coded RW03 resolved happily for RW21, and the runway-filtered
    # picker and the suggestion endpoint both answered with a SID the aircraft
    # cannot fly off that runway. The transition_identifier is what the source
    # actually states about this leg; trust it over the route_type bucket.
    # (APPROACH is exempt: its runway is baked into the name, and its final
    # segment legitimately runs through RWnn as a *waypoint*, not a group.)
    if (
        seg == "common"
        and proc_type is not ProcedureType.APPROACH
        and raw.transition
        and _is_runway_transition(raw.transition)
    ):
        return "runway"
    if seg is not None:
        return seg
    # Unknown route_type code: infer from the transition_identifier shape.
    tr = raw.transition
    if not tr or tr.upper() == "ALL":
        return "common"
    if _is_runway_transition(tr):
        return "runway"
    return "transition"
