/**
 * Small synthetic PDR fixture for the lib/pdr tests, shaped like the Myanmar
 * (Yangon FIR) AIXM 2609 export but with made-up schedules.
 *
 * The real `VY_AIP/pdr_activity.json` (AIP Myanmar ENR 5.1) only knows two
 * schedules — H24 and "notified by NOTAM" — so it cannot exercise the rest of
 * the schedule logic: weekday windows, windows that wrap midnight, solar
 * windows, holiday exclusions. These areas carry one of each.
 *
 * Designators 91-99 are deliberately outside the real VY range (1-54) so a
 * synthetic area can never be mistaken for a published one, and every name
 * starts with "SYNTH". Geometry follows `aixm_vy/restricted_areas.geojson`:
 * `type` + `designator` + `name` + AIP-style `lower`/`upper` strings, one
 * MultiPolygon per feature. Squares are placed over open country in the FIR,
 * well apart from each other.
 */
import type { PdrActivity, PdrActivityFile, Timesheet } from "../types";

/** Main VY aerodromes (aip_VY.json reference points). */
export const VYYY = { lat: 16.90726667, lon: 96.13323889 }; // Yangon Intl
export const VYMD = { lat: 21.70107222, lon: 95.97745556 }; // Mandalay Intl
export const VYNT = { lat: 19.62355, lon: 96.201 }; // Naypyitaw Intl

export const sheet = (over: Partial<Timesheet>): Timesheet => ({
  day: "ANY",
  dayTil: null,
  start: null,
  end: null,
  startEvent: null,
  endEvent: null,
  excluded: false,
  timeReference: "UTC",
  ...over,
});

interface SynthArea {
  type: "P" | "R" | "D";
  designator: string;
  name: string;
  lower: string;
  upper: string;
  /** Square centre and half-side (degrees). */
  lat: number;
  lon: number;
  half?: number;
  sheets: Timesheet[];
  activityNote?: string;
  restriction?: string;
  hazard?: string;
  remarks?: string;
}

const SYNTH: SynthArea[] = [
  {
    // Weekday clock window — the workhorse of the time-of-day tests.
    type: "D", designator: "91", name: "SYNTH WEEKDAY",
    lower: "GND SFC", upper: "200 STD", lat: 19.0, lon: 95.0,
    sheets: [sheet({ day: "MON", dayTil: "FRI", start: "01:00", end: "09:00" })],
    restriction: "Military flying training",
    hazard: "Air-to-ground firing",
  },
  {
    // Prohibited, active H24, no ceiling.
    type: "P", designator: "92", name: "SYNTH H24",
    lower: "GND SFC", upper: "UNL STD", lat: 20.0, lon: 94.4,
    sheets: [sheet({ day: "ANY", start: "00:00", end: "24:00" })],
  },
  {
    // Prohibited, sunset to sunrise.
    type: "P", designator: "93", name: "SYNTH NIGHT",
    lower: "GND SFC", upper: "100 STD", lat: 18.0, lon: 94.5,
    sheets: [sheet({ day: "ANY", startEvent: "SS", endEvent: "SR" })],
  },
  {
    // Restricted, H24, low — sits on the departure end of the terminal tests.
    type: "R", designator: "94", name: "SYNTH TERMINAL",
    lower: "GND SFC", upper: "3000 MSL", lat: 16.5, lon: 95.5, half: 0.1,
    sheets: [sheet({ day: "ANY", start: "00:00", end: "24:00" })],
    remarks: "Entry only with prior permission from the controlling authority",
  },
  {
    // Restricted, activated by NOTAM, no timesheet.
    type: "R", designator: "95", name: "SYNTH NOTAM",
    lower: "GND SFC", upper: "150 STD", lat: 18.0, lon: 97.5,
    sheets: [],
    activityNote: "Notified by NOTAM",
  },
  {
    // Weekday window that wraps midnight: MON-FRI 2300-1000.
    type: "D", designator: "96", name: "SYNTH WRAP",
    lower: "GND SFC", upper: "150 STD", lat: 20.5, lon: 97.5,
    sheets: [sheet({ day: "MON", dayTil: "FRI", start: "23:00", end: "10:00" })],
  },
  {
    // Weekday window except public holidays.
    type: "D", designator: "97", name: "SYNTH HOLIDAY",
    lower: "GND SFC", upper: "150 STD", lat: 22.5, lon: 97.0,
    sheets: [
      sheet({ day: "MON", dayTil: "FRI", start: "01:30", end: "09:30" }),
      sheet({ day: "HOL", start: "00:00", end: "24:00", excluded: true }),
    ],
  },
  {
    // A published window AND a NOTAM mention.
    type: "D", designator: "98", name: "SYNTH WEEKEND",
    lower: "GND SFC", upper: "150 STD", lat: 23.5, lon: 95.0,
    sheets: [sheet({ day: "SAT", dayTil: "SUN", start: "23:00", end: "14:00" })],
    activityNote: "After this period will be notified by NOTAM",
  },
  {
    // Something published that is not a time window.
    type: "D", designator: "99", name: "SYNTH NOTE",
    lower: "GND SFC", upper: "150 STD", lat: 24.5, lon: 96.5,
    sheets: [],
    activityNote: "MON - FRI",
  },
];

function square(lat: number, lon: number, h: number): number[][][][] {
  return [
    [
      [
        [lon - h, lat - h],
        [lon + h, lat - h],
        [lon + h, lat + h],
        [lon - h, lat + h],
        [lon - h, lat - h],
      ],
    ],
  ];
}

/** Features in the `aixm_vy/restricted_areas.geojson` property schema. */
export const synthGeo: { type: "FeatureCollection"; features: GeoJSON.Feature[] } = {
  type: "FeatureCollection",
  features: SYNTH.map((a) => ({
    type: "Feature",
    properties: {
      type: a.type,
      designator: a.designator,
      name: a.name,
      lower: a.lower,
      upper: a.upper,
      activity_note: a.activityNote ?? "",
      restriction: a.restriction ?? "",
      hazard: a.hazard ?? "",
      remarks: a.remarks ?? "",
    },
    geometry: {
      type: "MultiPolygon",
      coordinates: square(a.lat, a.lon, a.half ?? 0.15),
    },
  })),
};

/** The matching `pdr_activity.json`-shaped timetable. */
export const synthActivity: PdrActivityFile = {
  source: "synthetic VY-shaped fixture",
  validFrom: "2026-09-03T00:00:00Z",
  validTo: "2026-10-01T00:00:00Z",
  areas: SYNTH.map(
    (a): PdrActivity => ({
      designator: a.designator,
      type: a.type,
      name: a.name,
      sheets: a.sheets,
      activityNote: a.activityNote ?? "",
      restriction: a.restriction ?? "",
      hazard: a.hazard ?? "",
      remarks: a.remarks ?? "",
    }),
  ),
};

/** One synthetic activity record by type + designator ("D91"). */
export function synthRecord(ident: string): PdrActivity {
  const a = synthActivity.areas.find((x) => x.type + x.designator === ident);
  if (!a) throw new Error("fixture missing " + ident);
  return a;
}

/** A point well clear of every synthetic area (Andaman Sea, west of VYYY). */
export const CLEAR = [
  { lat: 14.0, lon: 94.0 },
  { lat: 14.5, lon: 94.5 },
];
