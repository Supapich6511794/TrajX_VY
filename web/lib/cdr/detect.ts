/**
 * Conflict detection pass — runs every simulation tick over all airborne
 * traffic.
 *
 * Accuracy comes from using each aircraft's REAL future path (sampled from its
 * precomputed trajectory) rather than extrapolating its current velocity in a
 * straight line. That distinction is the whole point: two aircraft on crossing
 * airways that are each about to turn onto their STAR would look like a
 * head-on to a straight-line predictor, yet never actually lose separation —
 * exactly the false alarms that "cleared without intervention because they were
 * never going to collide" come from. Walking the true future removes them.
 *
 * Between the sampled future points each aircraft is treated as moving linearly,
 * and the closest approach on that segment is solved EXACTLY with the same CPA
 * quadratic used elsewhere (cpa.ts). So the grid step trades turn-fidelity, not
 * correctness on straight legs.
 *
 * Steps: (1) an O(n) bounding-box pre-filter over the window; (2) projection of
 * every future into one shared ENU frame; (3) per-pair, per-segment separation.
 * Pure and deterministic.
 */

import {
  horizontalMinimumNm,
  sepMinNmForPair,
  verticalMinimumFt,
  type CdrConfig,
} from "./config";
import { cpa, horizontalWindow, intersect, verticalWindow, type Interval } from "./cpa";
import { add, frameFor, mag, scale, sub, toEnu, type EnuFrame, type Vec2 } from "./geo";
import {
  SEVERITY_ORDER,
  type CdrAircraft,
  type Conflict,
  type Severity,
} from "./types";

/** A future path projected into the shared ENU frame (positions NM, alt ft),
 *  plus its bounding box over the window for the coarse filter. */
interface ProjTrack {
  ac: CdrAircraft;
  p: Vec2[]; // position per grid index, NM
  alt: number[]; // altitude per grid index, ft
  n: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minAlt: number;
  maxAlt: number;
}

function project(frame: EnuFrame, ac: CdrAircraft): ProjTrack {
  const p: Vec2[] = [];
  const alt: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (const s of ac.future) {
    const v = toEnu(frame, s.lat, s.lon);
    p.push(v);
    alt.push(s.altFt);
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
    if (s.altFt < minAlt) minAlt = s.altFt;
    if (s.altFt > maxAlt) maxAlt = s.altFt;
  }
  return { ac, p, alt, n: p.length, minX, maxX, minY, maxY, minAlt, maxAlt };
}

/** Coarse reject: the two paths' bounding boxes (over the whole window) are
 *  clearly apart, horizontally beyond `shDet` or vertically beyond `svDet`, so
 *  no point-in-time separation can breach. Cheap O(1) per pair. */
function boxesApart(a: ProjTrack, b: ProjTrack, shDet: number, svDet: number): boolean {
  if (a.minX - b.maxX > shDet || b.minX - a.maxX > shDet) return true;
  if (a.minY - b.maxY > shDet || b.minY - a.maxY > shDet) return true;
  if (a.minAlt - b.maxAlt > svDet || b.minAlt - a.maxAlt > svDet) return true;
  return false;
}

/** CPA of a linear relative motion, clamped to the segment [0, dur]. */
function segmentCpa(p: Vec2, v: Vec2, dur: number): { t: number; d: number } {
  const { tCpa } = cpa(p, v);
  const t = Math.max(0, Math.min(dur, tCpa));
  return { t, d: mag(add(p, scale(v, t))) };
}

interface PairScan {
  minH: number; // min horizontal separation over the window (NM) = d_CPA
  tCpa: number; // global time of that minimum (s)
  vSepAtCpa: number; // vertical separation at that time (ft)
  firstBare: number | null; // first time bare minima both breached (s)
  firstBuffered: number | null; // first time buffered minima both breached (s)
}

/**
 * Walk a pair's aligned future grids segment by segment. Within each segment
 * both aircraft move linearly, so relative motion is linear and the CPA + the
 * separation-breach interval are solved exactly (cpa.ts). Accumulates the global
 * minimum-separation (CPA) and the earliest bare/buffered breach times.
 */
function scanPair(
  A: ProjTrack,
  B: ProjTrack,
  cfg: CdrConfig,
  sh: number,
  shBuf: number,
  step: number,
): PairScan {
  const K = Math.min(A.n, B.n);
  const out: PairScan = {
    minH: Infinity,
    tCpa: 0,
    vSepAtCpa: 0,
    firstBare: null,
    firstBuffered: null,
  };

  for (let k = 0; k < K - 1; k++) {
    const t0 = k * step;
    // Linear motion of each aircraft across this segment.
    const vA = scale(sub(A.p[k + 1], A.p[k]), 1 / step);
    const vB = scale(sub(B.p[k + 1], B.p[k]), 1 / step);
    const p = sub(B.p[k], A.p[k]); // relative position at segment start
    const v = sub(vB, vA); // relative velocity
    // Vertical: linear altitude across the segment.
    const vzA = (A.alt[k + 1] - A.alt[k]) / step;
    const vzB = (B.alt[k + 1] - B.alt[k]) / step;
    const dz0 = B.alt[k] - A.alt[k];
    const dvz = vzB - vzA;
    // Vertical minimum from the higher altitude reached in the segment (RVSM).
    const segMaxAlt = Math.max(A.alt[k], A.alt[k + 1], B.alt[k], B.alt[k + 1]);
    const sv = verticalMinimumFt(cfg, segMaxAlt, segMaxAlt);
    const svBuf = sv + cfg.buffer.verticalFt;
    const segBound: Interval = { t0: 0, t1: step };

    // Track the global closest approach.
    const { t, d } = segmentCpa(p, v, step);
    if (d < out.minH) {
      out.minH = d;
      out.tCpa = t0 + t;
      out.vSepAtCpa = Math.abs(dz0 + dvz * t);
    }

    // Earliest bare-minima breach (true loss of separation).
    if (out.firstBare == null) {
      const w = intersect(
        intersect(horizontalWindow(p, v, sh), verticalWindow(dz0, dvz, sv)),
        segBound,
      );
      if (w) out.firstBare = t0 + w.t0;
    }
    // Earliest buffered breach (fires the advisory before the hard minimum).
    if (out.firstBuffered == null) {
      const w = intersect(
        intersect(horizontalWindow(p, v, shBuf), verticalWindow(dz0, dvz, svBuf)),
        segBound,
      );
      if (w) out.firstBuffered = t0 + w.t0;
    }
    // Both earliest-times found and CPA can only be refined marginally further
    // out — but keep scanning for the true global CPA, it's cheap.
  }
  return out;
}

