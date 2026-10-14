"""Work Order fields the spray compliance check writes (kaitet 1cfe48e).

``custom_compliance_status`` (the check's verdict) and ``custom_spray_rule_overrides``
(a read-only table of who overrode which rule, signed server-side) sit on the
Work Order beside the plan's targets. Create-only, like ensure_scp_custom_fields:
an existing field is never touched. post_model_sync, because the table's child
doctype (Spray Rule Override) only exists once the sync has run.
"""

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

FIELDS = [
	{
		"fieldname": "custom_compliance_status",
		"label": "Spray Check",
		"fieldtype": "Select",
		"options": "\nClean\nWarnings\nAwaiting Override\nOverridden",
		"insert_after": "custom_targets",
		"read_only": 1,
		"in_standard_filter": 1,
	},
	{
		"fieldname": "custom_spray_rule_overrides",
		"label": "Spray Rule Overrides",
		"fieldtype": "Table",
		"options": "Spray Rule Override",
		"insert_after": "custom_compliance_status",
		"read_only": 1,
	},
]


def execute():
	if not frappe.db.exists("DocType", "Spray Rule Override"):
		return
	missing = [f for f in FIELDS if not frappe.db.exists("Custom Field", f"Work Order-{f['fieldname']}")]
	if missing:
		create_custom_fields({"Work Order": missing}, ignore_validate=True)
		frappe.db.commit()
