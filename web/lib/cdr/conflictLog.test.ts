/**
 * The conflict log is the record of a run, so what it must guarantee is that
 * nothing falls out of it: a pair that appears is kept, a pair that is fixed
 * keeps the instruction that fixed it, and a pair that quietly stops being a
 * conflict is closed rather than deleted.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import {
  conflictLogCounts,
  conflictLogCsv,
  formatLogLine,
  geometryOf,
  updateConflictLog,
  type ConflictLogEntry,
} from "./conflictLog";
import type { PlanConflict, PlanFlight } from "./planScan";
import type { AppliedFix } from "./types";

const cfg = resolveConfig();

/** A straight leg on a given track, so the log can read a crossing angle. */
function flight(id: string, trackDeg: number, lat = 13, lon = 100): PlanFlight {
  const rad = (trackDeg * Math.PI) / 180;
  return {
    id,
    callsign: id,
    offsetSec: 0,
    durationSec: 1800,
    samples: Array.from({ length: 121 }, (_, k) => ({
      t: k * 15,
      lat: lat + Math.cos(rad) * k * 0.01,
      lon: lon + Math.sin(rad) * k * 0.01,
      altitudeFt: 35000,
      gsKt: 450,
      tasKt: 450,
      track: trackDeg,
      phase: "cruise" as const,
    })),
  };
}

function conflict(over: Partial<PlanConflict> = {}): PlanConflict {
  return {
    id: "A|B",
    a: "A",
    b: "B",
    aCallsign: "UBA100",
    bCallsign: "MMA122",
    losStartAbsSec: 600,
    tCpaAbsSec: 660,
    dCpaNm: 2.1,
    vSepAtCpaFt: 0,
    shNm: 5,
    svFt: 1000,
    definite: true,
    ...over,
  };
}

const flights = new Map([
  ["A", flight("A", 0)],
  ["B", flight("B", 68)],
]);

function fold(
  prev: ConflictLogEntry[],
  conflicts: PlanConflict[],
  appliedFixes: AppliedFix[] = [],
  nowSec = 0,
) {
  return updateConflictLog(prev, {
    conflicts,
    flights,
    appliedFixes,
    cfg,
    nowSec,
  });
}

const FIX: AppliedFix = {
  conflictId: "A|B",
  a: "A",
  b: "B",
  target: "B",
  targetCallsign: "MMA122",
  instruction: "Reduce 20 kt",
  appliedAtSec: 300,
  maneuverType: "speed",
  beforeSepNm: 2.1,
  afterSepNm: 6.4,
  sector: "MINGALADON CTR",
};

describe("geometryOf", () => {
  it("names the encounter the way traffic is called", () => {
    expect(geometryOf(10)).toBe("in-trail");
    expect(geometryOf(68)).toBe("crossing");
    expect(geometryOf(170)).toBe("head-on");
    expect(geometryOf(null)).toBe("unknown");
  });
});

