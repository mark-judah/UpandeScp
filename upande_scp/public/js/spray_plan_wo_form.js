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

// Neutralise the client-side workflow read-only check for non-spray Work
// Orders. The Application Floor Plan Workflow is bound to Work Order, but
// CustomWorkOrder makes it inert server-side for records where
// custom_type != "Application Floor Plan". Without this patch the client's
// `frappe.workflow.is_read_only` falls back to the workflow's *default*
// state whenever `workflow_state` is empty, then applies that state's
// `allow_edit` role gate — leaving the form effectively read-only and
// stuck on "Not Saved" for users who lack Spray Plan Creator / General
// Manager.
(function () {
    if (!frappe.workflow || frappe.workflow.__upande_scp_patched) return;
    frappe.workflow.__upande_scp_patched = true;
    const orig_is_read_only = frappe.workflow.is_read_only;
    frappe.workflow.is_read_only = function (doctype, name) {
        if (doctype === "Work Order") {
            const doc = locals[doctype] && locals[doctype][name];
            if (doc && doc.custom_type !== "Application Floor Plan") {
                return false;
            }
        }
        return orig_is_read_only.call(this, doctype, name);
    };
})();

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
