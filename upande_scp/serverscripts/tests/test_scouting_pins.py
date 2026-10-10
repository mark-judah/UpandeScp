"""Scouting Pins (piece 3c): save / list / delete with visibility and edit
rights, area pins, the weekly series and the owner's notice.
DB test — direct runner; rolled back in tearDown. The four _test_scp_pin_*
users are committed once (the test_notifications pattern); scope and roles
are patched, never granted."""

import json
import unittest
from datetime import datetime
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import pins as PN
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import spread_fixture as SF
from upande_scp.serverscripts.tests import thresholds_fixture as TF

U_OWNER = "_test_scp_pin_owner@example.com"
U_OTHER = "_test_scp_pin_other@example.com"
U_GM = "_test_scp_pin_gm@example.com"
U_STRANGER = "_test_scp_pin_stranger@example.com"   # may see no farm


def _sees_everything(user=None):
    """crop_scope stand-in: every farm of the crop for all but the stranger."""
    return set() if (user or frappe.session.user) == U_STRANGER else None


def square(lng, lat, d=1e-7) -> dict:
    return {"type": "Polygon", "coordinates": [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d],
                                                [lng - d, lat + d], [lng - d, lat - d]]]}


class PinCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        for user in (U_OWNER, U_OTHER, U_GM, U_STRANGER):
            TF.ensure_user(user)

    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = PF.rose_greenhouses(1)[0]
        self.patches = [
            patch.object(crop_scope, "allowed_crops", side_effect=_sees_everything),
            patch.object(crop_scope, "allowed_farms", side_effect=_sees_everything),
            patch.object(PN, "_roles", side_effect=lambda user: {"SCP General Manager"} if user == U_GM else set()),
            patch.object(TC, "now_eat", return_value=datetime(2031, 8, 10, 9, 0, tzinfo=TC.EAT)),  # Sun 2031-W32
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def as_user(self, user):
        frappe.set_user(user)
        crop_scope.clear_cache()

    def section_pin(self, user=U_OWNER, row=0, col=0, **kw):
        self.as_user(user)
        args = {"crop": "Rose", "warehouse": self.gh, "kind": "Section", "title": "Thrips · first third · front",
                "observation": "Thrips", "obs_kind": "Pest", "section_row": row, "section_col": col, **kw}
        return PN.save_pin(**args)

    def names(self, user):
        self.as_user(user)
        return [p["name"] for p in PN.list_pins("Rose", self.gh, with_series=0)]


class TestPins(PinCase):
    def test_a_section_pin_saves_with_its_house_and_lists_for_its_owner(self):
        pin = self.section_pin(row=1, col=2)
        doc = frappe.get_doc("Scouting Pin", pin["name"])
        self.assertEqual(
            (doc.owner, doc.crop, doc.farm, doc.kind, doc.section_row, doc.section_col, doc.shared, doc.notify),
            (U_OWNER, "Rose", frappe.db.get_value("Warehouse", self.gh, "custom_farm"), "Section", 1, 2, 1, 1),
        )
        grid = R.station_grid(self.gh)
        self.assertEqual(pin["stations"], sorted(s for s, pos in grid.items() if tuple(pos) == (1, 2)))
        self.assertTrue(pin["may_edit"])
        self.assertEqual(self.names(U_OWNER), [pin["name"]])

    def test_a_shared_pin_is_seen_by_others_and_a_private_one_only_by_its_owner(self):
        shared = self.section_pin()
        private = self.section_pin(row=2, col=2, shared=0)
        self.assertEqual(set(self.names(U_OWNER)), {shared["name"], private["name"]})
        self.assertEqual(self.names(U_OTHER), [shared["name"]])
        self.assertEqual(self.names(U_GM), [shared["name"]])

    def test_a_stranger_can_neither_list_nor_save(self):
        self.section_pin()
        self.as_user(U_STRANGER)
        with self.assertRaises(frappe.PermissionError):
            PN.list_pins("Rose", self.gh)
        with self.assertRaises(frappe.PermissionError):
            PN.save_pin("Rose", self.gh, "Section", "mine", section_row=0, section_col=0)

    def test_only_the_owner_a_gm_or_a_system_manager_may_delete(self):
        pin = self.section_pin()
        self.as_user(U_OTHER)
        self.assertFalse(PN.list_pins("Rose", self.gh, with_series=0)[0]["may_edit"])
        with self.assertRaises(frappe.PermissionError):
            PN.delete_pin(pin["name"])
        self.as_user(U_GM)
        self.assertEqual(PN.delete_pin(pin["name"]), {"name": pin["name"]})
        self.assertFalse(frappe.db.exists("Scouting Pin", pin["name"]))
        mine = self.section_pin()
        self.as_user(U_OWNER)
        PN.delete_pin(mine["name"])
        self.assertFalse(frappe.db.exists("Scouting Pin", mine["name"]))
        theirs = self.section_pin()
        self.as_user("Administrator")
        PN.delete_pin(theirs["name"])
        self.assertFalse(frappe.db.exists("Scouting Pin", theirs["name"]))

    def test_another_user_cannot_edit_a_pin_even_through_the_document(self):
        pin = self.section_pin()
        self.as_user(U_OTHER)
        doc = frappe.get_doc("Scouting Pin", pin["name"])
        doc.title = "taken over"
        with self.assertRaises(frappe.PermissionError):
            doc.save(ignore_permissions=True)
        with self.assertRaises(frappe.PermissionError):
            frappe.delete_doc("Scouting Pin", pin["name"], ignore_permissions=True)

    def test_a_patch_pin_keeps_only_this_houses_stations(self):
        inv = SF.by_rank(self.gh)
        mine = [inv[c] for c in SF.rect(0, 0, 1, 3)]
        foreign = sorted(R.station_ranks(PF.rose_greenhouses(2)[1]))[:2]
        self.as_user(U_OWNER)
        pin = PN.save_pin("Rose", self.gh, "Patch", "Thrips · bed 1, zones 1–3", observation="Thrips",
                          obs_kind="pest", stations=json.dumps(mine + foreign), source_week="2031-W31")
        self.assertEqual(pin["stations"], sorted(mine))
        self.assertEqual((pin["obs_kind"], pin["source_week"]), ("Pest", "2031-W31"))
        with self.assertRaises(frappe.ValidationError):
            PN.save_pin("Rose", self.gh, "Patch", "nothing of mine", stations=json.dumps(foreign))

    def test_a_pin_needs_a_title_a_kind_a_cell_and_a_pest_or_disease_word(self):
        self.as_user(U_OWNER)
        for bad in (
            {"kind": "Section", "title": " ", "section_row": 0, "section_col": 0},
            {"kind": "Circle", "title": "x"},
            {"kind": "Section", "title": "x", "section_row": 3, "section_col": 0},
            {"kind": "Section", "title": "x", "section_row": 0, "section_col": 0, "observation": "Thrips"},
        ):
            with self.assertRaises(frappe.ValidationError, msg=str(bad)):
                PN.save_pin("Rose", self.gh, **bad)

    def test_an_area_pin_resolves_the_zone_under_its_polygon(self):
        centroids = PN.station_centroids(self.gh)
        zone = sorted(centroids)[0]
        area = square(*centroids[zone])
        self.as_user(U_OWNER)
        pin = PN.save_pin("Rose", self.gh, "Area", "one zone", polygon=json.dumps(area))
        self.assertEqual((pin["stations"], pin["polygon"]), ([zone], area))
        self.assertTrue(33 < centroids[zone][0] < 42, centroids[zone])   # lng first, Kenya
        self.assertTrue(-5 < centroids[zone][1] < 5, centroids[zone])
        far = {"type": "Polygon", "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]]}
        with self.assertRaises(frappe.ValidationError):
            PN.save_pin("Rose", self.gh, "Area", "nowhere", polygon=json.dumps(far))
        with self.assertRaises(frappe.ValidationError):
            PN.save_pin("Rose", self.gh, "Area", "a line",
                        polygon=json.dumps({"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]}))

    def test_an_area_pin_on_a_block_resolves_its_tree(self):
        block = F.avocado_block()
        centroids = PN.station_centroids(block)
        tree = sorted(centroids)[0]
        self.as_user(U_OWNER)
        pin = PN.save_pin("Avocado", block, "Area", "one tree", polygon=json.dumps(square(*centroids[tree])))
        self.assertEqual(pin["stations"], [tree])


class TestPinDoctypeGuards(PinCase):
    def test_a_roleless_user_cannot_insert_or_read_a_pin_through_the_document_api(self):
        pin = self.section_pin()
        self.as_user(U_STRANGER)
        with self.assertRaises(frappe.PermissionError):
            frappe.get_doc({"doctype": "Scouting Pin", "title": "x", "crop": "Rose", "warehouse": self.gh,
                            "kind": "Section", "section_row": 0, "section_col": 0}).insert()
        with self.assertRaises(frappe.PermissionError):
            frappe.get_list("Scouting Pin", fields=["name"], ignore_permissions=False)
        self.assertTrue(frappe.db.exists("Scouting Pin", pin["name"]))

    def test_a_gm_list_with_permissions_applied_shows_no_private_pin(self):
        self.section_pin(shared=0)
        self.as_user(U_GM)
        with patch.object(frappe, "get_roles", return_value=["SCP General Manager"]):
            try:
                rows = frappe.get_list("Scouting Pin", fields=["name"])
            except frappe.PermissionError:
                rows = []
        self.assertEqual(rows, [])

    def test_validate_rejects_foreign_stations_and_a_crop_mismatched_house_on_direct_insert(self):
        foreign = sorted(R.station_ranks(PF.rose_greenhouses(2)[1]))[:2]
        base = {"doctype": "Scouting Pin", "title": "x", "crop": "Rose", "warehouse": self.gh}
        with self.assertRaises(frappe.ValidationError):
            frappe.get_doc({**base, "kind": "Patch", "stations": json.dumps(foreign)}).insert(ignore_permissions=True)
        with self.assertRaises(frappe.ValidationError):
            frappe.get_doc({**base, "kind": "Section", "section_row": 7, "section_col": 0}).insert(ignore_permissions=True)
        with self.assertRaises(frappe.ValidationError):
            frappe.get_doc({**base, "crop": "Avocado", "kind": "Section", "section_row": 0,
                            "section_col": 0}).insert(ignore_permissions=True)
        with self.assertRaises(frappe.ValidationError):
            frappe.get_doc({**base, "warehouse": "No Such House - X", "kind": "Section", "section_row": 0,
                            "section_col": 0}).insert(ignore_permissions=True)
        ok = frappe.get_doc({**base, "kind": "Section", "section_row": 0, "section_col": 0}).insert(ignore_permissions=True)
        self.assertEqual(ok.farm, frappe.db.get_value("Warehouse", self.gh, "custom_farm"))


class TestSeries(PinCase):
    def seed_section(self, week, scouted, infested, **kw):
        stations = SF.section_stations(self.gh, 0, 0, scouted)
        SF.seed(self.gh, SF.monday(week), stations, infested=stations[:infested], **kw)

    def test_the_series_is_infested_over_scouted_among_the_pins_stations(self):
        self.seed_section(30, 6, 3)
        self.seed_section(31, 6, 6)
        self.seed_section(32, 4, 4)
        pin = self.section_pin()
        self.assertEqual(
            [(p["week"], p["scouted"], p["infested"], p["value"], p["thin"]) for p in PN.pin_series(pin["name"])],
            [("2031-W30", 6, 3, 50.0, False), ("2031-W31", 6, 6, 100.0, False), ("2031-W32", 4, 4, None, True)],
        )
        listed = PN.list_pins("Rose", self.gh)[0]
        self.assertEqual([p["week"] for p in listed["series"]], ["2031-W30", "2031-W31", "2031-W32"])

    def test_only_the_last_eight_scouted_weeks_are_shown(self):
        for week in range(24, 33):
            self.seed_section(week, 5, 1)
        pin = self.section_pin()
        self.assertEqual([p["week"] for p in PN.pin_series(pin["name"])], [f"2031-W{w}" for w in range(25, 33)])
        self.assertEqual([p["value"] for p in PN.pin_series(pin["name"], weeks=3)], [20.0, 20.0, 20.0])

    def test_a_pin_without_an_observation_watches_every_pest_and_disease(self):
        stations = SF.section_stations(self.gh, 0, 0, 6)
        SF.seed(self.gh, SF.monday(32), stations, infested=stations[:2], pest=None, disease="Downy Mildew")
        SF.seed(self.gh, SF.monday(32), stations[2:3], pest="Thrips")
        everything = self.section_pin(observation="", obs_kind="")
        thrips = self.section_pin()
        self.assertEqual(PN.pin_series(everything["name"])[-1]["infested"], 3)
        self.assertEqual(PN.pin_series(thrips["name"])[-1]["infested"], 1)

    def test_a_private_pins_series_is_its_owners_alone(self):
        private = self.section_pin(shared=0)
        self.as_user(U_OTHER)
        with self.assertRaises(frappe.PermissionError):
            PN.pin_series(private["name"])


class TestPinCheck(PinCase):
    def told(self, pin):
        return frappe.get_all("Notification Log", filters={"document_type": "Scouting Pin", "document_name": pin},
                              pluck="for_user")

    def seed_rise(self, before, now, n=10):
        stations = SF.section_stations(self.gh, 0, 0, n)
        SF.seed(self.gh, SF.monday(31), stations, infested=stations[:before])
        SF.seed(self.gh, SF.monday(32), stations, infested=stations[:now])

    def test_a_ten_point_rise_tells_the_owner_once_a_week(self):
        self.seed_rise(5, 6)                                                 # 50 % → 60 %
        pin = self.section_pin()
        self.as_user("Administrator")
        with patch.object(frappe, "sendmail") as mail:
            self.assertEqual(PN.check_pins()["notified"], 1)
            self.assertEqual(self.told(pin["name"]), [U_OWNER])              # the owner only
            subject = frappe.db.get_value("Notification Log", {"document_name": pin["name"]}, "subject")
            self.assertIn(f"Pin Thrips · first third · front in {self.gh}: Thrips 60.0% (was 50.0%)", subject)
            self.assertIn("up 10.0 points in 2031-W32", subject)
            self.assertEqual(frappe.db.get_value("Scouting Pin", pin["name"], "last_notified_week"), "2031-W32")
            self.assertEqual(PN.check_pins()["notified"], 0)                 # the next hour is silent
            self.assertEqual(self.told(pin["name"]), [U_OWNER])
            self.assertFalse(mail.called)

    def test_a_rise_under_ten_points_is_silent(self):
        self.seed_rise(5, 6, n=11)                                           # 45.5 % → 54.5 %
        pin = self.section_pin()
        self.as_user("Administrator")
        self.assertEqual(PN.check_pins()["notified"], 0)
        self.assertEqual(self.told(pin["name"]), [])

    def test_a_thin_week_is_silent(self):
        stations = SF.section_stations(self.gh, 0, 0, 10)
        SF.seed(self.gh, SF.monday(31), stations, infested=stations[:5])     # 5 of 10
        SF.seed(self.gh, SF.monday(32), stations[:4])                        # 4 of 4: too few scouted
        pin = self.section_pin()
        self.as_user("Administrator")
        self.assertEqual(PN.check_pins(), {"pins": 1, "notified": 0})
        self.assertEqual(self.told(pin["name"]), [])

    def test_notify_off_is_never_checked(self):
        self.seed_rise(5, 9)                                                 # 50 % → 90 %
        pin = self.section_pin(notify=0)
        self.as_user("Administrator")
        self.assertEqual(PN.check_pins(), {"pins": 0, "notified": 0})
        self.assertEqual(self.told(pin["name"]), [])

    def test_the_hourly_check_runs_pins_after_alerts_and_survives_their_failure(self):
        with patch.object(TC, "_crops_to_check", return_value=[]), \
                patch.object(PN, "check_pins", return_value={"pins": 0, "notified": 0}) as ran:
            out = TC.run_threshold_check(force=True, commit=False)
        ran.assert_called_once()
        self.assertEqual((out["pins"], out["errors"]), ({"pins": 0, "notified": 0}, []))
        with patch.object(TC, "_crops_to_check", return_value=[]), \
                patch.object(PN, "check_pins", side_effect=RuntimeError("boom")):
            out = TC.run_threshold_check(force=True, commit=False)
        self.assertEqual(out["errors"], ["pins"])
