/**
 * ENR 1.10 route rules.
 *
 * No published city-pair route table is shipped for Myanmar yet
 * (`/data/aip_routes_VY.json` does not exist and `fetchAipRoutes` fails closed
 * to an empty list), so the table here is a small inline VY-flavoured one. The
 * condition shapes it carries are the ones the parser understands: an
 * area-activity dependency ("when VY D91 is not active"), a time window with a
 * holiday exclusion, and an aircraft class. Anything else must come back
 * `unparsed` and `unknown` — a condition this app cannot read must never be
 * reported as satisfied.
 */
import { describe, expect, it } from "vitest";

import type { AipRoute } from "@/lib/aipRoutes";

import {
  AREA_ICAO_PREFIX,
  aircraftClass,
  evaluateCondition,
  matchFiledRoute,
  parseCondition,
  routeTokens,
  sameRoute,
} from "./routeRules";
import type { PdrActivity, PdrArea } from "./types";

/** Synthetic, directional: VYYY->VYMD and VYMD->VYYY are separate entries. */
const table: AipRoute[] = [
  { adep: "VYYY", ades: "VYMD", rnav: true, route: "BGO W13 MIA" },
  {
    adep: "VYYY",
    ades: "VYMD",
    rnav: true,
    route: "BGO W1 MIA",
    condition: "when VY D91 is not active",
  },
  {
    adep: "VYYY",
    ades: "VYMD",
    rnav: false,
    route: "BGO W5 MIA",
    condition: "Excluding Public Holiday; MON-FRI 0100-0900 UTC",
  },
  { adep: "VYMD", ades: "VYYY", rnav: true, route: "MIA W13 BGO", condition: "for jet aircraft" },
  { adep: "VYMD", ades: "VYYY", rnav: false, route: "MIA W1 BGO", condition: "when VY R92 is active" },
];

const MON = Date.UTC(2026, 8, 7); // Monday
const HOUR = 3600000;

function areaWith(designator: string, sheets: PdrActivity["sheets"]): PdrArea {
  const activity: PdrActivity = {
    designator,
    type: "D",
    name: designator,
    sheets,
    activityNote: sheets.length ? "" : "Notified by NOTAM",
    restriction: "",
    hazard: "",
    remarks: "",
  };
  return {
    ident: designator,
    name: designator,
    kind: "D",
    lowerFt: 0,
    upperFt: 20000,
    mp: [],
    activity,
    centroid: { lat: 19.6, lon: 96.2 },
    bbox: [95.5, 19, 97, 20.5],
  };
}

const workday = [
  {
    day: "MON",
    dayTil: "FRI",
    start: "01:00",
    end: "09:00",
    startEvent: null,
    endEvent: null,
    excluded: false,
    timeReference: "UTC",
  },
];

const ctx = (whenMs: number, actype?: string) => ({
  whenMs,
  areasByIdent: new Map([
    ["D91", areaWith("D91", workday)],
    ["R92", areaWith("R92", workday)],
  ]),
  actype,
});

describe("parseCondition", () => {
  it("uses the Myanmar ICAO prefix", () => {
    expect(AREA_ICAO_PREFIX).toBe("VY");
  });

  it("reads an area dependency, with or without the space in the ident", () => {
    // Areas are keyed class + designator ("D91"), without the ICAO prefix.
    expect(parseCondition("when VY D91 is not active")).toMatchObject({
      kind: "area",
      area: "D91",
      want: "inactive",
    });
    expect(parseCondition("when VYD91 is not active")).toMatchObject({
      kind: "area",
      area: "D91",
      want: "inactive",
    });
    expect(parseCondition("when VY R 19A is not active")).toMatchObject({
      kind: "area",
      area: "R19A",
    });
  });

  it("reads the positive form published for a complement route", () => {
    expect(parseCondition("when VY R92 is active")).toMatchObject({
      kind: "area",
      area: "R92",
      want: "active",
    });
  });

  it("does not read another state's area as a VY one", () => {
    expect(parseCondition("when XX D91 is not active").kind).toBe("unparsed");
  });

  it("reads a time window and notes the holiday exclusion", () => {
    const c = parseCondition("Excluding Public Holiday; MON-FRI 0100-0900 UTC");
    expect(c.kind).toBe("window");
    if (c.kind !== "window") return;
    expect(c.excludesHolidays).toBe(true);
    expect(c.sheet).toMatchObject({ day: "MON", dayTil: "FRI", start: "01:00", end: "09:00" });
  });

  it("reads an aircraft class", () => {
    expect(parseCondition("for jet aircraft")).toMatchObject({ kind: "aircraft", want: "jet" });
    expect(parseCondition("for propeller aircraft")).toMatchObject({
      kind: "aircraft",
      want: "propeller",
    });
  });

  it("marks anything else unparsed rather than guessing", () => {
    expect(parseCondition("subject to ATC approval").kind).toBe("unparsed");
  });

  it("parses every condition in the table", () => {
    const conditions = [...new Set(table.map((r) => r.condition).filter(Boolean))];
    expect(conditions.length).toBeGreaterThan(0);
    for (const c of conditions) {
      expect(parseCondition(c as string).kind).not.toBe("unparsed");
    }
  });
});

