"use client";

/**
 * usePdrCheck — the React seam for the PDR check.
 *
 * Loads the four AIRAC datasets the analysis needs (PDR polygons, their AIXM
 * activity times, the ENR 1.10 route table and the navdata cache) once per
 * page, then runs `analysePdr` over the supplied flights. The engine itself
 * stays pure and DOM-free in ./detect; this file exists only to feed it.
 *
 * The PDR overlay is fetched here rather than taken from the map's `sectorData`
 * because that collection is loaded lazily when the user toggles the layer on.
 * A safety check that silently reports "no conflicts" because a map layer
 * happened to be switched off would be worse than useless, so this owns its own
 * copy; `fetchSector` hits the same HTTP cache, so nothing is downloaded twice.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAip, type Fix } from "@/lib/aip";
import { fetchAipRoutes, type AipRoute } from "@/lib/aipRoutes";
import { fetchSector, type SectorCollection } from "@/lib/geojson";

import {
  fetchRouteSegments,
  indexSegments,
  type SegmentIndex,
} from "./airwayDirection";
import { buildPdrAreas, fetchPdrActivity } from "./areas";
import { analysePdr, type PdrReport } from "./detect";
import { decimatePath } from "./penetration";
import type { PdrActivityFile, PdrArea, TimedPoint } from "./types";

/** One flight to check, as the map already knows it. */
export interface PdrFlight {
  flightKey: string;
  callsign: string;
  adep: string;
  ades: string;
  actype?: string | null;
  /** The en-route string as filed. */
  filedRoute: string;
  /** Off-blocks, UTC epoch ms. */
  eobtMs: number;
  rflFt: number;
  gsKt: number;
  /** The generated trajectory, absolute-timed. */
  path: TimedPoint[];
  rnav?: boolean;
  /** True when `path` is an estimate from the filed fixes (pre-generation). */
  estimated?: boolean;
  /** ADEP / ADES coordinates, so a candidate route is profiled the same way. */
  terminals?: {
    dep?: { lat: number; lon: number } | null;
    arr?: { lat: number; lon: number } | null;
  };
}

/** Flights analysed per chunk, and how often partial results are published.
 *  A chunk is sized to stay inside a frame; publishing is coarser because each
 *  publish re-renders the whole flight list. */
const CHUNK = 100;
const PUBLISH_EVERY = 500;

/** Automatic retries before the UI has to offer a manual one. */
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

interface Loaded {
  areas: PdrArea[];
  routes: AipRoute[];
  fixes: Fix[];
  airways: Record<string, string[]>;
  activity: PdrActivityFile;
  segmentIndex: SegmentIndex;
}

export interface PdrCheckState {
  loading: boolean;
  error: string | null;
  /** Try the data load again after a failure. */
  retry: () => void;
  /** flightKey -> its report, WITHOUT the ranked alternatives. Fills in
   *  progressively while `scanning` is true. */
  reports: Map<string, PdrReport>;
  /** True while the bulk scan is still working through the flights. */
  scanning: boolean;
  /** The full report for one flight, alternatives included, on demand. */
  detailFor: (flightKey: string) => PdrReport | undefined;
  areas: PdrArea[];
  /** The AIRAC window the activity data is valid for, for the staleness note. */
  validFrom: string | null;
  validTo: string | null;
}

type TrajPoint = {
  lat: number;
  lon: number;
  altitude_ft: number | null;
  epoch_ts: string;
};

/** Paths already built, keyed by the (never mutated) points array. A CD&R fix
 *  replaces ONE trajectory's points; without this every fix re-parsed every
 *  timestamp of every flight — the single biggest cost in a playback trace. */
const pathCache = new WeakMap<ReadonlyArray<TrajPoint>, TimedPoint[]>();

/** Convert a generated trajectory into the absolute-timed path the check wants. */
export function pathFromTrajectory(points: ReadonlyArray<TrajPoint>): TimedPoint[] {
  const hit = pathCache.get(points);
  if (hit) return hit;
  const out: TimedPoint[] = [];
  for (const p of points) {
    const timeMs = Date.parse(p.epoch_ts);
    if (!Number.isFinite(timeMs)) continue;
    out.push({ lat: p.lat, lon: p.lon, altFt: p.altitude_ft ?? 0, timeMs });
  }
  const path = decimatePath(out);
  pathCache.set(points, path);
  return path;
}

