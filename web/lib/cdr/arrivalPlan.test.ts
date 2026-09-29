/** Stream-wide sequencing: does the delay actually cascade? */
import { describe, expect, it } from "vitest";

import { planArrivalStream } from "./arrivalPlan";
import type {
  ArrivalPairSpacing,
  RunwayStream,
  SequencedArrival,
} from "./arrivalSequence";
import { resolveConfig } from "./config";

const cfg = resolveConfig();
const GS = 180; // kt — 1 NM = 20 s, so the arithmetic stays checkable by hand

function ac(id: string, etaSec: number, over: Partial<SequencedArrival> = {}) {
  return {
    id,
    callsign: id,
    type: "A320",
    adep: "VYMK",
    ades: "VYMD",
    star: "DOGI1E",
    wake: "MEDIUM" as const,
    wakeKnown: true,
    etaSec,
    distToGoNm: (etaSec / 3600) * GS,
    finalGsKt: GS,
    position: 0,
    etaEstimated: false,
    establishedOnFinal: false,
    ...over,
  };
}

/** Build a stream from ETAs (seconds) with one required spacing for all. */
function stream(etas: number[], requiredNm = 5): RunwayStream {
  const arrivals = etas.map((t, i) => ({ ...ac(`A${i + 1}`, t), position: i + 1 }));
  const pairs: ArrivalPairSpacing[] = [];
  for (let i = 1; i < arrivals.length; i++) {
    const spacingNm = ((arrivals[i].etaSec - arrivals[i - 1].etaSec) / 3600) * GS;
    pairs.push({
      leader: arrivals[i - 1],
      follower: arrivals[i],
      gapSec: arrivals[i].etaSec - arrivals[i - 1].etaSec,
      spacingNm,
      requiredNm,
      requiredBy: "wake",
      minima: { radarNm: 3, wakeNm: requiredNm, runwayOccupancyNm: 2 },
      deficitNm: Math.max(0, requiredNm - spacingNm),
      estimated: false,
    });
  }
  return {
    ades: "VYMD",
    runway: "RW17",
    arrivals,
    pairs,
    deficits: pairs.filter((p) => p.deficitNm > 0),
  };
}

describe("planArrivalStream", () => {
  it("leaves a comfortably separated bank alone", () => {
    // 10 NM apart, 5 NM required.
    const plan = planArrivalStream(cfg, stream([0, 200, 400], 5));
    expect(plan.actions).toEqual([]);
    expect(plan.totalDelayNm).toBe(0);
    for (const p of plan.order) expect(p.fixes).toEqual([]);
  });

  it("never instructs the first aircraft — it has nothing in front", () => {
    const plan = planArrivalStream(cfg, stream([0, 20, 40], 5));
    expect(plan.order[0].delayNm).toBe(0);
    expect(plan.order[0].pair).toBeNull();
  });

  it("reduces to the pairwise deficit for a single tight pair", () => {
    // 3 NM apart (60 s at 180 kt), 5 NM required -> 2 NM short.
    const plan = planArrivalStream(cfg, stream([0, 60], 5));
    expect(plan.order[1].delayNm).toBeCloseTo(2, 3);
    expect(plan.order[1].delaySec).toBeCloseTo(40, 1);
    expect(plan.order[1].inheritedNm).toBeCloseTo(0, 3);
  });

  it("CASCADES: fixing one pair pushes the aircraft behind it too", () => {
    // #1 and #2 are 2 NM apart (short by 3). #2 and #3 are 5 NM apart — legal
    // on their own. But #2 must be delayed 3 NM, which eats #3's whole gap, so
    // #3 has to be delayed as well even though its pair showed NO deficit.
    const s = stream([0, 40, 140], 5);
    expect(s.pairs[0].deficitNm).toBeCloseTo(3, 3); // #1->#2 short
    expect(s.pairs[1].deficitNm).toBeCloseTo(0, 3); // #2->#3 fine, in isolation

    const plan = planArrivalStream(cfg, s);
    expect(plan.order[1].delayNm).toBeCloseTo(3, 3);
    // The pairwise view would say #3 needs nothing. The stream says otherwise.
    expect(plan.order[2].delayNm).toBeCloseTo(3, 3);
    expect(plan.order[2].inheritedNm).toBeCloseTo(3, 3);
    expect(plan.order[2].pair!.deficitNm).toBeCloseTo(0, 3);
  });

  it("does not push an aircraft that already has room after the fix ahead", () => {
    // #2 delayed 3 NM, but #3 sits 10 NM behind #2 — plenty of slack to absorb
    // it. A blanket "everyone behind moves too" would over-delay the bank.
    const plan = planArrivalStream(cfg, stream([0, 40, 240], 5));
    expect(plan.order[1].delayNm).toBeCloseTo(3, 3);
    expect(plan.order[2].delayNm).toBe(0);
    expect(plan.order[2].fixes).toEqual([]);
  });

  it("accumulates through a run of tight pairs", () => {
    // Four aircraft 2 NM apart, 5 NM required: each needs 3 NM MORE than the
    // one before, because the fix ahead of it has moved the target.
    const plan = planArrivalStream(cfg, stream([0, 40, 80, 120], 5));
    const delays = plan.order.map((p) => Number(p.delayNm.toFixed(3)));
    expect(delays).toEqual([0, 3, 6, 9]);
    expect(plan.totalDelayNm).toBeCloseTo(18, 3);
  });

  it("plans the fix against the STREAM delay, not the pair's own deficit", () => {
    const plan = planArrivalStream(cfg, stream([0, 40, 80], 5), () => ({
      openStar: true,
      vectorHeadingDeg: 15,
    }));
    const third = plan.order[2];
    expect(third.pair!.deficitNm).toBeCloseTo(3, 3);
    expect(third.delayNm).toBeCloseTo(6, 3); // 3 of its own + 3 inherited
    const vector = third.fixes.find((f) => f.kind === "vector");
    expect(vector?.extendNm).toBeCloseTo(6, 3); // not 3
  });

  it("ranks actions worst-delay first", () => {
    const plan = planArrivalStream(cfg, stream([0, 40, 80, 120], 5));
    const d = plan.actions.map((a) => a.delayNm);
    expect(d).toEqual([...d].sort((x, y) => y - x));
    expect(plan.actions[0].arrival.id).toBe("A4");
  });

  it("offers vectoring only where the context allows it", () => {
    const openOnly = (id: string) =>
      id === "A2" ? { openStar: true, vectorHeadingDeg: 15 } : { openStar: false };
    const plan = planArrivalStream(cfg, stream([0, 40, 80], 5), openOnly);
    expect(plan.order[1].fixes.some((f) => f.kind === "vector")).toBe(true);
    expect(plan.order[2].fixes.some((f) => f.kind === "vector")).toBe(false);
  });
});
