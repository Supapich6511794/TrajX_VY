/**
 * The strategic scan's pair prefilter.
 *
 * `scanFlightPlanConflicts` is O(n²) over the whole traffic set and reruns
 * whenever a trajectory changes — after every applied fix. At a 2 000-flight
 * import that walked ~2 million shared timelines and froze the tab for six
 * seconds a time. The fix is to reject a pair that cannot meet before walking
 * it, which is only safe if it rejects NOTHING a walk would have found: these
 * tests pin both halves of that.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { scanFlightPlanConflicts, type PlanFlight } from "./planScan";

const cfg = resolveConfig();

/** A straight leg: `n` samples at 5 s, 450 kt, on a constant track. */
function leg(
  id: string,
  lat: number,
  lon: number,
  trackDeg: number,
  altFt: number,
  offsetSec = 0,
  n = 240,
): PlanFlight {
  const step = 5;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const east = Math.sin((trackDeg * Math.PI) / 180);
  const north = Math.cos((trackDeg * Math.PI) / 180);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const nm = (450 * i * step) / 3600;
    samples.push({
      t: i * step,
      lat: lat + (nm * north) / 60,
      lon: lon + (nm * east) / nmPerDegLon,
      altitudeFt: altFt,
      gsKt: 450,
      tasKt: 450,
      track: trackDeg,
      phase: "cruise" as const,
    });
  }
  return { id, callsign: id, samples, offsetSec, durationSec: (n - 1) * step };
}

describe("scanFlightPlanConflicts", () => {
  it("finds a head-on pair at the same level", () => {
    const lat = 13;
    const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
    const a = leg("A", lat, 100, 90, 35000);
    const b = leg("B", lat, 100 + 40 / nmPerDegLon, 270, 35000);
    const [c] = scanFlightPlanConflicts([a, b], cfg);
    expect(c).toBeDefined();
    expect(c.definite).toBe(true);
    // The 15 s scan step lands within a couple of miles of the true CPA — at a
    // 900 kt closure that is one step's worth, and well inside the minima.
    expect(c.dCpaNm).toBeLessThan(2);
  });

  it("still finds it with a hundred unrelated flights in the way", () => {
    // The prefilter has to remove the noise WITHOUT removing the pair.
    const lat = 13;
    const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
    const all: PlanFlight[] = [
      leg("A", lat, 100, 90, 35000),
      leg("B", lat, 100 + 40 / nmPerDegLon, 270, 35000),
    ];
    for (let i = 0; i < 100; i++) {
      all.push(leg(`N${i}`, 6 + i / 10, 97 + (i % 7), (i * 31) % 360, 30000 + (i % 5) * 2000, i * 600));
    }
    const ids = scanFlightPlanConflicts(all, cfg).map((c) => `${c.a}|${c.b}`);
    expect(ids).toContain("A|B");
  });

  it("rejects a pair separated by altitude alone", () => {
    // Same track, same time, same place — 10 000 ft apart.
    const a = leg("A", 13, 100, 90, 35000);
    const b = leg("B", 13, 100, 90, 25000);
    expect(scanFlightPlanConflicts([a, b], cfg)).toEqual([]);
  });

  it("rejects a pair that is never airborne at the same time", () => {
    const lat = 13;
    const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
    const a = leg("A", lat, 100, 90, 35000);
    const b = leg("B", lat, 100 + 40 / nmPerDegLon, 270, 35000, 100_000);
    expect(scanFlightPlanConflicts([a, b], cfg)).toEqual([]);
  });

  it("rejects a pair whose paths never come near each other", () => {
    // Airborne together, same level, 400 NM apart — the case that used to cost
    // a full timeline walk each.
    const a = leg("A", 13, 100, 90, 35000);
    const b = leg("B", 13, 107, 90, 35000);
    expect(scanFlightPlanConflicts([a, b], cfg)).toEqual([]);
  });

  it("scales: a thousand flights scan in well under a second", () => {
    const all: PlanFlight[] = [];
    for (let i = 0; i < 1000; i++) {
      all.push(
        leg(`F${i}`, 6 + ((i * 7) % 130) / 10, 97 + ((i * 11) % 70) / 10, (i * 37) % 360, 20000 + (i % 8) * 2000, (i % 400) * 90),
      );
    }
    const t = Date.now();
    scanFlightPlanConflicts(all, cfg);
    // Shared CI runners are 2–3x slower than a dev machine; the looser budget
    // there still catches a return to the quadratic full-timeline walk.
    expect(Date.now() - t).toBeLessThan(process.env.CI ? 5000 : 1000);
  });
});
