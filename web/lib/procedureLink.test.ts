/**
 * The arrival end of a plan is one decision — STAR, runway, approach — and
 * these are the two links that make it one. What they must NOT do is guess:
 * the moment the data offers a choice, the choice is the controller's.
 */
import { describe, expect, it } from "vitest";

import { soleApproachFor, soleProcedure, soleRunwayOf } from "./procedureLink";

/** A VY aerodrome: NORT1C is coded for RW36 only; EAST1C serves both ends. */
const STAR_RUNWAYS: Record<string, string[]> = {
  NORT1C: ["RW36"],
  EAST1C: ["RW18", "RW36"],
  OPEN1A: [],
};

/** RW36 publishes exactly R36; RW09 (another aerodrome) publishes two. */
const APPROACHES: Record<string, string[]> = {
  RW36: ["R36"],
  RW09: ["R09-Y", "R09-Z"],
  RW18: [],
};

describe("soleRunwayOf", () => {
  it("names the runway when the STAR is coded for exactly one", () => {
    expect(soleRunwayOf(STAR_RUNWAYS, "NORT1C")).toBe("RW36");
  });

  it("says nothing when the STAR serves both ends", () => {
    // Which end is in use is the controller's call; pinning it here would fix
    // the arrival to a runway the procedure does not require.
    expect(soleRunwayOf(STAR_RUNWAYS, "EAST1C")).toBeNull();
  });

  it("says nothing for a procedure with no runway-specific legs", () => {
    expect(soleRunwayOf(STAR_RUNWAYS, "OPEN1A")).toBeNull();
  });

  it("says nothing for no STAR, or one it has never heard of", () => {
    expect(soleRunwayOf(STAR_RUNWAYS, "")).toBeNull();
    expect(soleRunwayOf(STAR_RUNWAYS, "NOPE1X")).toBeNull();
  });
});

describe("soleApproachFor", () => {
  it("names the approach when the runway publishes exactly one", () => {
    // The case from the panel: RW36 has only R36, so leaving the picker
    // on "None" served nobody.
    expect(soleApproachFor(APPROACHES, "RW36")).toBe("R36");
  });

  it("leaves a real choice alone", () => {
    expect(soleApproachFor(APPROACHES, "RW09")).toBeNull();
  });

  it("says nothing when the runway has no approach, or none is set", () => {
    expect(soleApproachFor(APPROACHES, "RW18")).toBeNull();
    expect(soleApproachFor(APPROACHES, "")).toBeNull();
    expect(soleApproachFor(APPROACHES, "RW22")).toBeNull();
  });

  it("chains: a single-runway STAR reaches a single approach", () => {
    const rwy = soleRunwayOf(STAR_RUNWAYS, "NORT1C")!;
    expect(soleApproachFor(APPROACHES, rwy)).toBe("R36");
  });
});

describe("soleProcedure", () => {
  it("names the procedure when filtering left exactly one", () => {
    // RW36 + a route leaving over LSO: one SID survives both filters,
    // so "None (direct departure)" is not a choice the data offers.
    expect(soleProcedure(["LSO1C"])).toBe("LSO1C");
  });

  it("leaves a real choice alone", () => {
    expect(soleProcedure(["LSO1C", "LSO2C"])).toBeNull();
  });

  it("says nothing when the filters left none", () => {
    expect(soleProcedure([])).toBeNull();
  });
});
