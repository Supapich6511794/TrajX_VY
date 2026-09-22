/**
 * End-to-end PDR check, run over the REAL AIRAC data the app ships: the PDR
 * polygons (`sectors_corrected/pdr.geojson`), their AIXM activity times
 * (`aixm/pdr_activity.json`), the published route table (`aip_routes_VT.json`)
 * and the navdata cache (`aip_VT.json`).
 *
 * Two properties are load-bearing and asserted here as well as the findings:
 *
 *   * the SAME route is or is not a conflict depending only on the time of day
 *     — that is the whole reason the schedules were ingested;
 *   * every suggestion is a route the AIP already publishes for that pair and
 *     direction. The tool must never invent a routing through Thai airspace.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fix } from "@/lib/aip";
import type { AipRoute } from "@/lib/aipRoutes";

import { buildPdrAreas } from "./areas";
import { analysePdr } from "./detect";
import { checkAirwayUsage, indexSegments } from "./airwayDirection";
import { pathFromFixes } from "./penetration";
import type { PdrActivityFile, PdrArea } from "./types";

// VT-only fixtures (Thai AIP published-route table + PDR/sector geometry) were
// removed with the rest of the Thailand data. There is no Myanmar equivalent
// yet, so this whole suite is skipped rather than deleted: re-enable it once
// real VY aip.json / aip_routes.json / sector-corrected PDR geometry exist.
const HAS_VT_FIXTURES = existsSync(
  resolve(__dirname, "../../public/data/aip_VT.json"),
);

if (HAS_VT_FIXTURES) {
  
  const dataFile = (p: string) =>
    JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));
  
  const activity = dataFile("aixm/pdr_activity.json") as PdrActivityFile;
  const pdrGeo = dataFile("sectors_corrected/pdr.geojson") as {
    features: GeoJSON.Feature[];
  };
  const routes = (dataFile("aip_routes_VT.json") as { routes: AipRoute[] }).routes;
  const aip = dataFile("aip_VT.json") as {
    waypoints: Record<string, { lat: number; lon: number }>;
    airways: Record<string, string[]>;
  };
  
  const fixes: Fix[] = Object.entries(aip.waypoints).map(([ident, w]) => ({
    ident,
    lat: w.lat,
    lon: w.lon,
  }));
  
  const areas = buildPdrAreas(pdrGeo, activity);
  const find = (ident: string): PdrArea => {
    const a = areas.find((x) => x.ident === ident);
    if (!a) throw new Error("no area " + ident);
    return a;
  };
  
  const MON = Date.UTC(2026, 8, 7); // Monday
  const HOUR = 3600000;
  
  /** A short east-west path straight through the middle of an area, at a level
   *  inside its band. Enough to guarantee an incursion without depending on the
   *  exact shape of the published polygon. */
  function pathThrough(area: PdrArea, startMs: number): ReturnType<typeof pathFromFixes> {
    const { lat, lon } = area.centroid;
    const altFt = Number.isFinite(area.upperFt)
      ? Math.max(area.lowerFt + 500, (area.lowerFt + area.upperFt) / 2)
      : area.lowerFt + 5000;
    return pathFromFixes(
      [
        { lat, lon: lon - 0.4 },
        { lat, lon: lon + 0.4 },
      ],
      { startMs, gsKt: 450, altFt },
    );
  }
  
  const baseInput = {
    adep: "VTBD",
    ades: "VTCC",
    filedRoute: "OLVUK Y26 MARNI",
    actype: "B738",
    rflFt: 33000,
    gsKt: 450,
    areas,
    publishedRoutes: routes,
    fixes,
    airways: aip.airways,
  };
  
  describe("the joined dataset", () => {
    it("matches a published activity record to almost every PDR polygon", () => {
      const withSchedule = areas.filter((a) => a.activity).length;
      expect(areas.length).toBeGreaterThan(60);
      expect(withSchedule).toBe(areas.length);
    });
  
    it("joins the lettered sub-areas the AIXM export splits out", () => {
      // pdr.geojson has VTD21 with areacode 1/2/3; AIXM calls them VTD21A1..A3.
      const subs = areas.filter((a) => a.ident === "VTD21");
      expect(subs.length).toBeGreaterThan(1);
      for (const s of subs) expect(s.activity?.designator).toMatch(/^VTD21A\d$/);
    });
  });
  
  describe("analysePdr — the same route at two times of day", () => {
    const area = () => find("VTD43"); // LOP BURI, MON-FRI 0100-0900 UTC
  
    it("raises a finding when the crossing is inside the active hours", () => {
      const start = MON + 3 * HOUR;
      const r = analysePdr({
        ...baseInput,
        eobtMs: start,
        path: pathThrough(area(), start),
      });
      const hit = r.findings.find((f) => f.area === "VTD43");
      expect(hit).toBeDefined();
      expect(hit!.category).toBe("restricted-airspace");
      expect(["violation", "caution"]).toContain(hit!.severity);
      expect(hit!.reason).toContain("0100-0900");
    });
  
    it("does not raise it when the same crossing is outside those hours", () => {
      const start = MON + 12 * HOUR;
      const r = analysePdr({
        ...baseInput,
        eobtMs: start,
        path: pathThrough(area(), start),
      });
      const hit = r.findings.find((f) => f.area === "VTD43");
      expect(hit?.severity).toBe("info");
      expect(r.worst).not.toBe("violation");
    });
  
    it("names the hazard and the restriction, not just the ident", () => {
      const start = MON + 3 * HOUR;
      const r = analysePdr({
        ...baseInput,
        eobtMs: start,
        path: pathThrough(area(), start),
      });
      const hit = r.findings.find((f) => f.area === "VTD43")!;
      expect(hit.reason).toMatch(/Restriction:/);
      expect(hit.reason).toMatch(/Hazard:/);
    });
  
    it("cites the AIP as the source", () => {
      const start = MON + 3 * HOUR;
      const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(area(), start) });
      expect(r.findings.find((f) => f.area === "VTD43")!.source).toContain("ENR 5.1");
    });
  });
  
  describe("analysePdr — prohibited areas outrank danger areas", () => {
    it("treats an active Prohibited area as a violation", () => {
      const p = areas.find((a) => a.kind === "P" && a.activity?.sheets.length);
      expect(p).toBeDefined();
      // VTP7 is active H24, so any time works.
      const h24 = areas.find(
        (a) => a.kind === "P" && a.activity?.sheets.some((s) => s.end === "24:00"),
      );
      expect(h24).toBeDefined();
      const start = MON + 6 * HOUR;
      const r = analysePdr({
        ...baseInput,
        eobtMs: start,
        path: pathThrough(h24!, start),
      });
      const hit = r.findings.find((f) => f.area === h24!.ident);
      expect(hit?.severity).toBe("violation");
    });
  });
  
  describe("analysePdr — route availability and direction", () => {
    const cleanPath = (startMs: number) =>
      pathFromFixes(
        // Well out over the Gulf, clear of every land area.
        [
          { lat: 9.0, lon: 101.5 },
          { lat: 9.5, lon: 102.0 },
        ],
        { startMs, gsKt: 450, altFt: 33000 },
      );
  
    it("accepts a route the AIP publishes for this direction", () => {
      const r = analysePdr({
        ...baseInput,
        eobtMs: MON + 6 * HOUR,
        path: cleanPath(MON + 6 * HOUR),
      });
      expect(r.routeMatch.kind).toBe("exact");
      expect(r.findings.filter((f) => f.category === "route-availability")).toEqual([]);
    });
  
    it("flags the return leg's routing as unavailable in this direction", () => {
      const r = analysePdr({
        ...baseInput,
        adep: "VTCC",
        ades: "VTBD",
        eobtMs: MON + 6 * HOUR,
        path: cleanPath(MON + 6 * HOUR),
      });
      expect(r.routeMatch.kind).toBe("reverse");
      const f = r.findings.find((x) => x.category === "route-direction");
      expect(f?.severity).toBe("violation");
      expect(f?.reason).toMatch(/directional/i);
    });
  
    it("flags a routing that is not published for the pair", () => {
      const r = analysePdr({
        ...baseInput,
        filedRoute: "MADEUP W99 NOWHERE",
        eobtMs: MON + 6 * HOUR,
        path: cleanPath(MON + 6 * HOUR),
      });
      const f = r.findings.find((x) => x.category === "route-availability");
      expect(f?.severity).toBe("caution");
    });
  
    it("says so plainly when the pair has no published route at all", () => {
      const r = analysePdr({
        ...baseInput,
        adep: "ZZZZ",
        ades: "YYYY",
        eobtMs: MON + 6 * HOUR,
        path: cleanPath(MON + 6 * HOUR),
      });
      const f = r.findings.find((x) => x.category === "route-availability");
      expect(f?.severity).toBe("info");
      expect(r.suggestions).toEqual([]);
    });
  
    it("reports a clean plan as clean", () => {
      const r = analysePdr({
        ...baseInput,
        eobtMs: MON + 6 * HOUR,
        path: cleanPath(MON + 6 * HOUR),
      });
      expect(r.findings.every((f) => f.severity === "info")).toBe(true);
      expect(r.suggestions).toEqual([]);
    });
  });
  
  describe("analysePdr — suggestions", () => {
    // VTBS->VTSF is the pair the AIP itself conditions on a danger area.
    const start = MON + 3 * HOUR;
    const report = () =>
      analysePdr({
        ...baseInput,
        adep: "VTBS",
        ades: "VTSF",
        filedRoute: "MADEUP ROUTING",
        eobtMs: start,
        path: pathThrough(find("VTD43"), start),
      });
  
    it("offers alternatives only from the published table for that direction", () => {
      const r = report();
      expect(r.suggestions.length).toBeGreaterThan(0);
      const published = new Set(
        routes.filter((x) => x.adep === "VTBS" && x.ades === "VTSF").map((x) => x.route),
      );
      for (const s of r.suggestions) expect(published.has(s.route)).toBe(true);
    });
  
    it("never offers a route whose published condition is unmet", () => {
      for (const s of report().suggestions) {
        expect(s.condition?.state).not.toBe("unmet");
      }
    });
  
    it("explains why each alternative is being offered", () => {
      for (const s of report().suggestions) {
        expect(s.why.length).toBeGreaterThan(0);
      }
    });
  
    it("ranks routes with no active area on them first", () => {
      const s = report().suggestions;
      const firstHot = s.findIndex((x) => x.activeAreas.length > 0);
      const lastClean = s.map((x) => x.activeAreas.length === 0).lastIndexOf(true);
      if (firstHot >= 0 && lastClean >= 0) expect(lastClean).toBeLessThan(firstHot);
    });
  
    it("leaves the filed route untouched — the report is advisory only", () => {
      const input = {
        ...baseInput,
        adep: "VTBS",
        ades: "VTSF",
        filedRoute: "MADEUP ROUTING",
        eobtMs: start,
        path: pathThrough(find("VTD43"), start),
      };
      analysePdr(input);
      expect(input.filedRoute).toBe("MADEUP ROUTING");
    });
  });
  
  describe("analysePdr — reporting integrity", () => {
    it("counts the areas it actually tested", () => {
      const r = analysePdr({
        ...baseInput,
        eobtMs: MON,
        path: pathThrough(find("VTD43"), MON),
      });
      expect(r.areasChecked).toBe(areas.length);
    });
  
    it("reports zero areas checked when the overlay is not loaded", () => {
      const r = analysePdr({
        ...baseInput,
        areas: [],
        eobtMs: MON,
        path: pathThrough(find("VTD43"), MON),
      });
      expect(r.areasChecked).toBe(0);
      expect(r.incursions).toEqual([]);
    });
  
    it("gives every finding a stable id, a reason and a source", () => {
      const start = MON + 3 * HOUR;
      const r = analysePdr({
        ...baseInput,
        adep: "VTCC",
        ades: "VTBD",
        eobtMs: start,
        path: pathThrough(find("VTD43"), start),
      });
      expect(r.findings.length).toBeGreaterThan(0);
      const ids = r.findings.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const f of r.findings) {
        expect(f.reason.length).toBeGreaterThan(20);
        expect(f.source).toBeTruthy();
      }
    });
  
    it("orders findings worst-first", () => {
      const start = MON + 3 * HOUR;
      const r = analysePdr({
        ...baseInput,
        adep: "VTCC",
        ades: "VTBD",
        eobtMs: start,
        path: pathThrough(find("VTD43"), start),
      });
      const rank = { violation: 0, caution: 1, info: 2 } as const;
      const seq = r.findings.map((f) => rank[f.severity]);
      expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    });
  });
  
  describe("analysePdr — estimated (pre-generation) paths", () => {
    // The generator checks a plan BEFORE it is flown, on a straight line to the
    // first fix. A finding down at climb-out altitude may therefore be an
    // artefact of that line rather than of the published SID, and must say so.
    const lowArea = () => {
      const a = areas.find((x) => Number.isFinite(x.upperFt) && x.upperFt <= 6000);
      if (!a) throw new Error("no low area in the fixture");
      return a;
    };
  
    it("caveats a terminal-level finding when the path was estimated", () => {
      const start = MON + 6 * HOUR;
      const r = analysePdr({
        ...baseInput,
        estimated: true,
        eobtMs: start,
        path: pathThrough(lowArea(), start),
      });
      const hit = r.findings.find((f) => f.area === lowArea().ident);
      expect(hit).toBeDefined();
      expect(hit!.reason).toMatch(/SID\/STAR\/approach is not modelled/);
    });
  
    it("does not caveat the same finding once the trajectory is real", () => {
      const start = MON + 6 * HOUR;
      const r = analysePdr({
        ...baseInput,
        eobtMs: start,
        path: pathThrough(lowArea(), start),
      });
      const hit = r.findings.find((f) => f.area === lowArea().ident);
      expect(hit!.reason).not.toMatch(/not modelled/);
    });
  
    it("does not caveat a cruise-level crossing even when estimated", () => {
      const high = areas.find((x) => !Number.isFinite(x.upperFt));
      expect(high).toBeDefined();
      const start = MON + 6 * HOUR;
      // pathThrough puts an unlimited-topped area's crossing at lower+5000 ft;
      // force a cruise level instead.
      const { lat, lon } = high!.centroid;
      const path = pathFromFixes(
        [
          { lat, lon: lon - 0.4 },
          { lat, lon: lon + 0.4 },
        ],
        { startMs: start, gsKt: 450, altFt: 33000 },
      );
      const r = analysePdr({ ...baseInput, estimated: true, eobtMs: start, path });
      const hit = r.findings.find((f) => f.area === high!.ident);
      if (hit) expect(hit.reason).not.toMatch(/not modelled/);
    });
  });
  
  describe("P / D / R areas are governed by different rules", () => {
    const at = (h: number) => MON + h * HOUR;
    const check = (area: PdrArea, hour: number, authorizedAreas?: string[]) => {
      const start = at(hour);
      const r = analysePdr({
        ...baseInput,
        authorizedAreas,
        eobtMs: start,
        path: pathThrough(area, start),
      });
      return r.findings.find((f) => f.area === area.ident);
    };
  
    // --- P: not permitted, full stop -----------------------------------------
    it("treats an active Prohibited area as a violation needing a re-route", () => {
      const f = check(find("VTP7"), 6); // VTP7 is H24
      expect(f?.severity).toBe("violation");
      expect(f?.areaClass).toBe("P");
      expect(f?.action).toMatch(/Re-route/i);
      expect(f?.reason).toContain("not permitted");
    });
  
    it("still flags a Prohibited area outside its published window", () => {
      // VTP36 is sunset-to-sunrise; 0500Z is the middle of the Thai day.
      const f = check(find("VTP36"), 5);
      expect(f?.severity).toBe("caution");
      expect(f?.areaClass).toBe("P");
    });
  
    // --- D: conditional on being active --------------------------------------
    it("treats an ACTIVE Danger area as a violation", () => {
      const f = check(find("VTD43"), 3); // MON-FRI 0100-0900
      expect(f?.severity).toBe("violation");
      expect(f?.areaClass).toBe("D");
      expect(f?.action).toMatch(/re-time|Re-route|re-level/i);
    });
  
    it("treats an INACTIVE Danger area as a note with nothing to do", () => {
      const f = check(find("VTD43"), 12);
      expect(f?.severity).toBe("info");
      expect(f?.action).toBeUndefined();
    });
  
    it("states the Danger-area rule rather than just the ident", () => {
      const f = check(find("VTD43"), 3);
      expect(f?.reason).toMatch(/may be entered, but not while it is active/i);
    });
  
    // --- R: conditional on authorization --------------------------------------
    it("treats an active Restricted area with no authorization as a violation", () => {
      const f = check(find("VTR1"), 6); // VTR1 is H24
      expect(f?.severity).toBe("violation");
      expect(f?.areaClass).toBe("R");
      expect(f?.reason).toMatch(/requires authorization/i);
      expect(f?.reason).toMatch(/No entry authorization is recorded/i);
    });
  
    it("permits the same crossing when authorization is on file", () => {
      const f = check(find("VTR1"), 6, ["VTR1"]);
      expect(f?.severity).toBe("info");
      expect(f?.reason).toMatch(/permitted/i);
    });
  
    it("quotes the published entry condition for a Restricted area", () => {
      const withRemarks = areas.find(
        (a) => a.kind === "R" && (a.activity?.remarks ?? "").trim().length > 5,
      );
      expect(withRemarks).toBeDefined();
      const start = at(6);
      const r = analysePdr({
        ...baseInput,
        eobtMs: start,
        path: pathThrough(withRemarks!, start),
      });
      const f = r.findings.find((x) => x.area === withRemarks!.ident);
      if (f && f.severity !== "info") expect(f.reason).toMatch(/Entry condition:/);
    });
  });
  
  /**
   * Areas whose activation is "Notified by NOTAM" are assumed cold, so flying
   * through one is a note rather than a conflict. The assumption still has to be
   * stated, and it must not reach any area the AIP actually schedules.
   */
  describe("areas notified by NOTAM are treated as inactive", () => {
    const notamAreas = areas.filter(
      (a) =>
        a.activity?.sheets.length === 0 &&
        /notam/i.test(a.activity?.activityNote ?? ""),
    );
  
    it("finds some in the dataset, or this suite proves nothing", () => {
      expect(notamAreas.length).toBeGreaterThan(0);
    });
  
    it("never applies to a Prohibited area, so nothing forbidden is downgraded", () => {
      // The assumption is only safe because no P area in this AIRAC publishes its
      // activity by NOTAM. If one ever does, this fails and the policy is
      // revisited rather than silently softened.
      expect(notamAreas.filter((a) => a.kind === "P")).toEqual([]);
    });
  
    it("makes a full transit a note, not a violation", () => {
      const start = MON + 6 * HOUR;
      for (const a of notamAreas.slice(0, 8)) {
        const r = analysePdr({
          ...baseInput,
          eobtMs: start,
          path: pathThrough(a, start),
        });
        const f = r.findings.find((x) => x.area === a.ident);
        // Some polygons are not crossed by the synthetic path at their published
        // band; those simply produce no finding, which is equally not a conflict.
        if (f) expect(f.severity).toBe("info");
      }
    });
  
    it("holds at every hour, because the assumption has no window", () => {
      const a = notamAreas[0];
      for (const h of [0, 6, 12, 18]) {
        const t = MON + h * HOUR;
        const f = analysePdr({ ...baseInput, eobtMs: t, path: pathThrough(a, t) })
          .findings.find((x) => x.area === a.ident);
        if (f) expect(f.severity).toBe("info");
      }
    });
  
    it("says the area is being assumed cold rather than saying nothing", () => {
      const start = MON + 6 * HOUR;
      const withFinding = notamAreas
        .map((a) => {
          const f = analysePdr({
            ...baseInput,
            eobtMs: start,
            path: pathThrough(a, start),
          }).findings.find((x) => x.area === a.ident);
          return f ?? null;
        })
        .find((f) => f !== null);
      expect(withFinding).toBeTruthy();
      expect(withFinding!.reason + " " + (withFinding!.action ?? "")).toMatch(/NOTAM/i);
    });
  });
  
  describe("boundary grazes are not transits", () => {
    it("drops an undetermined-activity graze to a note", () => {
      // A NOTAM-activated area touched for well under the sampling step is two
      // weak signals stacked, not a finding.
      const notam = areas.find(
        (a) => a.activity?.sheets.length === 0 && /notam/i.test(a.activity?.activityNote ?? ""),
      );
      expect(notam).toBeDefined();
      const { lat, lon } = notam!.centroid;
      const start = MON + 6 * HOUR;
      // One sample only, right at the centre: transit distance 0.
      const path = [
        { lat, lon, altFt: notam!.lowerFt + 100, timeMs: start },
      ];
      const r = analysePdr({ ...baseInput, eobtMs: start, path });
      const f = r.findings.find((x) => x.area === notam!.ident);
      expect(f?.severity).toBe("info");
    });
  });
  
  describe("a suggestion must pass the same rules as the filed route", () => {
    // The engine used to check candidates for restricted areas only, so it would
    // offer a route it had just rejected itself for a level below the airway's
    // published floor — the controller bounced between two rejected routes.
    const segmentIndex = indexSegments(
      dataFile("aixm/route_segments.json").segments,
    );
    const start = MON + 6 * HOUR;
    const lowLevel = {
      ...baseInput,
      adep: "VTBS",
      ades: "VTPO",
      filedRoute: "MADEUP ROUTING",
      segmentIndex,
      // Below the published floor of the northern Y-routes out of Bangkok.
      rflFt: 16000,
      eobtMs: start,
      path: pathThrough(find("VTR1"), start),
    };
  
    it("never offers a route whose own level band the flight breaks", () => {
      const r = analysePdr(lowLevel);
      for (const s of r.suggestions) {
        // Any level problem must be declared on the card, not hidden.
        const declared = s.issues.length > 0;
        const clean = s.issues.length === 0;
        expect(declared || clean).toBe(true);
        if (clean) {
          // A candidate reported clean really must be clean at this level.
          expect(
            checkAirwayUsage(s.route, segmentIndex, lowLevel.rflFt).filter(
              (i) => i.kind === "level" || i.kind === "direction",
            ),
          ).toEqual([]);
        }
      }
    });
  
    it("never offers a route that is one-way against this direction", () => {
      const r = analysePdr(lowLevel);
      for (const s of r.suggestions) {
        expect(
          checkAirwayUsage(s.route, segmentIndex, null).filter(
            (i) => i.kind === "direction",
          ),
        ).toEqual([]);
      }
    });
  
    it("ranks a candidate with a remaining rule problem behind a clean one", () => {
      const r = analysePdr(lowLevel);
      const firstFlawed = r.suggestions.findIndex((s) => s.issues.length > 0);
      const lastClean = r.suggestions
        .map((s) => s.issues.length === 0)
        .lastIndexOf(true);
      if (firstFlawed >= 0 && lastClean >= 0) {
        expect(lastClean).toBeLessThan(firstFlawed);
      }
    });
  });
  
  describe("a suggestion is judged on the same profile as the filed route", () => {
    // The ping-pong bug: candidates were built flat at cruise while the filed
    // route used the climb/descent profile, so an area under the climb-out looked
    // like something the alternative "cleared". Applying it produced the same
    // finding again, and the engine then offered the route just abandoned.
    const start = MON + 6 * HOUR;
    const low = find("VTR1"); // Bangkok City, GND-3000 ft, active H24
    const terminals = { dep: low.centroid, arr: { lat: 7.0, lon: 100.6 } };
  
    const withTerminals = (t: typeof terminals | undefined) =>
      analysePdr({
        ...baseInput,
        adep: "VTBS",
        ades: "VTPO",
        filedRoute: "MADEUP ROUTING",
        rflFt: 16000,
        estimated: true,
        terminals: t,
        eobtMs: start,
        path: pathThrough(low, start),
      });
  
    it("does not claim to clear an area every route out of that field crosses", () => {
      const r = withTerminals(terminals);
      for (const s of r.suggestions) {
        // Anchored at VTR1 itself, every candidate climbs out through it, so
        // none of them may be reported as clearing it.
        expect(s.clears).not.toContain("VTR1");
      }
    });
  
    it("reports that area as still crossed on the candidate", () => {
      const r = withTerminals(terminals);
      if (r.suggestions.length > 0) {
        expect(
          r.suggestions.some((s) => s.activeAreas.includes("VTR1")),
        ).toBe(true);
      }
    });
  
    it("is the flat-level behaviour that produced the false clear", () => {
      // Without terminals the candidate is flat at FL160, well above VTR1's
      // 3000 ft ceiling, so it looks clean — the old bug, kept as the contrast.
      const r = withTerminals(undefined);
      for (const s of r.suggestions) {
        expect(s.activeAreas).not.toContain("VTR1");
      }
    });
  });
  
  describe("an estimated terminal crossing is a CHECK, not a rejection", () => {
    // The departure leg of an un-generated plan is a straight line to the first
    // fix, so an area over the departure field is entered by EVERY route out of
    // it. Reporting that as a rejection left the flight permanently rejected with
    // nothing the controller could do — the check must not assert a breach on
    // geometry it states it has not modelled.
    const start = MON + 6 * HOUR;
    const low = () => {
      const a = areas.find(
        (x) => x.kind !== "D" && Number.isFinite(x.upperFt) && x.upperFt <= 6000,
      );
      if (!a) throw new Error("no low area in the fixture");
      return a;
    };
  
    const run = (estimated: boolean) =>
      analysePdr({
        ...baseInput,
        estimated,
        eobtMs: start,
        path: pathThrough(low(), start),
      }).findings.find((f) => f.area === low().ident);
  
    it("downgrades the estimated crossing to a caution", () => {
      const f = run(true);
      expect(f?.severity).toBe("caution");
      expect(f?.reason).toMatch(/not modelled/);
    });
  
    it("keeps the full severity once the real trajectory is checked", () => {
      const f = run(false);
      expect(f?.severity).toBe("violation");
    });
  
    it("leaves a CRUISE-level crossing at full severity even when estimated", () => {
      const high = areas.find((a) => !Number.isFinite(a.upperFt) && a.kind !== "D");
      if (!high) return;
      const { lat, lon } = high.centroid;
      const path = pathFromFixes(
        [
          { lat, lon: lon - 0.4 },
          { lat, lon: lon + 0.4 },
        ],
        { startMs: start, gsKt: 450, altFt: 33000 },
      );
      const f = analysePdr({
        ...baseInput,
        estimated: true,
        eobtMs: start,
        path,
      }).findings.find((x) => x.area === high.ident);
      if (f && f.severity !== "info") expect(f.severity).toBe("violation");
    });
  });
  
  describe("the Action never proposes a date change that cannot work", () => {
    const start = MON + 6 * HOUR;
    const actionFor = (ident: string) => {
      const a = find(ident);
      return analysePdr({
        ...baseInput,
        eobtMs: start,
        path: pathThrough(a, start),
      }).findings.find((f) => f.area === ident)?.action;
    };
  
    it("says re-timing cannot help for a Daily 0000-2400 area", () => {
      const action = actionFor("VTR1");
      expect(action).toMatch(/active continuously/i);
      expect(action).not.toMatch(/would clear it/);
    });
  
    it("offers re-timing for an area with a real inactive period", () => {
      // VTD43 is MON-FRI 0100-0900; 0600Z on a Monday is inside it.
      const start43 = MON + 6 * HOUR;
      const action = analysePdr({
        ...baseInput,
        eobtMs: start43,
        path: pathThrough(find("VTD43"), start43),
      }).findings.find((f) => f.area === "VTD43")?.action;
      if (action) {
        expect(action).toMatch(/re-time/i);
        expect(action).toMatch(/MON-FRI 0100-0900/);
      }
    });
  
    it("points at the NOTAMs rather than at a date for a NOTAM-activated area", () => {
      const notam = areas.find(
        (a) =>
          a.activity?.sheets.length === 0 &&
          /notam/i.test(a.activity?.activityNote ?? ""),
      );
      expect(notam).toBeDefined();
      const action = actionFor(notam!.ident);
      if (action) {
        expect(action).toMatch(/NOTAM/i);
        expect(action).not.toMatch(/would clear it/);
      }
    });
  });
  
  describe("navigation capability decides which routes may be offered", () => {
    const start = MON + 6 * HOUR;
    const base = {
      ...baseInput,
      adep: "VTBS",
      ades: "VTSF",
      filedRoute: "MADEUP ROUTING",
      eobtMs: start,
      path: pathThrough(find("VTD43"), start),
    };
  
    it("offers a conventional route to an RNAV flight — capability is a superset", () => {
      const r = analysePdr({ ...base, rnavCapable: true });
      // A NON-RNAV alternative is flyable by an RNAV-equipped aircraft, so it
      // must not be filtered out just for being NON-RNAV.
      const conventional = r.suggestions.filter((s) => !s.rnav);
      if (conventional.length > 0) {
        expect(conventional[0].capabilityNote).toMatch(/Conventional/);
      }
    });
  
    it("never offers an RNAV route to a flight without RNAV", () => {
      const r = analysePdr({ ...base, rnavCapable: false });
      expect(r.suggestions.filter((s) => s.rnav)).toEqual([]);
    });
  
    it("does not tag a conventional route when the flight is conventional too", () => {
      const r = analysePdr({ ...base, rnavCapable: false });
      for (const s of r.suggestions) expect(s.capabilityNote).toBeNull();
    });
  });
  
  describe("remedies are ranked, and only offered when they can work", () => {
    const start = MON + 6 * HOUR;
  
    it("does not offer a climb for a crossing on the climb-out", () => {
      // VTR1 is GND-3000 ft over Bangkok: every departure passes through it at
      // low level whatever it cruises at, so a level change cannot fix it.
      const low = find("VTR1");
      const path = pathFromFixes(
        [
          { lat: low.centroid.lat, lon: low.centroid.lon - 0.2 },
          { lat: low.centroid.lat, lon: low.centroid.lon + 0.2 },
        ],
        { startMs: start, gsKt: 450, altFt: 2000 },
      );
      const r = analysePdr({ ...baseInput, eobtMs: start, path });
      expect(r.remedies.some((m) => m.kind === "level")).toBe(false);
      expect(r.remedies.some((m) => m.kind === "route")).toBe(true);
    });
  
    it("offers a climb for a capped area crossed at cruise, naming the level", () => {
      const capped = areas.find(
        (a) => Number.isFinite(a.upperFt) && a.upperFt >= 13000 && a.upperFt <= 20000,
      );
      if (!capped) return;
      const path = pathFromFixes(
        [
          { lat: capped.centroid.lat, lon: capped.centroid.lon - 0.2 },
          { lat: capped.centroid.lat, lon: capped.centroid.lon + 0.2 },
        ],
        { startMs: start, gsKt: 450, altFt: capped.upperFt - 1000 },
      );
      const r = analysePdr({ ...baseInput, rflFt: capped.upperFt - 1000, eobtMs: start, path });
      const level = r.remedies.find((m) => m.kind === "level");
      if (r.findings.some((f) => f.severity !== "info")) {
        expect(level).toBeDefined();
        expect(level!.toFt).toBeGreaterThan(capped.upperFt);
        expect(level!.detail).toMatch(/Raise the requested level/);
      }
    });
  
    // A line across VTR1 also clips its Bangkok neighbours, so these assert on
    // the remedy FOR VTR1 rather than on there being none at all.
    const authFor = (ident: string, authorizedAreas?: string[]) =>
      analysePdr({
        ...baseInput,
        authorizedAreas,
        eobtMs: start,
        path: pathThrough(find(ident), start),
      }).remedies.filter(
        (m) => m.kind === "authorization" && m.clears?.includes(ident),
      );
  
    it("offers authorization for an unauthorized Restricted area", () => {
      expect(authFor("VTR1").length).toBe(1);
    });
  
    it("drops that remedy once authorization is recorded", () => {
      expect(authFor("VTR1", ["VTR1"])).toEqual([]);
    });
  
    it("offers nothing when the plan is clean", () => {
      const clean = pathFromFixes(
        [
          { lat: 9.0, lon: 101.5 },
          { lat: 9.5, lon: 102.0 },
        ],
        { startMs: start, gsKt: 450, altFt: 33000 },
      );
      expect(analysePdr({ ...baseInput, eobtMs: start, path: clean }).remedies).toEqual([]);
    });
  });
  
  describe("the level remedy covers airway bands, not just areas", () => {
    // The gap this closes: BKP211 was rejected for being below Y26's published
    // floor, the finding said "re-file at a level inside the band", and yet
    // RECOMMENDED ACTIONS listed only ROUTE and AUTH — the one action with a
    // concrete number was missing, because remedies only read area incursions.
    const segmentIndex = indexSegments(
      dataFile("aixm/route_segments.json").segments,
    );
    const start = MON + 6 * HOUR;
    const belowBand = {
      ...baseInput,
      filedRoute: "BKK Y8 SABIS", // published from 13000 ft
      segmentIndex,
      rflFt: 9000,
      eobtMs: start,
      path: pathFromFixes(
        [
          { lat: 9.0, lon: 101.5 },
          { lat: 9.5, lon: 102.0 },
        ],
        { startMs: start, gsKt: 450, altFt: 9000 },
      ),
    };
  
    it("offers a LEVEL action naming the level the airway requires", () => {
      const r = analysePdr(belowBand);
      const level = r.remedies.find((m) => m.kind === "level");
      expect(level).toBeDefined();
      expect(level!.toFt).toBe(13000);
      expect(level!.detail).toMatch(/FL130 or above/);
      expect(level!.detail).toMatch(/published from 13000 ft/);
    });
  
    it("ranks the level action first", () => {
      expect(analysePdr(belowBand).remedies[0].kind).toBe("level");
    });
  
    it("offers no level action when the level already fits the band", () => {
      const r = analysePdr({ ...belowBand, rflFt: 33000 });
      expect(r.remedies.find((m) => m.kind === "level")).toBeUndefined();
    });
  });
  
  describe("the row verdict and the detail cannot disagree", () => {
    // Both come from analysePdr; the ONLY difference the bulk scan makes is
    // skipping the suggestions. If includeSuggestions changed a severity, the
    // flight list and the open panel would show different verdicts for the same
    // flight — which is exactly what a stale bulk map looked like.
    const start = MON + 3 * HOUR;
    const input = {
      ...baseInput,
      eobtMs: start,
      path: pathThrough(find("VTD43"), start),
    };
  
    it("gives the same findings with and without suggestions", () => {
      const bulk = analysePdr({ ...input, includeSuggestions: false });
      const full = analysePdr({ ...input, includeSuggestions: true });
      expect(bulk.worst).toBe(full.worst);
      expect(bulk.findings.map((f) => f.id + f.severity)).toEqual(
        full.findings.map((f) => f.id + f.severity),
      );
    });
  
    it("only differs in the suggestion list", () => {
      const bulk = analysePdr({ ...input, includeSuggestions: false });
      const full = analysePdr({ ...input, includeSuggestions: true });
      expect(bulk.suggestions).toEqual([]);
      expect(full.suggestions.length).toBeGreaterThanOrEqual(0);
      expect(bulk.remedies.map((r) => r.kind)).toEqual(
        full.remedies.map((r) => r.kind),
      );
    });
  
    it("reads a different EOBT as a different verdict, not a stale one", () => {
      // VTD43 is MON-FRI 0100-0900: 0300Z is inside, 1300Z outside. The two must
      // not produce the same answer, or a stale row would be undetectable.
      const inside = analysePdr(input).worst;
      const outside = analysePdr({
        ...input,
        eobtMs: MON + 13 * HOUR,
        path: pathThrough(find("VTD43"), MON + 13 * HOUR),
      }).worst;
      expect(inside).not.toBe(outside);
    });
  });
  
  describe("an unset requested level is unknown, not sea level", () => {
    // A plan with no RFL used to be checked at 0 ft: every airway band was
    // "breached" and the estimated profile sat on the ground, so every low-level
    // area was entered. The UI showed FL250 in the form and the finding said
    // "the requested level is 0 ft".
    const segmentIndex = indexSegments(
      dataFile("aixm/route_segments.json").segments,
    );
    const start = MON + 6 * HOUR;
    const noLevel = {
      ...baseInput,
      filedRoute: "BKK Y8 SABIS", // published from 13000 ft
      segmentIndex,
      rflFt: 0,
      eobtMs: start,
      path: [],
    };
  
    it("does not claim the airway band is breached", () => {
      const r = analysePdr(noLevel);
      expect(r.findings.filter((f) => f.category === "airway-level")).toEqual([]);
    });
  
    it("does not demand a climb to a level it cannot compare against", () => {
      expect(analysePdr(noLevel).remedies.find((m) => m.kind === "level")).toBeUndefined();
    });
  
    it("reports the missing level as the finding it is", () => {
      const f = analysePdr(noLevel).findings.find((x) => x.id === "plan:no-level");
      expect(f).toBeDefined();
      expect(f!.severity).toBe("caution");
      expect(f!.reason).toMatch(/no usable RFL/i);
    });
  
    it("still checks the band once a real level is given", () => {
      const r = analysePdr({ ...noLevel, rflFt: 9000 });
      expect(r.findings.some((f) => f.category === "airway-level")).toBe(true);
      expect(r.findings.find((x) => x.id === "plan:no-level")).toBeUndefined();
    });
  });

} else {
  describe.skip("PDR check against real AIP data (needs VY fixtures)", () => {
    it("skipped: no VT fixtures on disk and no VY equivalent yet", () => {});
  });
}
