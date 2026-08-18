"""Fold Bed And Zone Automation and Tree And Row Automation into one tool.

The two automations did the same job with different vocabulary — see
`field_unit_automation.py` for why they merge and what a Band is. This carries
their documents across and deletes them.

## What has to survive

Both were named after their warehouse (`field:greenhouse` / `field:block`), and
the merged doctype is named `field:warehouse`, so **every document keeps its
name** — as long as no warehouse had a document in both tools. Measured on kaitet
before writing this: 96 rose docs, 77 avocado docs, **zero warehouses in both**.
The patch checks that again at run time rather than trusting the measurement, and
refuses to guess if it is ever false.

Nothing references these documents by name (they are input forms, not masters),
and the units they created — `Bed`, `Zone`, `Orchard Tree` — are untouched. So
the risk here is losing an operator's pasted GeoJSON and sector ranges, which is
what the copy is for.

## Field mapping

    Bed And Zone Automation      Tree And Row Automation     Field Unit Automation
    ───────────────────────      ───────────────────────     ─────────────────────
    greenhouse                   block                       warehouse
    (implicitly beds)            (implicitly rows)           unit_type = Bed / Row
    zones_geojson                trees_geojson               units_geojson
    sectors → Greenhouse         sectors → Block Sectors     sectors → Field Unit
      Sectors (from_bed/to_bed)    (from_row/to_row)           Sector (from_/to_unit)

Idempotent: a document already carried across is skipped, so a re-run after a
partial failure finishes the job.

## What this patch deliberately does not do

`Bed`, `Zone` and `Orchard Tree` (all upande_core) require the warehouse's Farm to
declare a matching structure level, and **no farm on kaitet declares any of
them** — so the merged tool will refuse to create anything until an operator
configures that. Seeding farm types is a decision about what each farm grows, not
something a migration should guess, so it is left to the office. The tool reports
what it skipped rather than failing silently, which is how this was found.
"""

import frappe

OLD_DOCTYPES = ("Bed And Zone Automation", "Tree And Row Automation")
OLD_CHILDREN = ("Greenhouse Sectors", "Block Sectors")

# old doctype → (warehouse field, geojson field, sector from/to fields, unit_type)
_MAPPING = {
	"Bed And Zone Automation": ("greenhouse", "zones_geojson", "from_bed", "to_bed", "Bed"),
	"Tree And Row Automation": ("block", "trees_geojson", "from_row", "to_row", "Row"),
}


def execute():
	# The Band option lives on core's `Bed.unit_type`; declare it before anything
	# reads the merged doctype, so a coffee layout can be created immediately.
	from upande_scp.serverscripts.geo.field_unit_types import ensure_unit_types

	ensure_unit_types()

	present = [dt for dt in OLD_DOCTYPES if frappe.db.exists("DocType", dt)]
	if not present:
		return

	if not frappe.db.exists("DocType", "Field Unit Automation"):
		# The doctype comes from the app's own JSON, synced before patches run.
		# If it is missing something is wrong with the deploy; stop rather than
		# delete the old tools with nowhere to put their data.
		frappe.log_error(
			"Field Unit Automation is not installed — leaving the old automations in place.",
			"SCP Field Units",
		)
		return

	rows = _collect(present)
	_assert_no_warehouse_serves_two_kinds(rows)

	migrated = skipped = 0
	for row in rows:
		if frappe.db.exists("Field Unit Automation", row["warehouse"]):
			skipped += 1
			continue
		_create(row)
		migrated += 1

	frappe.db.commit()
	print(f"Field Unit Automation: {migrated} migrated, {skipped} already present")

	for dt in present:
		_delete_doctype(dt)
	for dt in OLD_CHILDREN:
		_delete_doctype(dt)
	frappe.db.commit()


def _collect(present):
	"""Every old document flattened into the merged shape."""
	out = []
	for dt in present:
		wh_field, geo_field, from_field, to_field, unit_type = _MAPPING[dt]
		for doc in frappe.get_all(dt, fields=["name", wh_field, geo_field]):
			warehouse = doc.get(wh_field)
			if not warehouse:
				# Named after the warehouse, so the name is the fallback.
				warehouse = doc["name"]
			out.append(
				{
					"source": dt,
					"warehouse": warehouse,
					"unit_type": unit_type,
					"units_geojson": doc.get(geo_field) or "",
					"sectors": _sectors(dt, doc["name"], from_field, to_field),
				}
			)
	return out


def _sectors(parent_doctype, parent, from_field, to_field):
	child = "Greenhouse Sectors" if from_field == "from_bed" else "Block Sectors"
	if not frappe.db.exists("DocType", child):
		return []
	rows = frappe.get_all(
		child,
		filters={"parent": parent, "parenttype": parent_doctype},
		fields=["sector", from_field, to_field, "idx"],
		order_by="idx",
	)
	return [
		{
			"sector": r.get("sector"),
			"from_unit": r.get(from_field),
			"to_unit": r.get(to_field),
		}
		for r in rows
	]


def _assert_no_warehouse_serves_two_kinds(rows):
	"""A warehouse in both tools would collide on the merged name.

	Zero cases on kaitet, but the patch must not pick a winner silently: which
	geometry is current is an operator's call, not this patch's.
	"""
	seen = {}
	clashes = []
	for row in rows:
		other = seen.get(row["warehouse"])
		if other and other != row["source"]:
			clashes.append(row["warehouse"])
		seen[row["warehouse"]] = row["source"]

	if clashes:
		frappe.throw(
			"These warehouses have layouts in both automations, so they cannot be "
			"merged automatically — keep the current one and delete the other, "
			f"then re-run: {', '.join(sorted(set(clashes)))}"
		)


def _create(row):
	doc = frappe.get_doc(
		{
			"doctype": "Field Unit Automation",
			"warehouse": row["warehouse"],
			"unit_type": row["unit_type"],
			"units_geojson": row["units_geojson"],
			"sectors": row["sectors"],
		}
	)
	# The old docs predate the merged doctype's `reqd` flags, and some carry no
	# GeoJSON at all (created, never pasted into). Losing an empty form is worse
	# than keeping one, so validation is skipped rather than the row dropped.
	doc.flags.ignore_mandatory = True
	doc.flags.ignore_links = True
	doc.insert(ignore_permissions=True)


def _delete_doctype(name):
	if not frappe.db.exists("DocType", name):
		return
	frappe.delete_doc("DocType", name, force=True, ignore_permissions=True)
	print(f"deleted DocType {name}")
