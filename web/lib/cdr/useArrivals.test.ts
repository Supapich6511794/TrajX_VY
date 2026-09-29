/**
 * The live-traffic side of arrival sequencing: does `collectArrivals` pick the
 * right flights out of a mixed timeline, and does the whole chain produce a
 * plan from real trajectory shapes?
 *
 * `collectArrivals` is the part with all the conditions in it — the hook around
 * it is just memoisation — so it is what gets tested.
 */
import { describe, expect, it } from "vitest";

import { planArrivals } from "./arrivalPlan";
import { sequenceArrivals } from "./arrivalSequence";
import { resolveConfig } from "./config";
import { collectArrivals, nextHoldOnRoute } from "./useArrivals";
import type { Holding } from "@/lib/holdings";
import type { TrajectoryResult, TrajectoryPoint } from "@/lib/trajectory/types";

const cfg = resolveConfig();
const THR = { lat: 21.72005833, lon: 95.97401111 }; // VYMD RW17
const NM = 60;

/** A straight-in arrival: `distNm` out, closing at `gsKt`, 1 sample / 10 s. */
function arrival(
  key: string,
  distNm: number,
  gsKt = 180,
  over: Partial<TrajectoryResult["meta"]> = {},
): TrajectoryResult {
  const points: TrajectoryPoint[] = [];
  const totalSec = (distNm / gsKt) * 3600;
  for (let t = 0; t <= totalSec; t += 10) {
    const flown = (gsKt * t) / 3600;
    points.push({
      lat: THR.lat + (distNm - flown) / NM,
      lon: THR.lon,
      epoch_ts: new Date(Date.UTC(2025, 11, 23, 0, 0, 0) + t * 1000).toISOString(),
      altitude_ft: 3000,
      gs_kt: gsKt,
      track_deg: 180,
      phase: "descent",
    });
  }
  return {
    route: [],
    points,
    stats: {
      waypointCount: 0,
      pointCount: points.length,
      distanceNm: distNm,
      timeMinutes: totalSec / 60,
    } as TrajectoryResult["stats"],
    profile: null as unknown as TrajectoryResult["profile"],
    validation: null,
    meta: {
      flightKey: key,
      callsign: key,
      aircraftType: "A320",
      adep: "VYMK",
      ades: "VYMD",
      eobtIso: "2025-12-23T00:00:00Z",
      arrRwy: "RW17",
      arrThreshold: THR,
      starOpen: true,
      vectorHeadingDeg: 14.3,
      ...over,
    },
  };
}

/** The sample table + offsets MapApp builds, for a set of trajectories. */
function tables(trajs: TrajectoryResult[]) {
  const samplesByIdx = trajs.map((t) =>
    t.points.map((p, i) => ({
      t: i * 10,
      lat: p.lat,
      lon: p.lon,
      altitudeFt: p.altitude_ft,
      gsKt: p.gs_kt,
      tasKt: p.tas_kt ?? p.gs_kt,
      track: p.track_deg,
      phase: p.phase,
    })),
  );
  return { samplesByIdx, offsets: trajs.map(() => 0) };
}

function collect(
  trajs: TrajectoryResult[],
  simSec = 0,
  holdings?: Map<string, Holding>,
) {
  const { samplesByIdx, offsets } = tables(trajs);
  return collectArrivals(
    trajs,
    samplesByIdx,
    offsets,
    simSec,
    10,
    undefined,
    holdings,
  );
}

/** A published holding at a point `distNm` out on the straight-in track above. */
function holdingAt(ident: string, distNm: number): Holding {
  return {
    ident,
    lat: THR.lat + distNm / NM,
    lon: THR.lon,
    inboundCourseDeg: 180,
    turn: "R",
    legTimeMin: 1,
    legLengthNm: null,
    speedKt: null,
    minAltFt: null,
    maxAltFt: null,
  };
}

/** The trajectory above, with the given fixes named on its route. */
function withRoute(t: TrajectoryResult, hs: Holding[]): TrajectoryResult {
  return {
    ...t,
    route: hs.map((h) => ({ ident: h.ident, lat: h.lat, lon: h.lon })),
  };
}

