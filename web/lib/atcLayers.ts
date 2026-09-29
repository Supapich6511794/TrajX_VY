/**
 * Loaders for the extra ATC map layers re-added under /public/data. This
 * deployment reads the VY (Myanmar) files for everything that has one:
 *   - Gates    (airports/gateway.geojson) — dormant: the VY AIXM export has
 *              no GateStand feature, so no file ships and the loader fails
 *              closed; LayerOptions' Gates tab disables the toggle.
 *   - PBN      (aixm_vy/pbn_leg.geojson + aixm_vy/pbn_waypoint.geojson)
 *   - ILS      (aixm_vy/ils_leg.geojson + aixm_vy/ils_wp.geojson)
 *   - Airports (airports/Airport_with_AP_Main_vy.csv — carries the Main flag)
 *   - Runways  (airports/runway_vy.csv — threshold points)
 *
 * PBN/ILS share the SID/STAR DFD line + waypoint schema, so they reuse
 * `ProcedureLineCollection` / `ProcedureWaypointCollection`.
 */

import type {
  FeatureCollection,
  MultiPoint,
  MultiPolygon,
  Point,
} from "geojson";

import type {
  ProcedureLineCollection,
  ProcedureWaypointCollection,
} from "./types";

// `no-cache`, NOT `force-cache`: the bundled data files (SID/STAR/PBN/airway
// geojson) are edited in place when a procedure is corrected, and force-cache
// serves the browser's stale copy forever — a fixed procedure keeps drawing the
// old one until the cache is manually cleared. no-cache still uses the HTTP
// cache but revalidates first (a cheap 304 when the file is unchanged), so an
// edit shows up on the next load while unchanged files stay fast.
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(encodeURI(url), { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(encodeURI(url), { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** Minimal CSV → row objects (these files have no quoted/embedded commas). */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

/* --- Gates ---------------------------------------------------------------- */

export interface GateProperties {
  airport_identifier: string;
  gate_identifier: string;
  name?: string;
  gate_latitude: number;
  gate_longitude: number;
}
export type GateCollection = FeatureCollection<
  Point | MultiPoint,
  GateProperties
>;

/** Gate/stand positions. Dormant for VY (no file ships) — fails closed to an
 *  empty collection rather than throwing, so enabling the layer is a no-op. */
export const fetchGates = (): Promise<GateCollection> =>
  fetchJson<GateCollection>("/data/airports/gateway.geojson").catch(
    () => ({ type: "FeatureCollection", features: [] }) as GateCollection,
  );

/* --- PBN / ILS (same schema as SID/STAR) ---------------------------------- */
// AIXM 2609 (VY/Myanmar).

export const fetchPbnLines = (): Promise<ProcedureLineCollection> =>
  fetchJson<ProcedureLineCollection>("/data/aixm_vy/pbn_leg.geojson");
export const fetchPbnWaypoints = (): Promise<ProcedureWaypointCollection> =>
  fetchJson<ProcedureWaypointCollection>("/data/aixm_vy/pbn_waypoint.geojson");
export const fetchIlsLines = (): Promise<ProcedureLineCollection> =>
  fetchJson<ProcedureLineCollection>("/data/aixm_vy/ils_leg.geojson");
export const fetchIlsWaypoints = (): Promise<ProcedureWaypointCollection> =>
  fetchJson<ProcedureWaypointCollection>("/data/aixm_vy/ils_wp.geojson");

/* --- Myanmar (VY) airspace areas ------------------------------------------- */

/** One P/R/D restricted area or FIR/CTA/TMA/CTR boundary polygon — one
 *  feature per published AirspaceVolume (an area split into stacked altitude
 *  bands keeps each band's own limits). `activity_note`/`restriction`/
 *  `hazard`/`remarks` are almost always empty for VY: this export carries no
 *  AirspaceActivation schedule (activation windows, where known, live in
 *  `VY_AIP/pdr_activity.json`, from AIP Myanmar ENR 5.1). */
export interface AirspaceAreaProperties {
  type: string;
  designator: string;
  name: string;
  lower: string;
  upper: string;
  activity_note: string;
  restriction: string;
  hazard: string;
  remarks: string;
}
export type AirspaceAreaCollection = FeatureCollection<
  MultiPolygon,
  AirspaceAreaProperties
>;

export const fetchVyRestrictedAreas = (): Promise<AirspaceAreaCollection> =>
  fetchJson<AirspaceAreaCollection>("/data/aixm_vy/restricted_areas.geojson");
export const fetchVyAirspaceBoundaries = (): Promise<AirspaceAreaCollection> =>
  fetchJson<AirspaceAreaCollection>(
    "/data/aixm_vy/airspace_boundaries.geojson",
  );

/* --- Airports (CSV, with Main flag) --------------------------------------- */
// Derived from the AIXM 2609 (VY/Myanmar) export by
// scripts/ingest_aixm_airports.py — AIXM carries no ARINC-424 navdata fields
// (ifr_capability, transition altitude/level, speed limits, runway surface),
// so those columns are blank here; only identifier/name/position/Main
// are populated.

export interface PanelAirport {
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** True for the AIP "Main" aerodromes (VYYY/VYMD/VYNT) — grouped separately. */
  main: boolean;
}

export async function fetchPanelAirports(): Promise<PanelAirport[]> {
  const rows = parseCsv(
    await fetchText("/data/airports/Airport_with_AP_Main_vy.csv"),
  );
  return rows
    .map((r) => ({
      code: (r.airport_identifier || "").trim(),
      name: (r.airport_name || r.airport_identifier || "").trim(),
      lat: Number(r.airport_ref_latitude),
      lon: Number(r.airport_ref_longitude),
      main: (r.Main || "").trim().toUpperCase() === "Y",
    }))
    .filter(
      (a) => a.code && Number.isFinite(a.lat) && Number.isFinite(a.lon),
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

/* --- Runways (CSV, threshold points) -------------------------------------- */
// Derived from the same AIXM 2609 (VY/Myanmar) export by
// scripts/ingest_aixm_airports.py (RunwayDirection + RunwayCentrelinePoint
// for each threshold's position/bearing, Runway for length/width).

export interface RunwayPoint {
  airport: string;
  ident: string;
  lat: number;
  lon: number;
  /** Runway true bearing (degrees) — direction from this threshold. */
  bearing: number;
  /** Runway length (feet), for drawing the strip. */
  lengthFt: number;
  /** Runway width (feet). */
  widthFt: number;
  /** Landing threshold elevation (ft AMSL) of THIS runway end — not the
   *  whole runway's height. NaN when the AIXM export carries none. */
  thrElevFt: number;
}

export async function fetchRunways(): Promise<RunwayPoint[]> {
  const rows = parseCsv(await fetchText("/data/airports/runway_vy.csv"));
  return rows
    .map((r) => ({
      airport: (r.airport_identifier || "").trim(),
      ident: (r.runway_identifier || "").trim(),
      lat: Number(r.runway_latitude),
      lon: Number(r.runway_longitude),
      bearing: Number(r.runway_true_bearing),
      lengthFt: Number(r.runway_length),
      widthFt: Number(r.runway_width),
      thrElevFt:
        (r.landing_threshold_elevation || "").trim() === ""
          ? NaN
          : Number(r.landing_threshold_elevation),
    }))
    .filter(
      (r) => r.airport && Number.isFinite(r.lat) && Number.isFinite(r.lon),
    );
}
