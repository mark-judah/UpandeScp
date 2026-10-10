"""Spread (piece 3c): station ranks, a house's patches week to week, and the
digest's patch note. DB test — direct runner; rolled back in tearDown."""

import unittest
from datetime import date

import frappe

from upande_scp.serverscripts.common import cache_utils, crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import spread as S
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import spread_fixture as SF
from upande_scp.serverscripts.tests import thresholds_fixture as TF

U_STRANGER = "_test_scp_pin_stranger@example.com"   # may see no farm


class SpreadCase(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = PF.rose_greenhouses(1)[0]

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def found(self, week, gh=None, crop="Rose", obs="Thrips", stage=None):
        out = S.house_clusters(crop, gh or self.gh, obs, "pest", stage, week)
        return ([(c["size"], c["change"], c["prev_size"]) for c in out["clusters"]],
                [(g["size"], g["change"]) for g in out["gone"]], out)


class TestStationRanks(SpreadCase):
    def test_ranks_follow_bed_then_zone_order(self):
        ranks = R._load_ranks([self.gh])[self.gh]
        rows = frappe.db.sql(
            """select z.name, b.bed as bed_no, z.zone as zone_no from `tabZone` z
               left join `tabBed` b on b.name = z.bed where z.greenhouse = %s""",
            (self.gh,), as_dict=True,
        )
        self.assertEqual(len(ranks), len(rows))
        self.assertEqual(len(set(ranks.values())), len(ranks))          # one station per rank
        by_order = sorted(rows, key=lambda r: (int(r.bed_no), int(r.zone_no), r.name))
        self.assertEqual(sorted(ranks, key=ranks.get), [r.name for r in by_order])

    def test_the_grid_is_the_ranks_cut_in_thirds(self):
        ranks = R._load_ranks([self.gh])[self.gh]
        grid = R._load_grid(self.gh)
        groups = 1 + max(r for r, _c in ranks.values())
        size: dict = {}
        for r, _c in ranks.values():
            size[r] = size.get(r, 0) + 1
        for st, (r, c) in ranks.items():
            self.assertEqual(tuple(grid[st]), ((3 * r) // groups, (3 * c) // size[r]))

    def test_trees_rank_by_their_names_trailing_number(self):
        block = F.avocado_block()
        ranks = R._load_ranks([block])[block]
        self.assertEqual(len(ranks), frappe.db.count("Orchard Tree", {"block": block}))
        first_row = sorted((c, st) for st, (r, c) in ranks.items() if r == 0)
        numbers = [int(st.rsplit("T", 1)[1]) for _c, st in first_row]
        self.assertEqual(numbers, sorted(set(numbers)))

    def test_ranks_are_cached_and_a_zone_save_drops_them(self):
        cache_utils.invalidate(R.ranks_key(self.gh))
        first = R.station_ranks(self.gh)
        self.assertEqual(frappe.cache().get_value(R.ranks_key(self.gh), expires=True), first)
        zone = frappe.get_all("Zone", filters={"greenhouse": self.gh}, fields=["name", "greenhouse"], limit=1)[0]
        cache_utils.invalidate_station_grid_for_doc(frappe._dict(doctype="Zone", **zone))
        self.assertIsNone(frappe.cache().get_value(R.ranks_key(self.gh), expires=True))
        self.assertIsNone(frappe.cache().get_value(R.grid_key(self.gh), expires=True))


class TestHouseClusters(SpreadCase):
    def test_a_two_week_house_tracks_grew_new_and_gone(self):
        SF.seed_cells(self.gh, SF.monday(30), SF.rect(0, 0, 2, 3) + SF.rect(10, 0, 1, 3) + SF.rect(20, 0, 1, 2))
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 3, 3) + SF.rect(30, 0, 1, 4))
        now, gone, out = self.found("2031-W31")
        self.assertEqual((out["week"], out["prev_week"], out["unit"]), ("2031-W31", "2031-W30", "bed"))
        self.assertEqual(now, [(9, "Grew", 6), (4, "New", None)])        # the pair of 2 is no patch
        self.assertEqual(gone, [(3, "Gone")])
        top = out["clusters"][0]
        inv = SF.by_rank(self.gh)
        self.assertEqual(top["stations"], sorted(inv[c] for c in SF.rect(0, 0, 3, 3)))
        self.assertEqual((top["id"], top["label"], top["rows"], top["cols"]), ("P1", "beds 1–3, zones 1–3", [0, 2], [0, 2]))
        self.assertEqual(out["gone"][0]["label"], "bed 11, zones 1–3")

    def test_a_patch_two_beds_along_with_no_overlap_moved(self):
        SF.seed_cells(self.gh, SF.monday(30), SF.rect(40, 0, 1, 3))
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(42, 0, 1, 3))
        self.assertEqual(self.found("2031-W31")[:2], ([(3, "Moved", 3)], []))

    def test_the_previous_week_is_not_capped_at_five(self):
        cells = []
        for k in range(5):
            cells += SF.rect(3 * k, 0, 1, 4)                                # five patches of 4
        cells += SF.rect(15, 0, 1, 3)                                       # the sixth, of 3
        SF.seed_cells(self.gh, SF.monday(30), cells)
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(15, 0, 1, 3))
        now, gone, _out = self.found("2031-W31")
        self.assertEqual(now, [(3, "Stable", 3)])
        self.assertEqual(gone, [(4, "Gone")] * 5)

    def test_one_stage_narrows_and_every_stage_is_the_default(self):
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 1, 3), stage="Adult")
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(5, 0, 1, 3), stage="Larva")
        self.assertEqual(len(self.found("2031-W31")[2]["clusters"]), 2)
        larva = self.found("2031-W31", stage="Larva")[2]["clusters"]
        self.assertEqual([c["rows"] for c in larva], [[5, 5]])

    def test_an_avocado_block_speaks_rows_and_trees(self):
        block = F.avocado_block()
        SF.seed_cells(block, SF.monday(31), SF.rect(0, 0, 2, 2), crop="Avocado", pest=SF.AVOCADO_PEST, block=True)
        now, _gone, out = self.found("2031-W31", gh=block, crop="Avocado", obs=SF.AVOCADO_PEST)
        self.assertEqual((now, out["unit"]), ([(4, "New", None)], "row"))
        self.assertEqual(out["clusters"][0]["label"], "rows 1–2, trees 1–2")

    def test_a_week_that_does_not_exist_is_refused(self):
        self.assertEqual(S.normalize_week("2031-W5"), "2031-W05")
        self.assertEqual(S.normalize_week("2026-W53"), "2026-W53")           # a 53-week year
        with self.assertRaises(frappe.ValidationError):
            S.normalize_week("2031-W53")                                     # 2031 has 52

    def test_a_week_without_scouting_is_empty(self):
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 1, 3))
        out = S.house_clusters("Rose", self.gh, "Thrips", "pest", None, "2031-W29")
        self.assertEqual((out["week"], out["clusters"], out["gone"]), (None, [], []))

    def test_the_endpoint_checks_access_and_resolves_the_crop(self):
        TF.ensure_user(U_STRANGER)          # commits, so it runs before anything is seeded
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 1, 3))
        got = S.get_house_clusters("rose", self.gh, "Thrips", "Pest", week="2031-W31", force=1)
        self.assertEqual([c["size"] for c in got["clusters"]], [3])
        self.assertEqual(S.get_house_clusters("Rose", self.gh, "", "pest"), S.empty())
        with self.assertRaises(frappe.ValidationError):
            S.get_house_clusters("Rose", self.gh, "Thrips", "insect", week="2031-W31", force=1)
        frappe.set_user(U_STRANGER)
        crop_scope.clear_cache()
        with self.assertRaises(frappe.PermissionError):
            S.get_house_clusters("Rose", self.gh, "Thrips", "pest", week="2031-W31", force=1)

    def test_the_dashboard_cache_schema_moves_to_stg1(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "stg1")


