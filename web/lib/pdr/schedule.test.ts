/**
 * The published PDR timetables decide whether a route conflicts at all, so the
 * cases that flip an answer are pinned here against a synthetic VY-shaped
 * fixture (`./__fixtures__/vyPdr`) and hand-built sheets, and the shipped
 * AIP Myanmar ENR 5.1 file (`public/data/VY_AIP/pdr_activity.json`) is checked
 * for what it actually contains.
 *
 * The three that matter and are easy to get wrong: windows that wrap midnight,
 * solar windows, and `excluded` sheets that subtract time rather than add it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { sheet, synthRecord as area } from "./__fixtures__/vyPdr";
import {
  activityAt,
  formatSchedule,
  formatSheet,
  isAlwaysActive,
  worseState,
} from "./schedule";
import type { PdrActivity, PdrActivityFile } from "./types";

const ACTIVITY = resolve(__dirname, "../../public/data/VY_AIP/pdr_activity.json");
const file = JSON.parse(readFileSync(ACTIVITY, "utf-8")) as PdrActivityFile;

/** Central Myanmar (near Naypyitaw) — near enough for every synthetic area's
 *  solar times. */
const AT = { lat: 19.6, lon: 96.2 };

/** 2026-09-07 is a Monday, so the weekday arithmetic is unambiguous. */
const MON = Date.UTC(2026, 8, 7);
const DAY = 86400000;

describe("activityAt — plain clock windows", () => {
  it("is active inside a MON-FRI window and inactive outside it", () => {
    const a = area("D91"); // MON-FRI 0100-0900 UTC
    expect(activityAt(a, MON + 3 * 3600000, AT).state).toBe("active");
    expect(activityAt(a, MON + 12 * 3600000, AT).state).toBe("inactive");
  });

  it("is inactive at the weekend", () => {
    const a = area("D91");
    const sat = MON + 5 * DAY + 3 * 3600000;
    expect(activityAt(a, sat, AT).state).toBe("inactive");
  });

  it("treats the window as half-open [start, end)", () => {
    const a = area("D91");
    expect(activityAt(a, MON + 1 * 3600000, AT).state).toBe("active"); // 0100
    expect(activityAt(a, MON + 9 * 3600000, AT).state).toBe("inactive"); // 0900
  });

  it("explains WHY, naming the period it matched", () => {
    const v = activityAt(area("D91"), MON + 3 * 3600000, AT);
    expect(v.detail).toContain("MON");
    expect(v.detail).toContain("0100-0900");
    expect(v.schedule).toBe("MON-FRI 0100-0900 UTC");
  });
});

describe("activityAt — windows that wrap midnight", () => {
  // D96 is MON-FRI 2300-1000: it OPENS on a weekday and closes the next
  // morning. Saturday 0800 is inside the window that opened on Friday, which a
  // same-day-only test reports as inactive.
  const a = () => area("D96");

  it("is active late on the opening day", () => {
    expect(activityAt(a(), MON + 23.5 * 3600000, AT).state).toBe("active");
  });

  it("is active the next morning, before the window closes", () => {
    expect(activityAt(a(), MON + DAY + 8 * 3600000, AT).state).toBe("active");
  });

  it("is inactive in the gap between closing and reopening", () => {
    expect(activityAt(a(), MON + DAY + 15 * 3600000, AT).state).toBe("inactive");
  });

  it("stays active on Saturday morning from Friday's window", () => {
    const satMorning = MON + 5 * DAY + 8 * 3600000;
    expect(activityAt(a(), satMorning, AT).state).toBe("active");
  });

  it("is inactive on Sunday morning — Saturday never opened one", () => {
    const sunMorning = MON + 6 * DAY + 8 * 3600000;
    expect(activityAt(a(), sunMorning, AT).state).toBe("inactive");
  });
});

describe("activityAt — solar windows", () => {
  // P93 is a PROHIBITED area active sunset to sunrise. In central Myanmar
  // (MMT = UTC+6:30) in September that is roughly 1145Z-2320Z; local midday
  // (0500Z = 1130 MMT) must be cold, local night hot.
  const a = () => area("P93");

  it("is active in the middle of the night", () => {
    expect(activityAt(a(), MON + 18 * 3600000, AT).state).toBe("active");
  });

  it("is inactive in the middle of the day", () => {
    expect(activityAt(a(), MON + 5 * 3600000, AT).state).toBe("inactive");
  });

  it("is active just after local sunset and again before sunrise", () => {
    // ~1815 MMT = 1145Z is right at sunset; 2200Z (0430 MMT) is solidly dark.
    expect(activityAt(a(), MON + 22 * 3600000, AT).state).toBe("active");
    // 2300Z = 0530 MMT, still before sunrise (~2320Z).
    expect(activityAt(a(), MON + 23 * 3600000, AT).state).toBe("active");
  });

  it("prints the schedule in words rather than clock times", () => {
    expect(formatSchedule(a())).toBe("Daily sunset to sunrise");
  });
});

