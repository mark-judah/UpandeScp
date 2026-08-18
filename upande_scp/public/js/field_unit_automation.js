// field_unit_automation.js — the Run Automation button on Field Unit Automation.
//
// Replaces bed_and_zone_automation.js. The rose tool had a button and the avocado
// one had none (it was run from the bench shell), so this is also the point at
// which laying out avocado rows and coffee bands stops needing a terminal.
//
// The confirmation names the unit kind, because "this will create new Bed and Zone
// documents" was wrong for two of the three crops.

// What each unit kind imports by default, matching resolve_child_type() on the
// server. The operator can override it with the Creates field.
const DEFAULT_CHILD = { Bed: 'Zone', Row: 'Orchard Tree', Band: 'Triad' };

// A bed has zones. A row or band has triads dividing it and trees planted on it,
// so both are offered — core links Triad.row and Orchard Tree.row to the same
// unit record.
const CHILD_OPTIONS = {
    Bed: ['Zone'],
    Row: ['Triad', 'Orchard Tree'],
    Band: ['Triad', 'Orchard Tree'],
};

const plural = (child) => (child === 'Orchard Tree' ? 'Trees' : `${child}s`);

frappe.ui.form.on('Field Unit Automation', {
    refresh: function (frm) {
        applyChildOptions(frm);
        if (frm.is_new()) return;

        frm.add_custom_button(__('Run Automation'), function () {
            const unit = frm.doc.unit_type || 'Bed';
            const children = plural(frm.doc.child_type || DEFAULT_CHILD[unit] || 'Zone');
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
        applyChildOptions(frm);

        // A Band is a Row wearing coffee's vocabulary; say so where the operator is
        // choosing, so nobody goes looking for a separate band structure.
        if (frm.doc.unit_type === 'Band') {
            frm.dashboard.set_headline(
                __('A Band is a Row under its coffee name. Triads divide it; Orchard Trees are the plants on it.')
            );
        } else {
            frm.dashboard.clear_headline();
        }
    },
});

/**
 * Offer only the children this unit kind can hold, and clear a stale choice.
 *
 * Without the clear, switching Band → Bed would leave "Triad" selected and the
 * server would refuse the run — correct, but a worse place to find out.
 */
function applyChildOptions(frm) {
    const unit = frm.doc.unit_type || 'Bed';
    const options = CHILD_OPTIONS[unit] || ['Zone'];
    frm.set_df_property('child_type', 'options', [''].concat(options).join('\n'));
    if (frm.doc.child_type && !options.includes(frm.doc.child_type)) {
        frm.set_value('child_type', '');
    }
}
