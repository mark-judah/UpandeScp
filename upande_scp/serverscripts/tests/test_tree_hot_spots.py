"""Per-tree hot spots for block crops, beside the per-hectare block alert.

Pure rules run anywhere; the integration tests use the site's real Lokitela
avocado scouting (week of 2026-10-12), set per-tree bands inside a transaction
and roll everything back. Notifications are mocked."""
import unittest
from datetime import date
from unittest import mock

import frappe

from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.scouting import tree_hot_spots as T

SPEC = {"low": 0, "mod": 3, "high": 6}
# a 3 x 6 orchard: rank (row, tree)
RANKS = {f"T{r}{c}": (r, c) for r in range(3) for c in range(6)}


class TestPureRules(unittest.TestCase):
    def test_trees_at_moderate_or_above_are_over_band(self):
        over = T.over_band_trees({"T00": 2, "T01": 3, "T02": 6, "T03": 0}, SPEC)
        self.assertEqual(over, {"T01": "moderate", "T02": "high"})

    def test_neighbouring_over_band_trees_make_one_hot_spot(self):
        counts = {"T00": 3, "T01": 4, "T11": 3, "T05": 9}   # T05 is alone
        spots = T.find_spots(RANKS, counts, SPEC)
        self.assertEqual(len(spots), 1)
        s = spots[0]
        self.assertEqual((s["size"], s["band"], s["peak"]), (3, "moderate", 4))
        self.assertEqual(s["trees"], ["T00", "T01", "T11"])
        self.assertEqual((s["anchor_row"], s["anchor_col"]), (0, 0))
        self.assertIn("3 trees", s["label"])
        self.assertIn("rows 1–2", s["label"])

    def test_a_lone_tree_is_not_a_hot_spot(self):
        self.assertEqual(T.find_spots(RANKS, {"T00": 9}, SPEC), [])

    def test_trees_two_rows_apart_do_not_join(self):
        self.assertEqual(T.find_spots(RANKS, {"T00": 4, "T20": 4}, SPEC), [])

    def test_high_when_any_tree_reaches_high(self):
        (s,) = T.find_spots(RANKS, {"T00": 3, "T01": 7}, SPEC)
        self.assertEqual((s["band"], s["peak"]), ("high", 7))

    def test_two_separate_patches_are_two_hot_spots(self):
        spots = T.find_spots(RANKS, {"T00": 3, "T01": 3, "T04": 3, "T05": 3}, SPEC)
        self.assertEqual(sorted(s["anchor_col"] for s in spots), [0, 4])

    def test_notice_levels_match_the_house_alert(self):
        self.assertEqual(T.action_of("moderate"), B.ALARMING)
        self.assertEqual(T.action_of("high"), B.SPRAY_ADVISED)

    def test_tree_hot_spot_keys_differ_from_house_and_section_hot_spots(self):
        from upande_scp.serverscripts.scouting import thresholds_check as TC

        a = TC.alert_name("B", "Pest", "X", "", "2026-W42", B.TREE_HOT_SPOT, 3, 1)
        self.assertNotEqual(a, TC.alert_name("B", "Pest", "X", "", "2026-W42", B.HOT_SPOT, 3, 1))
        self.assertNotEqual(a, TC.alert_name("B", "Pest", "X", "", "2026-W42"))
        self.assertNotEqual(a, TC.alert_name("B", "Pest", "X", "", "2026-W42", B.TREE_HOT_SPOT, 3, 2))


TODAY = date(2026, 10, 18)


