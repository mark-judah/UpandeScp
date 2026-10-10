"""Scout capture settings (pieces 5–6): the GM's two switches and the max count,
what the handset is told, comments and captioned photos on the entry.

Ported from Mona's test_scouting_metadata.py (f5f6392 / b338508 / da18194) onto
kaitet's Single, Scouting and Crop Protection Settings. DB test — direct runner.
Every test rolls back in tearDown: the code under test calls frappe.db.commit,
which is patched out, and frappe.sendmail is patched so nothing is ever sent.
"""

import hashlib
import io
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.scouting import capture_settings as CS

SETTINGS = "Scouting and Crop Protection Settings"
GH = "Chepsito GH 01 - KR"
ENTRY = "_TEST-SE-CAP-1"
CLIENT_ID = "_test-scp-capture|2031-05-12|08:00:00|Chepsito GH 01 - KR|Bed 1"


def _raw(field):
    row = frappe.db.sql(
        "SELECT value FROM tabSingles WHERE doctype = %s AND field = %s", (SETTINGS, field)
    )
    return row[0][0] if row else None


def _unset(*fields):
    """What a site that never saved these fields looks like: no tabSingles row."""
    frappe.db.sql(
        "DELETE FROM tabSingles WHERE doctype = %s AND field IN %s",
        (SETTINGS, tuple(fields or CS.FIELDS)),
    )


def _set(**values):
    for field, value in values.items():
        frappe.db.set_single_value(SETTINGS, field, value)


