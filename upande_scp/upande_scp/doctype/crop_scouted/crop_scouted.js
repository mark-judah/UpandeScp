// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

// Pest Filter and Disease Filter are standalone DocTypes linked to this crop
// via `crop_scouted`. Manage them (and edit each filter's Stages grid inline)
// from the Connections tab on a saved Crop Scouted document.
frappe.ui.form.on("Crop Scouted", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(__("Pest Filters"), () => {
			frappe.set_route("List", "Pest Filter", { crop_scouted: frm.doc.name });
		});
		frm.add_custom_button(__("Disease Filters"), () => {
			frappe.set_route("List", "Disease Filter", { crop_scouted: frm.doc.name });
		});
	},
});
