/**
 * Client for the Python FastAPI server (the REAL trajectory_sim engine).
 *
 * The web no longer computes trajectories itself — it POSTs the form inputs
 * here and the Python package does route parsing, pyproj/WGS-84 geodesy and
 * GeoPackage/CSV export. One engine, no duplicated logic.
 *
 * Base URL is overridable via NEXT_PUBLIC_API_BASE (defaults to the local
 * uvicorn dev server).
 */

import { staticProcedureNames } from "@/lib/geojson";
import type {
  Phase,
  RouteWaypoint,
  TrajectoryResult,
} from "@/lib/trajectory/types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export interface GenerateInput {
  /** Route source. Only "fpl" (an Item-15 route string) exists; the legacy
   *  airway-CSV corridor mode is gone server-side. */
  source: "fpl";
  /** Departure / destination ICAO — drive direction + meta server-side. */
  adep: string;
  ades: string;
  route: string;
  callsign: string;
  /** ICAO aircraft type (e.g. "B738", "A333"). Selects the BADA
   *  climb/descent rates, speed schedule and ceiling server-side.
   *  Optional — the server defaults to B738 when omitted. */
  actype?: string;
  /** ISO local string from the datetime-local input (treated as UTC). */
  eobt: string;
  gs_kt: number;
  /** Requested Flight Level in hundreds of feet (FL330 → 330). */
  rfl: number;
  /** TRANSIT level (hundreds of ft): already at this level at the first fix,
   *  only passing through — no climb from the ground. Omit for an ordinary
   *  flight. */
  entry_fl?: number;
  /** Surveillance Profile: seconds between emitted track points (and the
   *  UTC timestamps in exports). 5 = en-route radar (default), 4 = CAT62
   *  terminal, 1 = high-rate. Output density only — flight time/validation
   *  are unaffected. Omitted → server default (5 s). */
  output_every_s?: number;
  /** 0-based index when several routes share (callsign, EOBT). Server
   *  suffixes the flight_key/filename with `_R{n+1}` to keep files
   *  distinct without mangling the user's callsign. */
  flight_index?: number;
  /** Optional Phase-3 speed-schedule overrides for tuning toward the
   *  CAT62 reference time. Omitted fields keep the airframe default. */
  climb_cas_kt?: number;
  climb_mach?: number;
  cruise_mach?: number;
  descent_mach?: number;
  descent_cas_kt?: number;
  restrict_cas_kt?: number;
  /** Optional SID (resolved at ADEP) / STAR (resolved at ADES) names to
   *  splice around the enroute route. Runway/transition are optional — the
   *  server auto-picks the first candidate on ambiguity and reports it in
   *  `warnings`. An unknown name is skipped with a warning, never fatal. */
  sid?: string;
  sid_runway?: string;
  sid_transition?: string;
  star?: string;
  star_runway?: string;
  star_transition?: string;
  /** PBN instrument approach (IAP) at ADES, e.g. "R09-Z". Its landing runway
   *  is encoded in the name and reuses `star_runway`; the IAF transition
   *  auto-picks from the STAR's terminal fix unless set here. */
  approach?: string;
  approach_transition?: string;
}

export interface GenerateResponse {
  result: TrajectoryResult;
  warnings: string[];
  /** Absolute URLs to the Python-written export files. */
  downloads: { gpkg: string; csv: string; geojson: string };
}

/** Raw JSON shape returned by POST /api/generate. */
interface ApiPayload {
  flight_key: string;
  meta: {
    callsign: string;
    aircraft_type: string;
    adep: string;
    ades: string;
    eobt: string;
    engine: string;
    sid?: string | null;
    dep_rwy?: string | null;
    star?: string | null;
    star_entry?: string | null;
    approach?: string | null;
    arr_rwy?: string | null;
    arr_threshold?: { lat: number; lon: number } | null;
    star_open?: boolean;
    vector_heading_deg?: number | null;
    vector_heading_mag_deg?: number | null;
    vectored?: boolean;
    clearance?: string | null;
  };
  stats: {
    waypoint_count: number;
    point_count: number;
    distance_nm: number;
    time_minutes: number;
    cruise_alt_ft: number | null;
    rfl_ft: number;
  };
  profile: {
    toc: {
      lat: number;
      lon: number;
      altitude_ft: number;
      epoch_ts: string;
    } | null;
    tod: {
      lat: number;
      lon: number;
      altitude_ft: number;
      epoch_ts: string;
    } | null;
    speed_schedule?: {
      climb_cas_kt: number;
      climb_mach: number;
      cruise_mach: number;
      descent_mach: number;
      descent_cas_kt: number;
      crossover_ft: number;
      below_fl100_restriction_kt: number;
    };
    phase_breakdown?: {
      climb: { avg_tas_kt: number | null; avg_gs_kt: number | null; time_min: number | null };
      cruise: { avg_tas_kt: number | null; avg_gs_kt: number | null; time_min: number | null };
      descent: { avg_tas_kt: number | null; avg_gs_kt: number | null; time_min: number | null };
    };
    constraints?: { phase: string; alt_ft: number }[];
  };
  validation: {
    route: string;
    cat62_min: number;
    simulated_min: number;
    delta_min: number;
    threshold_min: number;
    status: "PASS" | "FAIL";
    passed: boolean;
    source: "cat62" | "estimate";
  } | null;
  route: RouteWaypoint[];
  points: {
    lat: number;
    lon: number;
    epoch_ts: string;
    altitude_ft: number | null;
    gs_kt: number;
    tas_kt?: number | null;
    track_deg: number;
    phase: Phase;
  }[];
  warnings: string[];
  downloads: { gpkg: string; csv: string; geojson: string };
}

