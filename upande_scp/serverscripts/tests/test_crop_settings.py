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
