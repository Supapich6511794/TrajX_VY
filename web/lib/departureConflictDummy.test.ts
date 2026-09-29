/**
 * A departure-conflict sample with a claim attached: import it and the panel
 * must raise exactly six departure conflicts, one per Doc 4444 rule, and stay
 * silent on the three control pairs. This runs a small inline plan file (a
 * synthetic Yangon departure bank) through the SAME parser the upload button
 * uses and then through the same rules the panel calls, mapping plans to
 * departures the way GeneratorPanel does (track = bearing to the first fix the
 * route names, looked up in the shipped VY AIP navdata).
 *
 * Each pair sits in its own hour so it is only ever checked against its own
 * partner. VYYY runway 03/21 points 033°/213° true; the first fixes used are
 * PARLA (≈001° from VYYY), OSIDA (≈213°), POMEP (≈161°) and YY915 (≈249°).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  eobtToMs,
  findDepartureConflicts,
  initialBearingDeg,
  msToEobt,
  resolvedEobtMs,
  type DepartureFlight,
} from "./departureSeparation";
import { parseFlightFile } from "./flightFile";

const AIP = resolve(__dirname, "../public/data/aip_VY.json");

const CSV = `callsign,actype,adep,ades,eobt,rfl,gs,route,dep_rwy
UBA101,A320,VYYY,VYMD,2026-03-10T01:00,280,450,PARLA DCT OROMO,
UBA102,A320,VYYY,VYMD,2026-03-10T01:00,280,450,PARLA DCT OROMO,
MMA201,B77W,VYYY,WSSS,2026-03-10T02:00,350,480,OSIDA DCT,RW21
UBA202,A320,VYYY,VYKT,2026-03-10T02:01,330,450,OSIDA DCT,RW21
QTR301,A388,VYYY,OTHH,2026-03-10T03:00,380,480,OSIDA DCT,RW21
KMV302,A320,VYYY,WMKK,2026-03-10T03:02,330,450,OSIDA DCT,RW21
KMV401,AT72,VYYY,VYKP,2026-03-10T04:00,200,280,OSIDA DCT,RW21
MMA402,A320,VYYY,WSSS,2026-03-10T04:02,330,450,OSIDA DCT,RW21
UBA501,A320,VYYY,VYMD,2026-03-10T05:00,330,460,PARLA DCT OROMO,RW03
MMA502,AT72,VYYY,VYNT,2026-03-10T05:01,200,280,PARLA DCT,RW03
KMV601,A320,VYYY,VYMD,2026-03-10T06:00,350,450,PARLA DCT OROMO,RW03
UBA600,A320,VYYY,VYMD,2026-03-10T06:00,350,450,PARLA DCT OROMO,RW21
UBA701,A320,VYYY,VYKP,2026-03-10T07:00,300,450,POMEP DCT,RW21
MMA702,A320,VYYY,VYSW,2026-03-10T07:01,300,450,YY915 DCT,RW21
MMA801,A320,VYYY,VYMD,2026-03-10T08:00,300,450,PARLA DCT,RW03
UBA800,A320,VYYY,VYKP,2026-03-10T08:00,300,450,POMEP DCT,RW21
UBA901,B77W,VYYY,RJAA,2026-03-10T09:00,350,480,PARLA DCT,RW03
KMV902,A320,VYYY,VYMD,2026-03-10T09:03,330,450,PARLA DCT,RW03
`;

const records = await parseFlightFile(new File([CSV], "departure_conflict_flights.csv"));

const aip = JSON.parse(readFileSync(AIP, "utf-8")) as {
  waypoints: Record<string, { lat: number; lon: number }>;
  airports: Record<string, { lat: number; lon: number }>;
};

/** The panel's own mapping: a plan becomes a departure, and its track is the
 *  bearing from the aerodrome to the first fix its route names. */
const flights: DepartureFlight[] = records.map((r, i) => {
  const from = aip.airports[r.adep ?? ""];
  const firstFix = (r.route ?? "")
    .toUpperCase()
    .split(/\s+/)
    .find((w) => aip.waypoints[w]);
  const to = firstFix ? aip.waypoints[firstFix] : aip.airports[r.ades ?? ""];
  return {
    id: `p${i + 1}`,
    callsign: r.callsign ?? "",
    actype: r.actype ?? "",
    adep: r.adep ?? "",
    ades: r.ades ?? "",
    eobtMs: eobtToMs(r.eobt ?? ""),
    depRwy: r.depRwy ?? "",
    trackDeg:
      from && to ? initialBearingDeg(from.lat, from.lon, to.lat, to.lon) : null,
    gsKt: r.gsKt ?? 450,
    rfl: r.rfl ?? 350,
  };
});

const conflicts = findDepartureConflicts(flights);
const byPair = new Map(
  conflicts.map((c) => [`${c.leader.callsign}|${c.follower.callsign}`, c]),
);