export async function generateTrajectory(
  input: GenerateInput,
): Promise<GenerateResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error(
      `Cannot reach the Python API at ${API_BASE}. Is the FastAPI server ` +
        `running? (uvicorn api.server:app --port 8000)`,
    );
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = String(j.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }

  const p = (await res.json()) as ApiPayload;
  return mapPayload(p);
}

/**
 * Re-fly an arrival with a longer downwind, applied TACTICALLY — as an
 * instruction to an aircraft already at the vector hand-over fix, so everything
 * it has already flown is preserved.
 *
 * Only the flight key and the track miles to absorb are sent: the request that
 * produced the flight is held server-side, because the browser cannot rebuild
 * one from a `TrajectoryResult` (the resolved route is a fix list, not the
 * Item-15 string, and a vectored arrival's TURN/INTC are not routable input).
 */
export async function extendDownwind(
  flightKey: string,
  extendNm: number,
): Promise<GenerateResponse> {
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/api/extend/${encodeURIComponent(flightKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extend_nm: extendNm }),
      },
    );
  } catch {
    throw new Error(`Cannot reach the Python API at ${API_BASE}.`);
  }
  if (!res.ok) {
    // FastAPI errors are `{"detail": "…"}`; show the sentence, not the JSON.
    let detail = "";
    try {
      const j = await res.json();
      if (j?.detail) detail = String(j.detail);
    } catch {
      /* not JSON — fall back to the status line below */
    }
    throw new Error(
      detail || `Could not extend the downwind (HTTP ${res.status}).`,
    );
  }
  return mapPayload((await res.json()) as ApiPayload);
}

