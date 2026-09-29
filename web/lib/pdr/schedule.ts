/**
 * Is this area hot right now? — evaluating the published PDR timetable.
 *
 * The AIP states an area's activity as a set of AIXM timesheets, and the whole
 * point of this module is that a route only conflicts with a P/D/R area if it
 * is inside the volume *while the area is active*. A flight crossing a MON-FRI
 * 0100-0900 danger area at 1200Z is fine; the same route at 0300Z is not.
 *
 * Three details in the real data drive most of the code here, and getting any
 * of them wrong flips the answer for a whole class of areas:
 *
 *  1. **Windows wrap midnight.** "MON-FRI 2300-1000" starts on a weekday and
 *     runs into the next morning, so Saturday 0800 IS inside it (the window
 *     that started Friday). Every lookup therefore tests the window that began
 *     yesterday as well as today's.
 *  2. **Some windows are solar**, not clock — "sunset to sunrise" moves with
 *     the date and the area's position (see ./solar).
 *  3. **Some sheets subtract.** A sheet marked `excluded` carves time OUT of
 *     the others: "MON-FRI 0130-0930 *except public holidays*" is
 *     two sheets, the second one excluded. OR-ing every sheet together, the
 *     obvious implementation, gets that area exactly backwards on a holiday.
 *
 * Where the app genuinely cannot answer — a public holiday with no holiday
 * calendar in the dataset, or a polygon with no activity record at all — the
 * verdict is `unknown` rather than a guess. Callers are expected to treat that
 * conservatively and say so; see ./detect.
 *
 * The one deliberate assumption
 * ----------------------------
 * An area may publish no timesheet at all, only the activity note "Notified by
 * NOTAM". Those are reported INACTIVE here. It is
 * a modelling choice, not a reading of the data: a fast-time run has no NOTAM
 * feed, and calling them active for want of one shut whole routes for areas
 * that are cold on most days — the tool contradicting itself about airspace it
 * cannot actually see. The verdict carries the assumption in its `detail`, so
 * the reason travels with the answer, and the moment a NOTAM source is wired in
 * this branch is the only place that has to change.
 *
 * The Myanmar AIRAC 2609 export publishes NEITHER for any P/R/D area — every
 * record has an empty `sheets` list and an empty activity note — so today
 * every VY area evaluates to `unknown` ("assume active"). That is the safe
 * reading; the schedule logic stays in place for when timetables are ingested.
 *
 * A note on what a day code means
 * ------------------------------
 * AIXM says a sheet's `day` is the day the period STARTS, read in its own
 * `timeReference` — UTC throughout this dataset — and that is what this file
 * implements. It matters for the wrapped windows: "MON-FRI 2300-1700 UTC" is
 * active Mon 2300Z to Tue 1700Z and leaves Monday daytime cold.
 *
 * Read as LOCAL days (Myanmar, MMT = UTC+6:30) the same line would mean
 * 0530-2330 local on weekdays, which is the more natural shape for a military
 * training area, and would flag a different set of flights. The AIXM export states UTC, so UTC is
 * what is honoured here; if the underlying AIP turns out to publish these in
 * local time, the fix belongs in the ingest (shifting the day codes with the
 * times), not in this evaluator.
 */

import type {
  ActivityState,
  ActivityVerdict,
  PdrActivity,
  Timesheet,
} from "./types";
import { sunTimes } from "./solar";

const DAY_MS = 86400000;

/** ICAO day codes in week order. Index 0 = Monday, matching the way the AIP
 *  prints spans ("MON-FRI"); JS `getUTCDay()` is Sunday-first and is converted. */
const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

function dayIndexUtc(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0
}

