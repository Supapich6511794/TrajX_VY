/**
 * Holding patterns for this deployment's FIR (VY/Myanmar). The AIP holding
 * table (published + enroute racetracks) is read from `HOLDINGS_URL` below.
 * No VY holding table has been sourced yet, so that file is absent: the fetch
 * fails closed (see `fetchHoldings`/`fetchHoldingPatterns`) and those two
 * categories simply come back empty until the file is supplied.
 *
 * Missed-approach and HILPT holds (coded inside the approach procedures
 * themselves, not the AIP table) ARE available for VY — see `ILS_WP_URL` /
 * `PBN_WP_URL` in `fetchHoldingPatterns` below.
 *
 * Used by CD&R to offer a HOLD resolution: fly one racetrack loop at a holding
 * fix on the route (4 legs ≈ 4 min for a 1-minute leg), which DELAYS the flight
 * and opens spacing — the realistic fix for an arrival-merge conflict. Every
 * parameter (inbound course, turn direction, leg time/length, speed, altitude)
 * is taken verbatim from the AIP data.
 */

export interface Holding {
  ident: string;
  lat: number;
  lon: number;
  /** Inbound holding course (° true) — the track flown TO the fix. */
  inboundCourseDeg: number;
  /** Turn direction of the pattern ("R" = standard right-hand). */
  turn: "L" | "R";
  /** Coded leg time (min) — the straight-leg duration (default 1). */
  legTimeMin: number;
  /** Coded leg length (NM), when the hold is distance- not time-based. */
  legLengthNm: number | null;
  /** Coded holding speed (kt), when published. */
  speedKt: number | null;
  minAltFt: number | null;
  maxAltFt: number | null;
}

// No VY AIP holding table has been sourced yet — this 404s and the
// "offline / missing file" fallback below (and in `fetchHoldingPatterns`)
// returns an empty map, so Published/Enroute holds simply aren't offered.
// Drop a GeoJSON with the properties read below at this path to enable them.
const HOLDINGS_URL = "/data/aixm_vy/holdings_published.geojson";

let _cache: Map<string, Holding> | null = null;

/** Fetch + index the holdings by fix ident (first occurrence wins — the file
 *  carries a `duplicate_identifier` for the rare repeated fix). Cached. */
export async function fetchHoldings(): Promise<Map<string, Holding>> {
  if (_cache) return _cache;
  const m = new Map<string, Holding>();
  try {
    const res = await fetch(HOLDINGS_URL, { cache: "force-cache" });
    if (!res.ok) return m;
    const gj = (await res.json()) as {
      features?: {
        properties?: Record<string, unknown>;
        geometry?: { coordinates?: unknown };
      }[];
    };
    for (const f of gj.features ?? []) {
      const p = f.properties ?? {};
      const c = f.geometry?.coordinates;
      const ident = String(p.waypoint_identifier ?? p.holding_name ?? "").trim();
      if (!ident || !Array.isArray(c)) continue;
      if (m.has(ident)) continue;
      const num = (v: unknown): number | null =>
        v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
      m.set(ident, {
        ident,
        lon: Number(c[0]),
        lat: Number(c[1]),
        inboundCourseDeg: num(p.inbound_holding_course_deg) ?? 0,
        turn: p.turn_direction === "L" ? "L" : "R",
        legTimeMin: num(p.leg_time_min) ?? 1,
        legLengthNm: num(p.leg_length_nm),
        speedKt: num(p.holding_speed_kt),
        minAltFt: num(p.minimum_altitude_ft),
        maxAltFt: num(p.maximum_altitude_ft),
      });
    }
  } catch {
    /* offline / missing file → empty map (hold simply isn't offered) */
  }
  _cache = m;
  return m;
}

/** Duration (s) of ONE holding loop at ground speed `gsKt`: two straight legs +
 *  two 180° standard-rate (3°/s → 60 s) turns. Time-based when a leg time is
 *  coded (the usual case), else distance-based from the coded leg length. */
export function holdLoopSec(h: Holding, gsKt: number): number {
  const legSec =
    h.legLengthNm != null && gsKt > 0
      ? (h.legLengthNm / gsKt) * 3600
      : h.legTimeMin * 60;
  const turnSec = 60; // 180° at 3°/s
  return 2 * legSec + 2 * turnSec;
}

