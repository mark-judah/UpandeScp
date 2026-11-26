# Shared Spray Plan Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The roses plan form (tank mix + New tank mix, Add chemical, Available, Batch, Scheduled Application, MOA) becomes one component used by the roses page and, once per selected block, by the field Application Floor Plan.

**Architecture:** Extract the form section of `pages/ApplicationPlan.tsx` into `components/spray-plan/plan-form/` (a presentational `SprayPlanForm` plus a `useSprayPlanForm` state hook holding one plan's rows, BOM, batch picks, schedule). Roses renders one instance for its greenhouse; `OpenFieldPlanner`/`BlockPlanPanel` render one per selected block keyed by block name. Payload building stays in `lib/open-field.ts` (field) and the roses page (greenhouse), both fed from the hook's state.

**Tech Stack:** React + TypeScript, vitest + Testing Library, existing shadcn Dialog/Popover, FilterSelect pills.

**Spec:** `docs/superpowers/specs/2026-11-26-shared-spray-plan-form-design.md` (MOA options/default from `2026-11-26-spray-ticket-preview-design.md`).

## Global Constraints

- App: `/home/ubuntu/stive/code/frappe16-mutara/apps/upande_scp`, site `mutara.local`. No commits.
- Roses behaviour unchanged: every existing `ApplicationPlan` test keeps passing without weakening assertions.
- No new server endpoints unless an existing roses one cannot serve a block; stock/batch/BOM calls are the roses ones; a block's source store = its farm's chemical store (roses' rule for a greenhouse).
- required_qty sent absolute; quantity maths through the existing `lib/spray-rates.ts` / `lib/open-field.ts` helpers.
- MOA: options `Spraying (foliar)`, `Dusting`, `Chemigation`; default `Spraying (foliar)`; field `custom_method_of_application`; pill label "MOA", tooltip "Method of application".
- UI: Poppins, black and white, FilterSelect pills, no native selects, no vertical accent strips, skeletons.
- Do not edit `pages/avocado/AvocadoHeatMap.tsx`, `AvocadoTreeMap.tsx`, `pages/maps/*`, `lib/field-geo.ts` (another agent is on them).

## Review Focus

1. Two blocks selected, each with a different tank mix and time → two drafts with their own BOM, rows, batches, `custom_scheduled_application_time`. (Task 3 test)
2. Batch-tracked item with no batch picked on one block → that block's submit blocked with the roses message; the other block unaffected. (Task 3 test)
3. Available accounts for stock already reserved by another selected block's draft in the same batch, not just saved drafts. (Task 3 test)
4. Block with no area → area-based rows show "enter the block area", no NaN quantities. (Task 3 test)
5. Roses: New tank mix created from the dialog is selected afterwards, as today. (Task 1 test, existing or added)

---

### Task 1: Extract the form from the roses page

**Files:** Create `frontend/src/components/spray-plan/plan-form/{SprayPlanForm.tsx,useSprayPlanForm.ts,ChemicalTable.tsx,NewTankMixDialog.tsx,AddChemicalDialog.tsx}`; Modify `frontend/src/pages/ApplicationPlan.tsx`; Test `frontend/src/components/spray-plan/plan-form/__tests__/SprayPlanForm.test.tsx`.

**Interfaces — Produces:**
- `useSprayPlanForm(opts: { place: string; placeKind: "greenhouse" | "block"; crop?: string; farm: string; areaHa: number; reservedElsewhere?: Record<string, number> }) => PlanFormState`
- `PlanFormState` exposes at least: `bom, setBom, chemicals, addChemical, removeChemical, setRate, setBatch, water, setWater, method, setMethod, scheduledAt, setScheduledAt, classification, team, kit, problems: string[], reservedQty: Record<item_code, number>`.
- `<SprayPlanForm state={PlanFormState} compact?: boolean />` renders: Classification pills; one row of pills `Spray team | Kit | MOA` (MOA tooltip); Tank mix picker + "New tank mix" button (opens `NewTankMixDialog`); `ChemicalTable` with columns Chemical, Rate, Quantity, Available, Batch (Batch only when any row's item needs a batch) and "Add chemical" (opens `AddChemicalDialog`); Water; Scheduled Application (date + time).

- [ ] Step 1: Tests for the extracted pieces: renders the MOA pill with tooltip text "Method of application"; "New tank mix" opens the dialog; "Add chemical" adds a row; Batch column appears only when a row needs a batch; Available shows the roses-computed figure.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Move code out of `ApplicationPlan.tsx` into the new files (move, don't rewrite: keep roses' logic and copy identical), and make the roses page render `<SprayPlanForm>` from `useSprayPlanForm`.
- [ ] Step 4: `npx vitest run src/components/spray-plan src/pages` — new tests and all existing ApplicationPlan tests PASS.

### Task 2: MOA pill and sidebar collapse hint

**Files:** Modify `frontend/src/components/AppSidebar.tsx` (expose a highlight hook/flag on the Collapse button), `frontend/src/components/spray-plan/OpenFieldPlanner.tsx` (hint banner); Test `frontend/src/components/spray-plan/__tests__/OpenFieldPlanner.hint.test.tsx`.

- [ ] Step 1: Tests: hint visible when sidebar expanded and not dismissed; clicking "Collapse sidebar" in the hint collapses it and hides the hint; "Dismiss" hides it and stores `scp.hint.collapseSidebar.dismissed=1` (try/catch around localStorage); not shown when sidebar already collapsed; while shown, the sidebar Collapse button carries a highlight (ring/pulse class).
- [ ] Step 2: Run → FAIL. Step 3: implement using the sidebar's existing collapse state/context. Step 4: PASS.

### Task 3: One form per block on the field planner

**Files:** Modify `frontend/src/components/spray-plan/BlockPlanPanel.tsx`, `OpenFieldPlanner.tsx`, `frontend/src/lib/open-field.ts` (`toDraftPayload` from `PlanFormState`); Test `frontend/src/lib/open-field.test.ts`, `frontend/src/components/spray-plan/__tests__/BlockPlanPanel.test.tsx`.

- [ ] Step 1: Tests per Review Focus 1–4: two blocks → two payloads with their own `production_item`, rows, `custom_batch_no` per row, `custom_scheduled_application_time`, `custom_method_of_application`; missing batch blocks only that block; Available for block B subtracts block A's unsaved quantities of the same item at the same store; no-area block → "enter the block area".
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: BlockPlanPanel renders `<SprayPlanForm compact>` per block (collapsible card per block as today); pass `reservedElsewhere` summed from the other blocks' hook states. Remove the old slim fields it replaces.
- [ ] Step 4: PASS; server `create_draft_plans_batch` accepts the per-block payloads (run `bench --site mutara.local run-tests --module upande_scp.serverscripts.tests.test_open_field_plan`).

### Task 4: Build, deploy, verify

- [ ] `cd frontend && npx vitest run && npm run build` green (failures only in map files owned by the other agent → note, don't fix).
- [ ] `bench --site mutara.local clear-cache` (frontend-only change; restart only if Python changed: `sudo -n supervisorctl restart frappe16-mutara-web:`).
- [ ] Headless browser (scratchpad `pw/`): roses Application Plan still renders and opens New tank mix; field Application Floor Plan with 2 blocks selected shows two forms with MOA pill, New tank mix, Add chemical, Available, Batch, Scheduled Application; the collapse hint highlights the sidebar button. Screenshots to scratchpad.
