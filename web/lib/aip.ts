/**
 * aip — client loader for the CAAT eAIP navdata cache.
 *
 * The cache (`/data/aip_VT.json`) was produced once per AIRAC cycle by
 * `scripts/ingest_aip.py` from the Thai eAIP — a scrape, not something AIXM
 * carries, so there is no VY (Myanmar) equivalent. The file has been removed
 * along with the rest of the Thailand data; `fetchAip()` now fails closed
 * (empty waypoints/airways) instead of throwing, so the route picker and
 * best-route ranker just see no published fixes/airways until a real VY eAIP
 * cache exists at this same path/shape.
 *
 * Shape:
 *   {
 *     airac: "2026-05-14",
 *     waypoints: { VANKO: { lat, lon }, ... },
 *     airways:   { Y8: ["BKK","MOTNA",...], ... }
 *   }
 */

const AIP_URL = "/data/aip_VT.json";

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
 *  waypoints/airways) rather than throwing — there is no VY cache yet. */
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
