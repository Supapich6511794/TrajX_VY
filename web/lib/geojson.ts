/**
 * Loader for the ONE real source file: `public/data/airway_waypoint.geojson`
 * (a copy of the user-provided `airway waypoint.geojson`) — VT-only, with no
 * VY equivalent, and removed along with the rest of the Thailand data.
 * `fetchAirways()` now fails closed (empty collection) rather than throwing.
 *
 * Nothing here is fabricated. Airways are returned exactly as they appear in
 * the file. Waypoints are *derived* — we read the real lat/lon already stored
 * in each segment's properties (`waypoint_*` and `waypoint_*_2`) and
 * de-duplicate by identifier. No coordinate is invented or guessed.
 */

import { fetchRunways } from "./atcLayers";
import type {
  AirwayCollection,
  FirCollection,
  ProcedureLineCollection,
  ProcedureWaypointCollection,
  Waypoint,
} from "./types";

const SOURCE_URL = "/data/airway_waypoint.geojson";
const FIR_URL = "/data/fir.geojson";
// Terminal procedures: the AIXM 2609 (VY/Myanmar) export converted to the DFD
// schema by scripts/ingest_aixm_procedures.py. The VT/Thai equivalents this
// deployment used to read still sit under /data/aixm/ if it ever needs to
// switch back.
const SID_LINES_URL = "/data/aixm_vy/sid_line.geojson";
const STAR_LINES_URL = "/data/aixm_vy/star_line.geojson";
const SID_WPTS_URL = "/data/aixm_vy/sid_waypoint.geojson";
const STAR_WPTS_URL = "/data/aixm_vy/star_waypoint.geojson";
const PBN_WPTS_URL = "/data/aixm_vy/pbn_waypoint.geojson";
const ILS_WPTS_URL = "/data/aixm_vy/ils_wp.geojson";

// `no-cache` (revalidate), not `force-cache` (serve stale forever): the bundled
// geojson is edited in place when a procedure is corrected, so a hard-cached
// copy would keep the picker/preview on the old data. See atcLayers.fetchJson.
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Fetch SID procedure waypoints (the coded fixes). Loaded lazily. */
export function fetchSidWaypoints(): Promise<ProcedureWaypointCollection> {
  return fetchJson<ProcedureWaypointCollection>(SID_WPTS_URL);
}

/** Fetch STAR procedure waypoints (the coded fixes). Loaded lazily. */
export function fetchStarWaypoints(): Promise<ProcedureWaypointCollection> {
  return fetchJson<ProcedureWaypointCollection>(STAR_WPTS_URL);
}

/** Fetch PBN instrument-approach waypoints (the coded fixes). Loaded lazily. */
export function fetchPbnWaypoints(): Promise<ProcedureWaypointCollection> {
  return fetchJson<ProcedureWaypointCollection>(PBN_WPTS_URL);
}

/** Fetch ILS / conventional approach waypoints — the fallback approach source
 *  for aerodromes with no published PBN approach (e.g. VTUN → ILS "I24"). */
export function fetchIlsWaypoints(): Promise<ProcedureWaypointCollection> {
  return fetchJson<ProcedureWaypointCollection>(ILS_WPTS_URL);
}

// Memoised airport -> { runway -> [approach names] }, derived from the PBN
// approach GeoJSON. PBN procedures are named `R{rwy}` or `R{rwy}-{variant}`
// (e.g. R18, R09-Y, R09-Z), so the runway is parsed from the name; approaches
// are grouped under the "RW{rwy}" the Arrival-RWY picker uses. Built once.
let _approachIndex: Promise<Map<string, Record<string, string[]>>> | null = null;

/** Parse the landing runway (as an "RW…" ident) from an approach name. Handles
 *  PBN (`R09-Y`/`R18`/`R02L`) and ILS/conventional (`I24`/`I23LY`/`D05`/`L23`):
 *  a single-letter procedure prefix (R/I/D/L/N/V/S/Q…) then the runway number,
 *  optional side (L/C/R) and variant suffix. `null` for non-runway names
 *  (e.g. `VORA`, `NDBA`). */
