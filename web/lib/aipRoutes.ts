/**
 * aipRoutes — client loader + lookup for the predefined AIP flight-planning
 * routes (`/data/aip_routes_VY.json`: published city-pair routes, AIP ENR).
 *
 * The Generator uses these published routes VERBATIM in place of the
 * computed best-route, so a city pair flies its real filed route — no
 * graph-search shortest path, and no injected terminal navaid: the route
 * string holds only published fixes/airways, and the ADEP/ADES are anchored
 * by their own coordinates downstream.
 *
 * Routes are DIRECTIONAL (adep→ades ≠ ades→adep) and split by RNAV vs
 * Non-RNAV capability.
 *
 * DORMANT: no Myanmar published-route table has been extracted yet, so the
 * file does not exist. `fetchAipRoutes()` fails closed — an empty list, never
 * a throw — so the Generator falls back to its computed best-route for every
 * pair and the PDR check reports "no published route" for every pair. Drop a
 * `{ airac, routes: AipRoute[] }` file at this path and both pick it up.
 */

import type { Fix } from "./aip";
import type { RouteOption } from "./routeFinder";
import { resolveRoutePreview } from "./routePreview";

const AIP_ROUTES_URL = "/data/aip_routes_VY.json";

export interface AipRoute {
  adep: string;
  ades: string;
  rnav: boolean;
  route: string;
  /** Optional note for conditional routes (e.g. "when VY D23A is not active"). */
  condition?: string;
  /** Set on an overfly-mix route synthesized for a pair with no direct filed
   *  route, naming the hub fix its two halves were joined at (e.g. "BGO"). */
  via?: string;
}

interface AipRoutesFile {
  airac?: string;
  routes?: AipRoute[];
}

let _cache: Promise<AipRoute[]> | null = null;

/** Fetch + memoise the predefined-route table for the page's lifetime. Fails
 *  closed (empty list) rather than throwing — on a missing file (the VY
 *  default today), a non-JSON body, or a file without a `routes` array. */
export function fetchAipRoutes(): Promise<AipRoute[]> {
  if (!_cache) {
    _cache = fetch(AIP_ROUTES_URL, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load ${AIP_ROUTES_URL}: ${res.status}`);
        }
        return res.json() as Promise<AipRoutesFile>;
      })
      .then((j) => (Array.isArray(j?.routes) ? j.routes : []))
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
