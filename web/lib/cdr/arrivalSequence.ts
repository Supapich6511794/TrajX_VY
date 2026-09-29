/**
 * Arrival sequencing — the landing order for each runway, and how much
 * in-trail spacing each succeeding pair is short of.
 *
 * WHY THIS IS NOT THE CPA DETECTOR. `detect.ts` finds *closing* pairs: it walks
 * two future paths and solves for the closest point of approach. Two arrivals in
 * trail on one final approach track fly nearly parallel tracks at nearly equal
 * speeds, so their separation barely changes — the CPA is flat and far away, and
 * the pair never surfaces as a conflict. They are still unlandable if the gap is
 * under the minimum. That case is governed by a different rule (Doc 4444
 * §8.9.4.3, which makes the controller responsible for §8.7.3 separation
 * "between succeeding aircraft on the same final approach"), so it needs a
 * different computation: order the arrivals, then check each consecutive gap.
 *
 * WHAT "SPACING" MEANS HERE. The reported spacing for a pair is the follower's
 * remaining track distance at the instant the leader crosses the threshold —
 * i.e. how far behind it actually is, measured along the path it will fly. That
 * is exact and assumes nothing about speed. When one of the two runs past the
 * end of the projected window the pair falls back to a time-gap estimate
 * (gap × final ground speed) and is flagged `estimated`.
 *
 * The required spacing is the largest of:
 *   · the radar minimum — 2.5 NM once both are established on the same final
 *     approach track within 10 NM of the threshold (§8.7.3.2 b), otherwise the
 *     ordinary position-dependent minimum (3 NM in a reduced-minimum TMA —
 *     see `REDUCED_TERMINAL_SEP_TMAS` — else 5 NM);
 *   · the wake turbulence minimum for the leader/follower category pair
 *     (§8.7.3.4, e.g. 5 NM for a MEDIUM behind a HEAVY);
 *   · runway occupancy, converted to distance at the follower's final speed.
 *
 * `deficitNm` is what the extra track miles have to absorb — the input to a
 * speed reduction, a downwind extension, or a hold. Pure and UI-free.
 */

import {
  sepMinNmAtPos,
  wakeMinimumNm,
  type CdrConfig,
} from "./config";
import type { FutureSample } from "./types";
import { wakeCategoryOf, isKnownWakeType, type WakeCategory } from "./wake";

/** One arrival offered to the sequencer. `future` is the same projected path
 *  the detector uses (dt=0 is now), truncated at touchdown. */
export interface ArrivalInput {
  /** Stable identity (the app's flightKey). */
  id: string;
  callsign: string;
  /** ICAO type designator — drives the wake category. */
  type: string;
  /** Destination aerodrome and landing runway: arrivals sequence per runway. */
  ades: string;
  arrRwy: string;
  /** Departure aerodrome and the STAR being flown, for the strip readout: which
   *  flow an aircraft is on is part of reading a landing order, not decoration.
   *  Both are optional — a flight can arrive with no coded STAR (direct). */
  adep?: string;
  star?: string;
  /** Landing runway threshold. Without it the flight cannot be sequenced. */
  threshold: { lat: number; lon: number } | null;
  /** Projected path from now to touchdown, on the detector's step grid. */
  future: FutureSample[];
  /** Current ground speed (kt) and track (°) — used for the "established on
   *  final" test and as the speed fallback for an out-of-window estimate. */
  gsKt: number;
  trackDeg: number;
  /** Approach ground speed (kt), when the caller knows it. Preferred over
   *  deriving it from the projected path: a generated trajectory's positions
   *  and its reported speed can disagree on the final descent, and the
   *  reported speed is the one the performance model actually flies. */
  finalGsKt?: number;
}

/** One arrival, placed in its runway's landing order. */
export interface SequencedArrival {
  id: string;
  callsign: string;
  type: string;
  /** Where it came from / where it is landing, and the STAR it is flying —
   *  carried through from the input so the ladder row can name the flow. */
  adep?: string;
  ades: string;
  star?: string;
  wake: WakeCategory;
  /** False when `type` is not in the wake table, so `wake` is an assumption. */
  wakeKnown: boolean;
  /** Seconds from now until it crosses the threshold. */
  etaSec: number;
  /** Track distance still to fly to the threshold (NM). */
  distToGoNm: number;
  /** Ground speed over the last projected leg (kt) — the approach speed. */
  finalGsKt: number;
  /** 1-based place in this runway's landing order. */
  position: number;
  /** True when the projected path ended before the threshold, so `etaSec` is
   *  extrapolated at the current ground speed rather than measured. */
  etaEstimated: boolean;
  /** Established on the final approach track RIGHT NOW — inside the §8.7.3.2 b)
   *  distance and tracking at the threshold. A status readout for the strip;
   *  the reduced 2.5 NM minimum is gated on the same test applied at the
   *  instant the pair's spacing is evaluated, not on this. */
  establishedOnFinal: boolean;
}

