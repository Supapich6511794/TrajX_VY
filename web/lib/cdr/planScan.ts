/**
 * Strategic flight-plan conflict scan.
 *
 * The live detector (useCdr) only looks a short window ahead of the current
 * clock — that drives the realtime toast/badge. The Dashboard, by contrast,
 * wants the WHOLE picture: every loss of separation the filed plans will
 * produce, including ones far in the future that haven't alerted yet ("UBA100 &
 * MMA122 will lose separation at 00:24"). Because the trajectories are fully
 * precomputed, we can simply march each pair along its real path across the
 * entire shared timeline once and record where they breach minima.
 *
 * Runs once per trajectory set (memoised in MapApp), not per tick — so it can
 * afford to scan hours of flight time at a modest step. Absolute times are on
 * the same shared "all routes" clock the map uses (seconds from the earliest
 * departure); the Dashboard subtracts the live clock to show a countdown.
 */

import { aircraftAt, type AircraftState } from "@/lib/useSimPlayback";

import {
  sepMinNmForPair,
  verticalMinimumFt,
  type CdrConfig,
} from "./config";
import { frameFor, mag, sub, toEnu, type EnuFrame } from "./geo";

interface Sample extends AircraftState {
  t: number;
}

/** Absolute ceiling on scan iterations per pair — a safety stop so a pathological
 *  overlap (huge/near-infinite duration from a corrupt maneuvered trajectory) can
 *  never spin the main thread and freeze the tab. 500k @ 15 s ≈ 2000 flight-hours,
 *  far beyond any real encounter, so it never bites legitimate scans. */
const MAX_SCAN_STEPS = 500_000;

/** One flight for the scan: its elapsed-time sample table, EOBT offset and
 *  duration on the shared absolute timeline. */
export interface PlanFlight {
  id: string;
  callsign: string;
  samples: Sample[];
  offsetSec: number;
  durationSec: number;
}

/** A conflict found anywhere in the filed plans. */
export interface PlanConflict {
  id: string;
  a: string;
  b: string;
  aCallsign: string;
  bCallsign: string;
  /** Absolute time (s, shared clock) the pair first breaches HARD minima, or
   *  null when it only ever breaches the advisory buffer. */
  losStartAbsSec: number | null;
  /** Absolute time of closest approach and the separations there. */
  tCpaAbsSec: number;
  dCpaNm: number;
  vSepAtCpaFt: number;
  shNm: number;
  svFt: number;
  /** True when hard minima are actually breached (a real loss of separation),
   *  false when only the advisory buffer is (a close, sub-buffer pass). */
  definite: boolean;
}

/** The closest-point-of-approach walk over a pair's shared airborne window —
 *  the cheap first pass (pure geometry, no airspace lookups) every scanner here
 *  starts from. */
interface PairWalk {
  /** Overlap bounds on the shared absolute clock, and the step used. */
  start: number;
  end: number;
  step: number;
  frame: EnuFrame;
  minH: number;
  tCpaAbs: number;
  vAtMinH: number;
  /** Both aircraft states AT the CPA — where the governing minima are read. */
  cpaA: AircraftState;
  cpaB: AircraftState;
}

