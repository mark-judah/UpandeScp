# Spray Ticket Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only MOLFM27-style ticket per Application Floor Plan Work Order, previewed from Spray Plan Transfers with a % complete, printable only at 100%.

**Architecture:** One server module (`spray_plan_ops/spray_ticket.py`) gathers the plan's existing records (Work Order, block warehouse tree, Production Crop Cycle, Spray Product rates/ingredients, and the sign-offs `lifecycle.get_lifecycle` already derives) and folds them through a pure `build_ticket(ctx)` into lines + percent. The React dialog renders that payload; a Work Order Jinja print format renders the same payload. One new Work Order field: method of application.

**Tech Stack:** Frappe v16 / ERPNext (Python), React + TypeScript + Vite + vitest, shadcn Dialog, Jinja print format.

**Spec:** `docs/superpowers/specs/2026-11-26-spray-ticket-preview-design.md`

## Global Constraints

- Bench: `/home/ubuntu/stive/code/frappe16-mutara`, app `apps/upande_scp`, site `mutara.local`. Do not commit. Never restart MariaDB; never `bench get-app`.
- No Material Request; nothing on the ticket is stored — it is computed on every call.
- Access = `lifecycle.get_lifecycle`'s (its `ACCESS_ROLES` + greenhouse scope). No new roles.
- No hard-coded crop, farm, product or kit names in logic.
- SCP UI: Poppins, black and white, pills (FilterSelect/HEADER_PILL), no native selects, no vertical accent strips, skeleton while loading.
- Counted lines (14 details + 5 sign-offs = 19): `block, farm, location, area_ha, crop, variety, crop_stage, app_week, operator, products, composition, equipment, method, water` and `prepared, authorized, issued, collected, applied`. Spray-only lines `targets, classification, reentry, phi` are shown, never counted.
- `percent = floor(100 * filled_counted / 19)`; `printable = percent == 100`.
- Method options, exactly: `Spraying (foliar)`, `Dusting`, `Chemigation`. Default `Spraying (foliar)` when a plan is drafted without one.
- Print format name: `SCP Spray Ticket`; footer text `Field/FSQM/2`.

## Review Focus

1. A plan whose block has no live crop cycle, or a cycle with blank `current_stage` (31 of 74 on mutara) → `crop_stage` missing with hint "Set the crop stage on the crop cycle in Production", no crash. (Task 2 test)
2. A chemical row whose product has no rate row / the plan has no area or water → `products` missing with the reason, not a 0 rate. (Task 2 test)
3. A Stopped / cancelled plan → ticket still opens, sign-offs after the stop show missing, never printable. (Task 2 test)
4. A user without access or out of greenhouse scope → PermissionError from `get_spray_ticket`, and the print path refuses the same way. (Task 3 test)
5. Desk print of an incomplete plan → the print format shows "INCOMPLETE — N%" across the top instead of a clean ticket. (Task 3 test)

---

### Task 1: Method of application field and default

**Files:**
- Modify: `upande_scp/serverscripts/common/custom_fields.py` (Work Order list, ~line 73)
- Modify: `upande_scp/serverscripts/spray_plan_creator/drafts.py` (~line 288 field list; default where the WO is built)
- Test: `upande_scp/serverscripts/tests/test_spray_ticket.py` (create)

**Interfaces:**
- Produces: Work Order field `custom_method_of_application` (Select, label "Method of Application", options per Global Constraints, insert after `custom_kit`).