/** Classify one candidate pair from its scan, or null if it isn't a conflict. */
function classifyPair(A: ProjTrack, B: ProjTrack, cfg: CdrConfig): Conflict | null {
  // Position-dependent horizontal minimum: 3 NM if EITHER aircraft is in the
  // tighter-minimum airspace (a TMA in REDUCED_TERMINAL_SEP_TMAS), else 5 NM — taken at the current
  // positions (the pair is within the short realtime look-ahead of the CPA).
  const sh = sepMinNmForPair(
    cfg,
    A.ac.lat, A.ac.lon, A.alt[0],
    B.ac.lat, B.ac.lon, B.alt[0],
  );
  const shBuf = sh + cfg.buffer.horizontalNm;
  const step = cfg.lookahead.stepSec;

  const scan = scanPair(A, B, cfg, sh, shBuf, step);

  // No buffered breach anywhere in the window → not a conflict at all.
  if (scan.firstBuffered == null) return null;
  if (scan.firstBuffered > cfg.lookahead.mtcdSec) return null;

  // Current separation (now) for the LOS-now test + the live readout.
  const hNow = mag(sub(B.p[0], A.p[0]));
  const vNow = Math.abs(B.alt[0] - A.alt[0]);
  const svNow = verticalMinimumFt(cfg, A.alt[0], B.alt[0]);
  const losNow = hNow < sh && vNow < svNow;

  const tTrigger = Math.max(0, scan.firstBuffered);
  let severity: Severity;
  if (losNow) severity = "LOS";
  else if (tTrigger <= cfg.lookahead.stcaSec) severity = "STCA";
  else severity = "MTCD";

  const [a, b] = A.ac.id < B.ac.id ? [A.ac.id, B.ac.id] : [B.ac.id, A.ac.id];
  // Bare-minima window is represented by its first breach time (piecewise);
  // the full interval isn't needed downstream, so carry the entry time.
  const losWindow: Interval | null =
    scan.firstBare != null ? { t0: scan.firstBare, t1: scan.firstBare } : null;

  return {
    id: `${a}|${b}`,
    a,
    b,
    severity,
    tCpa: scan.tCpa,
    dCpa: scan.minH,
    vSepAtCpaFt: scan.vSepAtCpa,
    hSepNowNm: hNow,
    vSepNowFt: vNow,
    tToLosSec: scan.firstBare,
    losWindow,
    shNm: sh,
    svFt: svNow,
    pctOfMinima: (scan.minH / sh) * 100,
  };
}

/**
 * Detect every conflict in a traffic snapshot. Projects all futures into one
 * ENU frame centred on the traffic, coarse-filters pairs by bounding box, then
 * scans the survivors segment by segment. Returns conflicts sorted most-urgent
 * first (LOS → STCA → MTCD, then soonest LoS).
 */
export function detectConflicts(
  aircraft: CdrAircraft[],
  cfg: CdrConfig,
): Conflict[] {
  if (aircraft.length < 2) return [];

  const frame = frameFor(aircraft);
  const proj = aircraft.map((ac) => project(frame, ac));

  // Coarse bbox pre-filter uses the WIDEST possible minimum so it never rejects
  // a pair that classifyPair might flag at a per-position minimum.
  const sh = Math.max(
    cfg.horizontal.enrouteNm,
    cfg.horizontal.terminalNm,
    horizontalMinimumNm(cfg),
  );
  const svMax = Math.max(cfg.vertical.belowRvsmTopFt, cfg.vertical.aboveRvsmTopFt);
  const shDet = sh + cfg.buffer.horizontalNm;
  const svDet = svMax + cfg.buffer.verticalFt;

  const out: Conflict[] = [];
  for (let i = 0; i < proj.length; i++) {
    for (let j = i + 1; j < proj.length; j++) {
      if (proj[i].n < 2 || proj[j].n < 2) continue;
      if (boxesApart(proj[i], proj[j], shDet, svDet)) continue;
      const c = classifyPair(proj[i], proj[j], cfg);
      if (c) out.push(c);
    }
  }
  out.sort(compareConflicts);
  return out;
}

/** Sort key: severity first, then soonest time-to-LoS. */
export function compareConflicts(a: Conflict, b: Conflict): number {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  const ta = a.tToLosSec ?? a.tCpa;
  const tb = b.tToLosSec ?? b.tCpa;
  return ta - tb;
}
