// Copyright (c) 2025, Upande and contributors
// For license information, please see license.txt

const TRAP_RUN_ROLES = ["System Manager", "SCP General Manager"];

function scp_trap_can_estimate() {
	return TRAP_RUN_ROLES.some((r) => frappe.user.has_role(r));
}

// The unit a trap hangs on stands in the trap's station: hexagons and trees carry it as
// `block`, beds / rows as `greenhouse`.
const SCP_TRAP_UNIT_STATION = { Triad: "block", "Orchard Tree": "block", Bed: "greenhouse" };

frappe.ui.form.on("Trap", {
	setup(frm) {
		frm.set_query("unit", (doc) => {
			const field = SCP_TRAP_UNIT_STATION[doc.unit_type];
			return field && doc.greenhouse ? { filters: { [field]: doc.greenhouse } } : {};
		});
	},
	unit_type(frm) {
		frm.set_value("unit", "");
	},
	refresh(frm) {
		if (frm.is_new() || !scp_trap_can_estimate()) return;
		if (frm.doc.location_source === "Manual") {
			frm.set_intro(__("Location is Manual: the daily GPS estimate leaves it alone. Set Location Source to GPS estimate to hand it back."), "blue");
		} else if (frm.doc.location_flag) {
			frm.set_intro(__("GPS estimate is {0}: check the trap on the ground.", [frm.doc.location_flag]), "orange");
		}
		frm.add_custom_button(__("Estimate location from GPS"), () => {
			if (frm.doc.location_source === "Manual") {
				frappe.msgprint(__("This trap is Manual. Set Location Source to GPS estimate and save first."));
				return;
			}
			frappe.require("/assets/upande_scp/js/trap_estimate.js", () =>
				window.scp_estimate_trap_locations({ trap: frm.doc.name }, () => frm.reload_doc()),
			);
		});
	},
});
