/**
 * Display formatting for CD&R — shared by the toast, the conflict list and the
 * suggestion cards so the same numbers read identically everywhere. Pure and
 * UI-free (no React), just string helpers over engine values.
 */

import type { ManeuverType } from "./config";
import type { Conflict, Severity } from "./types";

/** Full-word severity label for headings/ARIA. */
export const SEVERITY_LABEL: Record<Severity, string> = {
  LOS: "Loss of separation",
  STCA: "Short-term alert",
  MTCD: "Predicted conflict",
};

/** A signed seconds value as a mm:ss countdown: "1:23", "now", "0:12 ago". */
export function fmtCountdown(sec: number | null): string {
  if (sec == null) return "—";
  if (sec <= 0 && sec > -1) return "now";
  const past = sec < 0;
  const s = Math.round(Math.abs(sec));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  const body = `${mm}:${ss}`;
  return past ? `${body} ago` : body;
}

/** Horizontal separation, 1 decimal NM. */
/** Non-finite = the two never share the sky (e.g. after a ground delay). */
export const fmtNm = (nm: number): string =>
  Number.isFinite(nm) ? `${nm.toFixed(1)} NM` : "no encounter";

/** Vertical separation, rounded to 100 ft. */
export const fmtFt = (ft: number): string => `${Math.round(ft / 100) * 100} ft`;

/** A flight level from feet, e.g. 37000 → "FL370". */
export const fmtFL = (ft: number): string =>
  `FL${String(Math.round(ft / 100)).padStart(3, "0")}`;

/** The "from" half of a before → after readout: the value the maneuver actually
 *  changed, as it was just before the fix, formatted for that maneuver kind
 *  ("FL140", "460 kt", "072°"). Null when the state is unknown or the maneuver
 *  has no single scalar parameter (route / hold). */
export function fmtFromValue(
  type: ManeuverType | undefined,
  st: { altitudeFt: number | null; gsKt: number; track: number } | null,
): string | null {
  if (!st || !type) return null;
  if (type === "flightlevel") {
    return st.altitudeFt == null ? null : fmtFL(st.altitudeFt);
  }
  if (type === "speed") return `${Math.round(st.gsKt)} kt`;
  if (type === "heading") {
    const deg = ((Math.round(st.track) % 360) + 360) % 360;
    return `${String(deg).padStart(3, "0")}°`;
  }
  return null;
}

/** Toast headline for a new/escalated conflict. `nameOf` maps a flightKey to a
 *  human callsign; falls back to the raw key. The toast is sticky, so the body
 *  stays QUALITATIVE (no frozen countdown) — the live count-down to LoS is shown
 *  in the Conflict View, which updates every tick. */
export function conflictHeadline(
  c: Conflict,
  nameOf: (id: string) => string,
): { title: string; body: string } {
  const pair = `${nameOf(c.a)} ↔ ${nameOf(c.b)}`;
  const title = `${c.severity} · ${pair}`;
  const when =
    c.severity === "LOS"
      ? "Separation lost now"
      : c.severity === "STCA"
        ? "Loss of separation imminent"
        : "Predicted loss of separation";
  const body = `${when} · CPA ${fmtNm(c.dCpa)} / ${fmtFt(c.vSepAtCpaFt)}`;
  return { title, body };
}
