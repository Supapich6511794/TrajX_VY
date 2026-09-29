"use client";

/**
 * MapApp — interactive shell.
 *
 * Orchestrates: airway load, the Phase 1 generator panel, UI theme,
 * basemap, lazy FIR layer, the aircraft-animation playback, and the
 * responsive sidebar drawer. Leaflet is mounted via
 * `next/dynamic({ ssr:false })` (App Router requirement).
 */

import type L from "leaflet";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AircraftTypeLegend from "@/components/AircraftTypeLegend";
import AltitudeLegend from "@/components/AltitudeLegend";
import DownloadModal, {
  type DownloadInfo,
  type ReportKind,
} from "@/components/DownloadModal";
import FilterPanel, {
  EMPTY_FILTER,
  type FlightFilter,
} from "@/components/FilterPanel";
import { type TagFields } from "@/components/FlightTagsMenu";
import { DEFAULT_TRAIL_OPTS, type TrailOpts } from "@/components/TrailsMenu";
import GeneratorPanel from "@/components/GeneratorPanel";
import MainNavigation, {
  type MainNavSlot,
} from "@/components/nav/MainNavigation";
import NavIcon from "@/components/nav/NavIcon";
import BasemapMenu from "@/components/nav/menus/BasemapMenu";
import ConflictsMenu from "@/components/nav/menus/ConflictsMenu";
import PlanCheckMenu from "@/components/nav/menus/PlanCheckMenu";
import SectorMenu from "@/components/nav/menus/SectorMenu";
import LayersMenu from "@/components/nav/menus/LayersMenu";
import ToolMenu from "@/components/nav/menus/ToolMenu";
import TrajectoryMenu from "@/components/nav/menus/TrajectoryMenu";
import { AirspaceBody } from "@/components/AirspaceMenu";
import type {
  AutoModeOption,
  AutoResolveMode,
  CdrView,
  MainNavId,
  NavView,
} from "@/components/nav/types";
import RouteResultTabs from "@/components/RouteResultTabs";
import SimControls from "@/components/SimControls";
import {
  flightOptions,
  matchesFlight,
  matchesRoute,
  routeOptions,
} from "@/lib/flightSearch";
import SearchCombo from "@/components/SearchCombo";
import {
  deriveWaypoints,
  fetchAirways,
  fetchAirwayReporting,
  fetchAirwayVor,
  fetchFir,
  fetchSector,
  fetchSidLines,
  fetchSidWaypoints,
  fetchStarLines,
  fetchStarWaypoints,
  SECTORS,
  type AirwayPointCollection,
  type SectorCollection,
  type SectorKey,
} from "@/lib/geojson";
import {
  extendDownwind,
  fetchProcedure,
  recacheTrajectory,
  setConflictMarks,
  type ProcedureDto,
} from "@/lib/api";
import {
  fetchGates,
  fetchIlsLines,
  fetchIlsWaypoints,
  fetchPanelAirports,
  fetchPbnLines,
  fetchPbnWaypoints,
  fetchRunways,
  type GateCollection,
  type PanelAirport,
  type RunwayPoint,
} from "@/lib/atcLayers";
import type { ProcedureSelection } from "@/components/LeafletMap";
import LayerOptions, {
  DEFAULT_HOLDING_LAYER,
  DEFAULT_PROC_LAYER,
  type AirwayExtra,
  type HoldingLayerState,
  type LayerTabKey,
  type ProcLayerState,
} from "@/components/LayerOptions";
import { fetchRouteBuilderIdents } from "@/lib/routeCsv";
import type { Basemap, Theme } from "@/lib/mapPrefs";
import type { PreviewPoint } from "@/lib/routePreview";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";
import type {
  AirwayCollection,
  FirCollection,
  ProcedureLineCollection,
  ProcedureWaypointCollection,
  Waypoint,
} from "@/lib/types";
import {
  aircraftAt,
  toSamples,
  totalSeconds,
  useSimPlayback,
} from "@/lib/useSimPlayback";
import {
  departureOffsets,
  localClock,
  statusFromLocalT,
} from "@/lib/flightStatus";
import {
  airspaceAt,
  buildAirspaceIndex,
  buildAirspaceSegments,
  formatAirspace,
  hasAirspace,
  type AirspaceIndex,
  type AirspaceMembership,
  type AirspaceSegment,
} from "@/lib/airspace";
import { yieldToMain } from "@/lib/yieldToMain";
import {
  fetchHoldingPatterns,
  fetchHoldings,
  type Holding,
  type HoldingPattern,
} from "@/lib/holdings";
import { applyArrivalHold, applySpeedReduction } from "@/lib/cdr/arrivalApply";
import { conflictSector, type ConflictSector, type SectorPoint } from "@/lib/cdr/sector";
import type { ArrivalFix } from "@/lib/cdr/arrivalFix";
import { useArrivals } from "@/lib/cdr/useArrivals";
import { useCdr } from "@/lib/cdr/useCdr";
import {
  DEFAULT_CDR_CONFIG,
  REDUCED_TERMINAL_SEP_TMAS,
  horizontalMinimumNm,
  type CdrConfig,
  type DeepPartial,
} from "@/lib/cdr/config";
import { useToasts } from "@/lib/cdr/useToasts";
import { playAlert } from "@/lib/cdr/sound";
import { conflictHeadline, fmtFromValue } from "@/lib/cdr/format";
import type { CdrEvent } from "@/lib/cdr/lifecycle";
import { applyManeuver, maneuverTiming } from "@/lib/cdr/kinematics";
import type { AppliedFix, Maneuver } from "@/lib/cdr/types";
import {
  pairSeparation,
  rescanFlightPlanConflicts,
  scanFlightPlanConflicts,
  type PlanConflict,
  type PlanFlight,
} from "@/lib/cdr/planScan";
import { buildLosMarks } from "@/lib/cdr/losMarks";
import {
  conflictLogCounts,
  updateConflictLog,
  type ConflictLogEntry,
} from "@/lib/cdr/conflictLog";
import type { DepartureConflict } from "@/lib/departureSeparation";
import { restrictedAreasFrom } from "@/lib/cdr/constraints";
import {
  type Blocker,
  generatePlanResolutions,
  planResolutions,
  type PlanAdvisoryResult,
  type PlanResolution,
} from "@/lib/cdr/planAdvisory";
import ToastStack from "@/components/cdr/ToastStack";
import ArrivalPanel from "@/components/cdr/ArrivalPanel";
import ConflictPanel from "@/components/cdr/ConflictPanel";
import ConflictLogPanel from "@/components/cdr/ConflictLogPanel";
import DepartureConflictPanel from "@/components/cdr/DepartureConflictPanel";
import NotificationPanel from "@/components/cdr/NotificationPanel";
import SuggestionCards from "@/components/cdr/SuggestionCards";
import PdrPanel from "@/components/pdr/PdrPanel";
import DynamicSectorPanel from "@/components/report/DynamicSectorPanel";
import SectorInfoPanel from "@/components/report/SectorInfoPanel";
import {
  pathFromTrajectory,
  usePdrCheck,
  type PdrFlight,
} from "@/lib/pdr/usePdrCheck";
import type { PdrReport } from "@/lib/pdr/detect";
import type { PdrArea } from "@/lib/pdr/types";
import { activityAt } from "@/lib/pdr/schedule";
import { saveBinaryFile, saveTextFile } from "@/lib/saveFile";
import {
  buildFlightEvents,
  buildSectorHours,
  flightEventsCsv,
  sectorHoursCsv,
  type FlightEventRow,
  type ReportConflict,
  type ReportFlight,
  type SectorHourRow,
} from "@/lib/report/flightEvents";
import {
  effectiveConfig,
  effectiveEvents,
  positionAt,
  positionsInForce,
  type EffectiveConfig,
} from "@/lib/report/effectiveSectors";
import {
  applyPlan,
  DEFAULT_DYNAMIC_CONFIG,
  dynamicSectorsCsv,
  dynamicSpansCsv,
  planDynamicSectors,
  type DynamicPlan,
  type DynamicSectorConfig,
} from "@/lib/report/dynamicSectors";
import {
  buildSectorAdjacency,
  sectorShapes,
  type SectorAdjacency,
} from "@/lib/report/sectorAdjacency";
import type { AreaTransfer, Rings } from "@/lib/report/dynamicArea";
import {
  CONFLICT_BY_SECTOR_CHART,
  STANDARD_VS_MERGED_CHART,
  conflictBySectorRows,
  conflictBySectorXlsx,
  flightTrajectoryChart,
  flightTrajectoryRows,
  flightTrajectoryXlsx,
  standardVsMergedRows,
  standardVsMergedXlsx,
  trajectoryChartCallsigns,
} from "@/lib/report/chartData";
import { XLSX_MIME } from "@/lib/report/xlsx";
import {
  HELLO_GIVE_UP_MS,
  REPORT_CHANNEL,
  isHello,
  newNonce,
  reportUrl,
  type ReportPayload,
} from "@/lib/report/viewPayload";

const LeafletMap = dynamic(() => import("@/components/LeafletMap"), {
  ssr: false,
  loading: () => <div className="status">Loading map…</div>,
});

// The CD&R before/after preview modal embeds its own react-leaflet map, so it
// must stay client-only (no SSR).
const PreviewModal = dynamic(() => import("@/components/cdr/PreviewModal"), {
  ssr: false,
});

/** Format an altitude constraint DTO as a compact label (e.g. "≤18000ft"). */
function fmtAlt(c: { type: string; alt1_ft?: number | null; alt2_ft?: number | null }): string {
  const a1 = c.alt1_ft ?? null;
  const a2 = c.alt2_ft ?? null;
  switch (c.type) {
    case "AT":
      return a1 != null ? `${a1}ft` : "";
    case "AT_OR_ABOVE":
      return a1 != null ? `≥${a1}ft` : "";
    case "AT_OR_BELOW":
      return a1 != null ? `≤${a1}ft` : "";
    case "BETWEEN":
      return `${a2 ?? "?"}–${a1 ?? "?"}ft`;
    default:
      return "";
  }
}

/** Format a speed constraint DTO as a compact label (e.g. "≤250kt"). */
function fmtSpd(c: { type: string; speed_kt?: number | null }): string {
  const s = c.speed_kt ?? null;
  if (s == null) return "";
  switch (c.type) {
    case "AT":
      return `${s}kt`;
    case "AT_OR_ABOVE":
      return `≥${s}kt`;
    case "AT_OR_BELOW":
      return `≤${s}kt`;
    default:
      return "";
  }
}

/** The auto-resolve choices offered in the Conflicts menu, in display order.
 *  (`AutoResolveMode` itself lives with the other navigation types, so the menu
 *  can name it without importing this shell.) */
const AUTO_MODE_OPTIONS: AutoModeOption[] = [
  {
    mode: "off",
    label: "Off",
    hint: "Resolve conflicts by hand from the notifications or the dashboard",
  },
  {
    mode: "before",
    label: "Before replay",
    hint: "Deconflict the whole filed plan up front (clock parked at the start), then replay the result",
  },
  {
    mode: "during",
    label: "While replaying",
    hint: "Apply the top validated fix to each conflict as the replay approaches it",
  },
];

/** Progress of the up-front ("before replay") auto-resolve pass. */
interface AutoPassState {
  /** Conflicts the resolver cleared. */
  fixed: number;
  /** Conflicts it looked at but found no validated fix for. */
  unfixed: number;
  /** False while the pass is still stepping through the queue. */
  done: boolean;
}

/** Above this many loaded flights the "Show area" move stops animating.
 *  Leaflet's canvas renderer redraws every vector layer on each frame of a pan,
 *  and each flight is one; a 2000-flight day turned the animation into a
 *  multi-second freeze. Below it the fly-to is smooth and worth having. */
const ANIMATED_PAN_MAX_FLIGHTS = 150;

/** How long a run-report build works before it hands the browser a turn, in ms.
 *  Roughly two frames: a visible console keeps painting its progress, and a
 *  hidden one (the report tab is in front of it) loses almost nothing, because
 *  the yield is `yieldToMain`, not a timer. */
const REPORT_SLICE_MS = 30;

/** Least gap between two progress updates, in ms. Every update re-renders the
 *  whole console, and a slice is far shorter than a render is worth paying for. */
const REPORT_PROGRESS_MS = 150;

/** The airspace layers a report walks flights against. PDR is not one: an
 *  aircraft is "in" an ATS unit, and a restricted area is not one. */
const REPORT_LAYERS: SectorKey[] = ["ctr", "tma", "cta", "fir"];

