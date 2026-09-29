"""Tests for ``api.server._smooth_turns`` — picking the right turn at each fix.

The pure geometry lives in ``test_turns``; this is about the *choice* the
procedure data drives. ARINC 424 says a fix is crossed before turning when its
description code marks it fly-over (2nd character ``Y``) or when the leg leaving
it publishes a turn direction; every other fix is cut. Get that wrong and the
aircraft either pivots on the spot or cuts a corner it was required to overfly —
which is how a departure ends up slicing back across its own runway.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

import api.server as server
from trajectory_sim.geodesy import haversine_distance
from trajectory_sim.navdata import (
    AltitudeConstraint,
    AltitudeConstraintType,
    Procedure,
    ProcedureLeg,
    ProcedureType,
    SpeedConstraint,
)

# A right-angle corner: north up the 96.00 meridian, then east along 17.10.
_START = ("START", 16.90, 96.00)
_CORNER = ("CORNER", 17.10, 96.00)
_END = ("END", 17.10, 96.30)
_ROUTE = [_START, _CORNER, _END]

_RFL_FT = 35000.0


def _leg(
    ident: str,
    lat: float,
    lon: float,
    *,
    desc_code: str | None = None,
    turn: str | None = None,
    alt_ft: float | None = None,
) -> ProcedureLeg:
    return ProcedureLeg(
        seqno=10,
        path_terminator="DF" if turn else "TF",
        ident=ident,
        lat=lat,
        lon=lon,
        altitude=(
            AltitudeConstraint(AltitudeConstraintType.AT_OR_BELOW, alt_ft)
            if alt_ft is not None
            else AltitudeConstraint()
        ),
        speed=SpeedConstraint(),
        turn_direction=turn,
        desc_code=desc_code,
    )


def _sid(*legs: ProcedureLeg) -> "list[tuple[Procedure | None, str]]":
    proc = Procedure(
        airport="VYYY",
        name="TEST1A",
        proc_type=ProcedureType.SID,
        runway="RW21",
        transition=None,
        legs=legs,
    )
    return [(proc, "climb")]


def _smooth(procs: "list[tuple[Procedure | None, str]]"):
    return server._smooth_turns(_ROUTE, "B738", _RFL_FT, procs)


def _on_path(path: "list[tuple[str, float, float]]", ident: str) -> bool:
    return any(p[0] == ident for p in path)


def _closest_nm(path: "list[tuple[str, float, float]]", pt) -> float:
    return min(haversine_distance(pt[1], pt[2], p[1], p[2]) for p in path)


def test_an_ordinary_fix_is_cut() -> None:
    """No fly-over flag, no published turn: the corner is cut, and the fix
    itself drops off the flown path."""
    path, _dist = _smooth(_sid(_leg("CORNER", 17.10, 96.00, desc_code="E")))
    assert not _on_path(path, "CORNER")
    assert _closest_nm(path, _CORNER) > 0.1


def test_an_altitude_terminated_leg_is_always_crossed() -> None:
    """A CA/VA leg ("climb on 015° to 700 ft") ends exactly where the altitude
    is made, so the turn off it cannot start early — cutting the corner would
    have the aircraft turning BELOW the altitude the procedure requires. A SID
    whose climb leg neither flags the fix fly-over nor publishes a turn
    direction was cut without this rule, and the departure turned at ~500 ft.
    """
    climb = _leg("CORNER", 17.10, 96.00, desc_code=None)
    path, _dist = _smooth(_sid(replace(climb, path_terminator="VA")))
    assert _on_path(path, "CORNER")
    assert _closest_nm(path, _CORNER) == pytest.approx(0.0, abs=1e-6)


def test_a_flyover_fix_is_crossed() -> None:
    """Description code "EY" — as a runway departure end (e.g. DE21) carries — means
    the aircraft must cross it before it may turn."""
    path, _dist = _smooth(_sid(_leg("CORNER", 17.10, 96.00, desc_code="EY")))
    assert _on_path(path, "CORNER")
    assert _closest_nm(path, _CORNER) == pytest.approx(0.0, abs=1e-6)


def test_a_published_turn_direction_makes_the_previous_fix_a_flyover() -> None:
    """A leg coded "turn right, direct END" is flown FROM the fix before it — so
    that fix is crossed, then the aircraft curves round onto END."""
    path, _dist = _smooth(
        _sid(
            _leg("CORNER", 17.10, 96.00, desc_code="E"),
            _leg("END", 17.10, 96.30, desc_code="E", turn="R"),
        )
    )
    assert _on_path(path, "CORNER")


def test_the_turn_goes_the_way_the_procedure_says() -> None:
    """END lies 90° right of the inbound track, but a published LEFT turn sends
    the aircraft the long way round — the arc is far longer than a right one."""
    left, _ = _smooth(
        _sid(
            _leg("CORNER", 17.10, 96.00, desc_code="E"),
            _leg("END", 17.10, 96.30, desc_code="E", turn="L"),
        )
    )
    right, _ = _smooth(
        _sid(
            _leg("CORNER", 17.10, 96.00, desc_code="E"),
            _leg("END", 17.10, 96.30, desc_code="E", turn="R"),
        )
    )
    assert len(left) > len(right)


def test_every_fix_keeps_a_distance_even_when_the_path_cuts_it() -> None:
    """A cut fix is off the path, but its crossing restriction still has to be
    applied somewhere — at the arc that cuts it. Losing it would silently drop
    the restriction (e.g. an "at or below 8 000")."""
    path, dist = _smooth(
        _sid(_leg("CORNER", 17.10, 96.00, desc_code="E", alt_ft=8000))
    )
    assert not _on_path(path, "CORNER")
    assert "CORNER" in dist
    # It sits between the two fixes it lies between, on the flown distance.
    assert dist["START"] < dist["CORNER"] < dist["END"]


def test_distances_are_measured_along_the_curved_path() -> None:
    """Cutting the corner is shorter than flying to it and back out again."""
    _path, dist = _smooth(
        _sid(_leg("CORNER", 17.10, 96.00, desc_code="E"))
    )
    straight_nm = haversine_distance(*_START[1:], *_CORNER[1:]) + haversine_distance(
        *_CORNER[1:], *_END[1:]
    )
    assert dist["END"] < straight_nm


def test_a_route_with_no_procedure_is_still_smoothed() -> None:
    """Turn geometry is not a SID-only affair: an en-route corner is flown as a
    turn too — at cruise speed, so a much wider one."""
    path, _dist = _smooth([(None, "climb")])
    assert len(path) > len(_ROUTE)
    assert not _on_path(path, "CORNER")
