"""Write trajectory data to GeoPackage and CSV.

Stitches per-leg interpolations from geodesy.interpolate_great_circle
into a single GeoDataFrame matching the sim_output.gpkg schema, then
writes to disk.
"""

from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

from trajectory_sim.geodesy import compute_bearing, interpolate_great_circle
from trajectory_sim.performance import (
    VerticalProfile,
    runway_threshold_elevation_ft,
)


def assign_waypoint_column(
    gdf: "gpd.GeoDataFrame", fixes: "list[tuple[str, float, float]]"
) -> "gpd.GeoDataFrame":
    """Add/replace a ``waypoint`` column: each named route fix labels the sample
    NEAREST to it (a fix-passing marker, like ``event``'s TOC/TOD); every other
    row is blank. Shared by the generate path and the re-cache/ingest builders so
    the exported CSV/GeoPackage/GeoJSON records which filed fix each pass is at."""
    n = len(gdf)
    col = [""] * n
    if fixes and n:
        xs = [float(g.x) for g in gdf.geometry]
        ys = [float(g.y) for g in gdf.geometry]
        for ident, flat, flon in fixes:
            if not ident:
                continue
            cosl = math.cos(math.radians(flat))
            best_i, best_d = -1, 1e30
            for i in range(n):
                dlat = ys[i] - flat
                dlon = (xs[i] - flon) * cosl
                d = dlat * dlat + dlon * dlon
                if d < best_d:
                    best_d, best_i = d, i
            if best_i >= 0:
                col[best_i] = str(ident)
    gdf["waypoint"] = col
    return gdf


