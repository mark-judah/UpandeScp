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


class TestFilterHash(unittest.TestCase):
    def test_same_inputs_same_hash(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import filter_hash
        h1 = filter_hash({"from_date": "2026-04-18", "to_date": "2026-05-18",
                          "crop": "Rose"})
        h2 = filter_hash({"crop": "Rose", "to_date": "2026-05-18",
                          "from_date": "2026-04-18"})  # different key order
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 20)

    def test_different_inputs_different_hash(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import filter_hash
        h1 = filter_hash({"crop": "Rose"})
        h2 = filter_hash({"crop": "Coffee"})
        self.assertNotEqual(h1, h2)


class TestSeverity(unittest.TestCase):
    def test_pest_severity_thresholds(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import pest_severity
        self.assertEqual(pest_severity(0), None)
        self.assertEqual(pest_severity(5), None)
        self.assertEqual(pest_severity(6), "moderate")
        self.assertEqual(pest_severity(15), "moderate")
        self.assertEqual(pest_severity(16), "high")

    def test_disease_severity_keywords(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import disease_severity
        self.assertEqual(disease_severity("High"), "high")
        self.assertEqual(disease_severity("severe outbreak"), "high")
        self.assertEqual(disease_severity("Active"), "high")
        self.assertEqual(disease_severity("Moderate"), "moderate")
        self.assertEqual(disease_severity("medium"), "moderate")
        self.assertEqual(disease_severity("low"), None)
        self.assertEqual(disease_severity(""), None)
        self.assertEqual(disease_severity(None), None)
