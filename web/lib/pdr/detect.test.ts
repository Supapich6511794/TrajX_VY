/**
 * End-to-end PDR check.
 *
 * Navdata and airway segments are the shipped Myanmar AIRAC 2609 files
 * (`aip_VY.json`, `aixm_vy/route_segments.json`). The PDR areas are the
 * synthetic VY-shaped fixture (`./__fixtures__/vyPdr`), because the real VY
 * activity file (ENR 5.1) is only H24 or NOTAM and so cannot show a schedule
 * flipping an answer. The published city-pair table is a small inline one: no VY table
 * ships yet, and the real default (an empty table) is covered separately.
 *
 * Two properties are load-bearing and asserted here as well as the findings:
 *
 *   * the SAME route is or is not a conflict depending only on the time of day
 *     — that is the whole reason the schedules were ingested;
 *   * every suggestion is a route the published table already has for that
 *     pair and direction. The tool must never invent a routing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fix } from "@/lib/aip";
import type { AipRoute } from "@/lib/aipRoutes";

import { CLEAR, VYMD, synthActivity, synthGeo } from "./__fixtures__/vyPdr";
import { checkAirwayUsage, indexSegments } from "./airwayDirection";
import { buildPdrAreas } from "./areas";
import { autoResolveFlight } from "./autoResolve";
import { analysePdr } from "./detect";
import { pathFromFixes } from "./penetration";
import type { PdrArea } from "./types";

const dataFile = (p: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"));

const aip = dataFile("aip_VY.json") as {
  waypoints: Record<string, { lat: number; lon: number }>;
  airways: Record<string, string[]>;
};
const fixes: Fix[] = Object.entries(aip.waypoints).map(([ident, w]) => ({
  ident,
  lat: w.lat,
  lon: w.lon,
}));
const segmentIndex = indexSegments(dataFile("aixm_vy/route_segments.json").segments);

/** Synthetic, directional city-pair table on real VY airways. */
const routes: AipRoute[] = [
  { adep: "VYYY", ades: "VYMD", rnav: true, route: "BGO W13 MIA" },
  {
    adep: "VYYY",
    ades: "VYMD",
    rnav: true,
    route: "BGO W1 MIA",
    condition: "when VY D91 is not active",
  },
  { adep: "VYYY", ades: "VYMD", rnav: false, route: "BGO W5 MIA" },
  // Y8 is one-way BUXEL -> MENEX in AIRAC 2609; this entry flies it backwards
  // and must never be offered once the segment table is known.
  { adep: "VYYY", ades: "VYMD", rnav: true, route: "MENEX Y8 BUXEL" },
  { adep: "VYMD", ades: "VYYY", rnav: true, route: "MIA W13 BGO" },
];

const areas = buildPdrAreas(synthGeo, synthActivity);
const find = (ident: string): PdrArea => {
  const a = areas.find((x) => x.ident === ident);
  if (!a) throw new Error("no area " + ident);
  return a;
};

const MON = Date.UTC(2026, 8, 7); // Monday
const HOUR = 3600000;

/** A short east-west path straight through the middle of an area, at a level
 *  inside its band. Enough to guarantee an incursion without depending on the
 *  exact shape of the polygon. */
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

const cleanPath = (startMs: number, altFt = 33000) =>
  pathFromFixes(CLEAR, { startMs, gsKt: 450, altFt });

const baseInput = {
  adep: "VYYY",
  ades: "VYMD",
  filedRoute: "BGO W13 MIA",
  actype: "A320",
  rflFt: 33000,
  gsKt: 450,
  areas,
  publishedRoutes: routes,
  fixes,
  airways: aip.airways,
};

describe("the joined dataset", () => {
  it("matches an activity record to every polygon", () => {
    expect(areas.length).toBe(synthGeo.features.length);
    expect(areas.filter((a) => !a.activity)).toEqual([]);
  });

  it("keys areas by class + designator", () => {
    expect(areas.map((a) => a.ident)).toContain("D91");
    expect(find("D91").activity?.designator).toBe("91");
  });
});

