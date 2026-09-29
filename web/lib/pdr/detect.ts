/**
 * PDR conflict detection and route suggestion — the orchestrator.
 *
 * Answers one question about a filed plan: *may this flight fly this route, at
 * this level, at this time?* — and when the answer is no, which published route
 * it could fly instead.
 *
 * Four checks, all against the current AIRAC/AIP data the app already loads:
 *
 *   1. **Restricted airspace** — does the generated trajectory enter a P/D/R
 *      volume while that area is active? (./penetration + ./schedule)
 *   2. **Route availability** — is the filed route one ENR 1.10 publishes for
 *      this city pair? (./routeRules)
 *   3. **Direction** — these routes are one-way; is the filed one the return
 *      leg's routing?
 *   4. **Conditions** — a published route can be conditioned on a time window,
 *      an aircraft class, or another area's activity.
 *
 * Everything here is ADVISORY. Nothing in this module mutates a flight plan:
 * it returns findings with their reasons and a ranked list of alternatives, and
 * applying one is an explicit act by the controller in the UI. That is a
 * deliberate constraint, not an omission — the tool tells the controller what
 * the AIP says and lets them decide.
 *
 * The suggestion pool is the published-route table itself, never a synthesised
 * routing. A route this tool proposes is one the AIP already prints for the
 * pair, so accepting it cannot invent an unpublished path through the
 * FIR; the worst case is that it proposes a route the controller rejects.
 */

import type { Fix } from "@/lib/aip";
import type { AipRoute } from "@/lib/aipRoutes";
import { resolveRoutePreview } from "@/lib/routePreview";

import {
  checkAirwayUsage,
  type AirwayIssue,
  type SegmentIndex,
} from "./airwayDirection";
import {
  climbCruiseDescentFt,
  findIncursions,
  pathFromFixes,
  routeLengthNm,
} from "./penetration";
import {
  matchFiledRoute,
  routeConditionVerdict,
  type ConditionContext,
  type ConditionVerdict,
} from "./routeRules";
import { formatSchedule, isAlwaysActive } from "./schedule";
import type { PdrArea, PdrIncursion, TimedPoint } from "./types";

/** How much a finding matters.
 *  violation — the plan conflicts with a published restriction.
 *  caution   — it may, and the app cannot rule it out (unknown activity, a
 *              Danger area, an unverifiable condition).
 *  info      — worth knowing, nothing to act on. */
export type PdrSeverity = "violation" | "caution" | "info";

export type PdrCategory =
  | "restricted-airspace"
  | "route-availability"
  | "route-direction"
  | "route-condition"
  | "flight-level"
  /** The filed route runs against a one-way ATS route, or outside a segment's
   *  published level band (AIXM RouteSegment, AIP ENR 3). */
  | "airway-direction"
  | "airway-level";

export interface PdrFinding {
  id: string;
  severity: PdrSeverity;
  category: PdrCategory;
  /** One-line headline, e.g. "Route enters R13 while active". */
  title: string;
  /** WHY — the published rule and how this plan breaches it. */
  reason: string;
  /** The authority behind it, e.g. "AIP MYANMAR ENR 5.1 / AIXM 2609". */
  source: string;
  /** Area ident when the finding is about one, so the UI can focus the map. */
  area?: string;
  /** P / D / R when the finding is about an area — the three are governed by
   *  different rules (see {@link AREA_POLICY}) and the UI shows them apart. */
  areaClass?: "P" | "D" | "R";
  /** What the controller has to do about it, when there is something to do. */
  action?: string;
  /** The incursion behind an airspace finding. */
  incursion?: PdrIncursion;
}

/** A published route offered in place of the filed one. */
export interface RouteSuggestion {
  /** The ENR 1.10 route string, verbatim — what would go in the plan. */
  route: string;
  rnav: boolean;
  /** Why this one is being offered. */
  why: string;
  /** Published condition and how it evaluates for this flight, if any. */
  condition: ConditionVerdict | null;
  /** Areas this route would still enter while they are active/unknown. Empty
   *  is the point of the suggestion. */
  activeAreas: string[];
  /** Areas the filed route hits that this one avoids. */
  clears: string[];
  /** Set when the candidate needs a different navigation specification from
   *  the one the flight is presumably filed with — flyable, but not a like-for-
   *  like swap. */
  capabilityNote: string | null;
  /** Rule problems this candidate would ITSELF have — a level outside an
   *  airway's published band, say. A route that merely avoids the areas but
   *  breaks another published rule is not a solution, and offering it silently
   *  sends the controller round in a circle between two rejected routes. */
  issues: string[];
  /** Great-circle length over the resolved fixes (NM), for the cost readout.
   *  Null when the route string could not be resolved to coordinates. */
  distanceNm: number | null;
  /** Ranking score, lower is better. */
  score: number;
}

