/**
 * EOBT is UTC, end to end.
 *
 * The field is labelled "EOBT (UTC)" and the browser renders it in the user's
 * locale — so 13:05 shows as "01:05 PM". Everything downstream reads the
 * 24-hour `datetime-local` value, and a single local-time interpretation
 * anywhere in the chain shifts every crossing time by the machine's offset
 * (+06:30 in Myanmar) and makes an AM entry behave like the previous evening.
 *
 * These pin the chain the PDR check uses:
 *
 *     datetime-local string -> eobtToMs -> path timestamps -> incursion times
 *                                                         -> activity verdict
 *
 * 01:05 and 13:05 on the same date must come out exactly 12 hours apart, at the
 * stated UTC hour, with no offset applied at any step.
 */
import { describe, expect, it } from "vitest";

import { eobtToMs, msToEobt } from "@/lib/departureSeparation";
import { parseFlightFile } from "@/lib/flightFile";

import { synthActivity, synthGeo } from "./__fixtures__/vyPdr";
import { buildPdrAreas } from "./areas";
import { findIncursions, pathFromFixes } from "./penetration";
import { activityAt } from "./schedule";

const areas = buildPdrAreas(synthGeo, synthActivity);
const find = (ident: string) => {
  const a = areas.find((x) => x.ident === ident);
  if (!a) throw new Error("no area " + ident);
  return a;
};

/** 8 Jul 2026 is a Wednesday. "01:05 AM" and "01:05 PM" as the input stores them. */
const AM = "2026-07-08T01:05";
const PM = "2026-07-08T13:05";

describe("eobtToMs treats the datetime-local value as UTC", () => {
  it("reads the morning value at the stated UTC hour", () => {
    expect(new Date(eobtToMs(AM)!).toISOString()).toBe("2026-07-08T01:05:00.000Z");
  });

  it("reads the afternoon value at the stated UTC hour", () => {
    expect(new Date(eobtToMs(PM)!).toISOString()).toBe("2026-07-08T13:05:00.000Z");
  });

  it("puts them exactly 12 hours apart", () => {
    expect(eobtToMs(PM)! - eobtToMs(AM)!).toBe(12 * 3600 * 1000);
  });

  it("does not depend on the machine's timezone", () => {
    // Date.UTC-based parsing, so this is the same number wherever it runs.
    // A `new Date(str)` implementation would return the local reading here.
    expect(eobtToMs(AM)).toBe(Date.UTC(2026, 6, 8, 1, 5));
    expect(eobtToMs(PM)).toBe(Date.UTC(2026, 6, 8, 13, 5));
  });

  it("round-trips through msToEobt without drifting", () => {
    for (const v of [AM, PM]) {
      expect(msToEobt(eobtToMs(v)!)).toBe(v);
    }
  });

  it("accepts seconds and a trailing Z without shifting", () => {
    expect(eobtToMs("2026-07-08T13:05:00")).toBe(eobtToMs(PM));
    expect(eobtToMs("2026-07-08T13:05:00Z")).toBe(eobtToMs(PM));
  });
});

describe("the crossing time follows the EOBT, AM and PM alike", () => {
  const area = () => find("R94"); // synthetic, GND-3000 ft, active H24
  const crossing = (eobt: string) => {
    const startMs = eobtToMs(eobt)!;
    const { lat, lon } = area().centroid;
    const path = pathFromFixes(
      [
        { lat, lon: lon - 0.2 },
        { lat, lon: lon + 0.2 },
      ],
      { startMs, gsKt: 450, altFt: 2000 },
    );
    const inc = findIncursions(path, [area()])[0];
    expect(inc).toBeDefined();
    return inc;
  };

  it("puts a 0105Z departure's crossing in the 01Z hour", () => {
    expect(new Date(crossing(AM).entryMs).toISOString()).toContain("T01:0");
  });

  it("puts a 1305Z departure's crossing in the 13Z hour", () => {
    expect(new Date(crossing(PM).entryMs).toISOString()).toContain("T13:0");
  });

  it("separates the two crossings by exactly 12 hours", () => {
    expect(crossing(PM).entryMs - crossing(AM).entryMs).toBe(12 * 3600 * 1000);
  });
});

describe("the activity verdict is read at the right UTC hour", () => {
  // D91 (synthetic) is MON-FRI 0100-0900 UTC. 0105Z is inside that window and
  // 1305Z is outside it, so the two EOBTs must give OPPOSITE verdicts. If any
  // step applied a local offset both would land in the same state and the bug
  // would be invisible in a single-time test.
  const a = () => find("D91").activity;
  const at = (eobt: string) =>
    activityAt(a(), eobtToMs(eobt)!, find("D91").centroid).state;

  it("is active for the 0105Z departure", () => {
    expect(at(AM)).toBe("active");
  });

  it("is inactive for the 1305Z departure", () => {
    expect(at(PM)).toBe("inactive");
  });

  it("would not be distinguishable if a +06:30 offset were applied", () => {
    // Guard against a "fix" that shifts everything uniformly: adding the
    // Myanmar offset moves 0105Z to 0735Z, still inside the window, and 1305Z
    // to 1935Z, still outside — the states would coincidentally survive. What
    // does NOT survive is the hour itself, so assert that too.
    expect(new Date(eobtToMs(AM)!).getUTCHours()).toBe(1);
    expect(new Date(eobtToMs(PM)!).getUTCHours()).toBe(13);
  });
});

describe("an imported EOBT keeps the instant it states", () => {
  // The bug this covers: the importer took the first HH:mm after the date and
  // dropped everything after it, INCLUDING the offset. A Myanmar-local file
  // was then read six and a half hours late, so an 0105Z departure behaved
  // like 0735Z and a morning EOBT looked like an evening one.
  const csv = (eobt: string) =>
    new File(
      [
        [
          "callsign,actype,adep,ades,eobt,rfl,route",
          `UBA101,AT72,VYYY,VYMD,${eobt},210,BGO W13 MIA`,
          "",
        ].join("\n"),
      ],
      "import.csv",
    );
  const imported = async (eobt: string) => {
    const rows = await parseFlightFile(csv(eobt));
    expect(rows).toHaveLength(1);
    return rows[0].eobt!;
  };

  it("converts a +06:30 value to the same instant in UTC", async () => {
    // 19:35 in Yangon (MMT) IS 13:05Z.
    expect(await imported("2026-07-08T19:35:00+06:30")).toBe(PM);
  });

  it("converts a negative offset the same way", async () => {
    // 21:05 the previous day at -04:00 IS 0105Z on the 8th.
    expect(await imported("2026-07-07T21:05:00-04:00")).toBe(AM);
  });

  it("leaves a Z value on its stated hour", async () => {
    expect(await imported("2026-07-08T13:05:00Z")).toBe(PM);
  });

  it("leaves a naive value alone — the project reads it as UTC", async () => {
    expect(await imported("2026-07-08T13:05:00")).toBe(PM);
  });

  it("reaches the right UTC instant end to end", async () => {
    const local = await imported("2026-07-08T19:35:00+06:30");
    expect(new Date(eobtToMs(local)!).toISOString()).toBe(
      "2026-07-08T13:05:00.000Z",
    );
  });

  it("puts an offset AM value in the 01Z hour, not 6.5 hours later", async () => {
    const local = await imported("2026-07-08T07:35:00+06:30"); // = 0105Z
    expect(new Date(eobtToMs(local)!).getUTCHours()).toBe(1);
  });
});
