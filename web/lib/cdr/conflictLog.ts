/**
 * The conflict log — what happened, to whom, and what was done about it.
 *
 * Every other CD&R view answers "what is wrong NOW": the notification stack
 * clears as conflicts pass, and the dashboard re-scans so a fixed pair simply
 * disappears from it. Nothing keeps the record, and the record is what a
 * fast-time study is for — one line per encounter, readable after the run:
 *
 *   02:14:20–02:16:05Z  UBA100 x MMA122  crossing 68°  2.1 NM / 0 ft
 *   resolved 02:06:30Z — MMA122 reduce 20 kt (speed)
 *
 * So this accumulates. An entry is created the first time a pair is seen in
 * conflict and is never dropped again: when the pair is fixed the entry gains
 * the instruction that fixed it, and when it vanishes for any other reason
 * (another aircraft's re-time moved it out of the way) it is closed as cleared
 * rather than quietly deleted.
 *
 * Pure and UI-free: given the live scan, the applied fixes and the flights, it
 * returns the next state of the log. The panel only renders it.
 */

import { aircraftAt } from "@/lib/useSimPlayback";

import type { CdrConfig } from "./config";
import { losWindows, type PlanConflict, type PlanFlight } from "./planScan";
import type { AppliedFix } from "./types";

/** How the two tracks meet — the shape of the encounter, which is what a
 *  controller names traffic by. */
export type ConflictGeometry = "head-on" | "crossing" | "in-trail" | "unknown";

/** Which engine found it. The two are found at different times: one from the
 *  flown 4D paths, one from the filed plans before anything moves. */
export type ConflictSource = "enroute" | "departure";

/**
 * What became of the encounter.
 *
 * `advisory` is the one that matters for reading the log against the
 * dashboard: a pair that came inside the ADVISORY BUFFER but never lost
 * minima. Nothing was issued for it and nothing needed to be — the standard
 * was kept. Counting those as "unresolved" put a red line in the log for
 * encounters the dashboard rightly reported as zero losses of separation.
 */
export type ConflictOutcome =
  | "unresolved"
  | "advisory"
  | "resolved"
  | "cleared";

export interface ConflictLogEntry {
  /** Pair id — the same one the dashboard and the applied fixes use. */
  id: string;
  source: ConflictSource;
  /** The pair, as flight keys and as callsigns. */
  a: string;
  b: string;
  aCallsign: string;
  bCallsign: string;
  /** The encounter window on the shared clock (s). `fromSec`/`toSec` bracket
   *  the loss of separation itself; a pair that only breaches the advisory
   *  buffer has both collapse onto the CPA. */
  fromSec: number;
  toSec: number;
  tCpaSec: number;
  /** Tightest gap reached, and the minima that governed it. */
  minHNm: number;
  minVFt: number;
  shNm: number;
  svFt: number;
  geometry: ConflictGeometry;
  /** Track difference at the CPA (deg), when both tracks are known. */
  crossingDeg: number | null;
  /** True for a real loss of separation, false for a sub-buffer pass. */
  definite: boolean;
  outcome: ConflictOutcome;
  /** How it was resolved — set once an applied fix names this pair. */
  resolution?: {
    /** Flight that was instructed, and what it was told. */
    target: string;
    targetCallsign: string;
    instruction: string;
    maneuver?: string;
    /** Sim second the instruction was issued. */
    atSec: number;
    /** Horizontal separation at CPA before -> after (NM), when recorded. */
    beforeNm?: number;
    afterNm?: number;
    /** ATS unit it was issued in. */
    sector?: string;
  };
  /** Sim second the entry was first recorded, and when it closed. */
  seenAtSec: number;
  closedAtSec?: number;
}

/** Smallest angle between two tracks (deg, 0-180). */
function trackDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The shape of the encounter, from the two tracks at the closest point.
 *
 * The thresholds are the ones controllers describe traffic by: nearly the same
 * heading is one aircraft catching another, nearly opposite is head-on, and
 * everything between is a crossing.
 */
export function geometryOf(crossingDeg: number | null): ConflictGeometry {
  if (crossingDeg == null) return "unknown";
  if (crossingDeg < 45) return "in-trail";
  if (crossingDeg > 135) return "head-on";
  return "crossing";
}

/** Track difference at the CPA, or null when either aircraft has no state
 *  there (a pair whose flights have since been re-timed apart). */
function crossingAt(
  A: PlanFlight | undefined,
  B: PlanFlight | undefined,
  tCpaSec: number,
): number | null {
  if (!A || !B) return null;
  const a = aircraftAt(A.samples, tCpaSec - A.offsetSec);
  const b = aircraftAt(B.samples, tCpaSec - B.offsetSec);
  if (!a || !b) return null;
  return trackDiff(a.track, b.track);
}

