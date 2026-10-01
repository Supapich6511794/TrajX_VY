/**
 * Chart-ready views of the run reports.
 *
 * A .csv is a table and nothing else — it cannot carry an embedded chart
 * object, however it is named. What it CAN carry is a table already shaped like
 * the chart someone wants, so that selecting the block and pressing Insert →
 * Chart in Excel produces the right picture with no re-arranging: the X values
 * in the first column, one Y series per column after it, rows already in the
 * order the axis should read, and no blank cells to break a line.
 *
 * That is what each function here returns. The data files stay exactly as they
 * were — one flat table per report, for filtering and pivoting — and each gains
 * a small companion file holding just the series for its headline chart:
 *
 *   | report                | chart               | X         | Y            |
 *   |-----------------------|---------------------|-----------|--------------|
 *   | Dynamic sectorization | Conflict by sector  | sector    | conflicts    |
 *   | Sector hours          | Standard vs merged  | hour      | sector count |
 *   | Sector information    | Traffic by sector   | sector    | entries      |
 *   | Flight events         | Flight trajectory   | longitude | latitude     |
 *
 * The two "by sector" charts are sorted busiest-first, which is what makes the
 * question they answer — *which* sector — readable at a glance; the two
 * time/space charts keep their natural order, because a trajectory or a day
 * re-sorted by value is meaningless.
 *
 * Three of the four are BAR charts: their X axis is a set of buckets — sectors,
 * or hours that were counted — and a line drawn between two buckets asserts a
 * path between them that nothing travelled. The trajectory chart is the
 * exception: a line per flight on two value axes, because there the X axis
 * really is a number: longitude. A bar chart of latitude against longitude is
 * not a map.
 */

import {
  flightEventsTable,
  sectorHoursTable,
  type FlightEventRow,
  type SectorHourRow,
} from "./flightEvents";
import {
  dynamicLogTable,
  dynamicSectorsTable,
  dynamicTransfersTable,
  dynamicTransitionsTable,
  type DynamicPlan,
} from "./dynamicSectors";
import { buildWorkbook, type Cell, type ChartSpec } from "./xlsx";

/** The sheet the chart reads its series from. The report itself always
 *  sits on the first tab, untouched. */
const SERIES_SHEET = "Chart data";

/**
 * One workbook: the report as it stands, the series a chart needs, and the
 * chart on a tab of its own.
 *
 * The report sheet is the same table the .csv holds — same columns, same
 * rows, same order. A chart wants a different shape (pivoted, aggregated,
 * sorted by value), and giving it that shape at the cost of the report would
 * be trading the thing being reported for a picture of it.
 */
function reportWithChart(
  reportName: string,
  report: Cell[][],
  series: Cell[][],
  spec: ChartSpec,
): Uint8Array {
  return buildWorkbook({
    sheets: [
      { name: reportName, rows: report },
      { name: SERIES_SHEET, rows: series },
    ],
    chart: { spec, dataSheet: SERIES_SHEET },
  });
}

// --- CSV --------------------------------------------------------------------

const CRLF = String.fromCharCode(13, 10);

function csvField(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The same table the workbook holds, in the plainer container. */
export function rowsCsv(rows: Cell[][]): string {
  return (
    "﻿" +
    rows.map((r) => r.map((v) => csvField(v ?? "")).join(",")).join(CRLF) +
    CRLF
  );
}


/** "2026-09-07T03:00Z" -> "0300". Excel keeps this as text, which is what an
 *  axis label wants — a real time value would be re-formatted per locale. */
function hourLabel(hourUtc: string): string {
  const ms = Date.parse(hourUtc);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16).replace(":", "") : hourUtc;
}

// --- 1. Conflict by sector --------------------------------------------------

/**
 * Which sectors generated the conflicts, busiest first.
 *
 * Totals across the whole run: a conflict is counted in the sector that owned
 * it, and `resolved` is the part a controller actually closed out. `open` is
 * the remainder — the column a capacity study is really after, since a sector
 * that produces conflicts nobody resolved is the one that is over its limit.
 */
