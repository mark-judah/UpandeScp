# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document

from upande_scp.serverscripts.common.cumulative_rules import alert_key


class CumulativePestAlert(Document):
	def autoname(self):
		# The name IS the unique key (block, kind, observation, round start): a
		# second insert for the same round fails instead of duplicating, which is
		# what makes "one email per block x pest x round" hold across workers.
		self.name = alert_key(self.warehouse, self.kind, self.observation, self.round_start)
