// item.js — Item desk form scripts (migrated from Client Script fixtures).

// ---------------------------------------------------------------------------
// Items Toggle Fields  (migrated from Client Script fixture, dt=Item)
// ---------------------------------------------------------------------------
frappe.ui.form.on('Item', {
    refresh(frm) {
        toggle_custom_fields(frm);
        toggle_type_fields(frm, false);
    },
    item_group(frm) {
        toggle_custom_fields(frm, false); // true means clear old values
    },
    custom_type(frm) {
        toggle_type_fields(frm, false); // clear old values
    },
    custom_irac(frm) {
        fetch_irac_moa(frm);
    },
    custom_frac(frm) {
        fetch_frac_moa(frm);
    },
    custom_ghs(frm) {
        fetch_ghs_description(frm);
    }
});

function toggle_custom_fields(frm, clear_values = false) {
    let group_field_map = {
        "Spray Roses": ["custom_chemical_intervention_threshhold"],
        "Standard Roses": ["custom_chemical_intervention_threshhold"],
        "Summer Flowers": ["custom_chemical_intervention_threshhold"],
        "CHEMICALS": [
            "custom_type",
            "custom_ghs",
            "custom_ghs_description",
            "custom_toxicity",
            "custom_irac",
            "custom_irac_moa",
            "custom_frac",
            "custom_frac_moa",
            "custom_reentry_interval_hrs",
            "custom_active_ingredients",
            "custom_targets"
        ],
        "AVOCADO CHEMICALS": [
            "custom_type",
            "custom_ghs",
            "custom_ghs_description",
            "custom_toxicity",
            "custom_irac",
            "custom_irac_moa",
            "custom_frac",
            "custom_frac_moa",
            "custom_reentry_interval_hrs",
            "custom_active_ingredients",
            "custom_targets"
        ],
    };

    // Flatten all possible fields
    let all_fields = Object.values(group_field_map).flat();

    // If item_group not selected, hide and optionally clear all fields
    if (!frm.doc.item_group) {
        all_fields.forEach(field => {
            frm.set_df_property(field, "hidden", 1);
            if (clear_values) frm.set_value(field, null);
        });
        return;
    }

    // Determine which fields should be shown
    let fields_to_show = group_field_map[frm.doc.item_group] || [];

    // Hide (and optionally clear) irrelevant fields
    all_fields.forEach(field => {
        if (!fields_to_show.includes(field)) {
            frm.set_df_property(field, "hidden", 1);
            if (clear_values) frm.set_value(field, null);
        }
    });

    // Show relevant fields
    fields_to_show.forEach(field => {
        frm.set_df_property(field, "hidden", 0);
    });
}

function toggle_type_fields(frm, clear_values = false) {
    let type_field_map = {
        "Insecticide": [
            "custom_irac",
            "custom_irac_moa",
            "custom_reentry_interval_hrs",
            "custom_active_ingredients",
            "custom_targets"
        ],
        "Fungicide": [
            "custom_frac",
            "custom_frac_moa",
            "custom_reentry_interval_hrs",
            "custom_active_ingredients",
            "custom_targets"
        ],
        "Adjuvant": [],
        "pH Buffer": [],
    };

    const grid = frm.fields_dict["custom_targets"].grid;
    const type = frm.doc.custom_type;

    grid.toggle_display("disease", type === "Fungicide");
    grid.toggle_display("pest", type === "Insecticide");

    grid.refresh();

    let all_type_fields = Object.values(type_field_map).flat();
    if (!frm.doc.custom_type) {
        all_type_fields.forEach(field => {
            frm.set_df_property(field, "hidden", 1);
            if (clear_values) frm.set_value(field, null);
        });
        return;
    }

    let fields_to_show = type_field_map[frm.doc.custom_type] || [];

    all_type_fields.forEach(field => {
        if (!fields_to_show.includes(field)) {
            frm.set_df_property(field, "hidden", 1);
            if (clear_values) frm.set_value(field, null);
        }
    });

    fields_to_show.forEach(field => {
        frm.set_df_property(field, "hidden", 0);
    });
}

function fetch_irac_moa(frm) {
    if (!frm.doc.custom_irac || frm.doc.custom_irac.length === 0) {
        frm.set_value("custom_irac_moa", null);
        return;
    }

    // Collect all IRAC codes from the child table
    let irac_codes = frm.doc.custom_irac.map(row => row.code).filter(x => x);

    if (irac_codes.length === 0) {
        frm.set_value("custom_irac_moa", null);
        return;
    }

    frappe.call({
        method: "frappe.client.get_list",
        args: {
            doctype: "IRAC Code",
            filters: { name: ["in", irac_codes] },
            fields: ["primary_site_of_action"]
        },
        callback: function (r) {
            if (r.message) {
                let moa_list = r.message.map(d => d.primary_site_of_action);
                frm.set_value("custom_irac_moa", moa_list.join(", "));
            }
        }
    });
}

function fetch_frac_moa(frm) {
    if (!frm.doc.custom_frac || frm.doc.custom_frac.length === 0) {
        frm.set_value("custom_frac_moa", null);
        return;
    }

    // Collect all IRAC codes from the child table
    let frac_codes = frm.doc.custom_frac.map(row => row.code).filter(x => x);

    if (frac_codes.length === 0) {
        frm.set_value("custom_frac_moa", null);
        return;
    }

    frappe.call({
        method: "frappe.client.get_list",
        args: {
            doctype: "FRAC Code",
            filters: { name: ["in", frac_codes] },
            fields: ["mode_of_action"]
        },
        callback: function (r) {
            if (r.message) {
                let moa_list = r.message.map(d => d.mode_of_action);
                frm.set_value("custom_frac_moa", moa_list.join(", "));
            }
        }
    });
}

function fetch_ghs_description(frm) {
    if (!frm.doc.custom_ghs || frm.doc.custom_ghs.length === 0) {
        frm.set_value("custom_ghs_description", null);
        return;
    }

    // Collect all IRAC codes from the child table
    let custom_ghs = frm.doc.custom_ghs.map(row => row.code).filter(x => x);

    if (custom_ghs.length === 0) {
        frm.set_value("custom_ghs_description", null);
        return;
    }

    frappe.call({
        method: "frappe.client.get_list",
        args: {
            doctype: "GHS Code",
            filters: { name: ["in", custom_ghs] },
            fields: ["description"]
        },
        callback: function (r) {
            if (r.message) {
                let moa_list = r.message.map(d => d.description);
                frm.set_value("custom_ghs_description", moa_list.join(", "));
            }
        }
    });
}
