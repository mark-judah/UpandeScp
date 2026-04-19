import frappe


@frappe.whitelist()
def getCropsScouted():
	crops = frappe.get_all(
		"Crop Scouted",
		fields=["name", "crop_name", "variety", "image"],
		order_by="crop_name asc",
	)

	frappe.response["message"] = {"data": crops}
	return frappe.response["message"]
