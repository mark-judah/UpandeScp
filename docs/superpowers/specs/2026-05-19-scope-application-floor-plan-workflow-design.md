# Remove the Application Floor Plan Workflow

## Problem

The "Application Floor Plan Workflow" was bound to the `Work Order`
DocType (see prior `fixtures/workflow.json`). Frappe binds a Workflow
1:1 to a DocType and offers no per-record scoping, so every layer of
Frappe's workflow framework ran on every Work Order — including
unrelated manufacturing orders. Symptoms experienced by users:

- Save blocked by the `allow_edit` role gate inside
  `frappe.model.workflow.validate_workflow`, even though the user
  wasn't a spray-plan participant.
- `WorkflowStateError("Workflow State not set")` thrown by
  `frappe.model.workflow.get_transitions` on form load.
- Most subtly: the client `frappe/public/js/frappe/form/workflow.js`
  re-runs `get_state` on every refresh and, when `workflow_state` is
  empty, calls `frm.set_value(state_field, default_state)` — which
  sets `__unsaved = 1`. The form is permanently dirty; "Not Saved"
  never clears, no matter how many times the user clicks Submit.

Successive attempts to suppress the framework per-record (a
`CustomWorkOrder.validate_workflow` override, a wrapper on the
`get_transitions` whitelisted endpoint, a client-side
`is_read_only` monkey-patch) each addressed one path but left the
others fighting back. Patching symptoms doesn't work because the
client-side state machine assumes a workflow applies to *the
DocType*, not to individual records.

## Goal

Stop running the Frappe Workflow framework against Work Order
entirely. Preserve the spray-plan user experience (submit drafts for
approval, approve, mark completed) which is already implemented in
custom code that drives `workflow_state` directly.

## Approach

Remove the Frappe Workflow record for Work Order. Once
`meta.get_workflow("Work Order")` returns `None`, every server- and
client-side workflow code path short-circuits at the first check:

- `Document.validate_workflow` → no-op (line 689 `if workflow:`).
- `frappe.ui.form.States` constructor → returns early (line 10:
  `if (!this.state_fieldname) return;`).
- `frappe.workflow.is_read_only` → returns `false` (line 70).
- `get_transitions` → never called by the form for this DocType.

The spray-plan "workflow" continues to function because it never
actually used Frappe's framework:

- The **"Submit for Approval" button** is rendered by
  `public/js/spray_plan_wo_form.js`, gated on
  `custom_type === "Application Floor Plan"` and
  `workflow_state === "Pending Submission"`.
- That button calls
  `serverscripts/spray_plan_creator/bulk.py::submit_drafts_for_approval`,
  which transitions `Pending Submission → Awaiting Approval` via raw
  SQL.
- Approval is driven by
  `serverscripts/spray_plan_approval.py::approve_plan`, which calls
  `frappe.db.set_value("Work Order", name, "workflow_state",
  "Approved")`.
- `auto_material_issue.py` sets `workflow_state = "Completed"` after
  the Material Issue is posted.

A grep across `upande_scp` confirmed there are zero callsites of
`apply_workflow` or any other `frappe.model.workflow` function —
nothing depends on the Workflow framework.

## Components

### 1. Delete the Workflow fixture

`upande_scp/upande_scp/fixtures/workflow.json` is removed. The
sibling fixtures (`workflow_state.json`, `workflow_action_master.json`)
stay — they define the state and action records that the custom
field on Work Order references.

### 2. Backfill patch: delete the Workflow record

**Location:** `upande_scp/patches/v1_0/delete_application_floor_plan_workflow.py`

```python
import frappe

def execute():
    name = "Application Floor Plan Workflow"
    if not frappe.db.exists("Workflow", name):
        return
    frappe.delete_doc("Workflow", name, force=True, ignore_missing=True)
    frappe.db.commit()
    # DocType meta caches the workflow association; without an
    # explicit invalidation the next save raises
    # "Workflow Application Floor Plan Workflow not found".
    frappe.clear_cache(doctype="Work Order")
```

Registered in `patches.txt` under `[post_model_sync]`.

### 3. Remove the now-dead overrides

- `upande_scp/serverscripts/spray_plan_creator/custom_work_order.py` — deleted.
- `upande_scp/serverscripts/spray_plan_creator/workflow_transitions.py` — deleted.
- `upande_scp/hooks.py` — removed the `override_doctype_class` and
  `override_whitelisted_methods` entries.
- `upande_scp/public/js/spray_plan_wo_form.js` — removed the
  `frappe.workflow.is_read_only` monkey-patch (the "Submit for
  Approval" button block is kept).

The prior backfill patch
`clear_non_spray_work_order_workflow_state.py` stays — it's
idempotent and harmless. It cleared the 717 leaked workflow_state
values that the broken framework set on non-spray WOs.

## Out of Scope

- The `workflow_state` Custom Field on Work Order (Link → Workflow
  State) stays. It now functions as a plain status field on Work
  Order, written and read only by spray-plan custom code.
- The `tabWorkflow State` records stay — they're the linked values.
- The `allow_edit` role gate the Workflow used to enforce
  (e.g. "only General Manager can edit an Approved spray plan") is
  not re-implemented. The spray-plan endpoints in `bulk.py`,
  `spray_plan_approval.py`, and `drafts.py` already validate role
  and scope on the transitions that matter. If finer-grained
  field-level gating is needed later, add a `before_save` hook
  scoped to Work Orders where `custom_type == "Application Floor
  Plan"`.

## Test Plan

- **Workflow gone:** `meta.get_workflow("Work Order")` returns
  `None`; `frappe.db.exists("Workflow", "Application Floor Plan
  Workflow")` returns `False`.
- **Non-spray WO save:** A draft non-spray WO saves cleanly
  (`workflow_state` stays `None`, no role gate, no
  `WorkflowStateError`).
- **Spray-plan submit:** A draft Application Floor Plan WO at
  `Pending Submission` transitions to `Awaiting Approval` and
  `docstatus = 1` via the existing
  `bulk.submit_drafts_for_approval` endpoint.
- **Form behaviour (browser):** Open a non-spray WO — no workflow
  badge, no "Not Saved" loop, normal Save/Submit work. Open a
  spray-plan WO at `Pending Submission` — the custom "Submit for
  Approval" button still appears and still posts to the bulk
  endpoint.