describe("activityAt — excluded sheets subtract time", () => {
  it("stays active inside the window when only a HOL exclusion applies", () => {
    // D97: MON-FRI 0130-0930, except public holidays.
    const v = activityAt(area("D97"), MON + 5 * 3600000, AT);
    expect(v.state).toBe("active");
    expect(v.holidayCaveat).toBe(true);
  });

  it("carries the holiday caveat rather than silently ignoring it", () => {
    const v = activityAt(area("D97"), MON + 5 * 3600000, AT);
    expect(formatSchedule(area("D97"))).toContain("except");
    expect(v.holidayCaveat).toBe(true);
  });

  it("reports inactive when a non-holiday exclusion covers the instant", () => {
    const synthetic: PdrActivity = {
      designator: "TEST",
      type: "D",
      name: "TEST",
      sheets: [
        sheet({ day: "MON", dayTil: "FRI", start: "00:00", end: "24:00" }),
        sheet({ day: "WED", start: "00:00", end: "24:00", excluded: true }),
      ],
      activityNote: "",
      restriction: "",
      hazard: "",
      remarks: "",
    };
    expect(activityAt(synthetic, MON + 5 * 3600000, AT).state).toBe("active");
    const wed = MON + 2 * DAY + 5 * 3600000;
    const v = activityAt(synthetic, wed, AT);
    expect(v.state).toBe("inactive");
    expect(v.detail).toContain("excluded");
  });
});

describe("activityAt — areas notified by NOTAM", () => {
  // A deliberate modelling choice, not a reading of the data: with no NOTAM
  // feed, calling these active shut routes for airspace that is cold on most
  // days. The assumption has to travel with the verdict.
  it("reports them INACTIVE", () => {
    const v = activityAt(area("R95"), MON + 5 * 3600000, AT);
    expect(v.state).toBe("inactive");
  });

  it("says in the detail that this is an assumption, not a published window", () => {
    const v = activityAt(area("R95"), MON + 5 * 3600000, AT);
    expect(v.detail).toMatch(/NOTAM/i);
    expect(v.detail).toMatch(/treated as INACTIVE/i);
    expect(v.detail).toMatch(/confirm/i);
  });

  it("holds at every hour of every day — there is no window to fall outside", () => {
    for (let h = 0; h < 24 * 7; h += 7) {
      expect(activityAt(area("R95"), MON + h * 3600000, AT).state).toBe("inactive");
    }
  });

  it("does not touch an area that publishes a timesheet AND mentions NOTAM", () => {
    // D98 is SAT-SUN 2300-1400, "after this period will be notified by
    // NOTAM". The published window still governs: inside it the area is ACTIVE,
    // and the assumption must not reach in and turn that off.
    const sat = MON + 5 * DAY; // Saturday
    expect(activityAt(area("D98"), sat + 23.5 * 3600000, AT).state).toBe("active");
    // Wednesday afternoon is outside every published sheet.
    expect(activityAt(area("D98"), MON + 2 * DAY + 18 * 3600000, AT).state).toBe(
      "inactive",
    );
  });
});

describe("activityAt — what the data cannot answer", () => {
  it("stays unknown for a note it cannot parse into a window", () => {
    // D99 publishes "MON - FRI" with no times. Something IS published; this
    // app just cannot read it, which is a different claim from "by NOTAM".
    const v = activityAt(area("D99"), MON + 5 * 3600000, AT);
    expect(v.state).toBe("unknown");
    expect(v.detail).toMatch(/MON - FRI/);
    expect(v.detail).toMatch(/assume active/i);
  });

  it("returns unknown when a polygon has no activity record at all", () => {
    const v = activityAt(null, MON, AT);
    expect(v.state).toBe("unknown");
    expect(v.detail).toMatch(/assume active/i);
  });
});

