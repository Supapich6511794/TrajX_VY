/**
 * Default runway in use, by aerodrome and month of year.
 *
 * Reads a measured runway-usage climatology from
 * `public/data/airports/runway_default.csv`. Each row is one airport ×
 * month-of-year × direction × runway, with `is_default = t` marking that
 * group's most-used runway (rnk 1). Columns read: airport, month_of_year,
 * direction (DEP / ARR / ALL), runway, pct, movements, n_years, is_default.
 *
 * OPTIONAL DATA: no such table has been built for the Yangon FIR yet, so the
 * file is normally absent. The loader fails closed — a missing or unreadable
 * file yields an empty table, every lookup returns null, and the runway
 * pickers are simply not pre-filled (the engine's own "Auto" choice stands).
 *
 * This is MEASURED usage, not the AIP's preferential-runway system: it says
 * what traffic actually did in that month across all pooled years, which is
 * why it is only ever used to PRE-FILL the runway pickers — the user can
 * always override it.
 *
 * Two rules are enforced here:
 *   - Departures read the DEP rows and arrivals the ARR rows. The combined
 *     ALL bucket averages two operations that a multi-runway aerodrome may
 *     segregate onto different runways, and then describes neither, so it is
 *     only a fallback for aerodromes that have no rows at all for one
 *     direction.
 *   - `movements` / `n_years` travel with the answer, so a default resting on
 *     a handful of movements can be shown as the thin evidence it is.
 */

/** Which half of the operation a default is wanted for. */
export type RunwayDirection = "DEP" | "ARR";

export interface RunwayDefault {
  /** Runway in the pickers' ARINC form, e.g. "RW21L". */
  ident: string;
  /** Designator as published, e.g. "21L". */
  runway: string;
  /** Share of that airport/month/direction's movements (0–100). */
  pct: number;
  /** Movements behind the figure, and how many years they came from — read
   *  these before trusting `pct` (under ~100 movements is arithmetic, not
   *  evidence). */
  movements: number;
  nYears: number;
  /** Bucket the answer came from: the asked-for direction, or "ALL" when that
   *  direction has no rows for this airport/month. */
  source: RunwayDirection | "ALL";
}

/** `${AIRPORT}|${month}|${DIR}` → that group's rnk-1 runway. */
type DefaultIndex = Map<string, RunwayDefault>;

const key = (airport: string, month: number, dir: string) =>
  `${airport}|${month}|${dir}`;

let _index: Promise<DefaultIndex> | null = null;

/** Parse the CSV. Plain comma-separated, no quoted fields (every column is a
 *  code, a number or an ISO date), so a split is enough. */
function parse(text: string): DefaultIndex {
  const lines = text.trim().split(/\r?\n/);
  const cols = lines[0].split(",").map((c) => c.trim());
  const at = (row: string[], name: string) => row[cols.indexOf(name)] ?? "";
  const out: DefaultIndex = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = lines[i].split(",");
    // Only the rnk-1 row of each group is a "default"; the rest are the
    // runner-up runways, which nothing here needs.
    if (at(row, "is_default").trim().toLowerCase() !== "t") continue;
    const airport = at(row, "airport").trim().toUpperCase();
    const month = Number(at(row, "month_of_year"));
    const dir = at(row, "direction").trim().toUpperCase();
    const runway = at(row, "runway").trim().toUpperCase();
    if (!airport || !runway || !Number.isFinite(month)) continue;
    out.set(key(airport, month, dir), {
      ident: `RW${runway}`,
      runway,
      pct: Number(at(row, "pct")) || 0,
      movements: Number(at(row, "movements")) || 0,
      nYears: Number(at(row, "n_years")) || 0,
      source: dir === "DEP" || dir === "ARR" ? dir : "ALL",
    });
  }
  return out;
}

/** Load + memoise the whole table (fetched once per session; empty when the
 *  file is absent, which is the normal state for this deployment). */
function loadIndex(): Promise<DefaultIndex> {
  if (!_index) {
    _index = fetch("/data/airports/runway_default.csv")
      .then((r) => {
        // 404 is this file's normal state: parse("") is an empty table, and
        // memoising it keeps every lookup a quiet null, not a fetch per call.
        if (r.status === 404) return "";
        if (!r.ok) throw new Error(`runway_default.csv: HTTP ${r.status}`);
        return r.text();
      })
      .then(parse)
      .catch(() => {
        _index = null; // let a later call retry the fetch
        return new Map<string, RunwayDefault>();
      });
  }
  return _index;
}

/**
 * The runway an aerodrome normally uses in `month` (1–12) for `dir`.
 * Returns null when the table has nothing for that airport/month.
 */
export async function runwayDefault(
  airport: string,
  month: number,
  dir: RunwayDirection,
): Promise<RunwayDefault | null> {
  const code = airport.trim().toUpperCase();
  if (!code || !Number.isFinite(month) || month < 1 || month > 12) return null;
  const idx = await loadIndex();
  return idx.get(key(code, month, dir)) ?? idx.get(key(code, month, "ALL")) ?? null;
}

/** Month of year (1–12) of an EOBT as typed in the panel — a datetime-local
 *  string ("2026-08-08T00:16") read as UTC. 0 when it isn't a valid stamp. */
export function eobtMonth(eobt: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(eobt.trim());
  if (!m) return 0;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? month : 0;
}
