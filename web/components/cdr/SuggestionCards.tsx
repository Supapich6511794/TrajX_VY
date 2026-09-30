"use client";

/**
 * SuggestionCards — the ranked resolution advisories for the selected conflict.
 * Each card states the instruction ("Turn right 15°"), the outcome (d_CPA
 * before → after), and the cost (extra track miles / time, or the level
 * change), with Preview (draw the modified path dashed, uncommitted) and Apply
 * (write the maneuver into the flight) actions.
 *
 * Suggestions are recomputed every tick upstream, so what's shown is always
 * validated against the current traffic picture; a card that no longer clears
 * simply disappears on the next pass.
 */

import { fmtNm } from "@/lib/cdr/format";
import type {
  Blocker,
  ChainedResolution,
  RejectedCandidate,
} from "@/lib/cdr/planAdvisory";
import type { Maneuver } from "@/lib/cdr/types";

interface Props {
  suggestions: Maneuver[];
  nameOf: (id: string) => string;
  /** Index of the maneuver currently previewed on the map, or null. */
  previewIdx: number | null;
  onPreview: (idx: number | null) => void;
  onApply: (idx: number) => void;
  /** Traffic that rejected the candidates. With no suggestions this turns the
   *  dead-end "no resolution" into something actionable: which aircraft is in
   *  the way, so the controller knows what to move first. */
  blockers?: Blocker[];
  /** Every candidate the search actually tried and dropped, with why — the
   *  full audit trail `blockers` only aggregates. Collapsed by default (it's
   *  a "show your work" detail, not the headline); omitted = no section, as
   *  before. See `RejectedCandidate` for the reason vocabulary — in
   *  particular "secondary-conflict" (clears the pair, hits a third
   *  aircraft) is kept visually distinct from "unresolved-primary" (never
   *  cleared the pair at all), per the resolution spec's requirement that a
   *  candidate creating a secondary conflict never reads as equivalent to
   *  one that simply didn't work. */
  rejected?: RejectedCandidate[];
  /** The blocker's OWN conflict, when it has one. Naming the aircraft to move
   *  is only useful if it can be reached: this is what the button opens. Null
   *  means it is not in conflict itself — there is nothing to resolve, only an
   *  aircraft to look at. */
  blockerConflictOf?: (b: Blocker) => string | null;
  /** Go and work the blocker: open its conflict (`conflictId`), or with null
   *  put it on the map so it can be re-planned. Omitted = the readout stays
   *  plain text, as it was before. */
  onWorkBlocker?: (b: Blocker, conflictId: string | null) => void;
  /** Open the blocker's FLIGHT PLAN in the generator — the other way out, when
   *  no maneuver on either aircraft clears it and the routing has to change. */
  onEditBlockerPlan?: (b: Blocker) => void;
  /** The suggestions came from the wider fallback envelope — the maneuvers are
   *  bigger than the engine would normally propose. */
  widened?: boolean;
  /** The suggestions are ATFM ground delays — nothing airborne cleared. */
  atfm?: boolean;
  /** Blocker-first fixes, offered only when no single maneuver clears: move
   *  the third aircraft, then the pair's fix works. */
  chained?: ChainedResolution[];
  /** Apply both steps of `chained[idx]`, blocker first. Omitted = the chains
   *  are not shown. */
  onApplyChain?: (idx: number) => void;
}

const TYPE_LABEL: Record<Maneuver["type"], string> = {
  heading: "HDG",
  flightlevel: "LVL",
  route: "DCT",
  speed: "SPD",
  hold: "HOLD",
  delay: "ATFM",
};

/** Short badge text per rejection reason — kept distinct on purpose:
 *  "Secondary" (this maneuver would CREATE a new conflict) reads as a
 *  different kind of problem from "Unresolved" (it never cleared the
 *  original pair), matching the resolution spec's insistence that the two
 *  not be conflated. */
const REJECT_LABEL: Record<RejectedCandidate["reason"], string> = {
  "secondary-conflict": "Secondary",
  "rejoin-conflict": "Third · rejoin",
  "unresolved-primary": "Unresolved",
  "constraint-reject": "Constraint",
  "arrival-protected": "Arrival",
};

