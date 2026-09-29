/**
 * The shapes behind the on-screen chart.
 *
 * A chart that is wrong is not obviously wrong — it is a picture, and a picture
 * of the wrong numbers looks exactly as convincing as a picture of the right
 * ones. So the things that would quietly mislead are what is pinned here: an
 * axis that cuts the tallest bar off, bars escaping the plot box, a track
 * stretched into a shape that was never flown, and a blank read as a zero.
 */
import { describe, expect, it } from "vitest";

import {
  barPlot,
  buildPlot,
  labelEvery,
  niceStep,
  pathPlot,
  valueTicks,
  type Box,
} from "./chartGeometry";
import type { Cell, ChartSpec } from "./xlsx";

const BOX: Box = {
  width: 800,
  height: 400,
  padLeft: 60,
  padRight: 20,
  padTop: 20,
  padBottom: 50,
};
const PLOT = { x: 60, y: 20, w: 720, h: 330 };

const BAR_SPEC: ChartSpec = {
  kind: "bar",
  title: "Conflicts by sector",
  xTitle: "Sector",
  yTitle: "Conflicts",
  catCol: 0,
  valCols: [1, 2],
};

const ROWS: Cell[][] = [
  ["sector", "conflicts", "resolved"],
  ["S1S", 12, 9],
  ["S6S", 7, 7],
  ["SMU", 3, 1],
];

describe("niceStep", () => {
  it("climbs 1 / 2 / 5 / 10 within a decade", () => {
    expect(niceStep(5)).toBe(1);
    expect(niceStep(9)).toBe(2);
    expect(niceStep(20)).toBe(5);
    expect(niceStep(48)).toBe(10);
    expect(niceStep(480)).toBe(100);
  });

  it("never returns zero, whatever it is handed", () => {
    expect(niceStep(0)).toBeGreaterThan(0);
    expect(niceStep(-4)).toBeGreaterThan(0);
  });
});

describe("the value axis", () => {
  it("reaches past the tallest value, so the bar has air over it", () => {
    const { ticks } = valueTicks(12, 0, 330, 20);
    const top = Math.max(...ticks.map((t) => Number(t.label)));
    expect(top).toBeGreaterThanOrEqual(12);
  });

  it("puts zero at the bottom when nothing is negative", () => {
    const { zero } = valueTicks(12, 0, 330, 20);
    expect(zero).toBeCloseTo(350, 5);
  });

  it("drops below zero only when the data does", () => {
    const { ticks } = valueTicks(4, -3, 330, 20);
    expect(Math.min(...ticks.map((t) => Number(t.label)))).toBeLessThan(0);
  });
});

describe("grouped bars", () => {
  const plot = barPlot(BAR_SPEC, ROWS, BOX);

  it("draws one bar per value column per category", () => {
    expect(plot.bars).toHaveLength(3 * 2);
    expect(plot.seriesNames).toEqual(["conflicts", "resolved"]);
  });

  it("keeps every bar inside the plot box", () => {
    for (const b of plot.bars) {
      expect(b.x).toBeGreaterThanOrEqual(PLOT.x - 0.001);
      expect(b.x + b.w).toBeLessThanOrEqual(PLOT.x + PLOT.w + 0.001);
      expect(b.y).toBeGreaterThanOrEqual(PLOT.y - 0.001);
      expect(b.y + b.h).toBeLessThanOrEqual(PLOT.y + PLOT.h + 0.001);
    }
  });

  it("makes the taller value the taller bar", () => {
    const first = plot.bars.filter((b) => b.cat === 0);
    expect(first[0].value).toBe(12);
    expect(first[1].value).toBe(9);
    expect(first[0].h).toBeGreaterThan(first[1].h);
  });

  it("keeps a bar readable as a bar when there is only one category", () => {
    // Three series over one hour used to fill a third of the page each, which
    // reads as a colour field rather than a chart.
    const one = barPlot(BAR_SPEC, [ROWS[0], ROWS[1]], BOX);
    for (const b of one.bars) expect(b.w).toBeLessThanOrEqual(54);
    // ...and stays centred on its slot rather than hugging the axis.
    const mid = PLOT.x + PLOT.w / 2;
    const left = Math.min(...one.bars.map((b) => b.x));
    const right = Math.max(...one.bars.map((b) => b.x + b.w));
    expect((left + right) / 2).toBeCloseTo(mid, 1);
  });

  it("carries the category label on the bar, for the hover", () => {
    expect(plot.bars.filter((b) => b.cat === 2).every((b) => b.label === "SMU")).toBe(
      true,
    );
  });

  it("survives a table with a header and nothing else", () => {
    const empty = barPlot(BAR_SPEC, [ROWS[0]], BOX);
    expect(empty.bars).toEqual([]);
    expect(empty.yTicks.length).toBeGreaterThan(0);
  });
});

describe("category labels", () => {
  it("prints them all when they fit", () => {
    expect(labelEvery(6, 720)).toBe(1);
  });

  it("thins them when they would overprint", () => {
    expect(labelEvery(90, 720)).toBeGreaterThan(1);
  });

  it("does not thin a single label out of existence", () => {
    expect(labelEvery(1, 10)).toBe(1);
  });
});

describe("tracks", () => {
  const spec: ChartSpec = {
    kind: "scatter",
    title: "Flight trajectories",
    xTitle: "Longitude",
    yTitle: "Latitude",
    pairs: [
      { xCol: 0, yCol: 1 },
      { xCol: 2, yCol: 3 },
    ],
  };
  // Second flight is shorter, so its columns run out part way down.
  const rows: Cell[][] = [
    ["lon_UBA1", "lat_UBA1", "lon_UBA2", "lat_UBA2"],
    [100, 13, 101, 14],
    [101, 14, 102, 15],
    [102, 15, "", ""],
  ];

  it("names a series after its flight, not its column", () => {
    expect(pathPlot(spec, rows, BOX).seriesNames).toEqual(["UBA1", "UBA2"]);
  });

  it("lifts the pen at a blank rather than drawing back to (0, 0)", () => {
    const p = pathPlot(spec, rows, BOX);
    // Two points for the short flight, and one move command for them.
    expect(p.paths[1].d.match(/M/g)).toHaveLength(1);
    expect(p.paths[1].d.match(/L/g)).toHaveLength(1);
  });

  it("keeps one scale for both axes, so the track keeps its shape", () => {
    // A 2-degree span of longitude against 2 of latitude must come out square.
    const square: Cell[][] = [
      ["lon_A", "lat_A"],
      [100, 10],
      [102, 12],
    ];
    const p = pathPlot({ ...spec, pairs: [{ xCol: 0, yCol: 1 }] }, square, BOX);
    const nums = p.paths[0].d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const [x1, y1, x2, y2] = nums;
    expect(Math.abs(x2 - x1)).toBeCloseTo(Math.abs(y2 - y1), 1);
  });

  it("returns an empty plot rather than NaN when there is no data", () => {
    const p = pathPlot(spec, [rows[0]], BOX);
    expect(p.paths).toEqual([]);
    expect(p.xTicks).toEqual([]);
  });
});

describe("buildPlot", () => {
  it("sends a scatter spec to the track renderer and everything else to bars", () => {
    expect(buildPlot(BAR_SPEC, ROWS, BOX).kind).toBe("bar");
    expect(buildPlot({ ...BAR_SPEC, kind: "line" }, ROWS, BOX).kind).toBe("bar");
    expect(
      buildPlot(
        { ...BAR_SPEC, kind: "scatter", pairs: [{ xCol: 1, yCol: 2 }] },
        ROWS,
        BOX,
      ).kind,
    ).toBe("path");
  });
});