/** Is a cached walk still the walk of THESE flights against THESE polygons? */
function isSameWalk(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A generated trajectory, in the shape the report's event builder reads. */
function toReportFlight(t: TrajectoryResult): ReportFlight {
  return {
    flightKey: t.meta.flightKey,
    callsign: t.meta.callsign,
    actype: t.meta.aircraftType,
    adep: t.meta.adep,
    ades: t.meta.ades,
    points: t.points,
    route: t.route,
    toc: t.profile?.toc
      ? {
          lat: t.profile.toc.lat,
          lon: t.profile.toc.lon,
          altitudeFt: t.profile.toc.altitudeFt,
          epochTs: t.profile.toc.epochTs,
        }
      : null,
    tod: t.profile?.tod
      ? {
          lat: t.profile.tod.lat,
          lon: t.profile.tod.lon,
          altitudeFt: t.profile.tod.altitudeFt,
          epochTs: t.profile.tod.epochTs,
        }
      : null,
  };
}

/**
 * The airspace index a report is walked against.
 *
 * The sector polygons are loaded lazily, the first time the user toggles that
 * map layer on — and they all start off. Reading `sectorData` alone meant the
 * report usually had NO sector rows at all: no crossing times, and an empty
 * sector-hours file, which reads as "this flight crossed no sectors" rather
 * than "nobody switched the layer on". So a report owns its own load;
 * `fetchSector` is memoised per file, so a layer already on costs nothing.
 */
async function loadReportAirspace(
  sectorData: Partial<Record<SectorKey, SectorCollection>>,
): Promise<AirspaceIndex> {
  const collections: Partial<Record<SectorKey, SectorCollection>> = {
    ...sectorData,
  };
  await Promise.all(
    REPORT_LAYERS.filter((k) => !collections[k]).map((k) =>
      fetchSector(k)
        .then((c) => {
          collections[k] = c;
        })
        // A layer that will not load leaves the report thinner rather than
        // failing it: takeoff / waypoints / TOC / TOD still export.
        .catch(() => undefined),
    ),
  );
  return buildAirspaceIndex(collections);
}

export default function MapApp() {
  const [airways, setAirways] = useState<AirwayCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trajectories, setTrajectories] = useState<TrajectoryResult[]>([]);
  /** Download URLs that pair 1-to-1 with `trajectories`. Lifted out of
   *  GeneratorPanel so the global nav bar + DownloadModal can read them
   *  without going through GeneratorPanel. */
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  /** Live (pre-Generate) route previews — one entry per route the user
   *  has typed/picked/queued, each drawn in a distinct colour. */
  const [previewRoutes, setPreviewRoutes] = useState<PreviewPoint[][]>([]);
  /** Just the route currently being typed/built in the Generator (the
   *  "section in progress"), for the "Current" preview scope. */
  const [currentPreview, setCurrentPreview] = useState<PreviewPoint[][]>([]);
  /** Whether the live route preview is hidden on the map. Controlled by a
   *  standalone floating button (not tied to the Generator form), so the
   *  user can toggle the preview on/off at any time. Auto-hidden right
   *  after a Generate (the real trajectory takes over) and auto-shown
   *  again the moment the user edits a route. */
  const [previewHidden, setPreviewHidden] = useState(false);
  /** Which routes the preview draws while composing: every route in flight
   *  ("full") or only the section currently being filled in ("current"). */
  const [previewScope, setPreviewScope] = useState<"full" | "current">("full");
  /**
   * The Flight Preview page: look at the filed routes before generating them.
   *
   * A chrome state rather than a route — the sidebar, the map and the preview
   * layers are the console's own, so there is nothing to duplicate and nothing
   * to restore on the way back. What changes is what surrounds the map: no
   * tabs, a title and a count instead, and the map framed.
   */
  const [previewMode, setPreviewMode] = useState(false);
  // Editing routes (a new preview set arrives) brings the preview back.
  useEffect(() => {
    setPreviewHidden(false);
  }, [previewRoutes]);
  /** "N / M flights ready" status shown beside the generator title. */
  const [genStatus, setGenStatus] = useState<string>("");
  // Two-scope search for the Route Profile "all routes" views: pick a
  // flight (callsign / ADEP-ADES), then optionally a specific route (empty
  // route box = every route of that flight).
  const [profileFlightQuery, setProfileFlightQuery] = useState("");
  const [profileRouteQuery, setProfileRouteQuery] = useState("");

  // Top-level navigation state. `null` = nothing open; the sidebar
  // is hidden entirely so the map fills the viewport on first load.
  /**
   * Which panel the sidebar is showing. Opens on the generator.
   *
   * It used to open on `null` — sidebar hidden, map only, and you clicked
   * Generator to start. With the first-run card that left a centred header
   * with nothing under it, because the panel inside is display:none until nav
   * names it. Opening on the generator is also simply what the app is for
   * with an empty run.
   */
  const [nav, setNav] = useState<NavView>({ kind: "generator" });
  const [generatedOpen, setGeneratedOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  // Route Profile cards are individually collapsible (by flightKey). A key
  // in the set = that card is expanded. Overview defaults to all collapsed;
  // the Vertical/Summary tabs expand the first card. Reset per generation.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((flightKey: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(flightKey)) next.delete(flightKey);
      else next.add(flightKey);
      return next;
    });
  }, []);

  // Playback source: which generated route the SimControls clock is
  // bound to. A number picks one route; "all" plays every route on the
  // longest route's timeline (legacy behaviour). The engine itself
  // stays single-instance — only the source changes.
  const [playbackIdx, setPlaybackIdx] = useState<number | "all">(0);

  // Two ways to surface a flight's live detail card:
  //  • followActive + followIdx — the camera LOCKS onto the aircraft and tracks
  //    it every frame. Triggered ONLY by clicking the plane on the map.
  //  • detailIdx — the detail card shows WITHOUT locking the camera. Triggered
  //    by hovering a plane on the map or clicking a Results row.
  // followActive takes priority for the card target, so a lock survives hovers.
  const [followActive, setFollowActive] = useState(false);
  const [followIdx, setFollowIdx] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);

  // Measure tool (Tool ▸ Measure). While it is armed, clicking planes on the
  // map picks the PAIR whose separation is drawn, rather than locking the
  // camera onto one of them — two indices into `trajectories`, and a third
  // click starts the next measurement.
  const [measureOn, setMeasureOn] = useState(false);
  const [measurePicks, setMeasurePicks] = useState<number[]>([]);
  const toggleMeasure = useCallback(() => {
    setMeasurePicks([]);
    setMeasureOn((on) => !on);
  }, []);
  const clearMeasure = useCallback(() => setMeasurePicks([]), []);
  // The picks are indices into `trajectories`; a regeneration renumbers them,
  // so the pair is dropped rather than left pointing at whoever is there now.
  useEffect(() => {
    setMeasurePicks([]);
  }, [trajectories]);

  // Locking the camera onto a flight (follow + zoom). Used by BOTH a Results-row
  // click and a click on the plane on the map — either way the camera tracks it.
  const lockOnFlight = useCallback((i: number) => {
    setFollowIdx(i);
    setFollowActive(true);
    setDetailIdx(null);
    // In single-route playback, switch the animated aircraft to the picked one
    // (otherwise it wouldn't be moving). In "all" mode every route animates.
    setPlaybackIdx((idx) => (idx === "all" ? "all" : i));
  }, []);
  const selectFlight = lockOnFlight;
  // A click on a plane means one of two things, and the measure tool decides
  // which: normally it locks the camera on; while measuring it names one end
  // of the pair being measured.
  const handleAircraftClick = useCallback(
    (i: number) => {
      if (measureOn) {
        setMeasurePicks((prev) =>
          prev.length >= 2 ? [i] : prev.includes(i) ? prev : [...prev, i],
        );
        return;
      }
      lockOnFlight(i);
    },
    [measureOn, lockOnFlight],
  );

  // Hovering a plane on the map: show its detail card, but leave the camera
  // unlocked. Ignored visually while a lock is active (the lock wins the card).
  const handleAircraftHover = useCallback(
    (i: number | null) => setDetailIdx(i),
    [],
  );

  // Which fields show in each aircraft's map label, toggled by the Flight
  // Tags menu. Off by default — a freshly generated map stays uncluttered;
  // the user opts into labels via the Flight Tags menu.
  const [tagFields, setTagFields] = useState<TagFields>({
    callsign: false,
    fl: false,
    ias: false,
    hdg: false,
    airspace: false,
  });
  // Trail drawing options (the Trails menu).
  const [trailOpts, setTrailOpts] = useState<TrailOpts>(DEFAULT_TRAIL_OPTS);
  // TOC/TOD vertical-profile pins. Off after a fresh generation (just the
  // lines show); the map toolbar's "TOC/TOD" button adds them on demand.
  const [profilePinsOn, setProfilePinsOn] = useState(false);

  // Top-center aircraft-type filter. When non-empty, the map shows only
  // flights whose type matches (case-insensitive substring) — every other
  // route line and aircraft icon is hidden. Empty = show all.
  const [acTypeQuery, setAcTypeQuery] = useState("");
  // Distinct aircraft types currently generated, for the search datalist.
  const aircraftTypes = useMemo(
    () =>
      Array.from(
        new Set(
          trajectories.map((t) => t.meta.aircraftType).filter(Boolean),
        ),
      ).sort(),
    [trajectories],
  );
  // One type per flight (not de-duplicated) — the "Display by → Aircraft type"
  // key counts how many of each are on the map.
  const trajectoryTypes = useMemo(
    () => trajectories.map((t) => t.meta.aircraftType),
    [trajectories],
  );

  // Per-route line visibility, keyed by flightKey (stable across removals,
  // unlike an index). A key in the set = that route is hidden on the map.
  // Lets the user declutter the map mid-simulation without deleting routes.
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const toggleRouteHidden = useCallback((flightKey: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(flightKey)) next.delete(flightKey);
      else next.add(flightKey);
      return next;
    });
  }, []);
  // Master toggle: hide every route line at once (show all if all hidden).
  const toggleAllRoutesHidden = useCallback(() => {
    setHiddenKeys((prev) => {
      const allHidden =
        trajectories.length > 0 &&
        trajectories.every((t) => prev.has(t.meta.flightKey));
      return allHidden
        ? new Set<string>()
        : new Set(trajectories.map((t) => t.meta.flightKey));
    });
  }, [trajectories]);
  const allRoutesHidden =
    trajectories.length > 0 &&
    trajectories.every((t) => hiddenKeys.has(t.meta.flightKey));
  // Visibility helpers for the filter panel (Show All / Hide All / Invert).
  const showAllRoutes = useCallback(() => setHiddenKeys(new Set()), []);
  const hideAllRoutes = useCallback(
    () => setHiddenKeys(new Set(trajectories.map((t) => t.meta.flightKey))),
    [trajectories],
  );
  const invertRoutes = useCallback(() => {
    setHiddenKeys((prev) => {
      const next = new Set<string>();
      for (const t of trajectories)
        if (!prev.has(t.meta.flightKey)) next.add(t.meta.flightKey);
      return next;
    });
  }, [trajectories]);
  const applyHidden = useCallback(
    (hidden: Set<string>) => setHiddenKeys(hidden),
    [],
  );

  // Per-aircraft icon visibility (separate from the route-line hiddenKeys).
  // The filter panel's eye / Show-Hide-Invert / Apply toggle the *animated
  // plane*, not its route line — so you can declutter the moving aircraft
  // while keeping (or dropping) their drawn paths.
  const [hiddenAircraft, setHiddenAircraft] = useState<Set<string>>(new Set());
  const toggleAircraftHidden = useCallback((flightKey: string) => {
    setHiddenAircraft((prev) => {
      const next = new Set(prev);
      if (next.has(flightKey)) next.delete(flightKey);
      else next.add(flightKey);
      return next;
    });
  }, []);
  const showAllAircraft = useCallback(() => setHiddenAircraft(new Set()), []);
  const hideAllAircraft = useCallback(
    () => setHiddenAircraft(new Set(trajectories.map((t) => t.meta.flightKey))),
    [trajectories],
  );
  const invertAircraft = useCallback(() => {
    setHiddenAircraft((prev) => {
      const next = new Set<string>();
      for (const t of trajectories)
        if (!prev.has(t.meta.flightKey)) next.add(t.meta.flightKey);
      return next;
    });
  }, [trajectories]);
  const applyAircraftHidden = useCallback(
    (hidden: Set<string>) => setHiddenAircraft(hidden),
    [],
  );

  // Full filter panel (FlightRadar-style) — open state + filter criteria.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<FlightFilter>(EMPTY_FILTER);
  const patchFilter = useCallback(
    (p: Partial<FlightFilter>) => setFilter((f) => ({ ...f, ...p })),
    [],
  );

  // Leaflet map instance, captured via MapRefBridge inside LeafletMap.
  // Used to drive the custom +/− zoom buttons on the global bar (the
  // built-in Leaflet zoom control is disabled).
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const onMapReady = useCallback(
    (m: L.Map | null) => setMapInstance(m),
    [],
  );
  const handleZoomIn = useCallback(() => mapInstance?.zoomIn(), [mapInstance]);
  const handleZoomOut = useCallback(
    () => mapInstance?.zoomOut(),
    [mapInstance],
  );

  // Stable callbacks for the memoised, animation-independent children
  // (GeneratorPanel / MainNavigation / DownloadModal). Keeping
  // these referentially constant lets React.memo skip those subtrees on
  // every aircraft-animation frame. All state setters are stable, so the
  // dependency lists are empty.
  const handleResult = useCallback(
    (rs: TrajectoryResult[] | null) => {
      const list = rs ?? [];
      setTrajectories(list);
      // Auto-redirect to the "Generated" landing view on a successful
      // generation. Only R1's data is rendered initially; "Show more"
      // reveals the rest one at a time.
      if (list.length > 0) {
        setNav({ kind: "all", section: "both" });
        // Looking is over: the results need the full console (and its tabs),
        // which the preview page deliberately does not have.
        setPreviewMode(false);
        setExpandedKeys(new Set()); // Overview lands with every card collapsed
        setProfileFlightQuery("");
        setProfileRouteQuery("");
        setSidebarOpen(true);
        // Fresh generation: every new route + aircraft starts visible.
        setHiddenKeys(new Set());
        setHiddenAircraft(new Set());
        // Hide the faint live preview now the real trajectory is drawn (it
        // sat under the generated line). The standalone button brings it back.
        setPreviewHidden(true);
        // Start playback on "all routes" so a fresh generation animates every
        // flight together (single-route playback is still one click away in
        // the source picker).
        setPlaybackIdx("all");
        // Any prior camera-follow ends with the new generation.
        setFollowActive(false);
        // Fresh traffic → drop the previous run's CD&R fix history.
        setAppliedFixes([]);
        setSelectedConflictId(null);
      }
    },
    [],
  );
  const handleNavChange = useCallback((n: NavView) => {
    setNav(n);
    if (n !== null) setSidebarOpen(true);
  }, []);
  const openDownload = useCallback(() => setDownloadOpen(true), []);
  const closeDownload = useCallback(() => setDownloadOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  // UI prefs.
  const [theme, setTheme] = useState<Theme>("dark");
  const [basemap, setBasemap] = useState<Basemap>("dark");

  // Flipping the theme carries the CANVAS basemap with it. The two were
  // independent, so switching to light left a black map inside a white console
  // — the worst of both, and the reason light mode read as unfinished. Esri's
  // Light Gray canvas is the same surveyed tile set as the dark one, so this
  // is the same map in the other tone. Streets and Satellite are a decision
  // about the map itself rather than about the console, so they stay put.
  const applyTheme = useCallback((next: Theme) => {
    setTheme(next);
    setBasemap((b) => (b === "dark" || b === "light" ? next : b));
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Reference-layer toggles (shown by default on load).
  const [showAirways, setShowAirways] = useState(false);
  const [showWaypoints, setShowWaypoints] = useState(false);

  // FIR layer (lazy — the file is ~15 MB).
  const [firOn, setFirOn] = useState(false);
  const [fir, setFir] = useState<FirCollection | null>(null);
  const [firLoading, setFirLoading] = useState(false);

  // Airspace sector overlays (CTR / TMA / CTA / FIR / PDR) — each
  // lazily loaded the first time its layer is toggled on.
  const [sectorsOn, setSectorsOn] = useState<Record<SectorKey, boolean>>(
    () =>
      Object.fromEntries(SECTORS.map((s) => [s.key, false])) as Record<
        SectorKey,
        boolean
      >,
  );
  const [sectorData, setSectorData] = useState<
    Partial<Record<SectorKey, SectorCollection>>
  >({});
  const toggleSector = useCallback(
    (k: SectorKey) => setSectorsOn((prev) => ({ ...prev, [k]: !prev[k] })),
    [],
  );
  // How the sector polygons are coloured: "zone" = the per-zone legend colour
  // (CTR/TMA/CTA/… — matches the Airspace menu swatches), "sector" = a distinct
  // colour per individual sector, "altitude" = by the sector's coded band.
  const [sectorColorMode, setSectorColorMode] = useState<
    "zone" | "sector" | "altitude"
  >("zone");

  // Airway reference layers (the Airway tab): VOR + reporting points, lazily
  // loaded when toggled, plus a shared opacity for the lines + points.
  const [airwayExtra, setAirwayExtra] = useState<AirwayExtra>({
    labels: false,
    vor: false,
    reporting: false,
    opacity: 0.7,
  });
  const [airwayVor, setAirwayVor] = useState<AirwayPointCollection | null>(null);
  const [airwayReporting, setAirwayReporting] =
    useState<AirwayPointCollection | null>(null);

  // Airports + runways layers (the Layer Options "Airports" tab). Airport
  // markers are controlled per-airport by the list (no master toggle).
  const [airportList, setAirportList] = useState<PanelAirport[]>([]);
  const [hiddenAirports, setHiddenAirports] = useState<Set<string>>(new Set());
  const [showRunways, setShowRunways] = useState(false);
  const [runwayLabels, setRunwayLabels] = useState(true);
  const [runways, setRunways] = useState<RunwayPoint[]>([]);

  // Gates layer.
  const [gatesOn, setGatesOn] = useState(false);
  const [gates, setGates] = useState<GateCollection | null>(null);

  // Procedure-style layers (SID/STAR/PBN/ILS) — rich state from the panel.
  const [layersOpen, setLayersOpen] = useState(false);
  /** Which Layer Options tab the panel opens on — set by the global Layers
   *  menu, which names a layer rather than just opening the panel. */
  const [layersTab, setLayersTab] = useState<LayerTabKey>("airports");
  const openLayers = useCallback((tab: LayerTabKey) => {
    setLayersTab(tab);
    setLayersOpen(true);
  }, []);
  const [sid, setSid] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [star, setStar] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [pbn, setPbn] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [ils, setIls] = useState<ProcLayerState>(DEFAULT_PROC_LAYER);
  const [holdingLayer, setHoldingLayer] = useState<HoldingLayerState>(
    DEFAULT_HOLDING_LAYER,
  );
  const [sidWpts, setSidWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  const [starWpts, setStarWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  const [pbnLines, setPbnLines] = useState<ProcedureLineCollection | null>(
    null,
  );
  const [pbnWpts, setPbnWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  const [ilsLines, setIlsLines] = useState<ProcedureLineCollection | null>(
    null,
  );
  const [ilsWpts, setIlsWpts] = useState<ProcedureWaypointCollection | null>(
    null,
  );
  // Holding patterns for the map layer (distinct from the CD&R holdings index
  // below: this one is categorised + drawable). Fetched on first enable.
  const [holdingPatterns, setHoldingPatterns] = useState<
    HoldingPattern[] | null
  >(null);
  const [holdingLoading, setHoldingLoading] = useState(false);
  // Procedure inspector: legs + constraints fetched when a SID/STAR line is
  // clicked. null = closed.
  const [procView, setProcView] = useState<{
    sel: ProcedureSelection;
    loading?: boolean;
    data?: ProcedureDto;
    error?: string;
  } | null>(null);
  // The procedure currently highlighted on the map (from a map click or the
  // lookup form). null = nothing highlighted.
  const [highlightProc, setHighlightProc] = useState<ProcedureDto | null>(null);
  const handleProcedureClick = useCallback((sel: ProcedureSelection) => {
    setProcView({ sel, loading: true });
    setHighlightProc(null);
    // The clicked line's transition_identifier is either a runway (RW…) or
    // an enroute transition fix; route it to the right query param and let
    // the API auto-resolve the other axis.
    const t = (sel.transition ?? "").toUpperCase();
    const isRunway = t.startsWith("RW");
    fetchProcedure(sel.airport, sel.name, {
      type: sel.type,
      runway: isRunway ? sel.transition ?? undefined : undefined,
      transition: isRunway ? undefined : sel.transition ?? undefined,
    })
      .then((data) => {
        setProcView({ sel, data });
        setHighlightProc(data); // light up the clicked procedure's path
      })
      .catch((e: unknown) =>
        setProcView({
          sel,
          error: e instanceof Error ? e.message : "Failed to load procedure",
        }),
      );
  }, []);
  const [sidLines, setSidLines] = useState<ProcedureLineCollection | null>(
    null,
  );
  const [starLines, setStarLines] = useState<ProcedureLineCollection | null>(
    null,
  );

  // RouteBuilder picker idents: every Myanmar fix/navaid in the VY navdata
  // cache (aip_VY.json), so a route can be built across any airway.
  const [routeIdents, setRouteIdents] = useState<string[]>([]);

  // Aircraft animation. One playback engine drives the clock; the
  // source is whichever route the user picked (R1, R2, …) or "all",
  // which falls back to the longest route so every flight fits the
  // timeline. The selector lives in SimControls.
  const longest = useMemo(
    () =>
      trajectories.reduce<TrajectoryResult | null>(
        (best, t) =>
          !best || t.points.length > best.points.length ? t : best,
        null,
      ),
    [trajectories],
  );
  // Clamp playbackIdx to the current list (e.g. after a route is
  // removed). "all" is only meaningful with 2+ routes (the picker is hidden
  // for a single flight); when just one route exists it collapses to R1, so
  // a stale "all" (left over from a multi-route run) still shows that
  // flight's live FL/speed instead of the degenerate all-span readout.
  // Numeric out-of-range falls back to R1.
  const safePlaybackIdx =
    playbackIdx === "all"
      ? trajectories.length >= 2
        ? "all"
        : 0
      : trajectories[playbackIdx]
        ? playbackIdx
        : 0;
  const activeTrajectory =
    safePlaybackIdx === "all" ? longest : trajectories[safePlaybackIdx] ?? null;

  // "All" mode plays an ABSOLUTE timeline: a two-point span from the earliest
  // departure to the latest arrival across every route. The shared clock then
  // covers the whole operation, so each flight animates at its real EOBT (the
  // map offsets each route by its own departure — see LeafletMap), spreading
  // same-track traffic into a realistic in-trail stream. (`useSimPlayback` only
  // reads first/last epoch for the clock; its interpolated aircraft is unused
  // in "all" mode — the per-route planes are drawn in LeafletMap.)
  const allOriginMs = useMemo(() => {
    let m = Infinity;
    for (const t of trajectories) {
      const p = t.points?.[0];
      if (p) m = Math.min(m, new Date(p.epoch_ts).getTime());
    }
    return Number.isFinite(m) ? m : 0;
  }, [trajectories]);
  // Latest landing time across all routes (the "all"-mode timeline end). Split
  // out so `allSpanPoints` can be keyed on the NUMERIC span, not the trajectory
  // array identity.
  const allEndMs = useMemo(() => {
    let end = -Infinity;
    for (const t of trajectories) {
      const ps = t.points;
      if (!ps || ps.length === 0) continue;
      const b = new Date(ps[ps.length - 1].epoch_ts).getTime();
      if (b > end) end = b;
    }
    return Number.isFinite(end) ? end : 0;
  }, [trajectories]);
  const allSpanPoints = useMemo(() => {
    if (allEndMs <= allOriginMs) return undefined;
    // A synthetic 2-point span: in "all" mode useSimPlayback only reads the
    // first/last epoch for the shared clock (its interpolated aircraft is unused
    // there — the per-route planes are drawn in LeafletMap). Keying on the
    // numeric span means a fix that DOESN'T extend the timeline keeps the SAME
    // array reference, so useSimPlayback no longer resets + replays the clock on
    // every applied fix — the churn that made auto-resolve re-render the whole
    // map ~every commit and freeze the tab at high sim speed.
    const base: TrajectoryPoint = {
      lat: 0,
      lon: 0,
      epoch_ts: "",
      altitude_ft: null,
      gs_kt: 0,
      tas_kt: null,
      track_deg: 0,
      phase: "cruise",
    };
    return [
      { ...base, epoch_ts: new Date(allOriginMs).toISOString() },
      { ...base, epoch_ts: new Date(allEndMs).toISOString() },
    ];
  }, [allOriginMs, allEndMs]);

  const sim = useSimPlayback(
    safePlaybackIdx === "all" ? allSpanPoints : activeTrajectory?.points,
  );

  // The detail-card target: the locked (followed) flight wins, else the flight
  // hovered / picked for detail only. We interpolate it at the SAME shared sim
  // clock the map uses, so in "all" mode it tracks the real position while every
  // route keeps animating.
  const cardIdx = followActive ? followIdx : detailIdx;
  const cardTraj =
    cardIdx != null && trajectories[cardIdx] ? trajectories[cardIdx] : null;
  const cardSamples = useMemo(
    () => (cardTraj ? toSamples(cardTraj.points) : []),
    [cardTraj],
  );
  // Match the plane to the absolute clock the map uses, so its camera + detail
  // card track the real position (offset by its own EOBT in "all" mode).
  const cardOffsetSec =
    cardTraj && safePlaybackIdx === "all" && cardTraj.points[0]
      ? (new Date(cardTraj.points[0].epoch_ts).getTime() - allOriginMs) / 1000
      : 0;
  const cardLocalT = sim.simT - cardOffsetSec;
  const cardAircraft = cardTraj ? aircraftAt(cardSamples, cardLocalT) : null;
  const cardStatus = cardTraj
    ? statusFromLocalT(cardLocalT, totalSeconds(cardTraj.points))
    : null;

  // Camera follow — keep the LOCKED aircraft centred. Runs every frame while a
  // lock is active (cardAircraft is fresh each tick); panTo animate:false is a
  // cheap centre-set. A hover/Results-click detail card never locks, so the
  // camera stays put for those.
  const followLat = followActive ? cardAircraft?.lat ?? null : null;
  const followLon = followActive ? cardAircraft?.lon ?? null : null;
  useEffect(() => {
    if (!mapInstance || followLat == null || followLon == null) return;
    mapInstance.panTo([followLat, followLon], { animate: false });
  }, [mapInstance, followLat, followLon]);
  // Zoom in when a flight is LOCKED (follow turns on or the target changes),
  // framing the aircraft. Frame-by-frame panning is the effect above, which
  // must not re-zoom.
  useEffect(() => {
    if (!mapInstance || !followActive) return;
    const ac = aircraftAt(cardSamples, sim.simT - cardOffsetSec);
    if (!ac) return;
    mapInstance.setView([ac.lat, ac.lon], Math.max(mapInstance.getZoom(), 8), {
      animate: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followActive, followIdx, mapInstance]);

  // Spacebar toggles play/pause (like a media player), except while typing
  // in a form field or focusing a button, so the generator inputs, the
  // aircraft-type search, and clickable controls still behave normally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        tag === "BUTTON" ||
        el?.isContentEditable
      ) {
        return;
      }
      e.preventDefault(); // stop the page from scrolling on Space
      sim.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sim.toggle]);

  // The sim clock for a given route's altitude chart: the live `simT` when
  // that route is the one being animated on the map ("all" animates every
  // route), else null so its plane parks at the start. In "all" mode the clock
  // is absolute, so subtract the route's own departure offset to keep each
  // profile's plane in lock-step with the map aircraft.
  const playSimT = (i: number): number | null => {
    if (safePlaybackIdx === "all") {
      const p = trajectories[i]?.points?.[0];
      const off = p
        ? (new Date(p.epoch_ts).getTime() - allOriginMs) / 1000
        : 0;
      return sim.simT - off;
    }
    return safePlaybackIdx === i ? sim.simT : null;
  };

  // --- Live airspace membership (which controlled volume each plane is in) ---
  // Built here because MapApp is the one owner of the trajectories, the shared
  // clock, the per-route EOBT offsets and the sector polygons. The result is
  // keyed by flightKey and fanned out to the map label, the Results rows and the
  // profile graph so all three show the SAME zone.
  const airspaceIndex = useMemo(
    () => buildAirspaceIndex(sectorData),
    [sectorData],
  );

  // Position-dependent horizontal separation minimum for CD&R: 3 NM inside a
  // TMA listed in REDUCED_TERMINAL_SEP_TMAS (terminal radar minimum), 5 NM
  // everywhere else (en-route). That set is EMPTY by default — Myanmar's
  // terminal minima must be confirmed from AIP Myanmar first — so this stays
  // undefined and the flat 5 NM applies. The TMA polygons are loaded once any
  // flight exists (see the all-sectors effect below). Fed to BOTH the
  // realtime detector and the plan-scan via `configOverrides`, so `cdr.config`
  // carries it and every downstream path (detect, planConflicts, advisories)
  // uses the same per-position minimum. Falls back to the flat en-route minimum
  // until the polygon loads.
  const sepMinNmAt = useMemo(() => {
    if (REDUCED_TERMINAL_SEP_TMAS.size === 0 || !airspaceIndex.tma) return undefined;
    const { enrouteNm, terminalNm } = DEFAULT_CDR_CONFIG.horizontal;
    return (lat: number, lon: number, altFt: number | null): number => {
      const tma = airspaceAt(airspaceIndex, lon, lat, altFt).tma;
      return tma && REDUCED_TERMINAL_SEP_TMAS.has(tma.toUpperCase())
        ? terminalNm
        : enrouteNm;
    };
  }, [airspaceIndex]);
  const cdrConfigOverrides = useMemo<DeepPartial<CdrConfig> | undefined>(
    () => (sepMinNmAt ? { sepMinNmAt } : undefined),
    [sepMinNmAt],
  );
  const samplesByIdx = useMemo(
    () => trajectories.map((t) => toSamples(t.points)),
    [trajectories],
  );
  const routeOffsets = useMemo(
    () => departureOffsets(trajectories),
    [trajectories],
  );
  // Throttle the (otherwise 60 fps) recompute to ~1 Hz — point-in-polygon on
  // ~184 polygons per plane is cheap, but there's no reason to redo it every
  // frame; whole-second resolution reads live enough.
  const simSec = Math.round(sim.simT);
  // …but a SIM second is not a real second. At x200 `simSec` ticks ~200×/s, so
  // a per-sim-second membership pass over a whole traffic day ran hundreds of
  // times per real second and ate the main thread. This second gate holds the
  // airspace pass to ~5 Hz of REAL time while playing; a pause or a scrub
  // (where simSec moves without the clock running) always lands immediately.
  const [airspaceSec, setAirspaceSec] = useState(0);
  const lastAirspaceMsRef = useRef(0);
  useEffect(() => {
    const nowMs =
      typeof performance !== "undefined" ? performance.now() : lastAirspaceMsRef.current;
    if (sim.playing && nowMs - lastAirspaceMsRef.current < 200) return;
    lastAirspaceMsRef.current = nowMs;
    setAirspaceSec(simSec);
  }, [simSec, sim.playing]);
  // Altitude-aware membership per plane — the volume that actually CONTAINS the
  // aircraft at its current altitude (a plane above a TMA's ceiling is not in
  // it). The one source of truth for the map tag, the Results rows and the
  // profile label/colours alike.
  const airspaceByKey = useMemo(() => {
    const out: Record<string, AirspaceMembership> = {};
    if (!hasAirspace(airspaceIndex)) return out; // polygons not loaded yet
    trajectories.forEach((t, i) => {
      const localT = localClock(i, airspaceSec, routeOffsets, safePlaybackIdx);
      if (statusFromLocalT(localT, totalSeconds(t.points)) !== "enroute") return;
      const ac = aircraftAt(samplesByIdx[i], localT);
      if (!ac) return;
      out[t.meta.flightKey] = airspaceAt(
        airspaceIndex,
        ac.lon,
        ac.lat,
        ac.altitudeFt,
      );
    });
    return out;
  }, [
    trajectories,
    samplesByIdx,
    airspaceIndex,
    routeOffsets,
    safePlaybackIdx,
    airspaceSec,
  ]);

  // Whole-route airspace breakdown — every stretch each route spends in the
  // same set of sectors — so the altitude profile can paint colour blocks for
  // the zones it crosses. Independent of the sim clock (a static property of
  // the route), so it's computed once per route, not per frame.
  //
  // Handed down as a LOOKUP rather than a prebuilt map: only an expanded route
  // card mounts an altitude chart, so with a whole traffic day loaded this walks
  // the one or two routes actually on screen instead of all 599 (which is what
  // made the tab hang the moment a big set finished generating). The walk itself
  // is memoised per route inside `buildAirspaceSegments`.
  const trajByKey = useMemo(() => {
    const m = new Map<string, TrajectoryResult>();
    for (const t of trajectories) m.set(t.meta.flightKey, t);
    return m;
  }, [trajectories]);
  const airspaceSegmentsFor = useCallback(
    (flightKey: string): AirspaceSegment[] => {
      const t = trajByKey.get(flightKey);
      if (!t || !hasAirspace(airspaceIndex)) return [];
      return buildAirspaceSegments(airspaceIndex, t.points);
    },
    [trajByKey, airspaceIndex],
  );

  // --- Conflict Detection & Resolution (CD&R) --------------------------------
  // A read-only consumer of the same trajectories + shared clock the map uses.
  // Detection runs continuously in "all" mode (the one timeline where every
  // aircraft is truly airborne) — it is NOT gated on the panel, so the live
  // conflict count (badge) and the bottom-right alerts appear without the user
  // opening anything. The Conflicts tab just toggles the detailed Conflict View
  // panel. Detection/lifecycle live in lib/cdr.
  const cdrMonitoring = safePlaybackIdx === "all";
  // Which CD&R view is open (chosen from the Conflicts menu), and whether the
  // dropdown itself is showing. "notifications" = the realtime alert stack;
  // "dashboard" = the strategic 2-column LoS/Fixed board.
  const [cdrView, setCdrView] = useState<CdrView>(
    null,
  );
  const [cdrMenuOpen, setCdrMenuOpen] = useState(false);
  // Auto-resolve: when on, the top plan-validated fix is applied automatically
  // to every detected conflict (no manual Apply). Off by default — the operator
  // opts in AND picks when the resolver works: up front, before anything is
  // replayed, or continuously while the replay runs (see `AutoResolveMode`).
  const [autoResolveMode, setAutoResolveMode] =
    useState<AutoResolveMode>("off");
  const autoResolve = autoResolveMode !== "off";
  // Progress of the up-front pass — drives the status line in the CD&R menu and
  // the summary toast. Null whenever no up-front pass is running or finished.
  const [autoPass, setAutoPass] = useState<AutoPassState | null>(null);
  // Bumped when the user re-picks "Before replay" while it is already selected,
  // to run the pass again over whatever is still unresolved.
  const [autoPassNonce, setAutoPassNonce] = useState(0);
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(
    null,
  );
  // Log of resolutions the user has APPLIED — drives the Dashboard's "Fixed"
  // list + the ✓ badge on rows that have been dealt with. Keyed newest-first.
  const [appliedFixes, setAppliedFixes] = useState<AppliedFix[]>([]);
  // An applied fix the user opened (by clicking its auto-resolve toast) to
  // inspect: shows the "from → to" detail card and highlights the new route on
  // the map (dashed + glowing). Keyed by conflict id.
  const [highlightFixId, setHighlightFixId] = useState<string | null>(null);
  const highlightedFix = useMemo(
    () =>
      highlightFixId
        ? appliedFixes.find((f) => f.conflictId === highlightFixId) ?? null
        : null,
    [highlightFixId, appliedFixes],
  );
  // The POST-fix route of the maneuvered flight, for the glowing dashed overlay.
  // Prefers the snapshot taken when the fix was applied; falls back to the live
  // trajectory for fixes logged before snapshots existed.
  const resolvedRoutePts = useMemo(() => {
    if (!highlightedFix) return null;
    if (highlightedFix.afterPath) return highlightedFix.afterPath;
    const t = trajectories.find(
      (tr) => tr.meta.flightKey === highlightedFix.target,
    );
    return t ? t.points.map((p) => ({ lat: p.lat, lon: p.lon })) : null;
  }, [highlightedFix, trajectories]);
  // The route the flight WOULD have flown — drawn faint + dashed underneath.
  const originalRoutePts = highlightedFix?.beforePath ?? null;
  // The before/after Preview & Fix modal (opened from a dashboard row).
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const toasts = useToasts();
  // flightKey → callsign, so alerts read "UBA201 ↔ MMA34", not raw keys.
  const callsignByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of trajectories) m[t.meta.flightKey] = t.meta.callsign;
    return m;
  }, [trajectories]);
  const nameOf = useCallback(
    (id: string) => callsignByKey[id] ?? id,
    [callsignByKey],
  );

  // Which ATS unit owns a conflict — the sector the loss of separation would
  // happen in, plus who is working each aircraft right now. A controller shown
  // a resolution has to know whether it is theirs to give, and whether it
  // crosses a boundary (Doc 4444 §10.1 coordination). Resolved from the same
  // altitude-aware airspace hierarchy the map labels and Results rows use, so
  // all of them name the same volume.
  /** flightKey → its position in `trajectories`. Anything that resolves a
   *  flight by key per row/per frame goes through this rather than scanning the
   *  list, which is O(traffic) and gets called thousands of times a frame with
   *  a whole day loaded. */
  const idxByFlightKey = useMemo(() => {
    const m = new Map<string, number>();
    trajectories.forEach((t, i) => m.set(t.meta.flightKey, i));
    return m;
  }, [trajectories]);

  /**
   * Who owns a conflict.
   *
   * `effective` decides WHICH picture is asked for, and it matters because the
   * two have different jobs. The live panels want the configuration in force —
   * a band-box means one controller, so two aircraft in its members are not a
   * coordination case any more. The report that FEEDS THE PLANNER wants the
   * published sectors, because a planner measuring against its own last output
   * would plan on top of itself; that table is the baseline and has to stay the
   * AIP's.
   */
  const sectorOfConflict = useCallback(
    (
      c: { a: string; b: string },
      tCpaAbsSec: number,
      { effective = true }: { effective?: boolean } = {},
    ): ConflictSector | null => {
      if (!hasAirspace(airspaceIndex)) return null; // polygons not loaded yet
      const at = (id: string, absSec: number): SectorPoint | null => {
        // Indexed, not searched: the dashboard asks this for every row it
        // draws, four times each (both aircraft, at the CPA and now). A linear
        // findIndex over a whole traffic day made that 852 x 4 x 1976 string
        // comparisons per frame — the panel froze the tab just by being open.
        const i = idxByFlightKey.get(id) ?? -1;
        if (i < 0) return null;
        const ac = aircraftAt(samplesByIdx[i], absSec - (routeOffsets[i] ?? 0));
        return ac ? { lat: ac.lat, lon: ac.lon, altFt: ac.altitudeFt } : null;
      };
      const now = Math.round(simTRef.current);
      // Published airspace in, EFFECTIVE position out. The index itself is
      // never rewritten — it is the baseline the planner measures against — so
      // an applied plan is layered on top here instead, per instant. With no
      // plan applied `positionAt` is the identity and this is the published
      // lookup it always was.
      const resolve = (
        lat: number,
        lon: number,
        altFt: number | null,
        atMs?: number,
      ) => {
        const m = airspaceAt(airspaceIndex, lon, lat, altFt);
        const cfg = effective ? effectiveRef.current : null;
        const layer = cfg?.layer as SectorKey | undefined;
        if (!cfg || !layer || layer === "pdr" || atMs == null) return m;
        const own = m[layer];
        if (!own) return m;
        return { ...m, [layer]: positionAt(cfg, own, lon, lat, atMs) };
      };
      const abs = (sec: number) => timelineOriginMsRef.current + sec * 1000;
      return conflictSector(
        c,
        { a: at(c.a, tCpaAbsSec), b: at(c.b, tCpaAbsSec), atMs: abs(tCpaAbsSec) },
        { a: at(c.a, now), b: at(c.b, now), atMs: abs(now) },
        resolve,
      );
    },
    [airspaceIndex, idxByFlightKey, samplesByIdx, routeOffsets],
  );
  // Hover readouts for the two before/after overlay lines. The new route carries
  // the instruction with its "from" value ("Climb FL160 — from FL140").
  const resolvedRouteLabel = useMemo(() => {
    if (!highlightedFix) return null;
    const who = highlightedFix.targetCallsign ?? nameOf(highlightedFix.target);
    const instr = highlightedFix.fromLabel
      ? `${highlightedFix.instruction} — from ${highlightedFix.fromLabel}`
      : highlightedFix.instruction;
    return `${who} · ${instr}`;
  }, [highlightedFix, nameOf]);
  const originalRouteLabel = useMemo(() => {
    if (!highlightedFix) return null;
    const who = highlightedFix.targetCallsign ?? nameOf(highlightedFix.target);
    return `${who} · original route (before the fix)`;
  }, [highlightedFix, nameOf]);
  const handleCdrEvent = useCallback(
    (e: CdrEvent) => {
      if (e.kind === "resolved") {
        // Conflict cleared → drop its transient toast and the panel selection if
        // it was the open one. The Dashboard's "Fixed" list keeps the record.
        toasts.dismiss(e.conflict.id);
        setSelectedConflictId((cur) => (cur === e.conflict.id ? null : cur));
        return;
      }
      // NEW or ESCALATED → upsert the sticky toast + sound (dedup/gating done in
      // the lifecycle). The alert now stays until the conflict resolves.
      const { title, body } = conflictHeadline(e.conflict, nameOf);
      toasts.upsert({
        conflictId: e.conflict.id,
        severity: e.conflict.severity,
        kind: e.kind,
        title,
        body,
      });
      playAlert(e.conflict.severity);
    },
    [nameOf, toasts],
  );
  const cdr = useCdr({
    trajectories,
    simT: sim.simT,
    simSec,
    playbackIdx: safePlaybackIdx,
    enabled: cdrMonitoring,
    onEvent: handleCdrEvent,
    configOverrides: cdrConfigOverrides,
  });

  // Arrival sequencing runs alongside conflict detection but answers a
  // different question: in-trail arrivals fly parallel tracks at similar
  // speeds, so they never trip the CPA detector even when the gap is
  // unlandable (Doc 4444 §8.9.4.3). Only computed while the panel is open —
  // it walks every arrival's whole remaining path.
  // --- Departure conflicts (pre-departure, from the FILED PLANS) -----------
  // Detected in GeneratorPanel (it owns the plans) but shown here, in the same
  // right-hand rail as the other conflict panels: one place to look, whether
  // the problem is on the runway or in the air. It is available BEFORE
  // anything is generated — that is the whole point of it.
  const [depConflictState, setDepConflictState] = useState<{
    conflicts: DepartureConflict[];
    ignore: (conflictId: string) => void;
    ignoreAll: (conflictIds: string[]) => void;
    fix: (conflictId: string, planId: string) => void;
    autoFixAll: () => void;
  } | null>(null);
  const [depPanelOpen, setDepPanelOpen] = useState(false);
  const [depChoiceFor, setDepChoiceFor] = useState<string | null>(null);
  const depConflicts = depConflictState?.conflicts ?? [];
  // The departure-conflict rail and the CD&R views share the same slot on the
  // left of the map, so opening one has to close the other — otherwise they
  // stack and the one underneath is unreachable.
  const openDepPanel = useCallback(() => {
    setDepPanelOpen(true);
    setCdrView(null);
  }, []);
  /** Open a CD&R view, closing the departure rail. */
  const openCdrView = useCallback((v: CdrView) => {
    setCdrView(v);
    setDepPanelOpen(false);
  }, []);
  // Nothing left to show → the panel closes itself rather than sitting there
  // empty (Auto fix all clears the whole list in one click).
  useEffect(() => {
    if (depConflicts.length === 0) {
      setDepPanelOpen(false);
      setDepChoiceFor(null);
    }
  }, [depConflicts.length]);

  // Arrival instructions the controller has issued, by flightKey — so a row
  // reads as done and is not offered again.
  const [issuedArrivalFixes, setIssuedArrivalFixes] = useState<Set<string>>(
    () => new Set(),
  );
  // Instructions currently being re-flown by the engine, so the row can show
  // it is working and the button can't be double-fired.
  const [busyArrivalFixes, setBusyArrivalFixes] = useState<Set<string>>(
    () => new Set(),
  );
  /** Downwind extension ALREADY issued to each arrival (NM, cumulative).
   *
   *  `/api/extend` is absolute, not incremental: it re-flies the flight from the
   *  originally filed request with `extend_downwind_nm = X`, so sending the
   *  second instruction's own 2 NM would REPLACE the first 3 NM rather than add
   *  to it — the aircraft would move back up the approach. A second instruction
   *  is a real case (the planner proposes the bare minimum, and a stream can
   *  re-tighten as the aircraft ahead is held), so the running total is what
   *  gets sent. Preview uses it too, or the drawn path would not be the one
   *  Issue commits. */
  const extendIssuedNm = useRef<Map<string, number>>(new Map());
  const totalExtendNm = useCallback(
    (flightKey: string, addNm: number) =>
      (extendIssuedNm.current.get(flightKey) ?? 0) + addNm,
    [],
  );
  /** An arrival fix being PREVIEWED: the path it would fly, held uncommitted so
   *  the map can draw it against the current one. A vector and a hold both
   *  change the ground track, so both draw; a speed control keeps it and
   *  changes only timing, so `points` is null for those and the panel says so
   *  instead of drawing a line identical to the one already there.
   *
   *  The fetched path is kept so Issue can commit it without asking the engine
   *  a second time. */
  const [arrivalPreview, setArrivalPreview] = useState<{
    flightKey: string;
    points: TrajectoryResult["points"] | null;
    route: TrajectoryResult["route"] | null;
    stats: TrajectoryResult["stats"] | null;
    meta: TrajectoryResult["meta"] | null;
  } | null>(null);

  const clearArrivalPreview = useCallback(() => setArrivalPreview(null), []);

  /** The previewed path, and the flight's CURRENT one to draw underneath it, so
   *  the change reads as "was -> would be". Both null when nothing is
   *  previewed, or when the fix leaves the track untouched. */
  const arrivalPreviewPts = useMemo(
    () =>
      arrivalPreview?.points
        ? arrivalPreview.points.map((p) => ({ lat: p.lat, lon: p.lon }))
        : null,
    [arrivalPreview],
  );
  const arrivalOriginalPts = useMemo(() => {
    if (!arrivalPreview?.points) return null;
    const cur = trajectories.find(
      (t) => t.meta.flightKey === arrivalPreview.flightKey,
    );
    return cur ? cur.points.map((p) => ({ lat: p.lat, lon: p.lon })) : null;
  }, [arrivalPreview, trajectories]);

  /** Fetch (or compute) what a fix would do, without committing it. */
  const handlePreviewArrivalFix = useCallback(
    (flightKey: string, fix: ArrivalFix) => {
      if (arrivalPreview?.flightKey === flightKey) {
        setArrivalPreview(null); // toggle off
        return;
      }
      // A HOLD is traced in the browser from the published pattern, so the
      // racetrack can be drawn without asking the engine anything.
      if (fix.kind === "hold" && fix.hold) {
        const i = trajectories.findIndex((t) => t.meta.flightKey === flightKey);
        if (i < 0) return;
        const localT = simTRef.current - (routeOffsets[i] ?? 0);
        const held = applyArrivalHold(
          trajectories[i],
          fix.hold,
          fix.holdLoops ?? 1,
          localT,
        );
        setArrivalPreview({
          flightKey,
          points: held === trajectories[i] ? null : held.points,
          route: held.route,
          stats: held.stats,
          meta: held.meta,
        });
        return;
      }
      if (fix.kind !== "vector" || !fix.extendNm) {
        // Nothing to draw: the track is unchanged.
        setArrivalPreview({
          flightKey, points: null, route: null, stats: null, meta: null,
        });
        return;
      }
      setBusyArrivalFixes((prev) => new Set(prev).add(flightKey));
      void (async () => {
        try {
          const { result } = await extendDownwind(
            flightKey,
            totalExtendNm(flightKey, fix.extendNm!),
          );
          setArrivalPreview({
            flightKey,
            points: result.points,
            route: result.route,
            stats: result.stats,
            meta: result.meta,
          });
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Could not preview the extension.",
          );
        } finally {
          setBusyArrivalFixes((prev) => {
            const next = new Set(prev);
            next.delete(flightKey);
            return next;
          });
        }
      })();
    },
    [arrivalPreview, trajectories, routeOffsets, totalExtendNm],
  );

  // Published holdings (dormant until a VY holding table is supplied — the
  // loader fails closed to none) — loaded once, enables the CD&R
  // HOLD resolution (fly a racetrack loop at a holding fix on the route to
  // delay + open spacing) and the same instruction for an arrival stream.
  const [holdings, setHoldings] = useState<Map<string, Holding>>(new Map());
  useEffect(() => {
    let alive = true;
    void fetchHoldings().then((m) => {
      if (alive) setHoldings(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  const arrivals = useArrivals({
    trajectories,
    samplesByIdx,
    offsets: routeOffsets,
    simSec,
    enabled: cdrMonitoring && cdrView === "arrivals",
    configOverrides: cdrConfigOverrides,
    holdings,
  });

  // Realtime notification list. An APPLIED fix is authoritative: a resolved
  // conflict is shown as "✓ Fixed" only BRIEFLY (a confirmation) and then drops
  // off the live stack — it must not linger as a loss alert even when the
  // detector still trips on residual geometry (e.g. a maneuver that narrows but
  // doesn't fully open the CPA). Unfixed conflicts always show.
  const FIX_NOTIF_LINGER_SEC = 6;
  const notifConflicts = useMemo(() => {
    const appliedAt = new Map(
      appliedFixes.map((f) => [f.conflictId, f.appliedAtSec]),
    );
    return cdr.conflicts.filter((c) => {
      const at = appliedAt.get(c.id);
      return at == null || simSec - at < FIX_NOTIF_LINGER_SEC;
    });
  }, [cdr.conflicts, appliedFixes, simSec]);

  // Live conflicts NOT yet resolved by an applied fix — drives the toolbar
  // badge/count, so a fixed conflict stops inflating the "active" number.
  const unresolvedConflicts = useMemo(() => {
    const fixedIds = new Set(appliedFixes.map((f) => f.conflictId));
    return cdr.conflicts.filter((c) => !fixedIds.has(c.id));
  }, [cdr.conflicts, appliedFixes]);


  // Live clock in a ref so the Preview/Apply click handlers can read "now"
  // without being re-created every animation frame.
  const simTRef = useRef(sim.simT);
  simTRef.current = sim.simT;

  /** The airspace configuration an applied dynamic plan puts in force, and the
   *  UTC the sim clock is measured from. Refs because `sectorOfConflict` is
   *  defined above both of them and is rebuilt on most renders — reading them
   *  through a ref keeps it off the dependency list rather than re-creating it
   *  (and every panel that depends on it) whenever the plan or the clock moves.
   *  Assigned where each value is computed, further down. */
  const effectiveRef = useRef<EffectiveConfig | null>(null);
  const timelineOriginMsRef = useRef(0);

  /**
   * Published sectors -> applied plan -> the configuration actually in force.
   *
   * Derived, never written back: `airspaceIndex` and the sector GeoJSON stay
   * exactly what the AIP publishes, because that is the baseline the planner
   * measures against — rewriting it from a plan would have the next run plan
   * against its own output. Only an APPLIED plan counts, so a proposal on
   * screen cannot quietly change the numbers being read to judge it.
   *
   * Declared up here rather than beside the panel that produces the plan: the
   * report builder and the sector-hour effect both key off it, and both run
   * before that point in the file.
   */
  const [dynamicPlan, setDynamicPlan] = useState<DynamicPlan | null>(null);
  const effectiveSectors = useMemo(
    () => effectiveConfig(dynamicPlan),
    [dynamicPlan],
  );
  effectiveRef.current = effectiveSectors;

  /** Issue an arrival-spacing instruction. Only SPEED is flyable from here: it
   *  keeps the ground track, so the trajectory is simply re-timed from the
   *  clock onward (the same client-side path the other CD&R fixes use). A
   *  vector or a hold re-routes the aircraft and needs the engine's geometry.
   *
   *  `sim.simT` is the SHARED timeline clock, not wall time, so it is mapped
   *  onto this flight's own epoch axis first — otherwise the cut-over would
   *  land in the wrong place on any flight whose EOBT is offset. */
  const handleIssueArrivalFix = useCallback(
    (flightKey: string, fix: ArrivalFix) => {
      // A DOWNWIND EXTENSION changes the ground track, so the engine re-flies
      // it: the request that produced the flight is held server-side, keyed by
      // flight key, and the result is spliced at the hand-over fix so nothing
      // already flown moves.
      if (fix.kind === "vector" && fix.extendNm) {
        // Already previewed? Commit exactly what was shown rather than asking
        // the engine again — a second call would be wasted, and any drift
        // between the two would mean the map lied.
        const total = totalExtendNm(flightKey, fix.extendNm);
        const shown = arrivalPreview;
        if (shown?.flightKey === flightKey && shown.points && shown.meta) {
        // Replacing a trajectory makes useSimPlayback reset the clock to 0 and
        // pause; hold the current position so issuing an instruction does not
        // throw the replay back to the start.
        restorePlaybackRef.current = {
          t: simTRef.current,
          playing: playingRef.current,
        };
          setTrajectories((prev) =>
            prev.map((t) =>
              t.meta.flightKey === flightKey
                ? { ...t, route: shown.route!, points: shown.points!,
                    stats: shown.stats!, meta: shown.meta! }
                : t,
            ),
          );
          void recacheTrajectory(flightKey, shown.points);
          extendIssuedNm.current.set(flightKey, total);
          setIssuedArrivalFixes((prev) => new Set(prev).add(flightKey));
          setArrivalPreview(null);
          return;
        }
        setBusyArrivalFixes((prev) => new Set(prev).add(flightKey));
        void (async () => {
          try {
            const { result } = await extendDownwind(flightKey, total);
        // Replacing a trajectory makes useSimPlayback reset the clock to 0 and
        // pause; hold the current position so issuing an instruction does not
        // throw the replay back to the start.
        restorePlaybackRef.current = {
          t: simTRef.current,
          playing: playingRef.current,
        };
            setTrajectories((prev) =>
              prev.map((t) =>
                t.meta.flightKey === flightKey
                  ? { ...t, route: result.route, points: result.points,
                      stats: result.stats, meta: result.meta }
                  : t,
              ),
            );
            // Keep the DOWNLOAD in step with what was issued — the extend
            // endpoint re-flies the flight but leaves the export cache holding
            // the un-extended baseline it generates alongside the splice.
            void recacheTrajectory(flightKey, result.points);
            extendIssuedNm.current.set(flightKey, total);
            setIssuedArrivalFixes((prev) => new Set(prev).add(flightKey));
            setArrivalPreview(null);
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : "Could not extend the downwind.",
            );
          } finally {
            setBusyArrivalFixes((prev) => {
              const next = new Set(prev);
              next.delete(flightKey);
              return next;
            });
          }
        })();
        return;
      }
      // A HOLD is spliced in at the published fix, client-side — the racetrack
      // geometry is the same one the conflict-side holds already fly.
      if (fix.kind === "hold") {
        if (!fix.hold) return; // advisory only: nowhere to hold
        restorePlaybackRef.current = {
          t: simTRef.current,
          playing: playingRef.current,
        };
        setTrajectories((prev) => {
          const i = prev.findIndex((t) => t.meta.flightKey === flightKey);
          if (i < 0) return prev;
          const localT = simTRef.current - (routeOffsets[i] ?? 0);
          const held = applyArrivalHold(
            prev[i],
            fix.hold!,
            fix.holdLoops ?? 1,
            localT,
          );
          if (held === prev[i]) return prev;
          // Keep the DOWNLOAD in step with what was issued.
          void recacheTrajectory(flightKey, held.points);
          return prev.map((t, k) => (k === i ? held : t));
        });
        setIssuedArrivalFixes((prev) => new Set(prev).add(flightKey));
        setArrivalPreview(null);
        return;
      }
      if (fix.kind !== "speed" || !fix.gsKt) return;
        // Replacing a trajectory makes useSimPlayback reset the clock to 0 and
        // pause; hold the current position so issuing an instruction does not
        // throw the replay back to the start.
        restorePlaybackRef.current = {
          t: simTRef.current,
          playing: playingRef.current,
        };
      setTrajectories((prev) => {
        const i = prev.findIndex((t) => t.meta.flightKey === flightKey);
        if (i < 0 || prev[i].points.length < 2) return prev;
        const localT = simTRef.current - (routeOffsets[i] ?? 0);
        const originSec = new Date(prev[i].points[0].epoch_ts).getTime() / 1000;
        const points = applySpeedReduction(
          prev[i].points,
          originSec + localT,
          fix.gsKt as number,
        );
        if (points === prev[i].points) return prev;
        // Keep the DOWNLOAD in step with what was issued, as the conflict
        // fixes do — otherwise the export still serves the pre-fix path.
        void recacheTrajectory(flightKey, points);
        return prev.map((t, k) => (k === i ? { ...t, points } : t));
      });
      setIssuedArrivalFixes((prev) => new Set(prev).add(flightKey));
    },
    [routeOffsets, arrivalPreview, totalExtendNm],
  );

  const playingRef = useRef(sim.playing);
  playingRef.current = sim.playing;

  // Applying a resolution replaces a trajectory, which makes useSimPlayback
  // reset the clock to 0 and pause (its reset fires on a new sample table). We
  // don't want the animation to jump back to the start on Apply — capture the
  // clock + play state here and restore them once the new trajectories commit.
  const restorePlaybackRef = useRef<{ t: number; playing: boolean } | null>(null);
  useEffect(() => {
    const r = restorePlaybackRef.current;
    if (!r) return;
    restorePlaybackRef.current = null;
    sim.seek(r.t);
    if (r.playing) sim.play();
    // Runs after the trajectory change (and after the hook's reset effect);
    // sim.seek/play are read from the current render's sim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trajectories]);

  // Strategic full-flight-plan conflict scan — every loss of separation the
  // filed plans will produce across the WHOLE timeline (not just the live
  // look-ahead), so the Dashboard can list future conflicts that haven't
  // alerted yet. Recomputed only when the trajectories change (e.g. after an
  // Apply), not per animation frame.
  // Shared per-flight tables (samples + EOBT offset + duration) for the plan
  // scan and the constraint re-check.
  const planFlights = useMemo<PlanFlight[]>(
    () =>
      trajectories.map((t, i) => ({
        id: t.meta.flightKey,
        callsign: t.meta.callsign,
        samples: samplesByIdx[i],
        offsetSec: routeOffsets[i] ?? 0,
        durationSec: totalSeconds(t.points),
      })),
    [trajectories, samplesByIdx, routeOffsets],
  );
  // The scan is O(pairs): a traffic day is ~2 million of them, seconds of work.
  // Auto-resolve re-times ONE flight per fix, so re-scanning everything after
  // each one is what makes a long pass look like a hung tab. Keep the last
  // result and rescan only the pairs that touch a flight whose sample table
  // actually changed (`toSamples` is cached per point array, so an untouched
  // flight keeps its identity). Anything else — a new set, a different config —
  // falls back to the full scan.
  const planScanRef = useRef<{
    flights: PlanFlight[];
    conflicts: PlanConflict[];
    cfg: CdrConfig;
  } | null>(null);
  const planConflicts = useMemo<PlanConflict[]>(() => {
    if (!cdrMonitoring || planFlights.length < 2) {
      planScanRef.current = null;
      return [];
    }
    const prev = planScanRef.current;
    let next: PlanConflict[] | null = null;
    if (prev && prev.cfg === cdr.config && prev.flights.length === planFlights.length) {
      const changed = new Set<string>();
      let sameSet = true;
      for (let i = 0; i < planFlights.length; i++) {
        const a = planFlights[i];
        const b = prev.flights[i];
        if (a.id !== b.id) {
          sameSet = false;
          break;
        }
        if (
          a.samples !== b.samples ||
          a.offsetSec !== b.offsetSec ||
          a.durationSec !== b.durationSec
        ) {
          changed.add(a.id);
        }
      }
      if (sameSet) {
        next = rescanFlightPlanConflicts(
          prev.conflicts,
          planFlights,
          changed,
          cdr.config,
        );
      }
    }
    if (next == null) next = scanFlightPlanConflicts(planFlights, cdr.config);
    planScanRef.current = { flights: planFlights, conflicts: next, cfg: cdr.config };
    return next;
  }, [cdrMonitoring, planFlights, cdr.config]);

  // The auto-resolve work queue: every REAL loss of separation in the filed
  // plan that hasn't been fixed, soonest CPA first. Whole-timeline, so a fix
  // gets applied while there is still enough lead time for it to work (see the
  // auto-resolve loop below for why the realtime detector is too late).
  const unresolvedPlanConflicts = useMemo(() => {
    const fixedIds = new Set(appliedFixes.map((f) => f.conflictId));
    return planConflicts
      .filter((c) => c.definite && !fixedIds.has(c.id))
      .sort((a, b) => a.tCpaAbsSec - b.tCpaAbsSec);
  }, [planConflicts, appliedFixes]);

  // --- Conflict log — the record of the run -------------------------------
  // The dashboard shows what is wrong NOW; a fixed pair vanishes from it. This
  // keeps every encounter the scan ever found, with the window it happens in,
  // the geometry, and the instruction that resolved it (or the fact that
  // nothing did). Folded rather than recomputed: entries are only added or
  // closed, so the history survives the trajectories changing under it.
  const [conflictLog, setConflictLog] = useState<ConflictLogEntry[]>([]);
  const planFlightsById = useMemo(
    () => new Map(planFlights.map((f) => [f.id, f])),
    [planFlights],
  );
  useEffect(() => {
    if (!cdrMonitoring) return;
    setConflictLog((prev) =>
      updateConflictLog(prev, {
        conflicts: planConflicts,
        flights: planFlightsById,
        appliedFixes,
        cfg: cdr.config,
        nowSec: simSec,
      }),
    );
    // `simSec` only stamps what changes, and folding on every tick would be
    // wasted work — the log moves when the SCAN or the fixes do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdrMonitoring, planConflicts, appliedFixes, planFlightsById, cdr.config]);
  const conflictLogCount = useMemo(
    () => conflictLogCounts(conflictLog),
    [conflictLog],
  );

  // UTC of the shared clock's t=0 — the earliest departure across the set, the
  // same origin `departureOffsets` measures from. Turns an absolute sim second
  // back into the real timestamp the exported track rows are keyed by.
  const timelineOriginMs = useMemo(() => {
    let origin = Infinity;
    for (const t of trajectories) {
      const p = t.points?.[0];
      if (p) origin = Math.min(origin, new Date(p.epoch_ts).getTime());
    }
    return Number.isFinite(origin) ? origin : 0;
  }, [trajectories]);
  timelineOriginMsRef.current = timelineOriginMs;

  /** Shared-clock seconds -> the UTC stamp the log is read in. The log is a
   *  record of real times, not of sim offsets: "02:14:20Z" is what goes in a
   *  report, and it is the same clock the exported files are keyed by. */
  const logUtc = useCallback(
    (sec: number) =>
      `${new Date(timelineOriginMs + sec * 1000).toISOString().slice(11, 19)}Z`,
    [timelineOriginMs],
  );

  /**
   * Tell the export which timestamps of a flight are in loss of separation,
   * for every conflict the controller has NOT resolved. Run just before a
   * download: detection lives in the browser (only it holds every trajectory),
   * so the server-rendered files have to be handed the windows.
   *
   * Flights with nothing outstanding post an empty list, which clears a mark
   * left by an earlier export — so a file downloaded after the fix is applied
   * never still claims a conflict.
   */
  const stampConflictMarks = useCallback(
    async (flightKeys: string[]) => {
      if (flightKeys.length === 0) return;
      // Single-route playback leaves the strategic scan off; run it here so a
      // download is annotated whether or not CD&R monitoring is live.
      const scanned =
        cdrMonitoring || planFlights.length < 2
          ? planConflicts
          : scanFlightPlanConflicts(planFlights, cdr.config);
      const fixedIds = new Set(appliedFixes.map((f) => f.conflictId));
      const unresolved = scanned.filter((c) => c.definite && !fixedIds.has(c.id));
      await setConflictMarks(
        buildLosMarks(
          flightKeys,
          planFlights,
          unresolved,
          cdr.config,
          timelineOriginMs,
        ),
      );
    },
    [
      cdrMonitoring,
      planConflicts,
      planFlights,
      cdr.config,
      appliedFixes,
      timelineOriginMs,
    ],
  );


  // Prohibited/Danger/Restricted areas (from the AIP PDR polygons) for the
  // constraint engine's airspace check.
  const restrictedAreas = useMemo(
    () => restrictedAreasFrom(sectorData.pdr ?? null),
    [sectorData.pdr],
  );
  // --- PDR route check ------------------------------------------------------
  // Prohibited/Danger/Restricted areas ARE already tested by the CD&R
  // constraint engine above, but only as "is this polygon in the way" — it has
  // no activity times, so it treats every area as permanently hot. This runs
  // the plan-level check instead: the AIXM timetable says whether each area is
  // actually active when the flight gets there, and ENR 1.10 says whether the
  // filed routing is even a published one for the pair. Advisory only; the
  // suggestion is staged into the generator, never flown automatically.
  const [pdrSelected, setPdrSelected] = useState<string | null>(null);
  /** The P/D/R areas picked out in red on the map, from "Show area". A list,
   *  not one: a rejected flight often has several findings and the useful
   *  question is where they sit RELATIVE to each other and to the route. */
  /**
   * The opening screen: the generator centred over a blurred map.
   *
   * True until either something has been generated or the operator has stepped
   * past it. Not a separate component — the same sidebar, moved by CSS — so
   * there is one generator in the tree and no state to keep in sync.
   */
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);

  const enterPreview = useCallback(() => {
    setPreviewMode(true);
    // Stepping onto the preview page IS stepping past the opening card.
    setFirstRunDismissed(true);
    // Drawing the routes is the whole point of the page, so a preview switched
    // off earlier in the console does not carry over.
    setPreviewHidden(false);
    // The plan rail is the page's left-hand column, so make sure it is the
    // panel on show even if Preview is reached from another view.
    setNav({ kind: "generator" });
  }, []);
  const exitPreview = useCallback(() => {
    setPreviewMode(false);
    // Back to where Preview was pressed: the opening card while nothing has
    // been generated, the console once something has (`firstRun` also requires
    // an empty run, so this is a no-op in that case).
    setFirstRunDismissed(false);
  }, []);

  // Entering or leaving the preview page insets the map container by the
  // frame. Leaflet caches its own size and cannot see a CSS change, so without
  // this the tiles keep the old dimensions and the centre drifts. Next frame,
  // once the new geometry has been laid out.
  useEffect(() => {
    if (!mapInstance) return;
    const f = requestAnimationFrame(() => mapInstance.invalidateSize());
    return () => cancelAnimationFrame(f);
  }, [mapInstance, previewMode]);

  const [focusedAreas, setFocusedAreas] = useState<PdrArea[]>([]);
  /** Which run report is being built and how far along, null when idle. The
   *  KIND matters: both report buttons share this state, and without it each
   *  one showed the other's progress. */
  const [reportProgress, setReportProgress] = useState<{
    kind: ReportKind;
    percent: number;
  } | null>(null);
  // "Edit route in plan" — which plan tab the generator should bring forward.
  const [planFocus, setPlanFocus] = useState<{
    planId?: string;
    match?: { callsign: string; adep: string; ades: string };
    nonce: number;
  } | null>(null);
  // The PDR check over the FILED PLANS, emitted by GeneratorPanel before
  // anything is generated. Preferred over the trajectory-based check below,
  // because a route is worth fixing while it is still a plan.
  const [pdrPlanState, setPdrPlanState] = useState<{
    flights: {
      flightKey: string;
      callsign: string;
      adep: string;
      ades: string;
      rflFt: number;
    }[];
    reports: Map<string, PdrReport>;
    loading: boolean;
    error: string | null;
    validFrom: string | null;
    validTo: string | null;
    useRoute: (flightKey: string, route: string) => void;
    retry: () => void;
    scanning: boolean;
    detailFor: (flightKey: string) => PdrReport | undefined;
  } | null>(null);
  const [routeHandoff, setRouteHandoff] = useState<{
    callsign: string;
    adep: string;
    ades: string;
    route: string;
    nonce: number;
  } | null>(null);

  const pdrFlights = useMemo<PdrFlight[]>(() => {
    return trajectories.map((t, i) => {
      const path = pathFromTrajectory(t.points);
      const hours = t.stats.timeMinutes / 60;
      return {
        flightKey: t.meta.flightKey,
        callsign: t.meta.callsign,
        adep: t.meta.adep,
        ades: t.meta.ades,
        actype: t.meta.aircraftType,
        // The route string as filed for THIS combination (a plan can queue
        // several), which is what the download row carries.
        filedRoute: downloads[i]?.route ?? "",
        // The first emitted sample is already an absolute UTC instant, so it
        // anchors the schedule lookup without re-parsing the EOBT string.
        eobtMs: path[0]?.timeMs ?? Date.parse(t.meta.eobtIso),
        rflFt: t.stats.rflFt,
        gsKt: hours > 0 ? t.stats.distanceNm / hours : 450,
        // Candidate routes are estimates even here, so they get the same
        // anchors — the flown trajectory's own ends.
        terminals: {
          dep: path[0] ? { lat: path[0].lat, lon: path[0].lon } : null,
          arr: path.length
            ? { lat: path[path.length - 1].lat, lon: path[path.length - 1].lon }
            : null,
        },
        path,
      };
    });
  }, [trajectories, downloads]);

  // Enabled whenever there are flights, not just while the panel is open, so
  // the Conflicts menu can carry the count without the operator opening it first.
  const pdr = usePdrCheck(pdrFlights, trajectories.length > 0);

  /**
   * Which check the panel shows.
   *
   * The GENERATED trajectories win as soon as there are any: they are the real
   * flown path, with the SID and STAR actually flown and real times, so their
   * verdict supersedes the estimate. The filed plans are the pre-generation
   * preview and only stand in until then.
   *
   * This used to be "plans whenever plans exist" — and the generator always has
   * plans, so the trajectory check was unreachable. The panel kept showing
   * "Filed plans, before generation" and its estimated climb-out findings long
   * after Generate had run, which read as the new times never reaching the
   * calculation at all.
   */
  const pdrShowsPlans =
    trajectories.length === 0 && (pdrPlanState?.flights.length ?? 0) > 0;

  const pdrActionable = useMemo(() => {
    const reports = pdrShowsPlans ? pdrPlanState!.reports : pdr.reports;
    return [...reports.values()].filter((r) =>
      r.findings.some((f) => f.severity !== "info"),
    ).length;
  }, [pdrShowsPlans, pdrPlanState, pdr.reports]);

  /**
   * Draw one restricted area in red and fly the map to it.
   *
   * The panel STAYS OPEN. It used to be closed on the way — it is 680 px wide
   * over the left of the map, so leaving it open would often hide the very area
   * being shown — but closing it also took away the list of findings that the
   * area is evidence for, and re-opening it meant finding the flight again. The
   * fix for "the panel covers the area" is to not fly the area under the panel:
   * the left padding below is the panel's own width, so the target lands in the
   * strip of map that is actually visible. It closes when the reader closes it.
   *
   * The red outline stays until it is dismissed from the chip, so the map can be
   * panned around the area afterwards.
   */
  const handleFocusArea = useCallback(
    (area: PdrArea) => {
      let next: PdrArea[] = [];
      setFocusedAreas((prev) => {
        // Clicking the same area again takes it off, so the button toggles.
        const without = prev.filter((a) => a.ident !== area.ident);
        next = without.length === prev.length ? [...prev, area] : without;
        return next;
      });
      // Nothing to move to when the click switched the area OFF.
      if (!mapInstance || !next.some((a) => a.ident === area.ident)) return;

      // Go to the area just clicked, not to the union of every highlighted one:
      // the union zooms further out with each pick, so the area you asked to see
      // gets smaller the more you look at.
      const [minLon, minLat, maxLon, maxLat] = area.bbox;

      // How much of the MAP the panel actually covers. Measured, not assumed:
      // the panel's width is a CSS clamp against the viewport, so on a narrow
      // window it is most of the screen. Both rectangles are read in viewport
      // coordinates and then differenced, because Leaflet's padding is relative
      // to the map container — which starts after the generator rail, so the
      // panel's raw `right` would over-pad by the width of that rail.
      //
      // Floored at 80 (the plain margin, when no panel is up) and capped so at
      // least 240 px of map is left to put the area in: padding wider than the
      // box gives Leaflet nothing to fit the bounds into.
      const mapBox = mapInstance.getContainer().getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>(".cdr-panel");
      const covered = panel
        ? panel.getBoundingClientRect().right - mapBox.left + 24
        : 0;
      const leftPad = Math.min(
        Math.max(covered, 80),
        Math.max(80, mapBox.width - 240),
      );

      // Animate — but only while it is affordable. Leaflet's canvas renderer
      // redraws every vector layer on each frame of a pan, and this canvas
      // carries a polyline per flight; with a whole imported traffic day the
      // animation itself locked the tab for seconds. Above the threshold the
      // move is instant, which is unremarkable but never janky.
      const animate = trajectories.length <= ANIMATED_PAN_MAX_FLIGHTS;
      mapInstance.flyToBounds(
        [
          [minLat, minLon],
          [maxLat, maxLon],
        ],
        {
          paddingTopLeft: [leftPad, 80],
          paddingBottomRight: [80, 80],
          maxZoom: 10,
          animate,
          duration: 0.6,
        },
      );
    },
    [mapInstance, trajectories.length],
  );

  /**
   * Save one of the run-level report CSVs.
   *
   * Built here rather than in the API because two of the three inputs only
   * exist in the browser: the airspace polygons the sector crossings come from,
   * and the conflict log, which is a record of what happened during THIS run.
   */
  /** The run-report tables, built once and shared by the download buttons and
   *  the sector-information panel — they are the same walk over every flight,
   *  and doing it twice is seconds of work for nothing. */
  /** The band-boxing rule the controller is asking "what if" with. Held here,
   *  not in the panel, because the download button in the Download dialog has
   *  to produce the SAME plan the panel is showing. */
  const [dynConfig, setDynConfig] = useState<DynamicSectorConfig>(
    DEFAULT_DYNAMIC_CONFIG,
  );

  /**
   * The walk of every flight against the airspace — the expensive half of a
   * report — and what is derived from the airspace alone. Keyed on the flights
   * and the loaded polygons ONLY. The conflict log is deliberately not in the
   * key: it grows every time a conflict is logged during a replay, and keying
   * the walk on it re-walked every flight for a change that only moves a
   * conflict count. Counting is the cheap half and is cached separately below.
   */
  const reportCacheRef = useRef<{
    key: unknown[];
    events: FlightEventRow[];
    /** Which sectors touch which, per layer. Geometry, not traffic — but it is
     *  built from the same airspace index this walk already loads, so it is
     *  cached with it rather than re-derived on every threshold change. */
    adjacency: Record<string, SectorAdjacency>;
    /** Sector outlines by display name, per layer — what a boundary re-cut
     *  actually cuts. */
    shapes: Record<string, ReadonlyMap<string, Rings>>;
  } | null>(null);

  /**
   * The effective table, cached against the configuration that produced it.
   *
   * Separate from the baseline cache on purpose. The baseline is the AIP's and
   * changes only when the traffic does; this changes whenever a configuration
   * is applied or reverted, and re-keying the baseline for it is what fed the
   * loop described in `buildReportData`. Built off the baseline's own event
   * walk, so applying a plan costs a re-label and a re-count, never a second
   * walk over every flight against the airspace.
   */
  /** The baseline sector-hour table: the walk's events with the conflict log
   *  counted onto them. Re-counted when the log changes, never re-walked. */
  const baselineHoursRef = useRef<{
    events: FlightEventRow[];
    log: typeof conflictLog;
    rows: SectorHourRow[];
  } | null>(null);

  const effectiveCacheRef = useRef<{
    events: FlightEventRow[];
    cfg: EffectiveConfig | null;
    /** The log the conflicts were counted from — the same walk serves every log,
     *  so the events alone no longer say whether this table is current. */
    log: typeof conflictLog;
    rows: SectorHourRow[] | null;
  } | null>(null);

  const buildReportData = useCallback(
    async (kind: ReportKind) => {
      // A conflict's sector: the unit recorded on the applied fix when it was
      // resolved there, else the unit that owns the CPA.
      //
      // Built twice, against the two pictures. The PUBLISHED set keys the
      // baseline table the planner reads; the EFFECTIVE set keys the table the
      // simulation reports. Using one set for both is what went wrong first
      // time: conflicts labelled "1N+3N" against rows keyed "1N" attribute to
      // nothing, and the planner's own input quietly lost its conflict counts.
      const conflictsAs = (effective: boolean): ReportConflict[] =>
        conflictLog.map((e) => ({
          id: e.id,
          aCallsign: e.aCallsign,
          bCallsign: e.bCallsign,
          startMs: timelineOriginMs + e.fromSec * 1000,
          sector:
            e.resolution?.sector ??
            sectorOfConflict({ a: e.a, b: e.b }, e.tCpaSec, { effective })
              ?.label ??
            null,
          resolved: !!e.resolution,
        }));
      const conflicts = conflictsAs(false);

      /** The same walk, told of the positions actually working the traffic.
       *  Null when nothing is in force, which is what every consumer falls
       *  back to the baseline on. */
      const effectiveFrom = (evs: FlightEventRow[]): SectorHourRow[] | null => {
        const cfg = effectiveRef.current;
        if (!cfg) return null;
        const hit = effectiveCacheRef.current;
        if (hit && hit.events === evs && hit.cfg === cfg && hit.log === conflictLog)
          return hit.rows;
        const rows = buildSectorHours(effectiveEvents(evs, cfg), conflictsAs(true));
        effectiveCacheRef.current = { events: evs, cfg, log: conflictLog, rows };
        return rows;
      };

      /** The published-sector table for a walk: reused while the log is the same
       *  one, re-counted (milliseconds) when it has grown. */
      const baselineHours = (evs: FlightEventRow[]): SectorHourRow[] => {
        const hit = baselineHoursRef.current;
        if (hit && hit.events === evs && hit.log === conflictLog) return hit.rows;
        const rows = buildSectorHours(evs, conflicts);
        baselineHoursRef.current = { events: evs, log: conflictLog, rows };
        return rows;
      };

      // The BASELINE key, and deliberately without the configuration in force.
      //
      // The baseline is the AIP's own picture and does not depend on any plan,
      // so it must keep its identity when one is applied. Adding the
      // configuration here fed a loop: applying re-built the baseline, the new
      // array identity tripped the "settings changed, re-plan" effect, that
      // cleared the acceptance, which cleared the configuration — and the Apply
      // button appeared to do nothing. The effective table is cached separately
      // below, off this same walk.
      const cacheKey: unknown[] = [trajectories, sectorData];
      const hit = reportCacheRef.current;
      if (hit && isSameWalk(hit.key, cacheKey)) {
        return {
          events: hit.events,
          sectorHours: baselineHours(hit.events),
          effectiveSectorHours: effectiveFrom(hit.events),
          adjacency: hit.adjacency,
          shapes: hit.shapes,
        };
      }
      const index = await loadReportAirspace(sectorData);
      const flights = trajectories.map(toReportFlight);

      // Built in slices, yielding to the browser between them. Every flight is
      // walked point by point against every airspace volume, so a full traffic
      // sample is seconds of work — done in one synchronous pass it locked the
      // tab from the moment the button was pressed until the file appeared,
      // with no way to tell the two apart from a crash.
      //
      // The yield is `yieldToMain`, NOT `setTimeout(0)`: "View" opens the report
      // in front of this tab, so this tab is hidden while it builds, and a
      // hidden tab's timers are held back to about one wake-up a second — a
      // traffic day was ~45 slices, i.e. the better part of a minute of waiting
      // for ~2 s of work.
      const events: ReturnType<typeof buildFlightEvents> = [];
      let sliceStart = performance.now();
      let shownAt = sliceStart;
      for (let i = 0; i < flights.length; i++) {
        events.push(...buildFlightEvents(flights[i], index));
        const now = performance.now();
        if (now - sliceStart < REPORT_SLICE_MS) continue;
        if (now - shownAt >= REPORT_PROGRESS_MS) {
          setReportProgress({
            kind,
            percent: Math.min(100, Math.round(((i + 1) / flights.length) * 100)),
          });
          shownAt = now;
        }
        await yieldToMain();
        sliceStart = performance.now();
      }
      setReportProgress(null);
      const adjacency: Record<string, SectorAdjacency> = {};
      const shapes: Record<string, ReadonlyMap<string, Rings>> = {};
      for (const k of REPORT_LAYERS) {
        adjacency[k] = buildSectorAdjacency(index, k);
        shapes[k] = sectorShapes(index, k);
      }
      const built = { events, adjacency, shapes };
      reportCacheRef.current = { key: cacheKey, ...built };
      return {
        ...built,
        /** The AIP's own picture. The planner measures against this and must
         *  keep measuring against this, whatever configuration is in force. */
        sectorHours: baselineHours(events),
        effectiveSectorHours: effectiveFrom(events),
      };
    },
    [trajectories, sectorData, conflictLog, timelineOriginMs, sectorOfConflict],
  );

  /** Save one of the run reports. */
  const handleDownloadReport = useCallback(
    async (kind: ReportKind) => {
      const data = await buildReportData(kind);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      // Each report ships with a companion holding just its headline chart's
      // series, laid out so the block can be selected and charted in Excel
      // without being re-arranged first. A .csv cannot carry a chart object;
      // it can carry a table already shaped like one.
      const plan = () =>
        planDynamicSectors(
          data.sectorHours,
          data.adjacency[dynConfig.layer] ?? new Map(),
          dynConfig,
        );
      if (kind === "events") {
        saveTextFile(flightEventsCsv(data.events), "flight_events_" + stamp + ".csv");
        saveBinaryFile(
          flightTrajectoryXlsx(data.events),
          "flight_events_" + stamp + "_chart_trajectory.xlsx",
          XLSX_MIME,
        );
      } else if (kind === "sectors") {
        // The traffic table reports the CONFIGURATION IN FORCE: with a plan
        // applied its rows are keyed by position ("1N+3N"), because that is who
        // worked the traffic. The chart beside it stays on the baseline — it
        // plots the plan against the published sectors it was measured from,
        // and measuring it against itself would flatten the very saving it is
        // there to show.
        saveTextFile(
          sectorHoursCsv(data.effectiveSectorHours ?? data.sectorHours),
          "sector_hours_" + stamp + ".csv",
        );
        saveBinaryFile(
          standardVsMergedXlsx(plan(), data.sectorHours),
          "sector_hours_" + stamp + "_chart_standard_vs_merged.xlsx",
          XLSX_MIME,
        );
      } else {
        // Same traffic table, one more decision on top of it. The threshold is
        // whatever the Sector information panel is currently set to, so the
        // file and the screen always describe the same configuration.
        const p = plan();
        saveTextFile(dynamicSectorsCsv(p), "dynamic_sectorization_" + stamp + ".csv");
        saveTextFile(
          dynamicSpansCsv(p),
          "dynamic_sectorization_" + stamp + "_periods.csv",
        );
        saveBinaryFile(
          conflictBySectorXlsx(data.sectorHours, dynConfig.layer, p),
          "dynamic_sectorization_" + stamp + "_chart_conflict_by_sector.xlsx",
          XLSX_MIME,
        );
      }
    },
    [buildReportData, dynConfig],
  );

  /**
   * The same three reports, shaped for the screen instead of for a file — the
   * headline chart only.
   *
   * The chart is built from the SAME `ChartSpec` the .xlsx chart is, so the tab
   * and the download cannot describe the run differently — that is the whole
   * reason this returns a payload rather than drawing anything itself. The rows
   * stay in the downloads: a flight-events table over a traffic day is 60,000+
   * of them, and building, cloning and indexing that for a tab that is there to
   * show a picture was most of what made it slow to open.
   */
  const buildReportPayload = useCallback(
    async (kind: ReportKind): Promise<ReportPayload> => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const flights = trajectories.length;
      const run = `${flights.toLocaleString()} flight${flights === 1 ? "" : "s"} · built ${stamp.slice(0, 10)} ${stamp.slice(11).replace(/-/g, ":")}Z`;

      if (kind === "events") {
        // The chart draws the first 25 flights by callsign, so events are built
        // for THOSE — 25 flights of work instead of the whole sample's. If a
        // full walk is already in hand (a download or the sector panel made
        // one) it is reused; the answer is the same either way.
        const hit = reportCacheRef.current;
        let events: FlightEventRow[];
        if (hit && isSameWalk(hit.key, [trajectories, sectorData])) {
          events = hit.events;
        } else {
          const keep = trajectoryChartCallsigns(
            trajectories.map((t) => t.meta.callsign),
          );
          const index = await loadReportAirspace(sectorData);
          events = trajectories
            .filter((t) => keep.has(t.meta.callsign))
            .flatMap((t) => buildFlightEvents(toReportFlight(t), index));
        }
        const series = flightTrajectoryRows(events);
        // Pairs, not columns: the trajectory chart carries two columns per
        // flight, and the count is however many flights fitted on it.
        const drawn = Math.floor((series[0]?.length ?? 0) / 2);
        return {
          kind: "events",
          title: "Flight trajectories",
          subtitle:
            (drawn < flights
              ? `The first ${drawn.toLocaleString()} of ${flights.toLocaleString()} flights by callsign`
              : `All ${drawn.toLocaleString()} flight${drawn === 1 ? "" : "s"}`) +
            ` · takeoff, filed fixes, TOC/TOD, sector boundaries and landing · ${run}`,
          series,
          spec: flightTrajectoryChart(drawn),
        };
      }

      const data = await buildReportData(kind);

      if (kind === "sectors") {
        // The chart stays on the PUBLISHED sectors even with a configuration
        // applied: it plots the plan against the sectors it was measured from,
        // and measuring it against itself would flatten the very saving it is
        // there to show.
        const plan = planDynamicSectors(
          data.sectorHours,
          data.adjacency[dynConfig.layer] ?? new Map(),
          dynConfig,
        );
        return {
          kind: "sectors",
          title: "Standard vs merged positions",
          subtitle: `Published sectors against the positions the traffic needed, hour by hour · merge below ${dynConfig.mergeBelow} · ${run}`,
          series: standardVsMergedRows(plan),
          spec: STANDARD_VS_MERGED_CHART,
        };
      }

      return {
        kind: "dynamic",
        title: "Conflicts by sector",
        subtitle: `Which sectors produced the conflicts, and how many were resolved · ${run}`,
        series: conflictBySectorRows(data.sectorHours, dynConfig.layer),
        spec: CONFLICT_BY_SECTOR_CHART,
      };
    },
    [buildReportData, dynConfig, trajectories, sectorData],
  );

  /**
   * Open a run report in a second browser tab.
   *
   * The window is opened FIRST, empty, and the report posted to it once built.
   * That order is not a style choice: `window.open` only counts as
   * user-initiated inside the click that caused it, so opening it after the
   * await — which is seconds of work over a whole traffic day — gets it eaten
   * by the pop-up blocker.
   *
   * The new tab asks for its report until it is answered (see
   * `lib/report/viewPayload.ts`), so neither side has to be ready first.
   */
  const handleViewReport = useCallback(
    (kind: ReportKind) => {
      const nonce = newNonce();
      // No features string. Passing one — even "noopener=no" — asks for a popup
      // WINDOW rather than a tab, which is both not what was asked for and the
      // shape browsers are most willing to block. A bare "_blank" opens a tab
      // and keeps `window.opener`, which is the channel the report arrives on.
      const win = window.open(reportUrl(kind, nonce, theme), "_blank");
      if (!win) {
        setError(
          "The browser blocked the report tab. Allow pop-ups for this site, then try View again.",
        );
        return;
      }

      type Delivery = {
        type: "payload" | "error";
        payload?: ReportPayload;
        error?: string;
      };
      let delivery: Delivery | null = null;
      let helloSeen = false;

      // BOTH conditions, every time. Posting as soon as the build finishes
      // looks right and silently loses the report whenever the build wins the
      // race: a message to a tab that has not yet installed its listener is
      // simply dropped, and the tab sits on "building" for ever. So the console
      // waits to be asked, and the tab keeps asking until it is answered.
      const answer = () => {
        if (!delivery || !helloSeen || win.closed) return;
        win.postMessage(
          { channel: REPORT_CHANNEL, nonce, ...delivery },
          window.location.origin,
        );
      };
      const onHello = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        if (!isHello(e.data) || e.data.nonce !== nonce) return;
        helloSeen = true;
        answer();
      };
      window.addEventListener("message", onHello);
      // Answering every hello, rather than only the first, is what lets the
      // report tab be reloaded and come back with its report. Stop listening
      // once the tab has had longer than it will ever wait.
      window.setTimeout(
        () => window.removeEventListener("message", onHello),
        HELLO_GIVE_UP_MS,
      );

      buildReportPayload(kind)
        .then((payload) => {
          delivery = { type: "payload", payload };
        })
        .catch((err: unknown) => {
          delivery = {
            type: "error",
            error: err instanceof Error ? err.message : "The report could not be built.",
          };
        })
        .finally(answer);
    },
    [buildReportPayload, theme],
  );

  // --- Sector information panel ---------------------------------------------
  const [sectorAdjacency, setSectorAdjacency] = useState<Record<
    string,
    SectorAdjacency
  > | null>(null);
  const [sectorShapesByLayer, setSectorShapesByLayer] = useState<Record<
    string,
    ReadonlyMap<string, Rings>
  > | null>(null);
  /**
   * What of the configuration is drawn on the map right now.
   *
   * A merge and a re-cut are both "where does this apply", so one piece of
   * state covers both: a band-box paints its member sectors, a transfer paints
   * the slice that changes hands. `key` is what the panel ticks as shown.
   */
  const [shownConfig, setShownConfig] = useState<
    | { kind: "transfer"; key: string; transfer: AreaTransfer }
    | { kind: "merge"; key: string; label: string; sectors: string[] }
    | null
  >(null);
  const [sectorHours, setSectorHours] = useState<SectorHourRow[] | null>(null);
  /** The same traffic keyed by the positions in force. The PLANNER keeps
   *  reading `sectorHours` above — its baseline must stay the AIP's — while
   *  everything that reports what happened reads this when it exists. */
  const [effectiveSectorHours, setEffectiveSectorHours] = useState<
    SectorHourRow[] | null
  >(null);
  const [sectorHoursLoading, setSectorHoursLoading] = useState(false);
  // Held in a ref, NOT listed as a dependency. `buildReportData` closes over
  // `sectorOfConflict`, which is rebuilt on most renders, so depending on it
  // re-ran this effect every render — each run cancelling the one before, and
  // the cancelled flag then blocking the `finally` that clears the spinner. The
  // panel sat on "Walking every flight against the airspace…" forever while
  // restarting the build behind it.
  const buildReportDataRef = useRef(buildReportData);
  buildReportDataRef.current = buildReportData;

  /** Build (or reuse) the sector-hour table when the panel opens. */
  useEffect(() => {
    // Nothing to build FROM. The spinner is cleared here rather than simply
    // returning, because a build that gets cancelled part-way — the panel is
    // closed, or the flights are re-generated — never reaches its own
    // `finally`, so the flag survives into the next run. If that next run then
    // bails out at this guard, the panel opens onto "walking every flight…"
    // that nothing will ever finish. Clearing on the way out makes the stuck
    // state unreachable.
    if (
      (cdrView !== "sectorinfo" && cdrView !== "dynsector") ||
      trajectories.length === 0
    ) {
      setSectorHoursLoading(false);
      // Rows from a previous run would otherwise be shown against a traffic
      // sample that no longer exists.
      if (trajectories.length === 0) setSectorHours(null);
      return;
    }
    let cancelled = false;
    setSectorHoursLoading(true);
    buildReportDataRef.current("sectors")
      .then((d) => {
        if (cancelled) return;
        setSectorHours(d.sectorHours);
        setEffectiveSectorHours(d.effectiveSectorHours);
        setSectorAdjacency(d.adjacency);
        setSectorShapesByLayer(d.shapes);
      })
      .catch(() => {
        // An empty table reads as "built, found nothing" — which the panel
        // says plainly. A failed build must not look like a running one.
        if (!cancelled) {
          setSectorHours([]);
          setEffectiveSectorHours(null);
        }
      })
      .finally(() => {
        if (!cancelled) setSectorHoursLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Only the real inputs: the panel opening, and the data it reads — which
    // now includes the configuration in force, because that re-keys the table.
  }, [cdrView, trajectories, conflictLog, effectiveSectors]);

  /** P and R areas that are ACTIVE in a given hour — the airspace a re-cut is
   *  not allowed to hand across. Danger areas are left out: they are a hazard
   *  to the flight, not a bar on which controller owns the airspace. */
  const blockersAt = useCallback(
    (hourUtc: string) => {
      const at = Date.parse(hourUtc);
      if (!Number.isFinite(at)) return [];
      return pdr.areas
        .filter((a: PdrArea) => a.kind !== "D")
        .filter(
          (a: PdrArea) => activityAt(a.activity, at, a.centroid).state === "active",
        )
        .map((a: PdrArea) => ({
          ident: a.ident,
          rings: (a.mp as number[][][][])
            .map((poly) => (poly[0] ?? []).map((c) => ({ lon: c[0], lat: c[1] })))
            .filter((r) => r.length >= 3),
        }));
    },
    [pdr.areas],
  );

  /**
   * The dynamic sectorisation, produced when the operator asks for it.
   *
   * Held in state rather than derived on every render, because a configuration
   * is a proposal someone looks at and then accepts: recomputing it silently
   * under them as a threshold is typed would mean the thing they applied is not
   * the thing they read. `runDynamic` is the only way it changes.
   */
  const [dynamicApplied, setDynamicApplied] = useState(false);

  const runDynamic = useCallback(() => {
    if (!sectorHours || !sectorAdjacency) return;
    const adj = sectorAdjacency[dynConfig.layer];
    if (!adj || adj.size === 0) {
      setDynamicPlan(null);
      return;
    }
    const shapes = sectorShapesByLayer?.[dynConfig.layer];
    setDynamicPlan(
      planDynamicSectors(
        sectorHours,
        adj,
        dynConfig,
        shapes ? { shapes, blockersAt } : undefined,
      ),
    );
    // A fresh recommendation is not an applied one, whatever was applied before.
    setDynamicApplied(false);
    setShownConfig(null);
  }, [sectorHours, sectorAdjacency, sectorShapesByLayer, dynConfig, blockersAt]);

  /**
   * A setting changed, so the configuration on screen is stale.
   *
   * Re-planned rather than blanked, once there is something to re-plan: the
   * first configuration is asked for deliberately, and after that the numbers
   * and the proposal beside them have to agree. What does NOT survive is the
   * acceptance — `runDynamic` clears it, so a plan can never stay "applied"
   * through a change to the rule that produced it.
   */
  const runDynamicRef = useRef(runDynamic);
  runDynamicRef.current = runDynamic;
  const hasPlanRef = useRef(false);
  hasPlanRef.current = dynamicPlan !== null;
  useEffect(() => {
    if (hasPlanRef.current) runDynamicRef.current();
    // Deliberately not `runDynamic`: it is rebuilt whenever any of these
    // change, and depending on it would re-plan on every render instead.
  }, [dynConfig, sectorHours]);

  /** The configuration drawn on the map: the member sectors of a band-box, or
   *  the slice a re-cut hands over. Built from the same outlines the planner
   *  cut, so what is drawn is what was planned. */
  const dynamicHighlight = useMemo(() => {
    if (!shownConfig) return [];
    if (shownConfig.kind === "transfer") {
      const t = shownConfig.transfer;
      return [
        {
          ident: shownConfig.key,
          name: t.from + " cedes its " + t.quadrant + " airspace to " + t.to,
          kind: "R" as const,
          mp: [[t.boundary.map((q) => [q.lon, q.lat])]] as number[][][][],
          color: "#fbbf24",
        },
      ];
    }
    const shapes = sectorShapesByLayer?.[dynConfig.layer];
    if (!shapes) return [];
    return shownConfig.sectors.flatMap((sector) => {
      const rings = shapes.get(sector);
      if (!rings || rings.length === 0) return [];
      return [
        {
          ident: shownConfig.key + ":" + sector,
          name: sector + " — worked as " + shownConfig.label,
          kind: "R" as const,
          mp: rings.map((ring) => [ring.map((q) => [q.lon, q.lat])]) as number[][][][],
          color: "#38bdf8",
        },
      ];
    });
  }, [shownConfig, sectorShapesByLayer, dynConfig.layer]);

  /** Open a flight's plan so its route can be re-written by hand. The PDR
   *  flightKey for a filed plan is "<planId>::<comboIndex>", so the plan id is
   *  its first half. Steps out of the panel and into the generator, which is
   *  where the route field lives. */
  /** Read inside callbacks that must not be rebuilt on every generation. */
  const trajectoriesRef = useRef(trajectories);
  trajectoriesRef.current = trajectories;

  const handleOpenPlan = useCallback((flightKey: string) => {
    // A FILED plan's key is "<planId>::<comboIndex>", so the id is its first
    // half. A GENERATED flight has no plan id at all — it is matched on the
    // callsign and city pair instead, which is what identifies a plan until it
    // has been flown.
    const flown = trajectoriesRef.current.find(
      (t) => t.meta.flightKey === flightKey,
    );
    setPlanFocus(
      flown
        ? {
            match: {
              callsign: flown.meta.callsign,
              adep: flown.meta.adep,
              ades: flown.meta.ades,
            },
            nonce: Date.now(),
          }
        : { planId: flightKey.split("::")[0], nonce: Date.now() },
    );
    setNav({ kind: "generator" });
    // The check panel STAYS open. It sits to the right of the generator rail
    // rather than over it, and the check re-runs as the route is edited — so
    // keeping both on screen is the point: the findings update while the
    // controller types, instead of having to be reopened to see the result.
  }, []);

  /** Stage a suggested route on its flight's plan. Deliberately does NOT
   *  regenerate: the controller reviews the routing in the generator and
   *  presses Generate themselves. */
  const handleUseSuggestedRoute = useCallback(
    (flightKey: string, route: string) => {
      const t = trajectories.find((x) => x.meta.flightKey === flightKey);
      if (!t) return;
      setRouteHandoff({
        callsign: t.meta.callsign,
        adep: t.meta.adep,
        ades: t.meta.ades,
        route,
        nonce: Date.now(),
      });
      setNav({ kind: "generator" });
      setCdrView(null);
    },
    [trajectories],
  );

  // flightKey → its trajectory + EOBT offset, for building/validating maneuvers.
  const trajById = useMemo(() => {
    const m = new Map<string, { traj: TrajectoryResult; offset: number }>();
    trajectories.forEach((t, i) =>
      m.set(t.meta.flightKey, { traj: t, offset: routeOffsets[i] ?? 0 }),
    );
    return m;
  }, [trajectories, routeOffsets]);

  // Auto-generated, plan-validated resolutions for the SELECTED conflict — the
  // advisory engine analyses the whole plan (full-trajectory what-ifs, unlike the
  // realtime short-horizon engine) and returns ranked fixes with reason + score.
  // Used by BOTH the inline notification cards and the Preview modal, so they
  // agree and both get the correct answer for long-timescale fixes (e.g. an
  // in-trail overtake, where a speed change clears but a turn only delays it).
  // Computed on demand (a conflict is selected), not per frame; clock snapshot.
  // Keeps the diagnostics alongside the resolutions: when the list is empty the
  // panel needs `blockers` to say WHICH aircraft rejected every candidate, and
  // `widened` marks results that only exist because the fallback envelope ran.
  const planAdvisory = useMemo<PlanAdvisoryResult>(() => {
    const none = { resolutions: [], blockers: [], rejected: [], widened: false };
    if (!selectedConflictId) return none;
    const c = planConflicts.find((x) => x.id === selectedConflictId);
    if (!c) return none;
    return planResolutions({
      conflict: c,
      flights: planFlights,
      trajById,
      simT: simTRef.current,
      cfg: cdr.config,
      restricted: restrictedAreas,
      holdings,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedConflictId,
    planConflicts,
    planFlights,
    trajById,
    cdr.config,
    restrictedAreas,
    holdings,
  ]);
  const planSuggestions: PlanResolution[] = planAdvisory.resolutions;

  /** The conflict to open when a resolution is blocked by a third aircraft.
   *
   *  "Resolve UBA574 first" is only advice until UBA574 can be REACHED, and in
   *  a busy picture its own conflict is somewhere down a stack of dozens. The
   *  live stack is preferred over the plan scan because that is the list the
   *  notification panel can actually expand; both are ordered worst-first, so
   *  the first hit is the one worth working. Null = that aircraft is not in
   *  conflict itself — it is merely in the way, and nothing can be "resolved". */
  const blockerConflictOf = useCallback(
    (b: Blocker): string | null => {
      const fixed = new Set(appliedFixes.map((f) => f.conflictId));
      const live = notifConflicts.find(
        (c) => !fixed.has(c.id) && (c.a === b.id || c.b === b.id),
      );
      if (live) return live.id;
      const planned = planConflicts.find(
        (c) => c.definite && !fixed.has(c.id) && (c.a === b.id || c.b === b.id),
      );
      return planned?.id ?? null;
    },
    [notifConflicts, planConflicts, appliedFixes],
  );

  /**
   * The pair to open when a blocker has no conflict of its own.
   *
   * A blocker is an aircraft every candidate fix would run into. It is often in
   * conflict with nobody, so there is no row in any list to open — which used
   * to leave "Show AIQ101 →" panning the map and stopping there, an answer that
   * names the problem and offers nothing to do about it.
   *
   * The encounter that matters is the one the blocking is ABOUT: the blocked
   * aircraft against the blocker. So it is synthesised here from the real
   * geometry of that pair and handed to the same Preview & fix modal, which
   * then offers level / heading / speed / hold on either of them, checks the
   * result against all traffic, and applies it like any other fix.
   *
   * `definite: false` is the honest flag: they are not losing separation on the
   * current plan. They would, if the fix under consideration were applied.
   */
  const [blockerPair, setBlockerPair] = useState<{
    conflict: PlanConflict;
    /** Which half is the one in the way, for the modal's own labelling. */
    blockerCallsign: string;
  } | null>(null);

  const makeBlockerPair = useCallback(
    (blockerId: string, blockedId: string): PlanConflict | null => {
      const A = planFlights.find((f) => f.id === blockedId);
      const B = planFlights.find((f) => f.id === blockerId);
      if (!A || !B) return null;
      const sep = pairSeparation(A, B);
      // Sorted, like every other conflict id, so the pair keeps one identity.
      const [a, b] = blockedId < blockerId ? [A, B] : [B, A];
      const cfg = cdr.config;
      return {
        id: `blocker:${a.id}|${b.id}`,
        a: a.id,
        b: b.id,
        aCallsign: a.callsign,
        bCallsign: b.callsign,
        losStartAbsSec: null,
        tCpaAbsSec: sep?.tCpaAbsSec ?? simTRef.current,
        dCpaNm: sep?.minHNm ?? 0,
        vSepAtCpaFt: sep?.vSepAtCpaFt ?? 0,
        shNm: horizontalMinimumNm(cfg),
        svFt: cfg.vertical.belowRvsmTopFt,
        definite: false,
      };
    },
    [planFlights, cdr.config],
  );

  /** Which aircraft a blocker is blocking: the one the suggestions were being
   *  generated for. Either half of the pair will do — the blocker is in the way
   *  of every candidate on both — so the first is taken. */
  const targetOfPair = useCallback((c: PlanConflict) => c.a, []);
  const blockedFlightId = useCallback(
    (conflictId: string | null) => {
      const c = planConflicts.find((x) => x.id === conflictId);
      return c ? c.a : undefined;
    },
    [planConflicts],
  );

  /** Go and work the blocker. With a conflict of its own, select that — through
   *  the modal when the live stack has no row for it (a plan-scan conflict that
   *  has not entered the look-ahead yet, which the notification panel would
   *  never show). Without one, open it against the aircraft it is blocking. */
  const workBlocker = useCallback(
    (b: Blocker, conflictId: string | null, blockedId?: string) => {
      setPreviewIdx(null);
      if (conflictId) {
        setBlockerPair(null);
        setSelectedConflictId(conflictId);
        if (!notifConflicts.some((c) => c.id === conflictId)) {
          setPreviewModalOpen(true);
        }
        return;
      }
      const pair = blockedId ? makeBlockerPair(b.id, blockedId) : null;
      if (pair) {
        setBlockerPair({ conflict: pair, blockerCallsign: b.callsign });
        setSelectedConflictId(pair.id);
        setPreviewModalOpen(true);
        return;
      }
      // Nothing to pair it with (the blocked flight is gone): the honest
      // fallback is still to put the aircraft on the map.
      const i = idxByFlightKey.get(b.id);
      if (i != null) {
        setPreviewModalOpen(false);
        lockOnFlight(i);
      }
    },
    [notifConflicts, idxByFlightKey, lockOnFlight, makeBlockerPair],
  );

  // Resolutions shown in the INLINE notification cards. These use the SAME
  // plan-validated engine as the Preview modal (full-trajectory what-ifs,
  // carrying the exact validated timing) — so the two ALWAYS agree: an auto
  // resolution appears in both or neither. No fallback to the realtime advisory
  // (whose short-horizon what-ifs can disagree with the modal and offer fixes
  // that don't actually clear).
  const inlineSuggestions = useMemo<
    (Maneuver & {
      timing?: { tManLocal: number; deviationSec: number; rejoinSec: number };
    })[]
  >(
    () =>
      planSuggestions.map((r) => ({
        ...r,
        timing: {
          tManLocal: r.tManLocal,
          deviationSec: r.deviationSec,
          rejoinSec: r.rejoinSec,
        },
      })),
    [planSuggestions],
  );

  // Preview / Apply of a suggestion. Preview computes the modified path once (on
  // click) and draws it dashed; Apply commits it into the trajectory so the
  // engine detects the resolution on the next tick. Both apply the maneuver at
  // the target flight's current route-local time.
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [previewPts, setPreviewPts] = useState<{ lat: number; lon: number }[] | null>(
    null,
  );
  const [previewAtSec, setPreviewAtSec] = useState(0);

  const localManeuverTime = useCallback(
    (flightKey: string): { idx: number; tMan: number } => {
      const idx = trajectories.findIndex((t) => t.meta.flightKey === flightKey);
      const off = routeOffsets[idx] ?? 0;
      return { idx, tMan: simTRef.current - off };
    },
    [trajectories, routeOffsets],
  );

  const handlePreview = useCallback(
    (idx: number | null) => {
      setPreviewIdx(idx);
      if (idx == null) {
        setPreviewPts(null);
        return;
      }
      const m = inlineSuggestions[idx];
      if (!m) return;
      const { idx: ti, tMan } = localManeuverTime(m.target);
      if (ti < 0) return;
      // Draw the preview with the SAME (validated) timing Apply will use, so the
      // dashed path matches what gets committed.
      const modified = m.timing
        ? applyManeuver(trajectories[ti], m, m.timing.tManLocal, {
            deviationSec: m.timing.deviationSec,
            rejoinSec: m.timing.rejoinSec,
            bankAngleDeg: cdr.config.bankAngleDeg,
          })
        : applyManeuver(trajectories[ti], m, tMan);
      setPreviewPts(modified.points.map((p) => ({ lat: p.lat, lon: p.lon })));
      setPreviewAtSec(Math.round(simTRef.current));
    },
    [inlineSuggestions, trajectories, localManeuverTime, cdr.config],
  );

  // Commit a maneuver into the target flight's trajectory (the shared write
  // path for both the suggestion cards and the Preview modal). Keeps playback
  // where it is, logs the fix against the currently-open conflict, and clears
  // that conflict's toast.
  const commitManeuver = useCallback(
    (
      m: Pick<Maneuver, "type" | "target" | "instruction" | "resolution"> & {
        // Optional plan-resolution detail for the "from → to" readout.
        targetCallsign?: string;
        reason?: string;
        origDCpaNm?: number;
        newDCpaNm?: number;
        origVertFt?: number;
        newVertFt?: number;
        timing?: { tManLocal: number; deviationSec: number; rejoinSec: number };
      },
      // Explicit conflict to log the fix against — used by auto-resolve, which
      // has no "selected" conflict. Falls back to `selectedConflictId`.
      forConflict?: { id: string; a: string; b: string },
    ) => {
      const { idx: ti } = localManeuverTime(m.target);
      if (ti < 0) return;
      const off = routeOffsets[ti] ?? 0;
      // Prefer the exact timing the maneuver was validated with (from the modal /
      // advisory); recomputing it from the current track would apply a different,
      // unvalidated maneuver. Fall back to a kinematic recompute otherwise.
      let timing = m.timing
        ? { tMan: m.timing.tManLocal, deviationSec: m.timing.deviationSec, rejoinSec: m.timing.rejoinSec }
        : null;
      if (!timing) {
        const live = cdr.conflicts.find((x) => x.id === selectedConflictId);
        const plan = planConflicts.find((x) => x.id === selectedConflictId);
        const tCpaAbs = plan
          ? plan.tCpaAbsSec
          : live
            ? simTRef.current + live.tCpa
            : simTRef.current + 300;
        const stNow = aircraftAt(
          toSamples(trajectories[ti].points),
          Math.max(0, simTRef.current - off),
        );
        timing = maneuverTiming(
          stNow?.gsKt ?? 450,
          stNow?.track ?? 0,
          tCpaAbs,
          off,
          simTRef.current,
          m,
          cdr.config,
        );
      }
      // Snapshot the pre-fix path + the value the maneuver is about to change,
      // BEFORE the trajectory is replaced — that's the only moment either is
      // still available for the dashboard's before/after map overlay.
      const beforeTraj = trajectories[ti];
      const beforePath = beforeTraj.points.map((p) => ({ lat: p.lat, lon: p.lon }));
      const fromLabel = fmtFromValue(
        m.type,
        aircraftAt(toSamples(beforeTraj.points), Math.max(0, timing.tMan)),
      );
      const modified = applyManeuver(beforeTraj, m, timing.tMan, {
        deviationSec: timing.deviationSec,
        rejoinSec: timing.rejoinSec,
        bankAngleDeg: cdr.config.bankAngleDeg,
      });
      restorePlaybackRef.current = { t: simTRef.current, playing: playingRef.current };
      setTrajectories((prev) => prev.map((t, i) => (i === ti ? modified : t)));
      // Keep the DOWNLOAD in sync with the fix: re-cache the backend export from
      // the modified points so every download format serves the post-fix path.
      void recacheTrajectory(modified.meta.flightKey, modified.points);
      setPreviewIdx(null);
      setPreviewPts(null);
      setPreviewModalOpen(false);
      const c =
        forConflict ??
        planConflicts.find((x) => x.id === selectedConflictId) ??
        cdr.conflicts.find((x) => x.id === selectedConflictId);
      if (c) {
        // Who issued it. Captured NOW, because the airspace the pair occupies
        // moves on but the unit that was responsible does not.
        const cpaAbs =
          "tCpaAbsSec" in c
            ? (c as { tCpaAbsSec: number }).tCpaAbsSec
            : simTRef.current + ((c as { tCpa?: number }).tCpa ?? 0);
        const unit = sectorOfConflict(c, cpaAbs);
        setAppliedFixes((prev) => [
          {
            conflictId: c.id,
            a: c.a,
            b: c.b,
            target: m.target,
            instruction: m.instruction,
            appliedAtSec: Math.round(simTRef.current),
            sector: unit?.label || undefined,
            sectorCoordination: unit?.coordination || undefined,
            maneuverType: m.type,
            targetCallsign: m.targetCallsign,
            reason: m.reason,
            beforeSepNm: m.origDCpaNm,
            afterSepNm: m.newDCpaNm,
            beforeVertFt: m.origVertFt,
            afterVertFt: m.newVertFt,
            beforePath,
            afterPath: modified.points.map((p) => ({ lat: p.lat, lon: p.lon })),
            fromLabel: fromLabel ?? undefined,
          },
          ...prev.filter((f) => f.conflictId !== c.id),
        ]);
      }
      const dismissId = forConflict?.id ?? selectedConflictId;
      if (dismissId) toasts.dismiss(dismissId);
    },
    [trajectories, routeOffsets, localManeuverTime, planConflicts, cdr.conflicts, cdr.config, selectedConflictId, toasts, sectorOfConflict],
  );

  const handleApply = useCallback(
    (idx: number) => {
      const m = inlineSuggestions[idx];
      if (m) commitManeuver(m);
    },
    [inlineSuggestions, commitManeuver],
  );

  // Top plan-validated resolution for ANY conflict (not just the selected one),
  // shaped like an inline suggestion so `commitManeuver` can apply it directly.
  // Returns null when the advisory engine finds no fix that actually clears the
  // conflict — auto-resolve then leaves it for manual handling.
  const topResolutionFor = useCallback(
    (
      c: PlanConflict,
    ):
      | (Maneuver & {
          timing: { tManLocal: number; deviationSec: number; rejoinSec: number };
        })
      | null => {
      const res = generatePlanResolutions({
        conflict: c,
        flights: planFlights,
        trajById,
        simT: simTRef.current,
        cfg: cdr.config,
        restricted: restrictedAreas,
        holdings,
      });
      const r = res[0];
      if (!r) return null;
      return {
        ...r,
        timing: {
          tManLocal: r.tManLocal,
          deviationSec: r.deviationSec,
          rejoinSec: r.rejoinSec,
        },
      };
    },
    [planFlights, trajById, cdr.config, restrictedAreas, holdings],
  );

  // Auto-resolve loop. A SELF-SCHEDULING stepper (not a dependency-driven
  // effect): on each tick it handles ONE conflict — apply the top validated
  // fix if one exists, mark the conflict tried (so an unresolvable one is never
  // re-validated), then schedule the next step. Each fix is validated against the
  // already-modified traffic (sequential, self-consistent).
  //
  // Why a timer loop and not an effect keyed on the conflicts: committing a fix
  // rebuilds the "all"-mode span (resets/re-seeks the sim clock) AND re-scans the
  // whole plan, which changes `planConflicts`/`commitManeuver` identities. An
  // effect keyed on those re-fires on every commit and runs the heavy
  // `generatePlanResolutions` + plan re-scan back-to-back with NO idle gap — that
  // pinned one CPU core at 100% and froze the tab. This loop instead reads the
  // latest state through refs and only ever does one heavy step per interval,
  // leaving a guaranteed gap for the browser to paint and stay responsive.
  //
  // The conflict SOURCE is the PLAN scan (`unresolvedPlanConflicts`), NOT the
  // realtime detector. Sourcing from the realtime look-ahead sounds more
  // controller-like, but it cannot work here: the detector only surfaces a pair
  // within `mtcdSec` (10 min) of CPA, while the cheapest resolutions need far
  // more lead time than that to bite. Reducing 40 kt opens 5 NM of along-track
  // spacing only after 5/40 h ≈ 7.5 min of flying, and that is the ideal case —
  // real crossing geometry converts less. So a conflict whose only fix is a
  // speed change was already unfixable by the time auto-resolve first saw it,
  // and rode to LOS with the dashboard cheerfully showing the fix it could have
  // applied 40 minutes earlier. The plan scan has the whole filed timeline from
  // the start, which is the entire point of a fast-time tool: deconflict
  // strategically, while there is still room to.
  //
  // Earliest CPA first, because an upstream fix re-times everything downstream.
  //
  // The attempt key is `id|leadBucket` (10-min buckets), NOT the id alone: a
  // pair the resolver can't clear now often becomes clearable later — traffic
  // around it has since been moved, or the aircraft has closed enough that a
  // holding fix on its route finally falls before the CPA (the hold candidate
  // needs that). So each conflict gets a fresh attempt every 10 minutes of
  // closure, up to 4 tries, instead of one for its whole life. Retrying every
  // tick instead would re-run the ~200 ms plan resolver back-to-back and pin the
  // CPU, which is what this whole timer loop exists to avoid.
  //: Longest the loop waits between fixes, and the shortest. The gap used to be
  //: a flat 400 ms — chosen when a single step could freeze the tab for a
  //: second, so the wait was cover for the work. With the scan now incremental
  //: (`rescanFlightPlanConflicts`) a step is a couple of milliseconds, and 400
  //: ms of idling per conflict is what a long pass is made of: 831 of them is
  //: 5 minutes of doing nothing. So the loop paces itself instead — it waits as
  //: long as the step it just ran took, which holds the main thread at roughly
  //: half duty cycle whatever the fleet size, and never longer than the old
  //: fixed gap.
  const AUTO_STEP_MAX_MS = 400;
  const AUTO_STEP_MIN_MS = 16; // one frame — still lets React paint
  /** Toast identity of the "before replay" pass summary (not a conflict id). */
  const AUTO_PASS_TOAST_ID = "auto-resolve-pass";
  const AUTO_RETRY_BUCKET_SEC = 600;
  /** Skip a conflict this close to CPA — nothing can be applied in time. */
  const AUTO_MIN_LEAD_SEC = 30;
  const autoTriedRef = useRef<Set<string>>(new Set());
  const autoTryKey = (c: { id: string }, leadSec: number) =>
    `${c.id}|${Math.min(3, Math.floor(Math.max(0, leadSec) / AUTO_RETRY_BUCKET_SEC))}`;
  // Live snapshots read by the timer callback (so the loop needn't re-subscribe
  // on every render — which is what caused the back-to-back heavy work).
  const autoStateRef = useRef({
    unresolvedPlanConflicts,
    stcaSec: cdr.config.lookahead.stcaSec,
    topResolutionFor,
    commitManeuver,
    toasts,
    nameOf,
    pause: sim.pause,
    seek: sim.seek,
  });
  autoStateRef.current = {
    unresolvedPlanConflicts,
    stcaSec: cdr.config.lookahead.stcaSec,
    topResolutionFor,
    commitManeuver,
    toasts,
    nameOf,
    pause: sim.pause,
    seek: sim.seek,
  };
  /** Running tally of the up-front pass, read by the step without re-rendering. */
  const autoPassCountsRef = useRef({ fixed: 0, unfixed: 0 });
  // Identity of the loaded flight SET. Stable across fixes (a maneuver only
  // rewrites one trajectory's points, never its flightKey), so keying the
  // up-front pass on this re-runs it for a newly generated set without
  // restarting it on every fix it applies — which `trajectories` would.
  const flightSetKey = useMemo(
    () =>
      trajectories
        .map((t) => t.meta.flightKey)
        .sort()
        .join("|"),
    [trajectories],
  );
  //
  // WHEN the loop runs is the operator's choice (`autoResolveMode`):
  //   "during" — steps against the LIVE clock, so a conflict is handled as the
  //              replay approaches it (lead time = CPA − current sim time);
  //   "before" — one batch pass with the clock parked at t=0 and playback
  //              paused, so every fix is planned with the whole filed timeline
  //              of lead time available and the replay starts deconflicted. The
  //              pass ends when the queue drains (with the clock stopped, no new
  //              conflict can mature into range) and posts a summary.
  useEffect(() => {
    if (autoResolveMode === "off" || !cdrMonitoring) {
      autoTriedRef.current.clear(); // fresh opt-in re-attempts everything
      setAutoPass(null);
      return;
    }
    const upfront = autoResolveMode === "before";
    autoTriedRef.current.clear();
    if (upfront) {
      // Park the clock at the start: `topResolutionFor` plans from `simT`, and
      // a fix applied to traffic already halfway down the route has far less
      // room to work with than the same fix planned off-block.
      autoStateRef.current.pause();
      autoStateRef.current.seek(0);
      autoPassCountsRef.current = { fixed: 0, unfixed: 0 };
      setAutoPass({ fixed: 0, unfixed: 0, done: false });
    } else {
      setAutoPass(null);
    }
    let cancelled = false;
    let timer: number | null = null;
    const step = () => {
      if (cancelled) return;
      const t0 = performance.now();
      try {
        const s = autoStateRef.current;
        const now = upfront ? 0 : simTRef.current;
        const leadOf = (c: PlanConflict) => c.tCpaAbsSec - now;
        // Soonest CPA first (the queue is pre-sorted), skipping anything already
        // attempted at this lead and anything too close to act on.
        const pc = s.unresolvedPlanConflicts.find(
          (c) =>
            leadOf(c) > AUTO_MIN_LEAD_SEC &&
            !autoTriedRef.current.has(autoTryKey(c, leadOf(c))),
        );
        if (pc) {
          const lead = leadOf(pc);
          autoTriedRef.current.add(autoTryKey(pc, lead)); // once per lead bucket
          const m = s.topResolutionFor(pc);
          const dt = Math.round(performance.now() - t0);
          // eslint-disable-next-line no-console
          console.debug(
            `[auto-resolve:${autoResolveMode}] ${pc.id} T−${Math.round(lead / 60)}min → ${m ? m.type + " " + (m.instruction ?? "") : "no fix"} (${dt}ms)`,
          );
          if (m) {
            s.commitManeuver(m, { id: pc.id, a: pc.a, b: pc.b });
            if (upfront) {
              autoPassCountsRef.current.fixed += 1;
              setAutoPass({ ...autoPassCountsRef.current, done: false });
            }
            // Pop a green confirmation of what auto-resolve just did.
            s.toasts.upsert({
              conflictId: pc.id,
              severity: lead <= s.stcaSec ? "STCA" : "MTCD",
              kind: "auto",
              title: `Auto-resolved · ${s.nameOf(m.target)}`,
              body: m.instruction || "resolution applied",
            });
          } else if (upfront) {
            // No validated fix — it stays on the dashboard for manual handling.
            autoPassCountsRef.current.unfixed += 1;
            setAutoPass({ ...autoPassCountsRef.current, done: false });
          }
        } else if (upfront) {
          // Queue drained: every plan conflict has been fixed or tried once.
          cancelled = true;
          const counts = autoPassCountsRef.current;
          setAutoPass({ ...counts, done: true });
          s.toasts.upsert({
            conflictId: AUTO_PASS_TOAST_ID,
            severity: "MTCD",
            kind: "auto",
            title: "Auto-resolve complete · before replay",
            body: `${counts.fixed} fixed · ${counts.unfixed} left for manual action`,
          });
          return;
        }
      } catch (err) {
        // Never let a bad resolution kill the loop or freeze the tab silently.
        // eslint-disable-next-line no-console
        console.error("[auto-resolve] step failed:", err);
      }
      // Keep polling: re-scans surface new conflicts as fixes re-time traffic.
      // Pace by what this step actually cost (see AUTO_STEP_MAX_MS): a cheap
      // step comes back next frame, an expensive one leaves the same amount of
      // time free for the UI before the next.
      if (!cancelled) {
        const spentMs = performance.now() - t0;
        timer = window.setTimeout(
          step,
          Math.max(AUTO_STEP_MIN_MS, Math.min(AUTO_STEP_MAX_MS, spentMs)),
        );
      }
    };
    timer = window.setTimeout(step, AUTO_STEP_MIN_MS);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [autoResolveMode, cdrMonitoring, autoPassNonce, flightSetKey]);

  // Clear any preview when the open conflict changes, and expire a stale preview
  // after 10 s of sim time (the maneuver geometry it was drawn for has moved on).
  useEffect(() => {
    setPreviewIdx(null);
    setPreviewPts(null);
  }, [selectedConflictId]);
  // Turning CD&R off clears the sticky alerts (they'd otherwise linger).
  useEffect(() => {
    // Leaving "all" mode (no multi-aircraft picture) clears the sticky alerts.
    if (!cdrMonitoring) {
      toasts.clear();
      setHighlightFixId(null);
    }
  }, [cdrMonitoring, toasts.clear]);
  useEffect(() => {
    if (previewPts && simSec - previewAtSec > 10) {
      setPreviewIdx(null);
      setPreviewPts(null);
    }
  }, [simSec, previewAtSec, previewPts]);

  useEffect(() => {
    let cancelled = false;
    fetchAirways()
      .then((d) => !cancelled && setAirways(d))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setError(e instanceof Error ? e.message : "Failed to load data"),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the VY fix idents for the RouteBuilder picker.
  useEffect(() => {
    let cancelled = false;
    fetchRouteBuilderIdents()
      .then((ids) => !cancelled && setRouteIdents(ids))
      .catch(() => {
        /* picker simply shows nothing if the navdata can't be read */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch FIR once, the first time it is enabled.
  useEffect(() => {
    if (!firOn || fir || firLoading) return;
    setFirLoading(true);
    fetchFir()
      .then(setFir)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load FIR"),
      )
      .finally(() => setFirLoading(false));
  }, [firOn, fir, firLoading]);

  // Fetch each sector overlay once, the first time its layer is enabled.
  useEffect(() => {
    for (const s of SECTORS) {
      if (sectorsOn[s.key] && !sectorData[s.key]) {
        fetchSector(s.key)
          .then((d) => setSectorData((prev) => ({ ...prev, [s.key]: d })))
          .catch((e: unknown) =>
            setError(
              e instanceof Error ? e.message : `Failed to load ${s.label}`,
            ),
          );
      }
    }
  }, [sectorsOn, sectorData]);

  // Once any flight exists, load ALL sector polygons (regardless of toggle) so
  // the live airspace-membership readout has geometry to test against. The
  // visual overlay still renders only toggled layers, so this is invisible; the
  // files are small and HTTP-cached. Fetched lazily (not on mount) so a session
  // that never generates a flight pays nothing.
  useEffect(() => {
    if (trajectories.length === 0) return;
    for (const s of SECTORS) {
      if (!sectorData[s.key]) {
        fetchSector(s.key)
          .then((d) =>
            setSectorData((prev) =>
              prev[s.key] ? prev : { ...prev, [s.key]: d },
            ),
          )
          .catch(() => {
            /* membership just omits this layer if it can't load */
          });
      }
    }
  }, [trajectories.length, sectorData]);

  // Fetch the airway VOR / reporting points once, on first enable.
  useEffect(() => {
    if (airwayExtra.vor && !airwayVor) fetchAirwayVor().then(setAirwayVor).catch(() => {});
    if (airwayExtra.reporting && !airwayReporting)
      fetchAirwayReporting().then(setAirwayReporting).catch(() => {});
  }, [airwayExtra.vor, airwayExtra.reporting, airwayVor, airwayReporting]);

  // Airport list for the Layer Options "Airports" tab + map markers.
  useEffect(() => {
    let cancelled = false;
    fetchPanelAirports()
      .then((xs) => !cancelled && setAirportList(xs))
      .catch(() => {
        /* airports simply unavailable if the CSV can't be read */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Runways (threshold points) — fetched the first time they're shown.
  useEffect(() => {
    if (!showRunways || runways.length > 0) return;
    fetchRunways()
      .then(setRunways)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load runways"),
      );
  }, [showRunways, runways.length]);

  // Gates — fetched the first time the layer is enabled.
  useEffect(() => {
    if (!gatesOn || gates) return;
    fetchGates()
      .then(setGates)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load gates"),
      );
  }, [gatesOn, gates]);

  // PBN / ILS line data — like SID/STAR, fetched when the panel opens or a
  // routes layer is enabled (so the filter dropdowns can populate).
  const pbnNeedLines = layersOpen || pbn.routes;
  const ilsNeedLines = layersOpen || ils.routes;
  useEffect(() => {
    if (!pbnNeedLines || pbnLines) return;
    fetchPbnLines()
      .then(setPbnLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load PBN lines"),
      );
  }, [pbnNeedLines, pbnLines]);
  useEffect(() => {
    if (!ilsNeedLines || ilsLines) return;
    fetchIlsLines()
      .then(setIlsLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load ILS lines"),
      );
  }, [ilsNeedLines, ilsLines]);
  useEffect(() => {
    if (!pbn.waypoints || pbnWpts) return;
    fetchPbnWaypoints()
      .then(setPbnWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load PBN fixes"),
      );
  }, [pbn.waypoints, pbnWpts]);
  useEffect(() => {
    if (!ils.waypoints || ilsWpts) return;
    fetchIlsWaypoints()
      .then(setIlsWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load ILS fixes"),
      );
  }, [ils.waypoints, ilsWpts]);

  // SID/STAR line data — fetched once the Layer Options panel is opened
  // (so the filter dropdowns can populate) or a routes layer is enabled.
  const sidNeedLines = layersOpen || sid.routes;
  const starNeedLines = layersOpen || star.routes;
  useEffect(() => {
    if (!sidNeedLines || sidLines) return;
    fetchSidLines()
      .then(setSidLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load SID lines"),
      );
  }, [sidNeedLines, sidLines]);
  useEffect(() => {
    if (!starNeedLines || starLines) return;
    fetchStarLines()
      .then(setStarLines)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load STAR lines"),
      );
  }, [starNeedLines, starLines]);

  // SID/STAR waypoint data — fetched the first time Waypoints is enabled.
  useEffect(() => {
    if (!sid.waypoints || sidWpts) return;
    fetchSidWaypoints()
      .then(setSidWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load SID fixes"),
      );
  }, [sid.waypoints, sidWpts]);
  useEffect(() => {
    if (!star.waypoints || starWpts) return;
    fetchStarWaypoints()
      .then(setStarWpts)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load STAR fixes"),
      );
  }, [star.waypoints, starWpts]);

  // Holding patterns — fetched the first time the layer is switched on (three
  // files: the AIP holding table plus the ILS/PBN approaches the missed-approach
  // and HILPT holds are coded in).
  useEffect(() => {
    if (!holdingLayer.patterns || holdingPatterns || holdingLoading) return;
    setHoldingLoading(true);
    fetchHoldingPatterns()
      .then(setHoldingPatterns)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load holdings"),
      )
      .finally(() => setHoldingLoading(false));
  }, [holdingLayer.patterns, holdingPatterns, holdingLoading]);

  // AIRPORT / HOLDING dropdown options. Like the procedure tabs, the holding
  // idents cascade from the airport selection ("ENRT" = the enroute holds).
  const holdingOpts = useMemo(() => {
    const airports = new Set<string>();
    const idents = new Set<string>();
    for (const h of holdingPatterns ?? []) {
      airports.add(h.region);
      if (holdingLayer.airports.size === 0 || holdingLayer.airports.has(h.region)) {
        idents.add(h.ident);
      }
    }
    return {
      airports: [...airports].sort(),
      holdings: [...idents].sort(),
    };
  }, [holdingPatterns, holdingLayer.airports]);

  // Distinct airport / procedure options for the SID/STAR filter dropdowns.
  // PROCEDURE options cascade from the AIRPORT selection.
  const procOpts = (
    lines: ProcedureLineCollection | null,
    airportFilter: Set<string>,
  ) => {
    const airports = new Set<string>();
    const procs = new Set<string>();
    for (const f of lines?.features ?? []) {
      const a = f.properties.airport_identifier;
      if (a) airports.add(a);
      if (airportFilter.size === 0 || airportFilter.has(a)) {
        if (f.properties.procedure_identifier) {
          procs.add(f.properties.procedure_identifier);
        }
      }
    }
    return {
      airports: [...airports].sort(),
      procedures: [...procs].sort(),
    };
  };
  const sidOpts = useMemo(
    () => procOpts(sidLines, sid.airports),
    [sidLines, sid.airports],
  );
  const starOpts = useMemo(
    () => procOpts(starLines, star.airports),
    [starLines, star.airports],
  );
  const pbnOpts = useMemo(
    () => procOpts(pbnLines, pbn.airports),
    [pbnLines, pbn.airports],
  );
  const ilsOpts = useMemo(
    () => procOpts(ilsLines, ils.airports),
    [ilsLines, ils.airports],
  );

  // Cascading index for the direct lookup form: airport -> procedure ->
  // [transitions]. Built from the line collection.
  const buildIndex = (lines: ProcedureLineCollection | null) => {
    const idx: Record<string, Record<string, string[]>> = {};
    for (const f of lines?.features ?? []) {
      const a = f.properties.airport_identifier;
      const p = f.properties.procedure_identifier;
      const t = f.properties.transition_identifier ?? "";
      if (!a || !p) continue;
      (idx[a] ??= {});
      (idx[a][p] ??= []);
      if (t && !idx[a][p].includes(t)) idx[a][p].push(t);
    }
    for (const a of Object.keys(idx))
      for (const p of Object.keys(idx[a])) idx[a][p].sort();
    return idx;
  };
  const sidIndex = useMemo(() => buildIndex(sidLines), [sidLines]);
  const starIndex = useMemo(() => buildIndex(starLines), [starLines]);
  const pbnIndex = useMemo(() => buildIndex(pbnLines), [pbnLines]);
  const ilsIndex = useMemo(() => buildIndex(ilsLines), [ilsLines]);

  // Direct procedure lookup (form-driven): map the chosen transition to the
  // right query param and resolve via the procedures API.
  const lookupProcedure = useCallback(
    (
      type: "SID" | "STAR" | "PBN" | "ILS",
      airport: string,
      name: string,
      transition: string | null,
    ) => {
      const t = (transition ?? "").toUpperCase();
      const isRunway = t.startsWith("RW");
      return fetchProcedure(airport, name, {
        type,
        runway: isRunway ? transition ?? undefined : undefined,
        transition: isRunway ? undefined : transition ?? undefined,
      });
    },
    [],
  );

  // Airport list handlers for the panel.
  const toggleAirport = useCallback((code: string) => {
    setHiddenAirports((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);
  const showAllAirports = useCallback(() => setHiddenAirports(new Set()), []);
  const hideAllAirports = useCallback(
    () => setHiddenAirports(new Set(airportList.map((a) => a.code))),
    [airportList],
  );

  const waypoints: Waypoint[] = useMemo(
    () => (airways ? deriveWaypoints(airways) : []),
    [airways],
  );

  const isLoading = !airways && !error;

  // Remove one finished route by index — clears it from the map AND
  // from the toolbar / modal selections.
  function removeResultAt(i: number) {
    const removedKey = trajectories[i]?.meta.flightKey;
    const next = trajectories.filter((_, k) => k !== i);
    setTrajectories(next);
    setDownloads((xs) => xs.filter((_, k) => k !== i));
    // Drop the removed route's visibility entry so the set can't grow stale.
    if (removedKey) {
      setHiddenKeys((prev) => {
        if (!prev.has(removedKey)) return prev;
        const n = new Set(prev);
        n.delete(removedKey);
        return n;
      });
    }
    // And keep the playback source pointing at a still-existing route.
    setPlaybackIdx((p) => {
      if (p === "all") return next.length > 0 ? "all" : 0;
      if (p === i) return 0;
      if (p > i) return p - 1;
      return p;
    });
    if (next.length === 0) {
      setNav({ kind: "generator" });
    } else if (nav?.kind === "route") {
      const curRoute = nav;
      if (curRoute.routeIdx === i) {
        setNav({ kind: "route", routeIdx: 0, section: curRoute.section });
      } else if (curRoute.routeIdx > i) {
        setNav({
          kind: "route",
          routeIdx: curRoute.routeIdx - 1,
          section: curRoute.section,
        });
      }
    }
  }

  // The sidebar is mounted only when a nav item is active. The form
  // (GeneratorPanel) stays mounted across visits to keep its inputs.
  const sidebarVisible = nav !== null;

  // Route Profile "all routes" views: stage 1 narrows to the matched
  // flight(s); stage 2 optionally picks a route within them. Each row keeps
  // its original index for the R-tag / removal.
  const profileFlightRows = useMemo(() => {
    if (nav?.kind !== "all") return [];
    return trajectories
      .map((t, i) => ({ t, d: downloads[i], i }))
      .filter(
        (row): row is { t: TrajectoryResult; d: DownloadInfo; i: number } =>
          !!row.d,
      )
      .filter(({ t }) =>
        matchesFlight(profileFlightQuery, {
          callsign: t.meta.callsign,
          adep: t.meta.adep,
          ades: t.meta.ades,
        }),
      );
  }, [nav, trajectories, downloads, profileFlightQuery]);

  const profileRows = useMemo(
    () =>
      profileFlightRows.filter(({ d, i }) =>
        matchesRoute(profileRouteQuery, { route: d.route, index: i }),
      ),
    [profileFlightRows, profileRouteQuery],
  );

  const profileFlightSugg = useMemo(
    () =>
      flightOptions(
        trajectories.map((t) => ({
          callsign: t.meta.callsign,
          adep: t.meta.adep,
          ades: t.meta.ades,
        })),
      ),
    [trajectories],
  );
  const profileRouteSugg = useMemo(
    () =>
      routeOptions(
        profileFlightRows.map(({ t, d, i }) => ({
          route: d.route,
          index: i,
          distanceNm: t.stats.distanceNm,
        })),
      ),
    [profileFlightRows],
  );

  /**
   * Home — back to the Generator, the first page of a run.
   *
   * Everything the other tabs opened over it closes; nothing that has been
   * generated is thrown away. It does NOT put the opening screen back: the bar
   * is hidden there, so a Home that returned to it would take away the control
   * that was just used, and the way out of it again.
   */
  const goHome = useCallback(() => {
    setNav({ kind: "generator" });
    setSidebarOpen(true);
    setCdrView(null);
    setDepPanelOpen(false);
    setFilterOpen(false);
    setLayersOpen(false);
    setDownloadOpen(false);
    setMeasureOn(false);
    setMeasurePicks([]);
  }, []);

  const activeRouteLabel = (() => {
    if (nav?.kind === "all") {
      const sec =
        nav.section === "vertical"
          ? " · Vertical profile"
          : nav.section === "summary"
            ? " · Trajectory summary"
            : "";
      return trajectories.length === 1 && nav.section === "both"
        ? "R1"
        : `All routes${sec} (${trajectories.length})`;
    }
    if (nav?.kind !== "route") return null;
    const i = nav.routeIdx;
    if (i < 0 || i >= trajectories.length) return null;
    const sec =
      nav.section === "vertical" ? "Vertical profile" : "Trajectory summary";
    return `R${i + 1} · ${sec}`;
  })();

  /** Nothing generated yet, and not yet stepped past. */
  const firstRun = trajectories.length === 0 && !firstRunDismissed;

  /** Any aircraft-tag field on — the Trails panel's master "Flight Tags" row. */
  const flightTagsOn =
    tagFields.callsign ||
    tagFields.fl ||
    tagFields.ias ||
    tagFields.hdg ||
    tagFields.airspace;

  /**
   * What each global tab is and does, keyed by the ids in the tab registry.
   *
   * A tab is ACTIVE when the page or panel it leads to is the one currently
   * showing — that is the whole rule, and it is why nothing here has to track
   * "which tab did I press last".
   *
   * Memoised because the shell re-renders on every animation frame while the
   * replay runs: the bar is memoised too, and a fresh object each frame would
   * defeat that. Everything a menu reads stays here, where the map state is —
   * the bar only decides which dropdown is open.
   */
  const navSlots = useMemo<Partial<Record<MainNavId, MainNavSlot>>>(() => {
    const hasFlights = trajectories.length > 0;
    const noFlightsHint = "Generate a flight first";
    // The live checks measure one aircraft against another, so they need two
    // on the clock. The plan checks read the FILED plans instead, which is why
    // they are worth opening before anything has been replayed — and why the
    // departure half is reachable even with nothing generated at all.
    const conflictsReady = trajectories.length >= 2;
    const planCheckReady = hasFlights || depConflicts.length > 0;
    const sectorsAnyOn = SECTORS.some((sec) => sectorsOn[sec.key]);
    // Only the live count. It used to fall back to the filed departures when
    // the replay was not monitoring, which made one badge stand for two
    // different problems; the departures have their own tab to be counted on
    // now.
    const alertCount = cdrMonitoring ? unresolvedConflicts.length : 0;

    return {
      home: {
        active: nav?.kind === "generator",
        onSelect: goHome,
      },

      tool: {
        // The flight filter lives in this menu now (it used to have a tab of
        // its own), so an open filter panel is this tab's doing.
        active: profilePinsOn || measureOn || filterOpen,
        disabled: !hasFlights,
        hint: hasFlights ? undefined : noFlightsHint,
        menu: (close) => (
          <ToolMenu
            trailOpts={trailOpts}
            onTrailOpts={setTrailOpts}
            tagFields={tagFields}
            onTagFields={setTagFields}
            flightTagsOn={flightTagsOn}
            onFlightTagsToggle={(on) =>
              setTagFields(
                on
                  ? {
                      callsign: true,
                      fl: true,
                      ias: false,
                      hdg: false,
                      airspace: true,
                    }
                  : {
                      callsign: false,
                      fl: false,
                      ias: false,
                      hdg: false,
                      airspace: false,
                    },
              )
            }
            profilePinsOn={profilePinsOn}
            onProfilePins={() => setProfilePinsOn((v) => !v)}
            measureOn={measureOn}
            onMeasure={toggleMeasure}
            measurePicked={measurePicks.length}
            filterOpen={filterOpen}
            onFilter={() => {
              setFilterOpen((v) => !v);
              close();
            }}
          />
        ),
      },

      trajectory: {
        active: nav?.kind === "all" || nav?.kind === "route",
        disabled: !hasFlights,
        hint: hasFlights ? undefined : noFlightsHint,
        badge: hasFlights ? { text: String(trajectories.length) } : null,
        // Pressing the tab itself goes to the overview; the dropdown is the
        // shortcut to one section, or to one flight's section.
        onSelect: () => handleNavChange({ kind: "all", section: "both" }),
        menu: (close) => (
          <TrajectoryMenu
            nav={nav}
            onNavChange={handleNavChange}
            onPicked={close}
          />
        ),
      },

      conflicts: {
        active:
          cdrView === "notifications" ||
          cdrView === "dashboard" ||
          cdrView === "log",
        disabled: !conflictsReady,
        hint: conflictsReady
          ? undefined
          : "Generate two or more flights to check them against each other",
        badge: alertCount > 0 ? { text: String(alertCount), tone: "alert" } : null,
        onSelect: () => {
          // Detection runs on its own in "all" mode; switching here means the
          // menu never opens onto a view with no traffic to separate.
          if (hasFlights && safePlaybackIdx !== "all") setPlaybackIdx("all");
        },
        menu: (close) => (
          <ConflictsMenu
            cdrView={cdrView}
            onOpenView={openCdrView}
            monitoring={cdrMonitoring}
            unresolvedCount={unresolvedConflicts.length}
            logCount={conflictLogCount.total}
            autoResolve={autoResolve}
            autoResolveMode={autoResolveMode}
            autoModeOptions={AUTO_MODE_OPTIONS}
            onAutoResolveMode={setAutoResolveMode}
            onRerunAutoPass={() => setAutoPassNonce((n) => n + 1)}
            autoPass={autoPass}
            onPicked={close}
          />
        ),
      },

      // What is wrong with the plans as FILED — answered by re-timing a
      // departure or re-filing a route, not by a vector, which is why these
      // two are no longer rows under Conflicts.
      plancheck: {
        active: depPanelOpen || cdrView === "pdr",
        disabled: !planCheckReady,
        hint: planCheckReady ? undefined : noFlightsHint,
        badge:
          depConflicts.length > 0
            ? { text: String(depConflicts.length), tone: "alert" }
            : null,
        menu: (close) => (
          <PlanCheckMenu
            cdrView={cdrView}
            onOpenView={openCdrView}
            depConflictCount={depConflicts.length}
            depPanelOpen={depPanelOpen}
            onOpenDepartures={openDepPanel}
            pdrActionable={pdrActionable}
            onPicked={close}
          />
        ),
      },

      // Sector workload. Both views are built from the TRAJECTORIES, not from
      // the replay, so one flight is enough to open them — the conflict
      // columns simply read zero until monitoring has run.
      sector: {
        active: cdrView === "sectorinfo" || cdrView === "dynsector",
        disabled: !hasFlights,
        hint: hasFlights ? undefined : noFlightsHint,
        menu: (close) => (
          <SectorMenu
            cdrView={cdrView}
            onOpenView={openCdrView}
            onPicked={close}
          />
        ),
      },

      sequencing: {
        active: cdrView === "arrivals",
        disabled: trajectories.length < 2,
        hint:
          trajectories.length < 2
            ? "Generate two or more flights to sequence their arrivals"
            : undefined,
        onSelect: () => {
          if (safePlaybackIdx !== "all") setPlaybackIdx("all");
          openCdrView("arrivals");
        },
      },

      basemap: {
        menu: (close) => (
          <BasemapMenu
            basemap={basemap}
            onBasemap={setBasemap}
            onPicked={close}
          />
        ),
      },

      airspace: {
        active: sectorsAnyOn,
        menu: () => (
          <div className="mnav-group">
            <AirspaceBody
              sectorsOn={sectorsOn}
              onToggleSector={toggleSector}
              colorMode={sectorColorMode}
              onColorMode={setSectorColorMode}
            />
          </div>
        ),
      },

      layers: {
        active: layersOpen,
        menu: (close) => (
          <LayersMenu onOpenLayers={openLayers} onPicked={close} />
        ),
      },

      export: {
        active: downloadOpen,
        disabled: !hasFlights,
        hint: hasFlights ? undefined : noFlightsHint,
        onSelect: openDownload,
      },
    };
  }, [
    autoPass,
    autoResolve,
    autoResolveMode,
    basemap,
    cdrMonitoring,
    cdrView,
    conflictLogCount,
    depConflicts.length,
    depPanelOpen,
    downloadOpen,
    filterOpen,
    flightTagsOn,
    goHome,
    handleNavChange,
    layersOpen,
    measureOn,
    measurePicks.length,
    nav,
    openCdrView,
    openDepPanel,
    openDownload,
    openLayers,
    pdrActionable,
    profilePinsOn,
    safePlaybackIdx,
    sectorColorMode,
    sectorsOn,
    tagFields,
    toggleMeasure,
    toggleSector,
    trailOpts,
    trajectories.length,
    unresolvedConflicts.length,
  ]);

  return (
    <div
      className={`app theme-${theme}${firstRun ? " first-run" : ""}${
        previewMode ? " preview-mode" : ""
      }`}
      data-theme={theme}
    >
      {/* The blurred ground behind the opening generator. Clicking it steps
          past — the map is explorable before anything is generated, so this
          must not be a wall. */}
      {firstRun && (
        <button
          type="button"
          className="first-run-scrim"
          aria-label="Continue to the map"
          onClick={() => setFirstRunDismissed(true)}
        />
      )}

      {/* The application's own navigation, above everything it navigates.

          Two screens do without it. The preview page has one thing to do and
          one way back, and its own header says both. The OPENING screen has
          nothing to navigate: no flight exists, so seven of the eleven tabs are
          dead, and a row of greyed-out words is a worse first impression than
          no row at all. It appears the moment there is something to look at —
          a flight generated, or the scrim stepped past. */}
      {!previewMode && !firstRun && (
        <MainNavigation
          slots={navSlots}
          theme={theme}
          onTheme={applyTheme}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onToggleSidebar={toggleSidebar}
        />
      )}

      {/* The workspace under the bar: the Generator rail and the map it drives.
          Everything below is one PAGE of the application — which is why the bar
          is not inside it. (Left at this indent level deliberately: the wrapper
          is a layout row, and re-indenting a thousand lines to add one would
          bury the change.) */}
      <div className="main-content">
      <aside
        className={`sidebar${sidebarOpen ? " open" : ""}${
          sidebarVisible ? "" : " hidden"
        }`}
      >
        <div className="sidebar-header">
          <h1 className="brand">
            <span className="brand-ico" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  d="M5 12a7 7 0 0 1 7-7m0 14a7 7 0 0 0 7-7M8.5 12a3.5 3.5 0 0 1 3.5-3.5m0 7A3.5 3.5 0 0 0 15.5 12"
                />
                <circle cx="12" cy="12" r="1.4" fill="currentColor" />
              </svg>
            </span>
            Flight Trajectory Generator
          </h1>
          {trajectories.length > 0 && nav?.kind !== "generator" && (
            <span className="ready-badge">READY</span>
          )}
          {nav?.kind === "generator" && genStatus && (
            <span className="sidebar-ready">{genStatus}</span>
          )}
          {/* ✕ closes the workspace rail entirely, leaving the map under the
              global bar. Home brings it back. */}
          <button
            type="button"
            className="sidebar-close"
            onClick={() => {
              setNav(null);
              setSidebarOpen(false);
              // Closing the panel IS stepping past the opening screen; without
              // this the scrim would stay up over an empty centred card.
              setFirstRunDismissed(true);
            }}
            aria-label="Close the panel"
            title="Close the panel and show the whole map"
          >
            ✕
          </button>
        </div>

        {/* Which page of the workspace this is. Always shown, not just on a
            route: "Generator" is a page of the application now, and a page
            that never names itself leaves the bar above looking like the only
            navigation there is. */}
        {nav && (
          <p className="nav-breadcrumb">
            {activeRouteLabel ? (
              <>
                <button
                  className="nav-crumb-link"
                  onClick={() => setNav({ kind: "generator" })}
                >
                  Generator
                </button>
                <span>›</span>
                <strong>{activeRouteLabel}</strong>
              </>
            ) : (
              <strong>Generator</strong>
            )}
          </p>
        )}

        {/* GeneratorPanel is always mounted so its form state is
            preserved — visible only when nav.kind === "generator". */}
        <div
          style={{
            display: nav?.kind === "generator" ? "block" : "none",
          }}
        >
          <GeneratorPanel
            onResult={handleResult}
            onDownloadsChange={setDownloads}
            onPreviewChange={setPreviewRoutes}
            onCurrentPreviewChange={setCurrentPreview}
            onReadyChange={setGenStatus}
            waypointIdents={routeIdents}
            onPreview={enterPreview}
            onDepartureConflicts={setDepConflictState}
            onOpenDepartureConflicts={openDepPanel}
            onPdrPlanCheck={setPdrPlanState}
            onOpenPdrCheck={() => openCdrView("pdr")}
            focusPlan={planFocus}
            routeHandoff={routeHandoff}
          />
        </div>

        {nav?.kind === "route" &&
          trajectories[nav.routeIdx] &&
          downloads[nav.routeIdx] && (
            <RouteResultTabs
              key={downloads[nav.routeIdx].flightKey}
              trajectory={trajectories[nav.routeIdx]}
              download={downloads[nav.routeIdx]}
              routeIndex={
                trajectories.length > 1 ? nav.routeIdx + 1 : null
              }
              onRemove={() => removeResultAt(nav.routeIdx)}
              forceSection={nav.section}
              simT={playSimT(nav.routeIdx)}
              airspace={airspaceByKey[downloads[nav.routeIdx].flightKey]}
              airspaceSegmentsFor={airspaceSegmentsFor}
            />
          )}

        {nav?.kind === "all" && trajectories.length > 0 && (
          <div className="gen-all">
            <p className="rp-ready">
              {trajectories.length} flight
              {trajectories.length === 1 ? "" : "s"} ready
            </p>

            {/* Two-scope search: 1) pick a flight (callsign / ADEP-ADES),
                2) optionally a specific route within it (empty = all). */}
            <div className="rp-search">
              <div className="field-row">
                <label className="field">
                  <span>1 · Flight</span>
                  <SearchCombo
                    value={profileFlightQuery}
                    onChange={setProfileFlightQuery}
                    suggestions={profileFlightSugg}
                    placeholder="VYYY VYMD · UBA201 — empty = all flights"
                  />
                </label>
                <label className="field">
                  <span>2 · Route</span>
                  <SearchCombo
                    value={profileRouteQuery}
                    onChange={setProfileRouteQuery}
                    suggestions={profileRouteSugg}
                    placeholder="BGO W13 MIA · R2 — empty = all routes"
                  />
                </label>
              </div>
              <p className="rp-search-count">
                Showing <strong>{profileRows.length}</strong> of{" "}
                {trajectories.length}{" "}
                {trajectories.length === 1 ? "route" : "routes"}
              </p>
            </div>

            {/* Inline section tabs — mirror the "Route Profile ▾" dropdown.
                Overview lands with every card collapsed; Vertical / Summary
                expand the first card so its section is visible at a glance. */}
            <div className="rp-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={nav.section === "both"}
                className={nav.section === "both" ? "active" : undefined}
                onClick={() => setNav({ kind: "all", section: "both" })}
              >
                Overview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={nav.section === "vertical"}
                className={nav.section === "vertical" ? "active" : undefined}
                onClick={() => setNav({ kind: "all", section: "vertical" })}
              >
                Vertical
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={nav.section === "summary"}
                className={nav.section === "summary" ? "active" : undefined}
                onClick={() => setNav({ kind: "all", section: "summary" })}
              >
                Summary
              </button>
            </div>

            {/* Collapsible, colour-tagged route cards — expand any to reveal
                the active section. Heavy charts mount only when expanded. */}
            {profileRows.map(({ t, d, i }) => (
              <RouteResultTabs
                key={d.flightKey}
                trajectory={t}
                download={d}
                routeIndex={i + 1}
                onRemove={() => removeResultAt(i)}
                collapsible
                collapsed={!expandedKeys.has(d.flightKey)}
                onToggleCollapse={() => toggleExpanded(d.flightKey)}
                sectionMode={nav.section}
                simT={playSimT(i)}
                airspace={airspaceByKey[d.flightKey]}
                airspaceSegmentsFor={airspaceSegmentsFor}
              />
            ))}

            {profileRows.length === 0 && (
              <p className="rp-search-empty">
                No routes match this search. Clear the boxes to see all.
              </p>
            )}
          </div>
        )}
      </aside>

      {/* Click-away backdrop for the mobile drawer. */}
      {sidebarOpen && sidebarVisible && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="map-area">
        {/* Spans the shell rather than the map — fixed, so it sits over the
            rail as well. Outside the `airways` gate below: it carries the only
            way off this page, which must not wait on a data file. */}
        {previewMode && (
          <header className="preview-head">
            {/* On a phone the plan rail is an off-canvas drawer, and the tool
                menu that normally opens it is not on this page — so the way in
                has to be here. CSS hides it at widths where the rail is always
                on screen. */}
            <button
              type="button"
              className="preview-plans"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label="Show the plan list"
              title="Show the plan list"
            >
              ☰
            </button>
            <div className="preview-head-id">
              <h2 className="preview-head-title">Flight Preview</h2>
              {genStatus && (
                // The generator's own count, tightened: how many of the filed
                // plans have actually been flown. The rail's header is hidden
                // on this page so that this is the only place it is said.
                <span className="preview-head-status">
                  {genStatus.replace(/\s*\/\s*/, "/")}
                </span>
              )}
            </div>
            <button
              type="button"
              className="preview-back"
              onClick={exitPreview}
              title="Leave the preview and return to the console"
            >
              Back
            </button>
          </header>
        )}
        {/* A failed ACTION (e.g. a rejected downwind extension) must not take
            the map down with it: once the base data is in, the error shows as
            a dismissible banner over a still-live map. Only a failure that
            leaves us with no airways at all keeps the full-area message —
            there is nothing to draw in that case anyway. */}
        {error &&
          (airways ? (
            <div className="map-error" role="alert">
              <span>⚠ {error}</span>
              <button
                type="button"
                className="map-error-x"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                title="Dismiss"
              >
                ×
              </button>
            </div>
          ) : (
            <div className="status error">⚠ {error}</div>
          ))}
        {isLoading && <div className="status">Loading airway data…</div>}
        {airways && (
          <>
            {/* The map itself carries no navigation any more: Trails, Flight
                Tags, TOC/TOD, the filter, the conflict views and the layer
                menus are all tabs on the global bar above. What is left over
                the map is what is ABOUT the map — the status banners, the
                measurement readout and the playback strip. */}

            {/* Measure tool: armed, it says what to click next; with a pair
                picked it names them, and the numbers are on the map itself. */}
            {measureOn && (
              <div className="measure-chip" role="status" aria-live="polite">
                <span className="measure-chip-ico">
                  <NavIcon name="measure" size={15} />
                </span>
                <span className="measure-chip-text">
                  {measurePicks.length === 0
                    ? "Measure — click the first aircraft"
                    : measurePicks.length === 1
                      ? `${trajectories[measurePicks[0]]?.meta.flightKey ?? "—"} — click the second aircraft`
                      : `${trajectories[measurePicks[0]]?.meta.flightKey ?? "—"} ↔ ${trajectories[measurePicks[1]]?.meta.flightKey ?? "—"}`}
                </span>
                {measurePicks.length > 0 && (
                  <button
                    type="button"
                    className="measure-chip-btn"
                    onClick={clearMeasure}
                    title="Clear the pair and measure another"
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  className="measure-chip-btn"
                  onClick={toggleMeasure}
                  aria-label="Turn the measure tool off"
                  title="Turn the measure tool off"
                >
                  ✕
                </button>
              </div>
            )}
            <FilterPanel
              open={filterOpen && trajectories.length > 0}
              onClose={() => setFilterOpen(false)}
              trajectories={trajectories}
              aircraftTypes={aircraftTypes}
              filter={filter}
              onFilterChange={patchFilter}
              typeQuery={acTypeQuery}
              onTypeQueryChange={setAcTypeQuery}
              hiddenKeys={hiddenAircraft}
              onApplyHidden={applyAircraftHidden}
              onShowAll={showAllAircraft}
              onHideAll={hideAllAircraft}
              onInvert={invertAircraft}
              onToggleHidden={toggleAircraftHidden}
              onSelectFlight={selectFlight}
              activeIndex={followActive ? followIdx : detailIdx ?? safePlaybackIdx}
              playbackIdx={safePlaybackIdx}
              simT={sim.simT}
              airspace={airspaceByKey}
            />
            <DownloadModal
              open={downloadOpen}
              onClose={closeDownload}
              results={trajectories}
              downloads={downloads}
              onBeforeDownload={stampConflictMarks}
              onDownloadReport={handleDownloadReport}
              onViewReport={handleViewReport}
              reportProgress={reportProgress}
            />
            {/* What the red outline on the map is, and the way to clear it —
                the highlight outlives the panel that set it, so it needs to be
                dismissible from the map itself. */}
            {focusedAreas.length > 0 && (
              <div className="pdr-focus-chip" role="status">
                {focusedAreas.map((a) => (
                  <span key={a.ident} className="pdr-focus-one">
                    <span className={"pdr-area-class cls-" + a.kind}>{a.kind}</span>
                    <span className="pdr-focus-name">
                      {a.ident}
                      {a.name ? " " + a.name : ""}
                    </span>
                    <button
                      type="button"
                      className="pdr-focus-clear"
                      onClick={() =>
                        setFocusedAreas((prev) =>
                          prev.filter((x) => x.ident !== a.ident),
                        )
                      }
                      aria-label={"Stop showing " + a.ident}
                      title={"Stop showing " + a.ident}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="pdr-focus-back"
                  onClick={() => openCdrView("pdr")}
                  title="Back to the route &amp; area check"
                >
                  ← Check
                </button>
                <button
                  type="button"
                  className="pdr-focus-clear"
                  onClick={() => setFocusedAreas([])}
                  aria-label="Clear every highlighted area"
                  title="Clear all"
                >
                  ✕
                </button>
              </div>
            )}

            <LayerOptions
              open={layersOpen}
              onClose={() => setLayersOpen(false)}
              initialTab={layersTab}
              airportList={airportList}
              hiddenAirports={hiddenAirports}
              onToggleAirport={toggleAirport}
              onShowAllAirports={showAllAirports}
              onHideAllAirports={hideAllAirports}
              showRunways={showRunways}
              onShowRunways={setShowRunways}
              runwayLabels={runwayLabels}
              onRunwayLabels={setRunwayLabels}
              gatesOn={gatesOn}
              onGatesOn={setGatesOn}
              airwaysOn={showAirways}
              onAirwaysOn={setShowAirways}
              airway={airwayExtra}
              onAirwayChange={setAirwayExtra}
              waypointsOn={showWaypoints}
              onWaypointsOn={setShowWaypoints}
              firOn={firOn}
              onFirOn={setFirOn}
              firLoading={firLoading}
              onProcHighlight={setHighlightProc}
              sid={{
                state: sid,
                onChange: setSid,
                airportOpts: sidOpts.airports,
                procOpts: sidOpts.procedures,
                index: sidIndex,
                lookup: (a, n, t) => lookupProcedure("SID", a, n, t),
              }}
              star={{
                state: star,
                onChange: setStar,
                airportOpts: starOpts.airports,
                procOpts: starOpts.procedures,
                index: starIndex,
                lookup: (a, n, t) => lookupProcedure("STAR", a, n, t),
              }}
              pbn={{
                state: pbn,
                onChange: setPbn,
                airportOpts: pbnOpts.airports,
                procOpts: pbnOpts.procedures,
                index: pbnIndex,
                lookup: (a, n, t) => lookupProcedure("PBN", a, n, t),
              }}
              ils={{
                state: ils,
                onChange: setIls,
                airportOpts: ilsOpts.airports,
                procOpts: ilsOpts.procedures,
                index: ilsIndex,
                lookup: (a, n, t) => lookupProcedure("ILS", a, n, t),
              }}
              holding={holdingLayer}
              onHoldingChange={setHoldingLayer}
              holdingAirportOpts={holdingOpts.airports}
              holdingOpts={holdingOpts.holdings}
              holdingLoading={holdingLoading}
            />
            <LeafletMap
              basemap={basemap}
              airways={showAirways ? airways : null}
              airwayPts={{
                vor: airwayExtra.vor ? airwayVor : null,
                reporting: airwayExtra.reporting ? airwayReporting : null,
                labels: airwayExtra.labels ? airways : null,
                opacity: airwayExtra.opacity,
              }}
              waypoints={showWaypoints ? waypoints : null}
              fir={firOn ? fir : null}
              sectors={Object.fromEntries(
                SECTORS.filter((s) => sectorsOn[s.key]).map((s) => [
                  s.key,
                  sectorData[s.key] ?? null,
                ]),
              )}
              sectorColorMode={sectorColorMode}
              sidLines={sidLines}
              starLines={starLines}
              sidWpts={sidWpts}
              starWpts={starWpts}
              pbnLines={pbnLines}
              pbnWpts={pbnWpts}
              ilsLines={ilsLines}
              ilsWpts={ilsWpts}
              holdings={holdingPatterns}
              holding={holdingLayer}
              sid={sid}
              star={star}
              pbn={pbn}
              ils={ils}
              airports={airportList}
              hiddenAirports={hiddenAirports}
              gates={gatesOn ? gates : null}
              runways={showRunways ? runways : null}
              runwayLabels={runwayLabels}
              highlightProc={highlightProc}
              onProcedureClick={handleProcedureClick}
              trajectories={trajectories}
              showTrails={trailOpts.show}
              flColorTrails={trailOpts.flColor}
              colorBy={trailOpts.colorBy}
              trailDecaySec={trailOpts.decaySec}
              trailWeight={trailOpts.weight}
              showProfilePins={profilePinsOn}
              hiddenKeys={hiddenKeys}
              hiddenAircraft={hiddenAircraft}
              typeFilter={acTypeQuery}
              tagFields={tagFields}
              airspace={airspaceByKey}
              previewRoutes={
                previewHidden
                  ? []
                  : previewScope === "current"
                    ? currentPreview
                    : previewRoutes
              }
              simT={sim.simT}
              playbackIdx={safePlaybackIdx}
              followKey={cardTraj?.meta.flightKey}
              onAircraftClick={handleAircraftClick}
              onAircraftHover={handleAircraftHover}
              measureOn={measureOn}
              measurePicks={measurePicks}
              onMapReady={onMapReady}
              highlightAreas={[
                ...focusedAreas.map((a) => ({
                  ident: a.ident,
                  name: a.name,
                  kind: a.kind,
                  mp: a.mp as number[][][][],
                })),
                // The configuration, dashed and in its own colours: cyan for a
                // band-box (sectors worked together), amber for airspace that
                // changes hands. Neither is the red of airspace to keep out of.
                ...dynamicHighlight,
              ]}
              cdrConflicts={cdrMonitoring ? cdr.conflicts : undefined}
              cdrTraffic={cdrMonitoring ? cdr.traffic : undefined}
              cdrSelectedId={selectedConflictId}
              cdrNameOf={nameOf}
              cdrPreview={arrivalPreviewPts ?? previewPts}
              cdrResolvedRoute={resolvedRoutePts}
              cdrOriginalRoute={arrivalPreviewPts ? arrivalOriginalPts : originalRoutePts}
              cdrResolvedLabel={resolvedRouteLabel}
              cdrOriginalLabel={originalRouteLabel}
            />
            {/* The preview page's own pair, centred at the foot of the frame:
                every filed route, or just the plan open in the rail. Rendered
                even with nothing to draw — disabled says "no routes yet",
                whereas an absent control says nothing at all. */}
            {previewMode ? (
              <div
                className="preview-actions"
                role="group"
                aria-label="What to preview"
              >
                <button
                  type="button"
                  className={`preview-act${
                    previewScope === "full" ? " active" : ""
                  }`}
                  onClick={() => setPreviewScope("full")}
                  disabled={previewRoutes.length === 0}
                  aria-pressed={previewScope === "full"}
                  title="Draw every route of every plan"
                >
                  Preview All
                </button>
                <button
                  type="button"
                  className={`preview-act${
                    previewScope === "current" ? " active" : ""
                  }`}
                  onClick={() => setPreviewScope("current")}
                  disabled={currentPreview.length === 0}
                  aria-pressed={previewScope === "current"}
                  title="Draw only the plan open in the rail"
                >
                  Preview Current
                </button>
              </div>
            ) : previewRoutes.length > 0 ? (
              <div className={`preview-fab${previewHidden ? " off" : ""}`}>
                <button
                  type="button"
                  className="preview-fab-toggle"
                  onClick={() => setPreviewHidden((v) => !v)}
                  aria-pressed={!previewHidden}
                  title={
                    previewHidden
                      ? "Show the live route preview"
                      : "Hide the live route preview"
                  }
                >
                  <span className="preview-fab-ico">
                    <NavIcon name={previewHidden ? "eye-off" : "eye"} size={15} />
                  </span>
                  {previewHidden ? "Show preview" : "Preview"}
                </button>
                {!previewHidden && (
                  <div
                    className="preview-fab-scope"
                    role="group"
                    aria-label="Preview scope"
                  >
                    <button
                      type="button"
                      className={previewScope === "full" ? "active" : undefined}
                      onClick={() => setPreviewScope("full")}
                      title="Preview every route (queued + the one being edited)"
                    >
                      Full ({previewRoutes.length})
                    </button>
                    <button
                      type="button"
                      className={
                        previewScope === "current" ? "active" : undefined
                      }
                      onClick={() => setPreviewScope("current")}
                      disabled={currentPreview.length === 0}
                      title="Preview only the current flight (this tab's routes)"
                    >
                      Current
                    </button>
                  </div>
                )}
              </div>
            ) : null}
            <SimControls
              sim={sim}
              trajectories={trajectories}
              playbackIdx={safePlaybackIdx}
              onPlaybackIdxChange={setPlaybackIdx}
              hiddenKeys={hiddenKeys}
              onToggleRouteHidden={toggleRouteHidden}
              allRoutesHidden={allRoutesHidden}
              onToggleAllRoutes={toggleAllRoutesHidden}
            />
            {/* The key follows "Display by": the altitude scale, or the aircraft
                types on the map. Only one is ever up, in the same corner. */}
            {trajectories.length > 0 &&
              (trailOpts.colorBy === "type" ? (
                <AircraftTypeLegend types={trajectoryTypes} />
              ) : (
                <AltitudeLegend />
              ))}

            {/* CD&R toast notifications — NEW / ESCALATED conflicts. Clicking a
                toast opens the realtime notification stack. */}
            <ToastStack
              toasts={toasts.toasts}
              onDismiss={toasts.dismiss}
              onOpen={(id) => {
                // The "before replay" pass summary is not a conflict — it
                // has nothing to open, so clicking it just clears it.
                if (id === AUTO_PASS_TOAST_ID) {
                  toasts.dismiss(id);
                  return;
                }
                // An auto-resolve toast → open its "from → to" detail + highlight
                // the new route on the map. A conflict alert → open the stack.
                if (appliedFixes.some((f) => f.conflictId === id)) {
                  setHighlightFixId(id);
                } else {
                  setSelectedConflictId(id);
                  openCdrView("notifications");
                }
              }}
            />

            {/* Auto-resolve detail card — what changed, from → to. */}
            {highlightedFix && (
              <div className="cdr-fix-detail" role="dialog" aria-label="Applied fix detail">
                <div className="cdr-fix-detail-head">
                  {/* Only the auto-resolver fills in `reason`; a hand-applied
                      fix opened from the dashboard gets the neutral label. */}
                  <span className="cdr-fix-detail-ico">
                    {highlightedFix.reason ? (
                      <NavIcon name="auto" size={15} />
                    ) : (
                      <span aria-hidden>✓</span>
                    )}
                  </span>
                  <span className="cdr-fix-detail-title">
                    {highlightedFix.reason ? "Auto-resolved" : "Resolved"} ·{" "}
                    {highlightedFix.targetCallsign ?? nameOf(highlightedFix.target)}
                  </span>
                  <button
                    type="button"
                    className="cdr-fix-detail-close"
                    onClick={() => setHighlightFixId(null)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="cdr-fix-detail-body">
                  <div className="cdr-fix-detail-instr">
                    {highlightedFix.maneuverType && (
                      <span className="cdr-fix-detail-tag">
                        {highlightedFix.maneuverType}
                      </span>
                    )}
                    {highlightedFix.instruction}
                  </div>
                  {highlightedFix.beforeSepNm != null &&
                    highlightedFix.afterSepNm != null && (
                      <div className="cdr-fix-detail-row">
                        <span>Separation</span>
                        <span>
                          <b className="was">
                            {highlightedFix.beforeSepNm.toFixed(1)}
                          </b>{" "}
                          →{" "}
                          <b className="now">
                            {highlightedFix.afterSepNm.toFixed(1)} NM
                          </b>
                        </span>
                      </div>
                    )}
                  {highlightedFix.maneuverType === "flightlevel" &&
                    highlightedFix.beforeVertFt != null &&
                    highlightedFix.afterVertFt != null && (
                      <div className="cdr-fix-detail-row">
                        <span>Vertical gap</span>
                        <span>
                          <b className="was">{highlightedFix.beforeVertFt}</b> →{" "}
                          <b className="now">{highlightedFix.afterVertFt} ft</b>
                        </span>
                      </div>
                    )}
                  {highlightedFix.reason && (
                    <div className="cdr-fix-detail-reason">{highlightedFix.reason}</div>
                  )}
                  <div className="cdr-fix-detail-hint">
                    Old route faint &amp; dashed, new route glowing — hover either
                    for its readout
                  </div>
                </div>
              </div>
            )}

            {/* Departure conflicts — the pre-departure half, off the filed
                plans rather than the flown paths. Sits in the same rail; its
                Fix hands back to the generator panel, which owns the tabs. */}
            {depPanelOpen && depConflictState && (
              <DepartureConflictPanel
                conflicts={depConflicts}
                choiceFor={depChoiceFor}
                onChoiceFor={setDepChoiceFor}
                onIgnore={depConflictState.ignore}
                onIgnoreAll={depConflictState.ignoreAll}
                onAutoFixAll={depConflictState.autoFixAll}
                onFix={(conflictId, planId) => {
                  depConflictState.fix(conflictId, planId);
                  // Step out of the way: the suggested time is waiting on that
                  // plan's own EOBT field, over in the generator panel.
                  setDepChoiceFor(null);
                  setDepPanelOpen(false);
                }}
                onClose={() => {
                  setDepPanelOpen(false);
                  setDepChoiceFor(null);
                }}
              />
            )}

            {/* Realtime notification stack — the live conflicts within the
                look-ahead (MTCD → STCA → LOS), appearing/escalating/clearing.
                Selecting one expands its inline Preview/Apply cards (the Preview
                draws the modified path dashed on the main map; no popup). */}
            {cdrView === "notifications" && cdrMonitoring && (
              <NotificationPanel
                conflicts={notifConflicts}
                nameOf={nameOf}
                selectedId={selectedConflictId}
                onSelect={setSelectedConflictId}
                onClose={() => {
                  setCdrView(null);
                  setSelectedConflictId(null);
                }}
                appliedFixes={appliedFixes}
                sectorOf={(c) =>
                  sectorOfConflict(c, simTRef.current + c.tCpa)
                }
                renderAdvisory={(id) =>
                  id === selectedConflictId ? (
                    // SuggestionCards owns the empty state too — that's where
                    // the "blocked by X" readout lives.
                    <SuggestionCards
                      suggestions={inlineSuggestions}
                      nameOf={nameOf}
                      previewIdx={previewIdx}
                      onPreview={handlePreview}
                      onApply={handleApply}
                      blockers={planAdvisory.blockers}
                      blockerConflictOf={blockerConflictOf}
                      onWorkBlocker={(b, cid) =>
                        workBlocker(b, cid, blockedFlightId(selectedConflictId))
                      }
                      onEditBlockerPlan={(b) => handleOpenPlan(b.id)}
                      widened={planAdvisory.widened}
                      rejected={planAdvisory.rejected}
                    />
                  ) : null
                }
              />
            )}

            {/* Strategic dashboard — whole-plan losses of separation + fixed. */}
            {cdrView === "dashboard" && cdrMonitoring && (
              <ConflictPanel
                planConflicts={planConflicts}
                // The THROTTLED clock, not the animation one. Its countdowns
                // read to the second, but `sim.simT` changes every frame — and
                // at x100 with a day of traffic loaded that redrew the whole
                // list, airspace labels and all, 60 times a second.
                simT={airspaceSec}
                nameOf={nameOf}
                appliedFixes={appliedFixes}
                sectorOf={(c) => sectorOfConflict(c, c.tCpaAbsSec)}
                onClearFixes={() => setAppliedFixes([])}
                onOpenPreview={(id) => {
                  setSelectedConflictId(id);
                  setPreviewModalOpen(true);
                }}
                selectedFixId={highlightFixId}
                // Draw that fix's before/after routes and step out of the way —
                // the dashboard sits over the middle of the map, so it has to
                // close for the lines to be visible. The detail card that opens
                // top-right carries the same "what changed" readout.
                onSelectFix={(id) => {
                  setHighlightFixId((cur) => (cur === id ? null : id));
                  setCdrView(null);
                }}
                onClose={() => {
                  setCdrView(null);
                  setSelectedConflictId(null);
                }}
              />
            )}

            {/* Arrival ladder — landing order + in-trail spacing per runway. */}
            {cdrView === "arrivals" && cdrMonitoring && (
              // No per-flight selection state exists in MapApp yet, so rows
              // are informational; the panel's optional onSelect stays unused.
              <ArrivalPanel
                plans={arrivals.plans}
                onIssue={handleIssueArrivalFix}
                onPreview={handlePreviewArrivalFix}
                config={arrivals.config}
                contextOf={arrivals.contextOf}
                previewedId={arrivalPreview?.flightKey ?? null}
                previewHasTrack={!!arrivalPreview?.points}
                issued={issuedArrivalFixes}
                busy={busyArrivalFixes}
                clearanceOf={(id) =>
                  trajectories.find((t) => t.meta.flightKey === id)?.meta
                    .clearance
                }
                onClose={() => {
                  clearArrivalPreview();
                  setCdrView(null);
                }}
              />
            )}

            {/* The run's record — every encounter, and what answered it. */}
            {cdrView === "log" && cdrMonitoring && (
              <ConflictLogPanel
                log={conflictLog}
                utc={logUtc}
                onSelect={(id) => {
                  setSelectedConflictId(id);
                  openCdrView("dashboard");
                }}
                onClose={() => setCdrView(null)}
              />
            )}

            {/* PDR route check — restricted airspace + published-route rules.
                Not gated on cdrMonitoring: this reads the FILED PLANS against
                the AIRAC, so it is answerable the moment a flight exists and
                has nothing to do with whether live traffic monitoring is on. */}
            {cdrView === "pdr" && (
              <PdrPanel
                flights={
                  pdrShowsPlans
                    ? pdrPlanState!.flights
                    : pdrFlights.map((f) => ({
                        flightKey: f.flightKey,
                        callsign: f.callsign,
                        adep: f.adep,
                        ades: f.ades,
                      }))
                }
                reports={pdrShowsPlans ? pdrPlanState!.reports : pdr.reports}
                loading={pdrShowsPlans ? pdrPlanState!.loading : pdr.loading}
                error={pdrShowsPlans ? pdrPlanState!.error : pdr.error}
                validFrom={pdrShowsPlans ? pdrPlanState!.validFrom : pdr.validFrom}
                validTo={pdrShowsPlans ? pdrPlanState!.validTo : pdr.validTo}
                // Say which picture is on screen: a filed plan is checked on an
                // ESTIMATED climb/cruise/descent profile, a generated flight on
                // its real trajectory. The difference decides how much weight a
                // marginal finding deserves.
                sourceNote={
                  pdrShowsPlans
                    ? "Filed plans, before generation — profile estimated at 3 NM per 1000 ft. Re-checked against the real trajectory once generated."
                    : "Generated trajectories (" +
                      trajectories.length +
                      ") — real flown path, real times, SID/STAR included. Re-generate after editing a plan to re-check it."
                }
                selectedKey={pdrSelected}
                onSelect={setPdrSelected}
                onUseRoute={
                  pdrShowsPlans ? pdrPlanState!.useRoute : handleUseSuggestedRoute
                }
                // Only offered for filed plans: a generated flight's key is a
                // flightKey, which no longer identifies a plan tab.
                // Offered in BOTH views: a rejected generated flight is the
                // case where reaching the plan matters most.
                onOpenPlan={handleOpenPlan}
                onRetry={pdrShowsPlans ? pdrPlanState!.retry : pdr.retry}
                detailFor={
                  pdrShowsPlans ? pdrPlanState!.detailFor : pdr.detailFor
                }
                onFocusArea={handleFocusArea}
                shownAreas={focusedAreas.map((a) => a.ident)}
                rflFtOf={(k) =>
                  (pdrShowsPlans
                    ? pdrPlanState?.flights.find((f) => f.flightKey === k)
                    : pdrFlights.find((f) => f.flightKey === k)
                  )?.rflFt
                }
                onClose={() => setCdrView(null)}
              />
            )}

            {/* Per-sector, per-hour workload. Not gated on cdrMonitoring: the
                traffic counts are answerable from the trajectories alone, and
                the conflict columns simply read zero when no monitoring ran. */}
            {cdrView === "sectorinfo" && (
              <SectorInfoPanel
                // What the traffic was worked by, not how the AIP divides it.
                rows={effectiveSectorHours ?? sectorHours}
                byPosition={!!effectiveSectorHours}
                loading={sectorHoursLoading}
                flightCount={trajectories.length}
                dynamicConfig={dynConfig}
                onClose={() => setCdrView(null)}
              />
            )}

            {cdrView === "dynsector" && (
              <DynamicSectorPanel
                plan={dynamicPlan}
                inForce={positionsInForce(
                  effectiveSectors,
                  timelineOriginMs + sim.simT * 1000,
                )}
                applied={dynamicApplied}
                onRun={runDynamic}
                onApply={() => {
                  setDynamicPlan((p) => (p ? applyPlan(p) : p));
                  setDynamicApplied(true);
                }}
                onRevert={() => {
                  // Clear the stamp as well as the badge: they are the same
                  // claim, and an export that still said APPLIED after a revert
                  // would be the file disagreeing with the screen.
                  setDynamicPlan((p) => (p ? { ...p, appliedAt: null } : p));
                  setDynamicApplied(false);
                  setShownConfig(null);
                }}
                running={sectorHoursLoading}
                rows={sectorHours}
                loading={sectorHoursLoading}
                flightCount={trajectories.length}
                config={dynConfig}
                onConfig={setDynConfig}
                onView={setShownConfig}
                shownKey={shownConfig?.key ?? null}
                onClose={() => {
                  setShownConfig(null);
                  setCdrView(null);
                }}
              />
            )}

            {/* Before/after Preview & fix modal. */}
            {previewModalOpen &&
              (() => {
                // A synthesised blocker pair is not in the scan (it is not a
                // conflict on the current plan), so it is looked up separately.
                const scanned = planConflicts.find(
                  (x) => x.id === selectedConflictId,
                );
                const blk =
                  blockerPair?.conflict.id === selectedConflictId
                    ? blockerPair
                    : null;
                const c = scanned ?? blk?.conflict ?? null;
                if (!c) return null;
                const ia = trajectories.findIndex((t) => t.meta.flightKey === c.a);
                const ib = trajectories.findIndex((t) => t.meta.flightKey === c.b);
                if (ia < 0 || ib < 0) return null;
                return (
                  <PreviewModal
                    // Everything the modal holds — which aircraft to maneuver,
                    // the manual values — belongs to ONE pair. Re-aiming it at
                    // a blocker's conflict has to start it fresh.
                    key={c.id}
                    conflict={c}
                    trajA={trajectories[ia]}
                    trajB={trajectories[ib]}
                    offsetA={routeOffsets[ia] ?? 0}
                    offsetB={routeOffsets[ib] ?? 0}
                    simT={sim.simT}
                    planSuggestions={planSuggestions}
                    planBlockers={planAdvisory.blockers}
                    blockerConflictOf={blockerConflictOf}
                    // Re-aim the open modal at the blocker: its own conflict
                    // when it has one, otherwise the pair it is blocking. The
                    // `key` above remounts it, so no manual state carries over.
                    onWorkBlocker={(b, id) => workBlocker(b, id, targetOfPair(c))}
                    onEditBlockerPlan={(b) => {
                      setPreviewModalOpen(false);
                      setBlockerPair(null);
                      handleOpenPlan(b.id);
                    }}
                    blockerCallsign={blk?.blockerCallsign}
                    nameOf={nameOf}
                    config={cdr.config}
                    allFlights={planFlights}
                    restricted={restrictedAreas}
                    holdings={holdings}
                    sector={sectorOfConflict(c, c.tCpaAbsSec)}
                    // Pass `c` explicitly rather than letting commitManeuver fall
                    // back to its own planConflicts/cdr.conflicts lookup by
                    // selectedConflictId: a synthesised blocker pair's id (see
                    // `blk` above) is deliberately NOT in either of those lists,
                    // so that lookup always misses for it, `appliedFixes` never
                    // gets the entry, and "Fix <blocker> →" silently applies
                    // the maneuver to the trajectory without ever showing up as
                    // fixed anywhere in the UI. Passing `c` directly (the same
                    // object already resolved above, real or synthesised) is
                    // exactly the workaround auto-resolve already uses for the
                    // same reason ("which has no selected conflict" — see
                    // commitManeuver's `forConflict` param).
                    onApply={(m) => commitManeuver(m, { id: c.id, a: c.a, b: c.b })}
                    onClose={() => {
                      setPreviewModalOpen(false);
                      setBlockerPair(null);
                    }}
                  />
                );
              })()}

            {/* Flight detail card — live readout for the picked aircraft. When
                LOCKED (clicked on the map) the camera tracks it at centre and
                the header offers to unlock; when shown from a hover / Results
                click it's a read-only card that doesn't move the camera, and the
                header offers to lock on. ✕ dismisses it. */}
            {cardTraj && cardAircraft && cardIdx != null && (
              <div
                className={`follow-card${followActive ? " locked" : " detail"}`}
                role="dialog"
              >
                <div className="follow-card-head">
                  <button
                    type="button"
                    className="follow-card-toggle"
                    onClick={() => {
                      if (followActive) {
                        // Unlock but keep the card open as a detail readout.
                        setFollowActive(false);
                        setDetailIdx(cardIdx);
                      } else {
                        // Lock the camera onto this flight.
                        setFollowIdx(cardIdx);
                        setFollowActive(true);
                      }
                    }}
                    title={
                      followActive
                        ? "Click to unlock (stop following)"
                        : "Click to lock the camera on this aircraft"
                    }
                  >
                    <span className="follow-card-key">
                      {cardTraj.meta.flightKey}
                    </span>
                    <span className="follow-card-unlock">
                      <NavIcon name={followActive ? "lock" : "unlock"} size={12} />
                      {followActive ? "click to unlock" : "click to lock"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="follow-card-close"
                    onClick={() => {
                      setFollowActive(false);
                      setDetailIdx(null);
                    }}
                    aria-label="Close flight detail"
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                <dl className="follow-card-body">
                  <div>
                    <dt>ACID</dt>
                    <dd>{cardTraj.meta.callsign}</dd>
                  </div>
                  <div>
                    <dt>Type</dt>
                    <dd>{cardTraj.meta.aircraftType || "—"}</dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>
                      {cardTraj.meta.adep} → {cardTraj.meta.ades}
                    </dd>
                  </div>
                  <div>
                    <dt>FL</dt>
                    <dd>
                      {cardAircraft.altitudeFt != null
                        ? `FL${String(
                            Math.round(cardAircraft.altitudeFt / 100),
                          ).padStart(3, "0")}`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>GS</dt>
                    <dd>{Math.round(cardAircraft.gsKt)} kt</dd>
                  </div>
                  <div>
                    <dt>HDG</dt>
                    <dd>{Math.round(cardAircraft.track)}°</dd>
                  </div>
                  <div>
                    <dt>Sector</dt>
                    <dd>
                      {(() => {
                        // Controlled sector only — PDR (prohibited/danger/
                        // restricted) is EXCLUDED: those areas are assumed closed
                        // (an aircraft wouldn't be routed through an active one),
                        // so they shouldn't read as the plane's "sector".
                        const m = airspaceByKey[cardTraj.meta.flightKey];
                        return (
                          formatAirspace(
                            m ? { ...m, pdr: undefined } : m,
                            "full",
                          ) || "—"
                        );
                      })()}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd
                      className={`follow-card-status ${cardStatus ?? "enroute"}`}
                    >
                      {cardStatus === "arrived"
                        ? "Arrived"
                        : cardStatus === "scheduled"
                          ? "Scheduled"
                          : "En route"}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            {/* Procedure inspector — legs + constraints for a clicked
                SID/STAR track. */}
            {procView && (
              <div className="proc-panel">
                <div className="proc-panel-head">
                  <strong>
                    {procView.sel.type} · {procView.sel.name}
                  </strong>
                  <button
                    type="button"
                    className="proc-panel-close"
                    onClick={() => {
                      setProcView(null);
                      setHighlightProc(null);
                    }}
                    aria-label="Close procedure panel"
                  >
                    ✕
                  </button>
                </div>
                {procView.loading && (
                  <p className="proc-panel-status">Loading legs…</p>
                )}
                {procView.error && (
                  <p className="proc-panel-status error">{procView.error}</p>
                )}
                {procView.data && (
                  <>
                    <p className="proc-panel-sub">
                      {procView.data.airport}
                      {procView.data.runway ? ` · ${procView.data.runway}` : ""}
                      {procView.data.transition
                        ? ` · ${procView.data.transition}`
                        : ""}
                      {procView.data.assumptions.length > 0 && (
                        <em> (auto-picked)</em>
                      )}
                    </p>
                    <ol className="proc-leg-list">
                      {procView.data.legs.map((lg, i) => (
                        <li key={`${lg.seqno}-${i}`} className="proc-leg">
                          <span className="proc-leg-term">
                            {lg.path_terminator}
                          </span>
                          <span className="proc-leg-ident">
                            {lg.ident ?? "—"}
                          </span>
                          <span className="proc-leg-con">
                            {fmtAlt(lg.altitude)}
                            {fmtSpd(lg.speed) ? ` · ${fmtSpd(lg.speed)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </main>
      </div>
    </div>
  );
}
