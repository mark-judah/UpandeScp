// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

// Per-crop pest stages live on each Pest Filter row's `stages` table. Frappe
// can't render a nested editable grid inside an expanded row form (perm.js
// crashes resolving the inner grid's docfield), so we replace the row's
// expand-pencil behaviour with a dialog-based stage editor that calls a
// whitelisted API to read/write stages on a Pest Filter row directly.

frappe.ui.form.on("Crop Scouted", {
	refresh(frm) {
		if (frm.is_new()) return;
		setupPestStagesUI(frm);
	},
	pests_add(frm) {
		// New rows show up after the initial refresh; rehook them.
		setTimeout(() => hijackPestRows(frm), 50);
	},
});

function setupPestStagesUI(frm) {
	const grid = frm.fields_dict.pests && frm.fields_dict.pests.grid;
	if (!grid) return;

	// 1) Header button — discoverable path (tick row, click button).
	grid.add_custom_button(__("Configure Stages"), () => {
		const selected = grid.get_selected_children();
		if (!selected.length) {
			frappe.show_alert({
				message: __("Tick a pest row's checkbox first, then click Configure Stages."),
				indicator: "orange",
			});
			return;
		}
		if (selected.length > 1) {
			frappe.show_alert({
				message: __("Select only one pest row at a time."),
				indicator: "orange",
			});
			return;
		}
		openStagesDialog(frm, selected[0]);
	});

	// 2) Hijack the pencil/expand on each row → open dialog instead of the
	//    broken nested row form.
	hijackPestRows(frm);
}

function hijackPestRows(frm) {
	const grid = frm.fields_dict.pests && frm.fields_dict.pests.grid;
	if (!grid || !grid.grid_rows) return;
	grid.grid_rows.forEach((gridRow) => {
		if (!gridRow || gridRow.__stagesHijacked) return;
		gridRow.__stagesHijacked = true;
		gridRow.toggle_view = function () {
			const doc = gridRow.doc || {};
			if (!doc.name || doc.__islocal) {
				frappe.msgprint(__("Save the document before editing stages on a new row."));
				return gridRow;
			}
			if (!doc.pest) {
				frappe.msgprint(__("Pick a pest for this row first."));
				return gridRow;
			}
			openStagesDialog(frm, doc);
			return gridRow;
		};
		// `show_form` is the deeper entry point grid_row click bindings use.
		gridRow.show_form = function () {
			gridRow.toggle_view();
		};
	});
}

function openStagesDialog(frm, row) {
	if (!row || !row.name || row.__islocal) {
		frappe.msgprint(__("Save the document before editing stages on a new row."));
		return;
	}
	if (!row.pest) {
		frappe.msgprint(__("Pick a pest for this row first."));
		return;
	}

	frappe.call({
		method: "upande_scp.serverscripts.pest_filter_api.get_pest_filter_stages",
		args: { filter_row_name: row.name },
		callback: (r) => {
			const existing = (r && r.message) || [];
			showStagesDialog(row, existing);
		},
	});
}

function showStagesDialog(row, existingStages) {
	const dialog = new frappe.ui.Dialog({
		title: __("Stages for {0}", [row.pest]),
		size: "large",
		fields: [
			{
				fieldname: "stages",
				fieldtype: "Table",
				label: __("Stages"),
				cannot_add_rows: false,
				in_place_edit: true,
				data: existingStages,
				get_data: () => existingStages,
				fields: [
					{
						fieldtype: "Data",
						fieldname: "stage",
						label: __("Stage"),
						in_list_view: 1,
						columns: 4,
						reqd: 1,
					},
					{
						fieldtype: "Select",
						fieldname: "reading_type",
						label: __("Reading Type"),
						options: "Count\nCheckbox\nRange",
						default: "Count",
						in_list_view: 1,
						columns: 2,
					},
					{
						fieldtype: "Small Text",
						fieldname: "plant_sections",
						label: __("Plant Sections"),
						in_list_view: 1,
						columns: 4,
					},
					{
						fieldtype: "Data",
						fieldname: "symbol",
						label: __("Symbol"),
						columns: 1,
					},
				],
			},
		],
		primary_action_label: __("Save Stages"),
		primary_action(values) {
			const stages = values.stages || [];
			frappe.call({
				method: "upande_scp.serverscripts.pest_filter_api.set_pest_filter_stages",
				args: {
					filter_row_name: row.name,
					stages: JSON.stringify(stages),
				},
				freeze: true,
				freeze_message: __("Saving stages..."),
				callback: (r) => {
					if (r && r.message && r.message.ok) {
						frappe.show_alert({
							message: __("Saved {0} stage(s) for {1}", [r.message.count, row.pest]),
							indicator: "green",
						});
						dialog.hide();
					}
				},
			});
		},
	});
	dialog.show();
}