/** One straight-leg duration (s) — half a loop's legs. */
/**
 * When a flight may first be offered a HOLD, in seconds on its own clock.
 *
 * Holding is an arrival instrument. A departure is not held — the instruction
 * a controller gives a climbing aircraft is a heading, a level or a speed, not
 * a racetrack — so a published holding fix the flight happens to cross on the
 * way up, or in the cruise, is not something to propose. The arrival begins at
 * top of descent, and that is the gate.
 *
 * Returns null when the flight has no descent point at all (no vertical
 * profile); the caller then falls back to the sample's own phase.
 */
/**
 * May the route fix at `routeIndex` carry an arrival hold?
 *
 * "On the arrival" means ON THE STAR. The server names the fix the procedure
 * starts at (`meta.starEntry`), which is the only way to tell — the route
 * reaches the client as a flat ident list with nothing marking where the
 * en-route portion ends. Top of descent is the fallback for a flight with no
 * STAR (or an older payload that carries no entry fix), and it is a looser
 * gate: on a domestic leg (VYMD-VYYY, say) it can fall several minutes and
 * several en-route fixes before the STAR is actually joined. Phase is the last resort, for a
 * trajectory with no vertical profile at all.
 */
export function makeArrivalHoldGate(traj: {
  points?: { epoch_ts: string }[];
  route?: { ident: string }[];
  profile?: { tod?: { epochTs: string } | null } | null;
  meta?: { starEntry?: string } | null;
}): (routeIndex: number, tSec: number, phase?: string | null) => boolean {
  const entry = traj.meta?.starEntry;
  const starIdx = entry
    ? (traj.route ?? []).findIndex((w) => w.ident === entry)
    : -1;
  if (starIdx >= 0) return (routeIndex) => routeIndex >= starIdx;

  const fromSec = holdEligibleFromSec(traj);
  if (fromSec != null) return (_routeIndex, tSec) => tSec >= fromSec;

  return (_routeIndex, _tSec, phase) => phase === "descent";
}


export function holdEligibleFromSec(traj: {
  points?: { epoch_ts: string }[];
  profile?: { tod?: { epochTs: string } | null } | null;
}): number | null {
  const tod = traj.profile?.tod;
  const first = traj.points?.[0];
  if (!tod || !first) return null;
  const t0 = Date.parse(first.epoch_ts);
  const tTod = Date.parse(tod.epochTs);
  if (!Number.isFinite(t0) || !Number.isFinite(tTod)) return null;
  return (tTod - t0) / 1000;
}


export function holdLegSec(h: Holding, gsKt: number): number {
  return h.legLengthNm != null && gsKt > 0
    ? (h.legLengthNm / gsKt) * 3600
    : h.legTimeMin * 60;
}

/* ---------------------------------------------------------------------------
 * Map layer: every hold in the FIR, categorised and drawable as a racetrack.
 *
 * Two sources, because no single file carries all four kinds:
 *   - the AIP holding table above → the PUBLISHED holds. `region_code` is the
 *     airport they're coded against, or "ENRT" for the enroute ones.
 *   - the coded approach procedures (ILS + PBN) → the holds that only exist
 *     INSIDE a procedure, identified by their ARINC 424 path terminator:
 *       HM = hold to manual termination  → the MISSED APPROACH hold
 *       HF = hold to fix, one circuit    → HILPT (hold in lieu of proc turn)
 *     (HA is treated as HILPT too.)
 *
 * The same physical racetrack is often in BOTH sources — the missed-approach
 * hold is usually also a published hold at that fix. They're deduped on
 * (ident, turn, inbound course ±3°) so each pattern is drawn exactly once, with
 * the more specific procedure-derived category winning. The ±3° tolerance
 * absorbs the rounding between the two files (a course coded 36° in one and
 * 35° in the other is the same hold).
 * ------------------------------------------------------------------------- */

export type HoldingCategory = "published" | "missed" | "enroute" | "hilpt";

export const HOLDING_CATEGORIES: HoldingCategory[] = [
  "published",
  "missed",
  "enroute",
  "hilpt",
];

export const HOLDING_CATEGORY_LABEL: Record<HoldingCategory, string> = {
  published: "Published Holding",
  missed: "Missed Approach Holding",
  enroute: "Enroute Holding",
  hilpt: "HILPT",
};

