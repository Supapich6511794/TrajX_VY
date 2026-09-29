/**
 * Arrival-spacing resolutions — what to do about a pair the sequencer says is
 * short, and in what order.
 *
 * This is the decision half of the supervisor's flow. `arrivalSequence.ts`
 * answers "is there enough room?"; this answers "then what?".
 *
 * On an OPEN STAR the vector leads. The procedure itself ends in "expect
 * vectors": the controller is going to give this aircraft a heading whatever
 * happens, so lengthening the downwind is not an extra intervention, it is the
 * instruction already in flight — and it is the one that actually buys the
 * miles (~2 NM of track per 1 NM of downwind, because the intercept moves out
 * with it). Speed comes next, and holding last:
 *
 *   1. **Vector** — the "maintain heading" instruction: hold the published
 *      downwind past the normal turn-in point and join final further out.
 *      Offered first whenever the geometry allows it (see the two gates below);
 *      where it does not, speed leads instead.
 *   2. **Speed** — least disruptive of the three, and the answer once the
 *      downwind is behind the aircraft. The follower stays on its path and its
 *      level and is simply re-timed. Bounded by an approach-speed floor.
 *   3. **Hold** — one or more racetrack loops at a published holding fix on the
 *      route ahead. Least preferred, but NOT only a last resort: a controller
 *      who can see a long bank coming holds the back of it early rather than
 *      vectoring everyone into a downwind that runs out. So whenever there is a
 *      published fix still ahead of the aircraft, a hold is offered alongside
 *      the other two and the controller dials the number of loops. Where there
 *      is no such fix, it stays what it was — the way out shown when nothing
 *      else can close the gap, and not issuable.
 *
 * Two gates decide whether vectoring is even on the table, both from Doc 4444:
 *
 *   * **§8.9.4.1** — "Vectoring will normally terminate at the time the
 *     aircraft leaves the last assigned heading to intercept the final approach
 *     track." Once the follower is established on final, the downwind is behind
 *     it; the answer is speed, or breaking it off — never a fresh vector.
 *   * The arrival must be on an **open** STAR at all. A closed STAR publishes
 *     no vector leg, so there is no assigned heading to extend; that aircraft
 *     is flying a coded path to the IAF.
 *
 * Pure and UI-free. The chosen fix carries the numbers the engine needs:
 * `extendNm` is passed to the generator as `extend_downwind_nm`, and `gsKt` is
 * the reduced speed.
 */

import type { ArrivalPairSpacing, SequencedArrival } from "./arrivalSequence";
import type { CdrConfig } from "./config";

/** How a spacing deficit would be absorbed. */
export type ArrivalFixKind = "speed" | "vector" | "hold";

/** One candidate instruction for the aircraft that is too close behind. */
export interface ArrivalFix {
  kind: ArrivalFixKind;
  /** The FOLLOWER — the aircraft that gets the instruction. Spacing is always
   *  taken out of the one behind; slowing the leader would only push the
   *  problem onto the pair in front of it. */
  target: string;
  callsign: string;
  /** Controller-readable instruction. */
  instruction: string;
  /** Track miles the fix has to absorb. */
  deficitNm: number;
  /** Distance this candidate can actually absorb (NM). */
  absorbsNm: number;
  /** Enough on its own? A candidate that only partly closes the gap is still
   *  returned — controllers combine them — but it is not `sufficient`. */
  sufficient: boolean;
  /** Extra distance to touchdown to fly, for a vector — the generator's
   *  `extend_downwind_nm`. */
  extendNm?: number;
  /** Reduced ground speed, for a speed control. */
  gsKt?: number;
  /** The tunable size of this instruction, and its unit — kt of reduction for a
   *  speed control, NM of extra track for a vector, racetrack loops for a hold.
   *  Present so the controller can dial it: the planner proposes the minimum
   *  that clears the deficit, which leaves no margin at all. */
  amount?: number;
  amountUnit?: "kt" | "NM" | "loop";
  /** Largest value `amount` may take for this aircraft. */
  maxAmount?: number;
  /** For a hold: the published fix to hold at and how long one loop takes —
   *  everything needed to fly it. Absent on the advisory-only hold offered when
   *  the route has no published holding fix ahead. */
  hold?: ArrivalHold;
  /** For a hold: how many loops to fly. */
  holdLoops?: number;
}