describe("analysePdr — the same route at two times of day", () => {
  const area = () => find("D91"); // MON-FRI 0100-0900 UTC

  it("raises a finding when the crossing is inside the active hours", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(area(), start) });
    const hit = r.findings.find((f) => f.area === "D91");
    expect(hit).toBeDefined();
    expect(hit!.category).toBe("restricted-airspace");
    expect(["violation", "caution"]).toContain(hit!.severity);
    expect(hit!.reason).toContain("0100-0900");
  });

  it("does not raise it when the same crossing is outside those hours", () => {
    const start = MON + 12 * HOUR;
    const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(area(), start) });
    const hit = r.findings.find((f) => f.area === "D91");
    expect(hit?.severity).toBe("info");
    expect(r.worst).not.toBe("violation");
  });

  it("names the hazard and the restriction, not just the ident", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(area(), start) });
    const hit = r.findings.find((f) => f.area === "D91")!;
    expect(hit.reason).toMatch(/Restriction:/);
    expect(hit.reason).toMatch(/Hazard:/);
  });

  it("cites the Myanmar AIP as the source", () => {
    const start = MON + 3 * HOUR;
    const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(area(), start) });
    const src = r.findings.find((f) => f.area === "D91")!.source;
    expect(src).toContain("ENR 5.1");
    expect(src).toContain("AIP MYANMAR");
  });
});

describe("analysePdr — prohibited areas outrank danger areas", () => {
  it("treats an active Prohibited area as a violation", () => {
    const start = MON + 6 * HOUR;
    const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(find("P92"), start) });
    expect(r.findings.find((f) => f.area === "P92")?.severity).toBe("violation");
  });
});

