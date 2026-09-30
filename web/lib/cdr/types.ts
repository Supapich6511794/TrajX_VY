/**
 * Shared CD&R engine types. Kept UI-free so the whole detection/resolution
 * core stays pure and unit-testable; the React layer (useCdr, panels, overlay)
 * imports from here but nothing here imports React or Leaflet.
 */

import type { ManeuverType } from "./config";
import type { Interval } from "./cpa";

/** One point on an aircraft's REAL future path, `dt` seconds from now. Sampled
 *  from the precomputed trajectory (not a straight-line guess), so it follows
 *  the actual route turns, climbs and descents. */
export interface FutureSample {
  dt: number; // seconds from now (dt=0 is the current position)
  lat: number;
  lon: number;
  altFt: number;
}

/** State of one aircraft for the detection engine: the instantaneous vector
 *  (for display + the resolution what-if's straight maneuver legs) PLUS its real
 *  future path over the look-ahead. Detection walks `future` rather than
 *  extrapolating the instantaneous velocity, which is what makes it accurate
 *  through turns and level-offs. `future[0]` is the current position. */
export interface CdrAircraft {
  /** Stable identity (the app's flightKey). */
  id: string;
  callsign: string;
  type: string;
  lat: number;
  lon: number;
  altFt: number;
  /** Ground speed (kt) and track (° clockwise from north). */
  gsKt: number;
  trackDeg: number;
  /** Vertical speed, ft/min (+climb / −descent). Derived by the hook from the
   *  altitude samples; 0 in level cruise. */
  vsFpm: number;
  /** Real future positions over the look-ahead, on the config step grid. */
  future: FutureSample[];
}

/** Severity of a detected conflict (Doc 4444 Ch.8 alerting concept). */
export type Severity = "LOS" | "STCA" | "MTCD";

/** Urgency ordering — lower number = more urgent. Used to sort conflicts and to
 *  decide when a severity change counts as an escalation. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  LOS: 0,
  STCA: 1,
  MTCD: 2,
};

/** One detected conflict between an ordered pair of aircraft, as produced by a
 *  single detection pass. Lifecycle state (NEW/ACTIVE/…) is layered on top of
 *  this by lib/cdr/lifecycle.ts — this record is the raw geometric snapshot. */
export interface Conflict {
  /** Stable id: the two ids sorted and joined, so the same pair keeps one id
   *  across ticks regardless of which came first. */
  id: string;
  /** The pair, sorted so `a` < `b` (matches the id ordering). */
  a: string;
  b: string;
  severity: Severity;
  /** Time to closest point of approach (s); negative once CPA has passed. */
  tCpa: number;
  /** Horizontal separation at CPA (NM). */
  dCpa: number;
  /** Vertical separation at CPA (ft). */
  vSepAtCpaFt: number;
  /** Current horizontal / vertical separation right now (t=0). */
  hSepNowNm: number;
  vSepNowFt: number;
  /** Seconds until minima are actually lost (≤0 = already lost). Null when the
   *  pair only ever breaches the advisory buffer, never the hard minima. */
  tToLosSec: number | null;
  /** The hard-minima conflict window (bare S_h/S_v), when one exists. */
  losWindow: Interval | null;
  /** Minima applied to THIS pair (NM / ft), for the "% of minima" readout. */
  shNm: number;
  svFt: number;
  /** dCpa as a percentage of the horizontal minimum (100% = exactly at minima). */
  pctOfMinima: number;
}

/** The concrete new flight parameter a maneuver sets, used both by the what-if
 *  simulation and to reconstruct the modified trajectory for Preview/Apply. */
export interface ManeuverResolution {
  /** Absolute new ground track (°) — set by heading and direct-to maneuvers. */
  headingDeg?: number;
  /** Target level (ft) — set by flight-level maneuvers. */
  altFt?: number;
  /** New ground speed (kt) — set by speed maneuvers. */
  gsKt?: number;
  /** Target fix — set by direct-to maneuvers. */
  directTo?: { ident: string; lat: number; lon: number };
  /** Holding pattern to fly one loop of — set by HOLD maneuvers. All fields are
   *  the published AIP holding parameters at the fix. */
  hold?: {
    ident: string;
    lat: number;
    lon: number;
    inboundCourseDeg: number;
    turn: "L" | "R";
    /** One straight-leg duration (s) and the holding ground speed (kt). */
    legSec: number;
    gsKt: number;
  };
  /** Seconds to push the departure back — set by ATFM ground-delay "maneuvers". */
  delaySec?: number;
}

/** A resolution the controller has APPLIED to a conflict — recorded so the
 *  Dashboard can show which conflicts have been dealt with, and with what. */
export interface AppliedFix {
  /** The conflict id this fix was applied to. */
  conflictId: string;
  /** The pair (flightKeys), for labelling after the conflict has cleared. */
  a: string;
  b: string;
  /** The maneuvered aircraft (flightKey) and the instruction applied. */
  target: string;
  instruction: string;
  /** Sim second the fix was applied. */
  appliedAtSec: number;
  // --- Optional resolution detail (populated for auto-resolve, for the
  //     "what changed, from → to" readout when the toast is clicked). ---
  maneuverType?: ManeuverType;
  targetCallsign?: string;
  reason?: string;
  /** Horizontal CPA to the partner before → after the fix (NM). */
  beforeSepNm?: number;
  afterSepNm?: number;
  /** Vertical separation at CPA before → after (ft). */
  beforeVertFt?: number;
  afterVertFt?: number;
  // --- Route snapshots, captured at apply time so the ✓ Fixed rows can redraw
  //     the pair on the map long after the trajectory has moved on. ---
  /** The path the flight WOULD have flown (pre-fix) and the one it flies now. */
  beforePath?: { lat: number; lon: number }[];
  afterPath?: { lat: number; lon: number }[];
  /** The maneuvered parameter as it was before the fix, pre-formatted
   *  ("FL140", "460 kt", "072°"). The "from" half of the hover readout. */
  fromLabel?: string;
  /** The ATS unit the fix was issued in, captured at apply time — the airspace
   *  moves on, but who was responsible does not. */
  sector?: string;
  /** The pair were with different units, so it needed coordination. */
  sectorCoordination?: boolean;
}

/** A candidate resolution maneuver produced by the advisory engine. */
export interface Maneuver {
  type: ManeuverType;
  /** The aircraft (id) that would be instructed. */
  target: string;
  /** Human instruction, e.g. "Turn right 15°", "Climb to FL370", "Reduce 20 kt". */
  instruction: string;
  /** Signed change, in the maneuver's natural unit (deg / ft / kt / waypoint#). */
  value: number;
  /** Concrete new parameter(s) for the what-if + Preview/Apply. */
  resolution: ManeuverResolution;
  /** Predicted post-maneuver horizontal separation at CPA (NM). */
  newDCpaNm: number;
  /** The original (pre-maneuver) d_CPA, so the card can show "2.1 → 6.3 NM". */
  origDCpaNm: number;
  /** Extra track distance the maneuver adds (NM, negative = shortcut) and rough
   *  added time (s). */
  extraDistanceNm: number;
  extraTimeSec: number;
  /** Absolute heading change / level change magnitude, for the cost + display. */
  trackDeviationDeg: number;
  altChangeFt: number;
  /** Ranking cost (lower = better) from the weighted cost function. */
  cost: number;
}