describe("collectArrivals", () => {
  it("takes arrivals that have a resolved runway and threshold", () => {
    const { inputs } = collect([arrival("A", 20), arrival("B", 30)]);
    expect(inputs.map((i) => i.id)).toEqual(["A", "B"]);
    expect(inputs[0].arrRwy).toBe("RW17");
    expect(inputs[0].threshold).toEqual(THR);
  });

  it("carries the city pair and the STAR onto the sequenced arrival", () => {
    // The ladder row names the flow an aircraft is on, so ADEP/ADES/STAR have
    // to survive collect -> sequence. A flight with no coded STAR keeps the
    // field empty rather than inheriting anyone else's.
    const withStar = arrival("A", 20, 180, { star: "DOGI1E" });
    const direct = arrival("B", 30, 180, { adep: "VYHH" });
    const [stream] = sequenceArrivals(cfg, collect([withStar, direct]).inputs);
    const byId = new Map(stream.arrivals.map((a) => [a.id, a]));
    expect(byId.get("A")).toMatchObject({
      adep: "VYMK",
      ades: "VYMD",
      star: "DOGI1E",
    });
    expect(byId.get("B")).toMatchObject({ adep: "VYHH", ades: "VYMD" });
    expect(byId.get("B")!.star).toBeUndefined();
  });

  it("skips a flight whose landing runway was never resolved", () => {
    // A departure or an overflight has no arrival runway, and neither does an
    // arrival the generator could not resolve one for. Guessing would put it
    // in someone else's landing sequence.
    const noRwy = arrival("X", 20, 180, { arrRwy: undefined });
    const noThr = arrival("Y", 25, 180, { arrThreshold: undefined });
    const { inputs } = collect([noRwy, noThr, arrival("Z", 30)]);
    expect(inputs.map((i) => i.id)).toEqual(["Z"]);
  });

  it("carries the vectoring context through per flight", () => {
    const closed = arrival("C", 25, 180, {
      starOpen: false,
      vectorHeadingDeg: undefined,
    });
    const { contexts } = collect([arrival("O", 20), closed]);
    expect(contexts.get("O")).toEqual({ openStar: true, vectorHeadingDeg: 14.3 });
    expect(contexts.get("C")).toEqual({
      openStar: false,
      vectorHeadingDeg: undefined,
    });
  });

  it("takes the approach speed from the trajectory's own last sample", () => {
    // Positions and reported speed can disagree on the descent; the reported
    // one is what the performance model flew.
    const { inputs } = collect([arrival("A", 20, 150)]);
    expect(inputs[0].finalGsKt).toBeCloseTo(150, 0);
  });

  it("projects ALL THE WAY to touchdown, so the ETA is measured not guessed", () => {
    // The landing order and the spacing are both decided at the threshold. A
    // fixed look-ahead would leave anything further out with a straight-line
    // guess at current ground speed — and could order the bank wrongly.
    const { inputs } = collect([arrival("A", 300, 450)]); // 40 min out
    const f = inputs[0].future;
    const last = f[f.length - 1];
    // Ends ON the runway, not 10 minutes short of it.
    expect(last.lat).toBeCloseTo(THR.lat, 3);
    expect(last.dt).toBeCloseTo((300 / 450) * 3600, 0);
  });

  it("coarsens a long leg rather than cutting it short", () => {
    // Truncating would put the ETA back to a guess; a coarser path still
    // reaches the threshold.
    const { inputs } = collect([arrival("A", 900, 450)]); // 2 h at 10 s = 720
    const f = inputs[0].future;
    expect(f.length).toBeLessThanOrEqual(900);
    expect(f[f.length - 1].lat).toBeCloseTo(THR.lat, 3);
  });

  it("drops a flight that has already landed at this clock", () => {
    // 20 NM at 180 kt = 400 s; well past that it is no longer traffic.
    const { inputs } = collect([arrival("A", 20), arrival("B", 60)], 500);
    expect(inputs.map((i) => i.id)).toEqual(["B"]);
  });
});

describe("collectArrivals -> sequence -> plan", () => {
  it("produces a resolved landing order with instructions", () => {
    // Three arrivals 2 NM apart at 180 kt — inside the minima, so the stream
    // has to absorb delay, and the third inherits the second's.
    const trajs = [arrival("A1", 10), arrival("A2", 12), arrival("A3", 14)];
    const { inputs, contexts } = collect(trajs);
    const plans = planArrivals(
      cfg,
      sequenceArrivals(cfg, inputs),
      (id) => contexts.get(id) ?? { openStar: false },
    );
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.ades).toBe("VYMD");
    expect(plan.runway).toBe("RW17");
    expect(plan.order.map((p) => p.arrival.callsign)).toEqual(["A1", "A2", "A3"]);

    // First lands unimpeded; the two behind need room.
    expect(plan.order[0].delayNm).toBe(0);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.order[2].delayNm).toBeGreaterThan(plan.order[1].delayNm);
    expect(plan.order[2].inheritedNm).toBeGreaterThan(0);

    // And every action carries a flyable instruction naming the aircraft.
    for (const a of plan.actions) {
      expect(a.fixes.length).toBeGreaterThan(0);
      expect(a.fixes[0].instruction).toContain(a.arrival.callsign);
    }
  });

  it("keeps separate runways in separate sequences", () => {
    const other = arrival("B1", 12, 180, { arrRwy: "RW35" });
    const { inputs } = collect([arrival("A1", 10), other]);
    const plans = planArrivals(cfg, sequenceArrivals(cfg, inputs));
    expect(plans.map((p) => p.runway).sort()).toEqual(["RW17", "RW35"]);
    for (const p of plans) expect(p.actions).toEqual([]);
  });
});

