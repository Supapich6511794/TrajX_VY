/**
 * The geometric half of the check: which stretches of a route are inside an
 * area's volume. The cases that matter are the ones a naive "does any waypoint
 * fall in a polygon" test gets wrong — an area small enough to sit between two
 * fixes, a route that leaves and re-enters, and a flight above the ceiling.
 */
import { describe, expect, it } from "vitest";

import {
  climbCruiseDescentFt,
  decimatePath,
  findIncursions,
  pathFromFixes,
  routeLengthNm,
} from "./penetration";
import type { PdrActivity, PdrArea, TimedPoint } from "./types";

const MON = Date.UTC(2026, 8, 7); // Monday
const HOUR = 3600000;

/** MON-FRI 0100-0900 UTC — a typical weekday training-area window. */
const workdaySchedule: PdrActivity = {
  designator: "TEST1",
  type: "D",
  name: "TEST AREA",
  sheets: [
    {
      day: "MON",
      dayTil: "FRI",
      start: "01:00",
      end: "09:00",
      startEvent: null,
      endEvent: null,
      excluded: false,
      timeReference: "UTC",
    },
  ],
  activityNote: "",
  restriction: "Training",
  hazard: "Gunnery",
  remarks: "",
};

/** A 1° box centred on (15, 100), GND to 15 000 ft. */
function boxArea(over: Partial<PdrArea> = {}): PdrArea {
  return {
    ident: "TEST1",
    name: "TEST AREA",
    kind: "D",
    lowerFt: 0,
    upperFt: 15000,
    mp: [[[[99.5, 14.5], [100.5, 14.5], [100.5, 15.5], [99.5, 15.5], [99.5, 14.5]]]],
    activity: workdaySchedule,
    centroid: { lat: 15, lon: 100 },
    bbox: [99.5, 14.5, 100.5, 15.5],
    ...over,
  };
}

/** A due-east track across the box at a fixed level and 1-minute steps. */
function eastboundPath(opts: {
  altFt: number;
  startMs: number;
  lons?: number[];
}): TimedPoint[] {
  const lons = opts.lons ?? [98, 99, 100, 101, 102];
  return lons.map((lon, i) => ({
    lat: 15,
    lon,
    altFt: opts.altFt,
    timeMs: opts.startMs + i * 10 * 60000, // 10 min apart
  }));
}

describe("findIncursions", () => {
  it("finds the stretch inside the volume with its entry and exit times", () => {
    const path = eastboundPath({ altFt: 10000, startMs: MON + 3 * HOUR });
    const [inc] = findIncursions(path, [boxArea()]);
    expect(inc).toBeDefined();
    expect(inc.area.ident).toBe("TEST1");
    // Only the lon=100 sample (index 2, so 0300Z + 20 min) is inside the box.
    expect(new Date(inc.entryMs).toISOString()).toContain("03:20");
    expect(inc.minAltFt).toBe(10000);
    expect(inc.maxAltFt).toBe(10000);
  });

  it("reports the area as active when the crossing is inside its hours", () => {
    const path = eastboundPath({ altFt: 10000, startMs: MON + 3 * HOUR });
    const [inc] = findIncursions(path, [boxArea()]);
    expect(inc.worstState).toBe("active");
    expect(inc.activityAtEntry.detail).toContain("0100-0900");
  });

  it("reports the same crossing as inactive outside those hours", () => {
    const path = eastboundPath({ altFt: 10000, startMs: MON + 12 * HOUR });
    const [inc] = findIncursions(path, [boxArea()]);
    expect(inc.worstState).toBe("inactive");
  });

  it("ignores a flight above the area's ceiling", () => {
    const path = eastboundPath({ altFt: 30000, startMs: MON + 3 * HOUR });
    expect(findIncursions(path, [boxArea()])).toEqual([]);
  });

  it("still catches a flight level with the ceiling, within tolerance", () => {
    const path = eastboundPath({ altFt: 15000, startMs: MON + 3 * HOUR });
    expect(findIncursions(path, [boxArea()])).toHaveLength(1);
  });

  it("splits a route that leaves and re-enters into two incursions", () => {
    // Out the east side, back in again.
    const lons = [99.7, 100.2, 101.5, 100.2, 99.7];
    const path = eastboundPath({ altFt: 10000, startMs: MON + 3 * HOUR, lons });
    const found = findIncursions(path, [boxArea()]);
    expect(found).toHaveLength(2);
    expect(found[0].entryMs).not.toBe(found[1].entryMs);
  });

  it("measures the track distance flown inside the volume", () => {
    const lons = [99.6, 99.9, 100.2, 100.4];
    const path = eastboundPath({ altFt: 10000, startMs: MON + 3 * HOUR, lons });
    const [inc] = findIncursions(path, [boxArea()]);
    // 0.8° of longitude at 15°N is about 46 NM.
    expect(inc.transitNm).toBeGreaterThan(40);
    expect(inc.transitNm).toBeLessThan(52);
  });

  it("sorts active areas ahead of inactive ones", () => {
    const cold = boxArea({
      ident: "TEST2",
      activity: { ...workdaySchedule, designator: "TEST2", sheets: [] },
    });
    // TEST2 has no sheets and no note -> unknown, which must rank behind active.
    const path = eastboundPath({ altFt: 10000, startMs: MON + 3 * HOUR });
    const found = findIncursions(path, [cold, boxArea()]);
    expect(found.map((f) => f.worstState)).toEqual(["active", "unknown"]);
  });

  it("returns nothing for an empty path", () => {
    expect(findIncursions([], [boxArea()])).toEqual([]);
  });
});

