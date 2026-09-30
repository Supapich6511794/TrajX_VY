/**
 * Plan-aware resolution advisory.
 *
 * Unlike the live advisory (advisory.ts), which reasons over a short constant-
 * velocity look-ahead, this engine works for ANY conflict in the filed plan —
 * including ones far in the future — by actually building the maneuvered
 * trajectory (with route recovery), re-checking it in 3-D against EVERY other
 * flight over the whole plan, and running the constraint engine. Only candidates
 * that genuinely clear and pass hard constraints survive; they're ranked by a
 * weighted cost and returned with a plain-language reason and a 0–100 score, so
 * the controller sees "Turn right 20° · 94 · clears to 6.3 NM, back on route in
 * 4 min" instead of having to hand-tune sliders.
 *
 * Heavier than the live advisory (it re-times trajectories and scans the plan),
 * so it's meant to run on demand — when a conflict is opened — not per frame.
 */

import type { TrajectoryResult } from "@/lib/trajectory/types";
import {
  aircraftAt,
  toSamples,
  totalSeconds,
  type AircraftState,
} from "@/lib/useSimPlayback";

import { respectsSemicircular } from "./advisory";
import {
  horizontalMinimumNm,
  verticalMinimumFt,
  type CdrConfig,
  type ManeuverType,
} from "./config";
import {
  areaIdentsOnPath,
  evaluateConstraints,
  type PathPoint,
  type RestrictedArea,
} from "./constraints";
import { headingDeltaDeg } from "./geo";
import {
  applyManeuver,
  recoveryTiming,
  type ManeuverTiming,
} from "./kinematics";
import {
  pairConflict,
  pairSeparation,
  type PlanConflict,
  type PlanFlight,
} from "./planScan";
import type { ManeuverResolution } from "./types";
import {
  holdLegSec,
  holdLoopSec,
  type Holding,
} from "@/lib/holdings";

interface Sample extends AircraftState {
  t: number;
}

/** A ranked, plan-validated resolution with rationale + score. */
export interface PlanResolution {
  type: ManeuverType;
  target: string; // flightKey
  targetCallsign: string;
  instruction: string;
  resolution: ManeuverResolution;
  value: number;
  /** Horizontal CPA to the conflict partner: before → after (NM). */
  origDCpaNm: number;
  newDCpaNm: number;
  /** Vertical separation at CPA to the partner: before → after (ft). */
  origVertFt: number;
  newVertFt: number;
  extraDistanceNm: number;
  extraTimeSec: number;
  altChangeFt: number;
  trackDeviationDeg: number;
  cost: number;
  /** 0–100, higher = better (relative to the best candidate). */
  score: number;
  reason: string;
  constraintVerdict: "accept" | "caution" | "reject";
  /** Set when the candidate only turned up in the WIDE fallback envelope, i.e.
   *  it is a bigger-than-usual maneuver. Undefined on a normal resolution. */
  widened?: boolean;
  /** The EXACT maneuver timing this candidate was validated with (local time to
   *  start the turn + how long to deviate + rejoin). The UI must apply the
   *  maneuver with this timing — recomputing it from the current track would
   *  produce a different, unvalidated maneuver. */
  tManLocal: number;
  deviationSec: number;
  rejoinSec: number;
}

export interface PlanAdvisoryArgs {
  conflict: PlanConflict;
  /** Every flight (index-aligned tables for the re-check). */
  flights: PlanFlight[];
  /** flightKey → its trajectory + EOBT offset, for building maneuvers. */
  trajById: Map<string, { traj: TrajectoryResult; offset: number }>;
  simT: number;
  cfg: CdrConfig;
  restricted: RestrictedArea[];
  /** Published holdings by fix ident — enables the HOLD resolution (fly one
   *  racetrack loop at a holding fix on the route ahead to delay + open
   *  spacing). Omitted → hold isn't offered. */
  holdings?: Map<string, Holding>;
  topN?: number;
}

/** The set of maneuvers the search will try. */
interface Envelope {
  flDeltas: number[];
  speedDeltas: number[];
  headingSteps: number[];
}

// Gentlest first in each list: the per-(target,type) dedup keeps the FIRST
// clearing value, so we prefer the smallest change that works. Larger speed cuts
// (−40/−50) cover overtakes where the rear jet is much faster (a −30 leaves it
// catching up).
const NORMAL_ENVELOPE: Envelope = {
  flDeltas: [1000, -1000, 2000, -2000],
  speedDeltas: [-10, -20, -30, -40, -50, 10, 20, 30, 40],
  headingSteps: [10, 15, 20, 25, 30, 35, 40],
};

// Fallback envelope, tried ONLY when the normal one comes back empty. A conflict
// is often unsolvable at ±2000 ft / 40° not because the pair can't be separated
// but because every gentle candidate then clips a THIRD aircraft; a bigger
// maneuver can straddle both. Bigger changes are also more disruptive, so they
// stay out of the way until the gentle search has failed.
const WIDE_ENVELOPE: Envelope = {
  flDeltas: [...NORMAL_ENVELOPE.flDeltas, 3000, -3000, 4000, -4000],
  speedDeltas: [...NORMAL_ENVELOPE.speedDeltas, -60, -70, 50, 60],
  headingSteps: [...NORMAL_ENVELOPE.headingSteps, 45, 50, 60, 70, 80],
};

function flightFrom(id: string, traj: TrajectoryResult, offset: number): PlanFlight {
  return {
    id,
    callsign: traj.meta.callsign,
    samples: toSamples(traj.points),
    offsetSec: offset,
    durationSec: totalSeconds(traj.points),
  };
}

