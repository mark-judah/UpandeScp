"""Fold `Foliar` into `Spray Product`, and drop the dead doctypes.

**post_model_sync.** Its sibling `rename_chemical_to_spray_product` runs
*before* the sync and does the rename; this runs *after*, because the fields it
writes (`category`, `crop_rates`) only exist once migrate has synced the doctype
from disk.

## What it does

1. `category = "Chemical"` on every row that came from `Chemical`.
2. Copies each `Foliar` in as `category = "Foliar"`, with its child tables.
3. Drops `Foliar`, `Chemical Crop Profile` and `Foliar Crop Profile`.

## Why the profiles can just go

Both override doctypes hold **zero rows** — on kaitet and on staging. They were
built for per-crop rate overrides nobody ever entered, and `crop_rates` on the
product replaces them. Nothing is migrated because there is nothing to migrate;
the patch still refuses to drop them if that ever stops being true.

## The Foliar copy is by hand, not `rename_doc`

Two records can hold the same item code — one Chemical, one Foliar — and the
autoname is `field:item`, so renaming a Foliar into the Spray Product namespace
could collide with an existing Chemical of the same name. Copying lets the
collision be detected and reported rather than silently resolved.

## And it reads `Foliar` by SQL, not `frappe.get_doc`

By the time this runs, `upande_scp/upande_scp/doctype/foliar/` has been deleted
from disk — that deletion is what makes the patch necessary. The ORM needs a
controller module to load a document, so `frappe.get_doc("Foliar", ...)` raises
`ModuleNotFoundError` and the migration dies halfway. Reading the table directly
is the only thing that works, and it is safe: rows are copied field-for-field,
not validated.
"""

import frappe

NEW = "Spray Product"
FOLIAR = "Foliar"
DEAD_DOCTYPES = ("Chemical Crop Profile", "Foliar Crop Profile")

#: Child tables carried across from a Foliar, as `fieldname -> child doctype`.
#: Source fieldname == target fieldname; only `parenttype` changes.
CHILD_TABLES = {
	"active_ingredients": "Active Ingredient",
	"default_targets": "Chemical Targets",
	"default_requirements": "Chemical Requirements",
	"irac": "IRAC Code Filter",
	"frac": "FRAC Code Filter",
	"ghs": "GHS Code Filter",
}

#: Scalars copied verbatim. `chemical_name`/`foliar_name` are handled separately
#: because they are the field being renamed.
SCALARS = (
	"type",
	"toxicity",
	"reentry_interval_hrs",
	"phi_days",
	"formulation",
	"registration_no",
	"mrl",
	"irac_moa",
	"frac_moa",
	"ghs_description",
	"low_stock_threshold",
	"default_lower_rate_limit",
	"default_upper_rate_limit",
	"qr_item_id",
)


def execute():
	if not frappe.db.table_exists(NEW):
		return

	_backfill_category()
	moved, skipped = _absorb_foliars()
	_drop_dead_doctypes()

	frappe.db.commit()
	frappe.logger().info(
		f"consolidate_spray_products: {moved} foliars absorbed, {len(skipped)} skipped"
	)
	if skipped:
		frappe.log_error(
			title="consolidate_spray_products: foliars skipped",
			message="\n".join(skipped),
		)


def _backfill_category():
	"""Everything that was a Chemical stays one."""
	if not frappe.db.has_column(NEW, "category"):
		return
	frappe.db.sql(
		f"UPDATE `tab{NEW}` SET category = 'Chemical' WHERE category IS NULL OR category = ''"
	)


def _absorb_foliars():
	"""Copy every Foliar in as a Spray Product with category = 'Foliar'."""
	if not frappe.db.table_exists(FOLIAR):
		return 0, []

	columns = [c for c in ("name", "item", "foliar_name", *SCALARS)
	           if frappe.db.has_column(FOLIAR, c)]
	rows = frappe.db.sql(
		"SELECT {cols} FROM `tab{dt}`".format(
			cols=", ".join(f"`{c}`" for c in columns), dt=FOLIAR
		),
		as_dict=True,
	)

	moved = 0
	skipped = []
	for src in rows:
		name = src["name"]
		# A product whose Item is gone has nothing left to describe, and the
		# insert would fail link validation and abort the whole migration. Two
		# such rows exist on kaitet, both test leftovers.
		if not src.get("item") or not frappe.db.exists("Item", src["item"]):
			skipped.append(
				f"{name}: its Item ({src.get('item') or 'none'}) no longer exists, "
				"so there is nothing to describe. Not migrated."
			)
			continue
		if frappe.db.exists(NEW, name):
			existing = frappe.db.get_value(NEW, name, "category")
			skipped.append(
				f"{name}: a Spray Product of this name already exists "
				f"(category={existing}). The Item is in both a chemical and a "
				"foliar Item Group — fix the Item Group, then re-run."
			)
			continue

		doc = frappe.new_doc(NEW)
		doc.item = src.get("item")
		doc.product_name = src.get("foliar_name")
		doc.category = "Foliar"
		for field in SCALARS:
			value = src.get(field)
			if value not in (None, ""):
				doc.set(field, value)
		for fieldname, child_dt in CHILD_TABLES.items():
			for row in _child_rows(child_dt, name, fieldname):
				doc.append(fieldname, row)
		# Copy faithfully. A child row pointing at a pest or code record that has
		# since been renamed is pre-existing data, and re-validating it here would
		# abort a 233-row migration over a row the operator can fix afterwards.
		doc.flags.ignore_links = True
		doc.insert(ignore_permissions=True)
		moved += 1

	return moved, skipped


def _child_rows(child_doctype, parent, parentfield):
	"""Child rows of a Foliar, read straight from the table.

	Filtered by `parenttype` as well as `parent`: the parent's name is the item
	code, so `parent` alone also matches the Item's own child rows of the same
	doctype (Item carries `custom_chemical_intervention_threshhold`, which is a
	`Chemical Requirements` table).
	"""
	if not frappe.db.table_exists(child_doctype):
		return []
	rows = frappe.db.sql(
		f"SELECT * FROM `tab{child_doctype}` "
		"WHERE parent = %s AND parenttype = %s AND parentfield = %s ORDER BY idx",
		(parent, FOLIAR, parentfield),
		as_dict=True,
	)
	return [
		{k: v for k, v in r.items() if k not in _CHILD_STD and not str(k).startswith("_")}
		for r in rows
	]


_CHILD_STD = {
	"name", "parent", "parenttype", "parentfield", "idx", "doctype",
	"owner", "creation", "modified", "modified_by", "docstatus",
}


def _drop_dead_doctypes():
	"""Remove Foliar and the two per-crop override doctypes.

	The overrides are refused if they somehow hold rows — this patch's whole
	premise is that they are empty, and silently discarding rate overrides would
	change what gets sprayed.
	"""
	for doctype in DEAD_DOCTYPES:
		if not frappe.db.exists("DocType", doctype):
			continue
		if frappe.db.table_exists(doctype) and frappe.db.count(doctype):
			frappe.log_error(
				title="consolidate_spray_products: override doctype not empty",
				message=(
					f"{doctype} holds {frappe.db.count(doctype)} rows and was NOT "
					"deleted. Move them onto Spray Product.crop_rates first."
				),
			)
			continue
		frappe.delete_doc("DocType", doctype, force=True, ignore_permissions=True)

	if frappe.db.exists("DocType", FOLIAR):
		frappe.delete_doc("DocType", FOLIAR, force=True, ignore_permissions=True)
