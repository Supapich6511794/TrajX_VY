/**
 * Conflict alert tones — synthesised with the Web Audio API so no audio assets
 * ship with the app. Each severity gets a distinct, escalating signature:
 *   LOS  — three urgent high beeps
 *   STCA — two mid beeps
 *   MTCD — one soft low beep
 *
 * The AudioContext is created lazily (browsers block it until a user gesture,
 * which the Play button provides) and reused. All of this is a no-op on the
 * server and degrades silently if Web Audio is unavailable or muted.
 */

import type { Severity } from "./types";

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** One short sine blip at `freq` Hz starting `at` seconds from now. */
function blip(c: AudioContext, freq: number, at: number, dur: number, gain: number) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t0 = c.currentTime + at;
  // Short attack/decay envelope so beeps don't click.
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Per-severity tone signature: [frequency Hz, beep count, gap seconds]. */
const TONES: Record<Severity, { freq: number; beeps: number; gap: number }> = {
  LOS: { freq: 1000, beeps: 3, gap: 0.16 },
  STCA: { freq: 760, beeps: 2, gap: 0.18 },
  MTCD: { freq: 520, beeps: 1, gap: 0 },
};

/* --------------------------------------------------------------------------
   Volume — a user preference, 0..1, kept in localStorage. 0.5 is the default
   and maps to the original fixed blip gain (0.14), so an untouched setting
   sounds exactly as it always did; 1 doubles it.
   -------------------------------------------------------------------------- */

const VOLUME_KEY = "trajx.alertVolume";
const DEFAULT_VOLUME = 0.5;
const MAX_GAIN = 0.28;

let volume = DEFAULT_VOLUME;
let volumeLoaded = false;
const listeners = new Set<(v: number) => void>();

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
}

/** Current alert volume, 0..1. Reads the saved value on first call. */
export function getAlertVolume(): number {
  if (!volumeLoaded && typeof window !== "undefined") {
    volumeLoaded = true;
    try {
      const raw = window.localStorage.getItem(VOLUME_KEY);
      if (raw !== null) volume = clamp01(Number(raw));
    } catch {
      // Storage blocked — keep the default.
    }
  }
  return volume;
}

/** Set (and persist) the alert volume, 0..1. 0 mutes the alerts. */
export function setAlertVolume(v: number): void {
  volume = clamp01(v);
  volumeLoaded = true;
  try {
    window.localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Storage blocked — the value still holds for this session.
  }
  listeners.forEach((fn) => fn(volume));
}

/** Subscribe to volume changes; returns the unsubscribe. */
export function onAlertVolume(fn: (v: number) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Play the alert tone for a severity at the user's volume. Volume 0 or
 *  `muted` → silent; safe to call anywhere. */
export function playAlert(severity: Severity, muted = false): void {
  const v = getAlertVolume();
  if (muted || v <= 0) return;
  const c = audioCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  const { freq, beeps, gap } = TONES[severity];
  const dur = 0.11;
  for (let i = 0; i < beeps; i++) blip(c, freq, i * (dur + gap), dur, v * MAX_GAIN);
}
