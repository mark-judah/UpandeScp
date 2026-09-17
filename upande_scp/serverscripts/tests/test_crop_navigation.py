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


class TestTileIcons(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self.nav = CN.get_crop_navigation()

	def test_every_tile_carries_a_mark_and_a_tint(self):
		"""A tile with no icon renders an empty chip — a hole in the grid rather
		than a missing decoration."""
		for entry in self.nav:
			for tile in entry["tiles"]:
				self.assertTrue(tile["icon"], f"{entry['crop']}/{tile['label']} has no icon")
				self.assertTrue(tile["tint"], f"{entry['crop']}/{tile['label']} has no tint")
				self.assertTrue(tile["colour"], f"{entry['crop']}/{tile['label']} has no colour")

	def test_the_icon_is_inner_markup_not_a_whole_svg(self):
		"""The block writes the <svg> wrapper so viewBox, stroke and width cannot
		drift between one tile and the next."""
		for entry in self.nav:
			for tile in entry["tiles"]:
				self.assertNotIn("<svg", tile["icon"])

	def test_the_original_seven_keep_the_colours_they_have_always_had(self):
		"""Roses users know these tiles. Re-pointing the links should not have
		repainted them."""
		self.assertEqual(CN.VIEW_ICONS["dashboard"][1:], ("rgba(59,130,246,.13)", "#3b82f6"))
		self.assertEqual(CN.VIEW_ICONS["scouting-map"][1:], ("rgba(34,197,94,.13)", "#16a34a"))
		self.assertEqual(CN.VIEW_ICONS["spraying"][1:], ("rgba(6,182,212,.13)", "#0891b2"))
		self.assertEqual(CN.VIEW_ICONS["application-plan"][1:], ("rgba(139,92,246,.13)", "#7c53e0"))
		self.assertEqual(CN.VIEW_ICONS["approvals"][1:], ("rgba(245,158,11,.13)", "#d97706"))
		self.assertEqual(CN.VIEW_ICONS["settings"][1:], ("rgba(100,116,139,.13)", "#64748b"))

	def test_a_view_with_no_icon_falls_back_rather_than_vanishing(self):
		tile = CN._tile("avocado", "some-future-view", "Future", "")
		self.assertEqual(
			(tile["icon"], tile["tint"], tile["colour"]),
			CN.FALLBACK_ICON,
		)
		self.assertEqual(tile["href"], "/scp_app#/avocado/some-future-view")