function runwayOfApproach(name: string): string | null {
  const m = /^[A-Z](\d{2}[LCR]?)(?:[-A-Z].*)?$/.exec(name.trim().toUpperCase());
  return m ? `RW${m[1]}` : null;
}

function indexApproachNames(
  fc: ProcedureWaypointCollection,
): Map<string, Record<string, string[]>> {
  const m = new Map<string, Map<string, Set<string>>>();
  for (const f of fc.features) {
    const a = f.properties.airport_identifier;
    const n = f.properties.procedure_identifier;
    if (!a || !n) continue;
    const rwy = runwayOfApproach(n);
    if (!rwy) continue;
    let byRwy = m.get(a);
    if (!byRwy) m.set(a, (byRwy = new Map()));
    let names = byRwy.get(rwy);
    if (!names) byRwy.set(rwy, (names = new Set()));
    names.add(n);
  }
  const out = new Map<string, Record<string, string[]>>();
  for (const [a, byRwy] of m) {
    const rec: Record<string, string[]> = {};
    for (const [rwy, names] of byRwy) rec[rwy] = [...names].sort();
    out.set(a, rec);
  }
  return out;
}

function buildApproachIndex(): Promise<Map<string, Record<string, string[]>>> {
  if (!_approachIndex) {
    _approachIndex = Promise.all([fetchPbnWaypoints(), fetchIlsWaypoints()])
      .then(([pbn, ils]) => {
        const pbnIdx = indexApproachNames(pbn);
        const ilsIdx = indexApproachNames(ils);
        // PREFER PBN; fall back to ILS/conventional ONLY for a runway that has
        // no published PBN approach (so VTUN, all-ILS, is fully usable while a
        // PBN aerodrome keeps its RNAV approaches).
        const out = new Map<string, Record<string, string[]>>();
        const airports = new Set([...pbnIdx.keys(), ...ilsIdx.keys()]);
        for (const a of airports) {
          const rec: Record<string, string[]> = { ...(pbnIdx.get(a) ?? {}) };
          const ilsRec = ilsIdx.get(a) ?? {};
          for (const [rwy, names] of Object.entries(ilsRec)) {
            if (!rec[rwy] || rec[rwy].length === 0) rec[rwy] = names;
          }
          out.set(a, rec);
        }
        return out;
      })
      .catch(() => {
        _approachIndex = null; // let a later call retry the fetch
        return new Map();
      });
  }
  return _approachIndex;
}

/** PBN instrument approaches published at an aerodrome, grouped by the arrival
 *  runway they serve: `{ RW09: ["R09-Y","R09-Z"], RW27: ["R27-Y","R27-Z"] }`.
 *  From the bundled PBN GeoJSON, so it works with or without the engine. */
export async function staticApproaches(
  airport: string,
): Promise<Record<string, string[]>> {
  const code = airport.trim().toUpperCase();
  if (!code) return {};
  const idx = await buildApproachIndex();
  return idx.get(code) ?? {};
}

// Memoised airport -> distinct SID/STAR procedure names AND runways, derived
// from the bundled procedure-waypoint GeoJSON (same source the engine
// indexes). Runways are the RW* transition identifiers (SID = departure
// runways, STAR = arrival runways). Built once, on first use.
interface _ProcEntry {
  SID: Set<string>;
  STAR: Set<string>;
  sidRwy: Set<string>;
  starRwy: Set<string>;
  /** procedure name → runways it serves (RW* transitions). A name with an
   *  empty set has no runway-specific legs (it serves any runway). */
  sidProcRwy: Map<string, Set<string>>;
  starProcRwy: Map<string, Set<string>>;
}
let _procNameIndex: Promise<Map<string, _ProcEntry>> | null = null;

/** Expand an ARINC "both parallels" runway transition (e.g. RW21B) into the
 *  two real runway idents (RW21L, RW21R) so the picker shows AIP-accurate
 *  options — the AIP publishes one SID/STAR chart for "RWY 21L/21R". A
 *  single-runway (RW18) or already-sided (RW21L) ident is returned unchanged.
 *  The engine matches either side back to the RW21B group (see navdata
 *  `_select_group`), so a selection still resolves. */
