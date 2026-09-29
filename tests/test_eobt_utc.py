"""EOBT is UTC on the way in and on the way out.

The web field is labelled "EOBT (UTC)" and the browser renders it in the
user's locale, so 13:05 is shown as "01:05 PM". The value that travels is the
24-hour ``datetime-local`` string, and every consumer of it — the engine here,
and the PDR crossing times in the browser — has to read it as UTC.

A single local-time interpretation anywhere shifts every emitted timestamp by
the machine's offset (+06:30 in Myanmar), which makes an early-morning EOBT
behave like the previous evening. These pin both ends:

  * ``parse_eobt`` reads the string as UTC, naive or with a trailing Z;
  * the emitted ``epoch_ts`` values carry an explicit UTC offset, so the
    browser's ``Date.parse`` cannot fall back to reading them as local time.

01:05 and 13:05 on the same date are used throughout: they are the AM/PM pair
that the report was raised about, and any offset bug moves them differently.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import geopandas as gpd
import pytest
from shapely.geometry import Point

from trajectory_sim.fpl import parse_eobt

AM = "2026-07-08T01:05"
PM = "2026-07-08T13:05"


class TestParseEobt:
    def test_naive_morning_value_is_read_as_utc(self):
        assert parse_eobt(AM) == datetime(2026, 7, 8, 1, 5, tzinfo=timezone.utc)

    def test_naive_afternoon_value_is_read_as_utc(self):
        assert parse_eobt(PM) == datetime(2026, 7, 8, 13, 5, tzinfo=timezone.utc)

    def test_the_pair_is_exactly_twelve_hours_apart(self):
        assert parse_eobt(PM) - parse_eobt(AM) == timedelta(hours=12)

    def test_the_hour_survives_verbatim(self):
        # The AM/PM report: 01:05 PM must not come back as 01:05, and the
        # morning value must not come back as 13:05.
        assert parse_eobt(AM).hour == 1
        assert parse_eobt(PM).hour == 13

    @pytest.mark.parametrize(
        "raw",
        ["2026-07-08T13:05", "2026-07-08T13:05:00", "2026-07-08T13:05:00Z"],
    )
    def test_seconds_and_trailing_z_do_not_shift_it(self, raw):
        assert parse_eobt(raw) == datetime(2026, 7, 8, 13, 5, tzinfo=timezone.utc)

    def test_an_explicit_offset_is_converted_rather_than_ignored(self):
        # 20:05+07:00 IS 13:05Z. Honouring the offset is right; dropping it
        # would be the same class of bug from the other direction.
        assert parse_eobt("2026-07-08T20:05:00+07:00") == datetime(
            2026, 7, 8, 13, 5, tzinfo=timezone.utc
        )
        assert parse_eobt("2026-07-08T20:05:00+07:00").tzinfo is timezone.utc


class TestEmittedTimestamps:
    """The samples the API serialises must state their offset.

    ``ts.isoformat()`` on a tz-naive value produces "2026-07-08T13:05:00" with
    no offset, and JavaScript's ``Date.parse`` reads THAT as local time. The
    column therefore has to stay timezone-aware all the way through pandas.
    """

    @staticmethod
    def _frame(eobt_raw: str) -> gpd.GeoDataFrame:
        eobt = parse_eobt(eobt_raw)
        recs = [
            {
                "epoch_ts": eobt + timedelta(seconds=i * 5),
                "geometry": Point(100.6, 13.7),
            }
            for i in range(3)
        ]
        return gpd.GeoDataFrame(recs, geometry="geometry", crs="EPSG:4326")

    def test_the_column_stays_timezone_aware(self):
        gdf = self._frame(PM)
        assert str(gdf["epoch_ts"].dtype) == "datetime64[ns, UTC]"

    @pytest.mark.parametrize("raw,hour", [(AM, "01"), (PM, "13")])
    def test_isoformat_carries_an_explicit_utc_offset(self, raw, hour):
        gdf = self._frame(raw)
        first = gdf["epoch_ts"].iloc[0].isoformat()
        # Without the offset the browser would read this as local time.
        assert first.endswith("+00:00"), first
        assert f"T{hour}:05" in first, first

    def test_the_two_departures_stay_twelve_hours_apart(self):
        am = self._frame(AM)["epoch_ts"].iloc[0]
        pm = self._frame(PM)["epoch_ts"].iloc[0]
        assert pm - am == timedelta(hours=12)