describe("updateConflictLog", () => {
  it("records a new conflict with its window, geometry and minima", () => {
    const log = fold([], [conflict()]);
    expect(log).toHaveLength(1);
    const e = log[0];
    expect(e.aCallsign).toBe("UBA100");
    expect(e.bCallsign).toBe("MMA122");
    expect(e.outcome).toBe("unresolved");
    expect(e.geometry).toBe("crossing");
    expect(Math.round(e.crossingDeg ?? 0)).toBe(68);
    expect(e.shNm).toBe(5);
    // The window is WALKED from the flights, not taken from the record: it is
    // a real stretch of time, and the gap inside it really is below minima.
    expect(e.fromSec).toBeLessThan(e.toSec);
    expect(e.minHNm).toBeLessThan(e.shNm);
    expect(e.minVFt).toBeLessThan(e.svFt);
  });

  it("logs a sub-buffer pass as an ADVISORY, not as unresolved", () => {
    // This is the pair the dashboard reports as zero losses of separation: it
    // came inside the advisory buffer and never broke minima. Calling it
    // unresolved put a red line in the log for an encounter that needed no
    // action at all.
    const log = fold([], [conflict({ definite: false, losStartAbsSec: null })]);
    expect(log[0].outcome).toBe("advisory");
    expect(log[0].definite).toBe(false);
    expect(conflictLogCounts(log)).toMatchObject({
      total: 1,
      unresolved: 0, // matches the dashboard's "Loss of separation (0)"
      advisory: 1,
    });
    expect(formatLogLine(log[0], (sec) => String(sec))).toContain(
      "advisory only",
    );
  });

  it("reports a sub-buffer pass from the window, not from the bare CPA", () => {
    // The CPA is the closest HORIZONTAL moment, and the vertical gap there can
    // be enormous: 0.1 NM read next to 13 000 ft describes an encounter that
    // never happened. Both numbers have to come from inside one window.
    const [e] = fold([], [conflict({ definite: false, losStartAbsSec: null })]);
    expect(e.fromSec).toBeLessThan(e.toSec);
    // Inside the buffered window the pair really is within the advisory
    // envelope in BOTH dimensions.
    expect(e.minHNm).toBeLessThan(e.shNm + cfg.buffer.horizontalNm);
    expect(e.minVFt).toBeLessThan(e.svFt + cfg.buffer.verticalFt);
  });

  it("keeps the same entry while the conflict stays open", () => {
    const first = fold([], [conflict()]);
    const again = fold(first, [conflict()]);
    expect(again).toBe(first); // unchanged -> same array, no re-render
  });

  it("marks it resolved, with the instruction that did it", () => {
    const open = fold([], [conflict()]);
    // A fix removes it from the live scan AND names it in appliedFixes.
    const log = fold(open, [], [FIX], 400);
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe("resolved");
    expect(log[0].resolution).toMatchObject({
      targetCallsign: "MMA122",
      instruction: "Reduce 20 kt",
      maneuver: "speed",
      atSec: 300,
      beforeNm: 2.1,
      afterNm: 6.4,
      sector: "MINGALADON CTR",
    });
    expect(log[0].closedAtSec).toBe(300);
  });

  it("never loses a resolved entry to a later scan", () => {
    let log = fold([], [conflict()]);
    log = fold(log, [], [FIX], 400);
    log = fold(log, [], [FIX], 900); // many ticks later
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe("resolved");
  });

  it("closes a conflict that went away on its own as CLEARED", () => {
    // Fixing someone else re-times traffic and a pair stops meeting. It was
    // real and it is kept — but nothing was issued for it, and the log says so.
    const open = fold([], [conflict()]);
    const log = fold(open, [], [], 500);
    expect(log[0].outcome).toBe("cleared");
    expect(log[0].closedAtSec).toBe(500);
    expect(log[0].resolution).toBeUndefined();
  });

  it("logs a fix applied before the scan ever saw the pair", () => {
    // Auto-resolve can outrun a scan; the record still has to exist.
    const log = fold([], [], [FIX], 300);
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe("resolved");
    expect(log[0].resolution?.instruction).toBe("Reduce 20 kt");
  });

  it("accumulates across many encounters, open ones first", () => {
    // Pairs whose flights are not in the map: the window falls back to the
    // record's own CPA, which keeps this test about ORDER and nothing else.
    const c1 = conflict({
      id: "E|F",
      a: "E",
      b: "F",
      tCpaAbsSec: 900,
      losStartAbsSec: 880,
    });
    const c2 = conflict({
      id: "C|D",
      a: "C",
      b: "D",
      aCallsign: "SIA1",
      bCallsign: "KMV2",
      tCpaAbsSec: 300,
      losStartAbsSec: 280,
    });
    let log = fold([], [c1, c2]);
    expect(log.map((e) => e.id)).toEqual(["C|D", "E|F"]); // by time
    log = fold(log, [c1], [{ ...FIX, conflictId: "C|D" }], 400);
    // The resolved one drops below the still-open one.
    expect(log.map((e) => e.outcome)).toEqual(["unresolved", "resolved"]);
    expect(conflictLogCounts(log)).toMatchObject({
      total: 2,
      unresolved: 1,
      resolved: 1,
    });
  });
});

describe("formatLogLine", () => {
  const utc = (sec: number) =>
    `${new Date(sec * 1000).toISOString().slice(11, 19)}Z`;

  it("writes the line a report is made of", () => {
    const [open] = fold([], [conflict()]);
    const line = formatLogLine(open, utc);
    expect(line).toContain("UBA100 x MMA122");
    expect(line).toContain("crossing");
    expect(line).toContain("minima 5 NM / 1000 ft");
    expect(line).toContain("UNRESOLVED");
  });

  it("says what resolved it once it is fixed", () => {
    const log = fold(fold([], [conflict()]), [], [FIX], 400);
    expect(formatLogLine(log[0], utc)).toContain("resolved 00:05:00Z — Reduce 20 kt");
  });
});

/**
 * The spreadsheet half of the panel's Download button (the Word report is
 * tested next door in conflictLogDocx.test.ts). What it must guarantee is that
 * the record survives the trip out of the browser: every encounter is in the
 * file, and it stays readable to a spreadsheet whatever the instruction text
 * happens to contain.
 */
describe("conflictLogCsv", () => {
  const utc = (sec: number) =>
    `${new Date(sec * 1000).toISOString().slice(11, 19)}Z`;

  it("writes a header and one row per encounter", () => {
    const log = fold(fold([], [conflict()]), [], [FIX], 400);
    const lines = conflictLogCsv(log, utc).trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("callsign_a,callsign_b");
    expect(lines[1]).toContain("UBA100,MMA122");
    expect(lines[1]).toContain("resolved");
    expect(lines[1]).toContain("Reduce 20 kt");
  });

  it("marks a buffer-only pass apart from a loss of separation", () => {
    const loss = conflictLogCsv(fold([], [conflict()]), utc);
    const pass = conflictLogCsv(fold([], [conflict({ definite: false })]), utc);
    expect(loss).toContain(",loss,");
    expect(pass).toContain(",buffer,");
  });

  it("quotes a field that carries a comma, so the columns do not shift", () => {
    const log = fold(fold([], [conflict()]), [], [
      { ...FIX, instruction: "Turn left 20°, then direct BUNTA" },
    ], 400);
    const row = conflictLogCsv(log, utc).trim().split("\r\n")[1];
    expect(row).toContain('"Turn left 20°, then direct BUNTA"');
    // Header and row still describe the same number of columns.
    const cols = (t: string) => t.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length;
    const [head, body] = conflictLogCsv(log, utc).trim().split("\r\n");
    expect(cols(body)).toBe(cols(head));
  });

  it("is a header on its own when nothing was recorded", () => {
    expect(conflictLogCsv([], utc).trim().split("\r\n")).toHaveLength(1);
  });
});
