/**
 * RFL propagation: the form's flight level must reach the checks as feet.
 *
 * The generator holds RFL as a flight level (250), and everything downstream
 * wants feet (25 000). The conversion is `rfl * 100` and it has to survive the
 * whole chain — plan signature, estimated profile, airway band check, area
 * ceiling check — or the check reports against a level the controller never
 * requested.
 *
 * The case this was raised on: RFL 250 filed on VTBS->VTPO via
 * "OLVUK Y26 ELDAL Y32 KIMET", where the published floors are 13 000 ft
 * (OLVUK-UPMUT), 25 000 ft (UPMUT-ELDAL) and 7 000 ft (ELDAL-KIMET). At FL250
 * all three are satisfied and no level finding may be raised.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fix } from "@/lib/aip";
import type { AipRoute } from "@/lib/aipRoutes";
import { resolveRoutePreview } from "@/lib/routePreview";

import { checkAirwayUsage, indexSegments } from "./airwayDirection";
import { buildPdrAreas } from "./areas";
import { analysePdr } from "./detect";
import { pathFromFixes } from "./penetration";
import type { PdrActivityFile } from "./types";
import { climbCruiseDescentFt } from "./penetration";

// VT-only fixtures (Thai AIP published-route table + PDR/sector geometry) were
// removed with the rest of the Thailand data. There is no Myanmar equivalent
// yet, so this whole suite is skipped rather than deleted: re-enable it once
// real VY aip.json / aip_routes.json / sector-corrected PDR geometry exist.
const HAS_VT_FIXTURES = existsSync(
  resolve(__dirname, "../../public/data/aip_VT.json"),
);

if (HAS_VT_FIXTURES) {
  
  const load = (p: string) =>
    JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));
  const index = indexSegments(load("aixm/route_segments.json").segments);
  
  /** Exactly what GeneratorPanel does with the form value. */
  const toFeet = (rfl: number) => rfl * 100;
  
  const ROUTE = "OLVUK Y26 ELDAL Y32 KIMET";
  
  describe("the form's RFL becomes feet", () => {
    it("converts the reported case", () => {
      expect(toFeet(250)).toBe(25000);
    });
  
    it("is not special-cased to one level", () => {
      expect(toFeet(210)).toBe(21000);
      expect(toFeet(160)).toBe(16000);
      expect(toFeet(410)).toBe(41000);
    });
  
    it("drives the estimated profile's cruise altitude", () => {
      const profile = climbCruiseDescentFt({ rflFt: toFeet(250) });
      // Mid-route on a long leg is at cruise.
      expect(profile(200, 400)).toBe(25000);
      const lower = climbCruiseDescentFt({ rflFt: toFeet(210) });
      expect(lower(200, 400)).toBe(21000);
    });
  });
  
  describe("FL250 on the reported route raises no level finding", () => {
    const at = (rfl: number) =>
      checkAirwayUsage(ROUTE, index, toFeet(rfl)).filter((i) => i.kind === "level");
  
    it("passes every published floor on the route", () => {
      // 13 000 / 25 000 / 7 000 ft floors — FL250 clears all three.
      expect(at(250)).toEqual([]);
    });
  
    it("still fails below the highest floor, so the check is doing work", () => {
      // FL160 is under the 25 000 ft UPMUT-ELDAL segment.
      const low = at(160);
      expect(low.length).toBeGreaterThan(0);
      expect(low.some((i) => i.detail.includes("25000"))).toBe(true);
    });
  
    it("fails at FL240, one step under the binding floor", () => {
      expect(at(240).length).toBeGreaterThan(0);
    });
  
    it("passes at FL260, one step over it", () => {
      expect(at(260)).toEqual([]);
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
      load("sectors_corrected/pdr.geojson"),
      load("aixm/pdr_activity.json") as PdrActivityFile,
    );
    const routes = (load("aip_routes_VT.json") as { routes: AipRoute[] }).routes;
    const aip = load("aip_VT.json") as {
      waypoints: Record<string, { lat: number; lon: number }>;
      airways: Record<string, string[]>;
    };
    const fixes: Fix[] = Object.entries(aip.waypoints).map(([ident, w]) => ({
      ident,
      lat: w.lat,
      lon: w.lon,
    }));
    const START = Date.UTC(2026, 6, 8, 23, 52);
  
    const check = (rfl: number) => {
      const rflFt = toFeet(rfl); // the ONE conversion, as the panel does it
      const pts = resolveRoutePreview(ROUTE, fixes, aip.airways);
      return analysePdr({
        adep: "VTBS",
        ades: "VTPO",
        filedRoute: ROUTE,
        actype: "AT76",
        rflFt,
        gsKt: 450,
        eobtMs: START,
        estimated: true,
        path: pathFromFixes(pts, {
          startMs: START,
          gsKt: 450,
          altFt: climbCruiseDescentFt({ rflFt }),
        }),
        areas,
        publishedRoutes: routes,
        fixes,
        airways: aip.airways,
        segmentIndex: index,
      });
    };
  
    it("raises no level finding at FL250 — the reported case", () => {
      const r = check(250);
      expect(r.findings.filter((f) => f.category === "airway-level")).toEqual([]);
    });
  
    it("raises them at FL160, so the check is not simply silent", () => {
      expect(
        check(160).findings.filter((f) => f.category === "airway-level").length,
      ).toBeGreaterThan(0);
    });
  
    it("works for another level, not just FL250", () => {
      // FL210 is still under the 25 000 ft segment, FL260 is over it.
      expect(
        check(210).findings.filter((f) => f.category === "airway-level").length,
      ).toBeGreaterThan(0);
      expect(check(260).findings.filter((f) => f.category === "airway-level")).toEqual([]);
    });
  
    const peakFt = (rfl: number) => {
      const pts = resolveRoutePreview(ROUTE, fixes, aip.airways);
      const path = pathFromFixes(pts, {
        startMs: START,
        gsKt: 450,
        altFt: climbCruiseDescentFt({ rflFt: toFeet(rfl) }),
      });
      return Math.max(...path.map((p) => p.altFt));
    };
  
    it("climbs toward the requested level and never above it", () => {
      // VTBS-VTPO is ~227 NM, so on the 3:1 profile the aircraft tops out around
      // 22 500 ft and never actually reaches FL250 — correct for a short leg, and
      // the reason this asserts a ceiling rather than an equality.
      const peak = peakFt(250);
      expect(peak).toBeLessThanOrEqual(25000);
      expect(peak).toBeGreaterThan(20000);
    });
  
    it("climbs to a LOWER requested level in full, because the leg is long enough", () => {
      expect(peakFt(160)).toBe(16000);
    });
  
    it("scales with the requested level rather than being fixed", () => {
      expect(peakFt(210)).toBeGreaterThan(peakFt(160));
      expect(peakFt(250)).toBeGreaterThan(peakFt(210));
    });
  
    it("checks the airway band against the REQUESTED level, not the peak reached", () => {
      // The peak is ~22 500 ft, below the 25 000 ft UPMUT-ELDAL floor, yet FL250
      // is what was requested and what the band is judged against.
      expect(peakFt(250)).toBeLessThan(25000);
      expect(check(250).findings.filter((f) => f.category === "airway-level")).toEqual([]);
    });
  });

} else {
  describe.skip("RFL propagation against real AIP data (needs VY fixtures)", () => {
    it("skipped: no VT fixtures on disk and no VY equivalent yet", () => {});
  });
}