function expandRunwayIdent(tr: string): string[] {
  const m = /^RW(\d{2})B$/.exec(tr.toUpperCase());
  return m ? [`RW${m[1]}L`, `RW${m[1]}R`] : [tr];
}

function buildProcedureNameIndex(): Promise<Map<string, _ProcEntry>> {
  if (!_procNameIndex) {
    _procNameIndex = Promise.all([fetchSidWaypoints(), fetchStarWaypoints()])
      .then(([sid, star]) => {
        const m = new Map<string, _ProcEntry>();
        const add = (
          fc: ProcedureWaypointCollection,
          kind: "SID" | "STAR",
        ) => {
          for (const f of fc.features) {
            const a = f.properties.airport_identifier;
            const n = f.properties.procedure_identifier;
            if (!a || !n) continue;
            let e = m.get(a);
            if (!e) {
              e = {
                SID: new Set(),
                STAR: new Set(),
                sidRwy: new Set(),
                starRwy: new Set(),
                sidProcRwy: new Map(),
                starProcRwy: new Map(),
              };
              m.set(a, e);
            }
            e[kind].add(n);
            const procRwy = kind === "SID" ? e.sidProcRwy : e.starProcRwy;
            if (!procRwy.has(n)) procRwy.set(n, new Set());
            const tr = f.properties.transition_identifier;
            if (tr && /^RW/.test(tr)) {
              const target = kind === "SID" ? e.sidRwy : e.starRwy;
              for (const id of expandRunwayIdent(tr)) {
                target.add(id);
                procRwy.get(n)!.add(id);
              }
            }
          }
        };
        add(sid, "SID");
        add(star, "STAR");
        return m;
      })
      .catch(() => {
        _procNameIndex = null; // let a later call retry the fetch
        return new Map();
      });
  }
  return _procNameIndex;
}

/**
 * Offline fallback for the SID/STAR picker: the procedure NAMES published at
 * an aerodrome, derived from the statically-bundled procedure-waypoint
 * GeoJSON (no backend). Used by `listProcedures` when the engine API is
 * unreachable so the dropdowns still populate.
 */
export async function staticProcedureNames(
  airport: string,
): Promise<{ SID: string[]; STAR: string[] }> {
  const code = airport.trim().toUpperCase();
  if (!code) return { SID: [], STAR: [] };
  const idx = await buildProcedureNameIndex();
  const e = idx.get(code);
  return {
    SID: e ? [...e.SID].sort() : [],
    STAR: e ? [...e.STAR].sort() : [],
  };
}

/** Runways published at an aerodrome (RW* transition idents), split by use:
 *  ``SID`` = departure runways, ``STAR`` = arrival runways. From the bundled
 *  procedure GeoJSON, so it works with or without the engine backend. */
export async function staticRunways(
  airport: string,
): Promise<{ SID: string[]; STAR: string[] }> {
  const code = airport.trim().toUpperCase();
  if (!code) return { SID: [], STAR: [] };
  const [idx, approachIdx, aip] = await Promise.all([
    buildProcedureNameIndex(),
    buildApproachIndex(),
    buildAipRunwayIndex(),
  ]);
  const e = idx.get(code);
  // A runway is offered for DEPARTURE only when a SID serves it, and for
  // ARRIVAL only when a STAR or a PBN approach serves it — you cannot fly a
  // procedure to a runway that publishes none. (VTSG's STAR serves RW32 only,
  // so its arrival picker shows RW32, not the physical RW14/RW32.) Approaches
  // count towards arrival because the picker also gates the approach dropdown
  // on the runway, and a runway may have an approach without a STAR.
  //
  // Only when the aerodrome has NO procedures of that direction at all do we
  // fall back to its full physical runway set, so a direct departure/arrival
  // can still name a runway (which anchors the threshold-elevation the vertical
  // profile starts/ends on).
  const all = aip.get(code) ?? [];
  const depRwy = e?.sidRwy ?? new Set<string>();
  const arrRwy = new Set<string>([
    ...(e?.starRwy ?? []),
    ...Object.keys(approachIdx.get(code) ?? {}),
  ]);
  const dep = depRwy.size ? [...depRwy] : all;
  const arr = arrRwy.size ? [...arrRwy] : all;
  return { SID: [...dep].sort(), STAR: [...arr].sort() };
}

