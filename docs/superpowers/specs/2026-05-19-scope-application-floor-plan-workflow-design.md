# Scope the Application Floor Plan Workflow to Spray-Plan Work Orders

## Problem

The "Application Floor Plan Workflow" (defined in
`upande_scp/upande_scp/fixtures/workflow.json`) is bound to
`document_type: "Work Order"`. Frappe binds a Workflow 1:1 to a DocType
and offers no native condition / filter, so the workflow's default state
("Pending Submission"), role-based `allow_edit` constraints, and
transition actions ("Submit for Approval", "Approve Plan") currently
apply to **every** Work Order — including unrelated manufacturing
orders. Spray-plan Work Orders are distinguished by the custom field
`custom_type == "Application Floor Plan"`.

The most visible symptom is that users without the "Spray Plan Creator"
or "General Manager" roles (e.g. Production Managers) can't save
non-spray Work Orders, because the workflow's `allow_edit` role gate
refuses the save while the WO sits in "Pending Submission".

## Goal

The workflow should only take effect on Work Orders where
`custom_type == "Application Floor Plan"`. All other Work Orders behave
as if no workflow exists.

## Approach

The workflow definition stays unchanged. We override the `Work Order`
controller class via `override_doctype_class` and replace
`validate_workflow` so it no-ops for non-spray Work Orders (and clears
any leftover `workflow_state` in the same call). The whole workflow
framework — default-state setter, `allow_edit` role gate, transition
check inside `frappe.model.workflow.validate_workflow` — is therefore
bypassed on those records.

We also add a one-off `post_model_sync` patch that clears
`workflow_state` on existing non-spray Work Orders in bulk, so historic
records normalise immediately rather than only on their next save.

### Why not `doc_events` (`before_validate` / `before_save`)?

`frappe.model.workflow.validate_workflow` (called from
`Document._validate` → `Document.validate_workflow`) re-applies
`workflow.states[0].state` whenever the field is empty. The lifecycle
runs `before_validate → validate (re-defaults) → before_save`, so:

- `before_validate` clears the field, then `validate_workflow` puts it
  right back.
- `before_save` runs after the re-defaulting, but by then the role gate
  inside `validate_workflow` has already thrown for unprivileged users
  — so the save never reaches `before_save`.

Overriding the controller method is the only point that sits *above*
the workflow framework's own defaulting and role gate.

## Components

### 1. `CustomWorkOrder` subclass

**Location:** `upande_scp/upande_scp/serverscripts/spray_plan_creator/custom_work_order.py`

```python
from erpnext.manufacturing.doctype.work_order.work_order import WorkOrder


class CustomWorkOrder(WorkOrder):
    def validate_workflow(self):
        if (self.get("custom_type") or "") != "Application Floor Plan":
            self.workflow_state = None
            return
        return super().validate_workflow()
```

**Wiring** in `upande_scp/hooks.py`:

```python
override_doctype_class = {
    "Work Order": "upande_scp.serverscripts.spray_plan_creator.custom_work_order.CustomWorkOrder",
}
```

ERPNext's `WorkOrder.validate` and every other method are inherited
untouched.

### 2. `get_transitions` override

**Location:** `upande_scp/upande_scp/serverscripts/spray_plan_creator/workflow_transitions.py`

```python
import frappe
from frappe.model.workflow import get_transitions as _orig_get_transitions

@frappe.whitelist()
def get_transitions(doc, workflow=None, raise_exception=False):
    if hasattr(doc, "doctype"):
        doctype = doc.doctype
        custom_type = doc.get("custom_type") or ""
    else:
        d = frappe.parse_json(doc) if isinstance(doc, str) else doc
        doctype = d.get("doctype") if isinstance(d, dict) else None
        custom_type = (d.get("custom_type") or "") if isinstance(d, dict) else ""
    if doctype == "Work Order" and custom_type != "Application Floor Plan":
        return []
    return _orig_get_transitions(doc, workflow=workflow, raise_exception=raise_exception)
```

**Wiring** in `upande_scp/hooks.py`:

```python
override_whitelisted_methods = {
    "frappe.model.workflow.get_transitions": "upande_scp.serverscripts.spray_plan_creator.workflow_transitions.get_transitions",
}
```

**Why this is needed:** `frappe/model/workflow.py::get_transitions`
is a whitelisted endpoint the form's workflow widget calls on every
refresh. It throws `WorkflowStateError("Workflow State not set")` when
`current_state` is empty. Since `CustomWorkOrder.validate_workflow`
clears the state for non-spray WOs (and the backfill patch did the
same for historical rows), the widget surfaces the error to the user
unless we intercept the endpoint.

### 3. Client-side `is_read_only` override

**Location:** `upande_scp/upande_scp/public/js/spray_plan_wo_form.js`
(top of file — loads via the existing `doctype_js` hook for Work Order)

```javascript
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
```

**Why this is needed:** the form's read-only check in
`frappe/public/js/frappe/model/workflow.js::is_read_only` falls back to
`get_default_state(doctype, doc.docstatus)` when `doc.workflow_state` is
empty, then enforces that state's `allow_edit` role gate. With the
server now clearing `workflow_state` on every non-spray WO, the client
would render those forms read-only for any user without the Spray Plan
Creator / General Manager roles — manifesting as a "Not Saved" status
that never clears even after repeated Submit clicks. The patch
short-circuits the check to `false` (editable) for non-spray Work
Orders only; everything else delegates to the original.

### 4. Backfill patch

**Location:** `upande_scp/patches/v1_0/clear_non_spray_work_order_workflow_state.py`

```python
import frappe

def execute():
    if not frappe.db.has_column("Work Order", "custom_type"):
        return
    frappe.db.sql("""
        UPDATE `tabWork Order`
        SET workflow_state = NULL
        WHERE COALESCE(custom_type, '') != 'Application Floor Plan'
          AND workflow_state IS NOT NULL
    """)
    frappe.db.commit()
```

Registered in `upande_scp/patches.txt` under `[post_model_sync]`:

```
upande_scp.patches.v1_0.clear_non_spray_work_order_workflow_state
```

Raw SQL avoids bumping `modified` / `modified_by` on every historical
record. Idempotent.

## Out of Scope

- The workflow fixture itself (still `document_type: "Work Order"`).
- Other apps that may want to override Work Order's class — they would
  need to subclass `CustomWorkOrder` instead of `WorkOrder` directly.
  No installed app does so today.

## Test Plan

- **New spray-plan WO:** Create a Work Order with
  `custom_type = "Application Floor Plan"`. `workflow_state` becomes
  "Pending Submission"; "Submit for Approval" button appears for the
  Spray Plan Creator role.
- **New non-spray WO:** Create a Work Order with any other
  `custom_type` (or empty). `workflow_state` stays `NULL`; the standard
  Submit button works; no workflow role restriction blocks edits — in
  particular, a user without "Spray Plan Creator" / "General Manager"
  can save the WO.
- **Migrate:** Run `bench migrate`. Existing non-spray Work Orders that
  had any `workflow_state` are cleared in one statement.
- **Edit a non-spray WO with a stale `workflow_state` set manually:**
  Saving it should clear the state (covered by the overridden
  `validate_workflow`).
