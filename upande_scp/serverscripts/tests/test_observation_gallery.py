"""Pest gallery pop-up aggregate (roadmap item 8, spec 2026-10-10 G1-G5).
DB test — direct runner, rolled back.

Week 2031-W49 (2031-12-01 → 2031-12-07): no other module seeds it and
kaitet.local has no real scouting in 2031.
"""

import unittest
from datetime import datetime, timedelta

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _gallery as G
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

MON, TUE, WED, SUN = "2031-12-01", "2031-12-02", "2031-12-03", "2031-12-07"


def scouts(n=2) -> list:
    return [r[0] for r in frappe.db.sql("select name from `tabEmployee` order by name limit %s", (n,))]


def insert(*, scout, date, greenhouse=None, zone=None, block=None, tree=None, crop="Rose",
           pests=(), diseases=(), photos=()) -> str:
    """One entry; ``pests`` are (pest, stage, count); ``photos`` are (subject, caption, minute)."""
    name = "_TEST-GAL-" + frappe.generate_hash(length=10)
    ts = datetime.strptime(date, "%Y-%m-%d") + timedelta(hours=8)
    frappe.db.sql(
        """insert into `tabScouting Entry`
           (name, creation, modified, owner, modified_by, docstatus, idx, naming_series,
            scouts_name, greenhouse, block, zone, tree, date_of_capture, time_of_capture,
            crop_scouted, latitude, longitude)
           values (%(n)s, %(c)s, %(c)s, 'Administrator', 'Administrator', 0, 0, 'SCE-.YYYY.-',
            %(s)s, %(gh)s, %(blk)s, %(z)s, %(t)s, %(d)s, '08:00:00', %(crop)s, '0', '0')""",
        {"n": name, "c": ts, "s": scout, "gh": greenhouse, "blk": block, "z": zone, "t": tree,
         "d": date, "crop": crop},
    )
    for i, (pest, stage, count) in enumerate(pests, start=1):
        frappe.db.sql(
            """insert into `tabPests Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, pest, stage, plant_section, `count`)
               values (%(n)s, %(c)s, %(c)s, 'Administrator', 'Administrator', 0, %(i)s, %(p)s,
                'Scouting Entry', 'pests_scouting_entry', %(pest)s, %(st)s, 'Leaf', %(cnt)s)""",
            {"n": frappe.generate_hash(length=12), "c": ts, "i": i, "p": name, "pest": pest,
             "st": stage, "cnt": count},
        )
    for i, disease in enumerate(diseases, start=1):
        frappe.db.sql(
            """insert into `tabDiseases Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, disease, stage, plant_section)
               values (%(n)s, %(c)s, %(c)s, 'Administrator', 'Administrator', 0, %(i)s, %(p)s,
                'Scouting Entry', 'diseases_scouting_entry', %(d)s, 'Active', 'Leaf')""",
            {"n": frappe.generate_hash(length=12), "c": ts, "i": i, "p": name, "d": disease},
        )
    for i, (subject, caption, minute) in enumerate(photos, start=1):
        frappe.db.sql(
            """insert into `tabScouting Entry Photo`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, image, caption, subject, captured_on)
               values (%(n)s, %(c)s, %(c)s, 'Administrator', 'Administrator', 0, %(i)s, %(p)s,
                'Scouting Entry', 'photos_scouting_entry', %(img)s, %(cap)s, %(sub)s, %(at)s)""",
            {"n": frappe.generate_hash(length=12), "c": ts, "i": i, "p": name,
             "img": f"/private/files/{name}-{i}.jpg", "cap": caption, "sub": subject,
             "at": ts + timedelta(minutes=minute)},
        )
    return name


