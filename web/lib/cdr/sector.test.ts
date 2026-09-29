/** Which ATS unit is responsible for resolving a conflict. */
import { describe, expect, it } from "vitest";

import { formatAirspace, type AirspaceMembership } from "@/lib/airspace";
import { conflictSector, unitName, type SectorPoint } from "./sector";

/** A resolver with a made-up geography, so the test is about the RULE and not
 *  about whether a particular Yangon FIR polygon happens to be where I think:
 *    lat < 13    -> MINGALADON TMA (below 12000 ft) else YANGON CTA
 *    13 <= lat   -> YANGON FIR
 *    lat > 20    -> outside all airspace
 */
const resolve = (lat: number, _lon: number, altFt: number | null): AirspaceMembership => {
  if (lat > 20) return {};
  if (lat < 13) {
    return altFt != null && altFt < 12000 ? { tma: "MINGALADON TMA" } : { cta: "YANGON CTA" };
  }
  return { fir: "YANGON FIR" };
};

const at = (lat: number, altFt: number | null = 30000): SectorPoint => ({
  lat,
  lon: 100,
  altFt,
});

const IDS = { a: "F1", b: "F2" };

describe("conflictSector", () => {
  it("names the unit the LOSS would happen in, not the one they started in", () => {
    // Both aircraft are still in the FIR now, but they close on each other south of
    // the boundary — the CTA has to prevent it.
    const s = conflictSector(
      IDS,
      { a: at(12.4), b: at(12.6) },
      { a: at(14), b: at(15) },
      resolve,
    );
    expect(s.label).toBe("Yangon CTA");
    expect(s.layer).toBe("cta");
  });

  it("resolves BETWEEN the pair, so a boundary does not decide it by luck", () => {
    // One each side: taking either aircraft alone would give a different answer
    // depending on which was picked. The midpoint is the conflict itself.
    const straddle = conflictSector(
      IDS,
      { a: at(12.9), b: at(13.1) },
      { a: at(12.9), b: at(13.1) },
      resolve,
    );
    const flipped = conflictSector(
      { a: "F2", b: "F1" },
      { a: at(13.1), b: at(12.9) },
      { a: at(13.1), b: at(12.9) },
      resolve,
    );
    expect(straddle.label).toBe(flipped.label);
  });

  it("uses the pair's mean LEVEL — the hierarchy is altitude-aware", () => {
    // Same place, different levels: inside the TMA's band it is Approach's,
    // above the ceiling it is the control area's.
    const low = conflictSector(
      IDS,
      { a: at(12, 8000), b: at(12, 8000) },
      { a: at(12, 8000), b: at(12, 8000) },
      resolve,
    );
    const high = conflictSector(
      IDS,
      { a: at(12, 30000), b: at(12, 30000) },
      { a: at(12, 30000), b: at(12, 30000) },
      resolve,
    );
    expect(low.label).toBe("Mingaladon TMA");
    expect(low.layer).toBe("tma");
    expect(high.label).toBe("Yangon CTA");
  });

  it("flags a fix that crosses a boundary as needing coordination", () => {
    const s = conflictSector(
      IDS,
      { a: at(13.5), b: at(13.5) },
      { a: at(12.5), b: at(14) }, // one in the CTA, one in the FIR
      resolve,
    );
    expect(s.byFlight).toEqual({ F1: "Yangon CTA", F2: "Yangon FIR" });
    expect(s.coordination).toBe(true);
  });

  it("does not flag coordination when both are with the same unit", () => {
    const s = conflictSector(
      IDS,
      { a: at(14), b: at(14) },
      { a: at(14), b: at(14.2) },
      resolve,
    );
    expect(s.coordination).toBe(false);
    expect(s.byFlight.F1).toBe("Yangon FIR");
  });

  it("does not cry coordination over two aircraft that are simply off the map", () => {
    // The data covers the Yangon FIR; outside it there is no unit to name, and
    // "different units" would be a fabrication.
    const s = conflictSector(
      IDS,
      { a: at(25), b: at(25) },
      { a: at(25), b: at(26) },
      resolve,
    );
    expect(s.label).toBe("");
    expect(s.layer).toBeNull();
    expect(s.coordination).toBe(false);
  });

  it("still answers when only one aircraft has a known position", () => {
    const s = conflictSector(IDS, { a: at(12.5), b: null }, { a: at(12.5), b: null }, resolve);
    expect(s.label).toBe("Yangon CTA");
    expect(s.byFlight).toEqual({ F1: "Yangon CTA" });
    expect(s.coordination).toBe(false);
  });

  it("says nothing rather than guessing when the pair has no position at all", () => {
    const s = conflictSector(IDS, { a: null, b: null }, { a: null, b: null }, resolve);
    expect(s.label).toBe("");
    expect(s.byFlight).toEqual({});
  });
});

