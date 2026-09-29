"""Tactical trajectory edits — changing a flight that is already airborne.

A CD&R resolution is not a re-plan. When ATC extends an arrival's downwind the
aircraft is ALREADY at the hand-over fix, at whatever altitude and speed it
reached there; the instruction can only change what happens next. Regenerating
the flight from EOBT with a longer route gets this wrong in a way that matters:

    extend = 0    hand-over fix at 6 630 ft
    extend = 12   hand-over fix at 9 632 ft     <- the same fix, 3 000 ft higher

The re-plan pushes top-of-descent back, so the extra track ends up flown in the
CRUISE band at ~450 kt instead of in the terminal area at ~200 kt — and the
delay the extension was supposed to buy mostly evaporates.

:func:`splice_tactical_extension` fixes that by treating the two generated
trajectories as what they respectively are: the BASELINE supplies the flight up
to the hand-over fix (and the vertical/speed schedule to fly inbound), while the
EXTENDED one supplies only the new ground track. The result is the aircraft
holding its altitude and speed along the longer downwind, then flying the same
profile inbound that it would have flown anyway.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from .geodesy import haversine_distance

#: Below this ground speed a sample cannot be used to advance the clock.
_MIN_GS_KT = 60.0


def _nearest_index(points: list[dict], lat: float, lon: float) -> int:
    """Index of the sample closest to a fix."""
    best_i, best_d = 0, math.inf
    for i, p in enumerate(points):
        d = haversine_distance(p["lat"], p["lon"], lat, lon)
        if d < best_d:
            best_i, best_d = i, d
    return best_i


def _distance_to_go(points: list[dict]) -> list[float]:
    """Track distance (NM) from each sample to the last one."""
    n = len(points)
    dtg = [0.0] * n
    for i in range(n - 2, -1, -1):
        dtg[i] = dtg[i + 1] + haversine_distance(
            points[i]["lat"], points[i]["lon"],
            points[i + 1]["lat"], points[i + 1]["lon"],
        )
    return dtg


def _at_distance_to_go(
    dtg: list[float], points: list[dict], key: str, want: float
) -> float:
    """Interpolate ``key`` at a distance-to-go along a tail.

    ``dtg`` descends (it is measured to the end), so the search runs backwards.
    Beyond the tail's own length the FIRST sample's value is held — that is the
    whole point: on the stretch of downwind the baseline never flew, the
    aircraft simply maintains what it had at the hand-over.
    """
    if want >= dtg[0]:
        return float(points[0][key])
    if want <= dtg[-1]:
        return float(points[-1][key])
    for i in range(len(dtg) - 1):
        hi, lo = dtg[i], dtg[i + 1]
        if lo <= want <= hi:
            span = hi - lo
            f = 0.0 if span <= 0 else (hi - want) / span
            a = float(points[i][key])
            b = float(points[i + 1][key])
            return a + (b - a) * f
    return float(points[-1][key])


def _parse(ts: object) -> datetime:
    return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))


def splice_tactical_extension(
    baseline: list[dict],
    extended: list[dict],
    handover_lat: float,
    handover_lon: float,
) -> list[dict]:
    """Apply an extended downwind to a flight already at the hand-over fix.

    Args:
        baseline: The flight as filed, sampled. Everything up to the hand-over
            fix is kept EXACTLY — it has already been flown.
        extended: The same flight regenerated with the longer downwind. Only
            its ground track after the hand-over is used; its timing and
            vertical profile are discarded, because they were re-planned from
            EOBT and so disagree with where the aircraft actually is.
        handover_lat, handover_lon: The fix the vectoring starts at (the STAR's
            last fix).

    Returns:
        A new sample list: the baseline up to the hand-over, then the extended
        ground track re-flown at the baseline's own altitude/speed schedule
        (indexed by distance to go, so every crossing restriction inbound is
        met at the same distance from the runway as before) and re-timed to
        follow on from the hand-over.
    """
    if len(baseline) < 2 or len(extended) < 2:
        return list(baseline)

    h = _nearest_index(baseline, handover_lat, handover_lon)
    e = _nearest_index(extended, handover_lat, handover_lon)
    if h >= len(baseline) - 1 or e >= len(extended) - 1:
        return list(baseline)

    base_tail = baseline[h:]
    ext_tail = extended[e:]
    base_dtg = _distance_to_go(base_tail)
    ext_dtg = _distance_to_go(ext_tail)

    out: list[dict] = [dict(p) for p in baseline[: h + 1]]
    clock = _parse(baseline[h]["epoch_ts"])
    prev = ext_tail[0]

    for i in range(1, len(ext_tail)):
        cur = ext_tail[i]
        step_nm = haversine_distance(
            prev["lat"], prev["lon"], cur["lat"], cur["lon"]
        )
        want = ext_dtg[i]
        alt = _at_distance_to_go(base_dtg, base_tail, "altitude_ft", want)
        gs = _at_distance_to_go(base_dtg, base_tail, "gs_kt", want)
        gs = max(_MIN_GS_KT, gs)
        # Time comes from the speed actually being flown over the step, which
        # is what makes the extension buy the delay it is supposed to.
        clock = clock + timedelta(seconds=step_nm / gs * 3600.0)
        sample = dict(cur)
        sample["epoch_ts"] = clock.isoformat()
        sample["altitude_ft"] = round(alt, 1)
        sample["gs_kt"] = round(gs, 1)
        if sample.get("tas_kt") is not None:
            sample["tas_kt"] = round(gs, 1)
        out.append(sample)
        prev = cur

    return out
