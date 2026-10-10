"""Spread and pins (piece 3c) — the pure rules. Plain pytest, no site."""

import json
import unittest

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import prevalence as P


def house(rows, cols):
    """A full rows × cols house: station "r:c" sits at rank (r, c)."""
    return {f"{r}:{c}": (r, c) for r in range(rows) for c in range(cols)}


RANKS = house(16, 12)
SQUARE = {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]]}


def at(*cells):
    return {f"{r}:{c}" for r, c in cells}


def rect(r0, c0, h, w):
    return [(r, c) for r in range(r0, r0 + h) for c in range(c0, c0 + w)]


def patch(*cells):
    return C.clusters(RANKS, at(*cells), limit=None)[0]


def changes(current, previous):
    found, gone = C.track(current, previous)
    return [(c["size"], c["change"], c["prev_size"]) for c in found], [(g["size"], g["change"]) for g in gone]


class TestClusters(unittest.TestCase):
    def test_diagonal_neighbours_join(self):
        found = C.clusters(RANKS, at((0, 0), (1, 1), (2, 2)))
        self.assertEqual([c["stations"] for c in found], [["0:0", "1:1", "2:2"]])

    def test_a_gap_of_one_rank_splits(self):
        found = C.clusters(RANKS, at(*rect(0, 0, 1, 3), *rect(0, 4, 1, 3)))
        self.assertEqual([(c["size"], c["cols"]) for c in found], [(3, (0, 2)), (3, (4, 6))])
        # Bed ranks 0 and 2 never touch, whatever their zones.
        self.assertEqual(C.clusters(RANKS, at((0, 0), (0, 1), (2, 0))), [])

    def test_fewer_than_three_stations_are_no_patch(self):
        self.assertEqual(C.MIN_SIZE, 3)
        self.assertEqual(C.clusters(RANKS, at((0, 0), (0, 1), (9, 9))), [])

    def test_only_the_five_largest_are_reported(self):
        cells = []
        for k, size in enumerate((3, 3, 4, 5, 3, 6)):
            cells += rect(2 * k, 0, 1, size)              # rows 0, 2, …, 10: never touching
        found = C.clusters(RANKS, at(*cells))
        self.assertEqual(C.TOP_N, 5)
        self.assertEqual([(c["size"], c["rows"][0]) for c in found], [(6, 10), (5, 6), (4, 4), (3, 0), (3, 2)])
        self.assertEqual(len(C.clusters(RANKS, at(*cells), limit=None)), 6)

    def test_a_patch_carries_its_shape(self):
        c = C.clusters(RANKS, at(*rect(2, 3, 2, 2)))[0]
        self.assertEqual((c["size"], c["centroid"], c["rows"], c["cols"]), (4, (2.5, 3.5), (2, 3), (3, 4)))

    def test_stations_without_a_rank_are_ignored(self):
        self.assertEqual(C.clusters(RANKS, at((0, 0), (0, 1)) | {"not-in-this-house"}), [])


class TestTrack(unittest.TestCase):
    def test_no_previous_week_means_new(self):
        self.assertEqual(changes([patch(*rect(0, 0, 1, 3))], []), ([(3, "New", None)], []))

    def test_grew_needs_a_quarter_and_three_stations(self):
        before = patch(*rect(0, 0, 2, 6))                                                  # 12
        self.assertEqual(changes([patch(*rect(0, 0, 3, 5))], [before])[0], [(15, "Grew", 12)])    # +3, +25 %
        self.assertEqual(changes([patch(*rect(0, 0, 2, 7))], [before])[0], [(14, "Stable", 12)])  # +2
        big = patch(*rect(0, 0, 4, 5))                                                     # 20
        self.assertEqual(changes([patch(*rect(0, 0, 4, 5), *rect(4, 0, 1, 3))], [big])[0],
                         [(23, "Stable", 20)])                                            # +3 but +15 %

    def test_shrank_mirrors_grew(self):
        before = patch(*rect(0, 0, 2, 6))                                                  # 12
        self.assertEqual(changes([patch(*rect(0, 0, 3, 3))], [before])[0], [(9, "Shrank", 12)])   # −3, −25 %
        self.assertEqual(changes([patch(*rect(0, 0, 2, 5))], [before])[0], [(10, "Stable", 12)])  # −2

    def test_matched_only_by_centroid_is_moved(self):
        before = patch(*rect(0, 0, 3, 1))                                                  # centroid (1, 0)
        self.assertEqual(changes([patch(*rect(0, 2, 3, 1))], [before]), ([(3, "Moved", 3)], []))
        self.assertEqual(changes([patch(*rect(0, 3, 3, 1))], [before]), ([(3, "New", None)], [(3, "Gone")]))

    def test_overlap_beats_a_centroid_match(self):
        a = patch(*rect(0, 0, 1, 3))                                                       # centroid (0, 1)
        b = patch(*rect(4, 0, 1, 3))                                                       # centroid (4, 1)
        t = patch((1, 0), (1, 1), (1, 2), (2, 1), (3, 1), (4, 1))                          # centroid (2, 1)
        self.assertEqual(changes([t], [a, b]), ([(6, "Grew", 3)], [(3, "Gone")]))
        self.assertEqual(C.track([t], [a, b])[1][0]["stations"], a["stations"])

    def test_a_split_patch_keeps_its_parent_and_nothing_is_gone(self):
        before = patch(*rect(0, 0, 1, 7))
        halves = [patch(*rect(0, 0, 1, 3)), patch(*rect(0, 4, 1, 3))]
        self.assertEqual(changes(halves, [before]), ([(3, "Shrank", 7), (3, "Shrank", 7)], []))

    def test_gone_lists_the_five_largest(self):
        previous = [patch(*rect(2 * k, 0, 1, 3 + k)) for k in range(6)]
        found, gone = C.track([], previous)
        self.assertEqual((found, [g["size"] for g in gone]), ([], [8, 7, 6, 5, 4]))


