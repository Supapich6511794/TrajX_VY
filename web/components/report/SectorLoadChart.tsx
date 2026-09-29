"use client";

/**
 * SectorLoadChart — aircraft per hour, for one sector, across the whole run.
 *
 * The panel above it answers "what happened in this sector in THIS hour". That
 * number means little on its own: six aircraft is a dead night in a busy
 * terminal area and a full hour in a quiet control zone. The shape of the day is what makes one hour readable,
 * so the chart draws every hour of the sample and marks the one being read.
 *
 * Three things are on it, and no more:
 *
 *   * **Bars** — aircraft present in the sector that hour (the occupancy count,
 *     not entries: an aircraft still inside from the hour before is still work).
 *   * **The merge line** — the band-boxing threshold. Bars under it are hours
 *     this sector could have been worked from a neighbouring position, which
 *     turns the dynamic sectorization result below into something you can see
 *     rather than something you have to take on trust.
 *   * **A conflict tick** — a small mark over any hour that had a conflict in
 *     it, so a quiet-looking hour that was actually hard does not read as easy.
 *
 * Colours are set as SVG attributes rather than CSS classes on purpose: the
 * chart is downloadable, and a saved .svg carries its attributes but not this
 * app's stylesheet.
 */

import { useMemo, useRef } from "react";

import type { SectorLoadPoint } from "@/lib/report/flightEvents";
import { saveBlob } from "@/lib/saveFile";

interface Props {
  sector: string;
  points: SectorLoadPoint[];
  /** The hour selected in the dropdowns above, highlighted here. */
  selected: string;
  /** Band-boxing threshold, drawn as a reference line. Null draws no line. */
  threshold: number | null;
  /** Clicking a bar selects that hour. */
  onPick?: (hourUtc: string) => void;
}

const W = 320;
const H = 132;
const PAD_L = 26;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 24;

const INK = "#94a3b8";
const GRID = "#33415588";
const BAR = "#38bdf8";
const BAR_DIM = "#38bdf866";
const BAR_SEL = "#7dd3fc";
const LINE = "#fbbf24";
const CONFLICT = "#f87171";

/** "2026-09-07T03:00Z" -> "03". */
const hh = (hourUtc: string) => {
  const ms = Date.parse(hourUtc);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 13) : "";
};

/** A y-axis that ends on a round number, so the gridline labels are readable. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const step = v <= 10 ? 2 : v <= 30 ? 5 : v <= 60 ? 10 : 20;
  return Math.ceil(v / step) * step;
}

export default function SectorLoadChart({
  sector,
  points,
  selected,
  threshold,
  onPick,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  const geom = useMemo(() => {
    const peak = points.reduce((m, p) => Math.max(m, p.present), 0);
    const top = niceMax(Math.max(peak, threshold ?? 0));
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const slot = points.length > 0 ? plotW / points.length : plotW;
    // A hair of air between bars, but never so much that a 24-hour day turns
    // into a row of hairlines.
    const barW = Math.max(2, Math.min(18, slot - 2));
    const y = (v: number) => PAD_T + plotH - (v / top) * plotH;
    return { top, plotH, slot, barW, y, peak };
  }, [points, threshold]);

  const saveChart = () => {
    const el = svgRef.current;
    if (!el) return;
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(W * 2));
    clone.setAttribute("height", String(H * 2));
    // The panel is dark and the SVG is transparent; on a white page the axis
    // labels would vanish. The saved copy brings its own ground.
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", "0");
    bg.setAttribute("y", "0");
    bg.setAttribute("width", String(W));
    bg.setAttribute("height", String(H));
    bg.setAttribute("fill", "#0f172a");
    clone.insertBefore(bg, clone.firstChild);
    saveBlob(
      new XMLSerializer().serializeToString(clone),
      "sector_load_" + sector.replace(/[^A-Za-z0-9]+/g, "_") + ".svg",
      "image/svg+xml;charset=utf-8",
    );
  };

  if (points.length === 0) return null;

  const ticks = [0, geom.top / 2, geom.top];
  // Enough hour labels to orient by, never so many that they collide.
  const labelEvery = Math.ceil(points.length / 8);

  return (
    <div className="si-chart">
      <div className="si-chart-head">
        <h4 className="pdr-group-h">Aircraft per hour · {sector}</h4>
        <button
          type="button"
          className="si-dl si-dl-mini"
          onClick={saveChart}
          title="Save this chart as an SVG image"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M8 1.5v8m0 0L5 6.5m3 3 3-3M2.5 11v2.5h11V11"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Chart</span>
          <span className="si-dl-ext">SVG</span>
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="si-chart-svg"
        role="img"
        aria-label={
          "Aircraft per hour in " +
          sector +
          ", peaking at " +
          geom.peak +
          " aircraft"
        }
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={geom.y(t)}
              y2={geom.y(t)}
              stroke={GRID}
              strokeWidth="1"
            />
            <text
              x={PAD_L - 5}
              y={geom.y(t) + 3}
              fill={INK}
              fontSize="8"
              textAnchor="end"
            >
              {t}
            </text>
          </g>
        ))}

        {points.map((p, i) => {
          const x = PAD_L + i * geom.slot + (geom.slot - geom.barW) / 2;
          const isSel = p.hourUtc === selected;
          const under = threshold != null && p.present < threshold;
          const top = geom.y(p.present);
          return (
            <g
              key={p.hourUtc}
              onClick={onPick ? () => onPick(p.hourUtc) : undefined}
              style={onPick ? { cursor: "pointer" } : undefined}
            >
              {/* A full-height hit area: a 1-aircraft bar is 3 px tall and
                  impossible to click at. */}
              <rect
                x={PAD_L + i * geom.slot}
                y={PAD_T}
                width={geom.slot}
                height={geom.plotH}
                fill={isSel ? "#38bdf81f" : "transparent"}
              />
              <rect
                x={x}
                y={top}
                width={geom.barW}
                height={Math.max(p.present > 0 ? 1.5 : 0, geom.y(0) - top)}
                rx="1.5"
                fill={isSel ? BAR_SEL : under ? BAR_DIM : BAR}
              />
              {p.conflicts > 0 && (
                <circle cx={x + geom.barW / 2} cy={top - 4} r="2" fill={CONFLICT} />
              )}
              <title>
                {hh(p.hourUtc)}
                {"00Z — "}
                {p.present} aircraft present, {p.entries} entered
                {p.conflicts > 0 ? ", " + p.conflicts + " conflict" : ""}
                {p.conflicts > 1 ? "s" : ""}
              </title>
            </g>
          );
        })}

        {threshold != null && threshold <= geom.top && (
          <g>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={geom.y(threshold)}
              y2={geom.y(threshold)}
              stroke={LINE}
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text
              x={W - PAD_R}
              y={geom.y(threshold) - 3}
              fill={LINE}
              fontSize="8"
              textAnchor="end"
            >
              merge below {threshold}
            </text>
          </g>
        )}

        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={geom.y(0)}
          y2={geom.y(0)}
          stroke={GRID}
          strokeWidth="1"
        />
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text
              key={p.hourUtc}
              x={PAD_L + i * geom.slot + geom.slot / 2}
              y={H - PAD_B + 11}
              fill={INK}
              fontSize="8"
              textAnchor="middle"
            >
              {hh(p.hourUtc)}
            </text>
          ) : null,
        )}
        <text x={W - PAD_R} y={H - 2} fill={INK} fontSize="7.5" textAnchor="end">
          hour (UTC)
        </text>
      </svg>
    </div>
  );
}