- [ ] **Step 1: Failing test** `TestMethodField.test_field_exists_with_options`: `frappe.get_meta("Work Order").get_field("custom_method_of_application").options.split("\n")` ⊇ `["Spraying (foliar)", "Dusting", "Chemigation"]`; and `test_draft_defaults_method`: the drafts helper that builds the WO doc from a payload without the key sets `"Spraying (foliar)"`, and keeps `"Dusting"` when given (test the pure builder function in drafts.py that maps payload → doc fields; if none exists, extract one named `_apply_method_default(payload: dict) -> dict`).
- [ ] **Step 2:** `bench --site mutara.local run-tests --module upande_scp.serverscripts.tests.test_spray_ticket` → FAIL.
- [ ] **Step 3:** Add the field in the Work Order list the way neighbouring fields are declared; add `custom_method_of_application` to the drafts field list and apply the default. Run `bench --site mutara.local migrate` (or the module's custom-field sync entry point used by existing fields) so the column exists.
- [ ] **Step 4:** Tests PASS.

### Task 2: Ticket builder and endpoint

**Files:**
- Create: `upande_scp/serverscripts/spray_plan_ops/spray_ticket.py`
- Test: `upande_scp/serverscripts/tests/test_spray_ticket.py`

**Interfaces:**
- Consumes: `lifecycle.get_lifecycle(work_order) -> {steps:[{key,status,actor,timestamp,detail}], stopped, ...}` (access + scope check comes with it); `planting._load_warehouses`, `planting._cycles_by_unit`, `planting.crop_for_station`; `open_field.group_of`, `open_field._ancestors`, `open_field._short`; `spray_rates.rates_for(item_code, crop)`, `spray_rates.pick_row(rows, prefer_area)`, `spray_rates.rate_from_quantity(qty, row, area_m2, water_l)`.
- Produces:
  - `build_ticket(ctx: dict) -> dict` — pure. Returns `{work_order, percent:int, printable:bool, missing:[label], lines:[{key,label,group:"details"|"signoff"|"spray",value,filled:bool,hint:str|None}]}` in the Global Constraints key order.
  - `gather(work_order: str) -> dict` — reads only; the ctx `build_ticket` takes.
  - `@frappe.whitelist() get_spray_ticket(work_order: str) -> dict` = `build_ticket(gather(work_order))`.
- Sign-off mapping from lifecycle steps (filled when that step `status == "done"`; value = `"<actor> · <timestamp>"`): `authorized ← approved`, `issued ← chemical_issued`, `collected ← labels_scanned`, `applied ← completed` (value shows `spraying_started` timestamp → `completed` timestamp). `prepared ← created` (WO owner + creation).
- Detail sources: block = `custom_greenhouse` (label via `_short`); farm = block's `custom_farm`; location = `group_of` label, else the parent warehouse; area_ha = `custom_area`; crop = `crop_for_station(block)`; variety = `custom_variety` or live cycle `variety`; crop_stage = live cycle `current_stage` (cycle chosen like `pick_cycle_item`, on the scheduled date); app_week = ISO week of `custom_scheduled_application_time` else `planned_start_date`, as `"W48 2026"`; operator = `custom_spray_plan_team_members` (supervisor first: role containing "Supervisor"), else `custom_spray_team`; products = WO required items with qty, stock UOM and rate line (filled only when every row has a rate); composition = each product's `active_ingredients` (filled only when every product has ≥1); equipment = `custom_kit`; method = `custom_method_of_application`; water = `custom_water_volume` L plus per-product "X <uom> per litre".

- [ ] **Step 1: Failing tests (pure, ctx dicts built in the test):**
  - `test_full_ctx_is_100_and_printable` — every source present → `percent == 100`, `printable is True`, `missing == []`, `len([l for l in lines if l["group"] != "spray"]) == 19`.
  - `test_blank_stage_is_missing_with_hint` — `current_stage=None` → line `crop_stage` `filled False`, hint `"Set the crop stage on the crop cycle in Production"`, `percent == 94` (18/19), `printable False`.
  - `test_product_without_rate_is_missing` — one chemical with no rate row → `products.filled False`, hint names the item.
  - `test_spray_lines_do_not_count` — removing targets/reentry/phi leaves percent unchanged.
  - `test_stopped_plan_never_printable` — `stopped=True` with steps after the stop not done → `printable False`.
  - `test_signoff_values` — authorized line value contains the approver name and timestamp from the step.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement `build_ticket`, then `gather`, then `get_spray_ticket`.
- [ ] **Step 4:** Tests PASS. Then live check on a real mutara AFP Work Order (`frappe.get_all("Work Order", {"custom_type": "Application Floor Plan"}, limit=1)`) via a throwaway `bench execute`: returns lines, no exception.

### Task 3: Print format

**Files:**
- Create: `upande_scp/upande_scp/print_format/scp_spray_ticket/{__init__.py, scp_spray_ticket.json}` (Jinja, doc_type Work Order, standard Yes, module the app's)
- Modify: `upande_scp/hooks.py` — `jinja = {"methods": [...]}` add `upande_scp.serverscripts.spray_plan_ops.spray_ticket.ticket_for_print`
- Modify: `spray_ticket.py` — `ticket_for_print(work_order: str) -> dict` = `get_spray_ticket` (same access check; raises for no access)
- Test: `test_spray_ticket.py`

**Interfaces:**
- Produces: print format `SCP Spray Ticket`; URL the dialog opens: `/printview?doctype=Work%20Order&name=<wo>&format=SCP%20Spray%20Ticket&no_letterhead=1`.

- [ ] **Step 1: Failing tests:** `test_print_renders_complete` — `frappe.get_print("Work Order", wo, "SCP Spray Ticket")` on a WO whose ticket is mocked to 100% contains `"Field/FSQM/2"` and the block label and not `"INCOMPLETE"`; `test_print_marks_incomplete` — mocked 94% → contains `"INCOMPLETE — 94%"`; `test_print_refuses_without_access` — as a user with none of `ACCESS_ROLES` → `frappe.PermissionError`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Layout follows the paper ticket: header (title "Spray Application Ticket (MOLFM27)", WO name, week), details grid, products table (product, composition, qty + UOM, rate), equipment/method, water + dilution, sign-off table (role, name, date/time), footer `Field/FSQM/2`. Blank lines print as empty boxes. Black on white, Poppins with sans-serif fallback.
- [ ] **Step 4:** PASS; `bench --site mutara.local migrate` (or reload-doc) so the format exists.

### Task 4: Preview dialog on Spray Plan Transfers

**Files:**
- Create: `frontend/src/lib/spray-ticket-api.ts`, `frontend/src/components/spray-plan/SprayTicketDialog.tsx`
- Modify: `frontend/src/pages/SprayPlanTransfers.tsx` (row actions)
- Test: `frontend/src/components/spray-plan/__tests__/SprayTicketDialog.test.tsx`

**Interfaces:**
- Consumes: `get_spray_ticket` payload (Task 2), print URL (Task 3).
- Produces: `getSprayTicket(workOrder: string): Promise<SprayTicket>`; types `SprayTicket`, `TicketLine` mirroring Task 2.

- [ ] **Step 1: Failing tests:** renders a progress ring with `"94%"` and the missing list; Print button `disabled` with title listing missing labels when `printable=false`; enabled and its href is the Task 3 URL when `printable=true`; lines grouped under "Details", "Sign-offs", "Spray" headings; filled lines show values, missing lines show the hint.
- [ ] **Step 2:** `cd frontend && npx vitest run src/components/spray-plan/__tests__/SprayTicketDialog.test.tsx` → FAIL.
- [ ] **Step 3:** Dialog (existing shadcn Dialog used on the page) with skeleton while loading and an inline error on failure. A "Preview" ghost button (lucide `FileText`) on every row — draft and submitted transfers — that opens it with the row's work order; clicking it must not toggle the row selection (`stopPropagation`, like the existing row buttons).
- [ ] **Step 4:** PASS; existing `SprayPlanTransfers` tests still pass.

### Task 5: Method on the Application Floor Plan

**Files:**
- Modify: `frontend/src/lib/open-field.ts` (`BlockPlan.method`, `emptyPlan`, `toDraftPayload` → `custom_method_of_application`)
- Modify: `frontend/src/components/spray-plan/BlockPlanPanel.tsx` (FilterSelect pill next to the kit)
- Test: `frontend/src/lib/open-field.test.ts`

- [ ] **Step 1: Failing tests:** `emptyPlan().method === "Spraying (foliar)"`; `toDraftPayload(...)` carries `custom_method_of_application` equal to the plan's method.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; the pill offers the three options.
- [ ] **Step 4:** PASS. Then `cd frontend && npx vitest run && npm run build` green.

### Task 6: Deploy and verify on mutara

- [ ] Restart: `sudo -n supervisorctl restart frappe16-mutara-web: frappe16-mutara-workers:` then `bench --site mutara.local clear-cache`.
- [ ] Headless browser (scratchpad `pw/`, login via `BROWSER=echo bench --site mutara.local browse --user Administrator`): open `/scp_app#/<crop>/spray-plan-transfers` (route per `App.tsx`), click Preview on a row, screenshot the dialog; open the print URL, screenshot. Report percent shown and which lines are missing.
