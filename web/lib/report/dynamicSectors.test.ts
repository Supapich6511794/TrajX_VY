/**
 * Dynamic sectorization.
 *
 * Two things have to hold for this to be usable as a study output: a merge is
 * only ever proposed between sectors that actually touch, and the plan is a
 * pure function of the traffic — the same sample must always produce the same
 * grouping, or nothing can be checked against it.
 *
 * The adjacency half is tested against the REAL published BACC geometry, not a
 * fixture: whether the 12 Thai en-route sectors share boundaries is a fact about
 * the dataset, and a synthetic square grid would prove nothing about it.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildAirspaceIndex } from "@/lib/airspace";

import {
  applyPlan,
  DEFAULT_DYNAMIC_CONFIG,
  describePosition,
  dynamicLog,
  dynamicLogCsv,
  dynamicLogTable,
  dynamicSectorsCsv,
  leadTimeIssues,
  dynamicSpansCsv,
  planDynamicSectors,
  planHour,
  type DynamicSectorConfig,
} from "./dynamicSectors";
import type { SectorHourRow } from "./flightEvents";
import { areAdjacent, buildSectorAdjacency, sectorsOf } from "./sectorAdjacency";

// --- the real airspace ------------------------------------------------------
// sectors_corrected/ is Bangkok ACC's own internal sector split — not
// published in any AIP/AIXM feed, so there is no VY equivalent and the Thai
// files have been removed. `load` fails closed (empty collection) so the rest
// of this file's synthetic-data tests still collect and run; the two describes
// below that assert real BACC facts are skipped instead of failing against an
// empty index.
const HAS_VT_FIXTURES = existsSync(
  resolve(__dirname, "../../public/data/sectors_corrected/bacc_geo.geojson"),
);
const load = (p: string) => {
  try {
    return JSON.parse(
      readFileSync(resolve(__dirname, "../../public/data/" + p), "utf-8"),
    );
  } catch {
    return { type: "FeatureCollection", features: [] };
  }
};
const realIndex = buildAirspaceIndex({
  bacc: load("sectors_corrected/bacc_geo.geojson"),
  ctr: load("sectors_corrected/ctr.geojson"),
  tma: load("sectors_corrected/tma.geojson"),
});
const baccAdj = buildSectorAdjacency(realIndex, "bacc");

describe.skipIf(!HAS_VT_FIXTURES)("sector adjacency, against the published BACC geometry", () => {
  it("knows every sector, with the altitude slabs collapsed into one", () => {
    const names = sectorsOf(baccAdj);
    expect(names.length).toBeGreaterThan(0);
    // 3S and 6S are published as _lower / _upper slabs; a controller works "3S".
    expect(names.some((n) => /_lower|_upper/.test(n))).toBe(false);
    expect(names).toContain("3S");
  });

  it("finds the 27 boundary pairs the 12 published sectors share", () => {
    const pairs = sectorsOf(baccAdj).reduce(
      (n, s) => n + (baccAdj.get(s)?.size ?? 0),
      0,
    );
    expect(sectorsOf(baccAdj)).toHaveLength(12);
    expect(pairs / 2).toBe(27);
  });

  it("gives every en-route sector at least one neighbour to merge with", () => {
    for (const s of sectorsOf(baccAdj)) {
      expect(baccAdj.get(s)?.size ?? 0).toBeGreaterThan(0);
    }
  });

  it("is symmetric and has no self-loops", () => {
    for (const a of sectorsOf(baccAdj)) {
      expect(baccAdj.get(a)?.has(a)).toBeFalsy();
      for (const b of baccAdj.get(a) ?? []) {
        expect(areAdjacent(baccAdj, b, a)).toBe(true);
      }
    }
  });

  it("leaves a sector no one touches out of every merge", () => {
    expect(areAdjacent(baccAdj, "1N", "NOT A SECTOR")).toBe(false);
  });

  it("reports the CTRs as islands, because they are", () => {
    // Control zones sit around their own aerodromes. "Nothing to band-box" is
    // the right answer for that layer, not a bug to paper over.
    const ctr = buildSectorAdjacency(realIndex, "ctr");
    const links = sectorsOf(ctr).reduce((n, s) => n + (ctr.get(s)?.size ?? 0), 0);
    expect(sectorsOf(ctr).length).toBeGreaterThan(10);
    expect(links / 2).toBeLessThan(3);
  });
});

// --- the planner ------------------------------------------------------------

/** A line of four sectors: A-B-C-D, each touching only its neighbours. */
const LINE = new Map<string, ReadonlySet<string>>([
  ["A", new Set(["B"])],
  ["B", new Set(["A", "C"])],
  ["C", new Set(["B", "D"])],
  ["D", new Set(["C"])],
]);

const HOUR = "2026-09-07T03:00Z";

/** A sector-hour row carrying `n` distinct aircraft, named per sector so the
 *  union across a merge is the sum unless the test overlaps them on purpose. */
