// Desk form script for Spray Product.
//
// One doctype now covers chemicals and foliars; `category` carries the
// distinction, and it is set from the Item's Item Group rather than typed, so
// the form explains where it came from instead of inviting an edit that the
// next Item save would undo.
frappe.ui.form.on("Spray Product", {
	refresh(frm) {
		if (frm.doc.disabled) {
			frm.dashboard.set_headline_alert(
				"This product's Item has left the configured crop-protection Item " +
					"Groups, so it is hidden from spray planning. Its rates and codes " +
					"are kept — move the Item back into a configured group to re-enable it.",
				"orange",
			);
		}
		if (frm.doc.item) {
			frm.add_custom_button(__("Open Item"), () =>
				frappe.set_route("Form", "Item", frm.doc.item),
			);
		}
	},

	category(frm) {
		if (frm.doc.__islocal) return;
		frm.set_df_property(
			"category",
			"description",
			"Normally set from the Item's Item Group via Scouting and Crop " +
				"Protection Settings. An edit here is overwritten the next time the " +
				"Item's group changes.",
		);
	},
});
