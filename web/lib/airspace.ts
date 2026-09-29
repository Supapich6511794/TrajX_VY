/**
 * Airspace membership — which controlled volume an aircraft occupies.
 *
 * Pure, dependency-free point-in-polygon (the project ships no turf) over the
 * Myanmar (Yangon FIR) airspace GeoJSON already loaded by `fetchSector`
 * (web/lib/geojson.ts): Control Zones (CTR), Terminal Areas (TMA), Control
 * Areas (CTA), the FIR itself and Prohibited/Danger/Restricted areas (PDR).
 * The test is ALTITUDE-AWARE — a plane at FL196 is not "in" a CTR that tops at
 * FL130 — so each feature's vertical band is parsed from its AIP-style
 * `lower`/`upper` strings (see `parseVyAltFt`).
 */

import type { Geometry, Position } from "geojson";

import { SECTORS, type SectorCollection, type SectorKey } from "./geojson";

export interface AirspaceMembership {
  ctr?: string; // e.g. "YANGON CTR"
  tma?: string; // e.g. "MINGALADON TMA"
  cta?: string; // e.g. "YANGON CTA"
  fir?: string; // e.g. "YANGON FIR"
  pdr?: string[]; // e.g. ["R13 SHANTE"] — can overlap, so a list
}

// --- point-in-polygon (ray casting, lon/lat) -------------------------------

function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** A GeoJSON Polygon is [outer, ...holes]. Inside the outer ring, not a hole. */
function pointInPolygon(lon: number, lat: number, poly: Position[][]): boolean {
  if (poly.length === 0 || !pointInRing(lon, lat, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) {
    if (pointInRing(lon, lat, poly[h])) return false;
  }
  return true;
}

export function pointInMultiPolygon(
  lon: number,
  lat: number,
  mp: Position[][][],
): boolean {
  for (const poly of mp) if (pointInPolygon(lon, lat, poly)) return true;
  return false;
}

// --- edge-bucketed ring index ------------------------------------------------
//
// The ray cast above walks EVERY edge of a ring for every point tested. The
// airspace polygons are not small — an FIR outline runs to thousands of
// vertices and a CTR to ~1 000 — so a single aircraft sample cost ~10 000 edge tests, and a
// whole traffic day (hundreds of flights, thousands of samples each) spent
// seconds in this loop. A horizontal ray only ever crosses edges whose latitude
// span contains the point, so the edges are bucketed by latitude band once and
// a point scans just its own band.
//
// EXACT, not approximate: a band holds every edge whose span overlaps it (a
// superset of the edges that can straddle the point), and each edge that is
// visited is put through the very same test as the plain loop, so the parity —
// and therefore the answer — is identical. Only edges that could never have
// toggled it are skipped.

/** Rings shorter than this are scanned plainly: the lookup would cost more than
 *  the loop it saves. */
const RING_INDEX_MIN_VERTICES = 64;

interface RingIndex {
  minY: number;
  maxY: number;
  /** Bands per degree of latitude. */
  scale: number;
  /** Index of the last band. */
  last: number;
  /** Band b holds edges[start[b] .. start[b + 1]). */
  start: Int32Array;
  /** Each entry is the vertex i of an edge (ring[j] → ring[i], j = i − 1 wrapped). */
  edges: Int32Array;
}

function buildRingIndex(ring: Position[]): RingIndex {
  const n = ring.length;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = ring[i][1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bands = Math.max(16, Math.min(512, n >> 4));
  const span = maxY - minY;
  const scale = span > 0 ? bands / span : 0;
  const last = bands - 1;
  const bandOf = (y: number): number => {
    const b = Math.floor((y - minY) * scale);
    return b < 0 ? 0 : b > last ? last : b;
  };
  const start = new Int32Array(bands + 1);
  // Two passes over the same edges: count per band, then fill.
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi === yj) continue; // a level edge can never straddle a latitude
    const lo = bandOf(yi < yj ? yi : yj);
    const hi = bandOf(yi < yj ? yj : yi);
    for (let b = lo; b <= hi; b++) start[b + 1]++;
  }
  for (let b = 0; b < bands; b++) start[b + 1] += start[b];
  const edges = new Int32Array(start[bands]);
  const fill = start.slice(0, bands);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ring[i][1];
    const yj = ring[j][1];
    if (yi === yj) continue;
    const lo = bandOf(yi < yj ? yi : yj);
    const hi = bandOf(yi < yj ? yj : yi);
    for (let b = lo; b <= hi; b++) edges[fill[b]++] = i;
  }
  return { minY, maxY, scale, last, start, edges };
}