/** A way out of the findings, independent of any particular published route. */
export type RemedyKind = "level" | "route" | "authorization" | "notam";

export interface Remedy {
  kind: RemedyKind;
  /** The action, in one line. */
  detail: string;
  /** For a level remedy: the lowest requested level (ft) that clears. */
  toFt?: number;
  /** Areas this would clear. */
  clears?: string[];
}

export interface PdrReport {
  findings: PdrFinding[];
  suggestions: RouteSuggestion[];
  /** Ranked ways out, best first. Independent of the published-route list: a
   *  level change or an authorization can resolve a finding that no alternative
   *  routing can. */
  remedies: Remedy[];
  /** Every area the filed route enters, active or not — the full picture the
   *  panel shows under "areas crossed". */
  incursions: PdrIncursion[];
  /** How the filed route relates to ENR 1.10. */
  routeMatch: ReturnType<typeof matchFiledRoute>;
  /** Number of PDR areas actually tested. 0 means the overlay was not loaded,
   *  and the panel must say so rather than report "no conflicts". */
  areasChecked: number;
  /** Worst severity present, or null when the plan is clean. */
  worst: PdrSeverity | null;
}

export interface PdrCheckInput {
  adep: string;
  ades: string;
  /** The filed en-route string, as typed into the generator. */
  filedRoute: string;
  actype?: string | null;
  /** Requested level, in feet. */
  rflFt: number;
  /** Cruise ground speed (kt), for estimating when a candidate route would be
   *  at each area. */
  gsKt: number;
  /** Off-blocks time, UTC epoch ms — the clock every schedule is read against. */
  eobtMs: number;
  /** The filed plan's generated trajectory, absolute-timed. */
  path: TimedPoint[];
  areas: PdrArea[];
  publishedRoutes: AipRoute[];
  fixes: Fix[];
  airways: Record<string, string[]>;
  /** Filed RNAV capability — picks which half of the published table applies. */
  rnav?: boolean;
  /** Can the flight fly an RNAV route? Defaults to true: the commercial
   *  fleet is RNAV-equipped, and assuming otherwise would hide the RNAV half of
   *  the published table. Set false for a conventional-only aircraft and the
   *  RNAV routes stop being offered. */
  rnavCapable?: boolean;
  /** The path was ESTIMATED from the filed fixes rather than generated, so the
   *  terminal segments are straight lines and findings there carry a caveat. */
  estimated?: boolean;
  /** Published ATS route segments, indexed by designator. Enables the one-way
   *  and segment-level checks; omit it and they are simply not run. */
  segmentIndex?: SegmentIndex;
  /** ADEP / ADES coordinates. When present, a candidate route is evaluated on
   *  the SAME anchored climb/cruise/descent profile as the filed plan.
   *
   *  Without it a candidate was built flat at the cruise level while the filed
   *  route used the profile, so the two were not comparable: an area under the
   *  climb-out looked like something the alternative avoided, when in truth
   *  every route out of that field crosses it. That produced a suggestion which
   *  claimed to clear an area it did not, and the controller ping-ponged
   *  between two routes each "clearing" the other's finding. */
  terminals?: {
    dep?: { lat: number; lon: number } | null;
    arr?: { lat: number; lon: number } | null;
  };
  /** Build the ranked alternatives. Off for a bulk scan of a whole traffic
   *  sample: resolving and re-checking every published alternative for every
   *  flight is about half the cost of the check, and only the ONE flight the
   *  controller has open needs them. Default true. */
  includeSuggestions?: boolean;
  /** Restricted-area idents this flight holds entry authorization for. An R
   *  area is passable WITH permission from the controlling authority, so a
   *  listed area stops being a conflict. Empty by default: the simulation
   *  carries no authorization state, and assuming none is the safe direction. */
  authorizedAreas?: string[];
}

const AIP_SOURCE = "AIP MYANMAR ENR 5.1 / AIXM 2609";
const ENR_SOURCE = "AIP MYANMAR ENR 1.10";
const ENR3_SOURCE = "AIP MYANMAR ENR 3 / AIXM 2609 RouteSegment";

const SEVERITY_RANK: Record<PdrSeverity, number> = {
  violation: 0,
  caution: 1,
  info: 2,
};

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + "Z";
}

/** Lowest usable cruising level (ft) that clears an area's ceiling. Null when
 *  the area has no ceiling (UNL) — nothing to climb above. */
function levelAbove(area: PdrArea): number | null {
  if (!Number.isFinite(area.upperFt)) return null;
  // Next whole thousand at least 1000 ft above the ceiling.
  return Math.ceil((area.upperFt + 1000) / 1000) * 1000;
}

