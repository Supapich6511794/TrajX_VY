/**
 * The airspace configuration actually in force, hour by hour.
 *
 * Dynamic sectorisation used to stop at a proposal: the panel drew a plan, the
 * export wrote it down, and the simulation carried on dividing the sky exactly
 * as the AIP does. A band-box that saved a position on paper saved nothing in
 * the picture — two aircraft in North and East still counted as two units and still
 * raised a coordination flag, when the whole point of band-boxing them is that
 * one controller now holds both.
 *
 * This is the layer that closes that gap, and it is deliberately a LAYER:
 *
 *     published sectors  ->  dynamic plan  ->  EFFECTIVE configuration  ->  sim
 *
 * Nothing here edits the published airspace. `airspaceIndex` and the sector
 * GeoJSON stay exactly what the AIP says, because they are the baseline the
 * planner measures against — rewrite them from a plan and the next run plans
 * against its own output. What this module does instead is answer one question,
 * purely:
 *
 *     "the AIP calls this point North at this time; who is actually working it?"
 *
 * Everything downstream asks that question instead of reading the published
 * label directly, and with no plan loaded the answer is the published label, so
 * the simulation behaves exactly as it did before.
 *
 * A plan changes ownership two ways, and they resolve in this order:
 *
 *   1. **A re-cut** hands a SLICE of an overloaded sector to a neighbour. That
 *      is geometry, so it is a point-in-polygon test and has to come first: the
 *      slice's new owner is what then gets grouped.
 *   2. **A band-box** works several whole sectors as one position. That is a
 *      name change — North and East both become "North+East".
 */

import { pointInMultiPolygon } from "@/lib/airspace";
import { hourBucket, type FlightEventRow } from "./flightEvents";
import type { LatLon } from "./dynamicArea";
import type { DynamicPlan } from "./dynamicSectors";

/** A slice of airspace that changed hands, ready to be tested against. */
interface TransferSlice {
  from: string;
  to: string;
  /** The ceded boundary as a single ring, in the [lon, lat] order the
   *  point-in-polygon test wants. */
  mp: number[][][][];
  /** Cheap reject before the ring test, same trick the airspace index uses. */
  bbox: [number, number, number, number];
}

export interface EffectiveHour {
  hourUtc: string;
  /** Published sector -> the position working it. Only sectors whose ownership
   *  CHANGED are listed; anything absent is worked as published. */
  positionOf: Map<string, string>;
  transfers: TransferSlice[];
}

export interface EffectiveConfig {
  /** The published layer this plan governs — "tma" and so on. A plan says
   *  nothing about the layers it did not plan, and those stay published. */
  layer: string;
  hours: Map<string, EffectiveHour>;
}

/**
 * The hour an instant falls in, as the ISO stamp the plan keys its hours by.
 *
 * Delegates to `hourBucket` rather than formatting its own. It did format its
 * own to begin with, one character differently — `T03:00:00Z` against the
 * plan's `T03:00Z` — so every lookup missed and the whole layer was a silent
 * no-op. Nothing caught it: a lookup that never matches behaves exactly like a
 * configuration that changes nothing, which is the state this is designed to be
 * indistinguishable from when idle. One source for the key is the fix.
 */
export function hourKey(atMs: number): string {
  return hourBucket(Math.floor(atMs / 3600000) * 3600000);
}

