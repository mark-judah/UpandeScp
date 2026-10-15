"""The Farm accounting dimension on spray-plan Stock Entries.

A Stock Entry made through ERPNext's own helpers (``work_order.make_stock_entry``
for the CSU transfer and the Chemical Mixing, ``frappe.new_doc`` for the rest)
starts from ``frappe.model.create_new``, which fills every Link field from the
*session user's* default User Permission. A store keeper whose default Farm
permission is Kapkolia therefore got ``farm = Kapkolia`` on the parent and on
every row of a Chepsito plan's Chemical Mixing, and ERPNext copies the row
dimension straight into the GL. Nothing in the chain ever set the plan's farm,
so the user's default survived to the ledger.

The farm of a plan's documents is the farm of its greenhouse
(``Warehouse.custom_farm``), whoever creates them. This hook stamps it on the
parent and every row of the spray-flow entries, before ERPNext validates.
Chemical Loaning is excluded: it moves stock between two farms on purpose.
"""
import frappe

from upande_scp.serverscripts.store.spray_stock_types import (
	SE_TYPE_LOAN,
	SE_TYPE_MIX,
	SE_TYPE_SPRAY,
	SE_TYPE_TRANSFER,
)

AFP_TYPE = "Application Floor Plan"
SPRAY_TYPES = {SE_TYPE_TRANSFER, SE_TYPE_MIX, SE_TYPE_SPRAY}


def _plan(doc):
	"""The spray plan's Work Order for this entry, or None."""
	wo = doc.get("custom_spray_plan") or doc.get("work_order")
	if wo and frappe.db.get_value("Work Order", wo, "custom_type") == AFP_TYPE:
		return wo
	return None


def plan_farm(doc):
	"""The farm this spray entry belongs to, or None when it is not a plan's entry
	or the greenhouse names no farm."""
	if doc.get("stock_entry_type") == SE_TYPE_LOAN:
		return None
	wo = _plan(doc)
	if not wo and doc.get("stock_entry_type") not in SPRAY_TYPES:
		return None
	greenhouse = None
	if wo:
		greenhouse, fg = frappe.db.get_value("Work Order", wo, ["custom_greenhouse", "fg_warehouse"])
		greenhouse = greenhouse or fg
	if not greenhouse and doc.get("stock_entry_type") == SE_TYPE_SPRAY:
		greenhouse = doc.get("from_warehouse") or next(
			(r.s_warehouse for r in doc.get("items") or [] if r.get("s_warehouse")), None)
	if not greenhouse:
		return None
	return frappe.db.get_value("Warehouse", greenhouse, "custom_farm") or None


def stamp(doc, method=None):
	"""before_validate: put the plan's farm on the entry and all its rows."""
	if not doc.meta.has_field("farm"):
		return
	farm = plan_farm(doc)
	if not farm:
		return
	doc.farm = farm
	for row in doc.get("items") or []:
		row.farm = farm
