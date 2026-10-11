"""Gallery page photo feed (spec 2026-10-11 GP2). DB test — direct runner, rolled back.

Week 2031-W49, like the pop-up's test: kaitet.local has no real scouting there.
"""

import unittest
from datetime import datetime, timedelta
from unittest import mock

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _photo_feed as P
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests.test_observation_gallery import MON, SUN, TUE, insert, scouts


class FeedCase(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        self.zone = frappe.db.get_value("Zone", {"name": ["like", self.gh + "%"]}, "name")
        self.s1, self.s2 = scouts(2)

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def feed(self, crop="Rose", **kw):
        kw.setdefault("from_date", MON)
        kw.setdefault("to_date", SUN)
        return DA.photo_feed(crop=crop, **kw)

    def seed(self):
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zone,
               photos=[("Thrips", "thrips-1", 0), ("Powdery Mildew", "pm-1", 5)])
        insert(scout=self.s2, date=TUE, greenhouse=self.gh, zone=self.zone,
               photos=[("Thrips", "thrips-2", 0), ("General", "general-1", 1)])


class TestFeed(FeedCase):
    def test_every_subject_newest_first_with_kind_and_scout_photo(self):
        self.seed()
        out = self.feed()
        self.assertEqual([p["caption"] for p in out["photos"]],
                         ["general-1", "thrips-2", "pm-1", "thrips-1"])
        kinds = {p["caption"]: p["kind"] for p in out["photos"]}
        self.assertEqual(kinds, {"general-1": "other", "thrips-2": "pest",
                                 "pm-1": "disease", "thrips-1": "pest"})
        p = out["photos"][0]
        self.assertEqual((p["scout"], p["house"], p["subject"], p["date"]), (self.s2, self.gh, "General", TUE))
        self.assertEqual(p["scoutImage"], frappe.db.get_value("Employee", self.s2, "image") or "")
        self.assertEqual(p["scoutName"], frappe.db.get_value("Employee", self.s2, "employee_name"))
        self.assertFalse(out["hasMore"])

    def test_filters_kind_name_scout(self):
        self.seed()
        cap = lambda o: sorted(p["caption"] for p in o["photos"])  # noqa: E731
        self.assertEqual(cap(self.feed(kind="pest")), ["thrips-1", "thrips-2"])
        self.assertEqual(cap(self.feed(kind="disease")), ["pm-1"])
        self.assertEqual(cap(self.feed(kind="other")), ["general-1"])
        self.assertEqual(cap(self.feed(name="Thrips")), ["thrips-1", "thrips-2"])
        self.assertEqual(cap(self.feed(kind="disease", name="Thrips")), [])
        self.assertEqual(cap(self.feed(scout=self.s1)), ["pm-1", "thrips-1"])
        self.assertEqual(cap(self.feed(from_date=TUE)), ["general-1", "thrips-2"])
        with self.assertRaises(frappe.ValidationError):
            self.feed(kind="weed")

    def test_facets_ignore_subject_and_scout_filters(self):
        self.seed()
        facets = self.feed(name="Thrips", scout=self.s1)["facets"]
        self.assertEqual({(s["name"], s["kind"], s["count"]) for s in facets["subjects"]},
                         {("Thrips", "pest", 2), ("Powdery Mildew", "disease", 1), ("General", "other", 1)})
        self.assertEqual({(s["scout"], s["count"]) for s in facets["scouts"]}, {(self.s1, 2), (self.s2, 2)})
        self.assertNotIn("facets", self.feed(page=1))

    def test_paging(self):
        for i in range(P.PHOTOS_PER_PAGE + 3):
            insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zone,
                   photos=[("Thrips", f"p{i}", i)])
        first, second = self.feed(), self.feed(page=1)
        self.assertEqual((len(first["photos"]), first["hasMore"]), (P.PHOTOS_PER_PAGE, True))
        self.assertEqual((len(second["photos"]), second["hasMore"]), (3, False))
        self.assertEqual(self.feed(page=10**9)["page"], P.MAX_PAGE)


class TestScope(FeedCase):
    def test_other_crops_photos_are_not_returned(self):
        insert(scout=self.s1, date=MON, block=F.avocado_block(), crop="Avocado", photos=[("Thrips", "avo", 0)])
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zone, photos=[("Thrips", "rose", 0)])
        self.assertEqual([p["caption"] for p in self.feed()["photos"]], ["rose"])

    def test_a_restricted_user_sees_only_their_houses(self):
        other = frappe.db.sql(
            """select w.name from `tabWarehouse` w where w.warehouse_type='Greenhouse' and w.is_group=0
               and w.name != %s and w.custom_farm in (select farm from `tabFarm Filter`
               where parenttype='Crop Scouted' and parent='Rose') order by w.name limit 1""", (self.gh,))[0][0]
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zone, photos=[("Thrips", "mine", 0)])
        insert(scout=self.s2, date=MON, greenhouse=other, photos=[("Thrips", "theirs", 0)])
        self.assertEqual(len(self.feed()["photos"]), 2)
        with mock.patch.object(crop_scope, "scoped_greenhouses", return_value={self.gh}):
            out = self.feed()
            self.assertEqual([p["caption"] for p in out["photos"]], ["mine"])
            self.assertEqual([s["scout"] for s in out["facets"]["scouts"]], [self.s1])
            with self.assertRaises(frappe.PermissionError):
                self.feed(greenhouse=other)

    def test_a_crop_the_user_may_not_see_is_refused(self):
        frappe.set_user(F.PETER)
        with self.assertRaises(frappe.PermissionError):
            self.feed(crop="Avocado")

    def test_no_aggregate_schema_change(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "psn1")


class TestHms(unittest.TestCase):
    def test_time_formats(self):
        self.assertEqual(P.hms(timedelta(hours=8, minutes=5, seconds=7)), "08:05:07")
        self.assertEqual(P.hms("14:30:00.000000"), "14:30:00")
        self.assertEqual(P.hms(None), "")
        self.assertEqual(P._day_time(datetime(2031, 12, 1).date(), timedelta(hours=9)), "2031-12-01 09:00:00")


if __name__ == "__main__":
    unittest.main()
