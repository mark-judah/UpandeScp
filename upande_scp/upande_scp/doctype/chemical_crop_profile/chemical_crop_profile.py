# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class ChemicalCropProfile(Document):
	def validate(self):
		dup = frappe.db.exists(
			"Chemical Crop Profile",
			{"chemical": self.chemical, "crop": self.crop, "name": ["!=", self.name]},
		)
		if dup:
			frappe.throw(
				f"A Chemical Crop Profile for {self.chemical} / {self.crop} already exists."
			)