function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** "01:30" -> 90 minutes. "24:00" is end-of-day, i.e. 1440. */
function minutesOf(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Does a day-code span cover this weekday? Spans are inclusive and may wrap
 *  the week end ("SAT-SUN", and in principle "FRI-MON"). */
function daySpanCovers(day: string, dayTil: string | null, idx: number): boolean {
  const from = DAYS.indexOf(day.toUpperCase() as (typeof DAYS)[number]);
  if (from < 0) return false;
  if (!dayTil) return idx === from;
  const to = DAYS.indexOf(dayTil.toUpperCase() as (typeof DAYS)[number]);
  if (to < 0) return idx === from;
  if (from <= to) return idx >= from && idx <= to;
  return idx >= from || idx <= to; // wraps the week boundary
}

/** The one window a sheet opens on the UTC day starting at `dayStartMs`, or
 *  null when the sheet does not apply to that day. `[start, end)` in epoch ms;
 *  `end` may fall on the following day (a wrapped window). */
function windowOn(
  sheet: Timesheet,
  dayStartMs: number,
  at: { lat: number; lon: number },
): { start: number; end: number } | null {
  const code = sheet.day.toUpperCase();
  if (code !== "ANY" && !daySpanCovers(code, sheet.dayTil, dayIndexUtc(dayStartMs))) {
    return null;
  }

  // Solar sheets: resolve the events for this day, and carry a start-after-end
  // pair (sunset -> sunrise) into the next morning.
  if (sheet.startEvent || sheet.endEvent) {
    const today = sunTimes(new Date(dayStartMs), at.lat, at.lon);
    if (!today) return null;
    const pick = (ev: string | null, t: { sunriseMs: number; sunsetMs: number }) =>
      String(ev).toUpperCase() === "SS" ? t.sunsetMs : t.sunriseMs;
    const start = pick(sheet.startEvent, today);
    let end = pick(sheet.endEvent, today);
    if (end <= start) {
      const tomorrow = sunTimes(new Date(dayStartMs + DAY_MS), at.lat, at.lon);
      if (!tomorrow) return null;
      end = pick(sheet.endEvent, tomorrow);
    }
    return { start, end };
  }

  const startMin = minutesOf(sheet.start);
  const endMin = minutesOf(sheet.end);
  if (startMin == null || endMin == null) return null;
  const start = dayStartMs + startMin * 60000;
  // end <= start means the window runs past midnight into the next day.
  const end = dayStartMs + (endMin <= startMin ? endMin + 1440 : endMin) * 60000;
  return { start, end };
}

/** Does this sheet cover `whenMs`? Tests today's window and yesterday's, so a
 *  window that wrapped midnight is still found.
 *
 *  Exported because the ENR 1.10 route conditions carry the same kind of
 *  window ("MON-FRI 0100-0900 UTC"); ./routeRules parses one into a `Timesheet`
 *  and asks this rather than growing a second, subtly different, time parser. */
export function sheetCovers(
  sheet: Timesheet,
  whenMs: number,
  at: { lat: number; lon: number },
): boolean {
  const today = utcMidnight(whenMs);
  for (const dayStart of [today, today - DAY_MS]) {
    const w = windowOn(sheet, dayStart, at);
    if (w && whenMs >= w.start && whenMs < w.end) return true;
  }
  return false;
}

// --- display ---------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = { SR: "sunrise", SS: "sunset" };

/** One sheet as the AIP would read it: "MON-FRI 0100-0900 UTC". */
export function formatSheet(sheet: Timesheet): string {
  const code = sheet.day.toUpperCase();
  const days =
    code === "ANY"
      ? "Daily"
      : code === "HOL"
        ? "Public holidays"
        : sheet.dayTil
          ? code + "-" + sheet.dayTil.toUpperCase()
          : code;
  const ev = (e: string | null) => EVENT_LABEL[String(e).toUpperCase()] ?? e ?? "";
  const clock = (t: string | null) => (t ?? "").replace(":", "");
  const window =
    sheet.startEvent || sheet.endEvent
      ? ev(sheet.startEvent) + " to " + ev(sheet.endEvent)
      : clock(sheet.start) + "-" + clock(sheet.end) + " " + sheet.timeReference;
  return (days + " " + window).trim();
}

/** The whole published schedule, printed. Exclusions are marked so a reader
 *  can tell "except public holidays" from another active window. */
export function formatSchedule(activity: PdrActivity | null): string {
  if (!activity) return "no published activity record";
  if (activity.sheets.length === 0) {
    return activity.activityNote || "no published activity time";
  }
  return activity.sheets
    .map((s) => (s.excluded ? "except " + formatSheet(s) : formatSheet(s)))
    .join("; ");
}

// --- the verdict -----------------------------------------------------------

/** How many weekdays a sheet's day code covers. ANY is the whole week; HOL
 *  cannot be counted without a holiday calendar and reports 0. */
function daysCovered(sheet: Timesheet): number {
  const code = sheet.day.toUpperCase();
  if (code === "ANY") return 7;
  if (code === "HOL") return 0;
  let n = 0;
  for (let i = 0; i < 7; i++) {
    if (daySpanCovers(code, sheet.dayTil, i)) n++;
  }
  return n;
}

/**
 * Is this area active at every instant, so that re-timing the flight can never
 * clear it?
 *
 * The distinction matters for the advice the check gives. An area published
 * MON-FRI 0100-0900 has inactive periods, so "fly outside the active window" is
 * a real option. An area published Daily 0000-2400 (a city prohibited area,
 * say) is never inactive, and telling a controller to change the date would waste their time.
 *
 * Conservative in both directions. A solar window ("sunset to sunrise") is not
 * treated as always-active because it genuinely has a gap; an area with no
 * timesheet at all returns false, because nothing published says it is
 * permanently active — see `activityAt` for what happens to those.
 */
export function isAlwaysActive(activity: PdrActivity | null): boolean {
  if (!activity || activity.sheets.length === 0) return false;
  // An exclusion carves time out, so the area has an inactive period by
  // construction.
  if (activity.sheets.some((s) => s.excluded)) return false;
  return activity.sheets.some(
    (s) =>
      !s.startEvent &&
      !s.endEvent &&
      s.start === "00:00" &&
      s.end === "24:00" &&
      daysCovered(s) === 7,
  );
}

/** Worst-case ordering: an active area outranks one we cannot judge, which
 *  outranks a cold one. Used to reduce a whole crossing to one state. */
export function worseState(a: ActivityState, b: ActivityState): ActivityState {
  const rank: Record<ActivityState, number> = { active: 0, unknown: 1, inactive: 2 };
  return rank[a] <= rank[b] ? a : b;
}

/**
 * Is `activity` hot at `whenMs` (UTC epoch ms), for an area centred at `at`?
 *
 * `at` matters only for solar schedules, but is always required — the caller
 * has the centroid anyway and making it optional invites passing the wrong one
 * silently.
 */
export function activityAt(
  activity: PdrActivity | null,
  whenMs: number,
  at: { lat: number; lon: number },
): ActivityVerdict {
  const schedule = formatSchedule(activity);

  // No AIXM record for this polygon at all. Nothing to evaluate.
  if (!activity) {
    return {
      state: "unknown",
      schedule,
      detail: "No published activity record in this AIRAC - assume active.",
      holidayCaveat: false,
    };
  }

  // No timesheet to evaluate. Two different situations hide behind that.
  if (activity.sheets.length === 0) {
    const note = activity.activityNote || "";
    // "Notified by NOTAM" is a real answer in the AIP, and no NOTAM feed is
    // wired in. Treated as INACTIVE: see the file header for why, and note that
    // this leaves the state honest in the detail rather than silent.
    if (/notam/i.test(note)) {
      return {
        state: "inactive",
        schedule,
        detail:
          "Activation is by NOTAM and no NOTAM source is wired in - treated as INACTIVE. Confirm against the NOTAMs for the day of flight.",
        holidayCaveat: false,
      };
    }
    // An unstructured note ("MON - FRI", with no times) is not the same claim:
    // something IS published, this app just cannot parse it into a window.
    return {
      state: "unknown",
      schedule,
      detail: note
        ? 'Published activity "' + note + '" could not be read as a time window - assume active.'
        : "No structured activity time published - assume active.",
      holidayCaveat: false,
    };
  }

  const stamp = new Date(whenMs).toISOString().slice(11, 16) + "Z";
  const dayName = DAYS[dayIndexUtc(whenMs)];

  // Exclusions first: a matching exclusion beats every inclusion. A HOL
  // exclusion cannot be decided without a holiday calendar, so it becomes a
  // caveat on whatever the inclusions say rather than an answer of its own.
  let holidayCaveat = false;
  for (const s of activity.sheets) {
    if (!s.excluded) continue;
    if (s.day.toUpperCase() === "HOL") {
      holidayCaveat = true;
      continue;
    }
    if (sheetCovers(s, whenMs, at)) {
      return {
        state: "inactive",
        schedule,
        detail:
          dayName + " " + stamp + " falls in an excluded period (" + formatSheet(s) + ").",
        holidayCaveat,
      };
    }
  }

  for (const s of activity.sheets) {
    if (s.excluded) continue;
    if (s.day.toUpperCase() === "HOL") {
      holidayCaveat = true;
      continue;
    }
    if (sheetCovers(s, whenMs, at)) {
      return {
        state: "active",
        schedule,
        detail:
          dayName + " " + stamp + " is inside the active period (" + formatSheet(s) + ").",
        holidayCaveat,
      };
    }
  }

  return {
    state: "inactive",
    schedule,
    detail: dayName + " " + stamp + " is outside every published active period.",
    holidayCaveat,
  };
}
