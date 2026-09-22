/**
 * Shared navigation types.
 *
 * Two levels, deliberately separate:
 *
 *  • `MainNavId` — the GLOBAL bar across the top of the shell (Home, Tool,
 *    Trajectory, …). It is the application's own navigation and never changes
 *    with what the workspace below it is showing.
 *
 *  • `NavView` — which PAGE the Generator workspace (the left rail) is on.
 *    This is the level "Generator" now lives at: it is the tool you are in,
 *    not a global destination.
 */

import type { RouteSection } from "@/components/RouteResultTabs";

/** The workspace page under the global bar. */
export type NavView =
  | { kind: "generator" }
  /** "All routes" view. `section` chooses what each route card shows:
   *  "both" = Vertical + Summary stacked (the landing/overview),
   *  "vertical" = every route's Vertical profile only,
   *  "summary" = every route's Trajectory summary only. All three are
   *  searchable by callsign / ADEP-ADES / route. */
  | { kind: "all"; section: RouteSection | "both" }
  | { kind: "route"; routeIdx: number; section: RouteSection }
  | null;

/** Every tab on the global bar, in display order. */
export type MainNavId =
  | "home"
  | "tool"
  | "trajectory"
  | "conflicts"
  | "plancheck"
  | "sector"
  | "sequencing"
  | "basemap"
  | "airspace"
  | "layers"
  | "export";

/** The CD&R views that share the left rail with the departure-conflict panel.
 *  Lives here rather than in MapApp so the Conflicts and Plan check menus can
 *  name them too without importing the shell they are rendered by. */
export type CdrView =
  | "notifications"
  | "dashboard"
  | "arrivals"
  | "log"
  | "pdr"
  | "sectorinfo"
  | "dynsector"
  | null;

/**
 * When the auto-resolver works.
 *   "off"    — manual only (default).
 *   "before" — one up-front pass over the whole filed plan, run with the clock
 *              parked at t=0, so the replay starts already deconflicted.
 *   "during" — resolve continuously while the replay runs.
 */
export type AutoResolveMode = "off" | "before" | "during";

/** One choice in the Conflicts menu's auto-resolve group. */
export interface AutoModeOption {
  mode: AutoResolveMode;
  label: string;
  hint: string;
}
