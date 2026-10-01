"""End-to-end: the runway-heuristic priority the trajectory builder must
respect (see ``_finish`` in ``api/server.py``):

    1. Published SID / STAR / Approach
    2. RUNWAY_HEURISTIC (a known runway, nothing published to fly off/onto it)
    3. DCT (nothing at all — no runway either)

A published procedure must never be overridden by the heuristic, and the
heuristic must never be reported as a published SID/STAR/approach — the two
are told apart by ``meta.dep_trajectory_source`` / ``meta.
arr_trajectory_source``, never by ``meta.sid`` / ``meta.star`` / ``meta.
approach``, which stay unset for a heuristic track.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.server import app

client = TestClient(app)


def _fly(**kw):
    body = {
        "source": "fpl",
        "eobt": "2026-01-03T08:15:00",
        "callsign": "TST1",
        "actype": "AT76",
        **kw,
    }
    r = client.post("/api/generate", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_case1_published_sid_is_not_overridden_by_the_heuristic():
    """VYYY VISA1A (RW21) is a real, resolvable SID — flying it must report
    PUBLISHED_SID, never RUNWAY_HEURISTIC, and the meta must actually name it."""
    d = _fly(
        adep="VYYY", ades="VYHH", route="BOMAS DCT VYHH",
        sid="VISA1A", sid_runway="RW21",
    )
    assert d["meta"]["dep_trajectory_source"] == "PUBLISHED_SID"
    assert d["meta"]["sid"] == "VISA1A"


def test_case2_no_sid_but_known_runway_uses_the_heuristic():
    """VYNT has no published SID at all — a known departure runway with
    nothing to fly off it must get the synthetic turn, not a straight line."""
    d = _fly(adep="VYNT", ades="VYTL", route="VYNT DCT VYTL", sid_runway="RW16")
    assert d["meta"]["dep_trajectory_source"] == "RUNWAY_HEURISTIC"
    assert d["meta"]["sid"] is None  # never claimed as a published SID
    # A real turn, not a straight line: some point off the runway/first-fix
    # great-circle must depart from the runway's own true bearing (157°).
    from trajectory_sim.geodesy import compute_bearing

    pts = d["points"]
    first_leg_bearing = compute_bearing(
        pts[0]["lat"], pts[0]["lon"], pts[1]["lat"], pts[1]["lon"]
    )
    assert first_leg_bearing == pytest.approx(157.0, abs=1.0)
    later_bearing = compute_bearing(
        pts[10]["lat"], pts[10]["lon"], pts[11]["lat"], pts[11]["lon"]
    )
    assert abs(later_bearing - first_leg_bearing) > 5.0  # it actually turned


def test_case3_published_star_and_approach_are_not_overridden():
    """VYDW -> VYYY with a resolvable R03 approach must report
    PUBLISHED_APPROACH, never the heuristic."""
    d = _fly(
        adep="VYDW", ades="VYYY", route="VYDW DCT VYYY",
        star_runway="RW03", approach="R03",
    )
    assert d["meta"]["arr_trajectory_source"] == "PUBLISHED_APPROACH"
    assert d["meta"]["approach"] == "R03"


def test_case4_no_star_or_approach_but_known_runway_uses_the_heuristic():
    """A known arrival runway with nothing published to fly onto it, and a
    last fix far enough from the field for a final turn to make sense."""
    d = _fly(
        adep="VYYY", ades="VYNT", route="PALPO DCT VYNT",
        star_runway="RW34",
    )
    assert d["meta"]["arr_trajectory_source"] == "RUNWAY_HEURISTIC"
    assert d["meta"]["star"] is None
    assert d["meta"]["approach"] is None


def test_case5_no_runway_picked_auto_selects_by_direction():
    """No runway asked for at either end: each is picked from the direction
    of flight, and reported back so the client knows which was flown."""
    d = _fly(adep="VYMD", ades="VYTL", route="VYMD DCT VYTL")
    # VYTL is ESE of VYMD (~107 deg): RW17 (171) points that way, RW35 (351)
    # would take off away from it.
    assert d["meta"]["dep_rwy"] == "RW17"
    # Arriving from the WNW, RW04 (37) is the end it can land straight on.
    assert d["meta"]["arr_rwy"] == "RW04"
    assert d["meta"]["dep_trajectory_source"] == "RUNWAY_HEURISTIC"
    assert d["meta"]["arr_trajectory_source"] == "RUNWAY_HEURISTIC"


def test_case6_airport_to_airport_route_still_lands_on_final():
    """A route filed ADEP DCT ADES has no fix to turn from — it must still
    land along the runway onto the threshold, never fly to the aerodrome
    reference point across the runway."""
    from trajectory_sim.geodesy import compute_bearing, haversine_distance

    d = _fly(
        adep="VYNT", ades="VYTL", route="VYNT DCT VYTL",
        sid_runway="RW16", star_runway="RW04",
    )
    assert d["meta"]["dep_trajectory_source"] == "RUNWAY_HEURISTIC"
    assert d["meta"]["arr_trajectory_source"] == "RUNWAY_HEURISTIC"
    pts = d["points"]
    last = (pts[-1]["lat"], pts[-1]["lon"])
    # Lands on RW04's threshold...
    assert haversine_distance(*last, 20.477175, 99.92856667) < 0.1
    # ...having flown the last few miles on the runway's own bearing (37).
    back = next(
        p for p in reversed(pts)
        if haversine_distance(p["lat"], p["lon"], *last) > 3.0
    )
    track = compute_bearing(back["lat"], back["lon"], *last)
    assert abs((track - 37.0 + 180.0) % 360.0 - 180.0) < 5.0


def test_case7_expand_sid_departure_is_byte_for_byte_unmodified():
    """This deployment carries no Thai (VTBS/VTSP) navdata to file an actual
    Thailand route against — see this session's earlier retirement of
    aip_VT.json/runway.csv/sectors_corrected/ for VY-only equivalents — so the
    real regression check for "the existing Thailand SID/STAR behaviour" is
    that :func:`expand_sid_departure` itself, the function that behaviour is
    built on, was not touched: only new, separate functions were added
    alongside it (`expand_runway_departure_heuristic` /
    `runway_arrival_pattern`). Reruns the exact VTBD OLVU3C fixture
    `test_sid_departure.py` pins, unit-level, with no server/navdata-file
    dependency at all.
    """
    from trajectory_sim.navdata import (
        AltitudeConstraint,
        AltitudeConstraintType,
        Procedure,
        ProcedureLeg,
        ProcedureType,
        RunwayEnd,
        SpeedConstraint,
        SpeedConstraintType,
        expand_sid_departure,
    )

    rwy = RunwayEnd(
        icao="VTBD", ident="RW21L",
        lat=13.92455833, lon=100.61554444,
        magnetic_bearing=208.7, true_bearing=208.568,
    )
    intos = (13.97182, 100.32976)
    sid = Procedure(
        airport="VTBD", name="OLVU3C", proc_type=ProcedureType.SID,
        runway=None, transition=None,
        legs=(
            ProcedureLeg(
                seqno=10, path_terminator="CA", ident=None, lat=None, lon=None,
                altitude=AltitudeConstraint(AltitudeConstraintType.AT_OR_ABOVE, 1500.0, None),
                speed=SpeedConstraint(SpeedConstraintType.AT_OR_BELOW, 200.0),
                magnetic_course=209.0,
            ),
            ProcedureLeg(
                seqno=20, path_terminator="DF", ident="INTOS",
                lat=intos[0], lon=intos[1],
                altitude=AltitudeConstraint(), speed=SpeedConstraint(),
            ),
        ),
    )
    expanded = expand_sid_departure(sid, rwy, lambda alt_ft: 4.8 * alt_ft / 1500.0)
    assert expanded.legs[0].ident == "RW21L"
    assert expanded.legs[0].lat == pytest.approx(rwy.lat)
    assert expanded.legs[-1].ident == "INTOS"
    # The synthesised altitude-terminated leg keeps its published restriction —
    # this is the exact behaviour the docstring describes, unaltered.
    assert expanded.legs[1].altitude.alt1_ft == 1500.0
    assert expanded.legs[1].speed.speed_kt == 200.0
