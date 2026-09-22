/**
 * Directional and vertical limits on the ATS routes themselves.
 *
 * An airway is not automatically two-way. AIP Thailand ENR 3 prints a direction
 * per route — Y8 is a *uni-directional southbound route* — and AIXM states it
 * per segment, relative to that segment's own start and end:
 *
 *     BOTH      either way
 *     FORWARD   start -> end only
 *     BACKWARD  end -> start only
 *
 * In AIRAC 2609 (VY), 15 of 186 segments are one-way across 86 routes, so a
 * filed route can be made entirely of valid fixes on a real airway and still
 * be unflyable because it runs up a one-way street. Nothing else in the app
 * can see that: the fix list resolves, the geometry is fine, and the route
 * reaches the destination.
 *
 * Each segment also carries its own level band, which is the other thing a fix
 * list hides — a route can be legal on one half and below the airway's coded
 * floor on the other.
 *
 * Pure and DOM-free; the data comes from `scripts/ingest_aixm_route_segments.py`.
 */

import { routeTokens } from "./routeRules";

export type SegmentDirection = "BOTH" | "FORWARD" | "BACKWARD";

/** One published route segment, as ingested from AIXM. */
export interface RouteSegment {
  route: string;
  from: string;
  to: string;
  direction: SegmentDirection;
  /** Level band in feet. null = not published / no ceiling. */
  lowerFt: number | null;
  upperFt: number | null;
  lengthNm: number | null;
}

/** `/data/aixm_vy/route_segments.json`. */
export interface RouteSegmentFile {
  source: string;
  validFrom: string;
  validTo: string;
  segments: RouteSegment[];
}

const SEGMENTS_URL = "/data/aixm_vy/route_segments.json";

let _cache: Promise<RouteSegmentFile> | null = null;

/** Fetch + memoise the segment table for the page's lifetime. */
export function fetchRouteSegments(): Promise<RouteSegmentFile> {
  if (!_cache) {
    _cache = fetch(SEGMENTS_URL, { cache: "no-store" }).then((res) => {
      if (!res.ok) {
        throw new Error("Failed to load " + SEGMENTS_URL + ": " + res.status);
      }
      return res.json() as Promise<RouteSegmentFile>;
    });
  }
  return _cache;
}

/** One traversable step along an airway, in the direction of flight. */
interface Edge {
  to: string;
  segment: RouteSegment;
  /** True when flying this edge means going start -> end on the segment. */
  forward: boolean;
}

/** route designator -> fix -> the steps leaving it. */
export type SegmentIndex = Map<string, Map<string, Edge[]>>;

/** Build the adjacency the traversal walks. Both orientations are present so a
 *  path can be FOUND even when it is not permitted — reporting "you may not fly
 *  Y8 that way" is far more useful than "no path". */
export function indexSegments(segments: RouteSegment[]): SegmentIndex {
  const idx: SegmentIndex = new Map();
  for (const s of segments) {
    const route = s.route.toUpperCase();
    let byFix = idx.get(route);
    if (!byFix) {
      byFix = new Map();
      idx.set(route, byFix);
    }
    const add = (from: string, to: string, forward: boolean) => {
      const list = byFix!.get(from) ?? [];
      list.push({ to, segment: s, forward });
      byFix!.set(from, list);
    };
    add(s.from.toUpperCase(), s.to.toUpperCase(), true);
    add(s.to.toUpperCase(), s.from.toUpperCase(), false);
  }
  return idx;
}

/** Is flying this edge allowed by the segment's published direction? */
export function edgePermitted(edge: Edge): boolean {
  const d = edge.segment.direction;
  if (d === "BOTH") return true;
  return edge.forward ? d === "FORWARD" : d === "BACKWARD";
}

/** The chain of steps from `from` to `to` along one route, or null when the two
 *  fixes are not connected on it. Breadth-first, so the fewest segments. */
