"use client";

/**
 * LayerOptions — the map's "Layer Options" panel (tabbed), modelled on the
 * reference ATC viewer. Tabs: Airports, SID, STAR, PBN, ILS (all fully wired
 * to their GeoJSON layers), plus Gates / Airway. (Airspace sectors moved to
 * their own toolbar dropdown beside the Layers button — see AirspaceMenu.)
 *
 * Pure presentational + local UI state (open dropdowns); all layer state is
 * lifted to MapApp so LeafletMap can render from it.
 */

import { memo, useEffect, useMemo, useState } from "react";

import NavIcon, { type NavIconName } from "@/components/nav/NavIcon";

import type { PanelAirport } from "@/lib/atcLayers";
import type { ProcedureDto } from "@/lib/api";
import {
  HOLDING_CATEGORIES,
  HOLDING_CATEGORY_LABEL,
  type HoldingCategory,
} from "@/lib/holdings";

/** Visibility + style state for one procedure layer (SID or STAR). */
export interface ProcLayerState {
  routes: boolean;
  waypoints: boolean;
  /** Airport ICAO filter — empty Set = all airports. */
  airports: Set<string>;
  /** Procedure-name filter — empty Set = all procedures. */
  procedures: Set<string>;
  opacity: number; // 0..1
  thickness: number; // px
}

export const DEFAULT_PROC_LAYER: ProcLayerState = {
  routes: false,
  waypoints: false,
  airports: new Set(),
  procedures: new Set(),
  opacity: 0.65,
  thickness: 2,
};

export type LayerTabKey =
  | "airports"
  | "gates"
  | "sid"
  | "star"
  | "pbn"
  | "ils"
  | "holding"
  | "airway";

/** Kept for the file's own use; `LayerTabKey` is the exported name. */
type TabKey = LayerTabKey;

/** Holding-tab layer state: the racetracks, their fix labels, which of the four
 *  kinds are drawn, and the airport / holding-fix filters. */
export interface HoldingLayerState {
  patterns: boolean;
  labels: boolean;
  /** Which categories are drawn. All four on = the published default. */
  categories: Set<HoldingCategory>;
  /** Airport ICAO filter ("ENRT" for enroute holds) — empty Set = all. */
  airports: Set<string>;
  /** Holding-fix ident filter — empty Set = all. */
  holdings: Set<string>;
  opacity: number; // 0..1
  thickness: number; // px
}

export const DEFAULT_HOLDING_LAYER: HoldingLayerState = {
  patterns: false,
  labels: true,
  categories: new Set(HOLDING_CATEGORIES),
  airports: new Set(),
  holdings: new Set(),
  opacity: 0.8,
  thickness: 2,
};

/** Airway-tab layer flags (lines opacity is shared with the points). */
export interface AirwayExtra {
  /** Draw the airway designator (e.g. "W18", "V3") beside each airway. */
  labels: boolean;
  vor: boolean;
  reporting: boolean;
  opacity: number;
}

// Full layer set: Airports, Gates, SID, STAR, PBN, ILS terminal procedures,
// plus the Airway reference layers. (Airspace sectors live in their own
// toolbar dropdown beside the Layers button.)
export const LAYER_TABS: {
  key: LayerTabKey;
  icon: NavIconName;
  label: string;
}[] = [
  { key: "airports", icon: "trajectory", label: "Airports" },
  { key: "gates", icon: "gates", label: "Gates" },
  { key: "sid", icon: "departure", label: "SID" },
  { key: "star", icon: "arrival", label: "STAR" },
  { key: "pbn", icon: "waypoint", label: "PBN" },
  { key: "ils", icon: "signal", label: "ILS" },
  { key: "holding", icon: "holding", label: "Holding" },
  { key: "airway", icon: "airway", label: "Airway" },
];

