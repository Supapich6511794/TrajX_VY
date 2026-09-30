"use client";

/**
 * useSimPlayback — drives the aircraft animation along a generated
 * trajectory.
 *
 * The trajectory points carry ISO timestamps every ~4 simulated seconds.
 * This hook converts them to an elapsed-seconds timeline and advances a
 * `simT` clock in real time multiplied by `speed` (x1 = real time, x200 =
 * 200× faster). Position/heading at the current `simT` are linearly
 * interpolated between the two bracketing samples.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Phase, TrajectoryPoint } from "@/lib/trajectory/types";

// x200 is there for the 24-hour traffic sets: a full day of movements runs in
// ~7 min of wall clock instead of ~15.
export type SimSpeed = 1 | 2 | 5 | 20 | 50 | 100 | 200;
export const SIM_SPEEDS: SimSpeed[] = [1, 2, 5, 20, 50, 100, 200];

export interface AircraftState {
  lat: number;
  lon: number;
  /** Heading in degrees (for icon rotation). */
  track: number;
  /** Altitude (ft) if present in the data, else null. */
  altitudeFt: number | null;
  /** Ground speed (kt). */
  gsKt: number;
  /** True airspeed (kt) — Phase-3 variable speed; null on legacy data. */
  tasKt: number | null;
  /** Current flight phase (climb/cruise/descent). */
  phase: Phase;
}

interface Sample extends AircraftState {
  /** Seconds since the first point. */
  t: number;
}

export interface SimPlayback {
  aircraft: AircraftState | null;
  /** Current sim clock (seconds since start). */
  simT: number;
  /** Total trajectory duration (seconds). */
  total: number;
  /** UTC epoch (ms) the clock's t=0 sits on — the first sample's timestamp.
   *  Lets the bar read out the dataset's own UTC time rather than elapsed
   *  seconds. Null when the points carry no parseable stamp. */
  originMs: number | null;
  playing: boolean;
  speed: SimSpeed;
  /** Whether a trajectory is loaded and animatable. */
  ready: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  reset: () => void;
  setSpeed: (s: SimSpeed) => void;
  /** Scrub to an absolute time (seconds). */
  seek: (t: number) => void;
}

/** Total elapsed seconds of a trajectory (last epoch − first epoch). This is
 *  the real flight duration the playback clock runs to — use it for arrival
 *  checks rather than the rounded `stats.timeMinutes`, which can exceed it. */
/** Durations by point array (never mutated — a change replaces the array).
 *  Several per-frame paths ask for every flight's duration, and each call
 *  parsed two ISO timestamps. */
const durationCache = new WeakMap<TrajectoryPoint[], number>();

export function totalSeconds(points: TrajectoryPoint[] | undefined): number {
  if (!points || points.length < 2) return 0;
  const hit = durationCache.get(points);
  if (hit !== undefined) return hit;
  const sec =
    (new Date(points[points.length - 1].epoch_ts).getTime() -
      new Date(points[0].epoch_ts).getTime()) /
    1000;
  durationCache.set(points, sec);
  return sec;
}

// Sample tables are derived purely from the point array, so they are cached
// against it. This matters at scale: `samplesByIdx`-style memos live in three
// places (map, MapApp, CD&R) and all rebuild when the trajectory ARRAY changes
// — which an applied CD&R fix does on every Apply, even though it replaces one
// flight. Without the cache a 599-flight set re-parsed ~600k ISO timestamps
// three times per Apply, which is what froze the tab. Keyed on the array
// identity, so a replaced flight is the only one recomputed.
const sampleCache = new WeakMap<TrajectoryPoint[], Sample[]>();

/** Build the elapsed-seconds sample table for a trajectory (memoised on the
 *  point array — see `sampleCache`). */
export function toSamples(points: TrajectoryPoint[] | undefined): Sample[] {
  if (!points || points.length === 0) return [];
  const cached = sampleCache.get(points);
  if (cached) return cached;
  const t0 = new Date(points[0].epoch_ts).getTime();
  const out = points.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    track: p.track_deg,
    altitudeFt: p.altitude_ft,
    gsKt: p.gs_kt,
    tasKt: p.tas_kt ?? null,
    phase: p.phase,
    t: (new Date(p.epoch_ts).getTime() - t0) / 1000,
  }));
  sampleCache.set(points, out);
  return out;
}

/** Interpolate aircraft state at elapsed time `t` (pure; reusable per
 *  trajectory for the multi-route animation). */
export function aircraftAt(
  samples: Sample[],
  t: number,
): AircraftState | null {
  if (samples.length === 0) return null;
  const total = samples[samples.length - 1].t;
  if (t <= 0) return samples[0];
  if (t >= total) return samples[samples.length - 1];

  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.t - a.t || 1;
  const f = (t - a.t) / span;
  // Interpolate GS / TAS between samples so the cockpit readouts ramp
  // smoothly through the speed transitions (e.g. 250 → 290 → Mach 0.78).
  const lerp = (x: number, y: number) => x + (y - x) * f;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    track: a.track,
    altitudeFt:
      a.altitudeFt != null && b.altitudeFt != null
        ? a.altitudeFt + (b.altitudeFt - a.altitudeFt) * f
        : a.altitudeFt,
    gsKt: lerp(a.gsKt, b.gsKt),
    tasKt:
      a.tasKt != null && b.tasKt != null
        ? lerp(a.tasKt, b.tasKt)
        : a.tasKt ?? b.tasKt ?? null,
    // Phase is discrete — pick the active band (lower bracket).
    phase: a.phase,
  };
}

export function useSimPlayback(
  points: TrajectoryPoint[] | undefined,
): SimPlayback {
  // Build the elapsed-time sample table once per trajectory.
  const samples = useMemo<Sample[]>(() => toSamples(points), [points]);

  const total = samples.length ? samples[samples.length - 1].t : 0;
  const ready = samples.length > 1;

  // The replay clock runs on the data's own UTC, not wall time: t=0 is the
  // first sample's timestamp, so simT + originMs is the stamp the exported
  // track rows are keyed by.
  const originMs = useMemo<number | null>(() => {
    const iso = points?.[0]?.epoch_ts;
    const ms = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  }, [points]);

  const [simT, setSimT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SimSpeed>(1);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // Reset the clock whenever a new trajectory is loaded.
  useEffect(() => {
    setSimT(0);
    setPlaying(false);
  }, [samples]);

  useEffect(() => {
    if (!playing) return;

    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dtReal = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;

      let reachedEnd = false;
      setSimT((prev) => {
        const nextT = prev + dtReal * speed;
        if (nextT >= total) {
          reachedEnd = true;
          return total;
        }
        return nextT;
      });

      if (reachedEnd) {
        setPlaying(false); // stop outside the updater; no reschedule
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [playing, speed, total]);

  // Interpolate aircraft state at the current simT.
  const aircraft = useMemo<AircraftState | null>(
    () => aircraftAt(samples, simT),
    [samples, simT],
  );

  const play = useCallback(() => {
    if (!ready) return;
    // Restart if parked at the end.
    setSimT((t) => (t >= total ? 0 : t));
    setPlaying(true);
  }, [ready, total]);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(
    () => (playing ? setPlaying(false) : play()),
    [playing, play],
  );
  const reset = useCallback(() => {
    setPlaying(false);
    setSimT(0);
  }, []);
  const seek = useCallback(
    (t: number) => setSimT(Math.max(0, Math.min(total, t))),
    [total],
  );

  return {
    aircraft,
    simT,
    total,
    originMs,
    playing,
    speed,
    ready,
    play,
    pause,
    toggle,
    reset,
    setSpeed,
    seek,
  };
}