describe("evaluateCondition", () => {
  it("is met when the area the route depends on is cold", () => {
    const c = parseCondition("when VY D91 is not active");
    const v = evaluateCondition(c, ctx(MON + 12 * HOUR)); // outside 0100-0900
    expect(v.state).toBe("met");
    expect(v.detail).toContain("D91");
  });

  it("is unmet when that area is hot", () => {
    const c = parseCondition("when VY D91 is not active");
    expect(evaluateCondition(c, ctx(MON + 3 * HOUR)).state).toBe("unmet");
  });

  it("inverts correctly for the 'is active' form", () => {
    const c = parseCondition("when VY R92 is active");
    expect(evaluateCondition(c, ctx(MON + 3 * HOUR)).state).toBe("met");
    expect(evaluateCondition(c, ctx(MON + 12 * HOUR)).state).toBe("unmet");
  });

  it("is unknown when the area is not in the loaded data", () => {
    const c = parseCondition("when VY D99 is not active");
    const v = evaluateCondition(c, ctx(MON + 3 * HOUR));
    expect(v.state).toBe("unknown");
    expect(v.detail).toContain("D99");
  });

  it("is unmet outside a published window", () => {
    const c = parseCondition("Excluding Public Holiday; MON-FRI 0100-0900 UTC");
    expect(evaluateCondition(c, ctx(MON + 12 * HOUR)).state).toBe("unmet");
  });

  it("is unknown inside a window that excludes holidays, and says why", () => {
    const c = parseCondition("Excluding Public Holiday; MON-FRI 0100-0900 UTC");
    const v = evaluateCondition(c, ctx(MON + 3 * HOUR));
    expect(v.state).toBe("unknown");
    expect(v.detail).toMatch(/holiday/i);
  });

  it("matches an aircraft class and rejects the other one", () => {
    const jet = parseCondition("for jet aircraft");
    expect(evaluateCondition(jet, ctx(MON, "B738")).state).toBe("met");
    expect(evaluateCondition(jet, ctx(MON, "AT76")).state).toBe("unmet");
  });

  it("is unknown for an unrecognised type rather than assuming jet", () => {
    expect(evaluateCondition(parseCondition("for jet aircraft"), ctx(MON, "ZZZZ")).state)
      .toBe("unknown");
  });

  it("never reports an unparsed condition as satisfied", () => {
    const v = evaluateCondition(parseCondition("subject to ATC approval"), ctx(MON));
    expect(v.state).toBe("unknown");
  });
});

describe("aircraftClass", () => {
  it("classifies common turboprops and jets", () => {
    expect(aircraftClass("AT76")).toBe("propeller");
    expect(aircraftClass("DH8D")).toBe("propeller");
    expect(aircraftClass("B738")).toBe("jet");
    expect(aircraftClass("A333")).toBe("jet");
    expect(aircraftClass("E190")).toBe("jet");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(aircraftClass(" at76 ")).toBe("propeller");
  });

  it("returns unknown for an unset or unrecognised type", () => {
    expect(aircraftClass("")).toBe("unknown");
    expect(aircraftClass(null)).toBe("unknown");
    expect(aircraftClass("ZZZZ")).toBe("unknown");
  });
});

describe("route token comparison", () => {
  it("ignores spacing and case", () => {
    expect(sameRoute("bgo  w13   mia", "BGO W13 MIA")).toBe(true);
  });

  it("does not treat a different routing as the same", () => {
    expect(sameRoute("BGO W13 MIA", "BGO W1 MIA")).toBe(false);
  });

  it("splits on any whitespace run", () => {
    expect(routeTokens(" A  B\tC ")).toEqual(["A", "B", "C"]);
  });
});

describe("matchFiledRoute against the published table", () => {
  it("recognises a published route for the filed direction", () => {
    const m = matchFiledRoute("BGO W13 MIA", table, "VYYY", "VYMD");
    expect(m.kind).toBe("exact");
    expect(m.matched?.route).toBe("BGO W13 MIA");
  });

  it("flags a routing that is only published in the opposite direction", () => {
    // Take a VYYY->VYMD route and file it as if going VYMD->VYYY.
    const outbound = table.find((r) => r.adep === "VYYY" && r.ades === "VYMD");
    expect(outbound).toBeDefined();
    const m = matchFiledRoute(outbound!.route, table, "VYMD", "VYYY");
    expect(m.kind).toBe("reverse");
  });

  it("reports a non-published routing for a pair that has published routes", () => {
    const m = matchFiledRoute("SOMETHING ELSE", table, "VYYY", "VYMD");
    expect(m.kind).toBe("none");
    expect(m.forPair.length).toBeGreaterThan(0);
  });

  it("distinguishes a pair with no published route at all", () => {
    const m = matchFiledRoute("ANY ROUTE", table, "ZZZZ", "YYYY");
    expect(m.kind).toBe("none-published");
    expect(m.forPair).toEqual([]);
  });
});

describe("an empty published table (the VY default today)", () => {
  it("reports every pair as having no published route", () => {
    const m = matchFiledRoute("BGO W13 MIA", [], "VYYY", "VYMD");
    expect(m.kind).toBe("none-published");
    expect(m.matched).toBeNull();
  });
});
