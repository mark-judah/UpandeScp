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


class TestPhotoFileName(unittest.TestCase):
    """The stored name must fit File.file_name (Data, 140) and be stable.

    The live failure: the client named the upload from the raw client_id, whose
    separators percent-encode on the wire, and a real Mona capture reached 148
    characters — CharacterLengthExceededError, and a photo already uploaded was
    lost on insert.
    """

    LONG = (
        "Spodoptera-diana.tanui_40monaflowers.co.ke_7C2026-08-26_7C19_3A44_3A49"
        "_7CMain_20GH_2006_20-_20MFK_7CMain_20GH_2006_20-_20MFK_20-_20Bed_2011f9a17.jpg"
    )
    CID = (
        "diana.tanui@monaflowers.co.ke|2026-08-26|19:44:49"
        "|Main GH 06 - MFK|Main GH 06 - MFK - Bed 11"
    )

    def test_the_name_that_broke_production_now_fits(self):
        self.assertGreater(len(self.LONG), pest_image.MAX_FILE_NAME)
        out = pest_image._short_file_name(self.LONG, self.CID, "Spodoptera")
        self.assertLessEqual(len(out), pest_image.MAX_FILE_NAME)

    def test_it_is_deterministic_so_retries_stay_idempotent(self):
        # The duplicate check matches on file_name; a name that varied per
        # attempt would attach a fresh copy on every retry of a lost ack.
        a = pest_image._short_file_name(self.LONG, self.CID, "Spodoptera")
        b = pest_image._short_file_name(self.LONG, self.CID, "Spodoptera")
        self.assertEqual(a, b)

    def test_different_subjects_on_one_entry_stay_distinct(self):
        a = pest_image._short_file_name(self.LONG, self.CID, "Spodoptera")
        b = pest_image._short_file_name(self.LONG, self.CID, "Downy Mildew")
        self.assertNotEqual(a, b)

    def test_the_subject_stays_legible_in_the_name(self):
        out = pest_image._short_file_name(self.LONG, self.CID, "Downy Mildew")
        self.assertTrue(out.startswith("Downy-Mildew-"), out)
        self.assertTrue(out.endswith(".jpg"), out)

    def test_a_hostile_or_absent_name_still_yields_something_storable(self):
        for raw in (None, "", "../../etc/passwd", "no-extension"):
            out = pest_image._short_file_name(raw, self.CID, "")
            self.assertLessEqual(len(out), pest_image.MAX_FILE_NAME)
            self.assertRegex(out, r"^[A-Za-z0-9._-]+$")
