"use client";

/**
 * AltitudeProfile — compact altitude-vs-time chart for a generated flight,
 * with a moving aircraft locked to the simulation clock.
 *
 * Renders the Phase 2 vertical profile (climb → cruise → descent) as a
 * filled area on an SVG canvas with dashed cruise-level + TOC/TOD
 * gridlines. The plane is driven by the SAME `simT` clock that animates the
 * map, so Play/Pause, the x1…x200 speed and the TOC/TOD crossings all stay
 * in lock-step with the map aircraft. The chart SVG is stretched with
 * preserveAspectRatio="none" (which would distort an icon drawn inside it),
 * so the plane is an absolutely-positioned overlay whose %-position maps
 * 1:1 onto the chart's viewBox.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import type { TrajectoryResult } from "@/lib/trajectory/types";
import {
  formatAirspace,
  type AirspaceMembership,
  type AirspaceSegment,
} from "@/lib/airspace";
import NavIcon from "@/components/nav/NavIcon";

interface Props {
  trajectory: TrajectoryResult;
  /** Width is taken from the container; height is fixed for visual rhythm. */
  height?: number;
  /** Current simulation clock (seconds since departure) for THIS route, or
   *  null/undefined when this route isn't the one being animated. Drives
   *  the plane so it advances with the map playback; parked at the start
   *  otherwise. */
  simT?: number | null;
  /** Live altitude-aware airspace membership for this route (from MapApp) —
   *  the volume that currently contains the aircraft — shown as a small
   *  caption pinned to the moving plane. */
  airspace?: AirspaceMembership;
  /** Whole-route airspace breakdown (from MapApp): each contiguous stretch the
   *  aircraft spends in the same set of sectors. Paints the profile area in
   *  colour blocks tinted by those sectors' map colours. Passed as a lookup so
   *  the walk happens when a chart mounts, not for every loaded flight. */
  airspaceSegmentsFor?: (flightKey: string) => AirspaceSegment[];
}

/** Soft translucent fill for a profile block, from the colour of the ONE
 *  airspace that owns the aircraft on that stretch (the hierarchy in
 *  lib/airspace.ts resolves overlaps, so this is normally a single colour).
 *  Averages if ever handed more than one; [] → the neutral default. */
function blendFill(colors: string[]): string {
  if (colors.length === 0) return "rgba(56,189,248,0.16)";
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of colors) {
    const h = c.replace("#", "");
    r += parseInt(h.slice(0, 2), 16);
    g += parseInt(h.slice(2, 4), 16);
    b += parseInt(h.slice(4, 6), 16);
  }
  const n = colors.length;
  return `rgba(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(
    b / n,
  )}, 0.24)`;
}

const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;

interface AltSample {
  t: number;
  alt: number;
  phase: string;
}

/** Altitude + phase at elapsed time `tt`, linearly interpolated between the
 *  bracketing samples (matches the chart line the plane rides on). */
function altAt(samples: AltSample[], tt: number): { alt: number; phase: string } {
  if (samples.length === 0) return { alt: 0, phase: "climb" };
  if (tt <= samples[0].t) return samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (tt <= samples[i].t) {
      const a = samples[i - 1];
      const b = samples[i];
      const f = (tt - a.t) / (b.t - a.t || 1);
      return {
        alt: a.alt + (b.alt - a.alt) * f,
        phase: f < 0.5 ? a.phase : b.phase,
      };
    }
  }
  return samples[samples.length - 1];
}

