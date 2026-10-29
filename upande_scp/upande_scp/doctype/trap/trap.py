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
		# Hung on a unit (a hexagon, a tree, a bed): the unit must stand in this trap's station.
		from upande_scp.serverscripts.traps.trap_units import validate_trap_unit

		validate_trap_unit(self)
