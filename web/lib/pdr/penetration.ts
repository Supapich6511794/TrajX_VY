/**
 * Where a planned route goes inside a PDR volume, and when.
 *
 * This is the geometric half of the check. `lib/cdr/constraints.areaIdentsOnPath`
 * already answers "does this path touch an area?" for the live maneuver gate,
 * but it returns a bare set of idents: no entry/exit time, no altitude band, no
 * separation of a 0.4 NM corner clip from a 30 NM transit, and no re-entry. A
 * flight-plan advisory needs all of those, because they are what the controller
 * is judging and what the schedule lookup keys off.
 *
 * Two path sources feed this:
 *   * the generated trajectory of the filed plan — real times, real altitudes;
 *   * a candidate alternative route, which has no trajectory yet and is
 *     estimated from its fixes (see {@link pathFromFixes}).
 */

import { pointInMultiPolygon } from "@/lib/airspace";

import { activityAt, worseState } from "./schedule";
import type { ActivityState, PdrArea, PdrIncursion, TimedPoint } from "./types";

const R_NM = 3440.065;

export function haversineNm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Vertical tolerance (ft) when testing a sample against an area's band.
 *  Matches the buffer `areaIdentsOnPath` uses, so the two agree about whether a
 *  level flight skimming a ceiling counts as inside. */
const BAND_TOLERANCE_FT = 100;

function insideArea(p: TimedPoint, area: PdrArea): boolean {
  if (p.altFt < area.lowerFt - BAND_TOLERANCE_FT) return false;
  if (p.altFt > area.upperFt + BAND_TOLERANCE_FT) return false;
  // Cheap rejects before the ray-cast: the band, then the bounding box. Almost
  // every sample of almost every flight fails one of these.
  const [minLon, minLat, maxLon, maxLat] = area.bbox;
  if (p.lon < minLon || p.lon > maxLon || p.lat < minLat || p.lat > maxLat) {
    return false;
  }
  return pointInMultiPolygon(p.lon, p.lat, area.mp);
}

/**
 * Every stretch of `path` that lies inside one of `areas`, with the activity
 * verdict for the time it is flown.
 *
 * A route that leaves an area and comes back produces two incursions, not one:
 * they can fall on opposite sides of a schedule boundary, and merging them
 * would report a single crossing at whichever time happened to come first.
 */
export function findIncursions(
  path: TimedPoint[],
  areas: PdrArea[],
): PdrIncursion[] {
  const out: PdrIncursion[] = [];
  if (path.length === 0) return out;

  // Whole-route bounding box and level range, computed once. A flight is near
  // a handful of the 110 published area polygons at most, and without this every area
  // was walked against every sample of every flight — the single biggest cost
  // in the check when a whole traffic day is loaded.
  let pMinLon = Infinity;
  let pMinLat = Infinity;
  let pMaxLon = -Infinity;
  let pMaxLat = -Infinity;
  let pMinAlt = Infinity;
  let pMaxAlt = -Infinity;
  for (const p of path) {
    if (p.lon < pMinLon) pMinLon = p.lon;
    if (p.lon > pMaxLon) pMaxLon = p.lon;
    if (p.lat < pMinLat) pMinLat = p.lat;
    if (p.lat > pMaxLat) pMaxLat = p.lat;
    if (p.altFt < pMinAlt) pMinAlt = p.altFt;
    if (p.altFt > pMaxAlt) pMaxAlt = p.altFt;
  }

  for (const area of areas) {
    // Skip the area entirely when the route cannot touch it. Same tolerance as
    // the per-sample test, so this can never reject something that test would
    // have accepted.
    const [aMinLon, aMinLat, aMaxLon, aMaxLat] = area.bbox;
    if (pMaxLon < aMinLon || pMinLon > aMaxLon) continue;
    if (pMaxLat < aMinLat || pMinLat > aMaxLat) continue;
    if (pMaxAlt < area.lowerFt - BAND_TOLERANCE_FT) continue;
    if (pMinAlt > area.upperFt + BAND_TOLERANCE_FT) continue;

    let run: TimedPoint[] = [];

    const close = () => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      let transitNm = 0;
      for (let i = 1; i < run.length; i++) transitNm += haversineNm(run[i - 1], run[i]);

      const atEntry = activityAt(area.activity, first.timeMs, area.centroid);
      const atExit =
        last.timeMs === first.timeMs
          ? atEntry
          : activityAt(area.activity, last.timeMs, area.centroid);

      out.push({
        area,
        entryMs: first.timeMs,
        exitMs: last.timeMs,
        minAltFt: Math.min(...run.map((p) => p.altFt)),
        maxAltFt: Math.max(...run.map((p) => p.altFt)),
        transitNm,
        activityAtEntry: atEntry,
        activityAtExit: atExit,
        worstState: worseState(atEntry.state, atExit.state),
      });
      run = [];
    };

    for (const p of path) {
      if (insideArea(p, area)) run.push(p);
      else close();
    }
    close();
  }

  // Worst first: active before unknown before inactive, then longest transit.
  const rank: Record<ActivityState, number> = { active: 0, unknown: 1, inactive: 2 };
  return out.sort(
    (a, b) =>
      rank[a.worstState] - rank[b.worstState] ||
      b.transitNm - a.transitNm ||
      a.entryMs - b.entryMs,
  );
}

