"""dew_point_series: the read-only feed of the Dew point page. The DB seams
(sensor map, readings, alerts) are mocked, so no sensor tables are needed."""

import unittest
from datetime import datetime, timedelta
from unittest import mock

import frappe

from upande_scp.serverscripts.common import condensation as C

END = datetime(2026, 11, 12, 12, 0)


def readings(dev, start, hours, temp, rh, step=10):
    out = []
    for i in range(int(hours * 60 / step)):
        ts = start + timedelta(minutes=i * step)
        out.append((dev, "Temperature", ts, temp))
        out.append((dev, "Humidity", ts, rh))
    return out


class DewPointSeries(unittest.TestCase):
    def setUp(self):
        frappe.flags.in_test = True

    def call(self, rows, mapping, farm_of=None, alerts=(), **kw):
        farm_of = farm_of or {"GH1 - KR": "Karen"}

        def get_all(doctype, **k):
            if doctype == C.MAP:
                return [frappe._dict(deveui=d, greenhouse=g) for d, g in mapping.items()]
            if doctype == "Warehouse":
                return [frappe._dict(name=n, custom_farm=f) for n, f in farm_of.items()]
            return list(alerts)

        with mock.patch.object(C, "sensors_available", return_value=True), \
                mock.patch.object(C, "get_settings", return_value=dict(C.DEFAULTS)), \
                mock.patch.object(C, "_cold_room_sensors", return_value=set()), \
                mock.patch.object(C, "_load_readings", return_value=rows), \
                mock.patch("frappe.get_all", side_effect=get_all), \
                mock.patch("frappe.db.table_exists", return_value=True), \
                mock.patch("frappe.utils.now_datetime", return_value=END):
            return C.dew_point_series(to_dt=END, **kw)

    def test_slots_summary_and_risk(self):
        # 3 h of saturated 12 C air (spread ~0) then 3 h of dry air (spread large).
        rows = readings("s1", END - timedelta(hours=6), 3, 12.0, 99.0) + readings("s1", END - timedelta(hours=3), 3, 12.0, 50.0)
        out = self.call(rows, {"s1": "GH1 - KR"})
        self.assertEqual(out["mapped_sensors"], 1)
        gh = out["greenhouses"][0]
        self.assertEqual((gh["greenhouse"], gh["label"], gh["farm"]), ("GH1 - KR", "GH1", "Karen"))
        self.assertEqual(len(gh["slots"]), 12)
        s = gh["slots"][0]
        self.assertTrue(s["risk"] and s["spread"] < 0.5)
        self.assertAlmostEqual(s["temp"] - s["dew_point"], s["spread"], places=1)
        self.assertFalse(gh["slots"][-1]["risk"])
        self.assertEqual(gh["summary"]["hours_at_risk"], 3.0)
        self.assertFalse(gh["summary"]["at_risk_now"])
        self.assertLess(gh["summary"]["min_spread"], 0.5)

    def test_at_risk_now_needs_a_recent_wet_slot(self):
        wet = readings("s1", END - timedelta(hours=3), 3, 12.0, 99.0)
        self.assertTrue(self.call(wet, {"s1": "GH1 - KR"})["greenhouses"][0]["summary"]["at_risk_now"])
        stale = readings("s1", END - timedelta(hours=9), 3, 12.0, 99.0)
        self.assertFalse(self.call(stale, {"s1": "GH1 - KR"})["greenhouses"][0]["summary"]["at_risk_now"])

    def test_range_capped_to_seven_days(self):
        out = self.call([], {"s1": "GH1 - KR"}, from_dt=END - timedelta(days=30))
        self.assertEqual(out["from"], (END - timedelta(days=C.MAX_RANGE_DAYS)).strftime("%Y-%m-%d %H:%M:%S"))

    def test_mapped_house_without_readings_is_listed_empty(self):
        gh = self.call([], {"s1": "GH1 - KR"})["greenhouses"][0]
        self.assertEqual(gh["slots"], [])
        self.assertIsNone(gh["summary"]["latest_reading"])

    def test_no_mapping_is_flagged(self):
        out = self.call([], {})
        self.assertEqual((out["mapped_sensors"], out["greenhouses"]), (0, []))

    def test_farm_filter_drops_other_farms(self):
        rows = readings("s1", END - timedelta(hours=2), 2, 12.0, 99.0)
        out = self.call(rows, {"s1": "GH1 - KR"}, farms='["Other"]')
        self.assertEqual(out["greenhouses"], [])

    def test_no_sensor_app_is_empty(self):
        with mock.patch.object(C, "sensors_available", return_value=False):
            out = C.dew_point_series()
        self.assertFalse(out["sensors_available"])
        self.assertEqual(out["greenhouses"], [])
