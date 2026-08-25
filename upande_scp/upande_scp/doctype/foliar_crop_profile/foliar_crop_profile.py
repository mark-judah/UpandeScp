# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class FoliarCropProfile(Document):
	def validate(self):
		dup = frappe.db.exists(
			"Foliar Crop Profile",
			{"foliar": self.foliar, "crop": self.crop, "name": ["!=", self.name]},
		)
		if dup:
			frappe.throw(
				f"A Foliar Crop Profile for {self.foliar} / {self.crop} already exists."
			)
