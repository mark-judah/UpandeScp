# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Tree(Document):
	def autoname(self):
		# Prefer a manually set tree_code; otherwise compute the canonical
		# {section}_{block}_ROW{n}_T{n} pattern from the linked row.
		code = self.tree_code or build_tree_code(self.row, self.tree_number)
		self.tree_code = code
		self.name = code

	def before_save(self):
		# Keep tree_code in sync with the computed name when the row or
		# tree_number changes. Users can still override by editing tree_code
		# explicitly.
		if not self.tree_code:
			self.tree_code = build_tree_code(self.row, self.tree_number)
		if not self.block and self.row:
			self.block = frappe.db.get_value("Bed", self.row, "greenhouse")


def build_tree_code(row_name, tree_number):
	"""Build `{section}_{block}_ROW{n}_T{n}` from a Bed (Row) and tree number.

	Derives the section and block short codes from the warehouse hierarchy:
	  - Block (Bed.greenhouse) → short code with the farm suffix stripped
	    and whitespace collapsed.
	  - Section (Block.parent_warehouse) → short code with the farm suffix
	    stripped, taking the leading underscore-separated token.
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

	section_code = ""
	block_code = ""
	if block_name:
		section_name = frappe.db.get_value(
			"Warehouse", block_name, "parent_warehouse"
		)
		block_code = _warehouse_short_code(block_name, short=True)
		if section_name:
			section_code = _warehouse_short_code(section_name, short=False)

	parts = [p for p in [section_code, block_code, row_token, tree_token] if p]
	return "_".join(parts)


def _row_token(bed_value):
	if bed_value is None:
		return "ROW"
	digits = "".join(ch for ch in str(bed_value) if ch.isdigit())
	return f"ROW{digits}" if digits else f"ROW{bed_value}"


def _warehouse_short_code(warehouse_name, short):
	if not warehouse_name:
		return ""
	name = warehouse_name
	if " - " in name:
		name = name.rsplit(" - ", 1)[0]
	if not short:
		head = name.split("_", 1)[0]
		return head.strip()
	compact = "".join(name.split())
	compact = compact.replace("BL", "")
	return compact
