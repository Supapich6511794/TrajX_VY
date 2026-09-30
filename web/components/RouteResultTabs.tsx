"use client";

/**
 * RouteResultTabs — per-route result block with two leaf sections:
 *   1. Vertical profile  (the altitude chart + TOC/TOD readouts)
 *   2. Trajectory summary (Phase 1 horizontal stats + per-waypoint table)
 *
 * Download is intentionally NOT a per-route view — it lives behind the
 * global "⬇ Download" button which opens a multi-route popup that lets
 * the user pick any subset of routes × formats. Keeping it global avoids
 * the user having to navigate per route to grab files.
 *
 * Two render modes:
 *   - Detail mode (default): mounted by the per-route nav. Own tab strip
 *     (or `forceSection` driven by the parent), no card chrome.
 *   - Collapsible card mode (`collapsible`): the Route Profile "all routes"
 *     list. Each route is a compact, colour-tagged card that expands to
 *     reveal the active section. `sectionMode` sets what an expanded card
 *     shows ("both" = stacked Overview, else a single section with an
 *     in-card Vertical/Summary switch).
 */

import { memo, useEffect, useMemo, useState } from "react";

import AltitudeProfile from "@/components/AltitudeProfile";
import type { Phase, TrajectoryResult } from "@/lib/trajectory/types";
import type { AirspaceMembership, AirspaceSegment } from "@/lib/airspace";

export type RouteSection = "vertical" | "summary";

interface DownloadLinks {
  callsign: string;
  flightKey: string;
  route: string;
  gpkg: string;
  csv: string;
  geojson: string;
}

interface Props {
  trajectory: TrajectoryResult;
  download: DownloadLinks;
  /** 1-based route index in the multi-route list, or null when single. */
  routeIndex: number | null;
  onRemove: () => void;
  /** When set, hide the internal tab strip and render that section
   *  exclusively. Used when a parent navigation drives selection. */
  forceSection?: RouteSection;
  /** Render **both** sections one above the other instead of a tab
   *  strip. The "all routes" landing page uses this. */
  stacked?: boolean;
  /** Current simulation clock (s) for this route, forwarded to the
   *  altitude chart so its plane tracks the map playback. Null when this
   *  route isn't the one being animated. */
  simT?: number | null;
  /** Live altitude-aware airspace membership for this route (from MapApp) —
   *  shown on the altitude chart next to the moving plane. */
  airspace?: AirspaceMembership;
  /** Whole-route airspace breakdown (from MapApp) — colour-blocks the altitude
   *  chart by the sectors the route crosses. A LOOKUP, not a value: walking a
   *  route's sectors is only worth doing for a card the user has expanded, so
   *  the chart resolves it when it mounts. */
  airspaceSegmentsFor?: (flightKey: string) => AirspaceSegment[];
  /** Collapsible card mode for the Route Profile list. */
  collapsible?: boolean;
  /** Whether the card is collapsed (header only). */
  collapsed?: boolean;
  /** Toggle the card's collapsed state. */
  onToggleCollapse?: () => void;
  /** What an expanded card shows in collapsible mode. */
  sectionMode?: RouteSection | "both";
}

const TABS: { id: RouteSection; label: string }[] = [
  { id: "vertical", label: "Vertical profile" },
  { id: "summary", label: "Trajectory summary" },
];

/** Format an altitude as FL (above 10k) or feet (below). */
function fmtAlt(ft: number | null | undefined): string {
  if (ft == null) return "—";
  return ft >= 10000
    ? `FL${Math.round(ft / 100)}`
    : `${Math.round(ft).toLocaleString()} ft`;
}

/** Flight-level label for the per-waypoint table (FL0 on the ground). */
function fmtFL(ft: number | null | undefined): string {
  if (ft == null) return "—";
  return `FL${Math.round(ft / 100)}`;
}

