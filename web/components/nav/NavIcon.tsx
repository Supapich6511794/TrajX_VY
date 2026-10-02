"use client";

/**
 * NavIcon — the chrome's icon set, as line art.
 *
 * One stroked SVG per name, drawn on a 24×24 grid in `currentColor`, so an
 * icon takes the colour of whatever it sits in: dim on a resting tab, accent
 * on an open one, `--on-accent` on a filled row. That is the whole reason this
 * exists instead of emoji — an emoji is a full-colour picture from the system
 * font, it ignores the palette, it renders differently on every machine, and a
 * console that is otherwise two greys and one cyan reads as a toybox with a
 * dozen of them across the top.
 *
 * Deliberately plain geometry: at 16px a clever icon is a smudge. Every path
 * here is built from a handful of straight runs and one curve at most.
 */

import { memo, type ReactNode } from "react";

export type NavIconName =
  // Global tabs
  | "home"
  | "tool"
  | "trajectory"
  | "filter"
  | "conflicts"
  | "plancheck"
  | "sector"
  | "sequencing"
  | "basemap"
  | "airspace"
  | "layers"
  | "export"
  // Chrome
  | "moon"
  | "sun"
  | "menu"
  | "volume"
  | "volume-off"
  // Tool menu
  | "profile"
  | "measure"
  // Basemap menu
  | "street"
  | "satellite"
  // Layer tabs
  | "gates"
  | "departure"
  | "arrival"
  | "waypoint"
  | "signal"
  | "holding"
  | "airway"
  // Conflicts menu
  | "bell"
  | "log"
  | "restricted"
  | "chart"
  | "grid"
  | "auto"
  // Map chrome
  | "eye"
  | "eye-off"
  | "lock"
  | "unlock"
  | "settings"
  | "search"
  | "tag"
  | "trails"
  | "file"
  | "clearance";