describe("departure-conflict sample bank", () => {
  it("imports as plans, not as trajectories", () => {
    // The panel must open these as editable tabs and warn — NOT load them
    // as-is, which is what happens when a file carries 4D samples.
    expect(records).toHaveLength(18);
    expect(records.every((r) => r.trajectory == null)).toBe(true);
    for (const r of records) {
      expect(r.callsign).toMatch(/^[A-Z]{3}\d+$/);
      expect(r.adep).toMatch(/^[A-Z]{4}$/);
      expect(r.eobt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(r.route).toBeTruthy();
      expect(r.gsKt).toBeGreaterThan(100);
    }
    // Every first fix resolves in the VY navdata, so every track is known.
    expect(flights.every((f) => f.trackDeg != null)).toBe(true);
  });

  it("raises exactly the six designed conflicts, worst first", () => {
    expect([...byPair.keys()].sort()).toEqual([
      "KMV401|MMA402",
      "KMV601|UBA600",
      "MMA201|UBA202",
      "QTR301|KMV302",
      "UBA101|UBA102",
      "UBA501|MMA502",
    ].sort());
    // Ranked by how much time is missing: the 5-minute rule with 2 minutes
    // filed is the worst of them.
    expect(conflicts[0].follower.callsign).toBe("MMA402");
  });

  it("§7.9.2 — same everything, so the runway itself sets the minute", () => {
    const c = byPair.get("UBA101|UBA102")!;
    expect(c.adep).toBe("VYYY");
    expect(c.gapSec).toBe(0);
    expect(c.requiredSec).toBe(60);
    expect(c.requiredBy).toBe("runway-occupancy");
    // Neither plan names a runway: "Auto", the aerodrome's default.
    expect(c.runway).toBe("Auto");
    expect(c.runwayAssumed).toBe(true);
  });

  it("§5.8.3.1 — MEDIUM behind HEAVY needs 2 min", () => {
    const c = byPair.get("MMA201|UBA202")!;
    expect(c.requiredBy).toBe("wake");
    expect(c.requiredSec).toBe(120);
    expect(c.gapSec).toBe(60);
    expect(c.runway).toBe("RW21");
  });

  it("A380 provisions — a MEDIUM behind a SUPER needs 3 min, not 2", () => {
    // A minute longer than the HEAVY row above it, which is the whole reason
    // the wake table is written out pair by pair rather than derived.
    const c = byPair.get("QTR301|KMV302")!;
    expect(c.requiredBy).toBe("wake");
    expect(c.requiredSec).toBe(180);
    expect(c.gapSec).toBe(120); // filed 2 min apart: exactly a minute short
    expect(c.reason).toContain("3 min");
  });

  it("§5.6.3 — climbing through the level ahead needs 5 min", () => {
    const c = byPair.get("KMV401|MMA402")!;
    expect(c.requiredBy).toBe("level-crossing");
    expect(c.requiredSec).toBe(300);
    expect(c.gapSec).toBe(120);
  });

  it("§5.6.2 — a 40 kt+ faster leader on the same track needs 2 min", () => {
    const c = byPair.get("UBA501|MMA502")!;
    expect(c.requiredBy).toBe("speed");
    expect(c.requiredSec).toBe(120);
    expect(c.gapSec).toBe(60);
  });

  it("§8.7.3 — two runways feeding one path is still a conflict", () => {
    // The pair a runway-keyed check waves through: RW03 and RW21, but both
    // filed PARLA at FL350 and 450 kt, so they climb out in formation.
    const c = byPair.get("KMV601|UBA600")!;
    expect(c.runway).toBe("RW03 / RW21");
    expect(c.runwayAssumed).toBe(false);
    expect(c.requiredBy).toBe("in-trail");
    expect(c.requiredSec).toBe(24); // 3 NM at 450 kt
    expect(c.gapSec).toBe(0);
    // Same track is what makes it one: the runways point opposite ways, the
    // filed paths do not.
    const a = flights.find((f) => f.callsign === "KMV601")!;
    const b = flights.find((f) => f.callsign === "UBA600")!;
    expect(Math.abs(a.trackDeg! - b.trackDeg!)).toBeLessThan(1);
  });

  it("stays silent on the three control pairs", () => {
    // §5.6.1 divergence relief on one runway, the same relief across two, and
    // simply enough time.
    for (const pair of ["UBA701|MMA702", "MMA801|UBA800", "UBA901|KMV902"]) {
      expect(byPair.has(pair)).toBe(false);
    }
    // …and the divergence control really is diverging, not merely spaced out.
    const a = flights.find((f) => f.callsign === "UBA701")!;
    const b = flights.find((f) => f.callsign === "MMA702")!;
    expect(Math.abs(a.trackDeg! - b.trackDeg!)).toBeGreaterThan(45);
    expect((b.eobtMs! - a.eobtMs!) / 1000).toBe(60);
  });

  it("clears completely once each follower takes the suggested EOBT", () => {
    let fixed = flights;
    for (const c of conflicts) {
      const ms = resolvedEobtMs(c, c.follower.id)!;
      fixed = fixed.map((f) =>
        f.id === c.follower.id ? { ...f, eobtMs: eobtToMs(msToEobt(ms)) } : f,
      );
    }
    expect(findDepartureConflicts(fixed)).toEqual([]);
  });
});
