"""Set `scouts_pick_unit` to 1 where it was never stored.

Frappe reads a never-saved Check as 0, which would silently switch off row/bed
picking on sites that never opened the Settings form after this field shipped.
"""
import frappe

SETTINGS = "Scouting and Crop Protection Settings"


def execute():
	exists = frappe.db.sql(
		"SELECT 1 FROM `tabSingles` WHERE doctype=%s AND field='scouts_pick_unit'",
		(SETTINGS,),
	)
	if not exists:
		frappe.db.set_single_value(SETTINGS, "scouts_pick_unit", 1)
