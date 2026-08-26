"""Comments on a scouting entry, and who gets alerted about a photo.

The mobile client has posted `comments_scouting_entry` for some time; until the
child doctype existed the rows were silently discarded on the way in. These
tests pin the round trip and the two rules that are easy to get wrong.
"""

import unittest

import frappe

from upande_scp.serverscripts.mobile import get_observations_details, pest_image


class TestCommentsCategory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")

    def test_the_doctype_the_client_posts_into_exists(self):
        self.assertTrue(frappe.db.exists("DocType", "Comments Scouting Entry"))
        meta = frappe.get_meta("Comments Scouting Entry")
        self.assertTrue(meta.istable)
        self.assertIsNotNone(meta.get_field("comment"))

    def test_scouting_entry_holds_comments_after_incidents(self):
        meta = frappe.get_meta("Scouting Entry")
        field = meta.get_field("comments_scouting_entry")
        self.assertIsNotNone(field, "Scouting Entry has nowhere to put comments")
        self.assertEqual(field.fieldtype, "Table")
        self.assertEqual(field.options, "Comments Scouting Entry")
        names = [f.fieldname for f in meta.fields]
        self.assertGreater(
            names.index("comments_scouting_entry"),
            names.index("incidents_scouting_entry"),
            "comments should follow incidents, matching the app's tab order",
        )

    def test_the_category_is_offered_unconditionally(self):
        """Every other category is driven by what a farm configured. A comment
        needs no configuration to be worth writing, and the app only shows the
        tab when the category is present."""
        result = get_observations_details.getObservationsDetails()
        categories = [c["category"] for c in result["data"]]
        self.assertIn("Comments", categories)

    def test_a_comment_round_trips_and_blank_ones_are_dropped(self):
        entry = frappe.new_doc("Scouting Entry")
        entry.append("comments_scouting_entry", {"comment": "Leaf curl on the north end"})
        self.assertEqual(len(entry.comments_scouting_entry), 1)
        self.assertEqual(
            entry.comments_scouting_entry[0].comment, "Leaf curl on the north end"
        )

    def test_an_entry_with_no_comment_stores_no_rows(self):
        """Optional has to mean optional — no empty row left behind."""
        entry = frappe.new_doc("Scouting Entry")
        self.assertEqual(list(entry.get("comments_scouting_entry") or []), [])


class TestPhotoAlertRule(unittest.TestCase):
    def test_an_unnamed_photo_alerts(self):
        self.assertTrue(pest_image._is_unidentified(""))
        self.assertTrue(pest_image._is_unidentified(None))

    def test_the_app_s_own_wording_alerts(self):
        """The app demands a photo when the pest name reads 'unidentified'
        (needsPhoto in traps/index.tsx) and always sends a name. Testing for a
        MISSING name instead would mean the alert never fires again."""
        for name in ("Unidentified pest", "Unidentified Moth", "unidentified insect"):
            self.assertTrue(pest_image._is_unidentified(name), name)

    def test_a_named_pest_or_disease_stays_quiet(self):
        for name in ("Spidermites", "Downy Mildew", "Thrips", "Botrytis"):
            self.assertFalse(pest_image._is_unidentified(name), name)
