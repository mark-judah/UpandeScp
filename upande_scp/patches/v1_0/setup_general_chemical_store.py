"""Create a general chemical store per company, and bind keepers to a store.

Two related pieces of the store model:

1. A **general chemical store** per company that owns chemical stores. Purchase
   receipts land here and it distributes onward to the farm stores, so a shared
   pool exists that belongs to no single farm.

   Parented at the company root (``All Warehouses - <abbr>``), NOT under a farm
   group. Every existing chemical store hangs off its farm's group, which is
   right for them and wrong here: burying a shared pool under one farm makes it
   read as that farm's stock in every warehouse-tree report.

2. **Backfill ``Farm Store Keeper.warehouse``** from the parent farm's
   ``custom_chemical_store``. That is the honest default — today's keepers are
   chemical-store keepers in practice, since the dashboard they use is the
   Chemical Dashboard — but it IS a guess for anyone who really keeps the
   fertilizer store. So every row touched is printed for review rather than
   changed silently.

Idempotent: an existing warehouse is left alone, and a row that already names a
store is never overwritten.
"""

import frappe

GENERAL_STORE_PREFIX = "General Chemical Store"


def _companies_with_chemical_stores():
	rows = frappe.db.sql(
		"""
		SELECT DISTINCT company FROM `tabWarehouse`
		WHERE name LIKE 'Chemical Store%%' AND disabled = 0 AND company IS NOT NULL
		""",
		as_dict=True,
	)
	return [r["company"] for r in rows if r["company"]]


def _root_for(company):
	"""The company's top-level warehouse group, e.g. 'All Warehouses - KR'."""
	abbr = frappe.db.get_value("Company", company, "abbr")
	for candidate in (f"All Warehouses - {abbr}", f"All Warehouses - {company}"):
		if frappe.db.exists("Warehouse", candidate):
			return candidate
	# Fall back to any root group for the company rather than inventing one.
	return frappe.db.get_value(
		"Warehouse",
		{"company": company, "is_group": 1, "parent_warehouse": ["in", ("", None)]},
		"name",
	)


def create_general_stores():
	created = []
	for company in _companies_with_chemical_stores():
		abbr = frappe.db.get_value("Company", company, "abbr")
		name = f"{GENERAL_STORE_PREFIX} - {abbr}"
		if frappe.db.exists("Warehouse", name):
			continue
		parent = _root_for(company)
		if not parent:
			print(f"  ! no root warehouse group for {company}; skipped")
			continue
		doc = frappe.get_doc({
			"doctype": "Warehouse",
			"warehouse_name": GENERAL_STORE_PREFIX,
			"company": company,
			"parent_warehouse": parent,
			"is_group": 0,
		})
		# custom_farm is mandatory (a Custom Field owned by Upande Core), but a
		# general store genuinely belongs to no farm — leaving it blank is the
		# truthful value, and it is what makes the ~108 `custom_farm`-scoped
		# queries exclude this warehouse from every farm's stock automatically.
		#
		# The trade-off, accepted deliberately: editing this warehouse in Desk
		# will demand a farm before it saves. We do not relax the flag, because
		# the field belongs to another app and a migrate would revert it.
		doc.flags.ignore_mandatory = True
		doc.insert(ignore_permissions=True)
		created.append(doc.name)
	return created


def backfill_keeper_stores():
	"""Point each keeper row at the farm's chemical store. Reports what it did."""
	rows = frappe.get_all(
		"Farm Store Keeper",
		filters={"parenttype": "Farm"},
		fields=["name", "parent", "user", "warehouse"],
	)
	touched, skipped, unmapped = [], 0, []
	for r in rows:
		if r.warehouse:
			skipped += 1
			continue
		store = frappe.db.get_value("Farm", r.parent, "custom_chemical_store")
		if not store:
			unmapped.append((r.parent, r.user))
			continue
		frappe.db.set_value(
			"Farm Store Keeper", r.name, "warehouse", store, update_modified=False
		)
		touched.append((r.parent, r.user, store))
	return touched, skipped, unmapped


def execute():
	created = create_general_stores()
	for n in created:
		print(f"general store created: {n}")
	if not created:
		print("general stores: none needed")

	touched, skipped, unmapped = backfill_keeper_stores()
	print(
		f"keeper backfill: set {len(touched)}, already set {skipped}, "
		f"no mapped store {len(unmapped)}"
	)
	# Printed, not silent: assigning the CHEMICAL store is an assumption, and a
	# fertilizer-store keeper needs correcting by hand.
	for farm, user, store in touched:
		print(f"  {farm} / {user} -> {store}  (verify: fertilizer keepers need changing)")
	for farm, user in unmapped:
		print(f"  ! {farm} / {user} has no custom_chemical_store; left blank")

	frappe.db.commit()
	frappe.clear_cache()
