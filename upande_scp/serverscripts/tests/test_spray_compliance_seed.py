"""MoA seed. DB test — direct runner; rolled back."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import moa_seed as M


class TestSeed(unittest.TestCase):
	def tearDown(self):
		frappe.db.rollback()

	def test_seed_codes_use_master_naming(self):
		for row in M.SEED:
			for c in (row.get("frac_code"), row.get("irac_code")):
				if c:
					self.assertFalse(c.startswith("M0") or c.startswith("P0"), c)

	def test_seed_is_idempotent(self):
		M.seed(dry_run=False, commit=False)
		second = M.seed(dry_run=False, commit=False)
		self.assertEqual(second["created"], [])
		self.assertEqual(frappe.db.get_value("Active Ingredient MoA", "Azoxystrobin", "frac_code"), "11")
		self.assertEqual(frappe.db.get_value("Active Ingredient MoA", "Spinetoram", "irac_code"), "5")

	def test_store_keeper_can_read_moa_list(self):
		roles = {p.role: p for p in frappe.get_meta("Active Ingredient MoA").permissions}
		self.assertTrue(roles["SCP Chemical Store Keeper"].read)
		self.assertFalse(roles["SCP Chemical Store Keeper"].write)

	def test_dry_run_writes_nothing(self):
		before = frappe.db.count("Active Ingredient MoA")
		M.seed(dry_run=True)
		self.assertEqual(frappe.db.count("Active Ingredient MoA"), before)
