/**
 * Dynamic sectorization — how many controller positions the traffic actually
 * needs, hour by hour.
 *
 * A published sector map is sized for the busy hour. At 0300Z the same map has
 * a controller sitting in front of two aircraft. Real ACCs band-box: adjacent
 * sectors are worked from one position while it is quiet, and split back when
 * the traffic returns. This module works out where that would have happened in
 * a run, and says so as an operational plan.
 *
 * What it is NOT
 * --------------
 * It does not touch the airspace. The published sectors (the AIXM airspace
 * boundaries under `public/data/aixm_vy`) are the baseline and stay the
 * baseline: every result here is expressed as *groupings of* those sectors,
 * every group can be read back to its members, and nothing is written anywhere. A merged position
 * is a staffing decision — who works which airspace this hour — not a new
 * volume. The report says so in as many words, because a table of "sector A+B"
 * is otherwise easy to mistake for a redrawn map.
 *
 * Where the numbers come from
 * ---------------------------
 * `buildSectorHours` — the same table the sector-hour report and the Sector
 * information panel read, built from the same flight events. There is no second
 * traffic count here and there must not be one: two counters drift, and then
 * the tool argues with itself about how busy a sector was. This module consumes
 * `SectorHourRow.occupancy` (aircraft PRESENT in the hour, not just crossings
 * in) and adds only the grouping decision on top.
 *
 * The rule
 * --------
 * Greedy, adjacency-constrained, deterministic:
 *
 *   1. Every published sector of the layer starts as its own position, carrying
 *      its own traffic — including sectors with no traffic at all, which is
 *      exactly the case band-boxing exists for.
 *   2. Repeatedly merge the two ADJACENT positions whose combined traffic is
 *      smallest, so long as that combined traffic stays under `mergeBelow` and
 *      the position would not exceed `maxSectorsPerPosition`.
 *   3. Stop when no pair qualifies.
 *
 * A sector already at or above the threshold can never merge: its own traffic
 * alone fails the combined test. That falls out of the rule rather than being a
 * special case, which is why the rule is stated as a ceiling on the RESULT — a
 * position is judged by what one controller ends up holding, not by how quiet
 * the pieces were separately.
 */

import type { SectorHourRow } from "./flightEvents";
import type { SectorAdjacency } from "./sectorAdjacency";
import { sectorsOf } from "./sectorAdjacency";
import {
  planAreaTransfer,
  type AreaTransfer,
  type Blocker,
  type Rings,
} from "./dynamicArea";

/**
 * What to do with one hour.
 *
 * `auto` lets the traffic decide; the other three are the operator saying
 * otherwise. A decision is per HOUR because that is the unit a watch supervisor
 * changes a configuration in — not per sector, which would let someone merge
 * one half of a pairing and not the other.
 */
export type HourDecision = "auto" | "keep" | "merge" | "split";

/**
 * Who decides: the traffic, or the operator.
 *
 * `auto` plans every hour from the sample and nothing else touches it. `manual`
 * hands the decision back: every hour keeps the published configuration until
 * the operator says otherwise, hour by hour — which is where a per-hour
 * override belongs, and the honest setting for a study where the configuration
 * is an input rather than a result.
 *
 * Overrides are read in `manual` ONLY. Letting them apply in `auto` would mean
 * a stored decision quietly steering a mode whose whole claim is that the
 * traffic decides — and with the control hidden there, invisibly.
 */
export type DynamicMode = "auto" | "manual";

export interface DynamicSectorConfig {
  mode: DynamicMode;
  /** Hours the operator has decided for themselves, by hour bucket. Read in
   *  `manual` mode only — see {@link DynamicMode}. Kept across a switch to
   *  `auto` and back rather than cleared, so changing mode to look at what the
   *  traffic would have done does not throw the work away. */
  overrides?: Record<string, HourDecision>;
  /** Which airspace layer to plan. Only one layer is ever merged at a time: a
   *  TMA and the CTA above it are different jobs, not two halves of one. */
  layer: string;
  /** A position may be formed while its COMBINED traffic stays under this many
   *  aircraft in the hour. The operational knob. */
  mergeBelow: number;
  /** Most published sectors one position may hold. Three is already a wide
   *  band-box; the cap keeps a quiet night from collapsing a whole FIR onto one
   *  controller, which no ACC would do however low the count. */
  maxSectorsPerPosition: number;
  /** A sector is OVER capacity at or above this many aircraft in the hour, and
   *  a slice of its airspace is offered to a neighbour with room. Must sit
   *  above `mergeBelow` — a sector cannot be too quiet and too busy at once. */
  splitAbove: number;
  /** Minutes of notice before a configuration change takes effect, so the
   *  handover can be briefed and the radar labels re-drawn. Reported, not
   *  simulated: it sets `notifyBy` on each transition. */
  leadTimeMin: number;
  /** Fewest hours a configuration must hold. Stops a boundary from moving back
   *  and forth on noise, which is worse for a controller than leaving it. */
  minHoldHours: number;
  /** How far ceded airspace may reach from the sector taking it, in NM — a
   *  stand-in for surveillance and radio coverage, which this dataset does not
   *  carry. */
  maxCedeNm: number;
}

