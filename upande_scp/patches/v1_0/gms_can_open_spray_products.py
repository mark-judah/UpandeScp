# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""Give the unprefixed roles the same access to Spray Product as the SCP ones.

Five of mona's six General Managers could not open the Spray Product list at
all — `frappe.has_permission` returned False and the list threw PermissionError.
Only the one who is also a System Manager got in.

The cause is the same split that `serverscripts/roles.py` fixes for the app's
own gates: mona carries both "General Manager" and "SCP General Manager".
Spray Product's permissions name only the SCP family, and Frappe's permission
system matches role names EXACTLY — it has no idea the two are the same role,
and nothing in this app can teach it. So the fix has to be data: the unprefixed
role needs its own row.

WHY A PATCH. These are Custom DocPerm rows, which override the doctype's own
JSON entirely — editing spray_product.json changes nothing on a site that has
them, and every site restored from mona production has them. They are not in
`fixtures/custom_docperm.json` either, so nothing ships them and nothing will
overwrite what this writes.

Each new row mirrors its SCP counterpart rather than inventing a level of
access: the two names mean the same role, so they should be able to do the same
things. Where duplicate rows disagree — and some do, one saying a Spray
Supervisor may write and another saying they may not — the more permissive wins,
which is what the SCP-named holder already gets today.

Idempotent: a row that exists is left exactly as it is, so a site that has
tuned these by hand keeps its tuning.
"""

import frappe

DOCTYPE = "Spray Product"
PREFIX = "SCP "

# ``if_owner`` is part of which rule a row IS, not one of the rights it grants,
# so it is never OR-ed across rows — the mirror is built from the plain rules
# and is itself a plain rule.
IDENTITY = "if_owner"


def _rights() -> tuple[str, ...]:
	"""Every right Custom DocPerm actually carries on THIS version.

	Read off the doctype rather than listed here: the first cut of this patch
	hard-coded a column that v16 does not have and died mid-migrate.
	"""
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
		filters={
			"parent": DOCTYPE,
			"role": ["like", f"{PREFIX}%"],
			IDENTITY: 0,
		},
		fields=["role", "permlevel", *rights],
	)
	if not rows:
		return

	# Fold the duplicates together, most permissive wins.
	merged: dict[tuple[str, int], dict] = {}
	for row in rows:
		plain = row.role[len(PREFIX) :]
		key = (plain, int(row.permlevel or 0))
		into = merged.setdefault(key, {r: 0 for r in rights})
		for r in rights:
			into[r] = max(into[r], int(row.get(r) or 0))

	added = []
	for (role, permlevel), rights in sorted(merged.items()):
		if not frappe.db.exists("Role", role):
			# Nothing holds it and nothing can — skip rather than create roles
			# nobody asked for.
			continue
		if frappe.db.exists(
			"Custom DocPerm",
			{"parent": DOCTYPE, "role": role, "permlevel": permlevel, IDENTITY: 0},
		):
			continue
		doc = frappe.get_doc(
			{
				"doctype": "Custom DocPerm",
				"parent": DOCTYPE,
				"parenttype": "DocType",
				"parentfield": "permissions",
				"role": role,
				"permlevel": permlevel,
				IDENTITY: 0,
				**rights,
			}
		)
		doc.insert(ignore_permissions=True)
		added.append(f"{role} (permlevel {permlevel})")

	if added:
		frappe.db.commit()
		frappe.clear_cache()
		print(f"Spray Product: granted {', '.join(added)}")