const PATHS: Record<NavIconName, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3.5l9 7" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M9.75 20v-5.5h4.5V20" />
    </>
  ),
  // Sliders: the tools that change what the map draws, not the data.
  tool: (
    <>
      <path d="M4 7h8M16 7h4M4 12h4M12 12h8M4 17h10M18 17h2" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
  trajectory: (
    <path d="M10.3 4.2a1.7 1.7 0 0 1 3.4 0v5.9l7.3 4v1.8l-7.3-2.1v4l2.5 1.7v1.5L12 20l-4.2 1v-1.5l2.5-1.7v-4L3 15.9v-1.8l7.3-4z" />
  ),
  filter: <path d="M4 5h16l-6.3 7.4V20l-3.4-2.2v-5.4z" />,
  conflicts: <path d="M13.2 3 5.5 13.8h5.1L10.4 21l7.9-10.9h-5.2z" />,
  /* A filed plan with a tick against it — the checks that run before a flight
     is airborne, rather than the separation that is watched once it is. */
  plancheck: (
    <>
      <path d="M13.5 3.5H6a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 6 20.5h7" />
      <path d="M8 8h6M8 11.5h4" />
      <path d="m14.5 15.5 2.5 2.5 4-4.5" />
    </>
  ),
  // A block of airspace with a working boundary through it — which is what a
  // sector is, and what dynamic sectorisation moves.
  sector: (
    <>
      <path d="M4 7.5 11 4.5l9 3v9.5l-9 2.5-7-2.5z" />
      <path d="M11 4.5v15" />
    </>
  ),
  // An arrival: a track brought down onto the ground line.
  sequencing: (
    <>
      <path d="M3 20.5h18" />
      <path d="M5.5 5v7.5a3.5 3.5 0 0 0 3.5 3.5h9" />
      <path d="M15 13l3 3-3 3" />
    </>
  ),
  basemap: (
    <>
      <path d="M9 4.5 3 7v12.5L9 17l6 2.5 6-2.5V4.5L15 7z" />
      <path d="M9 4.5V17M15 7v12.5" />
    </>
  ),
  // A block of airspace, seen as a volume rather than a flat shape.
  airspace: (
    <>
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 3 7.8l9 4.8 9-4.8z" />
      <path d="M3 12.6 12 17.4l9-4.8" />
      <path d="M3 17.2 12 22l9-4.8" />
    </>
  ),
  export: (
    <>
      <path d="M12 3.5v11" />
      <path d="M7.8 10.5 12 14.7l4.2-4.2" />
      <path d="M4 20h16" />
    </>
  ),
  moon: <path d="M20.5 14.8A8.6 8.6 0 0 1 9.2 3.5a8.8 8.8 0 1 0 11.3 11.3z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  volume: (
    <>
      <path d="M4 9.5h3.5L13 5.5v13L7.5 14.5H4z" />
      <path d="M16.5 9a4.5 4.5 0 0 1 0 6" />
    </>
  ),
  "volume-off": (
    <>
      <path d="M4 9.5h3.5L13 5.5v13L7.5 14.5H4z" />
      <path d="m16.5 9.5 5 5M21.5 9.5l-5 5" />
    </>
  ),
  // A vertical profile: climb, cruise, descent — which is what TOC/TOD mark.
  profile: (
    <>
      <path d="M3 19 8.5 8.5h7L21 19" />
      <path d="M8.5 8.5h7" />
    </>
  ),
  // The span between two things, which is all the measure tool reports.
  measure: (
    <>
      <path d="M4 12h16" />
      <path d="M7.5 8.5 4 12l3.5 3.5M16.5 8.5 20 12l-3.5 3.5" />
      <path d="M4 6v3M20 6v3" />
    </>
  ),
  street: (
    <>
      <path d="M7 21 9.5 3h5L17 21" />
      <path d="M12 6.5v2.5M12 12v2.5M12 17.5V20" />
    </>
  ),
  satellite: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17z" />
    </>
  ),
  gates: (
    <>
      <path d="M6.5 3h11v18h-11z" />
      <path d="M14 12h.01" />
    </>
  ),
  departure: (
    <>
      <path d="M4 20.5h16" />
      <path d="M5.5 14.5 17 8.5" />
      <path d="M12.5 7.5 17.5 8l-.5 5" />
    </>
  ),
  arrival: (
    <>
      <path d="M4 20.5h16" />
      <path d="M5.5 8.5 17 14.5" />
      <path d="M17.5 9.5 17 15l-4.5-2.5" />
    </>
  ),
  waypoint: (
    <>
      <path d="M12 21.5c0-5 5.5-6.6 5.5-11a5.5 5.5 0 0 0-11 0c0 4.4 5.5 6 5.5 11z" />
      <circle cx="12" cy="10.5" r="2" />
    </>
  ),
  signal: (
    <>
      <path d="M12 21v-7" />
      <path d="M8.6 11.4a4.8 4.8 0 0 1 6.8 0" />
      <path d="M6 8.8a8.5 8.5 0 0 1 12 0" />
      <circle cx="12" cy="13.5" r="1" />
    </>
  ),
  // A racetrack, which is what a published hold is.
  holding: <path d="M9 6.5h6a5.5 5.5 0 0 1 0 11H9a5.5 5.5 0 0 1 0-11z" />,
  airway: (
    <>
      <path d="M4.5 18.5 10 7.5l4 7 5.5-6" />
      <circle cx="4.5" cy="18.5" r="1.6" />
      <circle cx="19.5" cy="8.5" r="1.6" />
    </>
  ),
  bell: (
    <>
      <path d="M6 10a6 6 0 0 1 12 0c0 4.5 1.8 6 1.8 6H4.2S6 14.5 6 10z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  log: (
    <>
      <path d="M7 3h7l4.5 4.5V21H7z" />
      <path d="M13.8 3v5h4.7" />
      <path d="M10 13h6M10 16.5h4" />
    </>
  ),
  restricted: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  chart: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M7 20.5v-6M12 20.5v-11M17 20.5v-4" />
    </>
  ),
  grid: (
    <>
      <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
    </>
  ),
  auto: (
    <>
      <path d="M7.5 7.5h9v9h-9z" />
      <path d="M10 3.5v4M14 3.5v4M10 16.5v4M14 16.5v4M3.5 10h4M3.5 14h4M16.5 10h4M16.5 14h4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M4 4.5 20 20.5" />
      <path d="M9.6 6.1A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.4 4.2" />
      <path d="M6.4 8A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.2-.6" />
      <path d="M10 10a3 3 0 0 0 4 4" />
    </>
  ),
  lock: (
    <>
      <path d="M5.5 10.5h13v10h-13z" />
      <path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5" />
    </>
  ),
  unlock: (
    <>
      <path d="M5.5 10.5h13v10h-13z" />
      <path d="M8.5 10.5V7a3.5 3.5 0 0 1 6.8-1.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.4 15.4 21 21" />
    </>
  ),
  tag: (
    <>
      <path d="M3.5 11.2V4h7.2l9.3 9.3-7.2 7.2z" />
      <circle cx="7.6" cy="7.6" r="1.5" />
    </>
  ),
  // A track thinning out behind the aircraft, which is what a trail is.
  trails: (
    <>
      <path d="M20 5.5 9.5 16" />
      <circle cx="19.5" cy="5.5" r="2" />
      <path d="M8 17.5h.01M5.5 19h.01M3.5 20.5h.01" />
    </>
  ),
  file: (
    <>
      <path d="M7 3h7l4.5 4.5V21H7z" />
      <path d="M13.8 3v5h4.7" />
    </>
  ),
  // Transmitted, not written down: a clearance is read to the pilot.
  clearance: (
    <>
      <path d="M4 9.5h3.5L13 5.5v13L7.5 14.5H4z" />
      <path d="M17 9a4.5 4.5 0 0 1 0 6" />
      <path d="M19.5 6.5a8 8 0 0 1 0 11" />
    </>
  ),
};

export interface NavIconProps {
  name: NavIconName;
  /** Edge length in px. 16 suits a tab, 15 a dropdown row. */
  size?: number;
}

function NavIcon({ name, size = 16 }: NavIconProps) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

export default memo(NavIcon);