class GalleryCase(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        self.zones = [r[0] for r in frappe.db.sql(
            "select name from `tabZone` where name like %s order by name limit 4", (self.gh + "%",))]
        self.s1, self.s2 = scouts(2)

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def gallery(self, name="Thrips", kind="pest", crop="Rose", **kw):
        kw.setdefault("from_date", MON)
        kw.setdefault("to_date", SUN)
        return DA.observation_gallery(crop=crop, kind=kind, name=name, force="1", **kw)

    def scout(self, out, s):
        return next(r for r in out["scouts"] if r["scout"] == s)


class TestReference(GalleryCase):
    def test_reference_carries_the_master_fields(self):
        out = self.gallery()
        ref = out["reference"]
        expected = frappe.db.get_value(
            "Pest", "Thrips", ["scientific_name", "identification_guideline", "damage_symptoms"], as_dict=True)
        self.assertEqual(ref["scientificName"], expected.scientific_name)
        self.assertEqual(ref["guideline"], expected.identification_guideline)
        self.assertEqual(ref["image"], expected.damage_symptoms)
        self.assertEqual((out["kind"], out["name"]), ("pest", "Thrips"))

    def test_disease_reference_reads_plant_disease(self):
        out = self.gallery(name="Powdery Mildew", kind="disease")
        self.assertEqual(out["reference"]["image"],
                         frappe.db.get_value("Plant Disease", "Powdery Mildew", "damage_symptoms"))

    def test_bad_kind_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            self.gallery(kind="weed")


class TestByScout(GalleryCase):
    def seed(self):
        z = self.zones
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=z[0],
               pests=[("Thrips", "Adult", 3), ("Thrips", "Damages", 7)])   # a Sign: not counted
        insert(scout=self.s1, date=TUE, greenhouse=self.gh, zone=z[0], pests=[("Thrips", "Larvae", 2)])
        insert(scout=self.s1, date=WED, greenhouse=self.gh, zone=z[1], pests=[("Aphids", "Adult", 9)])
        insert(scout=self.s2, date=TUE, greenhouse=self.gh, zone=z[2], pests=[("Thrips", "Adult", 1)])

    def test_figures_per_scout(self):
        self.seed()
        out = self.gallery()
        s1 = self.scout(out, self.s1)
        self.assertEqual((s1["entries"], s1["stations"], s1["count"], s1["houses"], s1["lastSeen"]),
                         (2, 1, 5, 1, TUE))
        s2 = self.scout(out, self.s2)
        self.assertEqual((s2["entries"], s2["stations"], s2["count"]), (1, 1, 1))
        self.assertEqual([r["scout"] for r in out["scouts"]], [self.s1, self.s2])  # most entries first
        self.assertTrue(s1["scoutName"])
        self.assertTrue(out["showCount"])

    def test_disease_rows_have_no_count(self):
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zones[0], diseases=["Powdery Mildew"])
        insert(scout=self.s1, date=TUE, greenhouse=self.gh, zone=self.zones[1], diseases=["Powdery Mildew"])
        out = self.gallery(name="Powdery Mildew", kind="disease")
        s1 = self.scout(out, self.s1)
        self.assertEqual((s1["entries"], s1["stations"], s1["houses"]), (2, 2, 1))
        self.assertIsNone(s1["count"])
        self.assertFalse(out["showCount"])

    def test_outside_the_range_is_ignored(self):
        self.seed()
        out = self.gallery(from_date=WED, to_date=SUN)
        self.assertEqual(out["scouts"], [])


class TestPhotos(GalleryCase):
    def test_newest_first_with_paging(self):
        for day in range(30):
            date = (datetime(2031, 12, 1) + timedelta(days=day % 7)).strftime("%Y-%m-%d")
            insert(scout=self.s1, date=date, greenhouse=self.gh, zone=self.zones[0],
                   pests=[("Thrips", "Adult", 1)], photos=[("Thrips", f"p{day}", day)])
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zones[0],
               photos=[("Aphids", "other subject", 0), ("General", "general", 0)])
        first = self.gallery()
        self.assertEqual(len(first["photos"]), G.PHOTOS_PER_PAGE)
        self.assertTrue(first["photosHasMore"])
        stamps = [p["capturedOn"] for p in first["photos"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True))
        p = first["photos"][0]
        self.assertTrue(p["image"].startswith("/private/files/"))
        self.assertEqual((p["scout"], p["house"]), (self.s1, self.gh))
        self.assertTrue(p["scoutName"])
        second = self.gallery(page=1)
        self.assertEqual(len(second["photos"]), 30 - G.PHOTOS_PER_PAGE)
        self.assertFalse(second["photosHasMore"])
        captions = {x["caption"] for x in first["photos"] + second["photos"]}
        self.assertEqual(len(captions), 30)
        self.assertNotIn("other subject", captions)

    def test_photos_outside_scope_are_not_returned(self):
        block = F.avocado_block()
        insert(scout=self.s1, date=MON, block=block, crop="Avocado", photos=[("Thrips", "avo", 0)])
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zones[0],
               photos=[("Thrips", "rose", 0)])
        self.assertEqual([p["caption"] for p in self.gallery()["photos"]], ["rose"])
        other = frappe.db.get_value("Warehouse", {"name": ["!=", self.gh], "warehouse_type": "Greenhouse"}, "name")
        with self.assertRaises(frappe.PermissionError):   # not one of the crop's farms
            self.gallery(greenhouse=other)