/** A published holding pattern on an arrival's route, ahead of the aircraft. */
export interface ArrivalHold {
  ident: string;
  lat: number;
  lon: number;
  /** Inbound holding course (° true) and turn direction, from the AIP coding. */
  inboundCourseDeg: number;
  turn: "L" | "R";
  /** One straight leg (s) and the holding ground speed (kt). */
  legSec: number;
  gsKt: number;
  /** One complete racetrack (s) — two legs plus two 180° turns. */
  loopSec: number;
  /** Local time (s since this flight's own departure) it crosses the fix. This
   *  is when the instruction takes effect; a hold cannot be flown anywhere but
   *  at the fix. */
  tManSec: number;
}

/** Why vectoring is unavailable for an arrival, when it is. */
export type VectorBlockedReason =
  | "established-on-final"
  | "not-an-open-star"
  | "beyond-downwind-limit";

export interface ArrivalFixPlan {
  pair: ArrivalPairSpacing;
  /** Candidates, best first. Empty when the pair has no deficit. */
  fixes: ArrivalFix[];
  /** Set when a vector was ruled out rather than merely ranked below speed. */
  vectorBlocked?: VectorBlockedReason;
}

/** What the caller knows about the follower's arrival, beyond its geometry. */
export interface ArrivalContext {
  /** Does its STAR end in a vector leg? Only then is there a downwind to
   *  extend (`Procedure.is_open` on the engine side). */
  openStar: boolean;
  /** The published vector heading in °TRUE — the geometry the engine flies. */
  vectorHeadingDeg?: number;
  /** The same heading in °MAGNETIC, as the chart prints it. An instruction
   *  quotes THIS: a chart note such as "After <fix>, maintain heading 015°" is
   *  magnetic, and 015 magnetic is 014 true after a 0°42'W variation — reading
   *  the true course back to a controller is the wrong number. Falls back to
   *  the true one only when the magnetic course was not published. */
  vectorHeadingMagDeg?: number;
  /** The next published holding fix still ahead on its route, when there is
   *  one. Only then can a hold actually be flown. */
  hold?: ArrivalHold;
}

/** Seconds gained by flying `distNm` at `slowKt` instead of `fastKt`. */
function delaySec(distNm: number, fastKt: number, slowKt: number): number {
  if (distNm <= 0 || slowKt <= 0 || fastKt <= 0) return 0;
  return (distNm / slowKt - distNm / fastKt) * 3600;
}

/** Largest speed reduction (kt) this aircraft can still be given before the
 *  approach-speed floor. 0 when it is already there. */
export function maxReductionKt(cfg: CdrConfig, f: SequencedArrival): number {
  return Math.min(
    cfg.finalApproach.maxSpeedReductionKt,
    Math.max(0, f.finalGsKt - cfg.finalApproach.minApproachGsKt),
  );
}

/**
 * A speed control of a GIVEN size, or null when the aircraft has no room to
 * slow. Exported so the controller can dial the amount: the planner picks the
 * largest reduction available, but a controller may want less (or may want to
 * combine a smaller one with something else).
 */
export function speedFix(
  cfg: CdrConfig,
  f: SequencedArrival,
  deficitNm: number,
  reductionKt: number,
): ArrivalFix | null {
  const r = Math.min(Math.max(0, reductionKt), maxReductionKt(cfg, f));
  if (r <= 0) return null;
  const slowed = f.finalGsKt - r;
  // Costed over the terminal-area portion only — see the note in the header.
  const overNm = Math.min(f.distToGoNm, cfg.finalApproach.speedControlRangeNm);
  const absorbsNm = (delaySec(overNm, f.finalGsKt, slowed) * f.finalGsKt) / 3600;
  return {
    kind: "speed",
    target: f.id,
    callsign: f.callsign,
    instruction: `${f.callsign} reduce speed ${Math.round(r)} kt (${Math.round(slowed)} kt)`,
    deficitNm,
    absorbsNm,
    sufficient: absorbsNm >= deficitNm,
    gsKt: slowed,
    amount: r,
    amountUnit: "kt",
    maxAmount: maxReductionKt(cfg, f),
  };
}

