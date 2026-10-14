"""Add Spray Product.custom_cost_group and fill it from structured fields only.

Cost group says what a product's cost is for: Pest control, Foliar, Adjuvant, pH buffer,
Hygiene & sanitation or Post-harvest. This patch sets it ONLY where a structured field says
so: category Foliar or a FER* item code -> Foliar; type Adjuvant -> Adjuvant; type pH Buffer
-> pH buffer. Everything else is left EMPTY. No product is classified by name: finance decides
an empty group from evidence at report time (used on spray plans, ingredients known), and asks
a GM to set the rest. Idempotent; never overwrites a group someone already chose."""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

GROUPS = "\nPest control\nFoliar\nAdjuvant\npH buffer\nHygiene & sanitation\nPost-harvest"


def structured_group(category, type_, code) -> str | None:
    if category == "Foliar" or (code or "").upper().startswith("FER"):
        return "Foliar"
    if type_ == "Adjuvant":
        return "Adjuvant"
    if type_ == "pH Buffer":
        return "pH buffer"
    return None


def execute() -> None:
    if not frappe.db.exists("Custom Field", "Spray Product-custom_cost_group"):
        create_custom_fields({"Spray Product": [{
            "fieldname": "custom_cost_group", "fieldtype": "Select", "label": "Cost group",
            "options": GROUPS, "insert_after": "type", "in_standard_filter": 1,
            "description": "What this product's cost is for in finance. Blank = decided from evidence.",
        }]})
    frappe.clear_cache(doctype="Spray Product")
    for r in frappe.get_all("Spray Product", fields=["name", "category", "type", "custom_cost_group"]):
        group = structured_group(r.category, r.type, r.name)
        if group and not r.custom_cost_group:
            frappe.db.set_value("Spray Product", r.name, "custom_cost_group", group, update_modified=False)
