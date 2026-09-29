/** Ranking and gating of arrival-spacing resolutions. */
import { describe, expect, it } from "vitest";

import {
  holdFix,
  holdLoopsFor,
  holdNmPerLoop,
  maxReductionKt,
  planArrivalFix,
  speedFix,
  vectorFix,
  type ArrivalContext,
  type ArrivalHold,
} from "./arrivalFix";
import type { ArrivalPairSpacing, SequencedArrival } from "./arrivalSequence";
import { resolveConfig } from "./config";

const cfg = resolveConfig();

function arrival(over: Partial<SequencedArrival> = {}): SequencedArrival {
  return {
    id: "F1",
    callsign: "UBA100",
    type: "A320",
    adep: "VYMK",
    ades: "VYMD",
    star: "DOGI1E",
    wake: "MEDIUM",
    wakeKnown: true,
    etaSec: 600,
    distToGoNm: 30,
    finalGsKt: 220,
    position: 2,
    etaEstimated: false,
    establishedOnFinal: false,
    ...over,
  };
}

function pair(
  deficitNm: number,
  follower: Partial<SequencedArrival> = {},
): ArrivalPairSpacing {
  return {
    leader: arrival({ id: "L1", callsign: "SIA1", position: 1, etaSec: 400 }),
    follower: arrival(follower),
    gapSec: 120,
    spacingNm: 5 - deficitNm,
    requiredNm: 5,
    requiredBy: "wake",
    minima: { radarNm: 3, wakeNm: 5, runwayOccupancyNm: 3.7 },
    deficitNm,
    estimated: false,
  };
}

const OPEN: ArrivalContext = {
  openStar: true,
  vectorHeadingDeg: 14.3,
  vectorHeadingMagDeg: 15,
};
const CLOSED: ArrivalContext = { openStar: false };

/** A published 1-minute right-hand pattern → a 4-minute loop. */
const HOLD: ArrivalHold = {
  ident: "MDY",
  lat: 21.934,
  lon: 96.13,
  inboundCourseDeg: 195,
  turn: "R",
  legSec: 60,
  gsKt: 230,
  loopSec: 240,
  tManSec: 900,
};
const OPEN_HELD: ArrivalContext = { ...OPEN, hold: HOLD };

