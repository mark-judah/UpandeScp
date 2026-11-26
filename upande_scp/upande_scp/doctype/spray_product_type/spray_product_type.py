# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

# What the Spray Product `type` Select offered before it became a Link.
SEED_TYPES = ("Insecticide", "Fungicide", "Adjuvant", "pH Buffer", "Plant Growth Regulator")


class SprayProductType(Document):
	"""A kind of Spray Product (Insecticide, Fungicide, Biostimulant, ...). A list, not code."""


def ensure_product_types():
	"""Create the seed types, plus any value an existing Spray Product already carries.

	Idempotent. Shared by the migration patch and ``after_migrate`` (a fresh install marks
	every patch done without running it). Names match the old Select options, so every
	existing ``Spray Product.type`` stays a valid Link.
	"""
	if not frappe.db.table_exists("Spray Product Type"):
		return 0
	names = list(SEED_TYPES)
	if frappe.db.table_exists("Spray Product"):
		for (v,) in frappe.db.sql("SELECT DISTINCT type FROM `tabSpray Product` WHERE IFNULL(type,'') != ''"):
			if v not in names:
				names.append(v)
	made = 0
	for n in names:
		if not frappe.db.exists("Spray Product Type", n):
			frappe.get_doc({"doctype": "Spray Product Type", "type_name": n}).insert(ignore_permissions=True)
			made += 1
	return made
