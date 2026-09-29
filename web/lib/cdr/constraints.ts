/**
 * Constraint engine — every candidate maneuver must clear these checks before
 * it can be applied. This is the CD&R "would this clearance actually be legal
 * and safe?" gate, run live in the Preview modal.
 *
 * The checks use only data the app really has, so nothing here is mocked:
 *   • Airspace — the maneuvered path must not newly enter a Prohibited or
 *     Restricted area, and is warned if it enters a Danger area (from the AIP
 *     PDR polygons, altitude-banded).
 *   • Performance — speed inside a sane jet envelope; the 250 kt below FL100 rule.
 *   • Level — a sane altitude band; the semicircular cruising-level rule
 *     (Annex 2 App 3); RVSM note.
 *   • Conflict re-check — the result must stay clear of ALL other traffic by the
 *     buffered minima (computed by the caller and passed in).
 *
 * What we deliberately DON'T claim to check (no data source in-app): terrain /
 * MSA / MEA clearance, SID/STAR procedure protection areas, exact per-type
 * Vmo/Mmo and bank-angle limits. Those are called out as "not evaluated" rather
 * than silently passed. Pure + unit-tested.
 */

import type { Position } from "geojson";

import { parseVyAltFt, pointInMultiPolygon } from "@/lib/airspace";
import { horizontalMinimumNm, type CdrConfig, type ManeuverType } from "./config";
import { respectsSemicircular } from "./advisory";
import type { ManeuverResolution } from "./types";

export type ConstraintStatus = "pass" | "warn" | "fail";

export interface ConstraintCheck {
  category: "Airspace" | "Performance" | "Level" | "Procedure" | "Conflict";
  label: string;
  status: ConstraintStatus;
  detail: string;
  /** Reference/authority for the rule (Doc 4444, AIP, Annex 2…). */
  source?: string;
}

export interface ConstraintReport {
  checks: ConstraintCheck[];
  /** accept = all pass · caution = a warn but no fail · reject = a hard fail. */
  verdict: "accept" | "caution" | "reject";
}

/** A Prohibited / Danger / Restricted area, altitude-banded. */
export interface RestrictedArea {
  ident: string;
  name: string;
  kind: "P" | "D" | "R";
  lowerFt: number;
  upperFt: number;
  mp: Position[][][]; // MultiPolygon rings
}

/** Build the restricted-area list from the AIP PDR sector GeoJSON. */
export function restrictedAreasFrom(
  coll: { features: GeoJSON.Feature[] } | null | undefined,
): RestrictedArea[] {
  if (!coll) return [];
  const out: RestrictedArea[] = [];
  for (const f of coll.features) {
    const g = f.geometry;
    if (!g) continue;
    let mp: Position[][][];
    if (g.type === "MultiPolygon") mp = g.coordinates;
    else if (g.type === "Polygon") mp = [g.coordinates];
    else continue;
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const kindRaw = String(p.type ?? "R").toUpperCase()[0];
    // aixm_vy/restricted_areas.geojson has no combined ident field — build
    // one from type + designator (e.g. "R13"), same as the map's own label.
    const identFromParts = `${p.type ?? ""}${p.designator ?? ""}`.trim();
    out.push({
      ident: identFromParts || String(p.ident ?? p.name ?? "?"),
      name: String(p.name ?? ""),
      kind: kindRaw === "P" || kindRaw === "D" ? kindRaw : "R",
      lowerFt: safeAlt(p.lower ?? p.lowerlimit, 0),
      upperFt: safeAlt(p.upper ?? p.upperlimit, Infinity),
      mp,
    });
  }
  return out;
}

function safeAlt(v: unknown, fallback: number): number {
  const n = parseVyAltFt(v);
  return Number.isFinite(n) || n === Infinity ? n : fallback;
}

/** A point on a trajectory the checks run over. */
export interface PathPoint {
  lat: number;
  lon: number;
  altFt: number;
}

/** The set of restricted-area idents a path passes through (altitude-banded).
 *  Used to tell a maneuver's NEW incursions from areas the filed route already
 *  crosses. */
export function areaIdentsOnPath(
  path: PathPoint[],
  areas: RestrictedArea[],
): Set<string> {
  const hit = new Set<string>();
  for (const pt of path) {
    for (const a of areas) {
      if (hit.has(a.ident)) continue;
      if (
        pt.altFt >= a.lowerFt - 100 &&
        pt.altFt <= a.upperFt + 100 &&
        pointInMultiPolygon(pt.lon, pt.lat, a.mp)
      ) {
        hit.add(a.ident);
      }
    }
  }
  return hit;
}

