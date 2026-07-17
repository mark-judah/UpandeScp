// bed_and_zone_automation.js — Bed And Zone Automation desk form scripts (migrated from Client Script fixtures).

// ---------------------------------------------------------------------------
// Bed And Zone Automation Tool  (migrated from Client Script fixture, dt=Bed And Zone Automation)
// ---------------------------------------------------------------------------
frappe.ui.form.on('Bed And Zone Automation', {
    refresh: function(frm) {
        if (frm.doc.docstatus === 0 && !frm.is_new()) {
            frm.add_custom_button(__('Run Automation'), function() {
                frappe.confirm(
                    __('This will create new Bed and Zone documents. Do you want to continue?'),
                    () => {
                        frappe.call({
                            method: "upande_scp.serverscripts.bed_zone_automation.create_beds_and_zones",
                            args: {
                                doc_name: frm.doc.name
                            },
                            freeze: true,
                            freeze_message: "Automating zone and bed creation...",
                            callback: function(r) {
                                if (r.message) {
                                    frappe.msgprint(r.message);
                                }
                                frm.reload_doc();
                            },
                            error: function(r) {
                                if (r.message) {
                                    frappe.msgprint(r.message);
                                }
                            }
                        });
                    }
                );
            });
        }
    }
});
