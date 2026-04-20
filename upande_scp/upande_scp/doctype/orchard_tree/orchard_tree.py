# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Tree(Document):
	def autoname(self):
		code = build_tree_code(self.row, self.tree_number)
		self.tree_code = code
		self.name = code

	def before_save(self):
		if not self.block and self.row:
			self.block = frappe.db.get_value("Bed", self.row, "greenhouse")
		self.tree_code = build_tree_code(self.row, self.tree_number)


def build_tree_code(row_name, tree_number):
	"""Build `{sector}_{block}_ROW{n}_T{n}`, e.g. `23HA_WESA1_ROW1_T1`.

	  - Sector = first whitespace-separated token of the block's
	    parent_warehouse name (e.g. `23HA Avocado - UF` → `23HA`).
	  - Block  = block warehouse name with the farm suffix stripped and the
	    leading `Block` prefix removed (e.g. `Block WESA1 - UF` → `WESA1`).
	"""
	if not row_name:
		return f"Tree {tree_number}"

	row_doc = frappe.db.get_value(
		"Bed", row_name, ["greenhouse", "bed"], as_dict=True
	)
	if not row_doc:
		return f"Tree {tree_number}"

	block_name = row_doc.greenhouse or ""
	row_token = _row_token(row_doc.bed)
	tree_token = f"T{tree_number}" if tree_number else "T"

	sector_code = ""
	block_code = ""
	if block_name:
		sector_name = frappe.db.get_value("Warehouse", block_name, "parent_warehouse")
		block_code = _block_short_code(block_name)
		if sector_name:
			sector_code = _sector_short_code(sector_name)

	parts = [p for p in [sector_code, block_code, row_token, tree_token] if p]
	return "_".join(parts)


def _strip_farm_suffix(name):
	if " - " in name:
		return name.rsplit(" - ", 1)[0].strip()
	return name.strip()


def _sector_short_code(warehouse_name):
	if not warehouse_name:
		return ""
	name = _strip_farm_suffix(warehouse_name)
	head = name.split()[0] if name.split() else name
	return head.split("_")[0] if head else ""


def _block_short_code(warehouse_name):
	if not warehouse_name:
		return ""
	name = _strip_farm_suffix(warehouse_name)
	if name.lower().startswith("block"):
		name = name[5:].lstrip(" _-")
	return "".join(name.split())


def _row_token(bed_value):
	if bed_value is None:
		return "ROW"
	digits = "".join(ch for ch in str(bed_value) if ch.isdigit())
	return f"ROW{digits}" if digits else f"ROW{bed_value}"
