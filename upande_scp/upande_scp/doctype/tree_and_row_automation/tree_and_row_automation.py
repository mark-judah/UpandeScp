# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import json
import re

import frappe
from frappe.model.document import Document


# Trailing "_ROW<n>_T<n>" inside a feature's `properties.name`,
# e.g. "DAIRYBLK9_ROW1_T1" → row=1, tree=1.
_NAME_PATTERN = re.compile(r"_ROW(\d+)_T(\d+)$", re.IGNORECASE)


class TreeAndRowAutomation(Document):
	@frappe.whitelist()
	def run_automation(self):
		block = self.block
		trees_geojson = (self.trees_geojson or "").strip()
		sectors = self.sectors or []

		if not block:
			frappe.throw("Please select a Block.")
		if not trees_geojson:
			frappe.throw("Please paste GeoJSON in the Trees Geojson field.")

		feature_collection = _safe_parse_json(trees_geojson)
		features = (feature_collection or {}).get("features") or []
		if not features:
			frappe.throw("GeoJSON has no features.")

		rows_created = 0
		rows_skipped = 0
		trees_created = 0
		trees_skipped = 0
		features_skipped = 0

		row_cache = {}

		for feature in features:
			row_number, tree_number = _extract_row_tree(feature)
			if row_number is None or tree_number is None:
				features_skipped += 1
				continue

			if row_number in row_cache:
				row_doc = row_cache[row_number]
			else:
				row_doc = self._get_or_create_row(block, row_number, sectors)
				if row_doc is None:
					continue
				row_cache[row_number] = row_doc
				if row_doc.get("__created"):
					rows_created += 1
				else:
					rows_skipped += 1

			existing_tree = frappe.db.exists(
				{
					"doctype": "Orchard Tree",
					"row": row_doc.name,
					"tree_number": tree_number,
				}
			)

			if existing_tree:
				trees_skipped += 1
				continue

			try:
				frappe.get_doc(
					{
						"doctype": "Orchard Tree",
						"row": row_doc.name,
						"block": block,
						"tree_number": tree_number,
						"raw_geojson": json.dumps(feature),
					}
				).insert(ignore_permissions=True)
				trees_created += 1
			except Exception as e:
				frappe.log_error(
					f"Failed to create Tree row={row_number} tree={tree_number}: {e}",
					"Tree And Row Automation Error",
				)

		return (
			f"{rows_created} rows created, {rows_skipped} existed. "
			f"{trees_created} trees created, {trees_skipped} existed. "
			f"{features_skipped} features unparsable."
		)

	def _get_or_create_row(self, block, row_number, sectors):
		existing = frappe.db.exists(
			{
				"doctype": "Bed",
				"greenhouse": block,
				"unit_type": "Row",
				"bed": row_number,
			}
		)
		if existing:
			doc = frappe.get_doc("Bed", existing)
			doc.set("__created", False)
			return doc

		try:
			doc = frappe.get_doc(
				{
					"doctype": "Bed",
					"greenhouse": block,
					"unit_type": "Row",
					"bed": row_number,
					"variety": _assign_variety_from_sectors(sectors, row_number) or "",
				}
			)
			doc.insert(ignore_permissions=True)
			doc.set("__created", True)
			return doc
		except Exception as e:
			frappe.log_error(
				f"Failed to create Row {row_number}: {e}",
				"Tree And Row Automation Error",
			)
			return None


def _extract_row_tree(feature):
	"""Pull row/tree numbers from a feature's properties.

	Prefers explicit `row_id`/`tree_id` (or legacy `line_id`/`zone_id`) but
	falls back to parsing `properties.name` like `…_ROW<n>_T<n>` so callers
	can paste plain GeoJSON exports without pre-processing.
	"""
	props = (feature or {}).get("properties") or {}

	row_number = props.get("row_id") or props.get("line_id")
	tree_number = props.get("tree_id") or props.get("zone_id")

	if row_number is None or tree_number is None:
		match = _NAME_PATTERN.search(str(props.get("name") or ""))
		if match:
			row_number = row_number if row_number is not None else match.group(1)
			tree_number = tree_number if tree_number is not None else match.group(2)

	if row_number is None or tree_number is None:
		return None, None
	return str(row_number), str(tree_number)


def _assign_variety_from_sectors(sectors, row_number):
	try:
		row_int = int(row_number)
	except Exception:
		return None
	for sector in sectors:
		try:
			if int(sector.from_row) <= row_int <= int(sector.to_row):
				return sector.sector
		except Exception:
			continue
	return None


def _safe_parse_json(json_string):
	if not json_string:
		return {}
	try:
		return json.loads(json_string)
	except json.JSONDecodeError as e:
		frappe.throw(f"Invalid JSON format: {e}")