function walkCpa(A: PlanFlight, B: PlanFlight, stepSec: number): PairWalk | null {
  const start = Math.max(A.offsetSec, B.offsetSec);
  const end = Math.min(A.offsetSec + A.durationSec, B.offsetSec + B.durationSec);
  // Guard the scan bounds: a non-finite duration (e.g. a corrupt timestamp from
  // a maneuvered trajectory) would make `end` Infinity and spin this loop
  // forever — a synchronous tab freeze. A non-positive step would too.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 1) return null;
  const step = stepSec > 0 ? stepSec : 10;

  // A local frame near the pair's positions at the overlap start keeps the
  // planar geometry accurate over the (bounded) encounter.
  const a0 = aircraftAt(A.samples, start - A.offsetSec);
  const b0 = aircraftAt(B.samples, start - B.offsetSec);
  if (!a0 || !b0) return null;
  const frame = frameFor([a0, b0]);

  let minH = Infinity;
  let tCpaAbs = start;
  let vAtMinH = 0;
  let cpaA: AircraftState = a0;
  let cpaB: AircraftState = b0;
  let guard = 0;
  for (let t = start; t <= end; t += step) {
    if (++guard > MAX_SCAN_STEPS) break; // hard stop — never spin the main thread
    const acA = aircraftAt(A.samples, t - A.offsetSec);
    const acB = aircraftAt(B.samples, t - B.offsetSec);
    if (!acA || !acB || acA.altitudeFt == null || acB.altitudeFt == null) continue;
    const h = mag(sub(toEnu(frame, acB.lat, acB.lon), toEnu(frame, acA.lat, acA.lon)));
    if (h < minH) {
      minH = h;
      tCpaAbs = t;
      vAtMinH = Math.abs(acB.altitudeFt - acA.altitudeFt);
      cpaA = acA;
      cpaB = acB;
    }
  }
  return { start, end, step, frame, minH, tCpaAbs, vAtMinH, cpaA, cpaB };
}

/** Minimum horizontal separation (NM) between two flights over their overlapping
 *  airborne window, with the CPA time + vertical gap there. Used by the preview
 *  modal to show the resolved d_CPA live as the user edits a maneuver. Returns
 *  null when they're never airborne together. */
export function pairSeparation(
  A: PlanFlight,
  B: PlanFlight,
  stepSec = 10,
): { minHNm: number; tCpaAbsSec: number; vSepAtCpaFt: number } | null {
  const w = walkCpa(A, B, stepSec);
  if (!w) return null;
  return { minHNm: w.minH, tCpaAbsSec: w.tCpaAbs, vSepAtCpaFt: w.vAtMinH };
}

/** One continuous stretch of the plan where a pair is BELOW the hard minima —
 *  an actual loss of separation, on the shared absolute clock. */
export interface LosWindow {
  /** First and last scanned instant at which minima are breached (s, absolute,
   *  inclusive). A single-sample breach gives start === end. */
  startAbsSec: number;
  endAbsSec: number;
  /** Tightest horizontal / vertical gap reached inside this window. */
  minHNm: number;
  minVFt: number;
  /** The minima that were breached (governing values at the CPA). */
  shNm: number;
  svFt: number;
}

/**
 * Every loss-of-separation window between a pair over the whole plan.
 *
 * `scanPair` only reports the FIRST instant minima are lost (all the Dashboard
 * countdown needs); the exported trajectory files want the full extent, so each
 * sample inside the breach can be flagged with the time it happened. Same
 * criterion as the scan — hard minima only (no advisory buffer), horizontal
 * minimum read once at the CPA — so a pair has windows here exactly when
 * `scanFlightPlanConflicts` calls it `definite`.
 *
 * The step defaults to 5 s (finer than the 15 s Dashboard scan) so a window's
 * edges land close to the exported ~4-5 s track samples.
 */
