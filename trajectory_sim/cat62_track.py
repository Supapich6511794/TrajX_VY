"""Load real CAT062 surveillance tracks for validation reference.

Reads the raw CAT062 log (``web/Data/cat062_20251223.csv`` — columns
``flight_key, acid, time_of_track, latitude, longitude, measured_fl, dep,
dest, ias_dap``) and reduces each flight to the two figures the acceptance
criteria compare against:

  * **airborne time** — span of the track (last − first ``time_of_track``).
    ``time_of_track`` is Myanmar local (UTC+6:30), but the offset cancels in the
    difference, so no timezone conversion is needed.
  * **cruise / top-of-climb altitude** — the dominant cruise level, taken as
    the modal flight level of the upper part of the track. Real climbs step
    through intermediate ATC levels (e.g. FL100, FL160) before the final
    cruise, so a first-level-off heuristic would land on the wrong altitude;
    the mode of the upper band lands on the level the aircraft actually
    cruised at.

``measured_fl`` is a flight level (hundreds of feet), so altitude in feet is
``measured_fl * 100``.

The file is large (~256 MB) and git-ignored, so callers pass a ``pairs``
filter to stream only the flights they need. Pure stdlib; no third-party
dependencies.
"""

from __future__ import annotations

import csv
import datetime as dt
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

_TIME_FMT = "%Y-%m-%d %H:%M:%S"
#: Only flight levels at or above this fraction of the track's max count as
#: the "upper/cruise band" when finding the dominant cruise level.
_CRUISE_BAND_FRAC = 0.6
#: Bin width (feet) for the cruise-level mode — 500 ft absorbs Mode-C noise.
_CRUISE_BIN_FT = 500.0
#: CAT062 `time_of_track` is Myanmar local time (MMT, UTC+6:30); subtract this
#: to get UTC.
_LOCAL_UTC_OFFSET = dt.timedelta(hours=6, minutes=30)


@dataclass(frozen=True)
class TrackPoint:
    """One raw CAT062 surveillance return."""

    epoch_utc: dt.datetime   # tz-aware UTC
    lat: float
    lon: float
    fl_ft: float
    ias_kt: float | None


@dataclass
class RawFlight:
    """One real flight's ordered track points (for export / overlay)."""

    flight_key: str
    acid: str
    adep: str
    ades: str
    points: list[TrackPoint]  # sorted by time


@dataclass(frozen=True)
class RealTrack:
    """One real flight reduced to its validation-relevant figures."""

    flight_key: str
    adep: str
    ades: str
    n_points: int
    airborne_min: float
    #: Dominant cruise level (feet) = the track's top-of-climb altitude.
    cruise_alt_ft: float


def _cruise_alt_ft(fls_ft: list[float]) -> float:
    """Dominant cruise level (feet) — the modal FL of the upper band."""
    fmax = max(fls_ft)
    band = [f for f in fls_ft if f >= _CRUISE_BAND_FRAC * fmax]
    counts = Counter(round(f / _CRUISE_BIN_FT) * _CRUISE_BIN_FT for f in band)
    return float(counts.most_common(1)[0][0])


def load_track_points(
    path: str | Path,
    pairs: Iterable[tuple[str, str]] | None = None,
    *,
    min_points: int = 10,
) -> dict[str, RawFlight]:
    """Stream the CAT062 log into per-flight ordered track points.

    Args:
        path: CAT062 CSV path.
        pairs: Keep only these ``(adep, ades)`` city pairs (direction-
            agnostic). ``None`` loads every flight — memory-heavy on the
            full log, so prefer a filter.
        min_points: Drop flights with fewer track points (truncated data).

    Returns:
        ``{flight_key: RawFlight}`` with points sorted by time. Times are
        converted from Myanmar local (UTC+6:30) to UTC.
    """
    want = (
        {frozenset((a.upper(), b.upper())) for a, b in pairs}
        if pairs is not None
        else None
    )
    flights: dict[str, RawFlight] = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            dep = (row.get("dep") or "").strip().upper()
            dest = (row.get("dest") or "").strip().upper()
            if want is not None and frozenset((dep, dest)) not in want:
                continue
            fk = row.get("flight_key") or ""
            if not fk:
                continue
            try:
                local = dt.datetime.strptime(row["time_of_track"], _TIME_FMT)
                lat = float(row["latitude"])
                lon = float(row["longitude"])
                fl_ft = float(row["measured_fl"]) * 100.0
            except (ValueError, KeyError):
                continue
            try:
                ias_kt: float | None = float(row["ias_dap"])
            except (ValueError, KeyError, TypeError):
                ias_kt = None
            epoch_utc = (
                local - _LOCAL_UTC_OFFSET
            ).replace(tzinfo=dt.timezone.utc)
            f = flights.get(fk)
            if f is None:
                f = RawFlight(fk, row.get("acid") or fk.split("_")[0], dep, dest, [])
                flights[fk] = f
            f.points.append(TrackPoint(epoch_utc, lat, lon, fl_ft, ias_kt))

    out: dict[str, RawFlight] = {}
    for fk, f in flights.items():
        if len(f.points) < min_points:
            continue
        f.points.sort(key=lambda p: p.epoch_utc)
        out[fk] = f
    return out


