/**
 * Resolution advisory engine — for one active conflict, generate ranked
 * maneuver suggestions with a what-if loop.
 *
 * For each candidate applied to ONE aircraft (either of the pair), we build the
 * maneuvered future path and re-check it against ALL other traffic via
 * simulateSeparation. A candidate survives only if it clears every aircraft by
 * the BUFFERED minima (minima + advisory buffer, never bare minima) — so it
 * both resolves the original conflict and introduces no secondary one. Survivors
 * are scored by the weighted cost function and the cheapest three are returned.
 *
 * Candidate families (per the brief):
 *   - Heading    : collision-cone minimum turn L/R, rounded up to 5°, then
 *                  widened in 5° steps until the full check clears.
 *   - Flight level: ±1000/±2000 ft, respecting the semicircular cruising rule
 *                  (Annex 2 App 3) and only if reachable before the conflict
 *                  window opens at 1000–1500 ft/min.
 *   - Speed      : ±10/20/30 kt (resolves timing/in-trail/crossing conflicts).
 *   - Direct-to  : skip to a subsequent flight-plan fix.
 *
 * Enroute type preference (cost tie-break via w4): Speed < Flight Level < Heading < Route.
 */

import { collisionCone } from "./collisionCone";
import {
  horizontalMinimumNm,
  type CdrConfig,
} from "./config";
import { cpa } from "./cpa";
import {
  frameFor,
  headingDeltaDeg,
  mag,
  makeFrame,
  rotate,
  scale,
  sub,
  toEnu,
  trackOf,
  velocityFromGsTrack,
  type EnuFrame,
  type Vec2,
} from "./geo";
import { fmtFL } from "./format";
import type { Conflict, ManeuverResolution, Maneuver } from "./types";
import type { CdrAircraft } from "./types";
import {
  simulateSeparation,
  straightPath,
  type Kinematic,
  type ManeuverPath,
  type OtherTraffic,
} from "./whatif";

/** A route fix ahead of the aircraft, for direct-to candidates. */
export interface RouteFix {
  ident: string;
  lat: number;
  lon: number;
}

const FPM_TO_FPS = 1 / 60;

/** Max track difference (deg) for a conflict to count as an in-trail OVERTAKE
 *  (nearly co-directional), where a speed change is the effective resolution. */
const OVERTAKE_MAX_TRACK_DIFF_DEG = 25;

/** Round a positive turn magnitude UP to the next 5°. */
const roundUp5 = (deg: number): number => Math.ceil(deg / 5) * 5;

/** Kinematic (ENU) for an aircraft in the shared frame. */
function kinematicOf(frame: EnuFrame, ac: CdrAircraft): Kinematic {
  return {
    p0: toEnu(frame, ac.lat, ac.lon),
    v: velocityFromGsTrack(ac.gsKt, ac.trackDeg),
    alt0: ac.altFt,
    vs: ac.vsFpm * FPM_TO_FPS,
  };
}

/**
 * Semicircular cruising-level rule (ICAO Annex 2, Appendix 3): eastbound tracks
 * (000–179°) fly ODD thousands of feet, westbound (180–359°) fly EVEN. Only
 * enforced at cruising levels (≥ FL110 here); below that, climb/descent levels
 * aren't bound by it. The 11 000 ft floor is a cruising-level cut-off, not a
 * transition altitude: Myanmar publishes TA per aerodrome (AIP Myanmar Table
 * 3.6, 4 000–17 000 ft; see `lib/transitionAltitude.ts`), and this check has
 * no aerodrome context.
 */
export function respectsSemicircular(altFt: number, trackDeg: number): boolean {
  if (altFt < 11000) return true;
  const thousands = Math.round(altFt / 1000);
  const odd = thousands % 2 === 1;
  const eastbound = trackDeg >= 0 && trackDeg < 180;
  return eastbound ? odd : !odd;
}

/** Weighted cost — lower is better. Shortcuts (negative extra distance) are
 *  rewarded but can't dominate; the maneuver-type penalty enforces the
 *  Heading < FL < Route < Speed preference. */
function costOf(
  cfg: CdrConfig,
  m: Pick<
    Maneuver,
    "type" | "trackDeviationDeg" | "extraDistanceNm" | "altChangeFt"
  >,
): number {
  const w = cfg.weights;
  return (
    w.trackDeviationPerDeg * Math.abs(m.trackDeviationDeg) +
    w.extraDistancePerNm * m.extraDistanceNm +
    w.altitudeChangePerThousandFt * (Math.abs(m.altChangeFt) / 1000) +
    w.typePenalty[m.type]
  );
}