/** One procedure-style layer's wiring (shared by SID/STAR/PBN/ILS). */
export interface ProcLayerWiring {
  state: ProcLayerState;
  onChange: (s: ProcLayerState) => void;
  airportOpts: string[];
  procOpts: string[];
  /** Cascading lookup index: airport → procedure → [transitions]. */
  index: Record<string, Record<string, string[]>>;
  /** Resolve one procedure's legs + constraints via the API. */
  lookup: (
    airport: string,
    name: string,
    transition: string | null,
  ) => Promise<ProcedureDto>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Open straight on this tab — the global Layers menu names a layer, and the
   *  panel should already be on it when it appears. */
  initialTab?: LayerTabKey;
  // Airports
  airportList: PanelAirport[];
  hiddenAirports: Set<string>;
  onToggleAirport: (code: string) => void;
  onShowAllAirports: () => void;
  onHideAllAirports: () => void;
  showRunways: boolean;
  onShowRunways: (on: boolean) => void;
  runwayLabels: boolean;
  onRunwayLabels: (on: boolean) => void;
  // Gates
  gatesOn: boolean;
  onGatesOn: (on: boolean) => void;
  // Airway reference layers
  airwaysOn: boolean;
  onAirwaysOn: (on: boolean) => void;
  airway: AirwayExtra;
  onAirwayChange: (s: AirwayExtra) => void;
  // Route waypoints layer
  waypointsOn: boolean;
  onWaypointsOn: (on: boolean) => void;
  // FIR boundaries (lazy ~15 MB fetch on first enable)
  firOn: boolean;
  onFirOn: (on: boolean) => void;
  firLoading: boolean;
  /** Highlight a looked-up procedure on the map (null clears it). */
  onProcHighlight: (data: ProcedureDto | null) => void;
  // Procedure layers
  sid: ProcLayerWiring;
  star: ProcLayerWiring;
  pbn: ProcLayerWiring;
  ils: ProcLayerWiring;
  // Holding patterns
  holding: HoldingLayerState;
  onHoldingChange: (s: HoldingLayerState) => void;
  /** Airport ICAOs ("ENRT" included) and holding-fix idents present in the
   *  data, for the two filter dropdowns. Empty until the layer first loads. */
  holdingAirportOpts: string[];
  holdingOpts: string[];
  holdingLoading: boolean;
}

