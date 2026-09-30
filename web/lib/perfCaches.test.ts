import { describe, expect, it } from "vitest";

import { pathFromTrajectory } from "@/lib/pdr/usePdrCheck";
import { totalSeconds } from "@/lib/useSimPlayback";
import type { TrajectoryPoint } from "@/lib/trajectory/types";

// The playback hot paths rely on these being cached by point-array identity:
// an unchanged flight must cost nothing, a replaced one must be recomputed.
function pts(startIso: string, endIso: string): TrajectoryPoint[] {
  return [
    { lat: 16.9, lon: 96.1, altitude_ft: 0, epoch_ts: startIso },
    { lat: 17.5, lon: 96.5, altitude_ft: 20000, epoch_ts: endIso },
  ] as unknown as TrajectoryPoint[];
}

describe("identity caches", () => {
  it("pathFromTrajectory returns the cached path for the same array", () => {
    const a = pts("2025-07-01T00:00:00Z", "2025-07-01T00:10:00Z");
    expect(pathFromTrajectory(a)).toBe(pathFromTrajectory(a));
  });

  it("pathFromTrajectory recomputes for a replaced array", () => {
    const a = pts("2025-07-01T00:00:00Z", "2025-07-01T00:10:00Z");
    const b = pts("2025-07-01T01:00:00Z", "2025-07-01T01:10:00Z");
    expect(pathFromTrajectory(b)[0].timeMs).not.toBe(pathFromTrajectory(a)[0].timeMs);
  });

  it("totalSeconds is stable and follows a replaced array", () => {
    const a = pts("2025-07-01T00:00:00Z", "2025-07-01T00:10:00Z");
    expect(totalSeconds(a)).toBe(600);
    expect(totalSeconds(a)).toBe(600);
    expect(totalSeconds(pts("2025-07-01T00:00:00Z", "2025-07-01T00:20:00Z"))).toBe(1200);
  });
});
