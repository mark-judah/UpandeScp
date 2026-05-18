# Spray Plan — Auto Material Issue + Access-Sidebar Gating

**Date:** 2026-05-18
**Scope:** Part B-1 of the Spray Plan workflow. When the Manufacture Stock Entry for an Application Floor Plan Work Order is submitted, automatically create *and* submit a Material Issue Stock Entry that consumes the manufactured tank-mix from the greenhouse warehouse. Plus: hide the "Access Control" sidebar entry from users without General Manager / System Manager.

## 1 · Goals

1. Eliminate the manual step of creating a Material Issue after manufacturing — submitting the Manufacture SE atomically issues out the tank-mix in the same transaction.
2. Advance the Work Order workflow from `Tank Mix Manufactured` → `Completed` automatically when auto-issue succeeds.
3. Keep accountability: every auto-issued tank-mix records the spray-team Supervisor as the responsible employee, falling back to the submitting user only when no Supervisor is on the team.
4. Honour per-tank-mix expense accounts configured in `Item Defaults`, with a single configurable fallback.
5. Stop non–General-Managers from seeing the Access Control sidebar entry (server already blocks the route).

## 2 · Non-goals

- A separate "Spraying In Progress" workflow trigger — that state stays defined but unused. It is reserved for a future manual partial-issue flow.
- Biometric verification on the Material Issue — explicitly skipped per design call. `custom_biometric_data` stays empty and `custom_biometric_verified=0`.
- Any new UI for the Material Issue itself — it lands submitted in Desk. The Approval / ApplicationPlan pages don't need to render it.
- Migrating already-submitted Manufacture SEs (no retroactive auto-issue).
- Changing the Material Transfer for Manufacture leg (the existing `approve_single_work_order` flow) — untouched.

## 3 · Trigger + Transaction Model

Hook into `Stock Entry.on_submit` via `hooks.py:doc_events`:

```python
doc_events = {
    # ...existing entries...
    "Stock Entry": {
        "on_submit": "upande_scp.serverscripts.spray_plan_creator.auto_material_issue.on_manufacture_submit",
    },
}
```

Handler signature:

```python
def on_manufacture_submit(doc, method):
    """Stock Entry on_submit. No-op unless this is a Manufacture SE for an
    Application Floor Plan Work Order. On match, create + submit a Material
    Issue SE in the same transaction."""
```

Early-exit rules — the handler returns immediately if any of these are true:

- `doc.purpose != "Manufacture"`.
- `doc.work_order` is empty.
- The linked WO's `custom_type != "Application Floor Plan"`.

On match, the handler:

1. Resolves the supervisor employee (§4.1), the per-item expense accounts (§4.2), the cost center + farm (§4.3).
2. Builds the Material Issue dict (§4.4).
3. `frappe.get_doc(mi_dict).insert(ignore_permissions=True)` then `.submit()`.
4. `frappe.db.set_value("Work Order", doc.work_order, "workflow_state", "Completed", update_modified=True)`.
5. Writes one `add_comment("Workflow", ...)` on the WO summarising the transition and the Material Issue name.

**Atomicity.** All steps run inside the same Frappe request transaction as the Manufacture submit. Any `frappe.throw` rolls back the Manufacture submit too — both succeed or neither does. There is no `try/except` swallowing — the handler must let exceptions bubble.

## 4 · Material Issue Field Derivation

### 4.1 Supervisor Employee

```python
def resolve_supervisor_employee(wo) -> str:
    # 1. First row in WO.custom_spray_plan_team_members where role.strip().lower() == "supervisor".
    #    (role is a free-text Data field, so the comparison is case-insensitive and ignores stray whitespace.)
    # 2. Fallback: tabEmployee WHERE user_id == frappe.session.user (latest by modified).
    # 3. Both missing -> throw "Cannot auto-issue: no Supervisor in spray team and no Employee linked to the submitter."
```

