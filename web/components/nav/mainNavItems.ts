/**
 * The global tab registry.
 *
 * This list IS the bar: `MainNavigation` renders it in order and asks the
 * caller for a "slot" per id (active state, badge, what to do, what the
 * dropdown contains). Adding a tab is therefore two edits — an entry here and
 * a slot in `MapApp` — and no change to the bar itself.
 *
 * A tab with no slot still renders, disabled: the structure is ready for a
 * page that does not exist yet without pretending it does.
 */

import type { NavIconName } from "@/components/nav/NavIcon";
import type { MainNavId } from "@/components/nav/types";

export interface MainNavDef {
  id: MainNavId;
  /** Line-art glyph, drawn in `currentColor`. Shown beside the label only
   *  where the label is not — the Home tab, and every tab once the bar goes
   *  icon-only on a narrow screen. */
  icon: NavIconName;
  /** Visible label. Hidden below the icon-only breakpoint. */
  label: string;
  /** `title` text — what the tab is for, in one line. */
  hint: string;
  /** "menu" opens a dropdown under the tab; "action" fires and closes. */
  kind: "menu" | "action";
  /** Icon-only, no label, even on a wide screen (the Home button). */
  iconOnly?: boolean;
}

export const MAIN_NAV_ITEMS: readonly MainNavDef[] = [
  {
    id: "home",
    icon: "home",
    label: "Home",
    hint: "Back to the Generator — the first page of a run",
    kind: "action",
    iconOnly: true,
  },
  {
    id: "tool",
    icon: "tool",
    label: "Tool",
    hint: "Trails, flight tags, TOC/TOD, measure and the flight filter",
    kind: "menu",
  },
  {
    id: "trajectory",
    icon: "trajectory",
    label: "Trajectory",
    hint: "The generated flights' vertical profile and trajectory summary",
    kind: "menu",
  },
  {
    id: "conflicts",
    icon: "conflicts",
    label: "Conflicts",
    hint: "Conflict detection and resolution — the separation between flights in the air",
    kind: "menu",
  },
  {
    id: "plancheck",
    icon: "plancheck",
    label: "Plan check",
    hint: "Checks on the FILED plans, before anything flies — departures that cannot be cleared as filed, and each route against the restricted areas and the published preferred routes",
    kind: "menu",
  },
  {
    id: "sector",
    icon: "sector",
    label: "Sector",
    hint: "Sector information and dynamic sectorisation — the workload per sector and the configuration it asks for",
    kind: "menu",
  },
  {
    id: "sequencing",
    icon: "sequencing",
    label: "Sequencing",
    hint: "Arrival sequencing — the landing order and the spacing it needs",
    kind: "action",
  },
  {
    id: "basemap",
    icon: "basemap",
    label: "Basemap",
    hint: "Dark, Light, Street or Satellite tiles",
    kind: "menu",
  },
  {
    id: "airspace",
    icon: "airspace",
    label: "Airspace",
    hint: "Airspace sectors — BACC, CTR, TMA and the restricted areas",
    kind: "menu",
  },
  {
    id: "layers",
    icon: "layers",
    label: "Layers",
    hint: "Map layers — airports, gates, airways, SID, STAR, PBN, ILS, holding",
    kind: "menu",
  },
  {
    id: "export",
    icon: "export",
    label: "Export",
    hint: "Download the generated trajectories and the run report",
    kind: "action",
  },
];
