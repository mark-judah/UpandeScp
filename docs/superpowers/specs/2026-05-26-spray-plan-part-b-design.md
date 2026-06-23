# Spray Plan Part B — Lifecycle Wiring (Approved → Completed)

**Date:** 2026-05-26
**Builds on:** `2026-05-18-spray-plan-creator-workflow-design.md` (Part A) and `2026-05-18-spray-plan-auto-material-issue-design.md`.
**Scope:** Wire the four lifecycle transitions Part A reserved: `Chemical Issued`, `Tank Mix Manufactured`, `Spraying In Progress`, `Completed`. Move Material Issue from "fires on Manufacture submit" to "fires at end of spray session". Introduce the `Spray Application Logsheet` (SAL) as the per-spray record.

## 1 · Goals

1. Stamp every workflow state with a real trigger so operators see meaningful badges.
2. Capture *who scanned what* at the CSU when the tank-mix is prepared (mobile QR scan flow).
3. Treat the Spray Application Logsheet as the source of operational truth for a spray event — created when mixing starts, submitted when spraying ends.
4. Defer stock consumption (Material Issue SE) to the actual end of the spray, not the moment the tank-mix is manufactured, so inventory reflects physical reality.

## 2 · Non-goals

- New mobile UI design. The existing `preview3` per-chemical scan UX stays. We add server endpoints it can call.
- Resolving stuck `Spraying In Progress` work orders (no end-spray ever clicked). Future scheduled-job / GM force-complete.
- Migrating historical (already-completed) Work Orders. Only new AFP WOs travel the new path.
- Cancel / abort paths beyond cascading the existing `stop_single_work_order` into the SAL.
- Hardening the QR payload (still chemical name + qty + uom; WO context comes from mobile navigation).

## 3 · Lifecycle

| State | Trigger | Endpoint / Hook | docstatus | Notes |
|---|---|---|---|---|
| `Approved` | GM approves on Approval page | existing `approve_single_work_order` | 1 | Material Transfer draft SE + QR labels. No change. |
| `Chemical Issued` | Storekeeper submits Material Transfer for Manufacture SE | new `stock_entry_state.on_submit` branch | 1 | WO flipped only; no SAL yet. |
| `Tank Mix Manufactured` | Last chemical scanned at CSU | new `register_csu_scan` endpoint | 1 | Server creates+submits Manufacture SE, creates SAL draft. |
| `Spraying In Progress` | Supervisor taps "Start Spray" | new `start_spray_session` endpoint | 1 | Sprayer Movement Session opened (existing logic), `application_start_time` written to SAL. |
| `Completed` | Supervisor taps "End Spray Session" | new `end_spray_session` endpoint | 1 | Material Issue fired+submitted, SAL submitted (0→1), Sprayer Movement Session closed, `actual_end_date` set. |

## 4 · Data model

### 4.1 New child doctype: `Work Order Chemical Scan`

Hung off `Work Order` via new custom field `custom_chemical_scans` (Table).

| Field | Type | Notes |
|---|---|---|
| `item_code` | Link → Item | The chemical scanned. |
| `scanned_by` | Link → Employee | Resolved from `Employee.user_id`. |
| `scanned_at` | Datetime | Server time. |
| `csu_warehouse` | Link → Warehouse | CSU where the scan happened (mobile sends from app state). |
| `qr_payload` | Small Text | Raw QR string for audit. |
| `gps_lat` / `gps_lon` | Float | Optional, when mobile has GPS. |

Unique on `(parent, item_code)` — re-scans update the existing row.

### 4.2 `Work Order` custom field additions

| Field | Type | Notes |
|---|---|---|
| `custom_chemical_scans` | Table → `Work Order Chemical Scan` | The scan log. |
| `custom_spray_application_logsheet` | Link → Spray Application Logsheet | Back-pointer set at Tank Mix Manufactured. |

### 4.3 `Spray Application Logsheet` — additions and fixture export

The SAL doctype already exists in the DB as a Custom DocType (`custom: 1`) with child tables `Spray Application Pesticide` and `Spray Application Applicator`. Two pieces of work:

