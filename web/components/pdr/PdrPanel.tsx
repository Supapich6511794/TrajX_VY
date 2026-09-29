"use client";

/**
 * PdrPanel — the route and airspace check.
 *
 * Two different things are reported here and the panel keeps them apart,
 * because they answer different questions and have different remedies:
 *
 *   * **P / D / R Area conflicts** — the route intersects a Prohibited, Danger
 *     or Restricted AREA. Governed by AREA_POLICY: P is never permitted, D is a
 *     conflict only while active, R needs authorization.
 *   * **Route checks (PDR / ENR 1.10)** — the filed ROUTE itself: is it a
 *     published preferred route for the pair, in the right direction, with its
 *     conditions met.
 *
 * Left column: every flight with its worst finding, so a bank can be scanned at
 * a glance. The rows are filed PLANS before generation (checked on an estimated
 * climb/cruise/descent profile) and generated trajectories afterwards — the
 * `sourceNote` says which, because it changes how much a marginal finding is
 * worth. Right column: the selected flight's findings, each with
 * the published rule it breaches, and the alternative routes ENR 1.10 offers.
 *
 * The Apply action deliberately does NOT re-fly the flight. It stages the
 * suggested route into that flight's plan in the generator and stops there, so
 * the controller reads the routing, presses Generate themselves, and stays the
 * one who decides. A route that changed itself the moment the tool suggested it
 * would be a different (and much worse) tool.
 */

import { useMemo, useState } from "react";

import type {
  PdrFinding,
  PdrReport,
  Remedy,
  RouteSuggestion,
} from "@/lib/pdr/detect";
import type { PdrArea } from "@/lib/pdr/types";
import { matchesPdrSearch, pdrSearchTerms } from "@/lib/pdr/search";
import {
  inPdrTab,
  PDR_TABS,
  pdrTabCounts,
  pdrVerdict,
  type PdrTab,
} from "@/lib/pdr/verdict";
import NavIcon from "@/components/nav/NavIcon";

export interface PdrFlightRow {
  flightKey: string;
  callsign: string;
  adep: string;
  ades: string;
}

interface Props {
  flights: PdrFlightRow[];
  reports: Map<string, PdrReport>;
  loading: boolean;
  error: string | null;
  /** AIRAC window the activity data covers, for the staleness banner. */
  validFrom: string | null;
  validTo: string | null;
  /** Which picture this is — filed plans (estimated profile) or generated
   *  trajectories (real ones). Shown under the header so a marginal finding can
   *  be weighed correctly. */
  sourceNote?: string;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Stage a suggested route into that flight's plan (no regeneration). */
  onUseRoute: (flightKey: string, route: string) => void;
  /** Open this flight's plan in the generator so the route can be re-written by
   *  hand. The way out when the AIP publishes no alternative — which is most of
   *  the time, since ENR 1.10 covers a minority of city pairs. Omitted when the
   *  panel is showing generated trajectories, which no longer map to a plan. */
  onOpenPlan?: (flightKey: string) => void;
  /** The FULL report for one flight, alternatives included. The `reports` map
   *  is a bulk scan without them — building suggestions for a whole traffic
   *  sample costs about as much as the rest of the check put together, and only
   *  the open flight needs them. */
  detailFor?: (flightKey: string) => PdrReport | undefined;
  /** Re-run the AIP data load after a failure. */
  onRetry?: () => void;
  /** Centre the map on an area named by a finding. Toggles: calling it again
   *  with the same area takes it off. */
  onFocusArea?: (area: PdrArea) => void;
  /** Area idents currently drawn on the map. */
  shownAreas?: string[];
  /** The requested level the check ran with, per flight key. Shown in the
   *  header: when the form and the check disagree, the number that matters is
   *  the one the check used. */
  rflFtOf?: (flightKey: string) => number | undefined;
  onClose: () => void;
}

/** Chip wording. "REJECTED" rather than "conflict": the finding is that the
 *  plan breaches a published restriction and cannot be filed as it stands —
 *  which is a verdict on the plan, not a report of traffic in the way. */
const SEVERITY_LABEL = {
  violation: "REJECTED",
  caution: "CHECK",
  info: "NOTE",
} as const;

function severityChip(sev: PdrFinding["severity"]) {
  return <span className={"pdr-chip sev-" + sev}>{SEVERITY_LABEL[sev]}</span>;
}

