"""Tests for SID/STAR procedure loading in navdata.py.

Procedure layers are supplied as in-memory DataFrame fixtures (dispatched by
layer name) so the tests do not depend on the real bearcat_navdata.gpkg.
The fixtures follow the ARINC 424 "DFD" schema the loader targets.
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import Point

from trajectory_sim.navdata import (
    AltitudeConstraintType,
    AmbiguousProcedureError,
    NavData,
    ProcedureNotFoundError,
    ProcedureType,
    SpeedConstraintType,
    parse_altitude_constraint,
    parse_speed_constraint,
)


# --- fixtures --------------------------------------------------------------


def _waypoints_gdf() -> gpd.GeoDataFrame:
    rows = [
        {"ident": "BIDAK", "name": "BIDAK", "type": "ENRT",
         "geometry": Point(96.3, 17.2)},
    ]
    return gpd.GeoDataFrame(rows, crs="EPSG:4326")


# SID BIDA2A at VYYY (synthetic, laid out around Yangon): two runway transitions (RW19L, RW19R), a common
# segment, and two enroute transitions (DAGAB, TONUS). The RW19L transition
# includes a fixless CA (Course-to-Altitude) leg.
_SID_ROWS = [
    # RW19L runway transition (route_type "1")
    dict(route_type="1", transition_identifier="RW19L", seqno=10,
         waypoint_identifier="SAVUS", waypoint_latitude=16.90,
         waypoint_longitude=96.10, path_termination="IF",
         altitude_description="", altitude1=None, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    dict(route_type="1", transition_identifier="RW19L", seqno=20,
         waypoint_identifier="", waypoint_latitude=None,
         waypoint_longitude=None, path_termination="CA",
         altitude_description="+", altitude1=1000, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    dict(route_type="1", transition_identifier="RW19L", seqno=30,
         waypoint_identifier="BIDAK", waypoint_latitude=17.20,
         waypoint_longitude=96.30, path_termination="TF",
         altitude_description="+", altitude1=4000, altitude2=None,
         speed_limit=250, speed_limit_description="-", turn_direction=""),
    # RW19R runway transition
    dict(route_type="1", transition_identifier="RW19R", seqno=10,
         waypoint_identifier="SAVUX", waypoint_latitude=16.91,
         waypoint_longitude=96.11, path_termination="IF",
         altitude_description="", altitude1=None, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    dict(route_type="1", transition_identifier="RW19R", seqno=30,
         waypoint_identifier="BIDAK", waypoint_latitude=17.20,
         waypoint_longitude=96.30, path_termination="TF",
         altitude_description="+", altitude1=4000, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    # Common segment (route_type "2")
    dict(route_type="2", transition_identifier="", seqno=40,
         waypoint_identifier="DOGAR", waypoint_latitude=17.50,
         waypoint_longitude=96.50, path_termination="TF",
         altitude_description="+", altitude1=8000, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    dict(route_type="2", transition_identifier="", seqno=50,
         waypoint_identifier="BIDA", waypoint_latitude=17.80,
         waypoint_longitude=96.70, path_termination="TF",
         altitude_description="", altitude1=None, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    # Enroute transition DAGAB (route_type "3")
    dict(route_type="3", transition_identifier="DAGAB", seqno=60,
         waypoint_identifier="DAGAB", waypoint_latitude=18.30,
         waypoint_longitude=97.20, path_termination="TF",
         altitude_description="", altitude1=None, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    # Enroute transition TONUS
    dict(route_type="3", transition_identifier="TONUS", seqno=60,
         waypoint_identifier="TONUS", waypoint_latitude=18.50,
         waypoint_longitude=97.40, path_termination="TF",
         altitude_description="", altitude1=None, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
]

# STAR SARI1A at VYYY (synthetic): enroute transition LADAR, common, runway RW01L.
_STAR_ROWS = [
    dict(route_type="1", transition_identifier="LADAR", seqno=10,
         waypoint_identifier="LADAR", waypoint_latitude=18.80,
         waypoint_longitude=96.40, path_termination="TF",
         altitude_description="", altitude1=None, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
    dict(route_type="2", transition_identifier="", seqno=20,
         waypoint_identifier="RECID", waypoint_latitude=18.10,
         waypoint_longitude=96.30, path_termination="TF",
         altitude_description="-", altitude1=11000, altitude2=None,
         speed_limit=280, speed_limit_description="", turn_direction=""),
    dict(route_type="3", transition_identifier="RW01L", seqno=30,
         waypoint_identifier="FINAL", waypoint_latitude=17.10,
         waypoint_longitude=96.15, path_termination="TF",
         altitude_description="@", altitude1=3000, altitude2=None,
         speed_limit=0, speed_limit_description="", turn_direction=""),
]


def _proc_df(rows: list[dict], airport: str, name: str) -> pd.DataFrame:
    return pd.DataFrame(
        [{"airport_identifier": airport, "procedure_identifier": name, **r}
         for r in rows]
    )


@pytest.fixture
def navdata(monkeypatch: pytest.MonkeyPatch) -> NavData:
    """NavData backed by in-memory waypoints + sids + stars layers."""
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
    return NavData("ignored.gpkg")


# --- constraint parsing (subtask 2) ----------------------------------------


def test_altitude_constraint_codes() -> None:
    assert parse_altitude_constraint("+", 5000, None).type is (
        AltitudeConstraintType.AT_OR_ABOVE
    )
    assert parse_altitude_constraint("-", 5000, None).type is (
        AltitudeConstraintType.AT_OR_BELOW
    )
    assert parse_altitude_constraint("@", 5000, None).type is (
        AltitudeConstraintType.AT
    )
    between = parse_altitude_constraint("B", 9000, 7000)
    assert between.type is AltitudeConstraintType.BETWEEN
    assert between.alt1_ft == 9000 and between.alt2_ft == 7000
    assert parse_altitude_constraint("", None, None).type is (
        AltitudeConstraintType.NONE
    )


def test_speed_constraint_codes() -> None:
    assert parse_speed_constraint("", 250).type is SpeedConstraintType.AT_OR_BELOW
    assert parse_speed_constraint("-", 250).type is SpeedConstraintType.AT_OR_BELOW
    assert parse_speed_constraint("+", 250).type is SpeedConstraintType.AT_OR_ABOVE
    assert parse_speed_constraint("@", 250).type is SpeedConstraintType.AT
    assert parse_speed_constraint("", 0).type is SpeedConstraintType.NONE


# --- procedure lookup (subtasks 1, 3, 4) -----------------------------------


def test_sid_lookup_assembles_runway_common_transition(navdata: NavData) -> None:
    proc = navdata.lookup_procedure(
        "VYYY", "BIDA2A", runway="RW19L", transition="DAGAB"
    )
    assert proc.proc_type is ProcedureType.SID
    assert proc.runway == "RW19L"
    assert proc.transition == "DAGAB"
    # Full leg order: runway (incl. fixless CA) -> common -> transition.
    assert [lg.ident for lg in proc.legs] == [
        "SAVUS", None, "BIDAK", "DOGAR", "BIDA", "DAGAB"
    ]
    # waypoints() drops the fixless CA leg.
    assert [w.ident for w in proc.waypoints()] == [
        "SAVUS", "BIDAK", "DOGAR", "BIDA", "DAGAB"
    ]


def test_sid_leg_constraints(navdata: NavData) -> None:
    proc = navdata.lookup_procedure(
        "VYYY", "BIDA2A", runway="RW19L", transition="DAGAB"
    )
    by_ident = {lg.ident: lg for lg in proc.legs}
    bidak = by_ident["BIDAK"]
    assert bidak.altitude.type is AltitudeConstraintType.AT_OR_ABOVE
    assert bidak.altitude.alt1_ft == 4000
    assert bidak.speed.type is SpeedConstraintType.AT_OR_BELOW
    assert bidak.speed.speed_kt == 250
    # The fixless CA leg keeps its altitude constraint but has no fix.
    ca = next(lg for lg in proc.legs if lg.path_terminator == "CA")
    assert not ca.has_fix
    assert ca.altitude.type is AltitudeConstraintType.AT_OR_ABOVE
    assert ca.altitude.alt1_ft == 1000


def test_runway_accepts_bare_designator(navdata: NavData) -> None:
    proc = navdata.lookup_procedure(
        "VYYY", "BIDA2A", runway="19L", transition="DAGAB"
    )
    assert proc.runway == "RW19L"


def test_ambiguous_runway_raises(navdata: NavData) -> None:
    with pytest.raises(AmbiguousProcedureError) as exc:
        navdata.lookup_procedure("VYYY", "BIDA2A", transition="DAGAB")
    assert exc.value.kind == "runway"
    assert set(exc.value.candidates) == {"RW19L", "RW19R"}


def test_ambiguous_transition_raises(navdata: NavData) -> None:
    with pytest.raises(AmbiguousProcedureError) as exc:
        navdata.lookup_procedure("VYYY", "BIDA2A", runway="RW19L")
    assert exc.value.kind == "transition"
    assert set(exc.value.candidates) == {"DAGAB", "TONUS"}


def test_unknown_runway_raises_not_found(navdata: NavData) -> None:
    with pytest.raises(ProcedureNotFoundError):
        navdata.lookup_procedure(
            "VYYY", "BIDA2A", runway="27", transition="DAGAB"
        )


def test_runway_both_group_matched_by_either_side() -> None:
    # A STAR that serves both parallels is coded with the ARINC "both"
    # suffix (one RW21B group for 21L/21R, per the AIP's single 21L/21R
    # chart). A request for either side must resolve to that group.
    both = {"RW21B": [], "RW03B": []}
    sel = NavData._select_group
    for req in ("RW21L", "RW21R", "21L"):
        assert sel("VYMD", "ENDU3A", both, req, "runway") == "RW21B"
    assert sel("VYMD", "ENDU3A", both, "RW03R", "runway") == "RW03B"
    # Back-compat: an explicit RW21B still matches.
    assert sel("VYMD", "ENDU3A", both, "RW21B", "runway") == "RW21B"


def test_runway_exact_side_wins_over_both_group() -> None:
    # When a real per-side group exists alongside a both-group, the exact
    # side is preferred (the B fallback only fires when no side matches).
    sel = NavData._select_group
    groups = {"RW21L": [], "RW21B": []}
    assert sel("X", "P", groups, "RW21L", "runway") == "RW21L"


def test_runway_both_fallback_does_not_cross_pairs() -> None:
    # The both-group fallback is keyed on the runway number, so a request
    # for a different pair with no matching group still raises.
    sel = NavData._select_group
    with pytest.raises(ProcedureNotFoundError):
        sel("X", "P", {"RW09B": []}, "RW27L", "runway")


def test_runway_named_common_legs_form_a_runway_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A "common" leg that names a runway is a RUNWAY leg.

    A DFD export can code each runway-specific SID variant as ONE
    route_type "5" group and state the runway only in
    transition_identifier — here KASN1B is the RW03L variant (a sibling
    would be the RW21L one). Read literally by route_type both are all-common, the
    procedure has no runway group at all, and a requested runway has nothing
    to be checked against: KASN1B resolved happily for RW21L, so the
    suggestion endpoint filed a SID off a runway it is not coded for.
    """
    import trajectory_sim.navdata as navdata_mod

    rows = [
        dict(route_type="5", transition_identifier="RW03L", seqno=10,
             waypoint_identifier="LIBRA", waypoint_latitude=17.00,
             waypoint_longitude=96.00, path_termination="TF",
             altitude_description="", altitude1=None, altitude2=None,
             speed_limit=0, speed_limit_description="", turn_direction=""),
    ]
    sids = _proc_df(rows, "VYMD", "KASN1B")

    def fake_read_file(path: object, layer: str) -> pd.DataFrame:
        if layer == "waypoints":
            return _waypoints_gdf()
        if layer == "sids":
            return sids.copy()
        if layer == "stars":
            return _proc_df([], "VYMD", "NONE")
        raise ValueError(f"no layer {layer}")

    monkeypatch.setattr(navdata_mod.gpd, "read_file", fake_read_file)
    nav = NavData("ignored.gpkg")

    # The runway it IS coded for resolves, and says so.
    proc = nav.lookup_procedure(
        "VYMD", "KASN1B", proc_type=ProcedureType.SID, runway="RW03L"
    )
    assert proc.runway == "RW03L"
    assert [w.ident for w in proc.waypoints()] == ["LIBRA"]
    # …and the other end of the field does not.
    with pytest.raises(ProcedureNotFoundError):
        nav.lookup_procedure(
            "VYMD", "KASN1B", proc_type=ProcedureType.SID, runway="RW21L"
        )
    # Asked for nothing in particular it still resolves — the reclassification
    # must not make a single-runway procedure unusable without a runway.
    assert nav.lookup_procedure(
        "VYMD", "KASN1B", proc_type=ProcedureType.SID
    ).runway == "RW03L"


