/**
 * routeMatch — infer which published ATS route(s) connect an ORDERED chain
 * of known crossing fixes, from the AIP ENR 3 segment table
 * (`route_segments.json`).
 *
 * A track/FPL export often carries only the significant points a flight was
 * seen or filed at (`wp1`, `wp2`, `wp3`, …), never the route string. Two
 * consecutive fixes in that chain are not necessarily adjacent on the
 * published network — real ENR 3 routes have intermediate points a track
 * summary skips — and a single fix can sit on several routes at once, so
 * matching one waypoint in isolation is ambiguous. What is NOT ambiguous is
 * the PAIR: "the route(s) that connect fix A to fix B, in that order" has one
 * best (shortest) answer on the published network, honouring each segment's
 * own direction. This walks the whole chain that way, then collapses the
 * combined path into maximal same-route spans — so "APAGO -> X -> MDY" and
 * "MDY -> Y -> AKSAG" both riding Y8 render as one continuous "APAGO Y8
 * AKSAG" span, matching how a real Item-15 string names a route once, not
 * once per fix it happens to pass through.
 *
 * A pair the network genuinely does not connect (no path at all, or only
 * against a one-way segment's published direction) renders as a plain DCT
 * leg — a real gap in the data, not something to paper over.
 */

import type { RouteSegment } from "@/lib/pdr/airwayDirection";

interface Edge {
  to: string;
  route: string;
  distNm: number;
}

/** Directed adjacency: both orientations of a BOTH segment, one orientation
 *  each for FORWARD/BACKWARD, per the segment's own published direction. */
function buildGraph(segments: RouteSegment[]): Map<string, Edge[]> {
  const adj = new Map<string, Edge[]>();
  const add = (a: string, b: string, route: string, d: number) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ to: b, route, distNm: d });
  };
  for (const s of segments) {
    const a = s.from.trim().toUpperCase();
    const b = s.to.trim().toUpperCase();
    if (!a || !b || a === b) continue;
    const d = s.lengthNm ?? 1;
    if (s.direction !== "BACKWARD") add(a, b, s.route, d);
    if (s.direction !== "FORWARD") add(b, a, s.route, d);
  }
  return adj;
}

interface Leg {
  /** Fixes from `from` to `to` inclusive, length >= 1. */
  path: string[];
  /** One route designator per consecutive pair in `path` (length = path.length - 1). */
  edgeRoutes: string[];
}

/** Dijkstra, weighted by each segment's published length (falls back to a
 *  flat 1 when a segment carries no length, so hop count still breaks ties
 *  sensibly). Simple O(V^2) selection — this network is a few hundred fixes. */
function shortestLeg(
  adj: Map<string, Edge[]>,
  from: string,
  to: string,
): Leg | null {
  if (from === to) return { path: [from], edgeRoutes: [] };
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; route: string }>();
  const visited = new Set<string>();

  while (true) {
    let u: string | null = null;
    let uD = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < uD) {
        uD = d;
        u = node;
      }
    }
    if (u === null || u === to) break;
    visited.add(u);
    for (const e of adj.get(u) ?? []) {
      const nd = uD + e.distNm;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: u, route: e.route });
      }
    }
  }

  if (!dist.has(to)) return null;
  const path: string[] = [to];
  const edgeRoutes: string[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    path.push(p.node);
    edgeRoutes.push(p.route);
    cur = p.node;
  }
  path.reverse();
  edgeRoutes.reverse();
  return { path, edgeRoutes };
}

/** Render a fix path + per-hop route designators (or null = no published
 *  link) into an Item-15-style string, collapsing maximal same-route runs
 *  to "<fix> <ROUTE> <fix>" and an unmatched hop to "<fix> DCT <fix>". */
function renderPath(path: string[], edgeRoutes: (string | null)[]): string {
  if (path.length < 2) return path.join(" ");
  const parts: string[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    const r = edgeRoutes[i];
    if (r) {
      let j = i + 1;
      while (j < path.length - 1 && edgeRoutes[j] === r) j++;
      parts.push(r, path[j]);
      i = j;
    } else {
      parts.push("DCT", path[i + 1]);
      i += 1;
    }
  }
  return parts.join(" ");
}

/**
 * Infer the ATS route(s) connecting an ordered chain of fixes, e.g.
 * `["APAGO", "MDY", "AKSAG"]` -> `"APAGO Y8 AKSAG"` when the whole chain
 * rides one published route, or `"APAGO Y8 Y L507 AKSAG"` when the path
 * changes routes partway. A hop with no path on the published network at
 * all falls back to `DCT` for that span only.
 */
export function matchAtsRoute(
  fixes: string[],
  segments: RouteSegment[],
): string {
  const clean = fixes.map((f) => f.trim().toUpperCase()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];

  const adj = buildGraph(segments);
  const path: string[] = [clean[0]];
  const edgeRoutes: (string | null)[] = [];
  for (let i = 0; i + 1 < clean.length; i++) {
    const leg = shortestLeg(adj, clean[i], clean[i + 1]);
    if (leg && leg.path.length > 1) {
      path.push(...leg.path.slice(1));
      edgeRoutes.push(...leg.edgeRoutes);
    } else {
      path.push(clean[i + 1]);
      edgeRoutes.push(null);
    }
  }
  return renderPath(path, edgeRoutes);
}