// Map the Python payload onto the shared TrajectoryResult shape so the
// map components are unchanged. Shared by the single + batch endpoints.
function mapPayload(p: ApiPayload): GenerateResponse {
  const result: TrajectoryResult = {
    route: p.route,
    points: p.points,
    stats: {
      waypointCount: p.stats.waypoint_count,
      pointCount: p.stats.point_count,
      distanceNm: p.stats.distance_nm,
      timeMinutes: p.stats.time_minutes,
      cruiseAltFt: p.stats.cruise_alt_ft,
      rflFt: p.stats.rfl_ft,
    },
    profile: {
      toc: p.profile.toc
        ? {
            lat: p.profile.toc.lat,
            lon: p.profile.toc.lon,
            altitudeFt: p.profile.toc.altitude_ft,
            epochTs: p.profile.toc.epoch_ts,
          }
        : null,
      tod: p.profile.tod
        ? {
            lat: p.profile.tod.lat,
            lon: p.profile.tod.lon,
            altitudeFt: p.profile.tod.altitude_ft,
            epochTs: p.profile.tod.epoch_ts,
          }
        : null,
      speedSchedule: p.profile.speed_schedule
        ? {
            climbCasKt: p.profile.speed_schedule.climb_cas_kt,
            climbMach: p.profile.speed_schedule.climb_mach,
            cruiseMach: p.profile.speed_schedule.cruise_mach,
            descentMach: p.profile.speed_schedule.descent_mach,
            descentCasKt: p.profile.speed_schedule.descent_cas_kt,
            crossoverFt: p.profile.speed_schedule.crossover_ft,
            belowFl100RestrictionKt:
              p.profile.speed_schedule.below_fl100_restriction_kt,
          }
        : undefined,
      phaseBreakdown: p.profile.phase_breakdown
        ? {
            climb: {
              avgTasKt: p.profile.phase_breakdown.climb.avg_tas_kt,
              avgGsKt: p.profile.phase_breakdown.climb.avg_gs_kt,
              timeMin: p.profile.phase_breakdown.climb.time_min,
            },
            cruise: {
              avgTasKt: p.profile.phase_breakdown.cruise.avg_tas_kt,
              avgGsKt: p.profile.phase_breakdown.cruise.avg_gs_kt,
              timeMin: p.profile.phase_breakdown.cruise.time_min,
            },
            descent: {
              avgTasKt: p.profile.phase_breakdown.descent.avg_tas_kt,
              avgGsKt: p.profile.phase_breakdown.descent.avg_gs_kt,
              timeMin: p.profile.phase_breakdown.descent.time_min,
            },
          }
        : undefined,
      constraints: (p.profile.constraints ?? []).map((c) => ({
        phase: c.phase,
        altFt: c.alt_ft,
      })),
    },
    validation: p.validation
      ? {
          route: p.validation.route,
          cat62Min: p.validation.cat62_min,
          simulatedMin: p.validation.simulated_min,
          deltaMin: p.validation.delta_min,
          thresholdMin: p.validation.threshold_min,
          status: p.validation.status,
          passed: p.validation.passed,
          source: p.validation.source,
        }
      : null,
    meta: {
      flightKey: p.flight_key,
      callsign: p.meta.callsign,
      aircraftType: p.meta.aircraft_type,
      adep: p.meta.adep,
      ades: p.meta.ades,
      eobtIso: p.meta.eobt,
      sid: p.meta.sid ?? undefined,
      depRwy: p.meta.dep_rwy ?? undefined,
      star: p.meta.star ?? undefined,
      starEntry: p.meta.star_entry ?? undefined,
      approach: p.meta.approach ?? undefined,
      arrRwy: p.meta.arr_rwy ?? undefined,
      arrThreshold: p.meta.arr_threshold ?? undefined,
      starOpen: p.meta.star_open ?? false,
      vectorHeadingDeg: p.meta.vector_heading_deg ?? undefined,
      vectorHeadingMagDeg: p.meta.vector_heading_mag_deg ?? undefined,
      vectored: p.meta.vectored ?? false,
      clearance: p.meta.clearance ?? undefined,
    },
  };

  const abs = (u: string) => `${API_BASE}${u}`;
  return {
    result,
    warnings: p.warnings,
    downloads: {
      gpkg: abs(p.downloads.gpkg),
      csv: abs(p.downloads.csv),
      geojson: abs(p.downloads.geojson),
    },
  };
}

/** One flight that failed inside a batch — surfaced, not fatal. */
export interface BatchError {
  index: number;
  callsign: string;
  adep: string;
  ades: string;
  detail: string;
}

export interface BatchResponse {
  /** Successful flights, in submission order. */
  results: GenerateResponse[];
  /** Per-flight failures (e.g. an unroutable route) — the rest still run. */
  errors: BatchError[];
}

/**
 * Generate many flights in one request (POST /api/generate_batch).
 *
 * The server assigns each flight a distinct flight_index so their
 * flight_keys/filenames never collide. A single bad flight is reported in
 * `errors` rather than aborting the whole batch — built for whole-network
 * traffic days of thousands of flights.
 */
export async function generateBatch(
  flights: GenerateInput[],
  indexOffset = 0,
): Promise<BatchResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/generate_batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flights, index_offset: indexOffset }),
    });
  } catch {
    throw new Error(
      `Cannot reach the Python API at ${API_BASE}. Is the FastAPI server ` +
        `running? (uvicorn api.server:app --port 8000)`,
    );
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = String(j.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }

  const j = (await res.json()) as {
    results: ApiPayload[];
    errors: BatchError[];
  };
  return {
    results: (j.results ?? []).map(mapPayload),
    errors: j.errors ?? [],
  };
}

// --- SID/STAR procedures ---------------------------------------------------

export interface ProcedureLegDto {
  seqno: number;
  path_terminator: string;
  ident: string | null;
  lat: number | null;
  lon: number | null;
  turn: string | null;
  altitude: { type: string; alt1_ft?: number | null; alt2_ft?: number | null };
  speed: { type: string; speed_kt?: number | null };
}

export interface ProcedureDto {
  airport: string;
  name: string;
  type: string;
  runway: string | null;
  transition: string | null;
  /** Runway/transition the server auto-picked to resolve ambiguity. */
  assumptions: Record<string, string>[];
  legs: ProcedureLegDto[];
  waypoints: { ident: string; lat: number; lon: number }[];
}

export interface ProcedureList {
  airport: string;
  SID: string[];
  STAR: string[];
}