describe("planArrivalFix", () => {
  it("proposes nothing when the pair is already separated", () => {
    expect(planArrivalFix(cfg, pair(0), OPEN).fixes).toEqual([]);
  });

  it("always instructs the FOLLOWER, never the leader", () => {
    const plan = planArrivalFix(cfg, pair(3), OPEN);
    expect(plan.fixes.length).toBeGreaterThan(0);
    for (const f of plan.fixes) {
      expect(f.target).toBe("F1");
      expect(f.callsign).toBe("UBA100");
    }
  });

  it("leads with the vector on an open STAR, even when speed would do", () => {
    // The procedure ends in "expect vectors": the aircraft is getting a heading
    // regardless, so extending it is the instruction already in flight. Speed
    // is still offered — and here it would be enough on its own — but second.
    const plan = planArrivalFix(cfg, pair(1), OPEN);
    expect(plan.fixes[0].kind).toBe("vector");
    expect(plan.fixes.map((f) => f.kind)).toEqual(["vector", "speed"]);
    const speed = plan.fixes.find((f) => f.kind === "speed")!;
    expect(speed.sufficient).toBe(true);
    expect(speed.gsKt).toBe(180);
  });

  it("leads with speed when the STAR is closed — there is no heading to extend", () => {
    const plan = planArrivalFix(cfg, pair(1), { openStar: false });
    expect(plan.fixes[0].kind).toBe("speed");
    expect(plan.fixes.some((f) => f.kind === "vector")).toBe(false);
  });

  it("leads with speed once established on final (§8.9.4.1)", () => {
    const plan = planArrivalFix(
      cfg,
      pair(1, { establishedOnFinal: true }),
      OPEN,
    );
    expect(plan.fixes[0].kind).toBe("speed");
  });

  it("falls to the vector when speed alone cannot make up the gap", () => {
    const plan = planArrivalFix(cfg, pair(8), OPEN);
    const speed = plan.fixes.find((f) => f.kind === "speed");
    const vector = plan.fixes.find((f) => f.kind === "vector");
    expect(speed?.sufficient).toBe(false);
    expect(vector?.sufficient).toBe(true);
    expect(plan.fixes[0].kind).toBe("vector"); // sufficient ones rank first
  });

  it("asks the generator for exactly the deficit in extra track miles", () => {
    const vector = planArrivalFix(cfg, pair(6), OPEN).fixes.find(
      (f) => f.kind === "vector",
    );
    expect(vector?.extendNm).toBeCloseTo(6, 5);
  });

  it("quotes the downwind at HALF the distance bought", () => {
    // The intercept moves out with the downwind, so 3 NM of heading buys 6 NM.
    const vector = planArrivalFix(cfg, pair(6), OPEN).fixes.find(
      (f) => f.kind === "vector",
    );
    expect(vector?.instruction).toContain("extend downwind 3.0 NM");
    expect(vector?.instruction).toContain("6.0 NM extra track");
    expect(vector?.instruction).toContain("heading 015");
  });

  it("costs the speed reduction over the TERMINAL AREA, not the whole flight", () => {
    // An arrival 400 NM out is at cruise Mach, not approach speed. Charging a
    // 20 kt approach-speed reduction against all 400 NM would credit speed with
    // absorbing ~50 NM, so it would look sufficient for every deficit and the
    // vector would never be offered at all.
    const near = planArrivalFix(cfg, pair(3, { distToGoNm: 40 }), OPEN);
    const far = planArrivalFix(cfg, pair(3, { distToGoNm: 400 }), OPEN);
    const cap = (p: typeof near) =>
      p.fixes.find((f) => f.kind === "speed")!.absorbsNm;
    expect(cap(far)).toBeCloseTo(cap(near), 3);
    expect(cap(near)).toBeLessThan(10);
  });

  it("keeps speed on the menu until the deficit outgrows it", () => {
    // The vector leads either way on an open STAR; what changes with the size
    // of the gap is whether speed is still an ANSWER or merely an option.
    const small = planArrivalFix(cfg, pair(2), OPEN);
    const large = planArrivalFix(cfg, pair(9), OPEN);
    expect(small.fixes[0].kind).toBe("vector");
    expect(small.fixes.find((f) => f.kind === "speed")!.sufficient).toBe(true);
    expect(large.fixes[0].kind).toBe("vector");
    expect(large.fixes.find((f) => f.kind === "speed")!.sufficient).toBe(false);
  });

  it("respects the approach-speed floor", () => {
    // Already at 170 kt: only 10 kt of reduction is left before the 160 floor.
    const plan = planArrivalFix(cfg, pair(4, { finalGsKt: 170 }), OPEN);
    expect(plan.fixes.find((f) => f.kind === "speed")?.gsKt).toBe(160);
  });

  it("offers no speed control at all once at the floor", () => {
    const plan = planArrivalFix(cfg, pair(4, { finalGsKt: 160 }), OPEN);
    expect(plan.fixes.some((f) => f.kind === "speed")).toBe(false);
  });
});

describe("planArrivalFix — when vectoring is not available (§8.9.4.1)", () => {
  it("rules out a vector once the aircraft is established on final", () => {
    // "Vectoring will normally terminate at the time the aircraft leaves the
    // last assigned heading to intercept the final approach track."
    const plan = planArrivalFix(
      cfg,
      pair(8, { establishedOnFinal: true }),
      OPEN,
    );
    expect(plan.vectorBlocked).toBe("established-on-final");
    expect(plan.fixes.some((f) => f.kind === "vector")).toBe(false);
    // Speed is still on the table, and a hold backs it up.
    expect(plan.fixes.map((f) => f.kind)).toContain("hold");
  });

  it("rules out a vector on a closed STAR — there is no published downwind", () => {
    const plan = planArrivalFix(cfg, pair(8), CLOSED);
    expect(plan.vectorBlocked).toBe("not-an-open-star");
    expect(plan.fixes.some((f) => f.kind === "vector")).toBe(false);
  });

  it("rules out a vector for a deficit past the downwind limit", () => {
    const plan = planArrivalFix(cfg, pair(120), OPEN);
    expect(plan.vectorBlocked).toBe("beyond-downwind-limit");
    expect(plan.fixes[0].kind).toBe("hold");
  });

  it("does not flag a block when the vector was merely outranked", () => {
    const plan = planArrivalFix(cfg, pair(1), OPEN);
    expect(plan.vectorBlocked).toBeUndefined();
    expect(plan.fixes.some((f) => f.kind === "vector")).toBe(true);
  });

  it("always leaves a way out — a hold whenever nothing else suffices", () => {
    const plan = planArrivalFix(
      cfg,
      pair(200, { establishedOnFinal: true, finalGsKt: 160 }),
      CLOSED,
    );
    expect(plan.fixes).toHaveLength(1);
    expect(plan.fixes[0].kind).toBe("hold");
  });
});

