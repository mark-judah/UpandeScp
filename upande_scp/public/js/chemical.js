// chemical.js — Chemical desk form: MOA auto-fetch + target toggle by type.

frappe.ui.form.on("Chemical", {
	refresh(frm) {
		toggle_targets(frm, "default_targets");
	},
	type(frm) {
		toggle_targets(frm, "default_targets");
	},
	irac(frm) {
		fetch_codes(frm, "irac", "IRAC Code", "primary_site_of_action", "irac_moa");
	},
	frac(frm) {
		fetch_codes(frm, "frac", "FRAC Code", "mode_of_action", "frac_moa");
	},
	ghs(frm) {
		fetch_codes(frm, "ghs", "GHS Code", "description", "ghs_description");
	},
});

function toggle_targets(frm, table_field) {
	const grid = frm.fields_dict[table_field] && frm.fields_dict[table_field].grid;
	if (!grid) return;
	const type = frm.doc.type;
	grid.toggle_display("disease", type === "Fungicide");
	grid.toggle_display("pest", type === "Insecticide");
	grid.refresh();
}

function fetch_codes(frm, field, doctype, source_field, target) {
	const codes = (frm.doc[field] || []).map((r) => r.code).filter(Boolean);
	if (!codes.length) {
		frm.set_value(target, null);
		return;
	}
	frappe.call({
		method: "frappe.client.get_list",
		args: { doctype, filters: { name: ["in", codes] }, fields: [source_field] },
		callback(r) {
			if (r.message) {
				frm.set_value(
					target,
					r.message.map((d) => d[source_field]).filter(Boolean).join(", "),
				);
			}
		},
	});
}
