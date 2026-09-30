import { describe, expect, it } from "vitest";

import { autoBlocker, autoResolveFlight, autoResolvePdr } from "@/lib/pdr/autoResolve";
import type {
  PdrCategory,
  PdrReport,
  PdrSeverity,
  Remedy,
  RouteSuggestion,
} from "@/lib/pdr/detect";

function sugg(route: string, over: Partial<RouteSuggestion> = {}): RouteSuggestion {
  return {
    route,
    rnav: true,
    why: "",
    condition: null,
    activeAreas: [],
    clears: ["VYR1"],
    capabilityNote: null,
    issues: [],
    distanceNm: 300,
    score: 1,
    ...over,
  };
}

function report(
  findings: [PdrSeverity, PdrCategory, string?][],
  suggestions: RouteSuggestion[] = [],
  remedies: Remedy[] = [],
): PdrReport {
  return {
    findings: findings.map(([severity, category, title], i) => ({
      id: "f" + i,
      severity,
      category,
      title: title ?? category,
      reason: "",
      source: "",
    })),
    suggestions,
    remedies,
  } as unknown as PdrReport;
}

const flight = { flightKey: "p1::0", callsign: "UBA1", filedRoute: "A B C" };
const rejected = (s: RouteSuggestion[], r: Remedy[] = []) =>
  report([["violation", "restricted-airspace"]], s, r);

describe("autoBlocker", () => {
  it("passes a clean, like-for-like alternative", () => {
    expect(autoBlocker(sugg("A X C"), "A B C")).toBeNull();
  });

  it.each([
    ["an active area", sugg("R", { activeAreas: ["VYD5"] }), /VYD5/],
    ["a rule issue", sugg("R", { issues: ["Below the airway floor"] }), /floor/],
    [
      "an unverifiable condition",
      sugg("R", {
        condition: { state: "unknown", detail: "only when VYR3 inactive" } as never,
      }),
      /cannot be verified/,
    ],
    [
      "an unmet condition",
      sugg("R", { condition: { state: "unmet", detail: "jets only" } as never }),
      /not met/,
    ],
    ["a nav-spec change", sugg("R", { capabilityNote: "Needs RNAV 5" }), /RNAV 5/],
    ["the filed route itself", sugg("A  B C"), /same as the filed/],
  ])("blocks %s", (_label, s, why) => {
    expect(autoBlocker(s, "A B C")).toMatch(why);
  });

  it("accepts a condition that is met", () => {
    const s = sugg("R", { condition: { state: "met", detail: "ok" } as never });
    expect(autoBlocker(s, "A B C")).toBeNull();
  });
});

describe("autoResolveFlight", () => {
  it("takes the best-ranked alternative that is safe, skipping unsafe ones", () => {
    const out = autoResolveFlight(
      flight,
      rejected([sugg("BAD", { activeAreas: ["VYR2"] }), sugg("GOOD"), sugg("LATER")]),
    );
    expect(out).toMatchObject({ kind: "reroute", route: "GOOD", remaining: [] });
  });

  it("reports what a new route will not fix", () => {
    const out = autoResolveFlight(
      flight,
      report(
        [
          ["violation", "restricted-airspace"],
          ["caution", "flight-level", "RFL not semicircular"],
          ["info", "flight-level", "context only"],
        ],
        [sugg("GOOD")],
      ),
    );
    expect(out).toMatchObject({ kind: "reroute", remaining: ["RFL not semicircular"] });
  });

  it("leaves a flight with no published alternative, with the engine's action", () => {
    const out = autoResolveFlight(
      flight,
      rejected([], [
        { kind: "route", detail: "Re-route clear of VYR1." },
        { kind: "level", detail: "Raise the requested level to FL310.", toFt: 31000 },
      ]),
    );
    expect(out).toMatchObject({
      kind: "unresolved",
      reason: expect.stringMatching(/No published alternative/),
      // The non-routing remedy: re-routing is what just failed.
      action: "Raise the requested level to FL310.",
    });
  });

  it("says why the best candidate was not applied", () => {
    const out = autoResolveFlight(flight, rejected([sugg("R9", { issues: ["One-way"] })]));
    expect(out).toMatchObject({ kind: "unresolved", reason: expect.stringMatching(/R9: One-way/) });
  });
});

describe("autoResolvePdr", () => {
  it("works only the rejected flights the scan has reached", () => {
    const flights = [
      { flightKey: "rej", callsign: "REJ" },
      { flightKey: "chk", callsign: "CHK" },
      { flightKey: "ok", callsign: "OK" },
      { flightKey: "pending", callsign: "PND" },
    ];
    const scanned = new Map<string, PdrReport>([
      ["rej", rejected([])],
      ["chk", report([["caution", "route-condition"]])],
      ["ok", report([])],
    ]);
    const full = rejected([sugg("GOOD")]);
    const asked: string[] = [];
    const out = autoResolvePdr(flights, scanned, (k) => {
      asked.push(k);
      return full;
    });
    expect(out.map((o) => o.callsign)).toEqual(["REJ"]);
    expect(out[0]).toMatchObject({ kind: "reroute", route: "GOOD" });
    // Full reports (with alternatives) are expensive — only built when needed.
    expect(asked).toEqual(["rej"]);
  });
});
