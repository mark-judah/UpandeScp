# Spray Plan Creator Workflow — Part A Design

**Date:** 2026-05-18
**Scope:** Part A of the larger Scouting → Transfer → Issue → Move-Out workflow. This part covers the *creation* of spray plans (Application Floor Plan Work Orders) under a strict role + farm-scoped flow, and the *first* approval state. Parts B and C (chemical transfer, manufacture, material issue, in-progress / completed transitions) are out of scope here but reflected as reserved Workflow states.

## 1 · Goals

1. Restrict the spray-plan creation page to users holding a dedicated `Spray Plan Creator` role, scoped to specific Farm(s) assigned by a General Manager.
2. Replace the page's "create, redirect to Desk" pattern with a *batch* model — a creator builds several draft plans in one session and submits them all for approval together, race-free.
3. Add an explicit per-Work-Order workflow with seven named states; wire the first three transitions (Pending Submission → Awaiting Approval → Approved) in this part.
4. Surface chemical rates and IRAC/FRAC resistance-rotation warnings on the existing Approval page so GMs see them at the point of decision.
5. Add a non-blocking weather-forecast advisory to the planning page using farm latitude/longitude from the existing rose-mapping settings.
6. Eliminate accidental tank-mix proliferation — the page can no longer create new BOMs; rate edits stay on the Work Order.

## 2 · Non-goals

- Workflow transitions for `Chemical Issued`, `Tank Mix Manufactured`, `Spraying In Progress`, `Completed`. These states are *defined* now (so the field is complete) but their triggers ship in Parts B/C.
- A `Rejected` workflow state. Rejection re-uses the existing `stop_single_work_order` (cancel, docstatus=2).
- Hard-blocking enforcement of IRAC/FRAC violations. Warnings are advisory in this part; a future per-code `block` severity is reserved in `Spray Plan Settings`.
- Migrating historical Work Orders to the new workflow. The workflow applies only to *new* `custom_type='Application Floor Plan'` WOs.
- Replacing the existing TankMixes admin page — it remains the canonical place to author Chemical Mix BOMs.

## 3 · Data Model & Roles

### 3.1 Roles

**New role: `Spray Plan Creator`** (fixture).

- Read: `Warehouse`, `Farm`, `BOM`, `BOM Item`, `Spray Team`, `Spray Team Details`, `Item`, `Pest`, `Disease`, `Scouting Entry`, `Spray Kit`, `Cost Center`.
- Create / Read / Write on `Work Order`, filtered to docs they own (`owner = frappe.session.user`) AND `workflow_state = 'Pending Submission'`.
- Cannot Submit Work Orders directly — submission goes through the bulk endpoint.
- Read on own `Spray Plan Creator` activity log and own `Has Role` row.

`General Manager` and `System Manager` retain full access. They remain the only roles that can manage the Farm-assignment admin page and the Approval page.

### 3.2 New child doctype: `Farm Spray Plan Creator`

| Field | Type | Required | Notes |
|---|---|---|---|
| `user` | Link → User | Yes | Admin UI filters candidates to enabled users who hold `Spray Plan Creator`. |