describe("analysePdr — route availability and direction", () => {
  it("accepts a route published for this direction", () => {
    const r = analysePdr({ ...baseInput, eobtMs: MON + 6 * HOUR, path: cleanPath(MON + 6 * HOUR) });
    expect(r.routeMatch.kind).toBe("exact");
    expect(r.findings.filter((f) => f.category === "route-availability")).toEqual([]);
  });

  it("flags the return leg's routing as unavailable in this direction", () => {
    const r = analysePdr({
      ...baseInput,
      adep: "VYMD",
      ades: "VYYY",
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

  it("stays dormant with no published table at all — the VY default today", () => {
    const r = analysePdr({
      ...baseInput,
      publishedRoutes: [],
      eobtMs: MON + 6 * HOUR,
      path: cleanPath(MON + 6 * HOUR),
    });
    expect(r.routeMatch.kind).toBe("none-published");
    expect(r.worst).toBe("info");
    expect(r.suggestions).toEqual([]);
  });

  it("reports a clean plan as clean", () => {
    const r = analysePdr({ ...baseInput, eobtMs: MON + 6 * HOUR, path: cleanPath(MON + 6 * HOUR) });
    expect(r.findings.every((f) => f.severity === "info")).toBe(true);
    expect(r.suggestions).toEqual([]);
  });
});

describe("analysePdr — suggestions", () => {
  const start = MON + 3 * HOUR;
  const input = () => ({
    ...baseInput,
    filedRoute: "MADEUP ROUTING",
    eobtMs: start,
    path: pathThrough(find("D91"), start),
  });
  const report = () => analysePdr(input());

  it("offers alternatives only from the published table for that direction", () => {
    const r = report();
    expect(r.suggestions.length).toBeGreaterThan(0);
    const published = new Set(
      routes.filter((x) => x.adep === "VYYY" && x.ades === "VYMD").map((x) => x.route),
    );
    for (const s of r.suggestions) expect(published.has(s.route)).toBe(true);
  });

  it("never offers a route whose published condition is unmet", () => {
    const r = report();
    for (const s of r.suggestions) expect(s.condition?.state).not.toBe("unmet");
    // "BGO W1 MIA" needs D91 cold, and at 0300Z Monday it is hot.
    expect(r.suggestions.map((s) => s.route)).not.toContain("BGO W1 MIA");
  });

  it("offers the conditional route once its condition holds", () => {
    const later = MON + 12 * HOUR;
    const r = analysePdr({ ...input(), eobtMs: later, path: pathThrough(find("D91"), later) });
    expect(r.suggestions.map((s) => s.route)).toContain("BGO W1 MIA");
  });

  it("explains why each alternative is being offered", () => {
    for (const s of report().suggestions) expect(s.why.length).toBeGreaterThan(0);
  });

  it("ranks routes with no active area on them first", () => {
    const s = report().suggestions;
    const firstHot = s.findIndex((x) => x.activeAreas.length > 0);
    const lastClean = s.map((x) => x.activeAreas.length === 0).lastIndexOf(true);
    if (firstHot >= 0 && lastClean >= 0) expect(lastClean).toBeLessThan(firstHot);
  });

  it("leaves the filed route untouched — the report is advisory only", () => {
    const i = input();
    analysePdr(i);
    expect(i.filedRoute).toBe("MADEUP ROUTING");
  });
});

describe("analysePdr — reporting integrity", () => {
  it("counts the areas it actually tested", () => {
    const r = analysePdr({ ...baseInput, eobtMs: MON, path: pathThrough(find("D91"), MON) });
    expect(r.areasChecked).toBe(areas.length);
  });

  it("reports zero areas checked when the overlay is not loaded", () => {
    const r = analysePdr({
      ...baseInput,
      areas: [],
      eobtMs: MON,
      path: pathThrough(find("D91"), MON),
    });
    expect(r.areasChecked).toBe(0);
    expect(r.incursions).toEqual([]);
  });

  const messy = () => {
    const start = MON + 3 * HOUR;
    return analysePdr({
      ...baseInput,
      adep: "VYMD",
      ades: "VYYY",
      eobtMs: start,
      path: pathThrough(find("D91"), start),
    });
  };

  it("gives every finding a stable id, a reason and a source", () => {
    const r = messy();
    expect(r.findings.length).toBeGreaterThan(0);
    const ids = r.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of r.findings) {
      expect(f.reason.length).toBeGreaterThan(20);
      expect(f.source).toBeTruthy();
    }
  });

  it("orders findings worst-first", () => {
    const rank = { violation: 0, caution: 1, info: 2 } as const;
    const seq = messy().findings.map((f) => rank[f.severity]);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });
});

describe("analysePdr — estimated (pre-generation) paths", () => {
  // The generator checks a plan BEFORE it is flown, on a straight line to the
  // first fix. A finding down at climb-out altitude may therefore be an
  // artefact of that line rather than of the published SID, and must say so.
  const low = () => find("R94"); // GND-3000 ft

  it("caveats a terminal-level finding when the path was estimated", () => {
    const start = MON + 6 * HOUR;
    const r = analysePdr({ ...baseInput, estimated: true, eobtMs: start, path: pathThrough(low(), start) });
    const hit = r.findings.find((f) => f.area === "R94");
    expect(hit).toBeDefined();
    expect(hit!.reason).toMatch(/SID\/STAR\/approach is not modelled/);
  });

  it("does not caveat the same finding once the trajectory is real", () => {
    const start = MON + 6 * HOUR;
    const r = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(low(), start) });
    expect(r.findings.find((f) => f.area === "R94")!.reason).not.toMatch(/not modelled/);
  });

  it("does not caveat a cruise-level crossing even when estimated", () => {
    const high = find("P92"); // GND-UNL
    const start = MON + 6 * HOUR;
    const { lat, lon } = high.centroid;
    const path = pathFromFixes(
      [
        { lat, lon: lon - 0.4 },
        { lat, lon: lon + 0.4 },
      ],
      { startMs: start, gsKt: 450, altFt: 33000 },
    );
    const r = analysePdr({ ...baseInput, estimated: true, eobtMs: start, path });
    const hit = r.findings.find((f) => f.area === "P92");
    expect(hit).toBeDefined();
    expect(hit!.reason).not.toMatch(/not modelled/);
  });
});

describe("P / D / R areas are governed by different rules", () => {
  const check = (area: PdrArea, hour: number, authorizedAreas?: string[]) => {
    const start = MON + hour * HOUR;
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
    const f = check(find("P92"), 6); // H24
    expect(f?.severity).toBe("violation");
    expect(f?.areaClass).toBe("P");
    expect(f?.action).toMatch(/Re-route/i);
    expect(f?.reason).toContain("not permitted");
  });

  it("still flags a Prohibited area outside its published window", () => {
    // P93 is sunset-to-sunrise; 0500Z is 1130 MMT, the middle of the day.
    const f = check(find("P93"), 5);
    expect(f?.severity).toBe("caution");
    expect(f?.areaClass).toBe("P");
  });

  // --- D: conditional on being active --------------------------------------
  it("treats an ACTIVE Danger area as a violation", () => {
    const f = check(find("D91"), 3); // MON-FRI 0100-0900
    expect(f?.severity).toBe("violation");
    expect(f?.areaClass).toBe("D");
    expect(f?.action).toMatch(/re-time|Re-route|re-level/i);
  });

  it("treats an INACTIVE Danger area as a note with nothing to do", () => {
    const f = check(find("D91"), 12);
    expect(f?.severity).toBe("info");
    expect(f?.action).toBeUndefined();
  });

  it("states the Danger-area rule rather than just the ident", () => {
    expect(check(find("D91"), 3)?.reason).toMatch(/may be entered, but not while it is active/i);
  });

  // --- R: conditional on authorization --------------------------------------
  it("treats an active Restricted area with no authorization as a violation", () => {
    const f = check(find("R94"), 6); // H24
    expect(f?.severity).toBe("violation");
    expect(f?.areaClass).toBe("R");
    expect(f?.reason).toMatch(/requires authorization/i);
    expect(f?.reason).toMatch(/No entry authorization is recorded/i);
  });

  it("permits the same crossing when authorization is on file", () => {
    const f = check(find("R94"), 6, ["R94"]);
    expect(f?.severity).toBe("info");
    expect(f?.reason).toMatch(/permitted/i);
  });

  it("quotes the published entry condition for a Restricted area", () => {
    expect(check(find("R94"), 6)?.reason).toMatch(/Entry condition: Entry only with prior permission/);
  });
});