function pathAlong(
  byFix: Map<string, Edge[]>,
  from: string,
  to: string,
): Edge[] | null {
  if (from === to) return [];
  const seen = new Set<string>([from]);
  const queue: { fix: string; path: Edge[] }[] = [{ fix: from, path: [] }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const edge of byFix.get(cur.fix) ?? []) {
      if (seen.has(edge.to)) continue;
      const path = [...cur.path, edge];
      if (edge.to === to) return path;
      seen.add(edge.to);
      queue.push({ fix: edge.to, path });
    }
  }
  return null;
}

export type AirwayIssueKind =
  /** The span is flown against the route's published direction. */
  | "direction"
  /** The requested level is outside a traversed segment's published band. */
  | "level"
  /** The two fixes are not joined by that route at all. */
  | "not-connected"
  /** The route designator is not in the published table. */
  | "unknown-route";

export interface AirwayIssue {
  kind: AirwayIssueKind;
  route: string;
  /** The span as filed. */
  fromFix: string;
  toFix: string;
  /** The specific segment at fault, for direction and level issues. */
  segment?: RouteSegment;
  detail: string;
}

/**
 * Check every `<fix> <airway> <fix>` span in a filed route.
 *
 * `rflFt` enables the level check; pass null to check direction only. Tokens
 * that are not a known route designator are treated as fixes (a DCT leg, or a
 * SID/STAR name spliced into the string), so an unrecognised token never
 * produces a spurious finding.
 */
export function checkAirwayUsage(
  filedRoute: string,
  index: SegmentIndex,
  rflFt: number | null,
): AirwayIssue[] {
  const tokens = routeTokens(filedRoute);
  const issues: AirwayIssue[] = [];

  for (let i = 1; i + 1 < tokens.length; i++) {
    const route = tokens[i];
    const byFix = index.get(route);
    if (!byFix) continue; // not an airway designator — a fix or a DCT
    const fromFix = tokens[i - 1];
    const toFix = tokens[i + 1];

    const path = pathAlong(byFix, fromFix, toFix);
    if (path === null) {
      issues.push({
        kind: "not-connected",
        route,
        fromFix,
        toFix,
        detail:
          fromFix + " and " + toFix + " are not joined by " + route +
          " in the published segment table.",
      });
      continue;
    }

    for (const edge of path) {
      const s = edge.segment;
      if (!edgePermitted(edge)) {
        const allowed = s.direction === "FORWARD" ? s.from + " to " + s.to : s.to + " to " + s.from;
        issues.push({
          kind: "direction",
          route,
          fromFix,
          toFix,
          segment: s,
          detail:
            route + " is one-way over " + s.from + "-" + s.to +
            ": it may only be flown " + allowed + ", and this route flies it the other way.",
        });
      }
      if (rflFt != null) {
        const lo = s.lowerFt;
        const hi = s.upperFt;
        if (lo != null && rflFt < lo) {
          issues.push({
            kind: "level",
            route,
            fromFix,
            toFix,
            segment: s,
            detail:
              "The " + s.from + "-" + s.to + " segment of " + route +
              " is published from " + Math.round(lo) + " ft, and the requested level is " +
              Math.round(rflFt) + " ft.",
          });
        } else if (hi != null && rflFt > hi) {
          issues.push({
            kind: "level",
            route,
            fromFix,
            toFix,
            segment: s,
            detail:
              "The " + s.from + "-" + s.to + " segment of " + route +
              " is published to " + Math.round(hi) + " ft, and the requested level is " +
              Math.round(rflFt) + " ft.",
          });
        }
      }
    }
  }

  // One finding per (route, segment, kind): a long span that breaks the same
  // rule on several segments should not fill the panel with near-duplicates.
  const seen = new Set<string>();
  return issues.filter((x) => {
    const k =
      x.kind + "|" + x.route + "|" + (x.segment ? x.segment.from + "-" + x.segment.to : x.fromFix + "-" + x.toFix);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
