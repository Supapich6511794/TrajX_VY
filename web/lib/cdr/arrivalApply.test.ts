/** Applying a speed control, or a hold, to an arrival already in the air. */
import { describe, expect, it } from "vitest";

import { applyArrivalHold, applySpeedReduction, delayFromReduction } from "./arrivalApply";
import type { ArrivalHold } from "./arrivalFix";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";

const T0 = Date.UTC(2025, 11, 23, 0, 0, 0) / 1000;
const NM = 60;

/** A straight-in arrival: `distNm` out, closing at `gsKt`, one sample / 10 s. */
function inbound(distNm: number, gsKt: number): TrajectoryPoint[] {
  const pts: TrajectoryPoint[] = [];
  const totalSec = (distNm / gsKt) * 3600;
  for (let t = 0; t <= totalSec + 1e-9; t += 10) {
    const flown = (gsKt * t) / 3600;
    pts.push({
      lat: 21.72 + (distNm - flown) / NM,
      lon: 95.974,
      epoch_ts: new Date((T0 + t) * 1000).toISOString(),
      altitude_ft: 3000,
      gs_kt: gsKt,
      tas_kt: gsKt,
      track_deg: 180,
      phase: "descent",
    });
  }
  return pts;
}

const secs = (p: TrajectoryPoint[]) =>
  p.map((x) => new Date(x.epoch_ts).getTime() / 1000);

describe("applySpeedReduction", () => {
  it("delays the landing by what the slower speed costs", () => {
    // 30 NM at 180 kt = 600 s. At 160 kt it is 675 s — 75 s later.
    const before = inbound(30, 180);
    const after = applySpeedReduction(before, T0, 160);
    expect(delayFromReduction(before, after)).toBeCloseTo(75, 0);
  });

  it("leaves everything BEFORE the instruction untouched", () => {
    // An instruction cannot change where the aircraft has already been.
    const before = inbound(30, 180);
    const at = T0 + 300; // five minutes in
    const after = applySpeedReduction(before, at, 160);
    const flownIdx = secs(before).findIndex((s) => s >= at);
    for (let i = 0; i <= flownIdx; i++) {
      expect(after[i].epoch_ts).toBe(before[i].epoch_ts);
      expect(after[i].gs_kt).toBe(before[i].gs_kt);
    }
    // …and only the remainder is slowed.
    expect(after[flownIdx + 1].gs_kt).toBe(160);
  });

  it("keeps the ground track exactly as it was", () => {
    // A speed control does not re-route: same positions, new times.
    const before = inbound(25, 200);
    const after = applySpeedReduction(before, T0, 170);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].lat).toBe(before[i].lat);
      expect(after[i].lon).toBe(before[i].lon);
      expect(after[i].altitude_ft).toBe(before[i].altitude_ft);
    }
  });

  it("is a CAP, not a setting — it never speeds an aircraft up", () => {
    const before = inbound(20, 150);
    const after = applySpeedReduction(before, T0, 180);
    for (const p of after) expect(p.gs_kt).toBe(150);
    expect(delayFromReduction(before, after)).toBeCloseTo(0, 3);
  });

  it("keeps the clock strictly moving forward", () => {
    const after = applySpeedReduction(inbound(30, 180), T0 + 120, 160);
    const t = secs(after);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });

  it("does not mutate the trajectory it was given", () => {
    const before = inbound(20, 180);
    const snapshot = JSON.stringify(before);
    applySpeedReduction(before, T0, 140);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("no-ops when there is nothing left to fly", () => {
    const before = inbound(20, 180);
    const past = new Date(before[before.length - 1].epoch_ts).getTime() / 1000 + 60;
    expect(applySpeedReduction(before, past, 140)).toBe(before);
    expect(applySpeedReduction(before, T0, 0)).toBe(before);
  });
});

/* -------------------------------------------------------------------------
 * Holding
 * ---------------------------------------------------------------------- */

