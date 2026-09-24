"""What a scout may record about a round beyond the counts: photos and comments.

Both are optional, both are the General Manager's to allow, and the app must be
able to learn which of the two it may offer before it draws a single icon. These
tests pin that contract from both ends — the settings the GM sets, and what the
handset is told.

A photo carries its own caption, so the picture and the words about it are one
row. An entry-wide note stays in ``comments_scouting_entry``, which is a
different thing and predates this.
"""

import unittest

import frappe

from upande_scp.serverscripts.mobile import get_observations_details
from upande_scp.serverscripts.scouting import capture_settings

SETTINGS = "Spray Plan Settings"


def _set(photos, comments):
	frappe.db.set_single_value(
		SETTINGS,
		{"allow_scout_photos": int(photos), "allow_scout_comments": int(comments)},
	)


class TestTheSettingsTheGmOwns(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	@classmethod
	def tearDownClass(cls):
		_set(True, True)

	def test_the_switches_live_on_the_settings_the_page_already_loads(self):
		"""Not a settings doctype of their own: that is how one settings page
		becomes six. They sit on the Single the SCP settings page already
		loads and saves."""
		self.assertFalse(frappe.db.exists("DocType", "Scouting Settings"))
		meta = frappe.get_meta(SETTINGS)
		self.assertTrue(meta.issingle)
		for fieldname in ("allow_scout_photos", "allow_scout_comments"):
			field = meta.get_field(fieldname)
			self.assertIsNotNone(field, f"{SETTINGS} has no {fieldname}")
			self.assertEqual(field.fieldtype, "Check")

	def test_both_start_on(self):
		"""A farm that never opens the page should still get the feature. The
		switch exists to turn something OFF, which is the rarer intent."""
		meta = frappe.get_meta(SETTINGS)
		for fieldname in ("allow_scout_photos", "allow_scout_comments"):
			self.assertEqual(
				meta.get_field(fieldname).default, "1", f"{fieldname} should default on"
			)

	def test_the_general_manager_reaches_them_through_the_settings_page(self):
		"""The page gates every endpoint to GM / System Manager server-side
		(`_require_admin`), which is the door the GM actually uses — the desk
		doctype stays System Manager, as the rest of this Single is."""
		from upande_scp.serverscripts.spray_plan_creator import settings as settings_api

		self.assertTrue(callable(settings_api.get_settings_bundle))
		self.assertTrue(callable(settings_api.save_spray_plan_settings))
		bundle_fields = settings_api.get_settings_bundle()["spray_plan"]
		self.assertIn("allow_scout_photos", bundle_fields)
		self.assertIn("allow_scout_comments", bundle_fields)

	def test_a_farm_that_never_opened_the_page_is_allowed_both(self):
		"""The default has to hold at RUNTIME, not just on the field.

		`get_single_value` casts by fieldtype before returning, and a Check
		casts a missing row to 0 — so "no row" and "switched off" arrive
		identical, and the feature reads as off on every farm that has never
		touched the page. Restoring production, which has no rows for these
		fields, is what surfaced it: the payload said false on a site where
		nobody had ever switched anything off.
		"""
		frappe.db.sql(
			"""DELETE FROM tabSingles
			   WHERE doctype = %s AND field IN ('allow_scout_photos', 'allow_scout_comments')""",
			SETTINGS,
		)
		frappe.db.commit()
		self.assertTrue(capture_settings.allows("photos"))
		self.assertTrue(capture_settings.allows("comments"))
		self.assertEqual(
			get_observations_details.getObservationsDetails()["capture"],
			{"photos": True, "comments": True},
		)

	def test_allows_reads_the_switches(self):
		_set(True, False)
		self.assertTrue(capture_settings.allows("photos"))
		self.assertFalse(capture_settings.allows("comments"))
		_set(False, True)
		self.assertFalse(capture_settings.allows("photos"))
		self.assertTrue(capture_settings.allows("comments"))


class TestWhatTheHandsetIsTold(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	@classmethod
	def tearDownClass(cls):
		_set(True, True)

	def test_the_payload_carries_both_switches(self):
		"""The app draws the camera icon off this, so it has to arrive with the
		observations rather than in a call the app might skip."""
		_set(True, True)
		capture = get_observations_details.getObservationsDetails()["capture"]
		self.assertEqual(capture, {"photos": True, "comments": True})

		_set(False, False)
		capture = get_observations_details.getObservationsDetails()["capture"]
		self.assertEqual(capture, {"photos": False, "comments": False})

	def test_the_comments_tab_disappears_when_the_gm_turns_it_off(self):
		"""The app shows the tab only when the category is present, so the
		switch has to reach the category, not just the flag beside it."""
		_set(True, False)
		result = get_observations_details.getObservationsDetails()
		self.assertNotIn("Comments", [c["category"] for c in result["data"]])

		_set(True, True)
		result = get_observations_details.getObservationsDetails()
		self.assertIn("Comments", [c["category"] for c in result["data"]])


class TestThePhotoAndItsCaption(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_the_child_doctype_holds_a_picture_and_the_words_about_it(self):
		self.assertTrue(frappe.db.exists("DocType", "Scouting Entry Photo"))
		meta = frappe.get_meta("Scouting Entry Photo")
		self.assertTrue(meta.istable)
		self.assertEqual(meta.get_field("image").fieldtype, "Attach Image")
		self.assertEqual(meta.get_field("caption").fieldtype, "Small Text")
		self.assertIsNotNone(meta.get_field("subject"))

	def test_the_entry_has_somewhere_to_show_them(self):
		"""Before this the photos were File rows and nothing else — attached to
		the entry, but invisible on it."""
		field = frappe.get_meta("Scouting Entry").get_field("photos_scouting_entry")
		self.assertIsNotNone(field, "Scouting Entry has nowhere to show its photos")
		self.assertEqual(field.fieldtype, "Table")
		self.assertEqual(field.options, "Scouting Entry Photo")

	def test_a_caption_survives_the_round_trip(self):
		entry = frappe.new_doc("Scouting Entry")
		entry.append(
			"photos_scouting_entry",
			{
				"image": "/private/files/x.jpg",
				"caption": "Webbing on the underside",
				"subject": "Spider Mites",
			},
		)
		row = entry.photos_scouting_entry[0]
		self.assertEqual(row.caption, "Webbing on the underside")
		self.assertEqual(row.subject, "Spider Mites")


class TestAnythingIsPhotographable(unittest.TestCase):
	"""The camera used to appear only where the pest name read "unidentified".
	A scout standing in front of something worth a picture should not have to
	mislabel it to take one."""

	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_a_photo_needs_no_subject_at_all(self):
		from upande_scp.serverscripts.mobile import pest_image

		name = pest_image._short_file_name("IMG_0042.jpg", "abc|2026-01-01", "")
		self.assertTrue(name.endswith(".jpg"))
		self.assertLessEqual(len(name), pest_image.MAX_FILE_NAME)

	def test_the_gm_is_still_only_interrupted_by_the_unnamed(self):
		"""Ten documented findings on a round must not be ten alerts."""
		from upande_scp.serverscripts.mobile import pest_image

		self.assertTrue(pest_image._is_unidentified("Unidentified pest"))
		self.assertFalse(pest_image._is_unidentified("Downy Mildew"))
		# A photo of nothing named is the original case: still worth the alert.
		self.assertTrue(pest_image._is_unidentified(""))

	def test_the_old_endpoint_name_still_answers(self):
		"""Handsets in the field keep calling it for months after a rename."""
		from upande_scp.serverscripts.mobile import pest_image

		self.assertTrue(callable(pest_image.attach_unidentified_pest_image))
		self.assertTrue(callable(pest_image.attach_scouting_photo))
