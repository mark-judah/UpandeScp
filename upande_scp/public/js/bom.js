// bom.js — BOM desk form scripts (migrated from Client Script fixtures).

// ---------------------------------------------------------------------------
// BOM Toggle Fields  (migrated from Client Script fixture, dt=BOM)
// ---------------------------------------------------------------------------
frappe.ui.form.on('BOM', {
    after_load: function (frm) {
        if (frm.doc.custom_item_group && frm.doc.custom_item_group.toLowerCase() === 'chemical mix') {
            frm.clear_table('items');
            frm.set_df_property('custom_farm', 'reqd', 0);
            toggle_fields_visibility(frm);
        } else {
            reset_bom_fields(frm);
        }
    },

    // Event triggered when the main 'item' field is changed.
    item: function (frm) {
        if (frm.doc.item) {
            frappe.db.get_value('Item', frm.doc.item, 'item_group', (r) => {
                if (r.item_group) {
                    frm.set_value('custom_item_group', r.item_group);

                    if (frm.doc.custom_item_group && frm.doc.custom_item_group.toLowerCase() === 'chemical mix') {
                        frm.clear_table('items');
                        frm.set_df_property('custom_farm', 'reqd', 0);
                        toggle_fields_visibility(frm);
                        frm.doc.items.forEach(row => {
                            calculate_qty(frm, row.doctype, row.name);
                        });
                    } else {
                        reset_bom_fields(frm);
                    }
                }
            });
        }
    },

    refresh: function (frm) {
        if (frm.doc.custom_item_group && frm.doc.custom_item_group.toLowerCase() === 'chemical mix') {
            frm.set_df_property('custom_farm', 'reqd', 0);
            toggle_fields_visibility(frm);
            frm.doc.items.forEach(row => {
                calculate_qty(frm, row.doctype, row.name);
            });
        } else {
            reset_bom_fields(frm);
        }
    }
});
frappe.ui.form.on('BOM Item', {
    custom_application_rateper_ha_: function(frm, cdt, cdn) {
        if (frm.doc.custom_item_group && frm.doc.custom_item_group.toLowerCase() === 'chemical mix') {
            calculate_qty(frm, cdt, cdn);
        }
    }
});

function calculate_qty(frm, cdt, cdn) {
    const row = frappe.get_doc(cdt, cdn);
    const rate = row.custom_application_rateper_ha_ || 0;
    frappe.model.set_value(cdt, cdn, 'qty', 1 * rate);
}

function toggle_fields_visibility(frm) {
    const child_table_name = 'items';
    const all_managed_fields = [
        'is_stock_item',
        'allow_alternative_item',
        'source_warehouse',
        'custom_application_rateper_ha_'
    ];
    const child_grid = frm.fields_dict[child_table_name]?.grid;

    if (child_grid) {
        all_managed_fields.forEach(field => {
            child_grid.set_column_disp(field, false);
        });

        const fields_to_show_for_chemical_mix = [
            'custom_application_rateper_ha_'
        ];
        fields_to_show_for_chemical_mix.forEach(field => {
            child_grid.set_column_disp(field, true);
        });
    }

    const parent_fields_to_show = [
        'custom_water_ph',
        'custom_water_hardness',
    ];

    parent_fields_to_show.forEach(field => frm.toggle_display(field, true));
}

function reset_bom_fields(frm) {
    const child_table_name = 'items';
    const child_grid = frm.fields_dict[child_table_name]?.grid;

    const standard_fields = [
        'is_stock_item',
        'allow_alternative_item',
        'source_warehouse'
    ];

    const custom_fields = [
        'custom_application_rateper_ha_'
    ];

    const parent_fields_to_show = [
        'custom_mixing_instructions',
        'custom_target_pests'
    ];

    parent_fields_to_show.forEach(field => frm.toggle_display(field, false));

    if (child_grid) {
        standard_fields.forEach(field => {
            child_grid.set_column_disp(field, true);
        });
        custom_fields.forEach(field => {
            child_grid.set_column_disp(field, false);
        });
    }

    frm.set_value('allow_alternative_item', 0);
}
