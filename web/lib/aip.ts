/**
 * aip — client loader for the VY (Myanmar) navdata cache.
 *
 * The cache (`/data/aip_VY.json`) is built once per AIRAC cycle by
 * `scripts/ingest_aixm_waypoints.py` from the AIXM 5.1.1 export — every
 * DesignatedPoint/Navaid position, airways stitched from
 * `route_segments.json`, and airports from the AIXM-derived CSV.
 * `fetchAip()` fails closed (empty waypoints/airways/airports) on a fetch
 * error rather than throwing.
 *
 * IMPORTANT: `allFixes`/`airwaysMap` from here feed BOTH the map preview
 * (`resolveRoutePreview`, RouteBuilder's waypoint search) AND, in
 * `GeneratorPanel.tsx`, the `kBestRoutes` nearest-fix graph search that
 * used to back "Suggested" for any ADEP/ADES pair. That fallback has been
 * deliberately disabled there — real fix data alone is not permission to
 * suggest a route between two airports with no actual SID/STAR/ATS-route
 * connection; see the comment at `bestRoutes` in GeneratorPanel.tsx.
 *
 * Shape:
 *   {
 *     airac: "2026-09-03T00:00:00Z",
 *     waypoints: { AKSAG: { lat, lon }, ... },
 *     airways:   { B465: ["APAGO","MDY","AKSAG","LPB"], ... },
 *     airports:  { VYYY: { lat, lon, elev_ft, name }, ... }
 *   }
 */

const AIP_URL = "/data/aip_VY.json";

export interface AipAirport {
  lat: number;
  lon: number;
  elev_ft?: number;
  name?: string;
}

export interface AipData {
  airac: string;
  waypoints: Record<string, { lat: number; lon: number }>;
  airways: Record<string, string[]>;
  airports?: Record<string, AipAirport>;
}

export interface Fix {
  ident: string;
  lat: number;
  lon: number;
}

export interface AirportOption {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

let _cache: Promise<AipData> | null = null;

/** Fetch + memoise the AIP cache for the page's lifetime. Fails closed (empty
 *  waypoints/airways) rather than throwing when the cache is missing. */
export function fetchAip(): Promise<AipData> {
  if (!_cache) {
    _cache = fetch(AIP_URL, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${AIP_URL}: ${res.status}`);
        return res.json() as Promise<AipData>;
      })
      .catch(() => ({ airac: "", waypoints: {}, airways: {} }) as AipData);
  }
  return _cache;
}

/** All significant points / navaids with coords (340+ fixes). */
export async function fetchAllFixes(): Promise<Fix[]> {
  const aip = await fetchAip();
  const out: Fix[] = [];
  for (const [ident, w] of Object.entries(aip.waypoints)) {
    if (Number.isFinite(w.lat) && Number.isFinite(w.lon)) {
      out.push({ ident, lat: w.lat, lon: w.lon });
    }
  }
  return out;
}

/** designator → ordered ident sequence, for every published airway. */
export async function fetchAirwaysMap(): Promise<Record<string, string[]>> {
  const aip = await fetchAip();
  return aip.airways ?? {};
}

/** Aerodromes from the AIP AD section, sorted by ICAO. Empty when the
 *  cache predates aerodrome ingestion. */
export async function fetchAirports(): Promise<AirportOption[]> {
  const aip = await fetchAip();
  const airports = aip.airports ?? {};
  return Object.entries(airports)
    .map(([code, a]) => ({
      code,
      name: a.name ?? code,
      lat: a.lat,
      lon: a.lon,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
