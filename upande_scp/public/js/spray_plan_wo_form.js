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
