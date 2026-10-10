// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

frappe.listview_settings["Trap"] = {
	onload(listview) {
		const roles = ["System Manager", "SCP General Manager"];
		if (!roles.some((r) => frappe.user.has_role(r))) return;
		listview.page.add_inner_button(__("Estimate locations from GPS"), () => {
			const farm = (listview.filter_area.get() || []).find((f) => f[1] === "farm" && f[2] === "=");
			frappe.prompt(
				[{ fieldname: "farm", fieldtype: "Link", options: "Farm", label: __("Farm (blank = all)"), default: farm ? farm[3] : "" }],
				(v) => {
					const run = () =>
						window.scp_estimate_trap_locations({ farm: v.farm || "" }, () => listview.refresh());
					frappe.require("/assets/upande_scp/js/trap_estimate.js", run);
				},
				__("Estimate trap locations"),
			);
		});
	},
};
