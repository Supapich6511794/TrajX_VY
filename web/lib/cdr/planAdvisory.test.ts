import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { generatePlanResolutions, planResolutions } from "./planAdvisory";
import { scanFlightPlanConflicts, type PlanFlight } from "./planScan";
import { applyManeuver } from "./kinematics";
import { toSamples, totalSeconds } from "@/lib/useSimPlayback";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";

const cfg = resolveConfig();
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A straight, level cruise leg from lon0 heading east (90) or west (270).
 *  600 points at 4 s = a 40-minute flight: long enough that the arrival-protected
 *  tail (no lateral vectors in the last 10 min) doesn't swallow the whole leg,
 *  which a 15-minute toy route would. */
function leg(
  id: string,
  lat: number,
  lon0: number,
  trackDeg: number,
  altFt = 35000,
  n = 600,
  gs = 450,
): TrajectoryResult {
  const dt = 4;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const east = Math.sin((trackDeg * Math.PI) / 180); // +1 E, −1 W
  const points: TrajectoryPoint[] = [];
  for (let i = 0; i < n; i++) {
    const nm = (gs * i * dt) / 3600;
    points.push({
      lat,
      lon: lon0 + (nm * east) / nmPerDegLon,
      epoch_ts: new Date(T0 + i * dt * 1000).toISOString(),
      altitude_ft: altFt,
      gs_kt: gs,
      tas_kt: gs,
      track_deg: trackDeg,
      phase: "cruise",
    });
  }
  const last = points[points.length - 1];
  return {
    route: [{ ident: "WPT1", lat, lon: last.lon }],
    points,
    stats: {
      waypointCount: 1,
      pointCount: n,
      distanceNm: 100,
      timeMinutes: (n * dt) / 60,
      cruiseAltFt: altFt,
      rflFt: altFt,
    },
    profile: { toc: null, tod: null },
    validation: null,
    meta: {
      flightKey: id,
      callsign: id,
      aircraftType: "B738",
      adep: "AAAA",
      ades: "BBBB",
      eobtIso: new Date(T0).toISOString(),
    },
  };
}

/** Head-on pair at FL350: A east from lon 100, B west from ~60 NM ahead. */
function headOn() {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const a = leg("THA1", lat, 100, 90);
  const b = leg("AIQ2", lat, 100 + 60 / nmPerDegLon, 270);
  const flights: PlanFlight[] = [a, b].map((t) => ({
    id: t.meta.flightKey,
    callsign: t.meta.callsign,
    samples: toSamples(t.points),
    offsetSec: 0,
    durationSec: totalSeconds(t.points),
  }));
  const trajById = new Map([
    ["THA1", { traj: a, offset: 0 }],
    ["AIQ2", { traj: b, offset: 0 }],
  ]);
  return { a, b, flights, trajById };
}

describe("generatePlanResolutions", () => {
  const { flights, trajById } = headOn();
  const [conflict] = scanFlightPlanConflicts(flights, cfg);

  it("detects the head-on conflict as a definite loss", () => {
    expect(conflict).toBeDefined();
    expect(conflict.definite).toBe(true);
  });

  it("auto-generates ranked, validated suggestions with reason + score", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res.length).toBeGreaterThan(0);
    // Ranked cheapest-first; every one carries a reason, a score and a verdict.
    for (let i = 1; i < res.length; i++) {
      expect(res[i].cost).toBeGreaterThanOrEqual(res[i - 1].cost);
    }
    for (const r of res) {
      expect(r.instruction).not.toBe("");
      expect(r.reason).not.toBe("");
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.constraintVerdict).not.toBe("reject");
    }
    // The best suggestion scores highest.
    expect(res[0].score).toBe(100);
  });

  it("offers a level change (clears vertically) among the options", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res.some((r) => r.type === "flightlevel")).toBe(true);
  });

  it("the top suggestion, when applied, actually clears the conflict", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    const top = res[0];
    const info = trajById.get(top.target)!;
    // Re-apply with the EXACT timing the advisory validated the candidate with.
    const modified = applyManeuver(
      info.traj,
      { type: top.type, resolution: top.resolution },
      top.tManLocal,
      { deviationSec: top.deviationSec, rejoinSec: top.rejoinSec, bankAngleDeg: cfg.bankAngleDeg },
    );
    const newFlights = flights.map((f) =>
      f.id === top.target
        ? { ...f, samples: toSamples(modified.points), durationSec: totalSeconds(modified.points) }
        : f,
    );
    expect(scanFlightPlanConflicts(newFlights, cfg)).toHaveLength(0);
  });
});

