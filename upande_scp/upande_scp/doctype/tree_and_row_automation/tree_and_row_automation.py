# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import json

import frappe
from frappe.model.document import Document


class TreeAndRowAutomation(Document):
	@frappe.whitelist()
	def run_automation(self):
		block = self.block
		trees_geojson = self.trees_geojson or ""
		sectors = self.sectors or []

		rows_created = 0
		rows_skipped = 0
		trees_created = 0
		trees_skipped = 0

		for line in trees_geojson.strip().splitlines():
			if not line.strip():
				continue

			feature_collection = _safe_parse_json(line)
			if not feature_collection:
				continue

			for feature in feature_collection.get("features", []):
				props = feature.get("properties", {}) or {}
				row_number = props.get("row_id") or props.get("line_id")
				tree_number = props.get("tree_id") or props.get("zone_id")

				if row_number is None or tree_number is None:
					continue

				row_number = str(row_number)
				tree_number = str(tree_number)

				variety = _assign_variety_from_sectors(sectors, row_number)

				# --- Row (stored as Bed with unit_type=Row) ---
				existing_row = frappe.db.exists(
					{
						"doctype": "Bed",
						"greenhouse": block,
						"unit_type": "Row",
						"bed": row_number,
					}
				)

				if existing_row:
					rows_skipped += 1
					row_doc = frappe.get_doc("Bed", existing_row)
				else:
					try:
						row_doc = frappe.get_doc(
							{
								"doctype": "Bed",
								"greenhouse": block,
								"unit_type": "Row",
								"bed": row_number,
								"variety": variety or "",
							}
						)
						row_doc.insert(ignore_permissions=True)
						rows_created += 1
					except Exception as e:
						frappe.log_error(
							f"Failed to create Row: {e}",
							"Tree And Row Automation Error",
						)
						continue

				# --- Tree ---
				existing_tree = frappe.db.exists(
					{
						"doctype": "Tree",
						"row": row_doc.name,
						"tree_number": tree_number,
					}
				)

				if existing_tree:
					trees_skipped += 1
				else:
					try:
						tree_doc = frappe.get_doc(
							{
								"doctype": "Tree",
								"row": row_doc.name,
								"block": block,
								"tree_number": tree_number,
								"raw_geojson": line,
							}
						)
						tree_doc.insert(ignore_permissions=True)
						trees_created += 1
					except Exception as e:
						frappe.log_error(
							f"Failed to create Tree: {e}",
							"Tree And Row Automation Error",
						)

		return (
			f"{rows_created} rows created, {rows_skipped} skipped. "
			f"{trees_created} trees created, {trees_skipped} skipped."
		)


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
	except Exception as e:
		frappe.throw(f"Error parsing JSON: {e}")
