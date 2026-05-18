import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.drafts import (
    create_draft_spray_plan, delete_draft_plan, get_draft_plan,
    list_my_draft_plans, update_draft_plan,
)
from upande_scp.upande_scp.tests._helpers import (
    assign_creator, cleanup_user, ensure_farm, ensure_role, ensure_user,
)


def _make_warehouse(name: str, farm: str, wh_type: str = "Greenhouse") -> str:
    if not frappe.db.exists("Warehouse", {"warehouse_name": name}):
        frappe.get_doc({
            "doctype": "Warehouse", "warehouse_name": name,
            "warehouse_type": wh_type, "custom_farm": farm,
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


class TestDraftEndpoints(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        ensure_role("Spray Plan Creator")
        cls.farm = ensure_farm("DraftTestFarm")
        cls.creator = ensure_user("draft.creator@example.com", roles=["Spray Plan Creator"])
        cls.outsider = ensure_user("draft.outsider@example.com", roles=["Spray Plan Creator"])
        assign_creator(cls.creator, [cls.farm])
        cls.gh = _make_warehouse("DraftGH-1", cls.farm)
        cls.cc = _make_cost_center(cls.gh)

    @classmethod
    def tearDownClass(cls):
        # Wipe any draft WOs created during tests
        for wo in frappe.get_all("Work Order",
                                 filters={"custom_greenhouse": cls.gh},
                                 fields=["name", "docstatus"]):
            doc = frappe.get_doc("Work Order", wo["name"])
            if doc.docstatus == 1:
                doc.cancel()
            frappe.delete_doc("Work Order", wo["name"], force=1, ignore_permissions=True)
        if cls.gh and frappe.db.exists("Warehouse", cls.gh):
            frappe.delete_doc("Warehouse", cls.gh, force=1, ignore_permissions=True)
        if frappe.db.exists("Cost Center", cls.cc):
            frappe.delete_doc("Cost Center", cls.cc, force=1, ignore_permissions=True)
        for u in (cls.creator, cls.outsider):
            cleanup_user(u)
        if frappe.db.exists("Farm", cls.farm):
            frappe.delete_doc("Farm", cls.farm, force=1, ignore_permissions=True)
        super().tearDownClass()

    def _payload(self, *, classification="Curative", reason=None):
        return {
            "custom_greenhouse": self.gh,
            "custom_classification": classification,
            "custom_preventive_reason": reason or "",
            "custom_spray_type": "Full",
            "custom_scope": "Full Greenhouse",
            "custom_scope_details": "",
            "custom_kit": None,
            "custom_spray_team": None,
            "custom_water_ph": 7.0,
            "custom_water_hardness": 100.0,
            "custom_water_volume": 1000.0,
            "custom_area": 0.1,
            "custom_targets": ["Thrips"],
            "production_item": None,
            "chemicals": [],
            "custom_scheduled_application_time": "2026-06-01 06:00:00",
            "custom_weather_snapshot": None,
            "_skip_target_validation": True,
            "_skip_bom_validation": True,
            "_allow_zero_chems": True,
        }

    def test_create_then_list_returns_owner_draft(self):
        frappe.set_user(self.creator)
        try:
            r = create_draft_spray_plan(self._payload())
            self.assertIn("work_order", r)
            drafts = list_my_draft_plans()
            self.assertTrue(any(d["name"] == r["work_order"] for d in drafts))
        finally:
            frappe.set_user("Administrator")
            if r and frappe.db.exists("Work Order", r["work_order"]):
                frappe.delete_doc("Work Order", r["work_order"], force=1, ignore_permissions=True)

    def test_preventive_without_reason_raises(self):
        frappe.set_user(self.creator)
        try:
            with self.assertRaisesRegex(frappe.ValidationError, "Preventive"):
                create_draft_spray_plan(
                    self._payload(classification="Preventive", reason="")
                )
        finally:
            frappe.set_user("Administrator")

    def test_greenhouse_outside_scope_raises(self):
        frappe.set_user(self.outsider)  # has the role but no farm assignment
        try:
            with self.assertRaisesRegex(frappe.ValidationError, "scope|access"):
                create_draft_spray_plan(self._payload())
        finally:
            frappe.set_user("Administrator")

    def test_other_user_cannot_get_draft(self):
        frappe.set_user(self.creator)
        try:
            r = create_draft_spray_plan(self._payload())
        finally:
            frappe.set_user("Administrator")
        try:
            frappe.set_user(self.outsider)
            with self.assertRaisesRegex(frappe.ValidationError, "own"):
                get_draft_plan(r["work_order"])
        finally:
            frappe.set_user("Administrator")
            if frappe.db.exists("Work Order", r["work_order"]):
                frappe.delete_doc("Work Order", r["work_order"], force=1, ignore_permissions=True)

    def test_update_changes_classification(self):
        frappe.set_user(self.creator)
        r = None
        try:
            r = create_draft_spray_plan(self._payload())
            p = self._payload(
                classification="Preventive",
                reason="Routine prophylactic per agronomy plan, no observations yet.",
            )
            update_draft_plan(r["work_order"], p)
            doc = frappe.get_doc("Work Order", r["work_order"])
            self.assertEqual(doc.custom_classification, "Preventive")
        finally:
            frappe.set_user("Administrator")
            if r and frappe.db.exists("Work Order", r["work_order"]):
                frappe.delete_doc("Work Order", r["work_order"], force=1, ignore_permissions=True)

    def test_delete_removes(self):
        frappe.set_user(self.creator)
        try:
            r = create_draft_spray_plan(self._payload())
            delete_draft_plan(r["work_order"])
            self.assertFalse(frappe.db.exists("Work Order", r["work_order"]))
        finally:
            frappe.set_user("Administrator")
