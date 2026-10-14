"""The tank-mix Material Issue carries its spray plan, and history is back-linked.

``match`` is pure, so the rules are exercised without a database.
"""
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest import mock

from upande_scp.serverscripts.spray_plan_creator import auto_material_issue as AMI
from upande_scp.serverscripts.spray_plan_creator import issue_link as IL


def manu(wo, wh="GH1", day=1, item="MIX", qty=100, batches=()):
	return dict(wo=wo, item=item, wh=wh, qty=qty, dt=datetime(2026, 9, day, 8), batches=set(batches))


def issue(name, wh="GH1", day=2, item="MIX", qty=100, batches=(), remarks=""):
	return dict(name=name, remarks=remarks, item=item, wh=wh, qty=qty,
		dt=datetime(2026, 9, day, 17), batches=set(batches))


class TestMatch(unittest.TestCase):
	def test_direct_from_remarks(self):
		res, _ = IL.match([manu("WO-1", wh="GH9")], [issue("I1", wh="GH1", remarks="spray for WO-1.")])
		self.assertEqual(res["I1"], ("WO-1", IL.BASIS_DIRECT))

	def test_batch(self):
		ms = [manu("WO-1", batches=["B1"]), manu("WO-2", batches=["B2"])]
		res, _ = IL.match(ms, [issue("I1", batches=["B2"], wh="OTHER")])
		self.assertEqual(res["I1"], ("WO-2", IL.BASIS_BATCH))

	def test_greenhouse_and_date_nearest_first(self):
		ms = [manu("WO-1", day=1), manu("WO-2", day=3)]
		res, _ = IL.match(ms, [issue("I1", day=4)])
		self.assertEqual(res["I1"], ("WO-2", IL.BASIS_GREENHOUSE))

	def test_issue_before_manufacture_does_not_match(self):
		res, stats = IL.match([manu("WO-1", day=5)], [issue("I1", day=2)])
		self.assertEqual(res, {})
		self.assertEqual(stats["unmatched"], 1)

	def test_one_to_one(self):
		ms = [manu("WO-1", day=1), manu("WO-2", day=2)]
		res, _ = IL.match(ms, [issue("I1", day=3), issue("I2", day=4)])
		self.assertEqual({res["I1"][0], res["I2"][0]}, {"WO-1", "WO-2"})
		res, stats = IL.match([manu("WO-1")], [issue("I1", day=3), issue("I2", day=4)])
		self.assertEqual(list(res), ["I1"])
		self.assertEqual(stats["unmatched"], 1)

	def test_split_issue_may_match_twice(self):
		res, _ = IL.match([manu("WO-1", qty=100)], [issue("I1", qty=60), issue("I2", day=3, qty=40)])
		self.assertEqual({res["I1"][0], res["I2"][0]}, {"WO-1"})

	def test_no_false_link_across_greenhouses(self):
		res, _ = IL.match([manu("WO-1", wh="GH1")], [issue("I1", wh="GH2")])
		self.assertEqual(res, {})

	def test_ambiguous_tie_left_unlinked(self):
		ms = [manu("WO-1"), manu("WO-2")]
		res, stats = IL.match(ms, [issue("I1")])
		self.assertEqual(res, {})
		self.assertEqual(stats["ambiguous"], 1)

	def test_different_item_does_not_match(self):
		res, _ = IL.match([manu("WO-1", item="MIX-A")], [issue("I1", item="MIX-B")])
		self.assertEqual(res, {})


class TestNewIssueCarriesPlan(unittest.TestCase):
	def test_payload_has_plan_and_basis(self):
		manufacture = SimpleNamespace(
			to_warehouse="GH1", company="C", letter_head="", custom_location="", items=[SimpleNamespace(
				is_finished_item=1, item_code="MIX", item_name="Mix", description="",
				item_group="G", qty=10, transfer_qty=10, uom="L", stock_uom="L",
				conversion_factor=1)])
		wo = SimpleNamespace(name="WO-9", custom_cost_center="CC")
		with mock.patch.object(AMI.frappe.db, "get_value", return_value="FARM"), \
			mock.patch.object(AMI, "now_datetime", return_value=datetime(2026, 9, 1, 12)), \
			mock.patch.object(AMI, "resolve_expense_account", return_value="EXP"), \
			mock.patch.object(AMI.frappe, "get_meta", return_value=SimpleNamespace(get_field=lambda f: None)):
			p = AMI.build_material_issue(manufacture, wo, "EMP-1")
		self.assertEqual(p["custom_spray_plan"], "WO-9")
		self.assertEqual(p["custom_spray_link_basis"], "Direct")
