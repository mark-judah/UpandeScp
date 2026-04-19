// Copyright (c) 2025, Upande and contributors
// For license information, please see license.txt

const CATEGORY_MAP = [
	{
		section: "section_break_hwtj",
		table: "pests_scouting_entry",
		link_field: "pest",
		crop_field: "pests",
		crop_row_link: "pest",
	},
	{
		section: "section_break_usor",
		table: "diseases_scouting_entry",
		link_field: "disease",
		crop_field: "diseases",
		crop_row_link: "disease",
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
	{
		section: "section_break_hidu",
		table: "trap_scouting_entry",
		link_field: "trap",
		crop_field: "traps",
		crop_row_link: "trap",
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
	if (!frm.doc.crop_scouted) {
		CATEGORY_MAP.forEach((c) => {
			frm.set_df_property(c.section, "hidden", 0);
			clear_query(frm, c);
		});
		frm.refresh_fields();
		return;
	}

	frappe.db.get_doc("Crop Scouted", frm.doc.crop_scouted).then((crop) => {
		CATEGORY_MAP.forEach((c) => {
			const allowed = (crop[c.crop_field] || [])
				.map((row) => row[c.crop_row_link])
				.filter(Boolean);

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
}

function clear_query(frm, c) {
	frm.set_query(c.link_field, c.table, () => ({}));
}