/** Same answer as `pointInRing`, scanning only the point's latitude band. */
function pointInRingIndexed(
  lon: number,
  lat: number,
  ring: Position[],
  idx: RingIndex,
): boolean {
  // Above or below every vertex: no edge straddles the latitude.
  if (lat < idx.minY || lat > idx.maxY) return false;
  const n = ring.length;
  let b = Math.floor((lat - idx.minY) * idx.scale);
  b = b < 0 ? 0 : b > idx.last ? idx.last : b;
  let inside = false;
  for (let k = idx.start[b], end = idx.start[b + 1]; k < end; k++) {
    const i = idx.edges[k];
    const j = i === 0 ? n - 1 : i - 1;
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** One index per ring of one feature's MultiPolygon, parallel to `mp`
 *  (`undefined` for a ring too short to be worth one). */
type MultiPolygonIndex = (RingIndex | undefined)[][];

function buildMultiPolygonIndex(mp: Position[][][]): MultiPolygonIndex {
  return mp.map((poly) =>
    poly.map((ring) =>
      ring.length >= RING_INDEX_MIN_VERTICES ? buildRingIndex(ring) : undefined,
    ),
  );
}

/** `pointInMultiPolygon`, using the prebuilt ring indexes. */
function pointInMultiPolygonIndexed(
  lon: number,
  lat: number,
  mp: Position[][][],
  acc: MultiPolygonIndex,
): boolean {
  for (let p = 0; p < mp.length; p++) {
    const poly = mp[p];
    if (poly.length === 0) continue;
    const rings = acc[p];
    const inRing = (r: number): boolean => {
      const ix = rings[r];
      return ix
        ? pointInRingIndexed(lon, lat, poly[r], ix)
        : pointInRing(lon, lat, poly[r]);
    };
    if (!inRing(0)) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (inRing(h)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

// --- vertical bands --------------------------------------------------------

/** Feet from a limit value. `isFL` treats a bare number as a flight level.
 *  Strings: GND/SFC/MSL -> 0, UNL -> Infinity, "FL 120" -> 12000,
 *  "ALT 2000"/bare digits -> that many feet. */
export function parseAltFt(v: unknown, isFL = false): number {
  if (v == null) return NaN;
  if (typeof v === "number") return isFL ? v * 100 : v;
  const s = String(v).trim().toUpperCase();
  if (!s) return NaN;
  // "SURFACE" is spelled out by some sources where the rest use GND.
  if (s === "GND" || s === "SFC" || s === "MSL" || s === "SURFACE") return 0;
  if (s.startsWith("UNL")) return Infinity;
  const fl = s.match(/FL\s*(\d+)/);
  if (fl) return Number(fl[1]) * 100;
  const n = s.match(/(\d+)/);
  return n ? Number(n[1]) : NaN;
}

/** Feet from a Myanmar AIP-style limit string: "GND SFC" -> 0, "UNL STD" ->
 *  Infinity, "<n> STD" / "FL <n>" -> that flight level in feet (n * 100, QNE
 *  reference), "<n> MSL"/"<n> SFC" -> n feet directly. Used for every layer,
 *  whose `aixm_vy` source files all share this `lower`/`upper` format. Must
 *  stay in step with the backend's parser in trajectory_sim/airspace.py. */
export function parseVyAltFt(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const s = String(v).trim().toUpperCase();
  if (!s) return NaN;
  if (s.startsWith("GND") || s.startsWith("SFC")) return 0;
  if (s.startsWith("UNL")) return Infinity;
  const fl = s.match(/^FL\s*(\d+)/);
  if (fl) return Number(fl[1]) * 100;
  const m = s.match(/^(\d+)\s*(STD|MSL|SFC)?/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === "STD" ? n * 100 : n;
}

export interface Band {
  lo: number;
  hi: number;
}

/** Vertical band (feet) coded on a sector feature, per its layer's schema.
 *  Exposed so the map can colour sectors by altitude. */
export function layerBand(props: Record<string, unknown>, key: SectorKey): Band {
  void key; // every aixm_vy layer shares one `lower`/`upper` format
  const lo = parseVyAltFt(props.lower);
  const hi = parseVyAltFt(props.upper);
  // A missing limit must not make the volume unreachable (NaN fails every
  // comparison): treat an absent floor as the surface, an absent top as open.
  return {
    lo: Number.isNaN(lo) ? 0 : lo,
    hi: Number.isNaN(hi) ? Infinity : hi,
  };
}

function layerLabel(props: Record<string, unknown>, key: SectorKey): string {
  if (key === "pdr") {
    // restricted_areas.geojson has no combined ident — "R" + "13" + "SHANTE".
    const type = String(props.type ?? "").trim();
    const designator = String(props.designator ?? "").trim();
    const name = String(props.name ?? "").trim();
    return [`${type}${designator}`.trim(), name].filter(Boolean).join(" ") || "PDR";
  }
  const name = String(props.name ?? props.ident ?? "").trim();
  // The FIR feature is named just "YANGON" — say what it is.
  if (key === "fir" && name && !/\bFIR\b/i.test(name)) return `${name} FIR`;
  return name || key.toUpperCase();
}

// --- prebuilt index (bbox + normalized MultiPolygon per feature) -----------

/** One indexed airspace volume: its published name, vertical band, bbox and
 *  normalised geometry. Exported because callers that reason about the SHAPE of
 *  the airspace — sector adjacency, say — must read the same volumes the
 *  membership test uses, or they end up describing a different airspace. */
export interface IndexEntry {
  label: string;
  band: Band;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  mp: Position[][][];
  /** Edge-bucketed ring indexes for `mp` (see RingIndex). Built with the index
   *  and optional: an entry assembled by hand still works, just unaccelerated. */
  acc?: MultiPolygonIndex;
}

export type AirspaceIndex = Partial<Record<SectorKey, IndexEntry[]>>;

function featureMP(geom: Geometry | null | undefined): Position[][][] | null {
  if (!geom) return null;
  if (geom.type === "MultiPolygon") return geom.coordinates as Position[][][];
  if (geom.type === "Polygon") return [geom.coordinates as Position[][]];
  return null;
}

function bboxOf(mp: Position[][][]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const poly of mp)
    for (const ring of poly)
      for (const p of ring) {
        const lon = p[0];
        const lat = p[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
  return [minLon, minLat, maxLon, maxLat];
}

/** Build a reusable index from the loaded sector collections (bbox precomputed
 *  once so per-frame membership is a cheap bbox-reject then ray-cast). */
export function buildAirspaceIndex(
  sectorData: Partial<Record<SectorKey, SectorCollection | null>>,
): AirspaceIndex {
  const idx: AirspaceIndex = {};
  for (const key of Object.keys(sectorData) as SectorKey[]) {
    const fc = sectorData[key];
    if (!fc) continue;
    const entries: IndexEntry[] = [];
    for (const f of fc.features) {
      const mp = featureMP(f.geometry);
      if (!mp) continue;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      entries.push({
        label: layerLabel(props, key),
        band: layerBand(props, key),
        bbox: bboxOf(mp),
        mp,
        acc: buildMultiPolygonIndex(mp),
      });
    }
    idx[key] = entries;
  }
  return idx;
}

// --- membership ------------------------------------------------------------

const LAYER_ORDER: SectorKey[] = ["ctr", "tma", "cta", "fir", "pdr"];

/** Which airspace volumes contain (lon, lat, altFt). `altFt == null` (no
 *  vertical profile) skips the altitude gate → horizontal-only. */
export function airspaceAt(
  index: AirspaceIndex,
  lon: number,
  lat: number,
  altFt: number | null,
): AirspaceMembership {
  const m: AirspaceMembership = {};
  for (const key of LAYER_ORDER) {
    const entries = index[key];
    if (!entries) continue;
    const hits: string[] = [];
    for (const e of entries) {
      if (lon < e.bbox[0] || lon > e.bbox[2] || lat < e.bbox[1] || lat > e.bbox[3])
        continue;
      if (
        !(e.acc
          ? pointInMultiPolygonIndexed(lon, lat, e.mp, e.acc)
          : pointInMultiPolygon(lon, lat, e.mp))
      )
        continue;
      if (altFt != null) {
        if (!(altFt >= e.band.lo && altFt <= e.band.hi)) continue;
      }
      hits.push(e.label);
      if (key !== "pdr") break; // a plane is in exactly one of these
    }
    if (hits.length === 0) continue;
    if (key === "pdr") m.pdr = hits;
    else m[key] = hits[0];
  }
  return m;
}

// --- whole-route segments (for the altitude profile block colouring) -------

/** Per-layer sector colour (the same palette that styles the map overlays). */
const SECTOR_COLOR = Object.fromEntries(
  SECTORS.map((s) => [s.key, s.color]),
) as Record<SectorKey, string>;

/** The map colour of the ONE airspace that owns the aircraft here — the layer
 *  the hierarchy resolves to (see {@link controllingLayer}). Returned as an
 *  array so the profile's fill helper keeps one shape; [] when in no airspace,
 *  which draws the neutral default. */
export function membershipColors(m: AirspaceMembership | undefined): string[] {
  const key = controllingLayer(m);
  return key === null ? [] : [SECTOR_COLOR[key]];
}

/** One contiguous stretch of a route that stays inside the same set of
 *  airspace volumes. `t0`/`t1` are seconds from the route's first point (the
 *  same clock the altitude chart uses), so the profile can paint the run as a
 *  colour block. Boundaries are stitched so adjacent segments abut exactly. */
export interface AirspaceSegment {
  t0: number;
  t1: number;
  /** Altitude-aware membership — the volumes that actually contain the
   *  aircraft on this stretch. Drives both the label and the colours. */
  membership: AirspaceMembership;
  /** Compact display label, e.g. "Yangon CTR" ("" outside all zones).
   *  Altitude-aware: a TMA the aircraft is above (past its ceiling) is not
   *  listed here. */
  label: string;
  /** Per-layer colours to blend for this block ([] outside all zones) — from
   *  the same altitude-aware membership. */
  colors: string[];
}

interface SegPoint {
  lon: number;
  lat: number;
  altitude_ft: number | null;
  epoch_ts: string;
}

// One route's segments depend only on its points and the sector index, so the
// result is cached against the point array. A ray-cast per point over every
// sector is cheap for ONE route and ruinous for a whole traffic day: replacing
// a single flight (an applied CD&R fix) changes the trajectory ARRAY, and
// without this cache every one of the other flights was re-walked point by
// point on each Apply.
const segmentCache = new WeakMap<
  object,
  { index: AirspaceIndex; segs: AirspaceSegment[] }
>();

/** Walk a whole trajectory and collapse it into contiguous airspace segments.
 *  Membership is altitude-aware (a climb out of a low CTR drops that zone from
 *  both the label and the tint), so a new block starts wherever the set of
 *  containing volumes changes. Memoised per point array (see `segmentCache`) —
 *  one walk per route, not one per render. */
export function buildAirspaceSegments(
  index: AirspaceIndex,
  points: ReadonlyArray<SegPoint>,
): AirspaceSegment[] {
  if (points.length === 0 || !hasAirspace(index)) return [];
  // Cached against the index too: reloading the sector polygons builds a new
  // index, and the old segments were resolved against the old volumes.
  const hit = segmentCache.get(points);
  if (hit && hit.index === index) return hit.segs;
  const base = new Date(points[0].epoch_ts).getTime();
  let cur: AirspaceSegment | null = null;
  const segs: AirspaceSegment[] = [];
  for (const p of points) {
    const t = (new Date(p.epoch_ts).getTime() - base) / 1000;
    const full = airspaceAt(index, p.lon, p.lat, p.altitude_ft ?? null);
    // PDR (prohibited/danger/restricted) is EXCLUDED from the profile blocks:
    // those areas are assumed CLOSED (a flight wouldn't be routed through an
    // active one), so they must not tint or label the altitude chart as a
    // "sector". Only the controlling ATS volume (CTR/TMA/CTA/FIR) counts.
    const m = full.pdr ? { ...full, pdr: undefined } : full;
    const label = formatAirspace(m, "compact");
    if (cur && cur.label === label) {
      cur.t1 = t;
    } else {
      if (cur) cur.t1 = t; // stitch: previous block runs up to this transition
      cur = { t0: t, t1: t, membership: m, label, colors: membershipColors(m) };
      segs.push(cur);
    }
  }
  if (segs.length) segs[0].t0 = 0; // first block anchors at the departure edge
  segmentCache.set(points, { index, segs });
  return segs;
}

export function isEmptyAirspace(m: AirspaceMembership | undefined): boolean {
  return (
    !m ||
    (!m.ctr && !m.tma && !m.cta && !m.fir && (!m.pdr || m.pdr.length === 0))
  );
}

/** Has any ATS layer (CTR/TMA/CTA/FIR) been loaded into the index? The gate
 *  every live-membership consumer checks before resolving positions. */
export function hasAirspace(index: AirspaceIndex): boolean {
  return !!(index.ctr || index.tma || index.cta || index.fir);
}

// Abbreviations that stay upper-case in a title-cased zone name.
const ZONE_ABBR = new Set([
  "CTR",
  "TMA",
  "FIR",
  "ACC",
  "CTA",
  "ATZ",
  "TCA",
  "MTMA",
  "APP",
]);

/** Title-case a zone name for display, keeping airspace abbreviations
 *  ("CTR"/"TMA") and area idents (anything with a digit, e.g. "R13")
 *  as-is: "MINGALADON TMA" → "Mingaladon TMA", "R13 SHANTE" → "R13
 *  Shante", "YANGON FIR" → "Yangon FIR". */
function titleZone(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => {
      if (/\d/.test(w)) return w;
      if (ZONE_ABBR.has(w.toUpperCase())) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * The name a sector event carries for one indexed volume.
 *
 * `IndexEntry.label` is the raw published name; the events and the report rows
 * carry the DISPLAY name that `formatAirspace` produces. Anything joining the
 * two — the adjacency graph behind dynamic sectorization — has to cross that
 * gap with the same rules, or "MANDALAY TMA" and "Mandalay TMA" become two
 * sectors that never meet.
 */
export function sectorDisplayName(layer: SectorKey, label: string): string {
  if (layer === "pdr") return label;
  return titleZone(label);
}

/** Airspace hierarchy — an aircraft is in exactly ONE airspace at a time, so a
 *  point that falls inside several overlapping volumes resolves to one. Order
 *  (highest first):
 *
 *    1. **PDR** — prohibited/danger/restricted. Not an ATS unit, but being
 *       inside one is the fact that matters, so it overrides.
 *    2. **CTR** — Control Zone, worked by Aerodrome Control (Tower).
 *    3. **TMA** — Terminal Control Area, worked by Approach Control.
 *    4. **CTA** — Control Area, worked by Area Control.
 *    5. **FIR** — the Yangon FIR itself, the catch-all outside every
 *       controlled volume above.
 *
 *  Annex 11 airspace/ATS-unit structure, resolved AFTER the lateral and
 *  vertical tests — an aircraft above a CTR's ceiling has already dropped out
 *  of it and falls through to the TMA/CTA below.
 *  Must stay in step with _HIERARCHY in trajectory_sim/airspace.py. */
const HIERARCHY = ["pdr", "ctr", "tma", "cta", "fir"] as const;

/** Which layer owns the aircraft here, or null when it is in none. */
export function controllingLayer(
  m: AirspaceMembership | undefined,
): SectorKey | null {
  if (isEmptyAirspace(m)) return null;
  const mm = m as AirspaceMembership;
  for (const key of HIERARCHY) {
    if (key === "pdr" ? mm.pdr?.length : mm[key]) return key;
  }
  return null;
}

/** Human string for the ONE airspace that owns the aircraft (see
 *  {@link HIERARCHY}). `compact` (plane label / graph) shows a PDR by its
 *  ident, `full` (Results rows) spells it out. "" when in no airspace. */
export function formatAirspace(
  m: AirspaceMembership | undefined,
  mode: "compact" | "full",
): string {
  const key = controllingLayer(m);
  if (key === null) return "";
  const mm = m as AirspaceMembership;
  switch (key) {
    case "pdr":
      return mode === "compact"
        ? (mm.pdr as string[]).map((p) => p.split(" ")[0]).join(",")
        : (mm.pdr as string[]).map(titleZone).join(" · ");
    default:
      return titleZone(mm[key] as string);
  }
}
