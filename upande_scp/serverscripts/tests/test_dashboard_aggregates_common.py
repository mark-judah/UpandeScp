import unittest


class TestResolveGreenhouseScope(unittest.TestCase):
    def test_explicit_greenhouse_wins(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        farms_map = {"Karen Farm": ["GH 12", "GH 13"]}
        self.assertEqual(
            resolve_greenhouse_scope(greenhouse="GH 12", farm="Karen Farm",
                                     farms_map=farms_map),
            ["GH 12"],
        )

    def test_farm_expands_to_greenhouses(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        farms_map = {"Karen Farm": ["GH 12", "GH 13"]}
        self.assertEqual(
            resolve_greenhouse_scope(greenhouse="", farm="Karen Farm",
                                     farms_map=farms_map),
            ["GH 12", "GH 13"],
        )

    def test_both_empty_returns_none(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        farms_map = {"Karen Farm": ["GH 12"]}
        self.assertIsNone(
            resolve_greenhouse_scope(greenhouse="", farm="", farms_map=farms_map),
        )

    def test_unknown_farm_returns_empty_list(self):
        # Distinguishes "no filter" (None) from "filter excludes everything" ([]).
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        self.assertEqual(
            resolve_greenhouse_scope(greenhouse="", farm="Missing",
                                     farms_map={}),
            [],
        )