describe("dialling an instruction to a chosen size", () => {
  // The planner proposes the minimum that clears the deficit — no margin at
  // all. A controller normally wants some, so the builders take the amount.
  const f = arrival();

  it("builds a speed control at the size asked for", () => {
    const small = speedFix(cfg, f, 3, 10)!;
    const big = speedFix(cfg, f, 3, 40)!;
    expect(small.gsKt).toBe(210);
    expect(big.gsKt).toBe(180);
    expect(small.instruction).toContain("reduce speed 10 kt (210 kt)");
    expect(big.absorbsNm).toBeGreaterThan(small.absorbsNm);
  });

  it("never lets a speed control go below the approach floor", () => {
    const slow = arrival({ finalGsKt: 170 });
    expect(maxReductionKt(cfg, slow)).toBe(10);
    // Asking for 40 kt still stops at the floor rather than obeying blindly.
    expect(speedFix(cfg, slow, 3, 40)!.gsKt).toBe(160);
    expect(speedFix(cfg, arrival({ finalGsKt: 160 }), 3, 20)).toBeNull();
  });

  it("builds a vector at the size asked for, and says so in the instruction", () => {
    const v = vectorFix(cfg, f, OPEN, 4, 9);
    expect(v.extendNm).toBe(9);
    expect(v.amount).toBe(9);
    expect(v.amountUnit).toBe("NM");
    // Still the 2:1 downwind relationship in the text.
    expect(v.instruction).toContain("extend downwind 4.5 NM");
    expect(v.instruction).toContain("9.0 NM extra track");
  });

  it("caps a vector at the downwind limit", () => {
    const v = vectorFix(cfg, f, OPEN, 4, 9999);
    expect(v.extendNm).toBe(cfg.finalApproach.maxDownwindExtensionNm);
  });

  it("marks an under-sized instruction as NOT sufficient", () => {
    // Dialling it down below the deficit has to stop claiming it fixes things.
    const under = vectorFix(cfg, f, OPEN, 8, 3);
    expect(under.sufficient).toBe(false);
    const over = vectorFix(cfg, f, OPEN, 8, 10);
    expect(over.sufficient).toBe(true);
  });

  it("reports the amount and its ceiling so the UI can bound the stepper", () => {
    const s = speedFix(cfg, f, 3, 20)!;
    expect(s.amount).toBe(20);
    expect(s.amountUnit).toBe("kt");
    expect(s.maxAmount).toBe(maxReductionKt(cfg, f));
  });

  it("the planner's own proposal is what the builders produce by default", () => {
    // The refactor must not have changed what is proposed.
    const plan = planArrivalFix(cfg, pair(3), OPEN);
    const speed = plan.fixes.find((x) => x.kind === "speed")!;
    const vector = plan.fixes.find((x) => x.kind === "vector")!;
    expect(speed.gsKt).toBe(speedFix(cfg, f, 3, maxReductionKt(cfg, f))!.gsKt);
    expect(vector.extendNm).toBeCloseTo(3, 5);
  });
});