function ringBbox(ring: LatLon[]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * The per-hour configurations a plan puts in force.
 *
 * Only a plan that has been APPLIED counts. An unapplied plan is a proposal on
 * screen, and a proposal that silently re-partitioned the airspace would make
 * the panel's "Apply" button meaningless — worse, it would change the numbers
 * the reader is using to decide whether to apply it.
 */
export function effectiveConfig(plan: DynamicPlan | null | undefined): EffectiveConfig | null {
  if (!plan || !plan.appliedAt) return null;
  const hours = new Map<string, EffectiveHour>();

  for (const h of plan.hours) {
    const positionOf = new Map<string, string>();
    for (const p of h.positions) {
      // A position worked by one sector is that sector: nothing to record.
      if (!p.merged || p.sectors.length < 2) continue;
      for (const s of p.sectors) positionOf.set(s, p.label);
    }
    const transfers: TransferSlice[] = (h.transfers ?? [])
      .filter((t) => t.boundary && t.boundary.length >= 3)
      .map((t) => ({
        from: t.from,
        to: t.to,
        mp: [[t.boundary.map((p) => [p.lon, p.lat])]],
        bbox: ringBbox(t.boundary),
      }));
    if (positionOf.size === 0 && transfers.length === 0) continue;
    hours.set(h.hourUtc, { hourUtc: h.hourUtc, positionOf, transfers });
  }

  if (hours.size === 0) return null;
  return { layer: plan.config.layer, hours };
}

/**
 * Who is working a point that the AIP calls `published`, at `atMs`.
 *
 * Returns `published` unchanged when there is no plan, no configuration for
 * that hour, or nothing in force there — which is the common case and the
 * reason this is safe to put in front of every sector lookup.
 */
export function positionAt(
  cfg: EffectiveConfig | null,
  published: string,
  lon: number,
  lat: number,
  atMs: number,
): string {
  if (!cfg || !published) return published;
  const hour = cfg.hours.get(hourKey(atMs));
  if (!hour) return published;

  // Geometry first: a slice that changed hands belongs to its new owner before
  // any question of who that owner is grouped with.
  let sector = published;
  for (const t of hour.transfers) {
    if (t.from !== sector) continue;
    if (lon < t.bbox[0] || lon > t.bbox[2] || lat < t.bbox[1] || lat > t.bbox[3]) {
      continue;
    }
    if (pointInMultiPolygon(lon, lat, t.mp)) {
      sector = t.to;
      break;
    }
  }
  return hour.positionOf.get(sector) ?? sector;
}

/** Every position open in an hour, for a readout. Published sectors worked
 *  alone are not listed — this is what the plan CHANGED. */
export function positionsInForce(cfg: EffectiveConfig | null, atMs: number): string[] {
  const hour = cfg?.hours.get(hourKey(atMs));
  if (!hour) return [];
  return [...new Set(hour.positionOf.values())].sort();
}

// --- Re-labelling the traffic -----------------------------------------------

/**
 * The sector events as the APPLIED configuration saw them.
 *
 * Feeding the result back through the ordinary `buildSectorHours` is the whole
 * trick: the effective table is then produced by exactly the same code as the
 * published one, so the two cannot drift apart in their arithmetic — only in
 * the names they are keyed by, which is the entire point.
 *
 * The part that is not a rename is the coalescing. An aircraft that crosses
 * from North into East generates an exit and an entry, and when those two sectors
 * are band-boxed it has not gone anywhere: the same controller had it before
 * and after. Re-labelling alone would record two entries to "North+East" and count
 * the aircraft twice in its own position's workload, which would make a
 * band-box look busier than the sectors it replaced. Consecutive spells in one
 * position are therefore merged into one.
 *
 * Only the layer the plan governs is touched. Events on every other layer, and
 * every non-sector event, pass through untouched and in place.
 */
export function effectiveEvents(
  events: FlightEventRow[],
  cfg: EffectiveConfig | null,
): FlightEventRow[] {
  if (!cfg) return events;

  const isSector = (e: FlightEventRow) =>
    (e.event === "SECTOR_ENTRY" || e.event === "SECTOR_EXIT") &&
    e.layer === cfg.layer;

  const passthrough = events.filter((e) => !isSector(e));
  const mine = events.filter(isSector);
  if (mine.length === 0) return events;

  const out: FlightEventRow[] = [...passthrough];
  const byFlight = new Map<string, FlightEventRow[]>();
  for (const e of mine) {
    const list = byFlight.get(e.flightKey);
    if (list) list.push(e);
    else byFlight.set(e.flightKey, [e]);
  }

  for (const rows of byFlight.values()) {
    rows.sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc));

    // Pair each entry with the exit that closes it. Matched on the sector name
    // rather than on adjacency in the list: the rows are sorted by time and a
    // boundary puts an exit and an entry on the same timestamp, so position in
    // the list is not a reliable pairing.
    const spells: { pos: string; from: FlightEventRow; to: FlightEventRow }[] = [];
    const open = new Map<string, FlightEventRow>();
    for (const e of rows) {
      if (e.event === "SECTOR_ENTRY") {
        open.set(e.ident, e);
        continue;
      }
      const from = open.get(e.ident);
      if (!from) continue; // an exit with no entry: nothing to re-label
      open.delete(e.ident);
      spells.push({
        pos: positionAt(cfg, from.ident, from.lonDeg, from.latDeg, Date.parse(from.timeUtc)),
        from,
        to: e,
      });
    }
    spells.sort((a, b) => Date.parse(a.from.timeUtc) - Date.parse(b.from.timeUtc));

    // Merge consecutive spells in the same position — the crossing that is not
    // a crossing any more.
    for (let i = 0; i < spells.length; i++) {
      const s = spells[i];
      let last = s;
      while (
        i + 1 < spells.length &&
        spells[i + 1].pos === s.pos &&
        Date.parse(spells[i + 1].from.timeUtc) <= Date.parse(last.to.timeUtc)
      ) {
        i += 1;
        last = spells[i];
      }
      out.push(relabel(s.from, s.pos), relabel(last.to, s.pos));
    }
  }

  return out.sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc));
}

/** The same event, said of the position instead of the published sector. */
function relabel(e: FlightEventRow, pos: string): FlightEventRow {
  if (pos === e.ident) return e;
  return {
    ...e,
    ident: pos,
    description: e.description.split(e.ident).join(pos),
  };
}
