"""Move Chemical Transfer Requests from one-item/many-lenders to many-items/one-lender.

The old shape put ``item_code``/``uom``/``requested_qty`` on the PARENT and
carried a ``sources`` child table so a requester could split one chemical across
up to five lending farms. The new shape inverts that: a request is addressed to a
SINGLE farm — which is what makes it private to them and decidable by them — and
carries an ``items`` table so several chemicals can be borrowed in one go, each
approved or rejected on its own.

For each existing request this creates one item line from the parent fields and
sets ``lender_farm`` from its first source.

Nothing is deleted. The legacy parent fields and the ``sources`` rows stay, so a
request that was split across several lenders remains fully readable even though
``lender_farm`` can only name one of them — those are reported rather than
quietly flattened.

Idempotent: a request that already has item lines is skipped.
"""

import frappe


def execute():
	names = frappe.get_all("Chemical Transfer Request", pluck="name")
	if not names:
		print("loans_to_multi_item: no requests to migrate")
		return

	migrated = skipped = 0
	multi_source = []

	for name in names:
		if frappe.db.exists(
			"Chemical Transfer Request Item",
			{"parent": name, "parenttype": "Chemical Transfer Request"},
		):
			skipped += 1
			continue

		doc = frappe.db.get_value(
			"Chemical Transfer Request",
			name,
			["item_code", "item_name", "uom", "requested_qty", "workflow_state"],
			as_dict=True,
		)
		if not doc or not doc.item_code:
			skipped += 1
			continue

		sources = frappe.get_all(
			"Chemical Transfer Request Source",
			filters={"parent": name},
			fields=["source_farm", "source_warehouse", "qty", "approved", "stock_entry"],
			order_by="idx asc",
		)
		if len(sources) > 1:
			multi_source.append((name, [s.source_farm for s in sources]))

		# Terminal states mean the outcome is already known; anything else is
		# still Pending as far as the new per-item status is concerned.
		state = (doc.workflow_state or "").strip()
		approved_any = any(s.approved for s in sources)
		if state == "Fulfilled" or approved_any:
			status, approved_qty = "Approved", doc.requested_qty
		elif state in ("Rejected", "Expired"):
			status, approved_qty = "Rejected", 0
		else:
			status, approved_qty = "Pending", 0

		row = frappe.get_doc({
			"doctype": "Chemical Transfer Request Item",
			"parent": name,
			"parenttype": "Chemical Transfer Request",
			"parentfield": "items",
			"item_code": doc.item_code,
			"item_name": doc.item_name,
			"uom": doc.uom,
			"requested_qty": doc.requested_qty,
			"status": status,
			"approved_qty": approved_qty,
			"stock_entry": next((s.stock_entry for s in sources if s.stock_entry), None),
		})
		# Direct child insert: the parent may reference items or farms that no
		# longer validate, and re-saving history to add a row is not worth
		# failing the migration over.
		row.flags.ignore_links = True
		row.insert(ignore_permissions=True)

		if sources and not frappe.db.get_value("Chemical Transfer Request", name, "lender_farm"):
			frappe.db.set_value(
				"Chemical Transfer Request",
				name,
				{
					"lender_farm": sources[0].source_farm,
					"lender_warehouse": sources[0].source_warehouse,
				},
				update_modified=False,
			)
		migrated += 1

	frappe.db.commit()
	print(f"loans_to_multi_item: migrated {migrated}, skipped {skipped}")
	for name, farms in multi_source:
		print(
			f"  ! {name} was split across {len(farms)} lenders {farms}; "
			f"lender_farm set to the first. Full split remains in the sources table."
		)
