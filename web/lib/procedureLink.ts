/**
 * STAR -> runway -> approach: the arrival end of a plan is one decision.
 *
 * The three pickers look independent, but the data is not. A STAR is coded to
 * the runway(s) it feeds, and a runway's instrument approach is frequently the
 * only one published for it — a runway often has exactly one RNP. Treated as three
 * separate choices, picking the STAR left the approach on "None" and the
 * arrival was generated without the procedure that belongs to it.
 *
 * These links are kept out of the panel so the rules can be read and tested on
 * their own — including `soleProcedure`, the same idea applied to the SID/STAR
 * pickers once their filters have run. All of them are deliberately
 * conservative: they answer only when the data leaves nothing to choose
 * between, and say nothing otherwise.
 */

/** The runway a procedure is coded for, when it serves exactly ONE.
 *
 * A procedure with several runway transitions (or none at all — a STAR with no
 * runway-specific legs serves any) is not a choice this can make: which runway
 * is in use is the controller's call, and guessing would silently pin the
 * arrival to one end of the field.
 */
export function soleRunwayOf(
  procRunways: Record<string, string[]>,
  procedure: string,
): string | null {
  if (!procedure) return null;
  const rws = procRunways[procedure];
  return rws && rws.length === 1 ? rws[0] : null;
}

/** The approach to fly at `runway`, when the aerodrome publishes exactly one.
 *
 * Two or more (RW09 has R09-Y and R09-Z) is a real decision and stays with the
 * user; none means the STAR descends to the field without one.
 */
export function soleApproachFor(
  approachByRunway: Record<string, string[]>,
  runway: string,
): string | null {
  if (!runway) return null;
  const list = approachByRunway[runway];
  return list && list.length === 1 ? list[0] : null;
}

/** The procedure to fly, when filtering has left exactly ONE to choose from.
 *
 * The SID/STAR pickers narrow twice: to the procedures coded for the selected
 * runway, then to the ones that connect to the route's terminal fix. When both
 * filters agree on a single name, the data holds no decision any more — and
 * leaving the picker on "None (direct)" then generates a plan without the
 * procedure the flight was always going to fly. Two or more is a real choice
 * and stays with the controller; none means there is nothing to offer.
 */
export function soleProcedure(shown: readonly string[]): string | null {
  return shown.length === 1 ? shown[0] : null;
}
