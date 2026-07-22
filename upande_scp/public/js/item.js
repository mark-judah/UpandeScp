// item.js — Item desk form scripts.
//
// Chemical metadata now lives on the Chemical / Foliar doctypes (created
// automatically for items in the configured crop-protection groups). The only
// SCP field left on the Item is the per-variety intervention threshold, shown
// for the rose-variety groups.

const INTERVENTION_GROUPS = ["Spray Roses", "Standard Roses", "Summer Flowers"];

frappe.ui.form.on("Item", {
    refresh(frm) {
        toggle_intervention(frm);
    },
    item_group(frm) {
        toggle_intervention(frm);
    },
});

function toggle_intervention(frm) {
    const show = INTERVENTION_GROUPS.includes(frm.doc.item_group);
    frm.set_df_property("custom_chemical_intervention_threshhold", "hidden", show ? 0 : 1);
}
