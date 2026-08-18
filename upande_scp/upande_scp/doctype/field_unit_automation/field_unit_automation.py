# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""One tool for laying out field units, whatever the crop calls them.

## What this replaces

There were two automations doing the same job with different vocabulary:

* **Bed And Zone Automation** — roses. GeoJSON of zones → `Bed` rows plus a
  `Zone` per zone.
* **Tree And Row Automation** — avocado. GeoJSON of trees → `Bed` rows with
  `unit_type = "Row"` plus an `Orchard Tree` per tree.

They already wrote into the *same* table: both create `Bed` records,
discriminated by `Bed.unit_type`. Only the field names, the GeoJSON property
conventions and the child doctype differed. Coffee then needed a third —
**bands** — and a band is simply what coffee calls a row, so a third tool would
have been a third copy of the same code.

So there is one tool, and `unit_type` says which crop's vocabulary is in play. Each
unit kind holds exactly one kind of child:

| `unit_type` | Crop | Warehouse | Holds |
|-------------|---------|------------|----------------|
| `Bed`  | roses   | Greenhouse | `Zone`         |
| `Row`  | avocado | Block      | `Orchard Tree` |
| `Band` | coffee  | Block      | `Triad`        |

Two levels, three pairs. `Band` is a `Row` under coffee's name as far as core is
concerned — it sits on a Block and is validated as a row — so nothing downstream
learns a new structure: a coffee band is a `Bed` with `unit_type = "Band"`, and the
scouting screens, maps and mobile bundle read it the way they already read the
other two. What differs is only what hangs off it.

## What the merge fixed on the way through

Each tool understood only its own GeoJSON property names, and the rose tool only
accepted newline-delimited FeatureCollections while the avocado one only accepted
a single collection. Both formats and all three property conventions now work
everywhere, so an operator no longer has to reshape an export to match whichever
tool their crop happens to use.

Lookups are also keyed on `unit_type`, which the rose tool omitted. That fixes no
live bug — core validates the warehouse's *role* too, so a warehouse is either a
Greenhouse holding beds or a Block holding rows and bands, never both — but it
makes the query state what the data model guarantees instead of borrowing the
guarantee from another app's validation.

## Both old tools were already broken, and this is why nobody noticed

`Bed`, `Zone` and `Orchard Tree` moved into **upande_core**, which added
validation and renamed fields the automations were never updated for:

* `Orchard Tree.tree` (Int) is now mandatory and is what the document names
  itself from. The avocado tool wrote only the legacy `tree_number` (Data), so
  every tree insert failed.
* `Zone`'s geometry field is `geojson`. The rose tool wrote `raw_geojson`, which
  no longer exists.
* Both `Bed` and its children now require the warehouse's Farm to declare a
  matching structure level — "Has Beds", "Has Rows", "Has Zones",
  "Has Orchard Trees". **No farm on kaitet declares any of them**, so every
  insert throws.

None of that surfaced because both tools logged insert failures and carried on,
reporting a cheerful "0 created, 0 existed". This one still logs rather than
raising — a bad feature in one warehouse must not abort a 700-feature import —
but it counts what it skipped, so a run that creates nothing says so.

## Idempotency

