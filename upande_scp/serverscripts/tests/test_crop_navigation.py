"""Each crop's desk section links to its own pages, not to roses'."""

import unittest

import frappe

from upande_scp.serverscripts.scouting import crop_navigation as CN


class TestCropNavigation(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.nav = {c["crop"]: c for c in CN.get_crop_navigation()}

	def test_every_scouted_crop_gets_a_section(self):
		crops = {
			(r.get("crop_name") or r["name"]).strip()
			for r in frappe.get_all("Crop Scouted", fields=["name", "crop_name"])
		}
		self.assertEqual(set(self.nav), crops)

	def test_a_crop_links_to_its_own_pages(self):
		"""The bug this replaces: seven tiles, all `#/rose/...`, shown to everyone."""
		for crop, entry in self.nav.items():
			for tile in entry["tiles"]:
				self.assertTrue(
					tile["href"].startswith(f"/scp_app#/{entry['slug']}/"),
					f"{crop}'s {tile['label']} points at {tile['href']}",
				)

	def test_avocado_offers_the_jobsheet_and_roses_the_application_plan(self):
		"""They plan differently: roses bed by bed through an approval queue,
		avocado by prescribing a block. Offering either crop the other's page is
		offering a page that crop does not have."""
		avocado = {t["label"] for t in self.nav["Avocado"]["tiles"]}
		rose = {t["label"] for t in self.nav["Rose"]["tiles"]}
		self.assertIn("Jobsheet", avocado)
		self.assertNotIn("Application Plan", avocado)
		self.assertIn("Application Plan", rose)
		self.assertNotIn("Jobsheet", rose)

	def test_every_crop_can_reach_its_own_settings(self):
		"""Settings became per-crop; the desk has to lead there."""
		for crop, entry in self.nav.items():
			views = {t["view"] for t in entry["tiles"]}
			self.assertIn("settings", views, f"{crop} has no route to its settings")

	def test_an_unknown_crop_still_gets_a_working_section(self):
		"""A crop this module has never heard of gets the generic scouting pages
		rather than an empty section — and never another crop's identity."""
		tiles = CN.CROP_TILES.get("Pineapple") or CN.DEFAULT_TILES
		self.assertEqual(tiles, CN.DEFAULT_TILES)
		self.assertIsNone(CN.CROP_MARKS.get("pineapple"))

	def test_marks_and_accents_match_the_crop_identity_colours(self):
		"""The desk, the app and the report emails have to agree on what colour a
		crop is, or the same crop is three colours in three places."""
		self.assertEqual(CN.CROP_MARKS["rose"], ("rose.png", "#a33a5b"))
		self.assertEqual(CN.CROP_MARKS["avocado"], ("avocado.png", "#5f7d33"))
		self.assertEqual(CN.CROP_MARKS["coffee"], ("coffee.png", "#6f4a2f"))
