"""Per-crop spray-plan overrides: what a crop may differ on, and what it inherits.

Run directly (`bench run-tests` is broken on this bench):

    cd sites && ../env/bin/python -c "import frappe, unittest; \
        frappe.init(site='kaitet.local'); frappe.connect(); \
        frappe.set_user('Administrator'); \
        from upande_scp.serverscripts.tests import test_crop_settings as T; \
        unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(T))"

Every test puts the overrides back, because these write to a real Single that
the rest of the site reads.
"""

import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import crop_settings as CS


class _RestoresOverrides(unittest.TestCase):
	"""Snapshot this crop's overrides and put them back, whatever the test did."""

	CROP = "Avocado"

	def setUp(self):
		frappe.set_user("Administrator")
		self._before = CS.overrides_for(self.CROP)

	def tearDown(self):
		CS.replace_overrides(self.CROP, self._before)


class TestInheritance(_RestoresOverrides):
	def test_a_crop_with_no_override_inherits_the_site_default(self):
		CS.replace_overrides(self.CROP, {})
		r = CS.resolve(self.CROP)
		self.assertEqual(r["overridden"], [])
		self.assertEqual(r["effective"], r["defaults"])

	def test_an_override_changes_only_that_crop(self):
		CS.replace_overrides(self.CROP, {"weather_wind_red_min_kmh": "25"})
		self.assertEqual(CS.value_for("weather_wind_red_min_kmh", self.CROP), 25.0)
		# Rose was not touched and must still read the site default.
		default = CS.resolve("Rose")["defaults"]["weather_wind_red_min_kmh"]
		self.assertEqual(CS.value_for("weather_wind_red_min_kmh", "Rose"), default)

	def test_clearing_a_value_is_how_you_go_back_to_the_default(self):
		"""Empty and absent have to mean the same thing, or the page has two ways
		to say 'inherit' and only one of them works."""
		CS.replace_overrides(self.CROP, {"irac_rotation_window_days": "45"})
		self.assertIn("irac_rotation_window_days", CS.resolve(self.CROP)["overridden"])
		CS.replace_overrides(self.CROP, {"irac_rotation_window_days": ""})
		r = CS.resolve(self.CROP)
		self.assertNotIn("irac_rotation_window_days", r["overridden"])
		self.assertEqual(
			r["effective"]["irac_rotation_window_days"],
			r["defaults"]["irac_rotation_window_days"],
		)

	def test_saving_replaces_rather_than_merges(self):
		"""The page shows every overridable setting, so what it sends is the whole
		intent. Merging would make a cleared field unclearable."""
		CS.replace_overrides(
			self.CROP,
			{"irac_rotation_window_days": "45", "postponement_max_days": "9"},
		)
		CS.replace_overrides(self.CROP, {"irac_rotation_window_days": "45"})
		self.assertEqual(CS.resolve(self.CROP)["overridden"], ["irac_rotation_window_days"])


class TestTypes(_RestoresOverrides):
	def test_values_come_back_as_the_parent_field_declares_them(self):
		"""Overrides are stored as Data because one column cannot be Int, Float,
		Time and Check at once. The parent Single stays the authority on type."""
		CS.replace_overrides(
			self.CROP,
			{
				"weather_wind_red_min_kmh": "25",       # Float
				"irac_rotation_window_days": "45",      # Int
				"auto_cancel_enabled": "1",             # Check
				"spray_cutoff_time": "11:30:00",        # Time
			},
		)
		eff = CS.resolve(self.CROP)["effective"]
		self.assertIsInstance(eff["weather_wind_red_min_kmh"], float)
		self.assertIsInstance(eff["irac_rotation_window_days"], int)
		self.assertIsInstance(eff["auto_cancel_enabled"], int)
		self.assertEqual(eff["spray_cutoff_time"], "11:30:00")

	def test_a_value_that_cannot_be_read_falls_back_rather_than_breaking(self):
		"""A bad row should not take a setting — or the settings page — down."""
		CS.replace_overrides(self.CROP, {"irac_rotation_window_days": "not a number"})
		r = CS.resolve(self.CROP)
		self.assertNotIn("irac_rotation_window_days", r["overridden"])
		self.assertEqual(
			r["effective"]["irac_rotation_window_days"],
			r["defaults"]["irac_rotation_window_days"],
		)


class TestWhatMayBeOverridden(_RestoresOverrides):
	def test_a_setting_outside_the_list_is_refused(self):
		"""OVERRIDABLE is the contract. A crop is not a security boundary and not
		a chart of accounts, so those settings must not become per-crop by the
		back door."""
		CS.replace_overrides(
			self.CROP,
			{
				"allow_submit_without_biometric": "1",
				"default_chemical_expense_account": "Nonsense - KR",
				"app_timezone": "UTC",
			},
		)
		self.assertEqual(CS.resolve(self.CROP)["overridden"], [])

	def test_every_overridable_field_exists_on_the_parent(self):
		"""A typo here would silently create a setting that overrides nothing."""
		meta = frappe.get_meta(CS.SETTINGS_DOCTYPE)
		for key in CS.OVERRIDABLE:
			self.assertIsNotNone(meta.get_field(key), f"{key} is not a field on the Single")

	def test_every_overridable_field_says_why(self):
		"""The reason is part of the definition — it is shown to the person
		changing the value, and a field that cannot be given one does not belong."""
		for key, reason in CS.OVERRIDABLE.items():
			self.assertTrue(reason.strip(), f"{key} has no reason")

	def test_an_unknown_crop_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			CS.replace_overrides("Not A Crop", {"irac_rotation_window_days": "3"})


