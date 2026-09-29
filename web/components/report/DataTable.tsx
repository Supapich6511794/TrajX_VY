"use client";

/**
 * DataTable — the whole report table, at any size.
 *
 * A traffic day's flight-events report runs to six figures of rows. Handing
 * that many <tr> to the browser is not slow, it is a hung tab, so only the rows
 * in view are in the DOM: the body is a spacer of the full height and the
 * visible slice is translated down to where it belongs. Scrolling therefore
 * behaves normally — the bar is the real length of the data, Ctrl+End reaches
 * the last row, and the count in the header is the count in the file.
 *
 * Nothing is hidden and nothing is paged. The point of the tab is to be able to
 * check the numbers without opening a spreadsheet, and a table that quietly
 * stopped at row 2,000 would be worse than no table, because it looks complete.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Cell } from "@/lib/report/xlsx";

/** Row height, in px. Fixed on purpose: a virtual list over variable heights
 *  needs a measurement pass per row, which is the cost this avoids. */
const ROW_H = 30;
/** Rows kept above and below the viewport, so a fast flick does not show gaps. */
const OVERSCAN = 8;
/** Rows sampled to size the columns. The first screenful is representative and
 *  walking 100k rows to measure text would undo the point of the windowing. */
const WIDTH_SAMPLE = 120;

interface Props {
  /** Header row first, then the data. */
  rows: Cell[][];
  /** Rows matching the filter, if one is on; defaults to all of `rows`. */
  filter?: string;
}

const text = (c: Cell): string => (c == null ? "" : String(c));

/** Column widths from the header and a sample of the body, in px. Numbers get
 *  less room than free text; both are clamped so one long route string cannot
 *  push every other column off the screen. */
function columnWidths(rows: Cell[][]): number[] {
  const head = rows[0] ?? [];
  const sample = rows.slice(1, 1 + WIDTH_SAMPLE);
  return head.map((h, i) => {
    let longest = text(h).length;
    for (const r of sample) {
      const n = text(r[i]).length;
      if (n > longest) longest = n;
    }
    return Math.max(72, Math.min(340, 14 + longest * 7.4));
  });
}

export default function DataTable({ rows, filter }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [viewH, setViewH] = useState(520);

  const head = rows[0] ?? [];
  const widths = useMemo(() => columnWidths(rows), [rows]);
  const totalW = useMemo(() => widths.reduce((a, b) => a + b, 0), [widths]);

  // Filtering is a plain substring over the row, joined. Deliberately dumb: the
  // question this answers is "where is UBA201 in here", and a query language
  // would be a second thing to learn for a table someone is only checking.
  const body = useMemo(() => {
    const q = (filter ?? "").trim().toUpperCase();
    const all = rows.slice(1);
    if (!q) return all;
    const terms = q.split(/\s+/).filter(Boolean);
    return all.filter((r) => {
      const hay = r.map(text).join(" ").toUpperCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, filter]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) setTop(el.scrollTop);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // A filter changes which rows exist; staying at row 40,000 of a list that now
  // has three is a blank screen that reads as a broken table.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setTop(0);
  }, [filter]);

  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const last = Math.min(body.length, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);
  const slice = body.slice(first, last);

  return (
    <div className="rv-table" ref={scroller} onScroll={onScroll} tabIndex={0}>
      <div className="rv-table-inner" style={{ minWidth: totalW }}>
        <div className="rv-thead" role="row">
          {head.map((h, i) => (
            <span key={i} style={{ width: widths[i] }} role="columnheader">
              {text(h)}
            </span>
          ))}
        </div>

        {body.length === 0 ? (
          <p className="rv-table-empty">
            No row matches {filter ? `“${filter}”` : "the filter"}.
          </p>
        ) : (
          <div className="rv-tbody" style={{ height: body.length * ROW_H }}>
            <div
              className="rv-rows"
              style={{ transform: `translateY(${first * ROW_H}px)` }}
            >
              {slice.map((r, i) => (
                <div
                  className="rv-row"
                  role="row"
                  key={first + i}
                  style={{ height: ROW_H }}
                >
                  {head.map((_, c) => (
                    <span key={c} style={{ width: widths[c] }} role="cell">
                      {text(r[c])}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Rows a filter leaves, without rendering anything — for the count in the
 *  header, which has to agree with what the table shows. */
export function countMatching(rows: Cell[][], filter?: string): number {
  const q = (filter ?? "").trim().toUpperCase();
  if (!q) return Math.max(0, rows.length - 1);
  const terms = q.split(/\s+/).filter(Boolean);
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const hay = rows[i].map(text).join(" ").toUpperCase();
    if (terms.every((t) => hay.includes(t))) n++;
  }
  return n;
}
