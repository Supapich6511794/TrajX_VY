import { describe, expect, it } from "vitest";

import { buildFlightEvents, type ReportFlight } from "@/lib/report/flightEvents";

/**
 * The waypoint rows come from "the sample that passes closest to each fix". That
 * search ranks samples by a cheap flat distance and only takes the exact
 * great-circle distance over the near-best ones. It must land on the same sample
 * as taking the great-circle distance over every one — including for a fix that
 * the track does not pass through, and on a track that curves back on itself.
 */

const R_NM = 3440.065;
function haversineNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const s =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function flight(seed: number, latBase: number): ReportFlight {
  const next = rng(seed);
  const t0 = Date.UTC(2025, 11, 23, 0, 0, 0);
  const n = 900;
  const points = Array.from({ length: n }, (_, k) => {
    const f = k / (n - 1);
    return {
      // A wandering, doubling-back track so the nearest sample is not simply
      // "the one at the matching fraction of the way along".
      lat: latBase + f * 6 + Math.sin(f * 14) * 0.7,
      lon: 99 + f * 3 + Math.cos(f * 11) * 0.9,
      altitude_ft: 30000,
      epoch_ts: new Date(t0 + k * 4000).toISOString(),
    };
  });
  const route = Array.from({ length: 18 }, (_, k) => ({
    ident: "WP" + k,
    // Some on the track, some well off it (up to ~1.5° ≈ 90 NM away).
    lat: latBase + next() * 6 + (next() - 0.5) * (k % 3 === 0 ? 3 : 0.02),
    lon: 99 + next() * 3 + (next() - 0.5) * (k % 3 === 0 ? 3 : 0.02),
  }));
  return {
    flightKey: "F" + seed,
    callsign: "TST" + seed,
    actype: "A320",
    adep: "VYYY",
    ades: "VYMD",
    points,
    route,
    toc: null,
    tod: null,
  };
}

describe("waypoint rows — nearest sample", () => {
  // Latitudes from the equator to the far north: the flat distance's error is
  // worst where a degree of longitude is shortest.
  for (const [seed, latBase] of [
    [1, 4],
    [2, 13],
    [3, 25],
    [4, 40],
  ] as const) {
    it(`matches the exhaustive great-circle search (seed ${seed}, lat ${latBase}°)`, () => {
      const f = flight(seed, latBase);
      const rows = buildFlightEvents(f, {}).filter((r) => r.event === "WAYPOINT");
      expect(rows).toHaveLength(f.route.length);

      for (const wp of f.route) {
        let best = 0;
        let bestNm = Infinity;
        f.points.forEach((p, i) => {
          const d = haversineNm(p, wp);
          if (d < bestNm) {
            bestNm = d;
            best = i;
          }
        });
        const want = f.points[best];
        const row = rows.find((r) => r.ident === wp.ident)!;
        expect(row.timeUtc).toBe(want.epoch_ts.replace(".000", ""));
        expect(row.latDeg).toBeCloseTo(want.lat, 5);
        expect(row.lonDeg).toBeCloseTo(want.lon, 5);
      }
    });
  }
});
