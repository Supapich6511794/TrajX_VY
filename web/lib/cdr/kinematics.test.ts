import { describe, expect, it } from "vitest";

import {
  applyManeuver,
  turnGeometry,
  turnInitiationLeadSec,
} from "./kinematics";
import { toSamples, aircraftAt } from "@/lib/useSimPlayback";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";
import type { Maneuver } from "./types";

/** A straight, level, eastbound trajectory: 450 kt at 13°N, 4 s cadence. */
function eastbound(nPts = 60, altFt = 35000): TrajectoryResult {
  const gs = 450;
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const dtSec = 4;
  const nmPerDegLon = Math.cos((13 * Math.PI) / 180) * 60;
  const points: TrajectoryPoint[] = [];
  for (let i = 0; i < nPts; i++) {
    const tSec = i * dtSec;
    const nm = (gs * tSec) / 3600;
    points.push({
      lat: 13,
      lon: 100 + nm / nmPerDegLon,
      epoch_ts: new Date(t0 + tSec * 1000).toISOString(),
      altitude_ft: altFt,
      gs_kt: gs,
      tas_kt: gs,
      track_deg: 90,
      phase: "cruise",
    });
  }
  return {
    route: [],
    points,
    stats: {
      waypointCount: 0,
      pointCount: nPts,
      distanceNm: 30,
      timeMinutes: (nPts * dtSec) / 60,
      cruiseAltFt: altFt,
      rflFt: altFt,
    },
    profile: { toc: null, tod: null },
    validation: null,
    meta: {
      flightKey: "T1",
      callsign: "TST1",
      aircraftType: "B738",
      adep: "VYYY",
      ades: "VYKT",
      eobtIso: new Date(t0).toISOString(),
    },
  };
}

const man = (over: Partial<Maneuver>): Maneuver => ({
  type: "heading",
  target: "T1",
  instruction: "",
  value: 0,
  resolution: {},
  newDCpaNm: 6,
  origDCpaNm: 2,
  extraDistanceNm: 0,
  extraTimeSec: 0,
  trackDeviationDeg: 0,
  altChangeFt: 0,
  cost: 0,
  ...over,
});

