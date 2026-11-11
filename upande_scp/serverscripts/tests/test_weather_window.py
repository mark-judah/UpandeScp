"""Spray-window weather: the pure summary and the window logic with Open-Meteo
mocked. Plain pytest, no site network."""

import unittest
from datetime import date, datetime, timedelta
from unittest import mock

from upande_scp.serverscripts.common import weather_window as W


def day_rows(day, **over):
    base = {"temp": 15.0, "rh": 70.0, "dew": 9.0, "mm": 0.0, "prob": 5.0, "wind": 6.0, "gust": 10.0}
    rows = []
    for h in range(24):
        r = {"time": f"{day}T{h:02d}:00", **base}
        r.update({k: (v(h) if callable(v) else v) for k, v in over.items()})
        rows.append(r)
    return rows


class Summarize(unittest.TestCase):
    start = datetime(2026, 11, 12, 6, 0)

    def test_window_is_start_to_start_plus_hours(self):
        rows = day_rows("2026-11-12", temp=lambda h: float(h))
        s = W.summarize(rows, self.start, 4)
        # hours 06,07,08,09 only
        self.assertEqual((s["tempMin"], s["tempMax"]), (6.0, 9.0))
        self.assertEqual(s["window"]["end"], "2026-11-12 10:00")

    def test_calm_morning_has_no_flags(self):
        self.assertEqual(W.summarize(day_rows("2026-11-12"), self.start, 4)["flags"], [])

    def test_flags_are_warnings_by_threshold(self):
        rows = day_rows("2026-11-12", prob=60.0, wind=20.0, rh=92.0, dew=14.0)
        kinds = {f["kind"] for f in W.summarize(rows, self.start, 4)["flags"]}
        self.assertEqual(kinds, {"rain", "wind", "humidity", "dew"})

    def test_gust_alone_flags_wind(self):
        rows = day_rows("2026-11-12", gust=40.0)
        kinds = {f["kind"] for f in W.summarize(rows, self.start, 4)["flags"]}
        self.assertEqual(kinds, {"wind"})

    def test_no_rows_in_window(self):
        self.assertEqual(W.summarize(day_rows("2026-11-13"), self.start, 4)["status"], "unavailable")


class WindowWeather(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(W, "get_settings", return_value=dict(W.DEFAULTS))
        p.start()
        self.addCleanup(p.stop)

    def test_beyond_horizon(self):
        far = date.today() + timedelta(days=30)
        out = W.window_weather("Farm", datetime(far.year, far.month, far.day, 6))
        self.assertEqual(out["reason"], "beyond_horizon")
        self.assertIn("not available yet", out["message"])

    def test_no_coordinates(self):
        with mock.patch.object(W, "hourly_for", return_value=None), \
                mock.patch.object(W._w, "_farm_coords", return_value=None):
            out = W.window_weather("Farm", datetime.now() + timedelta(days=1))
        self.assertEqual(out["reason"], "no_coordinates")

    def test_ok_for_planned_day(self):
        d = date.today() + timedelta(days=1)
        with mock.patch.object(W, "hourly_for", return_value=day_rows(d.isoformat())):
            out = W.window_weather("Farm", datetime(d.year, d.month, d.day, 6))
        self.assertEqual(out["status"], "ok")
        self.assertFalse(out["past"])

    def test_window_across_midnight_uses_next_day(self):
        d = date.today() + timedelta(days=1)
        nxt = d + timedelta(days=1)
        calls = []

        def fake(farm, day):
            calls.append(day)
            return day_rows(day.isoformat())

        with mock.patch.object(W, "hourly_for", side_effect=fake):
            out = W.window_weather("Farm", datetime(d.year, d.month, d.day, 22), hours=4)
        self.assertEqual(calls, [d, nxt])
        self.assertEqual(out["status"], "ok")

    def test_date_only_means_six_in_the_morning(self):
        self.assertEqual(W._to_dt("2026-11-12").hour, 6)

    def test_endpoint_batches_items(self):
        d = date.today() + timedelta(days=1)
        with mock.patch.object(W, "hourly_for", return_value=day_rows(d.isoformat())):
            res = W.get_window_weather([{"key": "a", "farm": "F", "start": f"{d} 06:00:00"},
                                        {"key": "b", "farm": "", "start": f"{d} 06:00:00"}])
        self.assertEqual(res[0]["weather"]["status"], "ok")
        self.assertEqual(res[1]["weather"]["reason"], "no_farm")
