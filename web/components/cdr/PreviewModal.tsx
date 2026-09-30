"use client";

/**
 * PreviewModal — the before/after "Preview & fix" popup for one conflict.
 *
 * Opened from a dashboard row, it shows the two aircraft's paths around the
 * encounter with a short, scrubbable playback, lets the controller shape a
 * resolution (pick a ranked suggestion, or hand-edit heading / level / speed),
 * and previews the RESULT live: the maneuvered path is drawn white and the
 * resolved closest-approach distance updates as you edit. Apply commits it.
 *
 * The map is react-leaflet; the whole modal is loaded via next/dynamic(ssr:false)
 * from MapApp so Leaflet never runs on the server.
 */

import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  useMap,
} from "react-leaflet";

import { BASEMAPS } from "@/lib/mapPrefs";
import { fmtCountdown, fmtFt, fmtNm } from "@/lib/cdr/format";
import { applyManeuver, maneuverTiming } from "@/lib/cdr/kinematics";
import {
  pairConflict,
  pairSeparation,
  type PlanConflict,
  type PlanFlight,
} from "@/lib/cdr/planScan";
import {
  areaIdentsOnPath,
  evaluateConstraints,
  type PathPoint,
  type RestrictedArea,
} from "@/lib/cdr/constraints";
import type { CdrConfig, ManeuverType } from "@/lib/cdr/config";
import type { Blocker, PlanResolution } from "@/lib/cdr/planAdvisory";
import type { ConflictSector } from "@/lib/cdr/sector";
import type { Maneuver, ManeuverResolution } from "@/lib/cdr/types";
import { holdLegSec, holdLoopSec, type Holding } from "@/lib/holdings";
import type { TrajectoryResult } from "@/lib/trajectory/types";
import { aircraftAt, toSamples, totalSeconds, type AircraftState } from "@/lib/useSimPlayback";

import SectorChip from "./SectorChip";
import NavIcon from "@/components/nav/NavIcon";

interface Sample extends AircraftState { t: number }

interface Props {
  conflict: PlanConflict;
  trajA: TrajectoryResult; // conflict.a
  trajB: TrajectoryResult; // conflict.b
  offsetA: number;
  offsetB: number;
  simT: number; // current absolute clock (maneuver is applied from "now")
  /** Auto-generated ranked resolutions (with reason + score). */
  planSuggestions: PlanResolution[];
  /** Traffic that rejected every candidate, when none survived — names the
   *  aircraft to resolve first instead of leaving a dead end. */
  planBlockers?: Blocker[];
  /** The blocker's own conflict, when it has one — see SuggestionCards. */
  blockerConflictOf?: (b: Blocker) => string | null;
  /** Leave this conflict and go work the blocker instead. Closing the modal is
   *  the caller's job: it owns which conflict is selected. */
  onWorkBlocker?: (b: Blocker, conflictId: string | null) => void;
  /** Open the blocker's FLIGHT PLAN in the generator. The other way out of a
   *  blocked fix: when no maneuver on either aircraft clears it, the routing
   *  itself is what has to change. */
  onEditBlockerPlan?: (b: Blocker) => void;
  /** Set when this pair was SYNTHESISED from a blocker rather than scanned: the
   *  callsign that is in the way. The two are not in conflict on the current
   *  plan — the modal must not claim they are — and there is nothing for the
   *  advisory engine to resolve, so the manual controls are the whole point and
   *  open from the start. */
  blockerCallsign?: string;
  nameOf: (id: string) => string;
  config: CdrConfig;
  /** Every flight (for the constraint engine's re-check vs ALL traffic). */
  allFlights: PlanFlight[];
  /** Prohibited/Danger/Restricted areas for the airspace constraint. */
  restricted: RestrictedArea[];
  /** Published holdings by ident — enables the manual HOLD option. */
  holdings?: Map<string, Holding>;
  /** The ATS unit responsible for this conflict. Shown in the header because
   *  this is the screen the fix is actually issued from — the controller has
   *  to see whose airspace it is, and whether it needs coordinating. */
  sector?: ConflictSector | null;
  onApply: (
    m: Pick<Maneuver, "type" | "target" | "instruction" | "resolution"> & {
      /** Exact timing to apply the maneuver with (from the validated candidate),
       *  so the committed trajectory matches the preview. */
      timing?: { tManLocal: number; deviationSec: number; rejoinSec: number };
    },
  ) => void;
  onClose: () => void;
}

type EditType = Extract<
  ManeuverType,
  "heading" | "flightlevel" | "speed" | "hold"
>;

const norm360 = (d: number) => ((d % 360) + 360) % 360;

const TYPE_LABEL: Record<ManeuverType, string> = {
  heading: "HDG",
  flightlevel: "LVL",
  speed: "SPD",
  route: "DCT",
  hold: "HOLD",
  delay: "ATFM",
};

/** Compact cost string for a suggestion. */
function costLabel(r: PlanResolution): string {
  if (r.type === "flightlevel") {
    return `${r.altChangeFt > 0 ? "+" : "−"}${Math.abs(r.altChangeFt)} ft`;
  }
  const parts: string[] = [];
  if (Math.abs(r.extraDistanceNm) >= 0.1)
    parts.push(`${r.extraDistanceNm >= 0 ? "+" : "−"}${Math.abs(r.extraDistanceNm).toFixed(1)} NM`);
  if (Math.abs(r.extraTimeSec) >= 5)
    parts.push(`${r.extraTimeSec >= 0 ? "+" : "−"}${(Math.abs(r.extraTimeSec) / 60).toFixed(1)} min`);
  return parts.length ? parts.join(", ") : "negligible cost";
}