export const DEFAULT_DYNAMIC_CONFIG: DynamicSectorConfig = {
  mode: "auto",
  layer: "tma",
  mergeBelow: 6,
  maxSectorsPerPosition: 3,
  splitAbove: 14,
  leadTimeMin: 20,
  minHoldHours: 2,
  maxCedeNm: 250,
};

/** The geometry and the restricted airspace the area re-cut needs. Optional:
 *  without it the planner still merges, and simply reports that it could not
 *  consider re-cutting an overloaded sector. */
export interface AreaContext {
  /** Sector outline by display name, same names the traffic rows use. */
  shapes: ReadonlyMap<string, Rings>;
  /** Prohibited/restricted airspace that is ACTIVE in the hour being planned.
   *  Keyed by hour so an area that is cold at 0300 does not veto a cut. */
  blockersAt?: (hourUtc: string) => Blocker[];
}

/** One controller position for one hour: the sectors worked together, and the
 *  traffic that put them there. */
export interface DynamicPosition {
  /** Published sectors worked as one, sorted. */
  sectors: string[];
  /** "North+South" for a band-box, "North" for a sector worked on its own. */
  label: string;
  /** Distinct aircraft in the position over the hour. Not the sum of the member
   *  counts: an aircraft that crosses from one member to another is one
   *  aircraft to the controller who now holds both. */
  flights: number;
  /** What each member contributed, in the group's own order. */
  members: { sector: string; flights: number }[];
  merged: boolean;
}

/** Why an overloaded sector was left alone. Kept rather than dropped: "no
 *  boundary was moved" and "no boundary could legally be moved" are different
 *  answers, and only one of them means the plan is finished. */
export interface BlockedSplit {
  sector: string;
  flights: number;
  reason: string;
}

export interface DynamicHour {
  hourUtc: string;
  layer: string;
  positions: DynamicPosition[];
  /** Sectors over capacity this hour, busiest first. */
  overloaded: { sector: string; flights: number }[];
  /** Boundary changes: a slice of an overloaded sector handed to a neighbour. */
  transfers: AreaTransfer[];
  /** Overloads that could not be relieved, and why. */
  blocked: BlockedSplit[];
  /** What this hour asks for, in one word. */
  change: "none" | "merge" | "split" | "merge+split";
  /** How the hour was decided, and whether a person decided it. */
  decision: HourDecision;
  manual: boolean;
  /** Published sectors considered — the baseline this hour is measured against. */
  baselineSectors: number;
  /** Positions actually opened. `baselineSectors - positionsOpen` is the saving. */
  positionsOpen: number;
  /** Sectors that were in a band-box last hour and are worked on their own now:
   *  the split-back, which is the half of the story a merge table usually
   *  leaves out. */
  splitBack: string[];
}

/** A band-box that held together across consecutive hours. The report reads
 *  from these: a merge is an operational period, not an isolated hour. */
export interface DynamicSpan {
  label: string;
  sectors: string[];
  /** First hour of the band-box, and the first hour it was NO LONGER in force
   *  (exclusive), so `fromHourUtc` .. `toHourUtc` reads as a period. */
  fromHourUtc: string;
  toHourUtc: string;
  hours: number;
  /** Busiest hour the merged position saw — the headroom that was left. */
  peakFlights: number;
  /** Why it ended. `traffic` is the one that matters: the count reached the
   *  threshold and the sectors were split back. */
  endedBy: "traffic" | "regrouped" | "end-of-run";
}

/** A moment the configuration should change, and the notice it needs. */
export interface DynamicTransition {
  /** Hour the new configuration takes effect. */
  hourUtc: string;
  /** When the change has to be published — `hourUtc` less the lead time. */
  notifyBy: string;
  kind: "merge" | "split" | "revert";
  /** What changes, in one line. */
  detail: string;
}

export interface DynamicPlan {
  config: DynamicSectorConfig;
  /** When the operator accepted this configuration, ISO UTC. Null while it is
   *  still a recommendation.
   *
   *  Nothing about the PLAN changes on being applied — what changes is that it
   *  comes into force: `lib/report/effectiveSectors.ts` reads this field, and
   *  only an applied plan is layered over the published airspace, so from that
   *  moment the simulation attributes traffic and conflicts to the positions
   *  below rather than to the published sectors. A proposal deliberately does
   *  not, or the numbers being read to judge it would already reflect it. */
  appliedAt: string | null;
  hours: DynamicHour[];
  spans: DynamicSpan[];
  transitions: DynamicTransition[];
  /** Published sectors of this layer, the baseline the plan never alters. */
  baseline: string[];
}

const labelOf = (sectors: string[]) => sectors.join("+");

interface Group {
  sectors: string[];
  /** Distinct callsigns across the members. */
  flights: Set<string>;
}

/** Traffic for one sector in one hour: aircraft present, and which. */
function trafficOf(row: SectorHourRow | undefined): string[] {
  return row ? row.occupancyFlights : [];
}

