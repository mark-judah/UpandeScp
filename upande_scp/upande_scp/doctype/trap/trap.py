# Copyright (c) 2025, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class Trap(Document):
	def validate(self):
		# A location edited on the form is a human placing the trap: mark it
		# Manual so the GPS estimator never overwrites it. The estimator writes
		# with db.set_value, which skips this hook.
		if self.geojson and self.has_value_changed("geojson"):
			self.location_source = "Manual"