Re-running is safe and is the normal way to extend a layout: units and children
that already exist are counted as skipped, never duplicated or overwritten. That
is what lets an operator paste an updated export without first working out
what is new.
"""

import json
import re

import frappe
from frappe.model.document import Document


# Trailing "_ROW<n>_T<n>" in a feature's `properties.name`, e.g.
# "DAIRYBLK9_ROW1_T1" → unit 1, child 1. The avocado exports carry no explicit
# ids, so this is the only way to read them.
_NAME_PATTERN = re.compile(r"_ROW(\d+)_T(\d+)$", re.IGNORECASE)

# Property names each convention uses for (unit, child), most explicit first.
_ID_CONVENTIONS = (
	("unit_id", "child_id"),   # what this tool documents
	("row_id", "tree_id"),     # avocado exports
	("line_id", "zone_id"),    # rose exports
)

# unit_type → the one child it holds, and everything needed to create it.
#
#   child   — the doctype
#   parent  — the field linking the child back to its unit (a `tabBed` row)
#   number  — the child's own number; Int, mandatory, and what it names itself from
#   mirror  — a second field carrying the same number, where one exists
#   station — the field naming the warehouse
#
# Geometry is `geojson` on all three children.
_UNIT_SPEC = {
	"Bed": {
		"child": "Zone",
		"parent": "bed",
		"number": "zone",
		"mirror": None,
		"station": "greenhouse",
	},
	"Row": {
		"child": "Orchard Tree",
		"parent": "row",
		"number": "tree",
		# `tree` (Int) is mandatory and names the document, while `tree_number`
		# (Data) is what every reader in this app queries — `get_model_trees`,
		# `get_orchard_trees`, the scouting payloads — and what all 53,699
		# existing trees are populated with. The superseded automation wrote only
		# `tree_number`, leaving the mandatory field empty, which is why no tree
		# could be created once core took ownership of this doctype. Both are set.
		"mirror": "tree_number",
		"station": "block",
	},
	"Band": {
		"child": "Triad",
		"parent": "row",
		"number": "triad",
		"mirror": None,
		"station": "block",
	},
}


def child_doctype_for(unit_type):
	"""The child a unit kind holds. One each — see `_UNIT_SPEC`."""
	spec = _UNIT_SPEC.get(unit_type)
	return spec["child"] if spec else None


class FieldUnitAutomation(Document):
	@frappe.whitelist()
	def run_automation(self):
		"""Create the units and their children from `units_geojson`.

		Returns a human-readable summary; the form script shows it via
		`frappe.msgprint`.
		"""
		warehouse = self.warehouse
		unit_type = self.unit_type or "Bed"
		sectors = self.sectors or []

		if not warehouse:
			frappe.throw("Please select a Greenhouse / Block.")
		if unit_type not in _UNIT_SPEC:
			frappe.throw(f"Unknown Unit Type '{unit_type}'.")

		features = _parse_features(self.units_geojson)
		if not features:
			frappe.throw("GeoJSON has no features.")

		spec = _UNIT_SPEC[unit_type]
		child_doctype = spec["child"]

		units_created = units_skipped = 0
		children_created = children_skipped = 0
		unparsable = 0

		# One lookup per unit, not per feature: a block of 700 trees is 700
		# features across ~25 rows.
		unit_cache: dict[str, object] = {}

		for feature in features:
			unit_number, child_number = _extract_numbers(feature)
			if unit_number is None or child_number is None:
				unparsable += 1
				continue

			if unit_number in unit_cache:
				unit = unit_cache[unit_number]
			else:
				unit, created = self._get_or_create_unit(
					warehouse, unit_type, unit_number, sectors
				)
				if unit is None:
					continue
				unit_cache[unit_number] = unit
				if created:
					units_created += 1
				else:
					units_skipped += 1

			if self._get_or_create_child(
				child_doctype=child_doctype,
				spec=spec,
				warehouse=warehouse,
				unit=unit,
				child_number=child_number,
				feature=feature,
			):
				children_created += 1
			else:
				children_skipped += 1

		summary = (
			f"{units_created} {unit_type.lower()}s created, {units_skipped} existed. "
			f"{children_created} {child_doctype.lower()}s created, "
			f"{children_skipped} existed."
		)
		if unparsable:
			summary += f" {unparsable} features unparsable."
		return summary

	def _get_or_create_unit(self, warehouse, unit_type, unit_number, sectors):
		"""`(doc, created)` for one unit. `(None, False)` if it could not be made.

		The lookup includes `unit_type`, so a warehouse holding both beds and
		rows cannot have one kind shadow the other.
		"""
		existing = frappe.db.exists(
			{
				"doctype": "Bed",
				"greenhouse": warehouse,
				"unit_type": unit_type,
				"bed": unit_number,
			}
		)
		if existing:
			return frappe.get_doc("Bed", existing), False

		try:
			doc = frappe.get_doc(
				{
					"doctype": "Bed",
					"greenhouse": warehouse,
					"unit_type": unit_type,
					"bed": unit_number,
					"variety": _variety_for(sectors, unit_number) or "",
				}
			)
			doc.insert(ignore_permissions=True)
			return doc, True
		except Exception as e:
			frappe.log_error(
				f"Failed to create {unit_type} {unit_number} in {warehouse}: {e}",
				"Field Unit Automation",
			)
			return None, False

	def _get_or_create_child(
		self, child_doctype, spec, warehouse, unit, child_number, feature
	):
		"""True when a child was created, False when it already existed or failed."""
		existing = frappe.db.exists(
			{
				"doctype": child_doctype,
				spec["parent"]: unit.name,
				spec["number"]: child_number,
			}
		)
		if existing:
			return False

		payload = {
			"doctype": child_doctype,
			spec["parent"]: unit.name,
			spec["number"]: child_number,
			# Zones name their warehouse `greenhouse`, Triads and Orchard Trees
			# call it `block`. Same column in `tabBed` either way.
			spec["station"]: warehouse,
			"geojson": json.dumps(feature),
		}
		if spec["mirror"]:
			payload[spec["mirror"]] = child_number

		try:
			frappe.get_doc(payload).insert(ignore_permissions=True)
			return True
		except Exception as e:
			frappe.log_error(
				f"Failed to create {child_doctype} {child_number} "
				f"under {unit.name}: {e}",
				"Field Unit Automation",
			)
			return False


@frappe.whitelist()
def run(doc_name=None):
	"""Module-level entry point, for the desk form script and the bench shell.

	Kept alongside the controller method because the rose tool was driven this
	way (`create_beds_and_zones(doc_name)`) and console callers exist.
	"""
	if not doc_name:
		frappe.throw("Please save the document first.")
	doc = frappe.get_doc("Field Unit Automation", doc_name)
	result = doc.run_automation()
	frappe.db.commit()
	return result


def run_from_file(
	warehouse, geojson_path, unit_type="Bed", sectors=None
):
	"""Load GeoJSON from disk, attach it to the warehouse's doc, run it.

	    bench --site kaitet.local execute \\
	        upande_scp.upande_scp.doctype.field_unit_automation.field_unit_automation.run_from_file \\
	        --kwargs '{"warehouse":"DAIRY BLK 6 - KL","geojson_path":"/tmp/blk6.geojson","unit_type":"Row"}'
	"""
	with open(geojson_path) as f:
		payload = f.read()

	if frappe.db.exists("Field Unit Automation", warehouse):
		doc = frappe.get_doc("Field Unit Automation", warehouse)
		doc.units_geojson = payload
		doc.unit_type = unit_type
		if sectors is not None:
			doc.set("sectors", sectors)
		doc.save(ignore_permissions=True)
	else:
		doc = frappe.get_doc(
			{
				"doctype": "Field Unit Automation",
				"warehouse": warehouse,
				"unit_type": unit_type,
				"units_geojson": payload,
				"sectors": sectors or [],
			}
		)
		doc.insert(ignore_permissions=True)

	result = doc.run_automation()
	frappe.db.commit()
	return result


def _parse_features(raw):
	"""Every feature in `raw`, accepting either GeoJSON layout.

	The rose tool only read newline-delimited FeatureCollections; the avocado one
	only read a single collection. Both work here, so an operator never has to
	reshape an export to suit the tool.
	"""
	text = (raw or "").strip()
	if not text:
		return []

	# One collection covering the whole field is the common case.
	whole = _try_json(text)
	if isinstance(whole, dict) and whole.get("features"):
		return list(whole["features"])

	# Otherwise treat it as one collection per line.
	features = []
	for line in text.splitlines():
		line = line.strip()
		if not line:
			continue
		parsed = _try_json(line)
		if isinstance(parsed, dict):
			features.extend(parsed.get("features") or [])

	if not features and whole is None:
		# Neither shape parsed — the input is genuinely malformed, and saying so
		# is more useful than "no features".
		frappe.throw(
			"Could not read the GeoJSON. Expected a FeatureCollection, "
			"or one FeatureCollection per line."
		)
	return features


def _try_json(text):
	try:
		return json.loads(text)
	except (json.JSONDecodeError, TypeError):
		return None


def _extract_numbers(feature):
	"""`(unit_number, child_number)` as strings, or `(None, None)`.

	Tries each id convention in turn, then falls back to parsing a name like
	`…_ROW<n>_T<n>`, so exports from either crop's toolchain are readable
	without pre-processing.
	"""
	props = (feature or {}).get("properties") or {}

	for unit_key, child_key in _ID_CONVENTIONS:
		unit = props.get(unit_key)
		child = props.get(child_key)
		if unit is not None and child is not None:
			return str(unit), str(child)

	match = _NAME_PATTERN.search(str(props.get("name") or ""))
	if match:
		return match.group(1), match.group(2)

	# A partial convention — one id present, the other not — is still usable if
	# the missing half turns up in another convention.
	unit = child = None
	for unit_key, child_key in _ID_CONVENTIONS:
		if unit is None and props.get(unit_key) is not None:
			unit = str(props[unit_key])
		if child is None and props.get(child_key) is not None:
			child = str(props[child_key])
	if unit is not None and child is not None:
		return unit, child

	return None, None


def _variety_for(sectors, unit_number):
	"""The variety whose range covers `unit_number`, or None."""
	try:
		number = int(unit_number)
	except (TypeError, ValueError):
		return None
	for sector in sectors:
		try:
			if int(sector.from_unit) <= number <= int(sector.to_unit):
				return sector.sector
		except (TypeError, ValueError):
			continue
	return None