/**
 * Areas whose activation is "Notified by NOTAM" are assumed cold, so flying
 * through one is a note rather than a conflict. The assumption still has to be
 * stated, and it must not reach any area the AIP actually schedules.
 */
describe("areas notified by NOTAM are treated as inactive", () => {
  const notamAreas = areas.filter(
    (a) => a.activity?.sheets.length === 0 && /notam/i.test(a.activity?.activityNote ?? ""),
  );

  it("finds some in the fixture, or this suite proves nothing", () => {
    expect(notamAreas.map((a) => a.ident)).toEqual(["R95"]);
  });

  it("makes a full transit a note, not a violation, at every hour", () => {
    const a = notamAreas[0];
    for (const h of [0, 6, 12, 18]) {
      const t = MON + h * HOUR;
      const f = analysePdr({ ...baseInput, eobtMs: t, path: pathThrough(a, t) })
        .findings.find((x) => x.area === a.ident);
      expect(f?.severity).toBe("info");
    }
  });

  it("says the area is being assumed cold rather than saying nothing", () => {
    const start = MON + 6 * HOUR;
    const f = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(notamAreas[0], start) })
      .findings.find((x) => x.area === "R95")!;
    expect(f.reason + " " + (f.action ?? "")).toMatch(/NOTAM/i);
  });
});

describe("boundary grazes are not transits", () => {
  it("drops an undetermined-activity graze to a note", () => {
    // D99 publishes a note that is not a time window, so its activity is
    // undetermined. Touched for well under the sampling step, that is two weak
    // signals stacked, not a finding.
    const a = find("D99");
    const start = MON + 6 * HOUR;
    const path = [{ lat: a.centroid.lat, lon: a.centroid.lon, altFt: a.lowerFt + 100, timeMs: start }];
    const f = analysePdr({ ...baseInput, eobtMs: start, path }).findings.find((x) => x.area === "D99");
    expect(f?.severity).toBe("info");
  });

  it("keeps a full transit of the same area as a caution", () => {
    const start = MON + 6 * HOUR;
    const f = analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(find("D99"), start) })
      .findings.find((x) => x.area === "D99");
    expect(f?.severity).toBe("caution");
  });
});

