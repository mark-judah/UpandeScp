"""The spray supervisor's online steps consume exactly the batches transferred in.

Four Application Floor Plan Work Orders share one CSU and one batch-tracked chemical
with two store batches, B1 (older) and B2 (newer):

* P1 transferred B2          (opposite to FIFO)
* P2 transferred B1          (opposite to FIFO for the reverse reason: P1 ran first)
* P3 transferred B1 + B2     (one transfer entry, one row per batch)
* P4 transferred B1 and is never manufactured: unrelated stock that must not be touched

The supervisor then runs the public endpoints as a throwaway user holding only the
``SCP Spray Supervisor`` role, rostered on the farm (not Administrator):
``manufacture_tank_mix`` -> ``start_spray_session`` -> ``end_spray_session``.

Everything posts real Stock Entries / Serial and Batch Bundles inside one transaction that
is rolled back, so nothing survives and the shared site is left as found.
"""

import unittest
from unittest import mock

import frappe
from frappe.utils import flt

from upande_scp.serverscripts.spray_plan_creator import spray_session as SS
from upande_scp.serverscripts.tests.test_tank_mix_batch_resolution import LedgerCase, MTM

MTM_ = MTM

_REAL_SAL = SS._create_sal_draft
ENDPOINT = "upande_scp.serverscripts.spray_plan_creator.spray_session."


def _plans_sharing_a_csu(n):
    rows = frappe.db.sql(
        """SELECT wo.name, wo.wip_warehouse, wo.company
           FROM `tabWork Order` wo
           WHERE wo.custom_type = %s AND wo.docstatus = 1 AND wo.status = 'Not Started'
             AND wo.produced_qty = 0 AND wo.wip_warehouse IS NOT NULL
             AND wo.bom_no IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM `tabStock Entry` se
                             WHERE se.work_order = wo.name AND se.docstatus < 2)
           ORDER BY wo.creation DESC LIMIT 400""",
        (SS.AFP_TYPE,),
        as_dict=True,
    )
    by_csu = {}
    for r in rows:
        by_csu.setdefault(r.wip_warehouse, []).append(r)
        if len(by_csu[r.wip_warehouse]) == n:
            return by_csu[r.wip_warehouse]
    return None