/**
 * What the AIP permits for each class of area, and therefore what a route that
 * enters one has to do about it.
 *
 * The three classes are NOT interchangeable, and collapsing them loses the
 * distinction a controller works to:
 *
 *   P — Prohibited.  Flight inside is not permitted. Re-route, full stop.
 *   D — Danger.      May be entered; what makes it a conflict is the area being
 *                    ACTIVE, because activity is a published hazard (gunnery,
 *                    high-speed manoeuvring). Inactive, it is simply airspace.
 *   R — Restricted.  Entry is conditional on AUTHORIZATION from the controlling
 *                    authority. Without one it is a conflict even though the
 *                    airspace is not prohibited.
 */
export interface AreaPolicy {
  label: string;
  /** The entry rule, one line, for the finding text. */
  rule: string;
  /** What the controller has to do when it does conflict. */
  action: string;
}

export const AREA_POLICY: Record<"P" | "D" | "R", AreaPolicy> = {
  P: {
    label: "Prohibited",
    rule: "Flight inside a Prohibited area is not permitted.",
    action:
      "Re-route to avoid the area laterally, or plan above its upper limit.",
  },
  D: {
    label: "Danger",
    rule:
      "A Danger area may be entered, but not while it is active — activity is a published hazard to flight.",
    action: "Re-route to avoid the area, or re-level to clear it vertically.",
  },
  R: {
    label: "Restricted",
    rule:
      "Entry to a Restricted area requires authorization from the controlling authority.",
    action:
      "Obtain authorization from the controlling authority, or re-route to avoid the area.",
  },
};

/** A crossing shorter than this is inside the path's own sampling step: the
 *  route touches the boundary rather than transiting the area. Real for an
 *  active area, noise for one whose activity cannot even be determined. */
const GRAZE_NM = 0.5;

/**
 * Severity for one incursion, per {@link AREA_POLICY}.
 *
 * `authorized` lists areas this flight holds permission for, which is what
 * turns an R-area crossing from a conflict into a permitted transit. The
 * simulation carries no authorization state, so by default nothing is
 * authorized and every active R area is reported — the safe direction.
 */
function incursionSeverity(
  inc: PdrIncursion,
  authorized: ReadonlySet<string>,
): PdrSeverity {
  const kind = inc.area.kind;

  // A Prohibited area is not conditional on much: even outside its published
  // window it stays airspace to keep out of, so an inactive one is still worth
  // a look rather than a silent note.
  if (kind === "P") {
    return inc.worstState === "inactive" ? "caution" : "violation";
  }

  if (inc.worstState === "inactive") return "info";

  if (inc.worstState === "unknown") {
    // Undetermined activity AND a boundary graze is two weak signals, not a
    // finding; anything longer stays a caution.
    return inc.transitNm < GRAZE_NM ? "info" : "caution";
  }

  // Active. A Restricted area is passable WITH authorization.
  if (kind === "R" && authorized.has(inc.area.ident)) return "info";
  return "violation";
}

/**
 * Whether moving the flight in time could clear this area, and what to say.
 *
 * Only offered when the published schedule actually HAS an inactive period.
 * An area published Daily 0000-2400 — a city prohibited area, say — is never
 * inactive, so "fly outside the active window" is not an option and suggesting
 * it sends the controller looking for a date that does not exist. An area whose
 * activation is by NOTAM is a third case: the check assumes it is cold, so
 * there is no window to fly around — what is owed the reader is the assumption
 * itself, not a re-timing.
 */
function retimeAdvice(area: PdrArea): string | null {
  const activity = area.activity;
  if (!activity) return null;
  if (activity.sheets.length === 0) {
    return /notam/i.test(activity.activityNote)
      ? "Activation is by NOTAM: this check treats the area as inactive — confirm against the NOTAMs for the day of flight."
      : null;
  }
  if (isAlwaysActive(activity)) {
    // Say so explicitly: without it, a controller may keep trying dates.
    return "The area is active continuously (" +
      formatSchedule(activity) +
      "), so re-timing the flight cannot clear it.";
  }
  return "Alternatively re-time the flight: the area is active " +
    formatSchedule(activity) +
    ", and a crossing outside that period would clear it.";
}

/** Below this, a crossing is on the climb-out or the descent — the part of an
 *  estimated path that is least like the real one, because the published SID /
 *  STAR / approach is not modelled. */
const TERMINAL_CEILING_FT = 12000;

