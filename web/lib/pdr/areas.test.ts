/**
 * The join between the PDR polygons and their published activity times, and
 * the vertical limits read off the polygons.
 *
 * Run against the shipped Myanmar data (`aixm_vy/restricted_areas.geojson` +
 * `VY_AIP/pdr_activity.json`), because the failure modes here are data ones:
 * a polygon whose schedule does not join, a limit string the parser does not
 * know, or an area published with a timetable and no geometry — which can never
 * be detected at all and must be a known quantity rather than a surprise.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseVyAltFt } from "@/lib/airspace";

import { synthActivity, synthGeo } from "./__fixtures__/vyPdr";
import { areaKey, areasWithoutSchedule, buildPdrAreas } from "./areas";
import type { PdrActivityFile } from "./types";

const load = (p: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));

const activity = load("VY_AIP/pdr_activity.json") as PdrActivityFile;
const geo = load("aixm_vy/restricted_areas.geojson") as { features: GeoJSON.Feature[] };
const areas = buildPdrAreas(geo, activity);

describe("areaKey", () => {
  it("joins class and designator the way the map labels them", () => {
    expect(areaKey("R", "13")).toBe("R13");
    expect(areaKey("d", " 23a ")).toBe("D23A");
  });

  it("is empty without a designator, so the caller can fall back", () => {
    expect(areaKey("R", "")).toBe("");
    expect(areaKey("R", undefined)).toBe("");
  });
});

describe("parseVyAltFt covers every limit string the PDR data uses", () => {
  it("parses every lower and upper limit in the shipped polygons", () => {
    for (const f of geo.features) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      expect(Number.isNaN(parseVyAltFt(p.lower))).toBe(false);
      expect(Number.isNaN(parseVyAltFt(p.upper))).toBe(false);
    }
  });

  it("reads the AIP-style tokens", () => {
    expect(parseVyAltFt("GND SFC")).toBe(0);
    expect(parseVyAltFt("UNL STD")).toBe(Infinity);
    expect(parseVyAltFt("240 STD")).toBe(24000);
    expect(parseVyAltFt("8000 MSL")).toBe(8000);
  });
});

describe("the joined VY areas", () => {
  it("keeps one area per polygon and gives every polygon a record", () => {
    expect(areas.length).toBe(geo.features.length);
    expect(areasWithoutSchedule(areas)).toEqual([]);
  });

  it("keys areas by class + designator, e.g. R13 and D23A", () => {
    const idents = new Set(areas.map((a) => a.ident));
    expect(idents.has("P5")).toBe(true);
    expect(idents.has("R13")).toBe(true);
    expect(idents.has("D23A")).toBe(true);
    for (const a of areas) expect(a.ident).toMatch(/^[PRD]\d+[A-Z]?$/);
  });

  it("joins every polygon of a multi-polygon area to the same record", () => {
    const r13 = areas.filter((a) => a.ident === "R13");
    expect(r13.length).toBeGreaterThan(1);
    for (const a of r13) {
      expect(a.activity?.designator).toBe("13");
      expect(a.name).toBe("SHANTE");
    }
  });

  it("keeps lettered sub-areas separate", () => {
    const subs = [...new Set(areas.filter((a) => /^R19[A-D]$/.test(a.ident)).map((a) => a.ident))];
    expect(subs.sort()).toEqual(["R19A", "R19B", "R19C", "R19D"]);
    for (const a of areas.filter((x) => x.ident === "R19B")) {
      expect(a.activity?.designator).toBe("19B");
    }
  });

  it("gives every area a usable vertical band", () => {
    for (const a of areas) {
      expect(Number.isNaN(a.lowerFt)).toBe(false);
      expect(a.upperFt).toBeGreaterThan(a.lowerFt);
    }
  });

  it("reads the published band, not a default", () => {
    // P5 YANGON CITY is GND to FL240.
    const p5 = areas.find((a) => a.ident === "P5")!;
    expect(p5.lowerFt).toBe(0);
    expect(p5.upperFt).toBe(24000);
    // R13 SHANTE is GND to 8000 ft MSL.
    const r13 = areas.find((a) => a.ident === "R13")!;
    expect(r13.upperFt).toBe(8000);
  });

  it("keeps the polygon class and the AIXM class in step", () => {
    for (const a of areas) {
      if (a.activity) expect(a.activity.type).toBe(a.kind);
    }
  });

  it("places every area inside the Yangon FIR", () => {
    for (const a of areas) {
      const [minLon, minLat, maxLon, maxLat] = a.bbox;
      expect(minLon).toBeGreaterThan(92);
      expect(maxLon).toBeLessThan(102);
      expect(minLat).toBeGreaterThan(9);
      expect(maxLat).toBeLessThan(29);
    }
  });
});

describe("published areas with no geometry", () => {
  it("is none: every VY activity record has a polygon", () => {
    const withPolygon = new Set(areas.map((a) => a.ident));
    const missing = activity.areas
      .map((a) => areaKey(a.type, a.designator))
      .filter((k) => !withPolygon.has(k));
    expect(missing).toEqual([]);
  });
});

describe("failing closed", () => {
  it("treats every area as unscheduled when the activity file is missing", () => {
    const bare = buildPdrAreas(synthGeo, null);
    expect(bare.length).toBe(synthGeo.features.length);
    expect(bare.every((a) => a.activity === null)).toBe(true);
    expect(areasWithoutSchedule(bare).length).toBeGreaterThan(0);
  });

  it("returns nothing, not a throw, when the overlay is missing", () => {
    expect(buildPdrAreas(null, synthActivity)).toEqual([]);
  });

  it("does not join a record of a different class with the same number", () => {
    const wrongClass: PdrActivityFile = {
      ...synthActivity,
      areas: synthActivity.areas.map((a) => ({ ...a, type: a.type === "D" ? "R" : "D" })),
    };
    const joined = buildPdrAreas(synthGeo, wrongClass);
    expect(joined.every((a) => a.activity === null)).toBe(true);
  });

  it("falls back to a combined ident when a feature has no designator", () => {
    const legacy = {
      features: [
        {
          type: "Feature" as const,
          properties: { ident: "D91", type: "D", lowerlimit: "GND", upperlimit: "FL200" },
          geometry: synthGeo.features[0].geometry,
        },
      ],
    };
    const [a] = buildPdrAreas(legacy, synthActivity);
    expect(a.ident).toBe("D91");
    expect(a.activity?.name).toBe("SYNTH WEEKDAY");
    expect(a.upperFt).toBe(20000);
  });
});
