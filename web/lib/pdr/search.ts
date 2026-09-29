/**
 * Searching the PDR panel's flight list.
 *
 * A bank of plans runs to thousands of flights and the tabs (Clear / Check /
 * Rejected) only cut it into thirds, so finding ONE flight — "where is UBA201,
 * and did it pass?" — needs a search that works inside whichever tab is open.
 *
 * Deliberately dumb, like the report table's filter: plain substrings, no
 * syntax to learn. What it matches is what the row shows — the callsign and the
 * two aerodromes — so a query is always something the reader can see.
 */

/** The parts of a flight a search can match on. */
export interface PdrSearchable {
  callsign: string;
  adep: string;
  ades: string;
}

/**
 * A query as terms: upper-cased, split on whitespace and commas, blanks
 * dropped. `->` is read as the arrow the rows draw between the aerodromes, so
 * `VYYY->VYMD` finds the row that shows `VYYY→VYMD`.
 */
export function pdrSearchTerms(query: string): string[] {
  return query
    .toUpperCase()
    .replace(/->/g, "→")
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * Does the flight match EVERY term? A term is a substring of the callsign,
 * either aerodrome, or the pair as the row writes it (`VYYY→VYMD`, or with a
 * dash). Several terms narrow the list, in any order — `UBA VYYY` is the UBA
 * flights touching VYYY — and no terms matches everything.
 */
export function matchesPdrSearch(
  f: PdrSearchable,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const hay = (
    `${f.callsign} ${f.adep} ${f.ades} ` +
    `${f.adep}→${f.ades} ${f.adep}-${f.ades}`
  ).toUpperCase();
  return terms.every((t) => hay.includes(t));
}