/** A published 1-minute right-hand pattern → 60 s leg + 60 s turn, twice. */
const HOLD: ArrivalHold = {
  ident: "HOLD1",
  lat: 21.72 + 20 / NM, // 20 NM out on the inbound track below
  lon: 95.974,
  inboundCourseDeg: 180,
  turn: "R",
  legSec: 60,
  gsKt: 230,
  loopSec: 240,
  tManSec: 0, // set per test
};

function result(points: TrajectoryPoint[]): TrajectoryResult {
  return {
    route: [],
    points,
    stats: {
      waypointCount: 0,
      pointCount: points.length,
      distanceNm: 30,
      timeMinutes: 0,
      cruiseAltFt: 3000,
      rflFt: 3000,
    },
    profile: { toc: null, tod: null },
    validation: null,
    meta: {
      flightKey: "T1",
      callsign: "UBA100",
      aircraftType: "A320",
      adep: "VYMK",
      ades: "VYMD",
      eobtIso: new Date(T0 * 1000).toISOString(),
    },
  };
}

const lastSec = (t: TrajectoryResult) =>
  new Date(t.points[t.points.length - 1].epoch_ts).getTime() / 1000;

/** Local seconds at which the arrival passes the holding fix. */
const AT_FIX = (10 / 200) * 3600; // 30 NM out at 200 kt, fix 20 NM out

describe("applyArrivalHold", () => {
  const before = result(inbound(30, 200));

  it("delays the landing by one full pattern per loop", () => {
    const one = applyArrivalHold(before, { ...HOLD, tManSec: AT_FIX }, 1);
    const two = applyArrivalHold(before, { ...HOLD, tManSec: AT_FIX }, 2);
    const d1 = lastSec(one) - lastSec(before);
    const d2 = lastSec(two) - lastSec(before);
    expect(d1).toBeCloseTo(HOLD.loopSec, 0);
    // Loops compose: the second is entered where the first put it back.
    expect(d2).toBeCloseTo(2 * HOLD.loopSec, 0);
  });

  it("leaves everything BEFORE the fix untouched", () => {
    const after = applyArrivalHold(before, { ...HOLD, tManSec: AT_FIX }, 1);
    const flown = before.points.filter(
      (p) => new Date(p.epoch_ts).getTime() / 1000 < T0 + AT_FIX,
    );
    for (let i = 0; i < flown.length; i++) {
      expect(after.points[i].epoch_ts).toBe(before.points[i].epoch_ts);
      expect(after.points[i].lat).toBeCloseTo(before.points[i].lat, 9);
    }
  });

  it("comes back to the fix, so the route resumes from where it left it", () => {
    // The racetrack is a closed circuit: the aircraft is over the fix again at
    // the end of it, and every later position is the filed one, just later.
    const after = applyArrivalHold(before, { ...HOLD, tManSec: AT_FIX }, 2);
    const last = after.points[after.points.length - 1];
    const wasLast = before.points[before.points.length - 1];
    expect(last.lat).toBeCloseTo(wasLast.lat, 9);
    expect(last.lon).toBeCloseTo(wasLast.lon, 9);
  });

  it("actually leaves the inbound track — there is a racetrack to draw", () => {
    const after = applyArrivalHold(before, { ...HOLD, tManSec: AT_FIX }, 1);
    const offTrack = after.points.filter(
      (p) => Math.abs(p.lon - 95.974) > 0.01,
    );
    expect(offTrack.length).toBeGreaterThan(10);
  });

  it("refuses a fix the aircraft has already passed", () => {
    // An instruction cannot act on the past; a hold has to be joined AT the fix.
    const after = applyArrivalHold(
      before,
      { ...HOLD, tManSec: AT_FIX },
      1,
      AT_FIX + 60,
    );
    expect(after).toBe(before);
  });

  it("does nothing for zero loops", () => {
    expect(applyArrivalHold(before, { ...HOLD, tManSec: AT_FIX }, 0)).toBe(before);
  });
});
