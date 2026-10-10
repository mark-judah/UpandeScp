"""Pest/Disease Filter.measure from the old unit (thresholds spec §1).

A Pest Filter becomes Count when every one of its stages is recorded as a number
(`reading_type = Count`) and its old unit was Per Warehouse or Per Hectare — the
two units that compared a raw count. Everything else, and every Disease Filter,
is Percentage. Bands are not touched: a row whose bands are misordered (Rose
Thrips 1 / 0.4 / 2 on kaitet.local) keeps them, and the editor flags it.

It recomputes from `unit` on every run, so it runs once from patches.txt; the
editor owns `measure` afterwards.
"""

import frappe

COUNT_UNITS = ("Per Warehouse", "Per Hectare")
KINDS = (("Pest Filter", "Pests Stages"), ("Disease Filter", "Disease Stages"))


def wanted_measure(doctype, unit, reading_types) -> str:
	if doctype != "Pest Filter":
		return "Percentage"
	if not reading_types or any(rt != "Count" for rt in reading_types):
		return "Percentage"
	return "Count" if (unit or "") in COUNT_UNITS else "Percentage"


def execute():
	for doctype, child in KINDS:
		if not frappe.db.has_column(doctype, "measure"):
			continue
		stages: dict = {}
		for parent, reading_type in frappe.db.sql(
			f"select parent, reading_type from `tab{child}` where parenttype = %s", (doctype,)
		):
			stages.setdefault(parent, []).append(reading_type or "")
		for name, unit in frappe.db.sql(f"select name, unit from `tab{doctype}`"):
			frappe.db.set_value(
				doctype, name, "measure", wanted_measure(doctype, unit, stages.get(name)),
				update_modified=False,
			)
	# Dashboard severity cached before this ran was computed without a measure.
	cache = frappe.cache()
	for key in cache.get_keys("scp:dash_agg:*"):
		cache.delete_value(key)
