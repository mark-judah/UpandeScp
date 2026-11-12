"""Farm / greenhouse filters of open_alerts and the Biologicals endpoints take
one name or several (JSON list / comma names). Filters are captured with mocks,
so no data is read or written."""
import json
import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.biologicals import mortality, release
from upande_scp.serverscripts.scouting import thresholds_check as tc


class TestOpenAlertsPlaces(unittest.TestCase):
	def setUp(self):
		frappe.flags.in_test = True

	def _filters(self, farm=None, greenhouse=None, scoped=None):
		with mock.patch.object(tc.crop_catalog, "resolve_crop", return_value="Rose"), \
			mock.patch.object(tc.crop_scope, "assert_crop"), \
			mock.patch.object(tc.crop_scope, "scoped_farms", return_value=scoped), \
			mock.patch.object(tc.frappe.db, "table_exists", return_value=True), \
			mock.patch.object(tc.frappe, "get_all", return_value=[]) as get_all:
			out = tc.open_alerts("Rose", farm, greenhouse)
		calls = [c for c in get_all.call_args_list if c.args and c.args[0] == tc.DOCTYPE]
		return out, (calls[0].kwargs["filters"] if calls else None)

	def test_single_names_stay_plain(self):
		_, f = self._filters("Chepsito", "Chepsito GH 01 - KR")
		self.assertEqual(f["farm"], "Chepsito")
		self.assertEqual(f["warehouse"], "Chepsito GH 01 - KR")

	def test_several_farms_and_houses(self):
		_, f = self._filters(json.dumps(["A", "B"]), "H1,H2")
		self.assertEqual(f["farm"], ["in", ["A", "B"]])
		self.assertEqual(f["warehouse"], ["in", ["H1", "H2"]])

	def test_farms_narrowed_to_the_users_own(self):
		_, f = self._filters(json.dumps(["A", "B"]), None, scoped={"B", "C"})
		self.assertEqual(f["farm"], "B")
		out, f = self._filters("A", None, scoped={"B"})
		self.assertEqual(out, [])
		self.assertIsNone(f)

	def test_no_farm_uses_the_users_farms(self):
		_, f = self._filters(None, None, scoped={"B", "A"})
		self.assertEqual(f["farm"], ["in", ["A", "B"]])
		_, f = self._filters("__all__", None, scoped={"A"})
		self.assertEqual(f["farm"], ["in", ["A"]])


class TestBiologicalsPlaces(unittest.TestCase):
	def setUp(self):
		frappe.flags.in_test = True

	def test_houses_named_win(self):
		self.assertEqual(mortality._houses(json.dumps(["H1", "H2"]), "A"), ["H1", "H2"])
		self.assertEqual(mortality._houses("H1"), ["H1"])

	def test_houses_of_several_farms(self):
		with mock.patch.object(mortality.frappe, "get_all", return_value=["H1"]) as g:
			mortality._houses(None, "A,B")
		self.assertEqual(g.call_args.kwargs["filters"], {"custom_farm": ["in", ["A", "B"]]})
		with mock.patch.object(mortality.frappe, "get_all", return_value=[]) as g:
			mortality._houses(None, None)
		self.assertEqual(g.call_args.kwargs["filters"], {"custom_farm": ["is", "set"]})

	def test_list_releases_filters(self):
		with mock.patch.object(release, "_scope", return_value={"farms": None}), \
			mock.patch.object(release.frappe, "get_all", return_value=[]) as g:
			release.list_releases(greenhouse=json.dumps(["H1", "H2"]), farm=json.dumps(["A", "B"]))
			f = g.call_args_list[0].kwargs["filters"]
		self.assertEqual(f["greenhouse"], ["in", ["H1", "H2"]])
		self.assertEqual(f["farm"], ["in", ["A", "B"]])
		with mock.patch.object(release, "_scope", return_value={"farms": None}), \
			mock.patch.object(release.frappe, "get_all", return_value=[]) as g:
			release.list_releases(greenhouse="H1", farm="A")
			f = g.call_args_list[0].kwargs["filters"]
		self.assertEqual((f["greenhouse"], f["farm"]), ("H1", "A"))