/** Which rule set the requirement for a pair — shown to the controller so the
 *  number is explainable rather than a bare threshold. */
export type SpacingDriver = "radar" | "wake" | "runway-occupancy";

/** The gap between one arrival and the one landing immediately before it. */
export interface ArrivalPairSpacing {
  leader: SequencedArrival;
  follower: SequencedArrival;
  /** Time between the two threshold crossings (s). */
  gapSec: number;
  /** Follower's remaining track distance when the leader lands (NM). */
  spacingNm: number;
  /** Largest of the applicable minima (NM), and which one that was. */
  requiredNm: number;
  requiredBy: SpacingDriver;
  /** Every applicable minimum, for the breakdown in the UI. */
  minima: { radarNm: number; wakeNm: number; runwayOccupancyNm: number };
  /** How far short the pair is (NM); 0 when the spacing is sufficient. */
  deficitNm: number;
  /** `spacingNm` came from a time-gap estimate, not the projected paths. */
  estimated: boolean;
}

/** The landing order and pair spacing for one runway. */
export interface RunwayStream {
  ades: string;
  runway: string;
  arrivals: SequencedArrival[];
  pairs: ArrivalPairSpacing[];
  /** Pairs that are short of their minimum, worst deficit first. */
  deficits: ArrivalPairSpacing[];
}

const NM_PER_DEG_LAT = 60;

