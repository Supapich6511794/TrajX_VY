/**
 * Flight event report — when each aircraft did what, and what that gave each
 * ATC sector to do.
 *
 * The trajectory exports answer "where was this aircraft at time t", one row
 * per surveillance sample. A fast-time study asks the other question: *when did
 * things happen*, and *how much work did each sector have*. That is two tables:
 *
 *   1. **Flight events** — one row per event on one flight's timeline: takeoff,
 *      each filed waypoint it passes, top of climb, top of descent, every
 *      sector it enters and leaves, and landing. This is what carries the
 *      sector-crossing TIME the trajectory files never state explicitly: they
 *      hold a position every few seconds and leave the boundary to be inferred.
 *
 *   2. **Sector hours** — one row per (sector, hour): how many aircraft entered,
 *      which ones, how many conflicts arose there in that hour, how many of
 *      those were resolved, and which flights were involved. That is the
 *      workload figure a sector-capacity study is after.
 *
 * Both are built from data the app already has — the generated trajectories,
 * the airspace polygons and the run's conflict log — and both are pure
 * functions over plain inputs, so the whole report is unit-testable without a
 * browser. The React layer only fetches the pieces and saves the file.
 *
 * Times are absolute UTC. A sector-hour report keyed by "seconds since the
 * first departure" would be unreadable next to a real traffic sample.
 */

import {
  buildAirspaceSegments,
  controllingLayer,
  formatAirspace,
  type AirspaceIndex,
} from "@/lib/airspace";

/** One aircraft's generated trajectory, as the report needs it. */
export interface ReportFlight {
  flightKey: string;
  callsign: string;
  actype: string;
  adep: string;
  ades: string;
  /** The emitted samples, in order. */
  points: ReadonlyArray<{
    lat: number;
    lon: number;
    altitude_ft: number | null;
    epoch_ts: string;
  }>;
  /** The filed route's fixes, for the waypoint-crossing rows. */
  route: ReadonlyArray<{ ident: string; lat: number; lon: number }>;
  /** Top of climb / top of descent, when the profile reached cruise. */
  toc: { lat: number; lon: number; altitudeFt: number; epochTs: string } | null;
  tod: { lat: number; lon: number; altitudeFt: number; epochTs: string } | null;
}

export type FlightEventKind =
  | "TAKEOFF"
  | "WAYPOINT"
  | "TOC"
  | "TOD"
  | "SECTOR_ENTRY"
  | "SECTOR_EXIT"
  | "LANDING";

export interface FlightEventRow {
  flightKey: string;
  callsign: string;
  actype: string;
  adep: string;
  ades: string;
  event: FlightEventKind;
  /** Waypoint ident, or the sector/unit name for the sector events. */
  ident: string;
  /** Which airspace layer the sector events refer to (ctr / tma / cta / …). */
  layer: string;
  /** The row in words — "UBA100 entered Mingaladon TMA". The coded columns are for
   *  filtering and pivoting; this is so a reader can see what happened without
   *  decoding `event` + `ident` in their head. */
  description: string;
  /** Absolute UTC of the event. */
  timeUtc: string;
  /** Seconds since this flight's own first sample — the elapsed-time column. */
  elapsedSec: number;
  latDeg: number;
  lonDeg: number;
  altFt: number;
}

const R_NM = 3440.065;
const HOUR_MS = 3600000;

function haversineNm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000", "");
}

/** UTC hour bucket an instant falls in, as "YYYY-MM-DDTHH:00Z". */
export function hourBucket(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13) + ":00Z";
}

/**
 * Every event on one flight's timeline, in time order.
 *
 * `index` may be empty — the sector rows are simply omitted then, rather than
 * the whole report failing, so a run with the airspace layers unloaded still
 * produces takeoff / waypoint / TOC / TOD / landing.
 */
