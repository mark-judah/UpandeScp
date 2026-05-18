import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.bulk import (
    approve_drafts_bulk, submit_drafts_for_approval,
)
from upande_scp.serverscripts.spray_plan_creator.drafts import create_draft_spray_plan
from upande_scp.upande_scp.tests._helpers import (
    assign_creator, cleanup_user, ensure_farm, ensure_role, ensure_user,
)


def _ensure_wh(name, farm):
    if not frappe.db.exists("Warehouse", {"warehouse_name": name}):
        frappe.get_doc({
            "doctype": "Warehouse", "warehouse_name": name,
            "warehouse_type": "Greenhouse", "custom_farm": farm,
            "company": frappe.defaults.get_global_default("company"),
        }).insert(ignore_permissions=True)
    return frappe.db.get_value("Warehouse", {"warehouse_name": name}, "name")


def _ensure_cc(wh_name):
    """Create a Cost Center whose stored name matches wh_name.

    Frappe appends ' - <abbr>' to cost_center_name on save, so we strip the
    suffix before inserting (same pattern as _make_cost_center in
    test_bulk_submit_race.py).
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


class TestApproveBulk(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        ensure_role("Spray Plan Creator"); ensure_role("General Manager")
        cls.farm = ensure_farm("AppFarm")
        cls.creator = ensure_user("appbulk.creator@example.com",
                                  roles=["Spray Plan Creator"])
        cls.gm = ensure_user("appbulk.gm@example.com", roles=["General Manager"])
        assign_creator(cls.creator, [cls.farm])
        cls.gh = _ensure_wh("AppBulkGH-1", cls.farm)
        _ensure_cc(cls.gh)
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        for w in frappe.get_all("Work Order",
                                filters={"custom_greenhouse": cls.gh},
                                fields=["name", "docstatus"]):
            frappe.db.sql("UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (w["name"],))
            frappe.delete_doc("Work Order", w["name"], force=1, ignore_permissions=True)
        if cls.gh and frappe.db.exists("Warehouse", cls.gh):
            frappe.delete_doc("Warehouse", cls.gh, force=1, ignore_permissions=True)
        for cc in (cls.gh, cls.gh.split(" - ")[0] if " - " in cls.gh else cls.gh):
            if frappe.db.exists("Cost Center", cc):
                frappe.delete_doc("Cost Center", cc, force=1, ignore_permissions=True)
                break
        if frappe.db.exists("Farm", cls.farm):
            frappe.delete_doc("Farm", cls.farm, force=1, ignore_permissions=True)
        cleanup_user(cls.creator); cleanup_user(cls.gm)
        frappe.db.commit()
        super().tearDownClass()

    def _seed_awaiting(self, n):
        frappe.set_user(self.creator)
        try:
            names = []
            for _ in range(n):
                r = create_draft_spray_plan({
                    "custom_greenhouse": self.gh, "custom_classification": "Curative",
                    "custom_targets": ["Thrips"], "custom_spray_type": "Full",
                    "custom_scope": "Full Greenhouse",
                    "_skip_target_validation": True,
                    "_skip_bom_validation": True,
                    "_allow_zero_chems": True,
                    "custom_water_ph": 7, "custom_water_hardness": 100,
                    "custom_water_volume": 1000, "custom_area": 0.1,
                })
                names.append(r["work_order"])
            submit_drafts_for_approval(names)
        finally:
            frappe.set_user("Administrator")
        frappe.db.commit()
        return names

    def test_bulk_approve_happy(self):
        names = self._seed_awaiting(3)
        frappe.set_user(self.gm)
        try:
            r = approve_drafts_bulk(names)
            self.assertEqual(set(r["approved"]), set(names))
            for n in names:
                self.assertEqual(
                    frappe.db.get_value("Work Order", n, "workflow_state"),
                    "Approved",
                )
        finally:
            frappe.set_user("Administrator")

    def test_bulk_approve_rejects_non_gm(self):
        names = self._seed_awaiting(1)
        non_gm = ensure_user("appbulk.nonsense@example.com", roles=[])
        frappe.set_user(non_gm)
        try:
            with self.assertRaises(frappe.PermissionError):
                approve_drafts_bulk(names)
        finally:
            frappe.set_user("Administrator")
            cleanup_user(non_gm)
