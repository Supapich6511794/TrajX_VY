/**
 * RFL propagation: the form's flight level must reach the checks as feet.
 *
 * The generator holds RFL as a flight level (280), and everything downstream
 * wants feet (28 000). The conversion is `rfl * 100` and it has to survive the
 * whole chain — plan signature, estimated profile, airway band check, area
 * ceiling check — or the check reports against a level the controller never
 * requested.
 *
 * Pinned on the shipped Myanmar AIRAC 2609 data (`aip_VY.json`,
 * `aixm_vy/route_segments.json`, `aixm_vy/restricted_areas.geojson`,
 * `VY_AIP/pdr_activity.json`) along "NIVOG G463 BGO L507 NUNLI", where the
 * published floors are 11 000 ft (NIVOG-BGO), 28 000 ft (BGO-ARATO and
 * ARATO-LUDVI) and 15 000 ft (LUDVI-NUNLI). At FL280 all of them are satisfied
 * and no level finding may be raised.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fix } from "@/lib/aip";
import { resolveRoutePreview } from "@/lib/routePreview";

import { checkAirwayUsage, indexSegments } from "./airwayDirection";
import { buildPdrAreas } from "./areas";
import { analysePdr } from "./detect";
import { climbCruiseDescentFt, pathFromFixes } from "./penetration";
import type { PdrActivityFile } from "./types";

const load = (p: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));
const index = indexSegments(load("aixm_vy/route_segments.json").segments);

/** Exactly what GeneratorPanel does with the form value. */
const toFeet = (rfl: number) => rfl * 100;

const ROUTE = "NIVOG G463 BGO L507 NUNLI";

describe("the form's RFL becomes feet", () => {
  it("converts the reported case", () => {
    expect(toFeet(280)).toBe(28000);
  });

  it("is not special-cased to one level", () => {
    expect(toFeet(210)).toBe(21000);
    expect(toFeet(160)).toBe(16000);
    expect(toFeet(410)).toBe(41000);
  });

  it("drives the estimated profile's cruise altitude", () => {
    const profile = climbCruiseDescentFt({ rflFt: toFeet(280) });
    // Mid-route on a long leg is at cruise.
    expect(profile(200, 400)).toBe(28000);
    const lower = climbCruiseDescentFt({ rflFt: toFeet(210) });
    expect(lower(200, 400)).toBe(21000);
  });
});

describe("FL280 on the route raises no level finding", () => {
  const at = (rfl: number) =>
    checkAirwayUsage(ROUTE, index, toFeet(rfl)).filter((i) => i.kind === "level");

  it("passes every published floor on the route", () => {
    // 11 000 / 28 000 / 15 000 ft floors — FL280 clears all of them.
    expect(at(280)).toEqual([]);
  });

  it("still fails below the highest floor, so the check is doing work", () => {
    // FL160 is under the 28 000 ft BGO-ARATO-LUDVI segments.
    const low = at(160);
    expect(low.length).toBeGreaterThan(0);
    expect(low.some((i) => i.detail.includes("28000"))).toBe(true);
    // ...and over the 15 000 ft LUDVI-NUNLI floor, which must stay silent.
    expect(low.some((i) => i.detail.includes("15000"))).toBe(false);
  });

  it("fails at FL270, one step under the binding floor", () => {
    expect(at(270).length).toBeGreaterThan(0);
  });

  it("passes at FL290, one step over it", () => {
    expect(at(290)).toEqual([]);
  });

  it("treats a missing level as unknown rather than as 0 ft", () => {
    // The bug: 0 ft is below every floor, so every segment was "breached".
    expect(checkAirwayUsage(ROUTE, index, null).filter((i) => i.kind === "level"))
      .toEqual([]);
  });

  it("reports the requested level in feet, not as a flight level", () => {
    const [issue] = at(160);
    expect(issue.detail).toMatch(/requested level is 16000 ft/);
  });
});