/** One drawable holding pattern. */
export interface HoldingPattern {
  ident: string;
  lat: number;
  lon: number;
  category: HoldingCategory;
  /** Airport ICAO the hold is coded against, or "ENRT" for an enroute hold. */
  region: string;
  /** Inbound holding course — the track flown TO the fix. Both sources code it
   *  magnetic; treated as true, since variation in the FIR is about 1° (the VY
   *  runway table gives VYYY RW03 as 34° magnetic / 33° true). */
  inboundCourseDeg: number;
  turn: "L" | "R";
  legTimeMin: number | null;
  legLengthNm: number | null;
  speedKt: number | null;
  minAltFt: number | null;
  maxAltFt: number | null;
  /** The approach the hold is coded in — procedure-derived categories only. */
  procedure: string | null;
}

// VY (Myanmar) procedures — the coded approaches carry their own missed-
// approach and HILPT holds, so this half of the hold system works for this
// deployment even though the AIP table above (HOLDINGS_URL) doesn't exist yet.
const ILS_WP_URL = "/data/aixm_vy/ils_wp.geojson";
const PBN_WP_URL = "/data/aixm_vy/pbn_waypoint.geojson";

/** ICAO maximum holding speeds (kt) by altitude band — the fallback when a
 *  hold codes no speed, used to size the leg and the turn radius. */
function icaoHoldSpeedKt(altFt: number | null): number {
  const a = altFt ?? 0;
  if (a <= 14000) return 230;
  if (a <= 20000) return 240;
  return 265;
}

const num = (v: unknown): number | null =>
  v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

async function getJson(url: string): Promise<{
  features?: {
    properties?: Record<string, unknown>;
    geometry?: { coordinates?: unknown };
  }[];
} | null> {
  try {
    const res = await fetch(encodeURI(url), { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Smallest absolute difference between two bearings (degrees, 0..180). */
function courseDeltaDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

let _patterns: HoldingPattern[] | null = null;

/** Every holding pattern in the FIR, categorised and deduped. Cached. */
export async function fetchHoldingPatterns(): Promise<HoldingPattern[]> {
  if (_patterns) return _patterns;

  const out: HoldingPattern[] = [];

  const [published, ils, pbn] = await Promise.all([
    getJson(HOLDINGS_URL),
    getJson(ILS_WP_URL),
    getJson(PBN_WP_URL),
  ]);

  for (const f of published?.features ?? []) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates;
    const ident = String(p.waypoint_identifier ?? p.holding_name ?? "").trim();
    if (!ident || !Array.isArray(c)) continue;
    const region = String(p.region_code ?? "").trim() || "ENRT";
    out.push({
      ident,
      lon: Number(c[0]),
      lat: Number(c[1]),
      category: region === "ENRT" ? "enroute" : "published",
      region,
      inboundCourseDeg: num(p.inbound_holding_course_deg) ?? 0,
      turn: p.turn_direction === "L" ? "L" : "R",
      legTimeMin: num(p.leg_time_min),
      legLengthNm: num(p.leg_length_nm),
      speedKt: num(p.holding_speed_kt),
      minAltFt: num(p.minimum_altitude_ft),
      maxAltFt: num(p.maximum_altitude_ft),
      procedure: null,
    });
  }

  // Hold legs inside the coded approaches. `distance_time` says which unit
  // `route_distance_holding_distance_time` is in: "D" = NM, otherwise minutes.
  for (const src of [ils, pbn]) {
    for (const f of src?.features ?? []) {
      const p = f.properties ?? {};
      const term = String(p.path_termination ?? "").toUpperCase();
      if (term !== "HM" && term !== "HF" && term !== "HA") continue;
      const ident = String(p.waypoint_identifier ?? "").trim();
      const lat = num(p.waypoint_latitude);
      const lon = num(p.waypoint_longitude);
      if (!ident || lat == null || lon == null) continue;
      const leg = num(p.route_distance_holding_distance_time);
      const byDistance = String(p.distance_time ?? "").toUpperCase() === "D";
      out.push({
        ident,
        lat,
        lon,
        category: term === "HM" ? "missed" : "hilpt",
        region: String(p.airport_identifier ?? "").trim() || "ENRT",
        inboundCourseDeg: num(p.magnetic_course) ?? 0,
        turn: p.turn_direction === "L" ? "L" : "R",
        legTimeMin: byDistance ? null : leg,
        legLengthNm: byDistance ? leg : null,
        speedKt: num(p.speed_limit),
        minAltFt: num(p.altitude1),
        maxAltFt: num(p.altitude2),
        procedure: String(p.procedure_identifier ?? "").trim() || null,
      });
    }
  }

  _patterns = dedupeHoldings(out);
  return _patterns;
}

/** Collapse the same racetrack coded in more than one source. Keeps the most
 *  specific category (HILPT > missed > enroute > published) and leaves
 *  genuinely different holds at a shared fix (different course or turn) alone. */
export function dedupeHoldings(all: HoldingPattern[]): HoldingPattern[] {
  const rank: Record<HoldingCategory, number> = {
    hilpt: 0,
    missed: 1,
    enroute: 2,
    published: 3,
  };
  const kept = new Map<string, HoldingPattern[]>();
  for (const h of [...all].sort((a, b) => rank[a.category] - rank[b.category])) {
    const bucket = kept.get(h.ident) ?? [];
    const dup = bucket.some(
      (k) =>
        k.turn === h.turn &&
        courseDeltaDeg(k.inboundCourseDeg, h.inboundCourseDeg) <= 3,
    );
    if (dup) continue;
    bucket.push(h);
    kept.set(h.ident, bucket);
  }
  return [...kept.values()].flat().sort((a, b) => a.ident.localeCompare(b.ident));
}

/** Destination point `distNm` along `brgDeg` from (lat, lon). */
function destPoint(
  lat: number,
  lon: number,
  brgDeg: number,
  distNm: number,
): [number, number] {
  const R = 3440.065; // Earth radius, NM
  const d = distNm / R;
  const b = (brgDeg * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b),
  );
  const lo2 =
    lo +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la),
      Math.cos(d) - Math.sin(la) * Math.sin(la2),
    );
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}

