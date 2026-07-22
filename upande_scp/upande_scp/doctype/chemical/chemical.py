# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Chemical(Document):
	def validate(self):
		if self.item and not self.chemical_name:
			self.chemical_name = frappe.db.get_value("Item", self.item, "item_name")
