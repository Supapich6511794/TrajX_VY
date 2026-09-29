/**
 * Which ATS sectors touch which — the constraint that makes a merge legal.
 *
 * Band-boxing two sectors into one position is only meaningful if a controller
 * can actually work them as one piece of airspace: they must share a boundary.
 * Two sectors at opposite ends of the FIR have low traffic at 0300Z as surely
 * as two neighbours do, and merging those would be a number on a page rather
 * than an operational configuration.
 *
 * The graph is built from the SAME volumes the membership test uses (see
 * `buildAirspaceIndex`), keyed by the SAME display names the flight events
 * carry, so the traffic counts and the geometry are talking about one airspace.
 *
 * Adjacency here means *the boundaries meet*, tested in two passes:
 *
 *   1. **Shared vertices.** Sector polygons cut from a common boundary set share
 *      coordinates exactly along the line they have in common, so most
 *      neighbours match on this alone. A quantised vertex set makes it O(n+m).
 *   2. **Vertex on an edge.** Where one polygon carries a vertex that the other
 *      does not, the point still lies ON its neighbour's boundary. Only run
 *      when pass 1 finds nothing and the bounding boxes overlap.
 *
 * Both are boundary tests, not overlap tests: a sector sitting *inside* another
 * (a CTR inside the TMA above it, say) is a containment relationship, and merging
 * across it would double-count the traffic. Layers are kept apart for the same
 * reason — a TMA and the CTA above it are different jobs, not two halves of
 * one.
 */

import type { AirspaceIndex, IndexEntry } from "@/lib/airspace";
import { sectorDisplayName } from "@/lib/airspace";
import type { SectorKey } from "@/lib/geojson";

/** Sector display name -> the sectors it shares a boundary with. */
export type SectorAdjacency = ReadonlyMap<string, ReadonlySet<string>>;

/** Coordinates closer than this are the same point. ~5 m at the equator: tight
 *  enough that two sectors with a real gap between them stay apart, loose
 *  enough to survive the rounding in a published GeoJSON. */
const VERTEX_EPS_DEG = 5e-5;

/** How far a vertex may sit from a neighbour's edge and still count as being on
 *  it. ~55 m — a boundary drawn with one extra vertex on one side only. */
const EDGE_EPS_DEG = 5e-4;

type Ring = ReadonlyArray<readonly number[]>;

/** Every ring of every polygon of every feature under one display name. A
 *  sector published as several features (altitude slabs, or separate lateral
 *  pieces under one name) is ONE sector and contributes them all. */
function ringsOf(entries: IndexEntry[]): Ring[] {
  const rings: Ring[] = [];
  for (const e of entries) for (const poly of e.mp) for (const ring of poly) rings.push(ring);
  return rings;
}

function bboxOf(entries: IndexEntry[]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const e of entries) {
    if (e.bbox[0] < minLon) minLon = e.bbox[0];
    if (e.bbox[1] < minLat) minLat = e.bbox[1];
    if (e.bbox[2] > maxLon) maxLon = e.bbox[2];
    if (e.bbox[3] > maxLat) maxLat = e.bbox[3];
  }
  return [minLon, minLat, maxLon, maxLat];
}

function bboxesTouch(
  a: [number, number, number, number],
  b: [number, number, number, number],
  pad: number,
): boolean {
  return !(
    a[2] + pad < b[0] ||
    b[2] + pad < a[0] ||
    a[3] + pad < b[1] ||
    b[3] + pad < a[1]
  );
}

/** Quantised key, so "the same point" survives float noise. */
function vkey(lon: number, lat: number): string {
  const q = (v: number) => Math.round(v / VERTEX_EPS_DEG);
  return q(lon) + ":" + q(lat);
}

/** Squared distance from p to segment ab, in degrees². Degrees are not a metric
 *  on a sphere, but over the few hundred metres this test cares about the
 *  distortion is far smaller than the tolerance itself. */
function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/** Grid cell for the segment lookup, in degrees. Big enough that a boundary
 *  segment lands in a handful of cells, small enough that a cell holds a
 *  handful of segments. */
const CELL_DEG = 0.25;

const cellKey = (cx: number, cy: number) => cx + ":" + cy;

/** Every segment of `rings`, bucketed by the cells its (padded) extent covers.
 *  Built once per sector and reused against every other sector. */
function segmentGrid(rings: Ring[]): Map<string, number[][]> {
  const grid = new Map<string, number[][]>();
  const put = (cx: number, cy: number, seg: number[]) => {
    const k = cellKey(cx, cy);
    const list = grid.get(k);
    if (list) list.push(seg);
    else grid.set(k, [seg]);
  };
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1];
      const b = ring[i];
      const seg = [a[0], a[1], b[0], b[1]];
      const x0 = Math.floor((Math.min(a[0], b[0]) - EDGE_EPS_DEG) / CELL_DEG);
      const x1 = Math.floor((Math.max(a[0], b[0]) + EDGE_EPS_DEG) / CELL_DEG);
      const y0 = Math.floor((Math.min(a[1], b[1]) - EDGE_EPS_DEG) / CELL_DEG);
      const y1 = Math.floor((Math.max(a[1], b[1]) + EDGE_EPS_DEG) / CELL_DEG);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) put(cx, cy, seg);
    }
  }
  return grid;
}