class TestOnRealBlocks(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.addCleanup(frappe.db.rollback)
        from upande_scp.serverscripts.dashboard_aggregates import _common
        from upande_scp.serverscripts.scouting import cumulative_per_ha as C

        if not C.is_block_crop("Avocado"):
            self.skipTest("no avocado block crop on this site")
        self.C, self._common = C, _common
        names = frappe.get_all("Pest Filter", filters={"crop_scouted": "Avocado", "measure": "Count"}, pluck="name")
        if not names:
            self.skipTest("no avocado Count pests")
        for n in names:
            frappe.db.set_value("Pest Filter", n, {"low_threshold": 0, "moderate_threshold": 1, "high_threshold": 2})
        _common.clear_threshold_cache()
        self.addCleanup(_common.clear_threshold_cache)
        self.findings = T.findings("Avocado", TODAY)
        if not self.findings:
            self.skipTest("no tree hot spots in this site's data for the week of 2026-10-12")

    def raise_bands(self, moderate, high):
        for n in frappe.get_all("Pest Filter", filters={"crop_scouted": "Avocado", "measure": "Count"}, pluck="name"):
            frappe.db.set_value("Pest Filter", n, {"moderate_threshold": moderate, "high_threshold": high})
        self._common.clear_threshold_cache()

    def alerts(self, **extra):
        return frappe.get_all("Scouting Alert", filters={"crop": "Avocado", "alert_type": B.TREE_HOT_SPOT, **extra},
                              fields=["name", "status", "band", "action", "warehouse", "section_label", "notified_band"])

    def test_findings_are_tree_hot_spots_with_the_house_notice_levels(self):
        for f in self.findings:
            self.assertEqual(f["alert_type"], B.TREE_HOT_SPOT)
            self.assertEqual(f["measure"], B.COUNT)
            self.assertGreaterEqual(f["sections_scouted"], T.MIN_TREES)
            self.assertEqual(f["action"], B.SPRAY_ADVISED if f["band"] == "high" else B.ALARMING)

    def test_raised_once_per_week_and_resolved_when_clear(self):
        from upande_scp.serverscripts.scouting import thresholds_check as TC

        with mock.patch.object(TC, "_notify", return_value=["u@x.com"]) as notify:
            r1 = TC.check_crop("Avocado", TODAY)
            n1 = len(self.alerts(status="Open"))
            r2 = TC.check_crop("Avocado", TODAY)
        self.assertEqual(n1, len(self.findings))
        self.assertEqual(len(self.alerts()), n1, "a second run must not duplicate")
        spot_calls = [c for c in notify.call_args_list if c.args[1].get("alert_type") == B.TREE_HOT_SPOT]
        self.assertEqual(len(spot_calls), n1, "each hot spot is announced once")
        self.assertGreater(r1["alerts"], 0)
        # the trees recover: the alerts resolve
        self.raise_bands(500, 600)
        TC.check_crop("Avocado", TODAY)
        self.assertEqual(len(self.alerts(status="Open")), 0)
        self.assertEqual(len(self.alerts(status="Resolved")), n1)

    def test_a_high_hot_spot_escalates_from_moderate_once(self):
        from upande_scp.serverscripts.scouting import thresholds_check as TC

        self.raise_bands(1, 500)     # Moderate only
        with mock.patch.object(TC, "_notify", return_value=["u@x.com"]) as notify:
            TC.check_crop("Avocado", TODAY)
            spots = lambda: len([c for c in notify.call_args_list if c.args[1].get("alert_type") == B.TREE_HOT_SPOT])
            moderate = spots()
            self.assertTrue(all(a.band == "Moderate" and a.action == "Alarming" for a in self.alerts()))
            self.raise_bands(1, 1.5)   # trees of 2 or more are High now
            TC.check_crop("Avocado", TODAY)
            self.assertGreater(spots(), moderate)
        self.assertTrue(any(a.band == "High" and a.action == "Spray advised" for a in self.alerts(status="Open")))

    def test_the_per_ha_block_alert_still_fires_beside_them(self):
        from upande_scp.serverscripts.scouting import thresholds_check as TC

        # a very low per-ha line on every avocado pest: every block with a figure crosses it
        for n in frappe.get_all("Pest Filter", filters={"crop_scouted": "Avocado"}, pluck="name"):
            frappe.db.set_value("Pest Filter", n, "cumulative_per_ha_threshold", 0.01)
        found = TC.evaluate("Avocado", TODAY)
        kinds = {f["alert_type"] for f in found}
        self.assertEqual(kinds, {B.HOUSE, B.TREE_HOT_SPOT})
        self.assertTrue(all(f["measure"] == B.PER_HA for f in found if f["alert_type"] == B.HOUSE))
        with mock.patch.object(TC, "_notify", return_value=[]):
            TC.check_crop("Avocado", TODAY)
        types = {a.alert_type for a in frappe.get_all("Scouting Alert", filters={"crop": "Avocado", "status": "Open"},
                                                      fields=["alert_type"])}
        self.assertEqual(types, {B.HOUSE, B.TREE_HOT_SPOT})
        # open alerts list both, the per-ha one with its line
        rows = TC.open_alerts("Avocado")
        house = [r for r in rows if r.alert_type == B.HOUSE]
        self.assertTrue(house and all(r.threshold for r in house))

    def test_the_block_modal_and_heatmap_list_the_hot_spots(self):
        from upande_scp.serverscripts.scouting import thresholds_check as TC

        with mock.patch.object(TC, "_notify", return_value=[]):
            TC.check_crop("Avocado", TODAY)
        f = self.findings[0]
        mine = T.open_for_block(f["warehouse"])
        self.assertTrue(any(m["observation"] == f["observation"] for m in mine))
        self.assertEqual(T.open_for_block(f["warehouse"], "No such pest"), [])
        self.assertTrue(T.tree_bands("Avocado", f["observation"]))

    def test_weekly_email_lists_hot_spots_and_stays_small(self):
        from upande_scp.serverscripts.reports import block_weekly_email as E

        f = self.findings[0]
        farm = frappe.db.get_value("Warehouse", f["warehouse"], "custom_farm")
        data = E.collect("Avocado", farm, date(2026, 10, 12))
        self.assertTrue(data["hot_spots"])
        html = E.render(data)
        self.assertIn("Hot spots by tree", html)
        self.assertIn(frappe.utils.escape_html(f["warehouse"]), html)
        self.assertLess(len(html.encode()), 100_000)

    def test_the_thresholds_bundle_says_when_bands_find_hot_spots(self):
        from upande_scp.serverscripts.store import thresholds_api

        self.assertTrue(thresholds_api.get_thresholds("Avocado")["tree_hot_spots"])