def build_trajectory_gdf(
    waypoint_sequence: list[tuple[float, float]],
    eobt: datetime,
    callsign: str,
    aircraft_type: str,
    adep: str,
    ades: str,
    ground_speed_kt: float = 450.0,
    rfl: int | None = None,
    flight_key_suffix: str = "",
    *,
    variable_speed: bool = True,
    wind_kt: float | None = None,
    output_every_s: float = 4.0,
    constraints: "list | None" = None,
    sid: str | None = None,
    star: str | None = None,
    approach: str | None = None,
    dep_rwy: str | None = None,
    arr_rwy: str | None = None,
    clearance: str | None = None,
    fix_indices: "list[int] | None" = None,
    route_fixes: "list[tuple[str, float, float]] | None" = None,
    dep_elev_ft: float | None = None,
    des_elev_ft: float | None = None,
) -> gpd.GeoDataFrame:
    """Build a trajectory GeoDataFrame from a sequence of waypoints.

    Calls interpolate_great_circle on each consecutive pair and stitches
    the results, dropping the duplicate boundary point at each leg join.

    Args:
        waypoint_sequence: Ordered (latitude_deg, longitude_deg) tuples
            in WGS-84. Must contain at least 2 points.
        eobt: Estimated Off-Block Time, timezone-aware UTC. Used as t=0
            for the trajectory timestamps.
        callsign: ATC callsign.
        aircraft_type: ICAO aircraft type designator.
        adep, ades: ICAO departure and destination airports.
        ground_speed_kt: Constant ground speed in knots (Phase 1).
        rfl: Requested Flight Level in hundreds of feet (e.g. 330 →
            FL330). When given, a Phase 2 vertical profile is applied:
            altitude_ft is populated, phase is climb/cruise/descent, and
            the geometry becomes POINT Z. When None, Phase 1 behaviour is
            kept (altitude_ft None, phase "cruise", 2-D POINT).
        flight_key_suffix: Optional suffix appended to the generated
            flight_key (e.g. ``"R1"`` for "route 1 of N"). Lets the
            caller fly the same (callsign, EOBT) along several distinct
            routes without filename or PK collision, while keeping the
            ``callsign`` column itself unchanged.

    Returns:
        GeoDataFrame, EPSG:4326, with columns: flight_key, callsign,
        aircraft_type, adep, ades, dep_rwy, arr_rwy, sid, star, approach,
        clearance,
        epoch_ts (UTC), altitude_ft, tas_kt (None until Phase 3), gs_kt,
        track_deg, phase, geometry. The dep_rwy/arr_rwy/sid/star/approach
        columns carry the terminal-procedure selection ("" when none), so the
        exported trajectory records which SID/STAR/approach/runways were flown.

    Raises:
        ValueError: if waypoint_sequence has fewer than 2 points or
            eobt is not UTC-aware.
    """
    if eobt.tzinfo is None or eobt.utcoffset() != timedelta(0):
        raise ValueError("eobt must be timezone-aware UTC")
    if len(waypoint_sequence) < 2:
        raise ValueError("waypoint_sequence must contain at least 2 points")

    flight_key = f"{callsign}_{eobt.strftime('%Y%m%dT%H%MZ')}"
    if flight_key_suffix:
        flight_key = f"{flight_key}_{flight_key_suffix}"

    # Terminal-procedure selection, written into every row as constant
    # columns so the GeoPackage/GeoJSON/CSV export self-documents the SID,
    # STAR and the departure/arrival runways the trajectory was flown on.
    terminal_cols = {
        "dep_rwy": (dep_rwy or "").strip(),
        "arr_rwy": (arr_rwy or "").strip(),
        "sid": (sid or "").strip(),
        "star": (star or "").strip(),
        "approach": (approach or "").strip(),
        # The ATC clearance the arrival was flown under. An open STAR may not
        # enter the approach without one (see the VTBS STAR chart note), so the
        # export records WHICH clearance produced this path — vectors, or a
        # direct to the IAF.
        "clearance": (clearance or "").strip(),
    }

    # Named route fixes → (ident, lat, lon), for the `waypoint` marker column.
    # These are the FILED fixes (with idents), matched to the nearest sample by
    # position — independent of the sampled/smoothed path length.
    fixes: list[tuple[str, float, float]] = [
        (ident, lat, lon) for (ident, lat, lon) in (route_fixes or []) if ident
    ]

    # Phase 3 — variable speed timeline. Only kicks in when an RFL is
    # supplied (otherwise we have no altitude profile, hence no phase
    # boundaries and no per-phase ground speed).
    if variable_speed and rfl is not None:
        from trajectory_sim.trajectory import build_flight_timeline

        timeline = build_flight_timeline(
            waypoint_sequence=waypoint_sequence,
            aircraft_type=aircraft_type,
            adep=adep,
            ades=ades,
            rfl_ft=rfl * 100.0,
            eobt=eobt,
            wind_kt=wind_kt,
            output_every_s=output_every_s,
            constraints=constraints,
            # Anchor climb/descent to the selected runway thresholds.
            dep_runway=dep_rwy,
            ades_runway=arr_rwy,
            # Which of the waypoints are fixes vs. turn-arc vertices.
            fix_indices=fix_indices,
            # Start/end altitude override (a flight only passing through).
            dep_elev_ft=dep_elev_ft,
            des_elev_ft=des_elev_ft,
        )
        records = [
            {
                "flight_key": flight_key,
                "callsign": callsign,
                "aircraft_type": aircraft_type,
                "adep": adep,
                "ades": ades,
                **terminal_cols,
                "epoch_ts": s.epoch_ts,
                "altitude_ft": round(s.altitude_ft, 1),
                "tas_kt": round(s.tas_kt, 1),
                "gs_kt": round(s.gs_kt, 1),
                "track_deg": s.track_deg,
                "phase": s.phase,
                "geometry": Point(s.lon, s.lat, s.altitude_ft * 0.3048),
            }
            for s in timeline.samples
        ]
        return assign_waypoint_column(
            gpd.GeoDataFrame(records, crs="EPSG:4326", geometry="geometry"), fixes
        )

    # Legacy constant-ground-speed path — kept for callers that opt out
    # of the variable timeline by passing ``variable_speed=False`` or
    # leaving ``rfl`` as None.
    raw: list[dict[str, object]] = []
    cumulative_t_s = 0.0
    for i in range(len(waypoint_sequence) - 1):
        lat1, lon1 = waypoint_sequence[i]
        lat2, lon2 = waypoint_sequence[i + 1]
        leg_points = interpolate_great_circle(
            lat1,
            lon1,
            lat2,
            lon2,
            ground_speed_kt=ground_speed_kt,
            output_every_s=output_every_s,
        )
        track_deg = compute_bearing(lat1, lon1, lat2, lon2)

        for j, p in enumerate(leg_points):
            # Skip the leg's start point on legs after the first to avoid
            # duplicating the boundary waypoint.
            if i > 0 and j == 0:
                continue
            raw.append({
                "elapsed_s": cumulative_t_s + p["elapsed_s"],
                "lat": p["lat"],
                "lon": p["lon"],
                "track_deg": track_deg,
            })
        cumulative_t_s += leg_points[-1]["elapsed_s"]

    total_time_s = raw[-1]["elapsed_s"] if raw else 0.0

    # The vertical profile needs the total flight time, which is only
    # known once the horizontal path above is complete.
    profile: VerticalProfile | None = None
    if rfl is not None:
        profile = VerticalProfile.build(
            total_time_s=total_time_s,
            rfl_ft=rfl * 100.0,
            aircraft_type=aircraft_type,
            dep_elev_ft=(
                dep_elev_ft
                if dep_elev_ft is not None
                else runway_threshold_elevation_ft(adep, dep_rwy)
            ),
            des_elev_ft=(
                des_elev_ft
                if des_elev_ft is not None
                else runway_threshold_elevation_ft(ades, arr_rwy)
            ),
        )

    records: list[dict[str, object]] = []
    for r in raw:
        elapsed_s = float(r["elapsed_s"])
        if profile is not None:
            altitude_ft, phase = profile.at(elapsed_s)
            # POINT Z carries altitude (metres) in the geometry too.
            geom = Point(r["lon"], r["lat"], altitude_ft * 0.3048)
        else:
            altitude_ft, phase = None, "cruise"
            geom = Point(r["lon"], r["lat"])
        records.append({
            "flight_key": flight_key,
            "callsign": callsign,
            "aircraft_type": aircraft_type,
            "adep": adep,
            "ades": ades,
            **terminal_cols,
            "epoch_ts": eobt + timedelta(seconds=elapsed_s),
            "altitude_ft": altitude_ft,
            "tas_kt": None,
            "gs_kt": ground_speed_kt,
            "track_deg": r["track_deg"],
            "phase": phase,
            "geometry": geom,
        })

    return assign_waypoint_column(
        gpd.GeoDataFrame(records, crs="EPSG:4326", geometry="geometry"), fixes
    )


