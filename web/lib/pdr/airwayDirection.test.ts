/**
 * One-way ATS routes, checked against the REAL AIRAC 2609 (VY) segment table
 * (`public/data/aixm_vy/route_segments.json`) rather than invented fixtures.
 *
 * L524 is the worked example: a route that is BOTH-directional from BORBU to
 * KAMKO, then one-way FORWARD only (KAMKO -> KAKIP -> NURDA -> MIGAR) for the
 * rest of its length, with the level floor dropping from 28 000 ft to
 * 10 000 ft on the last leg. Both the bidirectional and one-way halves are
 * asserted here, because getting the direction sense backwards would pass a
 * naive test that only ever checks one orientation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkAirwayUsage,
  edgePermitted,
  indexSegments,
  type RouteSegment,
  type RouteSegmentFile,
} from "./airwayDirection";

const file = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../public/data/aixm_vy/route_segments.json"),
    "utf-8",
  ),
) as RouteSegmentFile;
const index = indexSegments(file.segments);

const seg = (route: string, from: string, to: string): RouteSegment => {
  const s = file.segments.find(
    (x) => x.route === route && x.from === from && x.to === to,
  );
  if (!s) throw new Error("no segment " + route + " " + from + "-" + to);
  return s;
};

describe("the ingested segment table", () => {
  it("covers the whole published network", () => {
    expect(file.segments.length).toBeGreaterThan(150);
    expect(new Set(file.segments.map((s) => s.route)).size).toBeGreaterThan(50);
  });

  it("has a meaningful share of one-way segments", () => {
    const oneWay = file.segments.filter((s) => s.direction !== "BOTH");
    expect(oneWay.length).toBeGreaterThan(10);
  });

  it("resolved every segment to a route and two named fixes", () => {
    for (const s of file.segments) {
      expect(s.route).toBeTruthy();
      expect(s.from).toBeTruthy();
      expect(s.to).toBeTruthy();
      expect(["BOTH", "FORWARD", "BACKWARD"]).toContain(s.direction);
    }
  });

  it("matches the AIP for L524: one-way only from KAMKO onward", () => {
    expect(seg("L524", "KAMKO", "KAKIP").direction).toBe("FORWARD");
    expect(seg("L524", "KAKIP", "NURDA").direction).toBe("FORWARD");
    expect(seg("L524", "NURDA", "MIGAR").direction).toBe("FORWARD");
  });

  it("matches the AIP for L524: the BORBU-KAMKO leg is bidirectional", () => {
    expect(seg("L524", "BORBU", "KAMKO").direction).toBe("BOTH");
  });

  it("carries the per-segment level band that changes down the route", () => {
    expect(seg("L524", "KAKIP", "NURDA").lowerFt).toBe(28000);
    expect(seg("L524", "NURDA", "MIGAR").lowerFt).toBe(10000);
  });
});

describe("edgePermitted", () => {
  const s: RouteSegment = {
    route: "T1",
    from: "AAA",
    to: "BBB",
    direction: "FORWARD",
    lowerFt: null,
    upperFt: null,
    lengthNm: null,
  };

  it("allows a FORWARD segment only start -> end", () => {
    expect(edgePermitted({ to: "BBB", segment: s, forward: true })).toBe(true);
    expect(edgePermitted({ to: "AAA", segment: s, forward: false })).toBe(false);
  });

  it("inverts for BACKWARD", () => {
    const b = { ...s, direction: "BACKWARD" as const };
    expect(edgePermitted({ to: "BBB", segment: b, forward: true })).toBe(false);
    expect(edgePermitted({ to: "AAA", segment: b, forward: false })).toBe(true);
  });

  it("allows either way for BOTH", () => {
    const d = { ...s, direction: "BOTH" as const };
    expect(edgePermitted({ to: "BBB", segment: d, forward: true })).toBe(true);
    expect(edgePermitted({ to: "AAA", segment: d, forward: false })).toBe(true);
  });
});

describe("checkAirwayUsage — BORBU to MIGAR on L524", () => {
  it("accepts the published-direction routing", () => {
    const issues = checkAirwayUsage("BORBU L524 MIGAR", index, 30000);
    expect(issues.filter((i) => i.kind === "direction")).toEqual([]);
  });

  it("rejects the same span flown in reverse", () => {
    const issues = checkAirwayUsage("MIGAR L524 BORBU", index, 30000);
    const dir = issues.filter((i) => i.kind === "direction");
    expect(dir.length).toBeGreaterThan(0);
    expect(dir[0].route).toBe("L524");
    expect(dir[0].detail).toMatch(/one-way/);
  });

  it("names the direction that IS permitted, so the fix is obvious", () => {
    const issues = checkAirwayUsage("MIGAR L524 BORBU", index, 30000).filter(
      (i) => i.kind === "direction",
    );
    // Every violating segment states its own permitted sense; the span is
    // walked from MIGAR, so which one comes first is BFS order, not something
    // to assert on.
    for (const issue of issues) {
      expect(issue.detail).toMatch(
        new RegExp("may only be flown " + issue.segment!.from + " to " + issue.segment!.to),
      );
    }
    // …and the whole one-way chain back to KAMKO is covered.
    expect(issues.some((i) => i.segment?.to === "KAKIP")).toBe(true);
  });

  it("allows the BORBU-KAMKO leg reversed, which is bidirectional", () => {
    const issues = checkAirwayUsage("KAMKO L524 BORBU", index, 30000);
    expect(issues.filter((i) => i.kind === "direction")).toEqual([]);
  });
});

describe("checkAirwayUsage — level bands", () => {
  it("flags a level below the segment's published floor", () => {
    // L524 is 28 000 ft and above between KAKIP and NURDA.
    const issues = checkAirwayUsage("KAKIP L524 NURDA", index, 15000);
    const lvl = issues.filter((i) => i.kind === "level");
    expect(lvl.length).toBeGreaterThan(0);
    expect(lvl[0].detail).toMatch(/published from 28000 ft/);
  });

  it("accepts a level inside the band", () => {
    expect(
      checkAirwayUsage("KAKIP L524 NURDA", index, 30000).filter(
        (i) => i.kind === "level",
      ),
    ).toEqual([]);
  });

  it("skips the level check entirely when no level is given", () => {
    expect(
      checkAirwayUsage("KAKIP L524 NURDA", index, null).filter(
        (i) => i.kind === "level",
      ),
    ).toEqual([]);
  });
});

describe("checkAirwayUsage — tokens that are not airways", () => {
  it("ignores a DCT leg", () => {
    expect(checkAirwayUsage("BORBU DCT KAMKO", index, 30000)).toEqual([]);
  });

  it("ignores an unrecognised designator rather than inventing a finding", () => {
    expect(checkAirwayUsage("BORBU ZZ999 KAMKO", index, 30000)).toEqual([]);
  });

  it("reports two fixes that the named airway does not join", () => {
    const issues = checkAirwayUsage("BORBU L524 NOWHERE", index, 30000);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("not-connected");
  });

  it("returns nothing for a route with no airway spans", () => {
    expect(checkAirwayUsage("BORBU", index, 30000)).toEqual([]);
    expect(checkAirwayUsage("", index, 30000)).toEqual([]);
  });

  it("does not repeat the same segment issue for a long span", () => {
    const issues = checkAirwayUsage("MIGAR L524 BORBU", index, 30000);
    const keys = issues.map((i) => i.kind + (i.segment?.from ?? "") + (i.segment?.to ?? ""));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
