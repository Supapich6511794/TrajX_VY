"""End-to-end: a flight that only crosses the area must not start or end on the
ground at a fix, and a route filed between two Myanmar aerodromes must fly.

Both came from importing a surveillance-derived track file: FIR-crossing flights
filed only by their crossing fixes were generated ground-to-ground between two
fixes in mid-air (piling every flight that entered at the same fix onto one
point at 0 ft), and short domestic hops filed as "VYMD DCT VYTL" resolved to no
waypoints at all, because aerodromes are not significant points.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.server import app

client = TestClient(app)


def _fly(**kw):
    body = {
        "source": "fpl",
        "eobt": "2025-06-03T01:00:00",
        "callsign": "TST1",
        "actype": "A320",
        **kw,
    }
    r = client.post("/api/generate", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    alts = [p["altitude_ft"] for p in d["points"]]
    return d, alts


def test_route_between_two_myanmar_aerodromes_flies_ground_to_ground():
    d, alts = _fly(adep="VYMD", ades="VYTL", route="DCT VYMD DCT VYTL DCT", rfl=190)
    assert [w["ident"] for w in d["route"]] == ["VYMD", "VYTL"]
    assert alts[0] < 2000 and alts[-1] < 2000  # aerodrome elevations, not FL
    assert max(alts) == pytest.approx(19000, abs=100)


def test_foreign_departure_without_entry_level_starts_at_cruise_not_on_the_ground():
    # VIDP has no coordinates in the AIP; TEBOV is where the flight crosses in.
    d, alts = _fly(adep="VIDP", ades="VYYY", route="DCT TEBOV DCT VYYY DCT", rfl=330)
    assert alts[0] == pytest.approx(33000, abs=100)
    assert alts[-1] < 500  # …but it does land at VYYY


def test_overflight_stays_level_from_first_fix_to_last():
    d, alts = _fly(
        adep="OERK", ades="ZSPD", route="CHILA DCT LSO DCT LINSO", rfl=350, entry_fl=350
    )
    assert min(alts) == max(alts) == 35000


def test_entry_level_is_capped_at_what_the_airframe_can_reach():
    # A B744 cannot hold FL410; asking for it must not produce an impossible level.
    d, alts = _fly(
        actype="B744",
        adep="OMDW",
        ades="VHHH",
        route="CHILA DCT LSO DCT LINSO",
        rfl=410,
        entry_fl=410,
    )
    assert max(alts) < 41000
    assert min(alts) == max(alts)


def test_departure_to_a_foreign_field_ends_at_level_at_the_exit_fix():
    d, alts = _fly(adep="VYYY", ades="VTBS", route="DCT VYYY DCT TEBOV DCT", rfl=350)
    assert alts[0] < 500
    assert alts[-1] == pytest.approx(35000, abs=100)