export function usePdrCheck(
  flights: PdrFlight[],
  enabled = true,
): PdrCheckState {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to re-run the load. A failure must NOT be terminal: these four
  // fetches go out while the generator may be firing hundreds of trajectory
  // requests, and one of them losing a connection used to leave the check
  // permanently empty — which reads as "no conflicts" and silently removes the
  // way into the panel. Retry a few times, then leave `retry` for the UI.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  useEffect(() => {
    if (!enabled || loaded) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    Promise.all([
      fetchSector("pdr"),
      fetchPdrActivity(),
      fetchAipRoutes(),
      fetchAip(),
      fetchRouteSegments(),
    ])
      .then(([sector, activity, routes, aip, segments]) => {
        if (cancelled) return;
        const fixes: Fix[] = Object.entries(aip.waypoints ?? {})
          .filter(([, w]) => Number.isFinite(w.lat) && Number.isFinite(w.lon))
          .map(([ident, w]) => ({ ident, lat: w.lat, lon: w.lon }));
        setLoaded({
          areas: buildPdrAreas(sector as SectorCollection, activity),
          routes,
          fixes,
          airways: aip.airways ?? {},
          activity,
          segmentIndex: indexSegments(segments.segments ?? []),
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        if (attempt < MAX_LOAD_ATTEMPTS) {
          timer = setTimeout(() => setAttempt((a) => a + 1), RETRY_DELAY_MS);
        }
      });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, loaded, attempt]);

  /** One flight's analysis. `full` adds the ranked alternatives, which are only
   *  worth their cost for the flight actually on screen. */
  const analyse = useCallback(
    (f: PdrFlight, data: Loaded, full: boolean): PdrReport =>
      analysePdr({
        adep: f.adep,
        ades: f.ades,
        filedRoute: f.filedRoute,
        actype: f.actype,
        rflFt: f.rflFt,
        gsKt: f.gsKt,
        eobtMs: f.eobtMs,
        path: f.path,
        areas: data.areas,
        publishedRoutes: data.routes,
        fixes: data.fixes,
        airways: data.airways,
        segmentIndex: data.segmentIndex,
        rnav: f.rnav,
        estimated: f.estimated,
        terminals: f.terminals,
        includeSuggestions: full,
      }),
    [],
  );

  // The bulk scan runs in CHUNKS off the render path.
  //
  // A whole imported traffic sample is ~2000 plans, and analysing them takes
  // well over a second. Done in a `useMemo` that landed on the render path and
  // froze the tab on open. Here it is an effect that yields to the browser
  // between chunks, publishing partial results as it goes: the banner count
  // climbs while the page stays responsive.
  const [reports, setReports] = useState<Map<string, PdrReport>>(new Map());
  const [scanning, setScanning] = useState(false);

  // Verdicts by flight OBJECT, so a re-scan after one flight changed only
  // analyses that flight (callers reuse the objects of unchanged flights).
  // Dropped whenever the AIP data changes.
  const scanCache = useRef<{ data: Loaded | null; map: WeakMap<PdrFlight, PdrReport> }>({
    data: null,
    map: new WeakMap(),
  });
  if (scanCache.current.data !== loaded) {
    scanCache.current = { data: loaded, map: new WeakMap() };
  }

  useEffect(() => {
    if (!loaded || flights.length === 0) {
      setReports(new Map());
      setScanning(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Drop the previous verdicts before re-scanning. Keeping them avoided a
    // flicker but left the list showing the PREVIOUS edit's answer while the
    // detail pane — recomputed on demand — showed the new one: change an EOBT
    // from 0106Z to 1306Z and the row said REJECTED beside a panel of CHECKs,
    // or the reverse. A row with no verdict yet renders as "checking", which is
    // the truth.
    setReports(new Map());
    const acc = new Map<string, PdrReport>();
    let i = 0;
    let published = 0;
    setScanning(true);

    const step = () => {
      if (cancelled) return;
      const end = Math.min(i + CHUNK, flights.length);
      const cache = scanCache.current.map;
      for (; i < end; i++) {
        const f = flights[i];
        let r = cache.get(f);
        if (!r) {
          r = analyse(f, loaded, false);
          cache.set(f, r);
        }
        acc.set(f.flightKey, r);
      }
      // Publish on a coarser boundary than the work chunk: each publish
      // re-renders a panel listing every flight, which is itself not cheap.
      // The FIRST chunk always publishes, so a re-scan after an edit replaces
      // the previous verdicts straight away instead of leaving them on screen
      // until 500 flights have been re-done.
      if (i >= flights.length || i === CHUNK || i - published >= PUBLISH_EVERY) {
        published = i;
        setReports(new Map(acc));
      }
      if (i < flights.length) {
        timer = setTimeout(step, 0);
      } else {
        setScanning(false);
      }
    };
    timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [loaded, flights, analyse]);

  /** The FULL report for one flight, alternatives included, computed on demand
   *  and cached. This is what the open panel shows. */
  const detailCache = useRef(new Map<string, PdrReport>());
  const detailDataRef = useRef<Loaded | null>(null);
  const detailFlightsRef = useRef<PdrFlight[] | null>(null);
  // Invalidate on either input: new AIRAC data, or an edited plan whose route
  // would otherwise keep showing the alternatives computed for the old one.
  if (detailDataRef.current !== loaded || detailFlightsRef.current !== flights) {
    detailDataRef.current = loaded;
    detailFlightsRef.current = flights;
    detailCache.current.clear();
  }
  const detailFor = useCallback(
    (flightKey: string): PdrReport | undefined => {
      if (!loaded) return undefined;
      const hit = detailCache.current.get(flightKey);
      if (hit) return hit;
      const f = flights.find((x) => x.flightKey === flightKey);
      if (!f) return undefined;
      const full = analyse(f, loaded, true);
      detailCache.current.set(flightKey, full);
      return full;
    },
    [loaded, flights, analyse],
  );

  return {
    loading: enabled && !loaded && !error,
    error,
    retry,
    reports,
    scanning,
    detailFor,
    areas: loaded?.areas ?? [],
    validFrom: loaded?.activity.validFrom ?? null,
    validTo: loaded?.activity.validTo ?? null,
  };
}
