"""FastAPI server: run the real trajectory_sim Phase 1 pipeline for the web.

Endpoints
---------
GET  /api/health
POST /api/generate                  -> stats + route + points + download URLs
GET  /api/download/{flight_key}.{ext}  (ext = gpkg | csv | geojson)

Run (from the project root, with the venv active):
    uvicorn api.server:app --reload --port 8000

Everything numeric comes from `trajectory_sim` (pyproj.Geod / WGS-84) — no
geodesy is re-implemented here. GeoPackage export is the genuine one written
by `trajectory_sim.output.write_geopackage`.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import tempfile
import threading
import zipfile
from collections import OrderedDict
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

import pandas as pd
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from trajectory_sim.fpl import FlightPlan, parse_eobt, parse_route
from trajectory_sim.geodesy import (
    compute_bearing,
    haversine_distance,
    route_distance_nm,
)
from trajectory_sim.tactical import splice_tactical_extension
from trajectory_sim.vectors import VectorToFinal, plan_open_star_join
from trajectory_sim.navdata import (
    ALTITUDE_TERMINATED,
    AltitudeConstraintType,
    AmbiguousProcedureError,
    NavData,
    Procedure,
    ProcedureNotFoundError,
    ProcedureType,
    RouteWaypoint,
    RunwayEnd,
    SpeedConstraintType,
    expand_sid_departure,
    register_runways,
    runway_end,
    splice_procedures,
)
from trajectory_sim.airspace import sector_columns
from trajectory_sim.output import (
    assign_waypoint_column,
    build_trajectory_gdf,
    write_csv,
    write_geopackage,
)
from trajectory_sim.performance import (
    PERFORMANCE_SOURCE,
    aircraft_speeds,
    estimator_types,
    cas_to_tas_kt,
    climb_distance_nm,
    crossover_altitude_ft,
    field_elevation_ft,
    get_speed_restriction,
    reachable_ceiling_ft,
    register_field_elevations,
    register_runway_elevations,
    runway_threshold_elevation_ft,
    set_speed_restriction,
    set_speed_schedule,
    target_tas_kt,
    tune_speed_schedule,
)
from trajectory_sim.trajectory import RouteConstraint, build_flight_timeline
from trajectory_sim.turns import (
    MAX_FLYBY_DEG,
    MIN_TURN_DEG,
    bank_angle_deg,
    flyby_arc,
    signed_turn_deg,
    turn_arc,
    turn_radius_nm,
)
from trajectory_sim.validation import (
    REFERENCE_MARGIN_MIN,
    CAT62Reference,
    estimate_sim_min,
)
from trajectory_sim.performance import UnknownAircraftPerformance

# Project root = parent of this `api/` package.
_ROOT = Path(__file__).resolve().parent.parent
_DATA = _ROOT / "web" / "public" / "data"
# VY (Myanmar) navdata, built once per AIRAC cycle from the AIXM 5.1.1
# export by scripts/ingest_aixm_waypoints.py (waypoints + airways +
# airports, same shape as the retired Thai aip_VT.json this replaces — see
# that script's docstring for why the coordinates couldn't come from
# anywhere else already in the pipeline).
_AIP_PATH = _DATA / "aip_VY.json"
_OUT_DIR = _ROOT / "api" / "_outputs"
_OUT_DIR.mkdir(parents=True, exist_ok=True)

# Cache-Control for the rarely-changing reference endpoints (procedures).
# This navdata only changes per AIRAC cycle (~28 days) and a new cycle means
# a redeploy/restart anyway, so the browser/CDN may safely keep it for a day —
# repeat SID/STAR clicks and look-ups then skip the network entirely.
# Dynamic endpoints (/api/generate*, /api/download*) are deliberately NOT
# given this header: their output depends on the user's FPL input.
_STATIC_CACHE = "public, max-age=86400"  # 1 day

def _sq_dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

app = FastAPI(title="Flight Trajectory Generator API", version="1.0")

# Allowed browser origins:
#   - any localhost port  (dev server falls back to :3001/:3002… if busy)
#   - any *.vercel.app    (the deployed Next.js front-end, incl. previews)
#   - explicit origins from $WEB_ORIGIN  (comma-separated; custom domains)
# $WEB_ORIGIN whitelists production/custom domains without a code change on
# the API host. Set WEB_ORIGIN="*" to allow every origin (handy for a quick
# deploy of this non-sensitive tool — it sends no cookies/credentials).
_web_origin_env = os.environ.get("WEB_ORIGIN", "").strip()
_extra_origins = [o.strip() for o in _web_origin_env.split(",") if o.strip()]
if "*" in _extra_origins:
    # Wildcard: allow any origin. Safe here because the API uses no
    # credentials; allow_credentials stays False so "*" is permitted.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_extra_origins,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+|https://[\w-]+\.vercel\.app",
        allow_methods=["*"],
        allow_headers=["*"],
    )


class GenerateRequest(BaseModel):
    """Inputs from the web GeneratorPanel."""

    source: str = Field("csv", description='"csv" or "fpl"')
    # CSV mode: True => VTSP->VTBS (reverse of the file's seqno order).
    vtsp_to_vtbs: bool = True
    # Departure / destination ICAO. These now actually drive direction
    # and the written meta (previously hardcoded for fpl mode).
    adep: str = "VTBS"
    ades: str = "VTSP"
    # ICAO aircraft type designator (e.g. "B738", "A333"). Drives the BADA
    # climb/descent rate table, speed schedule, service ceiling and
    # crossover altitude. Unknown types fall back to the B738 model inside
    # trajectory_sim.performance, so any value is accepted.
    actype: str = "B738"
    # FPL mode: raw Item-15 route string.
    route: str = "DCT MOTNA DCT SABIS DCT VANKO DCT"
    callsign: str = "SIM738"
    # ISO 8601; naive values are treated as UTC (project-wide rule).
    eobt: str = "2026-01-03T08:15:00"
    gs_kt: float = 450.0
    # Requested Flight Level in hundreds of feet (FL330 -> 330). Drives
    # the Phase 2 vertical profile (altitude + climb/cruise/descent).
    rfl: int = 330
    # TRANSIT level, in hundreds of feet. Set for a flight that is only passing
    # through the area: already at this level when it reaches the FIRST fix of
    # the route, and (unless it lands at an aerodrome the AIP knows) still at it
    # at the last. Without it every route starts on the ground at its first fix
    # and climbs — which for an FIR-crossing track filed only by its crossing
    # fixes puts an aircraft at 0 ft on top of every other flight that enters at
    # the same fix. None/0 = an ordinary flight from the ground (unchanged).
    entry_fl: int | None = None
    # 0-based index when several routes are flown under the same
    # (callsign, EOBT). Used to suffix the flight_key (e.g. "_R2") so
    # each file/PK is unique; the Callsign column itself stays the
    # user-typed value. Omit for a single-route request.
    flight_index: int | None = None

    # --- SID/STAR terminal procedures (Phase 4) ----------------------
    # Optional procedure names to splice around the enroute route: the SID
    # is resolved at ADEP and inserted right after departure, the STAR at
    # ADES and inserted right before arrival. Runway/transition are
    # optional — when omitted, an ambiguous choice is auto-resolved to the
    # first candidate and reported in `warnings` (same behaviour as the
    # map's click-to-load). An unknown procedure is skipped with a warning,
    # never a hard error, so a bad name can't sink the generation.
    sid: str | None = None
    sid_runway: str | None = None
    sid_transition: str | None = None
    star: str | None = None
    star_runway: str | None = None
    star_transition: str | None = None
    # PBN instrument approach (IAP) at ADES, e.g. "R09-Z". Its landing runway
    # is encoded in the name, so it reuses ``star_runway`` for the runway; the
    # IAF transition auto-picks from the STAR's terminal fix (or set it here).
    approach: str | None = None
    approach_transition: str | None = None
    # Take radar vectors to final instead of flying the published procedure to
    # the runway. Only an OPEN STAR (one ending in a VM "expect vectors" leg)
    # can be vectored; on any other arrival this is ignored with a warning.
    #
    # This is the CONFLICT branch of the arrival flow. With no conflict an
    # arrival stays on the procedure — STAR to its last fix, then the approach
    # from its IAF — so this defaults off. Setting `extend_downwind_nm` implies
    # it, since a downwind can only be extended under vectors.
    vector_to_final: bool | None = None
    # Extra track distance (NM) to absorb on the vector-to-final of an OPEN
    # STAR — the arrival sequencer's spacing deficit, flown as a longer
    # downwind before the turn onto final ("maintain heading until separation",
    # Doc 4444 §8.9.3.6).
    extend_downwind_nm: float | None = None
    # Apply `extend_downwind_nm` TACTICALLY — as an instruction to an aircraft
    # already at the hand-over fix — rather than re-planning the whole flight
    # with a longer route. Without this the re-plan pushes top-of-descent back,
    # so the aircraft passes the hand-over fix thousands of feet higher and the
    # extra track is flown in the cruise band; the delay the extension was meant
    # to buy is then mostly lost. See trajectory_sim.tactical.
    tactical_extend: bool | None = None

    # --- Optional speed-schedule overrides (Phase 3 tuning) -----------
    # Any field left None keeps the airframe's default. Applied per
    # request and restored afterwards, so one user's tuning never leaks
    # into another's generation.
    climb_cas_kt: float | None = None
    climb_mach: float | None = None
    cruise_mach: float | None = None
    descent_mach: float | None = None
    descent_cas_kt: float | None = None
    # Below-FL100 CAS cap (default 250 kt). Pass a large value to lift it.
    restrict_cas_kt: float | None = None

    # --- Surveillance Profile (output sampling cadence) --------------
    # Seconds between emitted track points (and therefore between the UTC
    # timestamps in the exported files). 5 s = en-route radar (default),
    # 4 s = CAT62 terminal surveillance, 1 s = high-rate. This only changes
    # the OUTPUT density — the underlying timeline is integrated at a fine
    # internal step, so flight time / CAT62 validation are unaffected.
    output_every_s: float = Field(5.0, ge=0.5, le=60.0)


# Per-airframe speed tuning mutates module-level state in
# trajectory_sim.performance; serialise generation so concurrent
# requests (FastAPI runs sync endpoints in a threadpool) can't see each
# other's overrides mid-build. Generation is fast, so a lock is cheap.
_GEN_LOCK = threading.Lock()

# Lazy export cache. Generation used to write three files per route (a
# GeoPackage + GeoJSON via slow GDAL drivers, plus a CSV) eagerly — ~3×
# the routes in disk writes on every "Generate all", even though the UI
# only needs the JSON it returns. The download/zip/combined endpoints are
# the only file consumers, so we now defer writing: generation stashes the
# GeoDataFrame + the bits needed to render each format here, and a file is
# materialised on first download (see `_materialise`). Keyed by flight_key,
# bounded so a long session can't grow without limit; an evicted entry just
# means its file is rebuilt only if still cached (else treated as "never
# generated", same as before).
_EXPORT_CACHE: "OrderedDict[str, dict[str, object]]" = OrderedDict()
_EXPORT_CACHE_MAX = 4000  # headroom for the multi-thousand-flight network case


def _cache_export(
    flight_key: str,
    gdf: object,
    route_str: str,
    rfl: float,
    route_feature: dict[str, object],
    request: "GenerateRequest | None" = None,
) -> None:
    """Stash everything needed to write this route's files on demand.

    The originating REQUEST is kept alongside so a flight can be re-flown with a
    tactical change (see ``/api/extend``) without the client having to hold the
    spec. It cannot rebuild one from the response: the resolved ``route`` is a
    fix list, not the Item-15 string, and for a vectored arrival it carries the
    invented TURN/INTC fixes, which are not routable input.
    """
    _EXPORT_CACHE[flight_key] = {
        "gdf": gdf,
        "request": request,
        "route_str": route_str,
        "rfl": rfl,
        "route_feature": route_feature,
    }
    _EXPORT_CACHE.move_to_end(flight_key)
    while len(_EXPORT_CACHE) > _EXPORT_CACHE_MAX:
        _EXPORT_CACHE.popitem(last=False)

    # Invalidate any stale on-disk export for this flight_key. `_materialise`
    # serves an existing file as-is, so without this a re-generation under the
    # same (callsign, EOBT) — hence the same flight_key/filename — would keep
    # handing back the OLD file (e.g. the previous Surveillance cadence). A
    # fresh gdf must replace its files, so drop them now and let the next
    # download rewrite them from this cache entry.
    _drop_files(flight_key)


def _drop_files(flight_key: str) -> None:
    """Delete this flight's materialised export files, so the next download
    re-renders them from the (now changed) cache entry."""
    for _ext in _MEDIA:
        stale = _OUT_DIR / f"{flight_key}.{_ext}"
        if stale.exists():
            try:
                stale.unlink()
            except OSError:
                pass  # best-effort; _materialise rewrites gpkg defensively too

# CAT62 reference times, loaded once. Falls back to an empty table if the
# bundled file is somehow missing, so the endpoint never hard-fails.
try:
    _CAT62_REF = CAT62Reference.load()
except Exception:  # noqa: BLE001
    _CAT62_REF = CAT62Reference({})

# Default airframe when a request omits the type. The actual type flown is
# read per-request from GenerateRequest.actype; speed-tuning snapshots
# target whatever type the flight uses.
_DEFAULT_ACTYPE = "B738"


@lru_cache(maxsize=1)
def _aip() -> dict[str, object]:
    """Load the CAAT eAIP navdata cache (built by scripts/ingest_aip.py).

    Cached for the process lifetime — the file only changes per AIRAC
    cycle, which means a redeploy/restart anyway.
    """
    if not _AIP_PATH.is_file():
        raise RuntimeError(
            f"AIP navdata cache missing at {_AIP_PATH}. "
            "Run: python scripts/ingest_aip.py --airac <YYYY-MM-DD>"
        )
    return json.loads(_AIP_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _airway_waypoint_index() -> dict[str, tuple[float, float]]:
    """ident -> (lat, lon) from the AIP significant points + airway fixes."""
    waypoints = _aip()["waypoints"]
    return {
        ident: (float(w["lat"]), float(w["lon"]))
        for ident, w in waypoints.items()  # type: ignore[union-attr]
    }


@lru_cache(maxsize=1)
def _airways() -> dict[str, list[str]]:
    """designator -> ordered ident sequence, straight from the AIP cache."""
    return {
        desig: list(seq)
        for desig, seq in _aip()["airways"].items()  # type: ignore[union-attr]
    }


@lru_cache(maxsize=1)
def _airports() -> dict[str, dict[str, object]]:
    """ICAO -> {lat, lon, elev_ft?, name?} from the AIP AD section."""
    return {
        icao: dict(info)  # type: ignore[arg-type]
        for icao, info in _aip().get("airports", {}).items()  # type: ignore[union-attr]
    }


def _airport_ll(icao: str) -> tuple[float, float] | None:
    """Aerodrome reference point (lat, lon) from the AIP, or None."""
    a = _airports().get(icao)
    if a and "lat" in a and "lon" in a:
        return (float(a["lat"]), float(a["lon"]))  # type: ignore[arg-type]
    return None


def _register_field_elevations() -> None:
    """Push AIP aerodrome elevations into the performance model so the
    climb/descent profile uses real field elevations for every Thai
    airport, not just the three hardcoded in performance.py."""
    elevs = {
        icao: float(a["elev_ft"])  # type: ignore[arg-type]
        for icao, a in _airports().items()
        if "elev_ft" in a
    }
    if elevs:
        register_field_elevations(elevs)


# Thai AIP AD 2 runway-threshold elevation table. Repo-root file (where it
# is maintained); trajectory_sim/data is a shipped fallback for deployment.
_RWY_ELEV_PATHS = (
    _ROOT / "thai_aip_ad2_thr_elevations.csv",
    _ROOT / "trajectory_sim" / "data" / "thai_aip_ad2_thr_elevations.csv",
)


def _register_runway_elevations() -> None:
    """Push AIP runway-threshold elevations into the performance model so a
    flight's climb starts / descent ends at the actual departure/arrival
    runway threshold (e.g. VTSP RW09 = 22 ft, VTBD RW21L = 6.4 ft) rather
    than the aerodrome's single field elevation."""
    path = next((p for p in _RWY_ELEV_PATHS if p.exists()), None)
    if path is None:
        return
    elevs: dict[tuple[str, str], float] = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            icao = (row.get("ICAO") or "").strip()
            rwy = (row.get("RWY_NR") or "").strip()
            raw = (row.get("THR_elev_ft") or "").strip()
            if not icao or not rwy or not raw:
                continue  # NIL/blank threshold — no elevation on record
            try:
                elevs[(icao, rwy)] = float(raw)
            except ValueError:
                continue
    if elevs:
        register_runway_elevations(elevs)


# ARINC 424 runway table: threshold coordinates + magnetic/true bearing.
_RUNWAY_SOURCE = _DATA / "airports" / "runway.csv"


def _register_runways() -> None:
    """Push runway threshold geometry into the nav-data model so a departure
    rolls down the runway centreline (VTBD RW21L = 13.9246N 100.6155E, 208.6°T)
    and its SID's course-to-altitude legs can be placed on that track — see
    :func:`trajectory_sim.navdata.expand_sid_departure`."""
    if not _RUNWAY_SOURCE.exists():
        return
    runways: list[RunwayEnd] = []
    with _RUNWAY_SOURCE.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            icao = (row.get("airport_identifier") or "").strip().upper()
            ident = (row.get("runway_identifier") or "").strip().upper()
            if not icao or not ident:
                continue
            try:
                runways.append(
                    RunwayEnd(
                        icao=icao,
                        ident=ident,
                        lat=float(row["runway_latitude"]),
                        lon=float(row["runway_longitude"]),
                        magnetic_bearing=float(row["runway_magnetic_bearing"]),
                        true_bearing=float(row["runway_true_bearing"]),
                    )
                )
            except (KeyError, TypeError, ValueError):
                continue  # incomplete row — that runway just isn't anchored
    if runways:
        register_runways(runways)


# Inject real AIP field + runway elevations and runway geometry at startup.
# Guarded so a missing cache (fresh checkout before the first ingest) never
# blocks boot.
try:
    _register_field_elevations()
except Exception:  # noqa: BLE001 — fall back to the hardcoded set
    pass
try:
    _register_runway_elevations()
except Exception:  # noqa: BLE001 — fall back to field elevations
    pass
try:
    _register_runways()
except Exception:  # noqa: BLE001 — departures just aren't runway-anchored
    pass


