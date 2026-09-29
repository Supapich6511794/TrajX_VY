/**
 * flightSearch — two-scope search/filter for generated flights.
 *
 * A generated set is a list of *routes*; several routes can belong to the
 * same *flight* (same callsign + ADEP/ADES). The UI exposes two fields:
 *   1. Flight — narrow to a flight by callsign or ADEP/ADES pair.
 *   2. Route  — within those, find a specific route by name
 *      (e.g. "BGO W13 MIA") or number (R2). Empty shows every route of the
 *      matched flight(s).
 * Both empty → everything. Shared by the Generator panel and the Route
 * Profile views so they behave identically.
 */

const SEPARATORS = /[\s,]+/;

function tokenize(query: string): string[] {
  return query.trim().toUpperCase().split(SEPARATORS).filter(Boolean);
}

export interface FlightScope {
  callsign: string;
  adep: string;
  ades: string;
}

export interface RouteScope {
  route: string;
  /** 0-based position in the generated list (matched as R{n} / {n}). */
  index: number;
}

/** Match the flight identity — callsign / ADEP / ADES. Empty → true. */
export function matchesFlight(query: string, f: FlightScope): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  const hay = [f.callsign, f.adep, f.ades].join(" ").toUpperCase();
  return tokens.every((t) => hay.includes(t));
}

/** Match a specific route by route string or route number (R2 / 2).
 *  Empty → true (i.e. show all routes of the matched flight). */
export function matchesRoute(query: string, r: RouteScope): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) return true;
  const hay = r.route.toUpperCase();
  const rTag = `R${r.index + 1}`;
  const num = `${r.index + 1}`;
  return tokens.every((t) => hay.includes(t) || t === rTag || t === num);
}

/** One rich suggestion row: a tag chip + main label + optional detail.
 *  `value` is what gets committed to the search box when picked. */
export interface SearchOption {
  value: string;
  tag: string;
  text: string;
  meta?: string;
}

/** Flight-field options — ONE row per distinct flight (callsign + pair),
 *  so the callsign and its ADEP→ADES sit together instead of as separate
 *  entries. Restricted to what was actually generated. */
export function flightOptions(
  items: { callsign: string; adep: string; ades: string }[],
): SearchOption[] {
  const seen = new Set<string>();
  const out: SearchOption[] = [];
  for (const it of items) {
    const cs = it.callsign.trim();
    const a = it.adep.trim().toUpperCase();
    const b = it.ades.trim().toUpperCase();
    const key = `${cs}|${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pair = a && b ? `${a} → ${b}` : a || b;
    out.push({
      value: [cs, a, b].filter(Boolean).join(" "),
      tag: cs || (a && b ? `${a}→${b}` : a || b),
      text: pair,
    });
  }
  return out;
}

/** Route-field options — ONE row per route combining its R-number, route
 *  string and distance. Pass the flight-filtered rows so the suggestions
 *  track the chosen flight. */
export function routeOptions(
  items: { route: string; index: number; distanceNm?: number }[],
): SearchOption[] {
  return items.map(({ route, index, distanceNm }) => ({
    value: route || `R${index + 1}`,
    tag: `R${index + 1}`,
    text: route || "(route)",
    meta: distanceNm != null ? `${distanceNm} NM` : undefined,
  }));
}
