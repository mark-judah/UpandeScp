"""Creator badges and Create-curative-plan conversion (thresholds spec D7).
DB test — direct runner; rolled back in tearDown."""

import inspect
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.spray_plan_creator import bootstrap as BOOT
from upande_scp.serverscripts.spray_plan_creator import drafts as D
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests.test_scouting_alerts import SUN_20, AlertCase, live_plan


class TestCreatorAlerts(AlertCase):
    def test_creator_alerts_carry_the_spray_actions_per_greenhouse(self):
        name = self.raise_spray_advised()
        out = TC.creator_alerts([self.gh, self.gh2])
        self.assertEqual([(a.name, a.action, a.unit) for a in out[self.gh]], [(name, "Spray advised", "%")])
        self.assertNotIn(self.gh2, out)

    def test_alarming_is_not_a_creator_badge(self):
        from upande_scp.serverscripts.tests import thresholds_fixture as TF

        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(TC.creator_alerts([self.gh]), {})

    def test_the_bootstrap_carries_them(self):
        name = self.raise_spray_advised()
        F.add_creator_roster(self.farm)
        boot = BOOT.fetch_creator_bootstrap("Rose")
        self.assertEqual(boot["alerts"][self.gh][0]["name"], name)
        self.assertEqual(BOOT._empty_bootstrap()["alerts"], {})

    def test_convert_to_plan_links_the_work_order_and_marks_the_alert(self):
        name = self.raise_spray_advised()
        wo = live_plan()
        self.assertEqual(TC.convert_to_plan(name, wo, self.gh), wo)
        status, linked = frappe.db.get_value("Scouting Alert", name, ["status", "work_order"])
        self.assertEqual((status, linked), ("Converted to plan", wo))
        self.assertNotIn(name, [r.name for r in TC.open_alerts("Rose")])
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(frappe.db.get_value("Scouting Alert", name, "status"), "Converted to plan")
        self.assertEqual(TC.convert_to_plan(name, "WO-LATER", self.gh), wo)

    def test_deleting_the_draft_plan_reopens_its_alert(self):
        name = self.raise_spray_advised()
        wo = live_plan()
        TC.convert_to_plan(name, wo, self.gh)
        with patch.object(D, "_require_creator", return_value="Administrator"), \
             patch.object(D, "_own_draft", return_value=frappe._dict(name=wo)), \
             patch.object(frappe, "delete_doc") as delete_doc:
            self.assertEqual(D.delete_draft_plan(wo), {"deleted": wo})
        delete_doc.assert_called_once()
        self.assertEqual(_real_get(name), ("Open", None))
        self.assertIn(name, [r.name for r in TC.open_alerts("Rose")])

    def test_convert_refuses_a_bad_alert(self):
        name = self.raise_spray_advised()
        with self.assertRaises(frappe.ValidationError):
            TC.convert_to_plan(name, "WO-NOPE", self.gh2)
        with self.assertRaises(frappe.ValidationError):
            TC.convert_to_plan("SA-NOPE", "WO-NOPE", self.gh)
        frappe.db.set_value("Scouting Alert", name, "status", "Resolved")
        with self.assertRaises(frappe.ValidationError):
            TC.convert_to_plan(name, "WO-NOPE", self.gh)
        self.assertEqual(frappe.db.get_value("Scouting Alert", name, "status"), "Resolved")

    def test_assert_alert_refuses_a_caller_who_cannot_see_the_farm(self):
        name = self.raise_spray_advised()
        with patch.object(TC, "_assert_can_see", side_effect=frappe.PermissionError("no")):
            with self.assertRaises(frappe.PermissionError):
                TC.assert_alert_for_plan(name, self.gh)

    def test_a_bad_alert_is_refused_before_the_plan_is_inserted(self):
        src = inspect.getsource(D.create_draft_spray_plan)
        self.assertLess(src.index("assert_alert_for_plan("), src.index("wo.insert("))
        self.assertLess(src.index("wo.insert("), src.index("convert_to_plan("))
        self.assertIn('thresholds_check.convert_to_plan(alert, wo.name, payload["custom_greenhouse"])', src)

    def _create(self, name, gh=None, targets=("Thrips",)):
        """Run the real create_draft_spray_plan with the heavy collaborators
        stubbed; returns (result_or_None, inserted, exception_or_None)."""
        inserted = []

        class FakeWO:
            name = "WO-ALERT-TEST"
            flags = frappe._dict()
            required_items = []

            def insert(self, **kw):
                inserted.append(1)

        payload = {"custom_greenhouse": gh or self.gh, "alert": name, "custom_classification": "Curative",
                   "custom_targets": list(targets), "custom_water_volume": 1, "production_item": "BOM-X"}
        with patch.object(D, "_require_creator", return_value="Administrator"), \
             patch.object(D, "_resolve_user_scope", return_value={"farms": [self.farm], "warehouses": []}), \
             patch.object(D, "_assert_in_scope"), \
             patch.object(D, "_validate_payload"), \
             patch.object(D, "_derive_plan_company", return_value="C"), \
             patch.object(D, "_resolve_cost_center_with_override", return_value=None), \
             patch.object(D, "_assert_same_company"), \
             patch.object(D, "_resolve_kit_warehouse", return_value=None), \
             patch.object(D, "_apply_payload"), \
             patch.object(D.compliance, "enforce_on_save", return_value={}), \
             patch.object(D, "_compliance_payload", return_value={}), \
             patch.object(D, "_find_same_day_duplicates", return_value=[]), \
             patch.object(D, "_build_duplicate_warning", return_value=None), \
             patch.object(D, "_summarize", return_value={}), \
             patch("frappe.new_doc", return_value=FakeWO()), \
             patch("frappe.db.get_value", side_effect=_gv):
            try:
                return D.create_draft_spray_plan(payload), inserted, None
            except frappe.ValidationError as e:
                return None, inserted, e

    def test_create_draft_spray_plan_converts_the_alert_it_was_given(self):
        name = self.raise_spray_advised()
        out, inserted, err = self._create(name)
        self.assertIsNone(err)
        self.assertEqual(inserted, [1])
        self.assertEqual(out["work_order"], "WO-ALERT-TEST")
        self.assertEqual(_real_get(name), ("Converted to plan", "WO-ALERT-TEST"))

    def test_an_alert_whose_pest_is_not_a_target_is_refused_and_nothing_inserted(self):
        name = self.raise_spray_advised()
        out, inserted, err = self._create(name, targets=("Mites",))
        self.assertIsNotNone(err)
        self.assertIn("does not target", str(err))
        self.assertEqual(inserted, [])
        self.assertEqual(_real_get(name), ("Open", None))

    def test_an_alert_for_another_greenhouse_is_refused_and_nothing_inserted(self):
        name = self.raise_spray_advised()
        out, inserted, err = self._create(name, gh=self.gh2)
        self.assertIsNotNone(err)
        self.assertEqual(inserted, [])
        self.assertEqual(_real_get(name), ("Open", None))


_orig_gv = frappe.db.get_value


def _gv(doctype, *a, **kw):
    if doctype == "BOM":
        return frappe._dict(item="ITEM", name="BOM-X", company=None)
    return _orig_gv(doctype, *a, **kw)


def _real_get(name):
    return tuple(_orig_gv("Scouting Alert", name, ["status", "work_order"]))
