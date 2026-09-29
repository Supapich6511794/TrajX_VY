/** Shared types for the in-browser Phase 1 trajectory generator. */

/** Flight phase along the vertical profile (mirrors performance.Phase). */
export type Phase = "climb" | "cruise" | "descent";

/** One ordered point on a resolved route (lat/lon in WGS-84 degrees). */
export interface RouteWaypoint {
  ident: string;
  lat: number;
  lon: number;
}

/** One emitted trajectory sample (matches the Python output schema). */
export interface TrajectoryPoint {
  lat: number;
  lon: number;
  /** ISO-8601 UTC timestamp. */
  epoch_ts: string;
  /** Altitude in feet (Phase 2). Null when no vertical profile applied. */
  altitude_ft: number | null;
  gs_kt: number;
  /** Phase-3: true airspeed in kt. Null on the legacy constant-speed path. */
  tas_kt?: number | null;
  track_deg: number;
  phase: Phase;
}

/** Summary metrics shown to the user after generation. */
export interface TrajectoryStats {
  waypointCount: number;
  pointCount: number;
  distanceNm: number;
  timeMinutes: number;
  /** Cruise altitude actually reached (feet). May be less than the
   *  requested FL when the leg is too short to climb that high. */
  cruiseAltFt: number | null;
  /** Requested Flight Level expressed in feet (FL330 → 33000). */
  rflFt: number;
}

/** Top-of-Climb or Top-of-Descent marker — null when the flight never
 *  reaches cruise altitude (too-short leg). */
export interface ProfilePoint {
  lat: number;
  lon: number;
  altitudeFt: number;
  epochTs: string;
}

/** Phase-3 planned-speed schedule for the airframe. */
export interface SpeedSchedule {
  climbCasKt: number;
  climbMach: number;
  cruiseMach: number;
  descentMach: number;
  descentCasKt: number;
  crossoverFt: number;
  belowFl100RestrictionKt: number;
}

/** One row of the climb / cruise / descent summary table. */
export interface PhaseBreakdownRow {
  avgTasKt: number | null;
  avgGsKt: number | null;
  timeMin: number | null;
}

/** Phase-3 per-phase aggregate stats. */
export interface PhaseBreakdown {
  climb: PhaseBreakdownRow;
  cruise: PhaseBreakdownRow;
  descent: PhaseBreakdownRow;
}

/** A SID/STAR crossing restriction's coded altitude (e.g. 9000 ft) and the
 *  phase it applies in, used to label the altitude-profile level-offs with the
 *  real restriction rather than the altitude the sim happened to level at. */
export interface CrossingConstraint {
  phase: string; // "climb" | "descent"
  altFt: number;
}

/** Vertical-profile waypoints surfaced for map markers + chart. */
export interface VerticalProfileMeta {
  toc: ProfilePoint | null;
  tod: ProfilePoint | null;
  speedSchedule?: SpeedSchedule;
  phaseBreakdown?: PhaseBreakdown;
  constraints?: CrossingConstraint[];
}

/** Server-side flight-time validation result (graded by the engine), null
 *  when the engine produced none. Not displayed in the UI. */
export interface FlightTimeValidation {
  route: string;
  cat62Min: number;
  simulatedMin: number;
  deltaMin: number;
  thresholdMin: number;
  status: "PASS" | "FAIL";
  passed: boolean;
  /** "cat62" = real reference sample; "estimate" = distance-based. */
  source: "cat62" | "estimate";
}

/** Full result of a generation run. */
export interface TrajectoryResult {
  /** Resolved route used (for map markers + listing). */
  route: RouteWaypoint[];
  /** Interpolated samples. */
  points: TrajectoryPoint[];
  stats: TrajectoryStats;
  /** Vertical-profile waypoints (TOC/TOD), null until a profile is built. */
  profile: VerticalProfileMeta;
  /** CAT62 flight-time check, null when the pair has no reference. */
  validation: FlightTimeValidation | null;
  /** Metadata echoed into exports. */
  meta: {
    flightKey: string;
    callsign: string;
    aircraftType: string;
    adep: string;
    ades: string;
    eobtIso: string;
    /** Resolved terminal selection, echoed by the server — departure as well
     *  as arrival, since a SID climb-out is a different path from a DCT. */
    sid?: string;
    depRwy?: string;
    star?: string;
    /** Ident of the STAR's first fix on this route — where the arrival begins.
     *  The route is a flat ident list, so this is the only way to tell which of
     *  its fixes the arrival procedure contributed. */
    starEntry?: string;
    approach?: string;
    /** Landing runway and its threshold — what arrival sequencing measures
     *  spacing against. The client has no runway database of its own. */
    arrRwy?: string;
    arrThreshold?: { lat: number; lon: number };
    /** Does the STAR end in radar vectors? Only then can this arrival be given
     *  a "maintain heading" resolution (Doc 4444 §8.9.3.6). */
    starOpen?: boolean;
    /** The published vector heading in °TRUE — the geometry. */
    vectorHeadingDeg?: number;
    /** The same heading in °MAGNETIC, exactly as the chart prints it. This is
     *  the one that goes into an instruction: a controller says "maintain
     *  heading 015", never the true course behind it. */
    vectorHeadingMagDeg?: number;
    /** Was this trajectory generated ON vectors rather than the procedure? */
    vectored?: boolean;
    /** The ATC clearance the arrival was flown under. An approach is never
     *  entered without one, so BOTH flows carry it — e.g. "DIRECT <IAF>,
     *  CLEARED R21 APPROACH" or "AFTER <fix> MAINTAIN HEADING 015, VECTORS
     *  R21". */
    clearance?: string;
  };
}
