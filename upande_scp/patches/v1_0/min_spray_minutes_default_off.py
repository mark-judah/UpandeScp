"""Reset `min_spray_minutes` to 0 (off) where it still holds the shipped default of 5."""
import frappe

SETTINGS = "Scouting and Crop Protection Settings"


def execute():
	rows = frappe.db.sql(
		"SELECT value FROM `tabSingles` WHERE doctype=%s AND field='min_spray_minutes'",
		(SETTINGS,),
	)
	if rows and str(rows[0][0]).strip() == "5":
		frappe.db.set_single_value(SETTINGS, "min_spray_minutes", 0)
