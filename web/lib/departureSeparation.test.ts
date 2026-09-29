/**
 * Departure separation between filed plans — the Doc 4444 minima and the
 * same-runway pairing that finds them.
 */
import { describe, expect, it } from "vitest";

import {
  autoResolveDepartures,
  departsFromKnownField,
  departureRequirement,
  eobtToMs,
  initialBearingDeg,
  findDepartureConflicts,
  fmtInterval,
  msToEobt,
  resolvedEobtMs,
  type DepartureFlight,
} from "./departureSeparation";

const T0 = Date.UTC(2026, 0, 3, 1, 55, 0);

function dep(over: Partial<DepartureFlight> = {}): DepartureFlight {
  return {
    id: "p1",
    callsign: "UBA100",
    actype: "B738",
    adep: "VYMD",
    ades: "VYYY",
    eobtMs: T0,
    depRwy: "RW17",
    trackDeg: 170,
    gsKt: 450,
    rfl: 350,
    ...over,
  };
}

describe("departureRequirement", () => {
  it("holds the runway for a minute when no other rule bites (§7.9.2)", () => {
    // Same category, same track, same level, same speed: Doc 4444 imposes no
    // time minimum of its own — what is left is the runway being clear.
    const r = departureRequirement(dep(), dep({ id: "p2", callsign: "UBA200" }));
    expect(r.requiredSec).toBe(60);
    expect(r.requiredBy).toBe("runway-occupancy");
    expect(r.reason).toContain("§7.9.2");
  });

  it("takes 2 min for a MEDIUM behind a HEAVY (§5.8.3.1)", () => {
    const r = departureRequirement(
      dep({ actype: "B77W" }),
      dep({ id: "p2", callsign: "UBA200", actype: "A320" }),
    );
    expect(r.requiredSec).toBe(120);
    expect(r.requiredBy).toBe("wake");
    expect(r.reason).toContain("§5.8.3.1");
  });

  it("raises the same pair to 3 min off an intersection (§5.8.3.2)", () => {
    const r = departureRequirement(
      dep({ actype: "B77W" }),
      dep({ id: "p2", actype: "A320", intersection: true }),
    );
    expect(r.requiredSec).toBe(180);
    expect(r.requiredBy).toBe("wake-intersection");
    expect(r.reason).toContain("§5.8.3.2");
  });

  it("gives a HEAVY 2 min behind a SUPER", () => {
    const r = departureRequirement(
      dep({ actype: "A388" }),
      dep({ id: "p2", actype: "B77W" }),
    );
    expect(r.requiredSec).toBe(120);
    expect(r.requiredBy).toBe("wake");
  });

  it("gives a MEDIUM or LIGHT 3 min behind a SUPER, not 2", () => {
    // The A380 provisions are a minute longer than §5.8.3.1's HEAVY row, and a
    // "is the follower lighter?" shortcut cannot express that: an A380 ahead of
    // a 737 is 3 minutes.
    for (const actype of ["B738", "C172"]) {
      const r = departureRequirement(
        dep({ actype: "A388" }),
        dep({ id: "p2", actype }),
      );
      expect(r.requiredSec).toBe(180);
      expect(r.requiredBy).toBe("wake");
      expect(r.reason).toContain("3 min");
    }
  });

  it("reads the whole published table, pair by pair", () => {
    const secs = (lead: string, follow: string) =>
      departureRequirement(dep({ actype: lead }), dep({ id: "p2", actype: follow }))
        .minima.wakeSec;
    // SUPER A388 · HEAVY B77W · MEDIUM A320/B738 · LIGHT C172
    expect(secs("A388", "B77W")).toBe(120);
    expect(secs("A388", "A320")).toBe(180);
    expect(secs("A388", "C172")).toBe(180);
    expect(secs("B77W", "A320")).toBe(120);
    expect(secs("B77W", "C172")).toBe(120);
    expect(secs("A320", "C172")).toBe(120);
    // No wake minimum for these — the runway and the tracks still have theirs.
    expect(secs("A320", "B738")).toBe(0);
    expect(secs("B77W", "A388")).toBe(0);
    expect(secs("C172", "A388")).toBe(0);
    expect(secs("A388", "A388")).toBe(0);
  });

  it("carries no wake minimum when the follower is not lighter", () => {
    // MEDIUM behind MEDIUM, and LIGHT ahead of anything, are not §5.8.3 pairs.
    expect(
      departureRequirement(dep({ actype: "A320" }), dep({ id: "p2", actype: "B738" }))
        .minima.wakeSec,
    ).toBe(0);
    expect(
      departureRequirement(dep({ actype: "C172" }), dep({ id: "p2", actype: "B77W" }))
        .minima.wakeSec,
    ).toBe(0);
  });

  it("gives 1 min to tracks diverging by 45° or more (§5.6.1)", () => {
    const r = departureRequirement(
      dep({ trackDeg: 10 }),
      dep({ id: "p2", trackDeg: 100 }),
    );
    expect(r.divergingTracks).toBe(true);
    expect(r.divergenceDeg).toBe(90);
    expect(r.requiredSec).toBe(60);
  });

  it("does not let divergence relief undercut the wake minimum", () => {
    // §5.8.3 is about the vortex, not the track — 45° apart or not, a MEDIUM
    // behind a HEAVY still waits 2 minutes.
    const r = departureRequirement(
      dep({ actype: "B77W", trackDeg: 10 }),
      dep({ id: "p2", actype: "A320", trackDeg: 100 }),
    );
    expect(r.requiredSec).toBe(120);
    expect(r.requiredBy).toBe("wake");
  });

  it("takes 2 min when the leader is 40 kt faster on the same track (§5.6.2)", () => {
    const r = departureRequirement(
      dep({ gsKt: 480 }),
      dep({ id: "p2", callsign: "UBA200", gsKt: 440 }),
    );
    expect(r.requiredSec).toBe(120);
    expect(r.requiredBy).toBe("speed");
    expect(r.reason).toContain("§5.6.2");
  });

  it("takes 5 min when the follower climbs through the leader's level (§5.6.3)", () => {
    const r = departureRequirement(
      dep({ rfl: 260 }),
      dep({ id: "p2", callsign: "UBA200", rfl: 360 }),
    );
    expect(r.requiredSec).toBe(300);
    expect(r.requiredBy).toBe("level-crossing");
    expect(r.reason).toContain("§5.6.3");
  });

  it("treats an unknown track as the same track", () => {
    // The 45° relief has to be shown before it can be used, so a plan with no
    // resolvable track gets the same-track rules.
    const r = departureRequirement(
      dep({ trackDeg: null, rfl: 260 }),
      dep({ id: "p2", trackDeg: null, rfl: 360 }),
    );
    expect(r.divergenceDeg).toBeNull();
    expect(r.divergingTracks).toBe(false);
    expect(r.requiredSec).toBe(300);
  });
});