class TestLabels(unittest.TestCase):
    def test_labels_speak_beds_and_zones_or_rows_and_trees(self):
        self.assertEqual(C.label({"rows": (19, 23), "cols": (2, 6)}, "bed"), "beds 20–24, zones 3–7")
        self.assertEqual(C.label({"rows": (3, 5), "cols": (9, 14)}, "row"), "rows 4–6, trees 10–15")
        self.assertEqual(C.label({"rows": (4, 4), "cols": (2, 2)}, "bed"), "bed 5, zone 3")


class TestGeometry(unittest.TestCase):
    def test_point_in_polygon_reads_lng_lat(self):
        self.assertTrue(C.point_in_polygon((1.5, 0.5), SQUARE))
        self.assertFalse(C.point_in_polygon((0.5, 1.5), SQUARE))

    def test_holes_multipolygons_features_and_strings(self):
        holed = {"type": "Polygon", "coordinates": [[[0, 0], [4, 0], [4, 4], [0, 4]],
                                                    [[1, 1], [3, 1], [3, 3], [1, 3]]]}
        self.assertTrue(C.point_in_polygon((0.5, 0.5), holed))
        self.assertFalse(C.point_in_polygon((2, 2), holed))
        multi = {"type": "MultiPolygon",
                 "coordinates": [SQUARE["coordinates"], [[[10, 10], [11, 10], [11, 11], [10, 11]]]]}
        self.assertTrue(C.point_in_polygon((10.5, 10.5), multi))
        feature = json.dumps({"type": "Feature", "geometry": SQUARE})
        self.assertTrue(C.point_in_polygon((1, 0.5), feature))
        self.assertEqual(C.polygons("not json"), [])
        self.assertEqual(C.polygons({"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]}), [])

    def test_geometry_centroid_matches_the_maps(self):
        zone = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[35.0, 0.0], [35.2, 0.2]]}}]}
        lng, lat = C.geometry_centroid(zone)
        self.assertAlmostEqual(lng, 35.1)
        self.assertAlmostEqual(lat, 0.1)
        tree = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [34.85, 0.98]}}
        self.assertEqual(C.geometry_centroid(json.dumps(tree)), (34.85, 0.98))
        self.assertIsNone(C.geometry_centroid(None))
        self.assertIsNone(C.geometry_centroid("{}"))

    def test_stations_in_polygon(self):
        centroids = {"a": (0.5, 0.5), "b": (1.9, 0.9), "c": (2.5, 0.5)}
        self.assertEqual(C.stations_in_polygon(centroids, SQUARE), ["a", "b"])
        self.assertEqual(C.stations_in_polygon(centroids, None), [])


class TestPinRules(unittest.TestCase):
    def test_share_is_infested_over_scouted_among_the_pins_stations(self):
        stations = ["a", "b", "c", "d", "e", "f"]
        self.assertEqual(C.share(stations, set(stations) | {"x"}, {"a", "b", "x"}),
                         {"scouted": 6, "infested": 2, "value": 33.3, "thin": False})
        self.assertEqual(C.share(stations, {"a", "b", "c", "d"}, {"a"}),
                         {"scouted": 4, "infested": 1, "value": None, "thin": True})
        self.assertEqual(C.PIN_MIN_SCOUTED, 5)

    def test_a_rise_needs_ten_points_and_five_stations_both_weeks(self):
        def fig(v):
            return {"value": v}
        self.assertEqual(C.PIN_RISE_POINTS, 10)
        self.assertTrue(C.pin_rises(fig(50.0), fig(60.0)))
        self.assertFalse(C.pin_rises(fig(50.0), fig(59.9)))
        self.assertFalse(C.pin_rises(fig(None), fig(80.0)))
        self.assertFalse(C.pin_rises(fig(10.0), fig(None)))
        self.assertFalse(C.pin_rises(None, fig(80.0)))


class TestRanks(unittest.TestCase):
    def test_rank_positions_share_the_grids_order(self):
        stations = [
            {"name": f"B{b}-Z{z}", "group": f"Bed {b}", "group_no": b, "no": z}
            for b in (3, 1, 2, 10) for z in range(1, 2 + b)
        ]
        ranks = P.rank_positions(stations)
        grid = P.grid_positions(stations)
        self.assertEqual((ranks["B1-Z1"], ranks["B10-Z11"]), ((0, 0), (3, 10)))
        size: dict = {}
        for r, _c in ranks.values():
            size[r] = size.get(r, 0) + 1
        for name, (r, c) in ranks.items():
            self.assertEqual(grid[name], ((3 * r) // 4, (3 * c) // size[r]))

    def test_trees_rank_by_their_names_trailing_number(self):
        trees = [{"name": f"BLK1_ROW1_T{n}", "group": "Row 1", "group_no": 1,
                  "no": P.station_number(0, f"BLK1_ROW1_T{n}")} for n in (10, 2, 1)]
        self.assertEqual(P.rank_positions(trees),
                         {"BLK1_ROW1_T1": (0, 0), "BLK1_ROW1_T2": (0, 1), "BLK1_ROW1_T10": (0, 2)})