function incursionFinding(
  inc: PdrIncursion,
  seq: number,
  estimated: boolean,
  authorized: ReadonlySet<string>,
): PdrFinding {
  const a = inc.area;
  const policy = AREA_POLICY[a.kind];
  const label = a.ident + (a.name ? " " + a.name : "");
  const kindWord = policy.label;
  const v = inc.activityAtEntry;
  const when =
    inc.exitMs > inc.entryMs
      ? hhmm(inc.entryMs) + "-" + hhmm(inc.exitMs)
      : hhmm(inc.entryMs);

  const band =
    inc.minAltFt === inc.maxAltFt
      ? Math.round(inc.minAltFt) + " ft"
      : Math.round(inc.minAltFt) + "-" + Math.round(inc.maxAltFt) + " ft";
  const areaBand =
    (a.lowerFt <= 0 ? "GND" : Math.round(a.lowerFt) + " ft") +
    " to " +
    (Number.isFinite(a.upperFt) ? Math.round(a.upperFt) + " ft" : "UNL");

  const parts = [
    "The route is inside " + label + " (" + kindWord + ", " + areaBand + ") for " +
      inc.transitNm.toFixed(1) + " NM at " + when + ", crossing at " + band + ".",
    "Published activity: " + v.schedule + ". " + v.detail,
    policy.rule,
  ];
  // The nature of the restriction and the hazard are published per area and are
  // the difference between "a training area" and "live gunnery" — the reason a
  // controller actually needs to see, not just the ident.
  const restriction = a.activity?.restriction?.trim();
  const hazard = a.activity?.hazard?.trim();
  if (restriction && restriction !== "-") parts.push("Restriction: " + restriction + ".");
  if (hazard && hazard !== "-") parts.push("Hazard: " + hazard + ".");
  // For an R area the published remarks ARE the authorization condition
  // ("Permission to entry : Only authorized aircraft"), so they are the
  // operative text, not a footnote.
  const remarks = a.activity?.remarks?.trim();
  if (a.kind === "R" && remarks && remarks !== "-") {
    parts.push("Entry condition: " + remarks.replace(/\s+/g, " "));
  }
  if (a.kind === "R" && inc.worstState === "active") {
    parts.push(
      authorized.has(a.ident)
        ? "Authorization for this area is recorded for this flight, so the transit is permitted."
        : "No entry authorization is recorded for this flight.",
    );
  }
  if (v.holidayCaveat) {
    parts.push(
      "The schedule excludes public holidays and the dataset has no holiday calendar, so this is conditional on the date not being one.",
    );
  }
  // An estimated path runs straight from the aerodrome to the first fix; the
  // real one flies a published procedure that may route clear of this area
  // entirely. Say so rather than presenting a straight-line artefact as fact.
  if (estimated && inc.maxAltFt < TERMINAL_CEILING_FT) {
    parts.push(
      "This crossing is on the estimated climb-out/descent: the departure and arrival legs are drawn straight to and from the first and last fixes, and the published SID/STAR/approach is not modelled. Confirm after generating.",
    );
  }
  // Only offer the vertical way out where it can actually work. A crossing on
  // the climb-out or descent happens at an altitude the aircraft passes through
  // whatever it cruises at, so raising the requested level does not avoid it —
  // saying otherwise sends the controller to re-file a level that changes
  // nothing.
  const clearFt = levelAbove(a);
  if (clearFt && inc.maxAltFt < a.upperFt) {
    parts.push(
      inc.minAltFt >= TERMINAL_CEILING_FT
        ? "Vertically, FL" + Math.round(clearFt / 100) + " or above would overfly it."
        : "Raising the cruising level would NOT clear it: the crossing is on the climb-out/descent, at a level the flight passes through however high it cruises.",
    );
  }

  const stateWord =
    inc.worstState === "active"
      ? "while active"
      : inc.worstState === "unknown"
        ? "with activity undetermined"
        : "while inactive";

  let severity = incursionSeverity(inc, authorized);
  // An estimated terminal crossing cannot be a REJECTION.
  //
  // The departure and arrival legs of an un-generated plan are drawn straight
  // to and from the first and last fixes; the published SID/STAR is not flown.
  // Every departure from a field with an area over it therefore "enters" that
  // area, no re-route can clear it, and the flight sat at REJECTED whatever the
  // controller did. The check cannot assert a breach on geometry it admits it
  // has not modelled, so a terminal-level finding on an estimated path is a
  // CHECK — confirm it against the real trajectory after generating.
  if (estimated && inc.maxAltFt < TERMINAL_CEILING_FT && severity === "violation") {
    severity = "caution";
  }
  return {
    // Several polygons share one ident (R13 SHANTE is published as eight
    // polygons), and a route can cross the same area twice, so the id carries
    // the AIXM designator and the position in the sorted list as well.
    id: "area:" + (a.activity?.designator ?? a.ident) + ":" + inc.entryMs + ":" + seq,
    severity,
    areaClass: a.kind,
    action:
      severity === "info"
        ? undefined
        : [policy.action, retimeAdvice(a)].filter(Boolean).join(" "),
    category: "restricted-airspace",
    title: "Route enters " + a.ident + " " + stateWord,
    reason: parts.join(" "),
    source: AIP_SOURCE,
    area: a.ident,
    incursion: inc,
  };
}