export function buildFlightEvents(
  flight: ReportFlight,
  index: AirspaceIndex,
): FlightEventRow[] {
  const pts = flight.points;
  if (pts.length === 0) return [];

  const baseMs = Date.parse(pts[0].epoch_ts);
  const rows: FlightEventRow[] = [];
  const base = {
    flightKey: flight.flightKey,
    callsign: flight.callsign,
    actype: flight.actype,
    adep: flight.adep,
    ades: flight.ades,
  };
  const describe = (
    event: FlightEventKind,
    ident: string,
    altFt: number,
  ): string => {
    const who = flight.callsign || flight.flightKey;
    switch (event) {
      case "TAKEOFF":
        return who + " departed " + ident;
      case "WAYPOINT":
        return who + " passed " + ident;
      case "TOC":
        return who + " reached top of climb at " + Math.round(altFt) + " ft";
      case "TOD":
        return who + " started descent from " + Math.round(altFt) + " ft";
      case "SECTOR_ENTRY":
        return who + " entered " + ident;
      case "SECTOR_EXIT":
        return who + " left " + ident;
      case "LANDING":
        return who + " landed " + ident;
    }
  };

  const push = (
    event: FlightEventKind,
    ident: string,
    layer: string,
    ms: number,
    at: { lat: number; lon: number; altFt: number },
  ) =>
    rows.push({
      ...base,
      event,
      ident,
      layer,
      description: describe(event, ident, at.altFt),
      timeUtc: iso(ms),
      elapsedSec: Math.round((ms - baseMs) / 1000),
      latDeg: Number(at.lat.toFixed(6)),
      lonDeg: Number(at.lon.toFixed(6)),
      altFt: Math.round(at.altFt),
    });

  const first = pts[0];
  const last = pts[pts.length - 1];
  push("TAKEOFF", flight.adep, "", baseMs, {
    lat: first.lat,
    lon: first.lon,
    altFt: first.altitude_ft ?? 0,
  });

  // --- filed waypoints: the sample that passes closest to each fix ----------
  // Two passes. A great-circle distance for every sample of every fix is routes
  // x samples trig calls per flight, which over a traffic day was the largest
  // cost left once the airspace walk was fixed. So a flat squared distance
  // (no trig) ranks the samples first, and the exact haversine is taken only
  // over those within 10% of the best flat distance — a margin wide enough that
  // the flat ranking's error (about 1% of a distance at 100 NM, so 2% of its
  // square) cannot drop the haversine winner. Same answer, a handful of
  // haversines per fix instead of one per sample.
  const flat = new Float64Array(pts.length);
  for (const wp of flight.route) {
    const lonScale = Math.cos((wp.lat * Math.PI) / 180);
    let bestFlat = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dLat = pts[i].lat - wp.lat;
      const dLon = (pts[i].lon - wp.lon) * lonScale;
      const d2 = dLat * dLat + dLon * dLon;
      flat[i] = d2;
      if (d2 < bestFlat) bestFlat = d2;
    }
    const cutoff = bestFlat * 1.1 + 1e-12;
    let bestI = -1;
    let bestNm = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (flat[i] > cutoff) continue;
      const d = haversineNm(pts[i], wp);
      if (d < bestNm) {
        bestNm = d;
        bestI = i;
      }
    }
    if (bestI < 0) continue;
    const p = pts[bestI];
    push("WAYPOINT", wp.ident, "", Date.parse(p.epoch_ts), {
      lat: p.lat,
      lon: p.lon,
      altFt: p.altitude_ft ?? 0,
    });
  }

  if (flight.toc) {
    push("TOC", "", "", Date.parse(flight.toc.epochTs), {
      lat: flight.toc.lat,
      lon: flight.toc.lon,
      altFt: flight.toc.altitudeFt,
    });
  }
  if (flight.tod) {
    push("TOD", "", "", Date.parse(flight.tod.epochTs), {
      lat: flight.tod.lat,
      lon: flight.tod.lon,
      altFt: flight.tod.altitudeFt,
    });
  }

  // --- sector entries and exits --------------------------------------------
  // buildAirspaceSegments already collapses the trajectory into contiguous runs
  // inside one controlling ATS volume, with `t0`/`t1` in seconds from the first
  // sample. A boundary is where one run ends and the next begins, so the entry
  // time IS t0 — no separate boundary search needed.
  // Elapsed seconds per sample, so a boundary time maps to a real position
  // rather than assuming the samples are evenly spaced — the surveillance
  // interval is a setting (1 s / 4 s / 5 s / custom) and the terminal phases
  // are denser than the cruise.
  const elapsed = pts.map((p) => (Date.parse(p.epoch_ts) - baseMs) / 1000);
  const sampleAt = (sec: number) => {
    let lo = 0;
    let hi = elapsed.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (elapsed[mid] < sec) lo = mid + 1;
      else hi = mid;
    }
    // `lo` is the first sample at or after `sec`; the one before may be nearer.
    if (lo > 0 && Math.abs(elapsed[lo - 1] - sec) <= Math.abs(elapsed[lo] - sec)) {
      lo -= 1;
    }
    const p = pts[lo];
    return { lat: p.lat, lon: p.lon, altFt: p.altitude_ft ?? 0 };
  };

  const segs = buildAirspaceSegments(index, [...pts]);
  for (const seg of segs) {
    if (!seg.label) continue; // outside every volume
    const layer = controllingLayer(seg.membership) ?? "";
    const name = formatAirspace(seg.membership, "full") || seg.label;
    push("SECTOR_ENTRY", name, layer, baseMs + seg.t0 * 1000, sampleAt(seg.t0));
    push("SECTOR_EXIT", name, layer, baseMs + seg.t1 * 1000, sampleAt(seg.t1));
  }

  push("LANDING", flight.ades, "", Date.parse(last.epoch_ts), {
    lat: last.lat,
    lon: last.lon,
    altFt: last.altitude_ft ?? 0,
  });

  return rows.sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc));
}