describe("the whole plan -> check mapping carries the level", () => {
  // Mirrors what GeneratorPanel builds for one plan: RFL in flight levels,
  // converted once, used BOTH for the estimated profile and for the checks.
  const areas = buildPdrAreas(
    load("aixm_vy/restricted_areas.geojson"),
    load("VY_AIP/pdr_activity.json") as PdrActivityFile,
  );
  const aip = load("aip_VY.json") as {
    waypoints: Record<string, { lat: number; lon: number }>;
    airways: Record<string, string[]>;
  };
  const fixes: Fix[] = Object.entries(aip.waypoints).map(([ident, w]) => ({
    ident,
    lat: w.lat,
    lon: w.lon,
  }));
  const START = Date.UTC(2026, 6, 8, 23, 52);

  const pathFor = (route: string, rfl: number) =>
    pathFromFixes(resolveRoutePreview(route, fixes, aip.airways), {
      startMs: START,
      gsKt: 450,
      altFt: climbCruiseDescentFt({ rflFt: toFeet(rfl) }),
    });

  const check = (rfl: number, route = ROUTE) => {
    const rflFt = toFeet(rfl); // the ONE conversion, as the panel does it
    return analysePdr({
      adep: "VYYY",
      ades: "VYDW",
      filedRoute: route,
      actype: "AT72",
      rflFt,
      gsKt: 450,
      eobtMs: START,
      estimated: true,
      path: pathFor(route, rfl),
      areas,
      // No VY published city-pair table ships yet — the dormant default.
      publishedRoutes: [],
      fixes,
      airways: aip.airways,
      segmentIndex: index,
    });
  };

  it("resolves the whole route from the VY navdata", () => {
    const pts = resolveRoutePreview(ROUTE, fixes, aip.airways);
    expect(pts.length).toBeGreaterThanOrEqual(5);
  });

  it("raises no level finding at FL280 — the reported case", () => {
    const r = check(280);
    expect(r.findings.filter((f) => f.category === "airway-level")).toEqual([]);
  });

  it("raises them at FL160, so the check is not simply silent", () => {
    expect(
      check(160).findings.filter((f) => f.category === "airway-level").length,
    ).toBeGreaterThan(0);
  });

  it("works for another level, not just FL280", () => {
    // FL210 is still under the 28 000 ft segments, FL290 is over them.
    expect(
      check(210).findings.filter((f) => f.category === "airway-level").length,
    ).toBeGreaterThan(0);
    expect(check(290).findings.filter((f) => f.category === "airway-level")).toEqual([]);
  });

  const peakFt = (rfl: number, route = ROUTE) =>
    Math.max(...pathFor(route, rfl).map((p) => p.altFt));

  it("climbs toward the requested level and never above it", () => {
    // ~310 NM: on the 3:1 profile FL280 needs ~168 NM of climb + descent, so
    // it is reached here.
    expect(peakFt(280)).toBeLessThanOrEqual(28000);
    expect(peakFt(280)).toBeGreaterThan(27000);
  });

  it("climbs to a LOWER requested level in full, because the leg is long enough", () => {
    expect(peakFt(160)).toBe(16000);
  });

  it("scales with the requested level rather than being fixed", () => {
    expect(peakFt(210)).toBeGreaterThan(peakFt(160));
    expect(peakFt(280)).toBeGreaterThan(peakFt(210));
  });

  it("checks the airway band against the REQUESTED level, not the peak reached", () => {
    // BGO-ARATO-LUDVI alone is ~160 NM: too short to reach FL280 on the 3:1
    // profile, so the estimated peak sits under the 28 000 ft floor — yet
    // FL280 is what was requested and what the band is judged against.
    const SHORT = "BGO L507 LUDVI";
    expect(peakFt(280, SHORT)).toBeLessThan(28000);
    expect(
      check(280, SHORT).findings.filter((f) => f.category === "airway-level"),
    ).toEqual([]);
  });
});
