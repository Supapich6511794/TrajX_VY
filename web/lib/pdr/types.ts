/**
 * Shared types for the PDR (Prohibited / Danger / Restricted) conflict check.
 *
 * Kept UI-free — like lib/cdr/types.ts — so the whole analysis stays pure and
 * unit-testable, and the React panel is the only piece that knows about React.
 *
 * The vocabulary here follows the AIP: an *area* is a published volume (R13
 * SHANTE), its *activity* is the timetable that says when it is hot, and an
 * *incursion* is a stretch of a planned route that is inside one while it is.
 */

import type { RestrictedArea } from "@/lib/cdr/constraints";

/** Area classes carried by AIP Myanmar ENR 5.1 / the AIXM export.
 *  TRA (temporary reserved) has no polygon in the PDR overlay, but its
 *  schedule is published, so the type allows it for completeness. */
export type PdrKind = "P" | "R" | "D" | "TRA";

/** One AIXM `Timesheet` — a slice of the week an area is active for.
 *
 *  Times are clock strings ("01:00", and "24:00" for end-of-day) OR solar
 *  events, never both: `startEvent`/`endEvent` carry "SR" (sunrise) / "SS"
 *  (sunset), which only resolve to a clock time once the date and the area's
 *  position are known. `excluded` inverts the sheet — it carves time OUT of
 *  the others rather than adding to them (e.g. MON–FRI 0130–0930 *except*
 *  public holidays). */
export interface Timesheet {
  /** ICAO day code: MON…SUN, plus ANY (every day) and HOL (public holidays). */
  day: string;
  /** End of an inclusive day span ("MON".."FRI"); null for a single day. */
  dayTil: string | null;
  start: string | null;
  end: string | null;
  startEvent: string | null;
  endEvent: string | null;
  excluded: boolean;
  timeReference: string;
}

/** The published activity record for one area, as extracted from the AIXM
 *  export by `scripts/extract_aixm_restricted_areas.py`. */
export interface PdrActivity {
  designator: string;
  type: PdrKind;
  name: string;
  sheets: Timesheet[];
  /** Free-text fallback for schedules that do not reduce to a timesheet —
   *  almost always "Notified by NOTAM". */
  activityNote: string;
  restriction: string;
  hazard: string;
  remarks: string;
}

/** `/data/VY_AIP/pdr_activity.json` (AIP Myanmar ENR 5.1). */
export interface PdrActivityFile {
  source: string;
  validFrom: string;
  validTo: string;
  areas: PdrActivity[];
}

/** A PDR polygon joined to its published timetable — the unit everything in
 *  this module works with. Geometry and the vertical band come from the AIP
 *  PDR overlay (`restrictedAreasFrom`), the schedule from the AIXM export. */
export interface PdrArea extends RestrictedArea {
  /** null when the polygon has no matching AIXM record: the area is then
   *  treated as permanently active, which is the safe reading. */
  activity: PdrActivity | null;
  /** Polygon centroid — where sunrise/sunset are computed for a solar
   *  schedule, and what the panel points the map at. */
  centroid: { lat: number; lon: number };
  /** Bounding box [minLon, minLat, maxLon, maxLat], precomputed so the
   *  point-in-polygon test can be skipped for the overwhelming majority of
   *  samples. Checking a whole traffic day against ~110 area polygons is otherwise a
   *  ray-cast per sample per area over some very detailed rings. */
  bbox: [number, number, number, number];
}

/** Whether an area is hot at a given instant.
 *
 *  `unknown` is a first-class answer and must not be collapsed into either of
 *  the others: "Notified by NOTAM" and "except public holidays" are real
 *  published schedules that this app has no data to evaluate, and saying so is
 *  more useful to a controller than a confident guess. */
export type ActivityState = "active" | "inactive" | "unknown";

export interface ActivityVerdict {
  state: ActivityState;
  /** The published schedule, printed ("MON–FRI 0100–0900 UTC"). */
  schedule: string;
  /** Why this instant lands inside/outside it. */
  detail: string;
  /** A HOL (public holiday) sheet bears on the answer and there is no holiday
   *  calendar in the app, so the verdict is conditional on the date not being
   *  one. Surfaced rather than silently ignored. */
  holidayCaveat: boolean;
}

/** One point on a route being checked. `timeMs` is absolute UTC epoch ms — the
 *  schedule is a wall-clock rule, so it can only be evaluated against a real
 *  date and time, not an elapsed offset. */
export interface TimedPoint {
  lat: number;
  lon: number;
  altFt: number;
  timeMs: number;
}

/** A stretch of the planned route that lies inside one area's volume. */
export interface PdrIncursion {
  area: PdrArea;
  /** Absolute UTC epoch ms of the first and last sample inside the volume. */
  entryMs: number;
  exitMs: number;
  /** Altitude band actually flown through the area (ft). */
  minAltFt: number;
  maxAltFt: number;
  /** Track distance flown inside the volume (NM). Ranks incursions and tells a
   *  0.3 NM corner clip from a 20 NM transit. */
  transitNm: number;
  /** Activity evaluated at entry, and again at exit when the two disagree —
   *  a long transit can straddle a schedule boundary. */
  activityAtEntry: ActivityVerdict;
  activityAtExit: ActivityVerdict;
  /** The worst state over the crossing: active beats unknown beats inactive. */
  worstState: ActivityState;
}