describe("a restricted area is not an ATS unit", () => {
  // The map hierarchy puts PDR on top, because "you are inside R13" is the
  // fact a pilot label needs. For "who resolves this conflict" it is the wrong
  // answer — nobody works a danger area. 16% of the samples in the conflict
  // fixture fall inside one, so this is not a corner case.
  const inDanger = (lat: number, _lon: number, _alt: number | null): AirspaceMembership =>
    lat < 13
      ? { pdr: ["R13 SHANTE"], cta: "YANGON CTA" }
      : { pdr: ["D5 TESTAREA"] };

  it("names the controlling unit, not the danger area over it", () => {
    const s = conflictSector(IDS, { a: at(12), b: at(12) }, { a: at(12), b: at(12) }, inDanger);
    expect(s.label).toBe("Yangon CTA");
    expect(s.layer).toBe("cta");
  });

  it("still reports the area — it constrains what may be issued there", () => {
    const s = conflictSector(IDS, { a: at(12), b: at(12) }, { a: at(12), b: at(12) }, inDanger);
    expect(s.restricted).toEqual(["R13 SHANTE"]);
  });

  it("says no unit when a danger area is ALL there is", () => {
    // Honest: there is genuinely no controlling volume coded here, and naming
    // the danger area as the responsible unit would be a fabrication.
    const s = conflictSector(IDS, { a: at(14), b: at(14) }, { a: at(14), b: at(14) }, inDanger);
    expect(s.label).toBe("");
    expect(s.restricted).toEqual(["D5 TESTAREA"]);
  });

  it("does not call it a boundary crossing when only the danger area differs", () => {
    const sameSector = (lat: number): AirspaceMembership =>
      lat < 12.5 ? { pdr: ["R13"], cta: "YANGON CTA" } : { cta: "YANGON CTA" };
    const s = conflictSector(
      IDS,
      { a: at(12), b: at(13) },
      { a: at(12), b: at(13) },
      (lat) => sameSector(lat),
    );
    expect(s.coordination).toBe(false);
  });
});

describe("unitName", () => {
  it("calls a named volume by its name", () => {
    expect(unitName("Mingaladon TMA", "tma")).toBe("Mingaladon TMA");
    expect(unitName("Yangon CTR", "ctr")).toBe("Yangon CTR");
    expect(unitName("Yangon CTA", "cta")).toBe("Yangon CTA");
    expect(unitName("Yangon FIR", "fir")).toBe("Yangon FIR");
  });

  it("is honest when there is no unit", () => {
    expect(unitName("", null)).toBe("outside known airspace");
  });
});

/* ---------------------------------------------------------------------------
 * Against the real Yangon FIR airspace (aixm_vy).
 *
 * The rules above are checked on a made-up geography. What they are FOR is the
 * actual AIXM boundary export, so a few real positions are run through it: if
 * the polygons or their vertical bands change such that a conflict over
 * Myanmar no longer resolves to a unit, the chip would silently disappear from
 * the UI — this fails instead.
 * ------------------------------------------------------------------------ */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { airspaceAt, buildAirspaceIndex } from "@/lib/airspace";
import type { SectorCollection, SectorKey } from "@/lib/geojson";

const AIXM_DIR = resolvePath(__dirname, "../../public/data/aixm_vy");
const BOUNDARIES = resolvePath(AIXM_DIR, "airspace_boundaries.geojson");
const RESTRICTED = resolvePath(AIXM_DIR, "restricted_areas.geojson");
const realPresent = existsSync(BOUNDARIES) && existsSync(RESTRICTED);

function realSectorData(): Partial<Record<SectorKey, SectorCollection | null>> {
  const bnd = JSON.parse(readFileSync(BOUNDARIES, "utf-8")) as SectorCollection;
  const byType = (t: string): SectorCollection => ({
    ...bnd,
    features: bnd.features.filter((f) => f.properties?.type === t),
  });
  return {
    ctr: byType("CTR"),
    tma: byType("TMA"),
    cta: byType("CTA"),
    fir: byType("FIR"),
    pdr: JSON.parse(readFileSync(RESTRICTED, "utf-8")) as SectorCollection,
  };
}
const realIndex = realPresent ? buildAirspaceIndex(realSectorData()) : {};
const realResolve = (lat: number, lon: number, altFt: number | null) =>
  airspaceAt(realIndex, lon, lat, altFt);

describe.skipIf(!realPresent)("against the real Yangon FIR airspace", () => {
  // Yangon International (VYYY), at levels that pick out different layers.
  const VYYY = { lat: 16.9073, lon: 96.1332 };

  it("names a controlling unit for an en-route conflict over Yangon", () => {
    const s = conflictSector(
      IDS,
      { a: { ...VYYY, altFt: 35000 }, b: { ...VYYY, altFt: 35000 } },
      { a: { ...VYYY, altFt: 35000 }, b: { ...VYYY, altFt: 35000 } },
      realResolve,
    );
    expect(s.label).not.toBe("");
    expect(["cta", "fir"]).toContain(s.layer);
  });

  it("hands a low-level conflict over Yangon to the terminal unit", () => {
    // Tower/Approach, not the area unit — the hierarchy is what decides, and
    // the altitude is what puts the aircraft inside it.
    const low = conflictSector(
      IDS,
      { a: { ...VYYY, altFt: 4000 }, b: { ...VYYY, altFt: 4000 } },
      { a: { ...VYYY, altFt: 4000 }, b: { ...VYYY, altFt: 4000 } },
      realResolve,
    );
    expect(["ctr", "tma"]).toContain(low.layer);
    expect(low.label).not.toBe("");
  });

  it("puts every point inside the FIR in some unit", () => {
    // Mandalay and Naypyitaw, high and low — nothing inside Myanmar is "off the map".
    for (const [lat, lon] of [
      [21.7022, 95.9779],
      [19.6235, 96.2010],
    ]) {
      for (const alt of [3000, 15000, 39000]) {
        expect(formatAirspace(realResolve(lat, lon, alt), "compact")).not.toBe("");
      }
    }
  });
});