class TestWipAreas(unittest.TestCase):
	"""Which warehouses count as a work-in-progress spray area.

	The flow is the same on every crop — chemicals in, mixed, sprayed out — but
	roses call the place the CSU and an orchard does not, and the matcher used
	to be the literal string in a SQL LIKE and a React regex.
	"""

	def setUp(self):
		frappe.set_user("Administrator")
		self._before = [
			{"keyword": r.keyword}
			for r in (frappe.get_single(CS.SETTINGS_DOCTYPE).get("wip_area_keywords") or [])
		]

	def tearDown(self):
		doc = frappe.get_single(CS.SETTINGS_DOCTYPE)
		doc.set("wip_area_keywords", self._before)
		doc.save(ignore_permissions=True)
		frappe.db.commit()

	def _set(self, words):
		doc = frappe.get_single(CS.SETTINGS_DOCTYPE)
		doc.set("wip_area_keywords", [{"keyword": w} for w in words])
		doc.save(ignore_permissions=True)
		frappe.db.commit()

	def test_an_unconfigured_site_still_finds_its_CSUs(self):
		"""The fallback is the whole reason roses keep working untouched."""
		self._set([])
		self.assertEqual(CS.wip_keywords(), ["CSU"])
		self.assertTrue(CS.is_wip_area("Torongo CSU Phase 1 - KR"))

	def test_a_crop_can_call_it_something_else(self):
		self._set(["CSU", "Mixing Bay"])
		self.assertTrue(CS.is_wip_area("Torongo CSU Phase 1 - KR"))
		self.assertTrue(CS.is_wip_area("Lokitela Mixing Bay - KL"))

	def test_matching_is_whole_word(self):
		"""A substring match would make 'Focus Store' a spray area because it
		contains 'cus', with nothing on screen to explain why."""
		self._set(["CSU"])
		self.assertFalse(CS.is_wip_area("Focus Store - KR"))
		self.assertFalse(CS.is_wip_area("Excused Goods - KR"))

	def test_matching_ignores_case(self):
		self._set(["CSU"])
		self.assertTrue(CS.is_wip_area("my csu bay - KL"))

	def test_the_same_word_twice_is_read_once(self):
		"""Case-insensitively — "CSU" and "csu" are one keyword, not two, or the
		SQL pre-filter gains a redundant OR for every repeat."""
		self._set(["CSU", "csu", "Mixing Bay"])
		self.assertEqual([w.lower() for w in CS.wip_keywords()], ["csu", "mixing bay"])

	def test_a_blank_keyword_cannot_be_stored(self):
		"""`keyword` is reqd on the child doctype, so the empty row the read path
		also guards against cannot get in through the form in the first place. A
		blank that DID get in (an import, a patch) would match every warehouse."""
		with self.assertRaises(frappe.MandatoryError):
			self._set(["CSU", "   "])

	def test_the_label_is_per_crop_while_the_keywords_are_not(self):
		"""What the area is CALLED is a crop's business; which warehouses ARE one
		is the site's, because the store dashboards span farms and crops."""
		self.assertIn("wip_area_label", CS.OVERRIDABLE)
		self.assertNotIn("wip_area_keywords", CS.OVERRIDABLE)


class TestFarmsForCrop(unittest.TestCase):
	"""Which farms belong to a crop — the Access roster and the Settings tabs
	have to agree, and neither may show a farm the crop is not grown on."""

	def setUp(self):
		frappe.set_user("Administrator")

	def test_a_crop_gets_its_own_farms(self):
		self.assertEqual(CS.farms_for_crop("Avocado"), ["Lokitela"])
		self.assertEqual(CS.farms_for_crop("Coffee"), ["Endebess", "Saboti"])

	def test_an_untagged_crop_gets_nothing_not_everything(self):
		"""The fallback this replaces listed all 17 farms on the avocado page,
		where one is tagged — sixteen chances to roster the wrong farm."""
		self.assertEqual(CS.farms_for_crop("Not A Crop"), [])
		self.assertEqual(CS.farms_for_crop(""), [])

	def test_the_access_roster_shows_the_same_farms(self):
		from upande_scp.serverscripts.spray_plan_creator.admin import (
			list_farms_with_creators,
		)

		for crop in ("Avocado", "Coffee", "Rose"):
			rostered = sorted(r["farm"] for r in list_farms_with_creators(crop))
			self.assertEqual(rostered, CS.farms_for_crop(crop), crop)

	def test_the_roster_without_a_crop_is_unchanged(self):
		"""A site-wide caller still gets every farm — the filter is opt-in."""
		from upande_scp.serverscripts.spray_plan_creator.admin import (
			list_farms_with_creators,
		)

		self.assertGreater(len(list_farms_with_creators()), len(CS.farms_for_crop("Avocado")))

	def test_an_untagged_crop_rosters_nothing(self):
		from upande_scp.serverscripts.spray_plan_creator.admin import (
			list_farms_with_creators,
		)

		self.assertEqual(list_farms_with_creators("Not A Crop"), [])
