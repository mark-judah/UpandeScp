// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

frappe.ui.form.on("Tree And Row Automation", {
	refresh(frm) {
		if (frm.doc.docstatus === 0 && !frm.is_new()) {
			frm.add_custom_button(__("Run Automation"), function () {
				frappe.confirm(
					__("This will create new Row (Bed) and Tree documents. Do you want to continue?"),
					() => {
						frm.call({
							method: "run_automation",
							doc: frm.doc,
							freeze: true,
							freeze_message: __("Automating row and tree creation..."),
							callback: function (r) {
								if (r.message) {
									frappe.msgprint(r.message);
								}
								frm.reload_doc();
							},
						});
					}
				);
			});
		}
	},
});