/** Straight-leg length (NM) of a pattern: the coded distance, or the coded leg
 *  time flown at the holding speed. */
export function holdLegNm(h: HoldingPattern): number {
  if (h.legLengthNm != null) return h.legLengthNm;
  const v = h.speedKt ?? icaoHoldSpeedKt(h.minAltFt);
  return ((h.legTimeMin ?? 1) * v) / 60;
}

/**
 * The racetrack outline of a holding pattern, as a closed lat/lon ring:
 * inbound leg → 180° turn over the fix → outbound leg → 180° turn back.
 *
 * The pattern lies on the turn side of the inbound track (right-hand hold =
 * right of the inbound course) and extends BACK from the fix, which is where a
 * real hold sits. Turns are rate-one, so the two legs are 2r apart with
 * r = V / (20π) NM.
 */
export function holdingRacetrack(
  h: HoldingPattern,
  arcSteps = 16,
): [number, number][] {
  const v = h.speedKt ?? icaoHoldSpeedKt(h.minAltFt);
  const r = v / (20 * Math.PI); // rate-one turn radius, NM
  const legNm = holdLegNm(h);
  const c = h.inboundCourseDeg;
  const sign = h.turn === "L" ? -1 : 1;
  const side = 90 * sign;

  const fix: [number, number] = [h.lat, h.lon];
  // Start of the inbound leg, `legNm` back along the inbound course.
  const legStart = destPoint(h.lat, h.lon, c + 180, legNm);
  // Turn centres sit abeam each end of the inbound leg, on the turn side.
  const c1 = destPoint(fix[0], fix[1], c + side, r);
  const c2 = destPoint(legStart[0], legStart[1], c + side, r);

  // 180° arc around `centre`, starting at bearing `fromBrg` and sweeping in the
  // turn direction. `from` skips the first point when it is already in the ring.
  const arc = (
    centre: [number, number],
    fromBrg: number,
    from: 0 | 1,
  ): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = from; i <= arcSteps; i++) {
      const b = fromBrg + (180 * sign * i) / arcSteps;
      pts.push(destPoint(centre[0], centre[1], b, r));
    }
    return pts;
  };

  return [
    legStart,
    fix,
    // Over the fix, turning onto the outbound leg (starts AT the fix).
    ...arc(c1, c - side, 1),
    // The outbound leg is the gap between the two arcs; the second turn rolls
    // out back on the inbound course, ending on `legStart`.
    ...arc(c2, c + side, 0),
  ];
}