/**
 * Group one hour's sectors into positions.
 *
 * Exported for the tests, and because the hour is the unit a controller thinks
 * in — the whole-run plan is just this, repeated.
 */
export function planHour(
  hourUtc: string,
  rowsBySector: Map<string, SectorHourRow>,
  adjacency: SectorAdjacency,
  config: DynamicSectorConfig,
): Pick<
  DynamicHour,
  "hourUtc" | "layer" | "positions" | "baselineSectors" | "positionsOpen"
> {
  const baseline = sectorsOf(adjacency);
  const groups: Group[] = baseline.map((s) => ({
    sectors: [s],
    flights: new Set(trafficOf(rowsBySector.get(s))),
  }));

  const adjacent = (a: Group, b: Group) =>
    a.sectors.some((x) => b.sectors.some((y) => adjacency.get(x)?.has(y)));

  for (;;) {
    let best: { i: number; j: number; flights: number; label: string } | null = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        if (a.sectors.length + b.sectors.length > config.maxSectorsPerPosition) continue;
        if (!adjacent(a, b)) continue;
        const union = new Set([...a.flights, ...b.flights]);
        if (union.size >= config.mergeBelow) continue;
        const label = labelOf([...a.sectors, ...b.sectors].sort());
        // Smallest combined position first; the label breaks ties so the same
        // traffic always yields the same plan. A plan that shuffles between
        // runs cannot be checked against anything.
        if (
          !best ||
          union.size < best.flights ||
          (union.size === best.flights && label < best.label)
        ) {
          best = { i, j, flights: union.size, label };
        }
      }
    }
    if (!best) break;
    const a = groups[best.i];
    const b = groups[best.j];
    groups.splice(best.j, 1);
    groups.splice(best.i, 1);
    groups.push({
      sectors: [...a.sectors, ...b.sectors].sort(),
      flights: new Set([...a.flights, ...b.flights]),
    });
  }

  const positions: DynamicPosition[] = groups
    .map((g) => ({
      sectors: g.sectors,
      label: labelOf(g.sectors),
      flights: g.flights.size,
      members: g.sectors.map((s) => ({
        sector: s,
        flights: trafficOf(rowsBySector.get(s)).length,
      })),
      merged: g.sectors.length > 1,
    }))
    .sort((x, y) => x.label.localeCompare(y.label));

  return {
    hourUtc,
    layer: config.layer,
    positions,
    baselineSectors: baseline.length,
    positionsOpen: positions.length,
  };
}

/**
 * Re-cut the airspace of the sectors that are over capacity this hour.
 *
 * Each overloaded sector is offered to its neighbours in turn, least-loaded
 * first, and the first neighbour that can legally take the slice gets it. Only
 * one transfer per overloaded sector: a second cut on the same airspace in the
 * same hour is two boundary changes to brief, and the first has already brought
 * the sector under capacity by construction.
 *
 * Sectors inside a merged position are skipped. They were band-boxed for being
 * quiet, so they cannot be overloaded, and a position that IS overloaded should
 * be un-merged before anyone starts moving boundaries.
 */
function planOverloads(
  hourUtc: string,
  rowsBySector: Map<string, SectorHourRow>,
  positions: DynamicPosition[],
  adjacency: SectorAdjacency,
  config: DynamicSectorConfig,
  area: AreaContext | undefined,
  /** False when the operator has said not to re-cut this hour. The overload is
   *  still MEASURED and reported — a sector over capacity is a fact about the
   *  traffic, and hiding it because nobody asked for a fix is how a capacity
   *  study ends up quietly reassuring. */
  act: boolean,
): Pick<DynamicHour, "overloaded" | "transfers" | "blocked"> {
  const load = (sector: string) => rowsBySector.get(sector)?.occupancy ?? 0;
  const standalone = new Set(
    positions.filter((p) => !p.merged).flatMap((p) => p.sectors),
  );
  const overloaded = [...standalone]
    .filter((s) => load(s) >= config.splitAbove)
    .map((s) => ({ sector: s, flights: load(s) }))
    .sort((a, b) => b.flights - a.flights || a.sector.localeCompare(b.sector));

  const transfers: AreaTransfer[] = [];
  const blocked: BlockedSplit[] = [];
  if (overloaded.length === 0) return { overloaded, transfers, blocked };
  if (!act) {
    for (const o of overloaded) {
      blocked.push({ ...o, reason: "this hour is set not to re-cut the airspace" });
    }
    return { overloaded, transfers, blocked };
  }

  if (!area) {
    for (const o of overloaded) {
      blocked.push({
        ...o,
        reason: "the sector outlines are not loaded, so no boundary can be cut",
      });
    }
    return { overloaded, transfers, blocked };
  }

  const blockers = area.blockersAt ? area.blockersAt(hourUtc) : [];
  // Traffic already handed to a sector counts against its room for more.
  const received = new Map<string, number>();

  for (const o of overloaded) {
    const fromRings = area.shapes.get(o.sector);
    const points = rowsBySector.get(o.sector)?.occupancyPoints ?? [];
    if (!fromRings || fromRings.length === 0) {
      blocked.push({ ...o, reason: "no published outline for " + o.sector });
      continue;
    }
    if (points.length < o.flights) {
      // Every aircraft has to have a position or the cut is being placed from
      // a partial picture, which is worse than not cutting.
      blocked.push({
        ...o,
        reason: "positions are known for only " + points.length + " of its aircraft",
      });
      continue;
    }

    const neighbours = [...(adjacency.get(o.sector) ?? [])]
      .filter((n) => standalone.has(n))
      .map((n) => ({ sector: n, flights: load(n) + (received.get(n) ?? 0) }))
      .sort((a, b) => a.flights - b.flights || a.sector.localeCompare(b.sector));

    if (neighbours.length === 0) {
      blocked.push({ ...o, reason: "no adjacent sector is worked on its own" });
      continue;
    }

    const reasons: string[] = [];
    let done = false;
    for (const n of neighbours) {
      const toRings = area.shapes.get(n.sector);
      if (!toRings || toRings.length === 0) {
        reasons.push(n.sector + ": no published outline");
        continue;
      }
      const result = planAreaTransfer({
        from: { sector: o.sector, rings: fromRings, flights: points },
        to: { sector: n.sector, rings: toRings, flightCount: n.flights },
        splitAbove: config.splitAbove,
        blockers,
        maxCedeNm: config.maxCedeNm,
      });
      if (result.ok) {
        transfers.push(result.transfer);
        received.set(n.sector, (received.get(n.sector) ?? 0) + result.transfer.flights.length);
        done = true;
        break;
      }
      reasons.push(n.sector + ": " + result.reason);
    }
    if (!done) blocked.push({ ...o, reason: reasons.join("; ") });
  }

  return { overloaded, transfers, blocked };
}