// --- sector-hour workload ---------------------------------------------------

/** One conflict from the run's log, reduced to what the sector report needs. */
export interface ReportConflict {
  id: string;
  aCallsign: string;
  bCallsign: string;
  /** Absolute UTC (ms) the encounter starts. */
  startMs: number;
  /** The ATS unit it happened in, or null when it could not be resolved. */
  sector: string | null;
  /** Was an instruction applied to it. */
  resolved: boolean;
}

/** One aircraft crossing INTO a sector: who, exactly when, and how high. The
 *  aggregated counts cannot give the time back, and the time is the column a
 *  sector study reads first. */
/** One aircraft's position inside a sector during an hour. */
export interface OccupancyPoint {
  flight: string;
  lat: number;
  lon: number;
}

export interface SectorEntry {
  flight: string;
  actype: string;
  timeUtc: string;
  altFt: number;
}

export interface SectorHourRow {
  sector: string;
  layer: string;
  hourUtc: string;
  /** Aircraft ENTERING the sector in this hour, and which they were. */
  entries: number;
  entryFlights: string[];
  /** The same entries un-aggregated, in time order — one per crossing. */
  entryEvents: SectorEntry[];
  /** Aircraft PRESENT in the sector at any point in the hour, and which ones.
   *
   *  Different question from `entries`, and the one a workload or a
   *  sectorisation decision turns on. An aircraft that crossed in at 0055 and
   *  is still there at 0130 is work for the 0100 hour, but it entered in the
   *  0000 hour and `entries` counts it there and nowhere else. A sector can
   *  read 0 entries and still be full of traffic. */
  occupancy: number;
  occupancyFlights: string[];
  /** Where each of those aircraft sat inside the sector — the midpoint of its
   *  stay. Only a re-cut of the airspace needs this (see ./dynamicArea): to
   *  decide which slice of a sector to hand to a neighbour you have to know
   *  which end of it the traffic is at, and a count cannot say. */
  occupancyPoints: OccupancyPoint[];
  /** Conflicts starting in this sector in this hour, and how many of those had
   *  a resolution applied. `conflictsToSolve` is the workload figure: the
   *  aircraft a controller has to do something about. */
  conflictsTotal: number;
  conflictsResolved: number;
  conflictFlights: string[];
  /** Per aircraft: how many conflicts it was part of in this sector and hour,
   *  and how many of those had a fix applied. A conflict involves two aircraft,
   *  so these sum to twice `conflictsTotal` — they answer "what did THIS
   *  aircraft cost the sector", not "how many conflicts were there". */
  conflictsByFlight: Record<string, { total: number; resolved: number }>;
}