function nmBetween(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = (bLat - aLat) * NM_PER_DEG_LAT;
  const dLon =
    (bLon - aLon) * NM_PER_DEG_LAT * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function bearingDeg(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dl = ((bLon - aLon) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Cumulative track distance (NM) at each future sample, from dt=0. */
function cumulativeNm(future: FutureSample[]): number[] {
  const cum = [0];
  for (let i = 1; i < future.length; i++) {
    cum.push(
      cum[i - 1] +
        nmBetween(
          future[i - 1].lat,
          future[i - 1].lon,
          future[i].lat,
          future[i].lon,
        ),
    );
  }
  return cum;
}

/**
 * Where the projected path reaches the threshold: the sample closest to it,
 * plus the track distance and time to get there. When the path ends still short
 * of the threshold (the projection window ran out), the remaining straight-line
 * distance is added and the time extrapolated at the closing speed — flagged so
 * callers know the ETA is not measured.
 */
function toThreshold(
  future: FutureSample[],
  cum: number[],
  threshold: { lat: number; lon: number },
  gsKt: number,
): { etaSec: number; distToGoNm: number; estimated: boolean } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < future.length; i++) {
    const d = nmBetween(future[i].lat, future[i].lon, threshold.lat, threshold.lon);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const measuredNm = cum[best];
  const measuredSec = future[best].dt;
  // Closest approach is the LAST sample and it is still well short of the
  // threshold => the window truncated the path before touchdown.
  const truncated = best === future.length - 1 && bestD > 1;
  if (!truncated) {
    return { etaSec: measuredSec, distToGoNm: measuredNm, estimated: false };
  }
  const speed = gsKt > 1 ? gsKt : 1;
  return {
    etaSec: measuredSec + (bestD / speed) * 3600,
    distToGoNm: measuredNm + bestD,
    estimated: true,
  };
}

/** Window (s) the approach speed is averaged over. A single leg is far too
 *  fragile: the last sample of a generated trajectory is snapped onto the
 *  threshold, so one pair can imply several hundred knots. */
const FINAL_SPEED_WINDOW_S = 60;

/** Approach ground speed (kt) — what converts a time gap into a distance, and
 *  what runway occupancy is measured at. Averaged over the last minute of the
 *  projected path rather than taken from its final leg. */
function finalGsKtOf(
  future: FutureSample[],
  cum: number[],
  gsKt: number,
): number {
  const n = future.length;
  if (n < 2) return gsKt;
  const end = future[n - 1].dt;
  let i = n - 2;
  while (i > 0 && end - future[i].dt < FINAL_SPEED_WINDOW_S) i--;
  const dt = end - future[i].dt;
  if (dt <= 0) return gsKt;
  const derived = ((cum[n - 1] - cum[i]) / dt) * 3600;
  return derived > 1 ? derived : gsKt;
}

/** Position, track and remaining track distance at time `t` along a projected
 *  path. Null when `t` is past the end of the projection. */
function stateAt(
  future: FutureSample[],
  cum: number[],
  totalNm: number,
  t: number,
): {
  lat: number;
  lon: number;
  altFt: number;
  trackDeg: number;
  distToGoNm: number;
} | null {
  const last = future[future.length - 1].dt;
  if (t > last || future.length < 2) return null;
  const i = Math.max(
    1,
    future.findIndex((s) => s.dt >= Math.max(0, t)),
  );
  if (i <= 0) return null;
  const span = future[i].dt - future[i - 1].dt || 1;
  const f = Math.min(1, Math.max(0, (t - future[i - 1].dt) / span));
  const travelled = cum[i - 1] + (cum[i] - cum[i - 1]) * f;
  return {
    lat: future[i - 1].lat + (future[i].lat - future[i - 1].lat) * f,
    lon: future[i - 1].lon + (future[i].lon - future[i - 1].lon) * f,
    altFt: future[i - 1].altFt + (future[i].altFt - future[i - 1].altFt) * f,
    // Track over the leg being flown at that instant.
    trackDeg: bearingDeg(
      future[i - 1].lat,
      future[i - 1].lon,
      future[i].lat,
      future[i].lon,
    ),
    distToGoNm: Math.max(0, totalNm - travelled),
  };
}

/** Is this state established on the final approach track — inside the
 *  §8.7.3.2 b) distance from the threshold AND tracking at it? */
function isEstablished(
  cfg: CdrConfig,
  state: { lat: number; lon: number; trackDeg: number },
  threshold: { lat: number; lon: number },
): boolean {
  const d = nmBetween(state.lat, state.lon, threshold.lat, threshold.lon);
  if (d > cfg.finalApproach.reducedWithinNm) return false;
  // Over the threshold the bearing to it is a zero-length vector and carries no
  // direction — an aircraft at the touchdown point is established by definition.
  if (d < 0.1) return true;
  const brg = bearingDeg(state.lat, state.lon, threshold.lat, threshold.lon);
  return (
    angleDiffDeg(state.trackDeg, brg) <= cfg.finalApproach.establishedToleranceDeg
  );
}

/** A sequenced arrival plus the working data the pair measurement needs. */
interface Sequenced extends SequencedArrival {
  threshold: { lat: number; lon: number };
  /** Established on the final approach track at its OWN threshold crossing —
   *  i.e. it flew a final approach rather than arriving off a turn. */
  establishedAtLanding: boolean;
  _future: FutureSample[];
  _cum: number[];
}

function sequenceOne(cfg: CdrConfig, a: ArrivalInput): Sequenced | null {
  if (!a.threshold || a.future.length < 1) return null;
  const cum = cumulativeNm(a.future);
  const { etaSec, distToGoNm, estimated } = toThreshold(
    a.future,
    cum,
    a.threshold,
    a.gsKt,
  );
  // Current position is dt=0 on the projected path; its track comes from the
  // input (the aircraft's instantaneous track), not from the sample spacing.
  const now = a.future[0];
  const nowState = { lat: now.lat, lon: now.lon, trackDeg: a.trackDeg };
  // Its own geometry at touchdown: the last projected leg. A flight whose
  // projection ends short can't be shown to be established, so it is not.
  const landing = estimated
    ? null
    : stateAt(a.future, cum, distToGoNm, etaSec) ??
      (a.future.length >= 2
        ? {
            lat: a.threshold.lat,
            lon: a.threshold.lon,
            trackDeg: bearingDeg(
              a.future[a.future.length - 2].lat,
              a.future[a.future.length - 2].lon,
              a.future[a.future.length - 1].lat,
              a.future[a.future.length - 1].lon,
            ),
            distToGoNm: 0,
          }
        : null);
  return {
    id: a.id,
    callsign: a.callsign,
    type: a.type,
    adep: a.adep,
    ades: a.ades,
    star: a.star,
    wake: wakeCategoryOf(a.type, cfg.wake.unknownTypeCategory),
    wakeKnown: isKnownWakeType(a.type),
    etaSec,
    distToGoNm,
    finalGsKt: a.finalGsKt && a.finalGsKt > 1
      ? a.finalGsKt
      : finalGsKtOf(a.future, cum, a.gsKt),
    position: 0, // assigned after sorting
    etaEstimated: estimated,
    establishedOnFinal: isEstablished(cfg, nowState, a.threshold),
    establishedAtLanding: landing
      ? isEstablished(cfg, landing, a.threshold)
      : false,
    threshold: a.threshold,
    _future: a.future,
    _cum: cum,
  };
}

/**
 * Order every arrival into its runway's landing sequence and measure each
 * succeeding pair against the applicable minima.
 *
 * Flights without a threshold, a runway, or a projected path are skipped —
 * they cannot be sequenced, and guessing a position would be worse than
 * leaving them out.
 */
export function sequenceArrivals(
  cfg: CdrConfig,
  inputs: ArrivalInput[],
): RunwayStream[] {
  const byRunway = new Map<string, ArrivalInput[]>();
  for (const a of inputs) {
    if (!a.threshold || !a.arrRwy || a.future.length < 1) continue;
    const key = `${a.ades}/${a.arrRwy}`;
    byRunway.set(key, [...(byRunway.get(key) ?? []), a]);
  }

  const streams: RunwayStream[] = [];
  for (const [key, list] of byRunway) {
    const [ades, runway] = key.split("/");
    const seq = list
      .map((a) => sequenceOne(cfg, a))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((x, y) => x.etaSec - y.etaSec);
    seq.forEach((s, i) => {
      s.position = i + 1;
    });

    const pairs: ArrivalPairSpacing[] = [];
    for (let i = 1; i < seq.length; i++) {
      pairs.push(measurePair(cfg, seq[i - 1], seq[i]));
    }
    const arrivals = seq.map(strip);
    streams.push({
      ades,
      runway,
      arrivals,
      pairs,
      deficits: pairs
        .filter((p) => p.deficitNm > 0)
        .sort((a, b) => b.deficitNm - a.deficitNm),
    });
  }
  return streams.sort((a, b) =>
    `${a.ades}${a.runway}`.localeCompare(`${b.ades}${b.runway}`),
  );
}

/** Drop the working fields so only the public shape is published. */
function strip(s: Sequenced): SequencedArrival {
  const {
    threshold: _t,
    establishedAtLanding: _e,
    _future,
    _cum,
    ...rest
  } = s;
  return rest;
}

function measurePair(
  cfg: CdrConfig,
  leader: Sequenced,
  follower: Sequenced,
): ArrivalPairSpacing {
  const gapSec = follower.etaSec - leader.etaSec;

  // Preferred measure: where the follower actually is along its own path when
  // the leader crosses the threshold. Needs both ETAs to be measured, not
  // extrapolated, and the leader's landing to fall inside the follower's window.
  const atLanding =
    leader.etaEstimated || follower.etaEstimated
      ? null
      : stateAt(
          follower._future,
          follower._cum,
          follower.distToGoNm,
          leader.etaSec,
        );
  const estimated = atLanding === null;
  const spacingNm = estimated
    ? (gapSec * follower.finalGsKt) / 3600
    : atLanding.distToGoNm;

  // Radar minimum. §8.7.3.2 b) is a condition AT THE POINT OF EVALUATION, so
  // it is tested where the pair actually is when the leader lands — not where
  // the follower happens to be right now, which may be an hour upstream. The
  // leader is at the threshold by definition; the follower must be inside the
  // §8.7.3.2 b) distance and tracking the same final approach track. Falls
  // back to the ordinary position-dependent minimum whenever that is not so
  // (or when the spacing had to be estimated, since then the geometry at the
  // evaluation instant is unknown).
  const bothEstablished =
    !estimated &&
    leader.establishedAtLanding &&
    isEstablished(cfg, atLanding, follower.threshold);
  // The minimum is position-dependent (3 NM inside a reduced-minimum TMA, 5 NM
  // en-route), so it must be resolved WHERE THE PAIR IS when the spacing is
  // measured — the follower's position at the leader's touchdown, which is in
  // the terminal area. Reading it at the follower's CURRENT position would
  // charge an arrival still an hour out the en-route 5 NM for a gap it will
  // only ever have on final. Falls back to the current position when the
  // spacing had to be estimated (the evaluation instant is then unknown).
  const at = atLanding ?? follower._future[0];
  const radarNm = bothEstablished
    ? cfg.finalApproach.reducedNm
    : sepMinNmAtPos(cfg, at.lat, at.lon, at.altFt);

  const wakeNm = wakeMinimumNm(cfg, leader.type, follower.type);
  const runwayOccupancyNm =
    (cfg.finalApproach.runwayOccupancySec * follower.finalGsKt) / 3600;

  let requiredNm = radarNm;
  let requiredBy: SpacingDriver = "radar";
  if (wakeNm > requiredNm) {
    requiredNm = wakeNm;
    requiredBy = "wake";
  }
  if (runwayOccupancyNm > requiredNm) {
    requiredNm = runwayOccupancyNm;
    requiredBy = "runway-occupancy";
  }

  return {
    leader: strip(leader),
    follower: strip(follower),
    gapSec,
    spacingNm,
    requiredNm,
    requiredBy,
    minima: { radarNm, wakeNm, runwayOccupancyNm },
    deficitNm: Math.max(0, requiredNm - spacingNm),
    estimated,
  };
}