/**
 * List the SID/STAR procedure names published at an aerodrome
 * (GET /api/procedures/{airport}). Returns empty arrays when the airport has
 * no coded procedures in the navdata. Never throws on a missing airport — an
 * empty list is the natural "no procedures" answer the picker shows.
 */
export async function listProcedures(airport: string): Promise<ProcedureList> {
  const code = airport.trim().toUpperCase();
  if (!code) return { airport: code, SID: [], STAR: [] };
  // Fallback to the statically-bundled procedure GeoJSON (same source the
  // engine indexes) so the SID/STAR dropdowns still populate when the API is
  // unreachable — e.g. a Vercel deploy whose backend is asleep or whose
  // NEXT_PUBLIC_API_BASE isn't set. Leg geometry still needs the API.
  const fromStatic = async (): Promise<ProcedureList> => {
    const s = await staticProcedureNames(code);
    return { airport: code, SID: s.SID, STAR: s.STAR };
  };
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}/api/procedures/${encodeURIComponent(code)}`,
    );
  } catch {
    return fromStatic();
  }
  if (!res.ok) return fromStatic();
  const j = (await res.json()) as Partial<ProcedureList>;
  const out: ProcedureList = {
    airport: j.airport ?? code,
    SID: j.SID ?? [],
    STAR: j.STAR ?? [],
  };
  // API reachable but returned nothing for a known aerodrome — still try the
  // bundled data before showing an empty picker.
  return out.SID.length === 0 && out.STAR.length === 0 ? fromStatic() : out;
}

/**
 * Resolve a SID/STAR's coded legs + altitude/speed constraints from the
 * procedures API. ``auto`` (default) lets the server pick a runway/transition
 * when the choice is ambiguous, so a single map click always returns legs.
 */
export async function fetchProcedure(
  airport: string,
  name: string,
  opts: {
    type?: string;
    runway?: string;
    transition?: string;
    /** Enroute route string — lets the server pick the transition the flight
     *  actually flies (e.g. NAKO1B via BLAFF, not ALBOS). */
    route?: string;
  } = {},
): Promise<ProcedureDto> {
  const q = new URLSearchParams();
  if (opts.type) q.set("type", opts.type);
  if (opts.runway) q.set("runway", opts.runway);
  if (opts.transition) q.set("transition", opts.transition);
  if (opts.route) q.set("route", opts.route);
  const url = `${API_BASE}/api/procedures/${encodeURIComponent(
    airport,
  )}/${encodeURIComponent(name)}?${q.toString()}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`Cannot reach the Python API at ${API_BASE}.`);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = typeof j.detail === "string" ? j.detail : detail;
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return (await res.json()) as ProcedureDto;
}

/**
 * Suggest the SID (type "SID") or STAR ("STAR") that best connects to the
 * enroute ``route`` at ``airport`` (GET /api/suggest-procedure). ``runway``
 * (optional) restricts to procedures serving it. Returns the best procedure
 * name, or ``null`` when nothing connects / the backend is unreachable — a
 * miss is never fatal, the picker just leaves the choice empty.
 */