/**
 * One-way and level findings for the airways the route uses.
 *
 * Flying a uni-directional route the wrong way is not a soft preference: the
 * traffic on it is all coming the other way, which is why the AIP publishes the
 * direction at all. It is reported as a violation, with the permitted direction
 * named so the fix is obvious.
 */
function airwayFindings(issues: AirwayIssue[]): PdrFinding[] {
  return issues.map(
    (issue) => {
      const where = issue.route + " " + issue.fromFix + "-" + issue.toFix;
      if (issue.kind === "direction") {
        return {
          id: "airway:dir:" + where + ":" + (issue.segment?.from ?? ""),
          severity: "violation" as PdrSeverity,
          category: "airway-direction" as PdrCategory,
          title: issue.route + " is one-way against this routing",
          reason:
            issue.detail +
            " A uni-directional route carries traffic in one direction only, so this cannot be flown as filed.",
          source: ENR3_SOURCE,
          action:
            "File the reverse-direction route for this pair, or route via a bidirectional airway.",
        };
      }
      if (issue.kind === "level") {
        return {
          id: "airway:lvl:" + where + ":" + (issue.segment?.from ?? ""),
          severity: "violation" as PdrSeverity,
          category: "airway-level" as PdrCategory,
          title: "Requested level is outside " + issue.route + "'s published band",
          reason: issue.detail,
          source: ENR3_SOURCE,
          action: "Re-file at a level inside the segment's published band.",
        };
      }
      return {
        id: "airway:conn:" + where,
        severity: "caution" as PdrSeverity,
        category: "route-availability" as PdrCategory,
        title: issue.route + " does not join " + issue.fromFix + " and " + issue.toFix,
        reason:
          issue.detail +
          " The span may rely on a segment outside the Myanmar AIRAC export, or the airway may be mis-typed.",
        source: ENR3_SOURCE,
      };
    },
  );
}

/** Build the findings that are about the route itself rather than airspace. */
function routeFindings(
  input: PdrCheckInput,
  match: ReturnType<typeof matchFiledRoute>,
  ctx: ConditionContext,
): PdrFinding[] {
  const out: PdrFinding[] = [];
  const pair = input.adep + "-" + input.ades;

  if (match.kind === "reverse") {
    out.push({
      id: "route:direction",
      severity: "violation",
      category: "route-direction",
      title: "Filed route is published for the opposite direction",
      reason:
        "ENR 1.10 routes are directional. This routing is published for " +
        input.ades + "-" + input.adep + ", not for " + pair +
        ". It is not available in the direction of flight.",
      source: ENR_SOURCE,
    });
  } else if (match.kind === "none") {
    out.push({
      id: "route:availability",
      severity: "caution",
      category: "route-availability",
      title: "Filed route is not a published route for " + pair,
      reason:
        "ENR 1.10 publishes " + match.forPair.length + " route(s) for " + pair +
        " and the filed routing is not one of them. A non-standard routing is not " +
        "invalid, but it is not covered by the pre-agreed flight-planning table " +
        "and may need coordination.",
      source: ENR_SOURCE,
    });
  } else if (match.kind === "none-published") {
    out.push({
      id: "route:availability",
      severity: "info",
      category: "route-availability",
      title: "No published route for " + pair,
      reason:
        "ENR 1.10 has no flight-planning route for this city pair, so there is " +
        "nothing to check the filed routing against and no alternative to offer.",
      source: ENR_SOURCE,
    });
  }

  // The filed route IS published, but carries a condition that does not hold.
  if (match.matched) {
    const verdict = routeConditionVerdict(match.matched, ctx);
    if (verdict && verdict.state !== "met") {
      out.push({
        id: "route:condition",
        severity: verdict.state === "unmet" ? "violation" : "caution",
        category: "route-condition",
        title:
          verdict.state === "unmet"
            ? "Published route's condition is not satisfied"
            : "Published route's condition cannot be verified",
        reason:
          'ENR 1.10 publishes this route with the condition "' +
          match.matched.condition +
          '". ' + verdict.detail,
        source: ENR_SOURCE,
      });
    }
  }
  return out;
}

/**
 * Rank the published alternatives for the pair.
 *
 * A candidate is scored on what a controller would actually weigh: does its
 * condition hold, does it still cross something hot, and how much longer is it.
 * Routes identical to the filed one are dropped, and so are ones whose
 * condition is definitively unmet for this flight — offering a route the AIP
 * says is unavailable would be worse than offering nothing.
 */
