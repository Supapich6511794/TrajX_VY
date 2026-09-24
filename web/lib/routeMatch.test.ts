import { describe, expect, it } from "vitest";

import { matchAtsRoute } from "@/lib/routeMatch";
import type { RouteSegment } from "@/lib/pdr/airwayDirection";

function seg(
  route: string,
  from: string,
  to: string,
  extra: Partial<RouteSegment> = {},
): RouteSegment {
  return {
    route,
    from,
    to,
    direction: "BOTH",
    lowerFt: null,
    upperFt: null,
    lengthNm: null,
    ...extra,
  };
}

describe("matchAtsRoute", () => {
  it("collapses a multi-hop chain on ONE route into a single span, dropping the intermediate fix", () => {
    // APAGO -> MDY -> AKSAG are all filed crossing fixes, but the published
    // network actually runs APAGO -> X -> MDY -> AKSAG, all on Y8 — MDY isn't
    // a segment endpoint of its own. The whole thing should read as one Y8
    // span, exactly like the user's example.
    const segments = [
      seg("Y8", "APAGO", "X"),
      seg("Y8", "X", "MDY"),
      seg("Y8", "MDY", "AKSAG"),
    ];
    expect(matchAtsRoute(["APAGO", "MDY", "AKSAG"], segments)).toBe(
      "APAGO Y8 AKSAG",
    );
  });

  it("finds a path through an intermediate fix not in the filed chain at all", () => {
    // AKSAG and MDY are only connected via an intermediate point Y8 doesn't
    // name in the filed wp list (a real ENR 3 shape: not every named point on
    // a route is one a track summary happens to record).
    const segments = [seg("Y8", "AKSAG", "X"), seg("Y8", "X", "MDY")];
    expect(matchAtsRoute(["AKSAG", "MDY"], segments)).toBe("AKSAG Y8 MDY");
  });

  it("splits into separate spans when the path changes route partway", () => {
    const segments = [
      seg("Y8", "APAGO", "X"),
      seg("Y8", "X", "Y"),
      seg("L507", "Y", "Z"),
      seg("L507", "Z", "AKSAG"),
    ];
    expect(matchAtsRoute(["APAGO", "AKSAG"], segments)).toBe(
      "APAGO Y8 Y L507 AKSAG",
    );
  });

  it("falls back to DCT for a hop the network does not connect at all", () => {
    const segments = [seg("Y8", "APAGO", "MDY")];
    expect(matchAtsRoute(["APAGO", "MDY", "NOWHERE"], segments)).toBe(
      "APAGO Y8 MDY DCT NOWHERE",
    );
  });

  it("respects a one-way segment's published direction", () => {
    // MDY -> AKSAG is FORWARD only: flyable MDY->AKSAG, not AKSAG->MDY.
    const segments = [seg("Y8", "MDY", "AKSAG", { direction: "FORWARD" })];
    expect(matchAtsRoute(["MDY", "AKSAG"], segments)).toBe("MDY Y8 AKSAG");
    // The reverse direction has no legal path, so it stays DCT rather than
    // silently using the segment against its published direction.
    expect(matchAtsRoute(["AKSAG", "MDY"], segments)).toBe("AKSAG DCT MDY");
  });

  it("does not resolve a single waypoint in isolation — a fix on two routes needs its PAIR to disambiguate", () => {
    // MDY sits on both Y8 (toward AKSAG) and L507 (toward BOMAS). Matching
    // MDY alone would be ambiguous; matching the ordered pair is not.
    const segments = [
      seg("Y8", "APAGO", "MDY"),
      seg("Y8", "MDY", "AKSAG"),
      seg("L507", "MDY", "BOMAS"),
    ];
    expect(matchAtsRoute(["APAGO", "MDY", "AKSAG"], segments)).toBe(
      "APAGO Y8 AKSAG",
    );
    expect(matchAtsRoute(["APAGO", "MDY", "BOMAS"], segments)).toBe(
      "APAGO Y8 MDY L507 BOMAS",
    );
  });

  it("returns a single fix unchanged and an empty chain as an empty string", () => {
    expect(matchAtsRoute(["APAGO"], [])).toBe("APAGO");
    expect(matchAtsRoute([], [])).toBe("");
  });
});