describe("findDepartureConflicts", () => {
  const field = { adep: "VYMD", depRwy: "RW17" };

  it("flags two plans off the same runway at the same time", () => {
    const a = dep({ id: "p1", callsign: "UBA100", ades: "VYYY", ...field });
    const b = dep({ id: "p2", callsign: "UBA200", ades: "VYKT", ...field });
    const [c] = findDepartureConflicts([a, b]);
    expect(c).toBeDefined();
    expect(c.gapSec).toBe(0);
    expect(c.requiredSec).toBe(60);
    expect(c.deficitSec).toBe(60);
    expect([c.leader.callsign, c.follower.callsign]).toEqual(["UBA100", "UBA200"]);
  });

  it("clears the pair once the interval is met", () => {
    const a = dep({ id: "p1" });
    const b = dep({ id: "p2", callsign: "UBA200", eobtMs: T0 + 60_000 });
    expect(findDepartureConflicts([a, b])).toEqual([]);
  });

  it("does not pair different aerodromes", () => {
    expect(
      findDepartureConflicts([dep({ id: "p1" }), dep({ id: "p2", adep: "VYYY" })]),
    ).toEqual([]);
  });

  it("still pairs different runways when the departure paths cross", () => {
    // The runway is not the question §5.8.3.1 c)/d) asks — the paths are. Two
    // aircraft off opposite runways onto the same fix at the same level fly in
    // formation, which a runway-keyed check misses entirely.
    const a = dep({ id: "p1", callsign: "QTR700", depRwy: "RW17", trackDeg: 221 });
    const b = dep({ id: "p2", callsign: "MAS701", depRwy: "RW35", trackDeg: 221 });
    const [c] = findDepartureConflicts([a, b]);
    expect(c).toBeDefined();
    expect(c.requiredBy).toBe("in-trail");
    // Same EOBT, so the take-off order is broken by callsign: MAS701 leads.
    expect(c.runway).toBe("RW35 / RW17");
    expect(c.runwayAssumed).toBe(false);
    expect(c.requiredSec).toBe(24); // 3 NM at 450 kt
  });

  it("lets different runways go when the tracks diverge", () => {
    // §5.6.1's one-minute floor is explicitly relaxed for parallel-runway
    // operations, so a diverging pair off two runways must stay silent.
    const a = dep({ id: "p1", depRwy: "RW17", trackDeg: 59 });
    const b = dep({ id: "p2", callsign: "UBA200", depRwy: "RW35", trackDeg: 221 });
    expect(findDepartureConflicts([a, b])).toEqual([]);
  });

  it("keeps the §7.9.2 minute to the runway it is about", () => {
    // Same track, so the pair is still checked — but runway occupancy belongs
    // to aircraft sharing a runway; what survives across two is the in-trail
    // distance.
    const a = dep({ id: "p1", depRwy: "RW17" });
    const b = dep({ id: "p2", callsign: "UBA200", depRwy: "RW35" });
    const [c] = findDepartureConflicts([a, b]);
    expect(c.requiredBy).toBe("in-trail");
    expect(c.requiredSec).toBeLessThan(60);
  });

  it("pairs each departure with the one immediately ahead of it at the field", () => {
    const first = dep({ id: "p1", callsign: "AAA", depRwy: "RW17" });
    const other = dep({
      id: "p2", callsign: "BBB", depRwy: "RW35", eobtMs: T0 + 20_000,
    });
    const third = dep({
      id: "p3", callsign: "CCC", depRwy: "RW17", eobtMs: T0 + 40_000,
    });
    const cs = findDepartureConflicts([first, other, third]);
    expect(cs.map((c) => [c.leader.callsign, c.follower.callsign])).toEqual([
      ["AAA", "BBB"],
      ["BBB", "CCC"],
    ]);
  });

  it("pairs an Auto runway with a stated one at the same aerodrome", () => {
    // The panel auto-fills the runway of the tab ON SCREEN only, so a freshly
    // imported bank is one stated runway and a pile of blanks. Both are the
    // aerodrome's default runway, and they must still be checked against
    // each other.
    const a = dep({ id: "p1", depRwy: "RW17" });
    const b = dep({ id: "p2", callsign: "UBA200", depRwy: "" });
    const [c] = findDepartureConflicts([a, b]);
    expect(c).toBeDefined();
    expect(c.runway).toBe("RW17");
    expect(c.runwayAssumed).toBe(true);
  });

  it("pairs two Auto runways — the engine gives both the same one", () => {
    const a = dep({ id: "p1", depRwy: "" });
    const b = dep({ id: "p2", callsign: "UBA200", depRwy: "" });
    const [c] = findDepartureConflicts([a, b]);
    expect(c.runway).toBe("Auto");
    expect(c.runwayAssumed).toBe(true);
  });

  it("skips plans with no EOBT", () => {
    expect(
      findDepartureConflicts([dep({ id: "p1" }), dep({ id: "p2", eobtMs: null })]),
    ).toEqual([]);
  });

  it("checks each departure against the one immediately ahead of it", () => {
    // Three in a row 30 s apart: two consecutive pairs, not three combinations.
    const flights = [0, 30_000, 60_000].map((dt, i) =>
      dep({ id: `p${i + 1}`, callsign: `UBA${i}`, eobtMs: T0 + dt }),
    );
    const cs = findDepartureConflicts(flights);
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => [c.leader.callsign, c.follower.callsign])).toEqual([
      ["UBA0", "UBA1"],
      ["UBA1", "UBA2"],
    ]);
  });
});