/** Downstream route fixes roughly ahead of the aircraft (for direct-to). */
function fixesAhead(
  traj: TrajectoryResult,
  now: AircraftState,
  limit = 3,
): { ident: string; lat: number; lon: number }[] {
  const out: { ident: string; lat: number; lon: number }[] = [];
  for (const w of traj.route) {
    const dLon = (w.lon - now.lon) * Math.cos((now.lat * Math.PI) / 180);
    const dLat = w.lat - now.lat;
    const distNm = Math.hypot(dLat, dLon) * 60;
    if (distNm < 8) continue; // basically overhead
    const brg = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
    if (Math.abs(headingDeltaDeg(now.track, brg)) <= 90) {
      out.push({ ident: w.ident, lat: w.lat, lon: w.lon });
      if (out.length >= limit) break;
    }
  }
  return out;
}

const norm360 = (d: number) => ((d % 360) + 360) % 360;

/** Max track difference (deg) for a conflict to count as an in-trail OVERTAKE. */
const OVERTAKE_MAX_TRACK_DIFF_DEG = 25;

/** Tail of the flight (s) in which a LATERAL maneuver is not offered.
 *
 *  A heading or direct-to has to be flown AND rejoined; vectoring the aircraft
 *  off track inside the arrival leaves no route left to intercept, so the rejoin
 *  degenerates into a straight run at the field and the resolved path cuts
 *  across the runway instead of flying the approach. Ten minutes covers the
 *  STAR terminus and the approach. Speed and level fixes are unaffected — they
 *  keep the aircraft on its route, which is what ATC uses on final anyway. */
const APPROACH_PROTECT_SEC = 600;

/** Traffic that stopped candidates from being offered: how many it blocked and
 *  how close the blocked maneuver would have come to it. */
export interface Blocker {
  /** The blocker's flight key. Naming the aircraft is only half an answer —
   *  the panel has to be able to OPEN it, and a callsign is not a handle. */
  id: string;
  callsign: string;
  /** Candidates this aircraft rejected. */
  count: number;
  /** Closest the tightest blocked candidate would have passed it (NM). */
  tightestNm: number;
}

/** Why one candidate did not make it into `resolutions`. Distinct from
 *  `Blocker`, which is an aggregate ("SHADOW blocked 4 candidates"): this is
 *  the per-candidate audit trail — which maneuver was tried, and the specific
 *  reason it failed — so a rejection can be explained rather than just
 *  counted. See `evaluateConstraints`'s own doc comment for why "the pair
 *  stays in conflict" and "a third aircraft would newly conflict" are kept as
 *  two distinct reasons rather than both called "secondary conflict". */
export type RejectionReason =
  /** A lateral fix (heading/route) this close to the arrival would leave no
   *  route left to rejoin — not tried against traffic at all. */
  | "arrival-protected"
  /** Still conflicts with the ORIGINAL partner — this maneuver did not do
   *  the job it was proposed for. Not a secondary/cascading conflict. */
  | "unresolved-primary"
  /** Clears the original pair but would newly lose separation with a THIRD
   *  aircraft WHILE the maneuver is being flown — a true secondary conflict
   *  per §5 of the resolution spec. */
  | "secondary-conflict"
  /** Same, but the new loss of separation comes only AFTER the maneuver —
   *  on the way back to the flight plan (the rejoin leg, or the re-timed
   *  remainder of the route). The "third conflict" of ATC practice: the
   *  deviation itself was clean, returning to the plan is what hits someone. */
  | "rejoin-conflict"
  /** Cleared every aircraft (pair + third parties) but failed a hard
   *  constraint — airspace, level band, speed/altitude envelope, etc. */
  | "constraint-reject";

export interface RejectedCandidate {
  type: ManeuverType;
  target: string; // flightKey
  targetCallsign: string;
  /** Same shape as `PlanResolution.instruction` — "Turn right 20°" etc. */
  instruction: string;
  reason: RejectionReason;
  detail: string;
  /** Set for "unresolved-primary" / "secondary-conflict" / "rejoin-conflict":
   *  who it's still or newly in conflict with. */
  conflictWith?: { id: string; callsign: string; dCpaNm: number };
}

export interface PlanAdvisoryResult {
  resolutions: PlanResolution[];
  /** Who blocked the rejected candidates, worst offender first. Populated even
   *  when `resolutions` is non-empty (some candidates always get blocked), but
   *  it's only worth SHOWING when the list came back empty. */
  blockers: Blocker[];
  /** Every candidate that was tried and did NOT survive, with why — the full
   *  audit trail `blockers` only aggregates. From whichever envelope pass
   *  produced the final `resolutions` (the normal one, or the wide fallback
   *  when that came back empty), matching how `blockers` is scoped. */
  rejected: RejectedCandidate[];
  /** True when nothing cleared inside the normal envelope and the results came
   *  from the wider fallback search — the maneuvers are bigger than usual. */
  widened: boolean;
  /** Two-step fixes, found only when no single maneuver clears: move the
   *  aircraft that blocked a candidate FIRST, then that candidate clears.
   *  Empty whenever `resolutions` came from the tactical search. */
  chained: ChainedResolution[];
  /** True when `resolutions` are ATFM ground delays — nothing airborne, single
   *  or chained, cleared the conflict, so the fix is to hold a departure. */
  atfm: boolean;
}

/** "Resolve the blocker first": a candidate for the conflict that failed on
 *  exactly ONE third aircraft, paired with a maneuver that moves that third
 *  aircraft out of its way. Validated together — `blockerFix` against all
 *  traffic with `fix` already flown — so applying both leaves no conflict
 *  among the three, nor with anyone else. */
