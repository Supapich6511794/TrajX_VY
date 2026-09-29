"""Tests for joining a VOR-terminated enroute route to a STAR / PBN approach.

``api.server._connect_route_to_terminal`` trims a route that ends on the
destination's terminal VOR back to the fix that leads into the STAR/approach,
and locks that entry's transition — so the aircraft flies into the procedure
instead of out to the field VOR and back. The trim only fires when the route
actually ends on that field VOR (``_ends_at_field_vor``). Uses the real bundled
VY navdata (VYSW R29/R11 off W22 to STW, VYBG R36 off W14 to BGN, VYMD
STARs off V12/W13 to MIA); the one case the real data has no example of — an
approach IAF lying on the filed route — uses a small synthetic approach.
"""

from __future__ import annotations

import json
from pathlib import Path

import api.server as server
from trajectory_sim.navdata import NavData, ProcedureType


def _resolve_route(route_str: str) -> list[tuple[str, float, float]]:
    from trajectory_sim.fpl import parse_route

    idx = server._airway_waypoint_index()
    return [
        (i, *idx[i])
        for i in parse_route(server._expand_airways(route_str))
        if i in idx
    ]


def _connect(ades, name, route_str, proc_type=None, nav=None):
    nav = nav or server._navdata()
    route = _resolve_route(route_str)
    trimmed, trn = server._connect_route_to_terminal(
        nav, ades, name, proc_type or ProcedureType.APPROACH, None, route,
        warnings=[],
    )
    return [p[0] for p in trimmed], trn


def _worst_turn_deg(res: dict) -> float:
    trk = [s["track_deg"] for s in res["points"]]
    return max(
        abs((trk[i] - trk[i - 1] + 180) % 360 - 180) for i in range(1, len(trk))
    )


# --- a synthetic approach whose IAF sits ON the filed route -----------------
#: R35-X at VYMD: one IAF transition from HEHOO (a real fix on airway V12,
#: which runs KG - HHO - THAZI - HEHOO - MIA into Mandalay), one from a made-up
#: fix to the west, a common IF/FAF/MAPt on the RW35 centreline.
_HEHOO = (21.35544444, 96.27602778)
_SYNTH_APPROACH = [
    # (route_type, transition, seqno, ident, lat, lon, path_term, desc)
    ("A", "HEHOO", 10, "HEHOO", *_HEHOO, "IF", "E  A"),
    ("A", "HEHOO", 20, "SX901", 21.55, 96.00, "TF", "E"),
    ("A", "SX905", 10, "SX905", 21.55, 95.70, "IF", "E  A"),
    ("A", "SX905", 20, "SX901", 21.55, 96.00, "TF", "E"),
    ("R", None, 10, "SX901", 21.55, 96.00, "IF", "E  I"),
    ("R", None, 20, "SX902", 21.60, 95.99, "TF", "E  F"),
    ("R", None, 30, "RW35", 21.68203333, 95.98074444, "TF", "EY M"),
]


def _synthetic_navdata(tmp_path: Path) -> NavData:
    feats = [
        {
            "type": "Feature",
            "properties": {
                "airport_identifier": "VYMD",
                "procedure_identifier": "R35-X",
                "route_type": rt,
                "transition_identifier": tr,
                "seqno": seq,
                "waypoint_identifier": ident,
                "waypoint_latitude": lat,
                "waypoint_longitude": lon,
                "path_termination": pt,
                "waypoint_description_code": desc,
            },
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
        }
        for rt, tr, seq, ident, lat, lon, pt, desc in _SYNTH_APPROACH
    ]
    path = tmp_path / "approach.geojson"
    path.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}),
        encoding="utf-8",
    )
    return NavData(approach_source=path)


def test_route_fix_that_is_an_iaf_becomes_the_join(tmp_path: Path) -> None:
    """V12 passes through HEHOO (an R35-X IAF) on the way to the MIA VOR. The
    route ends at HEHOO, dropping MIA, and enters on the HEHOO transition."""
    nav = _synthetic_navdata(tmp_path)
    idents, trn = _connect("VYMD", "R35-X", "KG V12 MIA", nav=nav)
    assert idents[-1] == "HEHOO"
    assert "MIA" not in idents
    assert trn == "HEHOO"


def test_route_fix_that_is_a_star_entry_becomes_the_join() -> None:
    """The same shape in the real data: V12 passes THAZI, the entry of VYMD's
    THAZ1W, on the way to MIA — so the route ends there (dropping HEHOO and
    MIA) and joins the STAR at its entry."""
    idents, _trn = _connect("VYMD", "THAZ1W", "KG V12 MIA", ProcedureType.STAR)
    assert idents[-1] == "THAZI"
    assert "HEHOO" not in idents and "MIA" not in idents


def test_no_iaf_on_route_joins_the_nearest_entry() -> None:
    """The route ends on the BGN VOR and no fix is an R36 IAF. The entry on the
    arrival side nearest BGN is MAHAR, and the route fix nearest MAHAR is BITAL
    — so it ends at BITAL (dropping BGN) and enters on MAHAR."""
    idents, trn = _connect("VYBG", "R36", "TDE W14 BGN")
    assert idents[-1] == "BITAL"
    assert "BGN" not in idents
    assert trn == "MAHAR"


