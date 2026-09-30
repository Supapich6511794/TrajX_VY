"use client";

/**
 * LeafletMap — browser-only react-leaflet map (loaded via dynamic ssr:false).
 *
 *  - Basemap   : streets / satellite / dark tiles (switchable).
 *  - FIR        : optional Flight Information Region polygons.
 *  - Airways    : faint reference network from the real airway file.
 *  - Trajectory : the generated path + route/start/end markers.
 *  - Aircraft   : animated icon driven by the playback hook.
 *
 * The aircraft updates ~60×/sec while playing. Every static layer (FIR,
 * airways, waypoints, the trajectory path/markers) is memoised so those
 * subtrees keep a stable element identity and React skips reconciling them
 * on each animation frame — only the aircraft marker re-renders.
 */

import L from "leaflet";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Pane,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";

import {
  aircraftColor,
  altitudeColor,
  DEFAULT_COLOR_BY,
  type ColorBy,
} from "@/lib/displayColors";
import { greatCircleNm } from "@/lib/geoDistance";
import { BASEMAPS, type Basemap } from "@/lib/mapPrefs";
import type { PreviewPoint } from "@/lib/routePreview";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";
import { aircraftAt, toSamples } from "@/lib/useSimPlayback";
import { smoothTrack, subdivisionFor } from "@/lib/trailCurve";
import { formatAirspace, type AirspaceMembership } from "@/lib/airspace";
import type {
  AirwayCollection,
  FirCollection,
  ProcedureLineCollection,
  ProcedureWaypointCollection,
  Waypoint,
} from "@/lib/types";
import type { AirportOption } from "@/lib/aip";
import type { GateCollection, RunwayPoint } from "@/lib/atcLayers";
import {
  SECTORS,
  type AirwayPointCollection,
  type SectorCollection,
  type SectorKey,
} from "@/lib/geojson";
import { layerBand } from "@/lib/airspace";
import type {
  HoldingLayerState,
  ProcLayerState,
} from "@/components/LayerOptions";
import {
  holdingRacetrack,
  HOLDING_CATEGORY_LABEL,
  type HoldingCategory,
  type HoldingPattern,
} from "@/lib/holdings";
import type { ProcedureDto } from "@/lib/api";
import ConflictLayer from "@/components/cdr/ConflictLayer";
import type { TrackedConflict } from "@/lib/cdr/lifecycle";
import type { CdrAircraft } from "@/lib/cdr/types";

interface Props {
  basemap: Basemap;
  airways: AirwayCollection | null;
  /** Airway reference-point overlays (the Airway tab): VOR navaids and
   *  reporting points, plus a shared opacity for the airway lines + points.
   *  Reporting is large (~35 k pts) so it only draws when zoomed in.
   *  `labels`, when set, carries the airway collection whose designators
   *  ("W18", "V3", …) are drawn — one label per airway. */
  airwayPts?: {
    vor?: AirwayPointCollection | null;
    reporting?: AirwayPointCollection | null;
    labels?: AirwayCollection | null;
    opacity?: number;
  };
  /** Reference waypoint layer (all fixes), or null to hide. */
  waypoints: Waypoint[] | null;
  fir: FirCollection | null;
  /** Airspace sector overlays (CTR / TMA / CTA / FIR / PDR), each
   *  present only when its layer is toggled on. */
  sectors?: Partial<Record<SectorKey, SectorCollection | null>>;
  /** How sector polygons are filled: "zone" = the per-zone legend colour,
   *  "sector" = a distinct colour per sector, "altitude" = by the coded band. */
  sectorColorMode?: "zone" | "sector" | "altitude";
  /** SID/STAR procedure tracks + fixes (full collections; visibility,
   *  filtering and styling are driven by `sid`/`star`). */
  sidLines?: ProcedureLineCollection | null;
  starLines?: ProcedureLineCollection | null;
  sidWpts?: ProcedureWaypointCollection | null;
  starWpts?: ProcedureWaypointCollection | null;
  pbnLines?: ProcedureLineCollection | null;
  pbnWpts?: ProcedureWaypointCollection | null;
  ilsLines?: ProcedureLineCollection | null;
  ilsWpts?: ProcedureWaypointCollection | null;
  /** Layer Options state per procedure layer (routes/waypoints on,
   *  airport+procedure filters, opacity, line thickness). */
  /** Every holding pattern in the FIR + the Holding tab's layer state. Null
   *  until the layer is first switched on (the data is fetched lazily). */
  holdings?: HoldingPattern[] | null;
  holding?: HoldingLayerState;
  sid?: ProcLayerState;
  star?: ProcLayerState;
  pbn?: ProcLayerState;
  ils?: ProcLayerState;
  /** Aerodromes for the Airports layer — every one not in `hiddenAirports`
   *  is drawn as a pin. */
  airports?: AirportOption[];
  /** Airport ICAOs hidden from the map (unchecked in the panel). */
  hiddenAirports?: Set<string>;
  /** Gate points (shown when non-null) and runway threshold points. */
  gates?: GateCollection | null;
  runways?: RunwayPoint[] | null;
  /** Label each runway threshold with its ident (03L, 21R…) — only rendered
   *  once zoomed in past RUNWAY_LABEL_ZOOM, where the strips are readable. */
  runwayLabels?: boolean;
  /** A procedure resolved via the lookup form / map click — drawn as a
   *  bright highlighted path with labelled fixes. */
  highlightProc?: ProcedureDto | null;
  /** Fired when a SID/STAR track is clicked — the parent fetches that
   *  procedure's coded legs + constraints from the procedures API. */
  onProcedureClick?: (sel: ProcedureSelection) => void;
  /** One or more generated routes, all shown/animated together. */
  trajectories: TrajectoryResult[];
  /** Trail drawing (the Trails menu): `showTrails` off draws the aircraft
   *  without its path line; `flColorTrails` off draws a flat per-route colour
   *  instead of the altitude (flight-level) gradient. `trailDecaySec` 0 = the
   *  whole route drawn statically; a positive value draws only a recent trail
   *  of that many flight-time seconds following the aircraft. */
  showTrails?: boolean;
  flColorTrails?: boolean;
  /** Tool menu → "Display by". Paints the aircraft symbol AND its trail from
   *  the same scale: "altitude" tints both by flight level (the symbol follows
   *  the aircraft up and down; the trail honours `flColorTrails`), "type" gives
   *  each aircraft type one colour for the symbol and the whole line. */
  colorBy?: ColorBy;
  trailDecaySec?: number;
  /** Stroke weight (px) of the coloured route/trail line; the dark casing is
   *  drawn 2 px wider. Set from the Trails menu's thickness slider. */
  trailWeight?: number;
  /** Show the TOC/TOD vertical-profile pins. Off by default so a fresh
   *  generation shows just the lines; the map toolbar's "TOC/TOD" button
   *  turns them on. */
  showProfilePins?: boolean;
  /** flightKeys whose route *line* is hidden on the map. The aircraft icon
   *  stays visible, so the user can declutter the lines mid-simulation while
   *  still tracking each flight. */
  hiddenKeys?: Set<string>;
  /** Live (pre-Generate) route previews from the GeneratorPanel — one
   *  entry per route the user has typed/picked/queued. Each is drawn as
   *  a faint dashed line in a distinct colour, with permanent ident
   *  labels so the user can see what they're about to fly while still
   *  editing. */
  previewRoutes?: PreviewPoint[][];
  /** Top-center aircraft-type filter (case-insensitive substring). When
   *  set, only matching flights are drawn — both their route line and the
   *  aircraft icon. Empty string shows every flight. */
  typeFilter?: string;
  /** Which fields the aircraft tag (the label beside each plane) shows,
   *  controlled by the Flight Tags menu. Updates the labels in real time. */
  tagFields?: {
    callsign: boolean;
    fl: boolean;
    ias: boolean;
    hdg: boolean;
    airspace: boolean;
  };
  /** Live airspace membership per flightKey (from MapApp); the tag's second
   *  line names the current zone when `tagFields.airspace` is on. */
  airspace?: Record<string, AirspaceMembership>;
  /** Shared sim clock (seconds); each aircraft is interpolated at it. */
  simT: number;
  /** Which route is currently driving the playback clock — a numeric
   *  index renders only that aircraft; ``"all"`` renders every aircraft
   *  on the longest-route clock (legacy behaviour). */
  playbackIdx?: number | "all";
  /** flightKeys whose animated aircraft icon is hidden (toggled from the
   *  filter panel's eye). Distinct from hiddenKeys, which hides route lines. */
  hiddenAircraft?: Set<string>;
  /** flightKey of the aircraft the camera is following — drawn with a
   *  pulsing highlight ring so it stands out from the rest. */
  followKey?: string;
  /** Clicking a plane on the map locks the camera onto it (the parent turns on
   *  camera-follow + the detail card). Index is into `trajectories`. While the
   *  Measure tool is armed the parent routes the same click to `measurePicks`
   *  instead — the map does not need to know which it is. */
  onAircraftClick?: (index: number) => void;
  /** Measure tool (Tool ▸ Measure): armed, and the aircraft picked so far —
   *  0, 1 or 2 indices into `trajectories`. With two, the separation between
   *  them is drawn and labelled at the live positions, so it tracks as they
   *  fly. */
  measureOn?: boolean;
  measurePicks?: number[];
  /** Hovering a plane shows its detail card without locking the camera; the
   *  parent clears it on mouse-out (index null). */
  onAircraftHover?: (index: number | null) => void;
  /** Bubbles the underlying Leaflet map instance up so the parent can
   *  drive zoom buttons rendered outside MapContainer (e.g. the +/− on
   *  the floating top-right toolbar). */
  onMapReady?: (map: L.Map | null) => void;
  /** A single Prohibited / Danger / Restricted area to pick out in red, from
   *  the route & area check's "Show area" button. Drawn above the sector
   *  overlays so it reads even with those layers on, and independent of them —
   *  the area is shown whether or not the PDR layer is switched on. */
  highlightAreas?: {
    ident: string;
    name: string;
    kind: "P" | "D" | "R";
    /** GeoJSON MultiPolygon rings, [lon, lat]. */
    mp: [number, number][][][] | number[][][][];
    /** Outline colour. Defaults to the restricted-area red. A proposed working
     *  boundary is drawn in its own colour: it is a staffing proposal, and
     *  painting it the same red as airspace to keep out of would say the
     *  opposite of what it means. */
    color?: string;
  }[];
  /** CD&R overlay: active conflicts + the traffic snapshot they were computed
   *  from, the selected conflict (drawn with full predicted tracks + CPA), and
   *  a flightKey→callsign resolver for labels. Undefined when CD&R is off. */
  cdrConflicts?: TrackedConflict[];
  cdrTraffic?: CdrAircraft[];
  cdrSelectedId?: string | null;
  cdrNameOf?: (id: string) => string;
  /** A resolution being previewed: the modified trajectory's path, drawn dashed
   *  and uncommitted. Null when nothing is previewed. */
  cdrPreview?: { lat: number; lon: number }[] | null;
  /** An APPLIED auto-resolve route the user opened for inspection: the flight's
   *  post-fix path, drawn dashed with a pulsing green glow. Null when none. */
  cdrResolvedRoute?: { lat: number; lon: number }[] | null;
  /** The same flight's PRE-fix path, drawn faint and dashed underneath so the
   *  maneuver reads as "was → is". Null when none. */
  cdrOriginalRoute?: { lat: number; lon: number }[] | null;
  /** Hover labels for the two lines above ("BKP102 · Climb FL160 — from FL140"
   *  / "BKP102 · original route"). Omitted = no tooltip. */
  cdrResolvedLabel?: string | null;
  cdrOriginalLabel?: string | null;
}