function RouteResultTabs({
  trajectory,
  download,
  routeIndex,
  onRemove,
  forceSection,
  stacked,
  simT,
  airspace,
  airspaceSegmentsFor,
  collapsible,
  collapsed,
  onToggleCollapse,
  sectionMode = "both",
}: Props) {
  const [tab, setTab] = useState<RouteSection>(forceSection ?? "vertical");
  // Keep the rendered tab in sync when the parent drives the choice.
  useEffect(() => {
    if (forceSection) setTab(forceSection);
  }, [forceSection]);

  // In-card section switch for collapsible mode (the "Vertical profile →
  // Trajectory summary →" links). Defaults to the global section and
  // follows it when the user flips the top-level Overview/Vertical/Summary
  // tabs, but can be overridden per card.
  const [cardSec, setCardSec] = useState<RouteSection>(
    sectionMode === "summary" ? "summary" : "vertical",
  );
  useEffect(() => {
    if (sectionMode === "vertical" || sectionMode === "summary") {
      setCardSec(sectionMode);
    }
  }, [sectionMode]);

  const { stats, profile, meta } = trajectory;

  // Per-waypoint readout for the summary table: snap each route fix to its
  // nearest emitted trajectory sample for FL / speed, and DERIVE the phase from
  // the LOCAL VERTICAL RATE at that sample — climbing / level / descending —
  // never the sample's own phase label. So the PHASE column always matches the
  // FL column even when the samples carry an unreliable phase (e.g. a flight
  // whose samples are all tagged "climb", or with no TOC/TOD computed).
  //
  // Built only while a summary is actually on screen. It parses every sample's
  // timestamp and scans every sample for every fix, and the "all routes" page
  // mounts one of these per flight — collapsed, showing a header — so doing it
  // unconditionally spent seconds on a whole traffic day before anything had
  // been opened.
  const summaryShown = collapsible
    ? !collapsed && (sectionMode === "both" || cardSec === "summary")
    : stacked || tab === "summary";
  const waypointRows = useMemo(() => {
    if (!summaryShown) return [];
    const pts = trajectory.points;
    if (pts.length === 0) return [];
    const tMs = pts.map((p) => new Date(p.epoch_ts).getTime());
    const LEVEL_FPM = 300; // |rate| below this = level (cruise)
    // Vertical rate (fpm) around sample `idx`, over a ~±20 s window for stability.
    const rateAt = (idx: number): number => {
      const lo = Math.max(0, idx - 3);
      const hi = Math.min(pts.length - 1, idx + 3);
      const a0 = pts[lo].altitude_ft;
      const a1 = pts[hi].altitude_ft;
      if (a0 == null || a1 == null) return 0;
      const dtMin = (tMs[hi] - tMs[lo]) / 60000;
      return dtMin > 0 ? (a1 - a0) / dtMin : 0;
    };
    return trajectory.route.map((wp) => {
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i].lat - wp.lat) ** 2 + (pts[i].lon - wp.lon) ** 2;
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      const r = rateAt(bestI);
      const phase: Phase = r > LEVEL_FPM ? "climb" : r < -LEVEL_FPM ? "descent" : "cruise";
      return {
        ident: wp.ident,
        altFt: pts[bestI].altitude_ft,
        gsKt: pts[bestI].gs_kt,
        phase,
      };
    });
  }, [summaryShown, trajectory.route, trajectory.points]);

  /** Vertical-profile section — stat boxes, chart, speed schedule, phases. */
  const renderVertical = (withTitle: boolean) => (
    <div className="rt-section rt-section-vertical">
      {withTitle && <h4 className="rt-section-title">Vertical profile</h4>}

      <dl className="rt-vp-stats">
        <div>
          <dt>Cruise</dt>
          <dd>{fmtAlt(stats.cruiseAltFt)}</dd>
        </div>
        <div>
          <dt>Req FL</dt>
          <dd>{fmtAlt(stats.rflFt)}</dd>
        </div>
        <div>
          <dt>TOC</dt>
          <dd>{fmtAlt(profile.toc?.altitudeFt ?? null)}</dd>
        </div>
        <div>
          <dt>TOD</dt>
          <dd>{fmtAlt(profile.tod?.altitudeFt ?? null)}</dd>
        </div>
      </dl>

      <AltitudeProfile
        trajectory={trajectory}
        simT={simT}
        airspace={airspace}
        airspaceSegmentsFor={airspaceSegmentsFor}
      />

      {/* Phase-3: planned speed schedule. */}
      {profile.speedSchedule && (
        <div className="rt-speed">
          <div className="rt-speed-head">Speed schedule</div>
          <p className="rt-speed-line">
            <span className="rt-speed-chip ph-climb">Climb</span>
            {profile.speedSchedule.climbCasKt} kt CAS · M
            {profile.speedSchedule.climbMach}
          </p>
          <p className="rt-speed-line">
            <span className="rt-speed-chip ph-cruise">Cruise</span>
            M{profile.speedSchedule.cruiseMach}
          </p>
          <p className="rt-speed-line">
            <span className="rt-speed-chip ph-descent">Descent</span>
            M{profile.speedSchedule.descentMach} ·
            {profile.speedSchedule.descentCasKt} kt CAS
          </p>
          <p className="rt-speed-foot">
            {profile.speedSchedule.belowFl100RestrictionKt} kt CAS below FL100 ·
            CAS→Mach crossover at FL
            {Math.round(profile.speedSchedule.crossoverFt / 100)}
          </p>
        </div>
      )}

      {profile.phaseBreakdown && (
        <dl className="rt-phase-grid">
          {(["climb", "cruise", "descent"] as const).map((p) => {
            const row = profile.phaseBreakdown![p];
            return (
              <div key={p} className={`ph-row ph-${p}`}>
                <dt>{p.charAt(0).toUpperCase() + p.slice(1)}</dt>
                <dd>
                  {row.timeMin == null ? "—" : `${row.timeMin.toFixed(1)} min`}
                  <span className="rt-phase-gs">
                    {row.avgGsKt == null ? "" : ` · ${Math.round(row.avgGsKt)} kt`}
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );

  /** Trajectory-summary section — hero stats, metadata, waypoints. */
  const renderSummary = (withTitle: boolean) => (
    <div className="rt-summary">
      {withTitle && <h4 className="rt-section-title">Trajectory summary</h4>}

      {/* Hero stats: the three headline numbers. */}
      <dl className="rt-summary-grid">
        <div>
          <dt>Waypoints</dt>
          <dd>{stats.waypointCount}</dd>
        </div>
        <div>
          <dt>Distance</dt>
          <dd>
            {stats.distanceNm}
            <span className="rt-summary-unit"> NM</span>
          </dd>
        </div>
        <div>
          <dt>Flight time</dt>
          <dd>
            {stats.timeMinutes}
            <span className="rt-summary-unit"> min</span>
          </dd>
        </div>
      </dl>

      {/* Secondary metadata strip. */}
      <dl className="rt-summary-meta">
        <div>
          <dt>Callsign</dt>
          <dd>{meta.callsign}</dd>
        </div>
        <div>
          <dt>Aircraft</dt>
          <dd>{meta.aircraftType}</dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd>
            {meta.adep} <span className="rt-arrow">→</span> {meta.ades}
          </dd>
        </div>
        <div>
          <dt>Points</dt>
          <dd>{stats.pointCount.toLocaleString()}</dd>
        </div>
      </dl>

      {/* Per-waypoint table: ident · FL · speed · phase. */}
      {waypointRows.length > 0 && (
        <div className="rt-wp">
          <div className="rt-wp-head">Waypoints</div>
          <table className="rt-wp-table">
            <thead>
              <tr>
                <th>Ident</th>
                <th>FL</th>
                <th>Spd</th>
                <th>Phase</th>
              </tr>
            </thead>
            <tbody>
              {waypointRows.map((w, i) => (
                <tr key={`${w.ident}-${i}`}>
                  <td className="rt-wp-ident">{w.ident}</td>
                  <td className={`rt-wp-fl ph-${w.phase}`}>{fmtFL(w.altFt)}</td>
                  <td className="rt-wp-spd">
                    {w.gsKt == null ? "—" : `${Math.round(w.gsKt)}kt`}
                  </td>
                  <td className={`rt-wp-phase ph-${w.phase}`}>
                    {w.phase.toUpperCase()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // ---- Collapsible card mode (Route Profile "all routes" list) ----------
  if (collapsible) {
    const tagNum = routeIndex ?? 1;
    const colorClass = `c${(tagNum - 1) % 6}`;
    return (
      <div
        className={`rt-card ${colorClass}${collapsed ? "" : " open"}`}
      >
        <div
          className="rt-card-head"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleCollapse?.();
            }
          }}
        >
          <span className="rt-card-tag">R{tagNum}</span>
          <span className="rt-card-call">{meta.callsign}</span>
          <span className="rt-card-route" title={download.route}>
            {download.route}
          </span>
          <button
            type="button"
            className="rt-card-x"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Remove this flight from the map and downloads"
            aria-label={`Remove ${download.flightKey}`}
          >
            ✕
          </button>
          <span className="rt-card-caret" aria-hidden>
            {collapsed ? "▾" : "▴"}
          </span>
        </div>

        {!collapsed && (
          <div className="rt-card-body rt-tabpanel" role="region">
            {sectionMode === "both" ? (
              <>
                {renderVertical(true)}
                <hr className="rt-section-sep" />
                {renderSummary(true)}
              </>
            ) : (
              <>
                <div className="rt-linktabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cardSec === "vertical"}
                    className={cardSec === "vertical" ? "active" : undefined}
                    onClick={() => setCardSec("vertical")}
                  >
                    Vertical profile →
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cardSec === "summary"}
                    className={cardSec === "summary" ? "active" : undefined}
                    onClick={() => setCardSec("summary")}
                  >
                    Trajectory summary →
                  </button>
                </div>
                {cardSec === "vertical"
                  ? renderVertical(false)
                  : renderSummary(false)}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Detail mode (per-route nav) --------------------------------------
  const showVertical = stacked || tab === "vertical";
  const showSummary = stacked || tab === "summary";

  return (
    <div className="gen-dl-route">
      <div className="gen-dl-head">
        <p className="gen-key">
          {routeIndex != null && (
            <span className="gen-route-tag">R{routeIndex}</span>
          )}
          {download.flightKey}
        </p>
        <button
          type="button"
          className="gen-dl-close"
          onClick={onRemove}
          title="Remove this flight from the map and downloads"
          aria-label={`Remove ${download.flightKey}`}
        >
          ✕
        </button>
      </div>
      <p className="gen-dl-rt" title={download.route}>
        ↳ {download.route}
      </p>

      {forceSection == null && !stacked && (
        <div className="rt-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="rt-tabpanel" role="tabpanel">
        {showVertical && renderVertical(stacked ?? false)}
        {showVertical && showSummary && <hr className="rt-section-sep" />}
        {showSummary && renderSummary(stacked ?? false)}
      </div>
    </div>
  );
}

/** Callback props are left out of the comparison: the parent passes fresh
 *  closures each render, but they only close over values that ARE compared
 *  (the route index / flight key) plus refs to its latest handlers. Without
 *  this, every card in the "all routes" list re-rendered on every animation
 *  frame of the playback. */
function sameProps(a: Props, b: Props): boolean {
  for (const k of Object.keys({ ...a, ...b }) as (keyof Props)[]) {
    if (k === "onRemove" || k === "onToggleCollapse") continue;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

export default memo(RouteResultTabs, sameProps);
