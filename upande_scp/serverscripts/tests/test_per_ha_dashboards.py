"""Block-grown crops' dashboards and alert cards are cumulative per hectare.

Mocked at the engine's edge (``round_figures`` / thresholds / block crop test), so
no data is written; a greenhouse crop must be left exactly as it was.
"""

import unittest
from datetime import date
from unittest import mock

from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _per_ha
from upande_scp.serverscripts.scouting import alert_digest, cumulative_per_ha as C, thresholds_check as T


def fig(block, obs, per_ha, threshold, cumulative=10.0, area=2.0, kind="pest"):
    return {"block": block, "farm": "F", "crop": "Avocado", "kind": kind, "observation": obs,
            "cumulative": cumulative, "area_ha": area, "per_ha": per_ha, "threshold_per_ha": threshold,
            "crossed_on": None, "daily": [], "scouts": []}


class TestUnits(unittest.TestCase):
    def test_per_ha_unit_and_format(self):
        self.assertEqual(B.unit_label(B.PER_HA, "tree"), "/ ha this week")
        self.assertEqual(B.format_value(12.4, B.unit_label(B.PER_HA)), "12.4 / ha this week")

    def test_editor_measures_are_unchanged(self):
        self.assertNotIn(B.PER_HA, B.MEASURES)
        self.assertIn(B.PER_HA, B.ALERT_MEASURES)


class TestAlertFindings(unittest.TestCase):
    def _run(self, today=date(2026, 10, 14), figs=None, scouted=None):
        figs = figs if figs is not None else [fig("B1", "Fruit fly", 12.0, 10.0), fig("B1", "Thrips", 3.0, 10.0),
                                              fig("B1", "NoLine", 50.0, 0), fig("B2", "Fruit fly", None, 10.0, area=None)]
        scouted = scouted if scouted is not None else {"B1", "B2"}
        by_block = {}
        for f in figs:
            by_block.setdefault(f["block"], []).append(f)
        with mock.patch.object(C, "thresholds", return_value={("pest", "Fruit fly"): 10.0}), \
             mock.patch.object(C.crop_catalog, "greenhouses_for_crop", return_value=["B1", "B2"]), \
             mock.patch.object(C, "_scouted_blocks", side_effect=lambda b, s, e: scouted if s == date(2026, 10, 12) else set()), \
             mock.patch.object(C, "round_figures", return_value=by_block):
            return C.alert_findings("Avocado", today)

    def test_over_the_line_is_a_spray_advised_per_ha_finding(self):
        f = self._run()
        hit = next(x for x in f if x["observation"] == "Fruit fly" and x["warehouse"] == "B1")
        self.assertEqual((hit["measure"], hit["unit"], hit["value"], hit["action"], hit["band"]),
                         (B.PER_HA, "/ ha this week", 12.0, B.SPRAY_ADVISED, "high"))
        self.assertEqual(hit["iso_week"], "2026-W42")

    def test_under_the_line_resolves_instead_of_raising(self):
        f = self._run()
        under = next(x for x in f if x["observation"] == "Thrips")
        self.assertIsNone(under["action"])

    def test_no_line_and_no_area_yield_no_finding(self):
        f = self._run()
        self.assertFalse([x for x in f if x["observation"] == "NoLine"])          # no threshold
        self.assertFalse([x for x in f if x["warehouse"] == "B2"])                # no area -> per_ha None

    def test_never_a_hot_spot(self):
        self.assertTrue(all(x["alert_type"] == B.HOUSE for x in self._run()))


class TestDashboardPayloads(unittest.TestCase):
    def setUp(self):
        figs = {"B1": [fig("B1", "Fruit fly", 12.0, 10.0, cumulative=24.0), fig("B1", "Thrips", 3.0, 0, cumulative=6.0)],
                "B2": [fig("B2", "Fruit fly", 4.0, 10.0, cumulative=8.0)],
                "B3": []}
        patches = [
            mock.patch.object(_per_ha, "_blocks", return_value=["B1", "B2", "B3"]),
            mock.patch.object(C, "round_figures", return_value=figs),
            mock.patch.object(C, "_scouted_blocks", return_value={"B1", "B2", "B3"}),
            mock.patch.object(C, "block_info", return_value={"B1": {"area_ha": 2.0, "farm": "F"}, "B2": {"area_ha": 2.0, "farm": "F"},
                                                              "B3": {"area_ha": None, "farm": "F"}}),
            mock.patch.object(C, "weekly_per_ha", return_value=[{"week": "2026-W42", "date": "2026-10-12", "per_ha": 8.0, "cumulative": 32.0, "area_ha": 4.0, "blocks": 2}]),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_overview_counts_block_by_pest_crossings(self):
        o = _per_ha.overview("Avocado", None)
        self.assertEqual((o["overTotal"], o["overByBlock"]["B1"], o["overByBlock"]["B2"]), (1, 1, 0))

    def test_kind_payload_ranking_is_farm_wide_per_ha_over_scouted_area(self):
        k = _per_ha.kind_payload("pest", "Avocado", None, {"observation": ""}, "2026-08-01", "2026-10-31")
        top = k["ranking"][0]
        # 32 cumulative over the 4 ha of blocks with an area (B3 adds nothing).
        self.assertEqual((top["name"], top["perHa"], top["blocksOver"], top["over"]), ("Fruit fly", 8.0, 1, False))
        self.assertEqual(k["overCount"], 1)
        self.assertEqual(k["trend"][0]["value"], 8.0)

    def test_by_block_marks_no_area_instead_of_inventing_a_figure(self):
        k = _per_ha.kind_payload("pest", "Avocado", None, {"observation": "Fruit fly"}, "2026-08-01", "2026-10-31")
        b = {r["name"]: r for r in k["byBlock"]}
        self.assertEqual((b["B1"]["perHa"], b["B1"]["over"], b["B2"]["over"]), (12.0, True, False))
        self.assertTrue(b["B3"]["noArea"] and b["B3"]["perHa"] is None)
        self.assertEqual(k["noArea"], ["B3"])


class TestGreenhouseCropUntouched(unittest.TestCase):
    def test_roses_never_take_the_per_ha_path(self):
        with mock.patch.object(C, "is_block_crop", return_value=False):
            self.assertFalse(_per_ha.active("Rose"))
            self.assertFalse(T.per_ha_crop("Rose"))


class TestDigest(unittest.TestCase):
    def test_per_ha_alert_reads_as_cumulative_not_a_margin(self):
        import frappe
        a = frappe._dict(value=12.0, unit="/ ha this week", measure="Per ha", alert_type="House")
        out = alert_digest._figure(a)
        self.assertIn("12.0 / ha this week", out)
        self.assertNotIn("too clustered", out)