class TestUserFarmScope(GalleryCase):
    """The user's own farms bound every scan, whatever the caller passes."""

    def other_house(self):
        farms = tuple(r[0] for r in frappe.db.sql(
            "select farm from `tabFarm Filter` where parenttype='Crop Scouted' and parent='Rose'"))
        return frappe.db.sql(
            """select name from `tabWarehouse` where custom_farm in %s and name != %s and is_group=0
               and warehouse_type='Greenhouse' order by name limit 1""", (farms, self.gh))[0][0]

    def seed_two_houses(self):
        self.other = self.other_house()
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zones[0],
               pests=[("Thrips", "Adult", 1)], photos=[("Thrips", "mine", 0)])
        insert(scout=self.s2, date=MON, greenhouse=self.other,
               pests=[("Thrips", "Adult", 5)], photos=[("Thrips", "theirs", 0)])

    def restricted(self):
        from unittest import mock
        return mock.patch.object(crop_scope, "scoped_greenhouses", return_value={self.gh})

    def test_a_farm_restricted_user_sees_only_their_farms_scouts_and_photos(self):
        self.seed_two_houses()
        both = self.gallery()
        self.assertEqual({r["scout"] for r in both["scouts"]}, {self.s1, self.s2})
        with self.restricted():
            out = self.gallery()
        self.assertEqual([r["scout"] for r in out["scouts"]], [self.s1])
        self.assertEqual([p["caption"] for p in out["photos"]], ["mine"])

    def test_a_greenhouse_outside_the_users_farms_is_refused(self):
        self.seed_two_houses()
        with self.restricted(), self.assertRaises(frappe.PermissionError):
            self.gallery(greenhouse=self.other)

    def test_a_farm_outside_the_users_farms_is_refused(self):
        self.seed_two_houses()
        farm = frappe.db.get_value("Warehouse", self.other, "custom_farm")
        with self.restricted(), mock_farms({"x"}), self.assertRaises(frappe.PermissionError):
            self.gallery(farm=farm)

    def test_the_cache_is_not_shared_between_scopes(self):
        self.seed_two_houses()
        kw = dict(crop="Rose", kind="pest", name="Thrips", from_date=MON, to_date=SUN)
        full = DA.observation_gallery(force="1", **kw)    # unrestricted, cached
        with self.restricted():
            mine = DA.observation_gallery(**kw)           # same args, no force
        self.assertEqual(len(full["scouts"]), 2)
        self.assertEqual([r["scout"] for r in mine["scouts"]], [self.s1])

    def test_page_is_capped(self):
        self.assertEqual(self.gallery(page=10**9)["photosPage"], G.MAX_PAGE)


def mock_farms(farms):
    from unittest import mock
    return mock.patch.object(crop_scope, "scoped_farms", return_value=farms)


class TestScoping(GalleryCase):
    def test_off_crop_observation_is_empty(self):
        insert(scout=self.s1, date=MON, greenhouse=self.gh, zone=self.zones[0],
               pests=[("Fruit fly (Ceratitis)", "Adult", 4)], photos=[("Fruit fly (Ceratitis)", "x", 0)])
        out = self.gallery(name="Fruit fly (Ceratitis)")
        self.assertEqual((out["scouts"], out["photos"]), ([], []))

    def test_other_crops_entries_do_not_count(self):
        block = F.avocado_block()
        tree = frappe.db.get_value("Orchard Tree", {"block": block}, "name")
        insert(scout=self.s1, date=MON, block=block, tree=tree, crop="Avocado", pests=[("FCM", "Adult", 4)])
        insert(scout=self.s2, date=MON, greenhouse=self.gh, zone=self.zones[0], pests=[("FCM", "Adult", 1)])
        rose = self.gallery(name="FCM")
        self.assertEqual([r["scout"] for r in rose["scouts"]], [self.s2])
        avo = self.gallery(name="FCM", crop="Avocado")
        self.assertEqual([(r["scout"], r["count"]) for r in avo["scouts"]], [(self.s1, 4)])

    def test_a_crop_the_user_may_not_see_is_refused(self):
        frappe.set_user(F.PETER)
        with self.assertRaises(frappe.PermissionError):
            self.gallery(name="FCM", crop="Avocado")

    def test_cache_schema_is_gal1(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "gal1")
        self.assertIn(":gal1:observation_gallery:", _common._build_key("observation_gallery", {"crop": "Rose"}))


if __name__ == "__main__":
    unittest.main()