describe("resolvedEobtMs", () => {
  it("moves the follower later or the leader earlier, to exactly the minimum", () => {
    const a = dep({ id: "p1", actype: "B77W" });
    const b = dep({ id: "p2", callsign: "UBA200", actype: "A320" });
    const [c] = findDepartureConflicts([a, b]);
    expect(c.requiredSec).toBe(120);
    expect(resolvedEobtMs(c, "p2")).toBe(T0 + 120_000); // follower pushed back
    expect(resolvedEobtMs(c, "p1")).toBe(T0 - 120_000); // leader brought forward
    expect(resolvedEobtMs(c, "nope")).toBeNull();
  });
});

describe("the whole story: import -> notify -> pick an FPL -> fix", () => {
  it("clears once the chosen plan takes the suggested EOBT", () => {
    // Two FPLs out of VYMD on the same runway at the same minute: UBA100 to
    // VYYY behind a HEAVY, UBA200 to VYKT as a MEDIUM.
    const uba100 = dep({
      id: "p1", callsign: "UBA100", actype: "B77W", ades: "VYYY", trackDeg: 178,
    });
    const uba200 = dep({
      id: "p2", callsign: "UBA200", actype: "A320", ades: "VYKT", trackDeg: 168,
    });

    const [c] = findDepartureConflicts([uba100, uba200]);
    // Tracks are 10° apart — not the 45° that buys the 1-minute relief — and a
    // MEDIUM behind a HEAVY is §5.8.3.1.
    expect(c.requiredSec).toBe(120);
    expect(c.requiredBy).toBe("wake");
    expect(c.deficitSec).toBe(120);

    // The user picks UBA200 (the follower) to move.
    const suggested = resolvedEobtMs(c, "p2")!;
    expect(msToEobt(suggested)).toBe("2026-01-03T01:57");

    const fixed = [uba100, { ...uba200, eobtMs: eobtToMs(msToEobt(suggested)) }];
    expect(findDepartureConflicts(fixed)).toEqual([]);
  });

  it("also clears if the user moves the leader instead", () => {
    const a = dep({ id: "p1", callsign: "UBA100" });
    const b = dep({ id: "p2", callsign: "UBA200" });
    const [c] = findDepartureConflicts([a, b]);
    const suggested = resolvedEobtMs(c, "p1")!;
    expect(findDepartureConflicts([{ ...a, eobtMs: suggested }, b])).toEqual([]);
  });
});

