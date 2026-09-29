/**
 * Arrival sequencing + in-trail spacing.
 *
 * The synthetic cases use straight-in arrivals on one meridian so the expected
 * spacing is exact arithmetic; the last block runs a mixed-type, mixed-speed
 * bank of a dozen arrivals into one runway to check the stream-level
 * invariants (order, wake coverage, named drivers, worst-first deficits).
 */
import { describe, expect, it } from "vitest";

import { planArrivalFix } from "./arrivalFix";
import { sequenceArrivals, type ArrivalInput } from "./arrivalSequence";
import { resolveConfig } from "./config";
import type { FutureSample } from "./types";

const cfg = resolveConfig();

/** VYMD RW17 threshold (runway_vy.csv, rounded); all synthetic traffic flies
 *  due south down its meridian towards it, so distance is pure latitude. The
 *  real runway points 171° true — close enough, and the maths stays exact. */
const THR = { lat: 21.72, lon: 95.974 };
const NM_PER_DEG = 60;
const STEP = 10; // seconds between projected samples

/**
 * A straight-in arrival `distNm` out, closing at `gsKt`, sampled every STEP
 * seconds until it reaches the threshold.
 */
function inbound(
  id: string,
  type: string,
  distNm: number,
  gsKt: number,
): ArrivalInput {
  const future: FutureSample[] = [];
  const totalSec = (distNm / gsKt) * 3600;
  for (let dt = 0; dt <= totalSec + STEP; dt += STEP) {
    const flown = Math.min(distNm, (gsKt * Math.min(dt, totalSec)) / 3600);
    future.push({
      dt,
      lat: THR.lat + (distNm - flown) / NM_PER_DEG,
      lon: THR.lon,
      altFt: 3000,
    });
    if (flown >= distNm) break;
  }
  return {
    id,
    callsign: id,
    type,
    ades: "VYMD",
    arrRwy: "RW17",
    threshold: THR,
    future,
    gsKt,
    trackDeg: 180, // tracking south, straight at the threshold
  };
}

/** Offset from the threshold, in NM north/east. */
function at(nmNorth: number, nmEast: number): { lat: number; lon: number } {
  return {
    lat: THR.lat + nmNorth / NM_PER_DEG,
    lon:
      THR.lon +
      nmEast / (NM_PER_DEG * Math.cos((THR.lat * Math.PI) / 180)),
  };
}

/** An arrival flying a multi-leg path (e.g. downwind → base → final) at a
 *  constant ground speed, sampled on the same grid as `inbound`. */
function viaPath(
  id: string,
  type: string,
  legs: { lat: number; lon: number }[],
  gsKt: number,
): ArrivalInput {
  const cum = [0];
  for (let i = 1; i < legs.length; i++) {
    const dLat = (legs[i].lat - legs[i - 1].lat) * NM_PER_DEG;
    const dLon =
      (legs[i].lon - legs[i - 1].lon) *
      NM_PER_DEG *
      Math.cos((((legs[i].lat + legs[i - 1].lat) / 2) * Math.PI) / 180);
    cum.push(cum[i - 1] + Math.hypot(dLat, dLon));
  }
  const total = cum[cum.length - 1];
  const future: FutureSample[] = [];
  for (let dt = 0; ; dt += STEP) {
    const s = Math.min(total, (gsKt * dt) / 3600);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    future.push({
      dt,
      lat: legs[i - 1].lat + (legs[i].lat - legs[i - 1].lat) * f,
      lon: legs[i - 1].lon + (legs[i].lon - legs[i - 1].lon) * f,
      altFt: 3000,
    });
    if (s >= total) break;
  }
  const brg = Math.atan2(
    (legs[1].lon - legs[0].lon) * Math.cos((THR.lat * Math.PI) / 180),
    legs[1].lat - legs[0].lat,
  );
  return {
    id,
    callsign: id,
    type,
    ades: "VYMD",
    arrRwy: "RW17",
    threshold: THR,
    future,
    gsKt,
    trackDeg: ((brg * 180) / Math.PI + 360) % 360,
  };
}

