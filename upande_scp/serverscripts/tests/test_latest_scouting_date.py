import unittest
from types import SimpleNamespace
from unittest import mock

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics_api as api


class TestLatestScoutingDate(unittest.TestCase):
    def setUp(self):
        # frappe.db is an unbound LocalProxy in a no-site test context.
        # Bind a fake db object so mock.patch.object can target it.
        if not hasattr(frappe.local, "db") or frappe.local.db is None:
            frappe.local.db = SimpleNamespace(sql=lambda q, v=None: [[None]])

    def test_greenhouse_filtered_query(self):
        captured = {}

        def fake_sql(query, values=None):
            captured["query"] = query
            captured["values"] = values
            return [["2026-03-01"]]

        with mock.patch.object(api.frappe.db, "sql", side_effect=fake_sql):
            out = api.get_latest_scouting_date(greenhouse="Main GH 01 - MFK")

        self.assertEqual(out, "2026-03-01")
        self.assertIn("greenhouse", captured["query"].lower())
        self.assertEqual(captured["values"], ("Main GH 01 - MFK",))

    def test_no_greenhouse_sitewide(self):
        with mock.patch.object(api.frappe.db, "sql", return_value=[["2026-05-09"]]):
            self.assertEqual(api.get_latest_scouting_date(), "2026-05-09")

    def test_none_when_empty(self):
        with mock.patch.object(api.frappe.db, "sql", return_value=[[None]]):
            self.assertIsNone(api.get_latest_scouting_date(greenhouse="X"))
