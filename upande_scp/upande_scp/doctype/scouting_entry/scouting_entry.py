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
		self._fill_crop_from_station()

	def _fill_crop_from_station(self):
		"""A blank crop is read from what is planted at the station on the day."""
		if self.crop_scouted:
			return
		station = self.greenhouse or self.block
		if not station:
			return
		from upande_scp.serverscripts.common.planting import crop_for_station

		self.crop_scouted = crop_for_station(station, self.date_of_capture)
