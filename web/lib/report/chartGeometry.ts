/**
 * Turning a `ChartSpec` plus its series table into shapes.
 *
 * The same spec drives the .xlsx chart (`xlsx.ts`) and the one drawn on the
 * report tab, so what the two show cannot drift apart: change the spec and both
 * follow. This module is the half of that which produces coordinates, kept out
 * of the component so the arithmetic can be tested without a DOM — an axis that
 * silently clips the tallest bar is exactly the kind of thing that looks right
 * in a screenshot.
 *
 * Everything here is pure and unit-less; the caller supplies the box.
 */

import type { Cell, ChartSpec } from "./xlsx";

export interface Box {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export interface BarShape {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index of the series this bar belongs to, for colour. */
  series: number;
  /** Index of the category, for hit-testing. */
  cat: number;
  label: string;
  value: number;
}

export interface Tick {
  /** Position along the axis, in px. */
  at: number;
  label: string;
}

interface PlotBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BarPlot {
  kind: "bar";
  bars: BarShape[];
  seriesNames: string[];
  yTicks: Tick[];
  xTicks: Tick[];
  plot: PlotBox;
}

/** One plotted point and what its hover says. */
export interface PathPoint {
  x: number;
  y: number;
  series: number;
  /** One line per `hoverCols` column ("altitude_ft: 33000"); empty when the
   *  spec names none. */
  hover: string[];
}

export interface PathPlot {
  kind: "path";
  paths: { d: string; series: number; name: string }[];
  /** Every point of every path, for hit-testing the hover. */
  points: PathPoint[];
  seriesNames: string[];
  yTicks: Tick[];
  xTicks: Tick[];
  plot: PlotBox;
}

export type Plot = BarPlot | PathPlot;

/** Widest a single bar is allowed to get. See the note in `barPlot`. */
const MAX_BAR_W = 54;

const num = (c: Cell): number => {
  const n = typeof c === "number" ? c : Number(c);
  return Number.isFinite(n) ? n : 0;
};
const text = (c: Cell): string => (c == null ? "" : String(c));
const blank = (c: Cell): boolean => c == null || c === "";

function plotBox(box: Box): PlotBox {
  return {
    x: box.padLeft,
    y: box.padTop,
    w: Math.max(1, box.width - box.padLeft - box.padRight),
    h: Math.max(1, box.height - box.padTop - box.padBottom),
  };
}

/**
 * A round number of about the right size, for axis ticks.
 *
 * Bare `max / 5` gives an axis labelled 0, 27, 54, which nobody reads a value
 * off. This walks up 1 / 2 / 5 / 10 in whatever decade the span lands in.
 */
export function niceStep(span: number, targetTicks = 5): number {
  if (span <= 0) return 1;
  const rough = span / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const m of [1, 2, 5, 10]) {
    if (rough <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/**
 * Value-axis ticks, from zero (or below, if anything is negative) to just past
 * the top of the data, so the tallest bar always has air over it.
 */
export function valueTicks(
  max: number,
  min: number,
  height: number,
  y0: number,
): { ticks: Tick[]; scale: (v: number) => number; zero: number } {
  const lo = Math.min(0, min);
  const step = niceStep(max - lo);
  const top = Math.ceil(max / step) * step || step;
  const bottom = Math.floor(lo / step) * step;
  const span = top - bottom || 1;
  const scale = (v: number) => y0 + height - ((v - bottom) / span) * height;
  const ticks: Tick[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) {
    const rounded = Math.abs(v) < step / 1e6 ? 0 : v;
    ticks.push({
      at: scale(rounded),
      label: Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2),
    });
  }
  return { ticks, scale, zero: scale(0) };
}

/**
 * Thin a list of category labels so they do not overprint.
 *
 * Twenty-four hours fit across a chart; ninety sectors do not, and drawing them
 * anyway produces a grey smear that reads as a rendering fault. Every nth is
 * kept, n chosen from how much room one label has.
 */
export function labelEvery(count: number, width: number, perLabel = 46): number {
  if (count <= 1) return 1;
  const room = Math.max(1, Math.floor(width / perLabel));
  return Math.max(1, Math.ceil(count / room));
}

/** Grouped bars: one cluster per category, one bar per value column. */
export function barPlot(spec: ChartSpec, rows: Cell[][], box: Box): BarPlot {
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  const cat = spec.catCol ?? 0;
  const cols = spec.valCols ?? [];
  const plot = plotBox(box);

  let max = 0;
  let min = 0;
  for (const r of body) {
    for (const c of cols) {
      const v = num(r[c]);
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  const { ticks: yTicks, scale, zero } = valueTicks(max, min, plot.h, plot.y);

  // A cluster per category; the remaining 22% of each slot is the gap between
  // one cluster and the next, which is what makes them read as groups.
  //
  // Capped, because a report can legitimately have one hour or two sectors in
  // it, and a bar allowed to take a third of the page stops reading as a bar —
  // it reads as a block of colour with a number beside it. The cluster is then
  // centred on its slot rather than stretched across it.
  const slot = plot.w / Math.max(1, body.length);
  const barW = Math.max(1, Math.min(MAX_BAR_W, (slot * 0.78) / Math.max(1, cols.length)));
  const groupW = barW * Math.max(1, cols.length);

  const bars: BarShape[] = [];
  body.forEach((r, i) => {
    const left = plot.x + i * slot + (slot - groupW) / 2;
    cols.forEach((c, s) => {
      const v = num(r[c]);
      const y = scale(v);
      bars.push({
        x: left + s * barW,
        y: Math.min(y, zero),
        w: barW,
        h: Math.max(1, Math.abs(zero - y)),
        series: s,
        cat: i,
        label: text(r[cat]),
        value: v,
      });
    });
  });

  const every = labelEvery(body.length, plot.w);
  const xTicks: Tick[] = body
    .map((r, i) => ({ at: plot.x + i * slot + slot / 2, label: text(r[cat]), i }))
    .filter((t) => t.i % every === 0)
    .map(({ at, label }) => ({ at, label }));

  return {
    kind: "bar",
    bars,
    seriesNames: cols.map((c) => text(head[c])),
    yTicks,
    xTicks,
    plot,
  };
}

/**
 * Joined points: one path per X/Y column pair, or per row group when the spec
 * has `groups` (one flight_key's rows each).
 *
 * Used for the flight tracks, where X is longitude rather than a category, so
 * both axes are numeric and the aspect has to be honest — a track stretched to
 * fill the box is a different shape from the one that was flown, which is why
 * the scale below is the SMALLER of the two fits rather than one per axis.
 *
 * Shorter flights simply run out of rows. A blank lifts the pen; it is never a
 * point at (0, 0), which on this chart is the Gulf of Guinea.
 */
export function pathPlot(spec: ChartSpec, rows: Cell[][], box: Box): PathPlot {
  const head = rows[0] ?? [];
  const plot = plotBox(box);
  const hoverCols = spec.hoverCols ?? [];

  // Either layout comes down to the same thing: per series, its points in
  // drawing order, with null where the pen lifts.
  type Pt = { x: number; y: number; row: Cell[] } | null;
  const tracks: { name: string; pts: Pt[] }[] = [];
  if (spec.groups) {
    const xc = spec.xCol ?? 0;
    const yc = spec.yCol ?? 1;
    for (const g of spec.groups) {
      const pts: Pt[] = [];
      for (let r = g.r0; r <= g.r1 && r < rows.length; r++) {
        const row = rows[r];
        pts.push(
          blank(row[xc]) || blank(row[yc]) ? null : { x: num(row[xc]), y: num(row[yc]), row },
        );
      }
      tracks.push({ name: g.name, pts });
    }
  } else {
    const body = rows.slice(1);
    for (const p of spec.pairs ?? []) {
      tracks.push({
        name: text(head[p.xCol]).replace(/^lon_/, ""),
        pts: body.map((row) =>
          blank(row[p.xCol]) || blank(row[p.yCol])
            ? null
            : { x: num(row[p.xCol]), y: num(row[p.yCol]), row },
        ),
      });
    }
  }

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const t of tracks) {
    for (const p of t.pts) {
      if (!p) continue;
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
  }
  if (!Number.isFinite(xMin)) {
    return {
      kind: "path",
      paths: [],
      points: [],
      seriesNames: [],
      yTicks: [],
      xTicks: [],
      plot,
    };
  }

  const spanX = xMax - xMin || 1;
  const spanY = yMax - yMin || 1;
  const k = Math.min(plot.w / spanX, plot.h / spanY);
  const offX = plot.x + (plot.w - spanX * k) / 2;
  const offY = plot.y + (plot.h + spanY * k) / 2;
  const sx = (v: number) => offX + (v - xMin) * k;
  const sy = (v: number) => offY - (v - yMin) * k;

  const points: PathPoint[] = [];
  const paths = tracks.map((t, i) => {
    let d = "";
    let pen = false;
    for (const p of t.pts) {
      if (!p) {
        pen = false;
        continue;
      }
      const px = sx(p.x);
      const py = sy(p.y);
      d += `${pen ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
      pen = true;
      points.push({
        x: px,
        y: py,
        series: i,
        hover: hoverCols.map((c) => `${text(head[c])}: ${text(p.row[c])}`),
      });
    }
    return { d, series: i, name: t.name };
  });

  const axis = (lo: number, hi: number, to: (v: number) => number): Tick[] => {
    const step = niceStep(hi - lo, 4);
    const out: Tick[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      out.push({ at: to(v), label: v.toFixed(step < 1 ? 2 : 0) });
    }
    return out;
  };

  return {
    kind: "path",
    paths,
    points,
    seriesNames: paths.map((p) => p.name),
    yTicks: axis(yMin, yMax, sy),
    xTicks: axis(xMin, xMax, sx),
    plot,
  };
}

/** Whichever the spec asks for. A `line` spec draws as bars here: every one in
 *  this app has a bucketed X axis — see the note at the top of `chartData.ts`. */
export function buildPlot(spec: ChartSpec, rows: Cell[][], box: Box): Plot {
  return spec.kind === "scatter" ? pathPlot(spec, rows, box) : barPlot(spec, rows, box);
}
