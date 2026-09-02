"""Per-site detection of the "bed is retired" flag.

`upande_core`'s `Bed` declares no such field. kaitet carries `custom_active`,
the v16 sites carry `status`, and a bare install carries neither — so naming one
of them in a query is a crash on the other. It was::

    MySQLdb.OperationalError: (1054, "Unknown column 'custom_active' in 'WHERE'")

from `get_beds_by_greenhouse`, which emptied the Application Plan's bed map and
left the area-to-spray permanently blank — the reported "spray plan doesn't pick
up the area".

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_bed_active_flag
"""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics as sm


def _has_column(present):
    """Fake `frappe.db.has_column` where only `present` columns exist on Bed."""

    def fake(doctype, column):
        if doctype != "Bed":
            return frappe.db.has_column(doctype, column)
        return column in present

    return fake


class TestBedActiveFlag(unittest.TestCase):
    def test_prefers_custom_active_when_present(self):
        with patch.object(frappe.db, "has_column", _has_column({"custom_active"})):
            self.assertEqual(sm._bed_active_flag()[0], "custom_active = 1")

    def test_falls_back_to_status(self):
        with patch.object(frappe.db, "has_column", _has_column({"status"})):
            self.assertEqual(sm._bed_active_flag()[0], "status != 'Uprooted'")

    def test_custom_active_wins_when_both_exist(self):
        """A site mid-migration may briefly carry both. Pick one deterministically
        rather than letting dict ordering decide."""
        with patch.object(frappe.db, "has_column", _has_column({"custom_active", "status"})):
            self.assertEqual(sm._bed_active_flag()[0], "custom_active = 1")

    def test_no_flag_counts_every_bed(self):
        """With nothing recording retirement there is nothing to exclude — and
        crucially, no column named in the SQL."""
        with patch.object(frappe.db, "has_column", _has_column(set())):
            self.assertIsNone(sm._bed_active_flag())
            self.assertEqual(sm.bed_active_filters(), {})

    def test_empty_beds_are_not_treated_as_retired(self):
        """An Empty bed has no crop in it right now but is still part of the
        greenhouse being sprayed. On a v16 site it is over a third of all beds,
        so excluding it would silently shrink every computed area."""
        with patch.object(frappe.db, "has_column", _has_column({"status"})):
            sql, filters = sm._bed_active_flag()
        self.assertNotIn("Empty", sql)
        self.assertEqual(filters, {"status": ("!=", "Uprooted")})

    def test_filters_form_matches_sql_form(self):
        for present in ({"custom_active"}, {"status"}):
            with patch.object(frappe.db, "has_column", _has_column(present)):
                flag = sm._bed_active_flag()
                self.assertEqual(sm.bed_active_filters(), flag[1])

    def test_filters_are_a_fresh_dict_each_call(self):
        """Callers splat this into a filters dict; a shared mutable would leak
        one query's filters into the next."""
        a = sm.bed_active_filters()
        a["greenhouse"] = "tampered"
        self.assertNotIn("greenhouse", sm.bed_active_filters())


class TestBedQueriesRunOnThisSite(unittest.TestCase):
    """The queries that crashed, executed against the real schema."""

    def test_get_beds_by_greenhouse_runs(self):
        result = sm.get_beds_by_greenhouse(active_only=True)
        self.assertIsInstance(result, dict)

    def test_get_beds_by_greenhouse_unfiltered_runs(self):
        self.assertIsInstance(sm.get_beds_by_greenhouse(active_only=False), dict)

    def test_bed_count_by_gh_runs(self):
        from upande_scp.serverscripts.common.cache_utils import build_bed_count_by_gh

        self.assertIsInstance(build_bed_count_by_gh(), dict)

    def test_active_filter_never_widens_the_result(self):
        active = sm.get_beds_by_greenhouse(active_only=True)
        every = sm.get_beds_by_greenhouse(active_only=False)
        self.assertLessEqual(
            sum(len(v) for v in active.values()),
            sum(len(v) for v in every.values()),
        )

    def test_beds_carry_the_area_the_spray_plan_needs(self):
        """The area chain is bed__area -> areaHa -> waterVolumeL -> stock_qty.
        A bed row without `bed__area` breaks it at the first link."""
        result = sm.get_beds_by_greenhouse(active_only=True)
        if not result:
            self.skipTest("no beds on this site")
        sample = next(iter(result.values()))[0]
        self.assertIn("bed__area", sample)
