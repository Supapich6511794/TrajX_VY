/**
 * PDR auto-resolve — pick a fix for every rejected plan in one pass.
 *
 * The panel already ranks published alternatives per flight; this walks the
 * rejected flights and takes, for each, the best-ranked alternative that is a
 * fix ON ITS OWN — one the controller could accept without reading further.
 * Anything short of that is left alone and reported with the engine's own
 * recommended action, never guessed at:
 *
 *   * a candidate that still crosses an active area, or breaks another
 *     published rule, is not a fix (see `RouteSuggestion.issues`);
 *   * a route condition that cannot be verified is not a fix — the controller
 *     has to know the answer before filing it;
 *   * a candidate needing a different navigation specification is flyable but
 *     not a like-for-like swap, so it is a decision, not an automatic one;
 *   * a level change is never applied: its caveats (terminal areas it cannot
 *     clear, an airway ceiling below the level it needs) live in its prose.
 *
 * Pure: it only CHOOSES. Staging the routes is the caller's, and so is the
 * re-check that confirms them.
 */

import type { PdrCategory, PdrReport, RouteSuggestion } from "./detect";
import { sameRoute } from "./routeRules";
import { pdrVerdict } from "./verdict";

/** Findings a different routing can remove. A "flight-level" finding is about
 *  the requested level itself and follows the flight onto any route. */
const ROUTE_DEPENDENT: ReadonlySet<PdrCategory> = new Set<PdrCategory>([
  "restricted-airspace",
  "route-availability",
  "route-direction",
  "route-condition",
  "airway-direction",
  "airway-level",
]);

export interface PdrAutoFlight {
  flightKey: string;
  callsign: string;
  /** The route as filed, so an alternative identical to it is not "a fix". */
  filedRoute?: string;
}

export type PdrAutoOutcome =
  | {
      kind: "reroute";
      flightKey: string;
      callsign: string;
      route: string;
      suggestion: RouteSuggestion;
      /** Findings the new route will NOT remove — the flight will still need
       *  attention for these after the re-check. Empty = fully resolved. */
      remaining: string[];
    }
  | {
      kind: "unresolved";
      flightKey: string;
      callsign: string;
      /** Why no route was applied. */
      reason: string;
      /** The engine's best non-routing action, when it has one. */
      action?: string;
    };

/** One auto-resolve run, as the panel reports it. */
export interface PdrAutoSummary {
  outcomes: PdrAutoOutcome[];
  /** The routes went into the plans but the flights on screen are generated
   *  trajectories: nothing is re-checked until they are generated again. */
  needsGenerate: boolean;
}

/** Why a candidate is not safe to apply unattended, or null when it is. */
export function autoBlocker(s: RouteSuggestion, filedRoute?: string): string | null {
  if (s.activeAreas.length > 0) return "still crosses " + s.activeAreas.join(", ");
  if (s.issues.length > 0) return s.issues[0];
  if (s.condition && s.condition.state !== "met") {
    return "route condition " + (s.condition.state === "unmet" ? "not met" : "cannot be verified") +
      ": " + s.condition.detail;
  }
  if (s.capabilityNote) return s.capabilityNote;
  if (filedRoute && sameRoute(s.route, filedRoute)) return "same as the filed route";
  return null;
}

/** Decide one flight. `report` must be the FULL report (alternatives
 *  included) — the bulk scan's reports carry none. */
export function autoResolveFlight(
  flight: PdrAutoFlight,
  report: PdrReport,
): PdrAutoOutcome {
  const { flightKey, callsign } = flight;
  const action = report.remedies.find((r) => r.kind !== "route")?.detail;
  const pick = report.suggestions.find((s) => autoBlocker(s, flight.filedRoute) === null);
  if (pick) {
    const remaining = report.findings
      .filter((f) => f.severity !== "info" && !ROUTE_DEPENDENT.has(f.category))
      .map((f) => f.title);
    return { kind: "reroute", flightKey, callsign, route: pick.route, suggestion: pick, remaining };
  }
  if (report.suggestions.length === 0) {
    return {
      kind: "unresolved",
      flightKey,
      callsign,
      reason: "No published alternative for this pair.",
      action,
    };
  }
  const why = autoBlocker(report.suggestions[0], flight.filedRoute)!;
  return {
    kind: "unresolved",
    flightKey,
    callsign,
    reason:
      "No alternative is safe to apply unattended — best candidate " +
      report.suggestions[0].route + ": " + why.replace(/\.$/, "") + ".",
    action,
  };
}

/** Every REJECTED flight's outcome, in list order. Flights with only
 *  cautions (the "Check" tab) are a judgement call and are left alone, as are
 *  flights the scan has not reached. `reportOf` must give full reports. */
export function autoResolvePdr(
  flights: readonly PdrAutoFlight[],
  scanned: ReadonlyMap<string, PdrReport>,
  reportOf: (flightKey: string) => PdrReport | undefined,
): PdrAutoOutcome[] {
  const out: PdrAutoOutcome[] = [];
  for (const f of flights) {
    if (pdrVerdict(scanned.get(f.flightKey)) !== "rejected") continue;
    const full = reportOf(f.flightKey);
    if (!full) continue;
    out.push(autoResolveFlight(f, full));
  }
  return out;
}
