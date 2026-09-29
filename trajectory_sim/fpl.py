"""Flight plan model and route string parser.

Module 1, Phase 1 of the trajectory generator. Parses a simplified ICAO
flight plan (Item 15 route string) into an ordered list of waypoint
identifiers, ignoring connectors and airway designators. SID/STAR tokens
are flagged but discarded — they will be handled in Phase 4.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)


def parse_eobt(raw: str) -> datetime:
    """Parse an ISO-8601 EOBT string to a UTC-aware datetime.

    A trailing ``Z`` and naive values are both treated as UTC — the
    project-wide rule that all datetimes are UTC.
    """
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

# 2–5 uppercase letters: enroute fixes, VORs, NDBs, terminal waypoints
# (e.g. PARLA, VYYY, MIA). DCT/SID/STAR also match this shape and are
# filtered out explicitly before this regex is consulted.
_WAYPOINT_LETTER_RE = re.compile(r"^[A-Z]{2,5}$")

# ICAO lat/lon waypoint, e.g. "1330N10030E" → 13°30'N 100°30'E.
_LATLON_RE = re.compile(r"^\d{4}[NS]\d{5}[EW]$")

# Airway designator: 1–2 letters, digits, optional trailing letter.
# Examples: A1, M750, G458, UL637.
_AIRWAY_RE = re.compile(r"^[A-Z]{1,2}\d+[A-Z]?$")


@dataclass(frozen=True)
class FlightPlan:
    """Simplified ICAO flight plan.

    Attributes:
        callsign: ATC callsign, e.g. "THA204".
        aircraft_type: ICAO aircraft type designator, e.g. "B738".
        adep: ICAO departure airport, e.g. "VYYY".
        ades: ICAO destination airport, e.g. "VYMD".
        eobt: Estimated Off-Block Time. Must be timezone-aware UTC.
        rfl: Requested Flight Level in hundreds of feet, e.g. 330 → FL330.
        route: Raw Item 15 route string, e.g. "DCT KARBI A1 VIBUN DCT".
    """

    callsign: str
    aircraft_type: str
    adep: str
    ades: str
    eobt: datetime
    rfl: int
    route: str

    def __post_init__(self) -> None:
        if self.eobt.tzinfo is None or self.eobt.utcoffset() is None:
            raise ValueError("eobt must be timezone-aware (UTC)")
        if self.eobt.utcoffset() != timedelta(0):
            raise ValueError(
                f"eobt must be in UTC, got offset {self.eobt.utcoffset()}"
            )


def parse_route(route: str) -> list[str]:
    """Parse an Item 15 route string into an ordered list of waypoint idents.

    Discards the "DCT" connector and airway designators. Logs a warning for
    "SID" / "STAR" tokens (handled in Phase 4) and for any unrecognized
    tokens.

    Args:
        route: Raw route string, whitespace-separated tokens.

    Returns:
        Ordered list of waypoint identifier strings. Lat/lon waypoints
        (e.g. "1330N10030E") are preserved verbatim; named fixes are
        returned as their ICAO ident.
    """
    waypoints: list[str] = []
    for token in route.split():
        if token == "DCT":
            continue
        if token in {"SID", "STAR"}:
            logger.warning(
                "Route contains %s token — discarded for now, will be handled in Phase 4",
                token,
            )
            continue
        if _LATLON_RE.match(token):
            waypoints.append(token)
            continue
        if _AIRWAY_RE.match(token):
            logger.debug("Discarding airway designator %s", token)
            continue
        if _WAYPOINT_LETTER_RE.match(token):
            waypoints.append(token)
            continue
        logger.warning("Unrecognized route token %r — discarding", token)
    return waypoints
