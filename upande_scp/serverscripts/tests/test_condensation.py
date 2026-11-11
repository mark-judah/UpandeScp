"""Condensation risk: dew point, pairing, the 2 h rule, GPS placement and the
one-alert-per-house-per-day guarantee, with synthetic readings (no sensor
tables needed)."""

import unittest
from datetime import datetime, timedelta
from unittest import mock

from upande_scp.serverscripts.common import condensation as C

T0 = datetime(2026, 11, 12, 3, 0)


def square(lon, lat, size=0.0005):
    return [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]]


class Maths(unittest.TestCase):
    def test_dew_point_known_values(self):
        self.assertAlmostEqual(C.dew_point(20, 100), 20, places=1)
        self.assertAlmostEqual(C.dew_point(20, 50), 9.3, places=0)
        self.assertIsNone(C.dew_point(20, 0))
        self.assertIsNone(C.dew_point(20, None))

    def test_pairing_nearest_within_gap(self):
        temps = [(T0, 15.0), (T0 + timedelta(minutes=30), 16.0)]
        hums = [(T0 + timedelta(minutes=4), 90.0), (T0 + timedelta(minutes=20), 90.0)]
        got = C.pair_readings(temps, hums, 15)
        self.assertEqual([p[1] for p in got], [15.0, 16.0])
        # 20 min is 10 from the 30 min reading: paired; nothing beyond the gap
        self.assertEqual(C.pair_readings(temps, [(T0 + timedelta(hours=3), 90.0)], 15), [])


def series(hours, temp, rh, step=10):
    out = []
    n = int(hours * 60 / step)
    for i in range(n):
        out.append((T0 + timedelta(minutes=i * step), temp, rh))
    return out


class Rule(unittest.TestCase):
    def runs(self, pairs_by_sensor, hours=2.0, spread=2.0):
        return C.risk_runs(C.house_slots(pairs_by_sensor), spread, hours)

    def test_two_hours_near_dew_point_flags(self):
        r = self.runs({"s1": series(2.5, 12.0, 98.0)})
        self.assertEqual(len(r), 1)
        self.assertGreaterEqual(r[0]["hours"], 2.0)

    def test_under_two_hours_does_not(self):
        self.assertEqual(self.runs({"s1": series(1.0, 12.0, 98.0)}), [])

    def test_dry_air_does_not(self):
        self.assertEqual(self.runs({"s1": series(4, 20.0, 50.0)}), [])

    def test_gap_breaks_the_run(self):
        a = series(1.2, 12.0, 98.0)
        b = [(ts + timedelta(hours=3), t, rh) for ts, t, rh in series(1.2, 12.0, 98.0)]
        self.assertEqual(self.runs({"s1": a + b}), [])

    def test_one_faulty_sensor_does_not_raise_the_house(self):
        self.assertEqual(self.runs({"good": series(3, 20.0, 50.0), "bad": series(3, 12.0, 99.0)}), [])


class Geometry(unittest.TestCase):
    houses = {"GH1": C._rings({"type": "Polygon", "coordinates": square(34.0, 1.0)}),
              "GH2": C._rings({"type": "Polygon", "coordinates": square(34.002, 1.0)})}

    def test_inside(self):
        r = C.locate(34.00025, 1.00025, self.houses, 40)
        self.assertEqual((r["greenhouse"], r["method"]), ("GH1", "inside"))

    def test_nearest_within_distance(self):
        # ~11 m east of GH1's east edge (0.0001 deg ~ 11 m)
        r = C.locate(34.0006, 1.00025, self.houses, 40)
        self.assertEqual((r["greenhouse"], r["method"]), ("GH1", "nearest"))
        self.assertLess(r["distance_m"], 15)

    def test_too_far_stays_unmapped(self):
        r = C.locate(34.0011, 1.00025, self.houses, 40)
        self.assertIsNone(r["greenhouse"])

    def test_featurecollection_and_multipolygon(self):
        fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {
            "type": "MultiPolygon", "coordinates": [square(34.0, 1.0), square(34.1, 1.0)]}}]}
        self.assertEqual(len(C._rings(fc)), 2)
        self.assertEqual(C._rings("not json"), [])

    def test_hole_excludes(self):
        poly = [square(0, 0, 1.0)[0], [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]]
        self.assertFalse(C.in_polygon(0.5, 0.5, poly))
        self.assertTrue(C.in_polygon(0.1, 0.1, poly))

    def test_smallest_outline_wins_when_nested(self):
        h = {"big": C._rings({"type": "Polygon", "coordinates": square(0, 0, 1.0)}),
             "small": C._rings({"type": "Polygon", "coordinates": square(0.4, 0.4, 0.2)})}
        self.assertEqual(C.locate(0.5, 0.5, h, 40)["greenhouse"], "small")


class Alerts(unittest.TestCase):
    """raise_alerts with the DB seams mocked: one alert per house per day."""

    def setUp(self):
        self.created = []

        class Doc:
            def __init__(s, d):
                s.__dict__.update(d)
                s.name = "CA-1"

            def insert(s, **k):
                key = (s.greenhouse, s.alert_date)
                if key in seen:
                    import frappe
                    raise frappe.DuplicateEntryError("x", "y", "z")
                seen.add(key)
                made.append(s)

        seen, made = set(), self.created
        self.Doc = Doc
        pairs = {"s1": series(3, 12.0, 98.0)}
        slots = C.house_slots(pairs)
        self.runs = {"GH1": C.risk_runs(slots, 2.0, 2.0)}

    def go(self):
        import frappe

        cfg = dict(C.DEFAULTS)
        fake = mock.MagicMock()
        fake.DuplicateEntryError = frappe.DuplicateEntryError
        fake.get_doc.side_effect = self.Doc
        fake.db.get_value.return_value = "Farm"
        with mock.patch.object(C, "sensors_available", return_value=True), \
                mock.patch.object(C, "get_settings", return_value=cfg), \
                mock.patch.object(C, "evaluate_houses", return_value=self.runs), \
                mock.patch.object(C, "_notify", return_value=["a@x"]), \
                mock.patch.object(C, "frappe", fake):
            return C.raise_alerts()

    def test_second_run_same_day_is_silent(self):
        self.assertEqual(len(self.go()), 1)
        self.assertEqual(self.go(), [])
        self.assertEqual(len(self.created), 1)

    def test_disabled_or_no_tables_is_a_noop(self):
        with mock.patch.object(C, "sensors_available", return_value=False):
            self.assertEqual(C.raise_alerts(), [])
            self.assertIsNone(C.hourly())