1. **Export** all three doctypes (SAL + two child tables) from DB → repo as JSON fixtures so the schema is reproducible.
2. **Add** custom field `work_order` (Link → Work Order, required for new SALs).

Field-by-field mapping at SAL creation (in `register_csu_scan` when last chemical scanned):

| SAL field | Source |
|---|---|
| `work_order` | The WO being scanned. |
| `date` | `wo.custom_scheduled_application_time` (date portion) or today. |
| `farm` | Derived from `wo.custom_greenhouse` (existing `_derive_farm` helper). |
| `crop` | From greenhouse warehouse's variety / Item link. |
| `weather` | From `wo.custom_weather_snapshot` if present, else left blank for supervisor. |
| `mixing_start_time` | Time of first scan in `custom_chemical_scans`. |
| `mixing_stop_time` | Time of last scan (== `now()` at creation). |
| `persons_mixing_1` / `_2` | Distinct `scanned_by` employees (first two by scan order). |
| `target_gh` | `wo.custom_greenhouse`. |
| `target_area_ha` | `wo.custom_area`. |
| `variety` | `wo.custom_variety`. |
| `target_pests` | First entry from `wo.custom_targets` if a Pest. |
| `spray_type` | Map `wo.custom_spray_type` → Full Spray / Spot Spray. |
| `method_of_application` | `CSU` (default, since this path is CSU-based). |
| `re_entry_interval_hrs` | `wo.custom_reentry_period_hrs`. |
| `pesticides` (child) | One row per `wo.required_items` entry. |

Filled later:

| SAL field | When | Source |
|---|---|---|
| `application_start_time`, `start_time` | `start_spray_session` | `now().time()` |
| `application_stop_time`, `end_time` | `end_spray_session` | `now().time()` |
| `applicators` (child) | `end_spray_session` | `wo.custom_spray_plan_team_members` rows, plus any opt-in confirmations captured by mobile. |
| `supervisor_name` | `end_spray_session` | Calling user's Employee. |

## 5 · Endpoint signatures

All three live under `upande_scp/serverscripts/spray_plan_creator/`, all `@frappe.whitelist()`, all take `SELECT … FOR UPDATE` on the WO row.

```
register_csu_scan(work_order, item_code, qr_payload,
                  csu_warehouse, gps_lat=None, gps_lon=None)
  → { workflow_state, all_scanned, scanned: [...],
      manufacture_se?: str, sal?: str }
```

- Upserts a row in `custom_chemical_scans` (idempotent on `(work_order, item_code)`).
- If all required chemicals are now scanned and WO state is `Chemical Issued`:
  - Build Manufacture SE via ERPNext's `make_stock_entry(work_order, purpose='Manufacture')`.
  - Patch zero rates (reuse `_patch_zero_rates`).
  - Insert + submit. The new `stock_entry_state.on_submit` hook handles AFP Manufacture as a no-op for state (state is set explicitly below) but still records the link.
  - Create SAL draft per §4.3 mapping.
  - Set `wo.workflow_state = 'Tank Mix Manufactured'`, write `custom_spray_application_logsheet`.

```
start_spray_session(work_order)
  → { workflow_state, sprayer_movement_session, sal, started_at }
```

- Requires WO state == `Tank Mix Manufactured`.
- Creates the existing `Sprayer Movement Session` doc (`status='Active'`, `started_at=now`, `employee=current`, `greenhouse=wo.custom_greenhouse`).
- Updates SAL `application_start_time` and `start_time`.
- Sets WO state `Spraying In Progress`.

```
end_spray_session(work_order)
  → { workflow_state, material_issue, sal_submitted, ended_at }
```

- Requires WO state == `Spraying In Progress`.
- Updates SAL `application_stop_time`, `end_time`, `supervisor_name`, fills `applicators` from team roster.
- **Fires Material Issue SE** — the existing `build_material_issue` from `auto_material_issue.py` is reused verbatim; only its trigger location changes.
- Submits the SAL (docstatus 0 → 1).
- Closes the Sprayer Movement Session (`status='Completed'`, `ended_at=now`).
- Sets WO `workflow_state='Completed'` and `actual_end_date=now`.

