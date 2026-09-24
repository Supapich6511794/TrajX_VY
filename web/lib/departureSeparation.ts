/**
 * Departure separation between flight plans off the SAME runway.
 *
 * Two FPLs filed out of the same aerodrome, on the same runway, at the same
 * EOBT is not a trajectory conflict — nothing has been generated yet, and the
 * CD&R engine (which needs 4D paths) cannot see it. It is a clearance problem,
 * and it is decided before either aircraft moves:
 *
 *     A takes off  ->  B is next  ->  which way do their tracks go?
 *                                 ->  wake categories?
 *                                 ->  full length or an intersection?
 *                                 ->  apply the Doc 4444 minimum
 *                                 ->  is the runway clear (§7.9.2)?
 *                                 ->  B may be cleared for take-off
 *
 * Each step is one of the minima below; the governing one is simply the
 * largest, and it is reported alongside the paragraph it comes from so the
 * number is explainable rather than a bare threshold.
 *
 * Rules, quoted from ICAO Doc 4444 (PANS-ATM, 16th ed.):
 *
 *   §5.6.1  1 minute — tracks diverging by at least 45° immediately after
 *           take-off, so that lateral separation is provided.
 *   §5.6.2  2 minutes — the PRECEDING aircraft is 40 kt (74 km/h) or more
 *           faster than the following one and both follow the same track.
 *   §5.6.3  5 minutes — while vertical separation does not exist, if a
 *           departing aircraft will be flown THROUGH the level of a preceding
 *           departure and both propose to follow the same track.
 *   §5.8.3.1  2 minutes — LIGHT or MEDIUM behind HEAVY, or LIGHT behind
 *           MEDIUM, using a) the same runway, b) parallel runways under 760 m
 *           apart, or c)/d) crossing or wider-spaced parallel runways WHEN THE
 *           PROJECTED FLIGHT PATHS CROSS. The runway is therefore not the
 *           question the rule asks — the paths are.
 *   §5.8.3.2  3 minutes — the same pairs departing from an INTERMEDIATE part
 *           of the same runway (an intersection departure).
 *   §7.9.2  the runway itself: a departure is not normally permitted to start
 *           take-off until the preceding one has crossed the runway end or
 *           started a turn. Doc 4444 gives no number for that — it is a
 *           visual/operational condition — so it is an ANSP parameter here.
 *
 * SUPER (A380) is not in the 16th edition's §5.8.3, which predates the
 * category. It carries ICAO's separate A380 provisions instead — 2 minutes for
 * a HEAVY behind it, 3 for a MEDIUM or LIGHT — set out in `WAKE_SEC` below,
 * the same way `lib/cdr/config.ts` gives SUPER its own row in the
 * distance-based matrix.
 */

import { wakeCategoryOf, type WakeCategory } from "@/lib/cdr/wake";

/** Which rule set the interval — the "why" behind the number. */
export type DepartureRule =
  | "wake"
  | "wake-intersection"
  | "track"
  | "speed"
  | "level-crossing"
  | "in-trail"
  | "runway-occupancy";

/** One filed departure, as much of it as a plan (not a trajectory) knows. */
export interface DepartureFlight {
  /** Plan id — what the UI navigates back to. */
  id: string;
  callsign: string;
  /** ICAO type designator; drives the wake category. */
  actype: string;
  adep: string;
  ades: string;
  /** EOBT in epoch ms (UTC). Null when the plan has none / an unparseable one,
   *  which takes the flight out of the check entirely. */
  eobtMs: number | null;
  /** Departure runway, e.g. "RW21L". "" = Auto: the engine picks the
   *  aerodrome's default, so two blanks are the SAME runway. */
  depRwy: string;
  /** Initial track after take-off (° true), null when it cannot be worked out.
   *  Null is treated as the SAME track as the other aircraft — the
   *  conservative reading, since the 45° divergence relief has to be shown
   *  before it can be used. */
  trackDeg: number | null;
  /** Planned ground speed (kt) — the §5.6.2 comparison. */
  gsKt: number;
  /** Requested flight level (hundreds of feet) — the §5.6.3 test. */
  rfl: number;
  /** Departing from an intermediate part of the runway rather than full
   *  length, which raises the wake minimum to 3 minutes (§5.8.3.2). */
  intersection?: boolean;
}