/**
 * Aggregate the flight events and the conflict log into (sector, hour) rows.
 *
 * Entries are counted from SECTOR_ENTRY events, so an aircraft that leaves and
 * re-enters within the hour counts twice — which is the right measure of how
 * often the sector was handed something, though it means `entries` is not the
 * same as "distinct aircraft". `entryFlights` is de-duplicated so both readings
 * are available from the one row.
 */
export function buildSectorHours(
  events: FlightEventRow[],
  conflicts: ReportConflict[] = [],
): SectorHourRow[] {
  const key = (sector: string, hour: string) => sector + "\u0000" + hour;
  const rows = new Map<string, SectorHourRow>();

  const row = (sector: string, layer: string, hourUtc: string): SectorHourRow => {
    const k = key(sector, hourUtc);
    let r = rows.get(k);
    if (!r) {
      r = {
        sector,
        layer,
        hourUtc,
        entries: 0,
        entryFlights: [],
        entryEvents: [],
        occupancy: 0,
        occupancyFlights: [],
        occupancyPoints: [],
        conflictsTotal: 0,
        conflictsResolved: 0,
        conflictFlights: [],
        conflictsByFlight: {},
      };
      rows.set(k, r);
    }
    return r;
  };

  const markPresent = (
    r: SectorHourRow,
    callsign: string,
    at?: { lat: number; lon: number },
  ) => {
    if (r.occupancyFlights.includes(callsign)) return;
    r.occupancyFlights.push(callsign);
    r.occupancy += 1;
    if (at) r.occupancyPoints.push({ flight: callsign, lat: at.lat, lon: at.lon });
  };

  for (const e of events) {
    if (e.event !== "SECTOR_ENTRY" || !e.ident) continue;
    const r = row(e.ident, e.layer, hourBucket(Date.parse(e.timeUtc)));
    r.entries += 1;
    if (!r.entryFlights.includes(e.callsign)) r.entryFlights.push(e.callsign);
    r.entryEvents.push({
      flight: e.callsign,
      actype: e.actype,
      timeUtc: e.timeUtc,
      altFt: e.altFt,
    });
  }

  // Occupancy, from the ENTRY/EXIT pairs the same walk already produced. Each
  // pair is one continuous stay in one sector, so the aircraft belongs to every
  // hour that stay overlaps — including hours it neither entered nor left.
  const stays = new Map<
    string,
    { layer: string; times: { ms: number; open: boolean; lat: number; lon: number }[] }
  >();
  for (const e of events) {
    if (e.event !== "SECTOR_ENTRY" && e.event !== "SECTOR_EXIT") continue;
    if (!e.ident) continue;
    const k = e.flightKey + "\u0000" + e.callsign + "\u0000" + e.ident;
    const st = stays.get(k) ?? { layer: e.layer, times: [] };
    st.times.push({
      ms: Date.parse(e.timeUtc),
      open: e.event === "SECTOR_ENTRY",
      lat: e.latDeg,
      lon: e.lonDeg,
    });
    stays.set(k, st);
  }
  for (const [k, st] of stays) {
    const [, callsign, sector] = k.split("\u0000");
    const times = [...st.times].sort((a, b) => a.ms - b.ms || (a.open ? -1 : 1));
    let openedAt: number | null = null;
    let openedFrom: { lat: number; lon: number } | null = null;
    for (const t of times) {
      if (t.open) {
        // Two entries with no exit between them: keep the first. Re-anchoring
        // would silently drop the stay that was already running.
        if (openedAt === null) {
          openedAt = t.ms;
          openedFrom = { lat: t.lat, lon: t.lon };
        }
        continue;
      }
      if (openedAt === null) continue; // an exit with no entry — nothing to close
      // Halfway between crossing in and crossing out: the best single point for
      // "where in this sector was it", from what the events record.
      const mid =
        openedFrom === null
          ? { lat: t.lat, lon: t.lon }
          : { lat: (openedFrom.lat + t.lat) / 2, lon: (openedFrom.lon + t.lon) / 2 };
      markPresent(row(sector, st.layer, hourBucket(openedAt)), callsign, mid);
      for (
        let h = Date.parse(hourBucket(openedAt)) + HOUR_MS;
        h <= t.ms;
        h += HOUR_MS
      ) {
        markPresent(row(sector, st.layer, hourBucket(h)), callsign, mid);
      }
      openedAt = null;
      openedFrom = null;
    }
    // A stay still open at the end of the run (the flight lands inside the
    // sector, or the sample ends) still occupied it up to that last moment.
    if (openedAt !== null) {
      markPresent(
        row(sector, st.layer, hourBucket(openedAt)),
        callsign,
        openedFrom ?? undefined,
      );
    }
  }

  for (const c of conflicts) {
    if (!c.sector) continue;
    const r = row(c.sector, "", hourBucket(c.startMs));
    r.conflictsTotal += 1;
    if (c.resolved) r.conflictsResolved += 1;
    for (const cs of [c.aCallsign, c.bCallsign]) {
      if (!cs) continue;
      if (!r.conflictFlights.includes(cs)) r.conflictFlights.push(cs);
      const n = r.conflictsByFlight[cs] ?? { total: 0, resolved: 0 };
      n.total += 1;
      if (c.resolved) n.resolved += 1;
      r.conflictsByFlight[cs] = n;
    }
  }

  // The events arrive flight by flight, so a sector's entries are in no
  // particular order until they are put in one.
  for (const r of rows.values()) {
    r.entryEvents.sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));
    r.occupancyFlights.sort();
  }

  return [...rows.values()].sort(
    (a, b) => a.hourUtc.localeCompare(b.hourUtc) || a.sector.localeCompare(b.sector),
  );
}