describe("formatSheet", () => {
  it("prints a day span and clock window the way the AIP does", () => {
    expect(formatSheet(sheet({ day: "MON", dayTil: "FRI", start: "01:00", end: "09:00" })))
      .toBe("MON-FRI 0100-0900 UTC");
  });

  it("prints ANY as Daily and HOL as public holidays", () => {
    expect(formatSheet(sheet({ day: "ANY", start: "00:00", end: "24:00" })))
      .toBe("Daily 0000-2400 UTC");
    expect(formatSheet(sheet({ day: "HOL", start: "00:00", end: "24:00" })))
      .toContain("Public holidays");
  });
});

describe("worseState", () => {
  it("ranks active over unknown over inactive", () => {
    expect(worseState("unknown", "active")).toBe("active");
    expect(worseState("inactive", "unknown")).toBe("unknown");
    expect(worseState("inactive", "inactive")).toBe("inactive");
  });
});

describe("the shipped AIP Myanmar ENR 5.1 activity file", () => {
  it("resolves every area to one of the three states without throwing", () => {
    expect(file.areas.length).toBeGreaterThan(0);
    for (const a of file.areas) {
      const v = activityAt(a, MON + 5 * 3600000, AT);
      expect(["active", "inactive", "unknown"]).toContain(v.state);
    }
  });

  const byIdent = (id: string) => {
    const a = file.areas.find((x) => x.type + x.designator === id);
    if (!a) throw new Error("no area " + id);
    return a;
  };
  const at = (id: string) => activityAt(byIdent(id), MON + 5 * 3600000, AT);

  it("reads a NOTAM-activated area as INACTIVE", () => {
    // ENR 5.1: "Times notified by NOTAM" / "Notified by NOTAM when area is
    // active" -- including R16/R52, whose remark also says H24.
    for (const id of ["D1", "D9", "D10", "D21", "D23A", "D23B", "D24", "D25",
      "R16", "R41", "R46B", "R52", "R53"]) {
      expect(at(id).state, id).toBe("inactive");
      expect(byIdent(id).sheets, id).toEqual([]);
    }
  });

  it("reads 'Active: Permanent' / H24 as active around the clock", () => {
    for (const id of ["P5", "P31", "P33", "R11", "R13", "R47", "R54"]) {
      expect(at(id).state, id).toBe("active");
      expect(isAlwaysActive(byIdent(id)), id).toBe(true);
    }
  });

  it("assumes active an area ENR 5.1 lists no row for", () => {
    // VYR40A/B are drawn on the training-area chart only.
    for (const id of ["R40A", "R40B"]) {
      expect(at(id).state, id).toBe("unknown");
      expect(at(id).detail).toMatch(/assume active/i);
    }
  });

  it("classifies every area (13 NOTAM, 40 H24, 2 unpublished)", () => {
    const states = file.areas.map((a) => activityAt(a, MON + 5 * 3600000, AT).state);
    expect(states.filter((s) => s === "inactive")).toHaveLength(13);
    expect(states.filter((s) => s === "active")).toHaveLength(40);
    expect(states.filter((s) => s === "unknown")).toHaveLength(2);
  });
});

describe("isAlwaysActive — can re-timing ever clear this area?", () => {
  it("is true for an area published Daily 0000-2400", () => {
    // P92 is Daily 0000-2400. No date change can ever clear it.
    expect(isAlwaysActive(area("P92"))).toBe(true);
  });

  it("is false for a weekday window, which does have inactive periods", () => {
    expect(isAlwaysActive(area("D91"))).toBe(false); // MON-FRI 0100-0900
  });

  it("is false for a solar window — sunset to sunrise has a daytime gap", () => {
    expect(isAlwaysActive(area("P93"))).toBe(false);
  });

  it("is false when activation is by NOTAM — an assumed-cold area is not 'always'", () => {
    expect(isAlwaysActive(area("R95"))).toBe(false);
  });

  it("is false when an exclusion carves time out", () => {
    expect(isAlwaysActive(area("D97"))).toBe(false); // except public holidays
  });

  it("is false for no activity record at all", () => {
    expect(isAlwaysActive(null)).toBe(false);
  });

  it("treats a full MON-SUN 0000-2400 span as continuous too", () => {
    expect(
      isAlwaysActive({
        designator: "T",
        type: "R",
        name: "T",
        sheets: [
          sheet({ day: "MON", dayTil: "SUN", start: "00:00", end: "24:00" }),
        ],
        activityNote: "",
        restriction: "",
        hazard: "",
        remarks: "",
      }),
    ).toBe(true);
  });
});