export function conflictBySectorRows(rows: SectorHourRow[], layer: string): Cell[][] {
  const byS = new Map<string, { total: number; resolved: number; hours: number }>();
  for (const r of rows) {
    if (r.layer !== layer) continue;
    const e = byS.get(r.sector) ?? { total: 0, resolved: 0, hours: 0 };
    e.total += r.conflictsTotal;
    e.resolved += r.conflictsResolved;
    e.hours += 1;
    byS.set(r.sector, e);
  }
  const out = [...byS.entries()].sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
  );
  return [
    ["sector", "conflicts", "resolved", "open"],
    ...out.map(([sector, e]) => [sector, e.total, e.resolved, e.total - e.resolved]),
  ];
}

/** Bars, not a line: the X axis is a list of sectors, and a line between two
 *  of them draws a slope that does not exist — nothing travels from S1S to
 *  SMU. Sorted busiest-first, so the columns read as a ranking. */
export const CONFLICT_BY_SECTOR_CHART: ChartSpec = {
  kind: "bar",
  title: "Conflicts by sector",
  xTitle: "Sector",
  yTitle: "Conflicts",
  catCol: 0,
  valCols: [1, 2, 3],
};

export function conflictBySectorCsv(rows: SectorHourRow[], layer: string): string {
  return rowsCsv(conflictBySectorRows(rows, layer));
}

export function conflictBySectorXlsx(
  rows: SectorHourRow[],
  layer: string,
  plan: DynamicPlan,
): Uint8Array {
  return reportWithChart(
    "Dynamic sectorization",
    dynamicSectorsTable(plan),
    conflictBySectorRows(rows, layer),
    CONFLICT_BY_SECTOR_CHART,
  );
}

/**
 * The whole dynamic-sectorisation result in one workbook.
 *
 * The tables that only make sense together — the log of what was in force hour
 * by hour, what each sector did, the boundaries that moved, and when the
 * configuration has to change — plus the chart. As separate files they arrive
 * as a handful of downloads and get read apart; as tabs they stay one answer.
 */
export function dynamicSectorisationXlsx(
  plan: DynamicPlan,
  rows: SectorHourRow[],
): Uint8Array {
  return buildWorkbook({
    sheets: [
      { name: "Log", rows: dynamicLogTable(plan) },
      { name: "Plan", rows: dynamicSectorsTable(plan) },
      { name: "Boundary changes", rows: dynamicTransfersTable(plan) },
      { name: "Timeline", rows: dynamicTransitionsTable(plan) },
      { name: SERIES_SHEET, rows: standardVsMergedRows(plan) },
    ],
    chart: { spec: STANDARD_VS_MERGED_CHART, dataSheet: SERIES_SHEET },
  });
}

// --- 2. Standard vs merged --------------------------------------------------

/**
 * How many controller positions the airspace needed, hour by hour.
 *
 * Two lines over the same hours: the published sector count, which is flat by
 * definition, and the positions the traffic actually justified. The gap between
 * them IS the dynamic sectorization result, which is why the saving is a column
 * of its own rather than something to be read off by subtracting.
 */
export function standardVsMergedRows(plan: DynamicPlan): Cell[][] {
  return [
    ["hour", "hour_utc", "standard_sectors", "merged_positions", "positions_saved"],
    ...plan.hours.map((h) => [
      hourLabel(h.hourUtc),
      h.hourUtc,
      h.baselineSectors,
      h.positionsOpen,
      h.baselineSectors - h.positionsOpen,
    ]),
  ];
}

/** Bars: each hour is a bucket that was counted, not a reading on a continuous
 *  curve, and the question is how the two counts compare WITHIN an hour — which
 *  is a pair of columns side by side. */
export const STANDARD_VS_MERGED_CHART: ChartSpec = {
  kind: "bar",
  title: "Standard vs merged positions",
  xTitle: "Hour (UTC)",
  yTitle: "Sectors / positions",
  catCol: 0,
  valCols: [2, 3, 4],
};

export function standardVsMergedCsv(plan: DynamicPlan): string {
  return rowsCsv(standardVsMergedRows(plan));
}

