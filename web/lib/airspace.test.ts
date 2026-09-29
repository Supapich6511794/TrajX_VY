import { describe, expect, it } from "vitest";

import { layerBand, parseVyAltFt } from "./airspace";

describe("parseVyAltFt", () => {
  it("reads GND/SFC as the surface", () => {
    expect(parseVyAltFt("GND SFC")).toBe(0);
  });

  it("reads UNL as unlimited", () => {
    expect(parseVyAltFt("UNL STD")).toBe(Infinity);
  });

  it("reads an STD value as a flight level (x100 ft)", () => {
    expect(parseVyAltFt("130 STD")).toBe(13000);
  });

  it("reads an MSL value as feet directly, not a flight level", () => {
    expect(parseVyAltFt("8000 MSL")).toBe(8000);
  });

  it("reads an SFC value as feet directly", () => {
    expect(parseVyAltFt("3300 SFC")).toBe(3300);
  });

  it("returns NaN for null/empty input", () => {
    expect(parseVyAltFt(null)).toBeNaN();
    expect(parseVyAltFt("")).toBeNaN();
  });
});

describe("layerBand for ctr/tma/pdr", () => {
  it("reads the real aixm_vy lower/upper band for ctr", () => {
    const band = layerBand({ lower: "GND SFC", upper: "130 STD" }, "ctr");
    expect(band).toEqual({ lo: 0, hi: 13000 });
  });

  it("reads the real aixm_vy lower/upper band for pdr", () => {
    const band = layerBand({ lower: "GND SFC", upper: "8000 MSL" }, "pdr");
    expect(band).toEqual({ lo: 0, hi: 8000 });
  });
});