export interface DepartureConfig {
  /** §7.9.2 runway-occupancy floor (s). Not a Doc 4444 figure — the document
   *  states the condition ("crossed the end of the runway-in-use or has
   *  started a turn"), and each ANSP turns it into a number. 60 s matches the
   *  arrival side's `finalApproach.runwayOccupancySec`. */
  runwayOccupancySec: number;
  /** §5.6.1 divergence that provides lateral separation (°). */
  divergingTrackDeg: number;
  /** §5.6.2 speed advantage that triggers the 2-minute minimum (kt). */
  fasterLeaderKt: number;
  /** Horizontal minimum two departures on the SAME track must end up with
   *  (NM). Doc 4444 §5.6 has no time minimum for that case — the aircraft are
   *  simply separated by distance instead (§8.7.3), so the interval is however
   *  long it takes the follower to be this far in trail. 3 NM is the Bangkok
   *  TMA radar minimum, which is where a departure is. */
  sameTrackSepNm: number;
  /** Category assumed for a type not in the wake table. */
  unknownTypeCategory: WakeCategory;
}

export const DEFAULT_DEPARTURE_CONFIG: DepartureConfig = {
  runwayOccupancySec: 60,
  divergingTrackDeg: 45,
  fasterLeaderKt: 40,
  sameTrackSepNm: 3,
  unknownTypeCategory: "MEDIUM",
};

/** The interval one departure needs behind another, and what set it. */
export interface DepartureRequirement {
  requiredSec: number;
  requiredBy: DepartureRule;
  /** One sentence naming the rule and its paragraph. */
  reason: string;
  /** Every applicable minimum, for the breakdown. */
  minima: {
    wakeSec: number;
    trackSec: number;
    inTrailSec: number;
    runwayOccupancySec: number;
  };
  /** Track divergence between the pair (°), and whether §5.6.1 relief applies.
   *  `divergenceDeg` is null when either track is unknown. */
  divergenceDeg: number | null;
  divergingTracks: boolean;
}

/**
 * Time-based wake-turbulence minima between two DEPARTURES off the same
 * runway, by category pair (seconds). Indexed [aircraft ahead][aircraft
 * behind]; a pair with no entry has no wake minimum at all.
 *
 *   SUPER  -> HEAVY            2 min
 *   SUPER  -> MEDIUM / LIGHT   3 min
 *   HEAVY  -> MEDIUM / LIGHT   2 min
 *   MEDIUM -> LIGHT            2 min
 *   MEDIUM -> MEDIUM           nothing here; the runway and the tracks still
 *                              have their own minima (§7.9.2, §5.6, §8.7.3)
 *
 * Doc 4444 §5.8.3.1 is the 2-minute rule and the 16th edition writes it for
 * HEAVY and MEDIUM only — the SUPER row comes from ICAO's separate A380
 * provisions, which give the lighter categories a minute more behind it. The
 * table is spelled out rather than derived from a "is the follower lighter?"
 * test precisely because that shortcut gets the SUPER row wrong: it made an
 * A380 followed by a 737 a 2-minute wait instead of 3.
 */
const WAKE_SEC: Partial<
  Record<WakeCategory, Partial<Record<WakeCategory, number>>>
> = {
  SUPER: { HEAVY: 120, MEDIUM: 180, LIGHT: 180 },
  HEAVY: { MEDIUM: 120, LIGHT: 120 },
  MEDIUM: { LIGHT: 120 },
};

/** §5.8.3.2: the same pairs, off an intermediate part of the runway, wait
 *  three minutes. It raises the 2-minute pairs and leaves the 3-minute ones
 *  where they are — the paragraph predates the SUPER category and there is no
 *  published figure to raise those to. */
const INTERSECTION_SEC = 180;

/** Wake minimum (s) for a departure pair — §5.8.3.1 / §5.8.3.2 and the A380
 *  provisions. Zero when the pair is not one they name (MEDIUM behind MEDIUM,
 *  or anything behind a lighter aircraft). */
function wakeSecFor(
  leader: WakeCategory,
  follower: WakeCategory,
  intersection: boolean,
): number {
  const base = WAKE_SEC[leader]?.[follower] ?? 0;
  if (base === 0) return 0;
  return intersection ? Math.max(base, INTERSECTION_SEC) : base;
}

/** Initial great-circle track (° true) from one point to another. What a PLAN
 *  can know about a departure's direction before anything is generated: the
 *  bearing to the first fix its route names. */
