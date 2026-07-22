# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Foliar(Document):
	def validate(self):
		if self.item and not self.foliar_name:
			self.foliar_name = frappe.db.get_value("Item", self.item, "item_name")