describe("autoResolveDepartures", () => {
  it("re-times a whole bank until nothing is left", () => {
    // Six flights filed at the same minute off one runway: the worst case the
    // button exists for, and one pass cannot fix it — moving them all to the
    // same new time just recreates the pile.
    const bank = Array.from({ length: 6 }, (_, i) =>
      dep({ id: `p${i + 1}`, callsign: `UBA${i}` }),
    );
    const { eobtMsById, remaining } = autoResolveDepartures(bank, {
      pick: (c) => c.follower.id, // deterministic: always delay the follower
    });
    expect(remaining).toEqual([]);
    const fixed = bank.map((f) => ({ ...f, eobtMs: eobtMsById.get(f.id) ?? f.eobtMs }));
    expect(findDepartureConflicts(fixed)).toEqual([]);
    // Each one ends up a whole minute apart (the field's own resolution) and
    // the first is left where it was filed.
    const times = fixed.map((f) => f.eobtMs!).sort((a, b) => a - b);
    expect(times[0]).toBe(T0);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBe(60_000);
    }
  });

  it("can resolve by moving the leader earlier instead", () => {
    const bank = [
      dep({ id: "p1", callsign: "AAA" }),
      dep({ id: "p2", callsign: "BBB" }),
    ];
    const { eobtMsById, remaining } = autoResolveDepartures(bank, {
      pick: (c) => c.leader.id,
    });
    expect(remaining).toEqual([]);
    expect(eobtMsById.get("p1")).toBe(T0 - 60_000);
    expect(eobtMsById.has("p2")).toBe(false);
  });

  it("respects a wake pair's longer minimum", () => {
    const bank = [
      dep({ id: "p1", callsign: "AAA", actype: "B77W" }),
      dep({ id: "p2", callsign: "BBB", actype: "A320" }),
    ];
    const { eobtMsById } = autoResolveDepartures(bank, {
      pick: (c) => c.follower.id,
    });
    expect(eobtMsById.get("p2")).toBe(T0 + 120_000); // §5.8.3.1, not 60 s
  });

  it("leaves dismissed pairs alone", () => {
    const bank = [dep({ id: "p1" }), dep({ id: "p2", callsign: "UBA200" })];
    const [c] = findDepartureConflicts(bank);
    const { eobtMsById, remaining } = autoResolveDepartures(bank, {
      ignored: new Set([c.id]),
    });
    expect(eobtMsById.size).toBe(0);
    expect(remaining).toEqual([]);
  });

  it("settles what the random phase leaves behind", () => {
    // The random phase alone does leave pairs: its last pass is never
    // rescanned, and moving one aircraft can drop it next to another. This is
    // the case that reached the panel as "1 pair" after Auto fix all. With a
    // pick that moves nothing at all, the settling sweep still has to produce
    // a clean bank.
    const bank = [
      dep({ id: "p1", callsign: "AAA" }),
      dep({ id: "p2", callsign: "BBB" }),
      dep({ id: "p3", callsign: "CCC" }),
    ];
    const { eobtMsById, remaining } = autoResolveDepartures(bank, {
      passes: 0, // skip the random phase entirely
      pick: () => "nope",
    });
    expect(remaining).toEqual([]);
    expect(eobtMsById.get("p2")).toBe(T0 + 60_000);
    expect(eobtMsById.get("p3")).toBe(T0 + 120_000);
  });

  it("never returns a bank it has not actually cleared", () => {
    // 40 flights filed across one minute at two aerodromes — the shape of a
    // real import. Whatever the coin tosses do, the result must be legal.
    const bank = Array.from({ length: 40 }, (_, i) =>
      dep({
        id: `p${i}`,
        callsign: `UBA${i}`,
        adep: i % 2 ? "VYYY" : "VYMD",
        eobtMs: T0 + (i % 3) * 20_000,
      }),
    );
    const { eobtMsById, remaining } = autoResolveDepartures(bank);
    expect(remaining).toEqual([]);
    const fixed = bank.map((f) => ({
      ...f,
      eobtMs: eobtMsById.get(f.id) ?? f.eobtMs,
    }));
    expect(findDepartureConflicts(fixed)).toEqual([]);
  });
});