class CaptureCase(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self._patches = [patch.object(frappe.db, "commit"), patch.object(frappe, "sendmail")]
        _commit, self.sendmail = (p.start() for p in self._patches)

    def tearDown(self):
        frappe.db.rollback()
        for p in reversed(self._patches):
            p.stop()
        frappe.set_user("Administrator")


class TestCaptureSettings(CaptureCase):
    def test_the_fields_live_on_the_scouting_tab(self):
        meta = frappe.get_meta(SETTINGS)
        self.assertTrue(meta.issingle)
        got = {f: (meta.get_field(f).fieldtype, meta.get_field(f).default) for f in CS.FIELDS}
        self.assertEqual(got, {
            "allow_scout_photos": ("Check", "1"),
            "allow_scout_comments": ("Check", "1"),
            "max_count_per_observation": ("Int", "15"),
        })
        order = [f.fieldname for f in meta.fields]
        self.assertLess(order.index("scouting_tab"), order.index("allow_scout_photos"))

    def test_nothing_stored_reads_as_allowed_and_fifteen(self):
        _unset()
        self.assertTrue(CS.allows("photos"))
        self.assertTrue(CS.allows("comments"))
        self.assertEqual(CS.max_count(), 15)
        self.assertEqual(CS.as_payload(), {"photos": True, "comments": True, "max_count": 15})
        self.assertEqual(CS.as_settings(), {"allow_scout_photos": 1, "allow_scout_comments": 1,
                                            "max_count_per_observation": 15})

    def test_allows_reads_the_switches(self):
        _set(allow_scout_photos=1, allow_scout_comments=0)
        self.assertEqual((CS.allows("photos"), CS.allows("comments")), (True, False))
        _set(allow_scout_photos=0, allow_scout_comments=1)
        self.assertEqual((CS.allows("photos"), CS.allows("comments")), (False, True))

    def test_an_unknown_switch_is_a_programming_error(self):
        with self.assertRaises(ValueError):
            CS.allows("videos")

    def test_a_stored_max_count_is_served_and_a_useless_one_reads_fifteen(self):
        _set(max_count_per_observation=40)
        self.assertEqual(CS.max_count(), 40)
        for useless in ("0", "20000", "-3", "lots"):
            frappe.db.sql("UPDATE tabSingles SET value = %s WHERE doctype = %s AND field = %s",
                          (useless, SETTINGS, CS.MAX_COUNT_FIELD))
            self.assertEqual(CS.max_count(), 15, useless)

    def test_clean_max_count_takes_1_to_10000_only(self):
        for good, want in ((1, 1), (10000, 10000), ("25", 25), (25.0, 25)):
            self.assertEqual(CS.clean_max_count(good), want)
        for bad in (0, 10001, -3, 2.5, "x", None, ""):
            with self.assertRaises(frappe.ValidationError, msg=repr(bad)):
                CS.clean_max_count(bad)

    def test_a_save_without_capture_rows_keeps_capture_on(self):
        # Review focus 1: a loaded Single casts a missing Check to 0, and a save
        # casts a None Int to 0. Without fill_unset, saving ANY setting would
        # switch photos and comments off and set the cap to 0.
        _unset()
        doc = frappe.get_single(SETTINGS)
        self.assertEqual(doc.allow_scout_photos, 0)              # Frappe's cast, documented
        doc.save(ignore_permissions=True)
        self.assertEqual(CS.as_payload(), {"photos": True, "comments": True, "max_count": 15})
        self.assertEqual((_raw("allow_scout_photos"), _raw("max_count_per_observation")), ("1", "15"))

    def test_an_explicit_off_in_the_same_save_is_kept(self):
        _unset()
        doc = frappe.get_single(SETTINGS)
        doc.flags.capture_explicit = {CS.PHOTOS_FIELD}
        doc.allow_scout_photos = 0
        doc.save(ignore_permissions=True)
        self.assertEqual((CS.allows("photos"), CS.allows("comments")), (False, True))

    def test_a_desk_zero_max_count_reads_as_fifteen_not_an_error(self):
        # An Int cannot tell 0 from unset; refusing it would block every save of
        # the Single. Out of range the other way is a real mistake and refused.
        doc = frappe.get_single(SETTINGS)
        doc.max_count_per_observation = 0
        doc.save(ignore_permissions=True)
        self.assertEqual(_raw("max_count_per_observation"), "15")
        doc = frappe.get_single(SETTINGS)
        doc.max_count_per_observation = 20000
        with self.assertRaises(frappe.ValidationError):
            doc.save(ignore_permissions=True)

    def test_ensure_defaults_writes_only_absent_rows(self):
        _unset(CS.COMMENTS_FIELD, CS.MAX_COUNT_FIELD)
        _set(allow_scout_photos=0)
        self.assertEqual(CS.ensure_defaults(), [CS.COMMENTS_FIELD, CS.MAX_COUNT_FIELD])
        self.assertEqual((_raw("allow_scout_photos"), _raw("allow_scout_comments"),
                          _raw("max_count_per_observation")), ("0", "1", "15"))
        self.assertEqual(CS.ensure_defaults(), [])               # the GM's 0 is never overwritten

    def test_after_migrate_seeds_the_defaults(self):
        import upande_scp.hooks as H
        self.assertIn("upande_scp.serverscripts.scouting.capture_settings.ensure_defaults", H.after_migrate)


class TestSettingsPage(CaptureCase):
    def setUp(self):
        super().setUp()
        from upande_scp.serverscripts.spray_plan_creator import settings as S
        self.S = S

    def bundle(self):
        return self.S.get_settings_bundle()["spray_plan"]

    def test_the_bundle_carries_the_three_values(self):
        _set(allow_scout_photos=0, allow_scout_comments=1, max_count_per_observation=40)
        got = self.bundle()
        self.assertEqual((got["allow_scout_photos"], got["allow_scout_comments"],
                          got["max_count_per_observation"]), (0, 1, 40))

    def test_the_bundle_reads_unset_as_on(self):
        _unset()
        got = self.bundle()
        self.assertEqual((got["allow_scout_photos"], got["allow_scout_comments"],
                          got["max_count_per_observation"]), (1, 1, 15))

    def test_a_save_round_trips(self):
        self.S.save_spray_plan_settings(json.dumps(
            {"allow_scout_photos": 0, "allow_scout_comments": 0, "max_count_per_observation": 40}))
        self.assertEqual(CS.as_payload(), {"photos": False, "comments": False, "max_count": 40})
        self.S.save_spray_plan_settings(json.dumps({"allow_scout_photos": True, "allow_scout_comments": "1"}))
        self.assertEqual((_raw("allow_scout_photos"), _raw("allow_scout_comments")), ("1", "1"))

    def test_a_save_of_other_fields_leaves_capture_alone(self):
        _unset()
        hours = self.bundle()["loaning_timeout_hours"]
        self.S.save_spray_plan_settings(json.dumps({"loaning_timeout_hours": hours}))
        self.assertEqual(CS.as_payload(), {"photos": True, "comments": True, "max_count": 15})

    def test_max_count_must_be_1_to_10000(self):
        _set(max_count_per_observation=40)
        for bad in (0, 10001, -1, 2.5, "lots", None):
            with self.assertRaises(frappe.ValidationError, msg=repr(bad)) as ctx:
                self.S.save_spray_plan_settings(json.dumps(
                    {"max_count_per_observation": bad, "allow_scout_photos": 0}))
            self.assertIn("whole number from 1 to 10000", str(ctx.exception))
            self.assertEqual((CS.max_count(), CS.allows("photos")), (40, True))   # nothing saved

    def test_only_a_gm_or_admin_may_read_or_save(self):
        frappe.set_user("Guest")
        with self.assertRaises(frappe.ValidationError):
            self.S.save_spray_plan_settings(json.dumps({"allow_scout_photos": 0}))
        with self.assertRaises(frappe.ValidationError):
            self.S.get_settings_bundle()
        frappe.set_user("Administrator")
        self.assertTrue(CS.allows("photos"))


class TestTablesAndComments(CaptureCase):
    def test_the_child_doctypes(self):
        photo = frappe.get_meta("Scouting Entry Photo")
        self.assertTrue(photo.istable)
        self.assertEqual({f: photo.get_field(f).fieldtype for f in ("image", "caption", "subject", "captured_on")},
                         {"image": "Attach Image", "caption": "Small Text", "subject": "Data",
                          "captured_on": "Datetime"})
        comment = frappe.get_meta("Comments Scouting Entry")
        self.assertTrue(comment.istable)
        self.assertEqual(comment.get_field("comment").fieldtype, "Small Text")

    def test_the_entry_has_both_tables_after_incidents(self):
        meta = frappe.get_meta("Scouting Entry")
        for field, options in (("comments_scouting_entry", "Comments Scouting Entry"),
                               ("photos_scouting_entry", "Scouting Entry Photo")):
            df = meta.get_field(field)
            self.assertEqual((df.fieldtype, df.options), ("Table", options))
        order = [f.fieldname for f in meta.fields]
        at = order.index("incidents_scouting_entry")
        self.assertEqual(order[at + 1:at + 3], ["comments_scouting_entry", "photos_scouting_entry"])

    def test_comments_are_trimmed_and_blanks_dropped(self):
        from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
        doc = frappe.new_doc("Scouting Entry")
        CSE._add_child_items(doc, "comments_scouting_entry", [
            {"comment": "  Webbing under the leaves  "}, {"comment": "   "}, {}, None, {"comment": None},
        ])
        self.assertEqual([r.comment for r in doc.comments_scouting_entry], ["Webbing under the leaves"])
        self.assertEqual(doc.comments_scouting_entry[0].doctype, "Comments Scouting Entry")

    def test_a_bare_string_comment_from_an_old_handset_is_kept_not_a_crash(self):
        from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
        doc = frappe.new_doc("Scouting Entry")
        CSE._add_child_items(doc, "comments_scouting_entry", ["  old handset note ", 42, "   "])
        self.assertEqual([r.comment for r in doc.comments_scouting_entry], ["old handset note"])

    def test_the_other_tables_fill_as_before(self):
        from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
        doc = frappe.new_doc("Scouting Entry")
        CSE._add_child_items(doc, "pests_scouting_entry",
                             [{"pest": "Thrips", "plant_section": "buds", "stage": "Adult", "count": 3}])
        CSE._add_child_items(doc, "incidents_scouting_entry", "not a list")
        row = doc.pests_scouting_entry[0]
        self.assertEqual((row.pest, row.plant_section, row.stage, row.count), ("Thrips", "buds", "Adult", 3))
        self.assertEqual(doc.incidents_scouting_entry, [])

    def test_create_scouting_entry_writes_the_comments(self):
        from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
        zone, bed, gh = frappe.db.sql(
            "SELECT z.name, z.bed, b.greenhouse FROM tabZone z JOIN tabBed b ON b.name = z.bed LIMIT 1")[0]
        user = frappe.db.get_value("Employee", {"status": "Active", "user_id": ["like", "%@%"]}, "user_id")
        entry = {
            "client_id": CLIENT_ID + "|comments", "scouts_name": user, "greenhouse": gh, "bed": bed,
            "latitude": "-0.1", "longitude": "35.1", "accuracy": 3, "crop_scouted": "Rose",
            "date_of_capture": "2031-05-12", "time_of_capture": "08:00:00",
            "comments_scouting_entry": [{"comment": "  Webbing under the leaves  "}, {"comment": " "}],
        }
        prev = getattr(frappe.local, "request", None)
        try:
            frappe.local.request = SimpleNamespace(get_json=lambda: entry)
            frappe.local.response = frappe._dict()
            with patch.object(CSE, "get_zone_from_coordinates",
                              return_value=(zone, 0.9, {"distance": "0.1", "buffer": "0.5", "fallback": False})), \
                 patch.object(frappe, "publish_realtime"):
                CSE.createScoutingEntry()
            result = frappe.local.response["data"][0]
        finally:
            frappe.local.request = prev
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(
            frappe.get_all("Comments Scouting Entry", filters={"parent": result["name"]}, pluck="comment"),
            ["Webbing under the leaves"])

    def test_a_caption_survives_on_the_row(self):
        doc = frappe.new_doc("Scouting Entry")
        doc.append("photos_scouting_entry", {"image": "/private/files/x.jpg",
                                             "caption": "Webbing on the underside", "subject": "Spider Mites"})
        row = doc.photos_scouting_entry[0]
        self.assertEqual((row.caption, row.subject), ("Webbing on the underside", "Spider Mites"))


class TestObservationsPayload(CaptureCase):
    def observations(self, crop=None):
        from upande_scp.serverscripts.mobile import get_observations_details as GOD
        frappe.local.response = frappe._dict()
        return GOD.getObservationsDetails(crop)

    def test_the_payload_carries_capture(self):
        _set(allow_scout_photos=1, allow_scout_comments=0, max_count_per_observation=40)
        got = self.observations()
        self.assertEqual(got["capture"], {"photos": True, "comments": False, "max_count": 40})
        self.assertIn("data", got)
        self.assertIn("allowed_plant_sections", got)

    def test_nothing_stored_sends_the_defaults(self):
        _unset()
        self.assertEqual(self.observations()["capture"], {"photos": True, "comments": True, "max_count": 15})

    def test_the_comments_category_follows_its_switch(self):
        _set(allow_scout_comments=0)
        self.assertNotIn("Comments", [c["category"] for c in self.observations()["data"]])
        _set(allow_scout_comments=1)
        data = self.observations()["data"]
        self.assertEqual(data[-1], {"category": "Comments", "type": "text", "fields": []})

    def test_the_crop_payload_is_otherwise_unchanged(self):
        _set(allow_scout_comments=1)
        cats = [c["category"] for c in self.observations("Rose")["data"]]
        self.assertIn("Pests", cats)
        self.assertEqual(cats.count("Comments"), 1)


def _seed_entry():
    """One raw, rolled-back Scouting Entry with its Metadata (client_id)."""
    frappe.db.sql("""INSERT INTO `tabScouting Entry` (name, creation, modified, owner, modified_by, docstatus, idx,
                         greenhouse, date_of_capture, time_of_capture, crop_scouted)
                     VALUES (%s, NOW(), '2031-05-12 08:00:00', 'Administrator', 'Administrator', 0, 0,
                             %s, '2031-05-12', '08:00:00', 'Rose')""", (ENTRY, GH))
    frappe.db.sql("""INSERT INTO `tabScouting Entry Metadata` (name, creation, modified, owner, modified_by,
                         docstatus, idx, scouting_entry, client_id)
                     VALUES ('_TEST-SEM-CAP-1', NOW(), NOW(), 'Administrator', 'Administrator', 0, 0, %s, %s)""",
                  (ENTRY, CLIENT_ID))


class _Upload:
    def __init__(self, data=b"\xff\xd8jpeg", filename="Thrips-_test.jpg"):
        self.filename = filename
        self.stream = io.BytesIO(data)


class TestPhotoUpload(CaptureCase):
    def setUp(self):
        super().setUp()
        from upande_scp.serverscripts.mobile import pest_image as PI
        self.PI = PI
        self.saved = []
        _seed_entry()
        _set(allow_scout_photos=1)
        self._save = patch("frappe.utils.file_manager.save_file", side_effect=self._fake_save_file)
        self._save.start()
        self._prev_request = getattr(frappe.local, "request", None)
        self._prev_form = getattr(frappe.local, "form_dict", None)

    def tearDown(self):
        self._save.stop()
        frappe.local.request = self._prev_request
        frappe.local.form_dict = self._prev_form
        super().tearDown()

    def _fake_save_file(self, fname, content, dt, dn, is_private=1):
        """Stands in for save_file: a raw, rolled-back File row and no disk write."""
        url = f"/private/files/{fname}"
        frappe.db.sql("""INSERT INTO tabFile (name, creation, modified, owner, modified_by, docstatus, idx,
                             file_name, file_url, attached_to_doctype, attached_to_name, is_private, is_folder)
                         VALUES (%s, NOW(), NOW(), 'Administrator', 'Administrator', 0, 0, %s, %s, %s, %s, %s, 0)""",
                      (f"_TEST-FILE-CAP-{len(self.saved) + 1}", fname, url, dt, dn, is_private))
        self.saved.append({"fname": fname, "dt": dt, "dn": dn, "is_private": is_private})
        return frappe._dict(file_url=url)

    def post(self, file=True, **form):
        form.setdefault("client_id", CLIENT_ID)
        frappe.local.form_dict = frappe._dict(form)
        frappe.local.request = SimpleNamespace(files={"file": _Upload()} if file else {})
        frappe.local.response = frappe._dict()
        self.PI.attach_scouting_photo()
        return frappe.local.response.get("data")

    def rows(self):
        return frappe.get_all("Scouting Entry Photo", filters={"parent": ENTRY, "parenttype": "Scouting Entry"},
                              fields=["image", "caption", "subject", "captured_on"], order_by="idx")

    def test_photos_off_refuses_a_documentation_photo(self):
        _set(allow_scout_photos=0)
        got = self.post(pest="Thrips", subject="Thrips", photo_id="p1")
        self.assertEqual((got["status"], got["reason"]), ("refused", "photos-off"))
        self.assertEqual((self.saved, self.rows()), ([], []))
        self.sendmail.assert_not_called()

    def test_an_unidentified_photo_is_accepted_with_photos_off(self):
        _set(allow_scout_photos=0)
        got = self.post(pest="Unidentified pest", trap="Trap 3")
        self.assertEqual((got["status"], got["notified"]), ("ok", True))
        self.assertEqual(len(self.rows()), 1)
        self.sendmail.assert_called_once()
        self.assertIn("Unidentified pest photo", self.sendmail.call_args.kwargs["subject"])

    def test_pending_until_the_entry_syncs(self):
        got = self.post(client_id="_test-scp-capture|never-synced", subject="General", photo_id="p1")
        self.assertEqual(got, {"status": "pending"})
        self.assertEqual(self.saved, [])

    def test_a_photo_lands_on_the_entry_with_its_caption(self):
        before = frappe.db.get_value("Scouting Entry", ENTRY, "modified")
        got = self.post(pest="Thrips", subject="Thrips", caption="  Webbing on the underside ", photo_id="p1")
        self.assertEqual((got["status"], got["subject"], got["caption"], got["notified"]),
                         ("ok", "Thrips", "Webbing on the underside", False))
        [row] = self.rows()
        self.assertEqual((row.subject, row.caption, row.image), ("Thrips", "Webbing on the underside", got["file"]))
        self.assertIsNotNone(row.captured_on)
        [saved] = self.saved
        self.assertEqual((saved["dt"], saved["dn"], saved["is_private"]), ("Scouting Entry", ENTRY, 1))
        self.assertTrue(saved["fname"].startswith("Thrips-"))
        self.assertLessEqual(len(saved["fname"]), self.PI.MAX_FILE_NAME)
        self.sendmail.assert_not_called()
        # The child row is written directly: the 2 M-row parent is never re-saved.
        self.assertEqual(frappe.db.get_value("Scouting Entry", ENTRY, "modified"), before)

    def test_a_general_photo_needs_no_pest(self):
        got = self.post(subject="General", caption="Broken vent", photo_id="g1")
        self.assertEqual((got["status"], got["notified"]), ("ok", False))
        self.assertEqual([r.subject for r in self.rows()], ["General"])
        self.sendmail.assert_not_called()

    def test_a_retry_of_the_same_photo_is_one_row_and_its_caption_updates(self):
        self.post(subject="General", caption="first words", photo_id="g1")
        again = self.post(subject="General", caption="Updated", photo_id="g1")
        self.assertEqual((again["status"], again["duplicate"]), ("ok", True))
        self.assertEqual([(r.subject, r.caption) for r in self.rows()], [("General", "Updated")])
        self.assertEqual(len(self.saved), 1)

    def test_two_photos_of_one_subject_are_two_rows(self):
        self.post(subject="General", caption="north vent", photo_id="g1")
        self.post(subject="General", caption="south vent", photo_id="g2")
        self.assertEqual([r.caption for r in self.rows()], ["north vent", "south vent"])
        self.assertEqual(len({s["fname"] for s in self.saved}), 2)

    def test_an_old_handset_name_hashes_as_before(self):
        # A handset without photo_id keeps Mona's deterministic name, so its
        # retries still find the first upload.
        digest = hashlib.sha1(f"{CLIENT_ID}|Unidentified pest".encode()).hexdigest()[:10]
        self.assertEqual(self.PI._short_file_name("x.jpg", CLIENT_ID, "Unidentified pest"),
                         f"Unidentified-pest-{digest}.jpg")
        self.assertNotEqual(self.PI._short_file_name("x.jpg", CLIENT_ID, "Unidentified pest", "p1"),
                            self.PI._short_file_name("x.jpg", CLIENT_ID, "Unidentified pest"))

    def test_a_long_client_id_still_fits(self):
        name = self.PI._short_file_name("IMG_0042.jpg", "x" * 300, "y" * 300, "z" * 64)
        self.assertLessEqual(len(name), self.PI.MAX_FILE_NAME)
        self.assertTrue(name.endswith(".jpg"))

    def test_the_old_endpoint_name_is_the_same_endpoint(self):
        self.assertIs(self.PI.attach_unidentified_pest_image, self.PI.attach_scouting_photo)
        self.assertIn(self.PI.attach_scouting_photo, frappe.whitelisted)

    def test_missing_file_or_client_id_throws(self):
        with self.assertRaises(frappe.ValidationError):
            self.post(file=False, subject="General", photo_id="g1")
        with self.assertRaises(frappe.ValidationError):
            self.post(client_id="", subject="General", photo_id="g1")

    def test_is_unidentified_mirrors_the_handset(self):
        self.assertTrue(self.PI._is_unidentified("Unidentified pest"))
        self.assertTrue(self.PI._is_unidentified(""))
        self.assertFalse(self.PI._is_unidentified("Downy Mildew"))
        self.assertFalse(self.PI._is_unidentified("General"))

    def test_two_traps_in_one_submission_are_two_photos(self):
        self.post(pest="Unidentified pest", trap="Trap 1")
        self.post(pest="Unidentified pest", trap="Trap 2")
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(len({s["fname"] for s in self.saved}), 2)
        # the same trap retried is still one photo
        self.post(pest="Unidentified pest", trap="Trap 2")
        self.assertEqual(len(self.rows()), 2)

    def test_the_owner_and_a_gm_may_upload_another_scout_may_not(self):
        # Real committed users with real roles (the TF.ensure_user pattern):
        # every SCP scout role holds write on Scouting Entry, so a permission
        # check alone would let one scout photograph another's entry.
        from upande_scp.serverscripts.tests import thresholds_fixture as TF
        owner = TF.ensure_user("_test_scp_capture_owner@example.com")
        other = TF.ensure_user("_test_scp_capture_other@example.com")
        gm = TF.ensure_user("_test_scp_capture_gm@example.com")
        for user, role in ((owner, "SCP Scout"), (other, "SCP Scout"), (gm, "SCP General Manager")):
            frappe.get_doc("User", user).add_roles(role)
        frappe.db.sql("UPDATE `tabScouting Entry` SET owner=%s WHERE name=%s", (owner, ENTRY))
        try:
            frappe.set_user(owner)
            self.assertEqual(self.post(subject="General", photo_id="o1")["status"], "ok")
            frappe.set_user(other)
            got = self.post(subject="General", caption="hijack", photo_id="o1")
            self.assertEqual((got["status"], got["reason"]), ("refused", "not-yours"))
            self.assertEqual(self.post(pest="Unidentified pest", trap="T9")["reason"], "not-yours")
            frappe.set_user(gm)
            self.assertEqual(self.post(subject="General", photo_id="g9")["status"], "ok")
        finally:
            frappe.set_user("Administrator")
        self.assertEqual(len(self.saved), 2)
        self.assertNotIn("hijack", [r.caption for r in self.rows()])
        self.sendmail.assert_not_called()

    def test_administrator_may_upload_to_anyones_entry(self):
        frappe.db.sql("UPDATE `tabScouting Entry` SET owner='Guest' WHERE name=%s", ENTRY)
        self.assertEqual(self.post(subject="General", photo_id="a1")["status"], "ok")

    def test_only_image_extensions_survive(self):
        n = self.PI._short_file_name
        self.assertTrue(n("x.PNG", "c", "s").endswith(".png"))
        self.assertTrue(n("x.heic", "c", "s").endswith(".heic"))
        for bad in ("x.php", "x.html", "x.svg", "x.exe", "x"):
            self.assertTrue(n(bad, "c", "s").endswith(".jpg"), bad)

    def test_an_empty_subject_is_unidentified_everywhere(self):
        got = self.post(disease="", pest="", subject="", trap="T1")
        self.assertEqual((got["subject"], got["notified"]), ("Unidentified", True))
        self.assertEqual([r.subject for r in self.rows()], ["Unidentified"])
        self.assertIn("Unidentified", self.sendmail.call_args.kwargs["subject"])

    def test_an_unidentified_disease_is_not_called_a_pest(self):
        self.post(disease="Unidentified disease", trap="T1")
        kw = self.sendmail.call_args.kwargs
        self.assertIn("disease", kw["subject"])
        self.assertNotIn("pest", kw["subject"].lower())
        self.assertNotIn("pest", kw["message"].lower())


def _noise_image(fmt):
    """A small real image of random pixels: a unique content hash site-wide,
    and bytes that a text decoder cannot swallow (Frappe tries cp1252)."""
    from PIL import Image

    out = io.BytesIO()
    Image.frombytes("RGB", (48, 48), os.urandom(48 * 48 * 3)).save(out, format=fmt)
    return out.getvalue()


class TestPhotoUploadRealSaveFile(CaptureCase):
    """The REAL save_file. Frappe dedupes identical bytes by content hash and
    hands the second File the first one's file_url (and, without EXIF
    stripping, its file_name too). Every file written to disk during a test
    is deleted again in tearDown."""

    SUBJECTS = ("Thrips", "Aphids")

    def setUp(self):
        super().setUp()
        from upande_scp.serverscripts.mobile import pest_image as PI
        self.PI = PI
        _seed_entry()
        _set(allow_scout_photos=1)
        self.dir = frappe.get_site_path("private", "files")
        os.makedirs(self.dir, exist_ok=True)
        self.before = set(os.listdir(self.dir))
        self._prev_request = getattr(frappe.local, "request", None)
        self._prev_form = getattr(frappe.local, "form_dict", None)

    def tearDown(self):
        try:
            for name in set(os.listdir(self.dir)) - self.before:
                if name.startswith(tuple(f"{s}-" for s in self.SUBJECTS)):
                    os.remove(os.path.join(self.dir, name))
        finally:
            frappe.local.request = self._prev_request
            frappe.local.form_dict = self._prev_form
            super().tearDown()

    def post(self, upload, **form):
        form.setdefault("client_id", CLIENT_ID)
        frappe.local.form_dict = frappe._dict(form)
        frappe.local.request = SimpleNamespace(host=None, files={"file": upload()})
        frappe.local.response = frappe._dict()
        self.PI.attach_scouting_photo()
        return frappe.local.response.get("data")

    def rows(self):
        return frappe.get_all("Scouting Entry Photo", filters={"parent": ENTRY, "parenttype": "Scouting Entry"},
                              fields=["image", "caption", "subject"], order_by="idx")

    def files(self):
        return frappe.get_all("File", filters={"attached_to_doctype": "Scouting Entry", "attached_to_name": ENTRY},
                              fields=["name", "file_url"])

    def _two_subjects_one_picture(self, fmt, ext):
        data = _noise_image(fmt)
        upload = lambda: _Upload(data=data, filename=f"x.{ext}")  # noqa: E731
        a = self.post(upload, pest="Thrips", subject="Thrips", caption="on the leaf", photo_id="p1")
        b = self.post(upload, pest="Aphids", subject="Aphids", caption="on the bud", photo_id="p2")
        self.assertEqual((a["status"], b["status"]), ("ok", "ok"))
        self.assertEqual(sorted((r.subject, r.caption) for r in self.rows()),
                         [("Aphids", "on the bud"), ("Thrips", "on the leaf")])
        self.assertEqual(len({r.image for r in self.rows()}), 1)  # one picture, shared
        files = len(self.files())

        # A retry of the second subject finds its upload and adds no File and no row.
        again = self.post(upload, pest="Aphids", subject="Aphids", caption="on the bud, later", photo_id="p2")
        self.assertEqual((again["status"], again["duplicate"]), ("ok", True))
        self.assertEqual(sorted((r.subject, r.caption) for r in self.rows()),
                         [("Aphids", "on the bud, later"), ("Thrips", "on the leaf")])
        self.assertEqual(len(self.files()), files)

    def test_identical_png_bytes_under_two_subjects_keep_their_own_captions(self):
        self._two_subjects_one_picture("PNG", "png")

    def test_identical_jpeg_bytes_under_two_subjects_keep_their_own_captions(self):
        self._two_subjects_one_picture("JPEG", "jpg")
