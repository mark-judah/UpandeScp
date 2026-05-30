# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class CropScouted(Document):
	def on_trash(self):
		# Pest Filter / Disease Filter are now standalone docs linked by
		# `crop_scouted`, so Frappe no longer auto-deletes them with the parent.
		# Delete them explicitly; their Pests/Disease Stages children cascade.
		for dt in ("Pest Filter", "Disease Filter"):
			for name in frappe.get_all(
				dt, filters={"crop_scouted": self.name}, pluck="name"
			):
				frappe.delete_doc(dt, name, ignore_permissions=True, force=True)
