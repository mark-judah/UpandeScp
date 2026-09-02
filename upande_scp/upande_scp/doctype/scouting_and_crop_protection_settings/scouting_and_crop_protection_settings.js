// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

frappe.ui.form.on("Scouting and Crop Protection Settings", {
	refresh(frm) {
		frm.add_custom_button(
			"Export to Chemicals",
			() => run_export(frm, "export_to_chemicals", "Chemicals"),
			"Crop Protection",
		);
		frm.add_custom_button(
			"Export to Foliars",
			() => run_export(frm, "export_to_foliars", "Foliars"),
			"Crop Protection",
		);
		// The Item `on_update` hook keeps a product in step with its Item Group,
		// but only when the *Item* is saved. Editing the group tables above
		// changes which groups count without touching a single Item, so nothing
		// re-examines the existing products. This does.
		frm.add_custom_button(
			"Re-sync Spray Products",
			() => run_resync(frm),
			"Crop Protection",
		);
	},
});

function run_resync(frm) {
	frappe.confirm(
		"Re-check every Spray Product against its Item's current Item Group. " +
			"Products whose Item has left the configured groups will be disabled " +
			"(kept, not deleted); products whose Item has joined one will be created " +
			"or re-enabled. Continue?",
		() => {
			frappe.call({
				method: "upande_scp.serverscripts.common.crop_protection.resync_products",
				freeze: true,
				freeze_message: "Re-syncing spray products…",
				callback(r) {
					const m = r.message || {};
					const lines = Object.entries(m)
						.filter(([, n]) => n)
						.map(([action, n]) => `${n} ${action}`);
					frappe.msgprint({
						title: "Re-sync Spray Products",
						indicator: "green",
						message: lines.length ? lines.join("<br>") : "Nothing to change.",
					});
				},
			});
		},
	);
}

function run_export(frm, method, label) {
	frappe.call({
		method: `upande_scp.serverscripts.common.crop_protection.${method}`,
		freeze: true,
		freeze_message: `Exporting to ${label}…`,
		callback(r) {
			const m = r.message || {};
			frappe.msgprint({
				title: `Export to ${label}`,
				indicator: "green",
				message: `Scanned ${m.scanned || 0} item(s); created ${m.created || 0} new record(s).`,
			});
		},
	});
}
