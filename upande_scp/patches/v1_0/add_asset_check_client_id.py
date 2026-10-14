"""Add the Asset Check Sheet client-id Custom Field (owned by upande_asset).

Skipped when upande_asset is not installed; the Scout app's offline retries use
this field to find the sheet they already made. Safe to re-run.
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute() -> None:
    if not frappe.db.table_exists("Asset Check Sheet"):
        return
    if frappe.db.exists("Custom Field", "Asset Check Sheet-custom_scp_client_id"):
        return
    create_custom_fields(
        {
            "Asset Check Sheet": [
                {
                    "fieldname": "custom_scp_client_id",
                    "label": "SCP Client ID",
                    "fieldtype": "Data",
                    "insert_after": "amended_from",
                    "read_only": 1,
                    "hidden": 1,
                    "no_copy": 1,
                    "search_index": 1,
                }
            ]
        },
        ignore_validate=True,
    )