describe("a suggestion must pass the same rules as the filed route", () => {
  // The engine used to check candidates for restricted areas only, so it would
  // offer a route it had just rejected itself — the controller bounced between
  // two rejected routes.
  const start = MON + 6 * HOUR;
  const lowLevel = {
    ...baseInput,
    filedRoute: "MADEUP ROUTING",
    segmentIndex,
    rflFt: 16000,
    eobtMs: start,
    path: pathThrough(find("R94"), start),
  };

  it("never offers a route whose own level band the flight breaks without saying so", () => {
    for (const s of analysePdr(lowLevel).suggestions) {
      if (s.issues.length === 0) {
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
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions.map((s) => s.route)).not.toContain("MENEX Y8 BUXEL");
    for (const s of r.suggestions) {
      expect(
        checkAirwayUsage(s.route, segmentIndex, null).filter((i) => i.kind === "direction"),
      ).toEqual([]);
    }
  });

  it("does offer that route when no segment table is loaded — the filter is the table", () => {
    const { segmentIndex: _unused, ...noSegments } = lowLevel;
    void _unused;
    expect(analysePdr(noSegments).suggestions.map((s) => s.route)).toContain("MENEX Y8 BUXEL");
  });

  it("ranks a candidate with a remaining rule problem behind a clean one", () => {
    const r = analysePdr(lowLevel);
    const firstFlawed = r.suggestions.findIndex((s) => s.issues.length > 0);
    const lastClean = r.suggestions.map((s) => s.issues.length === 0).lastIndexOf(true);
    if (firstFlawed >= 0 && lastClean >= 0) expect(lastClean).toBeLessThan(firstFlawed);
  });
});

describe("a suggestion is judged on the same profile as the filed route", () => {
  // The ping-pong bug: candidates were built flat at cruise while the filed
  // route used the climb/descent profile, so an area under the climb-out looked
  // like something the alternative "cleared".
  const start = MON + 6 * HOUR;
  const low = find("R94"); // GND-3000 ft, active H24
  const terminals = { dep: low.centroid, arr: VYMD };

  const withTerminals = (t: typeof terminals | undefined) =>
    analysePdr({
      ...baseInput,
      filedRoute: "MADEUP ROUTING",
      rflFt: 16000,
      estimated: true,
      terminals: t,
      eobtMs: start,
      path: pathThrough(low, start),
    });

  it("does not claim to clear an area every route out of that field crosses", () => {
    const r = withTerminals(terminals);
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) expect(s.clears).not.toContain("R94");
  });

  it("reports that area as still crossed on the candidate", () => {
    expect(withTerminals(terminals).suggestions.some((s) => s.activeAreas.includes("R94"))).toBe(
      true,
    );
  });

  it("is the flat-level behaviour that produced the false clear", () => {
    // Without terminals the candidate is flat at FL160, well above R94's
    // 3000 ft ceiling, so it looks clean — the old bug, kept as the contrast.
    for (const s of withTerminals(undefined).suggestions) {
      expect(s.activeAreas).not.toContain("R94");
    }
  });
});