describe("holding — offered up front, not only as a last resort", () => {
  // A controller who can see a long bank coming holds the back of it early,
  // rather than vectoring everyone into a downwind that eventually runs out.
  it("offers a flyable hold even when speed alone already suffices", () => {
    const plan = planArrivalFix(cfg, pair(1), OPEN_HELD);
    const hold = plan.fixes.find((f) => f.kind === "hold");
    expect(hold).toBeDefined();
    expect(hold!.hold?.ident).toBe("MDY");
    // ...without disturbing the ranking: the vector is still what is proposed.
    expect(plan.fixes[0].kind).toBe("vector");
    expect(plan.fixes.map((f) => f.kind)).toEqual(["vector", "speed", "hold"]);
  });

  it("keeps the hold OUT when there is nowhere to hold and something works", () => {
    // Without a published fix ahead there is no clearance to give, so the old
    // last-resort behaviour stands.
    const plan = planArrivalFix(cfg, pair(1), OPEN);
    expect(plan.fixes.some((f) => f.kind === "hold")).toBe(false);
  });

  it("still proposes nothing at all for a pair that is already separated", () => {
    expect(planArrivalFix(cfg, pair(0), OPEN_HELD).fixes).toEqual([]);
  });

  it("carries the fix so it can actually be flown", () => {
    const plan = planArrivalFix(cfg, pair(9), OPEN_HELD);
    const hold = plan.fixes.find((f) => f.kind === "hold")!;
    expect(hold.hold).toEqual(HOLD);
    expect(hold.holdLoops).toBeGreaterThanOrEqual(1);
    expect(hold.instruction).toContain("hold at MDY as published");
    expect(hold.instruction).toContain("right-hand");
  });

  it("converts a loop to track miles at the aircraft's own approach speed", () => {
    // 240 s at 220 kt = 14.67 NM opened per pattern.
    expect(holdNmPerLoop(arrival(), HOLD)).toBeCloseTo(14.667, 2);
  });

  it("sizes the hold in WHOLE loops, rounding up", () => {
    // A racetrack is quantised — you cannot fly 0.3 of one.
    expect(holdLoopsFor(cfg, arrival(), HOLD, 3)).toBe(1);
    expect(holdLoopsFor(cfg, arrival(), HOLD, 14.6)).toBe(1);
    expect(holdLoopsFor(cfg, arrival(), HOLD, 15)).toBe(2);
    expect(holdLoopsFor(cfg, arrival(), HOLD, 40)).toBe(3);
  });

  it("never offers less than one loop, or more than the ceiling", () => {
    expect(holdLoopsFor(cfg, arrival(), HOLD, 0.1)).toBe(1);
    expect(holdLoopsFor(cfg, arrival(), HOLD, 9999)).toBe(
      cfg.finalApproach.maxHoldLoops,
    );
    expect(holdFix(cfg, arrival(), HOLD, 5, 0).amount).toBe(1);
    expect(holdFix(cfg, arrival(), HOLD, 5, 99).amount).toBe(
      cfg.finalApproach.maxHoldLoops,
    );
  });

  it("builds a hold at the number of loops asked for", () => {
    const two = holdFix(cfg, arrival(), HOLD, 5, 2);
    expect(two.holdLoops).toBe(2);
    expect(two.amountUnit).toBe("loop");
    expect(two.absorbsNm).toBeCloseTo(29.33, 1);
    expect(two.instruction).toContain("2 right-hand loops");
    expect(two.instruction).toContain("~8 min");
  });

  it("says honestly when even the ceiling cannot close the gap", () => {
    const big = holdFix(cfg, arrival(), HOLD, 200, cfg.finalApproach.maxHoldLoops);
    expect(big.sufficient).toBe(false);
  });

  it("is the last resort when everything else is ruled out", () => {
    const plan = planArrivalFix(
      cfg,
      pair(30, { establishedOnFinal: true, finalGsKt: 160 }),
      { openStar: false, hold: HOLD },
    );
    expect(plan.fixes).toHaveLength(1);
    expect(plan.fixes[0].kind).toBe("hold");
    expect(plan.fixes[0].sufficient).toBe(true); // 3 loops covers 30 NM
  });
});

describe("the heading in an instruction is the one on the chart", () => {
  // An open-STAR chart note reads "After <fix>, maintain heading 015°". That
  // is a MAGNETIC course; the geometry behind it is 014.3 true, after a 0°42'W
  // variation. Reading the true course back to a controller is the wrong
  // number to transmit — the panel used to say "heading 014".
  it("quotes the published MAGNETIC heading, not the true course", () => {
    const v = vectorFix(cfg, arrival(), OPEN, 4, 4);
    expect(v.instruction).toContain("heading 015");
    expect(v.instruction).not.toContain("heading 014");
  });

  it("falls back to the true course when no magnetic one was published", () => {
    // Better an approximate heading than none — but only as a fallback.
    const v = vectorFix(
      cfg,
      arrival(),
      { openStar: true, vectorHeadingDeg: 14.3 },
      4,
      4,
    );
    expect(v.instruction).toContain("heading 014");
  });

  it("says 'present heading' when the STAR publishes no course at all", () => {
    const v = vectorFix(cfg, arrival(), { openStar: true }, 4, 4);
    expect(v.instruction).toContain("present heading");
  });

  it("pads to three digits, as phraseology requires", () => {
    const v = vectorFix(
      cfg,
      arrival(),
      { openStar: true, vectorHeadingMagDeg: 7 },
      4,
      4,
    );
    expect(v.instruction).toContain("heading 007");
  });
});