export async function suggestProcedure(
  airport: string,
  type: "SID" | "STAR",
  route: string,
  runway?: string,
): Promise<string | null> {
  const code = airport.trim().toUpperCase();
  if (!code || !route.trim()) return null;
  const q = new URLSearchParams({ type, route: route.trim() });
  if (runway) q.set("runway", runway);
  try {
    const res = await fetch(
      `${API_BASE}/api/suggest-procedure/${encodeURIComponent(code)}?${q}`,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { name?: string | null };
    return j?.name ?? null;
  } catch {
    return null;
  }
}

/** A PBN approach's IAF entry fixes and which of them the current route/STAR
 *  flies through (see /api/approach-entries). `matching` ⊆ `entries`. */
export interface ApproachEntries {
  airport: string;
  name: string;
  entries: string[];
  matching: string[];
}

/**
 * List a PBN approach's IAF entry fixes and which lie on the arriving route +
 * STAR (GET /api/approach-entries/{airport}/{name}). When `matching` has more
 * than one fix the generator offers the pilot a choice of where to join the
 * approach (e.g. an RNP approach with two IAFs). Returns empty lists when the
 * backend is unreachable or nothing matches — a miss just hides the dropdown.
 */
export async function fetchApproachEntries(
  airport: string,
  name: string,
  opts: { runway?: string; route?: string; star?: string } = {},
): Promise<ApproachEntries> {
  const code = airport.trim().toUpperCase();
  const empty: ApproachEntries = {
    airport: code,
    name,
    entries: [],
    matching: [],
  };
  if (!code || !name) return empty;
  const q = new URLSearchParams();
  if (opts.runway) q.set("runway", opts.runway);
  if (opts.route && opts.route.trim()) q.set("route", opts.route.trim());
  if (opts.star) q.set("star", opts.star);
  try {
    const res = await fetch(
      `${API_BASE}/api/approach-entries/${encodeURIComponent(
        code,
      )}/${encodeURIComponent(name)}?${q}`,
    );
    if (!res.ok) return empty;
    const j = (await res.json()) as Partial<ApproachEntries>;
    return {
      airport: j.airport ?? code,
      name: j.name ?? name,
      entries: j.entries ?? [],
      matching: j.matching ?? [],
    };
  } catch {
    return empty;
  }
}

/**
 * Re-cache a flight's download export from a CLIENT-modified trajectory (e.g.
 * after a CD&R resolution is applied), so the download files served by
 * /api/download/{flight_key}.{ext} (and the zip/combined bundles) reflect the
 * POST-fix path instead of the original. Best-effort: a failure (offline API,
 * flight never generated server-side) just leaves the previous export in place.
 */
/**
 * Register a trajectory loaded AS-IS from an uploaded file (a previously
 * downloaded, possibly post-CD&R-fix export) as a server-cached export, so its
 * download files serve exactly the imported path — no regeneration. Returns the
 * server flight_key + absolute download URLs, or null on failure (offline API).
 */
export async function ingestTrajectory(input: {
  callsign: string;
  aircraftType?: string;
  adep?: string;
  ades?: string;
  depRwy?: string;
  arrRwy?: string;
  sid?: string;
  star?: string;
  approach?: string;
  routeStr?: string;
  rfl?: number;
  points: {
    lat: number;
    lon: number;
    epoch_ts: string;
    altitude_ft: number | null;
    gs_kt: number;
    tas_kt?: number | null;
    track_deg: number;
    phase: string;
  }[];
  /** Named route fixes recovered from the file's `waypoint` column. */
  fixes?: { ident: string; lat: number; lon: number }[];
}): Promise<{
  flightKey: string;
  downloads: { gpkg: string; csv: string; geojson: string };
} | null> {
  try {
    const res = await fetch(`${API_BASE}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callsign: input.callsign,
        aircraft_type: input.aircraftType ?? "",
        adep: input.adep ?? "",
        ades: input.ades ?? "",
        dep_rwy: input.depRwy ?? "",
        arr_rwy: input.arrRwy ?? "",
        sid: input.sid ?? "",
        star: input.star ?? "",
        approach: input.approach ?? "",
        route_str: input.routeStr ?? "",
        rfl: input.rfl ?? 0,
        points: input.points.map((p) => ({
          lat: p.lat,
          lon: p.lon,
          epoch_ts: p.epoch_ts,
          altitude_ft: p.altitude_ft,
          gs_kt: p.gs_kt,
          tas_kt: p.tas_kt ?? null,
          track_deg: p.track_deg,
          phase: p.phase,
        })),
        fixes: (input.fixes ?? []).map((f) => ({
          ident: f.ident,
          lat: f.lat,
          lon: f.lon,
        })),
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const abs = (u: string) => `${API_BASE}${u}`;
    return {
      flightKey: String(j.flight_key),
      downloads: {
        gpkg: abs(j.downloads.gpkg),
        csv: abs(j.downloads.csv),
        geojson: abs(j.downloads.geojson),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Attach (or clear) the unresolved loss-of-separation windows of one or more
 * flights, so their downloaded files flag the timestamps at which minima are
 * lost. Sent right before a download: the marks are derived from the CURRENT
 * (post-fix) trajectories, and a flight whose conflict has been resolved posts
 * an empty span list, which drops any mark left on an earlier export.
 */
export async function setConflictMarks(
  marks: { flight_key: string; spans: unknown[] }[],
): Promise<boolean> {
  if (marks.length === 0) return true;
  try {
    const res = await fetch(`${API_BASE}/api/conflict_marks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marks }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function recacheTrajectory(
  flightKey: string,
  points: {
    lat: number;
    lon: number;
    epoch_ts: string;
    altitude_ft: number | null;
    gs_kt: number;
    tas_kt?: number | null;
    track_deg: number;
    phase: string;
  }[],
): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/recache`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flight_key: flightKey,
        points: points.map((p) => ({
          lat: p.lat,
          lon: p.lon,
          epoch_ts: p.epoch_ts,
          altitude_ft: p.altitude_ft,
          gs_kt: p.gs_kt,
          tas_kt: p.tas_kt ?? null,
          track_deg: p.track_deg,
          phase: p.phase,
        })),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