describe("an estimated terminal crossing is a CHECK, not a rejection", () => {
  // The departure leg of an un-generated plan is a straight line to the first
  // fix, so an area over the departure field is entered by EVERY route out of
  // it. The check must not assert a breach on geometry it has not modelled.
  const start = MON + 6 * HOUR;
  const run = (estimated: boolean) =>
    analysePdr({ ...baseInput, estimated, eobtMs: start, path: pathThrough(find("R94"), start) })
      .findings.find((f) => f.area === "R94");

  it("downgrades the estimated crossing to a caution", () => {
    const f = run(true);
    expect(f?.severity).toBe("caution");
    expect(f?.reason).toMatch(/not modelled/);
  });

  it("keeps the full severity once the real trajectory is checked", () => {
    expect(run(false)?.severity).toBe("violation");
  });

  it("leaves a CRUISE-level crossing at full severity even when estimated", () => {
    const high = find("P92");
    const { lat, lon } = high.centroid;
    const path = pathFromFixes(
      [
        { lat, lon: lon - 0.4 },
        { lat, lon: lon + 0.4 },
      ],
      { startMs: start, gsKt: 450, altFt: 33000 },
    );
    const f = analysePdr({ ...baseInput, estimated: true, eobtMs: start, path })
      .findings.find((x) => x.area === "P92");
    expect(f?.severity).toBe("violation");
  });
});

describe("the Action never proposes a date change that cannot work", () => {
  const start = MON + 6 * HOUR;
  const actionFor = (ident: string) =>
    analysePdr({ ...baseInput, eobtMs: start, path: pathThrough(find(ident), start) })
      .findings.find((f) => f.area === ident)?.action;

  it("says re-timing cannot help for a Daily 0000-2400 area", () => {
    const action = actionFor("R94");
    expect(action).toMatch(/active continuously/i);
    expect(action).not.toMatch(/would clear it/);
  });

  it("offers re-timing for an area with a real inactive period", () => {
    // D91 is MON-FRI 0100-0900; 0600Z on a Monday is inside it.
    const action = actionFor("D91");
    expect(action).toMatch(/re-time/i);
    expect(action).toMatch(/MON-FRI 0100-0900/);
  });

  it("does not point at a date for a NOTAM-activated area", () => {
    const action = actionFor("R95");
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
    filedRoute: "MADEUP ROUTING",
    eobtMs: start,
    path: pathThrough(find("D91"), start),
  };

  it("offers a conventional route to an RNAV flight — capability is a superset", () => {
    const conventional = analysePdr({ ...base, rnavCapable: true }).suggestions.filter(
      (s) => !s.rnav,
    );
    expect(conventional.length).toBeGreaterThan(0);
    expect(conventional[0].capabilityNote).toMatch(/Conventional/);
  });

  it("never offers an RNAV route to a flight without RNAV", () => {
    const r = analysePdr({ ...base, rnavCapable: false });
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions.filter((s) => s.rnav)).toEqual([]);
  });

  it("does not tag a conventional route when the flight is conventional too", () => {
    for (const s of analysePdr({ ...base, rnavCapable: false }).suggestions) {
      expect(s.capabilityNote).toBeNull();
    }
  });
});

describe("remedies are ranked, and only offered when they can work", () => {
  const start = MON + 6 * HOUR;

  it("does not offer a climb for a crossing on the climb-out", () => {
    // R94 is GND-3000 ft: a departure passes through it at low level whatever
    // it cruises at, so a level change cannot fix it.
    const low = find("R94");
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
    const capped = find("D91"); // GND-FL200, active 0100-0900
    const path = pathFromFixes(
      [
        { lat: capped.centroid.lat, lon: capped.centroid.lon - 0.2 },
        { lat: capped.centroid.lat, lon: capped.centroid.lon + 0.2 },
      ],
      { startMs: start, gsKt: 450, altFt: 19000 },
    );
    const r = analysePdr({ ...baseInput, rflFt: 19000, eobtMs: start, path });
    const level = r.remedies.find((m) => m.kind === "level");
    expect(level).toBeDefined();
    expect(level!.toFt).toBe(21000);
    expect(level!.detail).toMatch(/Raise the requested level/);
  });

  const authFor = (ident: string, authorizedAreas?: string[]) =>
    analysePdr({
      ...baseInput,
      authorizedAreas,
      eobtMs: start,
      path: pathThrough(find(ident), start),
    }).remedies.filter((m) => m.kind === "authorization" && m.clears?.includes(ident));

  it("offers authorization for an unauthorized Restricted area", () => {
    expect(authFor("R94").length).toBe(1);
  });

  it("drops that remedy once authorization is recorded", () => {
    expect(authFor("R94", ["R94"])).toEqual([]);
  });

  it("offers nothing when the plan is clean", () => {
    expect(analysePdr({ ...baseInput, eobtMs: start, path: cleanPath(start) }).remedies).toEqual(
      [],
    );
  });
});