Hung as a child table on `Farm` via a new custom field `Farm.spray_plan_creators`. Used by both the admin page (GM edits per-farm rosters) and `_resolve_user_scope` (server reverses the lookup to find a user's farms).

### 3.3 Warehouse — no schema change

CSUs are ordinary warehouses with `custom_farm` already populated. We do not add a `custom_is_csu` flag. CSU enumeration, wherever required, is performed by querying the distinct set of `Warehouse` names referenced by `Spray Kit.warehouse`.

### 3.4 Spray Team — add Farm link

New custom field `Spray Team.custom_farm` (Link → Farm, required). Backfilled via patch `v15_01_backfill_spray_team_farm` which infers the farm from each team's most-used Work Order's greenhouse-farm. Ambiguous teams (split history across farms) are written to a `_unassigned_spray_teams.csv` report file and the GM is required to clean them up before they can be used in the new flow.

### 3.5 Work Order — new custom fields

> Note: `workflow_state` is not listed below because Frappe Workflow auto-injects it (as a hidden Link → Workflow State) when the `Application Floor Plan Workflow` (§3.7) is created. No manual custom-field row is needed. For WOs of any other `custom_type` the field stays empty.

| Field | Type | Required | Notes |
|---|---|---|---|
| `custom_classification` | Select (`Curative`, `Preventive`) | `mandatory_depends_on: eval:doc.custom_type=='Application Floor Plan'` | Replaces the implicit "all spray plans are curative" assumption. |
| `custom_preventive_reason` | Long Text | `mandatory_depends_on: eval:doc.custom_classification=='Preventive'` | Min 20 chars enforced server-side; the frontend enforces the same threshold on `Add to batch`. |
| `custom_cost_center` | Link → Cost Center | `mandatory_depends_on: eval:doc.custom_type=='Application Floor Plan'` | Auto-derived at creation by exact name match against the greenhouse warehouse. Errors out if no matching Cost Center exists. Propagates to all downstream Stock Entries. |
| `custom_rate_overridden` | Check | — | Set when any `required_items.required_qty` differs from the underlying BOM's `custom_application_rate`. Audit flag only. |
| `custom_weather_snapshot` | Long Text (JSON) | — | Captured at submit time. Read-only on the Approval page. |
| `custom_spray_plan_team_members` | Table (child) | — | Per-plan team roster snapshot (employee + role rows). Coexists with the existing denormalized `custom_spray_team` text field. |

### 3.6 Item — IRAC / FRAC codes

If not already present, add via fixture:

- `Item.custom_irac_code` (Data) — insecticide MoA group, e.g. `4A`.
- `Item.custom_frac_code` (Data) — fungicide MoA group, e.g. `11`.

An Item carries one, the other, or neither (adjuvants/biostimulants blank).

### 3.7 Frappe Workflow: `Application Floor Plan Workflow`

Added as a `Workflow` doctype targeting `Work Order` with `is_active=1`. Adds a `workflow_state` Link field to the doctype.

| State | docstatus | Trigger | Wired in |
|---|---|---|---|
| `Pending Submission` | 0 | Set on creation by Spray Plan Creator | Part A |
| `Awaiting Approval` | 1 | Bulk-submit endpoint (creator action) | Part A |
| `Approved` | 1 | GM approves on Approval page (also creates draft Material Transfer for Manufacture SE — existing logic) | Part A |
| `Chemical Issued` | 1 | On submit of Material Transfer for Manufacture SE (Chemical Store → CSU/WIP) | Part B |
| `Tank Mix Manufactured` | 1 | On submit of Manufacture SE | Part B |
| `Spraying In Progress` | 1 | Manual trigger by spray supervisor | Part B/C |
| `Completed` | 1 | On submit of Material Issue SE (consumes the tank mix, cost booked to `custom_cost_center`) | Part B/C |

Transitions wired in Part A:
- `Pending Submission → Awaiting Approval` — role `Spray Plan Creator` (also the doc owner).
- `Awaiting Approval → Approved` — role `General Manager`.

The workflow only governs WOs where `custom_type='Application Floor Plan'`. Other WOs leave `workflow_state` empty and behave as Frappe's stock manufacturing workflow dictates.

### 3.8 Singleton: `Spray Plan Settings`

A Singleton doctype to hold operator-tunable thresholds:

| Field | Default | Notes |
|---|---|---|
| `irac_rotation_window_days` | 14 | IRAC repeat-use warning window. |
| `frac_rotation_window_days` | 21 | FRAC repeat-use warning window. |
| `weather_wind_green_max_kmh` | 10 | Above this, traffic-light goes yellow. |
| `weather_wind_red_min_kmh` | 15 | Above this, red. |
| `weather_rain_green_max_pct` | 20 | |
| `weather_rain_red_min_pct` | 50 | |
| `weather_temp_green_min_c` | 10 | |
| `weather_temp_green_max_c` | 28 | |
| `weather_temp_red_max_c` | 32 | |
| `weather_temp_red_min_c` | 8 | |

Editable by General Manager / System Manager.

### 3.9 Removed behavior

- Server-side dynamic-BOM creation in `create_application_work_order.py` (lines 132-156). Rate overrides land only on `required_items.required_qty`. If any rate differs from the BOM, `custom_rate_overridden` is set for audit.
- The legacy `createApplicationWorkOrder` endpoint remains callable for one release as a transition aid, then is removed in A3.
- The frontend "New BOM" dialog (and `createBom` lib call) are removed from `ApplicationPlan.tsx`. Authoring tank mixes goes through the existing TankMixes page.

## 4 · Admin Page — Farm Assignments

### 4.1 Route & gating

`/scp_app#/spray-plan-access`. Gated to `General Manager` + `System Manager` using the same role-aware redirect pattern as the existing Approvals page. Spray Plan Creators get a full-page `<AccessDenied />` panel on entry.

### 4.2 Layout

Single screen, no nested routes. A table-list with one row per Farm:

| Farm | Business Unit | Spray Plan Creators | Actions |
|---|---|---|---|
| Kaptumbo | Roses | `abraham@…` · `otieno@…` · `+ Add` | Save / Revert |

Each row's "Spray Plan Creators" cell is an inline-editable multi-user chip picker:
- `+ Add` opens a server-side typeahead filtered to enabled users holding the `Spray Plan Creator` role. Users without the role never appear.
- Chips have an `×` to remove.
- Edits stay local until the row's `Save` (or the page-level `Save all`) is clicked. Unsaved rows are visually marked.

A small header banner summarises `N farms · M creators`.

### 4.3 Backend endpoints (whitelisted)

- `list_farms_with_creators()` → `[{farm, business_unit, creators: [{user, full_name}]}]`. Reads `Farm.spray_plan_creators` child rows.
- `list_spray_plan_creator_candidates(q?: string)` → `[{user, full_name, email}]`. Joins `tabUser` and `tabHas Role` on `role='Spray Plan Creator'`, `enabled=1`, optional `LIKE` match on name/email.
- `set_farm_creators(farm: str, users: list[str])` → idempotent replace of the child table. Permission-guarded to General Manager / System Manager. Returns the resulting `creators` array for client reconciliation.

### 4.4 Edge cases

- A user has the role but is unassigned to any farm → on entering `ApplicationPlan`, sees an empty-state banner "You're not assigned to a farm yet — ask a General Manager".
- A GM removes a user mid-session → that user's next scope-aware API call returns an empty farms list and the page shows the same empty-state. In-flight drafts remain in the DB (the next bulk-submit silently skips drafts on inaccessible farms and toasts a warning).
- Removing a creator from a farm does NOT delete their existing Draft WOs. It only stops them creating new ones on that farm.

### 4.5 Out of scope for this page

Granting or revoking the `Spray Plan Creator` role itself. That is a normal Frappe User-admin task done in Desk by sysadmins. This page only manages per-farm assignments for users who already have the role.

## 5 · Backend Endpoints

All endpoints live in `upande_scp.serverscripts.spray_plan_creator` (new module). Gated by `Spray Plan Creator` role unless noted.

### 5.1 Scope resolution

```python
def _resolve_user_scope(user: str) -> dict:
    """Return the calling user's allowed farms, warehouses, and greenhouses."""
```

- `farms` = parents of `Farm Spray Plan Creator` rows where `user=<user>`.
- `warehouses` = all `Warehouse` where `custom_farm IN farms` AND `disabled=0`.
- `greenhouses` = subset of `warehouses` with `warehouse_type='Greenhouse'`.

Single source of truth — every other endpoint passes its filters through this helper.

### 5.2 Bootstrap

`fetch_creator_bootstrap()` — replaces today's `fetchApplicationPlanBootstrap` for the new page. Returns the full scope + filtered lookup data in one round-trip:

```ts
{
  scope: { farms: Farm[], allowed_warehouses: Warehouse[] },
  greenhouses: { name, custom_farm, latitude?, longitude? }[],
  kits: { kit, warehouse, custom_farm }[],
  spray_teams: { name, custom_farm, members: { employee, employee_name, role }[] }[],
  tank_mixes: { name, item_name, custom_farm }[],   // BOMs with item_group='Chemical Mix' in scope
  rate_limits: Record<item_code, { lower: number|null, upper: number|null }>,
  pest_catalog: { name }[],
  disease_catalog: { name }[],
  weather_settings: WeatherThresholds,             // from Spray Plan Settings
  irac_window_days: number,
  frac_window_days: number,
}
```

Latitude/longitude on each greenhouse are joined from the existing rose-mapping settings doctype (the same source the RoseScouting and Heatmaps pages already use).

### 5.3 Draft Work Order endpoints

#### `create_draft_spray_plan(payload)`

Replaces `createApplicationWorkOrder` for new flow. Steps:

1. Re-run `_resolve_user_scope` and assert every reference (`custom_greenhouse`, `kit`, `spray_team`, `bom`) is inside scope. The frontend is not trusted.
2. Resolve `custom_cost_center` by exact-name match on the greenhouse warehouse. Error if missing.
3. Validate every chemical's rate against `Item.custom_lower_rate_limit` / `custom_upper_rate_limit` (re-use existing helper).
4. If `classification='Preventive'` → assert `custom_preventive_reason` is non-empty and ≥ 20 chars.
5. Resolve targets:
   - `Curative` → every target must have been observed in the chosen greenhouse in the last 60 days.
   - `Preventive` → every target must exist in `Pest` or `Disease`.
6. Validate `production_item` (BOM) is an active Chemical Mix BOM in scope.
7. Create the `Work Order` with `docstatus=0`, `workflow_state='Pending Submission'`, `owner=user`, custom fields populated, `required_items` populated from the BOM with user-overridden rates. Set `custom_rate_overridden=1` if any rate differs.
8. Return `{work_order: name, summary: {...}}`.

No dynamic BOM is ever created.

#### `list_my_draft_plans()`

Returns the calling user's drafts (`owner=user`, `workflow_state='Pending Submission'`, `custom_type='Application Floor Plan'`) with a compact summary per row: `{name, greenhouse, classification, targets, scheduled_date, chemical_count, total_water_volume, has_warnings}`. Powers the right-column "Draft batch" panel.

#### `get_draft_plan(name)`

Full record for inline editing. Returns the same shape as the `create_draft_spray_plan` input plus resolved cost center / WIP / FG warehouses. Guarded to owner.

#### `update_draft_plan(name, payload)`

Same validation as `create_draft_spray_plan`, applied to an existing `Pending Submission` draft. Rejects WOs past `Pending Submission`. Guarded to owner.

#### `delete_draft_plan(name)`

Deletes the draft (`docstatus=0` only). Used by the "remove from batch" action. Guarded to owner.

### 5.4 Atomic bulk-submit (the race-killer)

`submit_drafts_for_approval(wo_names: list[str])` — race-free transition.

```python
@frappe.whitelist()
def submit_drafts_for_approval(wo_names: list[str]) -> dict:
    user = frappe.session.user
    if not wo_names: frappe.throw("No drafts to submit.")
    scope = _resolve_user_scope(user)
    if not scope["farms"]: frappe.throw("Not assigned to any farm.")

    submitted, skipped = [], []
    try:
        frappe.db.begin()
        for name in wo_names:
            row = frappe.db.sql(
                """SELECT name, docstatus, workflow_state, owner, custom_greenhouse
                   FROM `tabWork Order` WHERE name=%s FOR UPDATE""",
                name, as_dict=True,
            )
            if not row:
                skipped.append({"name": name, "reason": "missing"}); continue
            row = row[0]
            if row.owner != user:
                skipped.append({"name": name, "reason": "not owner"}); continue
            if row.docstatus != 0 or row.workflow_state != "Pending Submission":
                skipped.append({"name": name, "reason": "already submitted"}); continue
            gh_farm = frappe.db.get_value("Warehouse", row.custom_greenhouse, "custom_farm")
            if gh_farm not in scope["farms"]:
                skipped.append({"name": name, "reason": "lost farm access"}); continue
            _validate_draft(name)
            wo = frappe.get_doc("Work Order", name)
            wo.submit()
            wo.db_set("workflow_state", "Awaiting Approval", update_modified=True)
            submitted.append(name)
        frappe.db.commit()
    except Exception:
        frappe.db.rollback()
        raise
    return {"submitted": submitted, "skipped": skipped}
```

Race-safety properties:

1. `SELECT … FOR UPDATE` per row serialises concurrent submits over overlapping `wo_names` sets.
2. The state guard is checked *after* the lock, so a draft another transaction already submitted is skipped, never double-submitted.
3. Whole batch is one DB transaction; partial-failure rolls everything back, the user retries.
4. Idempotent at the list level — re-submitting the same `wo_names` just skips already-submitted ones.

### 5.5 Approval-page endpoints

#### Existing endpoints

`get_pending_work_orders` filter changes from `status='Not Started'` to `workflow_state='Awaiting Approval'`. Otherwise unchanged.

`approve_single_work_order` adds one line after the existing draft Material Transfer SE creation: `wo.db_set('workflow_state', 'Approved')` plus an audit Comment (§5.7).

`stop_single_work_order` unchanged. Rejection is still "cancel the WO" (docstatus=2); no `Rejected` workflow state needed.

#### New endpoint: `approve_drafts_bulk(wo_names: list[str])`

Mirrors `submit_drafts_for_approval` — `SELECT … FOR UPDATE` + state-guard (`workflow_state='Awaiting Approval'`) + single transaction. For each WO, creates the draft Material Transfer SE (existing logic) and sets `workflow_state='Approved'`. All-or-nothing per batch.

#### New endpoint: `get_approval_review(wo_name)`

Returns the per-chemical data the Approval page card needs:

```ts
{
  work_order: {
    name, greenhouse, scheduled_date, classification,
    preventive_reason?, weather_snapshot?, team_members: {...}[],
    targets: string[]
  },
  chemicals: [{
    item_code, item_name,
    application_rate, stock_uom,
    rate_limits: { lower, upper } | null,
    rate_status: 'ok' | 'below' | 'above',
    irac_code: string | null,
    frac_code: string | null,
    resistance_warnings: [{
      kind: 'irac' | 'frac',
      code: string,
      message: string,
      severity: 'warning' | 'block',
      prior_wo: string,
      days_ago: number
    }],
  }],
  plan_warnings: string[]
}
```

Re-used by the ApplicationPlan page as a live advisory while the creator edits rates/chemicals.

### 5.6 Violation rule

For each chemical with `custom_irac_code` (or `custom_frac_code`) set, find the most recent prior Approved Work Order on the same `custom_greenhouse` where any `required_items` row references an Item with the same code AND the WO's `custom_scheduled_application_time` is within the rotation window (`Spray Plan Settings.irac_rotation_window_days` / `frac_rotation_window_days`). If found → warning chip on the chemical, count rolled up into the plan-level banner.

Severity defaults to `warning` (red chip, does not block approval). A future per-code policy field on `Spray Plan Settings` may emit `block`; the contract is in place but unused in this part.

### 5.7 Logging & audit

- Every workflow transition writes a Comment to the WO via `frappe.get_doc("Work Order", name).add_comment(...)` with: actor, prior state, new state, and (on Approved) a summary of IRAC/FRAC warnings present at approval time.
- Bulk operations write one Comment per affected WO plus a single Activity Log entry at the batch level for the operator's session audit.
- `custom_weather_snapshot` JSON preserves the forecast the planner saw at submit time, surfaced read-only on the Approval card.

## 6 · Frontend — `ApplicationPlan.tsx` Rewrite

### 6.1 Gate

On mount, call `fetch_creator_bootstrap()`. If `403` (no `Spray Plan Creator` role) → `<AccessDenied />`. If `scope.farms.length === 0` → empty-state banner "You're not assigned to a farm yet — ask a General Manager".

### 6.2 Scope chip

A static strip below the page title:

```
Farm: [Kaptumbo ▾]   |   12 greenhouses · 3 CSUs · 2 spray teams · 4 tank mixes
```

Read-only if the user has one farm; a switcher if multiple. Changing farms clears the in-progress form (with a confirmation toast if dirty).

### 6.3 Three-column layout

| Left — Diagnose + Weather | Centre — Plan Form | Right — Draft Batch |
|---|---|---|
| Heatmap (existing) | Classification radio | Card per draft WO |
| Filters (existing) | Targets picker (gated) | Edit / Remove |
| Weather snapshot | Spray details | `Submit all for approval` |
| 24-h weather strip | Tank mix + rate table | |
| | Spray team + roster | |
| | Validation panel | |
| | `Add to batch` | |

### 6.4 Weather forecast (left column)

- Hook `useWeatherForecast(latitude, longitude, scheduledAt)` calls **Open-Meteo** (`https://api.open-meteo.com/v1/forecast`) with `hourly=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m&forecast_days=3` on greenhouse-select. Lat/long sourced from the existing rose-mapping settings via the bootstrap.
- Cached in IndexedDB for 30 minutes keyed by `${lat},${lon}`.
- Open-Meteo is "free for non-commercial use"; flag in the implementation plan for the team to confirm licence fit before commercial roll-out. The hook is abstracted behind a `WeatherProvider` interface so we can swap to WeatherAPI.com / OpenWeatherMap behind the same surface.
- Snapshot card for `custom_scheduled_application_time ± 1h`: four chips (🌡 temp, 💧 humidity, 💨 wind, 🌧 precip) with traffic-light colouring per the thresholds in `Spray Plan Settings`. Humidity is informational only.
- 24-hour strip is a small bar chart of hourly wind + precip; clicking an hour sets `custom_scheduled_application_time` to that hour.
- Weather is **advisory** — failing or missing data never blocks plan creation. Offline / errored → "Weather unavailable" placeholder.
- On `Add to batch`, the current snapshot JSON is sent to the backend and stored on `custom_weather_snapshot`.

### 6.5 Plan form (centre column)

Sequence reflects the workflow:

1. **Classification radio** — `Curative` / `Preventive`. Default unselected (forces the choice).
2. **Targets**:
   - Curative → multi-select chips sourced from observations in the last 60 days on the chosen greenhouse. **None pre-selected** (drift from today's "auto-select all observed" behaviour).
   - Preventive → multi-select from full Pest + Disease catalogues + a required `Preventive Reason` textarea (min 20 chars).
3. **Spray details** — scheduled date/time, spray type, scope (Full / Variety / Beds), kit (filtered to user's farm), greenhouse (filtered to user's farm), variety / bed selectors (driven by scope).
4. **Tank mix + rates** — BOM dropdown (Chemical Mix BOMs in farm scope only). On select, fetch BOM details and render the chemical table with per-row rate input + IRAC/FRAC chip + inline rate-limit warning (existing) + inline resistance warning (debounced `get_approval_review` call). **No "New BOM" button.**
5. **Spray team** — team dropdown (farm-filtered). Members render as a chip row; `Add member` opens an Employee typeahead; chips have an `×`. Edits scoped to this WO via `custom_spray_plan_team_members`.
6. **Validation panel** — sticky panel listing every unmet requirement (red) and warning (amber). `Add to batch` disabled until red list is empty.
7. **`Add to batch`** — calls `create_draft_spray_plan`; optimistic-inserts into the right column; clears the form; toasts "1 plan added".

### 6.6 Draft batch (right column)

- Lists current Pending Submission WOs (`list_my_draft_plans`). Each card: targets · greenhouse · scheduled time · chemical count · warning count · `Edit` / `Remove`.
- Click card → loads the draft into the centre form via `get_draft_plan` / `update_draft_plan`.
- Footer: `Submit all for approval` — disabled if 0 drafts; calls `submit_drafts_for_approval(wo_names)`; toast "N submitted · K skipped"; list refreshes.
- **No redirect to Desk** anywhere on this page. A small `View in Desk` `<a target="_blank">` per card remains for power users.

### 6.7 Networking / state

- React Query for reads: `fetch_creator_bootstrap`, `list_my_draft_plans`, `get_draft_plan`, `get_approval_review`. Invalidate `list_my_draft_plans` after every mutation.
- Mutations: `create_draft_spray_plan`, `update_draft_plan`, `delete_draft_plan`, `submit_drafts_for_approval`. All optimistic with rollback + toast on error.
- IndexedDB cache for weather (30 min) and pest/disease catalogues (24 h).
- Existing `useScouting` hook for the heatmap unchanged.

### 6.8 Routing & nav

- Existing route `/scp_app#/application-plan` reused.
- Sidebar entry hidden for users lacking `Spray Plan Creator` via the existing role-aware nav logic.
- New sidebar entry "Spray Plan Access" (GM only) for the §4 admin page.

## 7 · Frontend — Approval Page Enhancements

`/scp_app#/approvals` evolves, not replaced. Existing list + filter UI unchanged except the underlying filter (`workflow_state='Awaiting Approval'`).

### 7.1 WO card layout

```
┌──────────────────────────────────────────────────────────────┐
│ MFG-WO-2026-02411 · Kaptumbo GH 12          [✕ Reject] [✓ Approve]
│ Curative · Thrips, FCM · 2026-05-20 06:00  ·  Submitted by abraham@…
│ ── Targets ────────────────────────────────────────────────
│ Thrips · FCM
│ ── Weather at planning time ────────────────────────────────
│ 🌡 22 °C  💧 65 %  💨 8 km/h  🌧 10 %     (green snapshot)
│ ── Chemicals + rates + resistance ─────────────────────────
│ Sivanto Prime    [IRAC 4A]  1.0 L/1000L ✓  ⚠ 4A used 9d ago (WO-…02411)
│ Neemraj 3000     [IRAC ‑]   1.0 L/1000L ✓
│ Amisil           [—]        0.3 kg/1000L ✓
│ ── Spray team ──────────────────────────────────────────────
│ Abraham K. (Supervisor) · Antony C. (Pump Op) · 12 sprayers
│ ── Warnings ────────────────────────────────────────────────
│ ⚠ 1 IRAC rotation warning   ⚠ 0 rate out-of-range
└──────────────────────────────────────────────────────────────┘
```

Driven by `get_approval_review(wo_name)`. One call → all data needed.

### 7.2 Bulk approve

Checkbox column on each card + an `Approve selected` button. Calls `approve_drafts_bulk(wo_names)` with the same race-free contract as `submit_drafts_for_approval`. All-or-nothing.

### 7.3 Rejection

Unchanged — `stop_single_work_order` (cancel, docstatus=2).

## 8 · Fixtures & Migrations

Fixtures committed to git, applied via `bench migrate` / fixture sync:

- New role: `Spray Plan Creator`.
- New doctypes: `Farm Spray Plan Creator` (child), `Application Floor Plan Workflow` (Workflow), `Spray Plan Settings` (Singleton).
- New custom fields on `Work Order`, `Farm`, `Spray Team`, `Item` per §3.

Migration patches (registered in `upande_scp/patches.txt`):

- `v15_01_backfill_spray_team_farm` — infer `Spray Team.custom_farm` from each team's most-used Work Order history. Ambiguous teams written to `_unassigned_spray_teams.csv` for GM cleanup; the team is left blank and disabled until manually fixed.
- `v15_02_seed_spray_plan_settings` — create the singleton with default thresholds.

No backfill of `workflow_state` for existing Work Orders. The workflow applies only to new `custom_type='Application Floor Plan'` WOs.

## 9 · Testing

### 9.1 Backend (pytest, `upande_scp/tests/`)

- `test_scope_resolution.py` — user with no farms, single farm, multi-farm; revoked mid-session.
- `test_bulk_submit_race.py` — two threads submitting overlapping `wo_names` lists; assert no double-submission; partial-failure rolls back.
- `test_approval_review.py` — IRAC/FRAC violation detection across fixture WOs at varying recency; rate out-of-range; chemicals with no codes.
- `test_workflow_state_guards.py` — `update_draft_plan` rejects non-Pending WOs; `submit_drafts_for_approval` rejects non-owner WOs.

### 9.2 Frontend (Vitest, `frontend/src/`)

- `ApplicationPlan` smoke tests: role gate, scope chip switcher clears form, Preventive reason required, IRAC inline warning shows.
- `WeatherSnapshot` rendering with mocked Open-Meteo response; offline fallback; threshold colouring.
- `DraftBatchList` add → edit → remove → submit-all flow.

### 9.3 Manual QA checklist

Will be expanded in the implementation plan. Must cover: full happy path, IRAC violation flow, farm-scope revocation mid-session, bulk-approve, weather offline.

## 10 · Implementation Plans

Part A splits into three plans, run sequentially:

| Plan | Scope | Ships when… |
|---|---|---|
| **A1 — Schema & backend foundation** | New role, all new doctypes/custom fields/fixtures, migration patches, `_resolve_user_scope`, all new whitelisted endpoints (`fetch_creator_bootstrap`, `create_draft_spray_plan`, `list_my_draft_plans`, `get_draft_plan`, `update_draft_plan`, `delete_draft_plan`, `submit_drafts_for_approval`, `get_approval_review`, `approve_drafts_bulk`, admin-page endpoints), removal of dynamic-BOM logic, approval-endpoint filter swap. **Frontend untouched**: the old page still works against legacy `createApplicationWorkOrder`. | Patches apply cleanly; all backend tests pass; legacy frontend still functional. |
| **A2 — Admin page (GM → Farm assignments)** | New React route `/spray-plan-access`, GM-gated. Consumes the admin endpoints already shipped in A1. | GM can assign at least one creator to one farm. Existing pages unaffected. |
| **A3 — ApplicationPlan rewrite + Approval page enhancements** | Full ApplicationPlan UI overhaul (§6). Approval page card layout per §7.1 with rates + IRAC/FRAC + bulk-approve. Old `createApplicationWorkOrder` deprecated and removed once new flow is validated. | Creator can plan → batch → submit; GM sees enhanced approval cards; old page replaced. |

A1 must merge before A2 (A2 calls A1 endpoints). A2 must merge before A3 (creators need farm assignments to see content). A3 closes Part A.

## 11 · Open Questions & Future Work

Tracked for Parts B/C — not blocking this part:

- Spraying In Progress trigger: manual operator button vs. auto from a `Sprayer Check-In` doctype? Decide in Part B/C.
- Completed trigger: auto on Material Issue SE submit, or require a separate operator confirmation?
- IRAC/FRAC blocking severity: which codes warrant hard-block vs warning? Decide with agronomists.
- Commercial licence for Open-Meteo if traffic ever exceeds free tier — keep `WeatherProvider` abstraction so swap is one-file.
- Multi-farm bulk operations: do we ever need bulk-submit / bulk-approve spanning multiple farms in one click? Currently scoped to one farm per session.
