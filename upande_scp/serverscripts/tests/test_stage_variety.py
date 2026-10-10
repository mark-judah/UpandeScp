"""Stage & variety weighting (piece 4). DB test — direct runner; everything is
rolled back in tearDown, then the stage-roles Redis entry is dropped (SV.reset)."""

import unittest
from datetime import date
from importlib import import_module
from unittest.mock import patch

import frappe

from upande_scp.patches.v1_0 import seed_stage_roles
from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import cache_utils, crop_catalog, crop_scope, stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import stage_variety_fixture as SV
from upande_scp.serverscripts.tests import thresholds_fixture as TF

SUN_44 = date(2031, 11, 2)


class StageCase(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        SV.reset()
        self.gh, self.gh2 = PF.rose_greenhouses(2)
        TF.clear_all_bands("Rose")

    def tearDown(self):
        frappe.set_user("Administrator")
        frappe.db.rollback()
        SV.reset()                       # after the rollback: Redis is not transactional
        crop_scope.clear_cache()


class TestSchemaAndSeed(StageCase):
    def test_the_role_column_has_no_db_default_and_weights_default_to_one(self):
        cols = dict(frappe.db.sql(
            """select COLUMN_NAME, COLUMN_DEFAULT from information_schema.COLUMNS
               where TABLE_SCHEMA = database() and TABLE_NAME = 'tabStage'
                 and COLUMN_NAME in ('stage_role', 'weight')"""
        ))
        self.assertIn(cols["stage_role"], (None, "NULL"))   # else ADD COLUMN would pre-fill every row
        self.assertEqual(float(cols["weight"]), 1.0)
        self.assertTrue(frappe.db.has_column("Pests Stages", "weight"))

    def test_a_new_stage_is_a_life_stage_weighing_one(self):
        doc = frappe.get_doc({"doctype": "Stage", "stage_name": "_TEST Stage SV"}).insert(ignore_permissions=True)
        self.assertEqual((doc.stage_role, doc.weight), ("Life stage", 1.0))
        doc.stage_role = ""
        doc.save(ignore_permissions=True)
        self.assertEqual(frappe.db.get_value("Stage", doc.name, "stage_role"), "Life stage")

    def test_the_patch_fills_blank_roles_only(self):
        names = ("Damages", "Motiles", "Eggs", "Colonies", "Web", "Adult")
        stamp = frappe.db.get_value("Stage", "Damages", "modified")
        frappe.db.sql("update `tabStage` set stage_role=NULL where name in ('Damages', 'Motiles', 'Eggs')")
        frappe.db.sql("update `tabStage` set stage_role='' where name='Colonies'")
        frappe.db.sql("update `tabStage` set stage_role='Life stage' where name='Web'")   # an agronomist's call
        frappe.db.sql("update `tabStage` set stage_role='Form' where name='Adult'")
        seed_stage_roles.execute()

        def roles():
            return dict(frappe.db.sql("select name, stage_role from `tabStage` where name in %s", (names,)))

        expected = {"Damages": "Sign", "Motiles": "Form", "Eggs": "Life stage", "Colonies": "Form",
                    "Web": "Life stage", "Adult": "Form"}
        self.assertEqual(roles(), expected)
        self.assertEqual(frappe.db.get_value("Stage", "Damages", "modified"), stamp)
        seed_stage_roles.execute()                                # a rerun changes nothing
        self.assertEqual(roles(), expected)

    def test_the_catalog_reads_roles_weights_and_per_crop_overrides(self):
        for stage, role in (("Web", "Sign"), ("Eggs", "Life stage"), ("Motiles", "Form"),
                            ("Singles", "Form"), ("Colonies", "Form")):
            SV.set_role(stage, role)
        SV.set_master_weight("Eggs", 0.5)
        SV.set_override("Rose", "Spidermites", "Eggs", 0.25)
        self.assertEqual(stage_roles.role_map()["Web"], "Sign")
        self.assertEqual(stage_roles.master_weight("Eggs"), 0.5)
        self.assertEqual(stage_roles.stage_weight("Rose", "Spidermites", "Eggs"), 0.25)
        self.assertEqual(stage_roles.stage_weight("Rose", "Whiteflies", "Eggs"), 0.5)
        self.assertEqual(stage_roles.pest_weights("Rose", "Spidermites")["Eggs"], 0.25)
        self.assertEqual(stage_roles.sign_stages("Rose", "Spidermites"), ["Web"])
        self.assertEqual(stage_roles.sign_stages("Rose", "Aphids"), [])            # Singles, Colonies: forms

    def test_a_zero_override_inherits_the_master_weight(self):
        SV.set_master_weight("Eggs", 0.5)
        SV.set_override("Rose", "Spidermites", "Eggs", 0)
        self.assertEqual(stage_roles.stage_weight("Rose", "Spidermites", "Eggs"), 0.5)

    def test_a_stage_change_drops_the_cached_roles_and_the_dashboards(self):
        SV.set_role("Eggs", "Life stage")
        self.assertEqual(stage_roles.role_map()["Eggs"], "Life stage")           # now cached
        frappe.db.sql("update `tabStage` set stage_role='Sign' where name='Eggs'")
        self.assertEqual(stage_roles.role_map()["Eggs"], "Life stage")           # still the cached copy
        frappe.cache().delete_value(_common.K_DASH_AGG_BUMP_LOCK)                # the bump is debounced
        before = _common.dash_agg_version()
        cache_utils.invalidate_on_change(frappe._dict(doctype="Stage", name="Eggs"))
        self.assertEqual(stage_roles.role_map()["Eggs"], "Sign")
        self.assertNotEqual(_common.dash_agg_version(), before)                  # payloads judged by roles
        frappe.db.sql("update `tabPests Stages` set weight=0.25 where parenttype='Pest Filter' and stage='Eggs'")
        self.assertNotEqual(stage_roles.master_weight("Eggs"), None)             # warm the cache again
        cache_utils.invalidate_on_change(frappe._dict(doctype="Pests Stages"))
        self.assertEqual(stage_roles.stage_weight("Rose", "Spidermites", "Eggs"), 0.25)

    def test_a_rolled_back_role_change_never_outlives_the_test(self):
        real = stage_roles.role_map().get("Eggs")
        SV.set_role("Eggs", "Sign" if real != "Sign" else "Life stage")
        self.assertNotEqual(stage_roles.role_map()["Eggs"], real)                # cached inside the transaction
        self.tearDown()                                                          # rollback, then SV.reset()
        self.assertEqual(stage_roles.role_map()["Eggs"], real)

    def test_catalog_reads_the_real_columns_after_the_schema_exists(self):
        """The has_column fallbacks must not mask the real columns: the roles
        in the catalog are the stored ones, not the Life-stage fallback."""
        SV.reset()
        stored = dict(frappe.db.sql("select name, stage_role from `tabStage`"))
        self.assertTrue(stored, "no stages on this site")
        cat = stage_roles.catalog()
        self.assertEqual(set(cat["roles"]), set(stored))
        for name, role in stored.items():
            self.assertEqual(cat["roles"][name], stage_roles.normalise_role(role), name)
        self.assertEqual(cat["roles"]["Damages"], "Sign")
        self.assertEqual(cat["roles"]["Motiles"], "Form")
        self.assertTrue(all(w == 1.0 for w in cat["weights"].values()))


TC = import_module("upande_scp.serverscripts.scouting.thresholds_check")


class TestLiveFigure(StageCase):
    def setUp(self):
        super().setUp()
        for stage, role in (("Adult", "Life stage"), ("Damages", "Sign"), ("Damage", "Sign"),
                            ("Motiles", "Form"), ("Eggs", "Life stage"), ("Web", "Sign"),
                            ("Adult Moth", "Life stage"), ("Larvae", "Life stage"), ("Pupae", "Life stage")):
            SV.set_role(stage, role)
        for stage in ("Motiles", "Eggs", "Adult Moth", "Larvae", "Pupae"):
            SV.set_master_weight(stage, 1)
            SV.set_override("Rose", "Spidermites", stage, 0)

    def test_a_damages_only_station_is_out_of_the_live_figure_and_in_signs(self):
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Adult", infested_per_section=1)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Damages", infested_per_section=2)
        weeks = R.StationWeeks.load(*SV.WEEK_44, "Rose", None)
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips")["prevalence"], 33.3)
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips", "Damages")["prevalence"], 66.7)

    def test_evaluate_judges_the_live_figure(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Damages", infested_per_section=3)  # signs 100 %
        found = [f for f in TC.evaluate("Rose", SUN_44)
                 if f["warehouse"] == self.gh and f["observation"] == "Thrips" and not f["stage"]]
        house = [f for f in found if f.get("alert_type", "House") == "House"]
        self.assertEqual([(f["value"], f["action"]) for f in house], [(0.0, None)])
        self.assertFalse([f for f in found if f["action"]])                  # no hot spot either
        with patch.object(TC.notifications, "notify", return_value=[]), patch.object(frappe, "sendmail"):
            TC.check_crop("Rose", SUN_44)
        self.assertEqual(frappe.db.count("Scouting Alert", {"warehouse": self.gh, "iso_week": "2031-W44"}), 0)

    def test_a_count_row_never_sums_a_sign_stage(self):
        TF.set_bands("Rose", "FCM", 0, 1, 2, measure="Count")
        spec = _common.band_spec("Rose", "pest", "FCM", "")
        self.assertEqual(spec["measure"], "Count")
        self.assertEqual(spec["count_stages"], frozenset({"Adult Moth", "Larvae", "Eggs", "Pupae"}))  # no "Damage"
        self.assertEqual(dict(spec["count_weights"]), {"Adult Moth": 1.0, "Larvae": 1.0, "Eggs": 1.0, "Pupae": 1.0})

    def _spidermites(self):
        """Motiles 3 and Eggs 6 on station 0 of each section: 1.0 + 2.0 per zone."""
        TF.set_bands("Rose", "Spidermites", 0, 1, 5, measure="Count")
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", pest="Spidermites", stage="Motiles", count=3)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", pest="Spidermites", stage="Eggs", count=6)
        return R.StationWeeks.load(*SV.WEEK_44, "Rose", None)

    def _value(self, weeks, stage=""):
        _common.clear_threshold_cache()
        return _common.house_value("Rose", "pest", "Spidermites", stage, weeks, self.gh, None)

    def test_weights_of_one_reproduce_todays_count(self):
        weeks = self._spidermites()
        plain = weeks.count_latest(self.gh, "pest", "Spidermites", stages=frozenset({"Motiles", "Eggs"}))
        self.assertEqual((self._value(weeks), plain["value"]), (3.0, 3.0))

    def test_half_weight_on_eggs_halves_their_contribution(self):
        weeks = self._spidermites()
        SV.set_master_weight("Eggs", 0.5)
        self.assertEqual(self._value(weeks), 2.0)                            # 1.0 + 0.5 × 2.0

    def test_a_crop_override_beats_the_master_and_zero_inherits(self):
        weeks = self._spidermites()
        SV.set_master_weight("Eggs", 0.5)
        SV.set_override("Rose", "Spidermites", "Eggs", 0.25)
        self.assertEqual(self._value(weeks), 1.5)                            # 1.0 + 0.25 × 2.0
        SV.set_override("Rose", "Spidermites", "Eggs", 0)
        self.assertEqual(self._value(weeks), 2.0)

    def test_a_stage_band_reads_raw_counts_whatever_the_weight(self):
        TF.set_bands("Rose", "Spidermites", 0, 1, 5, measure="Count", stage_bands={"Eggs": (0, 1, 3)})
        weeks = self._spidermites()
        SV.set_master_weight("Eggs", 0.5)
        self.assertEqual(_common.band_spec("Rose", "pest", "Spidermites", "Eggs")["count_weights"], ())
        self.assertEqual(self._value(weeks, "Eggs"), 2.0)                    # 6 / 3, unweighted