function buildSuggestions(
  input: PdrCheckInput,
  match: ReturnType<typeof matchFiledRoute>,
  ctx: ConditionContext,
  filedActiveAreas: Set<string>,
): RouteSuggestion[] {
  const out: RouteSuggestion[] = [];

  for (const r of match.forPair) {
    if (match.matched && r.route === match.matched.route && r.rnav === match.matched.rnav) {
      continue; // this is what is already filed
    }
    // Capability, not equality. An RNAV-capable flight may fly a conventional
    // route perfectly well, so a NON-RNAV alternative is a real option and must
    // not be dropped just for being NON-RNAV. What DOES disqualify a route is
    // the flight lacking the navigation specification it requires: an aircraft
    // without RNAV cannot fly an RNAV route.
    const rnavCapable = input.rnavCapable ?? true;
    if (r.rnav && !rnavCapable) continue;
    // Flying a conventional route with an RNAV flight is allowed but is a step
    // down in navigation specification, so it is stated on the card.
    const capabilityNote =
      !r.rnav && rnavCapable
        ? "Conventional (non-RNAV) route — flyable, but check the flight is equipped and cleared for conventional navigation."
        : null;

    const verdict = routeConditionVerdict(r, ctx);
    if (verdict?.state === "unmet") continue;

    const pts = resolveRoutePreview(r.route, input.fixes, input.airways);
    const distanceNm = pts.length > 1 ? routeLengthNm(pts) : null;

    // Re-run the airspace check on the candidate. Times are estimated from the
    // EOBT and cruise speed — good enough to tell "crosses D60 while hot" from
    // "crosses it cold", which is the decision this drives.
    let activeAreas: string[] = [];
    if (pts.length > 1) {
      // Anchor and profile the candidate exactly like the filed plan, or the
      // comparison is meaningless (see `terminals`).
      const dep = input.terminals?.dep;
      const arr = input.terminals?.arr;
      const chain = [
        ...(dep ? [dep] : []),
        ...pts.map((pt) => ({ lat: pt.lat, lon: pt.lon })),
        ...(arr ? [arr] : []),
      ];
      const candidatePath = pathFromFixes(chain, {
        startMs: input.eobtMs,
        gsKt: input.gsKt,
        altFt: input.terminals
          ? climbCruiseDescentFt({
              rflFt: input.rflFt,
              // No aerodrome anchor at an end = the route's first / last point
              // is where the flight crosses in / out of the area, at level —
              // the same rule the filed plan's own path is built with.
              startAtLevel: !dep,
              endAtLevel: !arr,
            })
          : input.rflFt,
      });
      activeAreas = [
        ...new Set(
          findIncursions(candidatePath, input.areas)
            .filter((i) => i.worstState !== "inactive")
            .map((i) => i.area.ident),
        ),
      ];
    }

    // The candidate has to pass the SAME route rules as the filed one. Without
    // this the engine happily suggested a route it had just rejected itself:
    // the alternative cleared the restricted area but sat below the airway's
    // published floor, so accepting it swapped one REJECTED verdict for another.
    const airway = input.segmentIndex
      ? checkAirwayUsage(r.route, input.segmentIndex, input.rflFt)
      : [];
    // A one-way route flown the wrong way cannot be flown at all, so it is not
    // an alternative. A level problem is kept, because the controller can fix
    // it by re-filing the level — but it is stated and ranked last.
    if (airway.some((i) => i.kind === "direction")) continue;
    const issues = airway
      .filter((i) => i.kind === "level")
      .map((i) => i.detail);

    const clears = [...filedActiveAreas].filter((id) => !activeAreas.includes(id));

    const why =
      activeAreas.length === 0 && clears.length > 0
        ? "Published route that avoids " + clears.join(", ") + " at this time."
        : activeAreas.length === 0
          ? "Published route with no active area on it at this time."
          : "Published route, but still crosses " + activeAreas.join(", ") + ".";

    // Lower is better: unresolved conditions and remaining hot areas dominate,
    // then track distance as the tie-break.
    const score =
      activeAreas.length * 100 +
      issues.length * 100 +
      (verdict?.state === "unknown" ? 40 : 0) +
      (pts.length > 1 ? 0 : 25) +
      (distanceNm ?? 0) / 100;

    out.push({
      route: r.route,
      rnav: r.rnav,
      why,
      condition: verdict,
      activeAreas,
      clears,
      issues,
      capabilityNote,
      distanceNm,
      score,
    });
  }

  return out.sort((a, b) => a.score - b.score);
}

