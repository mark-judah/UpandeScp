import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, now_datetime

from upande_scp.serverscripts.spray_plan_creator.approval_review import (
    get_approval_review,
)
from upande_scp.upande_scp.tests._helpers import ensure_farm


def _ensure_irac_code(code: str) -> str:
    """Ensure an IRAC Code master record exists (name == moa_group)."""
    if not frappe.db.exists("IRAC Code", code):
        frappe.get_doc({
            "doctype": "IRAC Code",
            "moa_group": code,
        }).insert(ignore_permissions=True)
    return code


def _ensure_frac_code(code: str) -> str:
    """Ensure a FRAC Code master record exists."""
    if not frappe.db.exists("FRAC Code", code):
        doc = frappe.get_doc({"doctype": "FRAC Code", "frac_code": code})
        doc.flags.ignore_mandatory = True
        doc.insert(ignore_permissions=True)
    return code


def _seed_item(code: str, irac: str | None = None, frac: str | None = None,
               lower: float | None = None, upper: float | None = None) -> str:
    if frappe.db.exists("Item", code):
        frappe.delete_doc("Item", code, force=1, ignore_permissions=True)
    # Use "Chemical Mix" item group — the Item Approval server script skips
    # auto-disabling for this group, so the item stays enabled.
    item_group = "Chemical Mix" if frappe.db.exists("Item Group", "Chemical Mix") else (
        frappe.db.get_value("Item Group", {"is_group": 0}, "name") or "All Item Groups"
    )
    doc = frappe.get_doc({
        "doctype": "Item", "item_code": code, "item_name": code,
        "item_group": item_group, "stock_uom": "Litre",
        "custom_lower_rate_limit": lower, "custom_upper_rate_limit": upper,
    })
    doc.flags.ignore_mandatory = True
    doc.insert(ignore_permissions=True)
    # Add IRAC/FRAC codes via raw child insert (Table MultiSelect rows).
    # The live DocField for IRAC Code Filter uses "irac_code"; for FRAC Code Filter
    # the live DocField uses "frac_code".
    if irac:
        _ensure_irac_code(irac)
        child = frappe.get_doc({
            "doctype": "IRAC Code Filter",
            "parenttype": "Item",
            "parentfield": "custom_irac",
            "parent": code,
            "irac_code": irac,
        })
        child.flags.ignore_mandatory = True
        child.insert(ignore_permissions=True)
    if frac:
        _ensure_frac_code(frac)
        child = frappe.get_doc({
            "doctype": "FRAC Code Filter",
            "parenttype": "Item",
            "parentfield": "custom_frac",
            "parent": code,
            "frac_code": frac,
        })
        child.flags.ignore_mandatory = True
        child.insert(ignore_permissions=True)
    frappe.db.commit()
    return code


def _make_wo(greenhouse: str, item_codes: list[str], days_ago: int = 0,
             workflow_state: str = "Approved") -> str:
    """Create a Work Order at docstatus=0 with our custom fields, then set
    workflow_state via raw write (avoids ERPNext's on_submit pitfalls)."""
    wo = frappe.get_doc({
        "doctype": "Work Order",
        "custom_type": "Application Floor Plan",
        "custom_greenhouse": greenhouse,
        "production_item": item_codes[0],
        "qty": 1,
        "custom_scheduled_application_time": add_days(now_datetime(), -days_ago),
        "required_items": [
            {"item_code": c, "required_qty": 1, "stock_uom": "Litre"}
            for c in item_codes
        ],
    })
    wo.flags.ignore_mandatory = True
    wo.flags.ignore_workflow = True
    wo.insert(ignore_permissions=True)
    # Set state + docstatus via raw write (bypass on_submit hook)
    frappe.db.sql(
        "UPDATE `tabWork Order` SET workflow_state=%s, docstatus=1 WHERE name=%s",
        (workflow_state, wo.name),
    )
    frappe.db.commit()
    return wo.name