/** One log entry from a live conflict. */
function entryFrom(
  c: PlanConflict,
  flights: Map<string, PlanFlight>,
  cfg: CdrConfig,
  seenAtSec: number,
): ConflictLogEntry {
  const A = flights.get(c.a);
  const B = flights.get(c.b);
  // The window minima are actually breached in — the same walk the exported
  // conflict marks use, so the log and the downloaded file tell one story.
  // A real loss walks the hard minima; a sub-buffer pass walks the advisory
  // ones, which is the only window it has. Either way both numbers below come
  // from INSIDE one window, so they describe a moment that actually happened.
  const windows = A && B ? losWindows(A, B, cfg, 5, { buffered: !c.definite }) : [];
  const first = windows[0];
  const last = windows[windows.length - 1];
  const crossingDeg = crossingAt(A, B, c.tCpaAbsSec);
  return {
    id: c.id,
    source: "enroute",
    a: c.a,
    b: c.b,
    aCallsign: c.aCallsign,
    bCallsign: c.bCallsign,
    fromSec: first ? first.startAbsSec : c.tCpaAbsSec,
    toSec: last ? last.endAbsSec : c.tCpaAbsSec,
    tCpaSec: c.tCpaAbsSec,
    minHNm: first ? Math.min(...windows.map((w) => w.minHNm)) : c.dCpaNm,
    minVFt: first ? Math.min(...windows.map((w) => w.minVFt)) : c.vSepAtCpaFt,
    shNm: c.shNm,
    svFt: c.svFt,
    geometry: geometryOf(crossingDeg),
    crossingDeg,
    definite: c.definite,
    outcome: c.definite ? "unresolved" : "advisory",
    seenAtSec,
  };
}

export interface ConflictLogInput {
  /** The live scan — every conflict the plans still produce. */
  conflicts: PlanConflict[];
  /** Flights by id, for the encounter window and the crossing angle. */
  flights: Map<string, PlanFlight>;
  appliedFixes: AppliedFix[];
  cfg: CdrConfig;
  /** Sim clock now (s), stamped onto whatever changes this pass. */
  nowSec: number;
}

/**
 * Fold the current picture into the log.
 *
 * Additive by design: entries are only ever created or closed, never removed,
 * because the log is the record of the run. Returns the SAME array when nothing
 * changed, so React can skip the re-render.
 */
export function updateConflictLog(
  prev: ConflictLogEntry[],
  input: ConflictLogInput,
): ConflictLogEntry[] {
  const { conflicts, flights, appliedFixes, cfg, nowSec } = input;
  const byId = new Map(prev.map((e) => [e.id, e]));
  const live = new Set(conflicts.map((c) => c.id));
  let changed = false;

  // 1. Anything currently in conflict is on the log, and while it is still open
  //    its window is kept current — a fix upstream can move it.
  for (const c of conflicts) {
    const was = byId.get(c.id);
    if (!was) {
      byId.set(c.id, entryFrom(c, flights, cfg, nowSec));
      changed = true;
      continue;
    }
    if (was.outcome === "resolved") continue;
    const fresh = entryFrom(c, flights, cfg, was.seenAtSec);
    if (
      was.outcome !== fresh.outcome ||
      fresh.fromSec !== was.fromSec ||
      fresh.toSec !== was.toSec ||
      fresh.minHNm !== was.minHNm
    ) {
      byId.set(c.id, fresh);
      changed = true;
    }
  }

  // 2. An applied fix names the pair it was issued for: that is the "solved by".
  for (const f of appliedFixes) {
    const was = byId.get(f.conflictId);
    if (was?.outcome === "resolved") continue;
    const resolution = {
      target: f.target,
      targetCallsign: f.targetCallsign ?? f.target,
      instruction: f.instruction,
      maneuver: f.maneuverType,
      atSec: f.appliedAtSec,
      beforeNm: f.beforeSepNm,
      afterNm: f.afterSepNm,
      sector: f.sector,
    };
    if (was) {
      byId.set(f.conflictId, {
        ...was,
        outcome: "resolved",
        resolution,
        closedAtSec: f.appliedAtSec,
      });
    } else {
      // Fixed before the log ever saw it — auto-resolve can outrun a scan.
      byId.set(f.conflictId, {
        id: f.conflictId,
        source: "enroute",
        a: f.a,
        b: f.b,
        aCallsign: f.targetCallsign ?? f.a,
        bCallsign: f.b,
        fromSec: f.appliedAtSec,
        toSec: f.appliedAtSec,
        tCpaSec: f.appliedAtSec,
        minHNm: f.beforeSepNm ?? 0,
        minVFt: f.beforeVertFt ?? 0,
        shNm: 0,
        svFt: 0,
        geometry: "unknown",
        crossingDeg: null,
        definite: true,
        outcome: "resolved",
        resolution,
        seenAtSec: f.appliedAtSec,
        closedAtSec: f.appliedAtSec,
      });
    }
    changed = true;
  }

  // 3. Gone from the scan with no fix of its own — some other aircraft's
  //    re-time took it away. Recorded as cleared, not deleted: it happened.
  for (const e of byId.values()) {
    if ((e.outcome === "unresolved" || e.outcome === "advisory") && !live.has(e.id)) {
      byId.set(e.id, { ...e, outcome: "cleared", closedAtSec: nowSec });
      changed = true;
    }
  }

  if (!changed) return prev;
  // Still open first, then in the order the encounters happen.
  return [...byId.values()].sort((x, y) => {
    // Still needing an answer first, then the advisories, then the history.
    const rank = (e: ConflictLogEntry) =>
      e.outcome === "unresolved" ? 0 : e.outcome === "advisory" ? 1 : 2;
    return rank(x) - rank(y) || x.fromSec - y.fromSec;
  });
}

