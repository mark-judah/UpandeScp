import unittest


class TestRowPayload(unittest.TestCase):
    def _mod(self):
        from upande_scp.serverscripts import get_orchard_trees as g
        return g

    def test_strip_trailing_int(self):
        g = self._mod()
        self.assertEqual(g._strip_trailing_int("BLK_ROW1_T10", 10), "BLK_ROW1_T")
        self.assertIsNone(g._strip_trailing_int("BLK_ROW1_T10", 9))

    def test_even_row_is_linear(self):
        g = self._mod()
        names = [f"R_T{i}" for i in range(1, 6)]
        coords = [(0.0, 0.0), (0.001, 0.0), (0.002, 0.0), (0.003, 0.0), (0.004, 0.0)]
        row = g._row_payload(names, coords)
        self.assertEqual(row["k"], "l")
        self.assertEqual(row["p"], "R_T")
        self.assertEqual(row["a"], [0.0, 0.0])
        self.assertEqual(row["b"], [0.004, 0.0])
        self.assertEqual(row["n"], 5)
        self.assertNotIn("c", row)

    def test_gapped_row_is_explicit(self):
        g = self._mod()
        # 4 trees clustered near the ends with a big empty middle (obstacle).
        names = [f"R_T{i}" for i in range(1, 5)]
        coords = [(0.0, 0.0), (0.0002, 0.0), (0.01, 0.0), (0.0102, 0.0)]
        row = g._row_payload(names, coords)
        self.assertEqual(row["k"], "e")
        self.assertEqual(row["n"], 4)
        self.assertEqual(row["c"], [0.0, 0.0, 0.0002, 0.0, 0.01, 0.0, 0.0102, 0.0])
        self.assertEqual(row["p"], "R_T")

    def test_bad_prefix_row_ships_names(self):
        g = self._mod()
        names = ["ALPHA", "BETA", "GAMMA"]  # not <prefix><n>
        coords = [(0.0, 0.0), (0.001, 0.0), (0.002, 0.0)]
        row = g._row_payload(names, coords)
        self.assertEqual(row["k"], "e")
        self.assertEqual(row["names"], ["ALPHA", "BETA", "GAMMA"])
        self.assertNotIn("p", row)

    def test_single_tree_is_explicit(self):
        g = self._mod()
        row = g._row_payload(["R_T1"], [(1.0, 2.0)])
        self.assertEqual(row["k"], "e")
        self.assertEqual(row["n"], 1)
        self.assertEqual(row["c"], [1.0, 2.0])
        self.assertEqual(row["names"], ["R_T1"])

    def test_empty_is_none(self):
        g = self._mod()
        self.assertIsNone(g._row_payload([], []))


from types import SimpleNamespace


def _tree(name, block, row, num, lng, lat):
    gj = '{"type":"Feature","geometry":{"type":"Point","coordinates":[%r,%r]}}' % (lng, lat)
    return SimpleNamespace(name=name, block=block, row=row, tree_number=num, raw_geojson=gj)


class TestRowsFromTrees(unittest.TestCase):
    def _mod(self):
        from upande_scp.serverscripts import get_orchard_trees as g
        return g

    def test_groups_and_orders_by_tree_number(self):
        g = self._mod()
        # Deliberately out of order and with string tree_numbers "1".."3".
        trees = [
            _tree("B_R1_T3", "B", "R1", "3", 0.002, 0.0),
            _tree("B_R1_T1", "B", "R1", "1", 0.0, 0.0),
            _tree("B_R1_T2", "B", "R1", "2", 0.001, 0.0),
        ]
        out = g._rows_from_trees(trees)
        self.assertEqual(len(out["rows"]), 1)
        row = out["rows"][0]
        self.assertEqual(row["k"], "l")
        self.assertEqual(row["p"], "B_R1_T")
        self.assertEqual(row["n"], 3)
        self.assertEqual(row["a"], [0.0, 0.0])
        self.assertEqual(row["b"], [0.002, 0.0])

    def test_two_rows_two_payloads(self):
        g = self._mod()
        trees = [
            _tree("B_R1_T1", "B", "R1", "1", 0.0, 0.0),
            _tree("B_R1_T2", "B", "R1", "2", 0.001, 0.0),
            _tree("B_R2_T1", "B", "R2", "1", 0.0, 0.01),
            _tree("B_R2_T2", "B", "R2", "2", 0.001, 0.01),
        ]
        out = g._rows_from_trees(trees)
        self.assertEqual(len(out["rows"]), 2)

    def test_skips_unparseable_geojson(self):
        g = self._mod()
        bad = SimpleNamespace(name="B_R1_T1", block="B", row="R1", tree_number="1", raw_geojson="not json")
        out = g._rows_from_trees([bad])
        self.assertEqual(out["rows"], [])


if __name__ == "__main__":
    unittest.main()