// Memoised airport -> every runway ident published in the runway table
// (airports/runway_vy.csv). Covers ALL VY aerodromes, including those with no
// coded SID/STAR, so the runway pickers are never empty for a real airport.
let _aipRunwayIndex: Promise<Map<string, string[]>> | null = null;

function buildAipRunwayIndex(): Promise<Map<string, string[]>> {
  if (!_aipRunwayIndex) {
    _aipRunwayIndex = fetchRunways()
      .then((rows) => {
        const m = new Map<string, Set<string>>();
        for (const r of rows) {
          const a = r.airport.trim().toUpperCase();
          const id = r.ident.trim().toUpperCase();
          if (!a || !id) continue;
          let s = m.get(a);
          if (!s) m.set(a, (s = new Set()));
          s.add(id);
        }
        const out = new Map<string, string[]>();
        for (const [a, s] of m) out.set(a, [...s].sort());
        return out;
      })
      .catch(() => {
        _aipRunwayIndex = null; // let a later call retry the fetch
        return new Map();
      });
  }
  return _aipRunwayIndex;
}

/** Procedure name → the runways it serves, split SID/STAR, for an aerodrome.
 *  An empty array means the procedure has no runway-specific legs (serves any
 *  runway). Lets the picker show only the SID/STAR for a selected runway. */
export async function staticProcedureRunways(
  airport: string,
): Promise<{ sid: Record<string, string[]>; star: Record<string, string[]> }> {
  const code = airport.trim().toUpperCase();
  if (!code) return { sid: {}, star: {} };
  const idx = await buildProcedureNameIndex();
  const e = idx.get(code);
  const toRec = (mp?: Map<string, Set<string>>) => {
    const o: Record<string, string[]> = {};
    if (mp) for (const [k, v] of mp) o[k] = [...v];
    return o;
  };
  return { sid: toRec(e?.sidProcRwy), star: toRec(e?.starProcRwy) };
}

export interface ProcedureFix {
  ident: string;
  lat: number;
  lon: number;
}

/** First coordinate of a Point / MultiPoint geometry, or null when empty
 *  (e.g. a course-to-altitude leg that carries no fix). */
function firstCoord(geom: { type?: string; coordinates?: unknown }):
  | [number, number]
  | null {
  const c = geom?.coordinates;
  if (geom?.type === "MultiPoint") {
    const first = Array.isArray(c) ? (c[0] as number[] | undefined) : undefined;
    return first && first.length >= 2 ? [first[0], first[1]] : null;
  }
  return Array.isArray(c) && c.length >= 2
    ? [c[0] as number, c[1] as number]
    : null;
}

// Memoised `${airport}|${type}|${name}` -> ordered named fixes, derived from
// the bundled procedure-waypoint GeoJSON. Per procedure we pick the single
// transition with the most named, coordinate-bearing fixes (the most complete
// path) and order it by seqno — a best-effort match for the engine's resolved
// waypoints, used only as the no-backend preview fallback.
let _procGeomIndex: Promise<Map<string, ProcedureFix[]>> | null = null;