/** A downwind extension of a GIVEN size. Exported for the same reason as
 *  `speedFix`: the planner asks for the bare minimum, and a controller
 *  normally wants some margin on top. */
export function vectorFix(
  cfg: CdrConfig,
  f: SequencedArrival,
  ctx: ArrivalContext,
  deficitNm: number,
  extendNm: number,
): ArrivalFix {
  const e = Math.min(
    Math.max(0, extendNm),
    cfg.finalApproach.maxDownwindExtensionNm,
  );
  const hdg = ctx.vectorHeadingMagDeg ?? ctx.vectorHeadingDeg;
  const heading =
    hdg == null
      ? "present heading"
      : `heading ${String(Math.round(hdg)).padStart(3, "0")}`;
  return {
    kind: "vector",
    target: f.id,
    callsign: f.callsign,
    // The downwind itself grows by about half the distance bought, since the
    // intercept moves out with it.
    instruction:
      `${f.callsign} maintain ${heading}, extend downwind ` +
      `${(e / 2).toFixed(1)} NM — expect base turn for ` +
      `${e.toFixed(1)} NM extra track`,
    deficitNm,
    absorbsNm: e,
    sufficient: e >= deficitNm,
    extendNm: e,
    amount: e,
    amountUnit: "NM",
    maxAmount: cfg.finalApproach.maxDownwindExtensionNm,
  };
}

/** Track miles one racetrack loop buys — the loop is a pure time delay, and it
 *  converts to spacing at the aircraft's own approach speed, the same way a
 *  speed control's seconds do. */
export function holdNmPerLoop(f: SequencedArrival, hold: ArrivalHold): number {
  return (hold.loopSec / 3600) * f.finalGsKt;
}

/** Smallest whole number of loops that covers `deficitNm`, bounded by the
 *  configured ceiling. Never less than one — half a racetrack is not a thing a
 *  controller can issue. */
export function holdLoopsFor(
  cfg: CdrConfig,
  f: SequencedArrival,
  hold: ArrivalHold,
  deficitNm: number,
): number {
  const perLoop = holdNmPerLoop(f, hold);
  const want = perLoop > 0 ? Math.ceil(deficitNm / perLoop) : 1;
  return Math.max(1, Math.min(cfg.finalApproach.maxHoldLoops, want));
}

/**
 * A hold of a GIVEN number of loops at a published fix. Unlike speed and
 * vector, this one is QUANTISED: the aircraft flies whole patterns, so a
 * 4-minute loop at 220 kt buys ~15 NM whether 3 were needed or 15. That is the
 * real shape of the instruction, and the panel shows what it actually buys
 * rather than pretending the controller can dial it finely.
 */
export function holdFix(
  cfg: CdrConfig,
  f: SequencedArrival,
  hold: ArrivalHold,
  deficitNm: number,
  loops: number,
): ArrivalFix {
  const n = Math.max(
    1,
    Math.min(cfg.finalApproach.maxHoldLoops, Math.round(loops)),
  );
  const absorbsNm = n * holdNmPerLoop(f, hold);
  const min = Math.round((n * hold.loopSec) / 60);
  const turn = hold.turn === "R" ? "right" : "left";
  return {
    kind: "hold",
    target: f.id,
    callsign: f.callsign,
    instruction:
      `${f.callsign} hold at ${hold.ident} as published — ${n} ${turn}-hand ` +
      `loop${n === 1 ? "" : "s"} (~${min} min, opens ${absorbsNm.toFixed(1)} NM)`,
    deficitNm,
    absorbsNm,
    sufficient: absorbsNm >= deficitNm,
    amount: n,
    amountUnit: "loop",
    maxAmount: cfg.finalApproach.maxHoldLoops,
    hold,
    holdLoops: n,
  };
}