/** Captures the Leaflet map instance (only obtainable from inside a
 *  MapContainer via the useMap hook) and hands it back to the parent. */
function MapRefBridge({
  onReady,
}: {
  onReady: (m: L.Map | null) => void;
}) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
    return () => onReady(null);
  }, [map, onReady]);
  return null;
}

/** Reports the live map zoom so zoom-dependent layers (e.g. gate labels, shown
 *  only when zoomed in to an airport) can react to it. */
function ZoomWatcher({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => {
    onZoom(map.getZoom());
  }, [map, onZoom]);
  return null;
}

/** Gate dots always draw; their PERMANENT identifier labels only appear at or
 *  above this zoom (airport-diagram level) — below it the labels would blanket
 *  the country, so gates just show as dots with a hover tooltip. */
const GATE_ZOOM = 13;
/** Runway idents only label from this zoom in — at FIR-wide zoom the strips
 *  are sub-pixel and every aerodrome's labels would collide into a smear. */
const RUNWAY_LABEL_ZOOM = 10;

/** Per-route colours (cycled if there are more routes than entries). */
const ROUTE_COLORS = [
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#fbbf24",
  "#c084fc",
  "#fb7185",
];

/** Preview palette — same hue family as ROUTE_COLORS so a previewed
 *  route reads as the "draft" of the same route once generated. Used
 *  cyclically for the live route preview. */
const PREVIEW_COLORS = [
  "#38bdf8",
  "#f472b6",
  "#a3e635",
  "#fbbf24",
  "#c084fc",
  "#fb7185",
];

/** Myanmar (Yangon FIR) — the whole country fits at zoom 6. */
const DEFAULT_CENTER: L.LatLngExpression = [19.0, 96.5];
const DEFAULT_ZOOM = 6;

/** Holding-pattern colours, one per kind, so the four read apart on the map. */
const HOLDING_COLORS: Record<HoldingCategory, string> = {
  published: "#22d3ee",
  missed: "#fb7185",
  enroute: "#a78bfa",
  hilpt: "#facc15",
};
/** Below this zoom the holding fix labels are hidden — there are ~240 of them
 *  and they turn the whole FIR into a wall of text when zoomed out. */
const HOLDING_LABEL_ZOOM = 7;

/** Per-layer colours: SID green, STAR magenta, PBN amber, ILS red. */
const SID_COLOR = "#34d399";
const STAR_COLOR = "#f472b6";
const PBN_COLOR = "#fbbf24";
const ILS_COLOR = "#ef4444";
const GATE_COLOR = "#fb923c";
const RUNWAY_COLOR = "#e5e7eb";

/** Procedure-style layer kinds (share line/waypoint schema + rendering). */
type ProcKind = "SID" | "STAR" | "PBN" | "ILS";

/** A track the user clicked, for the parent to resolve via the API. */
export interface ProcedureSelection {
  airport: string;
  name: string;
  transition: string | null;
  type: ProcKind;
}

/** Tooltip/popup + click wiring for one procedure line feature. */
function bindProcedureFeature(
  feature: GeoJSON.Feature,
  layer: L.Layer,
  type: ProcKind,
  onClick?: (sel: ProcedureSelection) => void,
): void {
  const p = (feature.properties ?? {}) as {
    airport_identifier?: string;
    procedure_identifier?: string;
    transition_identifier?: string | null;
  };
  const name = p.procedure_identifier ?? "?";
  const trans = p.transition_identifier ?? null;
  layer.bindTooltip(`${type} · ${name}`, { sticky: true });
  layer.bindPopup(
    `<strong>${name}</strong> · ${type}<br/>${p.airport_identifier ?? ""}` +
      (trans ? ` · ${trans}` : "") +
      (onClick ? "<br/><em>click to load legs</em>" : ""),
  );
  if (onClick) {
    layer.on("click", () =>
      onClick({
        airport: p.airport_identifier ?? "",
        name,
        transition: trans,
        type,
      }),
    );
  }
}

/** True if a feature's airport/procedure pass the Layer Options filters. */
function passesProcFilter(
  props: { airport_identifier?: string; procedure_identifier?: string },
  state: ProcLayerState,
): boolean {
  if (
    state.airports.size > 0 &&
    !state.airports.has(props.airport_identifier ?? "")
  ) {
    return false;
  }
  if (
    state.procedures.size > 0 &&
    !state.procedures.has(props.procedure_identifier ?? "")
  ) {
    return false;
  }
  return true;
}

/** A filtered + styled SID/STAR <GeoJSON> line layer, or null when off. */
function buildProcedureLayer(
  lines: ProcedureLineCollection | null | undefined,
  state: ProcLayerState | undefined,
  type: ProcKind,
  color: string,
  onClick?: (sel: ProcedureSelection) => void,
): ReactNode {
  if (!lines || !state?.routes) return null;
  const features = lines.features.filter((f) =>
    passesProcFilter(f.properties, state),
  );
  // react-leaflet's GeoJSON is keyed by data identity — fold the filter +
  // style into the key so it rebuilds when the user changes them.
  const apSig = [...state.airports].sort().join(",");
  const prSig = [...state.procedures].sort().join(",");
  const key = `${type}-${features.length}-${state.opacity}-${state.thickness}-${apSig}-${prSig}`;
  return (
    <GeoJSON
      key={key}
      data={{ type: "FeatureCollection", features } as GeoJSON.FeatureCollection}
      style={() => ({
        color,
        weight: state.thickness,
        opacity: state.opacity,
      })}
      onEachFeature={(f, layer) =>
        bindProcedureFeature(f, layer, type, onClick)
      }
    />
  );
}

/** Format a SID/STAR fix's ARINC 424 crossing restriction as a compact label,
 *  e.g. "-10000" (at/below), "+11000" (at/above), "5000-8000" (between),
 *  "10000" (at). Empty string when the fix has no altitude restriction. */
function fmtWptAlt(p: {
  altitude_description?: string | null;
  altitude1?: number | null;
  altitude2?: number | null;
}): string {
  const a1 = p.altitude1 ?? null;
  const a2 = p.altitude2 ?? null;
  if (a1 == null && a2 == null) return "";
  const desc = (p.altitude_description ?? "").trim();
  if (desc === "+") return a1 != null ? `+${a1}` : "";
  if (desc === "-") return a1 != null ? `-${a1}` : "";
  if (desc === "B") return `${a2 ?? "?"}-${a1 ?? "?"}`;
  return a1 != null ? `${a1}` : ""; // "@" / blank = a hard AT
}

/** Filtered SID/STAR fix dots (deduped by ident), each with a permanent label
 *  showing the ident + its crossing restriction (e.g. "GUGOT · -10000"), read
 *  from the SID/STAR waypoint files. Null when the layer is off. */
function buildWaypointLayer(
  wpts: ProcedureWaypointCollection | null | undefined,
  state: ProcLayerState | undefined,
  color: string,
): ReactNode {
  if (!wpts || !state?.waypoints) return null;
  const seen = new Map<string, { lat: number; lon: number; alt: string }>();
  for (const f of wpts.features) {
    const p = f.properties;
    if (!passesProcFilter(p, state)) continue;
    const ident = p.waypoint_identifier ?? null;
    const lat = p.waypoint_latitude ?? null;
    const lon = p.waypoint_longitude ?? null;
    if (!ident || lat == null || lon == null) continue;
    const prev = seen.get(ident);
    const alt = fmtWptAlt(p);
    // First sighting wins for position; fill the altitude from whichever
    // occurrence actually carries a restriction (the same fix is unconstrained
    // on some procedures and constrained on others).
    if (!prev) seen.set(ident, { lat, lon, alt });
    else if (!prev.alt && alt) prev.alt = alt;
  }
  return [...seen.entries()].map(([ident, { lat, lon, alt }]) => (
    <CircleMarker
      key={`pwp-${ident}`}
      center={[lat, lon]}
      radius={2.5}
      pathOptions={{
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.6,
        opacity: state.opacity,
      }}
    >
      <Tooltip
        permanent
        direction="right"
        offset={[4, 0]}
        className="pwp-label"
        opacity={1}
      >
        <span className="pwp-id" style={{ color }}>
          {ident}
        </span>
        {alt && (
          <span className="pwp-alt" style={{ color }}>
            {alt}
          </span>
        )}
      </Tooltip>
    </CircleMarker>
  ));
}

/** Blue map-pin airport icon (airplane glyph) with a hover pulse glow. */
function airportIcon(): L.DivIcon {
  return L.divIcon({
    className: "airport-icon",
    iconSize: [22, 28],
    iconAnchor: [11, 26], // tip of the pin sits on the coordinate
    html: `<span class="airport-pulse"></span><span class="airport-pin">
      <svg viewBox="0 0 24 24" width="10" height="10" fill="#fff">
        <path d="M12 2 L14 10 L22 14 L22 16 L14 13 L13 20 L16 22 L16 23
                 L12 22 L8 23 L8 22 L11 20 L10 13 L2 16 L2 14 L10 10 Z"/>
      </svg></span>`,
  });
}

/** Fit to the generated routes if any, otherwise the airway network. */
function FitBounds({
  airways,
  trajectories,
}: Pick<Props, "airways" | "trajectories">) {
  const map = useMap();
  // Which flights are loaded, not their contents: an applied fix rewrites one
  // route's points but must not yank the camera. Memoised because this
  // component re-renders on every animation frame.
  const sig = useMemo(
    () => trajectories.map((t) => t.meta.flightKey).join("|"),
    [trajectories],
  );
  useEffect(() => {
    const b = L.latLngBounds([]);
    if (trajectories.length) {
      trajectories.forEach((t) =>
        t.points.forEach((p) => b.extend([p.lat, p.lon])),
      );
    } else if (airways) {
      airways.features.forEach((f) =>
        f.geometry.coordinates.forEach(([lon, lat]) => b.extend([lat, lon])),
      );
    }
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, airways, sig]);
  return null;
}