function row(
  sector: string,
  flights: string[],
  hourUtc = HOUR,
  layer = "bacc",
): SectorHourRow {
  return {
    sector,
    layer,
    hourUtc,
    entries: flights.length,
    entryFlights: [...flights],
    entryEvents: [],
    occupancy: flights.length,
    occupancyFlights: [...flights],
    occupancyPoints: [],
    conflictsTotal: 0,
    conflictsResolved: 0,
    conflictFlights: [],
    conflictsByFlight: {},
  };
}

const n = (sector: string, count: number) =>
  row(
    sector,
    Array.from({ length: count }, (_, i) => sector + "F" + i),
  );

const cfg = (over: Partial<DynamicSectorConfig> = {}): DynamicSectorConfig => ({
  ...DEFAULT_DYNAMIC_CONFIG,
  ...over,
});

const byLabel = (h: ReturnType<typeof planHour>) => h.positions.map((p) => p.label);

describe("planHour — who works what", () => {
  const rows = (list: SectorHourRow[]) => new Map(list.map((r) => [r.sector, r]));

  it("merges two quiet neighbours into one position", () => {
    const h = planHour(
      HOUR,
      rows([n("A", 2), n("B", 3)]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
    );
    expect(byLabel(h)).toContain("A+B");
  });

  it("counts the merged position by aircraft, and says what each sector brought", () => {
    const h = planHour(
      HOUR,
      rows([n("A", 2), n("B", 3)]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
    );
    const p = h.positions.find((x) => x.label === "A+B");
    expect(p?.flights).toBe(5);
    expect(p?.members).toEqual([
      { sector: "A", flights: 2 },
      { sector: "B", flights: 3 },
    ]);
    expect(describePosition(p!)).toBe(
      "A: 2 flights + B: 3 flights → merged as A+B (5 total)",
    );
  });

  it("does not double-count an aircraft that was in both sectors", () => {
    // It transits A then B. To the controller now holding both, it is one
    // aircraft, and a plan that says two would over-state its own workload.
    const h = planHour(
      HOUR,
      rows([row("A", ["SAME", "X1"]), row("B", ["SAME", "X2"])]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
    );
    expect(h.positions.find((p) => p.label === "A+B")?.flights).toBe(3);
  });

  it("refuses to merge sectors that do not touch", () => {
    // A and D are both empty and both quiet — and at opposite ends.
    const h = planHour(HOUR, rows([n("A", 1), n("D", 1)]), LINE, cfg({ mergeBelow: 6 }));
    expect(byLabel(h)).not.toContain("A+D");
  });

  it("leaves a busy sector on its own", () => {
    const h = planHour(HOUR, rows([n("A", 9), n("B", 1)]), LINE, cfg({ mergeBelow: 6 }));
    expect(byLabel(h)).toContain("A");
    expect(byLabel(h).some((l) => l.includes("A+"))).toBe(false);
  });

  it("judges the RESULT against the threshold, not the pieces", () => {
    // 3 + 3 = 6 is not under 6: two quiet sectors that would make a busy
    // position stay apart.
    const two = cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 });
    const at = planHour(HOUR, rows([n("A", 3), n("B", 3)]), LINE, two);
    expect(byLabel(at)).not.toContain("A+B");
    const under = planHour(HOUR, rows([n("A", 3), n("B", 2)]), LINE, two);
    expect(byLabel(under)).toContain("A+B");
  });

  it("honours the cap on how much airspace one position may hold", () => {
    const empty = rows([]);
    const two = planHour(HOUR, empty, LINE, cfg({ maxSectorsPerPosition: 2 }));
    expect(two.positions.every((p) => p.sectors.length <= 2)).toBe(true);
    const three = planHour(HOUR, empty, LINE, cfg({ maxSectorsPerPosition: 3 }));
    expect(three.positions.some((p) => p.sectors.length === 3)).toBe(true);
  });

  it("plans every published sector, including one with no traffic at all", () => {
    const h = planHour(HOUR, rows([n("A", 1)]), LINE, cfg({ mergeBelow: 1 }));
    expect(h.baselineSectors).toBe(4);
    expect(h.positions.flatMap((p) => p.sectors).sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("counts the positions it opened against the baseline", () => {
    const h = planHour(HOUR, rows([]), LINE, cfg({ maxSectorsPerPosition: 2 }));
    expect(h.baselineSectors).toBe(4);
    expect(h.positionsOpen).toBe(2); // A+B and C+D
  });

  it("band-boxes the empty end of the airspace first, smallest position first", () => {
    // A carries 2 and B carries 3; C and D carry nothing. With room for three
    // sectors on one position the quiet end goes together first — which is what
    // "merge the smallest adjacent pair" means, and why the rule is stated as a
    // ceiling on the result rather than a test on each sector.
    const h = planHour(
      HOUR,
      rows([n("A", 2), n("B", 3)]),
      LINE,
      cfg({ mergeBelow: 6, maxSectorsPerPosition: 3 }),
    );
    expect(byLabel(h)).toEqual(["A", "B+C+D"]);
  });

  it("gives the same answer twice for the same traffic", () => {
    const input = () => rows([n("A", 1), n("B", 1), n("C", 1), n("D", 1)]);
    const one = planHour(HOUR, input(), LINE, cfg());
    const two = planHour(HOUR, input(), LINE, cfg());
    expect(byLabel(one)).toEqual(byLabel(two));
  });

  it("opens one position per sector when nothing may merge", () => {
    const h = planHour(HOUR, rows([n("A", 9), n("B", 9), n("C", 9), n("D", 9)]), LINE, cfg());
    expect(byLabel(h)).toEqual(["A", "B", "C", "D"]);
    expect(h.positionsOpen).toBe(h.baselineSectors);
  });
});

// --- across the day ---------------------------------------------------------

const H = (hh: number) => "2026-09-07T" + String(hh).padStart(2, "0") + ":00Z";

describe("planDynamicSectors — merging and splitting back over a run", () => {
  // Quiet at 0200 and 0300, busy from 0400.
  const rows = [
    ...[n("A", 1), n("B", 1)].map((r) => ({ ...r, hourUtc: H(2) })),
    ...[n("A", 2), n("B", 1)].map((r) => ({ ...r, hourUtc: H(3) })),
    ...[n("A", 9), n("B", 8)].map((r) => ({ ...r, hourUtc: H(4) })),
  ];
  const plan = planDynamicSectors(rows, LINE, cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }));

  it("merges while it is quiet", () => {
    const at3 = plan.hours.find((h) => h.hourUtc === H(3));
    expect(at3?.positions.map((p) => p.label)).toContain("A+B");
  });

  it("splits back when the traffic returns, and says which sectors those were", () => {
    const at4 = plan.hours.find((h) => h.hourUtc === H(4));
    expect(at4?.positions.map((p) => p.label)).toContain("A");
    expect(at4?.positions.map((p) => p.label)).toContain("B");
    expect(at4?.splitBack).toEqual(["A", "B"]);
  });

  it("reports the band-box as a PERIOD, not as scattered hours", () => {
    const span = plan.spans.find((s) => s.label === "A+B");
    expect(span?.fromHourUtc).toBe(H(2));
    expect(span?.toHourUtc).toBe(H(4)); // exclusive: in force 0200 up to 0400
    expect(span?.hours).toBe(2);
    expect(span?.endedBy).toBe("traffic");
  });

  it("records the busiest hour the merged position saw", () => {
    expect(plan.spans.find((s) => s.label === "A+B")?.peakFlights).toBe(3);
  });

  it("says when a band-box was still in force at the end of the sample", () => {
    const quiet = planDynamicSectors(
      [n("A", 1), n("B", 1)].map((r) => ({ ...r, hourUtc: H(2) })),
      LINE,
      cfg({ maxSectorsPerPosition: 2 }),
    );
    expect(quiet.spans.find((s) => s.label === "A+B")?.endedBy).toBe("end-of-run");
  });

  it("keeps the published sectors as the baseline, untouched", () => {
    expect(plan.baseline).toEqual(["A", "B", "C", "D"]);
    for (const h of plan.hours) {
      expect(h.positions.flatMap((p) => p.sectors).sort()).toEqual(["A", "B", "C", "D"]);
    }
  });

  it("ignores rows from other airspace layers rather than mixing them in", () => {
    const withTma = [...rows, row("BANGKOK TMA", ["X"], H(3), "tma")];
    const p = planDynamicSectors(withTma, LINE, cfg());
    expect(p.hours.flatMap((h) => h.positions.flatMap((x) => x.sectors))).not.toContain(
      "BANGKOK TMA",
    );
  });

  it("reads the traffic off the shared sector-hour table, not its own count", () => {
    // occupancy is what the planner uses: a row with entries but no one present
    // is an empty hour, and vice versa.
    const odd = { ...n("A", 0), occupancy: 4, occupancyFlights: ["W", "X", "Y", "Z"] };
    const h = planHour(H(3), new Map([["A", odd]]), LINE, cfg({ mergeBelow: 3 }));
    expect(h.positions.find((p) => p.sectors.includes("A"))?.merged).toBe(false);
  });
});

// --- the file ---------------------------------------------------------------

describe("the exported plan", () => {
  const plan = planDynamicSectors(
    [n("A", 1), n("B", 2)].map((r) => ({ ...r, hourUtc: H(3) })),
    LINE,
    cfg({ mergeBelow: 6, maxSectorsPerPosition: 2 }),
  );
  const lines = dynamicSectorsCsv(plan).trim().split("\r\n");

  it("writes one row per published sector per hour", () => {
    expect(lines).toHaveLength(1 + 4); // header + A, B, C, D
  });

  it("names the sector, its traffic, and the position it was worked from", () => {
    const a = lines.find((l) => l.split(",")[3] === "A") as string;
    const f = a.split(",");
    expect(f[3]).toBe("A");
    expect(f[4]).toBe("1"); // its own flights
    expect(f[5]).toBe("A+B"); // the position
    expect(f[7]).toBe("3"); // the position's flights
    expect(f[8]).toBe("MERGED");
  });

  /** Column by NAME: the table gains columns as the planner learns to do more,
   *  and a test pinned to an index fails for the wrong reason when it does. */
  const col = (line: string, name: string) =>
    line.split(",")[lines[0].split(",").indexOf(name)];

  it("carries the thresholds that produced it", () => {
    expect(lines[0]).toContain("merge_below");
    expect(col(lines[1], "merge_below")).toBe("6");
    expect(col(lines[1], "split_above")).toBe(String(DEFAULT_DYNAMIC_CONFIG.splitAbove));
  });

  it("states on every row that the published sectors are unchanged", () => {
    for (const l of lines.slice(1)) {
      expect(l).toContain("dynamic operational configuration");
    }
  });

  it("counts the positions saved against the baseline", () => {
    expect(col(lines[1], "baseline_sectors")).toBe("4");
    // C and D are empty and adjacent, so they band-box too: A+B and C+D.
    expect(col(lines[1], "positions_open")).toBe("2");
    expect(col(lines[1], "positions_saved")).toBe("2");
  });

  it("says whether the sector was over capacity, and what moved", () => {
    expect(lines[0]).toContain("overloaded");
    expect(lines[0]).toContain("boundary_change");
    expect(col(lines[1], "overloaded")).toBe("no");
    expect(col(lines[1], "boundary_change")).toBe("");
    expect(col(lines[1], "hour_change")).toBe("merge");
  });

  it("writes the band-box periods as their own table", () => {
    const span = dynamicSpansCsv(plan).trim().split("\r\n");
    expect(span[0]).toContain("from_hour_utc");
    expect(span[1]).toContain("A+B");
    expect(span[1]).toContain("end-of-run");
  });
});

// --- against the real airspace ---------------------------------------------

describe.skipIf(!HAS_VT_FIXTURES)("planning over the published BACC sectors", () => {
  const quiet = sectorsOf(baccAdj).map((sector, i) =>
    row(sector, i < 3 ? ["Q" + i] : [], H(3)),
  );
  const busy = sectorsOf(baccAdj).map((sector) =>
    row(sector, Array.from({ length: 12 }, (_, i) => sector + "B" + i), H(9)),
  );

  it("band-boxes a quiet night into far fewer positions", () => {
    const plan = planDynamicSectors([...quiet], baccAdj, cfg({ mergeBelow: 6 }));
    const h = plan.hours[0];
    expect(h.baselineSectors).toBe(12);
    expect(h.positionsOpen).toBeLessThan(12);
    expect(h.positions.some((p) => p.merged)).toBe(true);
  });

  it("keeps every published sector accounted for, merged or not", () => {
    const plan = planDynamicSectors([...quiet], baccAdj, cfg({ mergeBelow: 6 }));
    expect(plan.hours[0].positions.flatMap((p) => p.sectors).sort()).toEqual(
      sectorsOf(baccAdj),
    );
  });

  it("opens all twelve when the traffic is there", () => {
    const plan = planDynamicSectors([...busy], baccAdj, cfg({ mergeBelow: 6 }));
    const h = plan.hours[0];
    expect(h.positionsOpen).toBe(12);
    expect(h.positions.every((p) => !p.merged)).toBe(true);
  });

  it("only ever groups sectors that share a boundary", () => {
    const plan = planDynamicSectors([...quiet], baccAdj, cfg({ mergeBelow: 6 }));
    for (const p of plan.hours[0].positions) {
      // Every member must touch at least one other member of its own position,
      // or the "position" is two pieces of unconnected airspace.
      if (!p.merged) continue;
      for (const s of p.sectors) {
        expect(p.sectors.some((o) => o !== s && areAdjacent(baccAdj, s, o))).toBe(true);
      }
    }
  });

  it("splits back the moment the morning traffic arrives", () => {
    const plan = planDynamicSectors([...quiet, ...busy], baccAdj, cfg({ mergeBelow: 6 }));
    const morning = plan.hours.find((h) => h.hourUtc === H(9));
    expect(morning?.splitBack.length).toBeGreaterThan(0);
    expect(plan.spans.every((sp) => sp.toHourUtc <= H(9))).toBe(true);
  });
});

// --- the busy half: re-cutting an overloaded sector -------------------------

/** WEST 98-100E and EAST 100-102E, sharing the 100E boundary. */
const areaBox = (west: number, south: number, size = 2) => [
  [
    { lat: south, lon: west },
    { lat: south, lon: west + size },
    { lat: south + size, lon: west + size },
    { lat: south + size, lon: west },
  ],
];
const SHAPES = new Map([
  ["WEST", areaBox(98, 13)],
  ["EAST", areaBox(100, 13)],
]);
const PAIR = new Map<string, ReadonlySet<string>>([
  ["WEST", new Set(["EAST"])],
  ["EAST", new Set(["WEST"])],
]);

/** `n` aircraft strung west to east across WEST. */
const inWest = (n: number, hourUtc = H(9)): SectorHourRow => ({
  ...row("WEST", Array.from({ length: n }, (_, i) => "W" + i), hourUtc),
  occupancyPoints: Array.from({ length: n }, (_, i) => ({
    flight: "W" + i,
    lat: 14,
    lon: 98.1 + (1.8 * i) / Math.max(1, n - 1),
  })),
});

const areaCfg = (over: Partial<DynamicSectorConfig> = {}) =>
  cfg({ splitAbove: 14, mergeBelow: 3, maxSectorsPerPosition: 2, ...over });

describe("an overloaded sector has its airspace re-cut", () => {
  const plan = (n: number, eastLoad = 0, over: Partial<DynamicSectorConfig> = {}) =>
    planDynamicSectors(
      [inWest(n), row("EAST", Array.from({ length: eastLoad }, (_, i) => "E" + i), H(9))],
      PAIR,
      areaCfg(over),
      { shapes: SHAPES },
    );

  it("leaves a sector under capacity alone", () => {
    const h = plan(10).hours[0];
    expect(h.overloaded).toEqual([]);
    expect(h.transfers).toEqual([]);
    expect(h.change).toBe("none");
  });

  it("names the sector that is over capacity", () => {
    expect(plan(16).hours[0].overloaded).toEqual([{ sector: "WEST", flights: 16 }]);
  });

  it("hands a slice to the neighbour with room", () => {
    const t = plan(16).hours[0].transfers;
    expect(t).toHaveLength(1);
    expect(t[0].from).toBe("WEST");
    expect(t[0].to).toBe("EAST");
    expect(t[0].fromAfter).toBe(13);
    expect(t[0].quadrant).toBe("east");
    expect(t[0].areaNm2).toBeGreaterThan(0);
    expect(t[0].boundary.length).toBeGreaterThanOrEqual(3);
  });

  it("calls the hour a split", () => {
    expect(plan(16).hours[0].change).toBe("split");
  });

  it("refuses when the neighbour has no room, and says so", () => {
    const h = plan(16, 13).hours[0];
    expect(h.transfers).toEqual([]);
    expect(h.blocked).toHaveLength(1);
    expect(h.blocked[0].sector).toBe("WEST");
    expect(h.blocked[0].reason).toMatch(/overload would move/);
  });

  it("reports an overload it cannot cut rather than staying silent", () => {
    // No outlines supplied at all.
    const bare = planDynamicSectors([inWest(16)], PAIR, areaCfg());
    const h = bare.hours[0];
    expect(h.overloaded).toHaveLength(1);
    expect(h.transfers).toEqual([]);
    expect(h.blocked[0].reason).toMatch(/outlines are not loaded/);
  });

  it("will not cut on a partial picture of where the traffic is", () => {
    const noPoints = { ...inWest(16), occupancyPoints: [] };
    const h = planDynamicSectors([noPoints], PAIR, areaCfg(), { shapes: SHAPES })
      .hours[0];
    expect(h.transfers).toEqual([]);
    expect(h.blocked[0].reason).toMatch(/positions are known for only 0/);
  });

  it("refuses to cut around active restricted airspace", () => {
    const h = planDynamicSectors([inWest(16)], PAIR, areaCfg(), {
      shapes: SHAPES,
      blockersAt: () => [{ ident: "VTR9", rings: areaBox(99.7, 13.8, 0.2) }],
    }).hours[0];
    expect(h.transfers).toEqual([]);
    expect(h.blocked[0].reason).toMatch(/VTR9/);
  });

  it("does not re-cut a sector that is inside a band-box", () => {
    // Both quiet enough to merge; neither can then be overloaded.
    const quiet = planDynamicSectors(
      [inWest(1), row("EAST", ["E0"], H(9))],
      PAIR,
      areaCfg({ mergeBelow: 6, splitAbove: 2 }),
      { shapes: SHAPES },
    ).hours[0];
    expect(quiet.positions.some((p) => p.merged)).toBe(true);
    expect(quiet.transfers).toEqual([]);
  });
});

describe("a configuration change is an operational act", () => {
  it("gives each change the notice its lead time asks for", () => {
    const plan = planDynamicSectors(
      [inWest(16, H(9)), inWest(2, H(10))],
      PAIR,
      areaCfg({ leadTimeMin: 20, minHoldHours: 1 }),
      { shapes: SHAPES },
    );
    const split = plan.transitions.find((t) => t.kind === "split");
    expect(split?.hourUtc).toBe(H(9));
    expect(split?.notifyBy).toBe("2026-09-07T08:40Z");
  });

  it("says in words what has to change", () => {
    const plan = planDynamicSectors([inWest(16)], PAIR, areaCfg(), {
      shapes: SHAPES,
    });
    expect(plan.transitions[0].detail).toMatch(/WEST cedes its east airspace/);
    expect(plan.transitions[0].detail).toMatch(/aircraft/);
  });

  it("lists restoring the published boundaries when the rush passes", () => {
    const plan = planDynamicSectors(
      [inWest(16, H(9)), inWest(4, H(10))],
      PAIR,
      areaCfg({ minHoldHours: 1 }),
      { shapes: SHAPES },
    );
    expect(plan.transitions.some((t) => t.detail === "restore the published boundaries")).toBe(
      true,
    );
  });

  it("does not list an hour where nothing changed", () => {
    const plan = planDynamicSectors(
      [inWest(16, H(9)), inWest(16, H(10)), inWest(16, H(11))],
      PAIR,
      areaCfg(),
      { shapes: SHAPES },
    );
    // One split, and no repeat of it for the two identical hours after.
    expect(plan.transitions.filter((t) => t.kind === "split")).toHaveLength(1);
  });

  it("holds a band-box for the minimum before consolidating again", () => {
    // Quiet, busy, quiet: with a 3 hour hold the middle hour must not re-merge
    // the moment it goes quiet again.
    const rows = [
      row("WEST", ["a"], H(1)),
      row("EAST", ["b"], H(1)),
      row("WEST", ["a", "b", "c", "d"], H(2)),
      row("EAST", ["e", "f", "g", "h"], H(2)),
      row("WEST", ["a"], H(3)),
      row("EAST", ["b"], H(3)),
    ];
    const held = planDynamicSectors(
      rows,
      PAIR,
      areaCfg({ mergeBelow: 3, minHoldHours: 3 }),
      { shapes: SHAPES },
    );
    const loose = planDynamicSectors(
      rows,
      PAIR,
      areaCfg({ mergeBelow: 3, minHoldHours: 1 }),
      { shapes: SHAPES },
    );
    const mergedAt = (p: typeof held, hh: number) =>
      p.hours.find((h) => h.hourUtc === H(hh))?.positions.some((x) => x.merged);
    expect(mergedAt(loose, 3)).toBe(true);
    expect(mergedAt(held, 3)).toBe(false);
  });
});

// --- who decides ------------------------------------------------------------

/**
 * Auto plans from the traffic; manual leaves the published configuration alone
 * until someone asks otherwise. Either way an override is the operator's word,
 * and the plan has to record that a person made the call.
 */
describe("auto, manual, and the operator's override", () => {
  const quietAndBusy = [
    inWest(1, H(8)),
    row("EAST", ["e0"], H(8)),
    inWest(16, H(9)),
  ];
  const run = (over: Partial<DynamicSectorConfig>) =>
    planDynamicSectors(quietAndBusy, PAIR, areaCfg(over), { shapes: SHAPES });

  const at = (p: ReturnType<typeof run>, hh: number) =>
    p.hours.find((h) => h.hourUtc === H(hh));

  it("auto merges the quiet hour and splits the busy one", () => {
    const p = run({ mode: "auto", mergeBelow: 3 });
    expect(at(p, 8)?.change).toBe("merge");
    expect(at(p, 9)?.change).toBe("split");
  });

  it("manual keeps the published configuration in both", () => {
    const p = run({ mode: "manual", mergeBelow: 3 });
    expect(at(p, 8)?.change).toBe("none");
    expect(at(p, 9)?.change).toBe("none");
    expect(at(p, 8)?.positions.every((x) => !x.merged)).toBe(true);
    expect(at(p, 9)?.transfers).toEqual([]);
  });

  it("still measures the overload in manual, it just does not act on it", () => {
    // The count is a fact about the traffic; only the response is a choice, and
    // a sector over capacity has to be said either way.
    const p = run({ mode: "manual", mergeBelow: 3 });
    expect(at(p, 9)?.overloaded).toEqual([{ sector: "WEST", flights: 16 }]);
    expect(at(p, 9)?.transfers).toEqual([]);
    expect(at(p, 9)?.blocked[0].reason).toMatch(/set not to re-cut/);
  });

  it("ignores a stored override while in auto — the traffic decides, or the mode is a lie", () => {
    // The control is not even shown in auto. If the stored value still applied,
    // a decision nobody could see would be steering the result.
    const p = run({ mode: "auto", mergeBelow: 3, overrides: { [H(8)]: "keep" } });
    expect(at(p, 8)?.change).toBe("merge");
    expect(at(p, 8)?.decision).toBe("auto");
    expect(at(p, 8)?.manual).toBe(false);
  });

  it("keeps the override for when manual comes back", () => {
    // Switching to auto to see what the traffic would have done must not throw
    // the operator's work away.
    const cfg = { mergeBelow: 3, overrides: { [H(8)]: "keep" } } as const;
    expect(at(run({ ...cfg, mode: "auto" }), 8)?.change).toBe("merge");
    expect(at(run({ ...cfg, mode: "manual" }), 8)?.change).toBe("none");
  });

  it("takes an override against the mode, in manual", () => {
    const p = run({ mode: "manual", mergeBelow: 3, overrides: { [H(9)]: "split" } });
    expect(at(p, 9)?.change).toBe("split");
    expect(at(p, 9)?.manual).toBe(true);
    expect(at(p, 8)?.change).toBe("none");
  });

  it("can be told to merge only, and still names the overload it left", () => {
    const p = run({ mode: "manual", mergeBelow: 3, overrides: { [H(9)]: "merge" } });
    expect(at(p, 9)?.transfers).toEqual([]);
    expect(at(p, 9)?.overloaded).toHaveLength(1);
  });

  it("can be told to split only, leaving quiet sectors apart", () => {
    const p = run({ mode: "manual", mergeBelow: 3, overrides: { [H(8)]: "split" } });
    expect(at(p, 8)?.positions.every((x) => !x.merged)).toBe(true);
  });

  it("records how every hour was decided, so the file can be audited", () => {
    const p = run({ mode: "manual", mergeBelow: 3, overrides: { [H(8)]: "merge" } });
    expect(p.hours.map((h) => h.decision)).toEqual(["merge", "keep"]);
  });
});

describe("accepting a configuration", () => {
  const proposal = planDynamicSectors([inWest(16)], PAIR, areaCfg(), {
    shapes: SHAPES,
  });

  it("starts as a recommendation, not a decision", () => {
    expect(proposal.appliedAt).toBeNull();
    expect(dynamicSectorsCsv(proposal)).toContain("PROPOSED");
  });

  it("is stamped when the operator accepts it", () => {
    const applied = applyPlan(proposal, Date.UTC(2026, 8, 12, 7, 30, 0));
    expect(applied.appliedAt).toBe("2026-09-12T07:30:00Z");
    const csv = dynamicSectorsCsv(applied);
    expect(csv).toContain("APPLIED");
    expect(csv).toContain("2026-09-12T07:30:00Z");
  });

  it("leaves the recommendation it came from untouched", () => {
    applyPlan(proposal);
    expect(proposal.appliedAt).toBeNull();
  });

  it("changes nothing about the configuration itself", () => {
    const applied = applyPlan(proposal);
    expect(applied.hours).toEqual(proposal.hours);
    expect(applied.transitions).toEqual(proposal.transitions);
  });
});

// --- the log ----------------------------------------------------------------

/**
 * The log is what someone reads afterwards to say what the configuration was
 * and where. Every hour has to appear — including the quiet ones, which were a
 * decision too — and every line that names airspace has to carry enough to draw
 * it.
 */
describe("the configuration log", () => {
  const plan = planDynamicSectors(
    [
      // 0800 quiet enough to band-box, 0900 over capacity, 1000 ordinary.
      row("WEST", ["a"], H(8)),
      row("EAST", ["b"], H(8)),
      inWest(16, H(9)),
      row("WEST", ["x", "y", "z"], H(10)),
      row("EAST", ["p", "q", "r"], H(10)),
    ],
    PAIR,
    areaCfg({ mergeBelow: 3, splitAbove: 14 }),
    { shapes: SHAPES },
  );
  const log = dynamicLog(plan);

  it("covers every hour, including the ones where nothing changed", () => {
    expect([...new Set(log.map((e) => e.hourUtc))]).toEqual([H(8), H(9), H(10)]);
  });

  it("records a band-box, and which sectors it covers", () => {
    const merge = log.find((e) => e.kind === "merge");
    expect(merge?.hourUtc).toBe(H(8));
    expect(merge?.label).toBe("EAST+WEST");
    expect(merge?.sectors.sort()).toEqual(["EAST", "WEST"]);
    expect(merge?.transfer).toBeNull();
  });

  it("records a re-cut, and carries the shape so the map can draw it", () => {
    const split = log.find((e) => e.kind === "split");
    expect(split?.hourUtc).toBe(H(9));
    expect(split?.sectors).toEqual(["WEST", "EAST"]);
    expect(split?.transfer?.boundary.length).toBeGreaterThanOrEqual(3);
    expect(split?.detail).toMatch(/cedes its east airspace to EAST/);
  });

  it("says so when the published configuration simply stood", () => {
    const keep = log.find((e) => e.hourUtc === H(10));
    expect(keep?.kind).toBe("keep");
    expect(keep?.sectors).toEqual([]);
    expect(keep?.detail).toMatch(/published configuration stands/);
  });

  it("records who decided each line", () => {
    const manual = planDynamicSectors(
      [inWest(16, H(9))],
      PAIR,
      areaCfg({ mode: "manual", overrides: { [H(9)]: "keep" } }),
      { shapes: SHAPES },
    );
    expect(dynamicLog(manual)[0].decidedBy).toBe("operator");
    expect(log.every((e) => e.decidedBy === "auto")).toBe(true);
  });

  it("numbers the lines within an hour so the order is stable", () => {
    const busy = log.filter((e) => e.hourUtc === H(9));
    expect(busy.map((e) => e.seq)).toEqual(
      busy.map((_, i) => i),
    );
  });

  it("exports as a table with a row per line", () => {
    const table = dynamicLogTable(plan);
    expect(table[0]).toEqual([
      "hour_utc",
      "hour",
      "action",
      "what",
      "sectors",
      "detail",
      "decided_by",
    ]);
    expect(table).toHaveLength(log.length + 1);
    expect(dynamicLogCsv(plan)).toContain("MERGE");
    expect(dynamicLogCsv(plan)).toContain("SPLIT");
  });

  it("logs an overload nobody could relieve, rather than passing over it", () => {
    const stuck = planDynamicSectors(
      [inWest(16, H(9)), row("EAST", Array.from({ length: 13 }, (_, i) => "e" + i), H(9))],
      PAIR,
      areaCfg(),
      { shapes: SHAPES },
    );
    const over = dynamicLog(stuck).find((e) => e.kind === "overload");
    expect(over?.label).toBe("WEST");
    expect(over?.detail).toMatch(/holds 16/);
  });
});

// --- is there time to brief it? ---------------------------------------------

/**
 * Lead time decides whether a recommendation can be acted on, so the check has
 * to fire on the cases that really are impossible and stay quiet otherwise — a
 * warning that cried wolf on an ordinary plan would be turned off by the second
 * day.
 */
describe("lead time that leaves no room to brief", () => {
  /** Quiet, busy, quiet: a change at each hour boundary. */
  const swinging = [
    row("WEST", ["a"], H(1)),
    row("EAST", ["b"], H(1)),
    inWest(16, H(2)),
    row("WEST", ["a"], H(3)),
    row("EAST", ["b"], H(3)),
  ];
  const at = (leadTimeMin: number) =>
    leadTimeIssues(
      planDynamicSectors(
        swinging,
        PAIR,
        areaCfg({ leadTimeMin, mergeBelow: 3, minHoldHours: 1 }),
        { shapes: SHAPES },
      ),
    );

  it("says nothing when there is time", () => {
    expect(at(20)).toEqual([]);
  });

  it("flags a change that would be briefed before the one it follows", () => {
    // Changes are an hour apart; 90 minutes of notice puts the later brief
    // half an hour BEFORE the earlier change takes effect.
    const clash = at(90).find((i) =>
      /at or before the .* change it follows/.test(i.reason),
    );
    expect(clash).toBeDefined();
    expect(clash?.reason).toMatch(/60 min apart/);
    expect(clash?.reason).toMatch(/lead time is 90 min/);
  });

  it("does not mistake two lines about ONE change for two changes", () => {
    // An hour that both un-merges and moves a boundary produces two transition
    // lines at the same time. They are one brief.
    const sameHour = at(20);
    expect(sameHour).toEqual([]);
  });

  it("is quiet at exactly the gap between changes, and not a minute more", () => {
    // 60 min lead means the brief lands exactly ON the previous change, which
    // is already too late; 59 leaves a minute.
    expect(at(59)).toEqual([]);
    expect(at(60).length).toBeGreaterThan(0);
  });

  it("flags a first change that needed notice before the sample began", () => {
    const early = leadTimeIssues(
      planDynamicSectors(
        [row("WEST", ["a"], H(1)), row("EAST", ["b"], H(1)), inWest(16, H(2))],
        PAIR,
        areaCfg({ leadTimeMin: 45, mergeBelow: 3, minHoldHours: 1 }),
        { shapes: SHAPES },
      ),
    );
    // The 0200 change needs briefing at 0115, which is after 0100 — fine. Push
    // the lead past the run's own start and it is not.
    const impossible = leadTimeIssues(
      planDynamicSectors(
        [inWest(16, H(1))],
        PAIR,
        areaCfg({ leadTimeMin: 30, minHoldHours: 1 }),
        { shapes: SHAPES },
      ),
    );
    expect(early).toEqual([]);
    expect(impossible.every((i) => i.reason.includes("before the sample"))).toBe(true);
  });

  it("says nothing at all when no notice is required", () => {
    expect(at(0)).toEqual([]);
  });

  it("names the hour and the time the brief was due", () => {
    const [issue] = at(90);
    expect(issue.hourUtc).toMatch(/T0[0-9]:00Z/);
    expect(issue.notifyBy).toMatch(/Z$/);
  });
});
