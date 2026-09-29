import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { detectConflicts } from "./detect";
import { straightFuture } from "./future";
import type { CdrAircraft, FutureSample } from "./types";

const cfg = resolveConfig();
const W = cfg.lookahead.mtcdSec;
const STEP = cfg.lookahead.stepSec;

/** Compact aircraft factory — lat/lon in degrees, defaults level & cruising.
 *  The future defaults to a straight-line projection of the instantaneous
 *  vector (so the classic geometric cases behave as expected); pass `future`
 *  explicitly to model a curved/real path. */
function ac(
  over: Partial<CdrAircraft> & { id: string },
): CdrAircraft {
  const base = {
    callsign: over.id,
    type: "B738",
    lat: 13,
    lon: 100,
    altFt: 35000,
    gsKt: 450,
    trackDeg: 90,
    vsFpm: 0,
    ...over,
  };
  return { ...base, future: over.future ?? straightFuture(base, W, STEP) };
}

/** A straight future along a GIVEN track (independent of the instantaneous
 *  trackDeg), for modelling an aircraft whose real path differs from where its
 *  nose points right now. */
function futureAlong(
  lat: number,
  lon: number,
  trackDeg: number,
  gsKt = 450,
): FutureSample[] {
  return straightFuture(
    { lat, lon, altFt: 35000, gsKt, trackDeg, vsFpm: 0 },
    W,
    STEP,
  );
}

/** 1 NM ≈ 1/60°; place B a given NM east of A at the same latitude. */
const degEastPerNm = (lat: number) => 1 / (60 * Math.cos((lat * Math.PI) / 180));