def test_unknown_procedure_lists_available(navdata: NavData) -> None:
    with pytest.raises(ProcedureNotFoundError) as exc:
        navdata.lookup_procedure("VYYY", "NOPE9X")
    assert "BIDA2A" in exc.value.available


def test_star_assembles_transition_common_runway(navdata: NavData) -> None:
    proc = navdata.lookup_procedure(
        "VYYY", "SARI1A", runway="RW01L", transition="LADAR"
    )
    assert proc.proc_type is ProcedureType.STAR
    # STAR flies transition -> common -> runway.
    assert [w.ident for w in proc.waypoints()] == ["LADAR", "RECID", "FINAL"]
    recid = next(lg for lg in proc.legs if lg.ident == "RECID")
    assert recid.altitude.type is AltitudeConstraintType.AT_OR_BELOW
    assert recid.speed.type is SpeedConstraintType.AT_OR_BELOW


def test_list_procedures(navdata: NavData) -> None:
    assert navdata.list_procedures("VYYY") == ["BIDA2A", "SARI1A"]
    assert navdata.list_procedures("VYYY", ProcedureType.SID) == ["BIDA2A"]
    assert navdata.list_procedures("VYYY", ProcedureType.STAR) == ["SARI1A"]
    assert navdata.list_procedures("WSSS") == []