export function standardVsMergedXlsx(
  plan: DynamicPlan,
  rows: SectorHourRow[],
): Uint8Array {
  return reportWithChart(
    "Sector hours",
    sectorHoursTable(rows),
    standardVsMergedRows(plan),
    STANDARD_VS_MERGED_CHART,
  );
}

// --- 3. Traffic by sector ---------------------------------------------------

/**
 * Which sectors carried the traffic in ONE hour, busiest first.
 *
 * Scoped to an hour because that is what the Sector information panel is about.
 * `entries` is the X-to-Y the question asks for; `aircraft_present` rides along
 * because the two answer different questions and a reader with both in front of
 * them will not mistake one for the other.
 */
export function trafficBySectorRows(
  rows: SectorHourRow[],
  layer: string,
  hourUtc: string,
): Cell[][] {
  const mine = rows
    .filter((r) => r.layer === layer && r.hourUtc === hourUtc)
    .sort((a, b) => b.entries - a.entries || a.sector.localeCompare(b.sector));
  return [
    ["sector", "entries", "aircraft_present", "conflicts", "hour"],
    ...mine.map((r) => [
      r.sector,
      r.entries,
      r.occupancy,
      r.conflictsTotal,
      hourLabel(r.hourUtc),
    ]),
  ];
}

/** Bars — same reason as the conflict chart: sectors are categories. */
export const TRAFFIC_BY_SECTOR_CHART: ChartSpec = {
  kind: "bar",
  title: "Traffic by sector",
  xTitle: "Sector",
  yTitle: "Aircraft",
  catCol: 0,
  valCols: [1, 2],
};

export function trafficBySectorCsv(
  rows: SectorHourRow[],
  layer: string,
  hourUtc: string,
): string {
  return rowsCsv(trafficBySectorRows(rows, layer, hourUtc));
}

/**
 * The workbook behind the sector panel's "This hour" button.
 *
 * Both sheets are THIS HOUR. The report sheet used to be `sectorHoursTable(rows)`
 * — the whole run, every sector, every hour — while only the chart was filtered,
 * so a button labelled "This hour" handed over a day. Anyone who opened the
 * first tab, which is the one Excel lands on, was reading numbers for hours
 * they had not asked about and could not tell apart.
 */
export function trafficBySectorXlsx(
  rows: SectorHourRow[],
  layer: string,
  hourUtc: string,
): Uint8Array {
  const thisHour = rows.filter((r) => r.layer === layer && r.hourUtc === hourUtc);
  return reportWithChart(
    "Sector hours",
    sectorHoursTable(thisHour),
    trafficBySectorRows(rows, layer, hourUtc),
    {
      ...TRAFFIC_BY_SECTOR_CHART,
      title: "Traffic by sector · " + hourLabel(hourUtc) + "Z",
    },
  );
}

// --- 4. Flight trajectory ---------------------------------------------------

/** Most flights (flight_keys) to put in one trajectory chart. Excel draws a
 *  series per flight and the legend, not the maths, is what gives out first. */
export const TRAJECTORY_MAX_FLIGHTS = 25;

/**
 * The callsigns a trajectory chart draws: the first `maxFlights` in callsign
 * order. One rule, used by `flightTrajectoryRows` AND by anyone who wants to
 * know which flights to build events for before drawing it — the chart plots
 * 25 flights however big the sample is, so walking a whole traffic day to draw
 * it is 2,000 flights of work for a picture of 25.
 */
export function trajectoryChartCallsigns(
  callsigns: Iterable<string>,
  maxFlights = TRAJECTORY_MAX_FLIGHTS,
): Set<string> {
  return new Set(
    [...new Set(callsigns)].sort((a, b) => a.localeCompare(b)).slice(0, maxFlights),
  );
}

/** Columns of the trajectory series, in order. X/Y first after the keys so
 *  the block reads like the chart: one row per event, grouped by flight. */
export const TRAJECTORY_COLUMNS = [
  "flight_key",
  "callsign",
  "elapsed_s",
  "lon",
  "lat",
  "altitude_ft",
  "event",
  "ident",
] as const;

