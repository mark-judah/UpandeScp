"""Readers of Scouting Entry coordinates tolerate null (entries saved without a GPS fix).

Point-less entries drop out of point layers but still count in per-block figures.

Run: bench --site mutara.local run-tests \
        --module upande_scp.serverscripts.tests.test_scouting_null_coordinates
"""

import unittest
from datetime import date, datetime, timedelta

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.reports import block_weekly_email as E
from upande_scp.serverscripts.scouting import cumulative_per_ha as C
from upande_scp.serverscripts.scouting import get_complete_scouting_entries as G
from upande_scp.serverscripts.scouting import tree_hot_spots as T
from upande_scp.serverscripts.tests.test_observation_gallery import insert, scouts

P1_BLOCK = "PH1-B1 - MUT"  # an Avocado (block crop) block
FARM_DAY = "2031-12-03"  # a Wednesday; no real scouting this far out


def _monday(day):
	d = datetime.strptime(day, "%Y-%m-%d").date()
	return d - timedelta(days=d.weekday())


class TestNullCoordinates(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.crop = "Avocado"
		self.scout = scouts(1)[0]
		self.name = insert(
			scout=self.scout, date=FARM_DAY, block=P1_BLOCK, crop=self.crop,
			pests=[("Thrips", "Adult", 3)], photos=[("Thrips", "thrips-null", 0)],
		)
		frappe.db.sql(
			"update `tabScouting Entry` set latitude = NULL, longitude = NULL where name = %s",
			self.name,
		)
		frappe.db.sql(
			"""update `tabScouting Entry` set row = NULL, tree = NULL where name = %s""", self.name
		)

	def tearDown(self):
		frappe.db.rollback()
		frappe.clear_cache()

	def test_complete_entries_reader_returns_the_entry(self):
		out = G._build_month_entries(FARM_DAY, FARM_DAY)
		row = next(e for e in out if e["name"] == self.name)
		self.assertFalse(row.get("latitude"))

	def test_photo_feed_lists_the_photo_with_blank_location(self):
		out = DA.photo_feed(crop=self.crop, from_date=FARM_DAY, to_date=FARM_DAY)
		photo = next(p for p in out["photos"] if p["caption"] == "thrips-null")
		self.assertEqual((photo["latitude"], photo["longitude"]), ("", ""))

	def test_block_weekly_email_builds_and_counts_the_entry(self):
		if not C.is_block_crop(self.crop):
			self.skipTest("P1 block is not a block crop here")
		monday = _monday(FARM_DAY)
		sunday = monday + timedelta(days=6)
		figs = C.round_figures(self.crop, [P1_BLOCK], monday, sunday)
		thrips = [f for f in figs.get(P1_BLOCK, []) if f["observation"] == "Thrips"]
		self.assertTrue(thrips, figs)
		self.assertEqual(thrips[0]["cumulative"], 3)
		self.assertIn(P1_BLOCK, C._scouted_blocks([P1_BLOCK], monday, sunday))
		farm = frappe.db.get_value("Warehouse", P1_BLOCK, "custom_farm")
		data = E.collect(self.crop, farm, monday)
		E.render(data)  # must not raise

	def test_tree_hot_spots_ignore_the_pointless_entry(self):
		if not C.is_block_crop(self.crop):
			self.skipTest("P1 block is not a block crop here")
		monday = _monday(FARM_DAY)
		spots = T.spots_for_week(self.crop, monday, [P1_BLOCK])
		self.assertEqual(spots, [])
