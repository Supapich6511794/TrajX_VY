/**
 * An area published "sunset to sunrise" is only hot at night, so these instants
 * decide whether a night flight conflicts with it. The values are pinned
 * against published Yangon almanac times (MMT = UTC+6:30) rather than
 * against the implementation, so a regression in the solar maths shows up as a
 * wrong clock time instead of a silently shifted window.
 */
import { describe, expect, it } from "vitest";

import { sunTimes } from "./solar";

/** Yangon (VYYY aerodrome reference point). */
const VYYY = { lat: 16.9073, lon: 96.1332 };

/** Local (MMT, UTC+6:30) hour of an instant, as a decimal. */
function localHour(ms: number): number {
  return (((ms + 6.5 * 3600000) % 86400000) / 3600000 + 24) % 24;
}

function times(y: number, m: number, d: number, at = VYYY) {
  const t = sunTimes(new Date(Date.UTC(y, m, d)), at.lat, at.lon);
  if (!t) throw new Error("no sun times");
  return t;
}

describe("sunTimes over Yangon", () => {
  it("puts the early-September sunrise near 0553 local", () => {
    const t = times(2026, 8, 7); // 7 Sep 2026
    expect(localHour(t.sunriseMs)).toBeGreaterThan(5.6);
    expect(localHour(t.sunriseMs)).toBeLessThan(6.2);
  });

  it("puts the same day's sunset near 1814 local", () => {
    const t = times(2026, 8, 7);
    expect(localHour(t.sunsetMs)).toBeGreaterThan(17.9);
    expect(localHour(t.sunsetMs)).toBeLessThan(18.5);
  });

  it("gives a near-12-hour day at the equinox", () => {
    const t = times(2026, 8, 23); // ~equinox
    const hours = (t.sunsetMs - t.sunriseMs) / 3600000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThan(12.3);
  });

  it("gives the longest day in June and the shortest in December", () => {
    const june = times(2026, 5, 21);
    const dec = times(2026, 11, 21);
    const len = (t: { sunriseMs: number; sunsetMs: number }) =>
      (t.sunsetMs - t.sunriseMs) / 3600000;
    // Yangon's swing is small (16.9°N): about 13h06m to 11h13m.
    expect(len(june)).toBeGreaterThan(12.9);
    expect(len(june)).toBeLessThan(13.4);
    expect(len(dec)).toBeGreaterThan(10.9);
    expect(len(dec)).toBeLessThan(11.4);
    expect(len(june)).toBeGreaterThan(len(dec));
  });

  it("has sunrise before sunset on the same UTC day frame", () => {
    const t = times(2026, 8, 7);
    expect(t.sunriseMs).toBeLessThan(t.sunsetMs);
  });

  it("returns null inside the polar night", () => {
    expect(sunTimes(new Date(Date.UTC(2026, 11, 21)), 85, 0)).toBeNull();
  });
});
