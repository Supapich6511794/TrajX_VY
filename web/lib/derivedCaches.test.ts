/**
 * The map, MapApp and the CD&R loop each derive per-route tables (sample
 * tables, airspace segments) from a trajectory's points. All three memos are
 * keyed on the trajectory ARRAY, which an applied CD&R fix replaces even though
 * it only changes ONE flight — so without a per-route cache a full traffic day
 * was re-derived on every Apply, which froze the tab. These tests lock in that
 * the derivation is keyed on the point array itself.
 */
import { describe, expect, it } from "vitest";

import { buildAirspaceIndex, buildAirspaceSegments } from "./airspace";
import { toSamples } from "./useSimPlayback";
import type { TrajectoryPoint } from "./trajectory/types";

const pt = (i: number, lat: number, lon: number): TrajectoryPoint => ({
  lat,
  lon,
  epoch_ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 10)).toISOString(),
  altitude_ft: 10000 + i * 100,
  gs_kt: 420,
  tas_kt: 440,
  track_deg: 90,
  phase: "cruise",
});

const route = (n: number, lat0 = 17): TrajectoryPoint[] =>
  Array.from({ length: n }, (_, i) => pt(i, lat0 + i * 0.01, 96 + i * 0.01));

/** A one-polygon sector index covering the sample routes. */
const index = buildAirspaceIndex({
  cta: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { type: "CTA", name: "TEST CTA", lower: "GND SFC", upper: "UNL STD" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [95, 5],
              [110, 5],
              [110, 25],
              [95, 25],
              [95, 5],
            ],
          ],
        },
      },
    ],
  },
} as never);

describe("toSamples", () => {
  it("returns the same table for the same point array", () => {
    const pts = route(50);
    expect(toSamples(pts)).toBe(toSamples(pts));
  });

  it("derives a fresh table for a replaced flight's points", () => {
    const a = route(50);
    const b = route(50, 18);
    expect(toSamples(a)).not.toBe(toSamples(b));
    expect(toSamples(b)[0].lat).toBeCloseTo(18, 6);
  });

  it("still measures elapsed seconds from the first point", () => {
    const s = toSamples(route(4));
    expect(s.map((x) => x.t)).toEqual([0, 10, 20, 30]);
  });
});

describe("buildAirspaceSegments", () => {
  it("walks a route once and reuses the result", () => {
    const pts = route(200);
    const first = buildAirspaceSegments(index, pts);
    expect(first.length).toBeGreaterThan(0);
    expect(buildAirspaceSegments(index, pts)).toBe(first);
  });

  it("re-walks when the sector index is rebuilt", () => {
    const pts = route(20);
    const first = buildAirspaceSegments(index, pts);
    const rebuilt = buildAirspaceIndex({
      cta: { type: "FeatureCollection", features: [] },
    } as never);
    // A different index means different volumes — the cached answer must not
    // be handed back for it.
    expect(buildAirspaceSegments(rebuilt, pts)).not.toBe(first);
  });
});
