"use client";

/**
 * ConflictLogPanel — the record of the run.
 *
 * One row per encounter, in the form a post-run report wants it:
 *
 *   02:14:20–02:16:05Z   UBA100 x MMA122     crossing 68°
 *   2.1 NM / 0 ft  (minima 5 NM / 1000 ft)
 *   ✓ resolved 02:06:30Z — MMA122 reduce 20 kt   MINGALADON CTR
 *
 * The other CD&R views are about the present: the notification stack clears as
 * conflicts pass and the dashboard drops a pair the moment it is fixed. This
 * one keeps everything, including what fixed it, so the run can be read back
 * afterwards. "Copy" hands the whole thing over as text; "Download" saves it
 * as a Word report to hand in, or as CSV to count in a spreadsheet.
 */

import { useEffect, useRef, useState } from "react";

import {
  conflictLogCounts,
  conflictLogCsv,
  formatLogLine,
  type ConflictLogEntry,
  type ConflictOutcome,
} from "@/lib/cdr/conflictLog";
import { conflictLogDocx } from "@/lib/cdr/conflictLogDocx";
import { DOCX_MIME } from "@/lib/docx";
import NavIcon from "@/components/nav/NavIcon";

interface Props {
  log: ConflictLogEntry[];
  onClose: () => void;
  /** Shared-clock seconds -> the UTC stamp shown ("02:14:20Z"). */
  utc: (sec: number) => string;
  /** Focus a pair on the map / dashboard, when the app can. */
  onSelect?: (conflictId: string) => void;
}

const OUTCOME_LABEL: Record<ConflictOutcome, string> = {
  unresolved: "unresolved",
  advisory: "advisory",
  resolved: "resolved",
  cleared: "cleared",
};

/** Filters, in the order a reader wants them: everything, then the ones that
 *  still need an answer, then what was done. */
const FILTERS: { key: "all" | ConflictOutcome; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unresolved", label: "Unresolved" },
  { key: "advisory", label: "Advisory" },
  { key: "resolved", label: "Resolved" },
  { key: "cleared", label: "Cleared" },
];

