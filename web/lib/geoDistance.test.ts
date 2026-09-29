import { describe, expect, it } from "vitest";

import { greatCircleNm } from "@/lib/geoDistance";

/** Spherical law of cosines — an independent formula on the same radius, so a
 *  mistake in the haversine cannot agree with its own expectation. */
function cosineNm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 3440.065;
  const rad = (d: number) => (d * Math.PI) / 180;
  const la1 = rad(a.lat);
  const la2 = rad(b.lat);
  return (
    R *
    Math.acos(
      Math.min(
        1,
        Math.sin(la1) * Math.sin(la2) +
          Math.cos(la1) * Math.cos(la2) * Math.cos(rad(b.lon - a.lon)),
      ),
    )
  );
}

const VYYY = { lat: 16.90726667, lon: 96.13323889 }; // Yangon Intl
const VYHB = { lat: 17.11666667, lon: 96.06666667 }; // Hmawby
const VYMD = { lat: 21.70107222, lon: 95.97745556 }; // Mandalay Intl

describe("greatCircleNm — the Measure tool's readout", () => {
  it("is zero between a point and itself", () => {
    expect(greatCircleNm(VYYY, VYYY)).toBe(0);
  });

  it("puts one degree of latitude at ~60 NM (the definition of the mile)", () => {
    expect(greatCircleNm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(
      60.04,
      2,
    );
  });

  it("matches one degree of longitude at the equator", () => {
    expect(greatCircleNm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(
      60.04,
      2,
    );
  });

  it("shrinks a degree of longitude by cos(lat) away from the equator", () => {
    const atEquator = greatCircleNm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    const at60N = greatCircleNm({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
    expect(at60N).toBeCloseTo(atEquator * Math.cos((60 * Math.PI) / 180), 1);
  });

  it("gets the Yangon–Mandalay leg right (~288 NM)", () => {
    expect(greatCircleNm(VYYY, VYMD)).toBeCloseTo(287.96, 1);
  });

  it("gets the short Yangon pair right (~13.1 NM)", () => {
    expect(greatCircleNm(VYHB, VYYY)).toBeCloseTo(13.14, 2);
  });

  it("is symmetric", () => {
    expect(greatCircleNm(VYHB, VYMD)).toBeCloseTo(greatCircleNm(VYMD, VYHB), 9);
  });

  it("agrees with the spherical law of cosines at every scale", () => {
    for (const [a, b] of [
      [VYYY, VYMD],
      [VYHB, VYYY],
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }],
      [{ lat: -33.9, lon: 151.2 }, { lat: 51.5, lon: -0.1 }], // antipodal-ish
    ] as const) {
      expect(greatCircleNm(a, b)).toBeCloseTo(cosineNm(a, b), 3);
    }
  });

  it("handles the shortest way round the date line", () => {
    const across = greatCircleNm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 });
    expect(across).toBeCloseTo(60.04, 2);
  });
});
