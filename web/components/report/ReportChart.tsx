"use client";

/**
 * ReportChart — the headline chart of a run report, drawn on the page.
 *
 * It is handed the SAME `ChartSpec` that builds the chart inside the downloaded
 * .xlsx, so the picture here and the picture in the workbook are two renderings
 * of one description rather than two drawings that have to be kept in step. The
 * arithmetic lives in `lib/report/chartGeometry.ts`, which is where the axis
 * behaviour is tested; this file is the SVG and the hover.
 *
 * Colours are set as attributes, not classes: the chart can be saved as an .svg
 * and a saved file carries its attributes but not this app's stylesheet. They
 * are read from the live theme on mount so a saved chart matches the console it
 * came from.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { buildPlot, type Box, type Plot } from "@/lib/report/chartGeometry";
import type { Cell, ChartSpec } from "@/lib/report/xlsx";

/** Series colours. Distinct in hue rather than lightness, so the legend still
 *  works for the ~8% of men who cannot separate red from green. */
const SERIES = [
  "#0284c7",
  "#f59e0b",
  "#16a34a",
  "#a855f7",
  "#ef4444",
  "#0d9488",
  "#64748b",
];

/** Colour of series `i` of `n`. The fixed palette while it lasts; past it,
 *  hues stepped by the golden angle so every flight still gets its own colour
 *  and neighbours in the legend never land on near-identical ones. */
function seriesColor(i: number, n: number): string {
  if (n <= SERIES.length) return SERIES[i % SERIES.length];
  const hue = Math.round((i * 137.508) % 360);
  return `hsl(${hue}, 70%, 48%)`;
}

/** Hover box geometry: a line of 11px system text is ~6.4px a character. */
const TIP_LINE_H = 15;
const TIP_CHAR_W = 6.4;

const PAD: Omit<Box, "width" | "height"> = {
  padLeft: 64,
  padRight: 18,
  padTop: 18,
  padBottom: 54,
};

interface Props {
  spec: ChartSpec;
  /** The series table, header row first. */
  rows: Cell[][];
  height?: number;
}