/** What each tab holds, for its tooltip. */
const TAB_HINT: Record<PdrTab, string> = {
  all: "Every flight, including any the check has not reached yet",
  clear: "Nothing to act on — no restricted area or published-route finding",
  check: "Something to look at, but nothing outright forbidden",
  rejected: "Breaches a published restriction — cannot be filed as it stands",
};

/** Is the plan being checked outside the AIRAC cycle the data came from? */
function staleNote(validTo: string | null): string | null {
  if (!validTo) return null;
  const end = Date.parse(validTo);
  if (!Number.isFinite(end) || Date.now() <= end) return null;
  return (
    "The PDR activity data is from the AIRAC cycle that ended " +
    validTo.slice(0, 10) +
    ". Activity times may have changed; re-run scripts/extract_aixm_restricted_areas.py against the current export."
  );
}

/** Why a candidate sits where it does, in the engine's own order of weight:
 *  a route that still crosses something hot, or that breaks another published
 *  rule, is ranked behind a clean one however short it is. */
function rankReason(s: RouteSuggestion): string {
  if (s.activeAreas.length > 0) return "still crosses an active area";
  if (s.issues.length > 0) return "breaks another published rule";
  if (s.condition?.state === "unknown") return "condition cannot be verified";
  if (s.distanceNm != null) return "clean · " + s.distanceNm.toFixed(0) + " NM";
  return "clean";
}

function SuggestionCard({
  s,
  rank,
  total,
  onUse,
}: {
  s: RouteSuggestion;
  /** 1-based position in the ranked list. */
  rank: number;
  total: number;
  onUse: () => void;
}) {
  const clean = s.activeAreas.length === 0 && s.issues.length === 0;
  return (
    <div className="pdr-sugg">
      <div className="pdr-sugg-top">
        {/* The list IS ranked — best first — but that was only visible as sort
            order, which says nothing at all when there is one card. */}
        <span
          className={"pdr-sugg-rank" + (rank === 1 && clean ? " best" : "")}
        >
          #{rank}
          {total > 1 ? "/" + total : ""}
        </span>
        <code className="pdr-sugg-route">{s.route}</code>
        <span className="pdr-sugg-tag">{s.rnav ? "RNAV" : "Non-RNAV"}</span>
      </div>
      <p className="pdr-sugg-rankwhy">
        {rank === 1 ? "Best option — " : "Ranked #" + rank + " — "}
        {rankReason(s)}
      </p>
      <p className="pdr-sugg-why">{s.why}</p>
      {s.condition && (
        <p className={"pdr-sugg-cond state-" + s.condition.state}>
          {s.condition.state === "met" ? "Condition met: " : "Condition: "}
          {s.condition.detail}
        </p>
      )}
      <div className="pdr-sugg-meta">
        {s.distanceNm != null && <span>{s.distanceNm.toFixed(0)} NM</span>}
        {s.clears.length > 0 && <span>clears {s.clears.join(", ")}</span>}
        {s.activeAreas.length > 0 && (
          <span className="warn">still crosses {s.activeAreas.join(", ")}</span>
        )}
      </div>
      {/* A candidate that avoids the areas but breaks another published rule is
          not a fix on its own — say so on the card rather than letting it be
          accepted and come straight back as a new rejection. */}
      {s.issues.map((issue) => (
        <p key={issue} className="pdr-sugg-issue">
          ⚠ {issue}
        </p>
      ))}
      {s.capabilityNote && (
        <p className="pdr-sugg-cap">ℹ {s.capabilityNote}</p>
      )}
      {/* The label has to match what accepting this route would actually do.
          "Use this route" on a candidate that still crosses an active area
          reads as a fix, and the controller applies it expecting the finding to
          clear. */}
      <button
        type="button"
        className={"pdr-sugg-apply" + (clean ? "" : " unresolved")}
        onClick={onUse}
        title={
          clean
            ? "Put this routing in the flight's plan for review — it is not generated until you press Generate"
            : "This routing does NOT clear the finding above. It is staged for review only."
        }
      >
        {clean ? "Use this route →" : "Use anyway — conflict remains →"}
      </button>
    </div>
  );
}

const AREA_CLASS_LABEL = { P: "Prohibited", D: "Danger", R: "Restricted" } as const;