/**
 * Plan the whole run: one grouping per hour, the boundary changes the busy
 * hours need, and the periods each configuration held for.
 *
 * `rows` is the sector-hour table for the WHOLE run; rows of other layers are
 * ignored rather than rejected, so the caller can hand over the table it
 * already has.
 *
 * `area` is optional. Without it the plan still merges quiet sectors — it
 * simply reports that an overloaded sector could not be re-cut, rather than
 * pretending none was overloaded.
 */
export function planDynamicSectors(
  rows: SectorHourRow[],
  adjacency: SectorAdjacency,
  config: DynamicSectorConfig = DEFAULT_DYNAMIC_CONFIG,
  area?: AreaContext,
): DynamicPlan {
  const baseline = sectorsOf(adjacency);
  const mine = rows.filter((r) => r.layer === config.layer);
  const hoursUtc = [...new Set(mine.map((r) => r.hourUtc))].sort();

  const byHour = new Map<string, Map<string, SectorHourRow>>();
  for (const r of mine) {
    const m = byHour.get(r.hourUtc) ?? new Map<string, SectorHourRow>();
    m.set(r.sector, r);
    byHour.set(r.hourUtc, m);
  }

  const hours: DynamicHour[] = [];
  let previouslyMerged = new Set<string>();
  let heldSince = 0;
  let held: DynamicPosition[] | null = null;

  hoursUtc.forEach((hourUtc, i) => {
    const forHour = byHour.get(hourUtc) ?? new Map();
    const override =
      config.mode === "manual" ? config.overrides?.[hourUtc] : undefined;
    const decision: HourDecision =
      override ?? (config.mode === "auto" ? "auto" : "keep");
    const mayMerge = decision === "auto" || decision === "merge";
    const maySplit = decision === "auto" || decision === "split";

    // "Keep" and "split" both leave the published sectors as they are: one
    // position each. Only the band-box pass groups them.
    const planned = mayMerge
      ? planHour(hourUtc, forHour, adjacency, config)
      : planHour(hourUtc, forHour, adjacency, {
          ...config,
          mergeBelow: 0, // nothing can be under zero, so nothing merges
        });

    // Coordination: a configuration has to stand for `minHoldHours` before it
    // is changed again. Only CONSOLIDATING changes are damped — a merge can
    // wait, whereas leaving an overloaded sector band-boxed to keep a tidy
    // schedule is the one thing this must never do.
    let positions = planned.positions;
    const merging = positions.some((p) => p.merged);
    const sameAsHeld =
      held !== null &&
      held.map((p) => p.label).join("|") === positions.map((p) => p.label).join("|");
    if (held && !sameAsHeld && merging && i - heldSince < config.minHoldHours) {
      positions = held;
    } else if (!sameAsHeld) {
      held = positions;
      heldSince = i;
    }

    const overload = planOverloads(
      hourUtc,
      forHour,
      positions,
      adjacency,
      config,
      area,
      maySplit,
    );

    const mergedNow = new Set<string>();
    for (const p of positions) {
      if (p.merged) for (const s of p.sectors) mergedNow.add(s);
    }
    const splitBack = [...previouslyMerged].filter((s) => !mergedNow.has(s)).sort();
    const anyMerge = positions.some((p) => p.merged);
    const anySplit = overload.transfers.length > 0;
    hours.push({
      ...planned,
      positions,
      positionsOpen: positions.length,
      splitBack,
      ...overload,
      change:
        anyMerge && anySplit
          ? "merge+split"
          : anyMerge
            ? "merge"
            : anySplit
              ? "split"
              : "none",
      decision,
      manual: override !== undefined,
    });
    previouslyMerged = mergedNow;
  });

  return {
    config,
    appliedAt: null,
    hours,
    spans: buildSpans(hours),
    transitions: buildTransitions(hours, config),
    baseline,
  };
}