def write_geopackage(
    gdf: gpd.GeoDataFrame,
    path: str | Path,
    layer: str = "trajectory",
) -> None:
    """Write a trajectory GeoDataFrame to a GeoPackage layer.

    Overwrites the layer if it already exists. After writing, two
    indices are added on the trajectory layer to match the brief's
    output schema (§6.2):

      * UNIQUE INDEX on (flight_key, epoch_ts) — the brief specifies
        ``PRIMARY KEY (flight_key, epoch_ts)`` but SQLite cannot add a
        PRIMARY KEY to an existing table after ``geopandas.to_file``
        has created it; a UNIQUE index enforces the same constraint.
      * Plain INDEX on epoch_ts — for time-range scans (the brief's
        ``trajectory_ts_idx``).

    The R-tree spatial index on the geometry column is already created
    automatically by the GPKG driver.

    Args:
        gdf: GeoDataFrame as built by build_trajectory_gdf.
        path: Output .gpkg filesystem path.
        layer: Layer name within the GeoPackage (default "trajectory").
    """
    gpkg_path = Path(path)
    gdf.to_file(gpkg_path, layer=layer, driver="GPKG")

    # GeoPackage is a SQLite file — open it and add the brief-required
    # indices on the just-written layer. `IF NOT EXISTS` keeps repeat
    # writes (overwrite-same-layer) idempotent. The `with` block on a
    # sqlite3 connection only commits/rollbacks on exit; on Windows the
    # OS file lock survives a non-closed handle and blocks the next
    # request's `unlink()` — so close explicitly in a finally.
    conn = sqlite3.connect(gpkg_path)
    try:
        conn.execute(
            f'CREATE UNIQUE INDEX IF NOT EXISTS "{layer}_pk_idx" '
            f'ON "{layer}" (flight_key, epoch_ts)'
        )
        conn.execute(
            f'CREATE INDEX IF NOT EXISTS "{layer}_ts_idx" '
            f'ON "{layer}" (epoch_ts)'
        )
        conn.commit()
    finally:
        conn.close()


