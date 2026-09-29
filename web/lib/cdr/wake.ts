/**
 * Wake turbulence categories — the aircraft-type reference data behind the
 * distance-based wake minima in `config.ts`.
 *
 * ICAO Doc 4444 §4.9.1.1 groups types by maximum certificated take-off mass:
 *
 *   HEAVY  (H)  — 136 000 kg or more
 *   MEDIUM (M)  — less than 136 000 kg but more than 7 000 kg
 *   LIGHT  (L)  — 7 000 kg or less
 *
 * plus one category the §8.7.3.4 table predates:
 *
 *   SUPER  (J)  — the A380-800. Doc 4444's table only has H/M/L, and putting
 *                 the A380 in HEAVY understates its wake; ICAO issued separate
 *                 A380 approach minima (6/7/8 NM for a HEAVY/MEDIUM/LIGHT
 *                 follower). This tool models that as its own category. Set
 *                 `SUPER_TYPES` to an empty set to fall back to the plain
 *                 three-category Doc 4444 table.
 *
 * The table below covers every type in the Thai APM performance dataset
 * (`trajectory_sim/data/thaiapm_performance.csv`, 66 types) plus the common
 * types seen in regional traffic, since neither the APM data nor the
 * AIP carries a mass or a wake category.
 */

/** Wake turbulence category (Doc 4444 §4.9.1.1, plus SUPER — see file docs). */
export type WakeCategory = "SUPER" | "HEAVY" | "MEDIUM" | "LIGHT";

/** Types ICAO gives dedicated A380 approach minima for. */
const SUPER_TYPES = new Set(["A388"]);

/** ICAO type designator -> category. Assigned from maximum certificated
 *  take-off mass per §4.9.1.1; the boundary cases are commented. */
const CATEGORY_BY_TYPE: Record<string, WakeCategory> = {
  // --- HEAVY: MTOW ≥ 136 t -------------------------------------------------
  A332: "HEAVY", A333: "HEAVY", A338: "HEAVY", A339: "HEAVY",
  A343: "HEAVY", A346: "HEAVY", A359: "HEAVY", A35K: "HEAVY",
  A30B: "HEAVY", A306: "HEAVY", A310: "HEAVY",
  B744: "HEAVY", B748: "HEAVY", B741: "HEAVY", B742: "HEAVY", B743: "HEAVY",
  B762: "HEAVY", B763: "HEAVY", B764: "HEAVY",
  B772: "HEAVY", B773: "HEAVY", B77L: "HEAVY", B77W: "HEAVY",
  B788: "HEAVY", B789: "HEAVY", B78X: "HEAVY",
  MD11: "HEAVY", C17: "HEAVY", IL76: "HEAVY", A124: "HEAVY",

  // --- MEDIUM: 7 t < MTOW < 136 t -----------------------------------------
  A19N: "MEDIUM", A20N: "MEDIUM", A21N: "MEDIUM",
  A318: "MEDIUM", A319: "MEDIUM", A320: "MEDIUM", A321: "MEDIUM",
  B733: "MEDIUM", B734: "MEDIUM", B735: "MEDIUM", B736: "MEDIUM",
  B737: "MEDIUM", B738: "MEDIUM", B739: "MEDIUM",
  B37M: "MEDIUM", B38M: "MEDIUM", B39M: "MEDIUM",
  // The 757 is ~116 t, so ICAO's mass rule makes it MEDIUM even though several
  // States give it its own (heavier) treatment for its unusually strong wake.
  B752: "MEDIUM", B753: "MEDIUM",
  AJ27: "MEDIUM", C909: "MEDIUM", SU95: "MEDIUM",
  AT43: "MEDIUM", AT45: "MEDIUM", AT72: "MEDIUM", AT75: "MEDIUM", AT76: "MEDIUM",
  DH8A: "MEDIUM", DH8C: "MEDIUM", DH8D: "MEDIUM",
  E135: "MEDIUM", E145: "MEDIUM", E170: "MEDIUM", E175: "MEDIUM",
  E190: "MEDIUM", E195: "MEDIUM", E290: "MEDIUM", E35L: "MEDIUM",
  CRJ2: "MEDIUM", CRJ9: "MEDIUM", SF34: "MEDIUM",
  C130: "MEDIUM", C295: "MEDIUM", CN35: "MEDIUM",
  // Business jets — all comfortably over the 7 t LIGHT ceiling.
  C750: "MEDIUM", CL30: "MEDIUM", CL35: "MEDIUM", CL60: "MEDIUM",
  F2TH: "MEDIUM", FA7X: "MEDIUM", FA50: "MEDIUM",
  GALX: "MEDIUM", GL5T: "MEDIUM", GL7T: "MEDIUM", GLEX: "MEDIUM",
  GLF4: "MEDIUM", GLF5: "MEDIUM", GLF6: "MEDIUM",
  H25B: "MEDIUM", LJ60: "MEDIUM",

  // --- LIGHT: MTOW ≤ 7 t ---------------------------------------------------
  // B350 (King Air 350) is 6 804 kg — just under the 7 t ceiling.
  B350: "LIGHT", BE20: "LIGHT", BE9L: "LIGHT",
  C510: "LIGHT", C525: "LIGHT", C172: "LIGHT", C208: "LIGHT",
  HDJT: "LIGHT", TEX2: "LIGHT", PC12: "LIGHT", DA42: "LIGHT",
};

/**
 * Wake category for an ICAO type designator. Unknown types fall back to
 * `fallback` (MEDIUM by default): most unknown designators in a regional
 * FIR sample are regional jets or turboprops, and MEDIUM is the middle of the
 * three, so it neither systematically over- nor under-separates. Callers that
 * want to be conservative can pass "HEAVY".
 */
export function wakeCategoryOf(
  aircraftType: string | null | undefined,
  fallback: WakeCategory = "MEDIUM",
): WakeCategory {
  const t = (aircraftType ?? "").trim().toUpperCase();
  if (!t) return fallback;
  if (SUPER_TYPES.has(t)) return "SUPER";
  return CATEGORY_BY_TYPE[t] ?? fallback;
}

/** True when the type is known to the table (so the UI can flag an assumed
 *  category rather than silently separating on a guess). */
export function isKnownWakeType(aircraftType: string | null | undefined): boolean {
  const t = (aircraftType ?? "").trim().toUpperCase();
  return !!t && (SUPER_TYPES.has(t) || t in CATEGORY_BY_TYPE);
}