/** The same plan, accepted. A copy: the recommendation it was made from stays
 *  intact, so "what did the system suggest" and "what did the operator take"
 *  can still be told apart afterwards. */
export function applyPlan(plan: DynamicPlan, atMs = Date.now()): DynamicPlan {
  return { ...plan, appliedAt: new Date(atMs).toISOString().slice(0, 19) + "Z" };
}

/** Back off `min` minutes from an hour, as an ISO stamp. */
function minus(hourUtc: string, min: number): string {
  const ms = Date.parse(hourUtc);
  return Number.isFinite(ms)
    ? new Date(ms - min * 60000).toISOString().slice(0, 16) + "Z"
    : hourUtc;
}

/**
 * The moments the configuration changes, and when each has to be published.
 *
 * A change is only listed where the configuration actually differs from the
 * hour before, so a band-box that holds all night is one transition rather than
 * eight. `notifyBy` is the hour less the lead time: the point by which the
 * change has to be briefed and the radar labels re-drawn, which is a real
 * constraint on whether it can be made at all.
 */
function buildTransitions(
  hours: DynamicHour[],
  config: DynamicSectorConfig,
): DynamicTransition[] {
  const out: DynamicTransition[] = [];
  let prevPositions = "";
  let prevTransfers = "";
  hours.forEach((h, i) => {
    const positions = h.positions.map((p) => p.label).join(" · ");
    const transfers = h.transfers.map((t) => t.from + "->" + t.to).join(" · ");
    if (i > 0 && positions !== prevPositions) {
      const merged = h.positions.filter((p) => p.merged).map((p) => p.label);
      out.push({
        hourUtc: h.hourUtc,
        notifyBy: minus(h.hourUtc, config.leadTimeMin),
        kind: merged.length > 0 ? "merge" : "revert",
        detail:
          merged.length > 0
            ? "band-box " + merged.join(", ")
            : "split back to " + h.positions.length + " separate positions",
      });
    }
    if (transfers !== prevTransfers && transfers !== "") {
      out.push({
        hourUtc: h.hourUtc,
        notifyBy: minus(h.hourUtc, config.leadTimeMin),
        kind: "split",
        detail: h.transfers
          .map(
            (t) =>
              t.from +
              " cedes its " +
              t.quadrant +
              " airspace (" +
              t.flights.length +
              " aircraft, " +
              t.areaNm2 +
              " NM²) to " +
              t.to,
          )
          .join("; "),
      });
    } else if (transfers === "" && prevTransfers !== "") {
      out.push({
        hourUtc: h.hourUtc,
        notifyBy: minus(h.hourUtc, config.leadTimeMin),
        kind: "revert",
        detail: "restore the published boundaries",
      });
    }
    prevPositions = positions;
    prevTransfers = transfers;
  });
  return out;
}

/** Collapse the per-hour groupings into the periods each band-box held for. */
function buildSpans(hours: DynamicHour[]): DynamicSpan[] {
  const spans: DynamicSpan[] = [];
  const open = new Map<string, { span: DynamicSpan; index: number }>();

  const close = (
    key: string,
    entry: { span: DynamicSpan; index: number },
    toHourUtc: string,
    endedBy: DynamicSpan["endedBy"],
  ) => {
    entry.span.toHourUtc = toHourUtc;
    entry.span.endedBy = endedBy;
    spans.push(entry.span);
    open.delete(key);
  };

  hours.forEach((h, i) => {
    const merged = new Map(h.positions.filter((p) => p.merged).map((p) => [p.label, p]));
    // Band-boxes that did not survive into this hour.
    for (const [key, entry] of [...open]) {
      if (merged.has(key)) continue;
      // Split because the traffic rose, or re-grouped with a different
      // neighbour? Both end the span, and they are not the same event.
      const sectors = new Set(entry.span.sectors);
      const stillMergedElsewhere = h.positions.some(
        (p) => p.merged && p.sectors.some((s) => sectors.has(s)),
      );
      close(key, entry, h.hourUtc, stillMergedElsewhere ? "regrouped" : "traffic");
    }
    for (const [key, pos] of merged) {
      const entry = open.get(key);
      if (entry) {
        entry.span.hours = i - entry.index + 1;
        entry.span.peakFlights = Math.max(entry.span.peakFlights, pos.flights);
      } else {
        open.set(key, {
          index: i,
          span: {
            label: pos.label,
            sectors: [...pos.sectors],
            fromHourUtc: h.hourUtc,
            toHourUtc: h.hourUtc,
            hours: 1,
            peakFlights: pos.flights,
            endedBy: "end-of-run",
          },
        });
      }
    }
  });

  // Whatever is still band-boxed when the sample stops was not split back — the
  // run ended, which is a different statement from "the traffic stayed low".
  const last = hours.at(-1);
  for (const [key, entry] of [...open]) {
    close(key, entry, last ? nextHour(last.hourUtc) : entry.span.toHourUtc, "end-of-run");
  }

  return spans.sort(
    (a, b) => a.fromHourUtc.localeCompare(b.fromHourUtc) || a.label.localeCompare(b.label),
  );
}

