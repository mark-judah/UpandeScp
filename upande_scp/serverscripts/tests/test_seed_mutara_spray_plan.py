"""Mutara spray-plan seed: the data is consistent, and the two open-field fixes it exposed hold
(a block's crop is what is planted there; a curative target counts when it was scouted on the block).

Run: bench --site mutara.local run-tests --app upande_scp \
        --module upande_scp.serverscripts.tests.test_seed_mutara_spray_plan
"""

import unittest

import frappe
from frappe.utils import add_days, nowdate

from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.migrate import seed_mutara_spray_plan as S
from upande_scp.serverscripts.spray_plan_creator import validation as V


class TestSeedData(unittest.TestCase):
	def test_every_mix_ingredient_has_a_positive_rate(self):
		for name, parts in S.MIXES.items():
			self.assertGreaterEqual(len(parts), 2, name)
			self.assertTrue(all(rate > 0 for _, rate in parts), name)

	def test_team_names_carry_the_farm_name(self):
		self.assertTrue(all(S.FARM.lower() in t.lower() for t in S.TEAMS))

	def test_targets_never_list_an_empty_product(self):
		for item, (pests, diseases) in S.TARGETS.items():
			self.assertTrue(pests or diseases, item)

	def test_second_run_creates_nothing(self):
		if not frappe.db.exists("Farm", S.FARM) or not frappe.db.exists("Spray Team", S.TEAMS[0]):
			self.skipTest("Mutara spray-plan seed not applied on this site")
		self.assertEqual(S.run(dry_run=True), {})


class TestOpenFieldCrop(unittest.TestCase):
	def test_block_crop_is_what_is_planted_not_the_farm_crop(self):
		if not frappe.db.exists("Warehouse", "P1-B1 - MUT"):
			self.skipTest("Mutara block tree absent")
		from upande_scp.serverscripts.common import planting

		planted = planting.crop_for_station("P1-B1 - MUT")
		if not planted:
			self.skipTest("P1-B1 has no planting")
		self.assertEqual(crop_catalog.crop_for_greenhouse("P1-B1 - MUT"), planted)

	def test_observed_targets_read_block_entries(self):
		rows = frappe.db.sql(
			"""select se.block, p.pest from `tabScouting Entry` se
			   join `tabPests Scouting Entry` p on p.parent = se.name
			   where se.block is not null and se.block != '' and se.date_of_capture >= %s limit 1""",
			(add_days(nowdate(), -60),), as_dict=True,
		)
		if not rows:
			self.skipTest("no block scouting on this site")
		seen = V._observed_targets(rows[0].block, add_days(nowdate(), -60), kind="pest")
		self.assertIn(rows[0].pest, list(seen))
