"""Add Work Order Item.custom_targets: the pests / diseases each chemical row is for.

Recorded on the Application Floor Plan so finance can attribute a chemical's
cost to what it was declared for instead of guessing. Idempotent."""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute() -> None:
    if frappe.db.exists("Custom Field", "Work Order Item-custom_targets"):
        return
    create_custom_fields(
        {
            "Work Order Item": [
                {
                    "fieldname": "custom_targets",
                    "fieldtype": "Small Text",
                    "label": "Targets",
                    "insert_after": "custom_updated_required_qty",
                    "description": "Pests / diseases this chemical is for, one per line.",
                }
            ]
        }
    )