The Supervisor's Employee id is written to a single `Stock Entry.custom_employee_data` child row (doctype `Employee Request`) with these fields populated: `employee`, `employee_name` (fetch_from), `department`, `location`, `farm`. `department` / `location` / `farm` are looked up from the `Employee` record; missing values are left blank — they don't drive any downstream logic.

### 4.2 Per-item Expense Account

For each `is_finished_item=1` row in the Manufacture SE, derive `expense_account` in this order:

1. `tabItem Default` where `parent = item_code AND company = wo.company` → `expense_account` (must be non-empty).
2. `tabSpray Plan Settings.default_chemical_expense_account`.
3. If both are blank → `frappe.throw` with a message that lists both options for the operator to fix.

### 4.3 Cost Center and Farm

- `cost_center` per row = `Work Order.custom_cost_center` (already greenhouse-derived in Part A; throw if blank).
- `custom_farm` on the SE header = `Warehouse.custom_farm` of the greenhouse warehouse (= `Manufacture SE.to_warehouse`). Throw if blank.
- `custom_location` on the SE header = `Manufacture SE.custom_location` if present (no fallback).

### 4.4 Material Issue dict

| MI field | Source |
|---|---|
| `doctype` | `"Stock Entry"` |
| `stock_entry_type` / `purpose` | `"Material Issue"` |
| `company` | `Manufacture SE.company` |
| `posting_date` / `posting_time` | `now_datetime()` |
| `from_warehouse` (header) | `Manufacture SE.to_warehouse` (the greenhouse) |
| `letter_head` | `Manufacture SE.letter_head` |
| `custom_farm` | `Warehouse.custom_farm` of greenhouse |
| `custom_location` | `Manufacture SE.custom_location` if present, else blank |
| `items[*]` | one per FG row in Manufacture SE (`is_finished_item=1`) |
| · `item_code`, `item_name`, `description`, `item_group` | copied |
| · `qty`, `transfer_qty`, `uom`, `stock_uom`, `conversion_factor` | copied |
| · `s_warehouse` | greenhouse warehouse |
| · `expense_account` | resolved per §4.2 |
| · `cost_center` | `WO.custom_cost_center` |
| · `farm` | header `custom_farm` |
| `custom_employee_data[0]` | one row per §4.1 |
| `custom_biometric_data` | empty |
| `custom_biometric_verified` | 0 |

## 5 · Schema Additions

A single new field on the existing `Spray Plan Settings` singleton:

| Field | Type | Required | Notes |
|---|---|---|---|
| `default_chemical_expense_account` | Link → Account | — | Fallback expense account when an Item has no Item Default for the WO's company. Editable by General Manager / System Manager only. |

Added via `custom_field.json` fixture in the existing Spray Plan Settings group. No new doctype, no migration patch.

## 6 · Workflow State Map

The full Application Floor Plan workflow (no schema change in this part):

| State | Trigger |
|---|---|
| `Pending Submission` | Created by Spray Plan Creator (Part A). |
| `Awaiting Approval` | Bulk-submit endpoint (Part A). |
| `Approved` | GM approves on Approval page (Part A). |
| `Chemical Issued` | Submit of Material Transfer for Manufacture SE (existing). |
| `Tank Mix Manufactured` | Submit of Manufacture SE (existing). |
| `Spraying In Progress` | Reserved — no automatic trigger. |
| `Completed` | **New**: set in the same transaction as the auto-Material-Issue submit (this part). |

The transition into `Tank Mix Manufactured` happens first (the existing on-submit logic), then this part's handler overwrites it with `Completed` once the Material Issue submits. If the auto-issue fails, the transaction rolls back — both `workflow_state` and the Manufacture submit revert.

## 7 · Sidebar Gating

`frontend/src/components/AppSidebar.tsx` — the navigation item at:

```ts
{ kind: "view", view: "spray-plan-access", label: "Access Control", icon: ShieldCheck }
```

is wrapped so it's rendered only when the current user holds `General Manager` or `System Manager`. Roles come from the existing user-info bootstrap (the same source `Approvals.tsx` uses for its gate).

