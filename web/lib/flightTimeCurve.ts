/**
 * flightTimeCurve — client helper for predicting a candidate route's flight
 * time in the route picker.
 *
 * A distance→time curve for ONE airframe at ONE cruise level is served by the
 * API (GET /api/flight_time_curve) and interpolated locally, so the picker can
 * show a predicted time on every candidate without a round-trip per route and
 * can never disagree with the server about what a flight "should" take.
 *
 * The curve comes from the aircraft's own Thai APM performance, and an
 * airframe with no Thai APM data of its own returns `supported: false`
 * rather than a 737 curve wearing its name — there is nothing here to fall
 * back to.
 */

import { API_BASE } from "@/lib/api";

// --- Aircraft-specific flight-time curve ----------------------------------

/** A distance→time curve for one airframe at one cruise level. */
export interface FlightTimeCurve {
  aircraftType: string;
  /** Sampled [distanceNm, minutes] pairs, ascending by distance. */
  points: ReadonlyArray<readonly [number, number]>;
  /** Terminal-area margin (minutes) the server reports with the curve. */
  marginMin: number;
  /** Performance dataset the curve was derived from. */
  dataset: string;
}

/** Why no curve is available for a type — surfaced instead of guessing. */
export interface UnsupportedCurve {
  aircraftType: string;
  reason: string;
}

export type FlightTimeCurveResult = FlightTimeCurve | UnsupportedCurve;

export function isSupportedCurve(
  c: FlightTimeCurveResult | null,
): c is FlightTimeCurve {
  return c != null && "points" in c && c.points.length > 0;
}

/** Fetch the curve for one airframe + cruise level.
 *
 *  `cruiseAltFt` is the planned level; the server clamps it to the type's
 *  reachable ceiling. Pass null to get the curve at that ceiling.
 */
export function fetchFlightTimeCurve(
  aircraftType: string,
  cruiseAltFt: number | null,
): Promise<FlightTimeCurveResult> {
  const ac = aircraftType.trim().toUpperCase();
  const qs = new URLSearchParams({ actype: ac });
  if (cruiseAltFt != null) qs.set("cruise_alt_ft", String(cruiseAltFt));
  return fetch(`${API_BASE}/api/flight_time_curve?${qs}`, {
    cache: "no-store",
  })
    .then((r) => {
      if (!r.ok) throw new Error(`flight_time_curve ${r.status}`);
      return r.json();
    })
    .then((j): FlightTimeCurveResult => {
      if (!j.supported) {
        return {
          aircraftType: ac,
          reason: String(j.reason ?? "no performance data for this type"),
        };
      }
      return {
        aircraftType: String(j.aircraft_type ?? ac),
        points: (j.points ?? []) as ReadonlyArray<readonly [number, number]>,
        marginMin: Number(j.margin_min ?? 3),
        dataset: String(j.dataset ?? ""),
      };
    })
    .catch((e): UnsupportedCurve => ({ aircraftType: ac, reason: String(e) }));
}

/** Predicted simulated flight time (minutes) for a route distance —
 *  piecewise-linear interpolation of the airframe's own curve, extrapolating
 *  along the final segment beyond the table. */
export function estimateSimMin(
  curve: FlightTimeCurve,
  distanceNm: number,
): number {
  const t = curve.points;
  const d = Math.max(0, distanceNm);
  if (t.length === 0) return 0;
  if (t.length === 1 || d <= t[0][0]) return t[0][1];
  for (let i = 0; i < t.length - 1; i++) {
    const [d0, t0] = t[i];
    const [d1, t1] = t[i + 1];
    if (d <= d1) return t0 + ((t1 - t0) * (d - d0)) / (d1 - d0);
  }
  const [d0, t0] = t[t.length - 2];
  const [d1, t1] = t[t.length - 1];
  return t1 + ((t1 - t0) / (d1 - d0)) * (d - d1);
}