describe("applyManeuver", () => {
  it("heading: leaves the pre-maneuver path intact and turns downstream", () => {
    const traj = eastbound();
    const out = applyManeuver(
      traj,
      man({ type: "heading", resolution: { headingDeg: 120 } }),
      100, // maneuver at t=100 s
    );
    const samples = toSamples(out.points);

    // Before the maneuver, still on the original eastbound track.
    expect(aircraftAt(samples, 50)!.track).toBeCloseTo(90, 5);
    // After it, on the new ~120° track (the recovered leg computes its bearing
    // geometrically, so it lands within a hundredth of a degree, not exact).
    expect(aircraftAt(samples, 160)!.track).toBeCloseTo(120, 1);
    // Position at t=50 s is unchanged vs the original.
    const orig = toSamples(traj.points);
    expect(aircraftAt(samples, 50)!.lat).toBeCloseTo(aircraftAt(orig, 50)!.lat, 6);
    expect(aircraftAt(samples, 50)!.lon).toBeCloseTo(aircraftAt(orig, 50)!.lon, 6);
  });

  it("turn geometry: radius grows with speed (∝ V²), duration with heading change", () => {
    const slow = turnGeometry(300, 30, 25);
    const fast = turnGeometry(500, 30, 25);
    expect(fast.radiusNm).toBeGreaterThan(slow.radiusNm);
    expect(fast.radiusNm / slow.radiusNm).toBeCloseTo((500 / 300) ** 2, 1);
    expect(turnGeometry(450, 40, 25).turnDurationSec).toBeGreaterThan(
      turnGeometry(450, 10, 25).turnDurationSec,
    );
  });

  it("faster aircraft begin turning earlier (further from the conflict)", () => {
    // The turn-execution component (∝ speed) is larger for a faster aircraft.
    expect(turnGeometry(500, 30, 25).turnDurationSec).toBeGreaterThan(
      turnGeometry(300, 30, 25).turnDurationSec,
    );
    // Turn-initiation DISTANCE before CPA = lead × speed: it grows with speed,
    // so a faster aircraft starts its turn further out (the requirement).
    const distBeforeCpa = (gs: number) =>
      turnInitiationLeadSec(gs, 20, 6, 25, 15) * (gs / 3600);
    expect(distBeforeCpa(600)).toBeGreaterThan(distBeforeCpa(300));
    expect(turnInitiationLeadSec(450, 20, 6, 25, 15)).toBeGreaterThan(15);
  });

  it("heading maneuver is a SMOOTH fly-by turn (track changes gradually)", () => {
    const traj = eastbound(120); // level east, track 90
    const out = applyManeuver(
      traj,
      man({ type: "heading", resolution: { headingDeg: 150 } }),
      40,
      { deviationSec: 150, rejoinSec: 150, bankAngleDeg: 25 },
    );
    const s = toSamples(out.points);
    // A few seconds into the turn the track is PARTWAY (not jumped to 150).
    const early = aircraftAt(s, 48)!.track;
    expect(early).toBeGreaterThan(90);
    expect(early).toBeLessThan(150);
    // Later in the deviation it has reached ~150.
    expect(aircraftAt(s, 130)!.track).toBeCloseTo(150, 0);
  });

  it("heading with recovery: deviates, then rejoins the original route", () => {
    // Long straight eastbound route at lat 13. Turn at t=40, hold 60 s, rejoin.
    const traj = eastbound(120);
    const out = applyManeuver(
      traj,
      man({ type: "heading", resolution: { headingDeg: 130 } }),
      40,
      { deviationSec: 60, rejoinSec: 60 },
    );
    const samples = toSamples(out.points);
    const orig = toSamples(traj.points);

    // Mid-deviation the aircraft has left the lat-13 track (turned SE).
    const dev = aircraftAt(samples, 80)!;
    expect(dev.lat).toBeLessThan(12.98);

    // Well after the rejoin it is back on the original route (lat ≈ 13). The
    // recapture is a flown, bank-limited turn onto the route rather than an
    // instant snap onto the rejoin bearing, so it converges over a few minutes
    // (t=300 is still mid-intercept; by t=450 it is within a mile of the line).
    const late = aircraftAt(samples, 450)!;
    expect(Math.abs(late.lat - 13)).toBeLessThan(0.02);

    // And it ends near the original destination rather than diverging off.
    const end = out.points[out.points.length - 1];
    const origEnd = traj.points[traj.points.length - 1];
    expect(Math.abs(end.lat - origEnd.lat)).toBeLessThan(0.05);
    expect(Math.abs(end.lon - origEnd.lon)).toBeLessThan(0.2);
    // Contrast: without recovery it would still be heading 130 forever.
    void orig;
  });

  it("the REJOIN is bank-limited too — no hairpin vertex anywhere in the path", () => {
    // A near-reversal (heading 90 → 300) with a short deviation puts the rejoin
    // point behind and abeam the aircraft, which is exactly the geometry that
    // used to snap the track ~180° at a single vertex and draw a spike on the
    // map. Every heading change in the output must stay inside the bank-limited
    // turn rate — the turn OUT and the turn BACK alike.
    const gs = 450;
    const bankAngleDeg = 25;
    const traj = eastbound(200);
    const out = applyManeuver(
      traj,
      man({ type: "heading", resolution: { headingDeg: 300 } }),
      40,
      { deviationSec: 120, rejoinSec: 120, bankAngleDeg },
    );
    const maxRateDegSec = turnGeometry(gs, 90, bankAngleDeg).turnRateDegSec;

    let worstRate = 0;
    const pts = out.points;
    for (let i = 1; i < pts.length; i++) {
      const dt =
        (new Date(pts[i].epoch_ts).getTime() -
          new Date(pts[i - 1].epoch_ts).getTime()) /
        1000;
      if (dt <= 0) continue;
      const d = Math.abs(
        ((pts[i].track_deg - pts[i - 1].track_deg + 540) % 360) - 180,
      );
      worstRate = Math.max(worstRate, d / dt);
    }
    // 1.6× headroom: `track_deg` is the bearing of each 4 s chord, so a chord
    // straddling the mid-step heading reads slightly hotter than the true rate.
    expect(worstRate).toBeLessThan(maxRateDegSec * 1.6);
    // Sanity: it really did have to turn a long way round.
    expect(worstRate).toBeGreaterThan(0.5);
  });

  it("a maneuver late in the flight still ENDS at the destination", () => {
    // tMan 400 + 60 s deviation + 180 s rejoin overruns the 476 s route, so the
    // rejoin target clamps to the final point. The recapture has to home onto
    // that point anyway — giving up because there is no route left to intercept
    // left the aircraft running off on its deviation heading, never arriving.
    const traj = eastbound(120);
    const out = applyManeuver(
      traj,
      man({ type: "heading", resolution: { headingDeg: 200 } }),
      400,
      { deviationSec: 60, rejoinSec: 180 },
    );
    const end = out.points[out.points.length - 1];
    const origEnd = traj.points[traj.points.length - 1];
    const dLatNm = Math.abs(end.lat - origEnd.lat) * 60;
    const dLonNm =
      Math.abs(end.lon - origEnd.lon) * 60 * Math.cos((13 * Math.PI) / 180);
    expect(Math.hypot(dLatNm, dLonNm)).toBeLessThan(1);
  });

  it("flight level: keeps track, ramps altitude toward the new level", () => {
    const traj = eastbound(90, 35000);
    const out = applyManeuver(
      traj,
      man({ type: "flightlevel", resolution: { altFt: 37000 } }),
      40,
      { climbFpm: 1200 }, // ft/min
    );
    const samples = toSamples(out.points);
    // Track unchanged.
    expect(aircraftAt(samples, 200)!.track).toBeCloseTo(90, 5);
    // ~100 s after the maneuver at 1200 fpm ≈ +2000 ft ⇒ reaches FL370 and holds.
    expect(aircraftAt(samples, 200)!.altitudeFt!).toBeCloseTo(37000, -2);
    // Mid-ramp it is between the two levels.
    const mid = aircraftAt(samples, 80)!.altitudeFt!;
    expect(mid).toBeGreaterThan(35000);
    expect(mid).toBeLessThanOrEqual(37000);
  });

  it("flight level: TEMPORARY step — climbs, holds, then RETURNS to the filed level", () => {
    const traj = eastbound(150, 35000); // 600 s of level cruise at FL350
    const out = applyManeuver(
      traj,
      man({ type: "flightlevel", resolution: { altFt: 37000 } }),
      40,
      { climbFpm: 1200, deviationSec: 120, rejoinSec: 180 },
    );
    const samples = toSamples(out.points);
    // Stepped UP to FL370 during the hold…
    expect(aircraftAt(samples, 145)!.altitudeFt!).toBeCloseTo(37000, -2);
    // …then RETURNED to the filed FL350 once the conflict window is past —
    // NOT cruising at the temporary level forever.
    expect(aircraftAt(samples, 450)!.altitudeFt!).toBeCloseTo(35000, -2);
    // And the cruise level is not relabelled to the transient peak.
    expect(out.stats.cruiseAltFt).toBe(35000);
  });

  it("hold: flies one racetrack loop and DELAYS the rest of the route (~4 min)", () => {
    const traj = eastbound(120, 35000);
    const origDur = toSamples(traj.points).slice(-1)[0].t;
    const out = applyManeuver(
      traj,
      man({
        type: "hold",
        resolution: {
          hold: {
            ident: "FIX",
            lat: 13,
            lon: 100.5,
            inboundCourseDeg: 90,
            turn: "R",
            legSec: 60, // 1-minute legs
            gsKt: 230,
          },
        },
      }),
      40,
    );
    const samples = toSamples(out.points);
    const newDur = samples.slice(-1)[0].t;
    // One loop = 2 legs (60 s) + 2 × 180° turns (60 s) ≈ 240 s added.
    expect(newDur - origDur).toBeGreaterThan(200);
    expect(newDur - origDur).toBeLessThan(280);
    // The racetrack sweeps the heading through the reciprocal (a ~180° range).
    const tracks = out.points.map((p) => p.track_deg);
    expect(Math.max(...tracks) - Math.min(...tracks)).toBeGreaterThan(150);
    // After the loop the aircraft is back at the fix and resumes eastbound.
    expect(aircraftAt(samples, newDur - 1)!.track).toBeCloseTo(90, 0);
  });

  it("hold: traces the racetrack at the flight's own sampling rate, smoothly", () => {
    // The loop used to be emitted on a hard-coded 6-second step, which is both
    // a different radar picture from the rest of the track and 18 degrees of
    // heading between one position and the next — an arc drawn as a polygon.
    const traj = eastbound(120, 35000);
    const before = toSamples(traj.points);
    const cadence = before[1].t - before[0].t;
    const out = applyManeuver(
      traj,
      man({
        type: "hold",
        resolution: {
          hold: {
            ident: "FIX",
            lat: 13,
            lon: 100.5,
            inboundCourseDeg: 90,
            turn: "R",
            legSec: 60,
            gsKt: 230,
          },
        },
      }),
      40,
    );
    // Samples inside the loop, by time: the loop runs from the maneuver for
    // about four minutes.
    const epoch0 = new Date(out.points[0].epoch_ts).getTime();
    const inLoop = out.points.filter((p) => {
      const t = (new Date(p.epoch_ts).getTime() - epoch0) / 1000;
      return t > 40 && t < 40 + 235;
    });
    expect(inLoop.length).toBeGreaterThan(10);

    // Emitted at the track's own rate, not a rate of its own.
    const gaps: number[] = [];
    for (let i = 1; i < inLoop.length; i++) {
      gaps.push(
        (new Date(inLoop[i].epoch_ts).getTime() -
          new Date(inLoop[i - 1].epoch_ts).getTime()) /
          1000,
      );
    }
    expect(Math.max(...gaps)).toBeLessThanOrEqual(cadence + 0.001);

    // Standard rate is 3 deg/s, so one sampling interval can turn the aircraft
    // by 3 * cadence and no more. At the old 6-second step this was 18.
    const turns: number[] = [];
    for (let i = 1; i < inLoop.length; i++) {
      turns.push(
        Math.abs(
          ((inLoop[i].track_deg - inLoop[i - 1].track_deg + 540) % 360) - 180,
        ),
      );
    }
    expect(Math.max(...turns)).toBeLessThanOrEqual(3 * cadence + 0.5);
  });

  it("hold: traces a racetrack the size the geometry says it is", () => {
    // The old code moved a whole 6-second step along the heading it would be
    // facing at the END of that step, which traces an arc wider than the one
    // being flown: measured against the exact pattern, up to 711 m out of
    // position. The racetrack came out 0.18 NM too big.
    //
    // The extent is analytic, so this is a check against the geometry rather
    // than against the previous output. Entering at the fix on the inbound
    // course, the pattern is: 180 turn, outbound leg, 180 turn, inbound leg.
    // The farthest the aircraft gets from the fix is on the SECOND turn, whose
    // centre is `hypot(leg, r)` away and whose radius adds r.
    const GS = 230;
    const LEG_SEC = 60;
    const r = GS / 3600 / (3 * (Math.PI / 180)); // v / omega, standard rate
    const leg = (GS / 3600) * LEG_SEC;
    const wantMax = Math.hypot(leg, r) + r;

    const traj = eastbound(120, 35000);
    // The racetrack is flown from where the AIRCRAFT is when the hold is
    // applied, which is what the published fix's coordinates identify rather
    // than replace. That pivot is the centre everything below is measured from.
    const pivot = aircraftAt(toSamples(traj.points), 40)!;
    const out = applyManeuver(
      traj,
      man({
        type: "hold",
        resolution: {
          hold: {
            ident: "FIX",
            lat: pivot.lat,
            lon: pivot.lon,
            inboundCourseDeg: 90,
            turn: "R",
            legSec: LEG_SEC,
            gsKt: GS,
          },
        },
      }),
      40,
    );
    const epoch0 = new Date(out.points[0].epoch_ts).getTime();
    const inLoop = out.points.filter((p) => {
      const t = (new Date(p.epoch_ts).getTime() - epoch0) / 1000;
      return t > 40 && t < 40 + 240;
    });
    const gotMax = Math.max(
      ...inLoop.map(
        (p) =>
          Math.hypot(
            p.lat - pivot.lat,
            (p.lon - pivot.lon) * Math.cos((pivot.lat * Math.PI) / 180),
          ) * 60,
      ),
    );
    // 0.05 NM: the old integrator missed by 0.18, the sampled one by 0.001.
    expect(Math.abs(gotMax - wantMax)).toBeLessThan(0.05);
  });

  it("speed: keeps the geographic path but re-times it for the new gs", () => {
    const traj = eastbound(60, 35000);
    const out = applyManeuver(
      traj,
      man({ type: "speed", resolution: { gsKt: 360 } }),
      40,
    );
    const samples = toSamples(out.points);
    // Ground speed downstream is the new value.
    const late = aircraftAt(samples, 120);
    expect(late!.gsKt).toBeCloseTo(360, 3);
    // The flight now takes LONGER overall (slower), so total duration grew.
    const origDur = toSamples(traj.points).slice(-1)[0].t;
    const newDur = samples.slice(-1)[0].t;
    expect(newDur).toBeGreaterThan(origDur);
  });

  it("speed: the flight-time check follows the re-timed duration (not stale)", () => {
    const base = eastbound(90, 35000);
    // A flight with a flight-time validation attached (as the backend returns).
    const traj: TrajectoryResult = {
      ...base,
      validation: {
        route: "VYYY-VYKT",
        cat62Min: 6,
        simulatedMin: base.stats.timeMinutes,
        deltaMin: Math.round((base.stats.timeMinutes - 6) * 10) / 10,
        thresholdMin: 5,
        status: "PASS",
        passed: true,
        source: "estimate",
      },
    };
    const out = applyManeuver(
      traj,
      man({ type: "speed", resolution: { gsKt: 360 } }), // slow down
      40,
    );
    // The check's "Sim" now equals the recomputed FLIGHT TIME, not the old value.
    expect(out.validation!.simulatedMin).toBe(out.stats.timeMinutes);
    expect(out.validation!.simulatedMin).toBeGreaterThan(traj.stats.timeMinutes);
    // Δ and PASS/FAIL are re-derived from the new duration.
    expect(out.validation!.deltaMin).toBe(
      Math.round((out.stats.timeMinutes - 6) * 10) / 10,
    );
  });
});
