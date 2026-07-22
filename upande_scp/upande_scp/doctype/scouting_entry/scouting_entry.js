// Copyright (c) 2025, Upande and contributors
// For license information, please see license.txt

// pests/diseases are scoped from the standalone Pest Filter / Disease Filter
// doctypes (linked back by crop_scouted); the rest are Table MultiSelect fields
// embedded directly on the Crop Scouted doc.
const CATEGORY_MAP = [
	{
		section: "section_break_hwtj",
		table: "pests_scouting_entry",
		link_field: "pest",
		filter_doctype: "Pest Filter",
		filter_link: "pest",
	},
	{
		section: "section_break_usor",
		table: "diseases_scouting_entry",
		link_field: "disease",
		filter_doctype: "Disease Filter",
		filter_link: "disease",
	},
	{
		section: "section_break_luxj",
		table: "predators_scouting_entry",
		link_field: "predator",
		crop_field: "predators",
		crop_row_link: "predator",
	},
	{
		section: "section_break_ocal",
		table: "weeds_scouting_entry",
		link_field: "weed",
		crop_field: "weeds",
		crop_row_link: "weed",
	},
	{
		section: "section_break_dlwd",
		table: "incidents_scouting_entry",
		link_field: "incident",
		crop_field: "incidents",
		crop_row_link: "incident",
	},
	{
		section: "section_break_betj",
		table: "physiological_disorders_entry",
		link_field: "physiological_disorders",
		crop_field: "physiological_disorders",
		crop_row_link: "physiological_disorder",
	},
];

frappe.ui.form.on("Scouting Entry", {
	refresh(frm) {
		apply_crop_scope(frm);
	},
	crop_scouted(frm) {
		apply_crop_scope(frm);
	},
});

function apply_crop_scope(frm) {
	const crop_name = frm.doc.crop_scouted;

	if (!crop_name) {
		CATEGORY_MAP.forEach((c) => {
			frm.set_df_property(c.section, "hidden", 0);
			clear_query(frm, c);
		});
		frm.refresh_fields();
		return;
	}

	frappe.db.get_doc("Crop Scouted", crop_name).then((crop) => {
		Promise.all(CATEGORY_MAP.map((c) => resolve_allowed(crop, c))).then((allowed_lists) => {
			// The crop may have changed while the async lookups were in flight;
			// only apply the result that matches the current selection.
			if (frm.doc.crop_scouted !== crop_name) {
				return;
			}
			CATEGORY_MAP.forEach((c, i) => {
				const allowed = allowed_lists[i];
				if (allowed.length === 0) {
					frm.set_df_property(c.section, "hidden", 1);
					frm.clear_table(c.table);
				} else {
					frm.set_df_property(c.section, "hidden", 0);
					frm.set_query(c.link_field, c.table, () => ({
						filters: { name: ["in", allowed] },
					}));
				}
			});
			frm.refresh_fields();
		});
	});
}

// Resolve the allowed species names for a category. pests/diseases come from
// their standalone filter doctypes; the rest from child rows on the crop doc.
function resolve_allowed(crop, c) {
	if (c.filter_doctype) {
		return frappe.db
			.get_list(c.filter_doctype, {
				filters: { crop_scouted: crop.name },
				fields: [c.filter_link],
				limit: 0,
			})
			.then((rows) => rows.map((row) => row[c.filter_link]).filter(Boolean));
	}
	return Promise.resolve(
		(crop[c.crop_field] || []).map((row) => row[c.crop_row_link]).filter(Boolean)
	);
}

function clear_query(frm, c) {
	frm.set_query(c.link_field, c.table, () => ({}));
}
