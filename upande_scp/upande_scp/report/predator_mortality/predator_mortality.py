# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""Expected predator mortality per completed spray and predator present, per greenhouse.
An ESTIMATE (released quantity x ingredient mortality), labelled as such in the message."""

import frappe
from frappe.utils import add_days, today

from upande_scp.serverscripts.biologicals import mortality


def execute(filters=None):
	filters = frappe._dict(filters or {})
	res = mortality.mortality_report(
		from_date=filters.get("from_date") or add_days(today(), -90),
		to_date=filters.get("to_date") or today(),
		greenhouse=filters.get("greenhouse"), farm=filters.get("farm"))
	columns = [
		{"label": "Spray time", "fieldname": "when", "fieldtype": "Datetime", "width": 150},
		{"label": "Work Order", "fieldname": "wo", "fieldtype": "Link", "options": "Work Order", "width": 150},
		{"label": "Greenhouse", "fieldname": "greenhouse", "fieldtype": "Link", "options": "Warehouse", "width": 170},
		{"label": "Predator", "fieldname": "predator", "fieldtype": "Link", "options": "Predator", "width": 170},
		{"label": "Released present", "fieldname": "present", "fieldtype": "Float", "width": 110},
		{"label": "Mortality %", "fieldname": "mortality_pct", "fieldtype": "Percent", "width": 100},
		{"label": "Expected kill", "fieldname": "expected_kill", "fieldtype": "Float", "width": 110},
		{"label": "Unit", "fieldname": "uom", "fieldtype": "Data", "width": 70},
		{"label": "Mix", "fieldname": "products_text", "fieldtype": "Data", "width": 320},
	]
	rows = [{**r, "products_text": ", ".join(r["products"])} for r in res["rows"]]
	message = f"<b>Expected</b> mortality: {mortality.LABEL} Total expected kill {res['total']:g}."
	return columns, rows, message
