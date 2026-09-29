import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import {
  areaIdentsOnPath,
  evaluateConstraints,
  restrictedAreasFrom,
  type ConstraintInput,
  type RestrictedArea,
} from "./constraints";

const cfg = resolveConfig();

/** A 0.2°-square restricted area around (100.5, 13.5), GND–FL200 — same
 *  `type`/`designator`/`lower`/`upper` shape as aixm_vy/restricted_areas.geojson. */
const AREA_COLL = {
  features: [
    {
      type: "Feature" as const,
      properties: {
        type: "R",
        designator: "1",
        name: "TEST RESTRICTED",
        lower: "GND SFC",
        upper: "200 STD",
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [100.4, 13.4],
            [100.6, 13.4],
            [100.6, 13.6],
            [100.4, 13.6],
            [100.4, 13.4],
          ],
        ],
      },
    },
  ],
};

const restricted = restrictedAreasFrom(AREA_COLL);

function base(over: Partial<ConstraintInput> = {}): ConstraintInput {
  return {
    maneuverType: "heading",
    resolution: {},
    cfg,
    afterPath: [{ lat: 12.0, lon: 99.0, altFt: 35000 }], // far from the area
    originalAreaIdents: new Set(),
    restricted,
    trackDeg: 90,
    ...over,
  };
}

describe("restrictedAreasFrom / areaIdentsOnPath", () => {
  it("parses a PDR polygon with its altitude band", () => {
    expect(restricted).toHaveLength(1);
    expect(restricted[0]).toMatchObject({ ident: "R1", kind: "R", lowerFt: 0, upperFt: 20000 });
  });

  it("detects a path point inside the area within its band", () => {
    const inside = areaIdentsOnPath([{ lat: 13.5, lon: 100.5, altFt: 10000 }], restricted);
    expect(inside.has("R1")).toBe(true);
  });

  it("ignores a point above the area's ceiling", () => {
    const above = areaIdentsOnPath([{ lat: 13.5, lon: 100.5, altFt: 30000 }], restricted);
    expect(above.has("R1")).toBe(false);
  });

  it("ignores a point outside the polygon", () => {
    const out = areaIdentsOnPath([{ lat: 12.0, lon: 99.0, altFt: 10000 }], restricted);
    expect(out.size).toBe(0);
  });
});

describe("evaluateConstraints", () => {
  it("accepts a clean maneuver clear of everything", () => {
    const r = evaluateConstraints(
      base({
        newAltFt: 35000, // FL350 eastbound = odd ✓
        recheck: { clear: true, minSepNm: 8 },
      }),
    );
    // Only the honest "terrain not evaluated" warn should downgrade it.
    expect(r.verdict).toBe("caution");
    expect(r.checks.find((c) => c.category === "Conflict")!.status).toBe("pass");
    expect(r.checks.find((c) => c.category === "Airspace")!.status).toBe("pass");
  });

  it("rejects a maneuver that newly enters a restricted area", () => {
    const r = evaluateConstraints(
      base({
        afterPath: [{ lat: 13.5, lon: 100.5, altFt: 10000 }], // inside R1
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(r.checks.some((c) => c.category === "Airspace" && c.status === "fail")).toBe(true);
  });

  it("does NOT flag an area the original route already crossed", () => {
    const r = evaluateConstraints(
      base({
        afterPath: [{ lat: 13.5, lon: 100.5, altFt: 10000 }],
        originalAreaIdents: new Set(["R1"]), // filed route already inside
      }),
    );
    expect(r.checks.some((c) => c.category === "Airspace" && c.status === "fail")).toBe(false);
  });

  it("rejects a secondary conflict from the re-check", () => {
    const r = evaluateConstraints(
      base({
        recheck: {
          clear: false,
          minSepNm: 2.5,
          secondary: { callsign: "KMV9", dCpaNm: 2.5 },
        },
      }),
    );
    expect(r.verdict).toBe("reject");
    const conflict = r.checks.find((c) => c.category === "Conflict")!;
    expect(conflict.status).toBe("fail");
    expect(conflict.label).toBe("Secondary conflict");
    expect(conflict.detail).toContain("KMV9");
    expect(conflict.detail).toContain("newly");
  });

  it("does not call the pair partner a secondary conflict", () => {
    // The aircraft this fix is FOR is not a cascading conflict: a secondary
    // conflict is one the maneuver CREATES, and the partner is the one it was
    // proposed to remove. Reporting it as secondary told the controller to go
    // and resolve the conflict they were already resolving.
    const r = evaluateConstraints(
      base({
        recheck: {
          clear: false,
          minSepNm: 0,
          unresolved: { callsign: "UAE114", dCpaNm: 0 },
        },
      }),
    );
    expect(r.verdict).toBe("reject");
    const conflict = r.checks.find((c) => c.category === "Conflict")!;
    expect(conflict.label).toBe("Conflict persists with UAE114");
    expect(conflict.label).not.toContain("Secondary");
    expect(conflict.detail).toContain("does not resolve");
  });

  it("reports both when the fix neither resolves the pair nor clears a third", () => {
    const r = evaluateConstraints(
      base({
        recheck: {
          clear: false,
          minSepNm: 0,
          unresolved: { callsign: "UAE114", dCpaNm: 0 },
          secondary: { callsign: "KMV9", dCpaNm: 3.1, alsoCount: 2 },
        },
      }),
    );
    const conflicts = r.checks.filter((c) => c.category === "Conflict");
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].label).toContain("UAE114");
    expect(conflicts[1].label).toBe("Secondary conflict");
    expect(conflicts[1].detail).toContain("2 more");
  });

  it("still says something useful when the caller names nobody", () => {
    const r = evaluateConstraints(base({ recheck: { clear: false, minSepNm: 2.5 } }));
    expect(r.verdict).toBe("reject");
    const conflict = r.checks.find((c) => c.category === "Conflict")!;
    expect(conflict.label).toBe("Not clear of other traffic");
  });

  it("warns on the semicircular rule (level against the direction of flight)", () => {
    const r = evaluateConstraints(
      base({
        trackDeg: 90, // eastbound → wants odd thousands
        newAltFt: 36000, // FL360 even → wrong direction
        recheck: { clear: true, minSepNm: 8 },
      }),
    );
    expect(r.checks.some((c) => c.label.includes("Semicircular"))).toBe(true);
  });

  it("warns on 250 kt below FL100 (speed change at low level)", () => {
    const r = evaluateConstraints(
      base({
        newGsKt: 300,
        afterPath: [{ lat: 12.0, lon: 99.0, altFt: 8000 }], // below FL100
        recheck: { clear: true, minSepNm: 8 },
      }),
    );
    expect(r.checks.some((c) => c.label.includes("250 kt"))).toBe(true);
  });

  it("fails an out-of-envelope speed", () => {
    const r = evaluateConstraints(base({ newGsKt: 90, recheck: { clear: true, minSepNm: 8 } }));
    expect(r.verdict).toBe("reject");
    expect(r.checks.some((c) => c.category === "Performance" && c.status === "fail")).toBe(true);
  });
});