def test_entry_on_the_far_side_of_the_field_is_not_chosen() -> None:
    """R29's entries include WADIE, which sits nearest the STW VOR but ~100°
    off the arrival bearing — round the far side of the aerodrome from a route
    arriving from the east. Picking it (the old rule: simply the entry nearest
    the VOR) would fly the aircraft past the field and back — the
    doubling-back this trim exists to remove. The join must stay on the arrival
    side: AKYAB, from NPT."""
    idents, trn = _connect("VYSW", "R29", "NPT W22 STW")
    assert trn == "AKYAB"
    assert trn != "WADIE"  # far side of the field — would double back
    assert idents[-1] == "NPT"
    assert "STW" not in idents


def test_both_runways_join_from_the_same_route_fix() -> None:
    """The runway decides the approach flown, not where the route is cut: both
    of VYSW's approaches are joined from NPT. R29 has an entry on the arrival
    side (AKYAB); R11 has none, so it falls back to its entry nearest the field
    (BYALA) rather than refusing."""
    got = {rwy: _connect("VYSW", rwy, "NPT W22 STW") for rwy in ("R29", "R11")}
    assert got["R29"] == (["NPT"], "AKYAB")
    assert got["R11"] == (["NPT"], "BYALA")


def test_full_generate_flies_in_without_doubling_back() -> None:
    """End to end: the spliced route runs continuously into the approach (no
    sharp reversal) and lands on the runway."""
    req = server.GenerateRequest(
        callsign="T", actype="B738", adep="VYYY", ades="VYSW",
        eobt="2026-07-13T15:54:00Z", rfl=350, source="fpl",
        route="NPT W22 STW", star_runway="RW29", approach="R29",
        output_every_s=5,
    )
    res = server._generate_one(req)
    idents = [w["ident"] for w in res["route"]]
    assert idents[-3:] == ["SW901", "SITWE", "RW29"]  # into the final segment
    assert "STW" not in idents
    assert _worst_turn_deg(res) < 20.0  # no double-back corner


def test_star_route_ending_on_the_field_vor_is_trimmed() -> None:
    """VYMD's MIA VOR sits at the field, past every STAR entry, so a route filed
    to MIA doubles back. It is dropped and the route joins the STAR's entry
    (DOGIP for DOGI1W) from the fix before the VOR."""
    idents, _trn = _connect(
        "VYMD", "DOGI1W", "BGO W13 MIA", ProcedureType.STAR
    )
    assert "MIA" not in idents
    assert idents[-1] == "NPT"  # joins the STAR from the fix before the VOR
    # DOGI1W is single-entry (DOGIP), keyed on the runway, so there is no
    # separate enroute transition to force (trn is None); the STAR name is the
    # entry. The end-to-end test confirms it joins DOGIP cleanly.


def test_star_full_generate_drops_the_field_vor_backtrack() -> None:
    """End to end, VYMD DOGI1W off a MIA-ending route would reverse at MIA (the
    STAR starts 57 NM back south at DOGIP); dropping MIA removes the
    double-back."""
    req = server.GenerateRequest(
        callsign="T", actype="B738", adep="VYYY", ades="VYMD",
        eobt="2026-07-13T15:54:00Z", rfl=250, source="fpl",
        route="BGO W13 MIA", star="DOGI1W", star_runway="RW35",
        output_every_s=5,
    )
    res = server._generate_one(req)
    idents = [w["ident"] for w in res["route"]]
    assert "MIA" not in idents
    assert idents[-4:] == ["NPT", "DOGIP", "ZIDAW", "MDS02"]
    assert _worst_turn_deg(res) < 20.0


def test_field_vor_gate_ignores_a_non_vor_ending() -> None:
    """A route to VYMD ending on DOGIP (an ordinary fix, not a VOR) must not be
    trimmed — only routes filed to the field VOR are touched."""
    route = _resolve_route("NPT DCT DOGIP")
    assert route and route[-1][0] == "DOGIP"
    assert not server._ends_at_field_vor(route, "VYMD")


def test_field_vor_gate_ignores_a_distant_vor() -> None:
    """VYYY's nearest VOR, HGU, is ~12 NM out — a fix on the way, not the field
    navaid — so a route ending there is not a terminal-VOR overshoot."""
    route = _resolve_route("BGO DCT HGU")
    assert route and route[-1][0] == "HGU"
    assert not server._ends_at_field_vor(route, "VYYY")


def test_vor_that_is_itself_the_entry_is_kept() -> None:
    """VYSW's STW VOR is the entry of its D11 approach — a route to STW enters
    the approach there, so STW is kept, not dropped."""
    idents, trn = _connect("VYSW", "D11", "NPT W22 STW")
    assert idents[-1] == "STW"
    assert trn in ("STW1", "STW2")  # D11's two transitions both start at STW
