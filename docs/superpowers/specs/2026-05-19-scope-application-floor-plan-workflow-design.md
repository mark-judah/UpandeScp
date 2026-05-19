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

## Goal

The workflow should only take effect on Work Orders where
`custom_type == "Application Floor Plan"`. All other Work Orders behave
as if no workflow exists.

## Approach

The workflow definition stays unchanged. Per-document, `workflow_state`
is cleared for Work Orders that aren't Application Floor Plans. Frappe's
UI hides workflow badges and actions, and the `allow_edit` role gate is
not applied, when `workflow_state` is empty.

This requires two changes:

1. A `doc_events` hook on `Work Order` that clears `workflow_state` for
   non-spray records before insert and before every validate.
2. A one-off `post_model_sync` patch that clears `workflow_state` for
   existing non-spray Work Orders already in the database.

## Components

### 1. `gate_workflow_state` hook

**Location:** `upande_scp/upande_scp/serverscripts/spray_plan_creator/work_order_workflow_gate.py`

```python
def gate_workflow_state(doc, method=None):
    if (doc.get("custom_type") or "") != "Application Floor Plan":
        doc.workflow_state = None
```

**Wiring** in `upande_scp/hooks.py`, adding a `"Work Order"` entry to
the existing `doc_events` dict:

```python
"Work Order": {
    "before_insert":  "upande_scp.upande_scp.serverscripts.spray_plan_creator.work_order_workflow_gate.gate_workflow_state",
    "before_validate":"upande_scp.upande_scp.serverscripts.spray_plan_creator.work_order_workflow_gate.gate_workflow_state",
},
```

**Why both `before_insert` and `before_validate`:** `before_insert`
prevents Frappe's workflow framework from assigning the default first
state on new docs; `before_validate` covers every subsequent save —
including imports, scripted updates, or future code paths that set
`workflow_state` directly.

### 2. Backfill patch

**Location:** `upande_scp/patches/v1_0/clear_non_spray_work_order_workflow_state.py`

```python
import frappe

def execute():
    frappe.db.sql("""
        UPDATE `tabWork Order`
        SET workflow_state = NULL
        WHERE COALESCE(custom_type, '') != 'Application Floor Plan'
          AND workflow_state IS NOT NULL
    """)
    frappe.db.commit()
```

**Registration** in `upande_scp/patches.txt` under `[post_model_sync]`:

```
upande_scp.patches.v1_0.clear_non_spray_work_order_workflow_state
```

Raw SQL is used instead of `frappe.db.set_value` to avoid bumping
`modified` / `modified_by` on every historical record.

## Out of Scope

- The workflow fixture itself (still `document_type: "Work Order"`).
- Direct `frappe.db.sql` writes or `frappe.db.set_value` calls in
  third-party code — they bypass `doc_events`. The patch covers
  existing rows; future bulk loads should set `custom_type` correctly.
- Restoring `workflow_state` on non-spray Work Orders that historically
  had one set: the user has confirmed clearing them is desired.

## Test Plan

- **New spray-plan WO:** Create a Work Order with
  `custom_type = "Application Floor Plan"`. `workflow_state` becomes
  "Pending Submission"; "Submit for Approval" button appears for the
  Spray Plan Creator role.
- **New non-spray WO:** Create a Work Order with any other
  `custom_type` (or empty). `workflow_state` stays `NULL`; the standard
  Submit button works; no workflow role restriction blocks edits.
- **Migrate:** Run `bench migrate`. Existing non-spray Work Orders that
  had any `workflow_state` are cleared in one statement.
- **Edit a non-spray WO with a stale `workflow_state` set manually:**
  Saving it should clear the state (covered by `before_validate`).
