"""Regression test for the curative-target "not observed" false negative.

mona imported `tabScouting Entry.zone` wrapped in literal double-quotes
(`"Main GH 08 - MFK - Bed 131 - Zone 8"`). A plain `zone LIKE 'Main GH 08%'`
prefix never matched, so curative targets that *were* scouted the same day were
rejected. `_observed_targets` must strip the wrapping quotes before matching.
"""
import unittest
from unittest import mock

from upande_scp.serverscripts.spray_plan_creator import validation as V


class TestObservedTargetsQuotedZone(unittest.TestCase):
    def test_query_is_quote_tolerant(self):
        with mock.patch.object(V, "frappe") as fake_frappe:
            fake_frappe.db.sql.return_value = [{"target": "Aphids"}]
            out = list(V._observed_targets("Main GH 08 - MFK", "2026-04-30", kind="pest"))

        query, params = fake_frappe.db.sql.call_args[0][0], fake_frappe.db.sql.call_args[0][1]
        # The fix: zone is normalised (wrapping quotes trimmed) before the LIKE,
        # so a double-quoted zone still matches the unquoted greenhouse prefix.
        self.assertIn('TRIM(BOTH \'"\' FROM parent.zone)', query)
        self.assertEqual(params[0], "Main GH 08 - MFK%")
        self.assertEqual(out, ["Aphids"])

    def test_blank_greenhouse_short_circuits(self):
        with mock.patch.object(V, "frappe") as fake_frappe:
            self.assertEqual(list(V._observed_targets("", "2026-04-30", kind="pest")), [])
            fake_frappe.db.sql.assert_not_called()