def _conflict_header_line(span: "dict") -> str:
    """One ``CONFLICT:`` header line describing an unresolved LOS window."""
    other = str(span.get("with_callsign") or "").strip() or "traffic"
    start = str(span.get("start_ts") or "")
    end = str(span.get("end_ts") or "")

    def _num(key: str, unit: str, nd: int = 1) -> str:
        v = span.get(key)
        if v is None:
            return ""
        try:
            f = float(v)
        except (TypeError, ValueError):
            return ""
        s = f"{f:.{nd}f}"
        if "." in s:  # trim only the fractional zeros — "300" must stay 300
            s = s.rstrip("0").rstrip(".")
        return f"{s} {unit}"

    got = " / ".join(x for x in (_num("min_sep_nm", "NM"), _num("min_vert_ft", "ft", 0)) if x)
    minima = " / ".join(
        x for x in (_num("sep_min_nm", "NM"), _num("sep_min_ft", "ft", 0)) if x
    )
    parts = [f"LOSS OF SEPARATION vs {other}", f"{start} - {end}"]
    if got:
        parts.append(f"min {got}")
    if minima:
        parts.append(f"minima {minima}")
    parts.append("UNRESOLVED")
    return "CONFLICT: " + "  |  ".join(parts)


def write_csv(
    gdf: gpd.GeoDataFrame,
    path: str | Path,
    *,
    route_str: str = "",
    rfl: int | None = None,
    conflicts: "list[dict] | None" = None,
) -> None:
    """Write a trajectory GeoDataFrame to the ATC-style trajectory CSV.

    Layout::

        ROUTE: <route_str>
        DEP: <adep>
        DEST: <ades>
        ACTYPE: <aircraft_type>
        DEP RWY: <dep_rwy>
        ARR RWY: <arr_rwy>
        CLEARANCE: <clearance>   (only when one was issued)
        SID: <sid>
        STAR: <star>
        APPROACH: <approach>
        FL: F<rfl>
        ATD: YYYY-MM-DD HH:MM:SS
        CONFLICT: LOSS OF SEPARATION vs <acid>  |  <start> - <end>  |  …

        ---

        Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction,Phase,Sector,Event,Waypoint,Conflict
        <epoch_s>,<iso_utc_Z>,<callsign>,<lat>,<lon>,<alt_ft>,<gs_kt>,<track_deg>,<phase>,<sector>,<toc/tod>,<fix>,<LOS acid>
        ...

    The column header names line up 1-to-1 with the fields of each data
    row, so Excel/pandas open the CSV with every value under the right
    header. Per row: ``Phase`` is climb/cruise/descent,
    ``Sector`` the airspace volume containing the aircraft at that timestamp
    (altitude-aware, e.g. "8S/Bangkok CTR" — a plane above a TMA's ceiling is
    not in it), ``Event`` marks the TOC / TOD samples (blank otherwise), and
    ``Conflict`` marks the samples at which this flight is below separation
    minima against another one ("LOS <acid>"; blank otherwise).
    The ``Sector`` field is double-quoted when it contains a comma (overlapping
    PDR areas are comma-joined).

    Args:
        gdf: GeoDataFrame as built by build_trajectory_gdf.
        path: Output .csv filesystem path.
        route_str: Raw Item-15 route string written into the ROUTE
            header (e.g. ``"BKK Y8 PUT"``). Optional; empty by default.
        rfl: Requested Flight Level (hundreds of feet) written into the
            FL header as ``"F<rfl>"``. Optional; the FL line is omitted
            when None.
        conflicts: Unresolved loss-of-separation windows for this flight
            (the CD&R scan's output). Each one gets a ``CONFLICT:`` header
            line naming the other aircraft and the UTC window, so the reader
            sees WHEN separation is lost without scanning the table. The
            per-row detail comes from the gdf's ``conflict`` column.
    """
    out_path = Path(path)

    # Metadata pulled from the gdf's constant columns. These are the
    # same for every row (the gdf is one flight).
    adep = str(gdf["adep"].iloc[0])
    ades = str(gdf["ades"].iloc[0])
    actype = str(gdf["aircraft_type"].iloc[0])
    callsign = str(gdf["callsign"].iloc[0])

    # Terminal-procedure metadata (constant per flight). Absent on gdfs built
    # before these columns existed, so read defensively.
    def _const(col: str) -> str:
        return str(gdf[col].iloc[0]) if col in gdf.columns else ""

    dep_rwy, arr_rwy = _const("dep_rwy"), _const("arr_rwy")
    sid, star, approach = _const("sid"), _const("star"), _const("approach")
    eobt_raw = gdf["epoch_ts"].iloc[0]
    eobt = (
        eobt_raw.to_pydatetime()
        if hasattr(eobt_raw, "to_pydatetime")
        else eobt_raw
    )
    if eobt.tzinfo is None:
        eobt = eobt.replace(tzinfo=timezone.utc)

    # Surveillance cadence — the ACTUAL spacing between emitted track
    # points (median of consecutive epoch_ts deltas), so the file self-
    # documents which Surveillance Profile produced it. The median ignores
    # the final, possibly-shorter endpoint step.
    def _to_dt(x: object) -> datetime:
        d = x.to_pydatetime() if hasattr(x, "to_pydatetime") else x
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d

    ts_list = list(gdf["epoch_ts"])
    cadence_s: float | None = None
    if len(ts_list) >= 2:
        deltas = sorted(
            (_to_dt(ts_list[i + 1]) - _to_dt(ts_list[i])).total_seconds()
            for i in range(len(ts_list) - 1)
        )
        cadence_s = deltas[len(deltas) // 2]  # median step

    with out_path.open("w", encoding="utf-8", newline="") as f:
        f.write(f"ROUTE: {route_str}\n")
        f.write(f"DEP: {adep}\n")
        f.write(f"DEST: {ades}\n")
        f.write(f"ACTYPE: {actype}\n")
        # Terminal procedures / runways — always emitted so the format
        # carries them (blank when the flight has none).
        f.write(f"DEP RWY: {dep_rwy}\n")
        f.write(f"ARR RWY: {arr_rwy}\n")
        f.write(f"SID: {sid}\n")
        f.write(f"STAR: {star}\n")
        f.write(f"APPROACH: {approach}\n")
        # The ATC clearance the arrival was flown under. Only written when one
        # was issued, so departures and non-terminal flights are unchanged.
        clearance = _const("clearance")
        if clearance:
            f.write(f"CLEARANCE: {clearance}\n")
        if rfl is not None:
            f.write(f"FL: F{rfl}\n")
        f.write(f"ATD: {eobt.strftime('%Y-%m-%d %H:%M:%S')}\n")
        # Unresolved conflicts — one line per loss-of-separation window, so the
        # controller reading the strip sees the times up front. Only written
        # when the flight still has one (a fixed conflict posts no window).
        for span in conflicts or []:
            f.write(_conflict_header_line(span) + "\n")
        if cadence_s is not None:
            cs = (
                int(cadence_s)
                if abs(cadence_s - round(cadence_s)) < 1e-6
                else round(cadence_s, 1)
            )
            f.write(f"SURVEILLANCE: {cs}s\n")
        # Plain-ASCII separator — em-dashes mojibake in Excel/Notepad
        # when the file is opened under cp1252/cp874 (Thai Windows
        # default), making "———" render as 'â€"â€"â€"'.
        f.write("\n---\n\n")
        # `Waypoint` and `Conflict` are appended LAST so the leading columns
        # keep their fixed positions (the re-importer reads Lat/Lon/… by index).
        f.write(
            "Timestamp,UTC,Callsign,Lat,Lon,Altitude,Speed,Direction,"
            "Phase,Sector,Event,Waypoint,Conflict\n"
        )

        # Per-point enrichment columns — absent on gdfs built before they
        # existed, so read defensively (blank keeps the column count stable).
        def _col(name: str) -> list[str]:
            if name in gdf.columns:
                return ["" if v is None or pd.isna(v) else str(v)
                        for v in gdf[name]]
            return [""] * len(gdf)

        def _quote(v: str) -> str:
            # Overlapping PDR areas are comma-joined -> CSV-quote the field.
            return f'"{v}"' if "," in v else v

        phases = _col("phase")
        sectors = _col("sector")
        events = _col("event")
        waypoints = _col("waypoint")
        conflict_col = _col("conflict")

        for i, (geom, ts, alt, gs, trk) in enumerate(
            zip(
                gdf.geometry,
                gdf["epoch_ts"],
                gdf["altitude_ft"],
                gdf["gs_kt"],
                gdf["track_deg"],
                strict=True,
            )
        ):
            ts_dt = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
            if ts_dt.tzinfo is None:
                ts_dt = ts_dt.replace(tzinfo=timezone.utc)
            epoch = int(ts_dt.timestamp())
            utc_iso = ts_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            alt_val = 0 if alt is None or pd.isna(alt) else int(round(float(alt)))
            gs_val = 0 if gs is None or pd.isna(gs) else int(round(float(gs)))
            trk_val = int(round(float(trk))) % 360
            f.write(
                f"{epoch},{utc_iso},{callsign},"
                f"{geom.y:.6f},{geom.x:.6f},"
                f"{alt_val},{gs_val},{trk_val},"
                f"{phases[i]},{_quote(sectors[i])},{events[i]},{waypoints[i]},"
                f"{_quote(conflict_col[i])}\n"
            )