/**
 * The ways out, ranked.
 *
 * Ordered the way a controller would work the problem: climb over it if that is
 * possible, otherwise re-route around it, otherwise fall back on the area's own
 * entry conditions.
 *
 * The level remedy carries a restriction that is easy to get wrong. Climbing
 * only helps when the aircraft is INSIDE the area at cruise. A crossing during
 * the climb-out or the descent is not fixed by raising the requested level: the
 * aircraft still passes through that altitude near the field, so a GND-3000 ft
 * area off the departure runway is crossed whether the flight is planned at FL160 or FL350. Offering
 * "climb above it" there would be advice that cannot work.
 */
function buildRemedies(
  input: PdrCheckInput,
  incursions: PdrIncursion[],
  authorized: ReadonlySet<string>,
  airwayIssues: AirwayIssue[],
): Remedy[] {
  const out: Remedy[] = [];
  const blocking = incursions.filter((i) => i.worstState !== "inactive");
  const levelIssues = airwayIssues.filter((i) => i.kind === "level");
  if (blocking.length === 0 && levelIssues.length === 0) return out;

  // --- 1. the level, solving BOTH constraints at once ----------------------
  //
  // Two different things push the level around, and answering one at a time
  // sends the controller back and forth: the areas the route has to overfly,
  // and the published band of every airway segment it uses. The useful answer
  // is the lowest level that satisfies both, with the reason for it.
  const atCruise = blocking.filter((i) => i.minAltFt >= TERMINAL_CEILING_FT);
  const terminal = blocking.filter((i) => i.minAltFt < TERMINAL_CEILING_FT);
  const cappedAtCruise = atCruise.filter((i) => Number.isFinite(i.area.upperFt));

  const wants: number[] = [];
  const clears: string[] = [];
  // Areas contribute only when EVERY cruise-level crossing has a ceiling to
  // climb above; one uncapped area and climbing solves nothing.
  if (cappedAtCruise.length > 0 && cappedAtCruise.length === atCruise.length) {
    wants.push(Math.max(...cappedAtCruise.map((i) => levelAbove(i.area) ?? 0)));
    clears.push(...cappedAtCruise.map((i) => i.area.ident));
  }
  // Airways contribute the floor of every segment the flight is below.
  let airwayFloorFt = 0;
  const airwayWhy: string[] = [];
  for (const issue of levelIssues) {
    const lo = issue.segment?.lowerFt;
    if (lo != null && input.rflFt < lo) {
      airwayFloorFt = Math.max(airwayFloorFt, lo);
      airwayWhy.push(
        issue.segment!.from + "-" + issue.segment!.to + " on " + issue.route +
          " is published from " + Math.round(lo) + " ft",
      );
    }
  }
  if (airwayFloorFt > 0) wants.push(airwayFloorFt);

  // A segment ceiling anywhere on the route caps what can be asked for.
  let capFt = Infinity;
  for (const issue of levelIssues) {
    const hi = issue.segment?.upperFt;
    if (hi != null && input.rflFt > hi) capFt = Math.min(capFt, hi);
  }

  if (wants.length > 0 && Number.isFinite(input.rflFt) && input.rflFt > 0) {
    const needFt = Math.max(...wants);
    if (needFt > input.rflFt) {
      const parts = [
        "Raise the requested level to FL" + Math.round(needFt / 100) +
          " or above and re-check.",
      ];
      if (airwayWhy.length > 0) {
        parts.push("Required because " + airwayWhy.join("; ") + ".");
      }
      if (clears.length > 0) {
        parts.push("That also overflies " + [...new Set(clears)].join(", ") + ".");
      }
      if (terminal.length > 0) {
        parts.push(
          "It will NOT clear " +
            [...new Set(terminal.map((i) => i.area.ident))].join(", ") +
            ", which is crossed on the climb-out or descent at a level the flight passes through whatever it cruises at.",
        );
      }
      if (needFt > capFt) {
        parts.push(
          "Note the route also has a ceiling of " + Math.round(capFt) +
            " ft, so no single level satisfies both — the routing has to change.",
        );
      }
      out.push({
        kind: "level",
        toFt: needFt,
        clears: [...new Set(clears)],
        detail: parts.join(" "),
      });
    }
  }

  // --- 2. re-route -----------------------------------------------------------
  if (blocking.length > 0) {
    out.push({
      kind: "route",
      clears: blocking.map((i) => i.area.ident),
      detail:
        "Re-route clear of " +
        [...new Set(blocking.map((i) => i.area.ident))].join(", ") +
        ". Use a published alternative below if one is offered, or edit the route by hand.",
    });
  } else if (levelIssues.length > 0) {
    out.push({
      kind: "route",
      detail:
        "Or route via an airway whose published band includes the requested level.",
    });
  }

  // --- 3. the area's own entry conditions ------------------------------------
  for (const i of blocking) {
    const a = i.area;
    if (a.kind === "R" && !authorized.has(a.ident)) {
      const remarks = a.activity?.remarks?.trim();
      out.push({
        kind: "authorization",
        clears: [a.ident],
        detail:
          "Obtain entry authorization for " + a.ident +
          " from the controlling authority" +
          (remarks && remarks !== "-" ? " — published condition: " + remarks.replace(/\s+/g, " ") : ".") ,
      });
    }
    // Keyed on what the AIP actually says, not on the state: the check now
    // assumes a NOTAM-activated area is cold, so its state is "inactive" and a
    // state test would never fire. A P area is still raised while inactive, and
    // that is exactly the case where the assumption has to be spelled out.
    if (
      a.activity?.sheets.length === 0 &&
      /notam/i.test(a.activity.activityNote || "")
    ) {
      out.push({
        kind: "notam",
        clears: [a.ident],
        detail:
          a.ident +
          " is activated by NOTAM. With no NOTAM feed in the dataset this check treats it as inactive — confirm against the NOTAMs for the day of flight before relying on that.",
      });
    }
  }

  return out;
}