No backend change — `upande_scp/serverscripts/spray_plan_creator/admin.py` already 403s.

## 8 · Edge Cases

- Manufacture SE has no `is_finished_item=1` row → throw "Cannot auto-issue: Manufacture has no finished-good row." (rollback).
- No Item Default expense account AND no `Spray Plan Settings.default_chemical_expense_account` → throw with both pieces of remediation guidance (rollback).
- Greenhouse warehouse has no `custom_farm` → throw (rollback).
- `WO.custom_cost_center` blank (shouldn't happen for new Part-A WOs) → throw (rollback).
- Insufficient stock of the tank-mix at the greenhouse → ERPNext's normal "negative stock" `frappe.throw` bubbles up (rollback).
- The Manufacture SE was created manually in Desk (not via the spray-plan flow) but happens to link to an Application-Floor-Plan WO → still triggers. Acceptable: the WO custom_type drives the behavior, not the SE provenance.
- Re-submit of a Manufacture SE is impossible (docstatus already 1) so idempotency is free.
- Manufacture SE whose work_order has `custom_type != "Application Floor Plan"` → handler returns immediately; non-spray manufacturing is unaffected.

## 9 · Testing

### Backend (pytest, `upande_scp/upande_scp/tests/`)

- `test_auto_material_issue_happy.py` — submit a Manufacture SE for a Part-A WO; assert a submitted Material Issue exists with the expected greenhouse, employee, expense account, cost center, farm; WO is at `Completed`.
- `test_auto_material_issue_supervisor_fallback.py` — team has no Supervisor row → falls back to `frappe.session.user`'s Employee.
- `test_auto_material_issue_no_supervisor_no_user_employee.py` — neither resolvable → throw, rollback.
- `test_auto_material_issue_atomic.py` — patch the Item Defaults lookup to return blank and clear the Spray Plan Settings fallback → submit throws, Manufacture stays draft, WO state unchanged.
- `test_auto_material_issue_non_afp_wo.py` — a Manufacture SE linked to a non-Application-Floor-Plan WO → handler is a no-op; no Material Issue created.
- `test_auto_material_issue_expense_account_fallback.py` — Item has no Item Default, Spray Plan Settings fallback set → Material Issue uses the fallback.

### Frontend (Vitest, `frontend/src/`)

- `AppSidebar.test.tsx` — `spray-plan-access` item rendered for users with `General Manager`; hidden for users without it.

### Manual QA checklist

- End-to-end: create a Part-A spray plan → approve → submit the resulting Material Transfer for Manufacture SE → submit the resulting Manufacture SE → verify the Material Issue was auto-submitted and the WO is `Completed`.
- Negative path: create a Part-A WO whose tank-mix Item has no Item Default expense account for the company → unset the Spray Plan Settings fallback → submitting Manufacture must fail with the documented error.
- Sidebar: open `/scp_app` as a user without General Manager — verify "Access Control" is not in the sidebar. As a GM, verify it is.

## 10 · Implementation Plan (high level)

Single plan (no decomposition needed):

1. Add `default_chemical_expense_account` to the `Spray Plan Settings` singleton via `custom_field.json`.
2. New module `upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py` with `on_manufacture_submit`, `resolve_supervisor_employee`, `resolve_expense_account`, `build_material_issue`.
3. Register the `Stock Entry.on_submit` hook in `hooks.py:doc_events`.
4. `AppSidebar.tsx` — wrap the Access Control item in a role check using the existing user-roles source.
5. Tests per §9.

Writing-plans skill will sequence these steps and produce the detailed task list.

## 11 · Open Questions

None. All design calls were made in the brainstorming session:

- Auto-create + auto-submit (no biometric).
- Supervisor → session-user-Employee fallback.
- Item Default → Spray Plan Settings fallback → throw, for expense account.
- Atomic failure handling (rollback the Manufacture submit on any chain error).
- Sidebar entry: simple role-gated render; standalone page stays.
