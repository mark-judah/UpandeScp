# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""Give each SCP-prefixed role the access its unprefixed twin already has.

The reverse of ``gms_can_open_spray_products``. mona carries both families
("Spray Supervisor" and "SCP Spray Supervisor"). The app's own gates compare
them with the prefix stripped (``serverscripts/roles.py``), but Frappe's
permission system matches role names EXACTLY, and nothing in this app can teach
it otherwise.

The mobile spray flow reads and writes Work Order, Stock Entry, Spray
Application Logsheet, Sprayer Movement Session, Item, BIN and so on through the
resource API. Every Custom DocPerm row for those names only "Spray Supervisor".
A user granted "SCP Spray Supervisor" and not the old name therefore has the
role -- the desk shows it on their user -- and is still refused ("not
permitted") on every one of those doctypes. Same shape for "SCP Scout".

Each new row mirrors its unprefixed counterpart, merged most-permissive-wins
across duplicates, and an existing SCP row is never touched or widened.
Idempotent.
"""

import frappe

PREFIX = "SCP "
IDENTITY = "if_owner"


def _rights() -> tuple[str, ...]:
	return tuple(
		f.fieldname
		for f in frappe.get_meta("Custom DocPerm").fields
		if f.fieldtype == "Check" and f.fieldname != IDENTITY
	)


def execute():
	if not frappe.db.table_exists("Custom DocPerm"):
		return

	rights = _rights()
	rows = frappe.get_all(
		"Custom DocPerm",
		filters={IDENTITY: 0},
		fields=["parent", "role", "permlevel", *rights],
	)

	merged: dict[tuple[str, str, int], dict] = {}
	for row in rows:
		if (row.role or "").startswith(PREFIX):
			continue
		key = (row.parent, PREFIX + row.role, int(row.permlevel or 0))
		into = merged.setdefault(key, {r: 0 for r in rights})
		for r in rights:
			into[r] = max(into[r], int(row.get(r) or 0))

	added = 0
	for (doctype, role, permlevel), grant in sorted(merged.items()):
		if not frappe.db.exists("Role", role):
			continue
		if frappe.db.exists(
			"Custom DocPerm",
			{"parent": doctype, "role": role, "permlevel": permlevel, IDENTITY: 0},
		):
			continue
		frappe.get_doc(
			{
				"doctype": "Custom DocPerm",
				"parent": doctype,
				"parenttype": "DocType",
				"parentfield": "permissions",
				"role": role,
				"permlevel": permlevel,
				IDENTITY: 0,
				**grant,
			}
		).insert(ignore_permissions=True)
		added += 1

	if added:
		frappe.db.commit()
		frappe.clear_cache()
		print(f"Custom DocPerm: mirrored {added} unprefixed rows onto SCP-prefixed roles")
