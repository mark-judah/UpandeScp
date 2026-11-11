// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

frappe.query_reports["Predator Mortality"] = {
	filters: [
		{ fieldname: "from_date", label: "From", fieldtype: "Date", default: frappe.datetime.add_days(frappe.datetime.get_today(), -90) },
		{ fieldname: "to_date", label: "To", fieldtype: "Date", default: frappe.datetime.get_today() },
		{ fieldname: "farm", label: "Farm", fieldtype: "Link", options: "Farm" },
		{ fieldname: "greenhouse", label: "Greenhouse", fieldtype: "Link", options: "Warehouse" },
	],
};