function nextHour(hourUtc: string): string {
  const ms = Date.parse(hourUtc);
  return Number.isFinite(ms)
    ? new Date(ms + 3600000).toISOString().slice(0, 13) + ":00Z"
    : hourUtc;
}

// --- is there time to brief it? ---------------------------------------------

/** A change the lead time leaves no room to brief. */
export interface LeadTimeIssue {
  hourUtc: string;
  notifyBy: string;
  reason: string;
}

/**
 * Changes the lead time makes impossible to issue in time.
 *
 * Lead time is not decoration on the report: it decides whether a
 * recommendation can be acted on at all. Two ways it fails, both arithmetic
 * rather than judgement:
 *
 *   1. **Changes too close together.** A change at 0200 with 90 minutes of
 *      lead has to be briefed at 0030 — before the 0100 change it follows has
 *      even taken effect. The second decision would have to be issued while the
 *      first was still being read out.
 *   2. **Briefed before the sample starts.** The first change needs its notice
 *      earlier than the run's own first hour, so there was never a moment at
 *      which it could have been decided.
 *
 * Anything else is a judgement call about whether a unit can turn a decision
 * around, which is not this tool's to make — so it says nothing.
 */
export function leadTimeIssues(plan: DynamicPlan): LeadTimeIssue[] {
  const out: LeadTimeIssue[] = [];
  const lead = plan.config.leadTimeMin;
  if (lead <= 0) return out;
  const firstHour = plan.hours[0]?.hourUtc;
  const firstMs = firstHour ? Date.parse(firstHour) : NaN;

  plan.transitions.forEach((t, i) => {
    const effective = Date.parse(t.hourUtc);
    const notify = Date.parse(t.notifyBy);
    if (!Number.isFinite(effective) || !Number.isFinite(notify)) return;

    // The previous change at a DIFFERENT hour. One configuration change can
     // produce several transition lines in the same hour — positions and
     // boundaries are listed separately — and those are one brief, not a queue
     // of briefs racing each other.
     const prev = plan.transitions
       .slice(0, i)
       .reverse()
       .find((x) => x.hourUtc !== t.hourUtc);
    if (prev) {
      const prevEffective = Date.parse(prev.hourUtc);
      if (Number.isFinite(prevEffective) && notify <= prevEffective) {
        const gap = Math.round((effective - prevEffective) / 60000);
        out.push({
          hourUtc: t.hourUtc,
          notifyBy: t.notifyBy,
          reason:
            "it would have to be briefed at " +
            t.notifyBy.slice(11, 16) +
            "Z, at or before the " +
            prev.hourUtc.slice(11, 16) +
            "Z change it follows — the two are " +
            gap +
            " min apart and the lead time is " +
            lead +
            " min",
        });
        return;
      }
    }
    // The plan's first hour is the configuration the run STARTS in, not a
    // change away from something earlier, so there is nothing to brief against
    // and no notice it could have failed to give.
    if (Number.isFinite(firstMs) && notify < firstMs && t.hourUtc !== firstHour) {
      out.push({
        hourUtc: t.hourUtc,
        notifyBy: t.notifyBy,
        reason:
          "it would have to be briefed at " +
          t.notifyBy.slice(11, 16) +
          "Z, before the sample itself begins at " +
          (firstHour ?? "").slice(11, 16) +
          "Z",
      });
    }
  });
  return out;
}

// --- the log ----------------------------------------------------------------

/**
 * One line of the configuration log: a thing the plan says to do, in one hour.
 *
 * `transitions` answers "when does something change"; this answers "what was in
 * force, and where". They are different questions — a band-box that holds from
 * 0200 to 0600 is one transition and four hours of configuration — and a
 * capacity study reads both.
 */
export interface DynamicLogEntry {
  hourUtc: string;
  /** Position within the hour, so the log has a stable order. */
  seq: number;
  kind: "merge" | "split" | "overload" | "keep";
  /** "North+East", "North → East", or the sector on its own. */
  label: string;
  detail: string;
  /** Sectors this line is about — what the map should show. */
  sectors: string[];
  /** The boundary change, when there is one to draw. */
  transfer: AreaTransfer | null;
  decidedBy: "auto" | "operator";
}

/**
 * Every configuration action over the run, hour by hour.
 *
 * Hours where nothing changed get a line too. A log that only recorded the
 * exceptions would read as though the airspace spent the quiet hours
 * unaccounted for, when in fact it was deliberately left as published.
 */
