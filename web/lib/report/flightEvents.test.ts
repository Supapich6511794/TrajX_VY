/**
 * The flight event report is a study output — its numbers get read as fact, so
 * the things that must hold are: every event carries a real UTC time, the
 * sector-crossing time comes from the airspace boundary rather than from a
 * guess, and the per-hour aggregation buckets on the hour the event actually
 * falls in.
 */
import { describe, expect, it } from "vitest";

import { buildAirspaceIndex } from "@/lib/airspace";

import {
  buildFlightEvents,
  buildSectorHours,
  flightEventsCsv,
  hourBucket,
  sectorHourCsv,
  sectorLoadSeries,
  sectorHoursCsv,
  type SectorHourRow,
  type ReportConflict,
  type ReportFlight,
} from "./flightEvents";

/** Two synthetic TMA sectors side by side, split at lon 101 (GND to FL460). */
const SECTORS = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: { name: "West", lower: "GND SFC", upper: "460 STD" },
      geometry: {
        type: "Polygon" as const,
        coordinates: [[[99, 13], [101, 13], [101, 17], [99, 17], [99, 13]]],
      },
    },
    {
      type: "Feature" as const,
      properties: { name: "East", lower: "GND SFC", upper: "460 STD" },
      geometry: {
        type: "Polygon" as const,
        coordinates: [[[101, 13], [103, 13], [103, 17], [101, 17], [101, 13]]],
      },
    },
  ],
};

const index = buildAirspaceIndex({ tma: SECTORS });
const emptyIndex = buildAirspaceIndex({});

const START = Date.UTC(2026, 8, 7, 10, 0, 0); // 1000Z

/** An eastbound flight at FL330, one sample a minute, crossing 99E -> 103E. */
function flight(over: Partial<ReportFlight> = {}): ReportFlight {
  const points = [];
  for (let i = 0; i <= 40; i++) {
    points.push({
      lat: 15,
      lon: 99 + i * 0.1,
      altitude_ft: 33000,
      epoch_ts: new Date(START + i * 60000).toISOString(),
    });
  }
  return {
    flightKey: "F1",
    callsign: "UBA100",
    actype: "B738",
    adep: "VYYY",
    ades: "VYMD",
    points,
    route: [{ ident: "ALPHA", lat: 15, lon: 100 }],
    toc: {
      lat: 15,
      lon: 99.5,
      altitudeFt: 33000,
      epochTs: new Date(START + 5 * 60000).toISOString(),
    },
    tod: {
      lat: 15,
      lon: 102.5,
      altitudeFt: 33000,
      epochTs: new Date(START + 35 * 60000).toISOString(),
    },
    ...over,
  };
}

