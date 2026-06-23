# Copyright (c) 2025, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class ScoutingEntry(Document):
	def validate(self):
		greenhouse_flow = any([self.greenhouse, self.bed, self.zone])
		block_flow = any([self.block, self.row, self.tree])

		if greenhouse_flow and block_flow:
			frappe.throw(
				"Scouting Entry must use either the Greenhouse/Bed/Zone flow or "
				"the Block/Row/Tree flow, not both."
			)
		if not greenhouse_flow and not block_flow:
			frappe.throw("Scouting Entry requires a Greenhouse or a Block.")