export function dynamicLog(plan: DynamicPlan): DynamicLogEntry[] {
  const out: DynamicLogEntry[] = [];
  for (const h of plan.hours) {
    const decidedBy = h.manual ? "operator" : "auto";
    let seq = 0;
    for (const p of h.positions) {
      if (!p.merged) continue;
      out.push({
        hourUtc: h.hourUtc,
        seq: seq++,
        kind: "merge",
        label: p.label,
        detail: describePosition(p),
        sectors: [...p.sectors],
        transfer: null,
        decidedBy,
      });
    }
    for (const t of h.transfers) {
      out.push({
        hourUtc: h.hourUtc,
        seq: seq++,
        kind: "split",
        label: t.from + " \u2192 " + t.to,
        detail:
          t.from +
          " cedes its " +
          t.quadrant +
          " airspace to " +
          t.to +
          " — " +
          t.flights.length +
          " aircraft, " +
          t.areaNm2 +
          " NM². " +
          t.from +
          " then holds " +
          t.fromAfter +
          ", " +
          t.to +
          " holds " +
          t.toAfter +
          ".",
        sectors: [t.from, t.to],
        transfer: t,
        decidedBy,
      });
    }
    for (const b of h.blocked) {
      out.push({
        hourUtc: h.hourUtc,
        seq: seq++,
        kind: "overload",
        label: b.sector,
        detail: b.sector + " holds " + b.flights + " — " + b.reason + ".",
        sectors: [b.sector],
        transfer: null,
        decidedBy,
      });
    }
    if (seq === 0) {
      out.push({
        hourUtc: h.hourUtc,
        seq: 0,
        kind: "keep",
        label: "Published",
        detail:
          h.decision === "keep"
            ? "Set to keep the published configuration: " +
              h.positionsOpen +
              " sectors worked separately."
            : "Traffic within the normal band — the published configuration stands.",
        sectors: [],
        transfer: null,
        decidedBy,
      });
    }
  }
  return out;
}

/** The log as a table, for the workbook. */
export function dynamicLogTable(plan: DynamicPlan): (string | number)[][] {
  return [
    ["hour_utc", "hour", "action", "what", "sectors", "detail", "decided_by"],
    ...dynamicLog(plan).map((e) => [
      e.hourUtc,
      hourRangeLabel(e.hourUtc),
      e.kind.toUpperCase(),
      e.label,
      e.sectors.join(" "),
      e.detail,
      e.decidedBy,
    ]),
  ];
}

export function dynamicLogCsv(plan: DynamicPlan): string {
  const [head, ...body] = dynamicLogTable(plan);
  return csv(head as string[], body);
}

// --- saying it in words -----------------------------------------------------

/** "North: 2 flights + South: 3 flights → merged as North+South" — the merge,
 *  in the form a watch supervisor would write it. */
export function describePosition(p: DynamicPosition): string {
  const parts = p.members.map((m) => m.sector + ": " + m.flights + " flight" + (m.flights === 1 ? "" : "s"));
  if (!p.merged) return parts[0] + " → worked on its own";
  return parts.join(" + ") + " → merged as " + p.label + " (" + p.flights + " total)";
}

/** "0000-0100 UTC" for one hour bucket. */
export function hourRangeLabel(hourUtc: string): string {
  const start = Date.parse(hourUtc);
  if (!Number.isFinite(start)) return hourUtc;
  const hh = (ms: number) => new Date(ms).toISOString().slice(11, 16).replace(":", "");
  return hh(start) + "-" + hh(start + 3600000) + " UTC";
}

/** "07 Sep 0000-0300 UTC (3 h)" for a whole band-box period. */
export function spanLabel(s: DynamicSpan): string {
  const day = new Date(Date.parse(s.fromHourUtc)).toUTCString().slice(5, 11);
  const hhmm = (t: string) => new Date(Date.parse(t)).toISOString().slice(11, 16).replace(":", "");
  return (
    day +
    " " +
    hhmm(s.fromHourUtc) +
    "-" +
    hhmm(s.toHourUtc) +
    " UTC (" +
    s.hours +
    " h)"
  );
}

// --- CSV --------------------------------------------------------------------