export function losWindows(
  A: PlanFlight,
  B: PlanFlight,
  cfg: CdrConfig,
  stepSec = 5,
  opts: { buffered?: boolean } = {},
): LosWindow[] {
  const w = walkCpa(A, B, stepSec);
  if (!w) return [];
  // `buffered` widens the test to the ADVISORY thresholds — the same ones
  // `scanPair` uses to decide a pair is worth showing at all. It answers a
  // different question: not "when were minima lost" but "when was this pair
  // close enough to be worth a look", which is the only window a sub-buffer
  // encounter has. Without it such a pair has no window to report and its
  // numbers fall back to the CPA, where the horizontal minimum and the
  // vertical gap need not be from the same instant at all (0.1 NM and 13 000
  // ft, read together, describes an encounter that never happened).
  const hPad = opts.buffered ? cfg.buffer.horizontalNm : 0;
  const vPad = opts.buffered ? cfg.buffer.verticalFt : 0;
  const sh =
    sepMinNmForPair(
      cfg,
      w.cpaA.lat, w.cpaA.lon, w.cpaA.altitudeFt,
      w.cpaB.lat, w.cpaB.lon, w.cpaB.altitudeFt,
    ) + hPad;

  const out: LosWindow[] = [];
  let cur: LosWindow | null = null;
  let guard = 0;
  for (let t = w.start; t <= w.end; t += w.step) {
    if (++guard > MAX_SCAN_STEPS) break;
    const acA = aircraftAt(A.samples, t - A.offsetSec);
    const acB = aircraftAt(B.samples, t - B.offsetSec);
    if (!acA || !acB || acA.altitudeFt == null || acB.altitudeFt == null) continue;
    const h = mag(sub(toEnu(w.frame, acB.lat, acB.lon), toEnu(w.frame, acA.lat, acA.lon)));
    const v = Math.abs(acB.altitudeFt - acA.altitudeFt);
    const sv = verticalMinimumFt(cfg, acA.altitudeFt, acB.altitudeFt) + vPad;
    if (h < sh && v < sv) {
      if (cur == null) {
        cur = { startAbsSec: t, endAbsSec: t, minHNm: h, minVFt: v, shNm: sh, svFt: sv };
        out.push(cur);
      } else {
        cur.endAbsSec = t;
        cur.minHNm = Math.min(cur.minHNm, h);
        cur.minVFt = Math.min(cur.minVFt, v);
      }
    } else {
      cur = null; // separation restored — any further breach is a new window
    }
  }
  return out;
}

/** 3-D conflict check between two flights over the whole plan (horizontal AND
 *  vertical simultaneously), returning the conflict or null. Exported so the
 *  advisory can verify a candidate maneuver clears traffic including level
 *  changes, where horizontal separation alone stays tight. */
export function pairConflict(
  A: PlanFlight,
  B: PlanFlight,
  cfg: CdrConfig,
  stepSec = 15,
): PlanConflict | null {
  return scanPair(A, B, cfg, stepSec);
}

/** The box a whole flight stays inside: its path's extent in lat/lon/altitude
 *  and the window it is airborne. Computed once per flight and cached on the
 *  object, so the pair loop can reject a pair in a few comparisons instead of
 *  walking their shared timeline. */
interface PlanBounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  altMin: number;
  altMax: number;
  t0: number;
  t1: number;
}

/** Keyed on the SAMPLE TABLE, not the PlanFlight: applying a fix rebuilds every
 *  flight's wrapper object even though only one aircraft moved, and a cache
 *  keyed on the wrapper would then miss on all of them and re-walk the whole
 *  day's samples. `toSamples` hands back the same array for an untouched
 *  flight, so this survives. Only the box is cached — the times come from the
 *  wrapper, which is where a re-timing shows up. */
const _boundsCache = new WeakMap<
  Sample[],
  Omit<PlanBounds, "t0" | "t1">
>();

function boundsOf(f: PlanFlight): PlanBounds {
  const box = _boundsCache.get(f.samples);
  if (box) {
    return { ...box, t0: f.offsetSec, t1: f.offsetSec + f.durationSec };
  }
  let latMin = Infinity, latMax = -Infinity;
  let lonMin = Infinity, lonMax = -Infinity;
  let altMin = Infinity, altMax = -Infinity;
  for (const s of f.samples) {
    if (s.lat < latMin) latMin = s.lat;
    if (s.lat > latMax) latMax = s.lat;
    if (s.lon < lonMin) lonMin = s.lon;
    if (s.lon > lonMax) lonMax = s.lon;
    const a = s.altitudeFt;
    if (a != null) {
      if (a < altMin) altMin = a;
      if (a > altMax) altMax = a;
    }
  }
  const fresh = {
    latMin, latMax, lonMin, lonMax,
    altMin: altMin === Infinity ? -Infinity : altMin,
    altMax: altMax === -Infinity ? Infinity : altMax,
  };
  _boundsCache.set(f.samples, fresh);
  return { ...fresh, t0: f.offsetSec, t1: f.offsetSec + f.durationSec };
}