describe("sequenceArrivals — landing order", () => {
  it("orders by ETA at the threshold and numbers the sequence", () => {
    const streams = sequenceArrivals(cfg, [
      inbound("C", "A320", 30, 180),
      inbound("A", "A320", 10, 180),
      inbound("B", "A320", 20, 180),
    ]);
    expect(streams).toHaveLength(1);
    expect(streams[0].ades).toBe("VYMD");
    expect(streams[0].runway).toBe("RW17");
    expect(streams[0].arrivals.map((a) => a.id)).toEqual(["A", "B", "C"]);
    expect(streams[0].arrivals.map((a) => a.position)).toEqual([1, 2, 3]);
  });

  it("keeps one stream per runway — arrivals to different runways do not "
    + "sequence against each other", () => {
    const other = { ...inbound("D", "A320", 12, 180), arrRwy: "RW35" };
    const streams = sequenceArrivals(cfg, [inbound("A", "A320", 10, 180), other]);
    expect(streams.map((s) => s.runway).sort()).toEqual(["RW17", "RW35"]);
    for (const s of streams) expect(s.pairs).toHaveLength(0);
  });

  it("skips flights that cannot be sequenced", () => {
    const noThreshold = { ...inbound("X", "A320", 10, 180), threshold: null };
    const noRunway = { ...inbound("Y", "A320", 12, 180), arrRwy: "" };
    const streams = sequenceArrivals(cfg, [
      noThreshold,
      noRunway,
      inbound("A", "A320", 15, 180),
    ]);
    expect(streams).toHaveLength(1);
    expect(streams[0].arrivals.map((a) => a.id)).toEqual(["A"]);
  });

  it("computes distance-to-go and approach speed from the projected path", () => {
    const [s] = sequenceArrivals(cfg, [inbound("A", "A320", 20, 180)]);
    const a = s.arrivals[0];
    expect(a.distToGoNm).toBeCloseTo(20, 1);
    expect(a.etaSec).toBeCloseTo((20 / 180) * 3600, 0); // 400 s
    expect(a.finalGsKt).toBeCloseTo(180, 0);
    expect(a.etaEstimated).toBe(false);
  });
});

describe("sequenceArrivals — spacing measurement", () => {
  it("measures spacing as the follower's distance to go when the leader lands", () => {
    // Both at 180 kt; follower 8 NM further out → 8 NM behind at touchdown.
    const [s] = sequenceArrivals(cfg, [
      inbound("LEAD", "A320", 10, 180),
      inbound("FOLLOW", "A320", 18, 180),
    ]);
    expect(s.pairs).toHaveLength(1);
    const p = s.pairs[0];
    expect(p.leader.id).toBe("LEAD");
    expect(p.follower.id).toBe("FOLLOW");
    expect(p.spacingNm).toBeCloseTo(8, 1);
    expect(p.estimated).toBe(false);
  });

  it("accounts for a faster follower closing the gap before touchdown", () => {
    // Follower starts 12 NM further out but 60 kt faster, so by the time the
    // leader lands it has eaten most of that — the distance gap at the leader's
    // touchdown is what matters, not the gap right now.
    const [s] = sequenceArrivals(cfg, [
      inbound("LEAD", "A320", 12, 160),
      inbound("FOLLOW", "A320", 24, 220),
    ]);
    const p = s.pairs[0];
    // Leader lands at 270 s; follower has flown 220 kt × 270 s = 16.5 NM of 24.
    expect(p.spacingNm).toBeCloseTo(7.5, 1);
    expect(p.spacingNm).toBeLessThan(12); // it closed, not held, the 12 NM
  });
});