/** Sample a flight's path (lat/lon) over an absolute-time window. */
function pathOf(
  samples: Sample[],
  offset: number,
  t0: number,
  t1: number,
  step: number,
): L.LatLngExpression[] {
  const out: L.LatLngExpression[] = [];
  for (let t = t0; t <= t1; t += step) {
    const ac = aircraftAt(samples, t - offset);
    if (ac) out.push([ac.lat, ac.lon]);
  }
  return out;
}

/** Sample a flight's path with altitude (for the constraint checks). */
function pathWithAlt(
  samples: Sample[],
  offset: number,
  t0: number,
  t1: number,
  step: number,
): PathPoint[] {
  const out: PathPoint[] = [];
  for (let t = t0; t <= t1; t += step) {
    const ac = aircraftAt(samples, t - offset);
    if (ac && ac.altitudeFt != null) {
      out.push({ lat: ac.lat, lon: ac.lon, altFt: ac.altitudeFt });
    }
  }
  return out;
}

/** Fit the map to the drawn paths, re-fitting whenever the geometry changes
 *  (`sig`) — so switching to a Heading/Speed maneuver, whose resolved path can
 *  swing well away from the original route, keeps the white preview in view. */
function Fit({ pts, sig }: { pts: L.LatLngExpression[]; sig: string }) {
  const map = useMap();
  useEffect(() => {
    const b = L.latLngBounds(pts);
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return null;
}

export default function PreviewModal({
  conflict,
  trajA,
  trajB,
  offsetA,
  offsetB,
  simT,
  planSuggestions,
  planBlockers,
  blockerConflictOf,
  onWorkBlocker,
  onEditBlockerPlan,
  blockerCallsign,
  nameOf,
  config,
  allFlights,
  restricted,
  holdings,
  sector,
  onApply,
  onClose,
}: Props) {
  // Which aircraft is being maneuvered (default: whoever the top suggestion
  // targets, else the first of the pair).
  const [targetId, setTargetId] = useState(
    planSuggestions[0]?.target ?? conflict.a,
  );
  const isA = targetId === conflict.a;
  const targetTraj = isA ? trajA : trajB;
  const intrTraj = isA ? trajB : trajA;
  const targetOff = isA ? offsetA : offsetB;
  const intrOff = isA ? offsetB : offsetA;

  const targetSamples = useMemo(() => toSamples(targetTraj.points), [targetTraj]);
  const intrSamples = useMemo(() => toSamples(intrTraj.points), [intrTraj]);

  // Target state at the current clock (drives the editor's "now" readouts).
  const nowLocal = Math.max(0, simT - targetOff);
  const targetNow = aircraftAt(targetSamples, nowLocal);
  const curFL = targetNow?.altitudeFt != null ? Math.round(targetNow.altitudeFt / 100) : RFL_DEFAULT();
  const curGs = targetNow ? Math.round(targetNow.gsKt) : 450;
  const curTrk = targetNow ? Math.round(targetNow.track) : 0;

  // Editable resolution (manual mode).
  const [type, setType] = useState<EditType>("flightlevel");
  const [headingDelta, setHeadingDelta] = useState(20); // ° right (+) / left (−)
  const [targetFL, setTargetFL] = useState(curFL + 20); // FL
  const [speedDelta, setSpeedDelta] = useState(-30); // kt
  // A picked auto-suggestion (drives the resolution until the user hand-edits).
  // Route/direct suggestions can only be represented here, not by the sliders.
  const [picked, setPicked] = useState<PlanResolution | null>(null);
  // "What does 100 mean?" — the score legend, collapsed by default so it
  // explains itself on demand without pushing the list down every time.
  const [scoreHelp, setScoreHelp] = useState(false);

  // Reset the level target when the target aircraft changes.
  useEffect(() => {
    setTargetFL(curFL + 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  // EVERY published holding fix on the target's route ahead of the aircraft, in
  // route order — the user picks which one to hold at (empty → no holding fix on
  // this route, so the Hold button is disabled).
  const manualHoldOptions = useMemo(() => {
    if (!holdings || holdings.size === 0) return [];
    const t0Ms = new Date(targetTraj.points[0].epoch_ts).getTime();
    const nowLocal = Math.max(0, simT - targetOff);
    const seen = new Set<string>();
    const opts: {
      fix: Holding;
      tMan: number;
      loopMin: number;
      resolution: ManeuverResolution;
    }[] = [];
    for (const w of targetTraj.route) {
      const h = holdings.get(w.ident);
      if (!h || seen.has(w.ident)) continue;
      let bestT = 0;
      let bestD = Infinity;
      for (const p of targetTraj.points) {
        const d = (p.lat - w.lat) ** 2 + (p.lon - w.lon) ** 2;
        if (d < bestD) {
          bestD = d;
          bestT = (new Date(p.epoch_ts).getTime() - t0Ms) / 1000;
        }
      }
      if (bestT <= nowLocal + 30) continue; // must still be ahead
      seen.add(w.ident);
      const gsAtFix = aircraftAt(targetSamples, bestT)?.gsKt ?? curGs;
      opts.push({
        fix: h,
        tMan: bestT,
        loopMin: Math.round(holdLoopSec(h, gsAtFix) / 60),
        resolution: {
          hold: {
            ident: h.ident,
            lat: h.lat,
            lon: h.lon,
            inboundCourseDeg: h.inboundCourseDeg,
            turn: h.turn,
            legSec: holdLegSec(h, gsAtFix),
            gsKt: h.speedKt ?? gsAtFix,
          },
        } as ManeuverResolution,
      });
    }
    return opts;
  }, [holdings, targetTraj, targetSamples, simT, targetOff, curGs]);

  // Which holding fix the manual Hold targets (default: the first one ahead).
  const [holdIdent, setHoldIdent] = useState<string | null>(null);
  useEffect(() => {
    setHoldIdent(null); // reset when the target aircraft changes
  }, [targetId]);
  const manualHold =
    manualHoldOptions.find((o) => o.fix.ident === holdIdent) ??
    manualHoldOptions[0] ??
    null;

  // Manual resolution from the sliders.
  const manualResolution: ManeuverResolution = useMemo(() => {
    if (type === "heading") return { headingDeg: norm360(curTrk + headingDelta) };
    if (type === "speed") return { gsKt: Math.max(120, curGs + speedDelta) };
    if (type === "hold") return manualHold?.resolution ?? {};
    return { altFt: targetFL * 100 };
  }, [type, headingDelta, speedDelta, targetFL, curTrk, curGs, manualHold]);
  const manualInstruction = useMemo(() => {
    if (type === "heading")
      return `Turn ${headingDelta >= 0 ? "right" : "left"} ${Math.abs(headingDelta)}°`;
    if (type === "speed")
      return `${speedDelta < 0 ? "Reduce" : "Increase"} ${Math.abs(speedDelta)} kt`;
    if (type === "hold")
      return manualHold ? `Hold at ${manualHold.fix.ident}` : "Hold";
    return `${targetFL * 100 > (targetNow?.altitudeFt ?? 0) ? "Climb" : "Descend"} to FL${targetFL}`;
  }, [type, headingDelta, speedDelta, targetFL, targetNow, manualHold]);

  // Effective maneuver — resolution AND timing together. A picked suggestion
  // carries the EXACT timing it was validated with; reusing it (instead of
  // recomputing from the current track) is what keeps the preview/constraint
  // check identical to what the advisory verified. A manual heading is taken
  // relative to the track AT the turn point, not now.
  const eff = useMemo(() => {
    if (picked) {
      return {
        type: picked.type,
        resolution: picked.resolution,
        instruction: picked.instruction,
        tMan: picked.tManLocal,
        deviationSec: picked.deviationSec,
        rejoinSec: picked.rejoinSec,
        turnDeltaDeg: picked.type === "heading" ? picked.value : 0,
      };
    }
    if (type === "heading") {
      const prelim = maneuverTiming(
        curGs, curTrk, conflict.tCpaAbsSec, targetOff, simT,
        { type: "heading", resolution: { headingDeg: norm360(curTrk + headingDelta) } },
        config,
      );
      const st = aircraftAt(targetSamples, prelim.tMan);
      const trackBase = st?.track ?? curTrk;
      return {
        type: "heading" as ManeuverType,
        resolution: { headingDeg: norm360(trackBase + headingDelta) } as ManeuverResolution,
        instruction: manualInstruction,
        tMan: prelim.tMan,
        deviationSec: prelim.deviationSec,
        rejoinSec: prelim.rejoinSec,
        turnDeltaDeg: headingDelta,
      };
    }
    if (type === "hold") {
      // A hold is applied AT the fix (not "now") — use the fix's reach time.
      return {
        type: "hold" as ManeuverType,
        resolution: manualResolution,
        instruction: manualInstruction,
        tMan: manualHold?.tMan ?? 0,
        deviationSec: 0,
        rejoinSec: 0,
        turnDeltaDeg: 0,
      };
    }
    const t0 = maneuverTiming(
      curGs, curTrk, conflict.tCpaAbsSec, targetOff, simT,
      { type, resolution: manualResolution }, config,
    );
    return {
      type: type as ManeuverType,
      resolution: manualResolution,
      instruction: manualInstruction,
      tMan: t0.tMan,
      deviationSec: t0.deviationSec,
      rejoinSec: t0.rejoinSec,
      turnDeltaDeg: 0,
    };
  }, [
    picked, type, headingDelta, curGs, curTrk, targetSamples,
    conflict.tCpaAbsSec, targetOff, simT, config, manualResolution, manualInstruction,
    manualHold,
  ]);
  const effType: ManeuverType = eff.type;
  const resolution: ManeuverResolution = eff.resolution;
  const instruction = eff.instruction;

  // Pick a suggestion → drive the resolution + sync the sliders where possible.
  const useSuggestion = (r: PlanResolution) => {
    setPicked(r);
    setTargetId(r.target);
    if (r.type === "heading" && r.resolution.headingDeg != null) {
      setType("heading");
      setHeadingDelta(Math.round(r.value));
    } else if (r.type === "speed") {
      setType("speed");
      setSpeedDelta(Math.round(r.value));
    } else if (r.type === "flightlevel" && r.resolution.altFt) {
      setType("flightlevel");
      setTargetFL(Math.round(r.resolution.altFt / 100));
    }
  };
  // Any manual edit drops the picked suggestion (back to hand-tuning).
  const manualEdit = <T,>(setter: (v: T) => void) => (v: T) => {
    setPicked(null);
    setter(v);
  };

  // Auto-select the top suggestion when the modal opens.
  useEffect(() => {
    if (planSuggestions.length > 0) useSuggestion(planSuggestions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Maneuver timing comes from `eff` (the picked suggestion's validated timing,
  // or the manual editor's kinematic timing).
  const { tMan, deviationSec, rejoinSec } = eff;
  // Where the maneuvered flight sits on the shared clock. A ground delay moves
  // the whole flight later, and samples are timed from the flight's OWN first
  // point — so the delay lives here, not in the path. Using the original offset
  // re-checked the undelayed flight: "conflict persists" on a fix that clears.
  const afterOff = targetOff + (effType === "delay" ? (resolution.delaySec ?? 0) : 0);

  // The maneuvered trajectory + resolved separation (live).
  const afterTraj = useMemo(
    () =>
      applyManeuver(targetTraj, { type: effType, resolution }, tMan, {
        deviationSec,
        rejoinSec,
        bankAngleDeg: config.bankAngleDeg,
      }),
    [targetTraj, effType, resolution, tMan, deviationSec, rejoinSec, config.bankAngleDeg],
  );
  const afterSep = useMemo(() => {
    const A: PlanFlight = {
      id: targetId,
      callsign: "",
      samples: toSamples(afterTraj.points),
      offsetSec: afterOff,
      durationSec: totalSeconds(afterTraj.points),
    };
    const B: PlanFlight = {
      id: "intr",
      callsign: "",
      samples: intrSamples,
      offsetSec: intrOff,
      durationSec: totalSeconds(intrTraj.points),
    };
    return pairSeparation(A, B);
  }, [afterTraj, intrSamples, intrTraj, targetId, afterOff, intrOff]);

  // Playback / draw window. For a LATERAL maneuver the window spans from the
  // turn INITIATION point (so the white arc originates at the aircraft on its
  // route) through the rejoin — otherwise a far-future conflict clips the turn
  // origin and the line floats disconnected. Level/speed keep the route, so a
  // window around CPA is enough.
  const cpa = conflict.tCpaAbsSec;
  const isLateral = effType === "heading" || effType === "route";
  const manAbs = targetOff + tMan;
  const rejoinAbs = targetOff + tMan + deviationSec + rejoinSec;
  const winStart = isLateral
    ? Math.max(Math.max(offsetA, offsetB), manAbs - 45)
    : Math.max(Math.max(offsetA, offsetB), cpa - 240);
  const winEnd = isLateral ? rejoinAbs + 45 : cpa + 120;
  const [scrubT, setScrubT] = useState(cpa);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    const SPEED = 8; // preview plays at 8×
    const step = (ts: number) => {
      if (last.current == null) last.current = ts;
      const dt = ((ts - last.current) / 1000) * SPEED;
      last.current = ts;
      setScrubT((t) => (t + dt >= winEnd ? winStart : t + dt));
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      last.current = null;
    };
  }, [playing, winStart, winEnd]);

  // Drawn paths (windowed) + live positions at the scrub time.
  const STEP = 8;
  const beforeTargetPath = pathOf(targetSamples, targetOff, winStart, winEnd, STEP);
  const intrPath = pathOf(intrSamples, intrOff, winStart, winEnd, STEP);
  const afterTargetPath = pathOf(
    toSamples(afterTraj.points),
    afterOff,
    winStart,
    winEnd,
    STEP,
  );
  const fitPts = [...beforeTargetPath, ...intrPath, ...afterTargetPath];

  const posAt = (samples: Sample[], off: number): L.LatLngExpression | null => {
    const ac = aircraftAt(samples, scrubT - off);
    return ac ? [ac.lat, ac.lon] : null;
  };
  const afterTargetSamples = useMemo(() => toSamples(afterTraj.points), [afterTraj]);
  const pBeforeTarget = posAt(targetSamples, targetOff);
  const pIntr = posAt(intrSamples, intrOff);
  const pAfterTarget = posAt(afterTargetSamples, afterOff);

  const tiles = BASEMAPS.dark;
  const beforeD = conflict.dCpaNm;
  // A delayed flight may no longer share any airborne time with the partner —
  // no encounter at all, which `fmtNm` renders as such.
  const afterD = afterSep?.minHNm ?? (effType === "delay" ? Infinity : beforeD);
  const cleared = afterD >= conflict.shNm + 1; // minima + buffer

  // --- Resolution summary values -------------------------------------------
  const nmBetween = (a: L.LatLngExpression | null, b: L.LatLngExpression | null) => {
    if (!a || !b) return null;
    const [la1, lo1] = a as [number, number];
    const [la2, lo2] = b as [number, number];
    const R = 3440.065;
    const dLat = ((la2 - la1) * Math.PI) / 180;
    const dLon = ((lo2 - lo1) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((la1 * Math.PI) / 180) *
        Math.cos((la2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const acNowA = aircraftAt(targetSamples, Math.max(0, simT - targetOff));
  const acNowB = aircraftAt(intrSamples, Math.max(0, simT - intrOff));
  const currentSepNm =
    acNowA && acNowB
      ? nmBetween([acNowA.lat, acNowA.lon], [acNowB.lat, acNowB.lon])
      : null;
  const timeToCpa = conflict.tCpaAbsSec - simT;
  // A blocker pair is neither: they are clear on the plan as it stands, and the
  // reason this screen is open is that they would NOT be after a fix elsewhere.
  const severity = blockerCallsign
    ? "IN THE WAY"
    : conflict.definite
      ? "LOSS OF SEPARATION"
      : "PREDICTED";

  // --- Controller phraseology (from the effective maneuver) ----------------
  const callTgt = nameOf(targetId);
  const phraseology = (() => {
    if (effType === "route" && resolution.directTo) {
      return `${callTgt}, proceed direct ${resolution.directTo.ident}, then resume own navigation.`;
    }
    if (effType === "heading" && resolution.headingDeg != null) {
      const hdg = String(Math.round(resolution.headingDeg)).padStart(3, "0");
      const side = eff.turnDeltaDeg >= 0 ? "right" : "left";
      return `${callTgt}, turn ${side} heading ${hdg}, then resume own navigation.`;
    }
    if (effType === "delay" && resolution.delaySec != null) {
      // ATFM, not an RT clearance to an airborne aircraft: the flight is held
      // on the ground with a new off-block time.
      return `${callTgt}, expect departure delay ${Math.round(resolution.delaySec / 60)} minutes, new off-block time to follow.`;
    }
    if (effType === "speed" && resolution.gsKt != null) {
      return `${callTgt}, ${resolution.gsKt < curGs ? "reduce" : "increase"} speed to ${Math.round(resolution.gsKt)} knots.`;
    }
    const alt = resolution.altFt ?? curFL * 100;
    const climb = alt > (targetNow?.altitudeFt ?? 0);
    return `${callTgt}, ${climb ? "climb" : "descend"} and maintain FL${Math.round(alt / 100)}.`;
  })();

  // --- Constraint engine: airspace + performance + level + conflict re-check.
  const report = useMemo(() => {
    const afterPath = pathWithAlt(afterTargetSamples, afterOff, winStart, winEnd, 15);
    const beforePath = pathWithAlt(targetSamples, targetOff, winStart, winEnd, 15);
    const originalAreaIdents = areaIdentsOnPath(beforePath, restricted);
    // Re-check the maneuvered trajectory against EVERY other flight.
    const afterFlight: PlanFlight = {
      id: targetId,
      callsign: "",
      samples: afterTargetSamples,
      offsetSec: afterOff,
      durationSec: totalSeconds(afterTraj.points),
    };
    // 3-D re-check vs every other flight (a level change clears vertically even
    // though it stays horizontally close).
    //
    // The other half of THIS pair is kept separate from everyone else. Lumping
    // them together reported the conflict partner as a "secondary conflict",
    // which is the opposite of what it is: a secondary conflict is one the
    // maneuver CREATES, and the partner is the one it was supposed to remove.
    const partnerId = isA ? conflict.b : conflict.a;
    let clear = true;
    let tightestNm = Infinity;
    let unresolved: { callsign?: string; dCpaNm: number } | undefined;
    let secondary: { callsign?: string; dCpaNm: number; alsoCount?: number } | undefined;
    let otherCount = 0;
    for (const f of allFlights) {
      if (f.id === targetId) continue;
      const c = pairConflict(afterFlight, f, config);
      if (!c) continue;
      clear = false;
      if (c.dCpaNm < tightestNm) tightestNm = c.dCpaNm;
      if (f.id === partnerId) {
        unresolved = { callsign: f.callsign, dCpaNm: c.dCpaNm };
      } else {
        otherCount += 1;
        if (!secondary || c.dCpaNm < secondary.dCpaNm) {
          secondary = { callsign: f.callsign, dCpaNm: c.dCpaNm };
        }
      }
    }
    if (secondary) secondary.alsoCount = otherCount - 1;
    return evaluateConstraints({
      maneuverType: effType,
      resolution,
      cfg: config,
      afterPath,
      originalAreaIdents,
      restricted,
      trackDeg: curTrk,
      newGsKt: effType === "speed" ? resolution.gsKt : undefined,
      newAltFt: effType === "flightlevel" ? resolution.altFt : undefined,
      recheck: {
        clear,
        minSepNm: clear ? (afterSep?.minHNm ?? 99) : tightestNm,
        unresolved,
        secondary,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterTargetSamples, afterTraj, effType, resolution, restricted, allFlights, targetId, targetOff, afterOff, curTrk, config, winStart, winEnd, isA, conflict.a, conflict.b]);
  const rejected = report.verdict === "reject";

  // A maneuver that changes nothing (e.g. "Increase 0 kt") isn't a resolution —
  // block it from being applied.
  const isNoOp = (() => {
    if (effType === "speed")
      return resolution.gsKt != null && Math.abs(resolution.gsKt - curGs) < 1;
    if (effType === "flightlevel")
      return (
        resolution.altFt != null &&
        Math.abs(resolution.altFt - (targetNow?.altitudeFt ?? curFL * 100)) < 50
      );
    if (effType === "heading") return Math.abs(eff.turnDeltaDeg) < 1;
    if (effType === "delay") return !(resolution.delaySec && resolution.delaySec > 0);
    return false; // direct-to is always a real change
  })();
  const cannotApply = rejected || isNoOp;

  return (
    <div className="cdr-modal-backdrop" role="dialog" aria-modal="true">
      <div className="cdr-modal">
        <div className="cdr-modal-head">
          <strong>
            Preview &amp; fix — {nameOf(conflict.a)} ↔ {nameOf(conflict.b)}
          </strong>
          <SectorChip sector={sector} ids={conflict} nameOf={nameOf} />
          <button type="button" className="cdr-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cdr-modal-body">
          <div className="cdr-modal-map">
            <MapContainer
              center={[16.9, 96.13]}
              zoom={8}
              zoomControl={false}
              scrollWheelZoom
              preferCanvas
              style={{ height: "100%", width: "100%" }}
            >
              <TileLayer
                attribution={tiles.attribution}
                url={tiles.url}
                className={tiles.className}
              />
              {tiles.labelUrl && (
                <TileLayer url={tiles.labelUrl} className={tiles.labelClassName} />
              )}
              {/* Before: intruder (magenta) + target (cyan), dim. */}
              <Polyline positions={intrPath} pathOptions={{ color: "#f472b6", weight: 2, opacity: 0.55 }} />
              <Polyline positions={beforeTargetPath} pathOptions={{ color: "#22d3ee", weight: 2, opacity: 0.55 }} />
              {/* After: the maneuvered path, white dashed. */}
              <Polyline
                positions={afterTargetPath}
                pathOptions={{ color: "#f8fafc", weight: 2.5, opacity: 0.95, dashArray: "7 6" }}
              />
              {pIntr && (
                <CircleMarker center={pIntr} radius={5} pathOptions={{ color: "#f472b6", fillColor: "#f472b6", fillOpacity: 1, weight: 1 }} />
              )}
              {pBeforeTarget && (
                <CircleMarker center={pBeforeTarget} radius={5} pathOptions={{ color: "#22d3ee", fillColor: "#22d3ee", fillOpacity: 0.5, weight: 1 }} />
              )}
              {pAfterTarget && (
                <CircleMarker center={pAfterTarget} radius={5} pathOptions={{ color: "#f8fafc", fillColor: "#f8fafc", fillOpacity: 1, weight: 1 }} />
              )}
              {fitPts.length > 1 && (
                <Fit
                  pts={fitPts}
                  sig={`${targetId}-${effType}-${picked?.instruction ?? ""}-${headingDelta}-${targetFL}-${speedDelta}`}
                />
              )}
            </MapContainer>

            {/* Mini playback: scrub around the CPA + play. */}
            <div className="cdr-modal-play">
              <button type="button" onClick={() => setPlaying((p) => !p)} className="cdr-modal-playbtn">
                {playing ? "❚❚" : "▶"}
              </button>
              <input
                type="range"
                min={winStart}
                max={winEnd}
                step={1}
                value={scrubT}
                onChange={(e) => {
                  setPlaying(false);
                  setScrubT(Number(e.target.value));
                }}
              />
              <span className="cdr-modal-clock">
                CPA {Math.round((scrubT - cpa))}s
              </span>
            </div>
          </div>

          <div className="cdr-modal-controls">
            {/* Resolution summary. */}
            <div
              className={`cdr-modal-summary sev-${
                blockerCallsign ? "blk" : conflict.definite ? "los" : "prd"
              }`}
            >
              <div className="cdr-sum-sev">{severity}</div>
              <dl className="cdr-sum-grid">
                <div>
                  <dt>Current sep.</dt>
                  <dd>{currentSepNm != null ? fmtNm(currentSepNm) : "—"}</dd>
                </div>
                <div>
                  <dt>Time to CPA</dt>
                  <dd>{fmtCountdown(timeToCpa)}</dd>
                </div>
                <div>
                  <dt>Predicted CPA</dt>
                  <dd>{fmtNm(beforeD)}</dd>
                </div>
                <div>
                  <dt>Vert. @ CPA</dt>
                  <dd>{fmtFt(conflict.vSepAtCpaFt)}</dd>
                </div>
              </dl>
            </div>

            {/* Before → after outcome. */}
            <div className={`cdr-modal-outcome${cleared ? " ok" : " bad"}`}>
              d_CPA <b>{fmtNm(beforeD)}</b> → <b>{fmtNm(afterD)}</b>
              <span className="cdr-modal-verdict">{cleared ? "✓ clear" : "still tight"}</span>
            </div>

            {/* Auto-generated ranked resolutions. */}
            {planSuggestions.length > 0 ? (
              <div className="cdr-sugg">
                <div className="cdr-sugg-head">
                  <span>Suggested resolutions</span>
                  <button
                    type="button"
                    className="cdr-sugg-info"
                    aria-expanded={scoreHelp}
                    onClick={() => setScoreHelp((v) => !v)}
                    title="What the score means"
                  >
                    ⓘ What is the score?
                  </button>
                </div>
                {scoreHelp && (
                  <div className="cdr-sugg-help">
                    <p>
                      <b>100 = the least disruptive fix on this list.</b> The
                      cheapest option always scores 100 and every other one is
                      measured against it —{" "}
                      <code>100 × (best cost + 1) ÷ (this cost + 1)</code>. So
                      50 costs about twice the best, and 1 is ~100× as
                      disruptive.
                    </p>
                    <p>
                      Cost is what the maneuver takes away from the flight:
                      <b> 1</b> per degree off track, <b>2</b> per extra NM
                      flown, <b>3</b> per 1 000 ft of level change, plus a fixed
                      penalty for the kind of instruction — Speed <b>0</b>,
                      Level <b>10</b>, Heading <b>20</b>, Direct <b>30</b>, Hold{" "}
                      <b>40</b>. Speed control keeps the aircraft on its route
                      AND its level and just re-times the crossing, so it is the
                      cheapest; a hold is the dearest.
                    </p>
                    <p className="cdr-sugg-help-note">
                      The score is <b>relative to this conflict only</b> — it
                      ranks the options against each other, it is not a safety
                      rating. Every option shown already restores the separation
                      minima and passed the constraint check below.
                    </p>
                  </div>
                )}
                {planSuggestions.map((r, i) => {
                  const sel =
                    picked != null &&
                    picked.target === r.target &&
                    picked.instruction === r.instruction;
                  const outcome =
                    r.type === "flightlevel"
                      ? `vert ${fmtFt(r.origVertFt)} → ${fmtFt(r.newVertFt)}`
                      : `d_CPA ${fmtNm(r.origDCpaNm)} → ${fmtNm(r.newDCpaNm)}`;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`cdr-sugg-card${sel ? " sel" : ""}`}
                      onClick={() => useSuggestion(r)}
                    >
                      <div className="cdr-sugg-top">
                        <span className="cdr-sugg-rank">{i + 1}</span>
                        <span className={`cdr-card-type type-${r.type}`}>{TYPE_LABEL[r.type]}</span>
                        <span className="cdr-sugg-instr">
                          <strong>{nameOf(r.target)}</strong> {r.instruction}
                        </span>
                        <span
                          className={`cdr-sugg-score${r.score === 100 ? " best" : ""}`}
                          title={
                            r.score === 100
                              ? "Score 100 — the least disruptive option here; every other score is measured against this one."
                              : `Score ${r.score} of 100 — about ${(100 / r.score).toFixed(1)}× as disruptive as the best option on this list.`
                          }
                        >
                          {r.score}
                          <small>/100</small>
                        </span>
                      </div>
                      <div className="cdr-sugg-meta">
                        {outcome} · {costLabel(r)}
                      </div>
                      <div className="cdr-sugg-reason">{r.reason}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="cdr-adv-empty">
                <p>No automatic resolution found — adjust manually below.</p>
                {planBlockers?.[0] && (
                  <>
                    <p className="cdr-adv-blocked">
                      Every candidate would then conflict with{" "}
                      <b>{planBlockers[0].callsign}</b>
                      {Number.isFinite(planBlockers[0].tightestNm) &&
                        ` (${fmtNm(planBlockers[0].tightestNm)})`}
                      {planBlockers.length > 1 &&
                        ` +${planBlockers.length - 1} more`}
                      . Resolve {planBlockers[0].callsign} first, or override
                      below.
                    </p>
                    {/* Two ways out, because a blocker has two. Move it — level,
                        heading, speed or hold, checked like any other fix — or
                        change what it is doing, which is its flight plan. The
                        old single "Show X" button did neither: it panned the map
                        to the aircraft and stopped, naming the problem and
                        offering nothing to do about it. */}
                    <div className="cdr-adv-blocked-btns">
                      {onWorkBlocker && (
                        <button
                          type="button"
                          className="cdr-adv-blocked-btn"
                          onClick={() =>
                            onWorkBlocker(
                              planBlockers[0],
                              blockerConflictOf?.(planBlockers[0]) ?? null,
                            )
                          }
                          title={`Level, heading, speed or hold on ${planBlockers[0].callsign}`}
                        >
                          Fix {planBlockers[0].callsign} →
                        </button>
                      )}
                      {onEditBlockerPlan && (
                        <button
                          type="button"
                          className="cdr-adv-blocked-btn ghost"
                          onClick={() => onEditBlockerPlan(planBlockers[0])}
                          title={`Open ${planBlockers[0].callsign}'s filed route in the generator`}
                        >
                          Edit {planBlockers[0].callsign}&rsquo;s plan
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            <details className="cdr-manual" open={!!blockerCallsign}>
              <summary>
                {/* Both halves, blocker first. The OTHER one is whichever is
                    not the blocker — not "whichever is not the current target",
                    which named the blocker twice the moment the target defaulted
                    to the blocked aircraft. */}
                {blockerCallsign
                  ? `Move ${blockerCallsign} — or ${
                      nameOf(conflict.a) === blockerCallsign
                        ? nameOf(conflict.b)
                        : nameOf(conflict.a)
                    }`
                  : "Manual override"}
              </summary>

              {/* Which aircraft to maneuver. */}
              <div className="cdr-modal-field">
                <span>Maneuver</span>
                <div className="cdr-modal-seg">
                  <button type="button" className={isA ? "active" : ""} onClick={() => manualEdit(setTargetId)(conflict.a)}>
                    {nameOf(conflict.a)}
                  </button>
                  <button type="button" className={!isA ? "active" : ""} onClick={() => manualEdit(setTargetId)(conflict.b)}>
                    {nameOf(conflict.b)}
                  </button>
                </div>
              </div>

              {/* Maneuver type. */}
              <div className="cdr-modal-field">
                <span>Type</span>
                <div className="cdr-modal-seg">
                  {(["flightlevel", "heading", "speed"] as EditType[]).map((t) => (
                    <button key={t} type="button" className={!picked && type === t ? "active" : ""} onClick={() => manualEdit(setType)(t)}>
                      {t === "flightlevel" ? "Level" : t === "heading" ? "Heading" : "Speed"}
                    </button>
                  ))}
                  {/* Hold — only when a published holding fix lies ahead on the
                      target's route (else there's nothing to hold at). */}
                  <button
                    type="button"
                    className={!picked && type === "hold" ? "active" : ""}
                    disabled={!manualHold}
                    title={manualHold ? `Hold at ${manualHold.fix.ident}` : "No holding fix ahead on this route"}
                    onClick={() => manualEdit(setType)("hold")}
                  >
                    Hold
                  </button>
                </div>
              </div>

              {/* Value editor per type. */}
              {!picked && type === "flightlevel" && (
                <label className="cdr-modal-field">
                  <span>Target level · now FL{curFL}</span>
                  <div className="cdr-modal-stepper">
                    <button type="button" onClick={() => manualEdit(setTargetFL)(targetFL - 10)}>−</button>
                    <b>FL{targetFL}</b>
                    <button type="button" onClick={() => manualEdit(setTargetFL)(targetFL + 10)}>+</button>
                  </div>
                </label>
              )}
              {!picked && type === "heading" && (
                <label className="cdr-modal-field">
                  <span>Turn {headingDelta >= 0 ? "right" : "left"} {Math.abs(headingDelta)}°</span>
                  <input type="range" min={-60} max={60} step={5} value={headingDelta} onChange={(e) => manualEdit(setHeadingDelta)(Number(e.target.value))} />
                </label>
              )}
              {!picked && type === "speed" && (
                <label className="cdr-modal-field">
                  <span>Speed {speedDelta >= 0 ? "+" : ""}{speedDelta} kt · now {curGs}</span>
                  <input type="range" min={-40} max={40} step={10} value={speedDelta} onChange={(e) => manualEdit(setSpeedDelta)(Number(e.target.value))} />
                </label>
              )}
              {!picked && type === "hold" && manualHold && (
                <label className="cdr-modal-field">
                  <span>
                    Holding fix ({manualHoldOptions.length} on route) · one{" "}
                    {manualHold.loopMin}-min{" "}
                    {manualHold.fix.turn === "R" ? "right" : "left"}-hand loop
                  </span>
                  <select
                    value={manualHold.fix.ident}
                    onChange={(e) => manualEdit(setHoldIdent)(e.target.value)}
                  >
                    {manualHoldOptions.map((o) => (
                      <option key={o.fix.ident} value={o.fix.ident}>
                        Hold at {o.fix.ident} (inbound{" "}
                        {Math.round(o.fix.inboundCourseDeg)}°,{" "}
                        {o.fix.turn === "R" ? "right" : "left"})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </details>

            {/* Constraint check — every clearance is validated before Apply. */}
            <div className={`cdr-modal-constraints v-${report.verdict}`}>
              <div className="cdr-constraints-head">
                <span>Constraint check</span>
                <span className={`cdr-verdict v-${report.verdict}`}>
                  {report.verdict === "accept"
                    ? "✓ Accept"
                    : report.verdict === "caution"
                      ? "⚠ Caution"
                      : "✗ Reject"}
                </span>
              </div>
              <ul className="cdr-constraints-list">
                {report.checks.map((c, i) => (
                  <li key={i} className={`cdr-cx st-${c.status}`}>
                    <span className="cdr-cx-ico" aria-hidden>
                      {c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗"}
                    </span>
                    <span className="cdr-cx-text">
                      <span className="cdr-cx-label">{c.label}</span>
                      <span className="cdr-cx-detail">
                        {c.detail}
                        {c.source ? ` · ${c.source}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Controller phraseology for the chosen clearance. */}
            <div className="cdr-modal-phrase">
              <span className="cdr-phrase-label">
                <NavIcon name="clearance" size={13} /> Clearance
              </span>
              <span className="cdr-phrase-text">“{phraseology}”</span>
            </div>

            <div className="cdr-modal-actions">
              <button type="button" className="cdr-modal-cancel" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="cdr-modal-apply"
                disabled={cannotApply}
                title={
                  isNoOp
                    ? "This maneuver changes nothing"
                    : rejected
                      ? "Resolve the failed constraints before applying"
                      : undefined
                }
                onClick={() =>
                  onApply({
                    type: effType,
                    target: targetId,
                    instruction,
                    resolution,
                    timing: { tManLocal: tMan, deviationSec, rejoinSec },
                  })
                }
              >
                {isNoOp
                  ? "No change"
                  : rejected
                    ? "Rejected · fix constraints"
                    : `Apply · ${instruction}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Fallback cruise FL when the target's altitude is unknown. */
function RFL_DEFAULT() {
  return 350;
}