## 6 · Hook changes (`upande_scp/hooks.py`)

Before:

```python
"Stock Entry": {
    "on_submit":
        "upande_scp.serverscripts.spray_plan_creator.auto_material_issue.on_manufacture_submit",
}
```

After:

```python
"Stock Entry": {
    "on_submit":
        "upande_scp.serverscripts.spray_plan_creator.stock_entry_state.on_submit",
}
```

`stock_entry_state.on_submit` dispatches:
- Material Transfer for Manufacture + AFP WO → `workflow_state = 'Chemical Issued'`
- Manufacture + AFP WO → no-op (state is set by `register_csu_scan`)
- Material Issue → no-op (state is set by `end_spray_session`)
- Anything else → no-op

`auto_material_issue.on_manufacture_submit` is renamed / its body lifted into a helper `auto_material_issue.build_and_submit_material_issue(wo)` invoked from `end_spray_session`.

## 7 · Mobile integration

`preview3` already implements per-chemical QR scanning in `app/(tabs)/chemical/plan-details.tsx`. Mobile changes:

1. Per scan → POST `register_csu_scan` (was: local state + eventual `createAndSubmitWorkOrderStockEntry`).
2. Stop calling `createAndSubmitWorkOrderStockEntry` for AFP WOs — server now creates the Manufacture SE.
3. Replace the `finish_work_order_scan` stub with a no-op (or remove); its effect is now achieved by the last `register_csu_scan` returning `all_scanned: true` plus `sal` name.
4. "Start Spray" button → `start_spray_session`.
5. "End Spray Session" button → `end_spray_session`.

## 8 · Error handling and edge cases

- **Re-scan a chemical** → idempotent upsert on `(work_order, item_code)`; updates `scanned_at`.
- **Concurrent last-chemical scans** → `SELECT … FOR UPDATE` serialises; only one path creates the Manufacture SE + SAL.
- **`register_csu_scan` for a WO not in `Chemical Issued`** → return `{ state: <current>, all_scanned: false }`, do not advance. Caller surfaces a friendly toast.
- **Material Issue fails at end-spray** (e.g. negative stock) → whole txn rolls back; WO stays at `Spraying In Progress`; supervisor retries after fixing stock.
- **Mid-flight `stop_single_work_order`** → existing handler is extended to cancel the draft SAL if present.
- **GPS not available on mobile** → `gps_lat` / `gps_lon` left null; not a hard requirement.

## 9 · Testing

- Reuse `test_auto_material_issue.py` fixtures (WO + chemicals + warehouses + cost center).
- New tests:
  - `register_csu_scan`: happy path through three chemicals (last one triggers Manufacture + SAL); idempotent re-scan; race scenario (simulate two concurrent last-scans).
  - `start_spray_session`: state guard, SMS creation, SAL `application_start_time` written.
  - `end_spray_session`: Material Issue submitted, SAL submitted, SMS closed, WO Completed; rollback on insufficient stock.
  - `stock_entry_state.on_submit`: only Material Transfer for Manufacture flips state to `Chemical Issued`.

## 10 · Migration & cutover

- Patch `v15_03_remove_auto_mi_on_manufacture` — no-ops `auto_material_issue.on_manufacture_submit` for any pending Manufacture SE submits during deploy.
- Patch `v15_03_export_sal_fixtures` — writes SAL + child table fixtures into the repo on next migrate (one-time).
- Any in-flight WOs (state in `Approved` / `Chemical Issued`) at deploy time continue to work because the new endpoints accept them.

## 11 · Out-of-scope follow-ups

- GM "force-complete" button for stuck `Spraying In Progress` WOs.
- Reading SAL → Work Order in the Approval page (today the WO is the entry point).
- Mobile UI for confirming team applicators at end-spray (we accept the WO team roster as the default).
- Per-chemical scan UI on the React web app — Part B is mobile-only.