describe("pathFromFixes", () => {
  const fixes = [
    { lat: 15, lon: 98 },
    { lat: 15, lon: 102 },
  ];

  it("densifies enough to catch an area sitting between two distant fixes", () => {
    // The two fixes are ~232 NM apart and both OUTSIDE the box; only the
    // interpolated samples fall inside it.
    const path = pathFromFixes(fixes, {
      startMs: MON + 3 * HOUR,
      gsKt: 450,
      altFt: 10000,
    });
    expect(findIncursions(path, [boxArea()])).toHaveLength(1);
  });

  it("misses that area when sampled only at the fixes", () => {
    // The failure mode this densification exists to prevent.
    const vertexOnly: TimedPoint[] = fixes.map((f, i) => ({
      ...f,
      altFt: 10000,
      timeMs: MON + 3 * HOUR + i * HOUR,
    }));
    expect(findIncursions(vertexOnly, [boxArea()])).toEqual([]);
  });

  it("advances time with distance at the given ground speed", () => {
    const path = pathFromFixes(fixes, {
      startMs: MON,
      gsKt: 464, // ~232 NM leg -> ~30 min
      altFt: 10000,
    });
    const elapsedMin = (path[path.length - 1].timeMs - path[0].timeMs) / 60000;
    expect(elapsedMin).toBeGreaterThan(25);
    expect(elapsedMin).toBeLessThan(35);
  });

  it("returns an empty path for no fixes", () => {
    expect(pathFromFixes([], { startMs: MON, gsKt: 450, altFt: 10000 })).toEqual([]);
  });
});

describe("routeLengthNm", () => {
  it("sums the great-circle legs", () => {
    const d = routeLengthNm([
      { lat: 15, lon: 98 },
      { lat: 15, lon: 100 },
      { lat: 15, lon: 102 },
    ]);
    expect(d).toBeGreaterThan(225);
    expect(d).toBeLessThan(240);
  });

  it("is zero for a single point", () => {
    expect(routeLengthNm([{ lat: 15, lon: 98 }])).toBe(0);
  });
});