/** Counts for the tab badge and the panel header. */
export function conflictLogCounts(log: ConflictLogEntry[]): {
  total: number;
  unresolved: number;
  advisory: number;
  resolved: number;
  cleared: number;
} {
  let unresolved = 0;
  let advisory = 0;
  let resolved = 0;
  let cleared = 0;
  for (const e of log) {
    if (e.outcome === "unresolved") unresolved++;
    else if (e.outcome === "advisory") advisory++;
    else if (e.outcome === "resolved") resolved++;
    else cleared++;
  }
  // `unresolved` counts only real losses of separation left unactioned, which
  // is exactly what the dashboard's "Loss of separation" list holds.
  return { total: log.length, unresolved, advisory, resolved, cleared };
}

/**
 * One entry as a single line of text — what a report or a paste into a
 * spreadsheet carries, and what the panel's copy button hands over.
 */
export function formatLogLine(
  e: ConflictLogEntry,
  utc: (sec: number) => string,
): string {
  const when =
    e.fromSec === e.toSec
      ? utc(e.tCpaSec)
      : `${utc(e.fromSec)}-${utc(e.toSec)}`;
  const angle = e.crossingDeg != null ? ` ${Math.round(e.crossingDeg)} deg` : "";
  const what =
    `${e.geometry}${angle} · ${e.minHNm.toFixed(1)} NM / ` +
    `${Math.round(e.minVFt)} ft (minima ${e.shNm} NM / ${Math.round(e.svFt)} ft)`;
  const how =
    e.outcome === "resolved" && e.resolution
      ? `resolved ${utc(e.resolution.atSec)} — ${e.resolution.instruction}`
      : e.outcome === "cleared"
        ? "cleared by another change"
        : e.outcome === "advisory"
          ? "advisory only — minima kept"
          : "UNRESOLVED";
  return `${when}  ${e.aCallsign} x ${e.bCallsign}  ${what}  ${how}`;
}

// --- Taking the log out of the browser -------------------------------------
// A fast-time run is written up afterwards, and the two things a write-up
// wants are different: a Word REPORT to read and hand in (built next door in
// `conflictLogDocx`), and a CSV to count in a spreadsheet — this one. Both are
// built from the whole log, never the filtered view: the record of a run is
// not the tab that happened to be open. Pure; the panel only saves the result.

/** One CSV field, quoted only when it has to be (RFC 4180). */
function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Column order of the CSV — times first, then the pair, then the encounter,
 *  then what was done about it. */
const CSV_HEADER = [
  "from_utc",
  "to_utc",
  "cpa_utc",
  "from_sec",
  "to_sec",
  "cpa_sec",
  "callsign_a",
  "callsign_b",
  "source",
  "geometry",
  "crossing_deg",
  "min_h_nm",
  "min_v_ft",
  "min_h_required_nm",
  "min_v_required_ft",
  "severity",
  "outcome",
  "resolved_utc",
  "target_callsign",
  "instruction",
  "maneuver",
  "sep_before_nm",
  "sep_after_nm",
  "sector",
  "pair_id",
] as const;

/**
 * The log as CSV — one row per encounter, every field the panel shows.
 *
 * `severity` is the distinction the counts turn on and the one a reader of
 * the numbers alone would otherwise miss: `loss` breached the minima, `buffer`
 * only came inside the advisory buffer with the standard kept.
 */
export function conflictLogCsv(
  log: ConflictLogEntry[],
  utc: (sec: number) => string,
): string {
  const rows = log.map((e) =>
    [
      utc(e.fromSec),
      utc(e.toSec),
      utc(e.tCpaSec),
      Math.round(e.fromSec),
      Math.round(e.toSec),
      Math.round(e.tCpaSec),
      e.aCallsign,
      e.bCallsign,
      e.source,
      e.geometry,
      e.crossingDeg != null ? Math.round(e.crossingDeg) : "",
      e.minHNm.toFixed(2),
      Math.round(e.minVFt),
      e.shNm,
      Math.round(e.svFt),
      e.definite ? "loss" : "buffer",
      e.outcome,
      e.resolution ? utc(e.resolution.atSec) : "",
      e.resolution?.targetCallsign ?? "",
      e.resolution?.instruction ?? "",
      e.resolution?.maneuver ?? "",
      e.resolution?.beforeNm != null ? e.resolution.beforeNm.toFixed(2) : "",
      e.resolution?.afterNm != null ? e.resolution.afterNm.toFixed(2) : "",
      e.resolution?.sector ?? "",
      e.id,
    ]
      .map(csvCell)
      .join(","),
  );
  // Trailing newline: a file that ends mid-line trips some spreadsheet imports.
  return [CSV_HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}