/** Run the whole PDR check for one flight plan. Pure — no fetching, no React. */
export function analysePdr(input: PdrCheckInput): PdrReport {
  const incursions = findIncursions(input.path, input.areas);
  const authorized = new Set(input.authorizedAreas ?? []);
  // A requested level of 0 (or a missing one) is UNKNOWN, not sea level.
  // Treated as a real level it poisons everything vertical: every airway band
  // is "breached", and the estimated profile sits on the ground so every
  // low-level area is entered. Level-dependent checks are skipped instead, and
  // the missing level is reported as the finding it is.
  const rflKnown = Number.isFinite(input.rflFt) && input.rflFt > 0;

  // Computed once: both the findings and the remedies read these.
  const airwayIssues = input.segmentIndex
    ? checkAirwayUsage(input.filedRoute, input.segmentIndex, rflKnown ? input.rflFt : null)
    : [];

  const areasByIdent = new Map<string, PdrArea>();
  for (const a of input.areas) if (!areasByIdent.has(a.ident)) areasByIdent.set(a.ident, a);

  // Conditions are read at the time the flight would actually be en route.
  // Mid-flight is a better single instant than the EOBT for a route that is
  // hours long, and it is the same instant for every candidate, so they are
  // compared on equal terms.
  const lastMs = input.path.length ? input.path[input.path.length - 1].timeMs : input.eobtMs;
  const ctx: ConditionContext = {
    whenMs: input.eobtMs + (lastMs - input.eobtMs) / 2,
    areasByIdent,
    actype: input.actype,
  };

  const match = matchFiledRoute(
    input.filedRoute,
    input.publishedRoutes,
    input.adep,
    input.ades,
  );

  const findings = [
    ...incursions.map((inc, i) =>
      incursionFinding(inc, i, input.estimated ?? false, authorized),
    ),
    ...routeFindings(input, match, ctx),
    ...airwayFindings(airwayIssues),
    ...(rflKnown
      ? []
      : [
          {
            id: "plan:no-level",
            severity: "caution" as PdrSeverity,
            category: "flight-level" as PdrCategory,
            title: "No requested level on this plan",
            reason:
              "The plan carries no usable RFL, so nothing vertical can be checked: " +
              "airway level bands, and whether the route clears an area's upper limit, " +
              "both depend on it. Set a cruising level and the check re-runs.",
            source: ENR_SOURCE,
            action: "Set the requested flight level on the plan.",
          },
        ]),
  ].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.category.localeCompare(b.category),
  );

  const filedActiveAreas = new Set(
    incursions.filter((i) => i.worstState !== "inactive").map((i) => i.area.ident),
  );

  // Only offer alternatives when there is something to fix. A clean plan does
  // not need the controller reading a list of other routes.
  const needsAlternative =
    (input.includeSuggestions ?? true) &&
    findings.some((f) => f.severity !== "info");
  const suggestions = needsAlternative
    ? buildSuggestions(input, match, ctx, filedActiveAreas)
    : [];

  const worst = findings.length
    ? findings.reduce<PdrSeverity>(
        (w, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[w] ? f.severity : w),
        "info",
      )
    : null;

  return {
    findings,
    suggestions,
    remedies: buildRemedies(input, incursions, authorized, airwayIssues),
    incursions,
    routeMatch: match,
    areasChecked: input.areas.length,
    worst,
  };
}

/** Convenience for the panel header: the schedule line for one area. */
export function areaScheduleText(area: PdrArea): string {
  return formatSchedule(area.activity);
}
