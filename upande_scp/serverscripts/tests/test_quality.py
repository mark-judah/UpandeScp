"""Data quality tab aggregate (roadmap item 7). DB test — direct runner, rolled back.

Week 2031-W40 (2031-09-29 → 2031-10-05): no other module seeds it and
kaitet.local has no real scouting in 2031.
"""

import unittest
from datetime import date, datetime, timedelta
from importlib import import_module
from unittest.mock import patch

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.common import quality_rules as Q
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF

MON, TUE, SUN = "2031-09-29", "2031-09-30", "2031-10-05"
NEXT_MON, NEXT_SUN = "2031-10-06", "2031-10-12"  # 2031-W41
QM = import_module("upande_scp.serverscripts.dashboard_aggregates._quality")


def scouts(n=2) -> list:
    return [r[0] for r in frappe.db.sql("select name from `tabEmployee` order by name limit %s", (n,))]


def insert(*, scout, date, seconds, greenhouse=None, zone=None, block=None, tree=None, crop="Rose",
           pest=False, dist=None, buf=5.0, sync_s=120) -> str:
    """One entry at `seconds` past midnight, created `sync_s` later; a Metadata
    row when `dist` is given."""
    name = "_TEST-DQ-" + frappe.generate_hash(length=10)
    captured = datetime.strptime(date, "%Y-%m-%d") + timedelta(seconds=seconds)
    created = captured + timedelta(seconds=sync_s)
    bed = frappe.db.get_value("Zone", zone, "bed") if zone else None
    row = frappe.db.get_value("Orchard Tree", tree, "row") if tree else None
    frappe.db.sql(
        """insert into `tabScouting Entry`
           (name, creation, modified, owner, modified_by, docstatus, idx, naming_series,
            scouts_name, greenhouse, block, zone, bed, tree, `row`, date_of_capture,
            time_of_capture, crop_scouted, latitude, longitude)
           values (%(n)s, %(c)s, %(c)s, 'Administrator', 'Administrator', 0, 0, 'SCE-.YYYY.-',
            %(s)s, %(gh)s, %(blk)s, %(z)s, %(bed)s, %(t)s, %(row)s, %(d)s, %(tm)s, %(crop)s, '0', '0')""",
        {"n": name, "c": created, "s": scout, "gh": greenhouse, "blk": block, "z": zone, "bed": bed,
         "t": tree, "row": row, "d": date, "tm": captured.strftime("%H:%M:%S"), "crop": crop},
    )
    if pest:
        pest_name = pest if isinstance(pest, str) else "Thrips"
        frappe.db.sql(
            """insert into `tabPests Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, pest, stage, plant_section, `count`)
               values (%(n)s, %(c)s, %(c)s, 'Administrator', 'Administrator', 0, 1, %(p)s,
                'Scouting Entry', 'pests_scouting_entry', %(pest)s, 'Adult', 'Leaf', 2)""",
            {"n": frappe.generate_hash(length=12), "c": created, "p": name, "pest": pest_name},
        )
    if dist is not None:
        frappe.db.sql(
            """insert into `tabScouting Entry Metadata`
               (name, creation, modified, owner, modified_by, docstatus, idx, scouting_entry,
                distance, zone_buffer, client_id)
               values (%(n)s, %(c)s, %(c)s, 'Administrator', 'Administrator', 0, 0, %(p)s,
                %(d)s, %(b)s, %(n)s)""",
            {"n": "_TEST-DQM-" + frappe.generate_hash(length=10), "c": created, "p": name,
             "d": dist, "b": buf},
        )
    return name