describe("the level remedy covers airway bands, not just areas", () => {
  // The gap this closes: a plan below an airway's published floor was told to
  // "re-file at a level inside the band", yet the recommended actions listed
  // only ROUTE and AUTH — remedies only read area incursions.
  const start = MON + 6 * HOUR;
  const belowBand = {
    ...baseInput,
    filedRoute: "BUXEL Y8 MENEX", // published from 13000 ft in AIRAC 2609
    segmentIndex,
    rflFt: 9000,
    eobtMs: start,
    path: cleanPath(start, 9000),
  };

  it("offers a LEVEL action naming the level the airway requires", () => {
    const level = analysePdr(belowBand).remedies.find((m) => m.kind === "level");
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
  // flight list and the open panel would show different verdicts.
  const start = MON + 3 * HOUR;
  const input = { ...baseInput, eobtMs: start, path: pathThrough(find("D91"), start) };

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
    expect(bulk.remedies.map((r) => r.kind)).toEqual(full.remedies.map((r) => r.kind));
  });

  it("reads a different EOBT as a different verdict, not a stale one", () => {
    // D91 is MON-FRI 0100-0900: 0300Z is inside, 1300Z outside.
    const inside = analysePdr(input).worst;
    const outside = analysePdr({
      ...input,
      eobtMs: MON + 13 * HOUR,
      path: pathThrough(find("D91"), MON + 13 * HOUR),
    }).worst;
    expect(inside).not.toBe(outside);
  });
});

describe("an unset requested level is unknown, not sea level", () => {
  // A plan with no RFL used to be checked at 0 ft: every airway band was
  // "breached" and the estimated profile sat on the ground.
  const start = MON + 6 * HOUR;
  const noLevel = {
    ...baseInput,
    filedRoute: "BUXEL Y8 MENEX", // published from 13000 ft
    segmentIndex,
    rflFt: 0,
    eobtMs: start,
    path: [],
  };

  it("does not claim the airway band is breached", () => {
    expect(analysePdr(noLevel).findings.filter((f) => f.category === "airway-level")).toEqual([]);
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

describe("auto-resolve on the real engine", () => {
  const start = MON + 3 * HOUR;
  const input = {
    ...baseInput,
    filedRoute: "MADEUP ROUTING",
    eobtMs: start,
    path: pathThrough(find("D91"), start),
    segmentIndex,
  };
  const flight = { flightKey: "k", callsign: "UBA1", filedRoute: input.filedRoute };

  it("stages the best clean published route, skipping the conventional one", () => {
    // FL240 fits the airways' published bands (W13 / W5 end at 26000 ft).
    const out = autoResolveFlight(flight, analysePdr({ ...input, rflFt: 24000 }));
    // Y8 is one-way the other way (the segment table rules it out) and W5 is a
    // non-RNAV swap — a decision, not an automatic one.
    expect(out).toMatchObject({ kind: "reroute", route: "BGO W13 MIA", remaining: [] });
    if (out.kind === "reroute") expect(out.suggestion.clears).toContain("D91");
  });

  it("applies nothing when every alternative breaks an airway band, and says so", () => {
    const out = autoResolveFlight(flight, analysePdr({ ...input, rflFt: 33000 }));
    expect(out.kind).toBe("unresolved");
    if (out.kind === "unresolved") {
      expect(out.reason).toMatch(/BGO W13 MIA: .*26000 ft/);
      expect(out.reason).not.toMatch(/\.\.$/);
    }
  });

  it("leaves the flight alone when D91 is cold and nothing is rejected on it", () => {
    const later = MON + 12 * HOUR;
    const r = analysePdr({ ...input, eobtMs: later, path: pathThrough(find("D91"), later) });
    expect(r.findings.some((f) => f.severity === "violation")).toBe(false);
  });
});
