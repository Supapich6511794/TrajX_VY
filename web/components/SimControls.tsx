"use client";

/**
 * SimControls — playback bar for the aircraft animation.
 *
 * Sits at the bottom of the map. Play/pause/reset, a draggable time
 * scrubber, and the requested speed presets (x1 = real time … x200).
 * Hidden until a trajectory has been generated.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { TrajectoryResult } from "@/lib/trajectory/types";
import {
  fetchTransitionTable,
  flightLevelThresholdFt,
  type TransitionTable,
} from "@/lib/transitionAltitude";
import {
  SIM_SPEEDS,
  type SimPlayback,
  type SimSpeed,
} from "@/lib/useSimPlayback";
import NavIcon from "@/components/nav/NavIcon";

export type PlaybackSource = number | "all";

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The clock reads the dataset's own UTC, not wall time: `originMs` is the
 *  first sample's timestamp, so the cursor shows the stamp the exported track
 *  rows are keyed by. */
function utcAt(originMs: number, sec: number): Date {
  return new Date(originMs + Math.max(0, Math.round(sec)) * 1000);
}

/** Cursor clock — "2026-03-04 02:42:58 UTC". */
function utcStamp(originMs: number, sec: number): string {
  const iso = utcAt(originMs, sec).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** Timeline extent — time of day only ("02:42:58Z"); the date is in the title,
 *  which matters for a traffic day that runs past midnight. */
function utcTimeOfDay(originMs: number, sec: number): string {
  return `${utcAt(originMs, sec).toISOString().slice(11, 19)}Z`;
}

/** A span as "1 h 04 min" / "48 min", for the extent tooltip. */
function duration(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

/** Speed picker. Drops DOWN: the playback strip sits at the top of the map,
 *  under the global bar. */
function SpeedMenu({
  speed,
  setSpeed,
}: {
  speed: SimSpeed;
  setSpeed: (s: SimSpeed) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="sim-speed-menu" ref={ref}>
      <button
        className="sim-speed-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Playback speed"
      >
        x{speed} <span className="caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="sim-speed-pop" role="listbox">
          {[...SIM_SPEEDS]
            .slice()
            .reverse()
            .map((s) => (
              <li key={s} role="option" aria-selected={s === speed}>
                <button
                  className={s === speed ? "active" : undefined}
                  onClick={() => {
                    setSpeed(s);
                    setOpen(false);
                  }}
                  title={s === 1 ? "Real time" : `${s}× faster`}
                >
                  x{s}
                  {s === 1 ? "  (real time)" : ""}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** Coloured chip showing the current vertical phase. */
function PhaseChip({ phase }: { phase: "climb" | "cruise" | "descent" }) {
  const label = phase[0].toUpperCase() + phase.slice(1);
  return <span className={`sim-phase ph-${phase}`}>{label}</span>;
}

/** Live altitude readout: a flight level at or above `flThresholdFt` (the
 *  departure TA while climbing, the destination TL while descending — see
 *  `flightLevelThresholdFt`), feet below it. */
function AltReadout({
  ft,
  flThresholdFt,
}: {
  ft: number | null | undefined;
  flThresholdFt: number;
}) {
  if (ft == null) {
    return <span className="sim-alt">—</span>;
  }
  const ftInt = Math.round(ft);
  const display =
    ftInt >= flThresholdFt ? `FL${Math.round(ftInt / 100)}` : `${ftInt.toLocaleString()} ft`;
  return (
    <span
      className="sim-alt"
      title={`${ftInt.toLocaleString()} ft AMSL · FL above ${flThresholdFt.toLocaleString()} ft`}
    >
      {display}
    </span>
  );
}

/** Live ground-speed / true-airspeed pill. */
function SpeedReadout({
  gsKt,
  tasKt,
}: {
  gsKt: number | null | undefined;
  tasKt: number | null | undefined;
}) {
  if (gsKt == null) return null;
  const gs = Math.round(gsKt);
  return (
    <span
      className="sim-speed"
      title={
        tasKt != null
          ? `GS ${gs} kt · TAS ${Math.round(tasKt)} kt`
          : `GS ${gs} kt`
      }
    >
      <strong>{gs}</strong> kt
    </span>
  );
}

/** Compact dropdown to pick which generated route the playback engine
 *  is bound to. Hidden when there's only one route — the dropdown
 *  isn't useful for a single-flight playback. */
function RouteSourcePicker({
  trajectories,
  playbackIdx,
  onChange,
  hiddenKeys,
  onToggleHidden,
}: {
  trajectories: TrajectoryResult[];
  playbackIdx: PlaybackSource;
  onChange: (next: PlaybackSource) => void;
  /** flightKeys currently hidden on the map. */
  hiddenKeys?: Set<string>;
  /** Toggle a route's map visibility by flightKey. */
  onToggleHidden?: (flightKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Start each opening from a clean list rather than the last search.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Search over the flight identity (callsign / ADEP / ADES / type) AND the
  // route number, so "UBA" , "VYYY VYMD" and "R57" all find their row — with a
  // whole traffic day loaded this list is hundreds of entries long.
  const rows = useMemo(
    () =>
      trajectories
        .map((t, i) => ({ t, i }))
        .filter(({ t, i }) => {
          const q = query.trim().toUpperCase();
          if (!q) return true;
          return q.split(/[\s,]+/).filter(Boolean).every((tok) => {
            const hay = [
              t.meta.callsign,
              t.meta.adep,
              t.meta.ades,
              t.meta.aircraftType ?? "",
            ]
              .join(" ")
              .toUpperCase();
            return (
              hay.includes(tok) || tok === `R${i + 1}` || tok === `${i + 1}`
            );
          });
        }),
    [trajectories, query],
  );

  if (trajectories.length < 2) return null;

  const label =
    playbackIdx === "all"
      ? `All routes`
      : `R${playbackIdx + 1}`;

  return (
    <div className="sim-route-picker" ref={ref}>
      <button
        type="button"
        className="sim-route-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Replay source"
      >
        <span className="sim-route-label">{label}</span>
        <span className="caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="sim-route-menu" role="listbox">
          <li className="sim-route-search">
            <input
              type="search"
              value={query}
              placeholder="Search callsign, VYYY VYMD, R57…"
              onChange={(e) => setQuery(e.target.value)}
              // The menu closes on outside mousedown; keep clicks in the box
              // (and Escape) from bubbling out to the listbox handlers.
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
                e.stopPropagation();
              }}
              autoFocus
            />
          </li>
          {/* "All routes" is the timeline itself, not a flight, so it stays put
              regardless of the search. */}
          <li role="option" aria-selected={playbackIdx === "all"}>
            <button
              type="button"
              className={playbackIdx === "all" ? "active" : undefined}
              onClick={() => {
                onChange("all");
                setOpen(false);
              }}
              title="Play every route together on the longest timeline"
            >
              <span className="sim-route-tag all">∗</span>
              <span className="sim-route-key">All routes</span>
            </button>
          </li>
          {rows.length === 0 && (
            <li className="sim-route-empty">No flight matches “{query}”.</li>
          )}
          {rows.map(({ t, i }) => {
            const hidden = hiddenKeys?.has(t.meta.flightKey) ?? false;
            return (
              <li
                key={t.meta.flightKey}
                role="option"
                aria-selected={playbackIdx === i}
                className="sim-route-row"
              >
                <button
                  type="button"
                  className={`sim-route-pick${playbackIdx === i ? " active" : ""}${
                    hidden ? " route-hidden" : ""
                  }`}
                  onClick={() => {
                    onChange(i);
                    setOpen(false);
                  }}
                  title={`${t.meta.callsign} · ${t.meta.adep} → ${t.meta.ades}`}
                >
                  <span className="sim-route-tag">R{i + 1}</span>
                  <span className="sim-route-key">{t.meta.callsign}</span>
                  <span className="sim-route-meta">
                    {t.stats.timeMinutes} min
                  </span>
                </button>
                {onToggleHidden && (
                  <button
                    type="button"
                    className={`sim-route-eye${hidden ? " hidden" : ""}`}
                    aria-pressed={!hidden}
                    title={hidden ? "Show route on map" : "Hide route on map"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleHidden(t.meta.flightKey);
                    }}
                  >
                    {hidden ? (
                  <NavIcon name="eye-off" size={14} />
                ) : (
                  <NavIcon name="eye" size={14} />
                )}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface SimControlsProps {
  sim: SimPlayback;
  trajectories?: TrajectoryResult[];
  playbackIdx?: PlaybackSource;
  onPlaybackIdxChange?: (next: PlaybackSource) => void;
  /** flightKeys currently hidden on the map. */
  hiddenKeys?: Set<string>;
  /** Toggle a route's map visibility by flightKey. */
  onToggleRouteHidden?: (flightKey: string) => void;
  /** True when every route line is currently hidden. */
  allRoutesHidden?: boolean;
  /** Master toggle — hide/show every route line at once. */
  onToggleAllRoutes?: () => void;
}

export default function SimControls({
  sim,
  trajectories = [],
  playbackIdx = 0,
  onPlaybackIdxChange,
  hiddenKeys,
  onToggleRouteHidden,
  allRoutesHidden = false,
  onToggleAllRoutes,
}: SimControlsProps) {
  const [transitions, setTransitions] = useState<TransitionTable>(() => new Map());
  useEffect(() => {
    let live = true;
    fetchTransitionTable().then((t) => live && setTransitions(t));
    return () => {
      live = false;
    };
  }, []);
  if (!sim.ready) return null;
  // In "all routes" mode the playback clock runs on a synthetic two-point
  // span (just first/last epoch across every route), so its interpolated
  // aircraft is meaningless — the real per-route planes are drawn on the map.
  // Blank the alt/speed/phase readout there instead of showing the frozen
  // first-point value (the "always 6,000 ft" bug).
  const isAllRoutes = playbackIdx === "all";
  const ac = isAllRoutes ? null : sim.aircraft;
  const meta = isAllRoutes ? null : trajectories[playbackIdx]?.meta;
  const flThresholdFt = flightLevelThresholdFt(transitions, ac?.phase, meta?.adep, meta?.ades);
  // UTC of the clock's t=0. In "all" mode that's the earliest departure across
  // the set, otherwise the picked route's own first sample — either way it is
  // whatever `useSimPlayback` was handed, so the readout matches the map.
  const originMs = sim.originMs;
  const activeLabel = (() => {
    if (trajectories.length < 2) return null;
    if (playbackIdx === "all") return "Playing: all routes";
    const t = trajectories[playbackIdx as number];
    return t ? `Playing: R${(playbackIdx as number) + 1} · ${t.meta.callsign}` : null;
  })();

  return (
    <div className="sim">
      {/* Master visibility toggle — hides every route line at once while the
          aircraft icons stay on the map. Shown whenever a route exists. */}
      {onToggleAllRoutes && trajectories.length >= 1 && (
        <button
          type="button"
          className={`sim-btn sim-routes-eye${allRoutesHidden ? " off" : ""}`}
          onClick={onToggleAllRoutes}
          aria-pressed={!allRoutesHidden}
          title={
            allRoutesHidden
              ? "Show all route lines"
              : "Hide all route lines (aircraft stay visible)"
          }
        >
          {allRoutesHidden ? (
            <NavIcon name="eye-off" size={14} />
          ) : (
            <NavIcon name="eye" size={14} />
          )}
        </button>
      )}

      {onPlaybackIdxChange && trajectories.length >= 2 && (
        <RouteSourcePicker
          trajectories={trajectories}
          playbackIdx={playbackIdx}
          onChange={onPlaybackIdxChange}
          hiddenKeys={hiddenKeys}
          onToggleHidden={onToggleRouteHidden}
        />
      )}

      <div className="sim-live" aria-live="polite" title={activeLabel ?? undefined}>
        <AltReadout ft={ac?.altitudeFt ?? null} flThresholdFt={flThresholdFt} />
        <SpeedReadout gsKt={ac?.gsKt ?? null} tasKt={ac?.tasKt ?? null} />
        {ac && <PhaseChip phase={ac.phase} />}
      </div>

      <button
        className="sim-btn primary"
        onClick={sim.toggle}
        aria-label={sim.playing ? "Pause" : "Play"}
        title={sim.playing ? "Pause" : "Play"}
      >
        {sim.playing ? "❚❚" : "►"}
      </button>
      <button
        className="sim-btn"
        onClick={sim.reset}
        aria-label="Reset"
        title="Reset to start"
      >
        ↺
      </button>

      <span
        className="sim-time sim-clock"
        title={
          originMs != null
            ? `Replay cursor · ${duration(sim.simT)} into the timeline`
            : "Elapsed replay time"
        }
      >
        {originMs != null ? utcStamp(originMs, sim.simT) : mmss(sim.simT)}
      </span>

      <input
        className="sim-scrub"
        type="range"
        min={0}
        max={Math.max(1, Math.round(sim.total))}
        step={1}
        value={Math.round(sim.simT)}
        onChange={(e) => sim.seek(Number(e.target.value))}
        aria-label="Timeline"
      />

      <span
        className="sim-time sim-end"
        title={
          originMs != null
            ? `Timeline ends ${utcStamp(originMs, sim.total)} · ${duration(sim.total)}`
            : `Timeline length · ${duration(sim.total)}`
        }
      >
        {originMs != null ? utcTimeOfDay(originMs, sim.total) : mmss(sim.total)}
      </span>

      <SpeedMenu speed={sim.speed} setSpeed={sim.setSpeed} />
    </div>
  );
}