export default function ReportChart({ spec, rows, height = 340 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(
    null,
  );

  // The chart fills whatever column it is given, and a report tab is a window
  // someone resizes. ResizeObserver rather than a window listener: the sidebar
  // and the table beside it change this box without the window changing.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && Math.abs(w - width) > 2) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const plot: Plot = useMemo(
    () => buildPlot(spec, rows, { width, height, ...PAD }),
    [spec, rows, width, height],
  );
  const color = (i: number) => seriesColor(i, plot.seriesNames.length);

  // The hover box: sized to its longest line, kept inside the chart, and
  // dropped below the point when there is no room above it.
  const tip = hover
    ? (() => {
        const w = Math.max(...hover.lines.map((l) => l.length)) * TIP_CHAR_W + 16;
        const h = hover.lines.length * TIP_LINE_H + 8;
        const x = Math.min(Math.max(hover.x - w / 2, 2), Math.max(2, width - w - 2));
        const y = hover.y - h - 8 >= 2 ? hover.y - h - 8 : hover.y + 10;
        return { x, y, w, h };
      })()
    : null;

  const axisColor = "#94a3b8";
  const gridColor = "#cbd5e155";
  const inkColor = "#64748b";

  return (
    <figure className="rv-chart" ref={wrap}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${spec.title}. ${spec.xTitle} against ${spec.yTitle}.`}
        onMouseLeave={() => setHover(null)}
      >
        <title>{spec.title}</title>

        {/* Value gridlines first, so every mark sits on top of them. */}
        {plot.yTicks.map((t, i) => (
          <g key={"y" + i}>
            <line
              x1={plot.plot.x}
              x2={plot.plot.x + plot.plot.w}
              y1={t.at}
              y2={t.at}
              stroke={gridColor}
              strokeWidth={1}
            />
            <text
              x={plot.plot.x - 8}
              y={t.at + 4}
              textAnchor="end"
              fontSize={11}
              fill={inkColor}
              fontFamily="system-ui, sans-serif"
            >
              {t.label}
            </text>
          </g>
        ))}

        {plot.kind === "bar"
          ? plot.bars.map((b, i) => (
              <rect
                key={i}
                x={b.x}
                y={b.y}
                width={Math.max(0.5, b.w - 1)}
                height={b.h}
                fill={color(b.series)}
                onMouseEnter={() =>
                  setHover({
                    x: b.x + b.w / 2,
                    y: b.y,
                    lines: [`${b.label} · ${plot.seriesNames[b.series] ?? ""} ${b.value}`],
                  })
                }
              />
            ))
          : plot.paths.map((p, i) => (
              <path
                key={i}
                d={p.d}
                fill="none"
                stroke={color(p.series)}
                strokeWidth={1.4}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.9}
              >
                <title>{p.name}</title>
              </path>
            ))}

        {/* A dot per event, over the lines. The visible dot is small; the
            transparent ring around it is what the pointer actually has to hit. */}
        {plot.kind === "path" &&
          plot.points.map((pt, i) => (
            <g
              key={"p" + i}
              onMouseEnter={() =>
                setHover({
                  x: pt.x,
                  y: pt.y,
                  lines: pt.hover.length ? pt.hover : [plot.seriesNames[pt.series] ?? ""],
                })
              }
            >
              <circle cx={pt.x} cy={pt.y} r={7} fill="transparent" />
              <circle cx={pt.x} cy={pt.y} r={2.4} fill={color(pt.series)} />
            </g>
          ))}

        {/* Axes last: a bar drawn over its own baseline looks detached. */}
        <line
          x1={plot.plot.x}
          x2={plot.plot.x + plot.plot.w}
          y1={plot.plot.y + plot.plot.h}
          y2={plot.plot.y + plot.plot.h}
          stroke={axisColor}
          strokeWidth={1}
        />
        <line
          x1={plot.plot.x}
          x2={plot.plot.x}
          y1={plot.plot.y}
          y2={plot.plot.y + plot.plot.h}
          stroke={axisColor}
          strokeWidth={1}
        />

        {plot.xTicks.map((t, i) => (
          <text
            key={"x" + i}
            x={t.at}
            y={plot.plot.y + plot.plot.h + 16}
            textAnchor="middle"
            fontSize={11}
            fill={inkColor}
            fontFamily="system-ui, sans-serif"
          >
            {t.label}
          </text>
        ))}

        <text
          x={plot.plot.x + plot.plot.w / 2}
          y={height - 8}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill={inkColor}
          fontFamily="system-ui, sans-serif"
        >
          {spec.xTitle}
        </text>
        <text
          x={14}
          y={plot.plot.y + plot.plot.h / 2}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill={inkColor}
          fontFamily="system-ui, sans-serif"
          transform={`rotate(-90 14 ${plot.plot.y + plot.plot.h / 2})`}
        >
          {spec.yTitle}
        </text>

        {hover && tip && (
          <g pointerEvents="none">
            <rect
              x={tip.x}
              y={tip.y}
              width={tip.w}
              height={tip.h}
              rx={4}
              fill="#0f172a"
              opacity={0.92}
            />
            {hover.lines.map((line, i) => (
              <text
                key={i}
                x={tip.x + 8}
                y={tip.y + 4 + TIP_LINE_H * (i + 1) - 4}
                fontSize={11}
                fill="#f8fafc"
                fontFamily="system-ui, sans-serif"
              >
                {line}
              </text>
            ))}
          </g>
        )}
      </svg>

      {/* One legend for both chart kinds. Capped, because the trajectory chart
          has a series per flight and 25 callsigns is a wall, not a key. */}
      {plot.seriesNames.length > 1 && (
        <figcaption className="rv-legend">
          {plot.seriesNames.slice(0, 12).map((n, i) => (
            <span key={i}>
              <i style={{ background: color(i) }} />
              {n}
            </span>
          ))}
          {plot.seriesNames.length > 12 && (
            <span className="rv-legend-more">
              +{plot.seriesNames.length - 12} more
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}
