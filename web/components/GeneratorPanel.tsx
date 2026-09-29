"use client";

/**
 * GeneratorPanel — click-driven UI for Phase 1.
 *
 * This panel does NO trajectory math. It collects inputs, calls the Python
 * FastAPI server (`/api/generate`), and shows the result. All parsing,
 * pyproj/WGS-84 geodesy and GeoPackage/CSV writing happen in the real
 * `trajectory_sim` package server-side — the web is just the front-end.
 *
 * Two input modes:
 *   - "Manual"       — fill the form by hand. The route itself can be a
 *                       typed Item-15 string, the point-and-click
 *                       RouteBuilder, or the pre-resolved airway CSV.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import IdentCombobox, { type ComboOption } from "@/components/IdentCombobox";
import RouteBuilder from "@/components/RouteBuilder";
import {
  fetchAirwaysMap,
  fetchAllFixes,
  type Fix,
} from "@/lib/aip";
import { fetchPanelAirports, type PanelAirport } from "@/lib/atcLayers";
import {
  staticApproaches,
  staticProcedureRunways,
  staticProcedureWaypoints,
  staticRunways,
} from "@/lib/geojson";
import {
  fetchApproachEntries,
  fetchProcedure,
  generateBatch,
  generateTrajectory,
  ingestTrajectory,
  listProcedures,
  type GenerateInput,
} from "@/lib/api";
import SearchCombo from "@/components/SearchCombo";
import {
  flightOptions,
  matchesFlight,
  matchesRoute,
  routeOptions,
} from "@/lib/flightSearch";
import { parseFlightFile, type FlightRecord } from "@/lib/flightFile";
import {
  resolvePreviewFromIdents,
  resolveRoutePreview,
  splicePreviewProcedures,
  type PreviewPoint,
} from "@/lib/routePreview";
import {
  estimateSimMin,
  fetchFlightTimeCurve,
  isSupportedCurve,
  type FlightTimeCurveResult,
} from "@/lib/flightTimeCurve";
import type { RouteOption } from "@/lib/routeFinder";
import {
  soleApproachFor,
  soleProcedure,
  soleRunwayOf,
} from "@/lib/procedureLink";
import {
  autoResolveDepartures,
  departsFromKnownField,
  eobtToMs,
  findDepartureConflicts,
  fmtInterval,
  hhmmZ,
  initialBearingDeg,
  msToEobt,
  resolvedEobtMs,
  type DepartureConflict,
  type DepartureFlight,
} from "@/lib/departureSeparation";
import {
  climbCruiseDescentFt,
  pathFromFixes,
} from "@/lib/pdr/penetration";
import { usePdrCheck, type PdrFlight } from "@/lib/pdr/usePdrCheck";
import type { PdrReport } from "@/lib/pdr/detect";
import {
  eobtMonth,
  runwayDefault,
  type RunwayDefault,
} from "@/lib/runwayDefault";
import {
  aipRouteOptions,
  fetchAipRoutes,
  type AipRoute,
} from "@/lib/aipRoutes";
import type { TrajectoryPoint, TrajectoryResult } from "@/lib/trajectory/types";
import NavIcon from "@/components/nav/NavIcon";

/** How the route portion is supplied: a typed Item-15 string, or one built
 *  fix by fix. */
type RouteMode = "fpl" | "build";

interface DownloadInfo {
  callsign: string;
  flightKey: string;
  route: string;
  gpkg: string;
  csv: string;
  geojson: string;
}

/** Great-circle distance (NM) between two WGS-84 points. */
function nmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3440.065;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Turn a file-imported 4D trajectory into a ready TrajectoryResult WITHOUT
 * regenerating — so a previously-downloaded (post-CD&R-fix) path loads exactly
 * as saved. Derives stats + TOC/TOD from the samples and registers the path with
 * the backend (`/api/ingest`) so its download files serve the same points.
 */
async function buildImportedResult(
  rec: FlightRecord,
): Promise<{ result: TrajectoryResult; download: DownloadInfo } | null> {
  const traj = rec.trajectory;
  if (!traj || traj.points.length < 2) return null;
  const pts = traj.points;
  const callsign = rec.callsign ?? "IMPORT";

  let distanceNm = 0;
  for (let i = 1; i < pts.length; i++) {
    distanceNm += nmBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  const t0 = Date.parse(pts[0].epoch_ts);
  const t1 = Date.parse(pts[pts.length - 1].epoch_ts);
  const timeMinutes =
    Number.isFinite(t0) && Number.isFinite(t1) ? (t1 - t0) / 60000 : 0;
  // Actual cruise altitude = the maximum STABLE altitude actually FLOWN (never
  // the requested FL): the highest sample that isn't a lone overshoot spike
  // (>100 ft above BOTH neighbours). The ±100 ft band below then spans the whole
  // level segment and ignores small cruise oscillations.
  let cruiseAltFt: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i].altitude_ft;
    if (a == null || !Number.isFinite(a)) continue;
    const prev = pts[i - 1]?.altitude_ft ?? a;
    const next = pts[i + 1]?.altitude_ft ?? a;
    const spike = a - prev > 100 && a - next > 100;
    if (!spike && (cruiseAltFt == null || a > cruiseAltFt)) cruiseAltFt = a;
  }
  const rflFt = rec.rfl
    ? rec.rfl * 100
    : cruiseAltFt
      ? Math.round(cruiseAltFt / 1000) * 1000
      : 0;

  // TOC / TOD from the ALTITUDE profile only (never phase). Per spec, with a
  // ±100 ft tolerance around the flown cruise:
  //   TOC = FIRST sample at/above cruiseAlt − 100 ft
  //   TOD = LAST  sample at/above cruiseAlt − 100 ft
  // When a real cruise exists these bracket it, so TOC index < TOD index (never
  // reversed). When the leg never levels off (climb→descent) they collapse to
  // one point and only TOC is shown. Robust for a leg that tops out below its
  // requested FL and is never labelled "cruise" by phase.
  const CRUISE_TOL_FT = 100;
  const cruiseFloor = (cruiseAltFt ?? 0) - CRUISE_TOL_FT;
  const atCruise = (p: TrajectoryPoint) => (p.altitude_ft ?? -Infinity) >= cruiseFloor;
  const profilePoint = (i: number) => ({
    lat: pts[i].lat,
    lon: pts[i].lon,
    altitudeFt: pts[i].altitude_ft ?? cruiseAltFt ?? 0,
    epochTs: pts[i].epoch_ts,
  });
  const tocIdx = cruiseAltFt != null ? pts.findIndex(atCruise) : -1;
  let todIdx = -1;
  if (cruiseAltFt != null) {
    for (let i = pts.length - 1; i >= 0; i--) {
      if (atCruise(pts[i])) {
        todIdx = i;
        break;
      }
    }
  }

  const ing = await ingestTrajectory({
    callsign,
    aircraftType: rec.actype,
    adep: rec.adep,
    ades: rec.ades,
    depRwy: rec.depRwy,
    arrRwy: rec.arrRwy,
    sid: rec.sid,
    star: rec.star,
    approach: rec.approach,
    routeStr: rec.route ?? rec.routes?.[0],
    rfl: rec.rfl,
    points: pts,
    // Carry the recovered fixes so a re-download keeps the waypoint column.
    fixes: traj.route.map((w) => ({ ident: w.ident, lat: w.lat, lon: w.lon })),
  });
  const flightKey =
    ing?.flightKey ??
    `${callsign}_${pts[0].epoch_ts.replace(/[^0-9A-Za-z]/g, "").slice(0, 13)}`;

  const result: TrajectoryResult = {
    route: traj.route,
    points: pts,
    stats: {
      waypointCount: traj.route.length,
      pointCount: pts.length,
      distanceNm: Math.round(distanceNm * 10) / 10,
      timeMinutes: Math.round(timeMinutes * 10) / 10,
      cruiseAltFt,
      rflFt,
    },
    profile: {
      toc: tocIdx >= 0 ? profilePoint(tocIdx) : null,
      // Only a distinct, LATER sample counts as TOD — never before/equal TOC.
      tod: todIdx > tocIdx ? profilePoint(todIdx) : null,
    },
    validation: null,
    meta: {
      flightKey,
      callsign,
      aircraftType: rec.actype ?? "",
      adep: rec.adep ?? "",
      ades: rec.ades ?? "",
      eobtIso: pts[0].epoch_ts,
    },
  };
  const download: DownloadInfo = {
    callsign,
    flightKey,
    route: rec.route ?? rec.routes?.[0] ?? "(imported)",
    gpkg: ing?.downloads.gpkg ?? "",
    csv: ing?.downloads.csv ?? "",
    geojson: ing?.downloads.geojson ?? "",
  };
  return { result, download };
}

/** One queued route + its terminal procedures = one generated flight.
 *  A plan's queue holds these combos so a single FPL can fly several
 *  (SID × route × STAR) combinations. Empty sid/star = direct / no procedure. */
interface RouteCombo {
  route: string;
  sid: string;
  star: string;
}

/** One editable flight plan in the multi-plan tab strip. The active tab's
 *  values live in the scalar editor state below; inactive tabs are stored
 *  as snapshots here, so the whole single-plan editor JSX is reused
 *  unchanged and tab-switching just serialises/restores these fields. */
interface PlanDraft {
  id: string;
  callsign: string;
  actype: string;
  adep: string;
  ades: string;
  eobt: string;
  gsKt: number;
  rfl: number;
  /** Transit level (hundreds of ft) when the flight is only passing through —
   *  set by an import of a track file that carries `entry_fl`. Not an editable
   *  field: it rides along with the plan so Generate flies it at level. */
  entryFl?: number;
  routeMode: RouteMode;
  routeStr: string;
  builtWpts: string[];
  /** Queued (SID × route × STAR) combinations — each becomes one flight. */
  routes: RouteCombo[];
  /** SID name (spliced at ADEP) / STAR name (spliced at ADES). "" = none.
   *  The editor's current pick; queued combos carry their own sid/star. */
  sid: string;
  star: string;
  /** Departure runway at ADEP / arrival runway at ADES (e.g. "RW21L").
   *  "" = let the engine auto-pick the procedure's first runway. */
  depRwy: string;
  arrRwy: string;
  /** PBN instrument approach (IAP) at ADES for the arrival runway, e.g.
   *  "R09-Z". "" = none (STAR descends straight to the field). */
  approach: string;
  /** IAF entry fix the route joins the approach at when more than one is on
   *  the route ("" = engine auto-scores it). */
  approachTransition: string;
}

/** How long after the last plan edit the route & area check re-runs. Long
 *  enough that typing a level or a callsign does not restart it per keystroke,
 *  short enough that the verdict feels tied to the edit. */
const PLAN_CHECK_DEBOUNCE_MS = 400;

/** How many times "Auto fix all" re-scans. Moving a flight makes it the
 *  neighbour of a different one, so the fix cascades; a handful of passes
 *  settles a normal bank, and the cap stops a pathological set (every flight
 *  filed at one minute) from looping. */
const AUTO_FIX_PASSES = 8;

let _planSeq = 0;
const nextPlanId = () => `p${++_planSeq}`;

function blankPlan(): PlanDraft {
  return {
    id: nextPlanId(),
    callsign: "",
    actype: "B738",
    adep: "",
    ades: "",
    eobt: "",
    gsKt: 450,
    rfl: 350,
    routeMode: "fpl",
    routeStr: "",
    builtWpts: [],
    routes: [],
    sid: "",
    star: "",
    depRwy: "",
    arrRwy: "",
    approach: "",
    approachTransition: "",
  };
}

/** The (route, sid, star) combos a draft will fly: the queued combos, else
 *  a single combo from the current editor route + sid/star, else none. */
function draftCombos(d: PlanDraft): RouteCombo[] {
  if (d.routes.length > 0) return d.routes;
  const eff =
    d.routeMode === "build"
      ? d.builtWpts.length
        ? `DCT ${d.builtWpts.join(" DCT ")} DCT`
        : ""
      : d.routeStr.trim();
  return eff ? [{ route: eff, sid: d.sid, star: d.star }] : [];
}

/** Short tab label for a plan. */
function planLabel(d: PlanDraft, i: number): string {
  return d.callsign.trim() || `Plan ${i + 1}`;
}

/** Cache key for a resolved procedure's preview geometry. Includes the route
 *  because the chosen transition (hence the fixes) depends on it. */
function procKey(
  airport: string,
  type: "SID" | "STAR",
  name: string,
  route = "",
): string {
  return `${airport.trim().toUpperCase()}|${type}|${name.trim().toUpperCase()}|${route.trim().toUpperCase()}`;
}

interface Props {
  /** Emits the generated trajectories (or null to clear) to the parent.
   *  An array so several routes can be flown/shown at once. */
  onResult: (results: TrajectoryResult[] | null) => void;
  /** Emits the matching download URLs alongside results. Lifted to the
   *  parent so the global nav bar + DownloadModal can read them. */
  onDownloadsChange?: (dl: DownloadInfo[]) => void;
  /** Live preview of all routes the user has in flight (the queued
   *  routes plus the one currently being typed/built), so the map can
   *  show each as a faint distinctly-coloured polyline in real time. */
  onPreviewChange?: (routes: PreviewPoint[][]) => void;
  /** Live preview of just the route currently being typed/built (the
   *  "section in progress") — emitted as a 0- or 1-element list so the map
   *  can offer a "Current" preview scope alongside the "Full" one. */
  onCurrentPreviewChange?: (routes: PreviewPoint[][]) => void;
  /** Emits a short "generated / planned flights" status for the panel
   *  header (shown beside the title, top-right). */
  onReadyChange?: (text: string) => void;
  /** Selectable waypoint idents (from the airway file) for RouteBuilder. */
  waypointIdents: string[];
  /** Departure conflicts between the FILED PLANS, plus the actions that resolve
   *  them. Emitted upward because the list belongs in the right-hand conflict
   *  rail with the other CD&R panels, while the plans (and the tab the fix
   *  redirects to) live in here. */
  onDepartureConflicts?: (state: {
    conflicts: DepartureConflict[];
    ignore: (conflictId: string) => void;
    ignoreAll: (conflictIds: string[]) => void;
    fix: (conflictId: string, planId: string) => void;
    autoFixAll: () => void;
  }) => void;
  /** Open that rail — the panel's own "N departure conflicts →" line calls it. */
  onOpenDepartureConflicts?: () => void;
  /** PDR route check over the FILED PLANS, before anything is generated, plus
   *  the action that applies a suggested route. Emitted upward for the same
   *  reason as the departure conflicts: the findings belong in the right-hand
   *  rail with the other CD&R panels, while the plans live in here. */
  onPdrPlanCheck?: (state: {
    flights: {
      flightKey: string;
      callsign: string;
      adep: string;
      ades: string;
      /** The level the check ran with, so the panel can show it. */
      rflFt: number;
    }[];
    reports: Map<string, PdrReport>;
    loading: boolean;
    error: string | null;
    validFrom: string | null;
    validTo: string | null;
    /** Put a published route in the plan's Item-15 field. Never generates. */
    useRoute: (flightKey: string, route: string) => void;
    /** Re-run the AIP data load after a failure. */
    retry: () => void;
    /** True while the bulk scan is still working through the plans. */
    scanning: boolean;
    /** Full report (alternatives included) for one plan, on demand. */
    detailFor: (flightKey: string) => PdrReport | undefined;
  }) => void;
  /** Open the PDR panel — the "N PDR route conflicts →" line calls it. */
  onOpenPdrCheck?: () => void;
  /** Bring a plan's tab to the front so its route can be edited by hand. Sent
   *  by the PDR panel's "Edit route in plan" button. `nonce` makes a repeat
   *  request for the same plan a new event. */
  /** Bring one plan's tab forward.
   *
   *  Addressed either by `planId` — what a filed plan carries — or by
   *  `match`, the callsign + city pair that identifies a plan before it has
   *  been flown. The PDR check uses the first while it is reading filed plans
   *  and the second once the flights are generated, since a trajectory has no
   *  plan id to hand back. */
  /** Leave the opening card and show these plans on the map, with the route
   *  and area checks open. Optional: without it the Preview button is not
   *  rendered at all, rather than rendered and inert. */
  onPreview?: () => void;
  focusPlan?: {
    planId?: string;
    match?: { callsign: string; adep: string; ades: string };
    nonce: number;
  } | null;
  /** A route the PDR check has staged for review.
   *
   *  It fills the matching plan's Item-15 route field and stops there: the
   *  flight is NOT regenerated, so the controller reads the routing and presses
   *  Generate themselves. Matched on callsign + city pair, which is what
   *  identifies a plan here (`flightKey` only exists once a plan has been
   *  flown). `nonce` makes a repeat handoff of the same route a new event. */
  routeHandoff?: {
    callsign: string;
    adep: string;
    ades: string;
    route: string;
    nonce: number;
  } | null;
}