describe("decimatePath", () => {
  const dense = pathFromFixes(
    [
      { lat: 15, lon: 98 },
      { lat: 15, lon: 102 },
    ],
    { startMs: MON, gsKt: 450, altFt: 10000, stepNm: 0.2 },
  );

  it("thins a dense trajectory substantially", () => {
    const thin = decimatePath(dense, 1.5);
    expect(thin.length).toBeLessThan(dense.length / 4);
  });

  it("keeps the first and last samples", () => {
    const thin = decimatePath(dense, 1.5);
    expect(thin[0]).toEqual(dense[0]);
    expect(thin[thin.length - 1]).toEqual(dense[dense.length - 1]);
  });

  it("still finds the same incursion after thinning", () => {
    expect(findIncursions(decimatePath(dense, 1.5), [boxArea()])).toHaveLength(1);
  });

  it("leaves a short path alone", () => {
    const two = dense.slice(0, 2);
    expect(decimatePath(two)).toEqual(two);
  });
});

describe("climbCruiseDescentFt", () => {
  const profile = climbCruiseDescentFt({ rflFt: 33000, depElevFt: 10, arrElevFt: 10 });
  const TOTAL = 400; // NM

  it("starts near field elevation and ends near it", () => {
    expect(profile(0, TOTAL)).toBeLessThan(200);
    expect(profile(TOTAL, TOTAL)).toBeLessThan(200);
  });

  it("reaches the requested level in the cruise", () => {
    expect(profile(TOTAL / 2, TOTAL)).toBe(33000);
  });

  it("climbs at roughly 3 NM per 1000 ft", () => {
    // 30 NM out should be near 10 000 ft.
    expect(profile(30, TOTAL)).toBeGreaterThan(9000);
    expect(profile(30, TOTAL)).toBeLessThan(11000);
  });

  it("never exceeds the requested level on a short leg that cannot reach it", () => {
    const short = climbCruiseDescentFt({ rflFt: 33000 });
    // 60 NM total: the climb and descent legs cross well below cruise.
    const peak = Math.max(...[0, 15, 30, 45, 60].map((d) => short(d, 60)));
    expect(peak).toBeLessThan(33000);
    expect(peak).toBeGreaterThan(5000);
  });

  it("is never negative", () => {
    for (const d of [0, 1, 200, 399, 400]) {
      expect(profile(d, TOTAL)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("pathFromFixes with a profile", () => {
  it("catches a low area under the climb-out that a cruise-level check misses", () => {
    // The box tops at 15 000 ft; the route crosses it 30 NM after departure.
    const fixes = [
      { lat: 15, lon: 99.0 },
      { lat: 15, lon: 103.0 },
    ];
    const flat = pathFromFixes(fixes, {
      startMs: MON + 3 * HOUR,
      gsKt: 450,
      altFt: 33000,
    });
    expect(findIncursions(flat, [boxArea()])).toEqual([]);

    const profiled = pathFromFixes(fixes, {
      startMs: MON + 3 * HOUR,
      gsKt: 450,
      altFt: climbCruiseDescentFt({ rflFt: 33000 }),
    });
    expect(findIncursions(profiled, [boxArea()]).length).toBeGreaterThan(0);
  });
});

describe("climbCruiseDescentFt — a flight only passing through", () => {
  it("is at cruise from the first point when the route starts at a crossing fix, not an aerodrome", () => {
    const level = climbCruiseDescentFt({ rflFt: 35000, startAtLevel: true, endAtLevel: true });
    expect(level(0, 300)).toBe(35000);
    expect(level(150, 300)).toBe(35000);
    expect(level(300, 300)).toBe(35000);
  });
  it("still climbs from the ground when only the END is a crossing fix", () => {
    const p = climbCruiseDescentFt({ rflFt: 35000, endAtLevel: true });
    expect(p(0, 300)).toBe(0);
    expect(p(300, 300)).toBe(35000);
  });
  it("still descends to the ground when only the START is a crossing fix", () => {
    const p = climbCruiseDescentFt({ rflFt: 35000, startAtLevel: true });
    expect(p(0, 300)).toBe(35000);
    expect(p(300, 300)).toBe(0);
  });
  it("is unchanged from before when neither option is given", () => {
    const p = climbCruiseDescentFt({ rflFt: 33000, depElevFt: 10, arrElevFt: 10 });
    expect(p(0, 300)).toBe(10);
  });
});