def load_real_tracks(
    path: str | Path,
    pairs: Iterable[tuple[str, str]] | None = None,
    *,
    min_points: int = 10,
) -> dict[str, RealTrack]:
    """Stream the CAT062 log into per-flight :class:`RealTrack` summaries.

    Thin summariser over :func:`load_track_points` — reduces each flight to
    its airborne time (track span) and dominant cruise level.
    """
    out: dict[str, RealTrack] = {}
    for fk, f in load_track_points(path, pairs, min_points=min_points).items():
        ts = [p.epoch_utc.timestamp() for p in f.points]
        out[fk] = RealTrack(
            flight_key=fk,
            adep=f.adep,
            ades=f.ades,
            n_points=len(f.points),
            airborne_min=(max(ts) - min(ts)) / 60.0,
            cruise_alt_ft=_cruise_alt_ft([p.fl_ft for p in f.points]),
        )
    return out


def _percentile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolated percentile (``q`` in [0, 100]) of a sorted list."""
    if not sorted_vals:
        raise ValueError("no values")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (q / 100.0) * (len(sorted_vals) - 1)
    lo = int(pos)
    if lo + 1 >= len(sorted_vals):
        return sorted_vals[-1]
    return sorted_vals[lo] + (pos - lo) * (sorted_vals[lo + 1] - sorted_vals[lo])


def aggregate(values: list[float], method: str = "p10") -> float:
    """Aggregate a list with ``min``/``max``/``mean``/``median``/``pNN``.

    ``pNN`` is a percentile (e.g. ``p10``, ``p25``). Real airborne times
    include ATC vectoring/holding the clean sim doesn't model, so a low
    percentile (a fast/clean flight) is the fair reference for the total-
    time criterion; the caller picks the method.
    """
    vals = sorted(values)
    if not vals:
        raise ValueError("no values to aggregate")
    m = method.lower()
    if m == "min":
        return vals[0]
    if m == "max":
        return vals[-1]
    if m == "mean":
        return sum(vals) / len(vals)
    if m == "median":
        return _percentile(vals, 50.0)
    if m.startswith("p"):
        return _percentile(vals, float(m[1:]))
    raise ValueError(f"unknown aggregation method: {method!r}")


def _pair_tracks(
    tracks: dict[str, RealTrack], adep: str, ades: str
) -> list[RealTrack]:
    key = frozenset((adep.upper(), ades.upper()))
    return [t for t in tracks.values() if frozenset((t.adep, t.ades)) == key]


def pair_time_reference_min(
    tracks: dict[str, RealTrack],
    adep: str,
    ades: str,
    method: str = "p10",
) -> float | None:
    """Real airborne-time reference (minutes) for a pair, or None if absent."""
    rows = _pair_tracks(tracks, adep, ades)
    if not rows:
        return None
    return aggregate([t.airborne_min for t in rows], method)


def pair_cruise_reference_ft(
    tracks: dict[str, RealTrack],
    adep: str,
    ades: str,
    method: str = "median",
) -> float | None:
    """Real cruise-level reference (feet) for a pair, or None if absent."""
    rows = _pair_tracks(tracks, adep, ades)
    if not rows:
        return None
    return aggregate([t.cruise_alt_ft for t in rows], method)