export interface ChainedResolution {
  /** Apply first: moves the third aircraft. */
  blockerFix: PlanResolution;
  /** Apply second: resolves the original conflict. */
  fix: PlanResolution;
  cost: number;
  /** 0–100, relative to the cheapest chain. */
  score: number;
}

/** A candidate that separated the pair and would have been offered, but for a
 *  single third aircraft — the raw material for a `ChainedResolution`. */
interface NearMiss {
  resolution: PlanResolution;
  /** The maneuvered flight the blocker has to be moved clear of. */
  flight: PlanFlight;
  traj: TrajectoryResult;
  offset: number;
  blockerId: string;
  /** The maneuvered flight vs the blocker — what the blocker's fix must solve. */
  conflict: PlanConflict;
}

/** Gated behind `console.debug` (hidden under the default/"Info" console
 *  filter in Chromium and most browsers) so the trace is available for
 *  troubleshooting a specific resolution without spamming normal use. Two
 *  entry points rather than one union-typed one — accept/reject carry
 *  different data, and a shared type guard on that data is easier to get
 *  wrong than just calling the right function at the call site.
 *
 *  Off by default: `searchEnvelope` tries dozens of candidates per conflict
 *  (every heading/speed/level/route/hold option in the envelope), so with
 *  this always on, opening one conflict in a busy plan floods the console —
 *  `console.debug` being hidden under Chromium's default "Info" filter isn't
 *  enough on its own (Node/CI/test runners show every level). Turn it on
 *  with `setDebugLogging(true)` when actually troubleshooting one
 *  resolution. */
export let debugLogging = false;
export function setDebugLogging(on: boolean): void {
  debugLogging = on;
}

function logAccepted(conflict: PlanConflict, r: PlanResolution): void {
  if (!debugLogging) return;
  console.debug(
    `[ConflictResolution] Primary: ${conflict.aCallsign}-${conflict.bCallsign}\n` +
      `[Candidate] ${r.targetCallsign} ${r.instruction}\n` +
      `[ForwardSimulation] Primary conflict: RESOLVED (${r.origDCpaNm.toFixed(1)} -> ${r.newDCpaNm.toFixed(1)} NM)\n` +
      `[Candidate] VALID · cost ${r.cost.toFixed(1)}`,
  );
}
const CHECK_TAG: Record<RejectionReason, string> = {
  "secondary-conflict": "SecondaryCheck",
  "rejoin-conflict": "RejoinCheck",
  "unresolved-primary": "ForwardSimulation",
  "constraint-reject": "ForwardSimulation",
  "arrival-protected": "ForwardSimulation",
};
function logRejected(conflict: PlanConflict, r: RejectedCandidate): void {
  if (!debugLogging) return;
  console.debug(
    `[ConflictResolution] Primary: ${conflict.aCallsign}-${conflict.bCallsign}\n` +
      `[Candidate] ${r.targetCallsign} ${r.instruction}\n` +
      `[${CHECK_TAG[r.reason]}] ${r.detail}\n` +
      `[Candidate] REJECTED · ${r.reason}`,
  );
}

/** Generate ranked, validated resolutions for a conflict, plus the diagnostics
 *  behind them. Runs the gentle envelope first and only falls back to the wide
 *  one when that finds nothing, so the extra search cost is paid only on the
 *  hard conflicts.
 *
 *  When neither envelope clears, the search escalates the way a controller
 *  would: first try moving the one aircraft that blocked an otherwise-good
 *  candidate (`chained`), and only when that fails too hand the pair to flow
 *  management — a ground delay on whichever of them has not departed. */
export function planResolutions(args: PlanAdvisoryArgs): PlanAdvisoryResult {
  const blocked = new Map<string, Blocker>();
  const nearMisses: NearMiss[] = [];
  let { resolutions, rejected } = searchEnvelope(args, NORMAL_ENVELOPE, blocked, {
    nearMisses,
  });
  let widened = false;
  let chained: ChainedResolution[] = [];
  let atfm = false;
  if (resolutions.length === 0) {
    blocked.clear(); // the wide pass re-reports whoever is really in the way
    ({ resolutions, rejected } = searchEnvelope(args, WIDE_ENVELOPE, blocked, {
      nearMisses,
    }));
    widened = resolutions.length > 0;
    for (const r of resolutions) r.widened = true;
  }
  if (resolutions.length === 0) chained = resolveBlockersFirst(args, nearMisses);
  if (resolutions.length === 0 && chained.length === 0) {
    resolutions = groundDelays(args);
    atfm = resolutions.length > 0;
  }
  const blockers = [...blocked.values()].sort((a, b) => b.count - a.count);
  return { resolutions, blockers, rejected, widened, chained, atfm };
}

/** Near misses tried for a blocker-first chain, cheapest first. Each costs a
 *  full search on the blocker, and this only runs on a conflict nothing else
 *  cleared, so a handful is plenty. */
const MAX_CHAIN_TRIES = 4;
const MAX_CHAINS = 3;

/** Iterative resolution, one level deep: for each candidate that cleared the
 *  pair but hit a single third aircraft, fly the candidate and search for a
 *  maneuver on that third aircraft that clears it — checked against every
 *  flight WITH the candidate in place, so the two together are safe. */