/** Build the list of OTHER aircraft (everyone but the target) from their REAL
 *  future paths, projected into the shared frame on the detector's grid — so a
 *  candidate is validated against where traffic actually goes, not a straight
 *  extrapolation. */
function othersOf(
  frame: EnuFrame,
  traffic: CdrAircraft[],
  targetId: string,
): OtherTraffic[] {
  return traffic
    .filter((a) => a.id !== targetId)
    .map((a) => ({
      id: a.id,
      samples: a.future.map((s) => ({
        p: toEnu(frame, s.lat, s.lon),
        alt: s.altFt,
      })),
    }));
}

/** Assemble a Maneuver record, running the what-if and costing it; returns null
 *  when the candidate fails to clear all traffic by the buffered minima. */
function evaluate(
  cfg: CdrConfig,
  frame: EnuFrame,
  target: CdrAircraft,
  intruderId: string,
  others: OtherTraffic[],
  origDCpa: number,
  path: ManeuverPath,
  spec: {
    type: Maneuver["type"];
    instruction: string;
    value: number;
    resolution: ManeuverResolution;
    trackDeviationDeg: number;
    altChangeFt: number;
    extraDistanceNm: number;
    extraTimeSec: number;
  },
): Maneuver | null {
  const sep = simulateSeparation(path, intruderId, others, cfg);
  if (!sep.clearOfAll) return null;
  const m: Maneuver = {
    type: spec.type,
    target: target.id,
    instruction: spec.instruction,
    value: spec.value,
    resolution: spec.resolution,
    newDCpaNm: sep.minHToIntruderNm,
    origDCpaNm: origDCpa,
    extraDistanceNm: spec.extraDistanceNm,
    extraTimeSec: spec.extraTimeSec,
    trackDeviationDeg: spec.trackDeviationDeg,
    altChangeFt: spec.altChangeFt,
    cost: 0,
  };
  m.cost = costOf(cfg, m);
  return m;
}

/** Rough hold time (s) a lateral/speed maneuver is flown before the conflict is
 *  behind — used to size the extra-distance / extra-time estimates. */
function holdSec(conflict: Conflict): number {
  const t = conflict.tToLosSec ?? conflict.tCpa;
  return Math.max(120, Math.min(600, Math.abs(t) || 300));
}

// --- candidate generators --------------------------------------------------

function headingCandidates(
  cfg: CdrConfig,
  frame: EnuFrame,
  target: CdrAircraft,
  intruder: CdrAircraft,
  others: OtherTraffic[],
  origDCpa: number,
  conflict: Conflict,
): Maneuver[] {
  const kt = kinematicOf(frame, target);
  const ki = kinematicOf(frame, intruder);
  const sh = horizontalMinimumNm(cfg) + cfg.buffer.horizontalNm;
  const cone = collisionCone(kt.p0, kt.v, ki.p0, ki.v, sh);

  const gs = target.gsKt;
  const leg = (gs * holdSec(conflict)) / 3600; // NM flown while deviating
  const out: Maneuver[] = [];

  // For each side, seed at the collision-cone tangent (rounded up to 5°) and
  // widen in 5° steps until the FULL what-if check clears — the brief's
  // "round up to 5° then verify".
  const seeds: { side: "left" | "right"; seed: number | null }[] = [
    { side: "right", seed: cone.rightTurnDeg },
    { side: "left", seed: cone.leftTurnDeg },
  ];
  for (const { side, seed } of seeds) {
    if (seed == null) continue;
    const sign = side === "right" ? 1 : -1;
    for (let deg = roundUp5(seed); deg <= 60; deg += 5) {
      const signed = sign * deg;
      const vNew = rotate(kt.v, -signed); // compass right = clockwise = −math
      const path: ManeuverPath = {
        pos: (t) => ({ x: kt.p0.x + vNew.x * t, y: kt.p0.y + vNew.y * t }),
        alt: (t) => kt.alt0 + kt.vs * t,
      };
      const rad = (deg * Math.PI) / 180;
      const extraDistanceNm = leg * (1 / Math.cos(rad) - 1);
      const m = evaluate(cfg, frame, target, intruder.id, others, origDCpa, path, {
        type: "heading",
        instruction: `Turn ${side} ${deg}°`,
        value: signed,
        resolution: { headingDeg: trackOf(vNew) },
        trackDeviationDeg: deg,
        altChangeFt: 0,
        extraDistanceNm,
        extraTimeSec: (extraDistanceNm / gs) * 3600,
      });
      if (m) {
        out.push(m);
        break; // smallest turn that clears this side — stop widening
      }
    }
  }
  return out;
}

