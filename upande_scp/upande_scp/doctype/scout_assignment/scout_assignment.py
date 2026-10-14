# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

UNIQUE_FIELDS = ("date", "scout", "greenhouse")
UNIQUE_INDEX = "unique_scout_day_house"


class ScoutAssignment(Document):
	# The Schedule page's save_scout_plan is the normal path (it also checks leave
	# and farm scope). Whatever path a save takes, the scout's user and the farm are
	# filled in and a second row for the same scout, day and house is refused —
	# the unique index below backs that up at the database.
	def validate(self):
		if self.scout and not self.user:
			self.user = frappe.db.get_value("Employee", self.scout, "user_id")
		if self.greenhouse and not self.farm:
			self.farm = frappe.db.get_value("Warehouse", self.greenhouse, "custom_farm")
		dupe = frappe.db.exists(
			"Scout Assignment",
			{"date": self.date, "scout": self.scout, "greenhouse": self.greenhouse,
			 "name": ["!=", self.name or ""]},
		)
		if dupe:
			frappe.throw(
				f"{self.scout_name or self.scout} is already planned for {self.greenhouse} on {self.date}.",
				frappe.DuplicateEntryError,
			)


def on_doctype_update():
	frappe.db.add_unique("Scout Assignment", list(UNIQUE_FIELDS), constraint_name=UNIQUE_INDEX)