/**
 * Can this pair be dismissed without walking it?
 *
 * Two flights that are never airborne together, or whose paths never come
 * within the minima of each other in ANY of the three dimensions, cannot
 * conflict — and at 2 000 flights that is almost every pair. Checking it costs
 * a handful of comparisons; walking their shared window costs hundreds of
 * interpolations, which is what used to take six seconds and freeze the tab on
 * a whole day of traffic.
 *
 * The boxes are the flown samples' own extent, so this rejects only pairs that
 * genuinely cannot meet — it never hides a conflict the walk would have found.
 */
function cannotMeet(A: PlanFlight, B: PlanFlight, cfg: CdrConfig): boolean {
  const a = boundsOf(A);
  const b = boundsOf(B);
  // Never airborne at the same time.
  if (a.t1 <= b.t0 || b.t1 <= a.t0) return true;

  // Widest minimum either pair could be held to, plus the advisory buffer.
  const sepNm =
    Math.max(cfg.horizontal.enrouteNm, cfg.horizontal.terminalNm) +
    cfg.buffer.horizontalNm;
  const svFt =
    Math.max(cfg.vertical.belowRvsmTopFt, cfg.vertical.aboveRvsmTopFt) +
    cfg.buffer.verticalFt;

  if (a.altMin - b.altMax > svFt || b.altMin - a.altMax > svFt) return true;

  const dLat = sepNm / 60;
  if (a.latMin - b.latMax > dLat || b.latMin - a.latMax > dLat) return true;
  // Longitude degrees shrink with latitude; use the higher-latitude (tighter)
  // conversion so the margin is never under-stated.
  const cosLat = Math.cos(
    (Math.max(Math.abs(a.latMin), Math.abs(b.latMin)) * Math.PI) / 180,
  );
  const dLon = sepNm / (60 * Math.max(cosLat, 0.1));
  if (a.lonMin - b.lonMax > dLon || b.lonMin - a.lonMax > dLon) return true;

  return false;
}

/** Scan one pair over their overlapping airborne window. */
function scanPair(
  A: PlanFlight,
  B: PlanFlight,
  cfg: CdrConfig,
  stepSec: number,
): PlanConflict | null {
  // Pairs that cannot meet at all are rejected before any interpolation.
  if (cannotMeet(A, B, cfg)) return null;
  // Pass 1 (cheap — pure geometry, NO airspace lookups): find the CPA.
  const w = walkCpa(A, B, stepSec > 0 ? stepSec : 15);
  if (!w) return null;
  const { start, end, step, frame, minH, tCpaAbs, vAtMinH, cpaA, cpaB } = w;

  // Position-dependent horizontal minimum, evaluated ONCE at the CPA (where the
  // encounter is tightest — the point the separation standard actually governs).
  // Calling the airspace resolver PER STEP made this O(steps × polygons): inside
  // the advisory's hundreds of candidate re-checks it cost ~10 s per conflict and
  // froze the tab. One lookup per pair here is ~360× cheaper.
  const shAtCpa = sepMinNmForPair(
    cfg,
    cpaA.lat, cpaA.lon, cpaA.altitudeFt,
    cpaB.lat, cpaB.lon, cpaB.altitudeFt,
  );
  const shBuf = shAtCpa + cfg.buffer.horizontalNm;

  // Pass 2 (cheap): breach + first hard loss of separation, using the CPA
  // minimum (sv stays per-step — it's a plain comparison, not a polygon test).
  let losStart: number | null = null;
  let bufferedBreach = false;
  let guard = 0;
  for (let t = start; t <= end; t += step) {
    if (++guard > MAX_SCAN_STEPS) break;
    const acA = aircraftAt(A.samples, t - A.offsetSec);
    const acB = aircraftAt(B.samples, t - B.offsetSec);
    if (!acA || !acB || acA.altitudeFt == null || acB.altitudeFt == null) continue;
    const h = mag(sub(toEnu(frame, acB.lat, acB.lon), toEnu(frame, acA.lat, acA.lon)));
    const v = Math.abs(acB.altitudeFt - acA.altitudeFt);
    const sv = verticalMinimumFt(cfg, acA.altitudeFt, acB.altitudeFt);
    if (h < shBuf && v < sv + cfg.buffer.verticalFt) {
      bufferedBreach = true;
      if (losStart == null && h < shAtCpa && v < sv) losStart = t;
    }
  }

  if (!bufferedBreach) return null;

  const [a, b, aCs, bCs] =
    A.id < B.id
      ? [A.id, B.id, A.callsign, B.callsign]
      : [B.id, A.id, B.callsign, A.callsign];
  // svFt reported at CPA altitudes (governing minimum there).
  const acAcpa = aircraftAt(A.samples, tCpaAbs - A.offsetSec);
  const acBcpa = aircraftAt(B.samples, tCpaAbs - B.offsetSec);
  const svFt =
    acAcpa?.altitudeFt != null && acBcpa?.altitudeFt != null
      ? verticalMinimumFt(cfg, acAcpa.altitudeFt, acBcpa.altitudeFt)
      : cfg.vertical.belowRvsmTopFt;

  return {
    id: `${a}|${b}`,
    a,
    b,
    aCallsign: aCs,
    bCallsign: bCs,
    losStartAbsSec: losStart,
    tCpaAbsSec: tCpaAbs,
    dCpaNm: minH,
    vSepAtCpaFt: vAtMinH,
    shNm: shAtCpa,
    svFt,
    definite: losStart != null,
  };
}

