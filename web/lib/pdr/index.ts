/**
 * PDR Conflict Detection & Route Suggestion.
 *
 * Checks a filed flight plan against the Prohibited / Danger / Restricted
 * areas and the published flight-planning routes of the current AIRAC, and
 * proposes published alternatives when it finds a problem. Advisory only —
 * nothing here changes a plan.
 *
 * Typical use (see components/pdr/PdrPanel for the wired version):
 *
 *     const [activity, sector] = await Promise.all([
 *       fetchPdrActivity(),
 *       fetchSector("pdr"),
 *     ]);
 *     const areas = buildPdrAreas(sector, activity);
 *     const report = analysePdr({ ...plan, areas, publishedRoutes, fixes, airways });
 *
 * Module map:
 *   types        — the vocabulary (areas, timesheets, incursions, verdicts)
 *   solar        — sunrise/sunset, for "sunset to sunrise" schedules
 *   schedule     — is an area active at an instant, and why
 *   areas        — join the PDR polygons to their published timetables
 *   penetration  — where a route is inside a volume, and when
 *   routeRules   — ENR 1.10 availability, direction and conditions
 *   detect       — the orchestrator: findings + ranked suggestions
 *   autoResolve  — pick the fix for every rejected plan in one pass
 */

export {
  checkAirwayUsage,
  edgePermitted,
  fetchRouteSegments,
  indexSegments,
} from "./airwayDirection";
export type {
  AirwayIssue,
  AirwayIssueKind,
  RouteSegment,
  RouteSegmentFile,
  SegmentDirection,
  SegmentIndex,
} from "./airwayDirection";
export { fetchPdrActivity, buildPdrAreas, areasWithoutSchedule } from "./areas";
export { autoBlocker, autoResolveFlight, autoResolvePdr } from "./autoResolve";
export type { PdrAutoFlight, PdrAutoOutcome, PdrAutoSummary } from "./autoResolve";
export { analysePdr, areaScheduleText } from "./detect";
export type {
  PdrCategory,
  PdrCheckInput,
  PdrFinding,
  PdrReport,
  PdrSeverity,
  RouteSuggestion,
} from "./detect";
export { findIncursions, pathFromFixes, routeLengthNm, haversineNm } from "./penetration";
export {
  aircraftClass,
  evaluateCondition,
  matchFiledRoute,
  parseCondition,
  routeConditionVerdict,
  sameRoute,
} from "./routeRules";
export type {
  AircraftClass,
  ConditionVerdict,
  RouteCondition,
  RouteMatch,
} from "./routeRules";
export { activityAt, formatSchedule, formatSheet, worseState } from "./schedule";
export { sunTimes } from "./solar";
export type {
  ActivityState,
  ActivityVerdict,
  PdrActivity,
  PdrActivityFile,
  PdrArea,
  PdrIncursion,
  PdrKind,
  Timesheet,
  TimedPoint,
} from "./types";
