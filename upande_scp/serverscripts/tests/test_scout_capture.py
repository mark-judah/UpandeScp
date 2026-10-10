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
