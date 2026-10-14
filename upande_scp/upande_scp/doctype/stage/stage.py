# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document

from upande_scp.serverscripts.common import stage_roles


class Stage(Document):
	def validate(self):
		# stage_role has no column default (the seed patch fills blanks only, and
		# a DB default would make every existing stage look already set), so a
		# blank role is made the S1 default here.
		if not (self.stage_role or "").strip():
			self.stage_role = stage_roles.LIFE_STAGE
