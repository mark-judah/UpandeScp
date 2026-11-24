# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


#: A crop's field units carry its shape: roses are grown on beds, avocado and coffee on
#: rows or hexas (a hexa is a block unit holding triads). `Bed.unit_type` records which, so a farm tagged with a crop it has
#: no units for is very likely a typo — `Rose -> Vale` was exactly that, and once the
#: tags became an access rule it would have handed roses to every Kaitet Ltd. user.
UNIT_TYPES_BY_CROP = {
	"Rose": ("Bed",),
	"Avocado": ("Row", "Hexa"),
	"Coffee": ("Row", "Hexa"),
}


class CropScouted(Document):
	def validate(self):
		self._warn_about_farms_without_units()

	def _warn_about_farms_without_units(self):
		"""Warn when a tagged farm has no field units of this crop's kind.

		A warning, not an error. A farm is often planted before it is scouted — coffee
		had no beds anywhere on kaitet when it was first tagged to Endebess and Saboti —
		and refusing the tag would make it impossible to grant access ahead of the first
		scout walking the field. The point is that a mistake announces itself rather
		than silently deciding who sees what.
		"""
		kinds = UNIT_TYPES_BY_CROP.get(self.name)
		if not kinds:
			return
		kinds_label = " or ".join(k.lower() + "s" for k in reversed(kinds))

		suspect = []
		for row in self.farms or []:
			farm = getattr(row, "farm", None)
			if not farm:
				continue
			units = frappe.db.sql(
				"""SELECT 1 FROM `tabBed` b
				   JOIN `tabWarehouse` w ON w.name = b.greenhouse
				   WHERE w.custom_farm = %(farm)s AND IFNULL(b.unit_type, 'Bed') IN %(kinds)s
				   LIMIT 1""",
				{"farm": farm, "kinds": kinds},
			)
			if not units:
				suspect.append(farm)

		if suspect:
			frappe.msgprint(
				f"{self.name} is tagged to {', '.join(sorted(suspect))}, which have no "
				f"{kinds_label} recorded. That is fine for a farm planted but not "
				f"yet scouted — but if it is a mistake, it now decides who can see this "
				f"crop.",
				title="Check these farms",
				indicator="orange",
			)

	def on_trash(self):
		# Pest Filter / Disease Filter are now standalone docs linked by
		# `crop_scouted`, so Frappe no longer auto-deletes them with the parent.
		# Delete them explicitly; their Pests/Disease Stages children cascade.
		for dt in ("Pest Filter", "Disease Filter"):
			for name in frappe.get_all(
				dt, filters={"crop_scouted": self.name}, pluck="name"
			):
				frappe.delete_doc(dt, name, ignore_permissions=True, force=True)
