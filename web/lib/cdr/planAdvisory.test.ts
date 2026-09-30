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
  const a = leg("UBA1", lat, 100, 90);
  const b = leg("KMV2", lat, 100 + 60 / nmPerDegLon, 270);
  const flights: PlanFlight[] = [a, b].map((t) => ({
    id: t.meta.flightKey,
    callsign: t.meta.callsign,
    samples: toSamples(t.points),
    offsetSec: 0,
    durationSec: totalSeconds(t.points),
  }));
  const trajById = new Map([
    ["UBA1", { traj: a, offset: 0 }],
    ["KMV2", { traj: b, offset: 0 }],
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
    // SHADOW sits 2000 ft above UBA1 on its own track: legal now, but UBA1's
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
  // level within ±2000 of the pair (eastbound UBA1 may use odd → FL370/FL330,
  // westbound KMV2 even → FL360/FL340), and a climb/descent past them is
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
      (x) => [x.a, x.b].includes("UBA1") && [x.a, x.b].includes("KMV2"),
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

/* --- Third conflict, blocker-first chains, ATFM ground delay --- */

/** A northbound cruise leg that crosses latitude `lat` at `lon`, `tCrossSec`
 *  after its departure (T0). */
function northLeg(
  id: string,
  lat: number,
  lon: number,
  tCrossSec: number,
  altFt: number,
  n = 600,
  gs = 450,
): TrajectoryResult {
  const base = leg(id, lat, lon, 90, altFt, n, gs);
  const dt = 4;
  const lat0 = lat - (gs * tCrossSec) / 3600 / 60;
  const points = base.points.map((p, i) => ({
    ...p,
    lat: lat0 + (gs * i * dt) / 3600 / 60,
    lon,
    track_deg: 0,
  }));
  const last = points[points.length - 1];
  return { ...base, points, route: [{ ident: "WPT1", lat: last.lat, lon }] };
}

function planOf(entries: { traj: TrajectoryResult; offset: number }[]) {
  const flights: PlanFlight[] = entries.map(({ traj, offset }) => ({
    id: traj.meta.flightKey,
    callsign: traj.meta.callsign,
    samples: toSamples(traj.points),
    offsetSec: offset,
    durationSec: totalSeconds(traj.points),
  }));
  const trajById = new Map(entries.map((e) => [e.traj.meta.flightKey, e]));
  return { flights, trajById };
}

describe("planResolutions — third (rejoin) conflict", () => {
  it("labels a conflict met only on the way back to the plan as rejoin, not secondary", () => {
    // UBA1's "Climb FL370" holds FL370 until 2 min past the CPA (t≈360 s),
    // then descends back. RJN, westbound at FL370, meets UBA1 at t≈400 s —
    // clear during the hold (10 NM apart when it ends), inside the buffer on
    // the descent back to FL350. The original UBA1 at FL350 never conflicts.
    const lat = 13;
    const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
    const { a, b } = headOn();
    const rjn = leg("RJN", lat, 100 + 100 / nmPerDegLon, 270, 37000);
    const { flights, trajById } = planOf([a, b, rjn].map((traj) => ({ traj, offset: 0 })));
    const conflict = scanFlightPlanConflicts(flights, cfg).find(
      (x) => [x.a, x.b].includes("UBA1") && [x.a, x.b].includes("KMV2"),
    )!;
    const res = planResolutions({ conflict, flights, trajById, simT: 0, cfg, restricted: [] });

    const climb = res.rejected.find(
      (r) => r.target === "UBA1" && r.instruction === "Climb FL370",
    );
    expect(climb?.reason).toBe("rejoin-conflict");
    expect(climb?.conflictWith?.callsign).toBe("RJN");
    expect(climb?.detail).toMatch(/returning to the flight plan/);
  });

  it("keeps a conflict met during the maneuver itself as secondary", () => {
    // SHADOW is co-routed at FL370: UBA1 climbs straight into it.
    const { flights, trajById } = headOnWithShadows([{ id: "SHADOW", altFt: 37000 }]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({ conflict, flights, trajById, simT: 0, cfg, restricted: [] });
    const climb = res.rejected.find(
      (r) => r.target === "UBA1" && r.instruction === "Climb FL370",
    );
    expect(climb?.reason).toBe("secondary-conflict");
  });
});

/** A short head-on pair nothing tactical can clear on its own:
 *  - both legs are 10 min, so every lateral fix is arrival-protected;
 *  - head-on, so no speed change separates them;
 *  - the clock (simT 235) leaves only ±2000 ft reachable before the CPA
 *    (t≈410 s), and ±1000 ft is inside the vertical buffer;
 *  - so UBA1's FL370 / FL330 are the only real candidates, and northbound
 *    crossers at those levels cut across UBA1's path while it holds there.
 *  `crossersPerLevel` 1 → each candidate is blocked by ONE aircraft (a chain
 *  can move it); 2 → by two (no chain) and the pair falls to ATFM.
 *  KMV2 departs at t=300, after the clock — it can still be ground-delayed. */
function boxedShortPair(crossersPerLevel: 1 | 2) {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const a = leg("UBA1", lat, 100, 90, 35000, 150);
  const b = leg("KMV2", lat, 100 + 65 / nmPerDegLon, 270, 35000, 150);
  const entries = [
    { traj: a, offset: 0 },
    { traj: b, offset: 300 },
  ];
  // UBA1 is 57.5 NM along at t=460 and 50 NM along at t=400 — inside its hold.
  const crossings = [
    { nm: 57.5, t: 460 },
    { nm: 50, t: 400 },
  ].slice(0, crossersPerLevel);
  for (const altFt of [37000, 33000]) {
    crossings.forEach((c, i) =>
      entries.push({
        traj: northLeg(
          `X${altFt / 100}${"AB"[i]}`,
          lat,
          100 + c.nm / nmPerDegLon,
          c.t,
          altFt,
        ),
        offset: 0,
      }),
    );
  }
  const { flights, trajById } = planOf(entries);
  const conflicts = scanFlightPlanConflicts(flights, cfg);
  const conflict = conflicts.find(
    (x) => [x.a, x.b].includes("UBA1") && [x.a, x.b].includes("KMV2"),
  )!;
  return { flights, trajById, conflicts, conflict, simT: 235 };
}

/** Apply a resolution to its target's PlanFlight, as the UI would. */
function flown(
  flights: PlanFlight[],
  trajById: Map<string, { traj: TrajectoryResult; offset: number }>,
  r: {
    target: string;
    type: import("./config").ManeuverType;
    resolution: import("./types").ManeuverResolution;
    tManLocal: number;
    deviationSec: number;
    rejoinSec: number;
  },
): PlanFlight[] {
  const info = trajById.get(r.target)!;
  const modified = applyManeuver(info.traj, r, r.tManLocal, {
    deviationSec: r.deviationSec,
    rejoinSec: r.rejoinSec,
    bankAngleDeg: cfg.bankAngleDeg,
  });
  trajById.set(r.target, { traj: modified, offset: info.offset + (r.resolution.delaySec ?? 0) });
  return flights.map((f) =>
    f.id === r.target
      ? {
          ...f,
          samples: toSamples(modified.points),
          durationSec: totalSeconds(modified.points),
          offsetSec: f.offsetSec + (r.resolution.delaySec ?? 0),
        }
      : f,
  );
}

describe("planResolutions — resolve the blocker first (chained)", () => {
  it("the scenario really has no single-maneuver fix", () => {
    const s = boxedShortPair(1);
    expect(s.conflicts).toHaveLength(1); // only the pair itself
    const res = planResolutions({ ...s, cfg, restricted: [] });
    expect(res.resolutions).toHaveLength(0);
    expect(res.atfm).toBe(false); // a chain was found, so no ground delay
  });

  it("moves the one blocking crosser, then the original fix clears", () => {
    const s = boxedShortPair(1);
    const res = planResolutions({ ...s, cfg, restricted: [] });
    expect(res.chained.length).toBeGreaterThan(0);
    const [top] = res.chained;
    expect(top.fix.target).toBe("UBA1");
    expect(top.blockerFix.target).toMatch(/^X(370|330)A$/);
    expect(top.cost).toBeCloseTo(top.fix.cost + top.blockerFix.cost);
    expect(top.score).toBe(100);

    // Apply both, blocker first: the whole plan is conflict-free.
    const trajById = new Map(s.trajById);
    let flights = flown(s.flights, trajById, top.blockerFix);
    flights = flown(flights, trajById, top.fix);
    expect(scanFlightPlanConflicts(flights, cfg)).toHaveLength(0);
  });

  it("is not attempted when a single maneuver already clears", () => {
    const { flights, trajById } = headOnWithShadows([{ id: "SHADOW", altFt: 37000 }]);
    const [conflict] = scanFlightPlanConflicts(flights, cfg);
    const res = planResolutions({ conflict, flights, trajById, simT: 0, cfg, restricted: [] });
    expect(res.resolutions.length).toBeGreaterThan(0);
    expect(res.chained).toEqual([]);
  });
});

describe("planResolutions — who is really in the way", () => {
  it("never blames a third aircraft for a candidate that left the pair in conflict", () => {
    // KBZ312/KBZ845 in the field: "Resolve MMA502 first" was shown although the
    // candidates MMA502 "blocked" did not separate the pair either.
    const s = boxedShortPair(2);
    const res = planResolutions({ ...s, cfg, restricted: [] });
    const climb = res.rejected.find(
      (r) => r.target === "KMV2" && r.instruction === "Climb FL360",
    )!;
    // FL360 is 1000 ft from UBA1 — inside the buffer, so the pair is not
    // separated; that it ALSO passes a crosser is secondary to that.
    expect(climb.reason).toBe("unresolved-primary");
    expect(climb.conflictWith?.callsign).toBe("UBA1");
    expect(climb.detail).toMatch(/also conflict with X370/);
    // Every blocker tallied comes from a candidate that DID separate the pair.
    const pairSeparated = res.rejected.filter(
      (r) => r.reason === "secondary-conflict" || r.reason === "rejoin-conflict",
    );
    for (const b of res.blockers) {
      expect(pairSeparated.some((r) => r.conflictWith?.id === b.id)).toBe(true);
    }
  });
});

describe("planResolutions — ATFM ground delay", () => {
  it("falls back to delaying the aircraft that has not departed", () => {
    const s = boxedShortPair(2);
    const res = planResolutions({ ...s, cfg, restricted: [] });
    expect(res.chained).toEqual([]);
    expect(res.atfm).toBe(true);
    expect(res.resolutions.length).toBeGreaterThan(0);
    // UBA1 is airborne — only KMV2 (EOBT t=300, clock 235) can be held.
    for (const r of res.resolutions) {
      expect(r.type).toBe("delay");
      expect(r.target).toBe("KMV2");
    }
    const [top] = res.resolutions;
    expect(top.instruction).toMatch(/^Ground delay \+\d+ min$/);
    expect(top.extraTimeSec).toBe(top.resolution.delaySec);

    const flights = flown(s.flights, new Map(s.trajById), top);
    expect(scanFlightPlanConflicts(flights, cfg)).toHaveLength(0);
  });

  it("offers no ground delay once both aircraft are off blocks", () => {
    const s = boxedShortPair(2);
    // Clock past KMV2's EOBT: nobody left on the ground to hold.
    const res = planResolutions({ ...s, simT: 290, cfg, restricted: [] });
    expect(res.atfm).toBe(false);
    expect(res.resolutions.every((r) => r.type !== "delay")).toBe(true);
  });

  it("shifts the whole trajectory and EOBT, the path untouched", () => {
    const t = leg("DLY1", 13, 100, 90);
    const d = applyManeuver(t, { type: "delay", resolution: { delaySec: 600 } }, 0);
    const ms = (s: string) => new Date(s).getTime();
    expect(ms(d.points[0].epoch_ts) - ms(t.points[0].epoch_ts)).toBe(600_000);
    expect(ms(d.meta.eobtIso) - ms(t.meta.eobtIso)).toBe(600_000);
    expect(d.points.map((p) => [p.lat, p.lon, p.altitude_ft])).toEqual(
      t.points.map((p) => [p.lat, p.lon, p.altitude_ft]),
    );
  });
});
