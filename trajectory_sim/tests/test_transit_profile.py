"""A flight only PASSING THROUGH the area must not climb from / descend to the
ground at its first / last fix.

`build_flight_timeline` used to derive the profile's start and end altitude from
the aerodromes alone, so an FIR-crossing track filed only by its crossing fixes
was generated as a ground-to-ground flight between two fixes that are nowhere
near an aerodrome — every aircraft entering at the same fix started at 0 ft on
top of the others.
"""

from __future__ import annotations

from datetime import datetime, timezone

from trajectory_sim.trajectory import build_flight_timeline

# ~250 NM of eastbound track, well clear of any aerodrome the tool knows.
WAYPOINTS = [(22.4, 92.7), (22.8, 96.1), (23.4, 98.9)]
EOBT = datetime(2025, 6, 3, 0, 2, tzinfo=timezone.utc)


def _timeline(**kw):
    return build_flight_timeline(
        waypoint_sequence=WAYPOINTS,
        aircraft_type="A332",
        adep="OERK",
        ades="ZSPD",
        rfl_ft=35000.0,
        eobt=EOBT,
        **kw,
    )


def test_default_flight_still_starts_and_ends_on_the_ground():
    tl = _timeline()
    assert tl.samples[0].altitude_ft < 500
    assert tl.samples[-1].altitude_ft < 500


def test_transit_flight_is_at_its_level_from_the_first_fix_to_the_last():
    tl = _timeline(dep_elev_ft=35000.0, des_elev_ft=35000.0)
    alts = [s.altitude_ft for s in tl.samples]
    assert min(alts) == 35000.0 and max(alts) == 35000.0


def test_transit_flight_is_shorter_than_the_same_flight_from_the_ground():
    ground = _timeline()
    transit = _timeline(dep_elev_ft=35000.0, des_elev_ft=35000.0)
    assert transit.samples[-1].epoch_ts < ground.samples[-1].epoch_ts


def test_arrival_can_start_at_level_and_still_land():
    tl = _timeline(dep_elev_ft=35000.0, des_elev_ft=110.0)
    assert tl.samples[0].altitude_ft == 35000.0
    assert tl.samples[-1].altitude_ft < 500