class TestDigestNote(SpreadCase):
    def setUp(self):
        super().setUp()
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 2, 3))         # 6 zones in "first beds · front"

    def test_a_hot_section_inside_a_patch_names_it(self):
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W31", 0, 0), "patch of 6 zones, new")
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W31", 2, 2), "")
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W30", 0, 0), "")
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W31", -1, -1), "")

    def test_an_avocado_patch_says_trees(self):
        block = F.avocado_block()
        SF.seed_cells(block, SF.monday(31), SF.rect(0, 0, 2, 2), crop="Avocado", pest=SF.AVOCADO_PEST, block=True)
        self.assertEqual(
            S.patch_note("Avocado", block, "Pest", SF.AVOCADO_PEST, "2031-W31", 0, 0), "patch of 4 trees, new")

    def test_the_digest_adds_the_note_to_hot_spot_rows_only(self):
        from upande_scp.serverscripts.scouting import alert_digest as D

        base = frappe._dict(
            crop="Rose", farm=frappe.db.get_value("Warehouse", self.gh, "custom_farm"), warehouse=self.gh,
            kind="Pest", observation="Thrips", stage="", iso_week="2031-W31", measure="Percentage", unit="%",
            value=50.0, margin=None, reliability="Fair", sections_scouted=6, band="High", station_word="zone",
        )
        spot = frappe._dict(base, action="Hot spot", alert_type="Hot spot", section_row=0, section_col=0,
                            section_label="first beds · front", sections_total=1, house_value=20.0)
        house = frappe._dict(base, action="Alarming", alert_type="House", section_row=-1, section_col=-1,
                             section_label="", sections_total=9)
        html = D.render([house, spot], date(2031, 8, 3))
        self.assertEqual(html.count("patch of 6 zones, new"), 1)
        self.assertIn("first beds · front · patch of 6 zones, new", html)