describe("sequenceArrivals — required minima (Doc 4444 §8.7.3)", () => {
  it("applies the 2.5 NM reduced minimum once both are established on final", () => {
    // Both inside 10 NM, tracking straight at the threshold.
    const [s] = sequenceArrivals(cfg, [
      inbound("LEAD", "A320", 4, 140),
      inbound("FOLLOW", "A320", 8, 140),
    ]);
    const p = s.pairs[0];
    expect(p.leader.establishedOnFinal).toBe(true);
    expect(p.follower.establishedOnFinal).toBe(true);
    expect(p.minima.radarNm).toBe(2.5);
  });

  it("does NOT reduce when the follower is still outside 10 NM as the leader "
    + "lands — §8.7.3.2 b) is tested where the pair is AT THAT INSTANT", () => {
    // Leader 25 NM out lands at 360 s; by then the follower (40 NM out, same
    // speed) has flown 25 NM and is still 15 NM from the threshold.
    const [s] = sequenceArrivals(cfg, [
      inbound("LEAD", "A320", 25, 250),
      inbound("FOLLOW", "A320", 40, 250),
    ]);
    const p = s.pairs[0];
    expect(p.spacingNm).toBeCloseTo(15, 1);
    expect(p.minima.radarNm).toBe(cfg.horizontal.enrouteNm);
  });

  it("does NOT reduce for a follower still on base — inside 10 NM but not "
    + "tracking the final approach track", () => {
    // Leader lands at ~103 s. The follower is then ~4 NM along an 8 NM base
    // leg, 8.2 NM from the threshold (inside 10) but tracking west across it.
    const base = viaPath(
      "FOLLOW",
      "A320",
      [at(8, 6), at(8, -2), THR],
      140,
    );
    const [s] = sequenceArrivals(cfg, [inbound("LEAD", "A320", 4, 140), base]);
    // Note the follower is only 8.2 NM from the threshold in a straight line
    // but still has 11.8 NM of TRACK to fly — the gap between the two is the
    // base leg, and it is exactly why it is not yet established.
    expect(s.pairs[0].spacingNm).toBeGreaterThan(
      cfg.finalApproach.reducedWithinNm,
    );
    expect(s.pairs[0].minima.radarNm).toBe(cfg.horizontal.enrouteNm);
  });

  it("DOES reduce once that same follower has turned onto final", () => {
    // Same geometry, but the leader lands later (it starts further out), by
    // which time the follower is established inbound on the centreline.
    const base = viaPath("FOLLOW", "A320", [at(8, 6), at(8, -2), THR], 140);
    const [s] = sequenceArrivals(cfg, [inbound("LEAD", "A320", 12, 140), base]);
    expect(s.pairs[0].minima.radarNm).toBe(cfg.finalApproach.reducedNm);
  });

  it("resolves the position-dependent minimum WHERE THE PAIR IS AT TOUCHDOWN, "
    + "not where the follower is now", () => {
    // 3 NM inside a TMA, 5 NM en-route. An arrival still an hour out
    // is en-route RIGHT NOW, but the gap being measured is the one it will have
    // on final — inside the TMA. Charging it 5 NM would invent a deficit that
    // the aircraft never actually has.
    const TMA_RADIUS_NM = 40;
    const inTma = (lat: number, lon: number) =>
      Math.hypot((lat - THR.lat) * 60, (lon - THR.lon) * 60 * Math.cos((THR.lat * Math.PI) / 180)) < TMA_RADIUS_NM;
    const cfgTma = resolveConfig({
      sepMinNmAt: (lat: number, lon: number) => (inTma(lat, lon) ? 3 : 5),
    });

    // Both start well outside the TMA (60 and 80 NM out). At the leader's
    // touchdown the follower is 20 NM from the threshold: inside the 40 NM TMA,
    // but still outside the 10 NM that would earn the reduced 2.5 NM — so this
    // isolates the position-dependent minimum itself.
    const [s] = sequenceArrivals(cfgTma, [
      inbound("LEAD", "A320", 60, 300),
      inbound("FOLLOW", "A320", 80, 300),
    ]);
    const p = s.pairs[0];
    expect(p.spacingNm).toBeCloseTo(20, 1);
    expect(p.minima.radarNm).toBe(3); // TMA, not the en-route 5
    // Reading it at the follower's CURRENT position (80 NM out, en-route)
    // would have charged 5 NM instead.
    expect(sequenceArrivals(cfg, [
      inbound("LEAD", "A320", 60, 300),
      inbound("FOLLOW", "A320", 80, 300),
    ])[0].pairs[0].minima.radarNm).toBe(5);
  });

  it("still applies the en-route minimum when the pair is far out at touchdown", () => {
    const cfgTma = resolveConfig({
      sepMinNmAt: (lat: number, lon: number) =>
        Math.hypot((lat - THR.lat) * 60, (lon - THR.lon) * 60 * Math.cos((THR.lat * Math.PI) / 180)) < 40 ? 3 : 5,
    });
    // The follower is still 45 NM out when the leader lands — outside the TMA.
    const [s] = sequenceArrivals(cfgTma, [
      inbound("LEAD", "A320", 20, 300),
      inbound("FOLLOW", "A320", 65, 300),
    ]);
    expect(s.pairs[0].minima.radarNm).toBe(5);
  });

  it("lets the wake minimum govern a MEDIUM behind a HEAVY", () => {
    // 3 NM apart, both established: radar would allow 2.5 NM, but §8.7.3.4
    // demands 5 NM for a MEDIUM behind a HEAVY → a 2 NM deficit.
    const [s] = sequenceArrivals(cfg, [
      inbound("HEAVY1", "B77W", 5, 150),
      inbound("MED1", "A320", 8, 150),
    ]);
    const p = s.pairs[0];
    expect(p.spacingNm).toBeCloseTo(3, 1);
    expect(p.requiredBy).toBe("wake");
    expect(p.requiredNm).toBe(5);
    expect(p.deficitNm).toBeCloseTo(2, 1);
    expect(s.deficits).toHaveLength(1);
  });

  it("reports no deficit when a HEAVY follows a HEAVY at 4 NM", () => {
    const [s] = sequenceArrivals(cfg, [
      inbound("H1", "B77W", 5, 150),
      inbound("H2", "B789", 9.2, 150),
    ]);
    const p = s.pairs[0];
    expect(p.requiredNm).toBe(4); // H behind H
    expect(p.deficitNm).toBe(0);
    expect(s.deficits).toHaveLength(0);
  });

  it("lets runway occupancy govern a slow pair with no wake constraint", () => {
    // Two MEDIUMs (no wake minimum) at 120 kt: 60 s of occupancy = 2 NM, which
    // beats the 2.5 NM reduced radar minimum only if we raise the ROT.
    const slowCfg = resolveConfig({
      finalApproach: { runwayOccupancySec: 120 },
    });
    const [s] = sequenceArrivals(slowCfg, [
      inbound("A", "A320", 4, 120),
      inbound("B", "B738", 7, 120),
    ]);
    const p = s.pairs[0];
    expect(p.minima.runwayOccupancyNm).toBeCloseTo(4, 1); // 120 s at 120 kt
    expect(p.requiredBy).toBe("runway-occupancy");
    expect(p.deficitNm).toBeCloseTo(1, 1);
  });

  it("exposes every applicable minimum so the number is explainable", () => {
    const [s] = sequenceArrivals(cfg, [
      inbound("HEAVY1", "B77W", 5, 150),
      inbound("MED1", "A320", 8, 150),
    ]);
    const m = s.pairs[0].minima;
    expect(m.radarNm).toBe(2.5);
    expect(m.wakeNm).toBe(5);
    expect(m.runwayOccupancyNm).toBeGreaterThan(0);
  });

  it("flags an estimated spacing when a path runs past the projection window", () => {
    // Truncate the follower's projection well short of the threshold.
    const follower = inbound("FOLLOW", "A320", 40, 200);
    follower.future = follower.future.slice(0, 5); // ~1.1 NM of a 40 NM run
    const [s] = sequenceArrivals(cfg, [inbound("LEAD", "A320", 10, 200), follower]);
    expect(s.arrivals.find((a) => a.id === "FOLLOW")?.etaEstimated).toBe(true);
    expect(s.pairs[0].estimated).toBe(true);
    expect(s.pairs[0].spacingNm).toBeGreaterThan(0);
  });
});