/** Hand built bytes to the browser as a file. */
function save(data: BlobPart, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Same grace period the trajectory downloads use before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export default function ConflictLogPanel({ log, onClose, utc, onSelect }: Props) {
  const [filter, setFilter] = useState<"all" | ConflictOutcome>("all");
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const counts = conflictLogCounts(log);
  const rows = filter === "all" ? log : log.filter((e) => e.outcome === filter);

  // The format menu closes on the next click anywhere else, so it never sits
  // open over the log the reader came back to.
  useEffect(() => {
    if (!menu) return;
    const away = (ev: MouseEvent) => {
      if (!menuRef.current?.contains(ev.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);

  const copyAll = () => {
    const text = log.map((e) => formatLogLine(e, utc)).join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };

  /** Both files carry the WHOLE log, not the current filter: the record of a
   *  run is not the tab that happened to be open when it was saved. */
  const download = (kind: "report" | "csv") => {
    setMenu(false);
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    if (kind === "csv") {
      save(
        conflictLogCsv(log, utc),
        `conflict_log_${stamp}.csv`,
        "text/csv;charset=utf-8",
      );
    } else {
      save(
        conflictLogDocx(log, utc, `${now.toISOString().slice(0, 19)}Z`),
        `conflict_log_${stamp}.docx`,
        DOCX_MIME,
      );
    }
  };

  return (
    <div className="cdr-panel log-panel" role="dialog" aria-label="Conflict log">
      <div className="cdr-panel-head">
        <strong>
          <NavIcon name="log" size={14} /> Conflict log
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

      {log.length === 0 ? (
        <p className="cdr-panel-empty">
          Nothing recorded yet. Every conflict the scan finds is logged here —
          with the times it happens between, the pair, the geometry, and what
          was done about it.
        </p>
      ) : (
        <>
          <div className="log-bar">
            <span className="log-counts">
              <b>{counts.total}</b> encounter{counts.total === 1 ? "" : "s"} ·{" "}
              {/* "unresolved" is losses of separation still unanswered — the
                  same number the dashboard shows. A pass that stayed inside
                  minima is counted apart from it, not as a problem. */}
              <span className="bad">{counts.unresolved} unresolved</span> ·{" "}
              <span className="ok">{counts.resolved} resolved</span>
              {counts.advisory > 0 && <> · {counts.advisory} advisory</>}
              {counts.cleared > 0 && <> · {counts.cleared} cleared</>}
            </span>
            <span className="log-actions">
              <button
                type="button"
                className="log-copy"
                onClick={copyAll}
                title="Copy the whole log as text"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <span className="log-dl" ref={menuRef}>
                <button
                  type="button"
                  className="log-copy"
                  onClick={() => setMenu((v) => !v)}
                  title="Save the whole log as a file"
                  aria-haspopup="menu"
                  aria-expanded={menu}
                >
                  <NavIcon name="export" size={13} /> Download
                </button>
                {menu && (
                  <div className="log-dl-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => download("report")}>
                      <b>Word report</b>
                      <small>.docx — summary + tables, grouped by outcome</small>
                    </button>
                    <button type="button" role="menuitem" onClick={() => download("csv")}>
                      <b>CSV</b>
                      <small>.csv — one row per encounter, every field</small>
                    </button>
                  </div>
                )}
              </span>
            </span>
          </div>

          <div className="log-filters" role="group" aria-label="Filter the log">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`log-filter${filter === f.key ? " on" : ""}`}
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
              >
                {f.label}
              </button>
            ))}
          </div>

          <ol className="log-list">
            {rows.map((e) => (
              <li key={e.id} className={`log-row ${e.outcome}`}>
                <button
                  type="button"
                  className="log-row-head"
                  onClick={() => onSelect?.(e.id)}
                  title={
                    onSelect ? "Show this pair" : "Recorded conflict"
                  }
                >
                  <span className="log-when">
                    {e.fromSec === e.toSec
                      ? utc(e.tCpaSec)
                      : `${utc(e.fromSec)}–${utc(e.toSec)}`}
                  </span>
                  <span className="log-pair">
                    {e.aCallsign} <span className="log-x">×</span> {e.bCallsign}
                  </span>
                  <span className={`log-tag t-${e.geometry}`}>
                    {e.geometry}
                    {e.crossingDeg != null && e.geometry !== "unknown"
                      ? ` ${Math.round(e.crossingDeg)}°`
                      : ""}
                  </span>
                </button>

                <div className="log-sep">
                  {/* What the encounter actually came to, against what it had
                      to keep — the pair of numbers a report is written from. */}
                  <b className={e.definite ? "bad" : ""}>
                    {e.minHNm.toFixed(1)} NM / {Math.round(e.minVFt)} ft
                  </b>
                  <span className="log-minima">
                    minima {e.shNm} NM / {Math.round(e.svFt)} ft
                  </span>
                  {!e.definite && (
                    <span className="log-buffer" title="Never breached the hard minima — a close pass inside the advisory buffer">
                      buffer only
                    </span>
                  )}
                </div>

                <div className={`log-outcome ${e.outcome}`}>
                  {e.outcome === "resolved" && e.resolution ? (
                    <>
                      ✓ resolved {utc(e.resolution.atSec)} —{" "}
                      <b>{e.resolution.instruction}</b>
                      {e.resolution.maneuver && (
                        <span className="log-kind">{e.resolution.maneuver}</span>
                      )}
                      {e.resolution.beforeNm != null &&
                        e.resolution.afterNm != null && (
                          <span className="log-gain">
                            {e.resolution.beforeNm.toFixed(1)} →{" "}
                            {e.resolution.afterNm.toFixed(1)} NM
                          </span>
                        )}
                      {e.resolution.sector && (
                        <span className="log-sector">{e.resolution.sector}</span>
                      )}
                    </>
                  ) : e.outcome === "cleared" ? (
                    <>
                      ○ cleared — no longer in the plan, but nothing was issued
                      for it: another aircraft&apos;s re-time moved it away.
                    </>
                  ) : e.outcome === "advisory" ? (
                    <>
                      · advisory — came inside the buffer, minima kept. Nothing
                      was issued and nothing had to be.
                    </>
                  ) : (
                    <>⚠ {OUTCOME_LABEL.unresolved} — no instruction issued</>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {rows.length === 0 && (
            <p className="cdr-panel-empty">Nothing under this filter.</p>
          )}
        </>
      )}
    </div>
  );
}