export default function AltitudeProfile({
  trajectory,
  height = 140,
  simT,
  airspace,
  airspaceSegmentsFor,
}: Props) {
  // Resolved here rather than by the parent: this chart only exists for a route
  // the user opened, so the sector walk is paid for one route at a time.
  const airspaceSegments = useMemo(
    () => airspaceSegmentsFor?.(trajectory.meta.flightKey) ?? [],
    [airspaceSegmentsFor, trajectory.meta.flightKey],
  );
  const samples = useMemo<AltSample[]>(() => {
    const pts = trajectory.points;
    if (pts.length === 0) return [];
    const t0 = new Date(pts[0].epoch_ts).getTime();
    return pts
      .filter((p) => p.altitude_ft != null)
      .map((p) => ({
        t: (new Date(p.epoch_ts).getTime() - t0) / 1000,
        alt: p.altitude_ft as number,
        phase: p.phase,
      }));
  }, [trajectory.points]);

  // Scales — guarded so they're safe to compute before the early return.
  const tMax = samples.length ? samples[samples.length - 1].t || 1 : 1;
  const altMax = samples.length ? Math.max(...samples.map((s) => s.alt)) : 0;
  // Round the y-axis to a tidy STEP so every tick lands on a round altitude
  // (0/5k/FL100 …) instead of the 6.25k / FL187.5 that quartering an
  // arbitrary max produced.
  const yStep = altMax <= 24000 ? 5000 : 10000;
  const yMax = Math.max(yStep, Math.ceil(altMax / yStep) * yStep);

  const w = 100;
  const h = height;
  const vbW = 320;

  const x = (t: number) => PAD_L + (t / tMax) * (vbW - PAD_L - PAD_R);
  const y = (alt: number) =>
    PAD_T + (1 - alt / yMax) * (h - PAD_T - PAD_B);

  // Static chart paths — memoised so the per-frame playback re-render (simT
  // changing 60×/s) doesn't rebuild the whole curve, only repositions the
  // plane.
  const { linePath, areaPath } = useMemo(() => {
    if (samples.length < 2) return { linePath: "", areaPath: "" };
    const line = samples
      .map(
        (s, i) =>
          `${i === 0 ? "M" : "L"} ${x(s.t).toFixed(2)} ${y(s.alt).toFixed(2)}`,
      )
      .join(" ");
    const area =
      line +
      ` L ${x(tMax).toFixed(2)} ${y(0).toFixed(2)}` +
      ` L ${x(0).toFixed(2)} ${y(0).toFixed(2)} Z`;
    return { linePath: line, areaPath: area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, tMax, yMax, h]);

  // Airspace colour blocks — one filled sub-area per stretch the aircraft
  // spends in the same set of sectors, tinted by those sectors' map colours
  // blended together. Each block clips the altitude curve to its [t0,t1] span
  // and closes down to the baseline, so the whole area reads as the curve but
  // banded by controlling airspace. Labelled where a block is wide enough.
  const segBlocks = useMemo(() => {
    if (!airspaceSegments?.length || samples.length < 2) return [];
    return airspaceSegments
      .map((seg) => {
        const ta = Math.max(0, Math.min(tMax, seg.t0));
        const tb = Math.max(0, Math.min(tMax, seg.t1));
        if (tb - ta < 0.5) return null;
        const inner = samples.filter((s) => s.t > ta && s.t < tb);
        const pts = [
          { t: ta, alt: altAt(samples, ta).alt },
          ...inner,
          { t: tb, alt: altAt(samples, tb).alt },
        ];
        const top = pts
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"} ${x(p.t).toFixed(2)} ${y(p.alt).toFixed(2)}`,
          )
          .join(" ");
        const d =
          top +
          ` L ${x(tb).toFixed(2)} ${y(0).toFixed(2)}` +
          ` L ${x(ta).toFixed(2)} ${y(0).toFixed(2)} Z`;
        const wPx = x(tb) - x(ta);
        return {
          d,
          fill: blendFill(seg.colors),
          label: seg.label,
          x0: x(ta),
          xMid: (x(ta) + x(tb)) / 2,
          wPx,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b != null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airspaceSegments, samples, tMax, yMax, h]);

  // SID/STAR crossing constraints surface as climb/descent LEVEL-OFFS in the
  // curve — runs where the aircraft holds altitude until the fix releases it.
  // Detect each sustained hold so its altitude can be labelled: the steps then
  // read as the coded restrictions they are, not just wiggles.
  const holds = useMemo(() => {
    const cruise = trajectory.stats.cruiseAltFt ?? Infinity;
    // Coded SID/STAR crossing altitudes (per phase) so a level-off is labelled
    // with the real restriction (e.g. 9000) rather than the altitude the sim
    // happened to level at (~8875).
    const cons = trajectory.profile.constraints ?? [];
    const snap = (alt: number, phase: string): number => {
      const cands = cons.filter((c) => c.phase === phase);
      if (cands.length === 0) return alt;
      const near = cands.reduce((b, c) =>
        Math.abs(c.altFt - alt) < Math.abs(b.altFt - alt) ? c : b,
      );
      return Math.abs(near.altFt - alt) <= 2500 ? near.altFt : alt;
    };
    const out: { t: number; tEnd: number; alt: number; label: number }[] = [];
    let i = 0;
    while (i < samples.length - 1) {
      const s = samples[i];
      if (s.phase === "cruise" || s.alt < 800 || s.alt > cruise - 500) {
        i += 1;
        continue;
      }
      let j = i;
      while (
        j + 1 < samples.length &&
        samples[j + 1].phase !== "cruise" &&
        Math.abs(samples[j + 1].alt - s.alt) < 250
      ) {
        j += 1;
      }
      if (j > i && samples[j].t - s.t >= Math.max(40, tMax * 0.03)) {
        const alt = (s.alt + samples[j].alt) / 2;
        out.push({
          t: s.t,
          tEnd: samples[j].t,
          alt,
          label: snap(alt, s.phase),
        });
      }
      i = j + 1;
    }
    return out;
  }, [samples, tMax, trajectory.stats.cruiseAltFt, trajectory.profile.constraints]);

  // --- Magnifier zoom (e-commerce style) ---------------------------------
  // Click the magnifier badge to arm zoom; then the whole chart scales up around the
  // cursor as you move over it (transform-origin follows the pointer), so you
  // can inspect a level-off or the TOC/TOD region. Click again to exit.
  // (Declared before the early return below so the hook order stays stable.)
  const ZOOM = 2.4;
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const onMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!zoomed || !canvasRef.current) return;
      const r = canvasRef.current.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      setOrigin({
        x: Math.min(100, Math.max(0, x)),
        y: Math.min(100, Math.max(0, y)),
      });
    },
    [zoomed],
  );

  if (samples.length < 2) {
    return (
      <p className="alt-empty">
        No vertical profile (set an RFL to generate one).
      </p>
    );
  }

  const toc = trajectory.profile?.toc ?? null;
  const tod = trajectory.profile?.tod ?? null;
  const t0Iso = trajectory.points[0]?.epoch_ts;
  const t0 = t0Iso ? new Date(t0Iso).getTime() : 0;
  const tocT = toc ? (new Date(toc.epochTs).getTime() - t0) / 1000 : null;
  const todT = tod ? (new Date(tod.epochTs).getTime() - t0) / 1000 : null;

  const cruiseAlt = trajectory.stats.cruiseAltFt;
  const rflFt = trajectory.stats.rflFt;
  const fmtFL = (ft: number) => `FL${Math.round(ft / 100)}`;

  // Y-axis gridlines at round altitudes (every yStep) so labels stay tidy.
  const yTicks: number[] = [];
  for (let a = 0; a <= yMax + 1; a += yStep) yTicks.push(a);

  // Plane position from the shared sim clock — clamped to this route's own
  // duration and parked at the start when it isn't being animated. Because
  // the profile's sample times share the sim clock's t0 (first point), the
  // plane lands exactly on the TOC/TOD markers when the map aircraft does.
  const planeT = Math.max(0, Math.min(tMax, simT ?? 0));
  const planePos = altAt(samples, planeT);
  const planeLeft = (x(planeT) / vbW) * 100;
  const planeTop = (y(planePos.alt) / h) * 100;
  // Material "flight" icon points north; +90° faces it along travel (east).
  // A real aircraft's nose stays near-level even in climb/descent (pitch
  // attitude only ~8-10° climbing, ~3° descending) — nothing like the steep
  // slope the time-compressed chart line shows. So keep the plane essentially
  // horizontal, with only a slight nose-up/down hint of the phase.
  const planeRot =
    90 +
    (planePos.phase === "climb" ? -6 : planePos.phase === "descent" ? 4 : 0);
  // Airspace caption text — only while this route is being animated.
  const airsText = simT != null ? formatAirspace(airspace, "compact") : "";

  // Live altitude lead-line: a dashed horizontal from the Y-axis across to the
  // plane at its current altitude, tagged with a realtime readout on the axis.
  // The axis sits at PAD_L in the viewBox; as a % of the full width that's
  // where the plot (and the line) begins.
  const axisLeftPct = (PAD_L / vbW) * 100;
  const leadWidthPct = Math.max(0, planeLeft - axisLeftPct);
  // The readout sits over the Y-axis SCALE labels (FL400/FL300/…), which the
  // SVG draws left-aligned at x=4 — so it reads as the live tick on that scale.
  const scaleLeftPct = (4 / vbW) * 100;
  // Compact (no thousands comma) so the readout fits the narrow left margin
  // when pinned to the Y-axis, clear of the climbing aircraft.
  const altReadout =
    planePos.alt >= 10000
      ? `FL${Math.round(planePos.alt / 100)}`
      : `${Math.round(planePos.alt)} ft`;

  return (
    <figure className="alt-fig">
      <div className="alt-head">
        <span className="alt-title">Altitude profile</span>
        {cruiseAlt != null && (
          <span className="alt-sub">
            Cruise {fmtFL(cruiseAlt)}
            {rflFt && Math.abs(cruiseAlt - rflFt) > 100
              ? ` (req. ${fmtFL(rflFt)})`
              : ""}
          </span>
        )}
      </div>
      <div
        className={`alt-canvas${zoomed ? " zoomed" : ""}`}
        ref={canvasRef}
        onMouseMove={onMove}
      >
        <button
          type="button"
          className={`alt-zoom-btn${zoomed ? " on" : ""}`}
          onClick={() => setZoomed((v) => !v)}
          title={
            zoomed
              ? "Exit zoom"
              : "Zoom — then hover the chart to magnify"
          }
          aria-label={zoomed ? "Exit zoom" : "Zoom"}
          aria-pressed={zoomed}
        >
          <NavIcon name="search" size={14} />
        </button>
        <div
          className="alt-zoomable"
          style={
            zoomed
              ? {
                  transform: `scale(${ZOOM})`,
                  transformOrigin: `${origin.x}% ${origin.y}%`,
                }
              : undefined
          }
        >
        <svg
          className="alt-svg"
          viewBox={`0 0 ${vbW} ${h}`}
          width={`${w}%`}
          height={h}
          preserveAspectRatio="none"
          role="img"
          aria-label="Altitude over time"
        >
          {/* Y-axis grid + labels */}
          {yTicks.map((tick) => (
            <g key={`y-${tick}`}>
              <line
                x1={PAD_L}
                x2={vbW - PAD_R}
                y1={y(tick)}
                y2={y(tick)}
                className="alt-grid"
              />
              <text x={4} y={y(tick) + 3} className="alt-axis">
                {tick === 0
                  ? "0 ft"
                  : tick >= 10000
                    ? `FL${tick / 100}`
                    : `${tick / 1000}k ft`}
              </text>
            </g>
          ))}

          {/* Area fill — banded into airspace colour blocks when the whole-route
              sector breakdown is available (each stretch tinted by a blend of
              the sectors it's in), else a single neutral fill. */}
          {segBlocks.length > 0 ? (
            segBlocks.map((b, k) => (
              <path
                key={`seg-${k}`}
                d={b.d}
                fill={b.fill}
                className="alt-area-seg"
              />
            ))
          ) : (
            <path d={areaPath} className="alt-area" />
          )}
          <path d={linePath} className="alt-line" />

          {/* Boundary ticks + label for each airspace block wide enough to name
              (the "Yangon CTR" zone the aircraft crosses). */}
          {segBlocks.map((b, k) =>
            k > 0 ? (
              <line
                key={`seg-div-${k}`}
                x1={b.x0}
                x2={b.x0}
                y1={y(0)}
                y2={PAD_T}
                className="alt-seg-div"
              />
            ) : null,
          )}
          {segBlocks.map((b, k) =>
            b.label && b.wPx > 46 ? (
              <text
                key={`seg-lbl-${k}`}
                x={b.xMid}
                y={h - PAD_B - 4}
                textAnchor="middle"
                className="alt-seg-lbl"
              >
                {b.wPx > 96 ? b.label : b.label.split("/")[0]}
              </text>
            ) : null,
          )}

          {/* SID/STAR crossing constraints — the climb/descent level-offs,
              highlighted so the "held at FLxx" steps read as coded
              restrictions. Direct-labelled with the altitude (identity is
              never colour-alone). */}
          {holds.map((hd, k) => {
            const yy = y(hd.alt);
            const right = x(hd.t) > vbW * 0.58;
            // Label with the coded constraint (hd.label, e.g. 9000), positioned
            // on the actual level-off (hd.alt, ~8875).
            const lbl =
              hd.label >= 10000
                ? `FL${Math.round(hd.label / 100)}`
                : `${Math.round(hd.label).toLocaleString()} ft`;
            return (
              <g key={`con-${k}`}>
                <line
                  x1={x(hd.t)}
                  x2={x(hd.tEnd)}
                  y1={yy}
                  y2={yy}
                  className="alt-con-line"
                />
                <circle cx={x(hd.t)} cy={yy} r={2.3} className="alt-con" />
                <text
                  x={right ? x(hd.t) - 4 : x(hd.tEnd) + 4}
                  y={yy - 3}
                  textAnchor={right ? "end" : "start"}
                  className="alt-con-lbl"
                >
                  {lbl}
                </text>
              </g>
            );
          })}

          {/* TOC + TOD markers */}
          {tocT != null && (
            <g>
              <line
                x1={x(tocT)}
                x2={x(tocT)}
                y1={PAD_T}
                y2={h - PAD_B}
                className="alt-marker-line"
              />
              <circle
                cx={x(tocT)}
                cy={y(toc!.altitudeFt)}
                r={3.5}
                className="alt-marker"
              />
              <text x={x(tocT) + 4} y={PAD_T + 10} className="alt-marker-lbl">
                TOC
              </text>
            </g>
          )}
          {todT != null && (
            <g>
              <line
                x1={x(todT)}
                x2={x(todT)}
                y1={PAD_T}
                y2={h - PAD_B}
                className="alt-marker-line"
              />
              <circle
                cx={x(todT)}
                cy={y(tod!.altitudeFt)}
                r={3.5}
                className="alt-marker"
              />
              <text
                x={x(todT) - 4}
                y={PAD_T + 10}
                textAnchor="end"
                className="alt-marker-lbl"
              >
                TOD
              </text>
            </g>
          )}

          {/* X-axis baseline + time labels */}
          <line
            x1={PAD_L}
            x2={vbW - PAD_R}
            y1={h - PAD_B}
            y2={h - PAD_B}
            className="alt-axisline"
          />
          <text x={PAD_L} y={h - 6} className="alt-axis">
            0
          </text>
          <text x={vbW - PAD_R} y={h - 6} textAnchor="end" className="alt-axis">
            {Math.round(tMax / 60)} min
          </text>
        </svg>

        {/* Live altitude lead-line — a dashed horizontal from the Y-axis to the
            plane at its current altitude, so you can read the height straight off
            the axis as it climbs/descends. Moves with the plane every frame. */}
        <span
          className="alt-alt-line"
          aria-hidden="true"
          style={{
            left: `${axisLeftPct}%`,
            top: `${planeTop}%`,
            width: `${leadWidthPct}%`,
          }}
        />
        <span
          className="alt-alt-readout"
          style={{ left: `${scaleLeftPct}%`, top: `${planeTop}%` }}
        >
          {altReadout}
        </span>

        {/* Aircraft — position/rotation driven by the shared sim clock so
            it tracks the map playback exactly (play / pause / speed). */}
        <span
          className="alt-plane"
          aria-hidden="true"
          style={{
            left: `${planeLeft}%`,
            top: `${planeTop}%`,
            transform: `translate(-50%, -50%) rotate(${planeRot}deg)`,
          }}
        >
          <svg viewBox="0 0 24 24">
            <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
          </svg>
        </span>

        {/* Airspace caption pinned to the plane — the zone it's currently in,
            live and altitude-aware (only while this route is animating). */}
        {airsText && (
          <span
            className="alt-plane-airspace"
            style={{ left: `${planeLeft}%`, top: `${planeTop}%` }}
          >
            {airsText}
          </span>
        )}
        </div>
      </div>
    </figure>
  );
}