/** One collapsed-by-default row of the rejected-candidate audit trail. */
function RejectedRow({ r, nameOf }: { r: RejectedCandidate; nameOf: (id: string) => string }) {
  return (
    <li className="cdr-rejected-row">
      <span className={`cdr-rejected-badge reason-${r.reason}`}>
        {REJECT_LABEL[r.reason]}
      </span>
      <span className="cdr-rejected-text">
        <strong>{nameOf(r.target)}</strong> {r.instruction}
        <span className="cdr-rejected-detail">{r.detail}</span>
      </span>
    </li>
  );
}

/** Collapsible "show your work" trail — every candidate the search tried and
 *  dropped. Native `<details>` rather than component state: it's supporting
 *  detail nobody needs open by default, and this way there's nothing to wire
 *  up or reset when the conflict selection changes. */
function RejectedTrail({
  rejected,
  nameOf,
}: {
  rejected: RejectedCandidate[];
  nameOf: (id: string) => string;
}) {
  if (rejected.length === 0) return null;
  return (
    <details className="cdr-adv-rejected">
      <summary>Rejected candidates ({rejected.length})</summary>
      <ul className="cdr-rejected-list">
        {rejected.map((r, i) => (
          <RejectedRow key={`${r.target}-${r.type}-${i}`} r={r} nameOf={nameOf} />
        ))}
      </ul>
    </details>
  );
}

/** "Resolve the blocker first" — each card is two steps applied together.
 *  They were validated as a pair, so there is no per-step Apply: flying only
 *  the second one is exactly the candidate that was rejected. */