describe("buildFlightEvents", () => {
  const rows = buildFlightEvents(flight(), index);
  const kinds = rows.map((r) => r.event);

  it("brackets the flight with takeoff and landing", () => {
    expect(kinds[0]).toBe("TAKEOFF");
    expect(kinds[kinds.length - 1]).toBe("LANDING");
    expect(rows[0].ident).toBe("VYYY");
    expect(rows[rows.length - 1].ident).toBe("VYMD");
  });

  it("records TOC and TOD at their published times", () => {
    const toc = rows.find((r) => r.event === "TOC");
    const tod = rows.find((r) => r.event === "TOD");
    expect(toc?.timeUtc).toContain("10:05");
    expect(tod?.timeUtc).toContain("10:35");
  });

  it("times each filed waypoint at the sample that passes closest", () => {
    const wp = rows.find((r) => r.event === "WAYPOINT" && r.ident === "ALPHA");
    // ALPHA is at lon 100, which is sample 10 -> 1010Z.
    expect(wp?.timeUtc).toContain("10:10");
  });

  it("records entry and exit for both sectors crossed", () => {
    const entries = rows.filter((r) => r.event === "SECTOR_ENTRY");
    expect(entries.map((r) => r.ident)).toEqual(["West", "East"]);
    expect(rows.filter((r) => r.event === "SECTOR_EXIT")).toHaveLength(2);
  });

  it("times the sector change at the boundary crossing, not at the ends", () => {
    // lon 101 is sample 20 -> 1020Z.
    const east = rows.find(
      (r) => r.event === "SECTOR_ENTRY" && r.ident === "East",
    );
    expect(east?.timeUtc).toContain("10:20");
    expect(east?.layer).toBe("tma");
  });

  it("returns events in time order", () => {
    const t = rows.map((r) => Date.parse(r.timeUtc));
    expect([...t].sort((a, b) => a - b)).toEqual(t);
  });

  it("gives every row an absolute UTC time and an elapsed offset", () => {
    for (const r of rows) {
      expect(Number.isFinite(Date.parse(r.timeUtc))).toBe(true);
      expect(r.elapsedSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("still reports the non-airspace events with no sector data loaded", () => {
    const bare = buildFlightEvents(flight(), emptyIndex);
    const k = bare.map((r) => r.event);
    expect(k).toContain("TAKEOFF");
    expect(k).toContain("TOC");
    expect(k).toContain("LANDING");
    expect(k).not.toContain("SECTOR_ENTRY");
  });

  it("returns nothing for a flight with no samples", () => {
    expect(buildFlightEvents(flight({ points: [] }), index)).toEqual([]);
  });
});

describe("hourBucket", () => {
  it("floors to the UTC hour", () => {
    expect(hourBucket(Date.UTC(2026, 8, 7, 10, 59, 59))).toBe("2026-09-07T10:00Z");
    expect(hourBucket(Date.UTC(2026, 8, 7, 11, 0, 0))).toBe("2026-09-07T11:00Z");
  });
});

describe("buildSectorHours", () => {
  const events = [
    ...buildFlightEvents(flight(), index),
    ...buildFlightEvents(
      flight({ flightKey: "F2", callsign: "KBZ200" }),
      index,
    ),
  ];

  it("counts the aircraft entering each sector in each hour", () => {
    const west = buildSectorHours(events).find((r) => r.sector === "West");
    expect(west?.hourUtc).toBe("2026-09-07T10:00Z");
    expect(west?.entries).toBe(2);
    expect(west?.entryFlights.sort()).toEqual(["KBZ200", "UBA100"]);
  });

  it("names the flights, so a count can be traced back", () => {
    const east = buildSectorHours(events).find((r) => r.sector === "East");
    expect(east?.entryFlights).toContain("UBA100");
  });

  it("counts conflicts to solve and how many were resolved", () => {
    const conflicts: ReportConflict[] = [
      {
        id: "c1",
        aCallsign: "UBA100",
        bCallsign: "KBZ200",
        startMs: START + 10 * 60000,
        sector: "West",
        resolved: true,
      },
      {
        id: "c2",
        aCallsign: "UBA100",
        bCallsign: "MAI300",
        startMs: START + 25 * 60000,
        sector: "East",
        resolved: false,
      },
    ];
    const rows = buildSectorHours(events, conflicts);
    const west = rows.find((r) => r.sector === "West")!;
    const east = rows.find((r) => r.sector === "East")!;
    expect(west.conflictsTotal).toBe(1);
    expect(west.conflictsResolved).toBe(1);
    expect(east.conflictsTotal).toBe(1);
    expect(east.conflictsResolved).toBe(0);
    expect(east.conflictFlights).toContain("MAI300");
  });

  it("buckets a conflict into the hour it starts in", () => {
    const late: ReportConflict[] = [
      {
        id: "c3",
        aCallsign: "A",
        bCallsign: "B",
        startMs: Date.UTC(2026, 8, 7, 11, 30),
        sector: "West",
        resolved: false,
      },
    ];
    const rows = buildSectorHours(events, late);
    const h11 = rows.find(
      (r) => r.sector === "West" && r.hourUtc === "2026-09-07T11:00Z",
    );
    expect(h11?.conflictsTotal).toBe(1);
    // …and does not pollute the 1000Z row.
    const h10 = rows.find(
      (r) => r.sector === "West" && r.hourUtc === "2026-09-07T10:00Z",
    );
    expect(h10?.conflictsTotal).toBe(0);
  });

  it("skips a conflict whose sector could not be resolved", () => {
    const rows = buildSectorHours(events, [
      {
        id: "c4",
        aCallsign: "A",
        bCallsign: "B",
        startMs: START,
        sector: null,
        resolved: false,
      },
    ]);
    expect(rows.reduce((n, r) => n + r.conflictsTotal, 0)).toBe(0);
  });

  it("orders rows by hour then sector", () => {
    const rows = buildSectorHours(events);
    const keys = rows.map((r) => r.hourUtc + " " + r.sector);
    expect([...keys].sort()).toEqual(keys);
  });
});

/**
 * Occupancy — aircraft PRESENT in a sector during an hour, as opposed to
 * aircraft that crossed into it. The distinction is the whole basis of a
 * workload figure, and of the band-boxing decision built on top of it.
 */
describe("aircraft present, not just aircraft arriving", () => {
  // Airborne 1045-1125Z: in West across the hour boundary, then East.
  const LATE = Date.UTC(2026, 8, 7, 10, 45, 0);
  const crossing = () => {
    const points = [];
    for (let i = 0; i <= 40; i++) {
      points.push({
        lat: 15,
        lon: 99 + i * 0.1,
        altitude_ft: 33000,
        epoch_ts: new Date(LATE + i * 60000).toISOString(),
      });
    }
    return buildFlightEvents(flight({ points, toc: null, tod: null }), index);
  };
  const rows = buildSectorHours(crossing());
  const at = (sector: string, hour: string) =>
    rows.find((r) => r.sector === sector && r.hourUtc === hour);

  it("counts the aircraft in the hour it entered", () => {
    expect(at("West", "2026-09-07T10:00Z")?.occupancy).toBe(1);
  });

  it("still counts it in the NEXT hour, which it neither entered nor left", () => {
    // The bug this exists to prevent: a sector reading "0 traffic" at 1100
    // while an aircraft that arrived at 1050 is still inside it.
    const next = at("West", "2026-09-07T11:00Z");
    expect(next?.entries).toBe(0);
    expect(next?.occupancy).toBe(1);
    expect(next?.occupancyFlights).toEqual(["UBA100"]);
  });

  it("does not count it in a sector it had already left", () => {
    expect(at("East", "2026-09-07T10:00Z")).toBeUndefined();
    expect(at("East", "2026-09-07T11:00Z")?.occupancy).toBe(1);
  });

  it("counts one aircraft once, however many samples it left inside", () => {
    const twice = buildSectorHours([...crossing(), ...crossing()]);
    const west = twice.find(
      (r) => r.sector === "West" && r.hourUtc === "2026-09-07T10:00Z",
    );
    expect(west?.occupancy).toBe(1);
  });

  it("reports it in the sector-hours CSV", () => {
    const csv = sectorHoursCsv(rows);
    expect(csv).toContain("aircraft_present");
  });
});

describe("CSV output", () => {
  const rows = buildFlightEvents(flight(), index);

  it("writes a header and one line per event", () => {
    const lines = flightEventsCsv(rows).trim().split("\r\n");
    expect(lines[0]).toContain("flight_key");
    expect(lines[0]).toContain("time_utc");
    expect(lines).toHaveLength(rows.length + 1);
  });

  it("quotes a field containing a comma", () => {
    const withComma = buildFlightEvents(
      flight({ callsign: "UBA100, HEAVY" }),
      index,
    );
    expect(flightEventsCsv(withComma)).toContain('"UBA100, HEAVY"');
  });

  it("writes the sector-hour table with its counts", () => {
    const csv = sectorHoursCsv(buildSectorHours(rows));
    expect(csv).toContain("conflicts_resolved");
    expect(csv).toContain("West");
  });
});

describe("every row says which flight and what it did", () => {
  const rows = buildFlightEvents(flight(), index);

  it("names the flight and the sector on a crossing", () => {
    const entry = rows.find(
      (r) => r.event === "SECTOR_ENTRY" && r.ident === "East",
    )!;
    expect(entry.description).toBe("UBA100 entered East");
    expect(entry.callsign).toBe("UBA100");
    expect(entry.ident).toBe("East");
  });

  it("names the flight and the fix on a waypoint", () => {
    const wp = rows.find((r) => r.event === "WAYPOINT")!;
    expect(wp.description).toBe("UBA100 passed ALPHA");
  });

  it("describes the departure, the profile points and the arrival", () => {
    const by = (e: string) => rows.find((r) => r.event === e)!.description;
    expect(by("TAKEOFF")).toBe("UBA100 departed VYYY");
    expect(by("TOC")).toMatch(/reached top of climb at 33000 ft/);
    expect(by("TOD")).toMatch(/started descent from 33000 ft/);
    expect(by("LANDING")).toBe("UBA100 landed VYMD");
  });

  it("gives every row a non-empty description", () => {
    for (const r of rows) expect(r.description.length).toBeGreaterThan(0);
  });

  it("puts the description in the CSV", () => {
    const csv = flightEventsCsv(rows);
    expect(csv).toContain("description");
    expect(csv).toContain("UBA100 entered East");
  });
});

describe("when no airspace polygons are available", () => {
  it("produces no sector rows, so the sector report is empty rather than wrong", () => {
    const bare = buildFlightEvents(flight(), emptyIndex);
    expect(bare.some((r) => r.event === "SECTOR_ENTRY")).toBe(false);
    expect(buildSectorHours(bare)).toEqual([]);
  });
});

/**
 * The Sector information panel downloads the hour the reader has selected, and
 * only that hour — the whole-run table is the download dialog's job. It is a
 * flat table: one line per aircraft, carrying the time it actually crossed in.
 */
describe("the one-hour export", () => {
  const entry = (flight: string, hhmm: string, altFt = 32000) => ({
    flight,
    actype: "A320",
    timeUtc: "2025-12-23T" + hhmm + ":00Z",
    altFt,
  });
  const row: SectorHourRow = {
    sector: "MINGALADON TMA",
    layer: "tma",
    hourUtc: "2025-12-23T00:00Z",
    entries: 3,
    entryFlights: ["UBA100", "KBZ102", "MAI104"],
    entryEvents: [entry("UBA100", "00:05"), entry("KBZ102", "00:06", 28000), entry("MAI104", "00:41")],
    occupancy: 3,
    occupancyFlights: ["KBZ102", "MAI104", "UBA100"],
    occupancyPoints: [],
    conflictsTotal: 1,
    conflictsResolved: 0,
    conflictFlights: ["KBZ102", "MAI104"],
    conflictsByFlight: {
      KBZ102: { total: 1, resolved: 0 },
      MAI104: { total: 1, resolved: 0 },
    },
  };
  const lines = (r: SectorHourRow) => sectorHourCsv(r).trim().split("\r\n");

  it("gives one line per aircraft, not one line for the whole hour", () => {
    expect(lines(row)).toHaveLength(4); // header + 3 aircraft
  });

  it("puts the sector, the flight, the crossing time and the entry flag in columns", () => {
    const [head, first] = lines(row);
    expect(head).toBe(
      "sector,layer,hour_utc,flight,aircraft_type,entry_time_utc,entry_hhmm," +
        "entry_level_ft,entered_sector,in_conflict,conflicts,conflicts_resolved," +
        "hour_conflicts_total,hour_conflicts_resolved",
    );
    expect(first).toBe(
      "MINGALADON TMA,tma,2025-12-23T00:00Z,UBA100,A320,2025-12-23T00:05:00Z,00:05,32000,yes,no,0,0,1,0",
    );
  });

  it("reads the minute each aircraft actually crossed in, not the hour bucket", () => {
    const hhmm = lines(row).slice(1).map((l) => l.split(",")[6]);
    expect(hhmm).toEqual(["00:05", "00:06", "00:41"]);
  });

  it("marks the aircraft that were in conflict, with their own counts", () => {
    const byFlight = Object.fromEntries(
      lines(row).slice(1).map((l) => [l.split(",")[3], l.split(",")]),
    );
    expect(byFlight.UBA100[9]).toBe("no");
    expect(byFlight.KBZ102[9]).toBe("yes");
    expect(byFlight.KBZ102[10]).toBe("1");
    expect(byFlight.KBZ102[11]).toBe("0");
  });

  it("carries the selected hour and nothing else", () => {
    const other: SectorHourRow = {
      ...row,
      hourUtc: "2025-12-23T01:00Z",
      entryFlights: ["AAA999"],
      entryEvents: [entry("AAA999", "01:10")],
    };
    const out = sectorHourCsv(row);
    expect(out).toContain("2025-12-23T00:00Z");
    expect(out).not.toContain("01:00Z");
    expect(out).not.toContain("AAA999");
    // The whole-run file, by contrast, holds both hours.
    expect(sectorHoursCsv([row, other])).toContain("2025-12-23T01:00Z");
  });

  it("still lists an aircraft that was in conflict without entering this hour", () => {
    // It was already inside when the hour began: no crossing, still workload.
    const inside: SectorHourRow = {
      ...row,
      conflictFlights: [...row.conflictFlights, "GMR108"],
      conflictsByFlight: { ...row.conflictsByFlight, GMR108: { total: 1, resolved: 1 } },
    };
    const last = lines(inside).at(-1) as string;
    expect(last).toBe("MINGALADON TMA,tma,2025-12-23T00:00Z,GMR108,,,,,no,yes,1,1,1,0");
  });

  it("repeats the hour totals so the file stands on its own", () => {
    for (const l of lines(row).slice(1)) {
      expect(l.endsWith(",1,0")).toBe(true);
    }
  });

  it("marks the file UTF-8 once, at the front", () => {
    const out = sectorHourCsv(row);
    expect(out.startsWith("\uFEFF")).toBe(true);
    expect(out.split("\uFEFF")).toHaveLength(2);
  });

  it("survives an hour with no traffic at all", () => {
    const quiet: SectorHourRow = {
      ...row,
      entries: 0,
      entryFlights: [],
      entryEvents: [],
      conflictsTotal: 0,
      conflictsResolved: 0,
      conflictFlights: [],
      conflictsByFlight: {},
    };
    expect(lines(quiet)).toHaveLength(1); // the header, and nothing under it
  });
});

/**
 * The per-hour chart series. It is a projection of the sector-hour table, so
 * what has to hold is that it says the same thing the table says — a chart that
 * disagrees with the numbers printed beside it is worse than no chart.
 */
describe("the aircraft-per-hour series", () => {
  const LATE = Date.UTC(2026, 8, 7, 10, 45, 0);
  const points = [];
  for (let i = 0; i <= 40; i++) {
    points.push({
      lat: 15,
      lon: 99 + i * 0.1,
      altitude_ft: 33000,
      epoch_ts: new Date(LATE + i * 60000).toISOString(),
    });
  }
  const rows = buildSectorHours(
    buildFlightEvents(flight({ points, toc: null, tod: null }), index),
  );
  const series = sectorLoadSeries(rows, "tma", "West");

  it("covers every hour the sector was used, in time order", () => {
    expect(series.map((p) => p.hourUtc)).toEqual([
      "2026-09-07T10:00Z",
      "2026-09-07T11:00Z",
    ]);
  });

  it("plots aircraft PRESENT, so an hour with no entry is not drawn as empty", () => {
    const eleven = series.find((p) => p.hourUtc === "2026-09-07T11:00Z");
    expect(eleven?.entries).toBe(0);
    expect(eleven?.present).toBe(1);
  });

  it("carries the same numbers as the table it is drawn from", () => {
    for (const p of series) {
      const r = rows.find((x) => x.sector === "West" && x.hourUtc === p.hourUtc);
      expect(p.present).toBe(r?.occupancy);
      expect(p.entries).toBe(r?.entries);
      expect(p.conflicts).toBe(r?.conflictsTotal);
    }
  });

  it("returns nothing for a sector that was never flown", () => {
    expect(sectorLoadSeries(rows, "tma", "NOWHERE")).toEqual([]);
  });

  it("keeps the layers apart", () => {
    expect(sectorLoadSeries(rows, "ctr", "West")).toEqual([]);
  });
});
