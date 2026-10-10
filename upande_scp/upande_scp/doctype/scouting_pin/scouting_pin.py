# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ScoutingPin(Document):
	# C9: only the owner, an SCP General Manager or a System Manager may change
	# or delete a pin, whichever path the change takes (endpoint, Desk, script).
	def validate(self):
		if not self.is_new():
			from upande_scp.serverscripts.scouting.pins import assert_may_edit

			assert_may_edit(self)

	def on_trash(self):
		from upande_scp.serverscripts.scouting.pins import assert_may_edit

		assert_may_edit(self)