describe("nextHoldOnRoute — where an arrival can actually be held", () => {
  const holdings = new Map<string, Holding>([
    ["FAR", holdingAt("FAR", 45)],
    ["NEAR", holdingAt("NEAR", 20)],
  ]);
  const base = arrival("A", 60, 180); // 60 NM out at 180 kt = 20 min to run
  const traj = withRoute(base, [holdings.get("FAR")!, holdings.get("NEAR")!]);
  const { samplesByIdx } = tables([traj]);
  const samples = samplesByIdx[0];

  it("offers the EARLIEST fix ahead — the one it reaches next", () => {
    // Holding early is the whole point: the far fix comes first.
    const h = nextHoldOnRoute(traj, samples, 0, holdings);
    expect(h?.ident).toBe("FAR");
    // 15 NM flown to reach it at 180 kt = 300 s.
    expect(h?.tManSec).toBeCloseTo(300, -1);
  });

  it("moves on to the next fix once the first is behind", () => {
    // 6 minutes in, FAR is passed; NEAR is what is left.
    const h = nextHoldOnRoute(traj, samples, 400, holdings);
    expect(h?.ident).toBe("NEAR");
  });

  it("offers nothing once every fix is behind", () => {
    expect(nextHoldOnRoute(traj, samples, 1000, holdings)).toBeNull();
  });

  it("will not offer a fix the aircraft is about to cross", () => {
    // Inside the lead time the instruction cannot be flown — by the time it is
    // read the fix is behind.
    expect(nextHoldOnRoute(traj, samples, 280, holdings)?.ident).toBe("NEAR");
  });

  it("offers nothing while the aircraft is still climbing out", () => {
    // Nobody holds a departure. A published fix crossed on the way up is not an
    // instruction anyone gives, however much spacing is wanted later on.
    const climbing = {
      ...traj,
      points: traj.points.map((p) => ({ ...p, phase: "climb" as const })),
    };
    const { samplesByIdx: climbSamples } = tables([climbing]);
    expect(nextHoldOnRoute(climbing, climbSamples[0], 0, holdings)).toBeNull();
  });

  it("opens the menu where the STAR does, not at top of descent", () => {
    // On a domestic leg top of descent can fall several minutes and several
    // en-route fixes BEFORE the STAR is joined, so TOD alone still offered a
    // hold out in the cruise. The server names the STAR's first fix; from there
    // on is the arrival, and that is where holding belongs.
    const onStar = {
      ...traj,
      meta: { ...traj.meta, starEntry: "NEAR" },
    } as TrajectoryResult;
    // FAR is the earliest fix ahead and would win on time alone — but it is
    // en route, and the STAR starts at NEAR.
    expect(nextHoldOnRoute(onStar, samples, 0, holdings)?.ident).toBe("NEAR");
  });

  it("falls back to top of descent when no STAR entry is published", () => {
    // FAR is crossed 300 s in and NEAR at 600 s. With top of descent at 400 s,
    // FAR belongs to the cruise and only NEAR is an arrival hold.
    const t0 = Date.parse(traj.points[0].epoch_ts);
    const withTod = {
      ...traj,
      profile: {
        toc: null,
        tod: {
          lat: THR.lat,
          lon: THR.lon,
          altitudeFt: 20000,
          epochTs: new Date(t0 + 400_000).toISOString(),
        },
      },
    } as TrajectoryResult;
    expect(nextHoldOnRoute(withTod, samples, 0, holdings)?.ident).toBe("NEAR");
    // …and with it early, the earliest fix ahead is on the menu again.
    const earlyTod = {
      ...withTod,
      profile: {
        toc: null,
        tod: { ...withTod.profile.tod!, epochTs: new Date(t0).toISOString() },
      },
    } as TrajectoryResult;
    expect(nextHoldOnRoute(earlyTod, samples, 0, holdings)?.ident).toBe("FAR");
  });

  it("ignores route fixes with no published holding", () => {
    const plain = withRoute(base, [holdingAt("NOHOLD", 50)]);
    expect(nextHoldOnRoute(plain, samples, 0, holdings)).toBeNull();
  });

  it("codes the published pattern into a flyable loop", () => {
    const h = nextHoldOnRoute(traj, samples, 0, holdings)!;
    expect(h.turn).toBe("R");
    expect(h.inboundCourseDeg).toBe(180);
    // 1-minute legs + two 180° turns at standard rate = a 4-minute racetrack.
    expect(h.legSec).toBe(60);
    expect(h.loopSec).toBe(240);
  });

  it("reaches the fix planner, so a hold can be offered for a real flight", () => {
    const a = withRoute(arrival("A", 60), [holdings.get("NEAR")!]);
    const b = withRoute(arrival("B", 61), [holdings.get("NEAR")!]);
    const { contexts } = collect([a, b], 0, holdings);
    expect(contexts.get("B")?.hold?.ident).toBe("NEAR");
    // ...and without the holdings map there is nowhere to hold.
    expect(collect([a, b]).contexts.get("B")?.hold).toBeUndefined();
  });
});
