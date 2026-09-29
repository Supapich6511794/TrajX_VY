/**
 * Aerodrome transition altitudes / levels — AIP Myanmar Table 3.6, built into
 * `/data/VY_AIP/transition_altitudes.json` by `scripts/build_vy_aip.py`.
 *
 * Myanmar publishes a TA/TL per aerodrome (4 000 ft at Pathein/Sittwe up to
 * 17 000 ft at Putao), not one FIR-wide value, so altitude-vs-flight-level
 * depends on which aerodrome the flight is climbing out of or descending into.
 */

const URL = "/data/VY_AIP/transition_altitudes.json";

/** Used when an aerodrome has no Table 3.6 entry (e.g. Kyauktu, or a foreign
 *  field) — the app's historical display threshold. */
export const FALLBACK_TRANSITION_FT = 10000;

export interface TransitionEntry {
  icao: string;
  aerodrome: string;
  transition_altitude_ft: number | null;
  transition_altitude_m: number | null;
  transition_level_fl: number | null;
  transition_level_m: number | null;
  note?: string;
}

export type TransitionTable = Map<string, TransitionEntry>;

let _cache: Promise<TransitionTable> | null = null;

/** Fetch + memoise the table. A missing file yields an empty table, so every
 *  lookup falls back to {@link FALLBACK_TRANSITION_FT}. */
export function fetchTransitionTable(): Promise<TransitionTable> {
  if (!_cache) {
    _cache = fetch(URL, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { aerodromes: [] }))
      .then((d: { aerodromes: TransitionEntry[] }) =>
        new Map(d.aerodromes.map((e) => [e.icao.toUpperCase(), e])),
      )
      .catch(() => new Map());
  }
  return _cache;
}

/** Transition altitude (ft) of an aerodrome, or null when unpublished. */
export function transitionAltitudeFt(table: TransitionTable, icao: string | null | undefined): number | null {
  return (icao && table.get(icao.toUpperCase())?.transition_altitude_ft) || null;
}

/** Transition level of an aerodrome in feet (FL × 100), or null. */
export function transitionLevelFt(table: TransitionTable, icao: string | null | undefined): number | null {
  const fl = icao ? table.get(icao.toUpperCase())?.transition_level_fl : null;
  return fl ? fl * 100 : null;
}

/**
 * The altitude at or above which a flight reads its height as a flight level.
 * Climbing (and cruising) uses the departure aerodrome's TA; descending uses
 * the destination's TL, per ICAO Doc 8168 altimeter-setting practice.
 */
export function flightLevelThresholdFt(
  table: TransitionTable,
  phase: "climb" | "cruise" | "descent" | null | undefined,
  adep: string | null | undefined,
  ades: string | null | undefined,
): number {
  const ft =
    phase === "descent" ? transitionLevelFt(table, ades) : transitionAltitudeFt(table, adep);
  return ft ?? FALLBACK_TRANSITION_FT;
}
