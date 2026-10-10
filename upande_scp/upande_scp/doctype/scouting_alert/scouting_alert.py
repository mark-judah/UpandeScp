# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document

from upande_scp.serverscripts.scouting.thresholds_check import alert_name


class ScoutingAlert(Document):
	def autoname(self):
		# The name IS the unique key (house, kind, observation, stage, ISO week):
		# a second insert of the same key fails instead of duplicating (spec §4).
		self.name = alert_name(self.warehouse, self.kind, self.observation, self.stage, self.iso_week)
