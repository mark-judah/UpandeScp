// Adds a "Submit for Approval" button to the Work Order form for
// Application Floor Plan drafts that didn't get pushed through the React
// "Submit all" flow. One-click recovery so a planner can rescue a
// stranded draft from the Desk.
//
// Only visible when:
//   - custom_type == "Application Floor Plan"
//   - docstatus == 0 (draft)
//   - workflow_state == "Pending Submission"
//
// Calls the same race-safe endpoint as the bulk flow (single-WO list).

frappe.ui.form.on("Work Order", {
    refresh: function (frm) {
        if (frm.doc.custom_type !== "Application Floor Plan") return;
        if (frm.doc.docstatus !== 0) return;
        if (frm.doc.workflow_state !== "Pending Submission") return;

        frm.add_custom_button(
            __("Submit for Approval"),
            function () {
                frappe.confirm(
                    __("Submit this spray plan for General Manager approval?"),
                    function () {
                        frappe.call({
                            method:
                                "upande_scp.serverscripts.spray_plan_creator.bulk.submit_drafts_for_approval",
                            args: { wo_names: [frm.doc.name] },
                            freeze: true,
                            freeze_message: __("Submitting…"),
                            callback: function (r) {
                                const res = (r && r.message) || {};
                                const submitted = (res.submitted || []).length;
                                const skipped = (res.skipped || []).length;
                                if (submitted > 0) {
                                    frappe.show_alert(
                                        {
                                            message: __(
                                                "Submitted — now awaiting GM approval.",
                                            ),
                                            indicator: "green",
                                        },
                                        4,
                                    );
                                    frm.reload_doc();
                                } else {
                                    const why =
                                        (res.skipped || [])
                                            .map((s) => s.reason)
                                            .join(", ") || "no reason returned";
                                    frappe.msgprint({
                                        title: __("Not submitted"),
                                        message: __(
                                            "{0} skipped ({1}). The plan may already be submitted or you may have lost farm access.",
                                            [skipped, why],
                                        ),
                                        indicator: "orange",
                                    });
                                }
                            },
                        });
                    },
                );
            },
            __("Spray Plan"),
        );
    },
});

// ---------------------------------------------------------------------------
// Refresh Greenhouse Rentry Time  (migrated from Client Script fixture, dt=Work Order)
// ---------------------------------------------------------------------------
frappe.ui.form.on('Work Order', {
    refresh: function(frm) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        setTimeout(function() {
            calculate_reentry_period(frm);
        }, 100);
    },
    onload: function(frm) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        calculate_reentry_period(frm);
    },
    after_load: function(frm) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        calculate_reentry_period(frm);
    },
    custom_scheduled_application_time: function(frm) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        calculate_reentry_time(frm);
    },
    custom_reentry_period_hrs: function(frm) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        calculate_reentry_time(frm);
    }
});

frappe.ui.form.on('Work Order Item', {
    required_items_add: function(frm, cdt, cdn) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        calculate_reentry_period(frm);
    },
    required_items_remove: function(frm, cdt, cdn) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        calculate_reentry_period(frm);
    },
    item_code: function(frm, cdt, cdn) {
        if (frm.doc.custom_type !== 'Application Floor Plan') {
            return;
        }
        calculate_reentry_period(frm);
    }
});

function calculate_reentry_time(frm) {
    let scheduled_time = frm.doc.custom_scheduled_application_time;
    let reentry_hours = frm.doc.custom_reentry_period_hrs || 0;

    if (!scheduled_time) {
        frm.set_value('custom_reentry_time', null);
        return;
    }

    reentry_hours = parseFloat(reentry_hours);

    if (isNaN(reentry_hours) || reentry_hours < 0) {
        frappe.msgprint({
            title: __('Error'),
            indicator: 'red',
            message: __('Invalid reentry period. Please check the items and try again.')
        });
        frm.set_value('custom_reentry_time', null);
        return;
    }

    try {
        let scheduled_date = new Date(scheduled_time);

        if (isNaN(scheduled_date.getTime())) {
            throw new Error('Invalid scheduled application time format');
        }

        let current_utc_hours = scheduled_date.getUTCHours();
        scheduled_date.setUTCHours(current_utc_hours + reentry_hours);
        
        if (isNaN(scheduled_date.getTime())) {
            throw new Error('Invalid reentry time calculation result');
        }

        // Manual formatting to YYYY-MM-DD HH:MM:SS
        let YYYY = scheduled_date.getFullYear();
        let MM = String(scheduled_date.getMonth() + 1).padStart(2, '0');
        let DD = String(scheduled_date.getDate()).padStart(2, '0');
        let HH = String(scheduled_date.getHours()).padStart(2, '0');
        let mm = String(scheduled_date.getMinutes()).padStart(2, '0');
        let SS = String(scheduled_date.getSeconds()).padStart(2, '0');

        let reentry_time = `${YYYY}-${MM}-${DD} ${HH}:${mm}:${SS}`;

        frm.set_value('custom_reentry_time', reentry_time);

    } catch (error) {
        frappe.msgprint({
            title: __('Calculation Error'),
            indicator: 'red',
            message: __('Failed to calculate reentry time: {0}', [error.message])
        });
        frm.set_value('custom_reentry_time', null);
    }
}

function calculate_reentry_period(frm) {
    if (!frm.doc.required_items || frm.doc.required_items.length === 0) {
        frm.set_value('custom_reentry_period_hrs', 0);
        return;
    }

    let item_codes = [];
    frm.doc.required_items.forEach(function(item) {
        if (item.item_code) {
            item_codes.push(item.item_code);
        }
    });

    if (item_codes.length === 0) {
        frm.set_value('custom_reentry_period_hrs', 0);
        return;
    }

    frappe.call({
        method: 'frappe.client.get_list',
        args: {
            doctype: 'Item',
            filters: {
                'name': ['in', item_codes]
            },
            fields: ['name', 'custom_reentry_interval_hrs']
        },
        callback: function(r) {
            if (r.message) {
                let max_reentry = 0;
                r.message.forEach(function(item) {
                    let reentry_hrs = item.custom_reentry_interval_hrs || 0;
                    reentry_hrs = parseFloat(reentry_hrs);
                    if (reentry_hrs > max_reentry) {
                        max_reentry = reentry_hrs;
                    }
                });
                frm.set_value('custom_reentry_period_hrs', max_reentry);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Hide Start Button On Work Order  (migrated from Client Script fixture, dt=Work Order)
// ---------------------------------------------------------------------------
frappe.ui.form.on("Work Order", {

    refresh(frm) {
        if (frm.doc.custom_type !== "Application Floor Plan") return;

        const removeButtons = () => {
            frm.remove_custom_button("Start");
            frm.remove_custom_button("Finish");
            frm.remove_custom_button("Status");
        };

        removeButtons();
        setTimeout(removeButtons, 100);
        setTimeout(removeButtons, 500);
        setTimeout(removeButtons, 1000);
    }

});