/** One hour of one sector's day, as the load chart plots it. */
export interface SectorLoadPoint {
  hourUtc: string;
  /** Aircraft present during the hour — the workload measure. */
  present: number;
  /** Aircraft that crossed in during the hour. */
  entries: number;
  conflicts: number;
}

/**
 * One sector's traffic across the whole run, in time order.
 *
 * A projection of the sector-hour table, not a second reading of the events:
 * the chart and the numbers beside it come from the same rows and cannot
 * disagree about how busy an hour was.
 */
export function sectorLoadSeries(
  rows: SectorHourRow[],
  layer: string,
  sector: string,
): SectorLoadPoint[] {
  return rows
    .filter((r) => r.layer === layer && r.sector === sector)
    .sort((a, b) => a.hourUtc.localeCompare(b.hourUtc))
    .map((r) => ({
      hourUtc: r.hourUtc,
      present: r.occupancy,
      entries: r.entries,
      conflicts: r.conflictsTotal,
    }));
}

// --- CSV --------------------------------------------------------------------

/** RFC-4180 field: quote when it holds a comma, quote or newline. */
function csvField(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csv(header: string[], rows: (string | number)[][]): string {
  // BOM so Excel reads UTF-8 (the callsigns and area names are ASCII, but the
  // sector names are not guaranteed to be).
  return (
    "﻿" +
    [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") +
    "\r\n"
  );
}

const FLIGHT_EVENT_HEADER = [
  "flight_key",
  "callsign",
  "aircraft_type",
  "adep",
  "ades",
  "event",
  "ident",
  "layer",
  "description",
  "time_utc",
  "elapsed_s",
  "lat",
  "lon",
  "altitude_ft",
];

/** The flight-event table as a grid — header row first. The CSV and the
 *  workbook are both written from this, so the two containers can never end up
 *  holding different reports. */
export function flightEventsTable(rows: FlightEventRow[]): (string | number)[][] {
  return [
    FLIGHT_EVENT_HEADER,
    ...rows.map((r) => [
      r.flightKey,
      r.callsign,
      r.actype,
      r.adep,
      r.ades,
      r.event,
      r.ident,
      r.layer,
      r.description,
      r.timeUtc,
      r.elapsedSec,
      r.latDeg,
      r.lonDeg,
      r.altFt,
    ]),
  ];
}

export function flightEventsCsv(rows: FlightEventRow[]): string {
  const [head, ...body] = flightEventsTable(rows);
  return csv(head as string[], body);
}

const SECTOR_HOUR_HEADER = [
  "sector",
  "layer",
  "hour_utc",
  "entries",
  "distinct_flights",
  "entry_flights",
  "aircraft_present",
  "conflicts_total",
  "conflicts_resolved",
  "conflict_flights",
];

const sectorHourCells = (r: SectorHourRow): (string | number)[] => [
  r.sector,
  r.layer,
  r.hourUtc,
  r.entries,
  r.entryFlights.length,
  r.entryFlights.join(" "),
  r.occupancy,
  r.conflictsTotal,
  r.conflictsResolved,
  r.conflictFlights.join(" "),
];

export function sectorHoursTable(rows: SectorHourRow[]): (string | number)[][] {
  return [SECTOR_HOUR_HEADER, ...rows.map(sectorHourCells)];
}

export function sectorHoursCsv(rows: SectorHourRow[]): string {
  return csv(SECTOR_HOUR_HEADER, rows.map(sectorHourCells));
}

/**
 * The selected hour, one row per aircraft.
 *
 * The panel asks about a single cell of the table — this sector, this hour —
 * so the file is that cell, opened out: instead of one summary row with the
 * callsigns squeezed into a cell, every aircraft gets its own line saying when
 * it crossed in, at what level, and what it cost the controller. That is the
 * shape a spreadsheet can sort, filter and pivot.
 *
 * The `hour_*` columns are the hour's own totals, repeated on every line so the
 * file stands on its own. They are named apart from the per-flight columns
 * because they must not be summed down the sheet: a conflict involves two
 * aircraft and is one event, not two.
 */
const SECTOR_HOUR_FLIGHT_HEADER = [
  "sector",
  "layer",
  "hour_utc",
  "flight",
  "aircraft_type",
  "entry_time_utc",
  "entry_hhmm",
  "entry_level_ft",
  "entered_sector",
  "in_conflict",
  "conflicts",
  "conflicts_resolved",
  "hour_conflicts_total",
  "hour_conflicts_resolved",
];

/** "2025-12-23T00:05:12Z" -> "00:05". The full timestamp is kept in its own
 *  column; this one is for reading, and is what a strip chart is labelled by. */
function hhmmUtc(timeUtc: string): string {
  const ms = Date.parse(timeUtc);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : "";
}

export function sectorHourCsv(row: SectorHourRow): string {
  const conf = (f: string) => row.conflictsByFlight[f] ?? { total: 0, resolved: 0 };
  const tail = [row.conflictsTotal, row.conflictsResolved];

  const lines: (string | number)[][] = row.entryEvents.map((e) => {
    const c = conf(e.flight);
    return [
      row.sector,
      row.layer,
      row.hourUtc,
      e.flight,
      e.actype,
      e.timeUtc,
      hhmmUtc(e.timeUtc),
      Math.round(e.altFt),
      "yes",
      c.total > 0 ? "yes" : "no",
      c.total,
      c.resolved,
      ...tail,
    ];
  });

  // An aircraft in conflict here that never crossed in during this hour was
  // already inside when the hour began. Leaving it out would under-report the
  // sector's workload, so it gets a line with no entry time.
  const entered = new Set(row.entryEvents.map((e) => e.flight));
  for (const f of row.conflictFlights) {
    if (entered.has(f)) continue;
    const c = conf(f);
    lines.push([
      row.sector,
      row.layer,
      row.hourUtc,
      f,
      "",
      "",
      "",
      "",
      "no",
      "yes",
      c.total,
      c.resolved,
      ...tail,
    ]);
  }

  return csv(SECTOR_HOUR_FLIGHT_HEADER, lines);
}