/** Worst first: real losses of separation before sub-buffer passes, then by
 *  whichever happens soonest. */
function sortConflicts(out: PlanConflict[]): PlanConflict[] {
  return out.sort((x, y) => {
    if (x.definite !== y.definite) return x.definite ? -1 : 1;
    const tx = x.losStartAbsSec ?? x.tCpaAbsSec;
    const ty = y.losStartAbsSec ?? y.tCpaAbsSec;
    return tx - ty;
  });
}

/**
 * The scan again after only SOME flights moved.
 *
 * Applying a fix re-times exactly one aircraft, but the scan behind it is over
 * every pair — 1 976 flights is 1.95 million of them, several seconds of
 * arithmetic, and auto-resolve pays it after every single fix it applies. That
 * is what makes a long auto-resolve pass look like a hung tab.
 *
 * Only pairs that TOUCH a changed flight can have changed, so the rest are kept
 * as they were and the walk is `changed x all` — O(n) per fix instead of O(n²).
 * The result is the same list the full scan would have produced.
 */
export function rescanFlightPlanConflicts(
  previous: PlanConflict[],
  flights: PlanFlight[],
  changed: ReadonlySet<string>,
  cfg: CdrConfig,
  stepSec = 15,
): PlanConflict[] {
  if (changed.size === 0) return previous;
  const byId = new Map(flights.map((f) => [f.id, f]));
  // Everything the change cannot have touched, minus any flight that has since
  // left the set entirely.
  const out = previous.filter(
    (c) =>
      !changed.has(c.a) &&
      !changed.has(c.b) &&
      byId.has(c.a) &&
      byId.has(c.b),
  );
  // A pair of two changed flights turns up twice in the walk below; scan it once.
  const scanned = new Set<string>();
  for (const id of changed) {
    const A = byId.get(id);
    if (!A) continue;
    for (const B of flights) {
      if (B.id === A.id) continue;
      const pairId = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
      if (scanned.has(pairId)) continue;
      scanned.add(pairId);
      const c = scanPair(A, B, cfg, stepSec);
      if (c) out.push(c);
    }
  }
  return sortConflicts(out);
}

/**
 * Every conflict in the filed plans, sorted so the ones that lose separation
 * soonest come first (definite losses before sub-buffer passes).
 */
export function scanFlightPlanConflicts(
  flights: PlanFlight[],
  cfg: CdrConfig,
  stepSec = 15,
): PlanConflict[] {
  const out: PlanConflict[] = [];
  for (let i = 0; i < flights.length; i++) {
    for (let j = i + 1; j < flights.length; j++) {
      const c = scanPair(flights[i], flights[j], cfg, stepSec);
      if (c) out.push(c);
    }
  }
  return sortConflicts(out);
}
