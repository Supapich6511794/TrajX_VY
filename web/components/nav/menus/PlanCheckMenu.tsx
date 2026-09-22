"use client";

/**
 * Plan check menu — what is wrong with the flight plans as FILED.
 *
 * Both rows used to sit under Conflicts, and both were the odd ones out there.
 * Everything else on that tab is about separation between aircraft in the air:
 * it reads the replay, it needs two flights on the clock, and it is answered by
 * a vector or a level change. These two are answered before anything moves —
 * by re-timing a departure, or by re-filing a route — and they are read off the
 * filed plans alone, which is why the departure row worked with an empty map
 * while the rows above it did not.
 *
 * Keeping them there made "Conflicts" mean two unrelated things at once and
 * made its badge ambiguous. Split out, each tab counts one kind of problem.
 *
 * The order is the order the checks apply: can this flight leave, and is the
 * route it filed one it is allowed to fly.
 */

import { memo } from "react";

import NavIcon from "@/components/nav/NavIcon";
import type { CdrView } from "@/components/nav/types";

export interface PlanCheckMenuProps {
  cdrView: CdrView;
  onOpenView: (v: CdrView) => void;
  /** Departure conflicts come from the filed plans, not from the replay. */
  depConflictCount: number;
  depPanelOpen: boolean;
  onOpenDepartures: () => void;
  pdrActionable: number;
  /** Fired after a row is picked, so the bar can close the dropdown. */
  onPicked: () => void;
}

function PlanCheckMenu({
  cdrView,
  onOpenView,
  depConflictCount,
  depPanelOpen,
  onOpenDepartures,
  pdrActionable,
  onPicked,
}: PlanCheckMenuProps) {
  return (
    <div className="cdr-menu cdr-menu-flat">
      <button
        type="button"
        role="menuitem"
        className={depPanelOpen ? "active" : ""}
        disabled={depConflictCount === 0}
        onClick={() => {
          onOpenDepartures();
          onPicked();
        }}
        title={
          depConflictCount === 0
            ? "Every filed departure can be cleared as it stands"
            : `${depConflictCount} filed departures cannot be cleared as they stand`
        }
      >
        <NavIcon name="departure" size={15} />
        Departure conflict
        {depConflictCount > 0 && (
          <span className="cdr-menu-count">{depConflictCount}</span>
        )}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cdrView === "pdr" ? "active" : ""}
        onClick={() => {
          onOpenView("pdr");
          onPicked();
        }}
        title="Check each filed route against the Prohibited/Danger/Restricted areas and the published preferred routes (PDR, ENR 1.10)"
      >
        <NavIcon name="restricted" size={15} />
        Route &amp; area check
        {pdrActionable > 0 && (
          <span className="cdr-menu-count">{pdrActionable}</span>
        )}
      </button>
    </div>
  );
}

export default memo(PlanCheckMenu);