function buildProcedureGeomIndex(): Promise<Map<string, ProcedureFix[]>> {
  if (!_procGeomIndex) {
    _procGeomIndex = Promise.all([fetchSidWaypoints(), fetchStarWaypoints()])
      .then(([sid, star]) => {
        const out = new Map<string, ProcedureFix[]>();
        const ingest = (
          fc: ProcedureWaypointCollection,
          kind: "SID" | "STAR",
        ) => {
          // Group rows by airport|type|proc|transition, then keep the longest.
          const groups = new Map<
            string,
            { seq: number; fix: ProcedureFix }[]
          >();
          for (const f of fc.features) {
            const p = f.properties;
            const a = p.airport_identifier;
            const n = p.procedure_identifier;
            const ident = p.waypoint_identifier;
            if (!a || !n || !ident) continue;
            const ll = firstCoord(f.geometry);
            if (!ll) continue;
            const seq = Number((p as { seqno?: number }).seqno ?? 0);
            const gkey = `${a}|${kind}|${n}|${p.transition_identifier ?? ""}`;
            const row = { seq, fix: { ident, lat: ll[1], lon: ll[0] } };
            const arr = groups.get(gkey);
            if (arr) arr.push(row);
            else groups.set(gkey, [row]);
          }
          for (const [gkey, rows] of groups) {
            rows.sort((x, y) => x.seq - y.seq);
            const pts = rows.map((r) => r.fix);
            const procKey = gkey.split("|").slice(0, 3).join("|");
            const prev = out.get(procKey);
            if (!prev || pts.length > prev.length) out.set(procKey, pts);
          }
        };
        ingest(sid, "SID");
        ingest(star, "STAR");
        return out;
      })
      .catch(() => {
        _procGeomIndex = null;
        return new Map();
      });
  }
  return _procGeomIndex;
}

/**
 * Offline fallback for the SID/STAR PREVIEW geometry: the ordered fixes of a
 * procedure, derived from the bundled GeoJSON (no backend). Best-effort — one
 * transition path — used by the generator preview when the engine API is
 * unreachable. Generation itself still resolves the real legs server-side.
 */
export async function staticProcedureWaypoints(
  airport: string,
  type: "SID" | "STAR",
  name: string,
): Promise<ProcedureFix[]> {
  if (!airport || !name) return [];
  const idx = await buildProcedureGeomIndex();
  return (
    idx.get(
      `${airport.trim().toUpperCase()}|${type}|${name.trim().toUpperCase()}`,
    ) ?? []
  );
}

/**
 * Fetch the drawn SID (departure) procedure tracks. Loaded lazily when the
 * user enables the SID layer — these are the DFD `*_line` exports, just the
 * polylines (the coded legs + constraints come from the procedures API).
 */