O = import_module("upande_scp.serverscripts.dashboard_aggregates._overview")


class TestSignsOnPayloads(StageCase):
    """Thrips Adult on station 0 of each section (live 33.3 %), Damages on
    stations 0 and 1 (signs 66.7 %); Aphids Singles on station 0 (no Sign stage)."""

    def setUp(self):
        super().setUp()
        for stage, role in (("Adult", "Life stage"), ("Larvae", "Life stage"), ("Damages", "Sign"),
                            ("Singles", "Form"), ("Colonies", "Form")):
            SV.set_role(stage, role)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Adult", infested_per_section=1)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Damages", infested_per_section=2)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", pest="Aphids", stage="Singles", infested_per_section=1)
        self.range = {"from_date": SV.WEEK_44[0], "to_date": SV.WEEK_44[1], "crop": "Rose", "force": "1"}

    def test_overview_cells_and_alerts_carry_the_signs(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)          # the Adult cell (33.3 %) reads Moderate
        where, params = _common.parent_filter_conditions(*SV.WEEK_44, "Rose", None)
        weeks = R.StationWeeks.load(*SV.WEEK_44, "Rose", None)
        cells = O._classify_cells(O._observation_rows(where, params), "Rose", weeks)[1]
        adult = next(c for c in cells
                     if c["greenhouse"] == self.gh and c["obs_name"] == "Thrips" and c["stage"] == "Adult")
        self.assertEqual((adult["prevalence"], adult["signs"]["prevalence"]), (33.3, 66.7))
        aphids = next(c for c in cells if c["greenhouse"] == self.gh and c["obs_name"] == "Aphids")
        self.assertIsNone(aphids["signs"])                  # Singles / Colonies: no Sign stage on the row
        alert = next(a for a in O._active_alerts_from_cells(cells) if a["name"] == "Thrips" and a["stage"] == "Adult")
        self.assertEqual(alert["signs"]["prevalence"], 66.7)

    def test_pests_ranking_and_pressure_carry_the_signs(self):
        out = DA.pests(**self.range)
        thrips = next(r for r in out["ranking"] if r["name"] == "Thrips")
        self.assertEqual((thrips["prevalence"], thrips["signs"]["prevalence"]), (33.3, 66.7))
        self.assertIsNone(next(r for r in out["ranking"] if r["name"] == "Aphids")["signs"])
        picked = DA.pests(observation="Thrips", **self.range)
        row = next(r for r in picked["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual((row["pct"], row["signs"]["prevalence"]), (33.3, 66.7))
        staged = DA.pests(observation="Thrips", stage="Damages", **self.range)
        row = next(r for r in staged["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual((row["pct"], row["signs"]), (66.7, None))             # a named stage: no signs beside it

    def test_the_greenhouse_detail_row_carries_the_signs(self):
        out = DA.greenhouse_detail(greenhouse=self.gh, **self.range)
        thrips = next(p for p in out["prevalence"] if p["name"] == "Thrips")
        self.assertEqual((thrips["prevalence"], thrips["signs"]["prevalence"]), (33.3, 66.7))

    def test_trends_carry_signs_rows_beside_the_live_rows(self):
        out = DA.trends(**self.range)
        v = out["vocab"]
        w, s, o = v["weeks"].index("2031-W44"), v["stations"].index(self.gh), v["obs"].index("pest:Thrips")
        live = next(r for r in out["prevalenceByStation"] if r[:3] == [w, s, o])
        self.assertEqual(live[3], 33.3)
        self.assertIn([w, s, o, 66.7], out["signsByStation"])
        aphids = v["obs"].index("pest:Aphids")
        self.assertEqual([r for r in out["signsByStation"] if r[2] == aphids], [])

    def test_aggregate_keys_carry_the_stg1_schema(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "stg1")
        self.assertIn(":stg1:pests:", _common._build_key("pests", {"crop": "Rose"}))
