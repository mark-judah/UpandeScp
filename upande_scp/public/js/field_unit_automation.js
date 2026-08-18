// field_unit_automation.js — the Run Automation button on Field Unit Automation.
//
// Replaces bed_and_zone_automation.js. The rose tool had a button and the avocado
// one had none (it was run from the bench shell), so this is also the point at
// which laying out avocado rows and coffee bands stops needing a terminal.
//
// The confirmation names the unit kind and its child, because "this will create new
// Bed and Zone documents" was wrong for two of the three crops.

// One child per unit kind, mirroring _UNIT_SPEC on the server.
const CHILD_OF = { Bed: 'Zones', Row: 'Trees', Band: 'Triads' };

frappe.ui.form.on('Field Unit Automation', {
    refresh: function (frm) {
        if (frm.is_new()) return;

        frm.add_custom_button(__('Run Automation'), function () {
            const unit = frm.doc.unit_type || 'Bed';
            const children = CHILD_OF[unit] || 'children';
            frappe.confirm(
                __('This will create {0} and {1} for {2}. Existing ones are left alone. Continue?', [
                    __(unit + 's'),
                    __(children),
                    frm.doc.warehouse,
                ]),
                () => {
                    frappe.call({
                        method: 'upande_scp.upande_scp.doctype.field_unit_automation.field_unit_automation.run',
                        args: { doc_name: frm.doc.name },
                        freeze: true,
                        freeze_message: __('Creating {0} and {1}…', [
                            __(unit + 's'),
                            __(children),
                        ]),
                        callback: function (r) {
                            if (r.message) frappe.msgprint(r.message);
                            frm.reload_doc();
                        },
                        error: function (r) {
                            if (r.message) frappe.msgprint(r.message);
                        },
                    });
                }
            );
        });
    },

    unit_type: function (frm) {
        // Say what each kind produces where the operator is choosing, so nobody has
        // to go and look it up.
        const unit = frm.doc.unit_type;
        if (unit && CHILD_OF[unit]) {
            frm.dashboard.set_headline(
                __('{0}s hold {1}.', [__(unit), __(CHILD_OF[unit])])
            );
        } else {
            frm.dashboard.clear_headline();
        }
    },
});
