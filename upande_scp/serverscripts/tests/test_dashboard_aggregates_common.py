import unittest
import unittest.mock
from unittest.mock import patch

import frappe


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

        fake_cache = unittest.mock.MagicMock()
        # First call: cache miss → compute → set_value
        fake_cache.get_value.return_value = None
        with patch.object(_common, "_build_key", return_value="key"), \
             patch.object(_common.frappe, "cache", return_value=fake_cache):
            v1 = _common.cached_aggregate("overview", {"a": 1}, compute, force=False)
        self.assertEqual(v1, {"x": 1})
        self.assertEqual(calls["n"], 1)
        # The get must use expires=True (so the wrapper doesn't memoize None
        # into frappe.local.cache and poison the next read).
        fake_cache.get_value.assert_called_once_with("key", expires=True)
        from upande_scp.serverscripts.dashboard_aggregates._common import DASH_AGG_TTL
        fake_cache.set_value.assert_called_once_with("key", {"x": 1},
                                                     expires_in_sec=DASH_AGG_TTL)

        # Second call: cache hit → no compute, no set
        fake_cache.reset_mock()
        fake_cache.get_value.return_value = {"x": 1}
        with patch.object(_common, "_build_key", return_value="key"), \
             patch.object(_common.frappe, "cache", return_value=fake_cache):
            v2 = _common.cached_aggregate("overview", {"a": 1}, compute, force=False)
        self.assertEqual(v2, {"x": 1})
        self.assertEqual(calls["n"], 1)  # compute still only called once total
        fake_cache.set_value.assert_not_called()

    def test_force_bypasses_cache(self):
        from upande_scp.serverscripts.dashboard_aggregates import _common

        def compute():
            return {"x": 2}

        fake_cache = unittest.mock.MagicMock()
        with patch.object(_common, "_build_key", return_value="key"), \
             patch.object(_common.frappe, "cache", return_value=fake_cache):
            v = _common.cached_aggregate("overview", {"a": 1}, compute, force=True)
        self.assertEqual(v, {"x": 2})
        fake_cache.get_value.assert_not_called()  # force path skips the read
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            DASH_AGG_TTL,
        )
        fake_cache.set_value.assert_called_once_with("key", {"x": 2},
                                                     expires_in_sec=DASH_AGG_TTL)


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


class TestJobProgress(unittest.TestCase):
    """Progress a *different request* can read.

    The realtime event this pairs with never arrives in the standalone /scp_app
    shell — it loads no socket.io bundle, so `frappe.realtime` is undefined and
    every publish is dropped. That is why the loader used to animate a simulated
    percentage. The cache path is what makes the number real, so what matters here
    is that a value written during one call is readable from another.
    """

    JOB = "_test_scp_job_progress"

    def tearDown(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            _progress_key,
        )
        frappe.cache().delete_value(_progress_key(self.JOB))

    def test_a_published_stage_is_readable_afterwards(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            job_progress,
            publish_progress,
        )
        publish_progress(self.JOB, 35, "loading observations")
        out = job_progress(self.JOB)
        self.assertEqual(out["percent"], 35)
        self.assertEqual(out["label"], "loading observations")

    def test_later_stages_overwrite_earlier_ones(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            job_progress,
            publish_progress,
        )
        publish_progress(self.JOB, 10, "resolving filters")
        publish_progress(self.JOB, 70, "loading trap rows")
        self.assertEqual(job_progress(self.JOB)["percent"], 70)

    def test_an_unknown_job_reports_nothing_rather_than_zero(self):
        """None is the signal for the bar to stay indeterminate. Returning 0 would
        make a warm-cache hit look like a load stuck at the start line."""
        from upande_scp.serverscripts.dashboard_aggregates._common import job_progress
        self.assertIsNone(job_progress("_test_scp_no_such_job"))
        self.assertIsNone(job_progress(None))
        self.assertIsNone(job_progress(""))

    def test_a_percent_outside_the_range_is_clamped(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            job_progress,
            publish_progress,
        )
        publish_progress(self.JOB, 250, "over")
        self.assertEqual(job_progress(self.JOB)["percent"], 100)
        publish_progress(self.JOB, -5, "under")
        self.assertEqual(job_progress(self.JOB)["percent"], 0)

    def test_no_job_id_writes_nothing(self):
        """Warm-cache hits pass no job id and must not leave a stray key behind."""
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            job_progress,
            publish_progress,
        )
        publish_progress("", 50, "ignored")
        publish_progress(None, 50, "ignored")
        self.assertIsNone(job_progress(""))
