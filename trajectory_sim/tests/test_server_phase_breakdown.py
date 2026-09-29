"""The climb/cruise/descent tiles must add up to the flight they describe.

``phase_breakdown`` measured each phase as the span from its FIRST to its LAST
sample. That is only the phase's duration while its samples are contiguous --
and they are not. On a route with altitude constraints, ``trajectory._phase_for``
re-derives the phase from the altitude trend, so a step up after a level-off is
labelled "climb" again well into the cruise. The climb's first-to-last span then
swallowed the cruise, and the reported AT76 leg read

    climb 52.2 + cruise 26.4 + descent 18.0 = 96.6 min

for a flight lasting 70 minutes, with a chart showing top-of-climb at ~20 min.

Each inter-sample interval is now charged to the phase of the sample that opens
it, so the three are a partition of the flight and sum to it exactly.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from api.server import app  # noqa: E402
from trajectory_sim.performance import time_to_climb_s  # noqa: E402

_PHASES = ("climb", "cruise", "descent")

#: The reported flight shape: an ATR 72-600 (AT76) off VYYY to VYMD, filed
#: FL250 (above the type's FL180 reachable ceiling) on a SID with altitude
#: constraints (PARL1A: at or above 13000 at GONAS, 16000 at YY911) -- the kind
#: of profile whose constraint level-offs can make the phase labels
#: non-contiguous. The partition must hold either way.
_AT76_LEG = {
    "source": "fpl",
    "callsign": "UBA211",
    "actype": "AT76",
    "adep": "VYYY",
    "ades": "VYMD",
    "route": "PARLA DCT NPT W13 MIA",
    "eobt": "2026-07-08T23:00",
    "rfl": 250,
    "sid": "PARL1A",
    "sid_runway": "RW21",
}


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def _generate(client: TestClient, **overrides: object) -> dict:
    resp = client.post("/api/generate", json={**_AT76_LEG, **overrides})
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestPhasesPartitionTheFlight:
    def test_the_three_phases_sum_to_the_total_flight_time(
        self, client: TestClient
    ) -> None:
        payload = _generate(client)
        breakdown = payload["profile"]["phase_breakdown"]
        total = sum(breakdown[p]["time_min"] or 0.0 for p in _PHASES)
        assert total == pytest.approx(payload["stats"]["time_minutes"], abs=0.1)

    def test_no_single_phase_outlasts_the_flight(
        self, client: TestClient
    ) -> None:
        """The old span measurement let climb alone exceed the whole leg."""
        payload = _generate(client)
        breakdown = payload["profile"]["phase_breakdown"]
        flight_min = payload["stats"]["time_minutes"]
        for phase in _PHASES:
            assert (breakdown[phase]["time_min"] or 0.0) <= flight_min + 0.1

    def test_the_climb_tile_is_the_climb_to_cruise_not_a_span(
        self, client: TestClient
    ) -> None:
        """It must equal the APM climb from the field to the cruise level --
        the number the altitude chart's top-of-climb marker shows."""
        payload = _generate(client)
        cruise_ft = payload["stats"]["cruise_alt_ft"]
        expected_min = time_to_climb_s("AT76", 0.0, cruise_ft) / 60.0
        got = payload["profile"]["phase_breakdown"]["climb"]["time_min"]
        assert got == pytest.approx(expected_min, abs=1.5)

    def test_it_still_partitions_without_a_constrained_sid(
        self, client: TestClient
    ) -> None:
        """Contiguous phases were always fine; keep them that way."""
        payload = _generate(client, sid=None, sid_runway=None)
        breakdown = payload["profile"]["phase_breakdown"]
        total = sum(breakdown[p]["time_min"] or 0.0 for p in _PHASES)
        assert total == pytest.approx(payload["stats"]["time_minutes"], abs=0.1)


class TestTheFlightTimeCheckUsesTheRightAircraft:
    def test_the_atr72_leg_passes_its_own_reference(
        self, client: TestClient
    ) -> None:
        """It used to FAIL by +21 min against a B738 curve."""
        payload = _generate(client)
        validation = payload["validation"]
        assert validation is not None
        assert validation["status"] == "PASS", validation

    def test_an_unsupported_airframe_gets_no_verdict_at_all(
        self, client: TestClient
    ) -> None:
        """Rather than one computed from a substituted B738."""
        payload = _generate(client, actype="ZZZZ", sid=None, sid_runway=None)
        assert payload["validation"] is None


class TestTheFlightTimeCurveEndpoint:
    """What the route picker interpolates -- it must not hand the client a
    737 curve under another type's name."""

    def test_a_supported_type_returns_a_rising_curve(
        self, client: TestClient
    ) -> None:
        body = client.get(
            "/api/flight_time_curve", params={"actype": "AT76", "cruise_alt_ft": 18000}
        ).json()
        assert body["supported"] is True
        assert body["dataset"].startswith("Thai APM")
        minutes = [m for _d, m in body["points"]]
        assert minutes == sorted(minutes)

    def test_the_curve_differs_between_a_turboprop_and_a_jet(
        self, client: TestClient
    ) -> None:
        def at(actype: str, alt: int) -> dict[float, float]:
            body = client.get(
                "/api/flight_time_curve",
                params={"actype": actype, "cruise_alt_ft": alt},
            ).json()
            return {d: m for d, m in body["points"]}

        atr, jet = at("AT76", 18000), at("B738", 35000)
        assert atr[320] - jet[320] > 15.0

    def test_an_unsupported_type_is_refused_not_approximated(
        self, client: TestClient
    ) -> None:
        body = client.get(
            "/api/flight_time_curve", params={"actype": "SF34"}
        ).json()
        assert body["supported"] is False
        assert body["points"] == []
        assert "B738" in body["reason"]
