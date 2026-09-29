import { describe, expect, it } from "vitest";

import {
  dedupeHoldings,
  holdingRacetrack,
  holdLegNm,
  type HoldingPattern,
} from "./holdings";

const hold = (over: Partial<HoldingPattern> = {}): HoldingPattern => ({
  ident: "TEST",
  lat: 17,
  lon: 96,
  category: "published",
  region: "VYYY",
  inboundCourseDeg: 0,
  turn: "R",
  legTimeMin: 1,
  legLengthNm: null,
  speedKt: 230,
  minAltFt: null,
  maxAltFt: null,
  procedure: null,
  ...over,
});

/** Rate-one turn radius at 230 kt, and the 1-minute leg at the same speed. */
const R_NM = 230 / (20 * Math.PI);
const LEG_NM = 230 / 60;
const NM_PER_DEG_LAT = 60;
const nmPerDegLon = (lat: number) => 60 * Math.cos((lat * Math.PI) / 180);

describe("holdLegNm", () => {
  it("flies the coded leg time at the holding speed", () => {
    expect(holdLegNm(hold())).toBeCloseTo(LEG_NM, 3);
  });

  it("prefers a coded leg DISTANCE over the leg time", () => {
    expect(holdLegNm(hold({ legLengthNm: 5, legTimeMin: 1 }))).toBe(5);
  });

  it("falls back to the ICAO speed for the altitude band when none is coded", () => {
    // ≤ FL140 → 230 kt; above FL200 → 265 kt.
    expect(holdLegNm(hold({ speedKt: null, minAltFt: 5000 }))).toBeCloseTo(230 / 60, 3);
    expect(holdLegNm(hold({ speedKt: null, minAltFt: 24000 }))).toBeCloseTo(265 / 60, 3);
  });
});

describe("holdingRacetrack", () => {
  it("starts one leg back from the fix and closes on itself", () => {
    const ring = holdingRacetrack(hold());
    const [startLat, startLon] = ring[0];
    // Inbound course 000 → the leg runs up to the fix from the south.
    expect((17 - startLat) * NM_PER_DEG_LAT).toBeCloseTo(LEG_NM, 2);
    expect(startLon).toBeCloseTo(96, 4);
    expect(ring[1]).toEqual([17, 96]);
    // Within a metre — the roll-out is built from great-circle steps, so the
    // ring closes to spherical precision rather than exactly.
    const [endLat, endLon] = ring[ring.length - 1];
    expect(endLat).toBeCloseTo(startLat, 4);
    expect(endLon).toBeCloseTo(startLon, 4);
  });

  it("lays a right-hand pattern to the RIGHT of the inbound track", () => {
    const ring = holdingRacetrack(hold({ turn: "R" }));
    const lons = ring.map(([, lon]) => lon);
    // Inbound course 000 → "right" is east: nothing west of the inbound leg,
    // and the outbound leg sits two turn radii away.
    expect(Math.min(...lons)).toBeCloseTo(96, 3);
    expect((Math.max(...lons) - 96) * nmPerDegLon(17)).toBeCloseTo(2 * R_NM, 1);
  });

  it("mirrors the pattern for a left-hand hold", () => {
    const ring = holdingRacetrack(hold({ turn: "L" }));
    const lons = ring.map(([, lon]) => lon);
    expect(Math.max(...lons)).toBeCloseTo(96, 3);
    expect((96 - Math.min(...lons)) * nmPerDegLon(17)).toBeCloseTo(2 * R_NM, 1);
  });

  it("extends behind the fix by the leg length plus the roll-out turn", () => {
    const ring = holdingRacetrack(hold());
    const lats = ring.map(([lat]) => lat);
    // Furthest point back = the outbound roll-out, one leg + one radius south.
    expect((17 - Math.min(...lats)) * NM_PER_DEG_LAT).toBeCloseTo(LEG_NM + R_NM, 1);
    // The turn over the fix bulges one radius ahead of it.
    expect((Math.max(...lats) - 17) * NM_PER_DEG_LAT).toBeCloseTo(R_NM, 1);
  });
});

describe("dedupeHoldings", () => {
  it("collapses the same racetrack coded in two sources, keeping the specific kind", () => {
    const out = dedupeHoldings([
      hold({ ident: "UNTAB", category: "published", inboundCourseDeg: 36 }),
      hold({ ident: "UNTAB", category: "missed", inboundCourseDeg: 35 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("missed");
  });

  it("ranks HILPT above a missed-approach hold at the same fix", () => {
    const out = dedupeHoldings([
      hold({ ident: "GULNA", category: "missed" }),
      hold({ ident: "GULNA", category: "hilpt" }),
    ]);
    expect(out.map((h) => h.category)).toEqual(["hilpt"]);
  });

  it("keeps genuinely different holds at a shared fix", () => {
    const out = dedupeHoldings([
      // COBAR really is coded twice, on courses 55° apart.
      hold({ ident: "COBAR", category: "published", inboundCourseDeg: 178 }),
      hold({ ident: "COBAR", category: "missed", inboundCourseDeg: 235 }),
      // Same course but the opposite turn is a different pattern too.
      hold({ ident: "COBAR", category: "enroute", inboundCourseDeg: 178, turn: "L" }),
    ]);
    expect(out).toHaveLength(3);
  });

  it("treats the 359°/001° wrap as the same course", () => {
    const out = dedupeHoldings([
      hold({ ident: "WRAP", category: "published", inboundCourseDeg: 359 }),
      hold({ ident: "WRAP", category: "enroute", inboundCourseDeg: 1 }),
    ]);
    expect(out).toHaveLength(1);
  });
});
