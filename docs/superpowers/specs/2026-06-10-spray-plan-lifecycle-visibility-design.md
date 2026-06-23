# Spray-Plan Lifecycle Visibility — Design

**Date:** 2026-06-10
**Status:** Approved (design); pending implementation plan

## Problem

The Application Floor Plan (AFP) spray flow is fully modeled on the backend —
a Work Order moves through `workflow_state`:

```
Draft → Awaiting Approval → Approved → Chemical Issued
      → Tank Mix Manufactured → Spraying In Progress → Completed
```

— but the frontend exposes none of this end-to-end. The Approvals page (the
General Manager's view) only lists Pending + Forwarded plans, so the GM cannot
see how a chemical moves after approval: whether it was issued via biometric,
whether labels were printed, whether labels were scanned at the CSU, whether
spraying started (and by whom), and whether it ended. The Historical page (the
spray-plan creator's view) shows a static work-order list with no sense of
where each plan is in its life. The storesman has no window to follow chemical
progress. Labels can be reprinted with no record that they were printed before.
And unapproved plans accumulate indefinitely.

This project surfaces the existing lifecycle, adds the two pieces of state that
are genuinely missing (label-printed tracking; auto-cancellation of dormant
unapproved plans), and reuses one timeline component across all three views.

## Goals

- A General Manager can walk any plan cradle-to-grave: created → approved →
  chemical issued (biometric) → labels printed → labels scanned → spraying
  started (by whom) → completed.
- A spray-plan creator can see the full lifetime of their plan through every
  phase, with a clear flag when a spray did not start within its scheduled
  window.
- A storesman has a dedicated window to follow chemical-plan progress.
- Labels carry a persisted "printed" marker so an operator knows a label was
  printed before (reprint still allowed).
- Unapproved plans that sit dormant for more than 3 days are auto-cancelled.

## Non-goals

- No change to the underlying state machine, scan flow, biometric flow, or PDF
  rendering. We aggregate and surface existing data; we do not re-engineer it.
- No new persisted "lifecycle event" DocType — the data already lives in Work
  Order fields, workflow comments, and linked Stock Entries.
- Label-printed tracking does **not** block reprinting.

## Architecture

One shared backend progress endpoint feeds one reusable React timeline
component, consumed by three pages. Two small add-ons (label-printed fields +
mark-on-generate; an auto-cancel cron) round out the missing state.

```
                         ┌─────────────────────────────┐
                         │ lifecycle.py (new)          │
                         │  get_lifecycle(wo)          │  ← aggregates WO fields,
                         │  get_lifecycle_summary(...) │    workflow comments,
                         └──────────────┬──────────────┘    linked Stock Entries
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
   Approvals.tsx (GM)        Historical.tsx (creator)   ChemicalProgress.tsx (storesman, new)
   stage tabs + timeline     timeline + missed-window    stage list + timeline
              └─────────────────────────┴─────────────────────────┘
                              <LifecycleTimeline> (shared component)
```

### Why this approach

The lifecycle is already authoritative on the backend. A single
`get_lifecycle` aggregator keeps the definition of "what the stages are" in one
place; a single `<LifecycleTimeline>` keeps the rendering consistent. Adding a
new consumer (the storesman page) is then cheap. The rejected alternatives were
per-page bespoke queries (guaranteed drift across three copies) and a
materialized lifecycle DocType (redundant storage to keep in sync with data
that already exists).

## Component 1 — Backend: `lifecycle.py`

New module `upande_scp/serverscripts/spray_plan_creator/lifecycle.py`.

### `get_lifecycle(work_order: str) -> dict`

Returns `{ work_order, current_state, scheduled, steps: [...] }` where each step
is:

```python
{
  "key": "chemical_issued",        # stable identifier
  "label": "Chemical Issued",      # display label
  "status": "done",                # done | current | pending | warning | skipped
  "actor": "Jane Wanjiku",         # who performed it (name), or None
  "timestamp": "2026-06-08 09:14:00",  # ISO, or None
  "detail": "Biometric verified · STE-2026-00042",  # one-line context, or None
}
```

The seven steps and their data sources:

| key | label | source | actor / detail |
|---|---|---|---|
| `created` | Created | `WO.creation`, `WO.owner` | creator, creation date |
| `approved` | Approved | Material-Transfer-for-Manufacture SE exists (`is_forwarded`) + WO workflow comment | approver, approval time |
| `chemical_issued` | Chemical Issued | the Material-Transfer SE `docstatus=1`; `custom_biometric_data` (employee), `custom_biometric_verified`, submission datetime | biometric employee, time, ✓verified flag, SE name |
| `labels_printed` | Labels Printed | **new** SE fields (Component 2) | printed-by, when, ×count — or "not printed yet" |
| `labels_scanned` | Labels Scanned (CSU) | `WO.custom_chemical_scans` rows vs `WO.required_items` | "N of M scanned", last scanner, last scan time |
| `spraying_started` | Spraying Started | `WO.actual_start_date` + WO workflow comment ("Spray session started by …") | operator, start time |
| `completed` | Completed | `WO.actual_end_date`, SAL applicators, Material Issue name + WO workflow comment | who ended, applicator list, end time |

**Status derivation.** Walk the ordered `workflow_state` rank. Steps whose state
rank is below the WO's current rank are `done`; the step matching the current
state is `current`; later steps are `pending`. The `labels_printed` step is
special: it is not a `workflow_state` of its own — it sits between
`chemical_issued` and `labels_scanned` and reports `done` iff the printed flag
is set, else `pending` (or `current` when the WO is in `Chemical Issued` and not
yet printed). Cancelled/Stopped Work Orders report a terminal `cancelled`
banner and freeze remaining steps as `skipped`.

**Missed-window warning.** If `custom_scheduled_application_time` is in the past
and the WO has not yet reached `Spraying In Progress`, the `spraying_started`
step's status is `warning` with detail "Did not start within scheduled window".

**Actor/time resolution.** Where a Work Order field directly carries the value
(`actual_start_date`, `actual_end_date`, scan rows, biometric child rows), use
it. For approver and the start/end operators, parse the WO `add_comment`
"Workflow" entries (these already record `… by {user}` with a timestamp) as the
authoritative actor source, falling back to document `owner`/`modified_by` if a
comment is absent.

### `get_lifecycle_summary(from_date, to_date, farm, greenhouse, states) -> list`

A lightweight batch variant for list/tab views. Returns, per matching AFP Work
Order: `{ name, current_state, current_step_key, scheduled, missed: bool,
greenhouse, spray_type }`. Avoids the per-WO comment parsing — derives
`current_step_key` from `workflow_state` and `missed` from the scheduled time —
so it stays cheap for a full list. The detail timeline (`get_lifecycle`) is
only fetched when a row is expanded/opened.

### Permissions

`get_lifecycle` / `get_lifecycle_summary` are readable by Spray Plan Approver /
General Manager / System Manager / Store Keeper / the plan's creator. Gate on
the endpoint side (mirroring `spray_plan_approval.py`); non-privileged callers
get a PermissionError surfaced as an error state on the page.

## Component 2 — Label-printed tracking

### Custom fields on **Stock Entry**

(Applied to the Material-Transfer-for-Manufacture SEs that `Labels.tsx` lists.)

- `custom_labels_printed` — Check (default 0)
- `custom_labels_printed_on` — Datetime
- `custom_labels_printed_by` — Data (full name of the printing user)
- `custom_labels_print_count` — Int (default 0)

Fields are added via the app's existing custom-field fixture mechanism (same
path used for the other `Stock Entry`/`Work Order` custom fields).

### Stamping

`spray_plan_labels.generate_pdf` already knows which selected SEs actually
produced labels (vs the skipped/no-QR ones). After a successful render, it
stamps `custom_labels_printed=1`, `custom_labels_printed_on=now`,
`custom_labels_printed_by=<full name>`, and increments
`custom_labels_print_count` for each SE that produced ≥1 label. This is the
reliable "it was printed" signal (the operator only gets a PDF when generation
succeeds). Stamping uses `frappe.db.set_value` and does not touch docstatus.

### Surfacing

- `store_keeper_api.list_submitted_transfers` returns the four new fields per
  row.
- `Labels.tsx` shows a non-blocking badge per row: **"Printed ✓ ×N · {date} ·
  {by}"** when `custom_labels_printed`, else nothing. Selection and the
  Generate button are unaffected — reprint is always allowed.
- The `labels_printed` lifecycle step reads the same fields.

## Component 3 — Auto-cancel dormant unapproved plans

New function `auto_cancel_dormant_plans()` in
`upande_scp/serverscripts/spray_plan_creator/` (e.g. a new `maintenance.py`, or
appended to an existing creator module).

**Selection.** AFP Work Orders (`custom_type = "Application Floor Plan"`) whose
`workflow_state` is one of the pre-approval states — `Draft`, `Pending
Submission`, `Awaiting Approval` (i.e. anything before `Approved`) — with
`creation < now − 3 days` and not already cancelled/stopped.

**Action per plan.** Reuse the existing stop mechanism (the same path
`stop_work_order` uses) to move the WO to a terminal state, set
`workflow_state = "Cancelled"`, add a workflow comment *"Auto-cancelled:
unapproved for more than 3 days (created {date})."*, and notify the plan's
creator (Frappe Notification Log entry; email if the team's notification
settings send one). Each plan is processed in its own transaction so one
failure does not abort the batch (log and continue).

**Scheduling.** Registered in `hooks.py` under `scheduler_events["daily"]`
alongside `scouting_prewarm.daily_prewarm`.

**Clock basis.** From creation date (confirmed). A plan unapproved 3 days after
it was created is cancelled regardless of intervening edits.

## Component 4 — Frontend

### `<LifecycleTimeline>` (new shared component)

`frontend/src/components/spray-plan/LifecycleTimeline.tsx`. Props: the `steps`
array from `get_lifecycle` (+ `current_state`, `scheduled`). Renders a vertical
stepper: each step shows an icon keyed to status (done = filled check, current =
pulsing ring, pending = hollow, warning = amber alert, skipped = muted), the
label, actor, timestamp, and detail line. A cancelled banner renders above when
the plan was cancelled/stopped. Uses the existing design-system primitives
(Card, Badge, lucide icons, the `--sd-*` tokens) so it matches the app.

A small `lifecycle-api.ts` wraps `get_lifecycle` / `get_lifecycle_summary`
(typed) under `frontend/src/lib/`.

### Approvals.tsx (General Manager)

- Replace the Pending / Forwarded / All tabs with stage tabs driven by
  `get_lifecycle_summary`: **Pending · Forwarded · Chemical Issued · Tank Mix ·
  Spraying · Completed** (counts per tab). The existing bulk approve/stop
  actions stay on the Pending/Forwarded tabs.
- In each expanded row, render `<LifecycleTimeline>` (fetched lazily via
  `get_lifecycle` on expand) above/alongside the existing chemicals + detail
  panel, so the GM drills into any plan's full progress.

### Historical.tsx (creator)

- In the `WorkOrderDialog`, render `<LifecycleTimeline>` for the opened plan.
- In the list, add a red **"Missed window"** marker on rows where
  `get_lifecycle_summary.missed` is true (scheduled time passed, spray never
  started). The status filter gains the lifecycle stages as options.

### ChemicalProgress.tsx (storesman — new page)

- New router view `chemical-progress` (add to `router.ts` `View` union +
  `KNOWN_VIEWS`, lazy import + render branch in `App.tsx`, sidebar entry in
  `AppSidebar.tsx` gated to Store Keeper / GM / System Manager).
- Layout mirrors the existing store-keeper pages: filter bar (farm /
  greenhouse / date), a list from `get_lifecycle_summary` focused on the
  issue → scan → tank-mix → spray portion (current stage badge per row), and an
  expandable `<LifecycleTimeline>` per plan. Emphasizes the steps the storesman
  acts on: chemical issued, labels printed, labels scanned.

## Testing

**Backend (`upande_scp/serverscripts/tests/`):**
- `get_lifecycle` produces correct `status` per step for a WO in each of the 7
  states, including `labels_printed` done/pending logic and the cancelled
  freeze.
- Missed-window `warning` fires when scheduled time is past and state <
  `Spraying In Progress`, and does **not** fire once spraying started.
- `generate_pdf` stamps the four label fields and increments the count on
  reprint; SEs that produced no labels are not stamped.
- `auto_cancel_dormant_plans`: cancels a pre-approval plan created >3 days ago;
  leaves a plan created exactly at the 3-day boundary / <3 days ago alone;
  never touches a plan already `Approved` or beyond; writes the comment and
  notification.

**Frontend:**
- `<LifecycleTimeline>` renders each status variant and the cancelled banner.
- Approvals stage tabs filter correctly; expanding a row fetches and shows the
  timeline.
- Historical shows the missed-window marker only on missed rows.

## Files touched

**New**
- `upande_scp/serverscripts/spray_plan_creator/lifecycle.py`
- `upande_scp/serverscripts/spray_plan_creator/maintenance.py` (auto-cancel)
- `frontend/src/components/spray-plan/LifecycleTimeline.tsx`
- `frontend/src/lib/lifecycle-api.ts`
- `frontend/src/pages/ChemicalProgress.tsx`
- backend tests under `upande_scp/serverscripts/tests/`

**Modified**
- `upande_scp/serverscripts/spray_plan_labels.py` (stamp on generate)
- `upande_scp/serverscripts/store_keeper_api.py` (return printed fields)
- custom-field fixtures (4 new Stock Entry fields)
- `upande_scp/hooks.py` (daily scheduler entry)
- `frontend/src/pages/Approvals.tsx` (stage tabs + timeline)
- `frontend/src/pages/Historical.tsx` (timeline + missed marker)
- `frontend/src/pages/Labels.tsx` (printed badge)
- `frontend/src/lib/labels-api.ts`, `store-keeper-api.ts` (printed-field types)
- `frontend/src/lib/router.ts`, `frontend/src/App.tsx`,
  `frontend/src/components/AppSidebar.tsx` (new route)
```
