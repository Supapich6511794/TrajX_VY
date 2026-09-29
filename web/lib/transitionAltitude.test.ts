/**
 * Pinned on the shipped AIP Myanmar Table 3.6 file
 * (`public/data/VY_AIP/transition_altitudes.json`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FALLBACK_TRANSITION_FT,
  flightLevelThresholdFt,
  transitionAltitudeFt,
  transitionLevelFt,
  type TransitionEntry,
  type TransitionTable,
} from "./transitionAltitude";

const file = JSON.parse(
  readFileSync(resolve(__dirname, "../public/data/VY_AIP/transition_altitudes.json"), "utf-8"),
) as { aerodromes: TransitionEntry[] };
const table: TransitionTable = new Map(file.aerodromes.map((e) => [e.icao, e]));

describe("AIP Myanmar Table 3.6", () => {
  it("covers the main aerodromes with their published TA / TL", () => {
    expect(transitionAltitudeFt(table, "VYYY")).toBe(6000);
    expect(transitionLevelFt(table, "VYYY")).toBe(7500);
    expect(transitionAltitudeFt(table, "VYMD")).toBe(6000);
    expect(transitionAltitudeFt(table, "VYNT")).toBe(9000);
    expect(transitionLevelFt(table, "VYNT")).toBe(10500);
    expect(transitionAltitudeFt(table, "VYPT")).toBe(17000);
  });

  it("keeps every TL 1 500 ft above its TA", () => {
    for (const e of file.aerodromes) {
      if (e.transition_altitude_ft == null) continue;
      expect(e.transition_level_fl! * 100 - e.transition_altitude_ft, e.icao).toBe(1500);
    }
  });

  it("returns null for an aerodrome the table prints as '-'", () => {
    expect(transitionAltitudeFt(table, "VYKU")).toBeNull();
  });
});

describe("flightLevelThresholdFt", () => {
  it("uses the departure TA climbing and the destination TL descending", () => {
    expect(flightLevelThresholdFt(table, "climb", "VYYY", "VYNT")).toBe(6000);
    expect(flightLevelThresholdFt(table, "cruise", "VYYY", "VYNT")).toBe(6000);
    expect(flightLevelThresholdFt(table, "descent", "VYYY", "VYNT")).toBe(10500);
  });

  it("falls back for an unpublished or foreign aerodrome", () => {
    expect(flightLevelThresholdFt(table, "climb", "VTBS", "VYYY")).toBe(FALLBACK_TRANSITION_FT);
    expect(flightLevelThresholdFt(table, "descent", "VYYY", "VYKU")).toBe(FALLBACK_TRANSITION_FT);
  });
});
