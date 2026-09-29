/**
 * The route picker must predict flight times for the aircraft being flown.
 *
 * The curve comes from the server, derived from the type's own Thai APM
 * performance, and an airframe with no Thai APM data of its own is reported
 * unsupported instead of being approximated by another airframe's curve.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  estimateSimMin,
  fetchFlightTimeCurve,
  isSupportedCurve,
  type FlightTimeCurve,
} from "./flightTimeCurve";

/** An AT76 curve at FL180, as /api/flight_time_curve serves it. */
const ATR_CURVE: FlightTimeCurve = {
  aircraftType: "AT76",
  points: [
    [0, 0],
    [100, 27.23],
    [200, 50.6],
    [320, 78.63],
  ],
  marginMin: 3,
  dataset: "Thai APM (thaiapm-202607, ISA+15) [sqlite]",
};

function stubCurveResponse(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
}

describe("estimateSimMin", () => {
  it("interpolates between the curve's sampled distances", () => {
    // Halfway between 100 NM (27.23) and 200 NM (50.6).
    expect(estimateSimMin(ATR_CURVE, 150)).toBeCloseTo(38.915, 2);
  });

  it("returns the sampled value at a sample point", () => {
    expect(estimateSimMin(ATR_CURVE, 200)).toBeCloseTo(50.6, 5);
  });

  it("extrapolates along the last segment past the end of the curve", () => {
    const beyond = estimateSimMin(ATR_CURVE, 400);
    expect(beyond).toBeGreaterThan(78.63);
  });

  it("clamps at or below the first point", () => {
    expect(estimateSimMin(ATR_CURVE, -50)).toBe(0);
  });

  it("rises with distance", () => {
    const times = [40, 120, 260, 400].map((d) => estimateSimMin(ATR_CURVE, d));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("fetchFlightTimeCurve", () => {
  it("reads a supported curve, keeping the dataset it came from", async () => {
    stubCurveResponse({
      aircraft_type: "AT76",
      supported: true,
      dataset: "Thai APM (thaiapm-202607, ISA+15) [sqlite]",
      margin_min: 3,
      points: [
        [0, 0],
        [100, 27.23],
      ],
    });
    const curve = await fetchFlightTimeCurve("at76", 18000);
    expect(isSupportedCurve(curve)).toBe(true);
    expect((curve as FlightTimeCurve).dataset).toContain("Thai APM");
  });

  it("reports an unsupported airframe instead of approximating it", async () => {
    stubCurveResponse({
      aircraft_type: "SF34",
      supported: false,
      reason: "SF34 has no own speed schedule — would substitute B738",
      points: [],
    });
    const curve = await fetchFlightTimeCurve("SF34", 18000);
    expect(isSupportedCurve(curve)).toBe(false);
  });

  it("treats a failed request as unsupported, never as a default curve", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    const curve = await fetchFlightTimeCurve("AT76", 18000);
    expect(isSupportedCurve(curve)).toBe(false);
  });
});

describe("no aircraft-blind fallback survives in this module", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("./flightTimeCurve.ts", import.meta.url)),
    "utf8",
  );

  it("carries no hard-coded distance-to-time table", () => {
    expect(SRC).not.toMatch(/SIM_TIME_TABLE/);
  });

  it("no longer calls the retired CAT062 reference endpoint", () => {
    expect(SRC).not.toMatch(/cat62_reference/);
  });

  it("cannot estimate without a curve for a specific airframe", () => {
    // The estimator takes a FlightTimeCurve as its first argument, so there
    // is no distance-only path left to call.
    expect(estimateSimMin.length).toBe(2);
  });
});
