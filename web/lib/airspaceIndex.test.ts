import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  airspaceAt,
  buildAirspaceIndex,
  pointInMultiPolygon,
  type AirspaceIndex,
} from "@/lib/airspace";
import type { SectorCollection, SectorKey } from "@/lib/geojson";

/**
 * The edge-bucketed ring index must give the SAME answer as the plain ray cast
 * — it is only allowed to skip edges that could never have changed the result.
 * Checked against the real published Yangon FIR airspace (AIP Myanmar AIXM
 * export — the FIR boundary and the larger CTRs run to a few hundred
 * vertices), at random points and at the awkward ones: a latitude exactly on a
 * vertex, where the straddle test is decided by `>` versus `<=`.
 */

const DIR = path.resolve(__dirname, "../public/data/aixm_vy");

function readCollection(file: string): SectorCollection {
  return JSON.parse(
    fs.readFileSync(path.join(DIR, file), "utf8"),
  ) as SectorCollection;
}

/** The layers exactly as `fetchSector` builds them: the boundary file split by
 *  its `type`, the restricted-areas file as the PDR layer. */
function loadIndex(): AirspaceIndex {
  const boundaries = readCollection("airspace_boundaries.geojson");
  const ofType = (type: string): SectorCollection => ({
    ...boundaries,
    features: boundaries.features.filter(
      (f) => String((f.properties as Record<string, unknown> | null)?.type) === type,
    ),
  });
  return buildAirspaceIndex({
    ctr: ofType("CTR"),
    tma: ofType("TMA"),
    cta: ofType("CTA"),
    fir: ofType("FIR"),
    pdr: readCollection("restricted_areas.geojson"),
  });
}

/** The same index with the acceleration stripped — the reference. */
function plain(index: AirspaceIndex): AirspaceIndex {
  const out: AirspaceIndex = {};
  for (const [k, entries] of Object.entries(index) as [SectorKey, NonNullable<AirspaceIndex[SectorKey]>][]) {
    out[k] = entries.map((e) => ({ ...e, acc: undefined }));
  }
  return out;
}

/** A small deterministic generator, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("airspace ring index", () => {
  const index = loadIndex();
  const reference = plain(index);

  it("loaded every published layer", () => {
    expect(index.ctr?.length).toBe(37);
    expect(index.tma?.map((e) => e.label).sort()).toEqual([
      "MANDALAY TMA",
      "MINGALADON TMA",
      "NAYPYITAW TMA",
    ]);
    expect(index.cta?.map((e) => e.label)).toEqual(["YANGON CTA"]);
    expect(index.fir?.map((e) => e.label)).toEqual(["YANGON FIR"]);
    expect(index.pdr?.length).toBeGreaterThan(0);
  });

  it("actually indexed the big rings", () => {
    const accelerated = Object.values(index)
      .flat()
      .filter((e) => e!.acc?.some((poly) => poly.some(Boolean)));
    expect(accelerated.length).toBeGreaterThan(0);
  });

  it("answers exactly like the plain ray cast at random points", () => {
    const next = rng(20251223);
    let disagreements = 0;
    let inside = 0;
    let controlled = 0;
    for (let n = 0; n < 6000; n++) {
      // A box around Myanmar, a little wider than the FIR (92-101.2E,
      // 10-28.5N) so the outside is sampled too.
      const lon = 91 + next() * 11;
      const lat = 9 + next() * 20;
      const alt = next() < 0.2 ? null : next() * 45000;
      const a = airspaceAt(index, lon, lat, alt);
      const b = airspaceAt(reference, lon, lat, alt);
      if (JSON.stringify(a) !== JSON.stringify(b)) disagreements++;
      if (a.fir) inside++;
      if (a.ctr || a.tma || a.cta || a.pdr) controlled++;
    }
    expect(disagreements).toBe(0);
    // A vacuous pass — every point outside everything — would prove nothing.
    // The FIR (GND-UNL) holds a good share of the box; the smaller volumes
    // (CTRs, TMAs, the CTA above FL170, the PDRs) must be hit too.
    expect(inside).toBeGreaterThan(1500);
    expect(inside).toBeLessThan(6000);
    expect(controlled).toBeGreaterThan(100);
  });

  it("places known points in the right volumes", () => {
    // Yangon (Mingaladon) at FL150 — inside the Mingaladon TMA (FL130-170).
    expect(airspaceAt(index, 96.13, 16.91, 15000).tma).toBe("MINGALADON TMA");
    // North of Yangon at FL300 — the Yangon CTA (FL170-560), and the FIR.
    const cruise = airspaceAt(index, 96.2, 17.5, 30000);
    expect(cruise.cta).toBe("YANGON CTA");
    expect(cruise.fir).toBe("YANGON FIR");
    // The Bay of Bengal far west of the FIR — nothing at all.
    expect(airspaceAt(index, 85.0, 15.0, 30000)).toEqual({});
  });

  it("agrees for every feature, at latitudes exactly on a vertex", () => {
    const next = rng(7);
    let checked = 0;
    for (const entries of Object.values(index)) {
      for (const e of entries!) {
        const ring = e.mp[0][0];
        for (let n = 0; n < 40; n++) {
          const v = ring[Math.floor(next() * ring.length)];
          // On the vertex's latitude, at longitudes across the feature's width.
          const lon = e.bbox[0] + next() * (e.bbox[2] - e.bbox[0]);
          const lat = v[1];
          const viaIndex = airspaceAt({ tma: [e] }, lon, lat, null);
          const viaPlain = pointInMultiPolygon(lon, lat, e.mp);
          expect(!!viaIndex.tma).toBe(viaPlain);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
