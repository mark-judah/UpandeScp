"""Trap location estimator — the pure rules. Plain pytest, no site."""

import math
import unittest

from upande_scp.serverscripts.traps import trap_geometry as G

LAT0, LNG0 = 0.0680, 35.7540
M_LAT = 1 / 111195.0  # ~1 m of latitude in degrees


def at(dx_m=0.0, dy_m=0.0, acc=2.0):
    """A fix dx metres east / dy metres north of the origin."""
    return (LAT0 + dy_m * M_LAT, LNG0 + dx_m * M_LAT / math.cos(math.radians(LAT0)), acc)


class TestStats(unittest.TestCase):
    def test_median_odd_even(self):
        self.assertEqual(G.median([3, 1, 2]), 2)
        self.assertEqual(G.median([4, 1, 2, 3]), 2.5)

    def test_percentile(self):
        self.assertEqual(G.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90), 10)
        self.assertEqual(G.percentile([5], 90), 5)

    def test_distance(self):
        a = at(0, 0)
        b = at(30, 40)
        self.assertAlmostEqual(G.distance_m(a[0], a[1], b[0], b[1]), 50.0, delta=0.05)


class TestEstimate(unittest.TestCase):
    def test_median_centre(self):
        est = G.estimate([at(-1), at(0), at(1), at(0, 1), at(0, -1)])
        self.assertIsNotNone(est)
        self.assertLess(G.distance_m(est["lat"], est["lng"], LAT0, LNG0), 0.01)
        self.assertEqual(est["fixes"], 5)

    def test_outlier_dropped(self):
        fixes = [at(0), at(1), at(-1), at(0, 1), at(200, 0)]
        est = G.estimate(fixes)
        self.assertEqual(est["fixes"], 4)
        self.assertEqual(est["dropped"], 1)
        self.assertLess(G.distance_m(est["lat"], est["lng"], LAT0, LNG0), 1.0)

    def test_inaccurate_fixes_ignored(self):
        fixes = [at(0), at(1), at(50, acc=6.0), at(60, acc=20.0)]
        self.assertIsNone(G.estimate(fixes))  # only 2 accurate → too few
        est = G.estimate(fixes + [at(-1)])
        self.assertEqual(est["fixes"], 3)

    def test_min_fixes(self):
        self.assertIsNone(G.estimate([at(0), at(1)]))
        self.assertIsNotNone(G.estimate([at(0), at(1), at(2)]))

    def test_too_few_after_outlier_drop(self):
        # median sits between the two clusters; nothing within 15 m survives
        self.assertIsNone(G.estimate([at(0), at(0), at(100), at(100)]))

    def test_bad_and_zero_rows_skipped(self):
        fixes = [at(0), at(1), at(2), (0, 0, 2), ("x", 1, 2), (None, None, None), (LAT0, LNG0, 0)]
        self.assertEqual(G.estimate(fixes)["fixes"], 3)

    def test_string_inputs(self):
        fixes = [tuple(str(v) for v in at(d)) for d in (0, 1, 2)]
        self.assertEqual(G.estimate(fixes)["fixes"], 3)

    def test_spread_is_p90(self):
        fixes = [at(d) for d in range(0, 11)]  # 0..10 m east; median at 5
        est = G.estimate(fixes)
        self.assertAlmostEqual(est["spread_m"], 5.0, delta=0.05)


class TestHouseDistance(unittest.TestCase):
    def line(self, x0, y0, x1, y1):
        a, b = at(x0, y0), at(x1, y1)
        return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {},
                "geometry": {"type": "LineString", "coordinates": [[a[1], a[0]], [b[1], b[0]]]}}]}

    def test_distance_to_zone_line(self):
        d = G.distance_to_geometries(LAT0, LNG0, [self.line(40, -10, 40, 10), self.line(-20, -5, -20, 5)])
        self.assertAlmostEqual(d, 20.0, delta=0.05)

    def test_json_string_and_empty(self):
        import json
        d = G.distance_to_geometries(LAT0, LNG0, [json.dumps(self.line(0, 10, 10, 10))])
        self.assertAlmostEqual(d, 10.0, delta=0.05)
        self.assertIsNone(G.distance_to_geometries(LAT0, LNG0, []))
        self.assertIsNone(G.distance_to_geometries(LAT0, LNG0, ["not json"]))

    def test_inside_polygon_is_zero(self):
        ring = [at(-10, -10), at(10, -10), at(10, 10), at(-10, 10), at(-10, -10)]
        poly = {"type": "Polygon", "coordinates": [[[p[1], p[0]] for p in ring]]}
        self.assertEqual(G.distance_to_geometries(LAT0, LNG0, [poly]), 0.0)
        far = at(0, 25)
        self.assertAlmostEqual(G.distance_to_geometries(far[0], far[1], [poly]), 15.0, delta=0.05)

    def test_flag_thresholds(self):
        self.assertEqual(G.flag_for(None, "Indoor"), "")
        self.assertEqual(G.flag_for(30.0, "Indoor"), "")
        self.assertEqual(G.flag_for(30.1, "Indoor"), "outside house")
        self.assertEqual(G.flag_for(31, None), "outside house")
        self.assertEqual(G.flag_for(99, "Outdoor"), "")
        self.assertEqual(G.flag_for(101, "Outdoor"), "outside house")


class TestGeojson(unittest.TestCase):
    def test_roundtrip(self):
        g = G.to_geojson(LAT0, LNG0, {"fixes": 4})
        self.assertEqual(g["type"], "FeatureCollection")
        self.assertEqual(g["features"][0]["geometry"]["coordinates"], [LNG0, LAT0])
        self.assertEqual(G.point_of(g), (LAT0, LNG0))
        import json
        self.assertEqual(G.point_of(json.dumps(g)), (LAT0, LNG0))
        self.assertIsNone(G.point_of(None))