export async function fetchSidLines(): Promise<ProcedureLineCollection> {
  const res = await fetch(SID_LINES_URL, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(
      `Failed to load ${SID_LINES_URL}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as ProcedureLineCollection;
}

/** Fetch the drawn STAR (arrival) procedure tracks. Loaded lazily. */
export async function fetchStarLines(): Promise<ProcedureLineCollection> {
  const res = await fetch(STAR_LINES_URL, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(
      `Failed to load ${STAR_LINES_URL}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as ProcedureLineCollection;
}

/**
 * Fetch worldwide FIR boundaries. This file is large (~15 MB), so callers
 * should only invoke it lazily (when the user enables the FIR layer), not
 * on initial page load.
 *
 * This was a VT-only file with no VY equivalent, removed with the rest of
 * the Thailand data — fails closed (empty collection) rather than throwing.
 */
export async function fetchFir(): Promise<FirCollection> {
  try {
    const res = await fetch(FIR_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as FirCollection;
  } catch {
    return { type: "FeatureCollection", features: [] } as FirCollection;
  }
}

/**
 * Airspace sector overlays (ported from the flight-animation viewer) — the
 * Bangkok ACC sectors + subsectors, control zones (CTR), terminal areas (TMA)
 * and prohibited/danger/restricted areas (PDR). All are MultiPolygon
 * FeatureCollections under public/data/sectors_corrected/ (vertical limits
 * fixed against AIP Thailand — see that folder's CORRECTIONS.md), each with a
 * `name` (PDR uses `ident`). `color` styles the outline/fill; `label` names
 * the toggle.
 */
// Per-zone legend colours — the single source of truth for the Airspace menu
// swatches, the map's "by zone" sector fill and the altitude-profile blocks.
export const SECTORS = [
  { key: "bacc", label: "BACC Sectors", file: "bacc_geo", color: "#22d3ee" },
  { key: "subsector", label: "BACC Subsectors", file: "bacc_subsector", color: "#818cf8" },
  { key: "ctr", label: "Control Zones (CTR)", file: "ctr", color: "#34d399" },
  { key: "tma", label: "Terminal Areas (TMA)", file: "tma", color: "#38bdf8" },
  { key: "pdr", label: "Prohibited / Danger / Restricted", file: "pdr", color: "#f87171" },
] as const;

export type SectorKey = (typeof SECTORS)[number]["key"];
export type SectorCollection = import("geojson").FeatureCollection;

const _SECTOR_FILE: Record<SectorKey, string> = Object.fromEntries(
  SECTORS.map((s) => [s.key, s.file]),
) as Record<SectorKey, string>;

/**
 * Fetch one airspace-sector overlay. Loaded lazily when its layer is toggled
 * on; the file is small and rarely changes, so the HTTP cache may keep it.
 *
 * `sectors_corrected/` is Bangkok ACC's own internal sector split — not
 * published in any AIP/AIXM feed, so there is no VY equivalent and the
 * Thai files have been removed. Fails closed (empty collection) rather than
 * throwing: the Sector tab, sector reports and dynamic-sectorization
 * features all see zero sectors until a real VY sector agreement exists at
 * this same path/shape.
 */
export async function fetchSector(key: SectorKey): Promise<SectorCollection> {
  const url = `/data/sectors_corrected/${_SECTOR_FILE[key]}.geojson`;
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as SectorCollection;
  } catch {
    return { type: "FeatureCollection", features: [] } as SectorCollection;
  }
}

/** Airway reference points (MultiPoint with `waypoint_identifier`): the VOR
 *  navaids and the (very many) reporting points along the airways.
 *
 *  VT-only, user-supplied files with no VY equivalent, removed with the rest
 *  of the Thailand data — these fail closed (empty collection). */
export type AirwayPointCollection = import("geojson").FeatureCollection;

function emptyFeatureCollection<T extends { type: "FeatureCollection" }>(): T {
  return { type: "FeatureCollection", features: [] } as unknown as T;
}

export function fetchAirwayVor(): Promise<AirwayPointCollection> {
  return fetchJson<AirwayPointCollection>(
    "/data/airways/airway_vor.geojson",
  ).catch(() => emptyFeatureCollection<AirwayPointCollection>());
}

export function fetchAirwayReporting(): Promise<AirwayPointCollection> {
  return fetchJson<AirwayPointCollection>(
    "/data/airways/airways_reporting.geojson",
  ).catch(() => emptyFeatureCollection<AirwayPointCollection>());
}

/** Fetch the raw airway-segment FeatureCollection from the source file. Fails
 *  closed (empty collection) — see the module docstring: VT-only, no VY
 *  equivalent, removed with the rest of the Thailand data. */
export async function fetchAirways(): Promise<AirwayCollection> {
  try {
    const res = await fetch(SOURCE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as AirwayCollection;
  } catch {
    return emptyFeatureCollection<AirwayCollection>();
  }
}

/**
 * Build the unique waypoint list straight from the file's own coordinates.
 *
 * Each segment names two endpoints; we collect both, keyed by identifier,
 * and record which airways each waypoint lies on. The first coordinate seen
 * for an identifier wins (the file is internally consistent for a given
 * fix, so duplicates carry the same lat/lon).
 */
export function deriveWaypoints(airways: AirwayCollection): Waypoint[] {
  const byIdent = new Map<string, Waypoint>();

  for (const feature of airways.features) {
    const p = feature.properties;

    // Two endpoints per segment, both with real coords from the file.
    const endpoints: Array<[string, number, number]> = [
      [p.waypoint_identifier, p.waypoint_latitude, p.waypoint_longitude],
      [p.waypoint_identifier_2, p.waypoint_latitude_2, p.waypoint_longitude_2],
    ];

    for (const [ident, lat, lon] of endpoints) {
      if (!ident || lat == null || lon == null) continue;
      const existing = byIdent.get(ident);
      if (existing) {
        if (!existing.airways.includes(p.route_identifier)) {
          existing.airways.push(p.route_identifier);
        }
      } else {
        byIdent.set(ident, {
          ident,
          lat,
          lon,
          airways: [p.route_identifier],
        });
      }
    }
  }

  return [...byIdent.values()].sort((a, b) => a.ident.localeCompare(b.ident));
}