/**
 * Turn a list of route fixes into a timed, densified path, for candidate routes
 * that have not been generated yet.
 *
 * Deliberately a rough model — great-circle legs at a constant level and ground
 * speed. It exists to answer one question about an alternative ("would this one
 * also cross an active area?"), and the real trajectory is generated by the
 * Python engine only once the controller actually applies the route. Sampling
 * every `stepNm` matters more than the speed model: an area 8 NM across sits
 * entirely between two fixes 60 NM apart and is missed completely by a
 * fix-vertex-only test.
 */
export function pathFromFixes(
  fixes: ReadonlyArray<{ lat: number; lon: number }>,
  opts: {
    startMs: number;
    gsKt: number;
    /** A level for the whole route, or a profile: given distance flown and the
     *  route's total length (both NM), return the altitude in feet. */
    altFt: number | ((distNm: number, totalNm: number) => number);
    stepNm?: number;
  },
): TimedPoint[] {
  const step = opts.stepNm ?? 2;
  const gs = opts.gsKt > 0 ? opts.gsKt : 450;
  const out: TimedPoint[] = [];
  if (fixes.length === 0) return out;

  const totalNm = routeLengthNm(fixes);
  const altAt =
    typeof opts.altFt === "function" ? opts.altFt : () => opts.altFt as number;

  let distNm = 0;
  const push = (lat: number, lon: number, d: number) =>
    out.push({
      lat,
      lon,
      altFt: altAt(d, totalNm),
      timeMs: opts.startMs + (d / gs) * 3600000,
    });

  push(fixes[0].lat, fixes[0].lon, 0);
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    const legNm = haversineNm(a, b);
    const n = Math.max(1, Math.ceil(legNm / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      // Linear in lat/lon: over a <=2 NM step the great-circle and the rhumb
      // agree to well inside the polygon tolerance this feeds.
      push(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, distNm + legNm * t);
    }
    distNm += legNm;
  }
  return out;
}

/**
 * A rough climb / cruise / descent profile, for checking a plan that has not
 * been generated yet.
 *
 * This exists because a flat-at-cruise estimate is not merely imprecise, it is
 * blind to most of the hazard: only 7 of the 110 published PDR polygons in
 * the Yangon FIR (AIRAC 2609) reach FL330, while 88 of them top out below
 * FL200. Check a plan at its RFL alone
 * and every low area under the climb-out and the descent is missed.
 *
 * Uses the controller's 3:1 rule — 3 NM per 1000 ft — from the departure and
 * arrival field elevations. It is an approximation of the engine's real BADA
 * profile and is labelled as such in the UI; once the flight is generated, the
 * check re-runs against the actual trajectory.
 */
export function climbCruiseDescentFt(opts: {
  rflFt: number;
  depElevFt?: number;
  arrElevFt?: number;
  nmPerThousandFt?: number;
  /** The route's FIRST point is not an aerodrome — a fix where the flight
   *  crosses into the area — so the aircraft is already at `rflFt` there.
   *  Without this the profile climbs from the ground at that fix, which for a
   *  flight only passing through puts it under every low-level area for the
   *  ~100 NM the phantom climb takes. */
  startAtLevel?: boolean;
  /** Likewise the last point: a fix the flight leaves the area at. */
  endAtLevel?: boolean;
}): (distNm: number, totalNm: number) => number {
  const grad = opts.nmPerThousandFt ?? 3;
  const dep = opts.depElevFt ?? 0;
  const arr = opts.arrElevFt ?? 0;
  return (distNm, totalNm) => {
    const climbing = opts.startAtLevel
      ? Infinity
      : dep + (distNm / grad) * 1000;
    const descending = opts.endAtLevel
      ? Infinity
      : arr + ((totalNm - distNm) / grad) * 1000;
    return Math.max(0, Math.min(opts.rflFt, climbing, descending));
  };
}

/**
 * Thin a generated trajectory down to roughly one sample per `stepNm`.
 *
 * The engine emits a point every 5 s, which at cruise is about 0.6 NM — far
 * finer than this check needs, and checking a whole traffic day at that density
 * against 110 area polygons is a lot of ray-casting for no extra answer. Thinning to
 * ~1.5 NM keeps every area comfortably (the smallest published PDR is several
 * miles across) while cutting the work several-fold.
 *
 * The first and last samples are always kept, so departure and arrival ends of
 * the route are never trimmed away.
 */
export function decimatePath(path: TimedPoint[], stepNm = 1.5): TimedPoint[] {
  if (path.length <= 2) return [...path];
  const out: TimedPoint[] = [path[0]];
  let anchor = path[0];
  for (let i = 1; i < path.length - 1; i++) {
    if (haversineNm(anchor, path[i]) >= stepNm) {
      out.push(path[i]);
      anchor = path[i];
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Total great-circle length of a fix list (NM). */
export function routeLengthNm(
  fixes: ReadonlyArray<{ lat: number; lon: number }>,
): number {
  let d = 0;
  for (let i = 1; i < fixes.length; i++) d += haversineNm(fixes[i - 1], fixes[i]);
  return d;
}
