"""Manufacture / start / end are idempotent and serialised per Work Order.

A slow first tap followed by a second tap must not be refused ("already manufactured")
and must never make a second Stock Entry. Builds its OWN plan (afp_fixture.ThrowawayPlan).

Run: bench --site kaitet.local run-tests \
        --module upande_scp.serverscripts.tests.test_spray_idempotency
"""

import threading
import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import offline_session as OS
from upande_scp.serverscripts.spray_plan_creator import spray_session as SS
from upande_scp.serverscripts.tests import afp_fixture as AF


def _manufactures(wo):
    return frappe.db.count(
        "Stock Entry", {"work_order": wo, "purpose": "Manufacture", "docstatus": 1}
    )


class TestSprayIdempotency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.fx = AF.ThrowawayPlan("IDEM")
        try:
            cls.fx.build()
        except Exception:
            frappe.db.rollback()
            AF.wipe(cls.fx.prefix)
            raise
        cls.wo = cls.fx.wo.name
        cls.emp = frappe.db.get_value("Employee", {"status": "Active"})

    @classmethod
    def tearDownClass(cls):
        frappe.db.rollback()
        AF.wipe(cls.fx.prefix)

    def setUp(self):
        self.fx.assert_owns(self.wo)

    def _scan_all(self):
        frappe.flags.scp_replay_work_order = self.wo
        try:
            OS._replay_scans(
                {"scans": [{"item_code": r.item_code} for r in self.fx.wo.required_items]},
                self.wo,
            )
        finally:
            frappe.flags.scp_replay_work_order = None
        frappe.db.commit()

    def test_1_state_before_anything(self):
        st = SS.get_spray_state(self.wo)
        self.assertEqual(st["workflow_state"], SS.STATE_CHEMICAL_ISSUED)
        self.assertFalse(st["manufactured"])
        self.assertEqual(st["scanned"], [])
        self.assertEqual(st["required"], [self.fx.chem])

    def test_2_concurrent_manufacture_makes_exactly_one_entry(self):
        self._scan_all()
        self.assertEqual(_manufactures(self.wo), 0)
        site, sites_path = frappe.local.site, frappe.local.sites_path
        out, errors = [], []

        def worker():
            try:
                frappe.init(site, sites_path=sites_path)
                frappe.connect()
                frappe.set_user("Administrator")
                out.append(SS.manufacture_tank_mix(self.wo))
            except Exception as e:  # noqa: BLE001
                errors.append(repr(e))
            finally:
                frappe.destroy()

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        frappe.db.rollback()  # drop our snapshot
        self.assertEqual(errors, [], f"a concurrent request was refused: {errors}")
        self.assertEqual(len(out), 2)
        self.assertEqual(_manufactures(self.wo), 1, "two Manufacture entries were created")
        self.assertEqual(out[0]["manufacture_se"], out[1]["manufacture_se"])
        self.assertEqual(sum(1 for o in out if o.get("already")), 1)
        for o in out:
            self.assertEqual(o["workflow_state"], SS.STATE_TANK_MIX_MANUFACTURED)

    def test_3_manufacture_again_is_success_with_the_existing_entry(self):
        before = _manufactures(self.wo)
        again = SS.manufacture_tank_mix(self.wo)
        self.assertTrue(again["already"])
        self.assertEqual(again["workflow_state"], SS.STATE_TANK_MIX_MANUFACTURED)
        self.assertEqual(again["manufacture_se"], SS._find_submitted_manufacture_se(self.wo))
        self.assertEqual(_manufactures(self.wo), before)
        st = SS.get_spray_state(self.wo)
        self.assertTrue(st["manufactured"])
        self.assertFalse(st["started"])

    def test_4_start_then_start_again(self):
        first = SS.start_spray_session(self.wo, employee=self.emp)
        self.assertEqual(first["workflow_state"], SS.STATE_SPRAYING_IN_PROGRESS)
        self.assertFalse(first.get("already"))
        again = SS.start_spray_session(self.wo, employee=self.emp)
        self.assertTrue(again["already"])
        self.assertEqual(again["workflow_state"], SS.STATE_SPRAYING_IN_PROGRESS)
        self.assertEqual(again["sprayer_movement_session"], first["sprayer_movement_session"])
        self.assertEqual(
            frappe.db.count("Sprayer Movement Session", {"work_order": self.wo}), 1
        )
        # manufacture after start is still success, not an error
        late = SS.manufacture_tank_mix(self.wo)
        self.assertTrue(late["already"])
        self.assertEqual(late["workflow_state"], SS.STATE_SPRAYING_IN_PROGRESS)

    def test_5_end_then_end_again(self):
        first = SS.end_spray_session(self.wo)
        self.assertEqual(first["workflow_state"], SS.STATE_COMPLETED)
        issues = frappe.db.count("Stock Entry", {"docstatus": 1, "remarks": ["like", f"%{self.wo}%"]})
        again = SS.end_spray_session(self.wo)
        self.assertTrue(again["already"])
        self.assertEqual(again["workflow_state"], SS.STATE_COMPLETED)
        self.assertEqual(
            frappe.db.count("Stock Entry", {"docstatus": 1, "remarks": ["like", f"%{self.wo}%"]}),
            issues,
        )
        # start after completion is success too
        s = SS.start_spray_session(self.wo, employee=self.emp)
        self.assertTrue(s["already"])
        self.assertTrue(SS.get_spray_state(self.wo)["ended"])