export interface ConstraintInput {
  maneuverType: ManeuverType;
  resolution: ManeuverResolution;
  cfg: CdrConfig;
  /** The maneuvered path (the differing part is enough; whole is fine). */
  afterPath: PathPoint[];
  /** Restricted areas the ORIGINAL filed route already crosses — entering these
   *  isn't a new violation. */
  originalAreaIdents: Set<string>;
  restricted: RestrictedArea[];
  /** Target's current track (for the semicircular rule) and the resulting
   *  ground speed / level where the maneuver sets them. */
  trackDeg: number;
  newGsKt?: number;
  newAltFt?: number;
  /**
   * Result of re-checking the maneuvered trajectory against ALL other traffic
   * (caller-computed, 3-D so a level change that separates vertically counts as
   * clear even though it stays horizontally close).
   *
   * The two failures are reported SEPARATELY because they are different
   * findings, and calling both "secondary conflict" was simply wrong: the other
   * half of the pair being still in conflict means this maneuver did not do the
   * job it was proposed for, while a THIRD aircraft in conflict means the
   * maneuver would create a new problem. The first is not secondary and not
   * cascading, and there is nothing to "resolve first" about it.
   */
  recheck?: {
    clear: boolean;
    /** Tightest horizontal separation against anything, for the pass message. */
    minSepNm: number;
    /** The conflict this fix is FOR, when the maneuver leaves it unresolved. */
    unresolved?: { callsign?: string; dCpaNm: number };
    /** Traffic other than the pair that the maneuver would newly conflict with.
     *  `alsoCount` is how many further aircraft beyond this one. */
    secondary?: { callsign?: string; dCpaNm: number; alsoCount?: number };
  };
}

// Rough jet envelope — approximate, since exact per-type Vmo/Mmo lives in the
// backend performance model, not the client.
const MIN_GS_KT = 150;
const MAX_GS_KT = 560;