# VOR/DME navaids, for spotting a route that ends on a terminal VOR. The bundled
# airway_vor.geojson is a global set; only the Thai-area idents matter here.
_VOR_SOURCE = _DATA / "airways" / "airway_vor.geojson"


@lru_cache(maxsize=1)
def _vor_idents() -> frozenset[str]:
    """Idents of VOR/DME navaids inside the Thai FIR (from airway_vor.geojson).

    Used only to recognise a route that has been filed to a VOR; a miss just
    means no trim happens, so a parse failure degrades to 'not a VOR'.
    """
    if not _VOR_SOURCE.is_file():
        return frozenset()
    idents: set[str] = set()
    try:
        fc = json.loads(_VOR_SOURCE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    for f in fc.get("features", []):
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") == "MultiPoint":
            coords = coords[0] if coords else []
        if len(coords) < 2:
            continue
        lon, lat = coords[0], coords[1]
        if 5.0 < lat < 21.0 and 96.0 < lon < 106.0:  # Thai FIR bbox
            ident = (f.get("properties") or {}).get("waypoint_identifier")
            if ident:
                idents.add(ident.upper())
    return frozenset(idents)


#: A VOR nearer than this to the destination (NM) is that field's terminal
#: navaid — the one a route is filed to as shorthand for "the airport". A VOR
#: farther out (e.g. VTUD routed via KKN, 55 NM away) is just a fix on the way,
#: not a terminal overshoot, so it is left alone.
_FIELD_VOR_NM = 10.0

#: How far off the route's arrival bearing a procedure entry may sit and still
#: count as "the side the aircraft is coming from" (degrees, either way). An
#: entry beyond this is on the far side of the aerodrome, so joining it would
#: fly the aircraft over the field and back — the doubling-back
#: :func:`_connect_route_to_terminal` exists to remove. 90° = the arrival
#: hemisphere, which keeps every same-side IAF in play and drops the opposite
#: ones (VTSF RW01 reached on 060°: TAWIT 025° stays, CHARY 165° goes).
_ENTRY_ARRIVAL_SIDE_DEG = 90.0


def _ends_at_field_vor(
    route_pts: "list[tuple[str, float, float]]", ades: str
) -> bool:
    """True when the route's last fix is the destination's own terminal VOR.

    That is the overshoot pattern this module trims: an Item-15 route filed to
    the field VOR (RAN, NKS, LPN, BKK), which sits past the STAR/approach entry
    so flying to it doubles the aircraft back. A route ending on an ordinary
    fix, or on a VOR far from the field, is not touched.
    """
    if not route_pts:
        return False
    ident, lat, lon = route_pts[-1]
    if ident.upper() not in _vor_idents():
        return False
    ades_ll = _airport_ll(ades)
    return (
        ades_ll is not None
        and haversine_distance(lat, lon, ades_ll[0], ades_ll[1]) < _FIELD_VOR_NM
    )


def _airway_sequence(designator: str) -> list[str]:
    """Ordered fix sequence for an airway (e.g. 'Y8'), or [] if unknown."""
    return _airways().get(designator, [])


def _airway_route_points(
    designator: str, reverse: bool
) -> list[tuple[str, float, float]]:
    """Resolve an airway to (ident, lat, lon) points, optionally reversed.

    Used by CSV-mode generation: the published Y8 sequence is BKK→PUT, so
    ``reverse=True`` (VTSP→VTBS) flips it.
    """
    index = _airway_waypoint_index()
    pts = [
        (ident, *index[ident])
        for ident in _airway_sequence(designator)
        if ident in index
    ]
    return list(reversed(pts)) if reverse else pts


_FIX_TOKEN_RE = re.compile(r"^[A-Z]{2,5}$")


def _expand_airways(route_str: str) -> str:
    """Inject intermediate airway fixes into an Item-15 route string.

    Walks the tokens left-to-right and, whenever it sees a
    `<fix> <airway> <fix>` triple where the airway is known and both
    endpoints sit on it, splices the intervening fixes in between. The
    airway designator itself is left in place — `parse_route` will drop
    it as before, so existing parsing is unchanged for non-airway
    routes.
    """
    airways = _airways()
    tokens = route_str.split()
    # Collapse slash-separated airway alternatives published in the AIP
    # ("Y22/Y23", "W5/W6") to the first option — the route string keeps the
    # slash for display fidelity, but a single airway is actually flown.
    tokens = [t.split("/")[0] if "/" in t else t for t in tokens]
    out: list[str] = []
    i = 0
    while i < len(tokens):
        out.append(tokens[i])
        # Pattern: <fix> <airway> <fix>
        if (
            i + 2 < len(tokens)
            and _FIX_TOKEN_RE.match(tokens[i])
            and tokens[i + 1] in airways
            and _FIX_TOKEN_RE.match(tokens[i + 2])
        ):
            seq = airways[tokens[i + 1]]
            a_ident, b_ident = tokens[i], tokens[i + 2]
            if a_ident in seq and b_ident in seq:
                a = seq.index(a_ident)
                b = seq.index(b_ident)
                step = 1 if a < b else -1
                for k in range(a + step, b, step):
                    out.append(seq[k])
        i += 1
    return " ".join(out)


@app.get("/api/health")
def health() -> dict[str, object]:
    info: dict[str, object] = {"ok": True, "aip_present": _AIP_PATH.is_file()}
    if _AIP_PATH.is_file():
        try:
            aip = _aip()
            info["airac"] = aip.get("airac")
            info["waypoint_count"] = aip.get("waypoint_count")
            info["airway_count"] = aip.get("airway_count")
        except Exception:  # noqa: BLE001 — health must never 500
            info["ok"] = False
    return info


@app.get("/api/cat62_reference")
def cat62_reference() -> dict[str, object]:
    """Flight-time reference table + acceptance threshold for the web.

    Lets the route picker pre-screen candidate routes (PASS/FAIL within
    the threshold) without round-tripping each one through /api/generate.
    """
    return {
        "threshold_min": _CAT62_REF.threshold_min,
        "routes": _CAT62_REF.table(),
        # Types the flight-time estimate can be derived for. Anything else
        # gets no estimate rather than another airframe's numbers.
        "estimator_types": sorted(estimator_types()),
        "performance_source": PERFORMANCE_SOURCE,
    }


#: Distances (NM) the client-side flight-time curve is sampled at. Denser
#: where the profile bends (short hops that never reach cruise), sparse in
#: the linear cruise-dominated range.
_CURVE_DISTANCES_NM: tuple[float, ...] = (
    0, 20, 40, 60, 80, 100, 130, 160, 200, 260, 320,
    400, 500, 650, 800, 1000, 1300,
)


@app.get("/api/flight_time_curve")
def flight_time_curve(
    actype: str = "",
    cruise_alt_ft: float | None = None,
) -> dict[str, object]:
    """Distance to flight-time curve for ONE airframe at ONE cruise level.

    The route picker interpolates this to pre-screen candidate routes
    without a /api/generate round-trip each. It replaces the hard-coded
    B738 table the client used to carry: the curve is computed here with
    the same estimator the server validates with, so client and server
    always agree, and an airframe with no Thai APM data of its own comes
    back ``supported: false`` instead of a 737 curve wearing its name.
    """
    ac = actype.strip().upper()
    if not ac:
        return {"aircraft_type": "", "supported": False,
                "reason": "no aircraft type given", "points": []}
    try:
        points = [
            [d, round(estimate_sim_min(d, ac, cruise_alt_ft=cruise_alt_ft), 2)]
            for d in _CURVE_DISTANCES_NM
        ]
    except UnknownAircraftPerformance as exc:
        return {"aircraft_type": ac, "supported": False,
                "reason": str(exc), "points": []}
    return {
        "aircraft_type": ac,
        "supported": True,
        "dataset": PERFORMANCE_SOURCE,
        "cruise_alt_ft": cruise_alt_ft,
        "reachable_ceiling_ft": reachable_ceiling_ft(ac),
        "margin_min": REFERENCE_MARGIN_MIN,
        "points": points,
    }


# --- SID/STAR procedures ----------------------------------------------------
# Coded terminal procedures come from the AIXM 5.1.1 export (AIRAC 2609, VY —
# Myanmar), converted to the DFD GeoJSON schema by
# scripts/ingest_aixm_procedures.py. NavData reads + indexes them on first
# use. (The VT/Thai equivalents still sit under aixm/ — see that folder if
# this deployment ever needs to switch back.)
_SID_SOURCE = _DATA / "aixm_vy" / "sid_waypoint.geojson"
_STAR_SOURCE = _DATA / "aixm_vy" / "star_waypoint.geojson"
_APPROACH_SOURCE = _DATA / "aixm_vy" / "pbn_waypoint.geojson"
# ILS / conventional approaches — a fallback so aerodromes with no PBN approach
# are still landable. Merged into the approach layer.
_ILS_SOURCE = _DATA / "aixm_vy" / "ils_wp.geojson"


@lru_cache(maxsize=1)
def _navdata() -> NavData:
    """Procedures-only NavData accessor over the DFD SID/STAR/approach GeoJSON."""
    return NavData(
        sid_source=_SID_SOURCE if _SID_SOURCE.is_file() else None,
        star_source=_STAR_SOURCE if _STAR_SOURCE.is_file() else None,
        approach_source=_APPROACH_SOURCE if _APPROACH_SOURCE.is_file() else None,
        ils_source=_ILS_SOURCE if _ILS_SOURCE.is_file() else None,
    )


class _RouteCtx(NamedTuple):
    """What the en-route route tells us about the right terminal-procedure
    transition: every route fix ident, plus the endpoint that connects to the
    procedure — the route's LAST fix for a STAR/approach (its entry), FIRST for
    a SID."""

    idents: frozenset
    end_ident: str | None
    end_ll: "tuple[float, float] | None"


def _route_ctx(
    route_pts: "list[tuple[str, float, float]]",
    proc_type: "ProcedureType",
) -> "_RouteCtx | None":
    """Build the route context for picking ``proc_type``'s transition.

    For an approach the ``route_pts`` should already include the STAR's fixes,
    so its last fix (the STAR's terminal fix, e.g. KALIM) is the connecting
    point the approach's IAF transition is scored against.
    """
    if not route_pts:
        return None
    idents = frozenset(p[0].upper() for p in route_pts)
    end = route_pts[0] if proc_type is ProcedureType.SID else route_pts[-1]
    return _RouteCtx(idents, end[0].upper(), (end[1], end[2]))


def _score_transition(
    nav: NavData,
    airport: str,
    name: str,
    proc_type: "ProcedureType | None",
    runway: str | None,
    candidates: "list[str]",
    ctx: "_RouteCtx",
) -> "tuple[str | None, bool]":
    """Pick the transition the route actually flies, scoring (highest wins):

      P1  the transition name is itself a fix on the route (e.g. BLAFF)
      P2  the transition's connecting fix == the route's endpoint fix
      P3  any of the transition's fixes appear on the route
      P4  shortest great-circle hop from the route endpoint to that fix

    A STAR is entered on its FIRST fix, a SID re-joins enroute on its LAST.
    Returns ``(transition, connected)`` — ``connected`` is True when P1/P2/P3
    fired (a real route link, no assumption); a pure-P4 pick is a geographic
    best-guess and is reported as an assumption. ``(None, False)`` if nothing
    resolves.
    """
    best: str | None = None
    best_key: "tuple[bool, bool, bool, float] | None" = None
    for c in sorted(candidates):
        try:
            proc = nav.lookup_procedure(
                airport, name, proc_type=proc_type, runway=runway, transition=c
            )
        except (AmbiguousProcedureError, ProcedureNotFoundError):
            continue
        wps = proc.waypoints()
        ids = {w.ident.upper() for w in wps}
        conn = None
        if wps:
            # A SID re-joins enroute on its LAST fix (exit); a STAR/approach is
            # entered on its FIRST fix (the STAR entry / the approach IAF). The
            # approach IAF is the one that varies per transition — scoring its
            # last fix (the shared MAPt) can't tell the IAFs apart.
            conn = wps[-1] if proc.proc_type is ProcedureType.SID else wps[0]
        p1 = c.upper() in ctx.idents
        p2 = bool(conn and ctx.end_ident and conn.ident.upper() == ctx.end_ident)
        p3 = bool(ids & ctx.idents)
        dist = (
            _sq_dist((conn.lat, conn.lon), ctx.end_ll)
            if conn is not None and ctx.end_ll is not None
            else float("inf")
        )
        key = (p1, p2, p3, -dist)
        if best_key is None or key > best_key:
            best_key, best = key, c
    if best is None or best_key is None:
        return None, False
    return best, bool(best_key[0] or best_key[1] or best_key[2])


def _resolve_procedure_auto(
    nav: NavData,
    airport: str,
    name: str,
    *,
    proc_type: "ProcedureType | None" = None,
    runway: str | None = None,
    transition: str | None = None,
    auto: bool = True,
    route_ctx: "_RouteCtx | None" = None,
) -> "tuple[Procedure, list[dict[str, str]]]":
    """Resolve a SID/STAR, auto-picking the first candidate on ambiguity.

    Shared by the ``/api/procedures`` endpoint and the splice in
    ``_generate_one``. When ``auto`` is true (the default), each
    runway/transition/type ambiguity is settled by taking the first
    candidate and recording it in the returned ``assumptions`` list; with
    ``auto`` false the :class:`AmbiguousProcedureError` propagates so the
    caller can surface the choices. :class:`ProcedureNotFoundError` always
    propagates.

    ``route_ctx`` biases a TRANSITION ambiguity towards the candidate the route
    actually flies (e.g. STAR NAKO1B entered on BLAFF for ``… DUBEN Y28 BLAFF
    DCT NAKON``, not the alphabetically-first ALBOS) via :func:`_score_transition`.
    A route-connected transition is the correct one, so it is NOT recorded as an
    assumption; a pure-geographic pick or a plain first-candidate guess is.
    """
    assumptions: list[dict[str, str]] = []
    rwy, trn, pt = runway, transition, proc_type
    while True:
        try:
            proc = nav.lookup_procedure(
                airport, name, proc_type=pt, runway=rwy, transition=trn
            )
            return proc, assumptions
        except AmbiguousProcedureError as e:
            if not auto:
                raise
            # Pick the transition the route flies (runway is already resolved
            # by the time this branch is hit, so candidates resolve cleanly).
            if e.kind == "transition" and route_ctx is not None:
                pick, connected = _score_transition(
                    nav, airport, name, pt, rwy, e.candidates, route_ctx
                )
                if pick is not None:
                    trn = pick
                    if not connected:  # geographic best-guess — flag it
                        assumptions.append({"transition": pick})
                    continue
            pick = sorted(e.candidates)[0]
            assumptions.append({e.kind: pick})
            if e.kind == "runway":
                rwy = pick
            elif e.kind == "transition":
                trn = pick
            else:  # procedure type
                pt = ProcedureType(pick)


def _turn_deg(a: float | None, b: float | None) -> float:
    """Smallest turn (0..180°) between two bearings; 0 if either is None."""
    if a is None or b is None:
        return 0.0
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _suggest_procedure(
    nav: NavData,
    airport: str,
    proc_type: "ProcedureType",
    route_ctx: "_RouteCtx | None",
    runway: str | None,
) -> str | None:
    """Pick the SID/STAR that best connects to the enroute route.

    A SID connects on its LAST fix (its enroute exit); a STAR on its FIRST (its
    entry). Each candidate is resolved to the transition the route would fly
    first (via :func:`_resolve_procedure_auto`), so the connecting fix reflects
    that. Candidates are ranked by, in order:

      0. connecting fix == the route's first (SID) / last (STAR) en-route fix
      1. connecting fix lies ON the route (any expanded route fix) — the SID
         delivers you straight onto the filed path (e.g. VTSF GIFB1A exits at
         UPNEP, an A464 fix the route "NKS W94 GUPMO A464 GUTSO" flies through)
      2. connecting fix shares an airway with the endpoint en-route fix
      3. shortest great-circle distance to that en-route fix
      4. least turn from the procedure's leg onto the joining track
      5. published order (stable tie-break)

    Returns the chosen procedure name, or ``None`` when nothing resolves or the
    route has no usable endpoint (so the caller can leave the pick empty).
    """
    if route_ctx is None or route_ctx.end_ident is None:
        return None
    names = nav.list_procedures(airport, proc_type)
    if not names:
        return None
    target_id = route_ctx.end_ident
    target_ll = route_ctx.end_ll
    airways = [
        [w.upper() for w in seq] for seq in _airways().values()
    ]

    def _shares_airway(fix: str) -> bool:
        f = fix.upper()
        t = target_id
        return any(f in seq and t in seq for seq in airways)

    best_key: "tuple[int, float, float, int] | None" = None
    best_name: str | None = None
    is_sid = proc_type is ProcedureType.SID
    for idx, name in enumerate(names):
        try:
            proc, _ = _resolve_procedure_auto(
                nav, airport, name, proc_type=proc_type,
                runway=runway, route_ctx=route_ctx,
            )
        except (ProcedureNotFoundError, AmbiguousProcedureError):
            continue
        wps = proc.waypoints()
        if not wps:
            continue
        conn = wps[-1] if is_sid else wps[0]
        cid = (conn.ident or "").upper()
        if cid == target_id:
            tier = 0
        elif cid in route_ctx.idents:  # exits/enters directly onto the route
            tier = 1
        elif _shares_airway(cid):
            tier = 2
        else:
            tier = 3
        if target_ll is not None:
            dist = haversine_distance(conn.lat, conn.lon, target_ll[0], target_ll[1])
        else:
            dist = 0.0
        # Turn at the join: SID exits along (penultimate→exit) then turns to
        # the target; STAR is entered from the target then turns to (entry→next).
        turn = 0.0
        if target_ll is not None and len(wps) >= 2:
            if is_sid:
                prev = wps[-2]
                leg_in = compute_bearing(prev.lat, prev.lon, conn.lat, conn.lon)
                leg_out = compute_bearing(conn.lat, conn.lon, target_ll[0], target_ll[1])
            else:
                nxt = wps[1]
                leg_in = compute_bearing(target_ll[0], target_ll[1], conn.lat, conn.lon)
                leg_out = compute_bearing(conn.lat, conn.lon, nxt.lat, nxt.lon)
            turn = _turn_deg(leg_in, leg_out)
        key = (tier, round(dist, 3), round(turn, 3), idx)
        if best_key is None or key < best_key:
            best_key, best_name = key, name
    return best_name


def _resolve_proc_for_splice(
    nav: NavData,
    airport: str,
    name: str,
    proc_type: "ProcedureType",
    runway: str | None,
    transition: str | None,
    warnings: list[str],
    route_ctx: "_RouteCtx | None" = None,
) -> "Procedure | None":
    """Resolve one SID/STAR for splicing; a miss is a warning, not an error.

    Ambiguous runway/transition is auto-resolved — the transition is the one
    the route flies (``route_ctx``, via :func:`_score_transition`), else the
    first candidate (reported in ``warnings``), mirroring the map's
    click-to-load. Returns ``None`` if the procedure can't be found so
    generation continues with the enroute route unchanged.
    """
    label = proc_type.value
    try:
        proc, assumptions = _resolve_procedure_auto(
            nav,
            airport,
            name,
            proc_type=proc_type,
            runway=runway,
            transition=transition,
            route_ctx=route_ctx,
        )
    except (ProcedureNotFoundError, AmbiguousProcedureError) as e:
        warnings.append(f"{label} {name!r} at {airport}: {e} — skipped.")
        return None
    if assumptions:
        picks = ", ".join(f"{k} {v}" for a in assumptions for k, v in a.items())
        warnings.append(f"{label} {proc.name} at {airport}: assumed {picks}.")
    return proc


def _alt_floor_ceil(
    con: object,
) -> "tuple[float | None, float | None]":
    """(floor_ft, ceiling_ft) from an AltitudeConstraint — None = unbounded."""
    t = getattr(con, "type", None)
    a1 = getattr(con, "alt1_ft", None)
    a2 = getattr(con, "alt2_ft", None)
    if t is AltitudeConstraintType.AT:
        return a1, a1
    if t is AltitudeConstraintType.AT_OR_ABOVE:
        return a1, None
    if t is AltitudeConstraintType.AT_OR_BELOW:
        return None, a1
    if t is AltitudeConstraintType.BETWEEN:
        return a2, a1  # alt2 = lower, alt1 = upper
    return None, None


def _route_constraints(
    dist_by_ident: "dict[str, float]",
    sid_proc: "Procedure | None",
    star_proc: "Procedure | None",
    approach_proc: "Procedure | None" = None,
) -> "list[RouteConstraint]":
    """Map each SID/STAR/approach leg's crossing restriction to its along-track
    distance on the flown path (Phase 4/5, sub-task 6). SID legs are tagged
    climb; STAR and approach legs descent; only an upper speed limit (AT /
    AT-or-below) is kept. The approach's FAF/step-down altitudes shape the
    final descent to the runway.

    ``dist_by_ident`` comes from :func:`_smooth_turns` and is measured along the
    *curved* path — the one with the turn arcs in it, which is longer than the
    fix-to-fix polyline and is the one the aircraft flies. A fly-by fix that the
    path cuts rather than crosses is placed at the arc that cuts it.
    """
    out: list[RouteConstraint] = []
    for proc, phase in (
        (sid_proc, "climb"),
        (star_proc, "descent"),
        (approach_proc, "descent"),
    ):
        if proc is None:
            continue
        for leg in proc.legs:
            if not leg.has_fix:
                continue
            d = dist_by_ident.get((leg.ident or "").upper())
            if d is None:
                continue
            floor, ceil = (
                _alt_floor_ceil(leg.altitude)
                if leg.altitude.is_constrained
                else (None, None)
            )
            spd = None
            if leg.speed.is_constrained and leg.speed.type in (
                SpeedConstraintType.AT,
                SpeedConstraintType.AT_OR_BELOW,
            ):
                spd = leg.speed.speed_kt
            if floor is None and ceil is None and spd is None:
                continue
            out.append(
                RouteConstraint(
                    distance_nm=d,
                    phase=phase,  # type: ignore[arg-type]
                    alt_floor_ft=floor,
                    alt_ceil_ft=ceil,
                    spd_max_kt=spd,
                )
            )
    return out


def _glide_to_threshold(
    gdf: object,  # geopandas GeoDataFrame (gpd not imported here)
    faf_ll: "tuple[float, float]",
    des_elev_ft: float,
) -> None:
    """In place: straighten the final approach into a glideslope that touches
    down on the runway threshold elevation.

    The Thai APM descent RATE is shallower near the ground than a 3° approach
    glideslope, and the MAPt carries an "AT" crossing altitude ~50 ft above the
    threshold (its threshold-crossing height), so a flown approach otherwise
    LEVELS OFF and ends ~50 ft above the runway instead of landing (e.g. VTCC
    R18 stops at 1086 ft, its 1036 ft threshold + 50). From the final approach
    fix to the last sample we replace altitude with a straight line down to
    ``des_elev_ft`` (spread by along-track distance), so the trajectory lands on
    the threshold — the elevation the AIP AD 2 table publishes and the profile
    started from. No-op when the descent already reached the threshold.
    """
    from shapely.geometry import Point

    n = len(gdf)
    if n < 2:
        return
    lats = [float(g.y) for g in gdf.geometry]
    lons = [float(g.x) for g in gdf.geometry]
    alts = [None if a is None else float(a) for a in gdf["altitude_ft"]]
    if alts[-1] is None or alts[-1] <= des_elev_ft + 1.0:
        return  # already landed on (or below) the threshold — nothing to do
    # The final glide begins at the sample nearest the FAF (fix before the MAPt).
    i_faf = min(
        range(n),
        key=lambda i: (lats[i] - faf_ll[0]) ** 2 + (lons[i] - faf_ll[1]) ** 2,
    )
    start_alt = alts[i_faf]
    if i_faf >= n - 1 or start_alt is None or start_alt <= des_elev_ft:
        return
    cum = [0.0] * n
    for j in range(i_faf + 1, n):
        cum[j] = cum[j - 1] + haversine_distance(
            lats[j - 1], lons[j - 1], lats[j], lons[j]
        )
    total = cum[-1]
    if total <= 0:
        return
    new_alts = list(alts)
    for j in range(i_faf, n):
        new_alts[j] = start_alt + (des_elev_ft - start_alt) * (cum[j] / total)
    gdf["altitude_ft"] = [round(a, 1) for a in new_alts]
    gdf["geometry"] = [
        Point(lon, lat, a * 0.3048)
        for lat, lon, a in zip(lats, lons, new_alts)
    ]


#: Steepest base-leg descent gradient (ft/NM) treated as flyable. ~700 ft/NM is
#: about 6.5° at approach speed — already twice a normal 3° path and about the
#: limit of an idle, speedbrake-out descent. Beyond it the plan is not a plan.
_MAX_BASE_GRADIENT_FT_NM = 700.0


def _level_on_the_assigned_heading(
    gdf: object,  # geopandas GeoDataFrame
    handover_ll: "tuple[float, float]",
    turn_ll: "tuple[float, float]",
    intercept_ll: "tuple[float, float]",
) -> float:
    """In place: fly the assigned-heading leg LEVEL, then descend from the turn.

    The VTBS STAR chart's note is a heading instruction and nothing else —
    "After ESGEN, ATKIN maintain heading 015 or as directed by ATC" — and Doc
    4444 §8.9.4.2 has the aircraft hold its last assigned level until it is
    established. An aircraft on an open-ended radar heading has no descent
    clearance: it maintains what it was given until ATC turns it onto base and
    descends it. Continuing the STAR's descent profile down the downwind is
    therefore the wrong shape, and it gets worse the longer the downwind is
    extended for spacing — the aircraft would arrive at the turn progressively
    lower for a delay that is supposed to cost track miles, not altitude.

    Every sample between the hand-over fix and the turn point is clamped to the
    level the aircraft crossed the hand-over fix at. The descent then resumes
    from the turn, over the base leg, exactly as the chart has it.

    Returns the resulting gradient over the WHOLE base leg in ft/NM (turn point
    to intercept, 0 when nothing was changed), so the caller can warn if
    holding the level makes the base steeper than the aircraft can fly.
    """
    from shapely.geometry import Point

    n = len(gdf)
    if n < 3:
        return 0.0
    lats = [float(g.y) for g in gdf.geometry]
    lons = [float(g.x) for g in gdf.geometry]
    alts = [None if a is None else float(a) for a in gdf["altitude_ft"]]

    def nearest(ll: "tuple[float, float]") -> int:
        return min(
            range(n),
            key=lambda i: (lats[i] - ll[0]) ** 2 + (lons[i] - ll[1]) ** 2,
        )

    i0, i1 = nearest(handover_ll), nearest(turn_ll)
    if i1 <= i0 or alts[i0] is None:
        return 0.0
    level = float(alts[i0])
    new_alts = list(alts)
    for j in range(i0, i1 + 1):
        new_alts[j] = level
    gdf["altitude_ft"] = [None if a is None else round(a, 1) for a in new_alts]
    gdf["geometry"] = [
        Point(lon, lat, 0.0 if a is None else a * 0.3048)
        for lat, lon, a in zip(lats, lons, new_alts)
    ]

    # How steep the base leg now has to be — the altitude the downwind no
    # longer gives away has to come off somewhere. Measured over the WHOLE leg,
    # turn point to intercept: a per-sample slope would report the steepest
    # instant rather than the descent the aircraft actually has to fly.
    i2 = nearest(intercept_ll)
    if i2 <= i1 or new_alts[i2] is None:
        return 0.0
    base_nm = sum(
        haversine_distance(lats[j - 1], lons[j - 1], lats[j], lons[j])
        for j in range(i1 + 1, i2 + 1)
    )
    drop = level - float(new_alts[i2])
    return drop / base_nm if base_nm > 0.1 and drop > 0 else 0.0


def _proc_runway(proc: "Procedure | None") -> str | None:
    """The runway a resolved SID/STAR serves — for the trajectory export.

    Prefers ``proc.runway``, but the Thai DFD SID/STAR carry every leg under
    route_type 5 ("common"), so the runway (stored in each leg's
    ``transition_identifier``, e.g. RW03L) never surfaces as ``proc.runway``.
    Fall back to the first RW* transition found among the legs.
    """
    if proc is None:
        return None
    if getattr(proc, "runway", None):
        return proc.runway
    for leg in getattr(proc, "legs", ()):
        tr = getattr(leg, "transition", None)
        if tr and tr.upper().startswith("RW"):
            return tr.upper()
    return None


#: Altitude assumed at a turning fix that publishes no crossing restriction —
#: mid-terminal-area, where the 250 kt limit still caps the speed anyway, so the
#: radius it implies is barely sensitive to the guess.
_DEFAULT_TURN_ALT_FT = 5000.0


def _turn_speed_kt(
    actype: str, alt_ft: float, cap_kt: float | None, phase: str
) -> float:
    """TAS the aircraft holds through a turn — what sets its radius."""
    tas_kt = target_tas_kt(actype, alt_ft, phase)  # type: ignore[arg-type]
    if cap_kt:
        tas_kt = min(tas_kt, cas_to_tas_kt(cap_kt, alt_ft))
    return tas_kt


class _TurnFix(NamedTuple):
    """What the procedure data says about flying a turn at one fix."""

    #: Published turn direction "L"/"R" of the leg LEAVING this fix, or None.
    #: A leg that names one is a "turn this way, then direct to my fix" (DF)
    #: leg, so the fix it leaves is crossed before the turn starts.
    direction: str | None
    #: Must the fix be crossed before turning? Two things say so: the 2nd
    #: character of the waypoint description code is "Y" ("EY" on the runway
    #: departure end DE21L — a corner you cannot cut), or the leg TERMINATES ON
    #: AN ALTITUDE (CA/VA/FA), which by definition ends where the altitude is
    #: made and so cannot be cut short. Everything else is a fly-by.
    flyover: bool
    #: The fix's own crossing restrictions, and which phase it is flown in.
    alt_ft: float | None
    speed_kt: float | None
    phase: str
    #: Maximum bank for the segment this fix belongs to — PANS-OPS Table 2-1.
    bank_deg: float


def _turn_fixes(
    procs: "list[tuple[Procedure | None, str]]",
) -> "dict[str, _TurnFix]":
    """Index the resolved procedures' legs by fix ident for :func:`_smooth_turns`.

    Each fix is tagged with the bank angle PANS-OPS allows in its *segment of
    operation* (Doc 8168 Vol I, Table 2-1): 25° in the en-route structure, on a
    SID/STAR and through the initial and intermediate approach, but only 15°
    once established on final — a turn low and slow is flown gently, and the
    wider radius it gives is what keeps a jet inside the protected area.
    """
    out: dict[str, _TurnFix] = {}
    for proc, phase in procs:
        if proc is None:
            continue
        # An approach's legs run initial -> intermediate -> final; the final
        # segment starts at the FAF, which ARINC flags in the description code's
        # 4th character. Everything from there in is the 15° segment.
        on_final = False
        for leg in proc.legs:
            desc = leg.desc_code or ""
            if proc.proc_type is not ProcedureType.APPROACH:
                segment = (
                    "sid" if proc.proc_type is ProcedureType.SID else "star"
                )
            else:
                on_final = on_final or (len(desc) > 3 and desc[3] == "F")
                segment = (
                    "final_approach" if on_final else "intermediate_approach"
                )
            if not leg.has_fix:
                continue
            speed_kt = (
                leg.speed.speed_kt
                if leg.speed.type
                in (SpeedConstraintType.AT, SpeedConstraintType.AT_OR_BELOW)
                else None
            )
            out[(leg.ident or "").upper()] = _TurnFix(
                direction=leg.turn_direction or None,
                flyover=(len(desc) > 1 and desc[1] == "Y")
                or leg.path_terminator in ALTITUDE_TERMINATED,
                alt_ft=leg.altitude.alt1_ft or leg.altitude.alt2_ft,
                speed_kt=speed_kt,
                phase=phase,
                bank_deg=bank_angle_deg(segment),
            )
    return out


def _smooth_turns(
    route_pts: "list[tuple[str, float, float]]",
    actype: str,
    rfl_ft: float,
    procs: "list[tuple[Procedure | None, str]]",
    head: "tuple[float, float] | None" = None,
    tail: "tuple[float, float] | None" = None,
) -> "tuple[list[tuple[str, float, float]], dict[str, float]]":
    """Turn the route's corners into the arcs an aircraft actually flies.

    A route drawn as straight lines between fixes pivots on the spot at every
    course change — the aircraft changes heading by 90° between one sample and
    the next. Real turns are banked and take distance, and ARINC 424 says how
    each one is flown (see :mod:`trajectory_sim.turns`):

    * an ordinary fix is a **fly-by** — the corner is cut, tangent to both legs,
      and the fix itself is never crossed;
    * a fix flagged fly-over (description code ``·Y·``, e.g. the runway
      departure end) or left on a published ``turn_direction`` (a DF leg, e.g. a
      SID's "turn right, direct INTOS" after the initial climb) is **crossed
      first**, and the aircraft then curves round onto the next fix.

    The radius comes from the speed the aircraft actually holds at that fix — its
    published restrictions where it has them, cruise otherwise — so a slow, low
    SID turn is tight and a cruise-level one is wide.

    Args:
        route_pts: The spliced ``(ident, lat, lon)`` route.
        actype: ICAO aircraft type — sets the turn speed, hence the radius.
        rfl_ft: Cruise level, the altitude assumed at fixes outside a procedure.
        procs: The resolved ``(procedure, phase)`` pairs the route was spliced
            from — the source of every turn direction and crossing restriction.
        head: Where the aircraft leaves the ground, and ``tail`` where it lands
            — the aerodrome anchors. They belong here rather than being tacked
            on afterwards: an anchor added later leaves the route's FIRST and
            LAST fixes with a corner apiece, since neither had a leg on both
            sides of it while the turns were being built.

    Returns:
        ``(path, fix_distance_nm)``. ``path`` is the flown polyline: the
        anchors and the fixes, with arcs spliced in. Everything on it that is
        not a fix — the arc vertices and the anchors — carries an EMPTY ident,
        so anything keyed on fixes ignores it. ``fix_distance_nm`` maps each
        fix's ident to its along-track distance on that path, which is where its
        crossing restriction bites — and is why this must run *before* they are
        built. A fly-by fix is not on the path at all, so its distance is the
        point of the arc that cuts it.
    """
    fixes = _turn_fixes(procs)
    route_pts = [
        *([("", *head)] if head is not None else []),
        *route_pts,
        *([("", *tail)] if tail is not None else []),
    ]
    if len(route_pts) < 2:
        # Nothing to turn between. The caller rejects such a route anyway; this
        # just keeps the walk below from indexing off the end of it.
        return list(route_pts), {p[0].upper(): 0.0 for p in route_pts if p[0]}

    def _segment_fix(i: int) -> "_TurnFix | None":
        """The segment of operation the fix at route index ``i`` is flown in.

        A fix the procedures never described is not an en-route fix at cruise
        just because nothing was published for it — it is flown where its
        NEIGHBOURS are. The radar-vector points this module invents (TURN,
        INTC) are exactly that case: they sit between the STAR's last fix and
        the approach, at circuit height and approach speed, and taking them for
        cruise gave them a 6.3 NM turn radius at FL350 — a turn far too wide to
        fit the 1.3 NM downwind, so no arc could be drawn at all and the map
        showed the corner raw.
        """
        ident = (route_pts[i][0] or "").upper()
        fix = fixes.get(ident)
        if fix is not None:
            return fix
        for j in range(i - 1, -1, -1):
            back = fixes.get((route_pts[j][0] or "").upper())
            if back is not None:
                return back
        return None

    def _radius_nm(i: int, speed_from: int) -> float:
        """PANS-OPS turn radius at route index ``i``: the speed the aircraft is
        really holding there, banked as far as its segment of operation allows."""
        fix = _segment_fix(i)
        phase = fix.phase if fix else "cruise"
        alt_ft = (fix.alt_ft if fix else None) or (
            rfl_ft if phase == "cruise" else _DEFAULT_TURN_ALT_FT
        )
        cap = _segment_fix(speed_from)
        return turn_radius_nm(
            _turn_speed_kt(actype, alt_ft, cap.speed_kt if cap else None, phase),
            bank_deg=fix.bank_deg if fix else bank_angle_deg("enroute"),
        )

    path: list[tuple[str, float, float]] = [route_pts[0]]
    # Where each fix's restriction bites, as an index into `path`. A fly-by fix
    # is off the path, so it points at the arc vertex that replaces it.
    anchor: list[tuple[str, int]] = [(route_pts[0][0], 0)]

    for i in range(1, len(route_pts) - 1):
        prev_ll = (path[-1][1], path[-1][2])
        _, fix_lat, fix_lon = route_pts[i]
        _, next_lat, next_lon = route_pts[i + 1]
        ident = (route_pts[i][0] or "").upper()
        next_ident = (route_pts[i + 1][0] or "").upper()
        fix = fixes.get(ident)

        inbound_deg = compute_bearing(prev_ll[0], prev_ll[1], fix_lat, fix_lon)
        corner_deg = signed_turn_deg(
            inbound_deg, compute_bearing(fix_lat, fix_lon, next_lat, next_lon)
        )
        # The turn out of this fix is published on the leg that LEAVES it —
        # i.e. on the next fix's leg.
        leaving = fixes.get(next_ident)
        direction = leaving.direction if leaving else None
        # A fly-over is turned AT the fix, so the speed limit that shapes it is
        # the one on the leg being turned onto; a fly-by straddles the fix and
        # flies its own.
        must_cross = direction is not None or (fix is not None and fix.flyover)
        radius_nm = _radius_nm(i, i + 1 if must_cross else i)

        if not must_cross:
            arc = flyby_arc(
                prev_ll[0], prev_ll[1],
                fix_lat, fix_lon,
                next_lat, next_lon,
                radius_nm,
            )
            if arc:
                anchor.append((ident, len(path) + len(arc) // 2))
                path.extend(("", lat, lon) for lat, lon in arc)
                continue
            # The fly-by declined it. Either there is no corner (a couple
            # of degrees of course-keeping — leave the fix alone), or the
            # corner is one a fly-by cannot express: a near-reversal, or a
            # turn so tight the cut would need a bank no aircraft holds.
            # Those are flown OVER the fix and captured — which is what a
            # 150 deg downwind-to-base vector turn actually is.
            must_cross = abs(corner_deg) >= MIN_TURN_DEG

        anchor.append((ident, len(path)))
        path.append(route_pts[i])
        if not must_cross:
            continue
        if direction is None:
            # A fly-over with no published direction still has to get round the
            # corner — take the short way.
            direction = "R" if corner_deg > 0 else "L"
        path.extend(
            ("", lat, lon)
            for lat, lon in turn_arc(
                fix_lat, fix_lon,
                inbound_deg,
                next_lat, next_lon,
                direction,
                radius_nm,
            )
        )

    anchor.append((route_pts[-1][0], len(path)))
    path.append(route_pts[-1])

    cumulative_nm = [0.0]
    for a, b in zip(path, path[1:]):
        cumulative_nm.append(
            cumulative_nm[-1] + haversine_distance(a[1], a[2], b[1], b[2])
        )
    fix_distance_nm: dict[str, float] = {}
    for ident, index in anchor:  # first occurrence wins, as flight order demands
        if ident:
            fix_distance_nm.setdefault(ident.upper(), cumulative_nm[index])
    return path, fix_distance_nm


#: ~3 NM: the route already starts/ends over the aerodrome, so anchoring it
#: there would only add a zero-length leg.
_COINCIDENT_SQ = 0.0025
#: ~30 NM: the route's last fix is nowhere near the destination — it does not
#: actually serve the city pair.
_FAR_SQ = 0.25
#: A closing leg shorter than this (NM) is no leg at all. Some approaches put
#: their MAPt right on the threshold, so closing to the runway would append a
#: point on top of the last fix — a zero-length leg whose bearing is meaningless
#: and which reads as a violent turn.
_MIN_CLOSING_LEG_NM = 0.05


def _approach_runway(name: str | None) -> str | None:
    """Landing runway of an approach, from its name. Handles PBN (``R09-Z`` ->
    ``RW09``) and ILS/conventional (``I24`` -> ``RW24``, ``I23LY`` -> ``RW23L``):
    a single-letter procedure prefix (R/I/D/L/N/V/S/Q…) then the runway number,
    optional side and variant suffix.

    An approach is named for the runway it lands on, and that — not the STAR's
    runway — is the runway the aircraft touches down on. They can differ: a STAR
    resolved to RW01 followed by the R02L approach lands on 02L.
    """
    m = re.match(r"^[A-Z](\d{2}[LCR]?)(?:[-A-Z].*)?$", (name or "").strip().upper())
    return f"RW{m.group(1)}" if m else None


def _aerodrome_anchors(
    adep: str,
    ades: str,
    route_pts: "list[tuple[str, float, float]]",
    terminal: "dict[str, str | None]",
    warnings: list[str],
) -> "tuple[tuple[float, float] | None, tuple[float, float] | None]":
    """Where the flown path starts and ends: the aerodromes themselves.

    An FPL trajectory is gate-to-gate, so it must DEPART ADEP and ARRIVE ADES
    whatever fixes the Item-15 route happens to list. Either anchor is skipped
    when the route already begins/ends on the field (a SID starts on the runway
    threshold; PUT sits on VTSP), which would only add a zero-length leg.

    The arrival anchor is the landing RUNWAY THRESHOLD when the runway is known.
    An aerodrome reference point is not where an aircraft touches down — at a
    two-runway field like VTBS it sits between the two, so closing an approach to
    it ends the flight in the middle of the airport, abeam the runway the
    aircraft just flew a glideslope onto.
    """
    if not route_pts:
        return None, None

    head = None
    adep_ll = _airport_ll(adep)
    if adep_ll is not None and _sq_dist(route_pts[0][1:], adep_ll) > _COINCIDENT_SQ:
        head = adep_ll

    tail = None
    landing = runway_end(ades, terminal.get("arr_rwy"))
    ades_ll = (
        (landing.lat, landing.lon) if landing is not None else _airport_ll(ades)
    )
    if ades_ll is not None:
        gap = _sq_dist(route_pts[-1][1:], ades_ll)
        # With a PBN approach the route ends at the MAPt — over the field but at
        # the approach's decision altitude, not on the runway. Always close that
        # last leg so the aircraft actually lands, matching the AIP's
        # "MAPt → runway" path. Unless the MAPt IS the threshold (some
        # approaches put it there), in which case there is nothing left to fly.
        closing_nm = haversine_distance(*route_pts[-1][1:], *ades_ll)
        if closing_nm > _MIN_CLOSING_LEG_NM and (
            gap > _COINCIDENT_SQ or terminal.get("approach")
        ):
            tail = ades_ll
        if gap > _FAR_SQ:
            warnings.append(
                f"Route does not reach {ades}: its last fix is far from the "
                f"destination, so a direct leg to {ades} was added. Pick a "
                f"route that ends near {ades} for a realistic profile."
            )
    return head, tail


def _expand_departure(
    req: "GenerateRequest", adep: str, sid_proc: "Procedure"
) -> "Procedure":
    """Anchor a resolved SID to its departure runway threshold.

    Wires the request's aircraft type and the departure threshold's elevation
    into :func:`~trajectory_sim.navdata.expand_sid_departure`, which prepends
    the threshold and turns the SID's course-to-altitude legs (e.g. VTBD
    OLVU3C's "209° to 1 500 ft, MAX IAS 200 KT") into fixes on the runway
    track. Without it the aircraft starts at the runway END and turns straight
    for the first fix, cutting back across the runway. Returned unchanged when
    no departure threshold can be identified.

    The runway to anchor to is the one the SID's *legs* are coded for, not the
    one requested: a Thai SID name serves a single runway (ALBO3C is RW21L
    only), so a request for the opposite end — which the runway-filtered SID
    dropdown never offers — must not start the aircraft on a threshold its legs
    don't leave from. Only an ARINC "both" group (RW21B, one leg set for 21L and
    21R) names no single threshold, and there the request picks the side.
    """
    rwy = runway_end(adep, _proc_runway(sid_proc)) or runway_end(
        adep, (req.sid_runway or "").strip().upper()
    )
    if rwy is None:
        return sid_proc
    actype = req.actype.strip().upper() or _DEFAULT_ACTYPE
    thr_elev_ft = runway_threshold_elevation_ft(adep, rwy.ident)
    # The climb is flown at a phase-average speed set by its TOP, so the fix
    # placement needs the cruise level the profile will actually reach.
    cruise_ft = min(float(req.rfl) * 100.0, reachable_ceiling_ft(actype))
    return expand_sid_departure(
        sid_proc,
        rwy,
        lambda alt_ft: climb_distance_nm(actype, thr_elev_ft, alt_ft, cruise_ft),
    )


def _terminal_runways_only(req: "GenerateRequest") -> "dict[str, str | None]":
    """Terminal dict carrying only the user-picked runways.

    Used when no SID/STAR/approach is flown (a direct route) so the vertical
    profile still anchors its climb start / descent end to the departure /
    arrival runway *threshold* elevation (Thai AIP AD 2) rather than the
    aerodrome's single field elevation. The runways ride in on
    ``sid_runway``/``star_runway`` (the same fields a SID/STAR would use).
    """
    dep = (req.sid_runway or "").strip().upper()
    arr = (req.star_runway or "").strip().upper()
    return {"dep_rwy": dep or None, "arr_rwy": arr or None}


def _finish(
    req: "GenerateRequest",
    adep: str,
    ades: str,
    route_pts: "list[tuple[str, float, float]]",
    terminal: "dict[str, str | None]",
    sid_proc: "Procedure | None",
    star_proc: "Procedure | None",
    approach_proc: "Procedure | None",
    warnings: list[str],
) -> "tuple[list[tuple[str, float, float]], list[RouteConstraint], dict[str, str | None], list[tuple[str, float, float]]]":
    """Turn a resolved route into the path the aircraft flies, and the crossing
    restrictions placed along it. The single exit from
    :func:`_splice_terminal_procedures` — a route with no procedure at all comes
    through here too, so it is anchored and its corners turned like any other.

    The order matters: anchor the aerodromes, THEN build the turns, THEN measure
    the restrictions. Anchoring last would leave the route's first and last fixes
    with a corner apiece (neither had a leg on both sides when the turns were
    built), and measuring before the turns would place every restriction at a
    distance the aircraft never flies.
    """
    head, tail = _aerodrome_anchors(adep, ades, route_pts, terminal, warnings)
    path_pts, fix_distance_nm = _smooth_turns(
        route_pts,
        req.actype.strip().upper() or _DEFAULT_ACTYPE,
        float(req.rfl) * 100.0,
        [(sid_proc, "climb"), (star_proc, "descent"), (approach_proc, "descent")],
        head=head,
        tail=tail,
    )
    return (
        route_pts,
        _route_constraints(fix_distance_nm, sid_proc, star_proc, approach_proc),
        terminal,
        path_pts,
    )


def _procedure_entries(
    nav: NavData,
    ades: str,
    name: str,
    proc_type: "ProcedureType",
    runway: str | None,
) -> "list[tuple[str | None, str, float, float]]":
    """Every fix a terminal procedure can be entered on: (transition, ident,
    lat, lon).

    Enumerates the procedure's transitions and reads each one's FIRST fix — a
    STAR's enroute-entry fix, or an approach's IAF. A single-transition procedure
    resolves directly (transition ``None``). ``[]`` if it can't be resolved.
    """
    try:
        proc = nav.lookup_procedure(
            ades, name, proc_type=proc_type, runway=runway
        )
        trans: list[str | None] = [proc.transition]
    except AmbiguousProcedureError as e:
        trans = sorted(e.candidates)
    except ProcedureNotFoundError:
        return []
    out: list[tuple[str | None, str, float, float]] = []
    for t in trans:
        try:
            proc = nav.lookup_procedure(
                ades, name, proc_type=proc_type, runway=runway, transition=t
            )
        except (AmbiguousProcedureError, ProcedureNotFoundError):
            continue
        wps = proc.waypoints()
        if wps:
            out.append((t, wps[0].ident.upper(), wps[0].lat, wps[0].lon))
    return out


def _is_overfly_in_procedure(
    nav: NavData,
    ades: str,
    name: str,
    proc_type: "ProcedureType",
    runway: str | None,
    ident: str,
) -> bool:
    """True if ``ident`` is a fly-over waypoint of the procedure (desc code 2nd
    char ``Y``). Such a fix must be crossed, so a route ending on it is left in
    place — the exception to the VOR trim."""
    entries = _procedure_entries(nav, ades, name, proc_type, runway)
    for t, *_ in entries or [(None,)]:
        try:
            proc = nav.lookup_procedure(
                ades, name, proc_type=proc_type, runway=runway, transition=t
            )
        except (AmbiguousProcedureError, ProcedureNotFoundError):
            continue
        for leg in proc.legs:
            dc = leg.desc_code or ""
            if (
                (leg.ident or "").upper() == ident.upper()
                and len(dc) > 1
                and dc[1] == "Y"
            ):
                return True
    return False


def _connect_route_to_terminal(
    nav: NavData,
    ades: str,
    name: str,
    proc_type: "ProcedureType",
    runway: str | None,
    route_pts: "list[tuple[str, float, float]]",
    warnings: list[str],
) -> "tuple[list[tuple[str, float, float]], str | None]":
    """Trim a VOR-terminated route back to the fix that joins a STAR/approach
    cleanly, and pick that fix's entry transition.

    The caller has already checked the route ends on the destination's terminal
    VOR (:func:`_ends_at_field_vor`) — the VOR sits PAST the procedure's entry,
    so flying to it and then out to the entry doubles the aircraft back. This
    finds the join the AIP intends:

    * **a route fix that IS a procedure entry** — e.g. SAKUB, which airway W34
      passes through on the way to the RAN VOR: end the route there (the last
      one, if several); otherwise
    * **no route fix is an entry** — among the entries lying on the ARRIVAL side
      of the field, pick the one nearest the field, then end the route at the
      route fix nearest THAT entry, so the last enroute fix is the one that best
      leads in (e.g. Y94's DOXAS → TAWIT).

    The arrival-side filter matters: an entry on the far side of the aerodrome
    sends the aircraft past the field and back — the very doubling-back this
    trim exists to remove. VTSF RW01 reached on 060° used to pick CHARY (165°
    out, south of the field) purely because it sat nearest the VOR, flying the
    aircraft over the field and round; TAWIT (025°, the same side the route
    arrives from) is the join the AIP intends. Both runways now resolve to it.

    Exception: if the terminal VOR is itself a fly-over waypoint of the
    procedure, it must be crossed — leave the route as is.

    Returns ``(trimmed_route, transition | None)``; unchanged with ``None`` when
    the procedure has no resolvable entry.
    """
    entries = _procedure_entries(nav, ades, name, proc_type, runway)
    if not entries or len(route_pts) < 2:
        return route_pts, None
    kind = "STAR" if proc_type is ProcedureType.STAR else "approach"
    entry_idents = {e[1] for e in entries}
    vor = route_pts[-1]
    # The VOR IS the procedure's entry (e.g. VTCC's CMA) — enter there, no trim.
    if vor[0].upper() in entry_idents:
        return route_pts, next(e[0] for e in entries if e[1] == vor[0].upper())
    if _is_overfly_in_procedure(nav, ades, name, proc_type, runway, vor[0]):
        return route_pts, None  # the VOR must be overflown — keep it
    # Otherwise the terminal VOR sits at the field, PAST the entry: the procedure
    # is what flies TO the field, so drop the VOR and join from the fix before
    # it. Among those, an entry ON the route wins; else take the entry nearest
    # the VOR (the arrival direction) and end at the route fix nearest it.
    body = route_pts[:-1]
    on_route = [k for k, p in enumerate(body) if p[0].upper() in entry_idents]
    if on_route:
        k = max(on_route)
        trn = next(e[0] for e in entries if e[1] == body[k][0].upper())
    else:
        # Keep only the entries on the side the route arrives from, so the join
        # never sends the aircraft past the aerodrome and back; among those the
        # one nearest the field is the natural lead-in. Fall back to every entry
        # when none is on that side (a procedure entered only from the far side).
        arrival_deg = compute_bearing(vor[1], vor[2], body[-1][1], body[-1][2])
        near_side = [
            e
            for e in entries
            if abs(
                signed_turn_deg(
                    arrival_deg, compute_bearing(vor[1], vor[2], e[2], e[3])
                )
            )
            <= _ENTRY_ARRIVAL_SIDE_DEG
        ]
        trn, _eid, ela, elo = min(
            near_side or entries,
            key=lambda e: _sq_dist((e[2], e[3]), (vor[1], vor[2])),
        )
        k = min(
            range(len(body)),
            key=lambda j: _sq_dist((body[j][1], body[j][2]), (ela, elo)),
        )
    dropped = ", ".join(p[0] for p in route_pts[k + 1 :])
    warnings.append(
        f"Trimmed the route at {body[k][0]} to join {kind} {name} at its entry "
        f"(dropped {dropped})."
    )
    return body[: k + 1], trn


def _splice_terminal_procedures(
    req: "GenerateRequest",
    adep: str,
    ades: str,
    route_pts: "list[tuple[str, float, float]]",
    warnings: list[str],
) -> "tuple[list[tuple[str, float, float]], list[RouteConstraint], dict[str, str | None], list[tuple[str, float, float]]]":
    """Fold the requested SID (ADEP), STAR + approach (ADES) into the fixes.

    Returns ``(spliced_route, crossing_restrictions, terminal, flown_path)``:

    * ``spliced_route`` — the fixes, in flight order. This is the *route*: what
      the FPL string, the route payload and the fix markers are made of.
    * ``terminal`` — maps ``sid``/``star``/``approach``/``dep_rwy``/``arr_rwy``
      to the resolved selection (the runway is the one the resolver picked, even
      for an "Auto" request); empty ``{}`` when no procedure is requested.
    * ``flown_path`` — the same fixes with turn arcs spliced in (:func:`_smooth_
      turns`), so course changes the procedures publish a turn for are curves
      rather than corners. This is the *path*: what the aircraft actually flies,
      and what the crossing restrictions' along-track distances are measured on.
      Arc vertices carry an empty ident, which is what tells the two apart.

    The SID's fixes lead the sequence (it flies first, right after ADEP); the
    STAR's fixes trail it, then the PBN approach's fixes trail those (right
    before ADES). Shared boundary fixes — SID enroute-transition vs. route's
    first fix, route's last fix vs. STAR entry, STAR's terminal fix vs. the
    approach IAF — collapse via :func:`splice_procedures`. With no procedure
    requested the route passes through untouched, path == route (Phase 4/5).
    """
    sid_name = (req.sid or "").strip()
    star_name = (req.star or "").strip()
    approach_name = (req.approach or "").strip()
    if not sid_name and not star_name and not approach_name:
        return _finish(req, adep, ades, route_pts, _terminal_runways_only(req),
                       None, None, None, warnings)

    nav = _navdata()
    # The route's own fixes pick the right terminal-procedure transition when
    # several exist (a SID leaves on the route's first fix, a STAR is entered
    # on its last) — so NAKO1B on "… BLAFF DCT NAKON" uses the BLAFF transition
    # instead of the alphabetically-first ALBOS.
    sid_proc = (
        _resolve_proc_for_splice(
            nav, adep, sid_name, ProcedureType.SID,
            req.sid_runway, req.sid_transition, warnings,
            route_ctx=_route_ctx(route_pts, ProcedureType.SID),
        )
        if sid_name
        else None
    )
    # A route filed to the destination's terminal VOR (RAN, NKS, LPN, BKK) ends
    # PAST the first terminal procedure's entry, so flying to it doubles the
    # aircraft back. Trim it to the fix that leads in and lock that entry's
    # transition — for the STAR if one is flown (it bridges the enroute route to
    # the runway), otherwise for the approach. Only when the route ends on that
    # field VOR, and only when the user hasn't picked the transition themselves.
    forced_star_trans = req.star_transition
    forced_appr_trans = req.approach_transition
    if _ends_at_field_vor(route_pts, ades):
        if star_name and not (req.star_transition or "").strip():
            route_pts, forced_star_trans = _connect_route_to_terminal(
                nav, ades, star_name, ProcedureType.STAR,
                req.star_runway, route_pts, warnings,
            )
        elif (
            approach_name
            and not star_name
            and not (req.approach_transition or "").strip()
        ):
            route_pts, forced_appr_trans = _connect_route_to_terminal(
                nav, ades, approach_name, ProcedureType.APPROACH,
                req.star_runway, route_pts, warnings,
            )
    star_proc = (
        _resolve_proc_for_splice(
            nav, ades, star_name, ProcedureType.STAR,
            req.star_runway, forced_star_trans, warnings,
            route_ctx=_route_ctx(route_pts, ProcedureType.STAR),
        )
        if star_name
        else None
    )
    # The approach's IAF connects to the STAR's terminal fix (e.g. KALIM), so
    # score its transition against a context ending at the STAR's last fix;
    # fall back to the enroute end when there's no STAR.
    approach_ctx_pts = list(route_pts)
    if star_proc is not None:
        approach_ctx_pts += [
            (w.ident, w.lat, w.lon) for w in star_proc.waypoints()
        ]
    approach_proc = (
        _resolve_proc_for_splice(
            nav, ades, approach_name, ProcedureType.APPROACH,
            req.star_runway, forced_appr_trans, warnings,
            route_ctx=_route_ctx(approach_ctx_pts, ProcedureType.APPROACH),
        )
        if approach_name
        else None
    )
    if sid_proc is None and star_proc is None and approach_proc is None:
        return _finish(req, adep, ades, route_pts, _terminal_runways_only(req),
                       None, None, None, warnings)

    # Give the SID its published ground track before anything reads its fixes:
    # start on the runway threshold, fly runway heading through the initial
    # course-to-altitude leg, and only then turn for the first en-route fix.
    if sid_proc is not None:
        sid_proc = _expand_departure(req, adep, sid_proc)

    enroute = [RouteWaypoint(ident=i, lat=la, lon=lo) for i, la, lo in route_pts]

    # An arrival off an OPEN STAR (last leg a VM — "fly heading 015, expect
    # vectors") can be flown two ways, and WHICH ONE is a controller decision,
    # not a property of the procedure:
    #
    #   no conflict  ->  stay on the published path: the STAR runs to its last
    #                    fix, then the approach from its IAF (ATKIN, LETMA,
    #                    LAVOG, LOTMU, FAF, MAPt). This is the default.
    #   conflict     ->  leave the procedure at the STAR's end, hold the
    #                    published heading until the spacing is there, then turn
    #                    to intercept the extended centreline (TURN, INTC, …).
    #
    # So vectoring is opt-in: `vector_to_final`, or implicitly any request to
    # extend the downwind, which is only meaningful under vectors.
    extend_nm = max(0.0, float(req.extend_downwind_nm or 0.0))
    want_vectors = bool(req.vector_to_final) or extend_nm > 0
    vector_join: "VectorToFinal | None" = None
    if (
        want_vectors
        and star_proc is not None
        and star_proc.is_open
        and approach_proc is not None
    ):
        landing = _approach_runway(approach_name) or (
            (req.star_runway or "").strip().upper() or _proc_runway(star_proc)
        )
        rwy_end = runway_end(ades, landing)
        if rwy_end is not None:
            planned = plan_open_star_join(
                star_proc, approach_proc, rwy_end, extend_nm=extend_nm
            )
            if planned is not None:
                arrival_fixes, vector_join = planned
        if vector_join is None:
            warnings.append(
                f"Vectors to final were requested but no path could be planned "
                f"for {star_name}; flown on the published procedure instead."
            )
    elif want_vectors and star_proc is not None and not star_proc.is_open:
        warnings.append(
            f"{star_name} does not end in radar vectors, so there is no "
            "published heading to hold; flown on the published procedure."
        )

    if vector_join is not None:
        # enroute + SID through the normal splice (it collapses the route's
        # shared boundary fixes), then the arrival the vector planner built:
        # STAR fixes, the two vector legs, and the approach from the intercept
        # inwards. Those idents cannot collide with an enroute fix, so they
        # simply append.
        spliced = splice_procedures(enroute, sid=sid_proc, star=star_proc)
        star_len = len(star_proc.waypoints()) if star_proc is not None else 0
        spliced = [*spliced, *arrival_fixes[star_len:]]
    else:
        spliced = splice_procedures(
            enroute, sid=sid_proc, star=star_proc, approach=approach_proc
        )
    spliced_pts = [(w.ident, w.lat, w.lon) for w in spliced]
    # Resolved terminal selection for the export — the runway is the one the
    # resolver actually picked (so an "Auto" request still records a runway).
    # A specific request wins over the resolved group so an "RW21L" pick is
    # recorded as RW21L, not the ARINC "both" group (RW21B) it matched.
    def _rwy(requested: str | None, proc: "Procedure | None") -> str | None:
        req = (requested or "").strip().upper()
        return req or _proc_runway(proc)

    # An approach names the runway it lands on, and that beats the STAR's: they
    # can disagree (a STAR resolved to RW01 flown into the R02L approach lands
    # on 02L), and it is the approach that puts the aircraft on the tarmac.
    arr_rwy = _approach_runway(approach_name) or _rwy(req.star_runway, star_proc)
    terminal = {
        "sid": sid_name or None,
        "star": star_name or None,
        # Where the arrival actually begins: the STAR's first fix. Holding is an
        # arrival instrument, and "on the arrival" means ON THE STAR — not
        # merely past top of descent, which on a 55-minute leg falls a good 8
        # minutes and several en-route fixes before the STAR is joined. The
        # client has the route as a flat ident list and no way to tell which of
        # them the procedure contributed, so it is named here.
        "star_entry": (
            star_proc.waypoints()[0].ident
            if star_proc is not None and star_proc.waypoints()
            else None
        ),
        "approach": approach_name or None,
        "dep_rwy": _rwy(req.sid_runway, sid_proc),
        "arr_rwy": arr_rwy,
        # Can this arrival be VECTORED at all? Only an open STAR publishes a
        # heading to hold, so the client uses these to decide whether the
        # "maintain heading" resolution is on the table for a flight.
        "star_open": bool(star_proc is not None and star_proc.is_open),
        "vector_heading_deg": _vector_heading_true(ades, star_proc, arr_rwy),
        # ...and the same heading AS THE CHART PRINTS IT. The geometry is
        # solved in true, but "maintain heading 015" is what a controller
        # transmits and what the AIP note says; quoting the true course back at
        # them (014 here, after 0°42'W variation) is simply the wrong number
        # for an instruction.
        "vector_heading_mag_deg": _vector_heading_magnetic(star_proc),
        "vectored": vector_join is not None,
        # The chart forbids entering the approach without a clearance, so BOTH
        # flows record the clearance they were flown under.
        "clearance": _arrival_clearance(
            star_proc, approach_proc, approach_name, vector_join is not None
        ),
    }
    return _finish(
        req, adep, ades, spliced_pts, terminal,
        sid_proc, star_proc, approach_proc, warnings,
    )


def _arrival_clearance(
    star_proc: "Procedure | None",
    approach_proc: "Procedure | None",
    approach_name: str,
    vectored: bool,
) -> str | None:
    """The ATC clearance this arrival is flown under, as phraseology.

    The VTBS STAR charts print, against the vector hand-over fixes:

        "After ESGEN, ATKIN maintain heading 015 or as directed by ATC.
         Do not proceed Instrument Approach Procedure without ATC clearance."

    So an open STAR NEVER continues into the approach on its own. Both flows
    are therefore clearances and both are recorded — the difference is which
    one was issued:

        vectored   AFTER ATKIN MAINTAIN HEADING 015, VECTORS R19
        published  DIRECT LETMA, CLEARED R19 APPROACH

    A closed STAR connects to the IAF by design, so it carries the approach
    clearance alone. ``None`` when there is no approach to be cleared for.
    """
    name = (approach_name or "").strip().upper()
    if approach_proc is None or not name:
        return None
    if star_proc is not None and star_proc.is_open:
        leg = star_proc.vector_termination
        start = star_proc.last_fix()
        if vectored and leg is not None and start is not None:
            # Magnetic, as the chart prints it and as ATC would say it — not
            # the true course the geometry is solved in.
            crs = leg.magnetic_course
            hdg = f"{int(round(crs)) % 360:03d}" if crs is not None else "AS ASSIGNED"
            return f"AFTER {start.ident} MAINTAIN HEADING {hdg}, VECTORS {name}"
        entry = approach_proc.waypoints()
        if entry:
            return f"DIRECT {entry[0].ident}, CLEARED {name} APPROACH"
    return f"CLEARED {name} APPROACH"


def _threshold_json(ades: str, arr_rwy: object) -> dict[str, float] | None:
    """Landing threshold coordinates for the response, or ``None`` when the
    runway isn't on record. The client has no runway database of its own, and
    the threshold is what arrival sequencing measures spacing against."""
    rwy = runway_end(ades, arr_rwy if isinstance(arr_rwy, str) else None)
    return {"lat": rwy.lat, "lon": rwy.lon} if rwy is not None else None


def _vector_heading_true(
    ades: str, star_proc: "Procedure | None", arr_rwy: str | None
) -> float | None:
    """The published heading an OPEN STAR hands the arrival over on, in degrees
    TRUE. ``None`` for a closed STAR, or when the runway's magnetic variation
    isn't on record (the leg publishes the course magnetic)."""
    if star_proc is None:
        return None
    leg = star_proc.vector_termination
    if leg is None or leg.magnetic_course is None:
        return None
    rwy = runway_end(ades, arr_rwy)
    if rwy is None:
        return None
    return round((leg.magnetic_course + rwy.magnetic_variation) % 360.0, 1)


def _vector_heading_magnetic(star_proc: "Procedure | None") -> float | None:
    """The vector-termination course exactly as the chart publishes it — the
    magnetic course coded on the VM leg, no variation applied. This is the
    number that belongs in phraseology; :func:`_vector_heading_true` is the one
    that belongs in the geometry."""
    if star_proc is None:
        return None
    leg = star_proc.vector_termination
    if leg is None or leg.magnetic_course is None:
        return None
    return round(leg.magnetic_course % 360.0, 1)


def _constraint_json(con: object) -> dict[str, object]:
    """Serialise an Altitude/Speed constraint dataclass to a plain dict."""
    return {
        "type": con.type.value,  # type: ignore[attr-defined]
        **{
            k: getattr(con, k)
            for k in ("alt1_ft", "alt2_ft", "speed_kt")
            if hasattr(con, k)
        },
    }


@app.get("/api/procedures/{airport}")
def list_procedures(
    airport: str, response: Response, type: str | None = None
) -> dict[str, object]:
    """List SID/STAR names published at an aerodrome.

    ``type`` (optional) restricts to "SID" or "STAR".
    """
    response.headers["Cache-Control"] = _STATIC_CACHE
    nav = _navdata()
    proc_type = _parse_proc_type(type)
    if proc_type is not None:
        names = nav.list_procedures(airport, proc_type)
        return {"airport": airport.upper(), type.upper(): names}  # type: ignore[union-attr]
    return {
        "airport": airport.upper(),
        "SID": nav.list_procedures(airport, ProcedureType.SID),
        "STAR": nav.list_procedures(airport, ProcedureType.STAR),
    }


@app.get("/api/suggest-procedure/{airport}")
def suggest_procedure(
    airport: str,
    response: Response,
    type: str | None = None,
    route: str | None = None,
    runway: str | None = None,
) -> dict[str, object]:
    """Suggest the SID/STAR that best connects to the enroute ``route``.

    ``type`` = "SID" or "STAR"; ``route`` = the Item-15 enroute string;
    ``runway`` (optional) restricts to procedures serving it. Returns the best
    procedure name (or ``null``) per :func:`_suggest_procedure` — the priority
    is exact-fix, then same-airway, then nearest, then least-turn, then AIP
    order. Lets the generator auto-select a SID/STAR for a route whose first/
    last fix isn't itself a procedure exit (e.g. a route filed off a VOR).
    """
    response.headers["Cache-Control"] = _STATIC_CACHE
    proc_type = _parse_proc_type(type)
    if proc_type is None or proc_type is ProcedureType.APPROACH:
        raise HTTPException(400, "type must be SID or STAR")
    nav = _navdata()
    route_ctx: "_RouteCtx | None" = None
    if route and route.strip():
        idx = _airway_waypoint_index()
        pts = [
            (i, *idx[i]) for i in parse_route(_expand_airways(route)) if i in idx
        ]
        route_ctx = _route_ctx(pts, proc_type)
    name = _suggest_procedure(nav, airport.upper(), proc_type, route_ctx, runway)
    return {"airport": airport.upper(), "type": proc_type.value, "name": name}


@app.get("/api/procedures/{airport}/{name}")
def get_procedure(
    airport: str,
    name: str,
    response: Response,
    type: str | None = None,
    runway: str | None = None,
    transition: str | None = None,
    auto: bool = True,
    route: str | None = None,
) -> dict[str, object]:
    """Resolve a SID/STAR to ordered legs carrying altitude/speed constraints.

    When ``auto`` is true (the default, used by the map's click-to-load), any
    runway/transition ambiguity is resolved by picking the first candidate and
    reporting it in ``assumptions`` — so a single click always yields legs.
    Set ``auto=false`` to get a 409 listing the choices instead.

    ``route`` (the enroute Item-15 string) lets the resolver pick the
    transition the flight actually flies — STAR NAKO1B with ``… BLAFF DCT
    NAKON`` resolves to the BLAFF transition, not the first-listed ALBOS — so
    the map preview matches what generation will splice.
    """
    response.headers["Cache-Control"] = _STATIC_CACHE
    nav = _navdata()
    proc_type = _parse_proc_type(type)
    route_ctx: "_RouteCtx | None" = None
    if route and route.strip() and proc_type is not None:
        idx = _airway_waypoint_index()
        pts = [
            (i, *idx[i])
            for i in parse_route(_expand_airways(route))
            if i in idx
        ]
        route_ctx = _route_ctx(pts, proc_type)
    try:
        proc, assumptions = _resolve_procedure_auto(
            nav,
            airport,
            name,
            proc_type=proc_type,
            runway=runway,
            transition=transition,
            auto=auto,
            route_ctx=route_ctx,
        )
    except ProcedureNotFoundError as e:
        raise HTTPException(
            404,
            {"detail": str(e), "available": e.available},  # type: ignore[arg-type]
        ) from None
    except AmbiguousProcedureError as e:
        raise HTTPException(
            409,
            {  # type: ignore[arg-type]
                "detail": str(e),
                "kind": e.kind,
                "candidates": sorted(e.candidates),
            },
        ) from None

    return {
        "airport": proc.airport,
        "name": proc.name,
        "type": proc.proc_type.value,
        "runway": proc.runway,
        "transition": proc.transition,
        "assumptions": assumptions,
        "legs": [
            {
                "seqno": lg.seqno,
                "path_terminator": lg.path_terminator,
                "ident": lg.ident,
                "lat": lg.lat,
                "lon": lg.lon,
                "turn": lg.turn_direction,
                "altitude": _constraint_json(lg.altitude),
                "speed": _constraint_json(lg.speed),
            }
            for lg in proc.legs
        ],
        "waypoints": [
            {"ident": w.ident, "lat": w.lat, "lon": w.lon}
            for w in proc.waypoints()
        ],
    }


def _resolve_star_best_effort(
    nav: NavData, ades: str, name: str, runway: str | None
) -> "Procedure | None":
    """The STAR's fixes without caring which enroute transition — any resolution
    lists the same body fixes. Used only to know which fixes the arrival flies
    (for the approach-entry match), so an ambiguous STAR just takes the first
    candidate rather than erroring."""
    try:
        return nav.lookup_procedure(
            ades, name, proc_type=ProcedureType.STAR, runway=runway
        )
    except AmbiguousProcedureError as e:
        for cand in sorted(e.candidates):
            try:
                return nav.lookup_procedure(
                    ades,
                    name,
                    proc_type=ProcedureType.STAR,
                    runway=runway,
                    transition=cand,
                )
            except (AmbiguousProcedureError, ProcedureNotFoundError):
                continue
    except ProcedureNotFoundError:
        return None
    return None


@app.get("/api/approach-entries/{airport}/{name}")
def approach_entries(
    airport: str,
    name: str,
    response: Response,
    runway: str | None = None,
    route: str | None = None,
    star: str | None = None,
) -> dict[str, object]:
    """Entry fixes (IAF transitions) of a PBN approach, and which of them the
    given route + STAR actually flies through.

    A PBN approach can be joined at any of its IAF transitions — e.g. VTSP
    ``R27-Y`` at BARON, PACUS or STONE. When an arriving STAR passes more than
    one of those entry fixes (SUSI1D flies ``… STONE, CIDER, BARON, CI27``, so
    both STONE and BARON are options), the generator lets the pilot pick where
    to join instead of auto-scoring. This tells it which entries lie on the
    route, in the approach's own order, so the dropdown offers only real
    choices.

    Args:
        runway: Arrival runway (narrows STAR resolution).
        route: Item-15 enroute string — its fixes count as flown.
        star: Chosen STAR name — its body fixes count as flown too.

    Returns ``{airport, name, entries, matching}``: ``entries`` = every IAF
    entry fix; ``matching`` = those on the route/STAR (⊆ entries).
    """
    response.headers["Cache-Control"] = _STATIC_CACHE
    nav = _navdata()
    ades = airport.upper()
    entries: list[str] = []
    for _t, ident, _la, _lo in _procedure_entries(
        nav, ades, name, ProcedureType.APPROACH, runway
    ):
        if ident not in entries:
            entries.append(ident)

    # Fixes flown before the approach = the enroute route ∪ the resolved STAR.
    flown: set[str] = set()
    if route and route.strip():
        for i in parse_route(_expand_airways(route)):
            flown.add(i.upper())
    if star and star.strip():
        sp = _resolve_star_best_effort(nav, ades, star.strip(), runway)
        if sp is not None:
            for w in sp.waypoints():
                flown.add(w.ident.upper())

    matching = [i for i in entries if i in flown]
    return {
        "airport": ades,
        "name": name,
        "entries": entries,
        "matching": matching,
    }


def _parse_proc_type(value: str | None) -> "ProcedureType | None":
    """Map a 'SID'/'STAR' query value to ProcedureType, or None if absent."""
    if not value:
        return None
    try:
        return ProcedureType(value.strip().upper())
    except ValueError:
        raise HTTPException(
            400, f"type must be SID or STAR, got {value!r}"
        ) from None


def _generate_one(req: GenerateRequest) -> dict[str, object]:
    """Build one trajectory + its payload. Shared by the single-flight
    /api/generate endpoint and the bulk /api/generate_batch loop."""
    warnings: list[str] = []

    # --- Validate the city pair (any Thai aerodrome pair is allowed) ---
    adep = req.adep.strip().upper()
    ades = req.ades.strip().upper()
    actype = req.actype.strip().upper() or _DEFAULT_ACTYPE

    # Transit flight: starts at its entry level (capped by what the airframe can
    # actually reach) instead of on the ground, and ends at that level too unless
    # it lands somewhere the AIP has coordinates for — then it descends to that
    # aerodrome as usual. `None` for both = the ordinary ground-to-ground flight.
    #
    # An aerodrome with no coordinates (a foreign field) can't be where the route
    # starts or ends: the route's first / last fix then stands in for the point the
    # aircraft crosses into / out of the area, so it is at level there — not on the
    # ground at a fix in mid-air. That holds with or without an explicit
    # `entry_fl`, which only says WHICH level the aircraft entered at.
    transit_start_ft: float | None = None
    transit_end_ft: float | None = None
    _ceiling_ft = reachable_ceiling_ft(actype)
    _level_ft = min(float(req.entry_fl or req.rfl) * 100.0, _ceiling_ft)
    if req.entry_fl and req.entry_fl > 0:
        transit_start_ft = min(float(req.entry_fl) * 100.0, _ceiling_ft)
    elif _airport_ll(adep) is None:
        transit_start_ft = _level_ft
    if _airport_ll(ades) is None:
        transit_end_ft = transit_start_ft if transit_start_ft is not None else _level_ft

    if not adep or not ades:
        raise HTTPException(400, "ADEP and ADES are required.")
    if adep == ades:
        raise HTTPException(
            400, f"ADEP and ADES must differ (both {adep})."
        )

    if req.source == "csv":
        # Legacy shortcut: "follow the full published Y8 airway" from the
        # AIP cache. Only meaningful for the VTBS<->VTSP corridor; any
        # other pair should use FPL mode (type the route explicitly).
        if {adep, ades} != {"VTBS", "VTSP"}:
            raise HTTPException(
                400,
                "CSV (full-Y8) mode only covers VTBS <-> VTSP. "
                "Use route mode to type an Item-15 route for other pairs.",
            )
        route_pts = _airway_route_points("Y8", reverse=adep == "VTSP")
    elif req.source == "fpl":
        # Expand `<fix> <airway> <fix>` spans before parsing so the
        # trajectory follows the airway. Works for ALL 134 AIP airways.
        idents = parse_route(_expand_airways(req.route))
        if not idents:
            raise HTTPException(400, "No waypoints parsed from route string.")
        index = _airway_waypoint_index()
        route_pts = []
        missing = []
        for ident in idents:
            if ident in index:
                lat, lon = index[ident]
                route_pts.append((ident, lat, lon))
            elif (ad_ll := _airport_ll(ident)) is not None:
                # An aerodrome named IN the route ("VYMD DCT VYTL" — a short
                # domestic hop filed with no en-route fix at all). It is not a
                # significant point, so the fix index has never held it, but the
                # AIP knows where it is; dropping it left such a route with
                # nothing to fly.
                route_pts.append((ident, ad_ll[0], ad_ll[1]))
            else:
                missing.append(ident)
        if missing:
            warnings.append(
                f"Not found in AIP navdata (skipped): {', '.join(missing)}"
            )
        # Orient the route by ADEP so the file/animation follow the city
        # pair: the path must start at the fix nearest ADEP. Only possible
        # when the departure aerodrome's coordinates are in the AIP; if
        # not (unknown/foreign field), keep the route as typed.
        adep_ll = _airport_ll(adep)
        if adep_ll is not None and len(route_pts) >= 2:
            d0 = _sq_dist(route_pts[0][1:], adep_ll)
            dN = _sq_dist(route_pts[-1][1:], adep_ll)
            if dN < d0:
                route_pts.reverse()
    else:
        raise HTTPException(400, f"Unknown source {req.source!r}")

    # Phase 4: splice the SID (at ADEP) and STAR (at ADES) around the now
    # ADEP-oriented enroute fixes, before the < 2 check — a thin route can
    # become valid once its terminal procedures are folded in.
    route_pts, route_constraints, terminal, path_pts = _splice_terminal_procedures(
        req, adep, ades, route_pts, warnings
    )

    if len(route_pts) < 2:
        raise HTTPException(400, "Route resolved to fewer than 2 waypoints.")

    try:
        eobt = parse_eobt(req.eobt)
    except ValueError as e:
        raise HTTPException(400, f"Invalid EOBT: {e}") from None

    # Construct the canonical FlightPlan dataclass — Phase 2 spec says
    # RFL must be read from FlightPlan, not threaded as a bare int. The
    # ``route`` field captures the raw Item-15 string (or a synthetic one
    # in CSV mode) so the FPL is round-trippable.
    if req.source == "csv":
        fpl_route_str = "DCT " + " ".join(p[0] for p in route_pts) + " DCT"
    else:
        fpl_route_str = req.route
    try:
        fpl = FlightPlan(
            callsign=req.callsign or "FLT",
            aircraft_type=actype,
            adep=adep,
            ades=ades,
            eobt=eobt,
            rfl=int(req.rfl),
            route=fpl_route_str,
        )
    except ValueError as e:
        raise HTTPException(400, f"Invalid flight plan: {e}") from None

    # `path_pts` is already the whole flown path: the aerodrome anchors, the
    # fixes, and the turn arcs between them (see `_finish`). The timeline emits
    # a track sample at every one of its vertices.
    waypoint_sequence = [(lat, lon) for _, lat, lon in path_pts]

    # Multi-route requests share (callsign, EOBT) — disambiguate the
    # flight_key/filename with an R-prefixed suffix instead of mangling
    # the callsign so the CSV's Callsign column stays the user's value.
    flight_key_suffix = (
        f"R{req.flight_index + 1}" if req.flight_index is not None else ""
    )
    # Any speed-schedule override present?
    _has_sched_override = any(
        v is not None
        for v in (
            req.climb_cas_kt,
            req.climb_mach,
            req.cruise_mach,
            req.descent_mach,
            req.descent_cas_kt,
        )
    )
    _has_override = _has_sched_override or req.restrict_cas_kt is not None

    # Serialise generation: the tuning setters mutate module globals in
    # trajectory_sim.performance, so we snapshot → apply → build →
    # restore under a lock to keep requests isolated.
    with _GEN_LOCK:
        orig_sched = aircraft_speeds(actype)
        orig_restrict = get_speed_restriction()
        try:
            if _has_sched_override:
                tune_speed_schedule(
                    actype,
                    climb_cas_kt=req.climb_cas_kt,
                    climb_mach=req.climb_mach,
                    cruise_mach=req.cruise_mach,
                    descent_mach=req.descent_mach,
                    descent_cas_kt=req.descent_cas_kt,
                )
            if req.restrict_cas_kt is not None:
                set_speed_restriction(cas_kt=req.restrict_cas_kt)

            gdf = build_trajectory_gdf(
                waypoint_sequence=waypoint_sequence,
                eobt=fpl.eobt,
                callsign=fpl.callsign,
                aircraft_type=fpl.aircraft_type,
                adep=fpl.adep,
                ades=fpl.ades,
                ground_speed_kt=req.gs_kt,
                # Phase 2 acceptance: cruise FL must be an exact match to
                # the FPL-requested level — read it from the dataclass,
                # not from the raw int the browser sent.
                rfl=(
                    fpl.rfl
                    if transit_start_ft is None
                    else int(round(transit_start_ft / 100.0))
                ),
                dep_elev_ft=transit_start_ft,
                des_elev_ft=transit_end_ft,
                flight_key_suffix=flight_key_suffix,
                # Surveillance Profile cadence chosen in the UI (default 5 s).
                output_every_s=req.output_every_s,
                # Phase 4: SID/STAR crossing restrictions shape the profile.
                constraints=route_constraints,
                # Phase 4: record the terminal procedures + resolved runways
                # in the exported trajectory (GeoPackage/CSV/GeoJSON).
                sid=terminal.get("sid"),
                star=terminal.get("star"),
                approach=terminal.get("approach"),
                dep_rwy=terminal.get("dep_rwy"),
                arr_rwy=terminal.get("arr_rwy"),
                clearance=terminal.get("clearance"),
                # The filed route fixes (SID + enroute + STAR + approach, with
                # idents) → the `waypoint` marker column. Taken from route_pts,
                # not the smoothed path_pts (whose idents are sparse).
                route_fixes=[(ident, la, lo) for ident, la, lo in route_pts],
            )
            # Snapshot the schedule actually flown *before* restore, so the
            # reported speed_schedule reflects this flight's overrides (not
            # the baseline the globals get reset to in `finally`).
            applied_sched = aircraft_speeds(actype)
            applied_crossover_ft = crossover_altitude_ft(actype)
            applied_restrict_kt = get_speed_restriction()[0]
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        finally:
            # Always restore the baseline schedule + restriction.
            set_speed_schedule(actype, orig_sched)
            set_speed_restriction(
                cas_kt=orig_restrict[0], below_alt_ft=orig_restrict[1]
            )

    # An aircraft on an assigned radar heading holds its last cleared level —
    # the chart note gives it a heading and nothing else, and no descent comes
    # with it. Flatten the downwind before the final glide is straightened, so
    # the two edits compose in the order they happen in the air.
    if terminal.get("vectored"):
        turn_i = next(
            (i for i, w in enumerate(route_pts) if w[0] == "TURN" and i > 0), None
        )
        if turn_i is not None and turn_i + 1 < len(route_pts):
            handover = route_pts[turn_i - 1]
            turn, intc = route_pts[turn_i], route_pts[turn_i + 1]
            grad = _level_on_the_assigned_heading(
                gdf,
                (handover[1], handover[2]),
                (turn[1], turn[2]),
                (intc[1], intc[2]),
            )
            # Holding the level moves that altitude onto the base leg. Say so
            # when the base then needs a gradient no jet flies rather than
            # emitting a profile that only looks right.
            if grad > _MAX_BASE_GRADIENT_FT_NM:
                warnings.append(
                    f"Vectors to final: holding the assigned level to the base "
                    f"turn leaves {grad:.0f} ft/NM to lose on the base leg "
                    f"(over {_MAX_BASE_GRADIENT_FT_NM:.0f}); the descent may "
                    f"not be flyable as planned."
                )

    # Land a flown approach ON the runway threshold. The shallow near-ground
    # descent rate + the MAPt's threshold-crossing altitude otherwise leave the
    # aircraft ~50 ft high; glide the final approach straight down to the
    # arrival-runway threshold elevation (AIP AD 2) — the same height the climb
    # departed from. Done on the GDF so the JSON points AND the file exports
    # (GeoPackage/CSV/GeoJSON) all land on the threshold.
    if terminal.get("approach") and len(route_pts) >= 2:
        faf = route_pts[-2]  # fix just before the MAPt = start of the final glide
        _glide_to_threshold(
            gdf,
            (faf[1], faf[2]),
            runway_threshold_elevation_ft(ades, terminal.get("arr_rwy")),
        )

    flight_key = str(gdf["flight_key"].iloc[0])

    # Build the JSON payload first (it's all the web needs to render the
    # map); the heavier file exports follow.
    # Phase 3: include `tas_kt` per point. `pd.isna` guards the legacy
    # constant-speed path where the column is None for every row.
    points = [
        {
            "lat": float(geom.y),
            "lon": float(geom.x),
            "epoch_ts": ts.isoformat(),
            "altitude_ft": None if alt is None else float(alt),
            "gs_kt": float(gs),
            "tas_kt": None if tas is None or pd.isna(tas) else float(tas),
            "track_deg": float(trk),
            "phase": str(ph),
        }
        for geom, ts, alt, gs, tas, trk, ph in zip(
            gdf.geometry,
            gdf["epoch_ts"],
            gdf["altitude_ft"],
            gdf["gs_kt"],
            gdf["tas_kt"],
            gdf["track_deg"],
            gdf["phase"],
            strict=True,
        )
    ]
    distance_nm = route_distance_nm(waypoint_sequence)
    elapsed_min = (
        gdf["epoch_ts"].iloc[-1] - gdf["epoch_ts"].iloc[0]
    ).total_seconds() / 60.0

    # Flight-time validation — real CAT62 sample where we have one, else an
    # estimate derived from THIS airframe's Thai APM performance. The
    # estimate needs the aircraft type and the level actually cruised: it
    # used to be a distance-only curve measured on a B738 to RFL350, which
    # graded every type against a 737 and failed turboprops that were
    # simulated correctly. A type with no Thai APM data of its own yields no
    # estimate at all (validate() returns None) rather than borrowing the
    # B738's numbers.
    _peak_alt_ft = max(
        (a for a in gdf["altitude_ft"].tolist() if a is not None),
        default=None,
    )
    _val = _CAT62_REF.validate(
        adep,
        ades,
        elapsed_min,
        distance_nm=distance_nm,
        aircraft_type=actype,
        cruise_alt_ft=_peak_alt_ft,
        # A transit flight has no climb / descent to time — validate it as the
        # level cruise it is, not against a ground-to-ground estimate.
        dep_elev_ft=(
            transit_start_ft
            if transit_start_ft is not None
            else field_elevation_ft(adep)
        ),
        arr_elev_ft=(
            transit_end_ft
            if transit_end_ft is not None
            else field_elevation_ft(ades)
        ),
    )
    validation = _val.to_dict() if _val is not None else None

    # Top of Climb / Top of Descent — the FIRST and LAST samples at the
    # cruise (peak) altitude. Driven by altitude, not the phase label, so a
    # SID/STAR constraint level-off below cruise (which reads as a brief
    # non-climb band) can't be mistaken for the real top of climb/descent.
    # The web uses these for map markers + altitude-profile annotations.
    _alts = [a for a in gdf["altitude_ft"].tolist() if a is not None]
    toc = tod = None
    if _alts:
        _peak = max(_alts)
        at_peak = [
            i
            for i, a in enumerate(gdf["altitude_ft"].tolist())
            if a is not None and a >= _peak - 50.0
        ]
        toc_i = at_peak[0]
        tod_i = at_peak[-1]
        toc = {
            "lat": float(gdf.geometry.iloc[toc_i].y),
            "lon": float(gdf.geometry.iloc[toc_i].x),
            "altitude_ft": float(gdf["altitude_ft"].iloc[toc_i]),
            "epoch_ts": gdf["epoch_ts"].iloc[toc_i].isoformat(),
        }
        tod = {
            "lat": float(gdf.geometry.iloc[tod_i].y),
            "lon": float(gdf.geometry.iloc[tod_i].x),
            "altitude_ft": float(gdf["altitude_ft"].iloc[tod_i]),
            "epoch_ts": gdf["epoch_ts"].iloc[tod_i].isoformat(),
        }
    cruise_alt_ft = (
        float(max(gdf["altitude_ft"].dropna()))
        if gdf["altitude_ft"].notna().any()
        else None
    )

    # Phase-3 summary: time-weighted average GS per phase + the planned
    # speed schedule the airframe is flying. Computed straight off the
    # gdf rather than re-running build_flight_timeline (one pass, all
    # the data already on hand).
    def _avg(col: str, phase: str) -> float | None:
        rows = gdf[gdf["phase"] == phase][col].dropna()
        if rows.empty:
            return None
        return float(rows.mean())

    # Time per phase = the SUM of the sample intervals carrying that label,
    # NOT the span from its first to its last sample. A route with altitude
    # constraints can re-enter "climb" after a level-off (see
    # trajectory._phase_for, which re-derives the phase from the altitude
    # trend), so the climb's first->last span swallowed the whole cruise and
    # the three phases added up to more than the flight lasted — an AT76 leg
    # reported climb 52.2 + cruise 26.4 + descent 18.0 = 96.6 min for a
    # 70-minute flight. Charging each interval to the phase of the sample
    # that opens it makes the three sum to the total exactly.
    _ph_seq = gdf["phase"].tolist()
    _ts_seq = gdf["epoch_ts"].tolist()
    _phase_secs: dict[str, float] = {}
    for _i in range(len(_ts_seq) - 1):
        _p = _ph_seq[_i]
        _phase_secs[_p] = (
            _phase_secs.get(_p, 0.0)
            + (_ts_seq[_i + 1] - _ts_seq[_i]).total_seconds()
        )

    def _phase_minutes(phase: str) -> float | None:
        if phase not in _ph_seq:
            return None
        return float(_phase_secs.get(phase, 0.0) / 60.0)

    speed_schedule = {
        "climb_cas_kt": applied_sched.climb_cas_kt,
        "climb_mach": applied_sched.climb_mach,
        "cruise_mach": applied_sched.cruise_mach,
        "descent_mach": applied_sched.descent_mach,
        "descent_cas_kt": applied_sched.descent_cas_kt,
        "crossover_ft": applied_crossover_ft,
        "below_fl100_restriction_kt": applied_restrict_kt,
    }
    phase_breakdown = {
        "climb": {
            "avg_tas_kt": _avg("tas_kt", "climb"),
            "avg_gs_kt": _avg("gs_kt", "climb"),
            "time_min": _phase_minutes("climb"),
        },
        "cruise": {
            "avg_tas_kt": _avg("tas_kt", "cruise"),
            "avg_gs_kt": _avg("gs_kt", "cruise"),
            "time_min": _phase_minutes("cruise"),
        },
        "descent": {
            "avg_tas_kt": _avg("tas_kt", "descent"),
            "avg_gs_kt": _avg("gs_kt", "descent"),
            "time_min": _phase_minutes("descent"),
        },
    }

    # ROUTE header carries the raw Item-15 string for fpl/build mode; in
    # CSV mode the route is the full Y8, so render it as "BKK Y8 PUT"
    # (or its reverse) for consistency with the live preview.
    if req.source == "csv":
        seq = _airway_sequence("Y8")
        route_for_header = (
            f"{seq[-1]} Y8 {seq[0]}" if adep == "VTSP" else f"{seq[0]} Y8 {seq[-1]}"
        )
    else:
        route_for_header = req.route

    # Route LineString prepended to the GeoJSON so it SHOWS the selected
    # route (not only the sampled points) and re-imports as an editable plan:
    # it carries the Item-15 string + plan metadata, and is stamped as a
    # top-level "route" member by `_materialise`.
    route_feature = {
        "type": "Feature",
        "properties": {
            "feature_type": "route",
            "flight_key": flight_key,
            "route": route_for_header,
            "callsign": req.callsign,
            "aircraft_type": actype,
            "adep": adep,
            "ades": ades,
            "rfl": int(req.rfl),
            "eobt": eobt.isoformat(),
            # The ATC clearance the arrival was flown under — plan metadata, so
            # it belongs on the route feature as well as the sampled points.
            "clearance": terminal.get("clearance"),
            "idents": [p[0] for p in route_pts],
        },
        "geometry": {
            "type": "LineString",
            "coordinates": [[lon, lat] for _, lat, lon in route_pts],
        },
    }
    # Per-point export enrichment. The TOC/TOD events are free (the indices are
    # already known), so they go on now. The airspace `sector` does NOT: it is
    # export-only — the JSON response never carries it — and it is the single
    # most expensive step in a build (an STRtree query per airspace layer, ~60%
    # of the time one flight takes). A 2000-flight import would pay that 2000
    # times over for files almost none of which are ever written, so it is
    # computed on DOWNLOAD instead (see `_ensure_sector_column`).
    _events = [""] * len(gdf)
    if toc is not None:
        _events[toc_i] = "TOC"
    if tod is not None:
        _events[tod_i] = "TOC/TOD" if tod_i == toc_i else "TOD"
    gdf["event"] = _events

    # Defer all disk I/O: stash the GeoDataFrame + render inputs and let the
    # download endpoints write each format on demand (see `_materialise`).
    # This is what makes "Generate all" fast — no GDAL writes during
    # generation, only the JSON response below.
    _cache_export(
        flight_key, gdf, route_for_header, float(req.rfl), route_feature,
        request=req,
    )

    return {
        "flight_key": flight_key,
        "meta": {
            "callsign": req.callsign,
            "aircraft_type": actype,
            "adep": adep,
            "ades": ades,
            "eobt": eobt.isoformat(),
            # Resolved terminal selection — the DEPARTURE half as well as the
            # arrival: a flight flown on a SID is not the same climb-out as a
            # DCT off the aerodrome, so anything reading the response back (the
            # dummy-file generators, a re-import of a downloaded flight) has to
            # be able to see which one it was. The arrival runway and its
            # threshold are what the client needs to sequence arrivals (it has
            # no runway database of its own for this); `star_open` and the
            # published vector heading say whether this arrival CAN be
            # vectored, which gates the "maintain heading" resolution.
            "sid": terminal.get("sid"),
            "dep_rwy": terminal.get("dep_rwy"),
            "star": terminal.get("star"),
            "star_entry": terminal.get("star_entry"),
            "approach": terminal.get("approach"),
            "arr_rwy": terminal.get("arr_rwy"),
            "arr_threshold": _threshold_json(ades, terminal.get("arr_rwy")),
            "star_open": bool(terminal.get("star_open")),
            "vector_heading_deg": terminal.get("vector_heading_deg"),
            "vector_heading_mag_deg": terminal.get("vector_heading_mag_deg"),
            "vectored": bool(terminal.get("vectored")),
            "clearance": terminal.get("clearance"),
            "engine": (
                "Python trajectory_sim · pyproj.Geod (WGS-84) · "
                f"{PERFORMANCE_SOURCE}"
            ),
        },
        "stats": {
            "waypoint_count": len(route_pts),
            "point_count": len(points),
            "distance_nm": round(distance_nm, 1),
            "time_minutes": round(elapsed_min, 1),
            "cruise_alt_ft": cruise_alt_ft,
            "rfl_ft": float(req.rfl) * 100.0,
        },
        "profile": {
            "toc": toc,
            "tod": tod,
            "speed_schedule": speed_schedule,
            "phase_breakdown": phase_breakdown,
            # The SID/STAR crossing altitudes (the coded values, e.g. 9000),
            # so the altitude-profile chart can label each level-off with the
            # real restriction instead of the altitude the sim happened to
            # level at (~8875).
            "constraints": [
                {"phase": c.phase, "alt_ft": a}
                for c in route_constraints
                for a in (c.alt_ceil_ft, c.alt_floor_ft)
                if a is not None
            ],
        },
        "validation": validation,
        "route": [
            {"ident": i, "lat": la, "lon": lo} for i, la, lo in route_pts
        ],
        "points": points,
        "warnings": warnings,
        "downloads": {
            "gpkg": f"/api/download/{flight_key}.gpkg",
            "csv": f"/api/download/{flight_key}.csv",
            "geojson": f"/api/download/{flight_key}.geojson",
        },
    }


def _generate_tactical(req: "GenerateRequest") -> dict[str, object]:
    """Fly `extend_downwind_nm` as an INSTRUCTION rather than a re-plan.

    Generates the flight twice — once as filed (vectored, no extension) and once
    with the longer downwind — then splices them at the hand-over fix, keeping
    everything already flown and taking only the new ground track. See
    :mod:`trajectory_sim.tactical` for why the re-plan alone is wrong.

    Applied for ANY extension including zero. That is deliberate: the splice
    re-times the tail from the speeds the aircraft actually reports, so a
    vectored arrival flown with no extension must go through the same path as
    one flown with 6 NM of it. Otherwise the two differ by the re-timing alone,
    and "extend by D" would appear to buy D plus a constant.

    Falls back to the plain re-plan whenever there is nothing to splice (no
    vector legs were produced, or the hand-over fix can't be identified).
    """
    extend_nm = max(0.0, float(req.extend_downwind_nm or 0.0))
    extended = _generate_one(
        req.model_copy(update={"vector_to_final": True})
    )

    idents = [w["ident"] for w in extended.get("route", [])]
    if "TURN" not in idents or idents.index("TURN") == 0:
        return extended
    handover = extended["route"][idents.index("TURN") - 1]

    baseline = _generate_one(
        req.model_copy(update={"extend_downwind_nm": 0.0, "vector_to_final": True})
    )
    spliced = splice_tactical_extension(
        baseline.get("points") or [],
        extended.get("points") or [],
        float(handover["lat"]),
        float(handover["lon"]),
    )
    if len(spliced) < 2:
        return extended

    # The route (ground track) is the extended one; the flown path is the
    # splice. Re-derive the headline numbers from what is actually flown.
    dist_nm = sum(
        haversine_distance(a["lat"], a["lon"], b["lat"], b["lon"])
        for a, b in zip(spliced, spliced[1:])
    )
    t0 = datetime.fromisoformat(str(spliced[0]["epoch_ts"]).replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(str(spliced[-1]["epoch_ts"]).replace("Z", "+00:00"))
    out = dict(extended)
    out["points"] = spliced
    out["stats"] = {
        **extended["stats"],
        "point_count": len(spliced),
        "distance_nm": round(dist_nm, 1),
        "time_minutes": round((t1 - t0).total_seconds() / 60.0, 2),
    }
    meta = dict(extended.get("meta") or {})
    meta["tactical_extend_nm"] = extend_nm
    meta["tactical_handover"] = handover["ident"]
    out["meta"] = meta
    if extend_nm > 0:
        out["warnings"] = [
            *(extended.get("warnings") or []),
            f"Downwind extended {extend_nm:.1f} NM tactically from "
            f"{handover['ident']}; the flight before that fix is unchanged.",
        ]
    return out


@app.post("/api/generate")
def generate(req: GenerateRequest) -> dict[str, object]:
    if req.tactical_extend:
        return _generate_tactical(req)
    return _generate_one(req)


class BatchRequest(BaseModel):
    """POST body for /api/generate_batch — a list of flight specs."""

    flights: list[GenerateRequest] = Field(default_factory=list)
    # Global index of this chunk's first flight. The client splits a big
    # "Generate all" into smaller chunks (so one huge request can't time out
    # or exhaust a small host); the offset keeps each route's flight_index —
    # and therefore its flight_key/R-suffix — globally unique across chunks.
    index_offset: int = 0


@app.post("/api/generate_batch")
def generate_batch(req: BatchRequest) -> dict[str, object]:
    """Generate many trajectories in one request.

    Each flight is built with :func:`_generate_one`. A failing flight is
    recorded in ``errors`` rather than aborting the whole batch, so a few
    bad rows in a 2000-row import don't sink the run. Every flight is
    given a distinct ``flight_index`` so flight_keys never collide even
    when two rows share callsign + EOBT.
    """
    if not req.flights:
        raise HTTPException(400, "No flights provided.")

    results: list[dict[str, object]] = []
    errors: list[dict[str, object]] = []
    for i, f in enumerate(req.flights):
        spec = f.model_copy(update={"flight_index": req.index_offset + i})
        try:
            results.append(_generate_one(spec))
        except HTTPException as e:
            errors.append(
                {
                    "index": i,
                    "callsign": f.callsign,
                    "adep": f.adep,
                    "ades": f.ades,
                    "detail": str(e.detail),
                }
            )
    return {"results": results, "errors": errors, "count": len(results)}


_MEDIA = {
    "gpkg": "application/geopackage+sqlite3",
    "csv": "text/csv",
    "geojson": "application/geo+json",
}


def _materialise(flight_key: str, ext: str) -> "Path | None":
    """Ensure ``<flight_key>.<ext>`` exists on disk, writing it on demand
    from the lazy export cache. Returns the path, or None when neither the
    file nor its cached build data exist (treated as "never generated", the
    same outcome the eager path produced for an unknown key).

    Generation no longer writes files, so this is where the GeoPackage /
    CSV / GeoJSON are actually produced — once, the first time a route is
    downloaded (single, zip, or combined). Subsequent requests hit the
    file on disk.
    """
    if not _safe_key(flight_key) or ext not in _MEDIA:
        return None
    path = _OUT_DIR / f"{flight_key}.{ext}"
    if path.is_file():
        return path
    bundle = _EXPORT_CACHE.get(flight_key)
    if bundle is None:
        return None
    gdf = _ensure_sector_column(bundle["gdf"])
    # Unresolved losses of separation (posted by the client's CD&R scan) become
    # a per-sample `conflict` column, so every format says at WHICH timestamps
    # this flight is below minima and against whom.
    spans = bundle.get("conflicts") or []
    if spans:
        gdf = _with_conflict_column(gdf, spans)  # type: ignore[arg-type]
    if ext == "gpkg":
        if path.exists():
            path.unlink()  # GPKG driver appends; ensure a clean layer
        write_geopackage(gdf, path)
    elif ext == "csv":
        write_csv(
            gdf,
            path,
            route_str=str(bundle["route_str"]),
            rfl=bundle["rfl"],  # type: ignore[arg-type]
            conflicts=spans,  # type: ignore[arg-type]
        )
    elif ext == "geojson":
        # Build the FeatureCollection straight from the GeoDataFrame (no slow
        # Fiona round-trip), then prepend the route LineString feature and
        # stamp the top-level "route" member, matching the old output.
        g = gdf.copy()  # type: ignore[union-attr]
        g["epoch_ts"] = g["epoch_ts"].astype(str)
        fc = json.loads(g.to_json())
        fc.setdefault("features", [])
        # The route feature carries the plan metadata — give it the conflict
        # windows too, so a reader gets the summary without scanning points.
        route_feature = bundle["route_feature"]
        if spans:
            route_feature = {
                **route_feature,  # type: ignore[dict-item]
                "properties": {
                    **(route_feature.get("properties") or {}),  # type: ignore[union-attr]
                    "unresolved_conflicts": spans,
                },
            }
        fc["features"].insert(0, route_feature)
        fc["route"] = bundle["route_str"]  # foreign member; handy on re-import
        path.write_text(json.dumps(fc), encoding="utf-8")
    return path


def _ensure_sector_column(gdf: object) -> object:
    """Add the altitude-aware airspace `sector` column, once, on first download.

    Kept off the generate path deliberately: nothing in the API response uses
    it, and computing it costs more than the rest of the build put together.
    The column is written back onto the cached GeoDataFrame, so the second and
    third format of the same flight reuse it.
    """
    if "sector" in gdf.columns:  # type: ignore[union-attr]
        return gdf
    gdf["sector"] = sector_columns(  # type: ignore[index]
        [float(g.x) for g in gdf.geometry],  # type: ignore[union-attr]
        [float(g.y) for g in gdf.geometry],  # type: ignore[union-attr]
        [
            None if a is None or pd.isna(a) else float(a)
            for a in gdf["altitude_ft"]  # type: ignore[index]
        ],
    )
    return gdf


def _conflict_labels(
    timestamps: "list", spans: "list[dict[str, object]]"
) -> list[str]:
    """Label each sample that falls inside an unresolved LOS window.

    ``"LOS <other callsign>"`` per breached window, several joined with ``" ; "``
    when a flight loses separation against more than one aircraft at the same
    instant. Rows outside every window stay blank — same convention as the
    ``event`` / ``waypoint`` marker columns.
    """
    windows: list[tuple[datetime, datetime, str]] = []
    for s in spans:
        try:
            a = datetime.fromisoformat(str(s.get("start_ts", "")).replace("Z", "+00:00"))
            b = datetime.fromisoformat(str(s.get("end_ts", "")).replace("Z", "+00:00"))
        except ValueError:
            continue
        if a.tzinfo is None:
            a = a.replace(tzinfo=timezone.utc)
        if b.tzinfo is None:
            b = b.replace(tzinfo=timezone.utc)
        other = str(s.get("with_callsign") or "").strip()
        windows.append((a, b, f"LOS {other}".strip()))

    out: list[str] = []
    for ts in timestamps:
        t = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        hits = [label for a, b, label in windows if a <= t <= b]
        out.append(" ; ".join(hits))
    return out


def _with_conflict_column(gdf: object, spans: "list[dict[str, object]]") -> object:
    """Copy of the export gdf carrying the `conflict` marker column. Copied
    rather than mutated: the cached gdf is shared with the live JSON response
    and with the other formats' renders."""
    g = gdf.copy()  # type: ignore[union-attr]
    g["conflict"] = _conflict_labels(list(g["epoch_ts"]), spans)  # type: ignore[index]
    return g


@app.get("/api/download/{flight_key}.{ext}")
def download(flight_key: str, ext: str) -> FileResponse:
    if ext not in _MEDIA:
        raise HTTPException(400, f"Unsupported format .{ext}")
    # flight_key is generated server-side; reject any path trickery.
    if "/" in flight_key or "\\" in flight_key or ".." in flight_key:
        raise HTTPException(400, "Invalid flight key.")
    path = _materialise(flight_key, ext)
    if path is None:
        raise HTTPException(404, "File not found — generate it first.")
    return FileResponse(
        path, media_type=_MEDIA[ext], filename=f"{flight_key}.{ext}"
    )


class RecachePoint(BaseModel):
    """One trajectory sample for a re-cache (the client's modified path)."""

    lat: float
    lon: float
    epoch_ts: str  # ISO 8601 (…Z or +00:00)
    altitude_ft: float | None = None
    gs_kt: float | None = None
    tas_kt: float | None = None
    track_deg: float | None = None
    phase: str = "cruise"


class RecacheRequest(BaseModel):
    """POST body for ``/api/recache`` — replace a flight's exported points with a
    client-modified path (e.g. after a CD&R resolution is applied), so every
    download format serves the POST-fix trajectory instead of the original."""

    flight_key: str
    points: list[RecachePoint]


def _points_to_gdf(
    flight_key: str,
    const: dict[str, object],
    points: list,
    fixes: "list[tuple[str, float, float]] | None" = None,
) -> object:
    """Build the export GeoDataFrame (with sector + TOC/TOD event + waypoint
    columns) from a list of trajectory samples and a dict of constant per-flight
    columns. Shared by ``/api/recache`` (const + fixes reused from the cached gdf)
    and ``/api/ingest`` (const supplied by the caller for a file loaded as-is)."""
    import geopandas as gpd  # already loaded via trajectory_sim.output
    from shapely.geometry import Point

    records = []
    for p in points:
        alt = p.altitude_ft
        geom = (
            Point(p.lon, p.lat, (alt or 0.0) * 0.3048)
            if alt is not None
            else Point(p.lon, p.lat)
        )
        records.append(
            {
                "flight_key": flight_key,
                "callsign": const.get("callsign", ""),
                "aircraft_type": const.get("aircraft_type", ""),
                "adep": const.get("adep", ""),
                "ades": const.get("ades", ""),
                "dep_rwy": const.get("dep_rwy", ""),
                "arr_rwy": const.get("arr_rwy", ""),
                "sid": const.get("sid", ""),
                "star": const.get("star", ""),
                "approach": const.get("approach", ""),
                "epoch_ts": datetime.fromisoformat(p.epoch_ts.replace("Z", "+00:00")),
                "altitude_ft": alt,
                "tas_kt": p.tas_kt,
                "gs_kt": p.gs_kt,
                "track_deg": p.track_deg,
                "phase": p.phase,
                "geometry": geom,
            }
        )
    gdf = gpd.GeoDataFrame(records, crs="EPSG:4326", geometry="geometry")

    # Re-derive the same per-point enrichment the generate path adds. The
    # sector column is added on download, as it is there.
    events = [""] * len(gdf)
    prev = None
    for i, cur in enumerate(list(gdf["phase"])):
        if prev == "climb" and cur == "cruise":
            events[i] = "TOC"
        if prev == "cruise" and cur == "descent":
            events[i] = "TOC/TOD" if events[i] == "TOC" else "TOD"
        prev = cur
    gdf["event"] = events
    return assign_waypoint_column(gdf, fixes or [])


class ExtendRequest(BaseModel):
    """POST body for /api/extend/{flight_key}."""

    #: Extra distance to touchdown (NM) the arrival must absorb — the spacing
    #: deficit the sequencer reported.
    extend_nm: float = 0.0


@app.post("/api/extend/{flight_key}")
def extend_downwind(flight_key: str, body: ExtendRequest) -> dict[str, object]:
    """Re-fly an arrival with a longer downwind, tactically.

    The client sends only the flight key and how much track to absorb; the
    request that produced the flight is taken from the export cache, so nothing
    about the original spec has to be round-tripped through the browser.

    The result is spliced at the hand-over fix (see
    :func:`_generate_tactical`), so everything the aircraft has already flown
    is preserved and only the track after the hand-over changes.
    """
    if "/" in flight_key or "\\" in flight_key or ".." in flight_key:
        raise HTTPException(400, "Invalid flight key.")
    bundle = _EXPORT_CACHE.get(flight_key)
    if bundle is None:
        raise HTTPException(404, "Unknown flight key — generate it first.")
    req = bundle.get("request")
    if not isinstance(req, GenerateRequest):
        # Cached before the request was retained, or evicted and rebuilt from
        # a recache. Say so rather than silently doing nothing.
        raise HTTPException(
            409, "This flight was not generated with a retained request; "
                 "re-generate it before extending."
        )
    extend_nm = max(0.0, float(body.extend_nm))
    return _generate_tactical(
        req.model_copy(
            update={
                "vector_to_final": True,
                "extend_downwind_nm": extend_nm,
                "tactical_extend": True,
            }
        )
    )


@app.post("/api/recache")
def recache(req: RecacheRequest) -> dict[str, object]:
    """Rebuild a flight's download export from a client-supplied (modified) point
    list. Reuses the ORIGINAL cache entry's route string, RFL, route feature and
    constant columns (callsign / SID / STAR / approach / runways) — only the
    per-point path is swapped — so headers and the filed route line are
    preserved while the flown samples reflect the applied fix.
    """
    if "/" in req.flight_key or "\\" in req.flight_key or ".." in req.flight_key:
        raise HTTPException(400, "Invalid flight key.")
    bundle = _EXPORT_CACHE.get(req.flight_key)
    if bundle is None:
        raise HTTPException(404, "Unknown flight key — generate it first.")
    if len(req.points) < 2:
        raise HTTPException(400, "Need at least 2 points.")

    orig = bundle["gdf"]
    row0 = orig.iloc[0]
    const = {
        c: (row0[c] if c in orig.columns else "")
        for c in ("callsign", "aircraft_type", "adep", "ades",
                  "dep_rwy", "arr_rwy", "sid", "star", "approach")
    }
    # Reuse the original export's fix markers so the post-fix download keeps its
    # `waypoint` column (re-anchored to the nearest modified sample).
    fixes: list[tuple[str, float, float]] = []
    if "waypoint" in orig.columns:
        for wp, g in zip(orig["waypoint"], orig.geometry):
            if isinstance(wp, str) and wp:
                fixes.append((wp, float(g.y), float(g.x)))
    gdf = _points_to_gdf(req.flight_key, const, req.points, fixes)
    # Carry the ORIGINATING request across. Only the flown points change here;
    # the flight is still the one that request generated, and dropping it would
    # make every later tactical re-fly of this flight (`/api/extend`) fail with
    # "not generated with a retained request" — which is exactly what happens
    # to an arrival that has already had one instruction issued, since issuing
    # recaches.
    _cache_export(
        req.flight_key, gdf, bundle["route_str"], bundle["rfl"],
        bundle["route_feature"],
        request=bundle.get("request"),  # type: ignore[arg-type]
    )
    return {"ok": True, "flight_key": req.flight_key, "points": len(req.points)}


class ConflictSpan(BaseModel):
    """One stretch of a flight's path where it is below separation minima against
    another flight, as measured by the client's plan scan."""

    #: The other aircraft in the pair.
    with_callsign: str = ""
    with_flight_key: str = ""
    #: Inclusive UTC bounds of the breach (ISO 8601, "…Z" or "+00:00").
    start_ts: str
    end_ts: str
    #: Tightest gap reached inside the window, and the minima it breached.
    min_sep_nm: float | None = None
    min_vert_ft: float | None = None
    sep_min_nm: float | None = None
    sep_min_ft: float | None = None


class FlightConflictMarks(BaseModel):
    """The unresolved LOS windows of ONE flight. An empty ``spans`` clears the
    flight's marks (its conflict has been resolved)."""

    flight_key: str
    spans: list[ConflictSpan] = Field(default_factory=list)


class ConflictMarksRequest(BaseModel):
    """POST body for ``/api/conflict_marks``."""

    marks: list[FlightConflictMarks] = Field(default_factory=list)


@app.post("/api/conflict_marks")
def conflict_marks(req: ConflictMarksRequest) -> dict[str, object]:
    """Record which timestamps of a flight are in loss of separation.

    CD&R detection runs in the browser (it needs every flight's trajectory at
    once, which only the client holds), so the export cannot derive this itself.
    The client posts the UNRESOLVED windows just before a download; every format
    then carries a ``conflict`` column marking the affected track samples, plus —
    in the CSV — a ``CONFLICT:`` header line per window. Re-posting replaces a
    flight's marks, so a resolved conflict clears by posting an empty list.
    """
    updated = 0
    for m in req.marks:
        if not _safe_key(m.flight_key):
            continue
        bundle = _EXPORT_CACHE.get(m.flight_key)
        if bundle is None:
            continue  # never generated / evicted — nothing to annotate
        bundle["conflicts"] = [s.model_dump() for s in m.spans]
        # Any already-written file predates these marks; drop it so the next
        # download re-renders with (or without) the conflict column.
        _drop_files(m.flight_key)
        updated += 1
    return {"ok": True, "updated": updated}


class IngestFix(BaseModel):
    """One named route fix recovered from an imported file's `waypoint` column."""

    ident: str
    lat: float
    lon: float


class IngestRequest(BaseModel):
    """POST body for ``/api/ingest`` — register a trajectory loaded AS-IS from an
    uploaded file (e.g. a previously-downloaded, post-fix export) as a cached
    export, so its download files serve exactly the imported path without any
    regeneration. Unlike ``/api/recache`` it does NOT require a prior cache
    entry — all per-flight metadata is supplied here."""

    callsign: str
    aircraft_type: str = ""
    adep: str = ""
    ades: str = ""
    dep_rwy: str = ""
    arr_rwy: str = ""
    sid: str = ""
    star: str = ""
    approach: str = ""
    route_str: str = ""
    rfl: float = 0.0
    flight_key: str | None = None
    points: list[RecachePoint]
    # Named fixes (from the imported file's `waypoint` column) so a re-download
    # keeps the waypoint marker column.
    fixes: list[IngestFix] = Field(default_factory=list)


@app.post("/api/ingest")
def ingest(req: IngestRequest) -> dict[str, object]:
    """Cache an imported trajectory as a downloadable export (no regeneration)."""
    if len(req.points) < 2:
        raise HTTPException(400, "Need at least 2 points.")
    # Derive a stable flight_key (same scheme as generate: callsign_<EOBT>) when
    # the caller doesn't supply one.
    fk = req.flight_key
    if not fk:
        t0 = datetime.fromisoformat(req.points[0].epoch_ts.replace("Z", "+00:00"))
        fk = f"{req.callsign}_{t0.strftime('%Y%m%dT%H%MZ')}"
    fk = "".join(ch for ch in fk if ch.isalnum() or ch in "_-")
    if not fk:
        raise HTTPException(400, "Could not derive a flight key.")

    const = {
        "callsign": req.callsign, "aircraft_type": req.aircraft_type,
        "adep": req.adep, "ades": req.ades, "dep_rwy": req.dep_rwy,
        "arr_rwy": req.arr_rwy, "sid": req.sid, "star": req.star,
        "approach": req.approach,
    }
    fixes = [(f.ident, f.lat, f.lon) for f in req.fixes if f.ident]
    gdf = _points_to_gdf(fk, const, req.points, fixes)
    _cache_export(fk, gdf, req.route_str, req.rfl, None)
    return {
        "ok": True,
        "flight_key": fk,
        "points": len(req.points),
        "downloads": {
            "gpkg": f"/api/download/{fk}.gpkg",
            "csv": f"/api/download/{fk}.csv",
            "geojson": f"/api/download/{fk}.geojson",
        },
    }


class _ZipFileSpec(BaseModel):
    """One file to include in a download bundle."""

    flight_key: str
    ext: str  # "gpkg" | "csv" | "geojson"


class ZipRequest(BaseModel):
    """POST body for ``/api/download_zip``.

    Each entry pairs a server-generated flight_key with one of the
    supported extensions; the response is a single ``.zip`` archive
    containing every matching file laid out as ``<flight_key>.<ext>``.
    """

    files: list[_ZipFileSpec] = Field(default_factory=list)


class PrepareRequest(BaseModel):
    """POST body for ``/api/export_prepare`` — the same file specs as
    ``/api/download_zip``, rendered but not sent."""

    files: list[_ZipFileSpec] = Field(default_factory=list)


@app.post("/api/export_prepare")
def export_prepare(req: PrepareRequest) -> dict[str, object]:
    """Render the requested export files to disk WITHOUT returning them.

    Writing a route's file is the slow half of a download (GDAL writing the
    GeoPackage), and it happens inside the download request — where the client
    can only sit on a spinner, because no bytes flow until the whole export is
    finished. The download dialog therefore renders the routes through here in
    batches first, which gives it something real to count ("route 8 of 20"),
    and reports the size each one came to. The download that follows only has
    to concatenate and ship files that already exist.

    Idempotent: :func:`_materialise` returns an existing file untouched, so
    preparing then downloading does the work exactly once.
    """
    out: list[dict[str, object]] = []
    valid: list[tuple[str, str]] = []
    for spec in req.files:
        ext = spec.ext.lower()
        if ext in _MEDIA and _safe_key(spec.flight_key):
            valid.append((spec.flight_key, ext))

    # Same concurrency as the zip endpoint: GDAL/pyogrio release the GIL, so
    # the per-file writes overlap instead of running strictly back-to-back.
    with ThreadPoolExecutor(max_workers=min(8, (os.cpu_count() or 2) + 2)) as ex:
        materialised = list(
            ex.map(lambda fe: (fe, _materialise(fe[0], fe[1])), valid)
        )

    for (flight_key, ext), path in materialised:
        out.append(
            {
                "flight_key": flight_key,
                "ext": ext,
                "ready": path is not None,
                "bytes": path.stat().st_size if path is not None else 0,
            }
        )
    return {"files": out}


@app.post("/api/download_zip")
def download_zip(req: ZipRequest) -> Response:
    if not req.files:
        raise HTTPException(400, "No files requested.")

    # Validate + dedup the requested files (same path-traversal rejection as
    # the single-file endpoint). Dedup so two identical specs can't race on
    # writing the same path.
    seen: set[tuple[str, str]] = set()
    valid: list[tuple[str, str]] = []
    for spec in req.files:
        ext = spec.ext.lower()
        flight_key = spec.flight_key
        if ext not in _MEDIA:
            continue
        if "/" in flight_key or "\\" in flight_key or ".." in flight_key:
            continue
        key = (flight_key, ext)
        if key not in seen:
            seen.add(key)
            valid.append(key)

    # Materialise the files concurrently. GeoPackage/GeoJSON writing goes
    # through GDAL/pyogrio, which releases the GIL, so this overlaps the slow
    # per-file writes instead of doing them strictly back-to-back (the main
    # reason a big multi-route .gpkg download felt frozen). Each file has a
    # distinct path (deduped above), so concurrent writes don't collide.
    with ThreadPoolExecutor(max_workers=min(8, (os.cpu_count() or 2) + 2)) as ex:
        materialised = list(
            ex.map(lambda fe: (fe, _materialise(fe[0], fe[1])), valid)
        )

    # Build the archive in memory so we can stream it back without ever
    # writing it to disk — the output files are already on disk, this
    # endpoint only repackages them. Zipping stays sequential (one archive).
    buf = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for (flight_key, ext), path in materialised:
            if path is not None:
                zf.write(path, arcname=f"{flight_key}.{ext}")
                added += 1

    if added == 0:
        raise HTTPException(404, "None of the requested files were found.")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_name = f"trajectories_{stamp}.zip"
    # A plain Response, not StreamingResponse: the archive is already fully in
    # memory, and Starlette only sets Content-Length for a known-length body.
    # Without that header the browser cannot show a download percentage (it is
    # the one download header that IS CORS-safelisted, so the web app can read
    # it cross-origin).
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{archive_name}"'
        },
    )


class CombineRequest(BaseModel):
    """POST body for ``/api/download_combined``.

    Unlike ``/api/download_zip`` (which bundles each route as its own
    file), this MERGES the listed routes into a single combined file
    per requested format — e.g. one GeoPackage holding every flight's
    points in one ``trajectory`` layer, distinguishable by ``flight_key``.
    Useful for loading a whole traffic scenario as one dataset.
    """

    flight_keys: list[str] = Field(default_factory=list)
    formats: list[str] = Field(default_factory=list)


def _safe_key(flight_key: str) -> bool:
    return not (
        "/" in flight_key or "\\" in flight_key or ".." in flight_key
    )


def _load_combined_gdf(flight_keys: list[str]) -> "gpd.GeoDataFrame":
    """Read every route's GeoPackage and concat into one GeoDataFrame.

    The per-route ``.gpkg`` is the richest saved artefact (typed columns
    + POINT Z), so it's the canonical source for the merge.
    """
    import geopandas as gpd  # already loaded via trajectory_sim.output

    frames = []
    for fk in flight_keys:
        if not _safe_key(fk):
            continue
        path = _materialise(fk, "gpkg")
        if path is not None:
            frames.append(gpd.read_file(path))
    if not frames:
        return None  # type: ignore[return-value]
    combined = pd.concat(frames, ignore_index=True)
    combined = gpd.GeoDataFrame(
        combined, crs=frames[0].crs, geometry="geometry"
    )
    if "flight_key" in combined and "epoch_ts" in combined:
        combined = combined.sort_values(
            ["flight_key", "epoch_ts"]
        ).reset_index(drop=True)
    return combined


def _combined_bytes(combined: "gpd.GeoDataFrame", ext: str) -> bytes:
    """Serialise the merged GeoDataFrame to one file of the given format."""
    if ext == "gpkg":
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "combined.gpkg"
            write_geopackage(combined, p)
            return p.read_bytes()

    if ext == "geojson":
        g = combined.copy()
        # GeoJSON driver wants plain strings for datetimes.
        if "epoch_ts" in g:
            g["epoch_ts"] = g["epoch_ts"].astype(str)
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "combined.geojson"
            g.to_file(p, driver="GeoJSON")
            return p.read_bytes()

    raise HTTPException(400, f"Unsupported format .{ext}")


def _combined_csv_from_files(flight_keys: list[str]) -> bytes:
    """Stack each route's own readable CSV block into one file.

    The CSV is the human-readable export (ROUTE / DEST / ACTYPE / FL /
    ATD header + the 8-column table). For a combined download we keep
    that exact per-route layout and concatenate the blocks with a clear
    divider between routes, rather than flattening into one machine
    table — so the file reads like several flight strips in sequence.
    """
    blocks: list[str] = []
    total = len(flight_keys)
    for n, fk in enumerate(flight_keys, start=1):
        if not _safe_key(fk):
            continue
        path = _materialise(fk, "csv")
        if path is None:
            continue
        # Plain-ASCII divider — em-dashes mojibake in Excel/Notepad under
        # the cp874 Thai-Windows default (same reason write_csv avoids them).
        header = (
            "=" * 64
            + f"\nFLIGHT {n} of {total}  -  {fk}\n"
            + "=" * 64
            + "\n\n"
        )
        blocks.append(header + path.read_text(encoding="utf-8").rstrip("\n"))
    if not blocks:
        raise HTTPException(404, "None of the requested routes were found.")
    return ("\n\n\n".join(blocks) + "\n").encode("utf-8")


def _combined_geojson_from_files(flight_keys: list[str]) -> bytes:
    """Merge each flight's own .geojson into ONE FeatureCollection.

    Unlike the GeoPackage/GeoJSON gdf merge (points only), this reuses the
    per-flight ``.geojson`` files, which each already carry a ``route``
    LineString feature (with ``flight_key`` + the Item-15 string) plus the
    sample points. Concatenating their features keeps every flight's route
    intact and tagged by ``flight_key``, so a multi-flight download
    round-trips: the importer splits the features back by ``flight_key``,
    one editable plan per flight.
    """
    features: list[dict[str, object]] = []
    for fk in flight_keys:
        if not _safe_key(fk):
            continue
        path = _materialise(fk, "geojson")
        if path is None:
            continue
        try:
            fc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        features.extend(fc.get("features", []))
    if not features:
        raise HTTPException(404, "None of the requested routes were found.")
    return json.dumps(
        {"type": "FeatureCollection", "features": features}
    ).encode("utf-8")


@app.post("/api/download_combined")
def download_combined(req: CombineRequest) -> Response:
    flight_keys = [fk for fk in req.flight_keys if _safe_key(fk)]
    formats = [f.lower() for f in req.formats if f.lower() in _MEDIA]
    if not flight_keys:
        raise HTTPException(400, "No routes requested.")
    if not formats:
        raise HTTPException(400, "No formats requested.")

    # Only the GeoPackage needs the merged GeoDataFrame now. The CSV stacks
    # each route's own human-readable block, and the GeoJSON merges each
    # flight's own .geojson (route feature + points) so it round-trips per
    # flight — neither goes through the gdf.
    need_gdf = "gpkg" in formats
    combined = _load_combined_gdf(flight_keys) if need_gdf else None
    if need_gdf and (combined is None or len(combined) == 0):
        raise HTTPException(404, "None of the requested routes were found.")

    def bytes_for(ext: str) -> bytes:
        if ext == "csv":
            return _combined_csv_from_files(flight_keys)
        if ext == "geojson":
            return _combined_geojson_from_files(flight_keys)
        return _combined_bytes(combined, ext)  # type: ignore[arg-type]

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    # Single format → return that combined file directly. Multiple
    # formats → zip the combined files together.
    # Plain Responses so each carries a Content-Length — see download_zip.
    if len(formats) == 1:
        ext = formats[0]
        return Response(
            content=bytes_for(ext),
            media_type=_MEDIA[ext],
            headers={
                "Content-Disposition": (
                    f'attachment; filename="combined_{stamp}.{ext}"'
                )
            },
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for ext in formats:
            zf.writestr(f"combined_{stamp}.{ext}", bytes_for(ext))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="combined_{stamp}.zip"'
            )
        },
    )