function ChainCards({
  chained,
  nameOf,
  onApply,
}: {
  chained: ChainedResolution[];
  nameOf: (id: string) => string;
  onApply: (idx: number) => void;
}) {
  return (
    <div className="cdr-adv">
      <p className="cdr-adv-head">
        Resolve the blocker first
        <span className="cdr-adv-wide">2 steps</span>
      </p>
      {chained.map((c, i) => (
        <div
          key={`${c.blockerFix.target}-${c.blockerFix.type}-${c.fix.target}-${c.fix.type}`}
          className="cdr-card"
        >
          {[c.blockerFix, c.fix].map((step, n) => (
            <div key={n} className="cdr-chain-step">
              <span className="cdr-chain-no">{n + 1}</span>
              <span className={`cdr-card-type type-${step.type}`}>
                {TYPE_LABEL[step.type]}
              </span>
              <span className="cdr-card-instr">
                <strong>{nameOf(step.target)}</strong> {step.instruction}
              </span>
            </div>
          ))}
          <div className="cdr-card-meta">
            <span className="cdr-card-outcome">
              d_CPA {fmtNm(c.fix.origDCpaNm)} → <strong>{fmtNm(c.fix.newDCpaNm)}</strong>
            </span>
            <span className="cdr-card-cost">
              {costLabel(c.blockerFix)} · {costLabel(c.fix)}
            </span>
          </div>
          <div className="cdr-card-actions">
            <button
              type="button"
              className="cdr-card-btn apply"
              onClick={() => onApply(i)}
              title={`Move ${nameOf(c.blockerFix.target)} first, then ${nameOf(c.fix.target)} — checked together against all traffic`}
            >
              Apply both
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Compact cost string per maneuver kind. */
function costLabel(m: Maneuver): string {
  if (m.type === "flightlevel") {
    const sign = m.altChangeFt > 0 ? "+" : "−";
    return `${sign}${Math.abs(m.altChangeFt)} ft`;
  }
  const parts: string[] = [];
  if (Math.abs(m.extraDistanceNm) >= 0.1) {
    const sign = m.extraDistanceNm >= 0 ? "+" : "−";
    parts.push(`${sign}${Math.abs(m.extraDistanceNm).toFixed(1)} NM`);
  }
  if (Math.abs(m.extraTimeSec) >= 5) {
    const sign = m.extraTimeSec >= 0 ? "+" : "−";
    parts.push(`${sign}${(Math.abs(m.extraTimeSec) / 60).toFixed(1)} min`);
  }
  return parts.length ? parts.join(", ") : "negligible";
}

export default function SuggestionCards({
  suggestions,
  nameOf,
  previewIdx,
  onPreview,
  onApply,
  blockers,
  blockerConflictOf,
  onWorkBlocker,
  onEditBlockerPlan,
  widened,
  atfm,
  rejected,
  chained,
  onApplyChain,
}: Props) {
  if (suggestions.length === 0 && chained?.length && onApplyChain) {
    return (
      <>
        <ChainCards chained={chained} nameOf={nameOf} onApply={onApplyChain} />
        {rejected && <RejectedTrail rejected={rejected} nameOf={nameOf} />}
      </>
    );
  }
  if (suggestions.length === 0) {
    // Almost every "no resolution" is really "a third aircraft is in the way":
    // the maneuver separates the pair fine, then clips someone else and gets
    // dropped. Name that aircraft — resolving IT usually unblocks this pair.
    const worst = blockers?.[0];
    // …and let the controller GO there. "Resolve UBA574 first" with no way to
    // reach UBA574 is a dead end: its own conflict is somewhere down a stack of
    // dozens, and an aircraft that is merely in the way has no row at all.
    const blockerConflict = worst ? blockerConflictOf?.(worst) ?? null : null;
    return (
      <div className="cdr-adv-empty">
        <p>No clear resolution, even with a wider maneuver envelope.</p>
        {worst && (
          <>
            <p className="cdr-adv-blocked">
              Every candidate would then conflict with{" "}
              <b>{worst.callsign}</b>
              {Number.isFinite(worst.tightestNm) && ` (${fmtNm(worst.tightestNm)})`}
              {blockers && blockers.length > 1 && ` +${blockers.length - 1} more`}.
              {!onWorkBlocker && ` Resolve ${worst.callsign} first.`}
            </p>
            {/* Move it, or change what it is doing. A blocker that is in no
                conflict of its own still has to be got out of the way, and
                naming it without offering either was a dead end. */}
            <div className="cdr-adv-blocked-btns">
              {onWorkBlocker && (
                <button
                  type="button"
                  className="cdr-adv-blocked-btn"
                  onClick={() => onWorkBlocker(worst, blockerConflict)}
                  title={
                    blockerConflict
                      ? `Open ${worst.callsign}'s own conflict and resolve it — this pair should clear once it moves`
                      : `Level, heading, speed or hold on ${worst.callsign}, checked against all traffic`
                  }
                >
                  Fix {worst.callsign} →
                </button>
              )}
              {onEditBlockerPlan && (
                <button
                  type="button"
                  className="cdr-adv-blocked-btn ghost"
                  onClick={() => onEditBlockerPlan(worst)}
                  title={`Open ${worst.callsign}'s filed route in the generator`}
                >
                  Edit {worst.callsign}&rsquo;s plan
                </button>
              )}
            </div>
          </>
        )}
        {rejected && <RejectedTrail rejected={rejected} nameOf={nameOf} />}
      </div>
    );
  }
  return (
    <div className="cdr-adv">
      <p className="cdr-adv-head">
        Resolution advisories
        {widened && <span className="cdr-adv-wide">wider envelope</span>}
        {atfm && <span className="cdr-adv-wide">ATFM · no airborne fix</span>}
      </p>
      {suggestions.map((m, i) => {
        const previewing = previewIdx === i;
        return (
          <div key={`${m.target}-${m.type}-${m.value}`} className="cdr-card">
            <div className="cdr-card-top">
              <span className={`cdr-card-type type-${m.type}`}>
                {TYPE_LABEL[m.type]}
              </span>
              <span className="cdr-card-instr">
                <strong>{nameOf(m.target)}</strong> {m.instruction}
              </span>
            </div>
            <div className="cdr-card-meta">
              <span className="cdr-card-outcome">
                d_CPA {fmtNm(m.origDCpaNm)} → <strong>{fmtNm(m.newDCpaNm)}</strong>
              </span>
              <span className="cdr-card-cost">{costLabel(m)}</span>
            </div>
            <div className="cdr-card-actions">
              <button
                type="button"
                className={`cdr-card-btn${previewing ? " active" : ""}`}
                onClick={() => onPreview(previewing ? null : i)}
                aria-pressed={previewing}
              >
                {previewing ? "Hide preview" : "Preview"}
              </button>
              <button
                type="button"
                className="cdr-card-btn apply"
                onClick={() => onApply(i)}
              >
                Apply
              </button>
            </div>
          </div>
        );
      })}
      {rejected && <RejectedTrail rejected={rejected} nameOf={nameOf} />}
    </div>
  );
}
