"use client";

/**
 * Conflicts menu — separation between aircraft in the air.
 *
 * Everything here reads the REPLAY: it needs two flights on the clock, it is
 * measured in miles and minutes to CPA, and it is answered by a vector, a level
 * or a speed. That is the whole tab, and the badge counts one kind of thing.
 *
 * Three neighbours are deliberately NOT here. Arrival sequencing has its own
 * tab, being about the landing order rather than about separation; sector
 * information and dynamic sectorisation have the Sector tab, being about the
 * workload the airspace carries. The departure-conflict and route/area checks
 * moved to the Plan check tab — they are read off the FILED plans and answered
 * before anything flies, so they were never the same question as these rows.
 */

import { memo } from "react";

import NavIcon from "@/components/nav/NavIcon";
import type {
  AutoModeOption,
  AutoResolveMode,
  CdrView,
} from "@/components/nav/types";

export interface ConflictsMenuProps {
  cdrView: CdrView;
  onOpenView: (v: CdrView) => void;
  /** Live monitoring only runs in "all routes" playback. */
  monitoring: boolean;
  unresolvedCount: number;
  logCount: number;
  autoResolve: boolean;
  autoResolveMode: AutoResolveMode;
  autoModeOptions: readonly AutoModeOption[];
  onAutoResolveMode: (mode: AutoResolveMode) => void;
  /** Re-run the up-front pass when "Before replay" is picked again. */
  onRerunAutoPass: () => void;
  autoPass: { fixed: number; unfixed: number; done: boolean } | null;
  /** Fired after a view is picked, so the bar can close the dropdown. */
  onPicked: () => void;
}

function ConflictsMenu({
  cdrView,
  onOpenView,
  monitoring,
  unresolvedCount,
  logCount,
  autoResolve,
  autoResolveMode,
  autoModeOptions,
  onAutoResolveMode,
  onRerunAutoPass,
  autoPass,
  onPicked,
}: ConflictsMenuProps) {
  const pick = (v: CdrView) => {
    onOpenView(v);
    onPicked();
  };

  return (
    <div className="cdr-menu cdr-menu-flat">
      <button
        type="button"
        role="menuitem"
        className={cdrView === "notifications" ? "active" : ""}
        onClick={() => pick("notifications")}
      >
        <NavIcon name="bell" size={15} />
        Conflict notifications
        {monitoring && unresolvedCount > 0 && (
          <span className="cdr-menu-count">{unresolvedCount}</span>
        )}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cdrView === "dashboard" ? "active" : ""}
        onClick={() => pick("dashboard")}
      >
        <NavIcon name="conflicts" size={15} />
        Conflict dashboard
      </button>
      <button
        type="button"
        role="menuitem"
        className={cdrView === "log" ? "active" : ""}
        onClick={() => pick("log")}
        title="Every encounter of the run: when, who, what kind, and what resolved it"
      >
        <NavIcon name="log" size={15} />
        Conflict log
        {logCount > 0 && <span className="cdr-menu-count">{logCount}</span>}
      </button>

      <div className="cdr-menu-sep" role="separator" />

      {/* Auto-resolve is a three-way choice, not a switch: the operator picks
          WHEN the resolver works — up front over the whole filed plan, or live
          as the replay runs. */}
      <div className="cdr-auto-head">
        <span>
          <NavIcon name="auto" size={15} /> Auto-resolve conflicts
        </span>
        <span className={`cdr-auto-pill${autoResolve ? " on" : ""}`}>
          {autoResolve ? "ON" : "OFF"}
        </span>
      </div>
      <div
        className="cdr-auto-modes"
        role="group"
        aria-label="Auto-resolve conflicts"
      >
        {autoModeOptions.map((o) => (
          <button
            key={o.mode}
            type="button"
            role="menuitemradio"
            aria-checked={autoResolveMode === o.mode}
            className={`cdr-auto-mode${
              autoResolveMode === o.mode ? " active" : ""
            }`}
            onClick={() => {
              // Re-picking "Before replay" re-runs the pass over whatever is
              // still unresolved.
              if (o.mode === "before" && autoResolveMode === "before") {
                onRerunAutoPass();
              } else {
                onAutoResolveMode(o.mode);
              }
            }}
            title={o.hint}
          >
            <span className="cdr-auto-radio" aria-hidden>
              {autoResolveMode === o.mode ? "●" : "○"}
            </span>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {autoResolveMode === "before" && autoPass && (
        <div className="cdr-auto-status" role="status" aria-live="polite">
          {autoPass.done
            ? `Plan deconflicted · ${autoPass.fixed} fixed${
                autoPass.unfixed > 0
                  ? ` · ${autoPass.unfixed} need manual action`
                  : ""
              } — pick again to re-run`
            : `Resolving the filed plan… ${autoPass.fixed} fixed`}
        </div>
      )}
    </div>
  );
}

export default memo(ConflictsMenu);