function csvField(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csv(header: string[], rows: (string | number)[][]): string {
  return (
    "﻿" +
    [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") +
    "\r\n"
  );
}

/**
 * The plan as a flat table: one row per published sector per hour.
 *
 * Every row names the sector it is about AND the position it was worked from,
 * so the file can be read either way round — "what happened to North all day", or
 * "what did the North+South position hold at 0300". `basis` repeats on every row that
 * this is an operational grouping over an unchanged sector map, because a
 * column called `position` is otherwise one screenshot away from being read as
 * a new airspace design.
 */
export function dynamicSectorsTable(plan: DynamicPlan): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const h of plan.hours) {
    const splitBack = new Set(h.splitBack);
    const over = new Set(h.overloaded.map((o) => o.sector));
    const blocked = new Map(h.blocked.map((b) => [b.sector, b.reason]));
    const ceded = new Map(h.transfers.map((t) => [t.from, t]));
    const gained = new Map(h.transfers.map((t) => [t.to, t]));
    for (const p of h.positions) {
      for (const m of p.members) {
        const out = ceded.get(m.sector);
        const inn = gained.get(m.sector);
        rows.push([
          h.hourUtc,
          hourRangeLabel(h.hourUtc),
          h.layer,
          m.sector,
          m.flights,
          p.label,
          p.sectors.length,
          p.flights,
          p.merged ? "MERGED" : splitBack.has(m.sector) ? "SPLIT_BACK" : "STANDALONE",
          over.has(m.sector) ? "YES" : "no",
          out
            ? "CEDED " + out.quadrant + " to " + out.to
            : inn
              ? "RECEIVED from " + inn.from
              : "",
          out ? out.flights.length : inn ? inn.flights.length : 0,
          out ? out.areaNm2 : "",
          blocked.get(m.sector) ?? "",
          h.decision,
          h.manual ? "operator" : plan.config.mode,
          plan.appliedAt ? "APPLIED" : "PROPOSED",
          plan.appliedAt ?? "",
          plan.config.mergeBelow,
          plan.config.splitAbove,
          h.baselineSectors,
          h.positionsOpen,
          h.baselineSectors - h.positionsOpen,
          h.change,
          "dynamic operational configuration - published sectors unchanged",
        ]);
      }
    }
  }
  return [DYNAMIC_HEADER, ...rows];
}

/**
 * The boundary changes on their own: which sector cedes what, to whom, when.
 *
 * `notify_by` is the point the change has to be published rather than the point
 * it takes effect — the earlier of the two is the one that constrains whether
 * it can be made at all.
 */
export function dynamicTransfersTable(plan: DynamicPlan): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const h of plan.hours) {
    for (const t of h.transfers) {
      rows.push([
        h.hourUtc,
        hourRangeLabel(h.hourUtc),
        t.from,
        t.to,
        t.quadrant,
        t.bearingDeg,
        t.flights.length,
        t.flights.join(" "),
        t.areaNm2,
        t.fromAfter,
        t.toAfter,
        plan.config.splitAbove,
      ]);
    }
    // An overload nobody could relieve is part of the answer, not a gap in it.
    for (const b of h.blocked) {
      rows.push([
        h.hourUtc,
        hourRangeLabel(h.hourUtc),
        b.sector,
        "(none)",
        "",
        "",
        0,
        "",
        0,
        b.flights,
        "",
        plan.config.splitAbove,
      ]);
    }
  }
  return [
    [
      "hour_utc",
      "hour",
      "from_sector",
      "to_sector",
      "ceded_side",
      "bearing_deg",
      "aircraft_moved",
      "aircraft",
      "area_nm2",
      "from_after",
      "to_after",
      "split_above",
    ],
    ...rows,
  ];
}

/** When the configuration should change, and by when it has to be briefed. */
export function dynamicTransitionsTable(plan: DynamicPlan): (string | number)[][] {
  return [
    ["hour_utc", "hour", "notify_by_utc", "kind", "detail", "lead_time_min"],
    ...plan.transitions.map((t) => [
      t.hourUtc,
      hourRangeLabel(t.hourUtc),
      t.notifyBy,
      t.kind,
      t.detail,
      plan.config.leadTimeMin,
    ]),
  ];
}

export function dynamicTransfersCsv(plan: DynamicPlan): string {
  const [head, ...body] = dynamicTransfersTable(plan);
  return csv(head as string[], body);
}

export function dynamicTransitionsCsv(plan: DynamicPlan): string {
  const [head, ...body] = dynamicTransitionsTable(plan);
  return csv(head as string[], body);
}

const DYNAMIC_HEADER = [
  "hour_utc",
  "hour",
  "layer",
  "sector",
  "sector_flights",
  "position",
  "position_sectors",
  "position_flights",
  "status",
  "overloaded",
  "boundary_change",
  "aircraft_moved",
  "area_moved_nm2",
  "not_changed_because",
  "decision",
  "decided_by",
  "plan_status",
  "applied_at_utc",
  "merge_below",
  "split_above",
  "baseline_sectors",
  "positions_open",
  "positions_saved",
  "hour_change",
  "basis",
];

export function dynamicSectorsCsv(plan: DynamicPlan): string {
  const [head, ...body] = dynamicSectorsTable(plan);
  return csv(head as string[], body);
}

/** The band-box periods on their own — the "when was this in force" table.
 *  Split out from the .csv so the report tab can put the same rows on screen;
 *  a table someone reads and a table someone downloads being built twice is
 *  how the two come to disagree. */
export function dynamicSpansTable(plan: DynamicPlan): (string | number)[][] {
  return [
    [
      "position",
      "sectors",
      "from_hour_utc",
      "to_hour_utc",
      "hours",
      "peak_flights",
      "merge_below",
      "ended_by",
    ],
    ...plan.spans.map((s) => [
      s.label,
      s.sectors.join(" "),
      s.fromHourUtc,
      s.toHourUtc,
      s.hours,
      s.peakFlights,
      plan.config.mergeBelow,
      s.endedBy,
    ]),
  ];
}

export function dynamicSpansCsv(plan: DynamicPlan): string {
  const [head, ...body] = dynamicSpansTable(plan);
  return csv(head as string[], body);
}
