"""Station grids and weekly station sets on kaitet.local. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts.common import cache_utils, crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF

AVOCADO_PEST = "Fruit fly (Ceratitis)"  # Avocado Pest Filter only


class TestStationGrid(unittest.TestCase):
    def tearDown(self):
        frappe.db.rollback()

    def test_every_zone_of_the_greenhouse_is_placed(self):
        gh = F.rose_greenhouse()
        grid = R._load_grid(gh)
        self.assertEqual(len(grid), frappe.db.count("Zone", {"greenhouse": gh}))
        self.assertEqual(set(grid.values()), {(r, c) for r in range(3) for c in range(3)})

    def test_every_tree_of_a_block_with_tiny_rows_is_placed(self):
        tiny = frappe.db.sql(
            """select block, `row` from `tabOrchard Tree` group by block, `row`
               having count(*) <= 2 order by block, `row` limit 1""", as_dict=True)
        if not tiny:
            self.skipTest("no orchard row of 1–2 trees on this site")
        block, row = tiny[0].block, tiny[0].row
        grid = R._load_grid(block)
        self.assertEqual(len(grid), frappe.db.count("Orchard Tree", {"block": block}))
        cols = {grid[t][1] for t in frappe.get_all("Orchard Tree", filters={"row": row}, pluck="name")}
        self.assertTrue(cols <= {0, 1})

    def test_the_grid_is_cached_and_a_tree_save_drops_it(self):
        block = F.avocado_block()
        cache_utils.invalidate(R.grid_key(block))
        first = R.station_grid(block)
        self.assertEqual(frappe.cache().get_value(R.grid_key(block), expires=True), first)
        tree = frappe.get_all("Orchard Tree", filters={"block": block}, fields=["name", "block", "row"], limit=1)[0]
        cache_utils.invalidate_station_grid_for_doc(frappe._dict(doctype="Orchard Tree", **tree))
        self.assertIsNone(frappe.cache().get_value(R.grid_key(block), expires=True))


class TestStationWeeks(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _zone(self):
        return sorted(R._load_grid(self.gh))[0]

    def test_even_scouting_reads_the_house_prevalence(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        weeks = R.StationWeeks.load(*PF.WEEK_10, "Rose", [self.gh])
        fig = weeks.latest(self.gh, "pest", "Thrips")
        self.assertEqual((fig["scouted"], fig["infested"]), (27, 9))
        self.assertEqual((fig["prevalence"], fig["margin"]), (33.3, 18.0))  # Agresti–Coull floor: p̃ = 11/31 (or 20/31) → 1.96·sqrt(0.22893/27) = 18.0 (was 17.8)
        self.assertEqual((fig["sections_scouted"], fig["reliability"]), (9, "Fair"))
        self.assertEqual(fig["stations"], frappe.db.count("Zone", {"greenhouse": self.gh}))
        self.assertEqual((fig["week"], fig["prev"]), ("2031-W10", None))

    def test_the_previous_scouted_week_comes_from_before_the_window(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        PF.seed_even_week(self.gh, PF.WEEK_11[0], crop="Rose", infested_per_section=0)
        weeks = R.StationWeeks.load(*PF.WEEK_11, "Rose", [self.gh])
        self.assertEqual(weeks.latest_pair(self.gh), ("2031-W11", "2031-W10"))
        fig = weeks.latest(self.gh, "pest", "Thrips")
        self.assertEqual((fig["prevalence"], fig["prev"]), (0.0, 33.3))

    def test_a_house_not_scouted_in_the_window_is_omitted(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        weeks = R.StationWeeks.load(*PF.WEEK_11, "Rose", [self.gh])
        self.assertEqual(weeks.warehouses(), [])
        self.assertIsNone(weeks.latest(self.gh, "pest", "Thrips"))

    def test_mariadb_iso_weeks_match_python_at_week_53(self):
        z = self._zone()
        # 2033-01-02 is a Sunday: ISO week 2032-W53, not 2033-W01.
        PF.insert_station_entry(date=PF.WEEK_53[1], greenhouse=self.gh, zone=z, crop="Rose", pests=["Thrips"])
        PF.insert_station_entry(date=PF.WEEK_01[0], greenhouse=self.gh, zone=z, crop="Rose")
        weeks = R.StationWeeks.load(*PF.WEEK_01, "Rose", [self.gh])
        self.assertEqual(weeks.latest_pair(self.gh), ("2033-W01", "2032-W53"))
        fig = weeks.latest(self.gh, "pest", "Thrips")
        self.assertEqual((fig["prevalence"], fig["prev"]), (0.0, 100.0))

    def test_a_pest_row_with_no_count_and_no_stage_does_not_infest(self):
        z = self._zone()
        PF.insert_station_entry(date=PF.WEEK_10[0], greenhouse=self.gh, zone=z, crop="Rose",
                                pests=["Thrips"], pest_count=0, pest_stage="")
        weeks = R.StationWeeks.load(*PF.WEEK_10, "Rose", [self.gh])
        self.assertEqual(weeks.infested_set(self.gh, "2031-W10", "pest", "Thrips"), set())
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips")["scouted"], 1)

    def test_piece_one_crop_scoping_still_holds(self):
        z = self._zone()
        PF.insert_station_entry(date=PF.WEEK_10[0], greenhouse=self.gh, zone=z, crop=None,
                                pests=["Thrips", AVOCADO_PEST])
        rose = R.StationWeeks.load(*PF.WEEK_10, "Rose", None)
        self.assertIn(self.gh, rose.warehouses())                                        # D5
        self.assertEqual(rose.infested_set(self.gh, "2031-W10", "pest", AVOCADO_PEST), set())  # D4
        self.assertEqual(rose.infested_set(self.gh, "2031-W10", "pest", "Thrips"), {z})
        avocado = R.StationWeeks.load(*PF.WEEK_10, "Avocado", None)
        self.assertNotIn(self.gh, avocado.warehouses())

    def test_avocado_stations_are_trees(self):
        block = F.avocado_block()
        PF.seed_even_week(block, PF.WEEK_10[0], crop="Avocado", pest=AVOCADO_PEST, block=True)
        weeks = R.StationWeeks.load(*PF.WEEK_10, "Avocado", [block])
        fig = weeks.latest(block, "pest", AVOCADO_PEST)
        self.assertEqual(fig["stations"], frappe.db.count("Orchard Tree", {"block": block}))
        self.assertEqual((fig["scouted"], fig["prevalence"], fig["sections_scouted"]), (27, 33.3, 9))
