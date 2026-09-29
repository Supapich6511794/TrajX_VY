import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The runway-default table is optional data: no climatology has been built for
 * the Yangon FIR, so in this deployment the file is normally absent and the
 * module must fail closed. These tests serve a small SYNTHETIC table (made-up
 * numbers on real VY runway designators) to check the lookup rules, and a 404
 * to check the dormant path.
 */
const CSV = [
  "airport,month_of_year,direction,runway,pct,movements,n_years,rnk,is_default",
  // VYYY August: departures and arrivals resolve to different ends, and the
  // pooled ALL bucket disagrees with ARR — DEP/ARR must win over ALL.
  "VYYY,8,DEP,21,81,4200,3,1,t",
  "VYYY,8,DEP,03,19,980,3,2,f",
  "VYYY,8,ARR,03,55.5,2600,3,1,t",
  "VYYY,8,ARR,21,44.5,2080,3,2,f",
  "VYYY,8,ALL,21,63,6900,3,1,t",
  // VYMD: the preferred end reverses between the dry season and the monsoon.
  "VYMD,1,ARR,17,70,900,3,1,t",
  "VYMD,8,ARR,35,68,850,3,1,t",
  // VYNT February: ALL + DEP rows only, so an ARR lookup falls back to ALL.
  "VYNT,2,ALL,34,90,120,3,1,t",
  "VYNT,2,DEP,34,92,60,3,1,t",
].join("\n");

/** Fresh module per test: the table is memoised at module scope. */
async function load(body: string | null) {
  vi.resetModules();
  vi.stubGlobal("fetch", async (url: string) => {
    if (body != null && String(url).endsWith("/data/airports/runway_default.csv"))
      return new Response(body, { status: 200 });
    return new Response("", { status: 404 });
  });
  return import("./runwayDefault");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("eobtMonth", () => {
  it("reads the month out of a datetime-local EOBT", async () => {
    const { eobtMonth } = await load(CSV);
    expect(eobtMonth("2026-08-08T00:16")).toBe(8);
    expect(eobtMonth("2026-01-01T00:00")).toBe(1);
  });

  it("returns 0 for an unset or malformed EOBT", async () => {
    const { eobtMonth } = await load(CSV);
    expect(eobtMonth("")).toBe(0);
    expect(eobtMonth("tomorrow")).toBe(0);
  });
});

describe("runwayDefault", () => {
  it("returns the month's most-used departure runway", async () => {
    const { runwayDefault } = await load(CSV);
    const d = await runwayDefault("VYYY", 8, "DEP");
    expect(d).toMatchObject({
      ident: "RW21",
      runway: "21",
      pct: 81,
      movements: 4200,
      nYears: 3,
      source: "DEP",
    });
  });

  it("returns the month's most-used arrival runway, not the pooled one", async () => {
    const { runwayDefault } = await load(CSV);
    const d = await runwayDefault("vyyy", 8, "ARR");
    expect(d).toMatchObject({ ident: "RW03", pct: 55.5, source: "ARR" });
  });

  it("tracks a seasonal reversal month to month", async () => {
    const { runwayDefault } = await load(CSV);
    expect((await runwayDefault("VYMD", 1, "ARR"))?.ident).toBe("RW17");
    expect((await runwayDefault("VYMD", 8, "ARR"))?.ident).toBe("RW35");
  });

  it("falls back to the pooled bucket when a direction has no rows", async () => {
    const { runwayDefault } = await load(CSV);
    const d = await runwayDefault("VYNT", 2, "ARR");
    expect(d).toMatchObject({ ident: "RW34", source: "ALL" });
  });

  it("returns null for an aerodrome or month the table doesn't cover", async () => {
    const { runwayDefault } = await load(CSV);
    expect(await runwayDefault("EGLL", 8, "DEP")).toBeNull();
    expect(await runwayDefault("", 8, "DEP")).toBeNull();
    expect(await runwayDefault("VYYY", 0, "DEP")).toBeNull();
    expect(await runwayDefault("VYYY", 13, "DEP")).toBeNull();
  });

  it("fails closed when the table file is absent", async () => {
    const { runwayDefault } = await load(null);
    expect(await runwayDefault("VYYY", 8, "DEP")).toBeNull();
    expect(await runwayDefault("VYMD", 1, "ARR")).toBeNull();
  });
});
