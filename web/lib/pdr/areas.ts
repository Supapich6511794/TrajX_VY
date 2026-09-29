/**
 * Joining the PDR polygons to their published activity times.
 *
 * The two halves of a PDR live in different files and neither is complete on
 * its own:
 *
 *   * `/data/aixm_vy/restricted_areas.geojson` (via `fetchSector("pdr")`) —
 *     the geometry and the vertical band (AIP ENR 5.1), which is what the map
 *     draws and what `lib/cdr/constraints` tests routes against. Each feature
 *     carries `type` ("P"/"R"/"D"), `designator` ("13", "19A"), `name` and
 *     AIP-style `lower`/`upper` strings ("GND SFC", "240 STD", "8000 MSL").
 *     It carries NO time of activity.
 *   * `/data/VY_AIP/pdr_activity.json` — the timetables (AIP Myanmar ENR 5.1, built by `scripts/build_vy_aip.py`). No geometry; each
 *     record has the same `type` + `designator` pair.
 *
 * The join key is type + designator ("R13", "D23A"), the same ident
 * `restrictedAreasFrom` and the map label build. Designators are not unique
 * without the type in general, and lettered sub-areas ("R19A".."R19D") are
 * already separate designators on BOTH sides, so no sub-area rewriting is
 * needed. Several polygons can share one ident (R13 SHANTE is eight); each
 * joins to the same record. An area that finds no match keeps
 * `activity: null` and is treated as permanently active downstream — the safe
 * reading. A missing activity file therefore fails closed, too.
 *
 * Features without `designator` (older overlay shapes with a combined `ident`)
 * fall back to `ident`, then `name`, and to `lowerlimit`/`upperlimit`.
 */

import type { Position } from "geojson";

import { parseVyAltFt } from "@/lib/airspace";

import type { PdrActivity, PdrActivityFile, PdrArea } from "./types";

const ACTIVITY_URL = "/data/VY_AIP/pdr_activity.json";

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
  for (const a of file?.areas ?? []) {
    const key = areaKey(a.type, a.designator);
    if (key && !m.has(key)) m.set(key, a);
  }
  return m;
}

/** The join key: area class + designator, upper-cased, no spaces ("R13"). */
export function areaKey(type: unknown, designator: unknown): string {
  const d = String(designator ?? "").replace(/\s+/g, "").toUpperCase();
  if (!d) return "";
  const t = String(type ?? "").trim().toUpperCase();
  return t + d;
}

/** An altitude limit that survives a missing/garbled value. */
function safeAlt(v: unknown, fallback: number): number {
  const n = parseVyAltFt(v);
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
 * so its output cannot be zipped back against `coll.features` by index. The
 * result is still a `RestrictedArea` with the same ident, so it stays usable
 * everywhere the CD&R constraint engine expects one.
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
    const ident =
      areaKey(props.type, props.designator) ||
      String(props.ident ?? props.name ?? "?").trim().toUpperCase();
    const match = index.get(ident) ?? null;

    const kindRaw = String(props.type ?? "R").toUpperCase()[0];
    const bbox = bboxOf(mp);
    out.push({
      ident,
      name: String(props.name ?? ""),
      kind: kindRaw === "P" || kindRaw === "D" ? kindRaw : "R",
      lowerFt: safeAlt(props.lower ?? props.lowerlimit, 0),
      upperFt: safeAlt(props.upper ?? props.upperlimit, Infinity),
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
