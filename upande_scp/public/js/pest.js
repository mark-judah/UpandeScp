// pest.js — Pest desk form scripts (migrated from Client Script fixtures).

// ---------------------------------------------------------------------------
// Pests Legend Color Toggle  (migrated from Client Script fixture, dt=Pest)
// ---------------------------------------------------------------------------
frappe.ui.form.on('Pest', {
    refresh: function(frm) {
        // Set the initial value of pests_legend_color if the form is new
        if (frm.is_new()) {
            frm.set_value('pests_legend_color', '');
        }
    },
    severity: function(frm) {
        // Find the 'Moderate' severity row
        const moderateRow = frm.doc.severity.find(row => row.severity === 'Moderate');
        
        // If a moderate row exists, update the pests_legend_color
        if (moderateRow) {
            frm.set_value('pests_legend_color', moderateRow.color);
        }
    }
});

frappe.ui.form.on('Scouting Severity Scale', {
    color: function(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (row.severity === 'Moderate') {
            frm.set_value('pests_legend_color', row.color);
        }
    }
});