/**
 * Does any vertex of `rings` lie on an edge of the sector `grid` was built
 * from?
 *
 * Only the segments in the vertex's own cell are tested. That is exact, not an
 * approximation: a segment within EDGE_EPS of the vertex has a padded extent
 * that covers the vertex, so it was filed in that cell when the grid was built.
 *
 * The naive form — every vertex against every segment — is quadratic in the
 * vertex count and ran on the main thread while the panel waited; for large
 * sector polygons with heavily overlapping bounding boxes the bbox pre-reject
 * that was supposed to keep it rare rejects almost nothing.
 */
function vertexOnEdge(rings: Ring[], grid: Map<string, number[][]>): boolean {
  const eps2 = EDGE_EPS_DEG * EDGE_EPS_DEG;
  for (const ring of rings) {
    for (const p of ring) {
      const near = grid.get(
        cellKey(Math.floor(p[0] / CELL_DEG), Math.floor(p[1] / CELL_DEG)),
      );
      if (!near) continue;
      for (const sg of near) {
        if (distSqToSegment(p[0], p[1], sg[0], sg[1], sg[2], sg[3]) <= eps2) return true;
      }
    }
  }
  return false;
}

/**
 * Build the adjacency graph for one airspace layer.
 *
 * Returns an empty graph for a layer whose volumes do not touch — the CTRs are
 * islands around their aerodromes, and that is a real answer: nothing there can
 * be band-boxed.
 */
/** Airspace geometry does not change between report builds, but the report
 *  cache is keyed on the traffic — so without this the graph was rebuilt every
 *  time a flight was regenerated, for an answer that could not have changed. */
const adjacencyCache = new WeakMap<object, Map<string, SectorAdjacency>>();

export function buildSectorAdjacency(
  index: AirspaceIndex,
  layer: SectorKey,
): SectorAdjacency {
  const perIndex = adjacencyCache.get(index) ?? new Map<string, SectorAdjacency>();
  const cached = perIndex.get(layer);
  if (cached) return cached;

  const entries = index[layer] ?? [];
  // Collapse the features down to sectors: features sharing a name are one.
  const byName = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const name = sectorDisplayName(layer, e.label);
    if (!name) continue;
    const list = byName.get(name);
    if (list) list.push(e);
    else byName.set(name, [e]);
  }

  const names = [...byName.keys()].sort();
  const shape = new Map(
    names.map((n) => {
      const es = byName.get(n) as IndexEntry[];
      const rings = ringsOf(es);
      const keys = new Set<string>();
      for (const ring of rings) for (const p of ring) keys.add(vkey(p[0], p[1]));
      // The grid is built lazily: most pairs are settled by the shared-vertex
      // test, and a sector no pair falls through on never needs one.
      let grid: Map<string, number[][]> | null = null;
      return [
        n,
        {
          rings,
          keys,
          bbox: bboxOf(es),
          segments: () => (grid ??= segmentGrid(rings)),
        },
      ] as const;
    }),
  );

  const adj = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = shape.get(names[i]);
      const b = shape.get(names[j]);
      if (!a || !b) continue;
      if (!bboxesTouch(a.bbox, b.bbox, EDGE_EPS_DEG)) continue;
      let touching = false;
      for (const k of a.keys) {
        if (b.keys.has(k)) {
          touching = true;
          break;
        }
      }
      if (!touching) {
        touching =
          vertexOnEdge(a.rings, b.segments()) || vertexOnEdge(b.rings, a.segments());
      }
      if (touching) {
        (adj.get(names[i]) as Set<string>).add(names[j]);
        (adj.get(names[j]) as Set<string>).add(names[i]);
      }
    }
  }
  perIndex.set(layer, adj);
  adjacencyCache.set(index, perIndex);
  return adj;
}

/**
 * Sector outlines by display name — the outer ring of each polygon.
 *
 * The same collapse by display name the adjacency graph uses, so a sector
 * modelled as two altitude slabs comes back as one shape. Only outer rings: a
 * hole in a sector is not something a working boundary is cut around.
 */
export function sectorShapes(
  index: AirspaceIndex,
  layer: SectorKey,
): ReadonlyMap<string, { lat: number; lon: number }[][]> {
  const out = new Map<string, { lat: number; lon: number }[][]>();
  for (const e of index[layer] ?? []) {
    const name = sectorDisplayName(layer, e.label);
    if (!name) continue;
    const rings = e.mp
      .map((poly) => (poly[0] ?? []).map((c) => ({ lon: c[0], lat: c[1] })))
      .filter((r) => r.length >= 3);
    const existing = out.get(name);
    if (existing) existing.push(...rings);
    else out.set(name, rings);
  }
  return out;
}

/** Do these two sectors share a boundary? Unknown sectors are never adjacent —
 *  a name the geometry does not know about cannot be merged into anything. */
export function areAdjacent(adj: SectorAdjacency, a: string, b: string): boolean {
  return adj.get(a)?.has(b) ?? false;
}

/** The sectors the graph knows, sorted — the BASELINE for a layer. Traffic rows
 *  only name sectors that were flown; the baseline is every published sector,
 *  so an hour with no traffic at all still reports its open positions. */
export function sectorsOf(adj: SectorAdjacency): string[] {
  return [...adj.keys()].sort();
}
