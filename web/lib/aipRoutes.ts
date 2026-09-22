/**
 * aipRoutes — client loader + lookup for the predefined AIP flight-planning
 * routes (`/data/aip_routes_VT.json`, Thai eAIP ENR 4).
 *
 * The Generator uses these published routes VERBATIM in place of the
 * computed best-route, so a city pair flies its real filed route — no
 * graph-search shortest path, and no injected terminal navaid (BKK / CMA /
 * MUBUS): the route string holds only published fixes/airways, and the
 * ADEP/ADES are anchored by their own coordinates downstream.
 *
 * Routes are DIRECTIONAL (adep→ades ≠ ades→adep) and split by RNAV vs
 * Non-RNAV capability.
 *
 * This is a Thai eAIP scrape with no VY equivalent; the file has been
 * removed with the rest of the Thailand data. `fetchAipRoutes()` fails
 * closed (empty list) rather than throwing, so the Generator just falls
 * back to its computed best-route for every pair until a real VY published-
 * route table exists at this same path/shape.
 */

import type { Fix } from "./aip";
import type { RouteOption } from "./routeFinder";
import { resolveRoutePreview } from "./routePreview";

const AIP_ROUTES_URL = "/data/aip_routes_VT.json";

export interface AipRoute {
  adep: string;
  ades: string;
  rnav: boolean;
  route: string;
  /** Optional note for conditional routes (e.g. "when VT D60 is not active"). */
  condition?: string;
  /** Set on an overfly-mix route synthesized for a pair with no direct filed
   *  route, naming the hub fix its two halves were joined at (e.g. "BKK"). */
  via?: string;
}

interface AipRoutesFile {
  airac?: string;
  routes?: AipRoute[];
}

let _cache: Promise<AipRoute[]> | null = null;

/** Fetch + memoise the predefined-route table for the page's lifetime. Fails
 *  closed (empty list) rather than throwing — there is no VY table yet. */
export function fetchAipRoutes(): Promise<AipRoute[]> {
  if (!_cache) {
    _cache = fetch(AIP_ROUTES_URL, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load ${AIP_ROUTES_URL}: ${res.status}`);
        }
        return res.json() as Promise<AipRoutesFile>;
      })
      .then((j) => j.routes ?? [])
      .catch(() => []);
  }
  return _cache;
}

const R_NM = 3440.065;

function haversineNm(
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

/**
 * Published routes for one directional pair + RNAV mode, as RouteOptions
 * (so they drop straight into the existing best-route UI). Distance is the
 * great-circle sum over the airway-expanded fixes plus the ADEP→first and
 * last→ADES legs (matching how the computed ranker measures), so the
 * "NM · min · PASS/FAIL" readout stays consistent.
 *
 * Returns [] when the pair has no published route — the caller then falls
 * back to the computed best-route.
 */
export function aipRouteOptions(
  table: AipRoute[],
  adep: string,
  ades: string,
  rnav: boolean,
  fixes: Fix[],
  airways: Record<string, string[]>,
  depLL?: { lat: number; lon: number } | null,
  desLL?: { lat: number; lon: number } | null,
): RouteOption[] {
  const A = adep.trim().toUpperCase();
  const D = ades.trim().toUpperCase();
  const matches = table.filter(
    (r) =>
      r.adep.trim().toUpperCase() === A &&
      r.ades.trim().toUpperCase() === D &&
      r.rnav === rnav,
  );
  return matches.map((r) => {
    const pts = resolveRoutePreview(r.route, fixes, airways);
    let d = 0;
    if (depLL && pts.length > 0) d += haversineNm(depLL, pts[0]);
    for (let i = 1; i < pts.length; i++) d += haversineNm(pts[i - 1], pts[i]);
    if (desLL && pts.length > 0) d += haversineNm(pts[pts.length - 1], desLL);
    return { text: r.route, distanceNm: Math.round(d * 10) / 10 };
  });
}
