"use client";

/**
 * ArrivalPanel — the landing sequence for each runway, read top-down the way a
 * controller reads an arrival ladder: first to land at the top, each row
 * showing the gap to the aircraft ahead against the gap it needs.
 *
 *   1  UBA100  A320  M     ——
 *   2  UAE102  B77W  H    4.0 / 5.0 NM  wake    ⚠ 1.0 NM short
 *   3  KMV103  A320  M    6.6 / 5.0 NM  wake
 *
 * The number that matters is the SHORTFALL, and it is the stream's, not the
 * pair's: `arrivalPlan` re-times the whole order, so an aircraft can need a
 * delay even when its own gap looks legal — because the one in front of it is
 * being held back. Rows carrying inherited delay say so, since that is the
 * thing a pair-at-a-time reading gets wrong.
 *
 * Instructions can be issued from the row. A SPEED control is re-timed in the
 * browser (it keeps the ground track); a HOLD splices a published racetrack in
 * at the fix, also in the browser; a downwind extension is re-flown by the
 * engine, which owns the vector geometry.
 */

import { useState } from "react";

import {
  holdFix,
  speedFix,
  vectorFix,
  type ArrivalFix,
  type ArrivalContext,
} from "@/lib/cdr/arrivalFix";
import type { CdrConfig } from "@/lib/cdr/config";
import type { ArrivalPlan, PlannedArrival } from "@/lib/cdr/arrivalPlan";
import type { SpacingDriver } from "@/lib/cdr/arrivalSequence";
import type { WakeCategory } from "@/lib/cdr/wake";
import NavIcon from "@/components/nav/NavIcon";

interface Props {
  plans: ArrivalPlan[];
  onClose: () => void;
  /** Highlight one aircraft (e.g. the map selection). */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** The ATC clearance each arrival is flown under, by flight key. An
   *  open STAR ends in a vector leg and the approach may not be entered without
   *  a clearance, so showing it is how a controller sees WHICH flow an aircraft
   *  is on. */
  clearanceOf?: (id: string) => string | undefined;
  /** Issue the instruction on a row. Only called for kinds the app can fly;
   *  omit to render the panel read-only. */
  onIssue?: (flightKey: string, fix: ArrivalFix) => void;
  /** Flights whose instruction has been issued, so the row reads as done. */
  issued?: ReadonlySet<string>;
  /** Flights with an instruction in flight to the engine. */
  busy?: ReadonlySet<string>;
  /** Show what a fix would do, without committing it. */
  onPreview?: (flightKey: string, fix: ArrivalFix) => void;
  /** The flight currently previewed, and whether that preview actually drew a
   *  path. A speed control keeps the ground track, so there is nothing to see
   *  on the map — the row says so rather than leaving the user hunting for a
   *  line that is exactly under the existing one. */
  previewedId?: string | null;
  previewHasTrack?: boolean;
  /** Needed to rebuild an instruction when the controller dials its size. */
  config: CdrConfig;
  /** Whether each flight can be vectored, for the same reason. */
  contextOf?: (id: string) => ArrivalContext;
}

/** How far one click of the stepper moves each kind. A hold moves in whole
 *  racetracks — there is no such instruction as half a pattern. */
const STEP: Record<string, number> = { kt: 5, NM: 0.5, loop: 1 };
const MIN_AMOUNT: Record<string, number> = { kt: 5, NM: 0.5, loop: 1 };

/** Can this instruction actually be flown? Speed is re-timed client-side and a
 *  vector is re-flown by the engine, so both always can. A hold can only be
 *  flown when it names a published fix still ahead of the aircraft; the
 *  advisory hold offered where there is none is a statement, not a clearance. */
const issuable = (f: ArrivalFix): boolean =>
  f.kind === "speed" || f.kind === "vector" || (f.kind === "hold" && !!f.hold);

const WAKE_LABEL: Record<WakeCategory, string> = {
  SUPER: "J",
  HEAVY: "H",
  MEDIUM: "M",
  LIGHT: "L",
};

