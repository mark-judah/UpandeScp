// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

frappe.listview_settings["Sprayer"] = {
	onload(listview) {
		const roles = ["System Manager", "SCP General Manager"];
		if (!roles.some((r) => frappe.user.has_role(r))) return;
		listview.page.add_inner_button(__("Sync from Employees"), () => {
			frappe.call({
				method: "upande_scp.serverscripts.sprayers.register.sync_sprayers_now",
				freeze: true,
				freeze_message: __("Syncing sprayers…"),
				callback(r) {
					const m = r.message || {};
					frappe.show_alert({
						message: __("{0} created, {1} updated", [m.created || 0, m.updated || 0]),
						indicator: "green",
					});
					listview.refresh();
				},
			});
		});
	},
};