/**
 * Rank the ways to absorb one pair's spacing deficit.
 *
 * Returns an empty plan when the pair is already separated — the flow only
 * intervenes on a deficit, and a controller should not be shown an instruction
 * for traffic that does not need one.
 */
export function planArrivalFix(
  cfg: CdrConfig,
  pair: ArrivalPairSpacing,
  ctx: ArrivalContext,
): ArrivalFixPlan {
  if (pair.deficitNm <= 0) return { pair, fixes: [] };

  const f = pair.follower;
  const deficitNm = pair.deficitNm;
  const fixes: ArrivalFix[] = [];

  // --- Speed -------------------------------------------------------------
  // Slowing the follower re-times it without touching its path or its level.
  // The gain is costed over the terminal-area portion of the remaining track,
  // NOT the whole of it: this is an approach-speed reduction, and an arrival
  // still hundreds of miles out is at cruise Mach. Charging the reduction
  // against the entire distance to run would have speed absorbing tens of
  // miles it cannot, and it would then out-rank the vector every time.
  // The planner proposes the LARGEST reduction available; the controller can
  // dial it back through `speedFix`.
  const speed = speedFix(cfg, f, deficitNm, maxReductionKt(cfg, f));

  // --- Vector ------------------------------------------------------------
  // Doc 4444 §8.9.4.1: vectoring has already terminated once the aircraft is
  // established on final, so the downwind is no longer available to it.
  let blocked: VectorBlockedReason | undefined;
  if (f.establishedOnFinal) {
    blocked = "established-on-final";
  } else if (!ctx.openStar) {
    blocked = "not-an-open-star";
  } else if (deficitNm > cfg.finalApproach.maxDownwindExtensionNm) {
    blocked = "beyond-downwind-limit";
  }
  // Proposed at exactly the deficit — the bare minimum, no margin. The
  // controller normally adds some, which `vectorFix` allows.
  //
  // ORDER: the vector goes in FIRST when it is available, so it is what the
  // panel proposes and what auto-resolve picks. An open STAR hands the
  // aircraft over on a heading; extending that heading is the tool for the job,
  // and speed is the fallback rather than the opening move. With no vector
  // available (closed STAR, or already established on final) speed leads, which
  // is the order the list comes out in anyway.
  if (!blocked) fixes.push(vectorFix(cfg, f, ctx, deficitNm, deficitNm));
  if (speed) fixes.push(speed);

  // --- Hold ----------------------------------------------------------------
  // A real, flyable hold is offered WHENEVER there is a published fix still
  // ahead — not only once the other two have failed. Holding is a planning
  // instrument as much as a last resort: faced with a long bank, a controller
  // holds the back of it early rather than pushing every aircraft into a
  // downwind that eventually runs out. It still ranks last, so nothing about
  // the default proposal changes; it is simply on the menu.
  if (ctx.hold) {
    fixes.push(
      holdFix(cfg, f, ctx.hold, deficitNm, holdLoopsFor(cfg, f, ctx.hold, deficitNm)),
    );
  } else if (!fixes.some((x) => x.sufficient)) {
    // No published fix on the route ahead: all that can be said is that the
    // approach cannot absorb this. Advisory only — there is nowhere to hold.
    fixes.push({
      kind: "hold",
      target: f.id,
      callsign: f.callsign,
      instruction: `${f.callsign} hold — spacing cannot be made up on the approach`,
      deficitNm,
      absorbsNm: Infinity,
      sufficient: true,
    });
  }

  // Sufficient candidates first, then by preference: on an open STAR the
  // VECTOR leads (the aircraft is being vectored anyway — extending the
  // downwind is the instruction already in flight, and the one that buys the
  // miles), speed backs it up, and the hold ranks last. Where no vector is
  // available the ordering is moot: it isn't in the list.
  const rank: Record<ArrivalFixKind, number> = { vector: 0, speed: 1, hold: 2 };
  fixes.sort((a, b) => {
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
    return rank[a.kind] - rank[b.kind];
  });
  return blocked ? { pair, fixes, vectorBlocked: blocked } : { pair, fixes };
}
