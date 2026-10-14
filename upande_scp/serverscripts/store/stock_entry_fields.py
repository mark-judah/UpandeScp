"""Stock Entry custom fields owned by upande_scp, in a 'Scouting and Crop
Protection' tab.

Stock Entry is shared with harvest, grading and biometric flows, and carries
dozens of custom fields from them, so the tab is placed deterministically:
immediately BEFORE the standard ``tab_connections`` Tab Break. The anchor is the
nearest field ahead of it that no other custom field already hangs off, so
Frappe's single-pass insert_after resolution cannot interleave a foreign branch
into the tab (which once swallowed the Items table on kaitet).

Fields:
  custom_spray_plan        the spray plan (Work Order) a tank-mix Material Issue
                           belongs to. ``Stock Entry.work_order`` is NOT used:
                           ERPNext treats it as production consumption.
  custom_spray_link_basis  how the link was established (Direct / Batch /
                           Greenhouse + date).
"""
import json

import frappe

MODULE = "Upande Scp"
TAB = "custom_scouting_and_crop_protection_tab"
TAB_LABEL = "Scouting and Crop Protection"
BEFORE_TAB = "tab_connections"
DEPENDS_ON = "eval:doc.custom_spray_plan"

FIELDS = [
	{
		"fieldname": "custom_spray_plan",
		"label": "Spray Plan",
		"fieldtype": "Link",
		"options": "Work Order",
		"read_only": 1,
		"no_copy": 1,
		"search_index": 1,
		"in_standard_filter": 1,
		# the backfill sets it on already-submitted issues
		"allow_on_submit": 1,
	},
	{
		"fieldname": "custom_spray_link_basis",
		"label": "Spray Link Basis",
		"fieldtype": "Select",
		"options": "\nDirect\nBatch\nGreenhouse + date",
		"read_only": 1,
		"no_copy": 1,
		"allow_on_submit": 1,
	},
]


def _own():
	return {TAB} | {f["fieldname"] for f in FIELDS}


def _anchor():
	order = [df.fieldname for df in frappe.get_meta("Stock Entry", cached=False).fields]
	order = [fn for fn in order if fn not in _own()]
	if BEFORE_TAB not in order:
		raise ValueError(f"Stock Entry has no {BEFORE_TAB}")
	taken = {
		c.insert_after for c in frappe.get_all(
			"Custom Field", filters={"dt": "Stock Entry"}, fields=["fieldname", "insert_after"])
		if c.fieldname not in _own() and c.insert_after
	}
	for fn in reversed(order[:order.index(BEFORE_TAB)]):
		if fn not in taken:
			return fn
	raise ValueError(f"Stock Entry: no free anchor before {BEFORE_TAB}")


def _upsert(fieldname, values):
	"""Create or update one Custom Field; touches only what differs."""
	name = frappe.db.get_value("Custom Field", {"dt": "Stock Entry", "fieldname": fieldname})
	if not name:
		frappe.get_doc({"doctype": "Custom Field", "dt": "Stock Entry",
			"fieldname": fieldname, "module": MODULE, **values}).insert(ignore_permissions=True)
		return 1
	cf = frappe.get_doc("Custom Field", name)
	changed = False
	for k, v in values.items():
		if (cf.get(k) or "") != (v or ""):
			cf.set(k, v)
			changed = True
	if changed:
		cf.flags.ignore_validate = True
		cf.save(ignore_permissions=True)
	return int(changed)


def _pin_in_field_order():
	"""Mona's Stock Entry has a ``field_order`` Property Setter (saved from Customize
	Form), and Frappe appends any custom field it does not list AFTER every listed
	field, i.e. after Connections. Slot our fields in just before the Connections
	tab, leaving every other entry where it is."""
	name = frappe.db.get_value(
		"Property Setter", {"doc_type": "Stock Entry", "property": "field_order"})
	if not name:
		return 0
	order = json.loads(frappe.db.get_value("Property Setter", name, "value") or "[]")
	mine = [TAB] + [f["fieldname"] for f in FIELDS]
	rest = [fn for fn in order if fn not in mine]
	if BEFORE_TAB in rest:
		at = rest.index(BEFORE_TAB)
		wanted = rest[:at] + mine + rest[at:]
	else:
		# The saved order predates the Connections tab, so Frappe would otherwise
		# place it ahead of our (unlisted) tab; list both, ours first.
		wanted = rest + mine + [BEFORE_TAB]
	if wanted == order:
		return 0
	frappe.db.set_value("Property Setter", name, "value", json.dumps(wanted))
	return 1


def ensure_scp_stock_entry_fields(doc=None, method=None):
	"""Idempotent; a no-op before ERPNext's tables exist."""
	if not frappe.db.table_exists("Stock Entry"):
		return
	changed = _upsert(TAB, {"label": TAB_LABEL, "fieldtype": "Tab Break",
		"insert_after": _anchor(), "print_hide": 1, "depends_on": DEPENDS_ON})
	prev = TAB
	for f in FIELDS:
		values = {k: v for k, v in f.items() if k != "fieldname"}
		changed += _upsert(f["fieldname"], {**values, "insert_after": prev})
		prev = f["fieldname"]
	changed += _pin_in_field_order()
	if changed:
		frappe.clear_cache(doctype="Stock Entry")
