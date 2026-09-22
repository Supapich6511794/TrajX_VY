/**
 * Joining the PDR polygons to their published activity times.
 *
 * The two halves of a PDR live in different files and neither is complete on
 * its own:
 *
 *   * `/data/sectors_corrected/pdr.geojson` — the geometry and the vertical
 *     band (AIP ENR 5.1), which is what the map already draws and what
 *     `lib/cdr/constraints` already tests routes against. It carries NO time
 *     of activity at all, which is why the existing constraint engine treats
 *     every area as permanently hot. VT-only — no VY equivalent exists (no
 *     published internal sector-style PDR geometry for Myanmar), so this half
 *     is empty for this deployment until that data shows up.
 *   * `/data/aixm_vy/pdr_activity.json` — the timetables. No geometry, and
 *     its designators are bare numbers ("31", "33"...) rather than VT's
 *     `<ident>A<areacode>` lettered-sub-area scheme below, so the join logic
 *     here is VT-specific and simply has nothing to join against for VY.
 *
 * The join key needs one wrinkle, on the VT side. The AIXM export splits six
 * areas into lettered sub-areas that the GeoJSON keeps as one ident plus an
 * `areacode`: VTD21 areacode 1/2/3 is VTD21A1/A2/A3 in AIXM, and likewise for
 * VTD30, 33, 34, 59 and 60. Those are matched on `<ident>A<areacode>` first,
 * then on the bare ident. An area that still finds no match keeps
 * `activity: null` and is treated as permanently active downstream — the
 * safe reading, and the one the app had before this module existed.
 */

import type { Position } from "geojson";

import { parseAltFt } from "@/lib/airspace";

import type { PdrActivity, PdrActivityFile, PdrArea } from "./types";

const ACTIVITY_URL = "/data/aixm_vy/pdr_activity.json";

let _cache: Promise<PdrActivityFile> | null = null;

/** Fetch + memoise the published activity table for the page's lifetime.
 *  Mirrors `fetchAip` / `fetchAipRoutes` — one small file per AIRAC cycle. */
export function fetchPdrActivity(): Promise<PdrActivityFile> {
  if (!_cache) {
    _cache = fetch(ACTIVITY_URL, { cache: "no-store" }).then((res) => {
      if (!res.ok) {
        throw new Error("Failed to load " + ACTIVITY_URL + ": " + res.status);
      }
      return res.json() as Promise<PdrActivityFile>;
    });
  }
  return _cache;
}

/** Bounding box of a MultiPolygon, [minLon, minLat, maxLon, maxLat]. */
function bboxOf(mp: Position[][][]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const p of ring) {
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      }
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

/** Centre of that box. Used to resolve solar schedules and to point the map at
 *  an area; a PDR is small enough that the bbox centre and the true centroid
 *  give the same sunrise to the second. */
function bboxCentre(bbox: [number, number, number, number]): {
  lat: number;
  lon: number;
} {
  return { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 };
}

/** Index the activity table by designator for the two-step join. */
function activityIndex(file: PdrActivityFile | null): Map<string, PdrActivity> {
  const m = new Map<string, PdrActivity>();
  for (const a of file?.areas ?? []) m.set(a.designator.toUpperCase(), a);
  return m;
}

/** An altitude limit that survives a missing/garbled value. */
function safeAlt(v: unknown, fallback: number): number {
  const n = parseAltFt(v, false);
  return Number.isFinite(n) || n === Infinity ? n : fallback;
}

/**
 * Build the joined PDR areas the analysis works on.
 *
 * `coll` is the raw PDR GeoJSON exactly as `fetchSector("pdr")` returns it, so
 * callers pass through the collection the map already loaded rather than
 * fetching it twice.
 *
 * This walks the features itself rather than post-processing
 * `restrictedAreasFrom`: that helper drops features with no polygon geometry,
 * so its output cannot be zipped back against `coll.features` by index to
 * recover each area's `areacode`. The result is still a `RestrictedArea`, so it
 * stays usable everywhere the CD&R constraint engine expects one.
 */
export function buildPdrAreas(
  coll: { features: GeoJSON.Feature[] } | null | undefined,
  activity: PdrActivityFile | null,
): PdrArea[] {
  const index = activityIndex(activity);
  const out: PdrArea[] = [];

  for (const f of coll?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    let mp: Position[][][];
    if (g.type === "MultiPolygon") mp = g.coordinates;
    else if (g.type === "Polygon") mp = [g.coordinates];
    else continue;

    const props = (f.properties ?? {}) as Record<string, unknown>;
    const ident = String(props.ident ?? props.name ?? "?").trim().toUpperCase();
    const areacode = String(props.areacode ?? "").trim();
    // Sub-area first (VTD21 + "1" -> VTD21A1), then the bare ident.
    const match =
      (areacode ? index.get(ident + "A" + areacode) : undefined) ??
      index.get(ident) ??
      null;

    const kindRaw = String(props.type ?? "R").toUpperCase()[0];
    const bbox = bboxOf(mp);
    out.push({
      ident,
      name: String(props.name ?? ""),
      kind: kindRaw === "P" || kindRaw === "D" ? kindRaw : "R",
      lowerFt: safeAlt(props.lowerlimit, 0),
      upperFt: safeAlt(props.upperlimit, Infinity),
      mp,
      activity: match,
      centroid: bboxCentre(bbox),
      bbox,
    });
  }
  return out;
}

/** Areas whose activity record is missing — surfaced by the panel so a data
 *  gap reads as a data gap rather than as "nothing to report". */
export function areasWithoutSchedule(areas: PdrArea[]): string[] {
  const out = new Set<string>();
  for (const a of areas) if (!a.activity) out.add(a.ident);
  return [...out].sort();
}
