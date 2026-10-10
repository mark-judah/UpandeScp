# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ScoutingPin(Document):
	# C6/C9: the whitelisted endpoints are the only normal path (the doctype
	# grants System Manager alone). Whatever path a save takes, the house and
	# the stations are re-checked, and only the owner, an SCP General Manager
	# or a System Manager may change or delete a pin.
	def validate(self):
		from upande_scp.serverscripts.scouting.pins import assert_may_edit, normalise

		if not self.is_new():
			assert_may_edit(self)
		normalise(self)

	def on_trash(self):
		from upande_scp.serverscripts.scouting.pins import assert_may_edit

		assert_may_edit(self)
