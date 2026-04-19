import frappe


@frappe.whitelist()
def getCropsScouted(farm=None):
	"""Return the list of Crop Scouted records.

	If `farm` is supplied, only return crops whose `farms` multi-select contains
	that farm, OR crops with an empty `farms` list (applies-to-all semantics,
	mirroring FRAC Code Filter's convention).
	"""
	crops = frappe.get_all(
		"Crop Scouted",
		fields=["name", "crop_name", "variety", "image"],
		order_by="crop_name asc",
	)

	if farm:
		tagged_per_crop = frappe.get_all(
			"Farm Filter",
			filters={"parent": ["in", [c.name for c in crops]]} if crops else {"parent": "__none__"},
			fields=["parent", "farm"],
		)
		tagged_by_crop = {}
		for row in tagged_per_crop:
			tagged_by_crop.setdefault(row.parent, set()).add(row.farm)

		crops = [
			c
			for c in crops
			if c.name not in tagged_by_crop  # empty farms → applies to all
			or farm in tagged_by_crop[c.name]
		]

	frappe.response["message"] = {"data": crops}
	return frappe.response["message"]