class QualityCase(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        self.zones = sorted(R._load_grid(self.gh))
        self.s1, self.s2 = scouts(2)
        self.today = patch.object(QM, "_today", return_value=date(2031, 10, 10))  # Fri of W41
        self.today.start()

    def tearDown(self):
        self.today.stop()
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def run_quality(self, crop="Rose", to_date=SUN, **kw):
        return DA.quality(from_date=MON, to_date=to_date, crop=crop, force="1", **kw)

    def house(self, out, wh):
        return next(h for h in out["houses"] if h["house"] == wh)

    def scout(self, out, s):
        return next(r for r in out["scouts"] if r["scout"] == s)


class TestFigures(QualityCase):
    @staticmethod
    def s1_times():
        t, out = 8 * 3600, []
        for i in range(60):
            t += 2 if i >= 50 else 10
            out.append(t)
        return out

    def seed(self):
        z = self.zones
        # s1, Monday: 60 entries 10 s apart on 60 zones, 2 s gaps for the last 10,
        # every fix 25 m out (buffer 5) → map offset; pests on the first 30.
        for i, t in enumerate(self.s1_times()):
            insert(scout=self.s1, date=MON, seconds=t, greenhouse=self.gh, zone=z[i],
                   pest=i < 30, dist=25.0, sync_s=300)
        # s1 submits zone 0 twice in the same second → one duplicate, no move.
        insert(scout=self.s1, date=MON, seconds=self.s1_times()[0], greenhouse=self.gh, zone=z[0],
               pest=True, dist=1.0, sync_s=300)
        # s2, Tuesday: 4 entries, no metadata, nothing found on all.
        for i in range(4):
            insert(scout=self.s2, date=TUE, seconds=9 * 3600 + i * 60, greenhouse=self.gh, zone=z[100 + i])

    def test_house_and_scout_figures(self):
        self.seed()
        out = self.run_quality(greenhouse=self.gh)
        h = self.house(out, self.gh)
        self.assertEqual((h["entries"], h["scouts"], h["fixes"]), (65, 2, 61))
        self.assertEqual((h["metadataPct"], h["offZonePct"], h["medianDistance"]), (93.8, 98.4, 25.0))
        self.assertEqual(h["stationsScouted"], 64)
        self.assertEqual(h["stations"], len(self.zones))
        self.assertEqual(h["coveragePct"], round(100 * 64 / len(self.zones), 1))
        self.assertEqual((h["week"], h["weekPartial"]), ("2031-W40", False))

        s1 = self.scout(out, self.s1)
        self.assertEqual((s1["entries"], s1["activeDays"], s1["duplicates"]), (61, 1, 1))
        self.assertEqual((s1["moves"], s1["tooFastPct"]), (59, round(100 * 10 / 59, 1)))
        self.assertEqual(s1["nothingFoundPct"], round(100 * 30 / 61, 1))
        self.assertEqual(s1["medianSyncMin"], 5.0)
        s2 = self.scout(out, self.s2)
        self.assertEqual((s2["entries"], s2["nothingFoundPct"], s2["fixes"], s2["offZonePct"]), (4, 100.0, 0, None))
        self.assertEqual(s2["entriesPerHour"], round(4 / 0.05, 1))

        k = out["kpis"]
        self.assertEqual((k["entries"], k["houses"], k["scouts"]), (65, 1, 2))

    def test_too_fast_matches_the_pure_rule(self):
        self.seed()
        out = self.run_quality(greenhouse=self.gh)
        entries = [(t, self.zones[i]) for i, t in enumerate(self.s1_times())]
        entries.append((self.s1_times()[0], self.zones[0]))
        self.assertEqual(self.scout(out, self.s1)["tooFastPct"], Q.too_fast_share(entries))

    def test_flags_fire(self):
        self.seed()
        out = self.run_quality(greenhouse=self.gh)
        got = {(f["kind"], f["name"]) for f in out["flags"]}
        self.assertIn(("map_offset", self.gh), got)       # median 25 m > 20 over 61 fixes
        self.assertNotIn(("off_zone", self.s1), got)      # 98% off, but so is the house: the map, not the scout
        self.assertTrue(out["kpis"]["zoneMapSuspect"])
        self.assertNotIn(("too_fast", self.s1), got)      # 16.9% of moves ≤ 20
        self.assertIn(("thin_coverage", self.gh), got)    # 64 of hundreds of zones
        self.assertNotIn(("metadata_gap", self.gh), got)  # 93.8% ≥ 50
        self.assertNotIn(("off_zone", self.s2), got)      # no fixes
        self.assertEqual(out["flags"], sorted(out["flags"], key=lambda f: -f["score"]))

    def test_duplicates_flag_and_entries_without_metadata_grey_the_house(self):
        z = self.zones
        for i in range(10):
            insert(scout=self.s1, date=MON, seconds=8 * 3600 + i * 30, greenhouse=self.gh, zone=z[i])
        insert(scout=self.s1, date=MON, seconds=8 * 3600, greenhouse=self.gh, zone=z[0])  # double-submit
        out = self.run_quality(greenhouse=self.gh)
        h = self.house(out, self.gh)
        self.assertFalse(h["gpsReliable"])
        self.assertIsNone(h["medianDistance"])
        got = {(f["kind"], f["name"]) for f in out["flags"]}
        self.assertIn(("metadata_gap", self.gh), got)
        self.assertIn(("duplicates", self.s1), got)       # 1 of 11 = 9.1% > 2


    def test_off_zone_flags_a_scout_25_points_over_their_houses(self):
        z = self.zones
        for i in range(60):
            insert(scout=self.s1, date=MON, seconds=8 * 3600 + i * 30, greenhouse=self.gh, zone=z[i], dist=25.0)
            insert(scout=self.s2, date=MON, seconds=8 * 3600 + i * 30, greenhouse=self.gh, zone=z[60 + i], dist=0.0)
        out = self.run_quality(greenhouse=self.gh)
        s1 = self.scout(out, self.s1)
        self.assertEqual((s1["offZonePct"], s1["houseOffZonePct"]), (100.0, 0.0))  # baseline = the others' fixes
        self.assertEqual(self.scout(out, self.s2)["houseOffZonePct"], 100.0)
        got = {(f["kind"], f["name"]) for f in out["flags"]}
        self.assertIn(("off_zone", self.s1), got)
        self.assertNotIn(("off_zone", self.s2), got)
        self.assertNotIn(("map_offset", self.gh), got)     # median 0 m


class TestCoverageWeek(QualityCase):
    def test_the_unfinished_week_is_skipped_for_the_last_complete_one(self):
        z = self.zones
        for i in range(5):
            insert(scout=self.s1, date=MON, seconds=8 * 3600 + i * 30, greenhouse=self.gh, zone=z[i])
        insert(scout=self.s1, date=NEXT_MON, seconds=8 * 3600, greenhouse=self.gh, zone=z[50])
        h = self.house(self.run_quality(to_date=NEXT_SUN, greenhouse=self.gh), self.gh)
        self.assertEqual((h["week"], h["weekPartial"], h["stationsScouted"]), ("2031-W40", False, 5))

    def test_falls_back_to_the_current_week_marked_partial(self):
        insert(scout=self.s1, date=NEXT_MON, seconds=8 * 3600, greenhouse=self.gh, zone=self.zones[0])
        out = DA.quality(from_date=NEXT_MON, to_date=NEXT_SUN, crop="Rose", greenhouse=self.gh, force="1")
        h = self.house(out, self.gh)
        self.assertEqual((h["week"], h["weekPartial"], h["stationsScouted"]), ("2031-W41", True, 1))
        thin = next(f for f in out["flags"] if f["kind"] == "thin_coverage")
        self.assertIn("partial week", thin["detail"])


    def set_today(self, d):
        self.today.stop()
        self.today = patch.object(QM, "_today", return_value=d)
        self.today.start()

    def test_a_week_cut_by_the_range_start_is_not_complete(self):
        self.set_today(date(2031, 10, 20))
        for i in range(5):
            insert(scout=self.s1, date=TUE, seconds=8 * 3600 + i * 30, greenhouse=self.gh, zone=self.zones[i])
        insert(scout=self.s1, date=NEXT_MON, seconds=8 * 3600, greenhouse=self.gh, zone=self.zones[50])
        out = DA.quality(from_date=TUE, to_date=NEXT_SUN, crop="Rose", greenhouse=self.gh, force="1")
        h = self.house(out, self.gh)
        self.assertEqual((h["week"], h["weekPartial"], h["stationsScouted"]), ("2031-W41", False, 1))

    def test_a_week_cut_by_the_range_end_is_not_complete(self):
        self.set_today(date(2031, 10, 20))
        for i in range(5):
            insert(scout=self.s1, date=MON, seconds=8 * 3600 + i * 30, greenhouse=self.gh, zone=self.zones[i])
        insert(scout=self.s1, date=NEXT_MON, seconds=8 * 3600, greenhouse=self.gh, zone=self.zones[50])
        out = DA.quality(from_date=MON, to_date="2031-10-08", crop="Rose", greenhouse=self.gh, force="1")
        h = self.house(out, self.gh)
        self.assertEqual((h["week"], h["weekPartial"], h["stationsScouted"]), ("2031-W40", False, 5))

    def test_a_house_last_scouted_weeks_ago_is_not_scouted_recently(self):
        self.set_today(date(2031, 10, 30))
        insert(scout=self.s1, date=MON, seconds=8 * 3600, greenhouse=self.gh, zone=self.zones[0])
        out = DA.quality(from_date=MON, to_date="2031-10-26", crop="Rose", greenhouse=self.gh, force="1")
        self.assertEqual(self.house(out, self.gh)["staleDays"], 21)
        kinds = {f["kind"] for f in out["flags"] if f["name"] == self.gh}
        self.assertIn("not_scouted_recently", kinds)
        self.assertNotIn("thin_coverage", kinds)


class TestRangeAndScope(QualityCase):
    def test_the_range_is_capped_at_8_weeks(self):
        out = DA.quality(from_date="2031-01-01", to_date=SUN, crop="Rose", force="1")
        self.assertTrue(out["clamped"])
        self.assertEqual(out["range"], {"from_date": "2031-08-10", "to_date": SUN})
        self.assertFalse(self.run_quality()["clamped"])
        self.assertEqual(self.run_quality()["range"], {"from_date": MON, "to_date": SUN})

    def test_nothing_found_ignores_other_crops_observations(self):
        insert(scout=self.s1, date=MON, seconds=8 * 3600, greenhouse=self.gh, zone=self.zones[0],
               pest="Fruit fly (Ceratitis)")
        insert(scout=self.s1, date=MON, seconds=8 * 3600 + 60, greenhouse=self.gh, zone=self.zones[1], pest=True)
        s1 = self.scout(self.run_quality(greenhouse=self.gh), self.s1)
        self.assertEqual(s1["nothingFoundPct"], 50.0)  # the avocado pest on a rose entry is "nothing found"


class TestScoping(QualityCase):
    def test_crop_scoping_holds(self):
        block = F.avocado_block()
        tree = frappe.db.get_value("Orchard Tree", {"block": block}, "name")
        insert(scout=self.s1, date=MON, seconds=8 * 3600, greenhouse=self.gh, zone=self.zones[0])
        insert(scout=self.s2, date=MON, seconds=8 * 3600, block=block, tree=tree, crop="Avocado")
        rose = self.run_quality()
        self.assertIn(self.gh, [h["house"] for h in rose["houses"]])
        self.assertNotIn(block, [h["house"] for h in rose["houses"]])
        self.assertEqual([s["scout"] for s in rose["scouts"]], [self.s1])
        avo = self.run_quality(crop="Avocado")
        self.assertEqual([h["house"] for h in avo["houses"]], [block])
        self.assertEqual(self.house(avo, block)["stationsScouted"], 1)

    def test_empty_window_is_empty(self):
        out = self.run_quality()
        self.assertEqual((out["houses"], out["scouts"], out["flags"]), ([], [], []))
        self.assertEqual(out["kpis"]["entries"], 0)

    def test_cache_schema_is_psn1(self):
        from upande_scp.serverscripts.dashboard_aggregates import _common
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "psn1")
        self.assertIn(":psn1:quality:", _common._build_key("quality", {"crop": "Rose"}))