function resolveBlockersFirst(
  args: PlanAdvisoryArgs,
  nearMisses: NearMiss[],
): ChainedResolution[] {
  const tries = [...nearMisses]
    .sort((a, b) => a.resolution.cost - b.resolution.cost)
    .slice(0, MAX_CHAIN_TRIES);
  const chains: ChainedResolution[] = [];
  for (const nm of tries) {
    const id = nm.resolution.target;
    const flights = args.flights.map((f) => (f.id === id ? nm.flight : f));
    const trajById = new Map(args.trajById);
    trajById.set(id, { traj: nm.traj, offset: nm.offset });
    const { resolutions } = searchEnvelope(
      { ...args, conflict: nm.conflict, flights, trajById, topN: 1 },
      NORMAL_ENVELOPE,
      new Map(),
      { onlyTarget: nm.blockerId },
    );
    const blockerFix = resolutions[0];
    if (!blockerFix) continue;
    chains.push({
      blockerFix,
      fix: nm.resolution,
      cost: blockerFix.cost + nm.resolution.cost,
      score: 0,
    });
  }
  chains.sort((a, b) => a.cost - b.cost);
  const seen = new Set<string>();
  const out: ChainedResolution[] = [];
  for (const c of chains) {
    const key = `${c.blockerFix.target}:${c.blockerFix.type}|${c.fix.target}:${c.fix.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= MAX_CHAINS) break;
  }
  const minCost = out.length ? out[0].cost : 0;
  for (const c of out) c.score = relativeScore(c.cost, minCost);
  return out;
}

/** Ground-delay steps (min), smallest first — the first that clears is kept. */
const DELAY_STEPS_MIN = [2, 5, 10, 15, 20, 30, 45, 60];
/** A delay has to be issued before the aircraft is off blocks; anything
 *  departing sooner than this is treated as already gone. */
const MIN_DELAY_NOTICE_SEC = 60;

/** ATFM fallback: push back the departure of whichever aircraft of the pair
 *  has not left yet, by the smallest step that leaves it clear of EVERY flight
 *  (the route is untouched, so only the timing can create a new conflict). */
function groundDelays(args: PlanAdvisoryArgs): PlanResolution[] {
  const { conflict, flights, trajById, simT, cfg, topN = 5 } = args;
  const w = cfg.weights;
  const out: PlanResolution[] = [];
  for (const [targetId, intruderId] of [
    [conflict.a, conflict.b],
    [conflict.b, conflict.a],
  ] as const) {
    const info = trajById.get(targetId);
    const flight = flights.find((f) => f.id === targetId);
    const intr = flights.find((f) => f.id === intruderId);
    if (!info || !flight || !intr) continue;
    if (info.offset - simT < MIN_DELAY_NOTICE_SEC) continue;
    const others = flights.filter((f) => f.id !== targetId);
    for (const min of DELAY_STEPS_MIN) {
      const delaySec = min * 60;
      const delayed = { ...flight, offsetSec: flight.offsetSec + delaySec };
      if (others.some((o) => pairConflict(delayed, o, cfg))) continue;
      // No shared airborne time with the partner any more = nothing to measure.
      const sep = pairSeparation(delayed, intr);
      const r: PlanResolution = {
        type: "delay",
        target: targetId,
        targetCallsign: flight.callsign,
        instruction: `Ground delay +${min} min`,
        resolution: { delaySec },
        value: delaySec,
        origDCpaNm: conflict.dCpaNm,
        newDCpaNm: sep?.minHNm ?? Infinity,
        origVertFt: conflict.vSepAtCpaFt,
        newVertFt: sep?.vSepAtCpaFt ?? conflict.vSepAtCpaFt,
        extraDistanceNm: 0,
        extraTimeSec: delaySec,
        altChangeFt: 0,
        trackDeviationDeg: 0,
        cost: w.typePenalty.delay + w.delayPerMin * min,
        score: 0,
        reason: `ATFM: no airborne maneuver clears this pair — hold ${flight.callsign} on the ground ${min} min past its EOBT.`,
        constraintVerdict: "accept",
        tManLocal: 0,
        deviationSec: 0,
        rejoinSec: 0,
      };
      out.push(r);
      logAccepted(conflict, r);
      break; // smallest clearing delay per aircraft
    }
  }
  out.sort((a, b) => a.cost - b.cost);
  const ranked = out.slice(0, topN);
  const minCost = ranked.length ? ranked[0].cost : 0;
  for (const r of ranked) r.score = relativeScore(r.cost, minCost);
  return ranked;
}

/** 0–100, anchored so the cheapest option scores 100. */
function relativeScore(cost: number, minCost: number): number {
  return Math.max(1, Math.min(100, Math.round((100 * (minCost + 1)) / (cost + 1))));
}

/** Knobs for one envelope pass. `nearMisses` collects the candidates a
 *  single third aircraft blocked (for the blocker-first chain);
 *  `onlyTarget` maneuvers just that one aircraft of the conflict — the
 *  blocker, when the chain is searching for its fix. */
interface SearchOpts {
  nearMisses?: NearMiss[];
  onlyTarget?: string;
}

/** Ranked, validated resolutions for a conflict (the diagnostics are dropped —
 *  see `planResolutions` when you need them). */
export function generatePlanResolutions(args: PlanAdvisoryArgs): PlanResolution[] {
  return planResolutions(args).resolutions;
}

function searchEnvelope(
  args: PlanAdvisoryArgs,
  env: Envelope,
  blocked: Map<string, Blocker>,
  opts: SearchOpts = {},
): { resolutions: PlanResolution[]; rejected: RejectedCandidate[] } {
  const { conflict, flights, trajById, simT, cfg, restricted, holdings, topN = 5 } = args;
  const need = horizontalMinimumNm(cfg) + cfg.buffer.horizontalNm;
  const out: PlanResolution[] = [];
  const rejected: RejectedCandidate[] = [];

  // Overtake (in-trail catch-up): the two tracks are nearly parallel, so a turn
  // or direct-to only DELAYS the merge — the faster jet rejoins and re-closes.
  // SPEED is the effective fix (slow the rear / speed the lead). Detect it here
  // and, below, make that maneuver the cheapest so it ranks #1 with the top score.
  const stateOf = (id: string) => {
    const inf = trajById.get(id);
    return inf
      ? aircraftAt(toSamples(inf.traj.points), Math.max(0, simT - inf.offset))
      : null;
  };
  const acA = stateOf(conflict.a);
  const acB = stateOf(conflict.b);
  const isOvertake =
    !!acA &&
    !!acB &&
    Math.abs(headingDeltaDeg(acA.track, acB.track)) <= OVERTAKE_MAX_TRACK_DIFF_DEG;
  const fasterId = acA && acB && acA.gsKt < acB.gsKt ? conflict.b : conflict.a;
  const slowerId = fasterId === conflict.a ? conflict.b : conflict.a;

  for (const [targetId, intruderId] of [
    [conflict.a, conflict.b],
    [conflict.b, conflict.a],
  ] as const) {
    if (opts.onlyTarget && targetId !== opts.onlyTarget) continue;
    const info = trajById.get(targetId);
    const intrFlight = flights.find((f) => f.id === intruderId);
    if (!info || !intrFlight) continue;
    const { traj, offset } = info;
    const samples: Sample[] = toSamples(traj.points);
    const nowLocal = Math.max(0, simT - offset);
    const cpaLocal = conflict.tCpaAbsSec - offset;
    const nowTiming = recoveryTiming(conflict.tCpaAbsSec, offset, simT, "flightlevel");
    const stateNow = aircraftAt(samples, nowLocal);
    if (!stateNow || stateNow.altitudeFt == null) continue;

    const curGs = stateNow.gsKt;
    const curAlt = stateNow.altitudeFt;
    const curTrkNow = stateNow.track;
    const targetCallsign = traj.meta.callsign;
    // Only the traffic a maneuvered version of this flight could actually
    // reach. Every candidate is re-scanned against this list, hundreds of times
    // per conflict, so with a whole day loaded the unfiltered list turned each
    // conflict into a second of frozen main thread.
    // Every other flight. Measured at 2 000 flights this is NOT the hot part
    // — `pairConflict` rejects a pair that cannot meet in a few comparisons
    // (see `cannotMeet` in planScan), so the sweep costs tens of microseconds.
    const others = flights.filter((f) => f.id !== targetId);
    const origDur = totalSeconds(traj.points);

    // Kinematic turn-initiation timing for a lateral maneuver of `headingChange`
    // degrees: the turn starts early enough (turn duration + offset build-up +
    // buffer) that it clears the conflict — bigger/faster turns start earlier.
    const latTimingFor = (headingChangeDeg: number): ManeuverTiming =>
      recoveryTiming(conflict.tCpaAbsSec, offset, simT, "heading", {
        gsKt: curGs,
        headingChangeDeg,
        requiredOffsetNm: need,
        bankAngleDeg: cfg.bankAngleDeg,
        bufferSec: cfg.turnSafetyBufferSec,
      });

    /** A plain label for a candidate that never reaches its call site's own
     *  (more polished) `r.instruction` — reject paths return before that line
     *  runs, so the audit trail needs its own, good-enough rendering. */
    const briefInstruction = (
      type: ManeuverType,
      value: number,
      resolution: ManeuverResolution,
    ): string => {
      switch (type) {
        case "heading":
          return `Turn ${value >= 0 ? "right" : "left"} ${Math.abs(value)}°`;
        case "flightlevel":
          return `${value > 0 ? "Climb" : "Descend"} FL${Math.round((curAlt + value) / 100)}`;
        case "speed":
          return `${value < 0 ? "Reduce" : "Increase"} ${Math.abs(value)} kt`;
        case "route":
          return `Direct ${resolution.directTo?.ident ?? "fix"}`;
        case "hold":
          return `Hold at ${resolution.hold?.ident ?? "fix"}`;
        case "delay":
          return `Ground delay +${Math.round((resolution.delaySec ?? 0) / 60)} min`;
      }
    };

    /** Build + validate one candidate; returns a PlanResolution or null.
     *  Every rejection is also recorded in `rejected` (with why) and logged —
     *  §5/§9/§14 of the resolution spec: a candidate that fails must say why,
     *  not just vanish. */
    const evaluate = (
      type: ManeuverType,
      resolution: ManeuverResolution,
      value: number,
      trackDeviationDeg: number,
      altChangeFt: number,
      timing: ManeuverTiming,
      trackDeg: number,
    ): PlanResolution | null => {
      const reject = (
        reason: RejectionReason,
        detail: string,
        conflictWith?: RejectedCandidate["conflictWith"],
      ): null => {
        const r: RejectedCandidate = {
          type,
          target: targetId,
          targetCallsign,
          instruction: briefInstruction(type, value, resolution),
          reason,
          detail,
          conflictWith,
        };
        rejected.push(r);
        logRejected(conflict, r);
        return null;
      };

      // Lateral fixes are off the table once the flight is into its arrival.
      if (
        (type === "heading" || type === "route") &&
        timing.tMan + timing.deviationSec + timing.rejoinSec >
          origDur - APPROACH_PROTECT_SEC
      ) {
        return reject(
          "arrival-protected",
          "This close to the arrival, a lateral maneuver would leave no route left to rejoin.",
        );
      }
      const modified = applyManeuver(traj, { type, resolution }, timing.tMan, {
        deviationSec: timing.deviationSec,
        rejoinSec: timing.rejoinSec,
        bankAngleDeg: cfg.bankAngleDeg,
      });
      const afterFlight = flightFrom(targetId, modified, offset);
      const newDur = totalSeconds(modified.points);
      const extraTimeSec = Math.max(0, newDur - origDur);

      /** Everything after the traffic check: the before→after readout, the
       *  constraint engine and the cost. Returns the failure text when a hard
       *  constraint rejects it. Shared by an accepted candidate and a near miss
       *  (one only a single third aircraft blocked), so a chained fix is priced
       *  and constraint-checked exactly like a plain one. */
      const finish = (): PlanResolution | string => {
        // Separation to the conflict partner (for the before→after readout).
        const sep = pairSeparation(afterFlight, intrFlight);
        const newDCpaNm = sep?.minHNm ?? conflict.dCpaNm;
        const newVertFt = sep?.vSepAtCpaFt ?? conflict.vSepAtCpaFt;

        // Constraint engine over the maneuver window (local time around the turn).
        const wLo = offset + Math.max(0, timing.tMan - 60);
        const wHi = offset + timing.tMan + timing.deviationSec + 300;
        const afterPath = pathWithAlt(toSamples(modified.points), offset, wLo, wHi);
        const beforePath = pathWithAlt(samples, offset, wLo, wHi);
        const report = evaluateConstraints({
          maneuverType: type,
          resolution,
          cfg,
          afterPath,
          originalAreaIdents: areaIdentsOnPath(beforePath, restricted),
          restricted,
          trackDeg,
          newGsKt: type === "speed" ? resolution.gsKt : undefined,
          newAltFt: type === "flightlevel" ? resolution.altFt : undefined,
          // Only reached when the candidate clears the pair (and, for a near
          // miss, everyone but the one blocker the chain will move).
          recheck: { clear: true, minSepNm: newDCpaNm },
        });
        if (report.verdict === "reject") {
          const failed = report.checks.filter((c) => c.status === "fail");
          return failed.map((c) => c.label).join("; ") || "Failed a hard constraint.";
        }

        const extraDistanceNm =
          type === "speed" ? 0 : (extraTimeSec / 3600) * curGs;
        const w = cfg.weights;
        const cost =
          w.trackDeviationPerDeg * Math.abs(trackDeviationDeg) +
          w.extraDistancePerNm * extraDistanceNm +
          w.altitudeChangePerThousandFt * (Math.abs(altChangeFt) / 1000) +
          w.typePenalty[type];

        return {
          type,
          target: targetId,
          targetCallsign,
          instruction: "",
          resolution,
          value,
          origDCpaNm: conflict.dCpaNm,
          newDCpaNm,
          origVertFt: conflict.vSepAtCpaFt,
          newVertFt,
          extraDistanceNm,
          extraTimeSec,
          altChangeFt,
          trackDeviationDeg,
          cost,
          score: 0,
          reason: "",
          constraintVerdict: report.verdict,
          tManLocal: timing.tMan,
          deviationSec: timing.deviationSec,
          rejoinSec: timing.rejoinSec,
        };
      };

      // 3-D clearance vs EVERY other flight (level changes clear vertically).
      //
      // The intruder is checked like everyone else — a candidate that leaves
      // the original conflict standing is no fix — but it is tallied
      // separately, because the two failures mean different things. See the
      // blocker note below.
      let offender: PlanFlight | undefined; // third party, tightest first
      let offenderConflict: PlanConflict | undefined;
      let thirdCount = 0; // how many third parties it conflicts with
      let tightestNm = Infinity; // against anything, for the blocker readout
      let thirdTightestNm = Infinity;
      let intruderCpaNm: number | undefined; // the ORIGINAL pair's new CPA, if still tight
      let clear = true;
      for (const o of others) {
        const c = pairConflict(afterFlight, o, cfg);
        if (!c) continue;
        clear = false;
        if (c.dCpaNm < tightestNm) tightestNm = c.dCpaNm;
        if (o.id === intruderId) {
          intruderCpaNm = c.dCpaNm;
          continue;
        }
        thirdCount += 1;
        if (c.dCpaNm < thirdTightestNm) {
          thirdTightestNm = c.dCpaNm;
          offender = o;
          offenderConflict = c;
        }
      }
      // Rejected — but WHY matters: "no fix" almost always means some third
      // aircraft is in the way, and the controller can only act on that if we
      // say who. Tally that aircraft before dropping the candidate.
      //
      // ONLY a third aircraft. The other half of the pair is not a blocker: the
      // panel turns this tally into "resolve X first", and X being the aircraft
      // this conflict IS WITH sends the controller in a circle — there is
      // nothing to go and resolve first, the candidate simply did not work.
      if (!clear) {
        // A third aircraft is only "in the way" of a candidate that actually
        // separated the pair. One that still conflicts with the partner failed
        // on its own: moving the third aircraft would not make it work, so it
        // must not be tallied as a blocker ("resolve MMA502 first" when every
        // candidate also left KBZ845 in conflict sent the controller to fix an
        // aircraft that was not the problem).
        if (offender && offenderConflict && intruderCpaNm === undefined) {
          const b = blocked.get(offender.id) ?? {
            id: offender.id,
            callsign: offender.callsign,
            count: 0,
            tightestNm: Infinity,
          };
          b.count += 1;
          b.tightestNm = Math.min(b.tightestNm, thirdTightestNm);
          blocked.set(offender.id, b);

          // Blocked by this one aircraft ALONE, the pair itself separated: move
          // the blocker and this candidate works — keep it for the chain.
          if (opts.nearMisses && thirdCount === 1 && intruderCpaNm === undefined) {
            const r = finish();
            if (typeof r !== "string") {
              r.instruction = briefInstruction(type, value, resolution);
              r.reason = `Clears ${intrFlight.callsign} once ${offender.callsign} has been moved out of the way.`;
              opts.nearMisses.push({
                resolution: r,
                flight: afterFlight,
                traj: modified,
                offset,
                blockerId: offender.id,
                conflict: offenderConflict,
              });
            }
          }

          // WHERE on the maneuvered path it happens says which knock-on it is.
          // During the maneuver: a secondary conflict (§5 of the resolution
          // spec). Only after it — the aircraft back on its way to the plan
          // (the rejoin leg, or a re-timed remainder of the route) — the
          // "third conflict" of ATC practice. A hold's own loop is its
          // deviation, and its length is the time the hold added.
          const deviationEndAbs =
            offset + timing.tMan + (type === "hold" ? extraTimeSec : timing.deviationSec);
          const onRejoin = offenderConflict.tCpaAbsSec >= deviationEndAbs;
          const cpaText = `CPA ${thirdTightestNm.toFixed(1)} NM < ${need} NM`;
          return reject(
            onRejoin ? "rejoin-conflict" : "secondary-conflict",
            onRejoin
              ? `The deviation is clean, but returning to the flight plan it would newly lose separation with ${offender.callsign} (${cpaText}, ~${Math.max(0, Math.round((offenderConflict.tCpaAbsSec - deviationEndAbs) / 60))} min after the deviation ends).`
              : `Would newly lose separation with ${offender.callsign} (${cpaText}).`,
            { id: offender.id, callsign: offender.callsign, dCpaNm: thirdTightestNm },
          );
        }
        // The maneuver did not resolve the conflict it was proposed for —
        // whatever else it also runs into.
        return reject(
          "unresolved-primary",
          `Still conflicts with ${intrFlight.callsign} — CPA ${(intruderCpaNm ?? conflict.dCpaNm).toFixed(1)} NM < ${need} NM` +
            (offender ? ` (and would also conflict with ${offender.callsign}).` : "."),
          {
            id: intruderId,
            callsign: intrFlight.callsign,
            dCpaNm: intruderCpaNm ?? conflict.dCpaNm,
          },
        );
      }

      const r = finish();
      return typeof r === "string" ? reject("constraint-reject", r) : r;
    };

    // --- Heading: smallest clearing turn each side, started kinematically ---
    for (const sign of [1, -1]) {
      for (const deg of env.headingSteps) {
        const timing = latTimingFor(deg);
        const stateAtMan = aircraftAt(samples, timing.tMan) ?? stateNow;
        const trackBase = stateAtMan.track;
        const r = evaluate(
          "heading",
          { headingDeg: norm360(trackBase + sign * deg) },
          sign * deg,
          deg,
          0,
          timing,
          trackBase,
        );
        if (r) {
          const side = sign > 0 ? "right" : "left";
          const lead = Math.round((cpaLocal - timing.tMan) / 60);
          r.instruction = `Turn ${side} ${deg}°`;
          r.reason = `Smallest ${side} turn that clears; a ${cfg.bankAngleDeg}° fly-by turn started ~${Math.max(0, lead)} min before CPA, then rejoins the route.`;
          out.push(r);
          logAccepted(conflict, r);
          break; // smallest per side is enough
        }
      }
    }

    // --- Flight level: the envelope's deltas, semicircular + reachable ---
    for (const delta of env.flDeltas) {
      const targetAlt = Math.round((curAlt + delta) / 1000) * 1000;
      if (targetAlt < 10000 || targetAlt > 43000) continue;
      if (!respectsSemicircular(targetAlt, curTrkNow)) continue;
      const timeNeeded = Math.abs(targetAlt - curAlt) / (cfg.climbDescentFpm.min / 60);
      if (timeNeeded > Math.max(0, cpaLocal - nowLocal) + 60) continue;
      const r = evaluate("flightlevel", { altFt: targetAlt }, targetAlt - curAlt, 0, targetAlt - curAlt, nowTiming, curTrkNow);
      if (r) {
        const climb = targetAlt > curAlt;
        r.instruction = `${climb ? "Climb" : "Descend"} FL${targetAlt / 100}`;
        r.reason = `Keeps your route; ${climb ? "climb" : "descend"} for vertical separation.`;
        out.push(r);
        logAccepted(conflict, r);
      }
    }

    // --- Speed: keep the best-clearing reduce and increase ---
    for (const delta of env.speedDeltas) {
      const newGs = curGs + delta;
      if (newGs < 150 || newGs > 560) continue;
      const r = evaluate("speed", { gsKt: newGs }, delta, 0, 0, nowTiming, curTrkNow);
      if (r) {
        r.instruction = `${delta < 0 ? "Reduce" : "Increase"} ${Math.abs(delta)} kt`;
        r.reason = `Re-times the crossing; no track or level change.`;
        out.push(r);
        logAccepted(conflict, r);
      }
    }

    // --- Direct-to a downstream fix (turn started kinematically) ---
    const bearingTo = (fromLat: number, fromLon: number, toLat: number, toLon: number) => {
      const dLon = (toLon - fromLon) * Math.cos((fromLat * Math.PI) / 180);
      const dLat = toLat - fromLat;
      return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
    };
    for (const fix of fixesAhead(traj, stateNow)) {
      // Estimate the turn size from the current position, size the timing, then
      // recompute the bearing from the (future) maneuver point.
      const dPsi0 = Math.abs(
        headingDeltaDeg(curTrkNow, bearingTo(stateNow.lat, stateNow.lon, fix.lat, fix.lon)),
      );
      const timing = latTimingFor(dPsi0);
      const stateAtMan = aircraftAt(samples, timing.tMan) ?? stateNow;
      const brg = bearingTo(stateAtMan.lat, stateAtMan.lon, fix.lat, fix.lon);
      const trackDev = Math.abs(headingDeltaDeg(stateAtMan.track, brg));
      const r = evaluate(
        "route",
        { headingDeg: brg, directTo: fix },
        0,
        trackDev,
        0,
        timing,
        stateAtMan.track,
      );
      if (r) {
        r.instruction = `Direct ${fix.ident}`;
        r.reason = `Proceed direct ${fix.ident}${r.extraDistanceNm < 1 ? " — shortens the route" : ""} and clears the conflict.`;
        out.push(r);
        logAccepted(conflict, r);
      }
    }

    // --- Hold at a published holding fix on the route AHEAD (delay the flight
    //     to open spacing — the realistic fix for an arrival-merge conflict) ---
    if (holdings && holdings.size) {
      const t0Ms = new Date(traj.points[0].epoch_ts).getTime();
      const localAtFix = (fixLat: number, fixLon: number): number => {
        let bestT = 0;
        let bestD = Infinity;
        for (const p of traj.points) {
          const d = (p.lat - fixLat) ** 2 + (p.lon - fixLon) ** 2;
          if (d < bestD) {
            bestD = d;
            bestT = (new Date(p.epoch_ts).getTime() - t0Ms) / 1000;
          }
        }
        return bestT;
      };
      const heldIdents = new Set<string>();
      // NOT gated to the STAR, unlike the arrival ladder's hold
      // (`makeArrivalHoldGate`). That restriction is about the arrival
      // SEQUENCE — spacing a landing bank, where the instrument is the STAR and
      // holding a departure is not a thing anyone does. Here the hold is a
      // conflict resolution, and the resolver is allowed to reach for any
      // published fix ahead of the aircraft that opens the CPA.
      for (const w of traj.route) {
        const h = holdings.get(w.ident);
        if (!h || heldIdents.has(w.ident)) continue;
        const tManHold = localAtFix(w.lat, w.lon);
        // Only a fix that is still ahead AND before the CPA can open spacing.
        if (tManHold <= nowLocal + 30 || tManHold >= cpaLocal) continue;
        const st = aircraftAt(samples, tManHold);
        if (!st) continue;
        heldIdents.add(w.ident);
        const gsAtFix = st.gsKt || curGs;
        const hold = {
          ident: h.ident,
          lat: h.lat,
          lon: h.lon,
          inboundCourseDeg: h.inboundCourseDeg,
          turn: h.turn,
          legSec: holdLegSec(h, gsAtFix),
          gsKt: h.speedKt ?? gsAtFix,
        };
        const r = evaluate(
          "hold",
          { hold },
          0,
          0,
          0,
          { tMan: tManHold, deviationSec: 0, rejoinSec: 0 },
          st.track,
        );
        if (r) {
          const loopMin = Math.round(holdLoopSec(h, gsAtFix) / 60);
          r.instruction = `Hold at ${h.ident}`;
          r.reason = `Fly one ${loopMin}-min ${h.turn === "R" ? "right" : "left"}-hand hold at ${h.ident} to delay ~${loopMin} min and open spacing (for an arrival merge a vector/level can't clear).`;
          out.push(r);
          logAccepted(conflict, r);
        }
      }
    }
  }

  // For an overtake, discount the effective speed maneuver so it becomes the
  // cheapest → ranks #1 and scores highest. (A turn merely delays the merge.)
  // Slowing the rear/faster jet is preferred over speeding the lead.
  if (isOvertake) {
    for (const r of out) {
      if (r.type !== "speed") continue;
      if (r.target === fasterId && r.value < 0) {
        r.cost = Math.max(0.1, r.cost - 1000);
        r.reason = `In-trail overtake — slowing the rear (faster) aircraft opens the gap and re-sequences the pair (a turn only delays the merge).`;
      } else if (r.target === slowerId && r.value > 0) {
        r.cost = Math.max(0.2, r.cost - 500);
        r.reason = `In-trail overtake — speeding the lead opens the gap (a turn only delays the merge).`;
      }
    }
  }

  // Rank by cost, keep the best per (target,type) so the list stays diverse.
  out.sort((a, b) => a.cost - b.cost);
  const seen = new Set<string>();
  const ranked: PlanResolution[] = [];
  for (const r of out) {
    const key = `${r.target}:${r.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(r);
    if (ranked.length >= topN) break;
  }
  // Relative 0–100 score anchored to the cheapest.
  const minCost = ranked.length ? ranked[0].cost : 0;
  for (const r of ranked) {
    r.score = Math.max(1, Math.min(100, Math.round((100 * (minCost + 1)) / (r.cost + 1))));
  }
  return { resolutions: ranked, rejected };
}

/** Sample a flight's path with altitude over an absolute-time window. */
function pathWithAlt(
  samples: Sample[],
  offset: number,
  t0: number,
  t1: number,
  step = 15,
): PathPoint[] {
  const out: PathPoint[] = [];
  for (let t = t0; t <= t1; t += step) {
    const ac = aircraftAt(samples, t - offset);
    if (ac && ac.altitudeFt != null) {
      out.push({ lat: ac.lat, lon: ac.lon, altFt: ac.altitudeFt });
    }
  }
  return out;
}