describe("detectConflicts", () => {
  it("head-on co-altitude pair → a conflict", () => {
    const lat = 13;
    const b = 100 + 20 * degEastPerNm(lat); // 20 NM east
    const conflicts = detectConflicts(
      [
        ac({ id: "A", lat, lon: 100, trackDeg: 90 }),
        ac({ id: "B", lat, lon: b, trackDeg: 270 }),
      ],
      cfg,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe("A|B");
    expect(conflicts[0].dCpa).toBeLessThan(1);
    // 20 NM at 900 kt closing ≈ 75 s to LoS ⇒ within the 5-min resolution
    // tier (STCA): 75 s < 300 s.
    expect(conflicts[0].severity).toBe("STCA");
  });

  it("head-on but 2000 ft apart and level → NOT a conflict (well stacked)", () => {
    const lat = 13;
    const b = 100 + 20 * degEastPerNm(lat);
    const conflicts = detectConflicts(
      [
        ac({ id: "A", lat, lon: 100, trackDeg: 90, altFt: 35000 }),
        ac({ id: "B", lat, lon: b, trackDeg: 270, altFt: 37000 }),
      ],
      cfg,
    );
    expect(conflicts).toHaveLength(0);
  });

  it("well-separated parallel traffic → NOT a conflict (coarse filter rejects)", () => {
    const conflicts = detectConflicts(
      [
        ac({ id: "A", lat: 13, lon: 100, trackDeg: 90 }),
        ac({ id: "B", lat: 15, lon: 100, trackDeg: 90 }), // 120 NM north
      ],
      cfg,
    );
    expect(conflicts).toHaveLength(0);
  });

  it("current loss of separation → LOS severity", () => {
    const lat = 13;
    const b = 100 + 2 * degEastPerNm(lat); // 2 NM apart, co-altitude, closing
    const conflicts = detectConflicts(
      [
        ac({ id: "A", lat, lon: 100, trackDeg: 90 }),
        ac({ id: "B", lat, lon: b, trackDeg: 270 }),
      ],
      cfg,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("LOS");
    expect(conflicts[0].tToLosSec).not.toBeNull();
    expect(conflicts[0].tToLosSec!).toBeLessThanOrEqual(0);
  });

  it("distant converging pair → MTCD (predicted beyond the 5-min resolution tier, within 10)", () => {
    const lat = 13;
    // ~100 NM apart head-on at 900 kt closing ⇒ buffered breach ~376 s: past
    // the 5-min resolution tier (STCA), within the 10-min prediction window.
    const b = 100 + 100 * degEastPerNm(lat);
    const conflicts = detectConflicts(
      [
        ac({ id: "A", lat, lon: 100, trackDeg: 90 }),
        ac({ id: "B", lat, lon: b, trackDeg: 270 }),
      ],
      cfg,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("MTCD");
  });

  it("stable id regardless of input order", () => {
    const lat = 13;
    const b = 100 + 20 * degEastPerNm(lat);
    const A = ac({ id: "UBA1", lat, lon: 100, trackDeg: 90 });
    const B = ac({ id: "KMV2", lat, lon: b, trackDeg: 270 });
    const c1 = detectConflicts([A, B], cfg)[0];
    const c2 = detectConflicts([B, A], cfg)[0];
    expect(c1.id).toBe(c2.id);
    expect(c1.id).toBe("KMV2|UBA1"); // sorted
  });

  it("uses the REAL future path: head-on nose vectors that actually diverge are NOT flagged", () => {
    // Both aircraft POINT at each other right now (a straight-line predictor
    // would scream head-on), but their real futures turn apart — A flies north,
    // B flies south from 20 NM abeam. No loss of separation ever occurs.
    const lat = 13;
    const lonB = 100 + 20 * degEastPerNm(lat);
    const a = ac({
      id: "A",
      lat,
      lon: 100,
      trackDeg: 90, // nose east…
      future: futureAlong(lat, 100, 0), // …but path goes north
    });
    const b = ac({
      id: "B",
      lat,
      lon: lonB,
      trackDeg: 270, // nose west…
      future: futureAlong(lat, lonB, 180), // …but path goes south
    });
    expect(detectConflicts([a, b], cfg)).toHaveLength(0);

    // Sanity: the SAME instantaneous geometry with straight-ahead futures IS a
    // conflict — proving it's the real path, not the geometry, that clears it.
    const aStraight = ac({ id: "A", lat, lon: 100, trackDeg: 90 });
    const bStraight = ac({ id: "B", lat, lon: lonB, trackDeg: 270 });
    expect(detectConflicts([aStraight, bStraight], cfg).length).toBeGreaterThan(0);
  });

  it("position-dependent minimum: 4.5 NM co-altitude pair conflicts at the 5 NM en-route minimum but clears at the 3 NM TMA minimum", () => {
    const lat = 13;
    // Same track, 4.5 NM abeam ⇒ separation stays a constant 4.5 NM.
    const b = 100 + 4.5 * degEastPerNm(lat);
    const pair = (): CdrAircraft[] => [
      ac({ id: "A", lat, lon: 100, trackDeg: 90 }),
      ac({ id: "B", lat, lon: b, trackDeg: 90 }),
    ];
    // Flat 5 NM en-route default: 4.5 < 5 ⇒ loss of separation.
    expect(detectConflicts(pair(), cfg)).toHaveLength(1);
    // Resolver returning the 3 NM TMA minimum everywhere: 4.5 > 3 ⇒ clear.
    const tmaCfg = resolveConfig({ sepMinNmAt: () => 3 });
    expect(detectConflicts(pair(), tmaCfg)).toHaveLength(0);
  });

  it("position-dependent minimum applies the tighter 3 NM when EITHER aircraft is in the TMA", () => {
    const lat = 13;
    const b = 100 + 4.5 * degEastPerNm(lat);
    // 3 NM west of 100° lon (A's side, the 'TMA'); 5 NM elsewhere.
    const cfg3IfWest = resolveConfig({
      sepMinNmAt: (_lat, lon) => (lon <= 100 ? 3 : 5),
    });
    const conflicts = detectConflicts(
      [
        ac({ id: "A", lat, lon: 100, trackDeg: 90 }), // in 'TMA' ⇒ 3 NM
        ac({ id: "B", lat, lon: b, trackDeg: 90 }), // en-route ⇒ 5 NM
      ],
      cfg3IfWest,
    );
    // min(3, 5) = 3 governs the pair, and 4.5 > 3 ⇒ clear.
    expect(conflicts).toHaveLength(0);
  });

  it("vertically converging co-located pair → conflict as they level off together", () => {
    const lat = 13;
    const b = 100 + 6 * degEastPerNm(lat); // 6 NM apart horizontally, closing
    const conflicts = detectConflicts(
      [
        ac({ id: "A", lat, lon: 100, trackDeg: 90, altFt: 34000, vsFpm: 1500 }),
        ac({ id: "B", lat, lon: b, trackDeg: 270, altFt: 36000, vsFpm: -1500 }),
      ],
      cfg,
    );
    expect(conflicts).toHaveLength(1);
  });
});