/** In-trail overtake: LEAD (slower) ahead, REAR (faster) 6 NM behind on the same
 *  track/level → REAR catches up. A turn only delays it; speed is the fix. */
function overtake() {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  // LEAD 450 kt; REAR 20 kt faster, 8 NM behind → catches up over ~24 min. A
  // −30 kt reduction puts REAR below LEAD (as for a real A320↔B77W pair).
  const lead = leg("LEAD", lat, 100, 90, 35000, 400, 450);
  const rear = leg("REAR", lat, 100 - 8 / nmPerDegLon, 90, 35000, 400, 470);
  const flights: PlanFlight[] = [lead, rear].map((t) => ({
    id: t.meta.flightKey,
    callsign: t.meta.callsign,
    samples: toSamples(t.points),
    offsetSec: 0,
    durationSec: totalSeconds(t.points),
  }));
  const trajById = new Map([
    ["LEAD", { traj: lead, offset: 0 }],
    ["REAR", { traj: rear, offset: 0 }],
  ]);
  return { flights, trajById };
}

describe("generatePlanResolutions — in-trail overtake", () => {
  const { flights, trajById } = overtake();
  const [conflict] = scanFlightPlanConflicts(flights, cfg);

  it("ranks a speed REDUCTION on the rear (faster) aircraft #1", () => {
    expect(conflict).toBeDefined();
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].type).toBe("speed");
    expect(res[0].value).toBeLessThan(0); // a reduction
    expect(res[0].target).toBe("REAR"); // the faster / rear aircraft
    expect(res[0].score).toBe(100);
  });

  it("finds a LARGER reduction (−40+) for a fast overtake a −30 can't clear", () => {
    // REAR 45 kt faster than LEAD → a −30 leaves it at +15 kt, still catching.
    // The engine must reach for a bigger cut (−40/−50) rather than give up.
    const lat = 13;
    const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
    const lead = leg("LEAD", lat, 100, 90, 35000, 400, 450);
    const rear = leg("REAR", lat, 100 - 8 / nmPerDegLon, 90, 35000, 400, 495);
    const flights: PlanFlight[] = [lead, rear].map((t) => ({
      id: t.meta.flightKey,
      callsign: t.meta.callsign,
      samples: toSamples(t.points),
      offsetSec: 0,
      durationSec: totalSeconds(t.points),
    }));
    const trajById = new Map([
      ["LEAD", { traj: lead, offset: 0 }],
      ["REAR", { traj: rear, offset: 0 }],
    ]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res[0].type).toBe("speed");
    expect(res[0].target).toBe("REAR");
    expect(res[0].value).toBeLessThanOrEqual(-40); // needed a bigger cut than −30
  });

  it("the #1 speed reduction, when applied, actually clears the overtake", () => {
    const res = generatePlanResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    const top = res[0];
    const info = trajById.get(top.target)!;
    const modified = applyManeuver(
      info.traj,
      { type: top.type, resolution: top.resolution },
      top.tManLocal,
      { deviationSec: top.deviationSec, rejoinSec: top.rejoinSec, bankAngleDeg: cfg.bankAngleDeg },
    );
    const newFlights = flights.map((f) =>
      f.id === top.target
        ? { ...f, samples: toSamples(modified.points), durationSec: totalSeconds(modified.points) }
        : f,
    );
    expect(scanFlightPlanConflicts(newFlights, cfg)).toHaveLength(0);
  });
});

/* --- Diagnostics: who blocked a candidate, and the wide fallback envelope --- */

/** headOn(), plus extra co-routed traffic at the given levels. Each shadow flies
 *  the same track as one of the pair, so climbing/descending INTO its level is
 *  what gets the candidate rejected. */