class TestApprovalReview(FrappeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.farm = ensure_farm("IracFarm")
        cls.gh_name = "IracGH-1"
        if not frappe.db.exists("Warehouse", {"warehouse_name": cls.gh_name}):
            frappe.get_doc({
                "doctype": "Warehouse", "warehouse_name": cls.gh_name,
                "warehouse_type": "Greenhouse", "custom_farm": cls.farm,
                "company": frappe.defaults.get_global_default("company"),
            }).insert(ignore_permissions=True)
        cls.gh = frappe.db.get_value("Warehouse", {"warehouse_name": cls.gh_name}, "name")
        cls.itemA = _seed_item("IRAC-Sivanto", irac="4A", lower=0.5, upper=2.0)
        cls.itemB = _seed_item("IRAC-Belt",    irac="28")
        cls.itemC = _seed_item("FRAC-Folicur", frac="3")

    @classmethod
    def tearDownClass(cls):
        # Wipe WOs (raw delete to bypass on_cancel)
        wo_names = [r.name for r in frappe.db.sql(
            "SELECT name FROM `tabWork Order` WHERE custom_greenhouse=%s",
            (cls.gh,), as_dict=True,
        )]
        for n in wo_names:
            frappe.db.sql("UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (n,))
            frappe.delete_doc("Work Order", n, force=1, ignore_permissions=True)
        for c in (cls.itemA, cls.itemB, cls.itemC):
            if frappe.db.exists("Item", c):
                frappe.delete_doc("Item", c, force=1, ignore_permissions=True)
        if cls.gh and frappe.db.exists("Warehouse", cls.gh):
            frappe.delete_doc("Warehouse", cls.gh, force=1, ignore_permissions=True)
        if frappe.db.exists("Farm", cls.farm):
            frappe.delete_doc("Farm", cls.farm, force=1, ignore_permissions=True)
        frappe.db.commit()
        super().tearDownClass()

    def test_no_prior_no_warnings(self):
        wo = _make_wo(self.gh, [self.itemA], days_ago=0,
                      workflow_state="Awaiting Approval")
        try:
            review = get_approval_review(wo)
            warns = [w for c in review["chemicals"] for w in c["resistance_warnings"]]
            self.assertEqual(warns, [])
        finally:
            frappe.db.sql("UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (wo,))
            frappe.delete_doc("Work Order", wo, force=1, ignore_permissions=True)

    def test_irac_repeat_within_window_warns(self):
        prior = _make_wo(self.gh, [self.itemA], days_ago=5)  # Approved
        new   = _make_wo(self.gh, [self.itemA], days_ago=0,
                         workflow_state="Awaiting Approval")
        try:
            review = get_approval_review(new)
            warns = [w for c in review["chemicals"] if c["item_code"] == self.itemA
                     for w in c["resistance_warnings"]]
            self.assertEqual(len(warns), 1)
            self.assertEqual(warns[0]["kind"], "irac")
            self.assertEqual(warns[0]["code"], "4A")
        finally:
            for n in (prior, new):
                frappe.db.sql("UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (n,))
                frappe.delete_doc("Work Order", n, force=1, ignore_permissions=True)

    def test_irac_outside_window_no_warn(self):
        prior = _make_wo(self.gh, [self.itemA], days_ago=30)
        new   = _make_wo(self.gh, [self.itemA], days_ago=0,
                         workflow_state="Awaiting Approval")
        try:
            review = get_approval_review(new)
            warns = [w for c in review["chemicals"] if c["item_code"] == self.itemA
                     for w in c["resistance_warnings"]]
            self.assertEqual(warns, [])
        finally:
            for n in (prior, new):
                frappe.db.sql("UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (n,))
                frappe.delete_doc("Work Order", n, force=1, ignore_permissions=True)

    def test_rate_out_of_range_flagged(self):
        wo = _make_wo(self.gh, [self.itemA], days_ago=0,
                      workflow_state="Awaiting Approval")
        # Force a rate above the upper limit (2.0)
        frappe.db.set_value(
            "Work Order Item",
            {"parent": wo, "item_code": self.itemA},
            "required_qty", 3.5,
        )
        try:
            review = get_approval_review(wo)
            rs = next(c for c in review["chemicals"] if c["item_code"] == self.itemA)
            self.assertEqual(rs["rate_status"], "above")
        finally:
            frappe.db.sql("UPDATE `tabWork Order` SET docstatus=0 WHERE name=%s", (wo,))
            frappe.delete_doc("Work Order", wo, force=1, ignore_permissions=True)
