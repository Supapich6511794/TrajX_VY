import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { buildLosMarks } from "./losMarks";
import {
  losWindows,
  scanFlightPlanConflicts,
  type PlanFlight,
} from "./planScan";
import { toSamples, totalSeconds } from "@/lib/useSimPlayback";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";

const cfg = resolveConfig();
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A straight, level cruise leg — same shape as the plan-advisory fixtures. */
function leg(
  id: string,
  lat: number,
  lon0: number,
  trackDeg: number,
  altFt = 35000,
  n = 600,
  gs = 450,
): TrajectoryResult {
  const dt = 4;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  const east = Math.sin((trackDeg * Math.PI) / 180);
  const points: TrajectoryPoint[] = [];
  for (let i = 0; i < n; i++) {
    const nm = (gs * i * dt) / 3600;
    points.push({
      lat,
      lon: lon0 + (nm * east) / nmPerDegLon,
      epoch_ts: new Date(T0 + i * dt * 1000).toISOString(),
      altitude_ft: altFt,
      gs_kt: gs,
      tas_kt: gs,
      track_deg: trackDeg,
      phase: "cruise",
    });
  }
  const last = points[points.length - 1];
  return {
    route: [{ ident: "WPT1", lat, lon: last.lon }],
    points,
    stats: {
      waypointCount: 1,
      pointCount: n,
      distanceNm: 100,
      timeMinutes: (n * dt) / 60,
      cruiseAltFt: altFt,
      rflFt: altFt,
    },
    profile: { toc: null, tod: null },
    validation: null,
    meta: {
      flightKey: id,
      callsign: id,
      aircraftType: "B738",
      adep: "AAAA",
      ades: "BBBB",
      eobtIso: new Date(T0).toISOString(),
    },
  };
}

function planFlight(t: TrajectoryResult): PlanFlight {
  return {
    id: t.meta.flightKey,
    callsign: t.meta.callsign,
    samples: toSamples(t.points),
    offsetSec: 0,
    durationSec: totalSeconds(t.points),
  };
}

/** Head-on pair at the same level — a guaranteed loss of separation. */
function headOn(): PlanFlight[] {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  return [
    planFlight(leg("UBA1", lat, 100, 90)),
    planFlight(leg("KMV2", lat, 100 + 60 / nmPerDegLon, 270)),
  ];
}

/** The same pair 2000 ft apart — they cross, but never lose separation. */
function verticallySeparated(): PlanFlight[] {
  const lat = 13;
  const nmPerDegLon = Math.cos((lat * Math.PI) / 180) * 60;
  return [
    planFlight(leg("UBA1", lat, 100, 90, 35000)),
    planFlight(leg("KMV2", lat, 100 + 60 / nmPerDegLon, 270, 37000)),
  ];
}

describe("losWindows", () => {
  it("brackets the stretch a head-on pair is below minima", () => {
    const [a, b] = headOn();
    const windows = losWindows(a, b, cfg);
    expect(windows).toHaveLength(1);
    const w = windows[0];
    expect(w.endAbsSec).toBeGreaterThan(w.startAbsSec);
    // Tightest gap inside the window is below the minimum it reports.
    expect(w.minHNm).toBeLessThan(w.shNm);
    expect(w.minVFt).toBeLessThan(w.svFt);
    // The window must contain the CPA the strategic scan reports.
    const [c] = scanFlightPlanConflicts([a, b], cfg);
    expect(c.definite).toBe(true);
    expect(w.startAbsSec).toBeLessThanOrEqual(c.tCpaAbsSec);
    expect(w.endAbsSec).toBeGreaterThanOrEqual(c.tCpaAbsSec);
  });

  it("reports nothing when the pair is vertically separated", () => {
    const [a, b] = verticallySeparated();
    expect(losWindows(a, b, cfg)).toEqual([]);
  });
});

describe("buildLosMarks", () => {
  it("gives BOTH aircraft the window, naming the other one", () => {
    const flights = headOn();
    const conflicts = scanFlightPlanConflicts(flights, cfg);
    const marks = buildLosMarks(
      flights.map((f) => f.id),
      flights,
      conflicts,
      cfg,
      T0,
    );
    expect(marks.map((m) => m.flight_key)).toEqual(["UBA1", "KMV2"]);
    const [a, b] = marks;
    expect(a.spans[0].with_callsign).toBe("KMV2");
    expect(b.spans[0].with_callsign).toBe("UBA1");
    // Same window, expressed as UTC timestamps on the export's format.
    expect(a.spans[0].start_ts).toBe(b.spans[0].start_ts);
    expect(a.spans[0].start_ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(new Date(a.spans[0].end_ts).getTime()).toBeGreaterThan(
      new Date(a.spans[0].start_ts).getTime(),
    );
    expect(a.spans[0].min_sep_nm).toBeLessThan(a.spans[0].sep_min_nm);
  });

  it("returns an empty span list for a flight with no conflict left", () => {
    const flights = headOn();
    // Nothing unresolved (the fix was applied) -> the marks must CLEAR, not
    // just be omitted, or a stale export keeps accusing the flight.
    const marks = buildLosMarks(flights.map((f) => f.id), flights, [], cfg, T0);
    expect(marks).toEqual([
      { flight_key: "UBA1", spans: [] },
      { flight_key: "KMV2", spans: [] },
    ]);
  });

  it("only marks the flights being exported", () => {
    const flights = headOn();
    const conflicts = scanFlightPlanConflicts(flights, cfg);
    const marks = buildLosMarks(["UBA1"], flights, conflicts, cfg, T0);
    expect(marks).toHaveLength(1);
    expect(marks[0].spans[0].with_callsign).toBe("KMV2");
  });
});