function headOnWithShadows(
  shadows: { id: string; altFt: number; westbound?: boolean }[],
) {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const base = headOn();
  const extra = shadows.map((s) =>
    s.westbound
      ? leg(s.id, lat, 100 + 60 / nmPerDegLon, 270, s.altFt)
      : leg(s.id, lat, 100, 90, s.altFt),
  );
  const flights: PlanFlight[] = [...base.flights];
  const trajById = new Map(base.trajById);
  for (const t of extra) {
    flights.push({
      id: t.meta.flightKey,
      callsign: t.meta.callsign,
      samples: toSamples(t.points),
      offsetSec: 0,
      durationSec: totalSeconds(t.points),
    });
    trajById.set(t.meta.flightKey, { traj: t, offset: 0 });
  }
  return { flights, trajById, conflict: base.flights };
}

describe("planResolutions — blocked-by diagnostics", () => {
  it("names the third aircraft that rejected a candidate", () => {
    // SHADOW sits 2000 ft above THA1 on its own track: legal now, but THA1's
    // "Climb FL370" would fly straight into it, so that candidate is dropped.
    const { flights, trajById } = headOnWithShadows([
      { id: "SHADOW", altFt: 37000 },
    ]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    expect(res.blockers.map((b) => b.callsign)).toContain("SHADOW");
    const shadow = res.blockers.find((b) => b.callsign === "SHADOW")!;
    expect(shadow.count).toBeGreaterThan(0);
    expect(shadow.tightestNm).toBeLessThan(5); // it really was a near-miss
  });

  it("never blames the other half of the pair for blocking a fix", () => {
    // A blocker is an aircraft the controller can go and resolve FIRST. The
    // conflict partner is not one: it is the conflict being worked. Candidates
    // that leave it unresolved are dropped, as before — but tallying it turned
    // into "Resolve UAE114 first" on a UAE114 conflict, which sends the reader
    // in a circle, and into a "secondary conflict" that is neither secondary
    // nor cascading.
    const { flights, trajById } = headOnWithShadows([
      { id: "SHADOW", altFt: 37000 },
    ]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    const pairIds = [conflict.a, conflict.b];
    expect(res.blockers.map((b) => b.id).filter((id) => pairIds.includes(id))).toEqual(
      [],
    );
  });

  it("hands back a flight key, not just a name to read", () => {
    // "Resolve SHADOW first" is advice until the panel can OPEN SHADOW, and a
    // callsign is not a handle: the id is what the conflict lists are keyed by.
    const { flights, trajById } = headOnWithShadows([
      { id: "SHADOW", altFt: 37000 },
    ]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg,
      restricted: [],
    });
    const shadow = res.blockers.find((b) => b.callsign === "SHADOW")!;
    expect(shadow.id).toBeTruthy();
    // …and it resolves back to a real flight in the very list that was scanned.
    expect(flights.find((f) => f.id === shadow.id)?.callsign).toBe("SHADOW");
  });

  it("keeps the plain generator's output identical (diagnostics are additive)", () => {
    const { flights, trajById } = headOn();
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const args = { conflict, flights, trajById, simT: 0, cfg, restricted: [] };
    const rich = planResolutions(args);
    const plain = generatePlanResolutions(args);
    expect(plain.map((r) => r.instruction)).toEqual(
      rich.resolutions.map((r) => r.instruction),
    );
    // The easy head-on clears inside the normal envelope — no fallback needed.
    expect(rich.widened).toBe(false);
    expect(plain.every((r) => !r.widened)).toBe(true);
  });
});

// Resolution spec §5/§9/§13 Test 2: a candidate that resolves the primary
// conflict but creates a new one with a third aircraft must be rejected AND
// explained — not just silently dropped like every other failed candidate.
describe("planResolutions — rejected-candidate audit trail", () => {
  it("records a candidate that clears the pair but creates a secondary conflict", () => {
    const { flights, trajById } = headOnWithShadows([{ id: "SHADOW", altFt: 37000 }]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({ conflict, flights, trajById, simT: 0, cfg, restricted: [] });

    const secondary = res.rejected.filter((r) => r.reason === "secondary-conflict");
    expect(secondary.length).toBeGreaterThan(0);
    // Every secondary-conflict rejection names WHO it would newly conflict
    // with, and that aircraft is the third party (SHADOW), never the
    // original conflict partner.
    for (const r of secondary) {
      expect(r.conflictWith?.callsign).toBe("SHADOW");
      expect([conflict.a, conflict.b]).not.toContain(r.conflictWith?.id);
    }
  });

  it("distinguishes 'still conflicts with the original partner' from 'secondary conflict'", () => {
    // No shadow aircraft here — every rejection (if any) must be about the
    // pair itself, never mislabelled as a secondary conflict with a third
    // party that doesn't exist in this scenario.
    const { flights, trajById } = headOn();
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({ conflict, flights, trajById, simT: 0, cfg, restricted: [] });
    for (const r of res.rejected) {
      expect(r.reason).not.toBe("secondary-conflict");
    }
  });

  it("keeps the rejected trail out of the plain generator's output (additive only)", () => {
    const { flights, trajById } = headOnWithShadows([{ id: "SHADOW", altFt: 37000 }]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const args = { conflict, flights, trajById, simT: 0, cfg, restricted: [] };
    const rich = planResolutions(args);
    const plain = generatePlanResolutions(args);
    expect(rich.rejected.length).toBeGreaterThan(0);
    expect(plain.map((r) => r.instruction)).toEqual(
      rich.resolutions.map((r) => r.instruction),
    );
  });

  it("every rejected candidate carries a human-readable instruction and detail", () => {
    const { flights, trajById } = headOnWithShadows([{ id: "SHADOW", altFt: 37000 }]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({ conflict, flights, trajById, simT: 0, cfg, restricted: [] });
    expect(res.rejected.length).toBeGreaterThan(0);
    for (const r of res.rejected) {
      expect(r.instruction).not.toBe("");
      expect(r.detail).not.toBe("");
      expect(r.target).toBeTruthy();
      expect(r.targetCallsign).toBeTruthy();
    }
  });
});

describe("planResolutions — wide fallback envelope", () => {
  // Boxed in vertically: co-routed traffic sits at every semicircular-legal
  // level within ±2000 of the pair (eastbound THA1 may use odd → FL370/FL330,
  // westbound AIQ2 even → FL360/FL340), and a climb/descent past them is
  // blocked in transit too. That leaves the lateral fix, whose required turn
  // grows with the horizontal minimum — so the minimum sets which envelope can
  // solve it.
  const boxed = () =>
    headOnWithShadows([
      { id: "BLK370", altFt: 37000 },
      { id: "BLK330", altFt: 33000 },
      { id: "BLK360", altFt: 36000, westbound: true },
      { id: "BLK340", altFt: 34000, westbound: true },
    ]);
  const solve = (enrouteNm: number) => {
    const c = resolveConfig({ horizontal: { enrouteNm, terminalNm: 3 } });
    const { flights, trajById } = boxed();
    const conflict = scanFlightPlanConflicts(flights, c).find(
      (x) => [x.a, x.b].includes("THA1") && [x.a, x.b].includes("AIQ2"),
    )!;
    return planResolutions({
      conflict,
      flights,
      trajById,
      simT: 0,
      cfg: c,
      restricted: [],
    });
  };

  it("stays in the normal envelope while a ≤40° turn still clears", () => {
    const res = solve(15);
    expect(res.widened).toBe(false);
    expect(res.resolutions.length).toBeGreaterThan(0);
    expect(res.resolutions.every((r) => !r.widened)).toBe(true);
    expect(Math.abs(res.resolutions[0].trackDeviationDeg)).toBeLessThanOrEqual(40);
  });

  it("falls back to the wide envelope when it does not, and flags the result", () => {
    // 25 NM needs a bigger turn than the normal envelope's 40° ceiling.
    const res = solve(25);
    expect(res.resolutions.length).toBeGreaterThan(0);
    expect(res.widened).toBe(true);
    expect(res.resolutions.every((r) => r.widened)).toBe(true);
    expect(Math.abs(res.resolutions[0].trackDeviationDeg)).toBeGreaterThan(40);
  });

  it("still reports who blocked the gentle candidates", () => {
    expect(solve(25).blockers.length).toBeGreaterThan(0);
  });
});
