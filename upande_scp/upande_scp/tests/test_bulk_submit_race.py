import threading

import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.bulk import submit_drafts_for_approval
from upande_scp.serverscripts.spray_plan_creator.drafts import create_draft_spray_plan
from upande_scp.upande_scp.tests._helpers import (
    assign_creator, cleanup_user, ensure_farm, ensure_role, ensure_user,
)


def _make_warehouse(name: str, farm: str) -> str:
    if not frappe.db.exists("Warehouse", {"warehouse_name": name}):
        frappe.get_doc({
            "doctype": "Warehouse", "warehouse_name": name,
            "warehouse_type": "Greenhouse", "custom_farm": farm,
            "company": frappe.defaults.get_global_default("company"),
        }).insert(ignore_permissions=True)
    return frappe.db.get_value("Warehouse", {"warehouse_name": name}, "name")


def _make_cost_center(wh_name: str) -> str:
    """Create a Cost Center whose final name matches wh_name exactly.

    Frappe appends ' - <abbr>' to cost_center_name, so we strip the suffix
    before inserting, which yields exactly wh_name as the stored name.
    """
    if frappe.db.exists("Cost Center", wh_name):
        return wh_name
    company = frappe.defaults.get_global_default("company")
    abbr = frappe.db.get_value("Company", company, "abbr")
    suffix = f" - {abbr}"
    cc_short_name = wh_name[: -len(suffix)] if wh_name.endswith(suffix) else wh_name
    parent_cc = frappe.db.get_value(
        "Cost Center",
        {"company": company, "is_group": 1},
        "name",
    )
    frappe.get_doc({
        "doctype": "Cost Center", "cost_center_name": cc_short_name,
        "company": company,
        "is_group": 0,
        "parent_cost_center": parent_cc,
    }).insert(ignore_permissions=True)
    return wh_name


class TestBulkSubmitRace(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        ensure_role("Spray Plan Creator")
        cls.farm = ensure_farm("BulkFarm")
        cls.creator = ensure_user("bulk.creator@example.com", roles=["Spray Plan Creator"])
        assign_creator(cls.creator, [cls.farm])
        cls.gh = _make_warehouse("BulkGH-1", cls.farm)
        _make_cost_center(cls.gh)
        # Commit so that threads spawned by the concurrent test can see this data
        # via their own independent DB connections.
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        for w in frappe.get_all("Work Order",
                                filters={"custom_greenhouse": cls.gh},
                                fields=["name", "docstatus"]):
            # Force docstatus=0 before delete to avoid ERPNext on_cancel hooks
            if w["docstatus"] != 0:
                frappe.db.sql(
                    "UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (w["name"],)
                )
            frappe.delete_doc("Work Order", w["name"], force=1, ignore_permissions=True)
        if cls.gh and frappe.db.exists("Warehouse", cls.gh):
            frappe.delete_doc("Warehouse", cls.gh, force=1, ignore_permissions=True)
        # Cost Center name in DB may have the company suffix appended; try both
        for cc in (cls.gh, cls.gh.split(" - ")[0] if " - " in cls.gh else cls.gh):
            if frappe.db.exists("Cost Center", cc):
                frappe.delete_doc("Cost Center", cc, force=1, ignore_permissions=True)
                break
        if frappe.db.exists("Farm", cls.farm):
            frappe.delete_doc("Farm", cls.farm, force=1, ignore_permissions=True)
        cleanup_user(cls.creator)
        super().tearDownClass()

    def _payload(self):
        return {
            "custom_greenhouse": self.gh,
            "custom_classification": "Curative",
            "custom_targets": ["Thrips"],
            "custom_spray_type": "Full",
            "custom_scope": "Full Greenhouse",
            "production_item": None,
            "_skip_target_validation": True,
            "_skip_bom_validation": True,
            "_allow_zero_chems": True,
            "custom_water_ph": 7.0,
            "custom_water_hardness": 100.0,
            "custom_water_volume": 1000.0,
            "custom_area": 0.1,
        }

    def _create(self, n: int) -> list[str]:
        frappe.set_user(self.creator)
        try:
            names = [create_draft_spray_plan(self._payload())["work_order"] for _ in range(n)]
        finally:
            frappe.set_user("Administrator")
        return names

    def _cleanup(self, names: list[str]) -> None:
        for n in names:
            if frappe.db.exists("Work Order", n):
                # Force docstatus=0 before delete to avoid ERPNext on_cancel hooks
                frappe.db.sql("UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (n,))
                frappe.delete_doc("Work Order", n, force=1, ignore_permissions=True)

    def test_happy_path_single_batch(self):
        names = self._create(3)
        frappe.set_user(self.creator)
        try:
            r = submit_drafts_for_approval(names)
            self.assertEqual(set(r["submitted"]), set(names))
            self.assertEqual(r["skipped"], [])
            for n in names:
                self.assertEqual(
                    frappe.db.get_value("Work Order", n, "workflow_state"),
                    "Awaiting Approval",
                )
        finally:
            frappe.set_user("Administrator")
            self._cleanup(names)

    def test_second_submit_skips_already_submitted(self):
        names = self._create(2)
        frappe.set_user(self.creator)
        try:
            submit_drafts_for_approval(names)
            r = submit_drafts_for_approval(names)
            self.assertEqual(r["submitted"], [])
            self.assertEqual({s["name"] for s in r["skipped"]}, set(names))
        finally:
            frappe.set_user("Administrator")
            self._cleanup(names)

    def test_concurrent_submits_no_double(self):
        names = self._create(4)
        # Commit so threads on their own connections can see the draft WOs.
        frappe.db.commit()
        results: list[dict] = []

        def submit():
            frappe.init(site="kaitet.local")
            frappe.connect()
            frappe.set_user(self.creator)
            try:
                r = submit_drafts_for_approval(list(names))
                results.append(r)
            finally:
                frappe.set_user("Administrator")
                frappe.destroy()

        t1 = threading.Thread(target=submit)
        t2 = threading.Thread(target=submit)
        t1.start(); t2.start(); t1.join(); t2.join()

        all_submitted = [n for r in results for n in r["submitted"]]
        try:
            self.assertEqual(
                len(all_submitted), len(set(all_submitted)),
                f"Same WO submitted twice across threads: {all_submitted}",
            )
            self.assertEqual(
                set(all_submitted), set(names),
                "Every WO should be submitted exactly once across both threads",
            )
        finally:
            self._cleanup(names)
