import { describe, expect, it } from "vitest";

import { matchesPdrSearch, pdrSearchTerms } from "@/lib/pdr/search";

const flight = (callsign: string, adep: string, ades: string) => ({
  callsign,
  adep,
  ades,
});

const UBA201 = flight("UBA201", "VYYY", "VYMD");
const MMA3221 = flight("MMA3221", "VYNT", "VYHH");

const hit = (f: ReturnType<typeof flight>, q: string) =>
  matchesPdrSearch(f, pdrSearchTerms(q));

describe("pdrSearchTerms", () => {
  it("upper-cases and splits on spaces and commas, dropping blanks", () => {
    expect(pdrSearchTerms("  uba  vyyy,vymd ,")).toEqual(["UBA", "VYYY", "VYMD"]);
  });

  it("is empty for a blank query", () => {
    expect(pdrSearchTerms("")).toEqual([]);
    expect(pdrSearchTerms("   ")).toEqual([]);
  });

  it("reads -> as the arrow the rows draw", () => {
    expect(pdrSearchTerms("vyyy->vymd")).toEqual(["VYYY→VYMD"]);
  });
});

describe("matchesPdrSearch", () => {
  it("matches everything when there is nothing to search for", () => {
    expect(hit(UBA201, "")).toBe(true);
    expect(hit(UBA201, "   ")).toBe(true);
  });

  it("finds a callsign by any part of it, in any case", () => {
    expect(hit(UBA201, "uba201")).toBe(true);
    expect(hit(UBA201, "UBA")).toBe(true);
    expect(hit(UBA201, "a20")).toBe(true);
    expect(hit(MMA3221, "UBA")).toBe(false);
  });

  it("finds a flight by either aerodrome", () => {
    expect(hit(UBA201, "VYYY")).toBe(true); // departure
    expect(hit(UBA201, "vymd")).toBe(true); // destination
    expect(hit(UBA201, "VYHH")).toBe(false);
  });

  it("finds a flight by the pair as the row writes it", () => {
    expect(hit(UBA201, "VYYY→VYMD")).toBe(true);
    expect(hit(UBA201, "VYYY->VYMD")).toBe(true);
    expect(hit(UBA201, "VYYY-VYMD")).toBe(true);
    // The pair has a direction: the reverse is another flight.
    expect(hit(UBA201, "VYMD→VYYY")).toBe(false);
  });

  it("narrows with several terms, in any order", () => {
    expect(hit(UBA201, "UBA VYYY")).toBe(true);
    expect(hit(UBA201, "VYYY UBA")).toBe(true);
    expect(hit(UBA201, "UBA VYHH")).toBe(false);
    expect(hit(MMA3221, "UBA VYNT")).toBe(false);
  });

  it("treats two aerodromes as 'between these', whichever way round", () => {
    expect(hit(UBA201, "VYMD VYYY")).toBe(true);
  });

  it("does not match a query that is nowhere on the row", () => {
    expect(hit(UBA201, "zzz")).toBe(false);
  });
});