/** Short tag for each way out, in the order the engine ranks them. */
const REMEDY_LABEL: Record<Remedy["kind"], string> = {
  level: "LEVEL",
  route: "ROUTE",
  authorization: "AUTH",
  notam: "NOTAM",
};

/** One group of findings. Renders nothing when the group is empty, so a flight
 *  with only route findings does not show an empty airspace heading. */
function FindingList({
  title,
  findings,
  onFocusArea,
  shownAreas,
}: {
  title: string;
  findings: PdrFinding[];
  onFocusArea?: (area: PdrArea) => void;
  /** Idents currently drawn on the map, so the button can say which way it
   *  goes. The action toggles, and a button labelled "Show" that hides is
   *  worse than no label at all. */
  shownAreas: ReadonlySet<string>;
}) {
  if (findings.length === 0) return null;
  return (
    <>
      <h4 className="pdr-group-h">
        {title} ({findings.length})
      </h4>
      <ul className="pdr-findings">
        {findings.map((f) => (
          <li key={f.id} className={"pdr-finding sev-" + f.severity}>
            <div className="pdr-finding-head">
              {severityChip(f.severity)}
              {f.areaClass && (
                <span className={"pdr-area-class cls-" + f.areaClass}>
                  {f.areaClass} · {AREA_CLASS_LABEL[f.areaClass]}
                </span>
              )}
              <span className="pdr-finding-title">{f.title}</span>
              {f.incursion && onFocusArea && (() => {
                const shown = shownAreas.has(f.incursion.area.ident);
                return (
                  <button
                    type="button"
                    className={"pdr-finding-locate" + (shown ? " shown" : "")}
                    onClick={() => onFocusArea(f.incursion!.area)}
                    title={
                      shown
                        ? "Take " + f.incursion.area.ident + " off the map"
                        : "Draw " + f.incursion.area.ident +
                          " on the map in red and fly to it"
                    }
                  >
                    {shown ? "◉ Hide area" : "⌖ Show area"}
                  </button>
                );
              })()}
            </div>
            <p className="pdr-finding-reason">{f.reason}</p>
            {f.action && (
              <p className="pdr-finding-action">
                <strong>Action:</strong> {f.action}
              </p>
            )}
            <p className="pdr-finding-src">{f.source}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function PdrPanel({
  flights,
  reports,
  loading,
  error,
  validFrom,
  validTo,
  sourceNote,
  selectedKey,
  onSelect,
  onUseRoute,
  onOpenPlan,
  detailFor,
  onRetry,
  onFocusArea,
  shownAreas,
  rflFtOf,
  onClose,
}: Props) {
  const selected = selectedKey
    ? detailFor?.(selectedKey) ?? reports.get(selectedKey)
    : undefined;
  const selectedFlight = flights.find((f) => f.flightKey === selectedKey);
  const stale = staleNote(validTo);
  const shown = useMemo(() => new Set(shownAreas ?? []), [shownAreas]);

  // Clear / Check / Rejected — the list is split by verdict so a bank of plans
  // can be worked one kind at a time. One verdict per flight, computed once, so
  // the tab counts and the rows below cannot disagree.
  const [tab, setTab] = useState<PdrTab>("all");
  const verdicts = useMemo(
    () => flights.map((f) => pdrVerdict(reports.get(f.flightKey))),
    [flights, reports],
  );

  // Search: finds one flight among thousands, inside whichever tab is open. It
  // sits BEFORE the tab split, so the tab counts are counts of the matches —
  // search "UBA" and Clear / Check / Rejected say how many UBA flights are in
  // each, which is how you learn which tab a flight is on without opening all
  // three. The query survives a tab change, for the same reason.
  const [query, setQuery] = useState("");
  const terms = useMemo(() => pdrSearchTerms(query), [query]);
  const searching = terms.length > 0;
  const found = useMemo(
    () =>
      flights
        .map((f, i) => ({ f, verdict: verdicts[i] }))
        .filter((row) => matchesPdrSearch(row.f, terms)),
    [flights, verdicts, terms],
  );
  const tabCounts = useMemo(
    () => pdrTabCounts(found.map((row) => row.verdict)),
    [found],
  );
  const visible = useMemo(
    () => found.filter((row) => inPdrTab(row.verdict, tab)),
    [found, tab],
  );
  const tabLabel = PDR_TABS.find((t) => t.id === tab)!.label;

  return (
    <div className="cdr-panel pdr-panel" role="dialog" aria-label="PDR conflict check">
      <div className="cdr-panel-head">
        <strong>
          <NavIcon name="restricted" size={14} /> Route &amp; P/D/R Area Check
        </strong>
        <button
          type="button"
          className="cdr-panel-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {loading && <p className="cdr-panel-empty">Loading AIP restricted-area data…</p>}
      {error && (
        <div className="cdr-panel-empty pdr-error">
          <p>
            Could not load the AIP restricted-area data: {error}. Nothing was
            checked — this is not a clean result.
          </p>
          {onRetry && (
            <button type="button" className="pdr-edit-plan" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {stale && <p className="pdr-stale">⚠ {stale}</p>}
      {sourceNote && <p className="pdr-source-note">{sourceNote}</p>}

      {!loading && !error && flights.length === 0 && (
        <p className="cdr-panel-empty">
          Add a flight plan with a route to check it against the restricted
          areas — no need to generate first.
        </p>
      )}

      {!loading && !error && flights.length > 0 && (
        <div className="pdr-tabs">
          <div
            className="pdr-tablist"
            role="tablist"
            aria-label="Filter flights by verdict"
          >
            {PDR_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={"pdr-tab tone-" + t.id + (tab === t.id ? " active" : "")}
                onClick={() => setTab(t.id)}
                title={TAB_HINT[t.id]}
              >
                {t.label}
                <span className="pdr-tab-count">{tabCounts[t.id]}</span>
              </button>
            ))}
          </div>
          <label className="pdr-search">
            <span className="pdr-search-icon" aria-hidden="true">
              <NavIcon name="search" size={13} />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Escape empties the box first; only an empty one lets it
                // reach whatever else listens for Escape.
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Search callsign, ADEP, ADES…"
              aria-label="Search flights by callsign or aerodrome"
              title="Searches inside the tab that is open. The counts on the tabs show how many matches each one holds."
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>
      )}

      {!loading && !error && flights.length > 0 && (
        <div className="pdr-cols">
          <section className="pdr-list">
            <h3 className="cdr-dash-h">
              {tab === "all" && !searching
                ? "Flights (" + flights.length + ")"
                : (tab === "all" ? "Flights" : tabLabel) +
                  " (" + visible.length + " of " + flights.length + ")"}
            </h3>
            {visible.length === 0 && (
              <p className="pdr-tab-empty">
                {searching
                  ? "No flight matches “" + query.trim() + "”" +
                    (tab === "all"
                      ? "."
                      : " in " + tabLabel + " — the counts on the tabs show where the matches are.")
                  : "No flights in " + tabLabel + " — pick another tab."}
              </p>
            )}
            <ul>
              {visible.map(({ f, verdict }) => {
                // A flight the scan has not reached yet has NO verdict ("pending"),
                // and is never shown as clear: an unchecked flight must not be
                // indistinguishable from one that passed.
                const worst = reports.get(f.flightKey)?.worst ?? null;
                return (
                  <li key={f.flightKey}>
                    <button
                      type="button"
                      className={
                        "pdr-flight" +
                        (selectedKey === f.flightKey ? " active" : "") +
                        (worst ? " sev-" + worst : "")
                      }
                      onClick={() =>
                        onSelect(selectedKey === f.flightKey ? null : f.flightKey)
                      }
                    >
                      <span className="pdr-flight-cs">{f.callsign}</span>
                      <span className="pdr-flight-pair">
                        {f.adep}→{f.ades}
                      </span>
                      <span className="pdr-flight-state">
                        {verdict === "pending" ? (
                          <span className="pdr-pending">checking…</span>
                        ) : verdict === "rejected" ? (
                          severityChip("violation")
                        ) : verdict === "check" ? (
                          severityChip("caution")
                        ) : (
                          <span className="pdr-ok">clear</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="pdr-detail">
            {!selected && (
              <p className="cdr-panel-empty">Select a flight to see its check.</p>
            )}

            {selected && (
              <>
                <div className="pdr-detail-head">
                  <h3 className="cdr-dash-h">
                    {selectedFlight?.callsign} — {selected.areasChecked} areas
                    checked
                    {(() => {
                      const ft = rflFtOf?.(selectedKey!);
                      if (ft == null) return null;
                      return ft > 0
                        ? " · checked at FL" + Math.round(ft / 100)
                        : " · no level set";
                    })()}
                  </h3>
                  {onOpenPlan && (
                    <button
                      type="button"
                      className="pdr-edit-plan"
                      onClick={() => onOpenPlan(selectedKey!)}
                      title="Bring this flight's tab to the front in the generator. This panel stays open, and the check re-runs as you edit."
                    >
                      ✎ Edit route in plan
                    </button>
                  )}
                </div>

                {selected.areasChecked === 0 && (
                  <p className="pdr-stale">
                    ⚠ No restricted-area polygons were loaded, so airspace was not
                    checked at all.
                  </p>
                )}

                {selected.findings.length === 0 ? (
                  <p className="cdr-panel-empty">
                    No conflicts. The filed route clears every published area and
                    matches ENR 1.10 for this pair.
                  </p>
                ) : (
                  <>
                    <FindingList
                      title="P / D / R Area conflicts"
                      findings={selected.findings.filter(
                        (f) => f.category === "restricted-airspace",
                      )}
                      onFocusArea={onFocusArea}
                      shownAreas={shown}
                    />
                    <FindingList
                      title="Route checks — PDR / ENR 1.10"
                      findings={selected.findings.filter(
                        (f) => f.category !== "restricted-airspace",
                      )}
                      onFocusArea={onFocusArea}
                      shownAreas={shown}
                    />
                  </>
                )}

                {selected.remedies.length > 0 && (
                  <>
                    <h4 className="pdr-group-h">
                      Recommended actions ({selected.remedies.length})
                    </h4>
                    <ol className="pdr-remedies">
                      {selected.remedies.map((rm, i) => (
                        <li key={rm.kind + i} className={"pdr-remedy k-" + rm.kind}>
                          <span className="pdr-remedy-kind">
                            {REMEDY_LABEL[rm.kind]}
                          </span>
                          <span className="pdr-remedy-text">{rm.detail}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}

                {selected.suggestions.length > 0 && (
                  <>
                    <h3 className="cdr-dash-h">
                      Suggested routes ({selected.suggestions.length})
                    </h3>
                    <p className="pdr-sugg-note">
                      Published ENR 1.10 routes for this pair, best first: a route
                      that clears every active area and breaks no other rule ranks
                      above a shorter one that does not. Choosing one fills the
                      flight&apos;s route field — nothing is re-flown until you press
                      Generate.
                    </p>
                    {/* When nothing on offer actually removes a finding, say
                        so once at the top. Otherwise a "Best option" card reads
                        as a fix and the controller swaps between two routes
                        that each carry the same problem. */}
                    {selected.suggestions.every((s) => s.clears.length === 0) && (
                      <p className="pdr-sugg-nogain">
                        None of these clears the finding above — every published
                        route for this pair carries it. Changing the level, or
                        editing the route by hand, is the way out.
                      </p>
                    )}
                    {selected.suggestions.map((s, i) => (
                      <SuggestionCard
                        key={s.route + (s.rnav ? "-R" : "-N")}
                        s={s}
                        rank={i + 1}
                        total={selected.suggestions.length}
                        onUse={() => onUseRoute(selectedKey!, s.route)}
                      />
                    ))}
                  </>
                )}

                {selected.suggestions.length === 0 &&
                  selected.findings.some((f) => f.severity !== "info") && (
                    <div className="pdr-no-alt">
                      <p>
                        No published alternative is available for this pair at
                        this time — ENR 1.10 covers only a minority of city
                        pairs. Re-route by hand, or coordinate the filed routing.
                      </p>
                      {onOpenPlan && (
                        <button
                          type="button"
                          className="pdr-edit-plan wide"
                          onClick={() => onOpenPlan(selectedKey!)}
                          title="Bring this flight's tab to the front in the generator. This panel stays open, and the check re-runs as you edit."
                        >
                          ✎ Edit route in plan →
                        </button>
                      )}
                    </div>
                  )}

                {validFrom && validTo && (
                  <p className="pdr-src-note">
                    Activity times: AIXM export valid {validFrom.slice(0, 10)} to{" "}
                    {validTo.slice(0, 10)}.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