describe("sequenceArrivals — a mixed arrival bank into one runway", () => {
  // A dozen straight-ins to VYMD RW17 with mixed wake categories and speeds,
  // so it is one runway stream and every consecutive pair is a real in-trail
  // case. Some pairs are deliberately tight (they must show as deficits).
  const BANK: [string, string, number, number][] = [
    ["UBA101", "A320", 8, 160],
    ["MMA202", "AT72", 12, 150],
    ["KMV303", "B77W", 15, 180],
    ["UBA404", "A320", 18, 170], // 3 NM behind a HEAVY: wake deficit
    ["MMA505", "A321", 26, 200],
    ["UBA606", "AT72", 30, 170],
    ["KMV707", "A388", 38, 220],
    ["MMA808", "A320", 43, 220], // 5 NM behind a SUPER: short of 7
    ["UBA909", "B738", 55, 240],
    ["MMA110", "E190", 58, 240],
    ["KMV211", "A333", 70, 250],
    ["UBA312", "A320", 82, 250],
  ];
  const inputs: ArrivalInput[] = BANK.map(([id, type, dist, gs]) =>
    inbound(id, type, dist, gs),
  );
  const streams = sequenceArrivals(cfg, inputs);
  const N = BANK.length;

  it("builds one VYMD RW17 stream holding every arrival", () => {
    expect(streams).toHaveLength(1);
    expect(streams[0].ades).toBe("VYMD");
    expect(streams[0].runway).toBe("RW17");
    expect(streams[0].arrivals).toHaveLength(N);
    expect(streams[0].pairs).toHaveLength(N - 1);
  });

  it("produces a strictly increasing landing order", () => {
    const etas = streams[0].arrivals.map((a) => a.etaSec);
    expect(etas).toEqual([...etas].sort((x, y) => x - y));
    expect(streams[0].arrivals.map((a) => a.position)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  it("assigns a known wake category to every aircraft type in the bank", () => {
    for (const a of streams[0].arrivals) {
      expect(a.wakeKnown, `${a.callsign} (${a.type})`).toBe(true);
    }
  });

  it("gives every pair a positive requirement with a named driver", () => {
    for (const p of streams[0].pairs) {
      expect(p.requiredNm).toBeGreaterThan(0);
      expect(["radar", "wake", "runway-occupancy"]).toContain(p.requiredBy);
      expect(p.deficitNm).toBeGreaterThanOrEqual(0);
      expect(p.gapSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("mixes wake categories so the §8.7.3.4 minima actually bind", () => {
    const wakes = new Set(streams[0].arrivals.map((a) => a.wake));
    expect([...wakes].sort()).toEqual(["HEAVY", "MEDIUM", "SUPER"]);
    expect(streams[0].pairs.some((p) => p.requiredBy === "wake")).toBe(true);
  });

  it("is neither all-legal nor all-illegal — a MIX to sequence", () => {
    expect(streams[0].deficits.length).toBeGreaterThan(0);
    expect(streams[0].deficits.length).toBeLessThan(streams[0].pairs.length);
  });

  it("measures spacing from the paths, never falling back to an estimate", () => {
    for (const p of streams[0].pairs) expect(p.estimated).toBe(false);
  });

  it("yields an actionable instruction for every deficit", () => {
    for (const p of streams[0].deficits) {
      const plan = planArrivalFix(cfg, p, { openStar: true, vectorHeadingDeg: 15 });
      expect(plan.fixes.length).toBeGreaterThan(0);
      expect(plan.fixes.some((f) => f.sufficient)).toBe(true);
      expect(plan.fixes[0].target).toBe(p.follower.id);
    }
  });

  it("ranks deficits worst-first, and every one is a genuine shortfall", () => {
    const d = streams[0].deficits;
    expect(d.length).toBeGreaterThan(0);
    for (let i = 1; i < d.length; i++) {
      expect(d[i - 1].deficitNm).toBeGreaterThanOrEqual(d[i].deficitNm);
    }
    for (const p of d) {
      expect(p.deficitNm).toBeGreaterThan(0);
      expect(p.spacingNm).toBeLessThan(p.requiredNm);
    }
  });
});