export function initialBearingDeg(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number {
  const p1 = (fromLat * Math.PI) / 180;
  const p2 = (toLat * Math.PI) / 180;
  const dl = ((toLon - fromLon) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two tracks (°, 0–180). */
function trackDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * What the following departure needs behind the leading one.
 *
 * Every applicable minimum is evaluated and the LARGEST governs — the wake
 * minimum does not replace the track/level ones, it sits alongside them.
 */
export function departureRequirement(
  leader: DepartureFlight,
  follower: DepartureFlight,
  cfg: DepartureConfig = DEFAULT_DEPARTURE_CONFIG,
  /** Are they using the same runway (or one of them "Auto")? Only §7.9.2 and
   *  the §5.6.1 one-minute floor are runway-bound; everything else follows the
   *  PATHS, which is why two aircraft off different runways onto the same fix
   *  still have to be separated. */
  sameRunwayPair = true,
): DepartureRequirement {
  const lCat = wakeCategoryOf(leader.actype, cfg.unknownTypeCategory);
  const fCat = wakeCategoryOf(follower.actype, cfg.unknownTypeCategory);
  const intersection = !!(leader.intersection || follower.intersection);

  const divergenceDeg =
    leader.trackDeg != null && follower.trackDeg != null
      ? trackDiffDeg(leader.trackDeg, follower.trackDeg)
      : null;
  // Unknown tracks count as the same track: §5.6.1 is relief that has to be
  // demonstrated, and §5.6.2/§5.6.3 are the rules that then apply.
  const diverging =
    divergenceDeg != null && divergenceDeg >= cfg.divergingTrackDeg;

  // §5.8.3.1 a)/b) is the same runway; c)/d) extend the SAME 2 minutes to
  // crossing and wider-spaced parallel runways whenever the projected flight
  // paths cross. Tracks that do not diverge are the plan-level stand-in for
  // "the paths cross" — before generation there are no paths to intersect.
  const wakeApplies = sameRunwayPair || !diverging;
  const wakeSec = wakeApplies ? wakeSecFor(lCat, fCat, intersection) : 0;

  let trackSec = 0;
  let trackRule: DepartureRule = "track";
  if (diverging) {
    // §5.6.1 — one minute, and the same-track rules below do not apply. The
    // paragraph allows the minimum to be reduced for parallel-runway
    // operations, so it is not held against a pair on different runways.
    trackSec = sameRunwayPair ? 60 : 0;
    trackRule = "track";
  } else if (follower.rfl > leader.rfl) {
    // §5.6.3 — the follower will be flown through the leader's level.
    trackSec = 300;
    trackRule = "level-crossing";
  } else if (leader.gsKt - follower.gsKt >= cfg.fasterLeaderKt) {
    // §5.6.2 — the leader is 40 kt or more faster on the same track.
    trackSec = 120;
    trackRule = "speed";
  }

  // Same track, same level, no speed advantage: Doc 4444 §5.6 sets no time
  // minimum for that — the pair is separated by DISTANCE instead (§8.7.3), so
  // the interval is however long the follower needs to be that far in trail.
  // Without this, two aircraft filed off different runways onto the same fix at
  // the same minute look legal and fly in formation.
  const inTrailSec =
    !diverging && follower.gsKt > 0
      ? Math.ceil((cfg.sameTrackSepNm / follower.gsKt) * 3600)
      : 0;

  const runwayOccupancySec = sameRunwayPair ? cfg.runwayOccupancySec : 0;
  const minima = { wakeSec, trackSec, inTrailSec, runwayOccupancySec };
  const requiredSec = Math.max(wakeSec, trackSec, inTrailSec, runwayOccupancySec);

  // Ties go to the most specific rule: wake, then the track/level/speed rules,
  // then in-trail distance, then the runway itself.
  let requiredBy: DepartureRule;
  let reason: string;
  if (requiredSec === 0) {
    requiredBy = "track";
    reason =
      `tracks diverge ${Math.round(divergenceDeg ?? 0)}° from different ` +
      `runways — laterally separated immediately after take-off (Doc 4444 §5.6.1)`;
  } else if (wakeSec === requiredSec && wakeSec > 0) {
    requiredBy = intersection ? "wake-intersection" : "wake";
    // The interval is quoted from the rule that produced it, not written into
    // the sentence: SUPER pairs are 3 minutes where HEAVY pairs are 2.
    const mins = fmtInterval(wakeSec);
    reason = intersection
      ? `${fCat} behind ${lCat} from an intermediate part of the runway — ` +
        `${mins} (Doc 4444 §5.8.3.2)`
      : sameRunwayPair
        ? `${fCat} behind ${lCat} on the same runway — ${mins} ` +
          `(Doc 4444 §5.8.3.1)`
        : `${fCat} behind ${lCat} and the departure paths cross — ${mins} ` +
          `(Doc 4444 §5.8.3.1 c)/d))`;
  } else if (trackSec === requiredSec && trackSec > 0) {
    requiredBy = trackRule;
    reason =
      trackRule === "level-crossing"
        ? `same track and ${follower.callsign} climbs through FL${leader.rfl} — ` +
          `5 min while no vertical separation exists (Doc 4444 §5.6.3)`
        : trackRule === "speed"
          ? `same track and ${leader.callsign} is ${Math.round(
              leader.gsKt - follower.gsKt,
            )} kt faster — 2 min (Doc 4444 §5.6.2)`
          : `tracks diverge ${Math.round(divergenceDeg ?? 0)}° — ` +
            `1 min (Doc 4444 §5.6.1)`;
  } else if (inTrailSec === requiredSec && inTrailSec > 0) {
    requiredBy = "in-trail";
    reason =
      `both climb out on the same track at FL${follower.rfl}` +
      (sameRunwayPair ? "" : ", off different runways onto the same path") +
      ` — ${cfg.sameTrackSepNm} NM in trail is ${fmtInterval(inTrailSec)} at ` +
      `${Math.round(follower.gsKt)} kt (Doc 4444 §8.7.3)`;
  } else {
    requiredBy = "runway-occupancy";
    reason =
      `runway must be clear — the preceding departure has to cross the runway ` +
      `end or start a turn first (Doc 4444 §7.9.2)`;
  }

  return {
    requiredSec,
    requiredBy,
    reason,
    minima,
    divergenceDeg,
    divergingTracks: diverging,
  };
}

/** A pair of filed departures too close together on one runway. */
export interface DepartureConflict {
  /** Stable id: the two plan ids in take-off order. */
  id: string;
  leader: DepartureFlight;
  follower: DepartureFlight;
  adep: string;
  /** The runway both are using, or "Auto" when neither plan names one. */
  runway: string;
  /** True when that runway is the engine's default rather than a stated pick —
   *  the pair is only on the same runway by assumption. */
  runwayAssumed: boolean;
  /** Actual gap between the two EOBTs (s) and what is required. */
  gapSec: number;
  requiredSec: number;
  requiredBy: DepartureRule;
  reason: string;
  /** How much more time is needed (s). */
  deficitSec: number;
}

/** EOBT (epoch ms) that would clear the conflict, if `planId` is the one moved.
 *  Moving the follower pushes it later; moving the leader pulls it earlier —
 *  either way the pair ends up exactly at the required interval. */
export function resolvedEobtMs(
  c: DepartureConflict,
  planId: string,
): number | null {
  const lead = c.leader.eobtMs;
  const follow = c.follower.eobtMs;
  if (lead == null || follow == null) return null;
  if (planId === c.follower.id) return lead + c.requiredSec * 1000;
  if (planId === c.leader.id) return follow - c.requiredSec * 1000;
  return null;
}

/**
 * Does this plan actually take off from the aerodrome it names?
 *
 * The departure check is a tower's: two aircraft cleared off the same field a
 * minute apart. It only means something for a plan that starts on the ground at
 * a field this system knows. A flight that is merely PASSING THROUGH the area
 * (`entryFl` set) is at level when it arrives, and one whose ADEP has no
 * coordinates here is departing a foreign field that is not this tower's
 * business — for both, the EOBT is a time they cross into the area, not an
 * off-block time, so "two departures from VHHH 40 s apart" is not an event that
 * occurs. Counting them buried the real departures under dozens of false ones.
 *
 * `knownFields` empty means the aerodrome list has not loaded yet; nothing is
 * dropped on a guess in that case.
 */
export function departsFromKnownField(
  plan: { adep: string; entryFl?: number },
  knownFields: { readonly size: number; has(icao: string): boolean },
): boolean {
  if (plan.entryFl) return false;
  if (knownFields.size === 0) return true;
  return knownFields.has(plan.adep.trim().toUpperCase());
}

/**
 * Every pair of filed departures that cannot both be cleared as filed.
 *
 * Grouped by aerodrome, then walked in take-off order so each flight is checked
 * against the one immediately ahead of it — the pair a tower controller
 * actually holds. Sorted worst deficit first.
 */
export function findDepartureConflicts(
  flights: DepartureFlight[],
  cfg: DepartureConfig = DEFAULT_DEPARTURE_CONFIG,
): DepartureConflict[] {
  const byAdep = new Map<string, DepartureFlight[]>();
  for (const f of flights) {
    const adep = f.adep.trim().toUpperCase();
    if (!adep || f.eobtMs == null) continue;
    byAdep.set(adep, [...(byAdep.get(adep) ?? []), f]);
  }

  const out: DepartureConflict[] = [];
  for (const [adep, group] of byAdep) {
    if (group.length < 2) continue;
    const order = [...group].sort(
      (a, b) =>
        (a.eobtMs ?? 0) - (b.eobtMs ?? 0) || a.callsign.localeCompare(b.callsign),
    );
    for (let i = 1; i < order.length; i++) {
      const follower = order[i];
      // The aircraft immediately ahead of it AT THE FIELD — not just on its
      // runway. Two departures off different runways still have to be
      // separated when their paths cross (§5.8.3.1 c)/d)); only §7.9.2 and the
      // §5.6.1 floor are runway-bound, and `departureRequirement` is told which
      // case this is. A blank runway is "Auto" — the engine gives it the
      // aerodrome's default, which is the one the other flight is on too.
      const leader = order[i - 1];
      const same = sameRunway(leader.depRwy, follower.depRwy);
      const gapSec = ((follower.eobtMs ?? 0) - (leader.eobtMs ?? 0)) / 1000;
      const req = departureRequirement(leader, follower, cfg, same);
      if (gapSec >= req.requiredSec) continue;
      const lRwy = leader.depRwy.trim().toUpperCase();
      const fRwy = follower.depRwy.trim().toUpperCase();
      out.push({
        id: `${leader.id}|${follower.id}`,
        leader,
        follower,
        adep,
        // One runway when they share it (a blank is the field's default), both
        // when they do not — the pair reads differently in each case.
        runway: same
          ? lRwy || fRwy || "Auto"
          : `${lRwy || "Auto"} / ${fRwy || "Auto"}`,
        runwayAssumed: same && (!lRwy || !fRwy),
        gapSec,
        requiredSec: req.requiredSec,
        requiredBy: req.requiredBy,
        reason: req.reason,
        deficitSec: req.requiredSec - gapSec,
      });
    }
  }
  return out.sort((a, b) => b.deficitSec - a.deficitSec);
}

/** Are two plans using the same runway? Two stated runways must match; a blank
 *  ("Auto") matches any, because it resolves to the aerodrome's default. */
function sameRunway(a: string, b: string): boolean {
  const x = a.trim().toUpperCase();
  const y = b.trim().toUpperCase();
  return !x || !y || x === y;
}

/**
 * Re-time a whole bank until every pair has the interval it needs.
 *
 * For each conflict ONE of the two flights is moved — by default whichever
 * `pick` says, and the caller's default is a coin toss, because with a hundred
 * pairs off one import there is no sequencing intent to preserve: the goal is a
 * bank that can be cleared, and the controller re-times individual flights
 * afterwards if the order matters.
 *
 * Re-scanned between passes: moving a flight makes it the neighbour of a
 * different one, so a fix cascades down the departure bank the same way an
 * arrival delay cascades down the ladder. Times are snapped to the whole minute
 * the EOBT field actually holds, so the scan sees what will really be applied.
 *
 * Returns the new EOBT per flight id (only the ones that moved) and whatever
 * could not be resolved inside `passes`.
 */
export function autoResolveDepartures(
  flights: DepartureFlight[],
  opts: {
    passes?: number;
    /** Which side of a pair to move; must return one of the two flight ids. */
    pick?: (c: DepartureConflict) => string;
    cfg?: DepartureConfig;
    ignored?: ReadonlySet<string>;
  } = {},
): { eobtMsById: Map<string, number>; remaining: DepartureConflict[] } {
  const cfg = opts.cfg ?? DEFAULT_DEPARTURE_CONFIG;
  const passes = opts.passes ?? 8;
  const pick =
    opts.pick ?? ((c: DepartureConflict) =>
      Math.random() < 0.5 ? c.leader.id : c.follower.id);
  const ignored = opts.ignored ?? new Set<string>();

  const working = new Map(flights.map((f) => [f.id, { ...f }]));
  const moved = new Map<string, number>();

  // Phase 1 — the random re-times. Each pass rescans, because moving a flight
  // makes it the neighbour of a different one.
  for (let pass = 0; pass < passes; pass++) {
    const conflicts = findDepartureConflicts([...working.values()], cfg).filter(
      (c) => !ignored.has(c.id),
    );
    if (conflicts.length === 0) break;
    for (const c of conflicts) {
      const id = pick(c);
      const target = working.get(id);
      const ms = resolvedEobtMs(c, id);
      if (!target || ms == null) continue;
      // Snap to the minute the EOBT field holds — rounding UP, so the applied
      // time is never a few seconds under the interval it was computed for.
      const snapped = eobtToMs(msToEobt(ms));
      if (snapped == null) continue;
      target.eobtMs = snapped;
      moved.set(id, snapped);
    }
  }

  // Phase 2 — settle whatever the random phase left. It leaves things: a pass
  // can move a flight onto a NEW neighbour (the last one is never rescanned),
  // and moving the leader of one pair earlier while the follower of another is
  // moved later can ping-pong the same aircraft. Pushing each flight behind the
  // one ahead of it, in time order, cannot: a flight only ever moves LATER, so
  // nothing it has already passed can come undone.
  settleDepartures(working, cfg, ignored, moved);

  return {
    eobtMsById: moved,
    remaining: findDepartureConflicts([...working.values()], cfg).filter(
      (c) => !ignored.has(c.id),
    ),
  };
}

/** Forward sweep: every departure pushed to at least the interval behind the
 *  one ahead of it at that aerodrome. Mutates `working` and records the moves.
 *  Dismissed pairs are left short — that was the controller's decision. */
function settleDepartures(
  working: Map<string, DepartureFlight>,
  cfg: DepartureConfig,
  ignored: ReadonlySet<string>,
  moved: Map<string, number>,
): void {
  const byAdep = new Map<string, DepartureFlight[]>();
  for (const f of working.values()) {
    const adep = f.adep.trim().toUpperCase();
    if (!adep || f.eobtMs == null) continue;
    byAdep.set(adep, [...(byAdep.get(adep) ?? []), f]);
  }
  for (const group of byAdep.values()) {
    if (group.length < 2) continue;
    const order = group.sort(
      (a, b) =>
        (a.eobtMs ?? 0) - (b.eobtMs ?? 0) || a.callsign.localeCompare(b.callsign),
    );
    for (let i = 1; i < order.length; i++) {
      const leader = order[i - 1];
      const follower = order[i];
      if (ignored.has(`${leader.id}|${follower.id}`)) continue;
      const req = departureRequirement(
        leader,
        follower,
        cfg,
        sameRunway(leader.depRwy, follower.depRwy),
      );
      const gapSec = ((follower.eobtMs ?? 0) - (leader.eobtMs ?? 0)) / 1000;
      if (gapSec >= req.requiredSec) continue;
      const snapped = eobtToMs(
        msToEobt((leader.eobtMs ?? 0) + req.requiredSec * 1000),
      );
      if (snapped == null) continue;
      follower.eobtMs = snapped;
      moved.set(follower.id, snapped);
    }
  }
}

// --- EOBT helpers -----------------------------------------------------------
// The panel's EOBT is a `datetime-local` string READ AS UTC (its label says so),
// so both directions go through Date.UTC rather than the browser's zone.

/** "2026-08-11T15:41" (UTC) -> epoch ms. Null when it isn't a full stamp. */
export function eobtToMs(eobt: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    eobt.trim(),
  );
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
  );
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms -> the `datetime-local` value the input expects, rounded UP to the
 *  next whole minute so a suggested EOBT never lands just under the interval
 *  it was computed to deliver. */
export function msToEobt(ms: number): string {
  const up = Math.ceil(ms / 60000) * 60000;
  return new Date(up).toISOString().slice(0, 16);
}

/** "01:55Z" — how a departure time is read out. */
export function hhmmZ(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`;
}

/** "2 min" / "90 s" — intervals are quoted in minutes when they are whole. */
export function fmtInterval(sec: number): string {
  const s = Math.round(sec);
  return s % 60 === 0 ? `${s / 60} min` : `${s} s`;
}