/** Selectable aircraft types. Each maps to a real BADA 3.16 climb/descent
 *  rate table plus a per-type speed schedule / ceiling in performance.py;
 *  any other ICAO type still works (server falls back to the B738 model). */
const AIRCRAFT = [
  ["B738", "B738 — Boeing 737-800"],
  ["B739", "B739 — Boeing 737-900"],
  ["B38M", "B38M — Boeing 737 MAX 8"],
  ["A319", "A319 — Airbus A319"],
  ["A320", "A320 — Airbus A320"],
  ["A321", "A321 — Airbus A321"],
  ["A20N", "A20N — Airbus A320neo"],
  ["A21N", "A21N — Airbus A321neo"],
  ["A332", "A332 — Airbus A330-200"],
  ["A333", "A333 — Airbus A330-300"],
  ["A359", "A359 — Airbus A350-900"],
  ["B772", "B772 — Boeing 777-200"],
  ["B77W", "B77W — Boeing 777-300ER"],
  ["B788", "B788 — Boeing 787-8"],
  ["B789", "B789 — Boeing 787-9"],
  ["E190", "E190 — Embraer E190"],
  ["AT76", "AT76 — ATR 72-600"],
  ["DH8D", "DH8D — Dash 8 Q400"],
] as const;

/** Fallback airport list used only until the real airport CSV loads (free
 *  typing of any ICAO is always allowed). The live list comes from
 *  `fetchPanelAirports()` — all 48 Myanmar (VY) aerodromes from the AIXM
 *  2609 export. These three are the AIP "Main" aerodromes. */
const AIRPORTS_FALLBACK: ComboOption[] = [
  { code: "VYYY", label: "Yangon Intl" },
  { code: "VYMD", label: "Mandalay Intl" },
  { code: "VYNT", label: "Naypyitaw Intl" },
];

/** Title-case an ALL-CAPS AIP airport name for the dropdown label. */
function tidyAirportName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bInternational\b/i, "Intl");
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Provenance line under a runway picker: the month's measured default, the
 *  traffic behind it, and — when the user has picked something else — what
 *  the default was. Nothing is shown until an aerodrome + EOBT are set. */
function RwyDefaultHint({
  def,
  picked,
  month,
  kind,
}: {
  def: RunwayDefault | null;
  picked: string;
  month: number;
  kind: "departures" | "arrivals";
}) {
  if (!def || !month) return null;
  // README's reporting filter: below 100 movements or a single year, the
  // percentage is arithmetic rather than evidence — say so rather than
  // presenting it with the same confidence as a major hub's 17k movements.
  const thin = def.movements < 100 || def.nYears < 2;
  const stat = `${Math.round(def.pct)}% of ${def.movements.toLocaleString()} ${kind}`;
  const mon = MONTH_ABBR[month - 1];
  return (
    <span className={`field-hint${thin ? " thin" : ""}`}>
      {picked === def.ident
        ? `${mon} default · ${stat}`
        : `${mon} default: ${def.ident} · ${stat}`}
      {def.source === "ALL" ? " · both directions pooled" : ""}
      {thin ? " · thin sample" : ""}
    </span>
  );
}