const DRIVER_LABEL: Record<SpacingDriver, string> = {
  radar: "radar",
  wake: "wake",
  "runway-occupancy": "runway",
};

const fmtEta = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};

function Row({
  planned,
  selected,
  onSelect,
  clearance,
  onIssue,
  issued,
  busy,
  onPreview,
  previewed,
  previewHasTrack,
  config,
  contextOf,
}: {
  planned: PlannedArrival;
  selected: boolean;
  onSelect?: (id: string) => void;
  clearance?: string;
  onIssue?: (flightKey: string, fix: ArrivalFix) => void;
  issued?: boolean;
  busy?: boolean;
  onPreview?: (flightKey: string, fix: ArrivalFix) => void;
  previewed?: boolean;
  previewHasTrack?: boolean;
  config: CdrConfig;
  contextOf?: (id: string) => ArrivalContext;
}) {
  const { arrival, pair, delayNm, inheritedNm, fixes } = planned;
  const short = delayNm > 0;
  // The controller picks the instruction; the planner's ranking is advice, not
  // law. `null` amount means "whatever the planner proposed" — the moment it is
  // touched, the instruction is rebuilt at that size.
  const [kind, setKind] = useState<ArrivalFix["kind"] | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const chosen = fixes.find((f) => f.kind === kind) ?? fixes[0];
  const fix = (() => {
    if (!chosen || amount == null) return chosen;
    if (chosen.kind === "speed") {
      return speedFix(config, arrival, delayNm, amount) ?? chosen;
    }
    if (chosen.kind === "vector") {
      return vectorFix(
        config,
        arrival,
        contextOf?.(arrival.id) ?? { openStar: true },
        delayNm,
        amount,
      );
    }
    if (chosen.kind === "hold" && chosen.hold) {
      return holdFix(config, arrival, chosen.hold, delayNm, amount);
    }
    return chosen;
  })();
  return (
    <li className={`arr-row${short ? " short" : ""}${selected ? " sel" : ""}`}>
      <button
        type="button"
        className="arr-row-head"
        onClick={() => onSelect?.(arrival.id)}
        title={
          pair
            ? `${arrival.callsign}: ${pair.spacingNm.toFixed(1)} NM behind ` +
              `${pair.leader.callsign}, needs ${pair.requiredNm.toFixed(1)} NM ` +
              `(${DRIVER_LABEL[pair.requiredBy]})`
            : `${arrival.callsign} lands first`
        }
      >
        <span className="arr-seq">{arrival.position}</span>
        <span className="arr-cs">{arrival.callsign}</span>
        <span className="arr-type">{arrival.type}</span>
        <span
          className={`arr-wake w-${arrival.wake.toLowerCase()}`}
          title={
            arrival.wakeKnown
              ? `${arrival.wake} (ICAO Doc 4444 §4.9.1.1)`
              : `${arrival.wake} assumed — type not in the wake table`
          }
        >
          {WAKE_LABEL[arrival.wake]}
          {arrival.wakeKnown ? "" : "?"}
        </span>
        <span className="arr-eta" title="Time to threshold">
          {fmtEta(arrival.etaSec)}
          {arrival.etaEstimated ? "*" : ""}
        </span>
        {pair ? (
          <span className="arr-gap">
            <span className={short ? "bad" : "ok"}>
              {pair.spacingNm.toFixed(1)}
            </span>
            <span className="arr-gap-sep">/</span>
            {pair.requiredNm.toFixed(1)} NM
            <span className="arr-driver">{DRIVER_LABEL[pair.requiredBy]}</span>
          </span>
        ) : (
          <span className="arr-gap arr-first">first</span>
        )}
      </button>

      {/* Where the aircraft is coming from and which arrival flow it is on. A
          landing order is read against the flows feeding it — two aircraft 4 NM
          apart off the same STAR is a different picture from two off opposite
          ones — so the city pair and the STAR belong on the strip. */}
      <div className="arr-od">
        <span title="Departure → destination aerodrome">
          {arrival.adep || "?"} <span className="arr-od-arrow">→</span>{" "}
          {arrival.ades || "?"}
        </span>
        {arrival.star ? (
          <span className="arr-star" title="STAR being flown">
            STAR {arrival.star}
          </span>
        ) : (
          <span
            className="arr-star none"
            title="No STAR — this arrival routes direct to the approach"
          >
            no STAR
          </span>
        )}
      </div>

      {clearance && (
        <div className="arr-clr" title="ATC clearance this arrival is flown under">
          {clearance}
        </div>
      )}

      {/* An instruction that WORKED leaves nothing else on the row — the whole
          fix block below only renders while the row is short. Without this the
          only place an "issued" badge could ever appear was next to a red
          deficit, which read as "the instruction did nothing". */}
      {issued && !short && (
        <div className="arr-done" title="Instruction issued; the gap is now legal">
          ✓ instruction issued — spacing restored
        </div>
      )}

      {previewed && !previewHasTrack && (
        <div className="arr-note">
          Same ground track — a speed control changes only the timing, so there
          is nothing new to draw on the map.
        </div>
      )}

      {short && fixes.length > 1 && (
        <div className="arr-kinds">
          {fixes.map((f) => (
            <button
              key={f.kind}
              type="button"
              className={`arr-kind k-${f.kind}${f.kind === chosen?.kind ? " on" : ""}`}
              onClick={() => {
                setKind(f.kind);
                setAmount(null); // back to what the planner proposed
              }}
              title={
                f.sufficient
                  ? `Absorbs ${f.absorbsNm.toFixed(1)} NM — enough on its own`
                  : `Absorbs only ${f.absorbsNm.toFixed(1)} NM of ${delayNm.toFixed(1)}`
              }
            >
              {f.kind}
              {f.sufficient ? "" : " ⚠"}
            </button>
          ))}
        </div>
      )}

      {short && (
        <div className="arr-fix">
          <span className="arr-deficit">−{delayNm.toFixed(1)} NM</span>
          {inheritedNm > 0.05 && (
            <span
              className="arr-inherited"
              title="Caused by the delay applied to aircraft ahead, not by this pair on its own"
            >
              {inheritedNm.toFixed(1)} NM inherited
            </span>
          )}
          {/* Issued AND still short. The instruction is flown — this is what is
              left over, and the two causes need different actions: a gap held
              open by the aircraft ahead closes when THAT one is fixed, while a
              gap of its own needs more from this aircraft. */}
          {issued && (
            <span className="arr-residual">
              still short after the instruction —{" "}
              {inheritedNm > 0.05
                ? "held open by the aircraft ahead; it closes once that one is fixed too"
                : "the instruction absorbs less than the stream needs; issue more"}
            </span>
          )}
          {fix ? (
            <span className={`arr-instr k-${fix.kind}`}>
              {fix.instruction}
              {fix.amount != null && fix.amountUnit && onIssue && (
                <span className="arr-amount">
                  <button
                    type="button"
                    onClick={() =>
                      setAmount(
                        Math.max(
                          MIN_AMOUNT[fix.amountUnit!],
                          (fix.amount ?? 0) - STEP[fix.amountUnit!],
                        ),
                      )
                    }
                    title="Less"
                  >
                    −
                  </button>
                  <span className={fix.sufficient ? "" : "short"}>
                    {fix.amountUnit === "NM"
                      ? fix.amount.toFixed(1)
                      : Math.round(fix.amount)}{" "}
                    {fix.amountUnit}
                    {fix.amountUnit === "loop" && fix.amount !== 1 ? "s" : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setAmount(
                        Math.min(
                          fix.maxAmount ?? Infinity,
                          (fix.amount ?? 0) + STEP[fix.amountUnit!],
                        ),
                      )
                    }
                    title="More — the planner proposes the bare minimum, with no margin"
                  >
                    +
                  </button>
                </span>
              )}
              {issued && <span className="arr-issued">issued</span>}
              {/* Still offered after an instruction: the row is only here
                  because the gap is STILL short, and latching the button off
                  left the controller looking at a deficit they could no longer
                  act on. A second downwind extension is sent as the running
                  total (see MapApp) so it adds to the first rather than
                  replacing it. */}
              {onIssue && issuable(fix) ? (
                <>
                  {onPreview && (
                    <button
                      type="button"
                      className={`arr-preview${previewed ? " on" : ""}`}
                      onClick={() => onPreview(arrival.id, fix)}
                      disabled={busy}
                      title={
                        fix.kind === "speed"
                          ? "A speed control keeps the ground track — only the timing changes"
                          : "Draw the path it would fly, without issuing it"
                      }
                    >
                      {previewed ? "Hide" : "Preview"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="arr-issue"
                    onClick={() => onIssue(arrival.id, fix)}
                    disabled={busy}
                    title={
                      issued
                        ? `Issue a further instruction to ${arrival.callsign}`
                        : `Issue to ${arrival.callsign}`
                    }
                  >
                    {busy ? "…" : issued ? "Issue more" : "Issue"}
                  </button>
                </>
              ) : onIssue ? (
                <span
                  className="arr-issue disabled"
                  title={
                    "No published holding fix left ahead of this aircraft, so " +
                    "there is nowhere to hold it — the approach cannot absorb " +
                    "this gap."
                  }
                >
                  not issuable
                </span>
              ) : null}
            </span>
          ) : (
            <span className="arr-instr k-none">no resolution available</span>
          )}
        </div>
      )}
    </li>
  );
}

export default function ArrivalPanel({
  plans,
  onClose,
  selectedId,
  onSelect,
  clearanceOf,
  onIssue,
  issued,
  busy,
  onPreview,
  previewedId,
  previewHasTrack,
  config,
  contextOf,
}: Props) {
  const total = plans.reduce((n, p) => n + p.order.length, 0);
  const shortCount = plans.reduce((n, p) => n + p.actions.length, 0);

  return (
    <div
      className="cdr-panel arr-panel"
      role="dialog"
      aria-label="Arrival sequence"
    >
      <div className="cdr-panel-head">
        <strong>
          <NavIcon name="sequencing" size={14} /> Arrival sequence
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

      {total === 0 ? (
        <p className="cdr-panel-empty">
          No arrivals to sequence. Needs two or more flights landing at the same
          runway, with the runway resolved by the generator.
        </p>
      ) : (
        <>
          <p className="arr-summary">
            {total} arrival{total === 1 ? "" : "s"} ·{" "}
            {shortCount === 0 ? (
              <span className="ok">all separated</span>
            ) : (
              <span className="bad">{shortCount} short of minima</span>
            )}
          </p>
          {plans.map((plan) => (
            <section key={`${plan.ades}/${plan.runway}`} className="arr-stream">
              <h3 className="cdr-dash-h">
                {plan.ades} {plan.runway}
                {plan.totalDelayNm > 0 && (
                  <span className="arr-total">
                    {plan.totalDelayNm.toFixed(1)} NM to absorb
                  </span>
                )}
              </h3>
              <ol className="arr-list">
                {plan.order.map((p) => (
                  <Row
                    key={p.arrival.id}
                    planned={p}
                    selected={selectedId === p.arrival.id}
                    onSelect={onSelect}
                    clearance={clearanceOf?.(p.arrival.id)}
                    onIssue={onIssue}
                    issued={issued?.has(p.arrival.id)}
                    busy={busy?.has(p.arrival.id)}
                    onPreview={onPreview}
                    previewed={previewedId === p.arrival.id}
                    previewHasTrack={previewHasTrack}
                    config={config}
                    contextOf={contextOf}
                  />
                ))}
              </ol>
            </section>
          ))}
          <p className="arr-foot">
            Spacing is the follower&apos;s distance to run when the aircraft
            ahead touches down. Minima: ICAO Doc 4444 §8.7.3 — 2.5 NM
            established on final within 10 NM, wake §8.7.3.4, plus runway
            occupancy.
          </p>
        </>
      )}
    </div>
  );
}
