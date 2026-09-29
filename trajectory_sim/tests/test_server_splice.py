"""Integration tests for the SID/STAR splice wiring in api.server.

These exercise the API boundary (`GenerateRequest` -> `_splice_terminal_
procedures`), not the pure splice itself — that lives in
``test_route_splice``. The procedures NavData is monkeypatched onto the same
in-memory DFD fixtures the navdata tests use, so no real GeoPackage/GeoJSON
is read.
"""

from __future__ import annotations

import pandas as pd
import pytest

import api.server as server
from trajectory_sim.navdata import NavData

from trajectory_sim.tests.test_navdata_procedures import (
    _SID_ROWS,
    _STAR_ROWS,
    _proc_df,
    _waypoints_gdf,
)


@pytest.fixture
def patched_navdata(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point ``server._navdata`` at the in-memory SID/STAR fixtures.

    SID BIDA2A and STAR SARI1A are both synthetic procedures at VYYY; we
    reuse VYYY as ADEP and ADES here only so the one fixture covers both
    ends.
    """
    import trajectory_sim.navdata as navdata_mod

    sids = _proc_df(_SID_ROWS, "VYYY", "BIDA2A")
    stars = _proc_df(_STAR_ROWS, "VYYY", "SARI1A")

    def fake_read_file(path: object, layer: str) -> pd.DataFrame:
        if layer == "waypoints":
            return _waypoints_gdf()
        if layer == "sids":
            return sids.copy()
        if layer == "stars":
            return stars.copy()
        raise ValueError(f"no layer {layer}")

    monkeypatch.setattr(navdata_mod.gpd, "read_file", fake_read_file)
    monkeypatch.setattr(server, "_navdata", lambda: NavData("ignored.gpkg"))


def _req(**kw: object) -> server.GenerateRequest:
    base = dict(
        source="fpl",
        adep="VYYY",
        ades="VYYY",
        route="DCT DAGAB DCT LADAR DCT",
        callsign="TEST",
        eobt="2026-01-03T08:15:00",
        rfl=330,
    )
    base.update(kw)
    return server.GenerateRequest(**base)  # type: ignore[arg-type]


def _idents(pts: list[tuple[str, float, float]]) -> list[str]:
    return [p[0] for p in pts]


def test_splice_inserts_sid_and_star(patched_navdata: None) -> None:
    warnings: list[str] = []
    enroute = [("DAGAB", 18.3, 97.2), ("LADAR", 18.8, 96.4)]
    out, _cons, _term, _path = server._splice_terminal_procedures(
        _req(sid="BIDA2A", star="SARI1A"), "VYYY", "VYYY", enroute, warnings
    )
    assert _idents(out) == [
        "SAVUS", "BIDAK", "DOGAR", "BIDA", "DAGAB",  # SID (DAGAB joined)
        "LADAR", "RECID", "FINAL",  # STAR (LADAR joined)
    ]


def test_proc_runway_derivation() -> None:
    """The export runway falls back to the RW* leg transition when the DFD
    encodes it there (route_type 5) and ``proc.runway`` is None."""

    class _Leg:
        def __init__(self, tr: str | None) -> None:
            self.transition = tr

    class _Proc:  # proc.runway None → derive from legs
        runway = None
        legs = (_Leg(None), _Leg("RW03L"), _Leg("RW03L"))

    class _ProcWithRunway:  # explicit proc.runway wins
        runway = "RW21R"
        legs = (_Leg("RW09"),)

    class _ProcNoRunway:  # nothing to derive
        runway = None
        legs = (_Leg(None),)

    assert server._proc_runway(_Proc()) == "RW03L"
    assert server._proc_runway(_ProcWithRunway()) == "RW21R"
    assert server._proc_runway(_ProcNoRunway()) is None
    assert server._proc_runway(None) is None


def test_no_procedures_passthrough(patched_navdata: None) -> None:
    """No SID/STAR/approach: the FIXES pass through untouched."""
    warnings: list[str] = []
    enroute = [("DAGAB", 18.3, 97.2), ("LADAR", 18.8, 96.4)]
    out, _cons, _term, path = server._splice_terminal_procedures(
        _req(), "VYYY", "VYYY", enroute, warnings
    )
    assert out == enroute
    assert not [w for w in warnings if "procedure" in w.lower()]
    # The PATH is not a passthrough even so: it is still anchored to the
    # aerodromes and its corners still turned. Only a procedure is optional —
    # departing, arriving and flying a turn are not.
    assert len(path) > len(enroute)


def test_a_route_that_never_reaches_the_destination_is_flagged(
    patched_navdata: None,
) -> None:
    """The fixture's route ends ~115 NM from VYYY, so closing it to the field
    means a long invented leg — a bad route, not a bad simulation, and the user
    is told which."""
    warnings: list[str] = []
    server._splice_terminal_procedures(
        _req(), "VYYY", "VYYY", [("DAGAB", 18.3, 97.2), ("LADAR", 18.8, 96.4)],
        warnings,
    )
    assert any("does not reach VYYY" in w for w in warnings)


def test_direct_route_still_carries_runways_for_elevation_anchor(
    patched_navdata: None,
) -> None:
    """A direct route (no SID/STAR/approach) must still forward the user-picked
    runways in the terminal dict, so the vertical profile anchors its climb
    start / descent end to the runway *threshold* elevation (AIP AD 2),
    not the aerodrome field elevation. Regression: the no-procedure early
    return used to drop the runways (returned ``{}``), silently reverting a
    direct VYMD(RW17)->VYYY(RW21) flight to field elevation."""
    warnings: list[str] = []
    enroute = [("DAGAB", 18.3, 97.2), ("LADAR", 18.8, 96.4)]
    out, _cons, term, _path = server._splice_terminal_procedures(
        _req(sid_runway="RW17", star_runway="RW21"),
        "VYMD", "VYYY", enroute, warnings,
    )
    assert out == enroute  # route itself untouched
    assert term["dep_rwy"] == "RW17"
    assert term["arr_rwy"] == "RW21"


def test_unknown_procedure_warns_and_keeps_route(patched_navdata: None) -> None:
    warnings: list[str] = []
    enroute = [("DAGAB", 18.3, 97.2), ("LADAR", 18.8, 96.4)]
    out, _cons, _term, _path = server._splice_terminal_procedures(
        _req(sid="NOPE9Z"), "VYYY", "VYYY", enroute, warnings
    )
    assert out == enroute  # unchanged
    assert any("NOPE9Z" in w and "skipped" in w for w in warnings)


def test_ambiguous_runway_auto_resolves_with_warning(
    patched_navdata: None,
) -> None:
    """BIDA2A has two runways; with none specified the server picks one and
    records the assumption rather than failing."""
    warnings: list[str] = []
    enroute = [("DAGAB", 18.3, 97.2)]
    out, _cons, _term, _path = server._splice_terminal_procedures(
        _req(sid="BIDA2A"), "VYYY", "VYYY", enroute, warnings
    )
    # A SID was spliced in (route grew past the single enroute fix)...
    assert len(out) > 1
    # ...and the auto-pick was reported.
    assert any("assumed" in w for w in warnings)
    # ...and the resolved runway is captured for the export, even though the
    # request left it on "Auto".
    assert _term["sid"] == "BIDA2A"
    assert _term["dep_rwy"]  # a concrete runway, not None/empty


def _final_gdf(alts: list[float]) -> object:
    """A tiny GeoDataFrame of a final approach down a meridian (POINT Z in m)."""
    import geopandas as gpd
    from datetime import datetime, timedelta, timezone
    from shapely.geometry import Point

    t0 = datetime(2026, 1, 3, 8, 0, tzinfo=timezone.utc)
    lats = [18.90 - 0.03 * i for i in range(len(alts))]  # marching south
    lons = [98.98] * len(alts)
    return gpd.GeoDataFrame(
        {
            "altitude_ft": list(alts),
            "epoch_ts": [t0 + timedelta(seconds=4 * i) for i in range(len(alts))],
            "geometry": [Point(lo, la, a * 0.3048) for la, lo, a in zip(lats, lons, alts)],
        },
        crs="EPSG:4326",
        geometry="geometry",
    )


def test_glide_to_threshold_lands_on_the_runway() -> None:
    """A flown approach that levels off ~50 ft above the runway (the MAPt's
    threshold-crossing altitude) is re-glided down to touch the threshold —
    the elevation the AIP AD 2 table publishes. Regression for an R18
    approach ending at 1086 ft instead of its 1036 ft threshold."""
    gdf = _final_gdf([3400.0, 2200.0, 1086.0, 1086.0, 1086.0])
    faf = (18.90, 98.98)  # first (highest) sample = start of the glide
    server._glide_to_threshold(gdf, faf, 1036.0)
    out = gdf["altitude_ft"].tolist()
    assert out[-1] == 1036.0  # lands on the threshold, not the +50 plateau
    assert out[0] == 3400.0  # glide starts at the FAF, unchanged
    assert all(out[i] >= out[i + 1] for i in range(len(out) - 1))  # monotone down
    # POINT Z (metres) tracks the corrected altitude.
    assert abs(gdf.geometry.iloc[-1].z - 1036.0 * 0.3048) < 1e-6


def test_glide_to_threshold_noop_when_already_landed() -> None:
    """When the descent already reaches the threshold, the glide leaves it be."""
    gdf = _final_gdf([2000.0, 1200.0, 1036.0])
    server._glide_to_threshold(gdf, (18.90, 98.98), 1036.0)
    assert gdf["altitude_ft"].tolist() == [2000.0, 1200.0, 1036.0]