// Memoised: this panel stays mounted (hidden via display:none) while the
// map aircraft animates, so MapApp re-renders it ~60×/sec. Its props are
// referentially stable (state setters + a useCallback'd onResult), so memo
// lets React skip reconciling this large tree on every animation frame.
function GeneratorPanel({
  onResult,
  onDownloadsChange,
  onPreviewChange,
  onCurrentPreviewChange,
  onReadyChange,
  waypointIdents,
  onDepartureConflicts,
  onOpenDepartureConflicts,
  onPdrPlanCheck,
  onOpenPdrCheck,
  focusPlan,
  routeHandoff,
  onPreview,
}: Props) {
  const [routeMode, setRouteMode] = useState<RouteMode>("fpl");

  /**
   * How this plan is being entered: typed in, or read from a file.
   *
   * A view switch only — both paths were already here and both still work. It
   * opens on "manual" because that is the empty-handed case: someone who has a
   * file knows they have one, someone who does not needs the form in front of
   * them.
   */
  const [entryMode, setEntryMode] = useState<"manual" | "import">("manual");

  const [callsign, setCallsign] = useState("");
  const [actype, setActype] = useState("B738");
  const [adep, setAdep] = useState("");
  const [ades, setAdes] = useState("");
  const [eobt, setEobt] = useState("");
  const [gsKt, setGsKt] = useState(450);
  const [rfl, setRfl] = useState(350);
  const [entryFl, setEntryFl] = useState<number | undefined>(undefined);

  // Surveillance Profile — output sampling cadence (seconds) applied to the
  // whole generation. 5 s = en-route radar (default), 4 s = CAT062 terminal
  // update rate, 1 s = high-rate, or a free "custom" value. Only changes
  // export density; flight time is unaffected.
  const [survMode, setSurvMode] = useState<"5" | "4" | "1" | "custom">("5");
  const [survCustom, setSurvCustom] = useState(5);
  const outputEveryS = Math.max(
    0.5,
    Math.min(60, survMode === "custom" ? survCustom : Number(survMode)),
  );

  // Phase-3 speed-schedule tuning (advanced, collapsed by default).
  // Empty string = use the airframe default for that field.
  // --- DISABLED: speed schedule (advanced) — kept for future use. ---
  // const [tuneOpen, setTuneOpen] = useState(false);
  // const [climbCas, setClimbCas] = useState("");
  // const [cruiseMach, setCruiseMach] = useState("");
  // const [descentCas, setDescentCas] = useState("");
  // const [descentMach, setDescentMach] = useState("");
  // const [restrictCas, setRestrictCas] = useState("");
  const [routeStr, setRouteStr] = useState("");
  const [builtWpts, setBuiltWpts] = useState<string[]>([]);
  /** Extra Item-15 routes to fly together (capped at #possible routes). */
  const [routes, setRoutes] = useState<RouteCombo[]>([]);
  // SID/STAR terminal procedures to splice (empty = none). Their option
  // lists are fetched per ADEP/ADES below.
  const [sid, setSid] = useState("");
  const [star, setStar] = useState("");
  // Selected runways: departure at ADEP / arrival at ADES ("" = auto-pick).
  const [depRwy, setDepRwy] = useState("");
  const [arrRwy, setArrRwy] = useState("");
  // PBN instrument approach at ADES for the arrival runway ("" = none). Its
  // option list is derived from the arrival runway below.
  const [approach, setApproach] = useState("");
  // Where to JOIN the approach when the route/STAR passes more than one of its
  // IAF entry fixes (e.g. an RNP approach reached via a STAR through both of
  // its IAFs). "" = auto (the engine scores it). `approachEntryMatches` is the
  // realtime list of on-route entry fixes; the join dropdown shows only when
  // it has more than one.
  const [approachTransition, setApproachTransition] = useState("");
  const [approachEntryMatches, setApproachEntryMatches] = useState<string[]>(
    [],
  );

  // --- Multi-plan tabs -----------------------------------------------------
  // The active tab's values live in the scalar state above. `plans` holds a
  // snapshot per tab; switching tabs serialises the current scalar state
  // into the outgoing plan and restores the incoming one. This lets one
  // run cover thousands of flights (a whole-network traffic day) without rebuilding
  // the editor for each.
  const initialPlanId = useRef<string>(nextPlanId());
  const [plans, setPlans] = useState<PlanDraft[]>(() => [
    { ...blankPlan(), id: initialPlanId.current },
  ]);
  const [activeId, setActiveId] = useState<string>(initialPlanId.current);
  /** Quick search over the FPL plan tabs (empty = show every tab). */
  const [planQuery, setPlanQuery] = useState("");
  /** Search/filter over generated results (empty = show all). */
  // Two-scope search over generated routes: pick a flight, then optionally
  // narrow to one of its routes (empty route box = all routes of the flight).
  const [flightQuery, setFlightQuery] = useState("");
  const [routeQuery, setRouteQuery] = useState("");

  const [fileNote, setFileNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Generated trajectories + their download bundles kept in lock-step
  // (same index). Multi-route generates several at once; an ✕ button
  // on each download card removes that one entry from both arrays and
  // from the map (via onResult).
  const [results, setResults] = useState<TrajectoryResult[]>([]);
  const [dlList, setDlList] = useState<DownloadInfo[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Live progress text for "Generate all" while it streams the batch in
  // chunks (e.g. "Generating 80/242…").
  const [genProgress, setGenProgress] = useState("");

  // RouteBuilder selection → an Item-15 style string.
  const builtRoute = useMemo(
    () => (builtWpts.length ? `DCT ${builtWpts.join(" DCT ")} DCT` : ""),
    [builtWpts],
  );

  /** Snapshot the live editor (scalar state) into a PlanDraft. */
  const snapshotActive = (): PlanDraft => ({
    id: activeId,
    callsign,
    actype,
    adep,
    ades,
    eobt,
    gsKt,
    rfl,
    entryFl,
    routeMode,
    routeStr,
    builtWpts,
    routes,
    sid,
    star,
    depRwy,
    arrRwy,
    approach,
    approachTransition,
  });

  /** Pick the route tab for a loaded plan: AIP when its route is a published
   *  filed route for the pair, otherwise Manual (so a custom/imported route
   *  shows automatically in the Manual editor, limited to the pair's
   *  waypoints). Empty route defaults to AIP so the filed-route suggestions
   *  appear. */
  const routeTabForDraft = (d: PlanDraft): "aip" | "manual" => {
    const a = d.adep.trim().toUpperCase();
    const b = d.ades.trim().toUpperCase();
    const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");
    const rt = norm(d.routes?.[0]?.route ?? d.routeStr ?? "");
    if (!rt) return d.builtWpts.length > 0 ? "manual" : "aip";
    return aipRoutes.some(
      (r) =>
        r.adep.toUpperCase() === a &&
        r.ades.toUpperCase() === b &&
        norm(r.route) === rt,
    )
      ? "aip"
      : "manual";
  };

  /** Load a PlanDraft into the live editor (scalar state). */
  const loadDraft = (d: PlanDraft) => {
    setCallsign(d.callsign);
    setActype(d.actype);
    setAdep(d.adep);
    setAdes(d.ades);
    setEobt(d.eobt);
    setGsKt(d.gsKt);
    setRfl(d.rfl);
    setEntryFl(d.entryFl);
    setRouteMode(d.routeMode);
    setRouteStr(d.routeStr);
    setBuiltWpts(d.builtWpts);
    setRoutes(d.routes);
    setSid(d.sid);
    setStar(d.star);
    // The "selected automatically" notes belong to the tab being left.
    setSidAuto(null);
    setStarAuto(null);
    setDepRwy(d.depRwy ?? "");
    setArrRwy(d.arrRwy ?? "");
    // A draft that already names a runway keeps it: claim its
    // `${airport}|${month}` key so the default-runway effect below leaves the
    // saved pick alone. A draft with no runway (a blank tab, an imported row
    // that filed none) leaves the key open, so it gets the month's default.
    const mo = eobtMonth(d.eobt);
    depAutoKey.current = d.depRwy ? `${d.adep.trim().toUpperCase()}|${mo}` : "";
    arrAutoKey.current = d.arrRwy ? `${d.ades.trim().toUpperCase()}|${mo}` : "";
    // Same for the approach: a draft that names one keeps it, and clearing it
    // afterwards is a decision, not an invitation to re-pick.
    approachAutoKey.current = d.approach
      ? `${d.ades.trim().toUpperCase()}|${(d.arrRwy ?? "").toUpperCase()}`
      : "";
    setApproach(d.approach ?? "");
    setApproachTransition(d.approachTransition ?? "");
    // Auto-select AIP vs Manual based on whether the route is a filed route.
    setRouteTab(routeTabForDraft(d));
  };

  const switchTo = (id: string) => {
    if (id === activeId) return;
    const snap = snapshotActive();
    setPlans((prev) => prev.map((p) => (p.id === activeId ? snap : p)));
    const target = plans.find((p) => p.id === id);
    if (target) {
      loadDraft(target);
      setActiveId(id);
    }
  };

  // Held in a ref so the departure-conflict handlers — which the parent panel
  // keeps a reference to — can jump between tabs without themselves changing
  // identity on every render.
  const switchToRef = useRef(switchTo);
  switchToRef.current = switchTo;

  const addPlan = () => {
    const snap = snapshotActive();
    const fresh = blankPlan();
    setPlans((prev) => [...prev.map((p) => (p.id === activeId ? snap : p)), fresh]);
    loadDraft(fresh);
    setActiveId(fresh.id);
  };

  const duplicatePlan = () => {
    const snap = snapshotActive();
    const copy: PlanDraft = { ...snap, id: nextPlanId() };
    setPlans((prev) => {
      const persisted = prev.map((p) => (p.id === activeId ? snap : p));
      const at = persisted.findIndex((p) => p.id === activeId);
      return [...persisted.slice(0, at + 1), copy, ...persisted.slice(at + 1)];
    });
    loadDraft(copy);
    setActiveId(copy.id);
  };

  const removePlan = (id: string) => {
    if (plans.length <= 1) return; // never drop the last tab
    const at = plans.findIndex((p) => p.id === id);
    const next = plans.filter((p) => p.id !== id);
    // Keep the (possibly edited) active tab's data if it isn't the one
    // being removed.
    const snap = snapshotActive();
    setPlans(next.map((p) => (p.id === activeId ? snap : p)));
    if (id === activeId) {
      const fallback = next[Math.max(0, at - 1)];
      loadDraft(fallback);
      setActiveId(fallback.id);
    }
  };

  // Live view of every plan with the active tab reflecting unsaved edits,
  // for the header counters and "Generate all".
  const liveActive = snapshotActive();
  const allDrafts = plans.map((p) => (p.id === activeId ? liveActive : p));

  // Plan-tab rows after the FPL search box: each tab keeps its ORIGINAL index
  // (so "Plan N" labels stay stable) and is matched on callsign / ADEP / ADES
  // / route / SID / STAR — handy once a bulk import opens dozens of tabs.
  const planTokens = planQuery.trim().toUpperCase().split(/[\s,]+/).filter(Boolean);
  const planHay = (d: PlanDraft) =>
    [d.callsign, d.adep, d.ades, d.routeStr, d.sid, d.star, ...d.routes.map((r) => r.route)]
      .filter(Boolean)
      .join(" ")
      .toUpperCase();
  const planTabRows = allDrafts
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => planTokens.length === 0 || planTokens.every((t) => planHay(d).includes(t)));
  const totalRoutes = allDrafts.reduce(
    (n, d) => n + draftCombos(d).length,
    0,
  );
  const uniqueAirports = useMemo(() => {
    const s = new Set<string>();
    for (const d of allDrafts) {
      const a = d.adep.trim().toUpperCase();
      const b = d.ades.trim().toUpperCase();
      if (a) s.add(a);
      if (b) s.add(b);
    }
    return s;
  }, [allDrafts]);

  // "generated / planned" — shown beside the panel title. Planned is the
  // queued route count, falling back to the plan count so a fresh panel
  // reads "0 / 1".
  const plannedCount = Math.max(totalRoutes, plans.length);
  const readyText = `${results.length} / ${plannedCount} flight${
    plannedCount === 1 ? "" : "s"
  } ready`;
  useEffect(() => {
    onReadyChange?.(readyText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyText]);

  // Fixes/airways from the (currently empty, pending a VY eAIP cache) AIP
  // loader, plus the real 48-aerodrome VY airport list from the AIXM-derived
  // CSV — loaded once on mount.
  const [allFixes, setAllFixes] = useState<Fix[]>([]);
  const [airwaysMap, setAirwaysMap] = useState<Record<string, string[]>>({});
  const [airports, setAirports] = useState<PanelAirport[]>([]);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAllFixes(), fetchAirwaysMap(), fetchPanelAirports()])
      .then(([fixes, aw, aps]) => {
        if (cancelled) return;
        setAllFixes(fixes);
        setAirwaysMap(aw);
        setAirports(aps);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Airport combobox options — from the real VY airport CSV when loaded,
  // else a tiny fallback. Free typing of any ICAO is always allowed.
  const airportOptions: ComboOption[] = useMemo(
    () =>
      airports.length
        ? airports.map((a) => ({
            code: a.code,
            label: tidyAirportName(a.name),
          }))
        : AIRPORTS_FALLBACK,
    [airports],
  );

  // Any distinct, non-empty ICAO pair is routable now.
  const dep = adep.trim().toUpperCase();
  const des = ades.trim().toUpperCase();
  const pairReady = !!dep && !!des && dep !== des;

  // Predefined AIP flight-planning routes (ENR 4). When a city pair has a
  // published route it is used VERBATIM instead of the computed best-route
  // (no injected navaid endpoints). RNAV vs Non-RNAV picks which table.
  const [aipRoutes, setAipRoutes] = useState<AipRoute[]>([]);
  // Route source: "aip" = pick a published filed route (RNAV + Non-RNAV
  // listed together); "manual" = build it (Type / Pick) from this pair's
  // AIP waypoints.
  const [routeTab, setRouteTab] = useState<"aip" | "manual">("aip");
  useEffect(() => {
    let cancelled = false;
    fetchAipRoutes()
      .then((rs) => !cancelled && setAipRoutes(rs))
      .catch(() => {
        /* no published routes available → computed best-route is used */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // First and last EN-ROUTE fix of a published route string — the airway
  // designators (and DCT) are skipped, so we land on the real entry/exit fix.
  // A SID's exit fix is a route's FIRST fix; a STAR's entry fix is its LAST.
  const knownFixIdents = useMemo(
    () => new Set(allFixes.map((f) => f.ident)),
    [allFixes],
  );
  const routeFixEnds = useCallback(
    (route: string): { first: string | null; last: string | null } => {
      const toks = route
        .toUpperCase()
        .split(/\s+/)
        .filter((t) => t && t !== "DCT" && knownFixIdents.has(t));
      return { first: toks[0] ?? null, last: toks[toks.length - 1] ?? null };
    },
    [knownFixIdents],
  );

  // ADES suggestions cascade from ADEP: when the departure aerodrome has
  // published AIP routes, the destination dropdown lists only those filed
  // destinations (e.g. VYYY → VYMD, VYNT). When a SID is also chosen, narrow
  // further to destinations whose filed route leaves via that SID's exit fix
  // (the route's first fix matches the SID name, which is coded from that fix —
  // ALBO3C → ALBOS). Falls back to all aerodromes when the ADEP has no AIP
  // route, and to the ADEP-only list when no route matches the SID (soft
  // filter); free-typing any ICAO stays allowed by the combobox.
  const adesOptions = useMemo<ComboOption[]>(() => {
    const a = adep.trim().toUpperCase();
    if (!a) return airportOptions;
    const fromA = aipRoutes.filter((r) => r.adep.toUpperCase() === a);
    let dests = new Set(fromA.map((r) => r.ades.toUpperCase()));
    if (dests.size === 0) return airportOptions;
    const pre = sid ? sid.match(/^[A-Z]+/)?.[0] ?? sid : null;
    if (pre) {
      const narrowed = new Set(
        fromA
          .filter((r) => {
            const f = routeFixEnds(r.route).first;
            return f != null && f.startsWith(pre);
          })
          .map((r) => r.ades.toUpperCase()),
      );
      if (narrowed.size > 0) dests = narrowed;
    }
    return airportOptions.filter((o) => dests.has(o.code.toUpperCase()));
  }, [adep, sid, aipRoutes, airportOptions, routeFixEnds]);

  // ADEP suggestions cascade BACKWARD from ADES + STAR: when an arrival STAR is
  // chosen before the departure aerodrome, the ADEP dropdown lists only origins
  // whose filed route into this ADES arrives over that STAR's entry fix (the
  // route's last fix matches the STAR name, coded from that fix — SURG2A →
  // SURGU). Inactive (all aerodromes) until a STAR is picked, so the normal
  // ADEP-first workflow is unchanged; soft-falls back to all when nothing
  // matches. Free-typing any ICAO stays allowed by the combobox.
  const adepOptions = useMemo<ComboOption[]>(() => {
    const b = ades.trim().toUpperCase();
    const pre = star ? star.match(/^[A-Z]+/)?.[0] ?? star : null;
    if (!b || !pre) return airportOptions;
    const toB = aipRoutes.filter((r) => r.ades.toUpperCase() === b);
    const origins = new Set(
      toB
        .filter((r) => {
          const f = routeFixEnds(r.route).last;
          return f != null && f.startsWith(pre);
        })
        .map((r) => r.adep.toUpperCase()),
    );
    if (origins.size === 0) return airportOptions;
    return airportOptions.filter((o) => origins.has(o.code.toUpperCase()));
  }, [ades, star, aipRoutes, airportOptions, routeFixEnds]);

  // Aerodrome reference coords, keyed by ICAO, for the route finder.
  const airportLL = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>();
    for (const a of airports) m.set(a.code, { lat: a.lat, lon: a.lon });
    return m;
  }, [airports]);

  // --- Departure separation between FILED PLANS ---------------------------
  // Two FPLs off the same runway at the same EOBT never reach the CD&R engine:
  // that works on generated 4D paths, and this is decided before either
  // aircraft moves. So it is checked here, on the plans themselves, and shown
  // the moment a file is imported — not after "Generate".
  const fixLL = useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>();
    for (const f of allFixes) m.set(f.ident, { lat: f.lat, lon: f.lon });
    return m;
  }, [allFixes]);

  /** The track a plan departs on, as far as a PLAN can know: the bearing from
   *  the aerodrome to the first fix its route names, falling back to the
   *  destination. Null when neither is in the navdata — which the rules read as
   *  "same track", since the §5.6.1 divergence relief must be shown, not
   *  assumed. */
  const initialTrackOf = useCallback(
    (d: PlanDraft): number | null => {
      const from = airportLL.get(d.adep.trim().toUpperCase());
      if (!from) return null;
      const words = (draftCombos(d)[0]?.route ?? "").trim().toUpperCase().split(/\s+/);
      const firstFix = words.find((w) => fixLL.has(w));
      const to =
        (firstFix ? fixLL.get(firstFix) : undefined) ??
        airportLL.get(d.ades.trim().toUpperCase());
      if (!to) return null;
      return initialBearingDeg(from.lat, from.lon, to.lat, to.lon);
    },
    [airportLL, fixLL],
  );

  /** Conflicts the user has dismissed, by pair id. Cleared on a fresh import so
   *  a new file always re-notifies. */
  const [ignoredDepConflicts, setIgnoredDepConflicts] = useState<Set<string>>(
    () => new Set(),
  );
  /** The conflict whose "which FPL?" chooser is open. */
  const [depFixChoiceFor, setDepFixChoiceFor] = useState<string | null>(null);
  /** The plan the user chose to fix, and the EOBT that would clear it. Drives
   *  the red EOBT readout on that plan's own tab. */
  const [depFix, setDepFix] = useState<{
    conflictId: string;
    planId: string;
    suggestedMs: number;
    otherCallsign: string;
    otherEobtMs: number;
    adep: string;
    runway: string;
    requiredSec: number;
    reason: string;
  } | null>(null);

  /** Plans → the departure check's input. Shared by the live warning and by
   *  "Auto fix all", which re-runs the scan over its own working copy. */
  const toDepartureFlights = useCallback(
    (drafts: PlanDraft[]): DepartureFlight[] =>
      // flatMap (not filter-then-map) so `planLabel`'s index still means the
      // plan's position in the list — a blank callsign reads "Plan 5", not
      // "Plan 2" because the four before it were dropped.
      drafts.flatMap((d, i) =>
        !departsFromKnownField(d, airportLL)
          ? []
          : [
              {
                id: d.id,
                callsign: d.callsign.trim() || planLabel(d, i),
                actype: d.actype,
                adep: d.adep.trim().toUpperCase(),
                ades: d.ades.trim().toUpperCase(),
                eobtMs: eobtToMs(d.eobt),
                depRwy: d.depRwy,
                trackDeg: initialTrackOf(d),
                gsKt: d.gsKt,
                rfl: d.rfl,
              },
            ],
      ),
    [initialTrackOf, airportLL],
  );

  // --- PDR route check over the FILED PLANS ---------------------------------
  //
  // Runs BEFORE anything is generated, so a routing through an active
  // prohibited/danger/restricted area can be fixed while it is still a plan.
  // The path is estimated from the filed fixes on a 3:1 climb/cruise/descent
  // profile between the two aerodromes rather than flown: the point is to catch
  // the low areas under the climb-out and the descent, which a flat-at-RFL
  // check cannot see (only 16 of the 73 published areas reach FL330). The same
  // check re-runs against the real trajectory once the flight is generated.
  //
  // Keyed on a CONTENT signature rather than on `allDrafts`, which is rebuilt
  // on every render: without this the memo, the reports and the upward emit
  // would all change identity every render, and the parent's setState would
  // re-render this panel forever. It also stops a whole bank being re-analysed
  // when the user types in a field the check does not read.
  const pdrPlanKey = useMemo(
    () =>
      allDrafts
        .map((d) =>
          [
            d.id,
            d.callsign,
            d.actype,
            d.adep,
            d.ades,
            d.eobt,
            d.rfl,
            d.gsKt,
            d.routeMode,
            d.routeStr,
            d.builtWpts.join(","),
            d.routes.map((r) => r.route).join("|"),
            // The terminal selection belongs in the signature too. It does not
            // change the ESTIMATED path today (that runs straight to the first
            // fix — see the caveat on those findings), but leaving it out meant
            // picking a different SID silently left the previous verdict on
            // screen, which reads as the check ignoring the edit.
            d.sid,
            d.star,
            d.depRwy,
            d.arrRwy,
            d.approach,
          ].join("~"),
        )
        .join(";"),
    [allDrafts],
  );

  // Debounced, because the signature above changes on every KEYSTROKE — typing
  // "250" into RFL is three edits, and each one rebuilt ~2000 route paths
  // synchronously and restarted the scan. The field became impossible to type
  // in. The check is advisory and re-runs a moment after the edit settles.
  const [settledPlanKey, setSettledPlanKey] = useState(pdrPlanKey);
  useEffect(() => {
    const t = setTimeout(() => setSettledPlanKey(pdrPlanKey), PLAN_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [pdrPlanKey]);

  const pdrPlanFlights = useMemo<PdrFlight[]>(() => {
    if (allFixes.length === 0) return [];
    const airportLL = new Map(
      airports.map((a) => [a.code.toUpperCase(), { lat: a.lat, lon: a.lon }]),
    );
    const out: PdrFlight[] = [];
    allDrafts.forEach((d, i) => {
      const adep = d.adep.trim().toUpperCase();
      const ades = d.ades.trim().toUpperCase();
      // eobtToMs is null for a blank/unparseable EOBT, and the whole check is
      // a wall-clock one — without a real departure time there is nothing to
      // read the area schedules against.
      const eobtMs = eobtToMs(d.eobt);
      if (!adep || !ades || eobtMs == null || !Number.isFinite(eobtMs)) return;

      draftCombos(d).forEach((combo, ci) => {
        if (!combo.route.trim()) return;
        const mid = resolveRoutePreview(combo.route, allFixes, airwaysMap);
        if (mid.length === 0) return;
        // Anchor the profile at the aerodromes so the climb and descent start
        // and finish in the right place; the enroute fixes alone would put the
        // aircraft at cruise from the first waypoint.
        const dep = airportLL.get(adep);
        const arr = airportLL.get(ades);
        const fixes = [
          ...(dep ? [dep] : []),
          ...mid.map((pt) => ({ lat: pt.lat, lon: pt.lon })),
          ...(arr ? [arr] : []),
        ];
        out.push({
          flightKey: d.id + "::" + ci,
          callsign: d.callsign.trim() || planLabel(d, i),
          adep,
          ades,
          actype: d.actype,
          filedRoute: combo.route,
          eobtMs,
          rflFt: d.rfl * 100,
          gsKt: d.gsKt,
          estimated: true,
          // With no usable level there is no vertical dimension to check
          // against: a path built at 0 ft skims the ground and "enters" every
          // low-level area. The check reports the missing level instead.
          
          // The same anchors the filed path uses, so a candidate route is
          // profiled identically and the two verdicts are comparable.
          terminals: { dep: dep ?? null, arr: arr ?? null },
          path:
            d.rfl > 0
              ? pathFromFixes(fixes, {
                  startMs: eobtMs,
                  gsKt: d.gsKt,
                  altFt: climbCruiseDescentFt({
                    rflFt: d.rfl * 100,
                    // A flight only passing through is at level at the fix it
                    // crosses in at — and so is any flight whose ADEP/ADES has
                    // no coordinates here, since the route's first/last fix
                    // then stands in for that crossing. Matches the engine.
                    startAtLevel: !!d.entryFl || !dep,
                    endAtLevel: !arr,
                  }),
                })
              : [],
        });
      });
    });
    return out;
    // Intentionally keyed on the SETTLED signature, not on `allDrafts` and not
    // on the live one — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledPlanKey, allFixes, airwaysMap, airports]);

  const pdrPlan = usePdrCheck(pdrPlanFlights, pdrPlanFlights.length > 0);

  /** Plans with something the controller should look at before generating. */
  const pdrPlanConflicts = useMemo(
    () =>
      [...pdrPlan.reports.values()].filter((r) =>
        r.findings.some((f) => f.severity !== "info"),
      ).length,
    [pdrPlan.reports],
  );

  /** Put a suggested route in a plan's Item-15 field. Keyed by the synthetic
   *  "<planId>::<comboIndex>" the check uses. Deliberately does NOT generate —
   *  the controller reviews the routing and presses Generate themselves. */
  const usePdrRoute = useCallback(
    (flightKey: string, route: string) => {
      const planId = flightKey.split("::")[0];
      setPlans((prev) =>
        prev.map((p) =>
          p.id === planId
            ? { ...p, routeStr: route, routeMode: "fpl" as RouteMode, routes: [] }
            : p,
        ),
      );
      // The tab on screen keeps its own copy of the inputs, so if it is the one
      // that moved, its route box has to be told too.
      if (planId === activeIdRef.current) {
        setRouteMode("fpl");
        setRouteStr(route);
        setRoutes([]);
      }
    },
    [],
  );

  const depConflicts = useMemo<DepartureConflict[]>(() => {
    if (allDrafts.length < 2) return [];
    return findDepartureConflicts(toDepartureFlights(allDrafts)).filter(
      (c) => !ignoredDepConflicts.has(c.id),
    );
    // `allDrafts` is rebuilt every render (it carries the live editor state), so
    // this recomputes as the user types — which is what keeps the warning
    // truthful while an EOBT is being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDrafts, toDepartureFlights, ignoredDepConflicts]);

  // Latest values for the handlers below, which are handed to the parent ONCE
  // (they have to keep a stable identity or the panel would re-emit on every
  // render and loop).
  // Hand the PDR findings to the parent so the rail can render them. Same
  // shape-and-actions contract as onDepartureConflicts.
  const onPdrPlanCheckRef = useRef(onPdrPlanCheck);
  onPdrPlanCheckRef.current = onPdrPlanCheck;
  useEffect(() => {
    onPdrPlanCheckRef.current?.({
      flights: pdrPlanFlights.map((f) => ({
        flightKey: f.flightKey,
        callsign: f.callsign,
        adep: f.adep,
        ades: f.ades,
        rflFt: f.rflFt,
      })),
      reports: pdrPlan.reports,
      loading: pdrPlan.loading,
      error: pdrPlan.error,
      validFrom: pdrPlan.validFrom,
      validTo: pdrPlan.validTo,
      useRoute: usePdrRoute,
      retry: pdrPlan.retry,
      scanning: pdrPlan.scanning,
      detailFor: pdrPlan.detailFor,
    });
    // Depends on the STABLE members, not on `pdrPlan` itself: the hook returns
    // a fresh object literal every render, so listing it here fired the emit —
    // and the parent's setState, and so another render — forever.
  }, [
    pdrPlanFlights,
    pdrPlan.reports,
    pdrPlan.loading,
    pdrPlan.error,
    pdrPlan.validFrom,
    pdrPlan.validTo,
    pdrPlan.retry,
    pdrPlan.scanning,
    pdrPlan.detailFor,
    usePdrRoute,
  ]);

  const depConflictsRef = useRef(depConflicts);
  depConflictsRef.current = depConflicts;
  const allDraftsRef = useRef(allDrafts);
  allDraftsRef.current = allDrafts;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // A route staged by the PDR check.
  //
  // The tab on screen holds its inputs in their own state and only writes them
  // back to `plans` when it is left, so the match is made against the LIVE
  // fields first and the stored drafts second — otherwise a flight whose
  // callsign was just typed would not be found. Nothing is generated: the
  // routing is put in the Item-15 box and the Generate press stays the
  // controller's.
  // Jump to a plan's tab on request from the PDR panel. Mirrors what the
  // departure-conflict fix does, including clearing the FPL search box: the
  // target tab may be filtered out of view, and a redirect that lands on a tab
  // the user cannot see is worse than none.
  const focusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!focusPlan || focusNonce.current === focusPlan.nonce) return;
    const up = (v: string) => v.trim().toUpperCase();
    // By id when there is one, else by the identity a plan has before it has
    // been flown — the same match `routeHandoff` uses just below.
    const id = focusPlan.planId
      ? plans.find((p) => p.id === focusPlan.planId)?.id
      : focusPlan.match
        ? plans.find(
            (p) =>
              up(p.callsign) === up(focusPlan.match!.callsign) &&
              up(p.adep) === up(focusPlan.match!.adep) &&
              up(p.ades) === up(focusPlan.match!.ades),
          )?.id
        : undefined;
    // Leave the nonce unconsumed if the plan is not here yet: the tabs may
    // still be filling in from an import, and a dropped focus is silent.
    if (!id) return;
    focusNonce.current = focusPlan.nonce;
    setPlanQuery("");
    if (id !== activeIdRef.current) {
      switchToRef.current(id);
    }
  }, [focusPlan, plans]);

  const handoffNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!routeHandoff || handoffNonce.current === routeHandoff.nonce) return;
    const up = (v: string) => v.trim().toUpperCase();
    const wanted =
      up(routeHandoff.callsign) + "|" + up(routeHandoff.adep) + "|" + up(routeHandoff.ades);

    if (up(callsign) + "|" + up(adep) + "|" + up(ades) === wanted) {
      handoffNonce.current = routeHandoff.nonce;
      setRouteMode("fpl");
      setRouteStr(routeHandoff.route);
      return;
    }
    const target = plans.find(
      (p) => up(p.callsign) + "|" + up(p.adep) + "|" + up(p.ades) === wanted,
    );
    if (!target) return; // the plan was removed; leave the handoff unconsumed
    handoffNonce.current = routeHandoff.nonce;
    setPlans((prev) =>
      prev.map((p) =>
        p.id === target.id
          ? { ...p, routeStr: routeHandoff.route, routeMode: "fpl" as RouteMode }
          : p,
      ),
    );
  }, [routeHandoff, plans, callsign, adep, ades]);
  const toDepartureFlightsRef = useRef(toDepartureFlights);
  toDepartureFlightsRef.current = toDepartureFlights;
  const ignoredDepRef = useRef(ignoredDepConflicts);
  ignoredDepRef.current = ignoredDepConflicts;

  // A fix that has landed (or a pair that changed shape) stops being pending.
  useEffect(() => {
    if (depFix && !depConflicts.some((c) => c.id === depFix.conflictId)) {
      setDepFix(null);
    }
  }, [depConflicts, depFix]);

  /** The pending fix, when it belongs to the tab currently on screen. */
  const depFixHere = depFix && depFix.planId === activeId ? depFix : null;

  /** Take the user to the FPL they chose to move, carrying the conflict with
   *  them so that plan's own EOBT field can say what it clashes with and what
   *  to set it to. Which of the two moves is the controller's call — either
   *  end of the pair opens the same interval. */
  const startDepFix = useCallback((conflictId: string, planId: string) => {
    const c = depConflictsRef.current.find((x) => x.id === conflictId);
    if (!c) return;
    const suggestedMs = resolvedEobtMs(c, planId);
    if (suggestedMs == null) return;
    const other = planId === c.leader.id ? c.follower : c.leader;
    setDepFix({
      conflictId: c.id,
      planId,
      suggestedMs,
      otherCallsign: other.callsign,
      otherEobtMs: other.eobtMs ?? 0,
      adep: c.adep,
      runway: c.runway,
      requiredSec: c.requiredSec,
      reason: c.reason,
    });
    setDepFixChoiceFor(null);
    // The target tab may be hidden behind the FPL search filter — clear it, or
    // the redirect lands on a tab the user cannot see.
    setPlanQuery("");
    if (planId !== activeIdRef.current) switchToRef.current(planId);
    // Stable identity: everything mutable is read through a ref, because the
    // parent holds on to this function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Re-time EVERY listed pair in one go.
   *
   *  One of the two flights is picked AT RANDOM and moved to the time the rule
   *  needs; which side that is has no operational meaning, so the panel says
   *  so. It is the only workable option once an import brings in a hundred
   *  pairs — the alternative is a hundred visits to a hundred tabs.
   *
   *  Re-scanned between passes because moving a flight makes it the neighbour
   *  of a different one: the fix cascades down the departure bank, exactly like
   *  the arrival ladder's inherited delay. */
  const autoFixAllDepConflicts = useCallback(() => {
    const { eobtMsById } = autoResolveDepartures(
      toDepartureFlightsRef.current(allDraftsRef.current),
      { passes: AUTO_FIX_PASSES, ignored: ignoredDepRef.current },
    );
    if (eobtMsById.size === 0) return;
    const eobtOf = (id: string) => {
      const ms = eobtMsById.get(id);
      return ms == null ? null : msToEobt(ms);
    };
    setPlans((prev) =>
      prev.map((p) => {
        const next = eobtOf(p.id);
        return next == null ? p : { ...p, eobt: next };
      }),
    );
    // The tab on screen keeps its own copy of the fields, so if it was one of
    // the flights that moved, its EOBT input has to be told.
    const activeEobt = eobtOf(activeIdRef.current);
    if (activeEobt != null) setEobt(activeEobt);
    setDepFix(null);
    setDepFixChoiceFor(null);
  }, []);

  const ignoreDepConflict = useCallback(
    (id: string) => setIgnoredDepConflicts((prev) => new Set(prev).add(id)),
    [],
  );
  const ignoreAllDepConflicts = useCallback(
    (ids: string[]) =>
      setIgnoredDepConflicts((prev) => new Set([...prev, ...ids])),
    [],
  );

  // Hand the whole thing to the parent, which renders it in the right-hand
  // rail beside the other conflict panels. Only the LIST changes identity here
  // (the actions are stable), so this fires when the conflicts do and not on
  // every keystroke.
  useEffect(() => {
    onDepartureConflicts?.({
      conflicts: depConflicts,
      ignore: ignoreDepConflict,
      ignoreAll: ignoreAllDepConflicts,
      fix: startDepFix,
      autoFixAll: autoFixAllDepConflicts,
    });
  }, [
    depConflicts,
    onDepartureConflicts,
    ignoreDepConflict,
    ignoreAllDepConflicts,
    startDepFix,
    autoFixAllDepConflicts,
  ]);

  // K best routes for ANY aerodrome pair — graph search (Yen's
  // k-shortest) over the whole Myanmar airway network. Empty when either
  // airport's coordinates aren't in the AIP (e.g. a free-typed field).
  const bestRoutes = useMemo<(RouteOption & { caps?: boolean[] })[]>(() => {
    if (!pairReady) return [];
    const depLL = airportLL.get(dep) ?? null;
    const desLL = airportLL.get(des) ?? null;
    // Published AIP routes for BOTH capabilities (RNAV + Non-RNAV). When the
    // SAME route string is filed under both, merge it into ONE entry tagged
    // with both labels (no duplicate row). Used verbatim (no computed path,
    // no injected navaid endpoints). Falls back to the graph search when the pair has
    // no published route at all.
    const both = [
      ...aipRouteOptions(aipRoutes, dep, des, true, allFixes, airwaysMap, depLL, desLL).map(
        (r) => ({ ...r, rnav: true }),
      ),
      ...aipRouteOptions(aipRoutes, dep, des, false, allFixes, airwaysMap, depLL, desLL).map(
        (r) => ({ ...r, rnav: false }),
      ),
    ];
    if (both.length > 0) {
      const byText = new Map<
        string,
        RouteOption & { caps: boolean[] }
      >();
      for (const r of both) {
        const e = byText.get(r.text);
        if (e) {
          if (!e.caps.includes(r.rnav)) e.caps.push(r.rnav);
        } else {
          byText.set(r.text, {
            text: r.text,
            distanceNm: r.distanceNm,
            caps: [r.rnav],
          });
        }
      }
      // A route filed ONLY as Non-RNAV is not offered: that capability is not
      // in use yet. What stays is exactly two kinds of row — RNAV, and a route
      // filed under BOTH (tagged RNAV + NON-RNAV, since it is the same string).
      // Non-RNAV is still read above so the second kind can be recognised.
      // A pair whose every published route is Non-RNAV therefore has nothing
      // left here, and falls through to the computed best routes below, exactly
      // as a pair with no published route does.
      const offered = [...byText.values()].filter((e) => e.caps.includes(true));
      if (offered.length > 0) {
        // RNAV first within each capability set, then by distance.
        return offered.map((e) => ({
          ...e,
          caps: [...e.caps].sort((a, b) => Number(b) - Number(a)),
        }));
      }
    }
    // No published route for this pair (there is no VY aip_routes table
    // yet — see aipRoutes.ts). Deliberately NOT falling back to
    // kBestRoutes' nearest-fix graph search here: that would suggest an
    // ATS route for literally any two airports whose coordinates happen
    // to be known, whether or not a SID/STAR/ATS-route chain actually
    // connects them — exactly the "every combination" behaviour this
    // deployment must not show. Real fixes (allFixes/airwaysMap) still
    // power the map preview and the Manual/RouteBuilder waypoint search;
    // only the auto-suggestion path is disabled until a real
    // reachability-checked VY route table exists.
    return [];
  }, [pairReady, dep, des, airportLL, allFixes, airwaysMap, aipRoutes]);

  // Whether the current pair resolves to ANY published AIP route, so the UI
  // can label it "AIP filed route".
  const usingAip = useMemo(
    () => bestRoutes.some((r) => r.caps !== undefined),
    [bestRoutes],
  );

  // Waypoints that appear in this pair's AIP routes (both capabilities) —
  // the allowed set for Manual mode (Pick/Type). Falls back to every fix
  // when the pair has no published route.
  const manualFixes = useMemo(() => {
    const a = dep.trim().toUpperCase();
    const b = des.trim().toUpperCase();
    const known = new Set(allFixes.map((f) => f.ident));
    const out = new Set<string>();
    for (const r of aipRoutes) {
      if (r.adep.toUpperCase() !== a || r.ades.toUpperCase() !== b) continue;
      for (const tok of r.route.toUpperCase().split(/\s+/)) {
        const t = tok.includes("/") ? tok.split("/")[0] : tok;
        if (t !== "DCT" && known.has(t)) out.add(t);
      }
    }
    return out.size > 0 ? [...out].sort() : waypointIdents;
  }, [aipRoutes, dep, des, allFixes, waypointIdents]);

  // SID/STAR procedure names published at the current ADEP/ADES. Fetched
  // whenever the airport changes; an airport with no coded procedures (or
  // an unreachable API) yields an empty list and the picker just shows
  // "None". SID belongs to ADEP, STAR to ADES.
  const [sidOptions, setSidOptions] = useState<string[]>([]);
  const [starOptions, setStarOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!dep) {
      setSidOptions([]);
      return;
    }
    let cancelled = false;
    listProcedures(dep)
      .then((p) => !cancelled && setSidOptions(p.SID))
      .catch(() => !cancelled && setSidOptions([]));
    return () => {
      cancelled = true;
    };
  }, [dep]);
  useEffect(() => {
    if (!des) {
      setStarOptions([]);
      return;
    }
    let cancelled = false;
    listProcedures(des)
      .then((p) => !cancelled && setStarOptions(p.STAR))
      .catch(() => !cancelled && setStarOptions([]));
    return () => {
      cancelled = true;
    };
  }, [des]);

  // Runways published at the ADEP (departure) / ADES (arrival), from the
  // procedure data — drives the runway dropdowns. Empty when the aerodrome
  // has no coded runway transitions (the picker then shows just "Auto").
  const [depRwyOptions, setDepRwyOptions] = useState<string[]>([]);
  const [arrRwyOptions, setArrRwyOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!dep) {
      setDepRwyOptions([]);
      return;
    }
    let cancelled = false;
    staticRunways(dep)
      .then((r) => !cancelled && setDepRwyOptions(r.SID))
      .catch(() => !cancelled && setDepRwyOptions([]));
    return () => {
      cancelled = true;
    };
  }, [dep]);
  useEffect(() => {
    if (!des) {
      setArrRwyOptions([]);
      return;
    }
    let cancelled = false;
    staticRunways(des)
      .then((r) => !cancelled && setArrRwyOptions(r.STAR))
      .catch(() => !cancelled && setArrRwyOptions([]));
    return () => {
      cancelled = true;
    };
  }, [des]);

  // --- Default runway in use (ADEP/ADES + EOBT month) --------------------
  // With the city pair and the EOBT known, both runway pickers pre-fill with
  // the runway that aerodrome actually uses in that month of the year
  // (runway_default.csv: departures off the DEP rows, arrivals off the ARR
  // rows). It is a starting point, not a constraint — the user can pick any
  // other published runway, and that pick stands until the aerodrome or the
  // EOBT month changes.
  const month = eobtMonth(eobt);
  const [depRwyDefault, setDepRwyDefault] = useState<RunwayDefault | null>(null);
  const [arrRwyDefault, setArrRwyDefault] = useState<RunwayDefault | null>(null);
  // `${AIRPORT}|${month}` combos whose default has already been applied, so
  // re-renders (and a draft that carries its own runway) don't overwrite the
  // selection. loadDraft claims the key up-front for exactly that reason.
  const depAutoKey = useRef("");
  const arrAutoKey = useRef("");

  useEffect(() => {
    if (!dep || !month) {
      setDepRwyDefault(null);
      return;
    }
    const k = `${dep}|${month}`;
    let cancelled = false;
    // The published runways are resolved alongside the default: a measured
    // runway that publishes no SID (or isn't in the AIP at all) can't be
    // offered, so in that case the picker is left on Auto.
    Promise.all([staticRunways(dep), runwayDefault(dep, month, "DEP")]).then(
      ([opts, def]) => {
        if (cancelled) return;
        const usable = def && opts.SID.includes(def.ident) ? def : null;
        setDepRwyDefault(usable);
        if (depAutoKey.current === k) return;
        depAutoKey.current = k;
        setDepRwy(usable ? usable.ident : "");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dep, month]);

  useEffect(() => {
    if (!des || !month) {
      setArrRwyDefault(null);
      return;
    }
    const k = `${des}|${month}`;
    let cancelled = false;
    Promise.all([staticRunways(des), runwayDefault(des, month, "ARR")]).then(
      ([opts, def]) => {
        if (cancelled) return;
        const usable = def && opts.STAR.includes(def.ident) ? def : null;
        setArrRwyDefault(usable);
        if (arrAutoKey.current === k) return;
        arrAutoKey.current = k;
        setArrRwy(usable ? usable.ident : "");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [des, month]);

  // PBN instrument approaches at the ADES, grouped by the arrival runway they
  // serve ({ RW09: ["R09-Y","R09-Z"], … }). Picking an Arrival RWY reveals its
  // approaches; empty when the aerodrome has no coded PBN approaches.
  const [approachByRwy, setApproachByRwy] = useState<Record<string, string[]>>(
    {},
  );
  useEffect(() => {
    if (!des) {
      setApproachByRwy({});
      return;
    }
    let cancelled = false;
    staticApproaches(des)
      .then((r) => !cancelled && setApproachByRwy(r))
      .catch(() => !cancelled && setApproachByRwy({}));
    return () => {
      cancelled = true;
    };
  }, [des]);

  // procedure name → runways it serves, so a selected runway can narrow the
  // SID (ADEP) / STAR (ADES) dropdowns to that runway's procedures only.
  const [sidProcRwy, setSidProcRwy] = useState<Record<string, string[]>>({});
  const [starProcRwy, setStarProcRwy] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!dep) {
      setSidProcRwy({});
      return;
    }
    let cancelled = false;
    staticProcedureRunways(dep)
      .then((r) => !cancelled && setSidProcRwy(r.sid))
      .catch(() => !cancelled && setSidProcRwy({}));
    return () => {
      cancelled = true;
    };
  }, [dep]);
  useEffect(() => {
    if (!des) {
      setStarProcRwy({});
      return;
    }
    let cancelled = false;
    staticProcedureRunways(des)
      .then((r) => !cancelled && setStarProcRwy(r.star))
      .catch(() => !cancelled && setStarProcRwy({}));
    return () => {
      cancelled = true;
    };
  }, [des]);

  // Resolved SID/STAR geometry (the server-picked runway/transition fixes),
  // cached by `${airport}|${type}|${name}` and spliced into the live route
  // preview so picking a procedure immediately extends the highlight line.
  // Scoped to the flight being composed (editor pick + this tab's queued
  // combos) so a bulk import doesn't fan out into hundreds of fetches.
  const [procCache, setProcCache] = useState<Map<string, PreviewPoint[]>>(
    () => new Map(),
  );
  useEffect(() => {
    // Each needed procedure carries the route it's flown on, so the server
    // resolves the transition that route actually uses (NAKO1B via BLAFF).
    type Need = { airport: string; type: "SID" | "STAR"; name: string; route: string };
    const need = new Map<string, Need>();
    const add = (airport: string, type: "SID" | "STAR", name: string, route: string) => {
      if (airport && name) need.set(procKey(airport, type, name, route), { airport, type, name, route });
    };
    const editorRoute = (routeMode === "build" ? builtRoute : routeStr).trim();
    if (dep && sid) add(dep, "SID", sid, editorRoute);
    if (des && star) add(des, "STAR", star, editorRoute);
    for (const c of routes) {
      if (dep && c.sid) add(dep, "SID", c.sid, c.route);
      if (des && c.star) add(des, "STAR", c.star, c.route);
    }
    const missing = [...need.entries()].filter(([k]) => !procCache.has(k));
    if (missing.length === 0) return;
    let cancelled = false;
    const toPts = (ws: { ident: string; lat: number; lon: number }[]) =>
      ws.map((w) => ({ ident: w.ident, lat: w.lat, lon: w.lon, fromUser: false }));
    Promise.all(
      missing.map(async ([k, v]) => {
        // Engine API first (route-aware transition); fall back to the bundled
        // GeoJSON geometry when it is unreachable/empty (e.g. a deploy with no
        // backend) so the SID/STAR preview still draws. Cache the miss too.
        try {
          const dto = await fetchProcedure(v.airport, v.name, {
            type: v.type,
            route: v.route || undefined,
          });
          if (dto.waypoints.length > 0) return [k, toPts(dto.waypoints)] as const;
        } catch {
          /* fall through to the static fallback */
        }
        try {
          return [
            k,
            toPts(await staticProcedureWaypoints(v.airport, v.type, v.name)),
          ] as const;
        } catch {
          return [k, [] as PreviewPoint[]] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setProcCache((prev) => {
        const m = new Map(prev);
        for (const [k, val] of entries) m.set(k, val);
        return m;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [dep, des, sid, star, routes, routeStr, builtRoute, routeMode, procCache]);

  // Look up a procedure's cached preview points (null = not a real pick or
  // not yet loaded — the splice then leaves the route line unchanged).
  const procPts = useCallback(
    (airport: string, type: "SID" | "STAR", name: string, route: string) =>
      name ? procCache.get(procKey(airport, type, name, route)) ?? null : null,
    [procCache],
  );

  // Aerodrome anchor point for a "None (direct)" end: a single point at the
  // ADEP/ADES so the preview draws the direct leg from the airport to the
  // first fix (or last fix to the airport) instead of starting mid-route.
  const anchorPts = useCallback(
    (airport: string): PreviewPoint[] | null => {
      const code = airport.trim().toUpperCase();
      const ll = airportLL.get(code);
      return ll ? [{ ident: code, lat: ll.lat, lon: ll.lon, fromUser: false }] : null;
    },
    [airportLL],
  );

  // SID end of the splice: the picked procedure's fixes, or the ADEP anchor
  // when "None (direct)". STAR end is symmetric for the arrival.
  const sidEnd = useCallback(
    (airport: string, name: string, route: string) =>
      name ? procPts(airport, "SID", name, route) : anchorPts(airport),
    [procPts, anchorPts],
  );
  const starEnd = useCallback(
    (airport: string, name: string, route: string) =>
      name ? procPts(airport, "STAR", name, route) : anchorPts(airport),
    [procPts, anchorPts],
  );


  // Flight-time curve for THIS airframe at THIS level. Refetched when
  // either changes; the server derives it from the type's own Thai APM
  // performance, so the picker's prediction matches what /api/generate
  // will compute. A type with no Thai APM data of its own comes back
  // unsupported and the picker simply shows no time — never another
  // airframe's.
  const [timeCurve, setTimeCurve] = useState<FlightTimeCurveResult | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    if (!actype.trim()) {
      setTimeCurve(null);
      return;
    }
    fetchFlightTimeCurve(actype, rfl * 100)
      .then((c) => !cancelled && setTimeCurve(c))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [actype, rfl]);

  // Annotate each candidate route with its predicted flight time (from the
  // airframe's flight-time curve). Informational only — every candidate is
  // listed; there is no reference-time grading.
  const shownRoutes = useMemo(
    () =>
      bestRoutes.map((r) => {
        const simMin = isSupportedCurve(timeCurve)
          ? estimateSimMin(timeCurve, r.distanceNm)
          : null;
        return { ...r, simMin };
      }),
    [bestRoutes, timeCurve],
  );

  // The route the Item-15 box currently resolves to (typed or built).
  const effectiveRoute =
    routeMode === "build" ? builtRoute : routeStr.trim();

  // Realtime: which of the chosen approach's IAF entry fixes lie on the route
  // + STAR. When more than one does, the user picks where to join (below);
  // otherwise the engine auto-scores it. Debounced so typing the route doesn't
  // spam the backend. The picked join fix is reset if it leaves the match set.
  useEffect(() => {
    if (!approach || !des) {
      setApproachEntryMatches([]);
      setApproachTransition("");
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      fetchApproachEntries(des, approach, {
        runway: arrRwy || undefined,
        route: effectiveRoute || undefined,
        star: star || undefined,
      })
        .then((r) => {
          if (cancelled) return;
          setApproachEntryMatches(r.matching);
          setApproachTransition((cur) =>
            cur && !r.matching.includes(cur) ? "" : cur,
          );
        })
        .catch(() => !cancelled && setApproachEntryMatches([]));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [approach, des, arrRwy, star, effectiveRoute]);
  // Can't queue more routes than there are distinct possible ones.
  // Per-route SID/STAR options: the procedures whose name connects to the
  // route's first / last fix (ICAO naming convention: a procedure is named
  // from its fix's first letters, e.g. BOMAS → BOMA*).
  const routeProcs = (routeText: string) => {
    const known = new Set(allFixes.map((f) => f.ident));
    const toks = routeText
      .toUpperCase()
      .split(/\s+/)
      .map((t) => (t.includes("/") ? t.split("/")[0] : t))
      .filter((t) => t && t !== "DCT" && known.has(t));
    const first = toks[0] ?? null;
    const last = toks[toks.length - 1] ?? null;
    const pref = (n: string) => n.match(/^[A-Z]+/)?.[0] ?? n;
    return {
      sids: first ? sidOptions.filter((n) => first.startsWith(pref(n))) : [],
      stars: last ? starOptions.filter((n) => last.startsWith(pref(n))) : [],
    };
  };

  // Total possible combinations across the listed AIP routes:
  // Σ (SID+1) × (STAR+1). This is the queue cap and the "(n/total)" counter.
  const routeTotal = useMemo(() => {
    if (bestRoutes.length === 0) return 1;
    let t = 0;
    for (const r of bestRoutes) {
      const { sids, stars } = routeProcs(r.text);
      t += (sids.length + 1) * (stars.length + 1);
    }
    return Math.max(1, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bestRoutes, sidOptions, starOptions, allFixes]);

  const comboKey = (c: RouteCombo) => `${c.sid}|${c.route}|${c.star}`;

  // SID/STAR filtered to procedures that actually connect to the chosen
  // route's terminal fixes: a SID must reach the route's FIRST en-route fix,
  // a STAR must start from its LAST. Procedure names are coded from that
  // fix (BOMAS → BOMA1A/BOMA2B…), so we match on the
  // alphabetic name prefix. Falls back to all options when nothing matches
  // (e.g. a computed route whose entry fix has no same-named SID), so the
  // picker is never an unintended dead-end.
  const routeEndFixes = useMemo(() => {
    // SID/STAR follow the route the user actually picked/typed (its first
    // and last fix); fall back to the top suggestion before one is chosen.
    const src =
      (effectiveRoute && effectiveRoute.trim()) || bestRoutes[0]?.text || "";
    const known = new Set(allFixes.map((f) => f.ident));
    const toks = src
      .toUpperCase()
      .split(/\s+/)
      .filter((t) => t && t !== "DCT" && known.has(t));
    return { first: toks[0] ?? null, last: toks[toks.length - 1] ?? null };
  }, [usingAip, effectiveRoute, bestRoutes, allFixes]);

  // True when a procedure serves the selected runway (an empty/absent runway
  // set = no runway-specific legs, so it serves any runway).
  const servesRwy = (procRwy: Record<string, string[]>, name: string, rwy: string) => {
    if (!rwy) return true;
    const rws = procRwy[name];
    return !rws || rws.length === 0 || rws.includes(rwy);
  };

  const sidShown = useMemo(() => {
    // 1) narrow to the selected departure runway's SIDs (if a runway is set).
    const byRwy = sidOptions.filter((n) => servesRwy(sidProcRwy, n, depRwy));
    // 2) then to the ones connecting to the route's first fix (soft filter).
    const f = routeEndFixes.first;
    if (!f) return byRwy;
    const m = byRwy.filter((n) => f.startsWith(n.match(/^[A-Z]+/)?.[0] ?? n));
    return m.length > 0 ? m : byRwy;
  }, [sidOptions, routeEndFixes, depRwy, sidProcRwy]);

  const starShown = useMemo(() => {
    const byRwy = starOptions.filter((n) => servesRwy(starProcRwy, n, arrRwy));
    const f = routeEndFixes.last;
    if (!f) return byRwy;
    const m = byRwy.filter((n) => f.startsWith(n.match(/^[A-Z]+/)?.[0] ?? n));
    return m.length > 0 ? m : byRwy;
  }, [starOptions, routeEndFixes, arrRwy, starProcRwy]);

  // PBN approaches for the SELECTED arrival runway — the user picks the
  // runway first, then its approaches appear (RW09 → R09-Y, R09-Z).
  const approachShown = useMemo(
    () => (arrRwy ? approachByRwy[arrRwy] ?? [] : []),
    [approachByRwy, arrRwy],
  );

  // SID/STAR are picked explicitly, with ONE exception: when the filters have
  // left a single procedure to choose from, it is selected for the user (see
  // the auto-pick effects below). Short of that they default to "None
  // (direct)" and stay related to the runway — the picker lists only the
  // chosen RWY's procedures (sidShown/starShown), and changing ADEP/ADES
  // resets the pair to RWY=Auto + SID/STAR=None (see the ADEP/ADES change
  // handlers). The best-connecting-procedure engine endpoint still exists
  // (api.suggestProcedure) if a full auto-suggest UX is wanted later.

  // When the runway changes, drop a SID/STAR that doesn't serve the new
  // runway (the picker only lists that runway's procedures, so the stale pick
  // must clear to None too).
  //
  // Dropping it SILENTLY is what makes an import look broken: a filed plan
  // arrives with a SID, the field reads "None (direct departure)", and nothing
  // says why. Remember what was dropped and say so under the pickers.
  const [sidDropped, setSidDropped] = useState<{ name: string; rwy: string } | null>(
    null,
  );
  const [starDropped, setStarDropped] = useState<{ name: string; rwy: string } | null>(
    null,
  );
  // …and the mirror of it: the procedure that was filled in for the user
  // because the filters left exactly one (see the auto-pick effects below).
  // Named under the pickers too, so an auto-pick is never a silent one.
  const [sidAuto, setSidAuto] = useState<string | null>(null);
  const [starAuto, setStarAuto] = useState<string | null>(null);
  useEffect(() => {
    setSidDropped(null);
    setSidAuto(null);
  }, [dep]);
  useEffect(() => {
    setStarDropped(null);
    setStarAuto(null);
  }, [des]);
  useEffect(() => {
    if (sid && !servesRwy(sidProcRwy, sid, depRwy)) {
      setSidDropped({ name: sid, rwy: depRwy });
      setSid("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depRwy, sidProcRwy]);
  useEffect(() => {
    if (star && !servesRwy(starProcRwy, star, arrRwy)) {
      setStarDropped({ name: star, rwy: arrRwy });
      setStar("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrRwy, starProcRwy]);

  // --- Auto-pick when the filters leave exactly one procedure --------------
  // The pickers narrow twice — to the runway's procedures, then to the ones
  // that connect to the route (sidShown/starShown). When ONE name survives,
  // the data holds no choice any more, and a field left on "None (direct)"
  // generates the flight without the procedure it was always going to fly.
  //
  // Two guards keep this from taking a decision that is the controller's:
  //   * a SID/STAR the user already picked is never replaced — only an empty
  //     field, or one the runway filter is about to clear anyway, is filled;
  //   * choosing "None" records the context it was declined in, and that exact
  //     context (aerodrome | runway | procedure) is never offered again.
  const sidDeclined = useRef(new Set<string>());
  const starDeclined = useRef(new Set<string>());

  /** The offer currently on the table, `null` when there is nothing to offer
   *  or the field is already filled. Also the key the decline is recorded
   *  under: a different runway — or a route leading to a different lone
   *  procedure — is a new offer, not the one that was turned down. */
  const sidOffer = useMemo(() => {
    const only = soleProcedure(sidShown);
    if (!dep || !only) return null;
    return { name: only, key: `${dep}|${depRwy}|${only}` };
  }, [dep, depRwy, sidShown]);
  const starOffer = useMemo(() => {
    const only = soleProcedure(starShown);
    if (!des || !only) return null;
    return { name: only, key: `${des}|${arrRwy}|${only}` };
  }, [des, arrRwy, starShown]);

  useEffect(() => {
    if (!sidOffer || sidDeclined.current.has(sidOffer.key)) return;
    // A pick that still serves the runway is the user's and stays. One that
    // does NOT is the stale pick the drop effect above is clearing in this
    // same pass — this effect is declared after it, so its write lands last
    // and the lone valid SID replaces it instead of leaving the field empty.
    if (sid && servesRwy(sidProcRwy, sid, depRwy)) return;
    setSid(sidOffer.name);
    setSidAuto(sidOffer.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidOffer, sid, depRwy, sidProcRwy]);

  useEffect(() => {
    if (!starOffer || starDeclined.current.has(starOffer.key)) return;
    if (star && servesRwy(starProcRwy, star, arrRwy)) return;
    setStar(starOffer.name);
    setStarAuto(starOffer.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starOffer, star, arrRwy, starProcRwy]);

  // --- STAR -> runway -> approach, in that order ---------------------------
  // The three are one decision, not three independent pickers: a STAR is coded
  // to the runway it feeds, and a runway's approach is often the only one
  // published for it (a runway may have exactly one RNP). Left unlinked, picking the
  // STAR still left the approach on "None", and the arrival was generated
  // without the procedure that belongs to it.

  /** A STAR that serves exactly ONE runway names it. With the runway still on
   *  Auto the engine would pick the aerodrome's first, which need not be the
   *  one the chosen procedure is coded for. */
  useEffect(() => {
    if (!star || arrRwy) return;
    const only = soleRunwayOf(starProcRwy, star);
    if (only) setArrRwy(only);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [star, arrRwy, starProcRwy]);

  /** `${ADES}|${RWY}` whose sole approach has already been offered, so a
   *  controller who then chooses "None" is not overridden on the next render. */
  const approachAutoKey = useRef("");
  useEffect(() => {
    if (!des || !arrRwy) return;
    const key = `${des}|${arrRwy}`;
    if (approachAutoKey.current === key) return;
    // Only when there is NOTHING to choose between (see `soleApproachFor`).
    const only = soleApproachFor(approachByRwy, arrRwy);
    if (!only) return;
    approachAutoKey.current = key;
    if (!approach) setApproach(only);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [des, arrRwy, approachByRwy, approach]);

  // An approach belongs to one arrival runway; drop it when the runway is
  // cleared or changed to one it doesn't serve. The runway is derived from the
  // approach NAME (R36 → RW36, R09-Z → RW09), NOT from `approachShown`, so an
  // imported approach survives the async `approachByRwy` load — that index is
  // momentarily empty right after a draft sets ades/arrRwy/approach together,
  // and keying off it would wrongly wipe the just-imported value.
  useEffect(() => {
    if (!approach) return;
    if (!arrRwy) {
      setApproach("");
      return;
    }
    const m = /^R(\d{2}[LCR]?)(?:-.*)?$/.exec(approach.trim().toUpperCase());
    const rwyOfApproach = m ? `RW${m[1]}` : null;
    if (rwyOfApproach && rwyOfApproach !== arrRwy) setApproach("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrRwy, approach]);

  /** Queue one (route, SID, STAR) combination (deduped + capped). */
  const addCombo = (c: RouteCombo) => {
    if (!c.route.trim()) return;
    setRoutes((xs) =>
      xs.length >= routeTotal || xs.some((x) => comboKey(x) === comboKey(c))
        ? xs
        : [...xs, c],
    );
  };

  /** "+ Add route" — queue the CURRENT selection: the picked/typed route
   *  with the currently-chosen SID/STAR. (Workflow: pick route, then
   *  SID/STAR, then add.) */
  const addCurrent = () => {
    const route = effectiveRoute.trim();
    if (!route) return;
    addCombo({ route, sid, star });
  };

  /** "Add all combinations" — every listed route × (its SIDs + no-SID) ×
   *  (its STARs + no-STAR), up to the total cap. */
  const addAllCombos = () => {
    const all: RouteCombo[] = [];
    for (const r of bestRoutes) {
      const { sids, stars } = routeProcs(r.text);
      for (const s of ["", ...sids])
        for (const t of ["", ...stars])
          all.push({ route: r.text, sid: s, star: t });
    }
    setRoutes((prev) => {
      const seen = new Set(prev.map(comboKey));
      const merged = [...prev];
      for (const c of all) {
        const k = comboKey(c);
        if (!seen.has(k)) {
          seen.add(k);
          merged.push(c);
        }
      }
      return merged.slice(0, routeTotal);
    });
  };

  /** Drop the active tab's route selection — the queue, the typed Item-15
   *  string and any picked waypoints. A route is specific to its city pair,
   *  so changing ADEP/ADES (e.g. after a Duplicate) must clear the routes
   *  carried over from the previous flight. Called only from the airport
   *  comboboxes' onChange (a user action) — never from loadDraft, so
   *  switching tabs / importing still restores each plan's own routes. */
  const clearRouteSelection = () => {
    setRoutes([]);
    setRouteStr("");
    setBuiltWpts([]);
  };
  // Changing EITHER aerodrome invalidates the whole terminal setup (the route
  // is cleared, so its SID/STAR/approach no longer apply). Reset those to None,
  // and the runways to the measured default of the aerodrome they belong to.
  //
  // Only the CHANGED end drops to Auto — its own effect re-fills it once the
  // new aerodrome resolves (or leaves it on Auto when that aerodrome has no
  // usable default). The other end keeps ITS default, which is still valid:
  // editing the ADEP says nothing about which runway the ADES is landing on,
  // and dropping it to Auto left the picker contradicting the hint right under
  // it ("Aug default: RW36 · 98% of arrivals" over an "Auto" select).
  const resetTerminal = (changed: "dep" | "arr") => {
    setSid("");
    setStar("");
    setApproach("");
    // Release the one-shot auto-fill claims. They exist so a draft's saved
    // runway survives, but they are keyed by `${airport}|${month}` and were
    // never released — so returning to an aerodrome already visited this
    // session found its key claimed and skipped the default for good.
    depAutoKey.current = "";
    arrAutoKey.current = "";
    setDepRwy(changed === "dep" ? "" : depRwyDefault?.ident ?? "");
    setArrRwy(changed === "arr" ? "" : arrRwyDefault?.ident ?? "");
  };
  const handleAdepChange = (v: string) => {
    const nv = v.trim().toUpperCase();
    if (nv !== adep.trim().toUpperCase()) {
      clearRouteSelection();
      resetTerminal("dep");
      // ADES cascades from ADEP: if the new ADEP publishes AIP destinations
      // and the current ADES isn't one of them, clear it so the dependent
      // dropdown stays consistent.
      const dests = new Set(
        aipRoutes
          .filter((r) => r.adep.toUpperCase() === nv)
          .map((r) => r.ades.toUpperCase()),
      );
      if (dests.size > 0 && ades && !dests.has(ades.trim().toUpperCase())) {
        setAdes("");
      }
    }
    setAdep(v);
  };
  const handleAdesChange = (v: string) => {
    if (v.trim().toUpperCase() !== ades.trim().toUpperCase()) {
      clearRouteSelection();
      resetTerminal("arr");
    }
    setAdes(v);
  };

  // What the FPL route portion resolves to (for the live preview).
  const previewRoute = routeMode === "build" ? builtRoute : routeStr.trim();

  /**
   * The whole plan, not just the route portion.
   *
   * This used to be `callsign actype adep ades route` and nothing else, so a
   * flight with a STAR, an arrival runway and an approach picked in the
   * dropdowns immediately above previewed as though it had none of them — the
   * values were being sent to the engine all along (see the request built in
   * `generate`), they were simply missing from the line that claims to show
   * what will be filed.
   *
   * The SID and STAR bracket the route, which is how Item 15 reads: procedure
   * out, airways, procedure in. Runways and the approach are NOT part of an
   * Item-15 string, so they follow as an annotation rather than being pretended
   * into it. Every piece appears only when it is set, so a plan with no
   * procedures still reads exactly as it did before.
   */
  const previewFpl = (() => {
    if (!(callsign && adep && ades && previewRoute)) return "";
    const item15 = [sid, previewRoute, star].filter(Boolean).join(" ");
    const head = `${callsign} ${actype} ${adep} ${ades} ${item15}`.trim();
    const tail = [
      depRwy && `DEP ${depRwy}`,
      arrRwy && `ARR ${arrRwy}`,
      approach && `APP ${approach}`,
    ].filter(Boolean);
    return tail.length ? `${head}  ·  ${tail.join("  ·  ")}` : head;
  })();

  // The single route the user is editing *right now* — the "section in
  // progress". Skipped if the edit string is already queued, to avoid
  // drawing it twice. Folded into both preview scopes below.
  const inProgressPreview = useMemo<PreviewPoint[]>(() => {
    if (allFixes.length === 0) return [];
    const editorRoute = (routeMode === "build" ? builtRoute : routeStr).trim();
    // Splice the editor's SID/STAR around the typed route — or, when an end
    // is "None (direct)", anchor it at the ADEP/ADES so the direct leg shows.
    const withProc = (pts: PreviewPoint[]) =>
      splicePreviewProcedures(
        pts,
        sidEnd(dep, sid, editorRoute),
        starEnd(des, star, editorRoute),
      );
    if (routeMode === "build") {
      const trimmed = builtRoute.trim();
      return trimmed && !routes.some((c) => c.route === trimmed)
        ? withProc(resolvePreviewFromIdents(builtWpts, allFixes))
        : [];
    }
    const trimmed = routeStr.trim();
    return trimmed && !routes.some((c) => c.route === trimmed)
      ? withProc(resolveRoutePreview(trimmed, allFixes, airwaysMap))
      : [];
  }, [
    routeMode,
    routeStr,
    builtRoute,
    builtWpts,
    routes,
    allFixes,
    airwaysMap,
    dep,
    des,
    sid,
    star,
    sidEnd,
    starEnd,
  ]);

  // "Current" preview scope — the active tab's flight only: its queued
  // routes plus the route being typed/built. This is the flight the user
  // is composing right now (every queued route, not just the edit box).
  const currentPreview = useMemo<PreviewPoint[][]>(() => {
    if (allFixes.length === 0) return [];
    const out: PreviewPoint[][] = [];
    for (const c of routes) {
      const pts = resolveRoutePreview(c.route, allFixes, airwaysMap);
      if (pts.length === 0) continue;
      out.push(
        splicePreviewProcedures(
          pts,
          sidEnd(dep, c.sid, c.route),
          starEnd(des, c.star, c.route),
        ),
      );
    }
    if (inProgressPreview.length > 0) out.push(inProgressPreview);
    return out;
  }, [routes, allFixes, airwaysMap, inProgressPreview, dep, des, sidEnd, starEnd]);

  // "Full" preview scope — every route across EVERY plan/tab, not just the
  // active one, so a duplicated/previous flight's routes stay previewed
  // while a new tab is edited. The active tab uses the live queue (`routes`)
  // + the in-progress section; other tabs use their stored route list.
  const previewRoutes = useMemo<PreviewPoint[][]>(() => {
    if (allFixes.length === 0) return [];
    const out: PreviewPoint[][] = [];
    // Each combo's SID/STAR is spliced in (from the cache); a procedure not
    // yet loaded — e.g. an inactive tab we haven't fetched — just leaves that
    // route's line unchanged until it loads.
    const resolveAll = (combos: RouteCombo[], a: string, b: string) => {
      for (const c of combos) {
        const s = c.route.trim();
        if (!s) continue;
        const pts = resolveRoutePreview(s, allFixes, airwaysMap);
        if (pts.length === 0) continue;
        out.push(
          splicePreviewProcedures(
            pts,
            sidEnd(a, c.sid, c.route),
            starEnd(b, c.star, c.route),
          ),
        );
      }
    };
    for (const p of plans) {
      // Active tab: only its queued routes here — the route being typed is
      // appended once below (avoids a double-draw).
      if (p.id === activeId) resolveAll(routes, dep, des);
      else
        resolveAll(
          draftCombos(p),
          p.adep.trim().toUpperCase(),
          p.ades.trim().toUpperCase(),
        );
    }
    if (inProgressPreview.length > 0) out.push(inProgressPreview);
    return out;
  }, [
    plans,
    activeId,
    routes,
    allFixes,
    airwaysMap,
    inProgressPreview,
    dep,
    des,
    sidEnd,
    starEnd,
  ]);

  useEffect(() => {
    onPreviewChange?.(previewRoutes);
  }, [previewRoutes, onPreviewChange]);

  // Emit the active tab's flight on its own so the map's "Current" scope
  // can draw just this flight (queue + in-progress) and not the others.
  useEffect(() => {
    onCurrentPreviewChange?.(currentPreview);
  }, [currentPreview, onCurrentPreviewChange]);

  /** Turn a parsed flight row into a full PlanDraft. */
  function recordToPlan(r: FlightRecord): PlanDraft {
    const p = blankPlan();
    if (r.callsign) p.callsign = r.callsign;
    if (r.actype) p.actype = r.actype;
    if (r.adep) p.adep = r.adep;
    if (r.ades) p.ades = r.ades;
    if (r.eobt) p.eobt = r.eobt;
    if (r.rfl != null) p.rfl = r.rfl;
    if (r.gsKt != null) p.gsKt = r.gsKt;
    if (r.entryFl != null) p.entryFl = r.entryFl;
    if (r.sid) p.sid = r.sid;
    if (r.star) p.star = r.star;
    if (r.approach) p.approach = r.approach;
    if (r.depRwy) p.depRwy = r.depRwy;
    if (r.arrRwy) p.arrRwy = r.arrRwy;
    // A multi-route flight rebuilds as ONE plan with a route queue; a
    // single-route flight fills the Item-15 box.
    if (r.routes && r.routes.length > 0)
      p.routes = r.routes.map((rt) => ({
        route: rt,
        sid: r.sid ?? "",
        star: r.star ?? "",
      }));
    else if (r.route) p.routeStr = r.route;
    return p;
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      const all: FlightRecord[] = [];
      for (const f of Array.from(files)) {
        all.push(...(await parseFlightFile(f)));
      }
      if (all.length === 0) throw new Error("No flight rows found in file.");

      // A new file is a new traffic sample: whatever departure conflicts were
      // dismissed for the last one must not silence this one's.
      setIgnoredDepConflicts(new Set());
      setDepFix(null);
      setDepFixChoiceFor(null);

      // Bulk import: one tab per row, ready for "Generate all" (the
      // whole-network traffic-day case). Replaces the current plan set.
      const drafts = all.map(recordToPlan);
      setPlans(drafts);
      loadDraft(drafts[0]);
      setActiveId(drafts[0].id);

      // If EVERY imported flight carries a full 4D path (this tool's trajectory
      // export, e.g. a post-CD&R-fix download), load it AS-IS — show the saved
      // trajectory without regenerating, so an applied fix survives the round
      // trip. The plan tabs are still populated for reference/editing.
      const allHaveTraj =
        all.length > 0 &&
        all.every((r) => r.trajectory && r.trajectory.points.length >= 2);
      if (allHaveTraj) {
        setBusy(true);
        try {
          const built = (await Promise.all(all.map(buildImportedResult))).filter(
            (x): x is { result: TrajectoryResult; download: DownloadInfo } =>
              x != null,
          );
          setFlightQuery("");
          setRouteQuery("");
          setResults(built.map((b) => b.result));
          setDlList(built.map((b) => b.download));
          setWarnings([]);
          setError(null);
          setFileNote(
            `Loaded ${built.length} flight${built.length === 1 ? "" : "s"} as-is ` +
              `from file (no regeneration) — the saved trajectory is shown. ` +
              `Edit a tab and Generate to recompute.`,
          );
        } finally {
          setBusy(false);
        }
        return;
      }

      setFileNote(
        all.length > 1
          ? `Imported ${all.length} flights into tabs — edit any, then "Generate all"`
          : "Loaded from file — review and edit before Generate",
      );
    } catch (e) {
      setFileNote(null);
      setError(e instanceof Error ? e.message : "Could not parse file.");
    }
  }

  /** Speed-schedule overrides — only the fields the user actually set, so
   *  blanks keep the airframe default server-side. Shared by single +
   *  batch generation. */
  // --- DISABLED: speed schedule (advanced) — kept for future use. ---
  // function buildSpeedOverrides(): Partial<GenerateInput> {
  //   const num = (s: string) => {
  //     const v = parseFloat(s);
  //     return Number.isFinite(v) ? v : undefined;
  //   };
  //   return {
  //     ...(num(climbCas) !== undefined ? { climb_cas_kt: num(climbCas) } : {}),
  //     ...(num(cruiseMach) !== undefined ? { cruise_mach: num(cruiseMach) } : {}),
  //     ...(num(descentCas) !== undefined ? { descent_cas_kt: num(descentCas) } : {}),
  //     ...(num(descentMach) !== undefined ? { descent_mach: num(descentMach) } : {}),
  //     ...(num(restrictCas) !== undefined ? { restrict_cas_kt: num(restrictCas) } : {}),
  //   };
  // }

  // Stage 1 — narrow to the matched flight(s) by callsign / ADEP-ADES.
  const flightFiltered = useMemo(
    () =>
      results
        .map((r, i) => ({ r, dl: dlList[i], i }))
        .filter(({ r }) =>
          matchesFlight(flightQuery, {
            callsign: r.meta.callsign,
            adep: r.meta.adep,
            ades: r.meta.ades,
          }),
        ),
    [results, dlList, flightQuery],
  );

  // Stage 2 — within those, optionally pick a specific route (empty route
  // box = every route of the matched flight). Shares the matcher with the
  // Route Profile search so both behave identically.
  const filtered = useMemo(
    () =>
      flightFiltered.filter(({ dl, i }) =>
        matchesRoute(routeQuery, { route: dl?.route ?? "", index: i }),
      ),
    [flightFiltered, routeQuery],
  );

  // Flight-field options (one row per generated flight) and route-field
  // options (one row per route, scoped to the flight already chosen).
  const flightSugg = useMemo(
    () =>
      flightOptions(
        results.map((r) => ({
          callsign: r.meta.callsign,
          adep: r.meta.adep,
          ades: r.meta.ades,
        })),
      ),
    [results],
  );
  const routeSugg = useMemo(
    () =>
      routeOptions(
        flightFiltered.map(({ r, dl, i }) => ({
          route: dl?.route ?? "",
          index: i,
          distanceNm: r.stats.distanceNm,
        })),
      ),
    [flightFiltered],
  );

  // Search-driven map: emit only the matched flights (and their downloads)
  // upward. Null when nothing matches so the map clears. `filtered` is a
  // stable useMemo, so this fires only when results/downloads or either
  // search box change — the parent callbacks are intentionally excluded
  // from the deps to avoid a re-emit loop (onResult is inline in MapApp).
  useEffect(() => {
    onResult(filtered.length ? filtered.map((p) => p.r) : null);
    onDownloadsChange?.(
      filtered.map((p) => p.dl).filter(Boolean) as DownloadInfo[],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  /** Generate EVERY plan's routes in one batch request. */
  async function generateAll() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      // Reflect any unsaved edits on the active tab.
      const drafts = plans.map((p) => (p.id === activeId ? snapshotActive() : p));
      // --- DISABLED: speed schedule (advanced) — kept for future use. ---
      // const overrides = buildSpeedOverrides();

      const built: { input: GenerateInput; label: string }[] = [];
      const skipped: string[] = [];
      for (const d of drafts) {
        const dp = d.adep.trim().toUpperCase();
        const ds = d.ades.trim().toUpperCase();
        if (!dp || !ds || dp === ds) {
          skipped.push(`${planLabel(d, drafts.indexOf(d))}: set distinct ADEP/ADES`);
          continue;
        }
        const list = draftCombos(d);
        if (list.length === 0) {
          skipped.push(`${planLabel(d, drafts.indexOf(d))}: no route`);
          continue;
        }
        for (const c of list) {
          built.push({
            input: {
              source: "fpl",
              adep: dp,
              ades: ds,
              actype: d.actype,
              route: c.route,
              callsign: d.callsign || "FLT",
              eobt: d.eobt,
              gs_kt: d.gsKt,
              rfl: d.rfl,
              ...(d.entryFl ? { entry_fl: d.entryFl } : {}),
              output_every_s: outputEveryS,
              // ...overrides, // DISABLED: speed schedule (advanced)
              ...(c.sid ? { sid: c.sid } : {}),
              ...(c.star ? { star: c.star } : {}),
              ...(d.depRwy ? { sid_runway: d.depRwy } : {}),
              ...(d.arrRwy ? { star_runway: d.arrRwy } : {}),
              ...(d.approach ? { approach: d.approach } : {}),
              ...(d.approach && d.approachTransition
                ? { approach_transition: d.approachTransition }
                : {}),
            },
            label: c.route || "(route)",
          });
        }
      }

      if (built.length === 0) {
        throw new Error(
          "Nothing to generate — every plan is missing ADEP/ADES or a route.",
        );
      }

      // Send the batch in chunks rather than one giant request. A 200+
      // route "Generate all" in a single POST can exceed a small/free API
      // host's request timeout or memory and drop the connection (which the
      // browser then reports as "Cannot reach the API"). Chunking keeps each
      // request small, lets the host free memory between chunks, gives live
      // progress, and lets one bad chunk fail without sinking the rest. The
      // global `start` offset keeps every route's flight_key unique.
      const CHUNK = 40;
      const allTraj: TrajectoryResult[] = [];
      const allDownloads: DownloadInfo[] = [];
      const notes: string[] = [...skipped];

      for (let start = 0; start < built.length; start += CHUNK) {
        const chunk = built.slice(start, start + CHUNK);
        const done = Math.min(start + chunk.length, built.length);
        setGenProgress(`Generating ${done}/${built.length}…`);
        try {
          const { results: batch, errors } = await generateBatch(
            chunk.map((b) => b.input),
            start,
          );
          // Within a chunk the k-th success aligns to the k-th non-failed
          // spec — recover the route label that way.
          const failed = new Set(errors.map((e) => e.index));
          const okLabels = chunk
            .filter((_, i) => !failed.has(i))
            .map((b) => b.label);
          batch.forEach((s, i) => {
            allTraj.push(s.result);
            allDownloads.push({
              callsign: s.result.meta.callsign,
              flightKey: s.result.meta.flightKey,
              route: okLabels[i] ?? "(route)",
              gpkg: s.downloads.gpkg,
              csv: s.downloads.csv,
              geojson: s.downloads.geojson,
            });
          });
          notes.push(...batch.flatMap((s) => s.warnings));
          notes.push(
            ...errors.map(
              (e) => `${e.callsign} ${e.adep}→${e.ades}: ${e.detail}`,
            ),
          );
        } catch (chunkErr) {
          // A whole chunk failed (e.g. a cold-start timeout). Record it and
          // keep going — later chunks usually succeed once the host is warm.
          notes.push(
            `Routes ${start + 1}-${done} failed: ` +
              (chunkErr instanceof Error ? chunkErr.message : "request failed"),
          );
        }
      }

      setFlightQuery("");
      setRouteQuery("");
      setResults(allTraj);
      setDlList(allDownloads);
      setWarnings(notes);
      if (allTraj.length === 0) {
        setError(
          "All flights failed — see the messages below. If this says " +
            "'Cannot reach the API', the server may be waking up; wait ~30s " +
            "and try again.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Batch generation failed.");
      setResults([]);
      setDlList([]);
    } finally {
      setGenProgress("");
      setBusy(false);
    }
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const dep = adep.trim().toUpperCase();
      const des = ades.trim().toUpperCase();

      // Any distinct ICAO pair is routable now; the server resolves the
      // typed route against the full AIP navdata.
      if (!dep || !des) {
        throw new Error("ADEP and ADES are required.");
      }
      if (dep === des) {
        throw new Error(`ADEP and ADES must differ (both ${dep}).`);
      }

      // "build" piggybacks the FPL pipeline with the composed string; the
      // route is flown exactly as typed/built.
      const apiRoute = routeMode === "build" ? builtRoute : routeStr;

      if (
        routeMode === "build" &&
        builtWpts.length < 2 &&
        routes.length === 0
      ) {
        throw new Error("Add at least 2 waypoints to build a route.");
      }
      if (routeMode === "fpl" && !routeStr.trim() && routes.length === 0) {
        throw new Error("Enter an Item-15 route string.");
      }

      // One trajectory per (route, SID, STAR) combo: fly the queued combos,
      // or the single box if none queued (carrying the editor's current
      // SID/STAR).
      const comboList: RouteCombo[] =
        routes.length > 0 ? routes : [{ route: apiRoute, sid, star }];
      const multi = comboList.length > 1;

      const settled = await Promise.all(
        comboList.map((c, i) =>
          generateTrajectory({
            source: "fpl",
            adep: dep,
            ades: des,
            actype,
            route: c.route,
            // Callsign stays exactly what the user typed (or "FLT" as
            // the default for an unfilled field). Multi-route requests
            // disambiguate via flight_index instead, so the Callsign
            // column in the exported CSV isn't munged with a route number.
            callsign: callsign || "FLT",
            eobt,
            gs_kt: gsKt,
            rfl,
            ...(entryFl ? { entry_fl: entryFl } : {}),
            output_every_s: outputEveryS,
            ...(c.sid ? { sid: c.sid } : {}),
            ...(c.star ? { star: c.star } : {}),
            ...(depRwy ? { sid_runway: depRwy } : {}),
            ...(arrRwy ? { star_runway: arrRwy } : {}),
            ...(approach ? { approach } : {}),
            ...(approach && approachTransition
              ? { approach_transition: approachTransition }
              : {}),
            ...(multi ? { flight_index: i } : {}),
          }),
        ),
      );

      const trajectories = settled.map((s) => s.result);
      const newDownloads: DownloadInfo[] = settled.map((s, i) => ({
        callsign: s.result.meta.callsign,
        flightKey: s.result.meta.flightKey,
        route: [comboList[i].sid, comboList[i].route || "(route)", comboList[i].star]
          .filter(Boolean)
          .join(" · "),
        gpkg: s.downloads.gpkg,
        csv: s.downloads.csv,
        geojson: s.downloads.geojson,
      }));
      // The search-filter effect emits the (filtered) set to the map.
      setFlightQuery("");
      setRouteQuery("");
      setResults(trajectories);
      setDlList(newDownloads);
      setWarnings(settled.flatMap((s) => s.warnings));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
      setResults([]);
      setDlList([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gen">
      {/* Stat pills + batch action (mirrors the header in the mockup). */}
      <div className="plans-stats">
        <span className="plans-stat">
          <span className="ps-ico" aria-hidden>
            ≣
          </span>{" "}
          Plans: <b>{plans.length}</b>
        </span>
        <span className="plans-stat">
          <span className="ps-ico" aria-hidden>
            ⇄
          </span>{" "}
          Routes: <b>{totalRoutes}</b>
        </span>
        <span className="plans-stat">
          <span className="ps-ico" aria-hidden>
            ⌖
          </span>{" "}
          Airports: <b>{uniqueAirports.size}</b>
        </span>
        {/* Up here with the counters rather than under the form: the form runs
            to several screens once a plan is open, and on the preview page —
            where the rail is the only column — a footer button is simply below
            the fold. This is the one action that applies to every plan, so it
            belongs beside the count of them. */}
        <button
          type="button"
          className="plans-genall"
          onClick={generateAll}
          disabled={busy}
          title="Generate every plan's routes in one batch"
        >
          {busy ? genProgress || "Generating…" : "▶ Generate all"}
        </button>
      </div>

      {/* Search across the FPL tabs (callsign / ADEP / ADES / route). Shown
          once there's more than one plan — most useful after a bulk import. */}
      {plans.length > 1 && (
        <div className="plans-search-row">
          <input
            type="search"
            className="plans-search"
            value={planQuery}
            onChange={(e) => setPlanQuery(e.target.value)}
            placeholder="Search FPL — callsign / ADEP / ADES / route"
            aria-label="Search flight plans"
          />
          {planQuery && (
            <span className="plans-search-count">
              {planTabRows.length}/{plans.length}
            </span>
          )}
        </div>
      )}

      {/* Plan tab strip (underline tabs). */}
      <div className="plans-tabs" role="tablist">
        {planTabRows.map(({ d, i }) => (
          <div
            key={d.id}
            className={`plan-tab${d.id === activeId ? " active" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={d.id === activeId}
              onClick={() => switchTo(d.id)}
            >
              {planLabel(d, i)}
            </button>
            {plans.length > 1 && (
              <button
                type="button"
                className="plan-x"
                title="Remove this plan"
                onClick={() => removePlan(d.id)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {planTokens.length > 0 && planTabRows.length === 0 && (
          <span className="plans-nomatch">No FPL matches “{planQuery}”.</span>
        )}
        <button
          type="button"
          className="plan-add"
          title="Add a flight plan"
          onClick={addPlan}
        >
          +
        </button>
      </div>

      <>
          {/* Departure separation between the FILED PLANS — the pairs that
              cannot both be cleared off the runway as filed. The list itself
              lives in the right-hand conflict rail with the other CD&R panels;
              what belongs HERE is the count and the way to it, because this is
              the panel the user is looking at when a file lands. */}
          {/* PDR route check over the filed plans — a routing through an
              active restricted area is worth seeing BEFORE it is flown. Same
              pointer pattern as the departure conflicts below. */}
          {pdrPlanFlights.length > 0 &&
            (pdrPlanConflicts > 0 ||
              pdrPlan.loading ||
              pdrPlan.scanning ||
              pdrPlan.error) && (
            <button
              type="button"
              className={
                "dep-conf-pointer pdr-conf-pointer" +
                (pdrPlan.error ? " failed" : "")
              }
              onClick={() => {
                // A failed load is retried from here as well as opened: the
                // panel is no use until the AIP data is in.
                if (pdrPlan.error) pdrPlan.retry();
                onOpenPdrCheck?.();
              }}
              title={
                pdrPlan.error
                  ? "The AIP restricted-area data could not be loaded — click to retry"
                  : "Open the route & area check — P/D/R area conflicts and published-route (PDR) rules"
              }
            >
              <span className="dep-conf-pointer-txt">
                {pdrPlan.error ? (
                  <>⚠ Route &amp; area check unavailable — data did not load</>
                ) : pdrPlan.loading || pdrPlan.scanning ? (
                  <>
                    <span className="dlm-spin" aria-hidden="true" /> Checking routes &amp; P/D/R areas…
                    {pdrPlan.scanning && pdrPlanConflicts > 0 && (
                      <> ({pdrPlanConflicts} so far)</>
                    )}
                  </>
                ) : (
                  <>
                    ⚠ <b>{pdrPlanConflicts}</b> flight
                    {pdrPlanConflicts === 1 ? "" : "s"} with a route or area
                    conflict
                  </>
                )}
              </span>
              <span className="dep-conf-pointer-go">
                {pdrPlan.error ? "Retry" : "Route & Area Check"}{" "}
                <span aria-hidden="true">→</span>
              </span>
            </button>
          )}

          {depConflicts.length > 0 && (
            <button
              type="button"
              className="dep-conf-pointer"
              onClick={() => onOpenDepartureConflicts?.()}
              title="Open the Departure Conflict panel"
            >
              <span className="dep-conf-pointer-txt">
                ⚠ There {depConflicts.length === 1 ? "is" : "are"}{" "}
                <b>{depConflicts.length}</b> departure conflict
                {depConflicts.length === 1 ? "" : "s"}
              </span>
              <span className="dep-conf-pointer-go">
                Departure Conflict <span aria-hidden="true">→</span>
              </span>
            </button>
          )}

          {fileNote && (
            <p className="file-note">
              <NavIcon name="file" size={13} /> {fileNote}
            </p>
          )}

          {/* Type a plan, or bring a file. One-of-N, so it takes the segmented
              control the rest of the app uses for that. */}
          <div className="gen-entry" role="tablist" aria-label="How to enter this plan">
            <button
              type="button"
              role="tab"
              aria-selected={entryMode === "manual"}
              className={entryMode === "manual" ? "active" : undefined}
              onClick={() => setEntryMode("manual")}
            >
              Manual
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={entryMode === "import"}
              className={entryMode === "import" ? "active" : undefined}
              onClick={() => setEntryMode("import")}
            >
              Import file
            </button>
          </div>

          {entryMode === "import" && (
            <div className="gen-import-pane">
              <div
                className={`gen-import${dragging ? " drag" : ""}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  handleFiles(e.dataTransfer.files);
                }}
              >
                <span className="gen-import-ico" aria-hidden>
                  ⬆
                </span>
                <span className="gen-import-main">
                  Drop a flight-plan file, or click to choose
                </span>
                <span className="gen-import-sub">
                  CSV, JSON or GeoJSON · several files at once
                </span>
              </div>
              <p className="gen-import-note">
                Each flight in the file opens as its own plan tab. Edit any of
                them here, then <b>Generate all</b> — importing does not
                generate on its own.
              </p>
            </div>
          )}

          {/* The whole typed-in form. `hidden` rather than unmounted: every
              field keeps its state while the Import tab is up, so switching
              back does not wipe a half-filled plan. */}
          <div className="gen-form" hidden={entryMode !== "manual"}>
          <div className="field-row">
            <label className="field">
              <span>Callsign</span>
              <input
                type="text"
                value={callsign}
                placeholder="Enter callsign"
                onChange={(e) => setCallsign(e.target.value.toUpperCase())}
              />
            </label>
            <label className="field">
              <span>Aircraft type</span>
              <select
                value={actype}
                onChange={(e) => setActype(e.target.value)}
              >
                {AIRCRAFT.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>ADEP</span>
              <IdentCombobox
                value={adep}
                onChange={handleAdepChange}
                options={adepOptions}
                placeholder="Departure"
              />
            </label>
            <label className="field">
              <span>ADES</span>
              <IdentCombobox
                value={ades}
                onChange={handleAdesChange}
                options={adesOptions}
                placeholder="Destination"
              />
            </label>
          </div>

          <label className="field">
            <span>EOBT (UTC)</span>
            <input
              type="datetime-local"
              className={depFixHere ? "bad" : undefined}
              value={eobt}
              onChange={(e) => setEobt(e.target.value)}
            />
            {/* The redirect target's own field says what is wrong with this
                EOBT and what would clear it. The suggestion is the Doc 4444
                minimum exactly — no padding, so the controller can see what
                the rule actually costs. */}
            {depFixHere && (
              <span className="field-hint bad">
                ⚠ {hhmmZ(eobtToMs(eobt) ?? depFixHere.suggestedMs)} clashes with{" "}
                <b>{depFixHere.otherCallsign}</b> off {depFixHere.adep}{" "}
                {depFixHere.runway} at {hhmmZ(depFixHere.otherEobtMs)} —{" "}
                {fmtInterval(depFixHere.requiredSec)} required:{" "}
                {depFixHere.reason}. Suggested EOBT{" "}
                <b>{hhmmZ(depFixHere.suggestedMs)}</b>
                <button
                  type="button"
                  className="dep-conf-apply"
                  onClick={() => {
                    setEobt(msToEobt(depFixHere.suggestedMs));
                    setDepFix(null);
                  }}
                >
                  Use {hhmmZ(depFixHere.suggestedMs)}
                </button>
              </span>
            )}
          </label>

          <div className="field-row">
            <label className="field">
              <span>RFL</span>
              <input
                type="number"
                min={50}
                max={430}
                step={10}
                value={rfl}
                onChange={(e) => setRfl(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>GS (kt)</span>
              <input
                type="number"
                min={100}
                max={600}
                value={gsKt}
                onChange={(e) => setGsKt(Number(e.target.value))}
              />
            </label>
          </div>

          {/* Surveillance Profile — output sampling cadence for the exported
              track (and the UTC timestamps in the files). Applies to every
              plan in this generation; output density only, so the flight
              time is unaffected. */}
          <div className="field surv">
            <span>Surveillance Profile</span>
            <div
              className="surv-opts"
              role="radiogroup"
              aria-label="Surveillance Profile"
            >
              {(
                [
                  { v: "5", label: "5s", sub: "En-route Radar" },
                  { v: "4", label: "4s", sub: "CAT62 Terminal" },
                  { v: "1", label: "1s", sub: "High-rate" },
                  { v: "custom", label: "Custom", sub: "set interval" },
                ] as const
              ).map((o) => (
                <button
                  type="button"
                  key={o.v}
                  role="radio"
                  aria-checked={survMode === o.v}
                  className={`surv-opt${survMode === o.v ? " on" : ""}`}
                  onClick={() => setSurvMode(o.v)}
                >
                  <span className="surv-radio" aria-hidden />
                  <span className="surv-text">
                    <span className="surv-label">
                      {o.label}
                      {o.v === "5" && (
                        <span className="surv-default">Default</span>
                      )}
                    </span>
                    <span className="surv-sub">{o.sub}</span>
                  </span>
                </button>
              ))}
            </div>
            {survMode === "custom" && (
              <label className="surv-custom">
                <span>Interval (seconds)</span>
                <input
                  type="number"
                  min={0.5}
                  max={60}
                  step={0.5}
                  value={survCustom}
                  onChange={(e) =>
                    setSurvCustom(Number(e.target.value) || 0.5)
                  }
                />
              </label>
            )}
          </div>

          {/* Advanced: speed-schedule tuning. Collapsed by default; the
              fields override the airframe BADA defaults so the user can
              tune total flight time.
              --- DISABLED: speed schedule (advanced) — kept for future use.
              Re-enable by uncommenting this block AND the related state,
              buildSpeedOverrides(), and the ...overrides / ...speedOverrides
              spreads above. ---
          <div className="tune">
            <button
              type="button"
              className="tune-toggle"
              aria-expanded={tuneOpen}
              onClick={() => setTuneOpen((v) => !v)}
            >
              <span>
                <NavIcon name="settings" size={13} /> Speed schedule (advanced)
              </span>
              <span className="tune-caret">{tuneOpen ? "▾" : "▸"}</span>
            </button>

            {tuneOpen && (
              <div className="tune-body">
                <p className="tune-hint">
                  Leave blank to use the B738 defaults.
                </p>
                <div className="field-row">
                  <label className="field">
                    <span>Climb CAS (kt)</span>
                    <input
                      type="number"
                      placeholder="290"
                      value={climbCas}
                      onChange={(e) => setClimbCas(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Cruise Mach</span>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="0.785"
                      value={cruiseMach}
                      onChange={(e) => setCruiseMach(e.target.value)}
                    />
                  </label>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Descent CAS (kt)</span>
                    <input
                      type="number"
                      placeholder="290"
                      value={descentCas}
                      onChange={(e) => setDescentCas(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Descent Mach</span>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="0.78"
                      value={descentMach}
                      onChange={(e) => setDescentMach(e.target.value)}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Below-FL100 CAS cap (kt) — 250 ATC limit</span>
                  <input
                    type="number"
                    placeholder="250"
                    value={restrictCas}
                    onChange={(e) => setRestrictCas(e.target.value)}
                  />
                </label>
                {(climbCas ||
                  cruiseMach ||
                  descentCas ||
                  descentMach ||
                  restrictCas) && (
                  <button
                    type="button"
                    className="tune-reset"
                    onClick={() => {
                      setClimbCas("");
                      setCruiseMach("");
                      setDescentCas("");
                      setDescentMach("");
                      setRestrictCas("");
                    }}
                  >
                    Reset to defaults
                  </button>
                )}
              </div>
            )}
          </div>
          */}

          <div className="field">
            <span>Route</span>
            <div className="rt-modes" role="tablist">
              <button
                role="tab"
                aria-selected={routeTab === "aip"}
                className={routeTab === "aip" ? "active" : undefined}
                onClick={() => {
                  setRouteTab("aip");
                  setRouteMode("fpl"); // AIP picks fill the Item-15 text box
                }}
              >
                AIP
              </button>
              <button
                role="tab"
                aria-selected={routeTab === "manual"}
                className={routeTab === "manual" ? "active" : undefined}
                onClick={() => setRouteTab("manual")}
              >
                Manual
              </button>
            </div>

            {!pairReady && (
              <p className="rt-hint">
                {!dep || !des
                  ? "Enter ADEP and ADES above to start a route."
                  : "ADEP and ADES cannot be the same."}
              </p>
            )}

            {/* AIP — pick a published filed route. RNAV routes are listed, a
                route filed under both RNAV and Non-RNAV carrying both tags;
                click to fill the route, add either or both. */}
            {routeTab === "aip" &&
              pairReady &&
              (bestRoutes.length > 0 ? (
                <div className="rt-routes">
                  <span>
                    {usingAip ? "AIP filed routes" : "Best routes"} ({dep} →{" "}
                    {des})
                    {usingAip ? " — RNAV" : " — ranked shortest first"}
                  </span>
                  {(showAllRoutes ? shownRoutes : shownRoutes.slice(0, 4)).map(
                    (r) => {
                      const queued = routes.some((c) => c.route === r.text);
                      const selected = routeStr === r.text;
                      const cls = selected ? "rt-best" : "";
                      return (
                        <button
                          key={r.text}
                          type="button"
                          className={cls || undefined}
                          onClick={() => setRouteStr(r.text)}
                          title={`${r.distanceNm} NM${
                            r.simMin == null
                              ? ""
                              : ` · ~${Math.round(r.simMin)} min`
                          } — select, then pick SID/STAR and Add`}
                        >
                          {r.caps?.includes(true) && (
                            <span className="rt-cap">RNAV</span>
                          )}
                          {r.caps?.includes(false) && (
                            <span className="rt-cap non">NON-RNAV</span>
                          )}
                          {queued && <span className="rt-cap added">✓ queued</span>}
                          {r.text} · {r.distanceNm} NM
                          {r.simMin != null && <> · ~{Math.round(r.simMin)} min</>}
                        </button>
                      );
                    },
                  )}
                  {shownRoutes.length > 4 && (
                    <button
                      type="button"
                      className="rt-more"
                      onClick={() => setShowAllRoutes((v) => !v)}
                    >
                      {showAllRoutes
                        ? "See less"
                        : `See more (${shownRoutes.length - 4})`}
                    </button>
                  )}
                </div>
              ) : (
                <p className="rt-hint">
                  No AIP filed route for {dep} → {des}. Use{" "}
                  <strong>Manual</strong> to build one from this pair&apos;s
                  waypoints.
                </p>
              ))}

            {/* Manual — Type or Pick, limited to this pair's AIP waypoints. */}
            {routeTab === "manual" && (
              <>
                <div className="rt-modes rt-sub" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={routeMode !== "build"}
                    className={routeMode !== "build" ? "active" : undefined}
                    onClick={() => setRouteMode("fpl")}
                  >
                    Type
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={routeMode === "build"}
                    className={routeMode === "build" ? "active" : undefined}
                    onClick={() => setRouteMode("build")}
                  >
                    Pick waypoints
                  </button>
                </div>

                {routeMode !== "build" && (
                  <>
                    <input
                      type="text"
                      value={routeStr}
                      list="manual-fixes"
                      onChange={(e) => setRouteStr(e.target.value)}
                      placeholder="e.g. BGO W13 MIA"
                    />
                    <datalist id="manual-fixes">
                      {manualFixes.map((f) => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>
                    {pairReady && manualFixes.length > 0 && (
                      <p className="rt-hint">
                        Waypoints for {dep} → {des}:{" "}
                        <strong>{manualFixes.join(" · ")}</strong>
                      </p>
                    )}
                  </>
                )}

                {routeMode === "build" && (
                  <RouteBuilder
                    idents={manualFixes}
                    selected={builtWpts}
                    onChange={setBuiltWpts}
                  />
                )}
              </>
            )}


          </div>

          {/* Runway FIRST — pick the departure RWY at ADEP / arrival RWY at
              ADES; the SID/STAR pickers below then list only that runway's
              procedures. "Auto" = let the engine pick the first runway. */}
          <div className="field-row">
            <label className="field">
              <span>Departure RWY (at {dep || "ADEP"})</span>
              <select
                value={depRwy}
                onChange={(e) => setDepRwy(e.target.value)}
                disabled={!dep || depRwyOptions.length === 0}
              >
                <option value="">Auto</option>
                {depRwy && !depRwyOptions.includes(depRwy) && (
                  <option value={depRwy}>{depRwy}</option>
                )}
                {depRwyOptions.map((rw) => (
                  <option key={rw} value={rw}>
                    {rw}
                  </option>
                ))}
              </select>
              <RwyDefaultHint
                def={depRwyDefault}
                picked={depRwy}
                month={month}
                kind="departures"
              />
            </label>
            <label className="field">
              <span>Arrival RWY (at {des || "ADES"})</span>
              <select
                value={arrRwy}
                onChange={(e) => setArrRwy(e.target.value)}
                disabled={!des || arrRwyOptions.length === 0}
              >
                <option value="">Auto</option>
                {arrRwy && !arrRwyOptions.includes(arrRwy) && (
                  <option value={arrRwy}>{arrRwy}</option>
                )}
                {arrRwyOptions.map((rw) => (
                  <option key={rw} value={rw}>
                    {rw}
                  </option>
                ))}
              </select>
              <RwyDefaultHint
                def={arrRwyDefault}
                picked={arrRwy}
                month={month}
                kind="arrivals"
              />
            </label>
          </div>

          {/* Terminal procedures — splice a SID at ADEP / STAR at ADES into
              the enroute route. Narrowed to the selected runway (above);
              "None" leaves that end as a direct leg. */}
          <div className="field-row">
            <label className="field">
              <span>SID (at {dep || "ADEP"})</span>
              <select
                value={sid}
                onChange={(e) => {
                  setSidDropped(null);
                  setSidAuto(null);
                  // "None" turns the standing offer down for good.
                  if (!e.target.value && sidOffer)
                    sidDeclined.current.add(sidOffer.key);
                  setSid(e.target.value);
                }}
                disabled={!dep}
              >
                <option value="">None (direct departure)</option>
                {sid && !sidShown.includes(sid) && (
                  <option value={sid}>{sid}</option>
                )}
                {sidShown.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>STAR (at {des || "ADES"})</span>
              <select
                value={star}
                onChange={(e) => {
                  setStarDropped(null);
                  setStarAuto(null);
                  if (!e.target.value && starOffer)
                    starDeclined.current.add(starOffer.key);
                  setStar(e.target.value);
                }}
                disabled={!des}
              >
                <option value="">None (direct arrival)</option>
                {star && !starShown.includes(star) && (
                  <option value={star}>{star}</option>
                )}
                {starShown.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* PBN instrument approach at ADES — pick the Arrival RWY first
              (above), then its approaches appear (RW09 → R09-Y, R09-Z). Ends
              at the runway/MAPt; "None" descends the STAR straight to the
              field. */}
          <div className="field-row">
            <div className="field" aria-hidden />
            <label className="field">
              <span>Approach (at {des || "ADES"})</span>
              <select
                value={approach}
                onChange={(e) => {
                  setApproach(e.target.value);
                  setApproachTransition(""); // new approach → re-choose join
                }}
                disabled={!arrRwy || approachShown.length === 0}
                title={
                  !arrRwy
                    ? "Select an Arrival RWY first"
                    : "PBN instrument approach for the arrival runway"
                }
              >
                <option value="">None (no approach)</option>
                {approach && !approachShown.includes(approach) && (
                  <option value={approach}>{approach}</option>
                )}
                {approachShown.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Join-point picker — appears only when the route/STAR passes more
              than one of the approach's IAF entry fixes, so the pilot chooses
              where to enter (e.g. an RNP approach with two IAFs). One match or
              none → the engine auto-scores it and this stays hidden. */}
          {approach && approachEntryMatches.length > 1 && (
            <div className="field-row">
              <div className="field" aria-hidden />
              <label className="field">
                <span>Join approach at</span>
                <select
                  value={approachTransition}
                  onChange={(e) => setApproachTransition(e.target.value)}
                  title="Which entry fix the route joins the approach at"
                >
                  <option value="">Auto (best fit)</option>
                  {approachEntryMatches.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {des &&
            arrRwy &&
            Object.keys(approachByRwy).length > 0 &&
            approachShown.length === 0 && (
              <p className="rt-hint">
                No coded PBN approach for {des} {arrRwy}.
              </p>
            )}
          {(sidDropped || starDropped || sidAuto || starAuto) && (
            <p className={`rt-hint${sidDropped || starDropped ? " warn" : ""}`}>
              {sidDropped &&
                (sidAuto
                  ? `${sidDropped.name} is not coded for ${
                      sidDropped.rwy || "the selected runway"
                    } — replaced with ${sidAuto}, the only SID coded for it.`
                  : `${sidDropped.name} is not coded for ${
                      sidDropped.rwy || "the selected runway"
                    } — cleared. Pick one of that runway's SIDs, or change the Departure RWY.`)}
              {!sidDropped &&
                sidAuto &&
                `${sidAuto} is the only SID for ${dep}${
                  depRwy ? ` ${depRwy}` : ""
                } on this route — selected automatically.`}
              {(sidDropped || sidAuto) && (starDropped || starAuto) && " "}
              {starDropped &&
                (starAuto
                  ? `${starDropped.name} is not coded for ${
                      starDropped.rwy || "the selected runway"
                    } — replaced with ${starAuto}, the only STAR coded for it.`
                  : `${starDropped.name} is not coded for ${
                      starDropped.rwy || "the selected runway"
                    } — cleared. Pick one of that runway's STARs, or change the Arrival RWY.`)}
              {!starDropped &&
                starAuto &&
                `${starAuto} is the only STAR for ${des}${
                  arrRwy ? ` ${arrRwy}` : ""
                } on this route — selected automatically.`}
            </p>
          )}
          {((dep && sidOptions.length === 0) ||
            (des && starOptions.length === 0)) && (
            <p className="rt-hint">
              {sidOptions.length === 0 && starOptions.length === 0
                ? `No coded SID/STAR in the navdata for ${dep || "ADEP"} / ${
                    des || "ADES"
                  }.`
                : sidOptions.length === 0
                  ? `No coded SID for ${dep}.`
                  : `No coded STAR for ${des}.`}
            </p>
          )}

          {/* Queue of (route × SID × STAR) combinations — one flight each.
              Workflow: pick a route + SID/STAR above, then Add; or Add all.
              Total = Σ (SID+1) × (STAR+1) over the listed routes. */}
          <div className="rt-multi">
            <div className="rt-multi-btns">
              <button
                type="button"
                className="rt-add"
                onClick={addCurrent}
                disabled={!effectiveRoute.trim() || routes.length >= routeTotal}
                title="Queue the selected route with the chosen SID / STAR"
              >
                + Add route ({routes.length}/{routeTotal})
              </button>
              {usingAip && routeTotal > 1 && (
                <button
                  type="button"
                  className="rt-add-all"
                  onClick={addAllCombos}
                  disabled={routes.length >= routeTotal}
                  title="Queue every SID × route × STAR combination"
                >
                  Add all ({routeTotal})
                </button>
              )}
              {routes.length > 0 && (
                <button
                  type="button"
                  className="rt-clear"
                  onClick={() => setRoutes([])}
                  title="Clear the queue"
                >
                  Clear
                </button>
              )}
            </div>
            {routes.length > 0 && (
              <ul className="rt-queue">
                {routes.map((c, i) => (
                  <li key={`${comboKey(c)}-${i}`}>
                    <span>
                      {i + 1}.{" "}
                      {c.sid && <span className="rt-cap">{c.sid}</span>}
                      {c.route}
                      {c.star && <span className="rt-cap non">{c.star}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setRoutes((xs) => xs.filter((_, k) => k !== i))
                      }
                      title="Remove"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="fpl-prev">
            <span>PREVIEW FPL STRING</span>
            <code>{previewFpl || "— fill in the fields above —"}</code>
          </div>

          </div>

          {/* The file input itself stays mounted in both tabs: it is hidden
              either way, and unmounting it with the Import pane would drop the
              ref that the drop zone clicks through. */}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.json,.geojson,application/json,text/csv"
            multiple
            hidden
            onChange={(e) => handleFiles(e.target.files)}
          />

          {/* Bottom action bar — hint on the left, Duplicate + Generate
              on the right (mirrors the mockup footer). */}
          <div className="gen-actionbar">
            <span className="gen-actionbar-hint">
              {/* "Fill in fields above" would be pointing at a hidden form
                  while the Import tab is up. */}
              {pairReady
                ? `${dep} → ${des}`
                : entryMode === "import"
                  ? "Import a file, or switch to Manual"
                  : "Fill in fields above"}
            </span>
            <div className="gen-actionbar-btns">
              <button
                type="button"
                className="plans-dup"
                onClick={duplicatePlan}
                title="Duplicate this plan into a new tab"
              >
                ⧉ Duplicate
              </button>
              <button
                className="generate"
                onClick={handleGenerate}
                disabled={busy}
              >
                {busy
                  ? "Generating…"
                  : routes.length > 1
                    ? `▶ Generate ${routes.length} routes`
                    : "▶ Generate this plan"}
              </button>
            </div>
          </div>

          {/* Look at what these plans do before committing to generating
              them. At the end of the form because that is where the eye lands
              once the last field is filled; Generate all lives up in the
              counter row, where it stays reachable from any scroll position. */}
          {onPreview && (
            <div className="gen-footer">
              <button
                type="button"
                className="gen-preview"
                onClick={onPreview}
                title="Show these plans on the map with the route and area checks"
              >
                Preview
              </button>
            </div>
          )}
      </>

      {error && <p className="gen-error">⚠ {error}</p>}

      {warnings.length > 0 && (
        <ul className="gen-warnings">
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {results.length > 0 && (
        <div className="gen-search">
          <div className="field-row">
            <label className="field">
              <span>1 · Flight</span>
              <SearchCombo
                value={flightQuery}
                onChange={setFlightQuery}
                suggestions={flightSugg}
                placeholder="VYYY VYMD · UBA201 — empty = all flights"
              />
            </label>
            <label className="field">
              <span>2 · Route</span>
              <SearchCombo
                value={routeQuery}
                onChange={setRouteQuery}
                suggestions={routeSugg}
                placeholder="BGO W13 MIA · R2 — empty = all routes"
              />
            </label>
          </div>
          <p className="gen-results-shortcut">
            ✓ Showing <strong>{filtered.length}</strong> of {results.length}{" "}
            {results.length === 1 ? "route" : "routes"}
            <span className="gen-results-shortcut-cta">
              Open <strong>Route Profile ▾</strong> in the menu
            </span>
          </p>
        </div>
      )}
    </section>
  );
}

export default memo(GeneratorPanel);
     