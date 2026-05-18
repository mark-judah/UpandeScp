import unittest
import unittest.mock
from unittest.mock import patch


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


class TestCachedAggregate(unittest.TestCase):
    def test_cache_hit_skips_compute(self):
        from upande_scp.serverscripts.dashboard_aggregates import _common
        calls = {"n": 0}

        def compute():
            calls["n"] += 1
            return {"x": 1}

        with patch.object(_common, "get_or_set",
                          side_effect=lambda key, builder, ttl: builder()) as gs_miss, \
             patch.object(_common, "_build_key", return_value="key"):
            v1 = _common.cached_aggregate("overview", {"a": 1}, compute, force=False)
        self.assertEqual(v1, {"x": 1})
        self.assertEqual(calls["n"], 1)

        # Second call: get_or_set short-circuits and returns the cached value
        # without invoking builder.
        with patch.object(_common, "get_or_set",
                          return_value={"x": 1}) as gs_hit, \
             patch.object(_common, "_build_key", return_value="key"):
            v2 = _common.cached_aggregate("overview", {"a": 1}, compute, force=False)
        self.assertEqual(v2, {"x": 1})
        self.assertEqual(calls["n"], 1)  # compute still only called once total
        gs_hit.assert_called_once()

    def test_force_bypasses_cache(self):
        from upande_scp.serverscripts.dashboard_aggregates import _common

        def compute():
            return {"x": 2}

        fake_cache = unittest.mock.MagicMock()
        with patch.object(_common, "_build_key", return_value="key"), \
             patch.object(_common.frappe, "cache", return_value=fake_cache), \
             patch.object(_common, "get_or_set") as gs:
            v = _common.cached_aggregate("overview", {"a": 1}, compute, force=True)
        self.assertEqual(v, {"x": 2})
        gs.assert_not_called()              # force path skips get_or_set
        fake_cache.set_value.assert_called_once_with("key", {"x": 2},
                                                     expires_in_sec=120)


class TestParentFilterConditions(unittest.TestCase):
    def test_includes_date_range_always(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            parent_filter_conditions,
        )
        where, params = parent_filter_conditions("2026-04-18", "2026-05-18", "", None)
        self.assertIn("BETWEEN %(from_date)s AND %(to_date)s", where)
        self.assertEqual(params["from_date"], "2026-04-18")
        self.assertEqual(params["to_date"], "2026-05-18")

    def test_empty_scope_excludes_all(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            parent_filter_conditions,
        )
        where, params = parent_filter_conditions("2026-04-18", "2026-05-18", "",
                                                  greenhouse_scope=[])
        self.assertEqual(where, "1=0")
        self.assertEqual(params, {})

    def test_crop_clause_added(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            parent_filter_conditions,
        )
        where, params = parent_filter_conditions("2026-04-18", "2026-05-18",
                                                  "Rose", None)
        self.assertIn("se.crop_scouted = %(crop)s", where)
        self.assertEqual(params["crop"], "Rose")