def test_procedures_loaded_lazily(monkeypatch: pytest.MonkeyPatch) -> None:
    """Procedure layers must not be read at construction — only on demand."""
    import trajectory_sim.navdata as navdata_mod

    layers_read: list[str] = []

    def fake_read_file(path: object, layer: str) -> pd.DataFrame:
        layers_read.append(layer)
        if layer == "waypoints":
            return _waypoints_gdf()
        if layer == "sids":
            return _proc_df(_SID_ROWS, "VYYY", "BIDA2A").copy()
        if layer == "stars":
            return _proc_df(_STAR_ROWS, "VYYY", "SARI1A").copy()
        raise ValueError(layer)

    monkeypatch.setattr(navdata_mod.gpd, "read_file", fake_read_file)
    nd = NavData("ignored.gpkg")
    assert layers_read == ["waypoints"]  # no procedure read yet
    nd.lookup_procedure("VYYY", "BIDA2A", runway="RW19L", transition="DAGAB")
    assert "sids" in layers_read and "stars" in layers_read


def test_missing_procedure_layers_is_not_fatal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A waypoints-only GeoPackage still works; procedures are just empty."""
    import trajectory_sim.navdata as navdata_mod

    def fake_read_file(path: object, layer: str) -> pd.DataFrame:
        if layer == "waypoints":
            return _waypoints_gdf()
        raise ValueError(f"no layer {layer}")  # sids/stars absent

    monkeypatch.setattr(navdata_mod.gpd, "read_file", fake_read_file)
    nd = NavData("ignored.gpkg")
    assert nd.list_procedures("VYYY") == []
    with pytest.raises(ProcedureNotFoundError):
        nd.lookup_procedure("VYYY", "BIDA2A")