function flightLevelCandidates(
  cfg: CdrConfig,
  frame: EnuFrame,
  target: CdrAircraft,
  intruder: CdrAircraft,
  others: OtherTraffic[],
  origDCpa: number,
  conflict: Conflict,
): Maneuver[] {
  const kt = kinematicOf(frame, target);
  const rateFps = (cfg.climbDescentFpm.min * FPM_TO_FPS); // conservative reach
  const timeAvailable = Math.max(
    0,
    conflict.tToLosSec ?? conflict.tCpa ?? cfg.lookahead.mtcdSec,
  );
  const out: Maneuver[] = [];

  for (const delta of [1000, 2000, -1000, -2000]) {
    const targetAlt = Math.round((target.altFt + delta) / 1000) * 1000;
    if (targetAlt < 10000 || targetAlt > 45000) continue; // sane envelope
    if (!respectsSemicircular(targetAlt, target.trackDeg)) continue;
    // Reachable before the conflict window opens?
    const timeNeeded = Math.abs(targetAlt - target.altFt) / (cfg.climbDescentFpm.min / 60);
    if (timeNeeded > timeAvailable + 1) continue;

    const dir = Math.sign(targetAlt - target.altFt);
    const path: ManeuverPath = {
      pos: (t) => ({ x: kt.p0.x + kt.v.x * t, y: kt.p0.y + kt.v.y * t }),
      alt: (t) => {
        // Rate-limited climb/descent toward the target level (ft/s = fpm/60).
        const a = target.altFt + dir * rateFps * t;
        return dir > 0 ? Math.min(a, targetAlt) : Math.max(a, targetAlt);
      },
    };
    const m = evaluate(cfg, frame, target, intruder.id, others, origDCpa, path, {
      type: "flightlevel",
      instruction: `${dir > 0 ? "Climb" : "Descend"} to ${fmtFL(targetAlt)}`,
      value: targetAlt - target.altFt,
      resolution: { altFt: targetAlt },
      trackDeviationDeg: 0,
      altChangeFt: targetAlt - target.altFt,
      extraDistanceNm: 0,
      extraTimeSec: 0,
    });
    if (m) out.push(m);
  }
  return out;
}

function speedCandidates(
  cfg: CdrConfig,
  frame: EnuFrame,
  target: CdrAircraft,
  intruder: CdrAircraft,
  others: OtherTraffic[],
  origDCpa: number,
  conflict: Conflict,
): Maneuver[] {
  const kt = kinematicOf(frame, target);
  const dir = kt.v; // keep heading
  const speed = mag(dir);
  if (speed < 1e-6) return [];
  const unit = scale(dir, 1 / speed);
  const leg = (target.gsKt * holdSec(conflict)) / 3600;
  const out: Maneuver[] = [];

  for (const delta of [-10, -20, -30, 10, 20, 30]) {
    const newGs = target.gsKt + delta;
    if (newGs < 120 || newGs > 600) continue; // rough operating envelope
    const newSpeedNmps = newGs / 3600;
    const vNew = scale(unit, newSpeedNmps);
    const path: ManeuverPath = {
      pos: (t) => ({ x: kt.p0.x + vNew.x * t, y: kt.p0.y + vNew.y * t }),
      alt: (t) => kt.alt0 + kt.vs * t,
    };
    const extraTimeSec = (leg / newGs) * 3600 - (leg / target.gsKt) * 3600;
    const m = evaluate(cfg, frame, target, intruder.id, others, origDCpa, path, {
      type: "speed",
      instruction: `${delta < 0 ? "Reduce" : "Increase"} ${Math.abs(delta)} kt`,
      value: delta,
      resolution: { gsKt: newGs },
      trackDeviationDeg: 0,
      altChangeFt: 0,
      extraDistanceNm: 0,
      extraTimeSec,
    });
    if (m) out.push(m);
  }
  return out;
}

