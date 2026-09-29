/**
 * The rules attached to a published route — availability, direction, and the
 * conditions the AIP prints beside it.
 *
 * The AIP (ENR 1.10) may publish a flight-planning route per city pair, split
 * by RNAV capability and DIRECTIONAL (VYYY->VYMD is not the same entry as
 * VYMD->VYYY). No such table is shipped for Myanmar yet (`fetchAipRoutes`
 * fails closed to an empty list), so everything here stays dormant until one
 * is. Conditions on an entry are understood in four shapes:
 *
 *   "when VY D23A is not active"                      -> depends on a PDR
 *   "when VY R13 is active"                           -> the complement of one
 *   "Excluding Public Holiday; MON-FRI 0100-0900 UTC" -> a time window
 *   "for jet aircraft" / "for propeller aircraft"     -> an aircraft class
 *
 * The first two are what tie this file to the rest of the module: the AIP
 * itself routes traffic around a danger area by publishing an alternative and
 * conditioning it on that area's activity. Once the PDR schedules are known
 * (./schedule), those conditions can actually be evaluated instead of shown as
 * prose, which is what lets the panel say "file this one instead, R13 is
 * active until 1700Z".
 *
 * Anything that does not parse stays `unknown` and is quoted verbatim — never
 * silently treated as satisfied.
 */

import type { AipRoute } from "@/lib/aipRoutes";

import { activityAt, formatSheet, sheetCovers } from "./schedule";
import type { PdrArea, Timesheet } from "./types";

// --- aircraft class --------------------------------------------------------

/** Common turboprops (regional, utility and military transport types) plus
 *  the ones the dummy-traffic generators emit. Everything else is treated as a
 *  jet; a type in neither group is reported `unknown` rather than guessed. */
const PROPELLER_TYPES = new Set([
  "AT43", "AT45", "AT72", "AT75", "AT76",
  "DH8A", "DH8B", "DH8C", "DH8D", "ATP",
  "SF34", "SB20", "C208", "PC12", "B350", "BE20", "BE9L",
  "C130", "C295", "CN35", "TEX2", "DHC6",
]);

/** Jet families that appear in the dataset, by ICAO type prefix. Used only to
 *  separate "definitely a jet" from "type not recognised". */
const JET_PREFIXES = [
  "A19", "A20", "A21", "A22", "A31", "A32", "A33", "A34", "A35", "A38",
  "B37", "B38", "B39", "B73", "B74", "B75", "B76", "B77", "B78",
  "E13", "E14", "E17", "E19", "E29", "E35", "E45", "E75", "E90",
  "CRJ", "CL3", "CL6", "GLF", "GL5", "GL7", "GLE", "F2T", "FA7",
  "C51", "C56", "C75", "H25", "HDJ", "LJ6", "SU9", "AJ2", "C90", "MD8", "MD9",
];

export type AircraftClass = "jet" | "propeller" | "unknown";

export function aircraftClass(actype: string | null | undefined): AircraftClass {
  const t = String(actype ?? "").trim().toUpperCase();
  if (!t) return "unknown";
  if (PROPELLER_TYPES.has(t)) return "propeller";
  if (JET_PREFIXES.some((p) => t.startsWith(p))) return "jet";
  return "unknown";
}

// --- conditions ------------------------------------------------------------

export type ConditionState = "met" | "unmet" | "unknown";

export type RouteCondition =
  /** Available only while the named PDR is NOT active (or IS, when `want` is
   *  "active" — an AIP can publish both halves for one area). */
  | { kind: "area"; area: string; want: "active" | "inactive"; text: string }
  /** Available only inside a published window, optionally excluding holidays. */
  | { kind: "window"; sheet: Timesheet; excludesHolidays: boolean; text: string }
  /** Available only to one aircraft class. */
  | { kind: "aircraft"; want: "jet" | "propeller"; text: string }
  /** Published, but not in a shape this app understands. */
  | { kind: "unparsed"; text: string };

/** ICAO nationality prefix the AIP prints in front of an area designator in
 *  a route condition ("when VY D23A is not active"). The PDR areas themselves
 *  are keyed WITHOUT it (type + designator, "D23A"), matching the ident built
 *  from `restricted_areas.geojson`. */
export const AREA_ICAO_PREFIX = "VY";

const AREA_RE = new RegExp(
  "when\\s+" + AREA_ICAO_PREFIX + "\\s*([PRD])\\s*(\\d+[A-Z0-9]*)\\s+is\\s+(not\\s+)?active",
  "i",
);
const WINDOW_RE =
  /(MON|TUE|WED|THU|FRI|SAT|SUN)\s*-\s*(MON|TUE|WED|THU|FRI|SAT|SUN)\s+(\d{4})\s*-\s*(\d{4})/i;

/** Parse one ENR 1.10 condition string. */
export function parseCondition(text: string): RouteCondition {
  const raw = text.trim();

  const area = AREA_RE.exec(raw);
  if (area) {
    // "VY D23A", "VYD23A" and "VY D 23A" all name area "D23A" — the areas
    // are keyed type + designator, without the ICAO prefix.
    const ident = (area[1] + area[2]).replace(/\s+/g, "").toUpperCase();
    return {
      kind: "area",
      area: ident,
      want: area[3] ? "inactive" : "active",
      text: raw,
    };
  }

  const win = WINDOW_RE.exec(raw);
  if (win) {
    const hhmm = (v: string) => v.slice(0, 2) + ":" + v.slice(2);
    return {
      kind: "window",
      sheet: {
        day: win[1].toUpperCase(),
        dayTil: win[2].toUpperCase(),
        start: hhmm(win[3]),
        end: hhmm(win[4]),
        startEvent: null,
        endEvent: null,
        excluded: false,
        timeReference: "UTC",
      },
      excludesHolidays: /public\s+holiday/i.test(raw),
      text: raw,
    };
  }

  if (/\bjet\b/i.test(raw)) return { kind: "aircraft", want: "jet", text: raw };
  if (/propeller|turboprop/i.test(raw)) {
    return { kind: "aircraft", want: "propeller", text: raw };
  }
  return { kind: "unparsed", text: raw };
}