class TestSupervisorConsumesTransferredBatch(LedgerCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        plans = _plans_sharing_a_csu(4)
        if not plans:
            raise unittest.SkipTest("no four untouched floor plans share a CSU on this site")
        cls.p1, cls.p2, cls.p3, cls.p4 = [p.name for p in plans]
        cls.csu = plans[0].wip_warehouse
        cls.company = plans[0].company
        cls.store = frappe.db.get_value(
            "Warehouse",
            {"company": cls.company, "is_group": 0, "disabled": 0, "name": ["!=", cls.csu]},
            "name",
        )
        cls.item_group = frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name")[0]
        cls.uom = "Litre" if frappe.db.exists("UOM", "Litre") else "Nos"

    # ── fixtures ──

    def setUp(self):
        super().setUp()
        # The real SAL draft is wanted here (start/end need it); LedgerCase mocks it.
        # Its patcher restores the original on cleanup regardless.
        SS._create_sal_draft = _REAL_SAL

    def _supervisor(self, wo):
        """A user with ONLY SCP Spray Supervisor, rostered on the plan's farm, with an
        Employee record (scan/start/issue credit the Employee)."""
        email = f"tsc-{self.tag.lower()}@example.com"
        if frappe.db.exists("User", email):
            return email
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": "TSC",
            "send_welcome_email": 0, "user_type": "System User",
            "roles": [{"role": "SCP Spray Supervisor"}],
        }).insert(ignore_permissions=True)
        roles = set(frappe.get_roles(email))
        for r in ("Stock User", "Stock Manager", "System Manager", "Item Manager"):
            self.assertNotIn(r, roles)
        farm = frappe.db.get_value(
            "Warehouse",
            frappe.db.get_value("Work Order", wo, "custom_greenhouse"),
            "custom_farm",
        )
        if not farm:
            self.skipTest("the borrowed plan's greenhouse has no farm")
        frappe.get_doc({
            "doctype": "Farm Spray Supervisor", "parent": farm, "parenttype": "Farm",
            "parentfield": "spray_supervisors", "user": email, "idx": 999,
        }).db_insert()
        emp = frappe.db.get_value(
            "Employee", {"status": "Active", "company": self.company, "user_id": ["is", "not set"]}
        )
        if not emp:
            self.skipTest("no active Employee without a user to link")
        frappe.db.set_value("Employee", emp, "user_id", email)
        return email

    def _issue_state(self, wo):
        """WO as the store keeper leaves it: Chemical Issued, every chemical scanned."""
        frappe.db.set_value("Work Order", wo, {
            "workflow_state": SS.STATE_CHEMICAL_ISSUED,
            # borrowed plans are months old; the daily cutoff would refuse the start
            "custom_scheduled_application_time": frappe.utils.add_days(frappe.utils.now_datetime(), 1),
        })
        emp = frappe.db.get_value("Employee", {"user_id": f"tsc-{self.tag.lower()}@example.com"})
        for r in frappe.get_all("Work Order Item", filters={"parent": wo}, fields=["item_code"]):
            frappe.get_doc({
                "doctype": "Work Order Chemical Scan", "parent": wo,
                "parenttype": "Work Order", "parentfield": "custom_chemical_scans",
                "item_code": r.item_code, "scanned_by": emp, "csu_warehouse": self.csu,
                "scanned_at": frappe.utils.now_datetime(),
            }).insert(ignore_permissions=True)

    def balance(self, item, batch, wh):
        return flt(frappe.db.sql(
            """SELECT SUM(COALESCE(sbe.qty, sle.actual_qty))
               FROM `tabStock Ledger Entry` sle
               LEFT JOIN `tabSerial and Batch Entry` sbe ON sbe.parent = sle.serial_and_batch_bundle
               WHERE sle.is_cancelled = 0 AND sle.item_code = %s AND sle.warehouse = %s
                 AND COALESCE(sbe.batch_no, NULLIF(sle.batch_no, '')) = %s""",
            (item, wh, batch),
        )[0][0])

    # ── the scenario ──

    def test_each_plan_consumes_only_its_transferred_batches(self):
        item = self.item()
        b1, b2 = self.batch(item, "B1"), self.batch(item, "B2")
        self.receive(item, b1, 4, days_ago=9)   # older
        self.receive(item, b2, 4, days_ago=8)   # newer
        for wo, qty in ((self.p1, 1), (self.p2, 1), (self.p3, 1.2), (self.p4, 0.8)):
            self.plan(wo, {item: qty})
        self.transfer(self.p1, item, b2, 1, days_ago=7)
        self.transfer(self.p2, item, b1, 1, days_ago=6)
        self._se(MTM_, [
            {"item_code": item, "qty": 0.5, "s_warehouse": self.store,
             "t_warehouse": self.csu, "batch_no": b1},
            {"item_code": item, "qty": 0.7, "s_warehouse": self.store,
             "t_warehouse": self.csu, "batch_no": b2},
        ], 5, work_order=self.p3)
        self.transfer(self.p4, item, b1, 0.8, days_ago=4)   # unrelated, never run
        self.assertAlmostEqual(self.balance(item, b1, self.csu), 2.3)
        self.assertAlmostEqual(self.balance(item, b2, self.csu), 1.7)

        sup = self._supervisor(self.p1)
        for wo in (self.p1, self.p2, self.p3):
            self._issue_state(wo)

        expected = {self.p1: {b2: 1.0}, self.p2: {b1: 1.0}, self.p3: {b1: 0.5, b2: 0.7}}
        for wo, want in expected.items():
            frappe.set_user(sup)
            out = frappe.call(ENDPOINT + "manufacture_tank_mix", work_order=wo)
            frappe.set_user("Administrator")
            self.assertEqual(out["workflow_state"], SS.STATE_TANK_MIX_MANUFACTURED)
            se = frappe.get_doc("Stock Entry", out["manufacture_se"])
            self.assertEqual(se.docstatus, 1)
            # P3's issue is 1.2 of 1.2 transferred (0.5+0.7)
            self.assertEqual(self.consumed(se, item), want, wo)
            rec = out["reconciliation"]
            self.assertEqual(rec["batch_notes"], [], (wo, rec["batch_notes"]))
            self.assertEqual(
                frappe.db.get_value("Work Order", wo, "workflow_state"),
                SS.STATE_TANK_MIX_MANUFACTURED,
            )

        # P1 + P2 + P3 are gone from the CSU, P4's 0.8 of B1 is untouched.
        self.assertAlmostEqual(self.balance(item, b1, self.csu), 0.8)
        self.assertAlmostEqual(self.balance(item, b2, self.csu), 0.0)
        # The store kept what was never transferred.
        self.assertAlmostEqual(self.balance(item, b1, self.store), 4 - 1 - 0.5 - 0.8)
        self.assertAlmostEqual(self.balance(item, b2, self.store), 4 - 1 - 0.7)

        # start -> end, still as the supervisor, synchronously.
        for wo in (self.p1, self.p2, self.p3):
            frappe.set_user(sup)
            started = frappe.call(ENDPOINT + "start_spray_session", work_order=wo)
            self.assertEqual(started["workflow_state"], SS.STATE_SPRAYING_IN_PROGRESS)
            ended = frappe.call(ENDPOINT + "end_spray_session", work_order=wo)
            frappe.set_user("Administrator")
            self.assertEqual(ended["workflow_state"], SS.STATE_COMPLETED)
            self.assertEqual(frappe.db.get_value("Stock Entry", ended["material_issue"], "docstatus"), 1)

        # Ending the sprays posts only the tank-mix FG issue: no chemical batch moved.
        self.assertAlmostEqual(self.balance(item, b1, self.csu), 0.8)
        self.assertAlmostEqual(self.balance(item, b2, self.csu), 0.0)

    def test_a_plain_user_gets_a_meaningful_error_not_a_stock_error(self):
        item = self.item()
        b1 = self.batch(item, "B1")
        self.receive(item, b1, 1, days_ago=5)
        self.plan(self.p1, {item: 1})
        self.transfer(self.p1, item, b1, 1, days_ago=4)
        self._supervisor(self.p1)
        self._issue_state(self.p1)
        plain = f"tsc-plain-{self.tag.lower()}@example.com"
        frappe.get_doc({
            "doctype": "User", "email": plain, "first_name": "Plain",
            "send_welcome_email": 0, "user_type": "System User",
            "roles": [{"role": "Employee"}],
        }).insert(ignore_permissions=True)
        frappe.set_user(plain)
        with self.assertRaises(frappe.PermissionError) as cm:
            frappe.call(ENDPOINT + "manufacture_tank_mix", work_order=self.p1)
        frappe.set_user("Administrator")
        self.assertIn("cannot confirm the tank mix", str(cm.exception))
        self.assertEqual(
            frappe.db.get_value("Work Order", self.p1, "workflow_state"),
            SS.STATE_CHEMICAL_ISSUED,
        )