describe("initialBearingDeg", () => {
  it("gives the track a plan departs on", () => {
    // VYMD (Mandalay) to VYYY (Yangon) is very nearly due south (~178°); to
    // VYKT (Kawthaung) it is south-southeast (~168°). Under 45° apart, so the
    // two are NOT diverging departures — which is the whole point of the demo
    // case.
    const vymd = { lat: 21.7011, lon: 95.9775 };
    const vyyy = { lat: 16.9073, lon: 96.1332 };
    const vykt = { lat: 10.0496, lon: 98.5381 };
    const toYangon = initialBearingDeg(vymd.lat, vymd.lon, vyyy.lat, vyyy.lon);
    const toKawthaung = initialBearingDeg(vymd.lat, vymd.lon, vykt.lat, vykt.lon);
    expect(toYangon).toBeGreaterThan(175);
    expect(toYangon).toBeLessThan(180);
    expect(toKawthaung).toBeGreaterThan(160);
    expect(toKawthaung).toBeLessThan(175);
    expect(Math.abs(toYangon - toKawthaung)).toBeLessThan(45);
  });
});

describe("EOBT helpers", () => {
  it("reads and writes the panel's datetime-local value as UTC", () => {
    expect(eobtToMs("2026-01-03T01:55")).toBe(T0);
    expect(eobtToMs("2026-01-03T01:55:30")).toBe(T0 + 30_000);
    expect(eobtToMs("")).toBeNull();
    expect(eobtToMs("nonsense")).toBeNull();
    expect(msToEobt(T0)).toBe("2026-01-03T01:55");
  });

  it("rounds a suggested EOBT UP, so it never lands under the interval", () => {
    // 01:55:30 + 2 min = 01:57:30, which as a whole minute must be 01:58 —
    // 01:57 would be 30 s short of the minimum it was computed to deliver.
    expect(msToEobt(T0 + 30_000 + 120_000)).toBe("2026-01-03T01:58");
  });

  it("quotes whole intervals in minutes", () => {
    expect(fmtInterval(120)).toBe("2 min");
    expect(fmtInterval(90)).toBe("90 s");
  });
});

describe("departsFromKnownField", () => {
  const fields = new Set(["VYYY", "VYMD"]);
  it("counts a plan that takes off from an aerodrome the system knows", () => {
    expect(departsFromKnownField({ adep: "vyyy" }, fields)).toBe(true);
  });
  it("does not count a flight only passing through, even from a known field", () => {
    expect(departsFromKnownField({ adep: "VYYY", entryFl: 350 }, fields)).toBe(false);
  });
  it("does not count a departure from a foreign field this system has no coordinates for", () => {
    expect(departsFromKnownField({ adep: "VHHH" }, fields)).toBe(false);
  });
  it("drops nothing while the aerodrome list is still loading", () => {
    expect(departsFromKnownField({ adep: "VHHH" }, new Set())).toBe(true);
  });
});