export interface ConditionContext {
  /** When the flight would be on this route (UTC epoch ms). */
  whenMs: number;
  /** PDR areas, for conditions that depend on one. Keyed by ident. */
  areasByIdent: Map<string, PdrArea>;
  actype?: string | null;
}

export interface ConditionVerdict {
  state: ConditionState;
  /** Plain-language reading of the condition against this flight. */
  detail: string;
  condition: RouteCondition;
}

/** Evaluate a parsed condition for one flight. */
export function evaluateCondition(
  cond: RouteCondition,
  ctx: ConditionContext,
): ConditionVerdict {
  switch (cond.kind) {
    case "area": {
      const area = ctx.areasByIdent.get(cond.area);
      if (!area) {
        return {
          state: "unknown",
          detail: cond.area + " is not in the loaded PDR data, so this cannot be checked.",
          condition: cond,
        };
      }
      const v = activityAt(area.activity, ctx.whenMs, area.centroid);
      if (v.state === "unknown") {
        return {
          state: "unknown",
          detail: cond.area + " activity is not determinable (" + v.schedule + ").",
          condition: cond,
        };
      }
      const met = v.state === (cond.want === "active" ? "active" : "inactive");
      return {
        state: met ? "met" : "unmet",
        detail:
          cond.area + " is " + v.state + " at this time (" + v.schedule + "), and the route requires it " +
          cond.want + ".",
        condition: cond,
      };
    }
    case "window": {
      // No solar events in a route condition, so the position is irrelevant.
      const inside = sheetCovers(cond.sheet, ctx.whenMs, { lat: 0, lon: 0 });
      if (!inside) {
        return {
          state: "unmet",
          detail: "Outside the published window (" + formatSheet(cond.sheet) + ").",
          condition: cond,
        };
      }
      return {
        state: cond.excludesHolidays ? "unknown" : "met",
        detail: cond.excludesHolidays
          ? "Inside the window (" + formatSheet(cond.sheet) +
            "), but it excludes public holidays and the app has no holiday calendar."
          : "Inside the published window (" + formatSheet(cond.sheet) + ").",
        condition: cond,
      };
    }
    case "aircraft": {
      const cls = aircraftClass(ctx.actype);
      if (cls === "unknown") {
        return {
          state: "unknown",
          detail:
            "Route is " + cond.text + "; aircraft type " +
            (ctx.actype || "(unset)") + " is not classified as jet or propeller.",
          condition: cond,
        };
      }
      return {
        state: cls === cond.want ? "met" : "unmet",
        detail: "Route is " + cond.text + "; this flight is a " + cls + ".",
        condition: cond,
      };
    }
    default:
      return {
        state: "unknown",
        detail: 'Published condition not machine-readable: "' + cond.text + '".',
        condition: cond,
      };
  }
}

/** Evaluate a route's condition, if it has one. A route with none is `met`. */
export function routeConditionVerdict(
  route: AipRoute,
  ctx: ConditionContext,
): ConditionVerdict | null {
  if (!route.condition) return null;
  return evaluateCondition(parseCondition(route.condition), ctx);
}

// --- route matching --------------------------------------------------------

/** Route strings compare on their token sequence, so spacing and case in the
 *  filed plan never make a matching route look different. */
export function routeTokens(route: string): string[] {
  return route.trim().toUpperCase().split(/\s+/).filter(Boolean);
}

export function sameRoute(a: string, b: string): boolean {
  const ta = routeTokens(a);
  const tb = routeTokens(b);
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

/** How the filed route relates to what ENR 1.10 publishes for the pair. */
export interface RouteMatch {
  /** exact   — the filed route IS a published route for this direction.
   *  reverse — it is the published route for the OPPOSITE direction only.
   *  none    — the pair has published routes but this is not one of them.
   *  none-published — the pair has no ENR 1.10 entry at all. */
  kind: "exact" | "reverse" | "none" | "none-published";
  /** The matched entry, for `exact`/`reverse`. */
  matched: AipRoute | null;
  /** Every published entry for this direction (the suggestion pool). */
  forPair: AipRoute[];
}

function pairFilter(table: AipRoute[], adep: string, ades: string): AipRoute[] {
  const A = adep.trim().toUpperCase();
  const D = ades.trim().toUpperCase();
  return table.filter(
    (r) => r.adep.trim().toUpperCase() === A && r.ades.trim().toUpperCase() === D,
  );
}

/**
 * Match a filed route against ENR 1.10.
 *
 * The reverse-direction check is the point of the `reverse` verdict: these
 * routes are one-way, and filing the return leg's routing is a real and easy
 * planning error that produces a route which looks published but is not
 * available in the direction of flight.
 */
export function matchFiledRoute(
  filed: string,
  table: AipRoute[],
  adep: string,
  ades: string,
): RouteMatch {
  const forPair = pairFilter(table, adep, ades);
  const exact = forPair.find((r) => sameRoute(r.route, filed)) ?? null;
  if (exact) return { kind: "exact", matched: exact, forPair };

  const reverse = pairFilter(table, ades, adep).find((r) => sameRoute(r.route, filed));
  if (reverse) return { kind: "reverse", matched: reverse, forPair };

  return {
    kind: forPair.length === 0 ? "none-published" : "none",
    matched: null,
    forPair,
  };
}
