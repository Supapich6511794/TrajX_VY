/**
 * Whose conflict is it? — the ATS unit responsible for resolving a pair.
 *
 * A conflict is not just a geometry; somebody has to work it. Annex 11 §3.5 and
 * Doc 4444 §2 put separation on the unit providing control in the airspace
 * concerned, and §10 makes the boundary between two units a coordination
 * problem rather than a free choice. So the panel has to say WHICH sector owns
 * the instruction, or the controller is being shown a fix without being told
 * whether it is theirs to give.
 *
 * Two facts, and they are not the same:
 *
 *   * **Where the loss would happen.** Resolved at the CPA, between the two
 *     aircraft, at their level. This is the unit responsible for preventing it
 *     — the one whose airspace the aircraft would lose separation in, even if
 *     neither is inside it yet.
 *   * **Who is working each aircraft now.** Resolved at the current clock, per
 *     aircraft. This is who can actually transmit the instruction. When the two
 *     differ, the fix crosses a boundary and has to be coordinated.
 *
 * The airspace hierarchy itself (PDR > CTR > TMA > CTA > FIR) is
 * `lib/airspace.ts`; this module only asks it the right questions — with one
 * deliberate difference. That hierarchy puts a Prohibited/Danger/Restricted
 * area on top, because for a MAP LABEL "you are inside R13" is the fact that
 * matters. A PDR is not an ATS unit, though: nobody works it and nobody can be
 * asked to resolve a conflict in it. So the unit is resolved with the PDR layer
 * removed, and the areas are reported separately — the conflict still belongs
 * to whatever CTR/TMA/CTA/FIR contains it.
 *
 * Pure — the resolver is injected, so nothing here loads or knows about GeoJSON.
 */

import { controllingLayer, formatAirspace, type AirspaceMembership } from "@/lib/airspace";
import type { SectorKey } from "@/lib/geojson";

/** Where an aircraft is, at some instant. */
export interface SectorPoint {
  lat: number;
  lon: number;
  altFt: number | null;
}

/**
 * Resolves a position to the airspace that contains it.
 *
 * `atMs` is passed because WHO owns a piece of airspace is not fixed: an
 * applied dynamic-sectorisation plan band-boxes sectors and moves boundaries
 * for an hour at a time, so the same point has different owners at different
 * times. Resolvers that only read the published map ignore it.
 */
export type AirspaceResolver = (
  lat: number,
  lon: number,
  altFt: number | null,
  atMs?: number,
) => AirspaceMembership;

/** The ATS unit picture for one conflict. */
export interface ConflictSector {
  /** The unit that owns the conflict — where the CPA falls. "" when it is
   *  outside every known volume (the data covers the Yangon FIR only). */
  label: string;
  /** Which layer of the hierarchy that is, so the UI can say "CTA" vs
   *  "TMA" vs "CTR" rather than guessing from the string. */
  layer: SectorKey | null;
  /** Who is working each aircraft right now, by flight id. Empty string for an
   *  aircraft outside known airspace, absent for one with no position. */
  byFlight: Record<string, string>;
  /** The two aircraft are with DIFFERENT units, so whoever resolves it has to
   *  coordinate with the other (Doc 4444 §10.1). */
  coordination: boolean;
  /** Prohibited/Danger/Restricted areas the conflict sits inside, if any. Not
   *  a unit — a constraint on what may be issued there. */
  restricted: string[];
}

/** What a unit is called in a sentence — "Mingaladon TMA", "Yangon FIR".
 *  Every VY layer's label already carries the volume's own name. */
export function unitName(label: string, layer: SectorKey | null): string {
  if (!label) return "outside known airspace";
  void layer;
  return label;
}

/**
 * Resolve the responsible unit for one conflict.
 *
 * @param aAt   Position of aircraft A at the CPA, or null if unknown.
 * @param bAt   Position of aircraft B at the CPA.
 * @param nowA  Where A is at the current clock — who is working it now.
 * @param nowB  Where B is now.
 * @param ids   The two flight ids, for keying `byFlight`.
 * @param resolve Airspace lookup.
 */
export function conflictSector(
  ids: { a: string; b: string },
  cpa: { a: SectorPoint | null; b: SectorPoint | null; atMs?: number },
  now: { a: SectorPoint | null; b: SectorPoint | null; atMs?: number },
  resolve: AirspaceResolver,
): ConflictSector {
  // Each group carries its own instant: the CPA points are resolved at the CPA
  // and the live ones at the clock. With a dynamic plan in force those can fall
  // in different hours and be worked by different positions, which is exactly
  // the case `coordination` below has to get right.
  const at = (
    p: SectorPoint | null,
    atMs?: number,
  ): AirspaceMembership | undefined =>
    p ? resolve(p.lat, p.lon, p.altFt, atMs) : undefined;
  // The ATS unit only — a danger area is not somebody who can be called.
  const unitOf = (m: AirspaceMembership | undefined): AirspaceMembership | undefined =>
    m && { ...m, pdr: undefined };
  const name = (p: SectorPoint | null, atMs?: number): string =>
    formatAirspace(unitOf(at(p, atMs)), "compact");

  // The conflict's own position: BETWEEN the two aircraft at the CPA, at the
  // mean of their levels. Taking either aircraft on its own would hand the
  // conflict to whichever happened to be picked when they straddle a boundary;
  // the midpoint is the loss of separation itself.
  let mid: SectorPoint | null = null;
  if (cpa.a && cpa.b) {
    mid = {
      lat: (cpa.a.lat + cpa.b.lat) / 2,
      lon: (cpa.a.lon + cpa.b.lon) / 2,
      altFt:
        cpa.a.altFt == null || cpa.b.altFt == null
          ? (cpa.a.altFt ?? cpa.b.altFt)
          : (cpa.a.altFt + cpa.b.altFt) / 2,
    };
  } else {
    mid = cpa.a ?? cpa.b;
  }
  const full = at(mid, cpa.atMs);
  const m = unitOf(full);

  const byFlight: Record<string, string> = {};
  if (now.a) byFlight[ids.a] = name(now.a, now.atMs);
  if (now.b) byFlight[ids.b] = name(now.b, now.atMs);

  // Only a real disagreement counts. Two aircraft neither of which is inside a
  // known volume are not "in different sectors" — they are both off the map,
  // and calling that a coordination problem would cry wolf on every pair that
  // strays outside the Yangon FIR data.
  const ua = byFlight[ids.a];
  const ub = byFlight[ids.b];
  const coordination = !!ua && !!ub && ua !== ub;

  return {
    label: formatAirspace(m, "compact"),
    layer: controllingLayer(m),
    byFlight,
    coordination,
    restricted: full?.pdr ?? [],
  };
}