function directToCandidates(
  cfg: CdrConfig,
  frame: EnuFrame,
  target: CdrAircraft,
  intruder: CdrAircraft,
  others: OtherTraffic[],
  origDCpa: number,
  routeAhead: RouteFix[],
): Maneuver[] {
  if (routeAhead.length === 0) return [];
  const kt = kinematicOf(frame, target);
  const gs = target.gsKt;
  const speedNmps = gs / 3600;
  const selfFrame = makeFrame(target.lat, target.lon);
  const out: Maneuver[] = [];

  for (const fix of routeAhead) {
    const w = toEnu(frame, fix.lat, fix.lon);
    const dir = sub(w, kt.p0);
    const dist = mag(dir);
    if (dist < 1) continue; // basically overhead — nothing to cut to
    const vNew = scale(dir, speedNmps / dist);
    const path: ManeuverPath = {
      pos: (t) => ({ x: kt.p0.x + vNew.x * t, y: kt.p0.y + vNew.y * t }),
      alt: (t) => kt.alt0 + kt.vs * t,
    };
    const newTrack = trackOf(vNew);
    const trackDev = Math.abs(headingDeltaDeg(target.trackDeg, newTrack));
    // Distance saved vs continuing on the current heading to abeam the fix
    // (approx): straight-line to the fix is the shortcut length.
    const selfDist = mag(toEnu(selfFrame, fix.lat, fix.lon));
    const m = evaluate(cfg, frame, target, intruder.id, others, origDCpa, path, {
      type: "route",
      instruction: `Direct ${fix.ident}`,
      value: 0,
      resolution: {
        headingDeg: newTrack,
        directTo: { ident: fix.ident, lat: fix.lat, lon: fix.lon },
      },
      trackDeviationDeg: trackDev,
      altChangeFt: 0,
      // Direct-to is usually a shortcut; report a small negative (benefit).
      extraDistanceNm: -Math.max(0, selfDist * 0.1),
      extraTimeSec: 0,
    });
    if (m) out.push(m);
  }
  return out;
}

/**
 * Generate the top-N (default 3) ranked resolutions for a conflict.
 *
 * @param conflict   the active conflict to resolve
 * @param traffic    the full traffic snapshot (both aircraft + everyone else)
 * @param cfg        engine config
 * @param routesAhead  optional map: aircraft id → the fixes still ahead of it,
 *                     enabling direct-to candidates
 * @param topN       how many suggestions to return (default 3)
 */
export function generateResolutions(
  conflict: Conflict,
  traffic: CdrAircraft[],
  cfg: CdrConfig,
  routesAhead?: Map<string, RouteFix[]>,
  topN = 3,
): Maneuver[] {
  const a = traffic.find((t) => t.id === conflict.a);
  const b = traffic.find((t) => t.id === conflict.b);
  if (!a || !b) return [];

  const frame = frameFor(traffic);
  // Original d_CPA in this frame, for the "before → after" readout.
  const ka = kinematicOf(frame, a);
  const kb = kinematicOf(frame, b);
  const { dCpa: origDCpa } = cpa(sub(kb.p0, ka.p0), sub(kb.v, ka.v));

  const all: Maneuver[] = [];
  // Try maneuvering EITHER aircraft; the controller sees options on both.
  for (const [target, intruder] of [
    [a, b],
    [b, a],
  ] as const) {
    const others = othersOf(frame, traffic, target.id);
    all.push(
      ...headingCandidates(cfg, frame, target, intruder, others, origDCpa, conflict),
      ...flightLevelCandidates(cfg, frame, target, intruder, others, origDCpa, conflict),
      ...speedCandidates(cfg, frame, target, intruder, others, origDCpa, conflict),
      ...directToCandidates(
        cfg,
        frame,
        target,
        intruder,
        others,
        origDCpa,
        routesAhead?.get(target.id) ?? [],
      ),
    );
  }

  // Overtake (in-trail catch-up): the two tracks are nearly parallel, so a
  // heading turn or direct-to only DELAYS the merge — the faster jet rejoins the
  // route and re-closes on the slower one. The effective fix is SPEED: slow the
  // rear (faster) aircraft, or speed up the lead. Rank those first so
  // "Reduce N kt" is the #1 suggestion for this geometry.
  const trackDiff = Math.abs(headingDeltaDeg(a.trackDeg, b.trackDeg));
  const isOvertake = trackDiff <= OVERTAKE_MAX_TRACK_DIFF_DEG;
  const fasterId = a.gsKt >= b.gsKt ? a.id : b.id;
  const slowerId = fasterId === a.id ? b.id : a.id;
  // Preference tier for an overtake: (0) slow the rear/faster jet — the standard
  // action — then (1) speed the lead, then (2) everything else by cost.
  const speedTier = (m: Maneuver): number => {
    if (!isOvertake || m.type !== "speed") return 2;
    if (m.target === fasterId && m.value < 0) return 0;
    if (m.target === slowerId && m.value > 0) return 1;
    return 2;
  };

  all.sort((x, y) => {
    const tx = speedTier(x);
    const ty = speedTier(y);
    if (tx !== ty) return tx - ty; // overtake → speed-reduce first
    return x.cost - y.cost; // otherwise weighted-cost (Heading < FL < Route < Speed)
  });
  return all.slice(0, topN);
}