/** Run all constraint checks and produce a verdict. */
export function evaluateConstraints(input: ConstraintInput): ConstraintReport {
  const checks: ConstraintCheck[] = [];
  const {
    cfg,
    afterPath,
    restricted,
    originalAreaIdents,
    trackDeg,
    newGsKt,
    newAltFt,
    recheck,
  } = input;

  // --- Airspace: new incursions into P/D/R areas -------------------------
  const entered = areaIdentsOnPath(afterPath, restricted);
  const newAreas = [...entered]
    .filter((id) => !originalAreaIdents.has(id))
    .map((id) => restricted.find((a) => a.ident === id)!)
    .filter(Boolean);
  if (newAreas.length === 0) {
    checks.push({
      category: "Airspace",
      label: "Clear of prohibited/restricted airspace",
      status: "pass",
      detail: "The maneuver does not newly enter any P/R/D area.",
      source: "AIP ENR 5.1",
    });
  } else {
    for (const a of newAreas) {
      const prohibited = a.kind === "P" || a.kind === "R";
      checks.push({
        category: "Airspace",
        label: `Enters ${a.kind === "P" ? "prohibited" : a.kind === "R" ? "restricted" : "danger"} area ${a.ident}`,
        status: prohibited ? "fail" : "warn",
        detail: `${a.name || a.ident} (${fmtBand(a.lowerFt, a.upperFt)}).`,
        source: "AIP ENR 5.1",
      });
    }
  }

  // --- Performance: speed envelope + 250 kt below FL100 ------------------
  if (newGsKt != null) {
    if (newGsKt < MIN_GS_KT) {
      checks.push(perf("Speed below minimum", "fail", `${Math.round(newGsKt)} kt < ~${MIN_GS_KT} kt clean minimum (approx).`));
    } else if (newGsKt > MAX_GS_KT) {
      checks.push(perf("Speed exceeds Vmo/Mmo", "fail", `${Math.round(newGsKt)} kt > ~${MAX_GS_KT} kt (approx envelope).`));
    } else {
      checks.push(perf("Speed within envelope", "pass", `${Math.round(newGsKt)} kt.`));
    }
    const altForSpeed = newAltFt ?? afterPath[0]?.altFt ?? 0;
    if (altForSpeed < 10000 && newGsKt > 250) {
      checks.push({
        category: "Procedure",
        label: "250 kt below FL100",
        status: "warn",
        detail: `${Math.round(newGsKt)} kt below FL100 exceeds the 250 kt limit.`,
        source: "ICAO Doc 4444 §4.10",
      });
    }
  }

  // --- Level: band + semicircular ---------------------------------------
  if (newAltFt != null) {
    if (newAltFt > 45000) {
      checks.push(level("Above service ceiling", "fail", `FL${Math.round(newAltFt / 100)} is above a typical ceiling.`));
    } else if (newAltFt < 3000) {
      checks.push(level("Below safe cruising altitude", "fail", `${Math.round(newAltFt)} ft is too low for cruise.`));
    } else {
      checks.push(level("Level within band", "pass", `FL${Math.round(newAltFt / 100)}.`));
    }
    if (!respectsSemicircular(newAltFt, trackDeg)) {
      checks.push({
        category: "Procedure",
        label: "Semicircular cruising-level rule",
        status: "warn",
        detail: `FL${Math.round(newAltFt / 100)} is against the direction of flight (track ${Math.round(trackDeg)}°).`,
        source: "ICAO Annex 2, App 3",
      });
    }
  }

  // --- Conflict re-check against ALL other traffic (3-D) ----------------
  if (recheck) {
    const need = horizontalMinimumNm(cfg) + cfg.buffer.horizontalNm;
    if (recheck.clear) {
      checks.push({
        category: "Conflict",
        label: "Clear of all other traffic",
        status: "pass",
        detail: `Separation maintained against every other flight.`,
        source: "ICAO Doc 4444 Ch.5",
      });
    } else {
      // The pair first: it is the question the reader came here with.
      if (recheck.unresolved) {
        const who = recheck.unresolved.callsign;
        checks.push({
          category: "Conflict",
          label: who ? `Conflict persists with ${who}` : "Conflict not resolved",
          status: "fail",
          detail:
            `This maneuver does not resolve the conflict it is for — CPA still ` +
            `${recheck.unresolved.dCpaNm.toFixed(1)} NM < ${need} NM.`,
          source: "ICAO Doc 4444 Ch.5",
        });
      }
      if (recheck.secondary) {
        const more = recheck.secondary.alsoCount ?? 0;
        checks.push({
          category: "Conflict",
          label: "Secondary conflict",
          status: "fail",
          detail:
            `Would newly lose separation with ` +
            `${recheck.secondary.callsign ?? "other traffic"} ` +
            `(CPA ${recheck.secondary.dCpaNm.toFixed(1)} NM < ${need} NM)` +
            `${more > 0 ? ` and ${more} more` : ""}.`,
          source: "ICAO Doc 4444 Ch.5",
        });
      }
      // Neither named: the caller knows it is not clear but not who. Say that
      // rather than inventing a category for it.
      if (!recheck.unresolved && !recheck.secondary) {
        checks.push({
          category: "Conflict",
          label: "Not clear of other traffic",
          status: "fail",
          detail: `Tightest CPA ${recheck.minSepNm.toFixed(1)} NM < ${need} NM.`,
          source: "ICAO Doc 4444 Ch.5",
        });
      }
    }
  }

  // --- Not evaluated (no in-app data) — surfaced honestly ---------------
  checks.push({
    category: "Procedure",
    label: "Terrain / MSA / procedure protection",
    status: "warn",
    detail: "Not evaluated — no terrain / protection-area data in the tool.",
  });

  const verdict = checks.some((c) => c.status === "fail")
    ? "reject"
    : checks.some((c) => c.status === "warn")
      ? "caution"
      : "accept";
  return { checks, verdict };
}

function perf(label: string, status: ConstraintStatus, detail: string): ConstraintCheck {
  return { category: "Performance", label, status, detail, source: "Aircraft performance (approx)" };
}
function level(label: string, status: ConstraintStatus, detail: string): ConstraintCheck {
  return { category: "Level", label, status, detail, source: "ICAO Doc 4444 §5.3" };
}
function fmtBand(lo: number, hi: number): string {
  const f = (v: number) =>
    v === Infinity ? "UNL" : v <= 0 ? "GND" : v >= 10000 ? `FL${Math.round(v / 100)}` : `${Math.round(v)} ft`;
  return `${f(lo)}–${f(hi)}`;
}