/** Case-insensitive substring match of an aircraft type against the
 *  top-center filter query. An empty query matches everything (so "A32"
 *  matches A320/A321, "B789" matches just the 789). */
function matchesAcType(
  query: string | undefined,
  type: string | undefined,
): boolean {
  const q = (query ?? "").trim().toUpperCase();
  if (!q) return true;
  return (type ?? "").toUpperCase().includes(q);
}

/** A small SVG plane icon, rotated to the current heading and tinted by
 *  aircraft type. */
/** Plane icons by (heading, colour, followed). Handing react-leaflet the SAME
 *  icon object lets it skip `setIcon`, which otherwise tore down and rebuilt
 *  every aircraft's DOM element on every animation frame. Bounded: headings are
 *  whole degrees and colours come from fixed palettes. */
const planeIconCache = new Map<string, L.DivIcon>();

function planeIcon(
  track: number,
  color: string,
  highlight = false,
): L.DivIcon {
  const key = `${track}|${color}|${highlight ? 1 : 0}`;
  let icon = planeIconCache.get(key);
  if (!icon) {
    if (planeIconCache.size > 20000) planeIconCache.clear();
    icon = buildPlaneIcon(track, color, highlight);
    planeIconCache.set(key, icon);
  }
  return icon;
}

function buildPlaneIcon(
  track: number,
  color: string,
  highlight: boolean,
): L.DivIcon {
  const ring = highlight
    ? `<span class="aircraft-ring"></span>`
    : "";
  return L.divIcon({
    className: `aircraft-icon${highlight ? " followed" : ""}`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    html: `${ring}<div style="transform: rotate(${track}deg)">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="${color}"
           stroke="#0f172a" stroke-width="1.2">
        <path d="M12 2 L14 10 L22 14 L22 16 L14 13 L13 20 L16 22 L16 23
                 L12 22 L8 23 L8 22 L11 20 L10 13 L2 16 L2 14 L10 10 Z"/>
      </svg></div>`,
  });
}

/** Small pill badge for the Top-of-Climb / Top-of-Descent map markers. */
function profileBadge(text: string, color: string): L.DivIcon {
  // A small red dot AT the TOC/TOD point plus a tiny bare label (no filled
  // pill) — far less visual clutter when many routes show their TOC/TOD at
  // once. The label keeps the route's colour so TOC vs TOD still reads apart.
  return L.divIcon({
    className: "profile-badge",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html:
      `<span class="profile-badge-dot"></span>` +
      `<span class="profile-badge-text" style="color:${color}">${text}</span>`,
  });
}

/** Small pill badge identifying which route a polyline belongs to (R1, R2…)
 *  when several routes are flown at once. The pill is drawn just off the
 *  start endpoint so it doesn't overlap the green Start dot. */
/** Permanent gate-identifier pill, drawn just off the gate dot once zoomed in.
 *  Separate from the dot's hover tooltip (Leaflet allows one tooltip per
 *  marker), so hovering the dot still shows the full "ICAO - Gate <id>". */
function gateBadge(text: string): L.DivIcon {
  return L.divIcon({
    className: "gate-badge",
    iconSize: [0, 0],
    iconAnchor: [-4, 7],
    html: `<span class="gate-badge-pill">${text}</span>`,
  });
}

/** Runway ident badge pinned on a threshold — same pill shape as the gate
 *  badge, in the runway grey so it reads as part of the strip. */
function runwayBadge(text: string): L.DivIcon {
  return L.divIcon({
    className: "rwy-badge",
    iconSize: [0, 0],
    iconAnchor: [-5, 6],
    html: `<span class="rwy-badge-pill">${text}</span>`,
  });
}

/** Destination point `distNm` NM from (lat, lon) along a true bearing (deg) —
 *  used to build a runway strip rectangle out of a threshold + length + width. */
function destPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distNm: number,
): [number, number] {
  const R = 3440.065; // Earth radius, NM
  const d = distNm / R;
  const b = (bearingDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}

/** Display form of a coded runway ident — the ARINC "RW" prefix dropped so
 *  the badge reads like the painted number (RW03L → 03L). */
function rwyLabel(ident: string): string {
  return ident.replace(/^RW/i, "").trim() || ident;
}

/** Threshold badge text: runway ident plus that end's landing threshold
 *  elevation (ft AMSL), e.g. "18 · 260 ft" — the height of this threshold
 *  point, not of the whole runway. */
function rwyThrLabel(r: RunwayPoint): string {
  const id = rwyLabel(r.ident);
  return Number.isFinite(r.thrElevFt)
    ? `${id} · ${Math.round(r.thrElevFt)} ft`
    : id;
}

/** Reciprocal runway ident (RW03L → RW21R): +18 on the number (wrapping 1-36)
 *  and swapping L↔R, so a runway's two thresholds collapse into one strip. */
function reciprocalRwy(ident: string): string {
  const m = ident.match(/^RW(\d{1,2})([LRC]?)$/i);
  if (!m) return "";
  const num = ((parseInt(m[1], 10) + 18 - 1) % 36) + 1;
  const side = m[2].toUpperCase();
  const rec = side === "L" ? "R" : side === "R" ? "L" : side;
  return `RW${String(num).padStart(2, "0")}${rec}`;
}

/** A stable, distinct colour for a named sector — the sector's identity hashed
 *  onto the hue wheel, so 2S / 3S / 4S / each CTR-TMA-PDR read apart. */
function sectorHashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 58%)`;
}

/** Warm→cool colour for a normalised altitude fraction (0 = lowest band, 1 =
 *  highest) — same yellow→cyan feel as the trajectory legend. */
function altBandColor(f: number): string {
  const x = Math.max(0, Math.min(1, f));
  return `hsl(${(45 + x * 165).toFixed(0)}, 88%, ${(62 - x * 24).toFixed(0)}%)`;
}

/** Mid altitude (ft) of a sector feature's coded band; NaN when it has none. */
function sectorMidFt(props: Record<string, unknown>, key: SectorKey): number {
  const b = layerBand(props, key);
  const lo = Number.isFinite(b.lo) ? b.lo : NaN;
  const hi = Number.isFinite(b.hi) ? b.hi : NaN;
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return NaN;
  if (!Number.isFinite(hi)) return lo; // open top
  if (!Number.isFinite(lo)) return hi;
  return (lo + hi) / 2;
}

/**
 * A dot with a much larger *invisible* hit circle on top, so hovering a
 * waypoint is easy without enlarging the visible marker. The visible
 * circle is non-interactive; the transparent one carries tooltip/popup.
 */
function HoverFix({
  center,
  radius,
  hitRadius,
  pathOptions,
  children,
}: {
  center: L.LatLngExpression;
  radius: number;
  hitRadius: number;
  pathOptions: L.PathOptions;
  children: ReactNode;
}) {
  return (
    <>
      <CircleMarker
        center={center}
        radius={radius}
        pathOptions={{ ...pathOptions, interactive: false }}
      />
      <CircleMarker
        center={center}
        radius={hitRadius}
        pathOptions={{ stroke: false, fill: true, fillOpacity: 0 }}
      >
        {children}
      </CircleMarker>
    </>
  );
}

/** Start/End marker — the route's first/last fix, kept off the small
 *  intermediate markers so their tooltips don't stack and fight. */
function EndpointMarker({
  position,
  fill,
  stroke,
  ident,
  role,
  detail,
}: {
  position: L.LatLngExpression;
  fill: string;
  stroke: string;
  /** The aerodrome ICAO at this endpoint (e.g. "VYYY"). */
  ident: string;
  role: "Start" | "End";
  detail: string;
}) {
  return (
    <HoverFix
      center={position}
      radius={7}
      hitRadius={20}
      pathOptions={{
        color: stroke,
        weight: 2,
        fillColor: fill,
        fillOpacity: 1,
      }}
    >
      <Tooltip direction="top" offset={[0, -9]} sticky>
        <strong>{ident}</strong> · {role}
      </Tooltip>
      <Popup>
        <strong>
          {ident} — {role}
        </strong>
        <br />
        {detail}
      </Popup>
    </HoverFix>
  );
}

export default function LeafletMap({
  basemap,
  airways,
  airwayPts,
  waypoints,
  fir,
  sectors,
  sectorColorMode = "zone",
  sidLines,
  starLines,
  sidWpts,
  starWpts,
  pbnLines,
  pbnWpts,
  ilsLines,
  ilsWpts,
  holdings,
  holding,
  sid,
  star,
  pbn,
  ils,
  airports,
  hiddenAirports,
  gates,
  runways,
  runwayLabels,
  highlightProc,
  trajectories,
  showTrails = true,
  flColorTrails = true,
  colorBy = DEFAULT_COLOR_BY,
  trailDecaySec = 0,
  trailWeight = 2,
  showProfilePins = false,
  hiddenKeys,
  previewRoutes,
  typeFilter,
  onProcedureClick,
  tagFields,
  airspace,
  simT,
  playbackIdx,
  hiddenAircraft,
  followKey,
  onAircraftClick,
  onAircraftHover,
  measureOn,
  measurePicks,
  onMapReady,
  highlightAreas,
  cdrConflicts,
  cdrTraffic,
  cdrSelectedId,
  cdrNameOf,
  cdrPreview,
  cdrResolvedRoute,
  cdrOriginalRoute,
  cdrResolvedLabel,
  cdrOriginalLabel,
}: Props) {
  const tiles = BASEMAPS[basemap];


  // Elapsed-time sample table per trajectory (rebuilt only on new data).
  const samplesByRoute = useMemo(
    () => trajectories.map((t) => toSamples(t.points)),
    [trajectories],
  );

  // Absolute departure offset (seconds) per route: its first-sample epoch minus
  // the earliest first-sample epoch across all routes. In "all" mode the shared
  // sim clock is an ABSOLUTE timeline, so each flight animates at its real
  // EOBT — a later departure sits correspondingly behind on any shared track,
  // giving realistic in-trail separation instead of every plane launching at
  // once. Single-route playback ignores this (offset 0 = plays from its start).
  const routeOffsetSec = useMemo(() => {
    let origin = Infinity;
    for (const t of trajectories) {
      const p = t.points?.[0];
      if (p) origin = Math.min(origin, new Date(p.epoch_ts).getTime());
    }
    if (!Number.isFinite(origin)) origin = 0;
    return trajectories.map((t) => {
      const p = t.points?.[0];
      return p ? (new Date(p.epoch_ts).getTime() - origin) / 1000 : 0;
    });
  }, [trajectories]);

  const firLayer = useMemo(
    () =>
      fir && (
        <GeoJSON
          key={`fir-${fir.features.length}`}
          data={fir}
          style={() => ({
            color: "#a78bfa",
            weight: 1,
            opacity: 0.7,
            fillColor: "#a78bfa",
            fillOpacity: 0.05,
          })}
          onEachFeature={(f, layer) =>
            layer.bindPopup(`<strong>${f.properties?.name ?? "FIR"}</strong>`)
          }
        />
      ),
    [fir],
  );

  const airwayLayer = useMemo(
    () =>
      airways && (
        <GeoJSON
          key={`airways-${airways.features.length}`}
          data={airways}
          style={() => ({
            color: "#f59e0b",
            weight: 1,
            opacity: airwayPts?.opacity ?? 0.35,
          })}
        />
      ),
    [airways, airwayPts?.opacity],
  );

  // Airway reporting points (the Airway menu) — pink up-triangle + ident.
  // `fetchAirwayReporting` always returns an empty collection for this
  // deployment (see its doc comment: a "compulsory reporting point" has no
  // structured AIXM field, so there is genuinely nothing to draw here yet),
  // so this never runs today; left in place for if that ever changes. The
  // region crop below is now meaningless for the same reason it was removed
  // from the VOR layer above — kept here only because it is currently inert.
  const airwayPointLayers = useMemo(() => {
    const data = airwayPts?.reporting;
    if (!data) return null;
    const op = airwayPts?.opacity ?? 0.85;
    const inRegion = (lon: number, lat: number) =>
      lon >= 97.5 && lon <= 106 && lat >= 5.5 && lat <= 20.5;

    const markers: ReactNode[] = [];
    for (const f of data.features) {
      const g = f.geometry;
      const coords =
        g?.type === "MultiPoint"
          ? (g.coordinates as number[][])
          : g?.type === "Point"
            ? [g.coordinates as number[]]
            : [];
      const id = String(f.properties?.waypoint_identifier ?? "");
      if (!id) continue;
      for (let i = 0; i < coords.length; i++) {
        const [lon, lat] = coords[i];
        if (!inRegion(lon, lat)) continue;
        markers.push(
          <Marker
            key={`rep-${id}-${i}-${lat},${lon}`}
            position={[lat, lon]}
            interactive={false}
            opacity={op}
            icon={L.divIcon({
              className: "rep-icon",
              iconSize: [12, 12],
              iconAnchor: [6, 5],
              html: `<span class="rep-tri"></span><span class="rep-lbl">${id}</span>`,
            })}
          />,
        );
      }
    }
    return <>{markers}</>;
  }, [airwayPts?.reporting, airwayPts?.opacity]);

  // VOR navaids — drawn as the conventional ring+centre-dot symbol with the
  // station identifier beside it. The source file is already Myanmar-only
  // (18 VOR/DME stations, straight from the AIXM export — see
  // scripts/ingest_aixm_airways.py), so there is no worldwide set to crop
  // down: no region filter is needed.
  const airwayVorLayer = useMemo(() => {
    const data = airwayPts?.vor;
    if (!data) return null;
    const op = airwayPts?.opacity ?? 0.85;

    const markers: ReactNode[] = [];
    for (const f of data.features) {
      const g = f.geometry;
      const coords =
        g?.type === "MultiPoint"
          ? (g.coordinates[0] as number[] | undefined)
          : g?.type === "Point"
            ? (g.coordinates as number[])
            : undefined;
      if (!coords) continue;
      const [lon, lat] = coords;
      const id = String(f.properties?.waypoint_identifier ?? "");
      markers.push(
        <Marker
          key={`vor-${id}-${f.properties?.fid ?? `${lat},${lon}`}`}
          position={[lat, lon]}
          interactive={false}
          opacity={op}
          icon={L.divIcon({
            className: "vor-icon",
            iconSize: [12, 12],
            iconAnchor: [6, 6],
            html: `<span class="vor-ring"></span><span class="vor-lbl">${id}</span>`,
          })}
        />,
      );
    }
    return <>{markers}</>;
  }, [airwayPts?.vor, airwayPts?.opacity]);

  // Airway designator labels ("W18", "V3", …) — one permanent tooltip per
  // airway, anchored on the first segment that names it. Invisible host lines
  // (weight/opacity 0) so only the labels show; toggled by the Airway menu.
  const airwayLabelLayer = useMemo(() => {
    const data = airwayPts?.labels;
    if (!data) return null;
    const seen = new Set<string>();
    return (
      <GeoJSON
        key={`aw-labels-${data.features.length}`}
        data={data}
        style={() => ({ weight: 0, opacity: 0, interactive: false })}
        onEachFeature={(feature, layer) => {
          const id = feature.properties?.route_identifier;
          if (!id || seen.has(id)) return;
          seen.add(id);
          layer.bindTooltip(String(id), {
            permanent: true,
            direction: "center",
            className: "aw-label",
            opacity: airwayPts?.opacity ?? 0.8,
          });
        }}
      />
    );
  }, [airwayPts?.labels, airwayPts?.opacity]);

  // Airspace sector overlays — one dashed, lightly-filled <GeoJSON> per
  // toggled-on sector (CTR / TMA / CTA / FIR / PDR), each in its own
  // colour with a name popup.
  const sectorLayers = useMemo(
    () =>
      SECTORS.map((s) => {
        const data = sectors?.[s.key];
        if (!data) return null;
        // Altitude mode: normalise each sector's mid-band across THIS layer's
        // own min→max, so bands spread over the whole warm→cool palette (CTR
        // mids cluster tightly, so absolute colouring looks uniform — relative
        // colouring makes low/high sectors clearly different).
        let loMid = Infinity;
        let hiMid = -Infinity;
        if (sectorColorMode === "altitude") {
          for (const f of data.features) {
            const mid = sectorMidFt(
              (f.properties ?? {}) as Record<string, unknown>,
              s.key,
            );
            if (Number.isFinite(mid)) {
              if (mid < loMid) loMid = mid;
              if (mid > hiMid) hiMid = mid;
            }
          }
        }
        const span = hiMid - loMid;
        const colorFor = (props: Record<string, unknown>): string => {
          if (sectorColorMode === "altitude") {
            const mid = sectorMidFt(props, s.key);
            if (!Number.isFinite(mid)) return s.color; // no coded band
            const f = span > 1 ? (mid - loMid) / span : 0.5;
            return altBandColor(f);
          }
          if (sectorColorMode === "sector") {
            const name = String(props.name ?? props.ident ?? "").trim();
            return name ? sectorHashColor(name) : s.color;
          }
          return s.color; // "zone" → the zone's legend colour
        };
        return (
          <GeoJSON
            // Include the colour mode in the key so a mode switch restyles.
            key={`sector-${s.key}-${sectorColorMode}-${data.features.length}`}
            data={data}
            style={(feature) => {
              const c = colorFor(
                (feature?.properties ?? {}) as Record<string, unknown>,
              );
              return {
                color: c,
                weight: 1,
                opacity: 0.85,
                fillColor: c,
                fillOpacity: sectorColorMode === "altitude" ? 0.22 : 0.1,
                dashArray: "8 4",
              };
            }}
            onEachFeature={(f, layer) => {
              const p = (f.properties ?? {}) as Record<string, unknown>;
              // P/R/D areas carry type + designator separately ("R" + "13").
              const ident =
                s.key === "pdr" ? `${p.type ?? ""}${p.designator ?? ""}`.trim() : "";
              const name = [ident, p.name ?? p.ident].filter(Boolean).join(" ") || s.label;
              const band =
                p.lower != null && p.upper != null ? `<br/>${p.lower} – ${p.upper}` : "";
              layer.bindPopup(`<strong>${name}</strong> · ${s.label}${band}`);
            }}
          />
        );
      }).filter(Boolean),
    [sectors, sectorColorMode],
  );

  // SID/STAR procedure tracks. Filtered by the Layer Options airport +
  // procedure selections and styled by its opacity / line-thickness sliders.
  // Hover shows the name; clicking bubbles a selection up so the parent can
  // fetch the coded legs + constraints from the API. The data key includes
  // the filter/style so react-leaflet rebuilds the layer when they change.
  const sidLayer = useMemo(
    () => buildProcedureLayer(sidLines, sid, "SID", SID_COLOR, onProcedureClick),
    [sidLines, sid, onProcedureClick],
  );
  const starLayer = useMemo(
    () =>
      buildProcedureLayer(starLines, star, "STAR", STAR_COLOR, onProcedureClick),
    [starLines, star, onProcedureClick],
  );

  // SID/STAR fixes (the coded waypoints) as small dots with ident tooltips.
  const sidWptLayer = useMemo(
    () => buildWaypointLayer(sidWpts, sid, SID_COLOR),
    [sidWpts, sid],
  );
  const starWptLayer = useMemo(
    () => buildWaypointLayer(starWpts, star, STAR_COLOR),
    [starWpts, star],
  );

  // PBN / ILS reuse the same procedure-layer machinery as SID/STAR. No
  // click-to-fetch — the procedures API resolves SID/STAR only.
  const pbnLayer = useMemo(
    () => buildProcedureLayer(pbnLines, pbn, "PBN", PBN_COLOR),
    [pbnLines, pbn],
  );
  const ilsLayer = useMemo(
    () => buildProcedureLayer(ilsLines, ils, "ILS", ILS_COLOR),
    [ilsLines, ils],
  );
  const pbnWptLayer = useMemo(
    () => buildWaypointLayer(pbnWpts, pbn, PBN_COLOR),
    [pbnWpts, pbn],
  );
  const ilsWptLayer = useMemo(
    () => buildWaypointLayer(ilsWpts, ils, ILS_COLOR),
    [ilsWpts, ils],
  );

  // Live map zoom (updated by ZoomWatcher) — gates only label when zoomed in.
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);

  // Gates — small orange dots, ALWAYS drawn (with a hover tooltip naming the
  // airport + gate) so the stands read as dots even when zoomed out. Once
  // zoomed in to an airport (>= GATE_ZOOM) every gate additionally gets a
  // PERMANENT label with its identifier, so the whole stand layout is readable
  // at a glance for any airport that has gate data (all in gateway.geojson).
  const gateLayer = useMemo(() => {
    if (!gates) return null;
    const labelled = zoom >= GATE_ZOOM;
    return gates.features
      .map((f, i) => {
        const p = f.properties;
        const lat = p.gate_latitude;
        const lon = p.gate_longitude;
        if (lat == null || lon == null) return null;
        const gid = p.gate_identifier ?? "";
        return (
          <Fragment key={`gate-${p.airport_identifier}-${gid}-${i}`}>
            <CircleMarker
              center={[lat, lon]}
              radius={2}
              pathOptions={{
                color: GATE_COLOR,
                weight: 1,
                fillColor: GATE_COLOR,
                fillOpacity: 0.8,
              }}
            >
              <Tooltip direction="top" offset={[0, -3]} sticky>
                {p.airport_identifier} - Gate {gid}
              </Tooltip>
            </CircleMarker>
            {labelled && (
              <Marker
                position={[lat, lon]}
                icon={gateBadge(gid)}
                interactive={false}
              />
            )}
          </Fragment>
        );
      })
      .filter(Boolean);
  }, [gates, zoom]);

  // Holding patterns — the racetrack outline of every coded hold, drawn to
  // scale from its inbound course, turn direction and leg time. Filtered by the
  // Holding tab's four category checkboxes plus the airport / fix dropdowns;
  // the fix ident only labels once zoomed in (there are ~240 across the FIR).
  const holdingLayer = useMemo(() => {
    if (!holdings || !holding?.patterns) return null;
    const labelled = holding.labels && zoom >= HOLDING_LABEL_ZOOM;
    return holdings
      .filter(
        (h) =>
          holding.categories.has(h.category) &&
          (holding.airports.size === 0 || holding.airports.has(h.region)) &&
          (holding.holdings.size === 0 || holding.holdings.has(h.ident)),
      )
      .map((h, i) => {
        const color = HOLDING_COLORS[h.category];
        const leg =
          h.legLengthNm != null
            ? `${h.legLengthNm} NM leg`
            : `${h.legTimeMin ?? 1} min leg`;
        const alt =
          h.minAltFt != null && h.maxAltFt != null
            ? `${h.minAltFt}–${h.maxAltFt} ft`
            : h.minAltFt != null
              ? `≥${h.minAltFt} ft`
              : h.maxAltFt != null
                ? `≤${h.maxAltFt} ft`
                : null;
        return (
          <Fragment key={`hold-${h.ident}-${h.category}-${i}`}>
            <Polyline
              positions={holdingRacetrack(h)}
              pathOptions={{
                color,
                weight: holding.thickness,
                opacity: holding.opacity,
                fillColor: color,
                fillOpacity: 0.06,
              }}
            >
              <Tooltip direction="top" sticky className="holding-tip">
                <span className="holding-tip-id">{h.ident}</span>
                <span className={`holding-tip-cat ${h.category}`}>
                  {HOLDING_CATEGORY_LABEL[h.category]}
                </span>
                <span className="holding-tip-sub">
                  {h.region}
                  {h.procedure ? ` · ${h.procedure}` : ""}
                </span>
                <span className="holding-tip-sub">
                  INB {Math.round(h.inboundCourseDeg)}° ·{" "}
                  {h.turn === "R" ? "right" : "left"} turns · {leg}
                  {h.speedKt != null ? ` · ${h.speedKt} kt` : ""}
                </span>
                {alt && <span className="holding-tip-sub">{alt}</span>}
              </Tooltip>
            </Polyline>
            <CircleMarker
              center={[h.lat, h.lon]}
              radius={2.5}
              interactive={false}
              pathOptions={{
                color,
                weight: 1,
                fillColor: color,
                fillOpacity: 0.9,
                opacity: holding.opacity,
              }}
            >
              {labelled && (
                <Tooltip
                  permanent
                  direction="right"
                  offset={[6, 0]}
                  className="holding-label"
                >
                  {h.ident}
                </Tooltip>
              )}
            </CircleMarker>
          </Fragment>
        );
      });
  }, [holdings, holding, zoom]);

  // A dedicated SVG renderer for the CD&R route overlays (previewed fix +
  // applied auto-resolve route). The map uses `preferCanvas`, so by default
  // Polylines have no SVG element for CSS to target (no glow/blink). Giving just
  // these layers an SVG renderer restores CSS animation on them while leaving
  // all other traffic on the fast canvas.
  const cdrRouteRenderer = useMemo(() => L.svg({ padding: 0.5 }), []);

  // Highlighted procedure (from the lookup form / map click): a bright
  // yellow glow path through its fixes, with permanent ident labels.
  const highlightLayer = useMemo(() => {
    const wps = highlightProc?.waypoints ?? [];
    if (wps.length < 1) return null;
    const line: L.LatLngExpression[] = wps.map((w) => [w.lat, w.lon]);
    return (
      <Fragment key={`hl-${highlightProc?.name}`}>
        {line.length >= 2 && (
          <>
            <Polyline
              positions={line}
              interactive={false}
              pathOptions={{
                color: "#fde047",
                weight: 9,
                opacity: 0.3,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
            <Polyline
              positions={line}
              interactive={false}
              pathOptions={{
                color: "#fde047",
                weight: 3,
                opacity: 0.95,
                lineCap: "round",
                lineJoin: "round",
              }}
            />
          </>
        )}
        {wps.map((w, i) => (
          <CircleMarker
            key={`hl-${w.ident}-${i}`}
            center={[w.lat, w.lon]}
            radius={4}
            pathOptions={{
              color: "#0f172a",
              weight: 1.5,
              fillColor: "#fde047",
              fillOpacity: 1,
            }}
          >
            <Tooltip
              permanent
              direction="top"
              offset={[0, -4]}
              className="hl-tip"
            >
              {w.ident}
            </Tooltip>
          </CircleMarker>
        ))}
      </Fragment>
    );
  }, [highlightProc]);

  // Runways — drawn as real strips: a width-scaled rectangle spanning each
  // runway's two thresholds (paired by reciprocal ident), not just threshold
  // dots. The rectangle uses the published runway width so it reads like the
  // grey strips on the basemap and scales with zoom.
  const runwayLayer = useMemo(() => {
    if (!runways) return null;
    const NM_PER_FT = 1 / 6076.12;
    const labelled = Boolean(runwayLabels) && zoom >= RUNWAY_LABEL_ZOOM;
    const byKey = new Map(runways.map((r) => [`${r.airport}|${r.ident}`, r]));
    const drawn = new Set<string>();
    const out: ReactNode[] = [];
    for (const r of runways) {
      const rec = reciprocalRwy(r.ident);
      const pairKey = `${r.airport}|${[r.ident, rec].sort().join("-")}`;
      if (drawn.has(pairKey)) continue;
      drawn.add(pairKey);
      const brg = Number.isFinite(r.bearing) ? r.bearing : 0;
      const a: [number, number] = [r.lat, r.lon];
      // The far end is the reciprocal threshold when we have it, else a point
      // one runway length ahead along the bearing.
      const other = byKey.get(`${r.airport}|${rec}`);
      const b: [number, number] = other
        ? [other.lat, other.lon]
        : destPoint(r.lat, r.lon, brg, (r.lengthFt || 8000) * NM_PER_FT);
      const halfW = ((r.widthFt || 150) / 2) * NM_PER_FT;
      const corners: [number, number][] = [
        destPoint(a[0], a[1], brg + 90, halfW),
        destPoint(a[0], a[1], brg - 90, halfW),
        destPoint(b[0], b[1], brg - 90, halfW),
        destPoint(b[0], b[1], brg + 90, halfW),
      ];
      out.push(
        <Polygon
          key={`rwy-${pairKey}`}
          positions={corners}
          interactive={false}
          pathOptions={{
            color: RUNWAY_COLOR,
            weight: 0.5,
            fillColor: RUNWAY_COLOR,
            fillOpacity: 0.6,
          }}
        />,
      );
      if (labelled) {
        // One badge per threshold: this end's ident + threshold elevation,
        // and the far end's when the reciprocal threshold is actually coded
        // (a strip built from length alone has no second published ident).
        out.push(
          <Marker
            key={`rwy-lbl-${r.airport}-${r.ident}`}
            position={a}
            icon={runwayBadge(rwyThrLabel(r))}
            interactive={false}
          />,
        );
        if (other)
          out.push(
            <Marker
              key={`rwy-lbl-${other.airport}-${other.ident}`}
              position={b}
              icon={runwayBadge(rwyThrLabel(other))}
              interactive={false}
            />,
          );
      }
    }
    return out;
  }, [runways, runwayLabels, zoom]);

  // Airport markers — shown per-airport from the Layer Options list
  // (checked = visible). Hidden aerodromes are dropped.
  const airportLayer = useMemo(() => {
    if (!airports) return null;
    return airports
      .filter((a) => !hiddenAirports?.has(a.code))
      .map((a) => (
        <Marker
          key={`ap-${a.code}`}
          position={[a.lat, a.lon]}
          icon={airportIcon()}
        >
          <Tooltip
            direction="top"
            offset={[0, -34]}
            className="airport-tip"
          >
            <span className="airport-tip-name">{a.name}</span>
            <span className="airport-tip-code">{a.code}</span>
          </Tooltip>
        </Marker>
      ));
  }, [airports, hiddenAirports]);

  const waypointLayer = useMemo(
    () =>
      waypoints?.map((w) => (
        <HoverFix
          key={`wp-${w.ident}`}
          center={[w.lat, w.lon]}
          radius={2.5}
          hitRadius={13}
          pathOptions={{
            color: "#f59e0b",
            weight: 1,
            fillColor: "#f59e0b",
            fillOpacity: 0.5,
          }}
        >
          <Tooltip direction="top" offset={[0, -6]} sticky>
            {w.ident}
          </Tooltip>
        </HoverFix>
      )),
    [waypoints],
  );

  // Live preview of the routes the user is composing (typed Item-15,
  // RouteBuilder picks, plus any queued routes). One distinctly-coloured
  // dashed polyline per route; markers/labels are deduped across routes
  // so shared fixes (Y8 is heavily shared) get a single label, coloured
  // by the first route that contains them.
  const previewLayer = useMemo(() => {
    if (!previewRoutes || previewRoutes.length === 0) return null;

    const polylines = previewRoutes.map((route, idx) => {
      if (route.length < 2) return null;
      const color = PREVIEW_COLORS[idx % PREVIEW_COLORS.length];
      const line: L.LatLngExpression[] = route.map((p) => [p.lat, p.lon]);
      return (
        <Polyline
          key={`prev-line-${idx}`}
          positions={line}
          interactive={false}
          pathOptions={{
            color,
            weight: 2,
            opacity: 0.65,
            dashArray: "6 6",
          }}
        />
      );
    });

    // Dedupe markers by ident (Y8 routes share most fixes); first
    // occurrence wins and the marker takes that route's colour.
    const seen = new Map<string, { p: PreviewPoint; color: string }>();
    previewRoutes.forEach((route, idx) => {
      const color = PREVIEW_COLORS[idx % PREVIEW_COLORS.length];
      for (const p of route) {
        if (!seen.has(p.ident)) seen.set(p.ident, { p, color });
      }
    });
    const markers = Array.from(seen.values()).map(({ p, color }) => (
      <CircleMarker
        key={`prev-mk-${p.ident}`}
        center={[p.lat, p.lon]}
        radius={p.fromUser ? 5 : 3.5}
        pathOptions={{
          color,
          weight: p.fromUser ? 2 : 1,
          fillColor: color,
          fillOpacity: p.fromUser ? 0.45 : 0.25,
          interactive: false,
        }}
      >
        <Tooltip
          permanent
          direction="right"
          offset={[8, 0]}
          className="preview-label"
        >
          {p.ident}
        </Tooltip>
      </CircleMarker>
    ));

    return (
      <Fragment key="route-preview">
        {polylines}
        {markers}
      </Fragment>
    );
  }, [previewRoutes]);


  // Per-route cache of the STATIC layer (line + fixes + endpoint markers), keyed
  // by flight and invalidated only when that flight's points or the shared style
  // change. An applied CD&R fix replaces ONE trajectory but hands down a new
  // array, so without this the whole traffic day was rebuilt — thousands of
  // Leaflet layers torn down and recreated — on every Apply.
  const routeLayerCache = useRef(
    new Map<string, { pts: TrajectoryPoint[]; sig: string; node: ReactNode }>(),
  );

  const trajectoryLayer = useMemo(() => {
    // Colour segments are budgeted ACROSS routes, not per route: at 120 each a
    // 599-flight day is ~72k Leaflet paths, which is what wedged the tab after a
    // big generate. A single route still draws at full resolution.
    const SEG_BUDGET = 12000;
    const maxSeg = Math.max(
      12,
      Math.min(120, Math.floor(SEG_BUDGET / Math.max(1, trajectories.length))),
    );
    // With a tight budget the turn detector has to be coarser too, or a busy
    // route re-adds the samples the stride just dropped.
    const turnDeg = maxSeg >= 120 ? 2 : maxSeg >= 60 ? 4 : 8;
    // Curve smoothing gets a budget of its OWN, counted in points rather than
    // layers: it adds points inside the polylines that already exist, so it
    // costs nothing in the currency `maxSeg` is spending. Budgeting it against
    // `maxSeg` would have been exactly backwards — a single route decimates to
    // ~120 segments, which uses that budget up, so the one case anybody zooms
    // in on would have been the one case left as chords. Nothing at all for a
    // whole traffic day: the shape of one turn is not what is being looked at
    // with 599 tracks on screen.
    const pointBudget =
      trajectories.length <= 20 ? 900 : trajectories.length <= 100 ? 300 : 0;
    const styleSig = [
      showTrails,
      flColorTrails,
      colorBy,
      trailDecaySec,
      trailWeight,
      showProfilePins,
      maxSeg,
      turnDeg,
      pointBudget,
    ].join("|");
    const cache = routeLayerCache.current;
    const next = new Map<
      string,
      { pts: TrajectoryPoint[]; sig: string; node: ReactNode }
    >();
    const layers = trajectories.map((trajectory, ti) => {
      if (trajectory.points.length < 2) return null;
      if (hiddenKeys?.has(trajectory.meta.flightKey)) return null;
      // Top-center aircraft-type filter: skip non-matching flights' lines.
      if (!matchesAcType(typeFilter, trajectory.meta.aircraftType)) return null;
      // `ti` rides in the signature because it picks the route colour and the
      // R-badge number, so a reordered list must redraw.
      const cacheKey = trajectory.meta.flightKey;
      const sig = `${styleSig}|${ti}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.pts === trajectory.points && hit.sig === sig) {
        next.set(cacheKey, hit);
        return hit.node;
      }
      const node = buildRouteLayer(trajectory, ti, maxSeg, turnDeg, pointBudget);
      next.set(cacheKey, { pts: trajectory.points, sig, node });
      return node;
    });
    routeLayerCache.current = next; // drops routes that are gone
    return layers;

    function buildRouteLayer(
      trajectory: TrajectoryResult,
      ti: number,
      MAX_SEG: number,
      TURN_DEG: number,
      POINT_BUDGET: number,
    ): ReactNode {
        const pts = trajectory.points;
        const { route, meta } = trajectory;
        const color = ROUTE_COLORS[ti % ROUTE_COLORS.length];
        const kp = meta.flightKey;
        // "Display by": how the trail line itself is painted. By type it is one
        // flat line in the aircraft type's colour; by altitude it is the FL
        // gradient, or (FL Color Trails off) the flat per-route colour.
        const byType = colorBy === "type";
        const flatColor = byType ? aircraftColor(meta.aircraftType) : color;
        const gradient = !byType && flColorTrails;

        // Decimate the *drawn* line so a long route (points are sampled
        // every 4 s ⇒ ~750 pts for a 50-min leg) doesn't explode into
        // thousands of Leaflet layers. With many routes on screen at once
        // the unbounded version exhausted browser memory ("Aw, Snap! Out
        // of Memory"). Each route gets ~MAX_SEG colour segments out of the
        // shared budget above; short routes keep full resolution. The
        // animation is unaffected — it interpolates the full-resolution
        // `samplesByRoute` table.
        const step = Math.max(1, Math.ceil((pts.length - 1) / MAX_SEG));
        const keep = new Set<number>([0, pts.length - 1]);
        // Decimate the STRAIGHT parts only. A turn is a handful of samples out
        // of hundreds, so dropping 5 in 6 of them the way a flat stride does
        // collapses the whole arc into one chord — a departure that curves off
        // the runway over half a minute gets drawn as a corner. Keep every
        // sample whose track has moved since the last one drawn, and the arcs
        // come out at full resolution while the long straight legs still cost
        // almost nothing. (TURN_DEG loosens as the segment budget tightens.)
        let lastKept = 0;
        for (let i = 1; i < pts.length; i++) {
          const turned =
            Math.abs(
              ((pts[i].track_deg - pts[lastKept].track_deg + 540) % 360) - 180,
            ) >= TURN_DEG;
          if (turned || i - lastKept >= step) {
            keep.add(i);
            lastKept = i;
          }
        }
        // Force-keep the sample nearest every route waypoint (enroute + SID +
        // STAR + PBN approach) so the decimated line passes through the fixes
        // it is meant to. A fly-over fix has a sample exactly on it; a fly-by
        // one is cut by the turn, so the nearest sample is the arc beside it.
        for (const wp of route) {
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < pts.length; i++) {
            const dy = pts[i].lat - wp.lat;
            const dx = pts[i].lon - wp.lon;
            const d = dy * dy + dx * dx;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          keep.add(best);
        }
        const drawIdx: number[] = [...keep].sort((a, b) => a - b);
        // Stroke the kept samples as a CURVE rather than a run of chords. The
        // samples are unchanged and every one of them is still on the line;
        // only the space between them is filled in. See `lib/trailCurve.ts` —
        // it matters most in a standard-rate turn, where 5-second sampling puts
        // 15° between one position and the next.
        const kept = drawIdx.map((i) => pts[i]);
        const sub = subdivisionFor(kept.length, POINT_BUDGET);
        const curve = smoothTrack(kept, sub);
        const line: L.LatLngExpression[] = curve.map((c) => [c.lat, c.lon]);

        // Colour the line by altitude: one Polyline per decimated segment,
        // tinted by the segment's mean altitude. Round line caps overlap at
        // the joints so the colour steps blend instead of stair-stepping —
        // which is why no extra per-segment sub-splitting is needed. Same
        // scale on every route.
        const altSegments: ReactNode[] = [];
        // Only built when the gradient is what gets drawn — a flat line needs
        // none of these layers, and there is one per decimated segment.
        for (let s = 0; gradient && s < drawIdx.length - 1; s++) {
          const a = pts[drawIdx[s]];
          const b = pts[drawIdx[s + 1]];
          const altMid = ((a.altitude_ft ?? 0) + (b.altitude_ft ?? 0)) / 2;
          // This segment's slice of the curve: `smoothTrack` emits exactly
          // `sub` points per input segment after the first, so the layer count
          // is unchanged — each coloured segment is simply curved now.
          altSegments.push(
            <Polyline
              key={`${kp}-alt-${s}`}
              positions={curve
                .slice(s * sub, s * sub + sub + 1)
                .map((c) => [c.lat, c.lon] as L.LatLngExpression)}
              interactive={false}
              pathOptions={{
                color: altitudeColor(altMid),
                weight: trailWeight,
                opacity: 0.95,
                lineCap: "round",
                lineJoin: "round",
              }}
            />,
          );
        }

        return (
          <Fragment key={kp}>
            {/* The FULL route line — drawn when "Show Trails" is on and Trail
                Decay is "No decay" (aircraft + fixes always stay). FL Color
                Trails on = altitude gradient; off = one flat per-route colour.
                A faint dark casing keeps it readable. With a finite decay this
                static line is replaced by the per-frame decaying trail. */}
            {showTrails && trailDecaySec === 0 && (
              <>
                <Polyline
                  positions={line}
                  interactive={false}
                  pathOptions={{
                    color: "#0f172a",
                    weight: trailWeight + 2,
                    opacity: 0.45,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                />
                {gradient ? (
                  altSegments
                ) : (
                  <Polyline
                    positions={line}
                    interactive={false}
                    pathOptions={{
                      color: flatColor,
                      weight: trailWeight,
                      opacity: 0.95,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />
                )}
              </>
            )}

            {/* Every published route fix as a dot (OLVUK … MARNI). The
                ADEP/ADES aerodromes are drawn separately by the endpoint
                markers below, so we no longer drop the first/last fix —
                with AIP routes those are real en-route fixes (e.g. OLVUK,
                MARNI), NOT the airports. */}
            {route.map((w) => (
              <HoverFix
                key={`${kp}-${w.ident}`}
                center={[w.lat, w.lon]}
                radius={4}
                hitRadius={13}
                pathOptions={{
                  color: "#0f172a",
                  weight: 1,
                  fillColor: color,
                  fillOpacity: 1,
                }}
              >
                <Tooltip direction="top" offset={[0, -7]} sticky>
                  {meta.callsign} · {w.ident}
                </Tooltip>
                <Popup>
                  <strong>{w.ident}</strong>
                  <br />
                  {w.lat.toFixed(5)}, {w.lon.toFixed(5)}
                </Popup>
              </HoverFix>
            ))}

            <EndpointMarker
              position={line[0]}
              fill="#22c55e"
              stroke="#052e16"
              ident={meta.adep}
              role="Start"
              detail={`${meta.callsign} · ${meta.eobtIso}`}
            />
            <EndpointMarker
              position={line[line.length - 1]}
              fill="#ef4444"
              stroke="#450a0a"
              ident={meta.ades}
              role="End"
              detail={`${meta.callsign} · ${pts[pts.length - 1].epoch_ts}`}
            />

            {/* Phase 2 vertical-profile pins: small triangles where the
                aircraft reaches cruise (TOC) and starts descent (TOD).
                Omitted on too-short legs where no cruise sample exists. */}
            {showProfilePins && trajectory.profile?.toc && (
              <Marker
                position={[trajectory.profile.toc.lat, trajectory.profile.toc.lon]}
                icon={profileBadge("TOC", "#22d3ee")}
              >
                <Tooltip direction="top" offset={[0, -10]}>
                  TOC · FL
                  {Math.round(trajectory.profile.toc.altitudeFt / 100)}
                </Tooltip>
              </Marker>
            )}
            {showProfilePins && trajectory.profile?.tod && (
              <Marker
                position={[trajectory.profile.tod.lat, trajectory.profile.tod.lon]}
                icon={profileBadge("TOD", "#fbbf24")}
              >
                <Tooltip direction="top" offset={[0, -10]}>
                  TOD · FL
                  {Math.round(trajectory.profile.tod.altitudeFt / 100)}
                </Tooltip>
              </Marker>
            )}
          </Fragment>
        );
    }
  }, [
    trajectories,
    hiddenKeys,
    typeFilter,
    showTrails,
    flColorTrails,
    colorBy,
    trailDecaySec,
    trailWeight,
    showProfilePins,
  ]);

  // Decaying trails are rebuilt every frame, so their cost is shared: count who
  // is actually airborne at this instant and split one segment budget between
  // them. Twenty aircraft keep the full-resolution trail; a whole traffic day
  // gets a coarser one instead of freezing the tab.
  let airborneNow = 0;
  if (playbackIdx === "all") {
    for (let i = 0; i < trajectories.length; i++) {
      const s = samplesByRoute[i];
      if (!s?.length) continue;
      const lt = simT - (routeOffsetSec[i] ?? 0);
      if (lt >= 0 && lt <= s[s.length - 1].t) airborneNow++;
    }
  } else {
    airborneNow = 1;
  }
  const trailSegBudget = Math.max(
    8,
    Math.min(120, Math.floor(2400 / Math.max(1, airborneNow))),
  );
  // Curve smoothing, in points rather than segments — see the note on the
  // static line's `pointBudget`. Zero above a hundred aircraft, which leaves
  // the per-frame cost of a busy day exactly where it was.
  const trailPointBudget =
    airborneNow <= 20 ? 900 : airborneNow <= 100 ? 300 : 0;

  /**
   * The Measure tool's readout: the two picked aircraft AT THE CURRENT CLOCK,
   * so the line and the numbers track them as they fly rather than freezing at
   * whatever the separation was when they were clicked.
   *
   * Horizontal distance and vertical difference both, because that is what
   * "how far apart are they" means in a control room — 6 NM is separation at
   * the same level and nothing at all 4000 ft apart.
   */
  const measured = (() => {
    if (!measureOn || !measurePicks || measurePicks.length < 2) return null;
    const ends = measurePicks.slice(0, 2).map((ti) => {
      const t = trajectories[ti];
      const samples = samplesByRoute[ti];
      if (!t || !samples?.length) return null;
      const off = playbackIdx === "all" ? routeOffsetSec[ti] ?? 0 : 0;
      const ac = aircraftAt(samples, simT - off);
      return ac ? { ac, key: t.meta.flightKey } : null;
    });
    const [a, b] = ends;
    if (!a || !b) return null;
    return {
      a,
      b,
      distNm: greatCircleNm(a.ac, b.ac),
      vertFt: Math.abs((a.ac.altitudeFt ?? 0) - (b.ac.altitudeFt ?? 0)),
    };
  })();

  // Moving-aircraft trails, collected by the aircraft loop below and drawn in
  // their own pane. With `preferCanvas` every path shares ONE canvas, so a
  // trail moving each frame made Leaflet redraw every airway, sector and fix
  // under it — most of a playback frame. A separate pane gets its own canvas
  // (Leaflet creates one renderer per pane); only trails are redrawn now.
  const liveTrails: ReactNode[] = [];

  return (
    <>
      {/*
        Basemap tone filter.

        Esri's canvas is a neutral grey; the target palette is blue-tinted, and
        no CSS filter can tint a grey (hue-rotate does nothing to a colour with
        no saturation). An SVG colour matrix can, because it maps each output
        channel independently.

        Solved so the tile's two fills land exactly on the reference palette:
        water grey 34 -> #0a0e17, land grey 65 -> #161c27. Verified against a
        real z7 tile over mainland Southeast Asia — the two most common colours come out
        (10,14,23) and (22,28,39), the reference's own values. Esri's canvas
        brightens as it zooms in, so at z13 the same map yields (27,34,46):
        the same hue, a little lighter, which is the tile's behaviour and not
        the matrix's.

        Each row reads luminance (0.2126/0.7152/0.0722) and scales it, so a
        tile pixel that is not perfectly neutral still maps sensibly.
      */}
      <svg width="0" height="0" aria-hidden="true" focusable="false"
           style={{ position: "absolute" }}>
        <filter id="basemap-night" colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values="
              0.08230 0.27685 0.02795 0 -0.012397
              0.09601 0.32299 0.03261 0 -0.005313
              0.10973 0.36914 0.03726 0  0.021379
              0       0       0       1  0"
          />
        </filter>
      </svg>
    <MapContainer
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      scrollWheelZoom
      preferCanvas
      // Leaflet's default zoom control sits top-left. We disable it so a
      // custom +/− pair can be rendered next to the Light/Dark toggle
      // (on the global nav bar) — see onMapReady prop below.
      zoomControl={false}
      style={{ height: "100%", width: "100%" }}
    >
      {/* Tiles for streets and satellite. The dark basemap draws none at all
          — see `vectorBase` — so nothing here is fetched while it is shown. */}
      {tiles.url && (
        <TileLayer
          key={basemap}
          attribution={tiles.attribution}
          url={tiles.url}
          className={tiles.className}
          maxNativeZoom={tiles.maxNativeZoom}
        />
      )}
      {/* A tile source may carry a second overlay layer (Esri splits place
          names out of its canvas base). None currently does — the dark map
          wants no labels — but the capability stays on the type. */}
      {tiles.labelUrl && (
        <TileLayer
          key={basemap + "-labels"}
          url={tiles.labelUrl}
          className={tiles.labelClassName}
          maxNativeZoom={tiles.maxNativeZoom}
        />
      )}

      {/* The picked-out P/D/R area, above every sector overlay. */}
      {(highlightAreas ?? []).map((area) =>
        (area.mp as number[][][][]).map((poly, pi) => (
          <Polygon
            key={"pdr-hl-" + area.ident + "-" + pi}
            // Leaflet wants [lat, lon]; GeoJSON stores [lon, lat].
            positions={poly.map((ring) =>
              ring.map((c) => [c[1], c[0]] as [number, number]),
            )}
            pathOptions={{
              color: area.color ?? "#f87171",
              weight: 3,
              opacity: 1,
              fillColor: area.color ?? "#ef4444",
              fillOpacity: 0.28,
              dashArray: area.color ? "8 6" : undefined,
            }}
            // No tooltip: it would need an interactive layer, and a hover
            // handler over a 13 000-vertex ring (VTR62) on the shared canvas
            // costs far more than it is worth. The chip above the map names
            // what is highlighted.
            interactive={false}
          />
        )),
      )}
      {onMapReady && <MapRefBridge onReady={onMapReady} />}
      <ZoomWatcher onZoom={setZoom} />

      {firLayer}
      {sectorLayers}
      {airwayLayer}
      {airwayLabelLayer}
      {airwayPointLayers}
      {airwayVorLayer}
      {sidLayer}
      {starLayer}
      {pbnLayer}
      {ilsLayer}
      {sidWptLayer}
      {starWptLayer}
      {pbnWptLayer}
      {ilsWptLayer}
      {holdingLayer}
      {gateLayer}
      {runwayLayer}
      {airportLayer}
      {waypointLayer}
      {previewLayer}
      {trajectoryLayer}
      {highlightLayer}

      {trajectories.map((t, ti) => {
        // Only the route currently bound to the playback engine gets an
        // animated aircraft icon — the others keep their static
        // polyline + endpoint markers. "all" mode renders every plane.
        if (playbackIdx !== undefined && playbackIdx !== "all" && playbackIdx !== ti) {
          return null;
        }
        // Top-center aircraft-type filter hides the icon too, so a filtered
        // map shows only the searched type (line + plane).
        if (!matchesAcType(typeFilter, t.meta.aircraftType)) return null;
        // The filter panel's eye hides the animated aircraft icon (the route
        // line, controlled by hiddenKeys, is independent).
        if (hiddenAircraft?.has(t.meta.flightKey)) return null;
        // Absolute timeline in "all" mode: shift this route's clock by its
        // departure offset, and show the icon only while it is airborne (after
        // EOBT, before touchdown) so the map isn't littered with parked/landed
        // planes stacked at the airports.
        const routeSamples = samplesByRoute[ti] ?? [];
        const off = playbackIdx === "all" ? routeOffsetSec[ti] ?? 0 : 0;
        const localT = simT - off;
        if (playbackIdx === "all") {
          const dur = routeSamples[routeSamples.length - 1]?.t ?? 0;
          if (localT < 0 || localT > dur) return null;
        }
        const ac = aircraftAt(routeSamples, localT);
        if (!ac) return null;

        // Decaying trail (Full Trails off): the flown path within the decay
        // window [simT − decay, simT], capped + tinted like the static line.
        // Re-rendered every frame here so it follows the aircraft.
        let decayTrail: ReactNode = null;
        if (showTrails && trailDecaySec > 0) {
          const samples = routeSamples;
          const lo = localT - trailDecaySec;
          // Binary-search the window edges instead of filtering the whole
          // table: this runs per airborne aircraft per frame, and scanning
          // every sample of every flight 60×/s is most of a frame budget once
          // a full traffic day is loaded.
          const firstAtOrAfter = (tt: number) => {
            let a = 0;
            let b = samples.length;
            while (a < b) {
              const mid = (a + b) >> 1;
              if (samples[mid].t < tt) a = mid + 1;
              else b = mid;
            }
            return a;
          };
          const i0 = firstAtOrAfter(lo);
          let i1 = firstAtOrAfter(localT);
          while (i1 < samples.length && samples[i1].t <= localT) i1++;
          const trailPts = [
            ...samples.slice(i0, i1),
            { lat: ac.lat, lon: ac.lon, altitudeFt: ac.altitudeFt, t: localT },
          ];
          if (trailPts.length >= 2) {
            // Decimate so a long flown path stays within the per-frame budget.
            // The cap shrinks as more aircraft are airborne — with FL colouring
            // each kept sample is its own Polyline, so a whole traffic day at
            // 120 apiece is thousands of layers rebuilt every single frame.
            const perAcSeg = trailSegBudget;
            const stepT = Math.max(
              1,
              Math.ceil((trailPts.length - 1) / perAcSeg),
            );
            const keep = trailPts.filter(
              (_, i) => i % stepT === 0 || i === trailPts.length - 1,
            );
            // Curve it, with whatever is left of this aircraft's budget after
            // the decimation above — a short trail gets the smoothest line and
            // one already at its cap is left as chords, so the smoothing never
            // costs more than the budget that was there for it.
            const subT = subdivisionFor(keep.length, trailPointBudget);
            const curveT = smoothTrack(keep, subT);
            // Same rule as the static line: by type = one flat line in the
            // type's colour; by altitude = the gradient (or the per-route flat
            // colour when FL Color Trails is off).
            const trailByType = colorBy === "type";
            const trailGradient = !trailByType && flColorTrails;
            const trailColor = trailByType
              ? aircraftColor(t.meta.aircraftType)
              : ROUTE_COLORS[ti % ROUTE_COLORS.length];
            decayTrail = (
              <>
                <Polyline
                  positions={curveT.map((s) => [s.lat, s.lon])}
                  interactive={false}
                  pathOptions={{
                    color: "#0f172a",
                    weight: trailWeight + 2,
                    opacity: 0.4,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                />
                {trailGradient ? (
                  keep.slice(0, -1).map((a, i) => {
                    const b = keep[i + 1];
                    const altMid =
                      ((a.altitudeFt ?? 0) + (b.altitudeFt ?? 0)) / 2;
                    return (
                      <Polyline
                        key={`trail-${t.meta.flightKey}-${i}`}
                        positions={curveT
                          .slice(i * subT, i * subT + subT + 1)
                          .map((c) => [c.lat, c.lon] as L.LatLngExpression)}
                        interactive={false}
                        pathOptions={{
                          color: altitudeColor(altMid),
                          weight: trailWeight,
                          opacity: 0.95,
                          lineCap: "round",
                          lineJoin: "round",
                        }}
                      />
                    );
                  })
                ) : (
                  <Polyline
                    positions={curveT.map((s) => [s.lat, s.lon])}
                    interactive={false}
                    pathOptions={{
                      color: trailColor,
                      weight: trailWeight,
                      opacity: 0.95,
                      lineCap: "round",
                      lineJoin: "round",
                    }}
                  />
                )}
              </>
            );
          }
        }
        // Configurable flight tag — only the fields enabled in the Flight
        // Tags menu, in screenshot order: callsign · FL · IAS · HDG. Updates
        // live as the checkboxes toggle (re-rendered every frame anyway).
        const tf = tagFields ?? {
          callsign: true,
          fl: true,
          ias: true,
          hdg: true,
          airspace: true,
        };
        const tagParts: string[] = [];
        if (tf.callsign) tagParts.push(t.meta.callsign);
        if (tf.fl && ac.altitudeFt != null)
          tagParts.push(`FL${Math.round(ac.altitudeFt / 100)}`);
        if (tf.ias) tagParts.push(`${Math.round(ac.gsKt)}kt`);
        if (tf.hdg) tagParts.push(`${Math.round(ac.track)}°`);
        const tagText = tagParts.join(" ");
        // Second line: the airspace the plane currently occupies (live,
        // altitude-aware — computed by MapApp, keyed by flightKey).
        const airsText = tf.airspace
          ? formatAirspace(airspace?.[t.meta.flightKey], "compact")
          : "";
        if (decayTrail) {
          liveTrails.push(
            <Fragment key={`trail-${t.meta.flightKey}`}>{decayTrail}</Fragment>,
          );
        }
        return (
          <Fragment key={`ac-${t.meta.flightKey}`}>
            {/* Invisible hit target. The visible plane Marker re-creates its
                divIcon every frame (to rotate with heading), which replaces its
                DOM element ~60×/sec — a click (mousedown+mouseup on one element)
                can never complete on it. This CircleMarker only ever moves
                (setLatLng, same element), so click + hover register reliably.
                Click locks the camera; hover shows detail without locking. */}
            <CircleMarker
              center={[ac.lat, ac.lon]}
              radius={12}
              pathOptions={{
                stroke: false,
                fill: true,
                fillOpacity: 0,
                interactive: true,
                className: "aircraft-hit",
              }}
              eventHandlers={{
                click: () => onAircraftClick?.(ti),
                mouseover: () => onAircraftHover?.(ti),
                mouseout: () => onAircraftHover?.(null),
              }}
            />
            <Marker
              position={[ac.lat, ac.lon]}
              interactive={false}
              icon={planeIcon(
                Math.round(ac.track),
                colorBy === "type"
                  ? aircraftColor(t.meta.aircraftType)
                  : altitudeColor(ac.altitudeFt),
                t.meta.flightKey === followKey,
              )}
              zIndexOffset={t.meta.flightKey === followKey ? 1000 : 0}
            >
              {(tagText || airsText) && (
                <Tooltip
                  permanent
                  direction="right"
                  offset={[10, 0]}
                  className="aircraft-tag"
                >
                  {tagText && <div>{tagText}</div>}
                  {airsText && <div className="aircraft-tag-airspace">{airsText}</div>}
                </Tooltip>
              )}
            </Marker>
          </Fragment>
        );
      })}

      {/* Above the static overlays, below the markers; never a click target
          (the trails are non-interactive), so the canvas lets events through
          to the aircraft hit targets and the layers underneath. */}
      <Pane name="aircraft-trails" style={{ zIndex: 410, pointerEvents: "none" }}>
        {liveTrails}
      </Pane>

      {/* CD&R resolution preview — the modified (uncommitted) path, dashed with
          a pulsing cyan glow (cyan = proposed, green = already applied). Same
          SVG-renderer trick as the applied route below, since the canvas
          renderer can't run the CSS keyframes. */}
      {cdrPreview && cdrPreview.length >= 2 && (
        <>
          <Polyline
            positions={cdrPreview.map((p) => [p.lat, p.lon])}
            interactive={false}
            pathOptions={{
              renderer: cdrRouteRenderer,
              color: "#38bdf8",
              weight: 8,
              opacity: 0.4,
              lineCap: "round",
              className: "cdr-preview-route-glow",
            }}
          />
          <Polyline
            positions={cdrPreview.map((p) => [p.lat, p.lon])}
            interactive={false}
            pathOptions={{
              renderer: cdrRouteRenderer,
              color: "#f8fafc",
              weight: 2.5,
              opacity: 0.95,
              dashArray: "7 6",
              lineCap: "round",
              className: "cdr-preview-route-dash",
            }}
          />
        </>
      )}

      {/* The pre-fix path of the same flight — faint, thin dashes, drawn FIRST
          so the new route sits on top of it. Hovering names it. */}
      {cdrOriginalRoute && cdrOriginalRoute.length >= 2 && (
        <Polyline
          positions={cdrOriginalRoute.map((p) => [p.lat, p.lon])}
          pathOptions={{
            renderer: cdrRouteRenderer,
            color: "#94a3b8",
            weight: 2,
            opacity: 0.5,
            dashArray: "3 8",
            lineCap: "round",
          }}
        >
          {cdrOriginalLabel && (
            <Tooltip sticky className="cdr-route-tip was">
              {cdrOriginalLabel}
            </Tooltip>
          )}
        </Polyline>
      )}

      {/* An applied auto-resolve route opened for inspection: the post-fix path,
          dashed with a pulsing green glow. The map runs in CANVAS mode
          (preferCanvas) where CSS classes/animations don't apply, so these two
          layers force an SVG renderer of their own — that's what lets the
          `cdr-resolved-route-*` keyframes (globals.css) actually blink/glow. */}
      {cdrResolvedRoute && cdrResolvedRoute.length >= 2 && (
        <>
          {/* The wide glow halo doubles as the hover target for the tooltip —
              the 3 px dashed line on its own is too thin to hit reliably. */}
          <Polyline
            positions={cdrResolvedRoute.map((p) => [p.lat, p.lon])}
            pathOptions={{
              renderer: cdrRouteRenderer,
              color: "#22c55e",
              weight: 8,
              opacity: 0.4,
              lineCap: "round",
              className: "cdr-resolved-route-glow",
            }}
          >
            {cdrResolvedLabel && (
              <Tooltip sticky className="cdr-route-tip now">
                {cdrResolvedLabel}
              </Tooltip>
            )}
          </Polyline>
          <Polyline
            positions={cdrResolvedRoute.map((p) => [p.lat, p.lon])}
            interactive={false}
            pathOptions={{
              renderer: cdrRouteRenderer,
              color: "#86efac",
              weight: 3,
              opacity: 1,
              dashArray: "7 6",
              lineCap: "round",
              className: "cdr-resolved-route-dash",
            }}
          />
        </>
      )}

      {/* CD&R overlay — predicted tracks + CPA for the selected conflict, faint
          CPA ticks for the rest. Rendered last so it sits above the traffic. */}
      {cdrConflicts && cdrTraffic && (
        <ConflictLayer
          conflicts={cdrConflicts}
          traffic={cdrTraffic}
          selectedId={cdrSelectedId ?? null}
          nameOf={cdrNameOf ?? ((id) => id)}
        />
      )}

      {/* Measure tool — the span between the two picked aircraft. Drawn last so
          it reads over the traffic it is measuring. */}
      {measured && (
        <>
          <Polyline
            positions={[
              [measured.a.ac.lat, measured.a.ac.lon],
              [measured.b.ac.lat, measured.b.ac.lon],
            ]}
            interactive={false}
            pathOptions={{
              color: "#22d3ee",
              weight: 1.5,
              opacity: 0.95,
              dashArray: "6 5",
            }}
          />
          {[measured.a, measured.b].map((end) => (
            <CircleMarker
              key={`measure-end-${end.key}`}
              center={[end.ac.lat, end.ac.lon]}
              radius={5}
              interactive={false}
              pathOptions={{
                color: "#22d3ee",
                weight: 1.5,
                fillColor: "#22d3ee",
                fillOpacity: 0.25,
              }}
            />
          ))}
          <Marker
            position={[
              (measured.a.ac.lat + measured.b.ac.lat) / 2,
              (measured.a.ac.lon + measured.b.ac.lon) / 2,
            ]}
            interactive={false}
            icon={L.divIcon({
              className: "measure-label",
              iconSize: [0, 0],
              html: `<span class="measure-pill">${measured.distNm.toFixed(
                1,
              )} NM · ${Math.round(measured.vertFt).toLocaleString()} ft</span>`,
            })}
          />
        </>
      )}

      <FitBounds airways={airways} trajectories={trajectories} />
    </MapContainer>
    </>
  );
}
