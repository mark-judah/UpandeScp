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
	},
});

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