const COL = {
  flightKey: 0,
  callsign: 1,
  lon: 3,
  lat: 4,
  altitude: 5,
  event: 6,
  ident: 7,
};

/**
 * Flight tracks as one row per event: X = lon, Y = lat, grouped by
 * `flight_key` and ordered by `elapsed_s` inside each group.
 *
 * Long rather than wide, so each point keeps its own callsign, level, event
 * and fix — the hover reads them straight off the row — and a flight is a
 * contiguous block of rows, which is all a chart series needs to point at.
 * Flights are ordered by callsign then key; only the first `maxFlights` keys
 * are kept.
 *
 * Points come from the event rows, so the track is the flight's own milestones
 * — takeoff, each filed fix, TOC/TOD, every sector boundary, landing — not a
 * resampled copy of the trajectory. That keeps the file small enough to chart
 * while still following the route.
 */
export function flightTrajectoryRows(
  events: FlightEventRow[],
  maxFlights = TRAJECTORY_MAX_FLIGHTS,
): Cell[][] {
  const byFlight = new Map<string, FlightEventRow[]>();
  for (const e of events) {
    const list = byFlight.get(e.flightKey);
    if (list) list.push(e);
    else byFlight.set(e.flightKey, [e]);
  }
  const flights = [...byFlight.values()]
    .sort(
      (a, b) =>
        a[0].callsign.localeCompare(b[0].callsign) ||
        a[0].flightKey.localeCompare(b[0].flightKey),
    )
    .slice(0, maxFlights);

  const out: Cell[][] = [[...TRAJECTORY_COLUMNS]];
  for (const rows of flights) {
    for (const e of [...rows].sort((a, b) => a.elapsedSec - b.elapsedSec)) {
      out.push([
        e.flightKey,
        e.callsign,
        e.elapsedSec,
        e.lonDeg,
        e.latDeg,
        e.altFt,
        e.event,
        e.ident,
      ]);
    }
  }
  return out;
}

/**
 * The chart for `flightTrajectoryRows`: one line per flight_key, joined in
 * elapsed order. Longitude is a number, so the lines are drawn on two value
 * axes (an Excel "scatter with straight lines") — a category-axis line chart
 * would space the longitudes evenly and draw a different map.
 *
 * A series is named by its callsign, or by its flight_key when two of the
 * flights drawn share a callsign and the legend could not tell them apart.
 */
export function flightTrajectoryChart(series: Cell[][]): ChartSpec {
  const groups: { key: string; callsign: string; r0: number; r1: number }[] = [];
  for (let r = 1; r < series.length; r++) {
    const key = String(series[r][COL.flightKey] ?? "");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.r1 = r;
    else groups.push({ key, callsign: String(series[r][COL.callsign] ?? ""), r0: r, r1: r });
  }
  const perCallsign = new Map<string, number>();
  for (const g of groups) perCallsign.set(g.callsign, (perCallsign.get(g.callsign) ?? 0) + 1);
  return {
    kind: "scatter",
    title: "Flight trajectories",
    xTitle: "Longitude (deg E)",
    yTitle: "Latitude (deg N)",
    xCol: COL.lon,
    yCol: COL.lat,
    groups: groups.map((g) => ({
      name: g.callsign && perCallsign.get(g.callsign) === 1 ? g.callsign : g.key,
      r0: g.r0,
      r1: g.r1,
    })),
    hoverCols: [COL.callsign, COL.altitude, COL.event, COL.ident],
  };
}

export function flightTrajectoryCsv(
  events: FlightEventRow[],
  maxFlights = TRAJECTORY_MAX_FLIGHTS,
): string {
  return rowsCsv(flightTrajectoryRows(events, maxFlights));
}

export function flightTrajectoryXlsx(
  events: FlightEventRow[],
  maxFlights = TRAJECTORY_MAX_FLIGHTS,
): Uint8Array {
  const series = flightTrajectoryRows(events, maxFlights);
  return reportWithChart(
    "Flight events",
    flightEventsTable(events),
    series,
    flightTrajectoryChart(series),
  );
}
