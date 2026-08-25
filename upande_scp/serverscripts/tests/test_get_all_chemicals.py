"""The spray picker must see foliars as well as chemicals.

`create_bom` filtered on the literals ["CHEMICALS", "Fertilizer"]. MariaDB's
case-insensitive collation forgave CHEMICALS -> Chemicals, but not
Fertilizer -> Fertilizers, so all 26 foliar items were invisible to the picker
and only one foliar line ever reached a tank mix.
"""

import inspect
import unittest


class TestGetAllChemicals(unittest.TestCase):
    def test_fertilizers_are_returned(self):
        from upande_scp.serverscripts.store.create_bom import getAllChemicals

        result = getAllChemicals()
        self.assertTrue(result["chemicals"], "no chemicals returned")
        self.assertTrue(
            result["fertilizers"],
            "no fertilizers returned — the item-group filter is wrong",
        )

    def test_no_hardcoded_group_literals_remain(self):
        from upande_scp.serverscripts.store import create_bom

        src = inspect.getsource(create_bom)
        for literal in ('"CHEMICALS"', "'CHEMICALS'", '"Fertilizer"', "'Fertilizer'"):
            self.assertNotIn(
                literal, src, f"hardcoded item group {literal} still present"
            )