function LayerOptions({
  open,
  onClose,
  airportList,
  hiddenAirports,
  onToggleAirport,
  onShowAllAirports,
  onHideAllAirports,
  showRunways,
  onShowRunways,
  runwayLabels,
  onRunwayLabels,
  gatesOn,
  onGatesOn,
  airwaysOn,
  onAirwaysOn,
  airway,
  onAirwayChange,
  waypointsOn,
  onWaypointsOn,
  firOn,
  onFirOn,
  firLoading,
  onProcHighlight,
  sid,
  star,
  pbn,
  ils,
  holding,
  onHoldingChange,
  holdingAirportOpts,
  holdingOpts,
  holdingLoading,
  initialTab,
}: Props) {
  const [tab, setTab] = useState<TabKey>("airports");
  // Followed rather than seeded once: picking a second layer from the global
  // menu while the panel is already up has to move it, not be ignored.
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  if (!open) return null;

  const PROC: Record<"sid" | "star" | "pbn" | "ils", ProcLayerWiring> = {
    sid,
    star,
    pbn,
    ils,
  };

  return (
    <div className="lo-panel" role="dialog" aria-label="Layer Options">
      <div className="lo-head">
        <strong>
          <NavIcon name="settings" size={14} /> Layer Options
        </strong>
        <button className="lo-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="lo-tabs" role="tablist">
        {LAYER_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`lo-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            <span className="lo-tab-ico">
              <NavIcon name={t.icon} size={15} />
            </span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="lo-body">
        {tab === "airports" && (
          <AirportsTab
            airportList={airportList}
            hiddenAirports={hiddenAirports}
            onToggleAirport={onToggleAirport}
            onShowAllAirports={onShowAllAirports}
            onHideAllAirports={onHideAllAirports}
            showRunways={showRunways}
            onShowRunways={onShowRunways}
            runwayLabels={runwayLabels}
            onRunwayLabels={onRunwayLabels}
          />
        )}
        {tab === "gates" && (
          <>
            <label className="lo-check lo-check-off">
              <span>Show Gates</span>
              <input
                type="checkbox"
                checked={gatesOn}
                disabled
                onChange={(e) => onGatesOn(e.target.checked)}
              />
            </label>
            <p className="lo-empty">
              Needs gate data for VY — the AIXM export carries no stand
              positions, so gate dots are disabled for this deployment.
            </p>
          </>
        )}
        {tab === "airway" && (
          <>
            <label className="lo-check">
              <span>Airways</span>
              <input
                type="checkbox"
                checked={airwaysOn}
                onChange={(e) => onAirwaysOn(e.target.checked)}
              />
            </label>
            <label className="lo-check">
              <span>Labels</span>
              <input
                type="checkbox"
                checked={airway.labels}
                onChange={(e) =>
                  onAirwayChange({ ...airway, labels: e.target.checked })
                }
              />
            </label>
            <label className="lo-check">
              <span>VOR</span>
              <input
                type="checkbox"
                checked={airway.vor}
                onChange={(e) =>
                  onAirwayChange({ ...airway, vor: e.target.checked })
                }
              />
            </label>
            <label className="lo-check">
              <span>Reporting</span>
              <input
                type="checkbox"
                checked={airway.reporting}
                onChange={(e) =>
                  onAirwayChange({ ...airway, reporting: e.target.checked })
                }
              />
            </label>
            <label className="lo-check">
              <span>Waypoints</span>
              <input
                type="checkbox"
                checked={waypointsOn}
                onChange={(e) => onWaypointsOn(e.target.checked)}
              />
            </label>
            <label className="lo-check">
              <span>FIR{firLoading ? " (loading…)" : ""}</span>
              <input
                type="checkbox"
                checked={firOn}
                onChange={(e) => onFirOn(e.target.checked)}
              />
            </label>
            <Slider
              label="OPACITY"
              value={Math.round(airway.opacity * 100)}
              min={10}
              max={100}
              step={5}
              suffix="%"
              onChange={(v) => onAirwayChange({ ...airway, opacity: v / 100 })}
            />
            <p className="lo-empty">
              Reporting has no published data for this deployment — a
              compulsory reporting point isn't a structured AIXM field, so
              there's nothing to draw yet.
            </p>
          </>
        )}
        {tab === "holding" && (
          <HoldingTab
            state={holding}
            onChange={onHoldingChange}
            airportOpts={holdingAirportOpts}
            holdingOpts={holdingOpts}
            loading={holdingLoading}
          />
        )}
        {(tab === "sid" ||
          tab === "star" ||
          tab === "pbn" ||
          tab === "ils") && (
          <ProcTab
            kind={tab.toUpperCase() as "SID" | "STAR" | "PBN" | "ILS"}
            state={PROC[tab].state}
            onChange={PROC[tab].onChange}
            airportOpts={PROC[tab].airportOpts}
            procOpts={PROC[tab].procOpts}
            index={PROC[tab].index}
            lookup={PROC[tab].lookup}
            onHighlight={onProcHighlight}
          />
        )}
      </div>
    </div>
  );
}

/* --- Airports tab --------------------------------------------------------- */

function AirportsTab({
  airportList,
  hiddenAirports,
  onToggleAirport,
  onShowAllAirports,
  onHideAllAirports,
  showRunways,
  onShowRunways,
  runwayLabels,
  onRunwayLabels,
}: Pick<
  Props,
  | "airportList"
  | "hiddenAirports"
  | "onToggleAirport"
  | "onShowAllAirports"
  | "onHideAllAirports"
  | "showRunways"
  | "onShowRunways"
  | "runwayLabels"
  | "onRunwayLabels"
>) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return needle
      ? airportList.filter(
          (a) =>
            a.code.includes(needle) || a.name.toUpperCase().includes(needle),
        )
      : airportList;
  }, [airportList, q]);

  const row = (a: PanelAirport) => (
    <label key={a.code} className="lo-ap-row">
      <input
        type="checkbox"
        checked={!hiddenAirports.has(a.code)}
        onChange={() => onToggleAirport(a.code)}
      />
      <span className="lo-ap-name">{a.name}</span>
      <span className="lo-ap-code">{a.code}</span>
    </label>
  );

  return (
    <>
      <label className="lo-check">
        <span>Show Runways</span>
        <input
          type="checkbox"
          checked={showRunways}
          onChange={(e) => onShowRunways(e.target.checked)}
        />
      </label>
      {/* Threshold idents ride on the runway strips, so the labels are only
          meaningful while the strips themselves are drawn. */}
      <label className={`lo-check${showRunways ? "" : " lo-check-off"}`}>
        <span>Show Runway Labels</span>
        <input
          type="checkbox"
          checked={runwayLabels}
          disabled={!showRunways}
          onChange={(e) => onRunwayLabels(e.target.checked)}
        />
      </label>
      {showRunways && runwayLabels && (
        <p className="lo-empty">
          Runway idents (03L, 21R…) label each threshold when zoomed in to an
          airport.
        </p>
      )}
      <input
        className="lo-search"
        placeholder="Search airports…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="lo-ap-actions">
        <button onClick={onShowAllAirports}>Show All</button>
        <button onClick={onHideAllAirports}>Hide All</button>
      </div>
      {filtered.length > 0 ? (
        <>
          <p className="lo-ap-group">Airport ({filtered.length})</p>
          {filtered.map(row)}
        </>
      ) : (
        <p className="lo-empty">No airports match “{q}”.</p>
      )}
    </>
  );
}

/* --- SID / STAR tab ------------------------------------------------------- */

function ProcTab({
  kind,
  state,
  onChange,
  airportOpts,
  procOpts,
  index,
  lookup,
  onHighlight,
}: {
  kind: "SID" | "STAR" | "PBN" | "ILS";
  state: ProcLayerState;
  onChange: (s: ProcLayerState) => void;
  airportOpts: string[];
  procOpts: string[];
  index: Record<string, Record<string, string[]>>;
  lookup: (
    airport: string,
    name: string,
    transition: string | null,
  ) => Promise<ProcedureDto>;
  onHighlight: (data: ProcedureDto | null) => void;
}) {
  const set = (patch: Partial<ProcLayerState>) =>
    onChange({ ...state, ...patch });

  // Only one of the two multiselects (AIRPORT / PROCEDURE) may be open at a
  // time — their dropdown menus are absolutely positioned and would otherwise
  // overlap each other and the controls below.
  const [openMs, setOpenMs] = useState<"airport" | "procedure" | null>(null);

  // Wrapper keeps every procedure tab (SID/STAR/PBN/ILS) the same card height,
  // so PBN/ILS — which have no "look up a procedure" form — don't render as a
  // visibly shorter card than SID/STAR.
  return (
    <div className="lo-proc">
      <label className="lo-check">
        <span>{kind} Routes</span>
        <input
          type="checkbox"
          checked={state.routes}
          onChange={(e) => set({ routes: e.target.checked })}
        />
      </label>
      <label className="lo-check">
        <span>Waypoints</span>
        <input
          type="checkbox"
          checked={state.waypoints}
          onChange={(e) => set({ waypoints: e.target.checked })}
        />
      </label>

      <MultiSelect
        label="AIRPORT"
        options={airportOpts}
        selected={state.airports}
        onChange={(s) => set({ airports: s })}
        open={openMs === "airport"}
        onOpenChange={(o) => setOpenMs(o ? "airport" : null)}
      />
      <MultiSelect
        label="PROCEDURE"
        options={procOpts}
        selected={state.procedures}
        onChange={(s) => set({ procedures: s })}
        open={openMs === "procedure"}
        onOpenChange={(o) => setOpenMs(o ? "procedure" : null)}
      />

      <Slider
        label="OPACITY"
        value={Math.round(state.opacity * 100)}
        min={10}
        max={100}
        step={5}
        suffix="%"
        onChange={(v) => set({ opacity: v / 100 })}
      />
      <Slider
        label="LINE THICKNESS"
        value={state.thickness}
        min={1}
        max={8}
        step={1}
        suffix="PX"
        onChange={(v) => set({ thickness: v })}
      />

      {/* The direct "look up a procedure" form is only useful for the terminal
          procedures the user routes through (SID/STAR). PBN/ILS show just the
          layer + style controls. */}
      {(kind === "SID" || kind === "STAR") && (
        <ProcLookup
          kind={kind}
          index={index}
          lookup={lookup}
          onHighlight={onHighlight}
        />
      )}
    </div>
  );
}

/* --- Holding tab ---------------------------------------------------------- */

function HoldingTab({
  state,
  onChange,
  airportOpts,
  holdingOpts,
  loading,
}: {
  state: HoldingLayerState;
  onChange: (s: HoldingLayerState) => void;
  airportOpts: string[];
  holdingOpts: string[];
  loading: boolean;
}) {
  const set = (patch: Partial<HoldingLayerState>) =>
    onChange({ ...state, ...patch });

  // Same single-open rule as the procedure tabs — the two dropdown menus are
  // absolutely positioned and would otherwise stack on each other.
  const [openMs, setOpenMs] = useState<"airport" | "holding" | null>(null);

  const flipCategory = (c: HoldingCategory) => {
    const next = new Set(state.categories);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    set({ categories: next });
  };

  return (
    <div className="lo-proc">
      <label className="lo-check">
        <span>Holding Patterns{loading ? " (loading…)" : ""}</span>
        <input
          type="checkbox"
          checked={state.patterns}
          onChange={(e) => set({ patterns: e.target.checked })}
        />
      </label>
      <label className="lo-check">
        <span>Labels</span>
        <input
          type="checkbox"
          checked={state.labels}
          onChange={(e) => set({ labels: e.target.checked })}
        />
      </label>

      <div className="lo-field">
        <span className="lo-label">HOLDING PATTERN</span>
        {HOLDING_CATEGORIES.map((c) => {
          // Missed-approach and HILPT holds are coded inside the VY approach
          // procedures, so they're populated for this deployment. Published
          // and enroute holds come from an AIP holding table, and none has
          // been supplied for VY yet, so those two stay dimmed and empty.
          const needsVy = c === "published" || c === "enroute";
          return (
            <label
              key={c}
              className={`lo-check lo-hold-cat ${c}${needsVy ? " lo-check-off" : ""}`}
            >
              <span>{HOLDING_CATEGORY_LABEL[c]}</span>
              <input
                type="checkbox"
                checked={state.categories.has(c)}
                disabled={needsVy}
                onChange={() => flipCategory(c)}
              />
            </label>
          );
        })}
      </div>
      <p className="lo-empty">
        Published and Enroute holds need holding data for VY (an AIP holding
        table), so they’re unavailable here.
      </p>

      <MultiSelect
        label="AIRPORT"
        options={airportOpts}
        selected={state.airports}
        onChange={(s) => set({ airports: s })}
        open={openMs === "airport"}
        onOpenChange={(o) => setOpenMs(o ? "airport" : null)}
      />
      <MultiSelect
        label="HOLDING"
        options={holdingOpts}
        selected={state.holdings}
        onChange={(s) => set({ holdings: s })}
        open={openMs === "holding"}
        onOpenChange={(o) => setOpenMs(o ? "holding" : null)}
      />

      <Slider
        label="OPACITY"
        value={Math.round(state.opacity * 100)}
        min={10}
        max={100}
        step={5}
        suffix="%"
        onChange={(v) => set({ opacity: v / 100 })}
      />
      <Slider
        label="LINE THICKNESS"
        value={state.thickness}
        min={1}
        max={8}
        step={1}
        suffix="PX"
        onChange={(v) => set({ thickness: v })}
      />
      <p className="lo-empty">
        Racetracks are drawn to scale from the coded inbound course, turn
        direction and leg time at the holding speed. Enroute holds file under
        the “ENRT” airport.
      </p>
    </div>
  );
}

/* --- Direct procedure lookup form (airport → procedure → transition) ------ */

const fmtAlt = (c: ProcedureDto["legs"][number]["altitude"]): string => {
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
};
const fmtSpd = (c: ProcedureDto["legs"][number]["speed"]): string => {
  const s = c.speed_kt ?? null;
  if (s == null) return "";
  if (c.type === "AT_OR_ABOVE") return `≥${s}kt`;
  if (c.type === "AT") return `${s}kt`;
  return `≤${s}kt`;
};

function ProcLookup({
  kind,
  index,
  lookup,
  onHighlight,
}: {
  kind: string;
  index: Record<string, Record<string, string[]>>;
  lookup: (
    airport: string,
    name: string,
    transition: string | null,
  ) => Promise<ProcedureDto>;
  onHighlight: (data: ProcedureDto | null) => void;
}) {
  const [airport, setAirport] = useState("");
  const [proc, setProc] = useState("");
  const [trans, setTrans] = useState("");
  const [res, setRes] = useState<{
    loading?: boolean;
    data?: ProcedureDto;
    error?: string;
  } | null>(null);

  const airports = useMemo(() => Object.keys(index).sort(), [index]);
  const procs = useMemo(
    () => (airport && index[airport] ? Object.keys(index[airport]).sort() : []),
    [index, airport],
  );
  const transitions = useMemo(
    () => (airport && proc ? index[airport]?.[proc] ?? [] : []),
    [index, airport, proc],
  );

  const run = () => {
    if (!airport || !proc) return;
    setRes({ loading: true });
    lookup(airport, proc, trans || null)
      .then((data) => {
        setRes({ data });
        onHighlight(data); // light up the path on the map
      })
      .catch((e: unknown) =>
        setRes({ error: e instanceof Error ? e.message : "Lookup failed" }),
      );
  };

  // Reset the whole look-up: the three selects, the legs result and the map
  // highlight the last lookup lit up.
  const clear = () => {
    setAirport("");
    setProc("");
    setTrans("");
    setRes(null);
    onHighlight(null);
  };
  const dirty = Boolean(airport || proc || trans || res);

  return (
    <div className="lo-lookup">
      <p className="lo-label">LOOK UP A {kind}</p>
      <select
        className="lo-lk-select"
        value={airport}
        onChange={(e) => {
          setAirport(e.target.value);
          setProc("");
          setTrans("");
          setRes(null);
          onHighlight(null);
        }}
      >
        <option value="">Airport…</option>
        {airports.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <select
        className="lo-lk-select"
        value={proc}
        disabled={!airport}
        onChange={(e) => {
          setProc(e.target.value);
          setTrans("");
          setRes(null);
        }}
      >
        <option value="">Procedure…</option>
        {procs.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        className="lo-lk-select"
        value={trans}
        disabled={!proc}
        onChange={(e) => setTrans(e.target.value)}
      >
        <option value="">All transitions (auto)</option>
        {transitions.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <div className="lo-lk-actions">
        <button
          type="button"
          className="lo-lk-btn"
          disabled={!airport || !proc}
          onClick={run}
        >
          Show legs
        </button>
        <button
          type="button"
          className="lo-lk-btn lo-lk-clear"
          disabled={!dirty}
          onClick={clear}
        >
          Clear
        </button>
      </div>

      {res?.loading && <p className="lo-empty">Loading legs…</p>}
      {res?.error && <p className="lo-empty">{res.error}</p>}
      {res?.data && (
        <>
          <p className="lo-lk-sub">
            {res.data.airport}
            {res.data.runway ? ` · ${res.data.runway}` : ""}
            {res.data.transition ? ` · ${res.data.transition}` : ""}
          </p>
          <ol className="lo-lk-legs">
            {res.data.legs.map((lg, i) => (
              <li key={`${lg.seqno}-${i}`}>
                <span className="lo-lk-term">{lg.path_terminator}</span>
                <span className="lo-lk-ident">{lg.ident ?? "—"}</span>
                <span className="lo-lk-con">
                  {fmtAlt(lg.altitude)}
                  {fmtSpd(lg.speed) ? ` · ${fmtSpd(lg.speed)}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/* --- shared controls ------------------------------------------------------ */

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  open,
  onOpenChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  /** Controlled open state — lifted to the parent so only ONE multiselect
   *  (AIRPORT or PROCEDURE) is open at a time; otherwise the two absolutely-
   *  positioned menus stack over each other and the fields below them. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const text = selected.size === 0 ? "ALL" : `${selected.size} SELECTED`;

  // Type-ahead filter over the option list (case-insensitive substring).
  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return needle
      ? options.filter((o) => o.toUpperCase().includes(needle))
      : options;
  }, [options, query]);

  // Reset the search whenever the menu closes (incl. when the sibling
  // multiselect steals the single "open" slot).
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const toggle = () => onOpenChange(!open);

  const flip = (o: string) => {
    const next = new Set(selected);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    onChange(next);
  };

  return (
    <div className="lo-field">
      <span className="lo-label">{label}</span>
      <div className="lo-select">
        <button className="lo-select-btn" onClick={toggle}>
          <span>{text}</span>
          <span className="lo-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open && (
          <div className="lo-select-menu">
            <input
              className="lo-opt-search"
              placeholder={`Search ${label.toLowerCase()}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {/* Select All ticks every option; Clear empties the set — an
                empty set is the "no filter → show all" default, so Clear
                returns the layer to showing every airport/procedure. */}
            <div className="lo-ap-actions lo-ms-actions">
              <button
                type="button"
                onClick={() => onChange(new Set(options))}
              >
                Select All
              </button>
              <button type="button" onClick={() => onChange(new Set())}>
                Clear
              </button>
            </div>
            <div className="lo-opt-list">
              {options.length === 0 && <p className="lo-empty">No options.</p>}
              {options.length > 0 && filtered.length === 0 && (
                <p className="lo-empty">No matches for “{query}”.</p>
              )}
              {filtered.map((o) => (
                <label key={o} className="lo-opt">
                  <input
                    type="checkbox"
                    checked={selected.has(o)}
                    onChange={() => flip(o)}
                  />
                  <span>{o}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="lo-field">
      <div className="lo-slider-head">
        <span className="lo-label">{label}</span>
        <span className="lo-slider-val">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="lo-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default memo(LayerOptions);
