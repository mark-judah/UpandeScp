# Group serverscripts by functionality — Design

**Date:** 2026-07-21
**Status:** Approved (design), pending implementation plan
**Scope:** Reorganize the 41 loose top-level modules under
`upande_scp/serverscripts/` into functional subpackages, updating every
reference so nothing breaks. Pure move + reference rewrite — no behavior
changes, no content refactoring.

## Problem

`upande_scp/serverscripts/` has 41 loose `.py` modules at the top level
alongside the already-grouped subpackages (`spray_plan_creator/`,
`dashboard_aggregates/`, `mobile/`, `tests/`). The flat list is hard to
navigate. We want the loose modules grouped into functional subpackages,
matching the existing precedent.

## Constraints that shape the approach

- Modules are invoked by **full dotted path** from many places: 85 distinct
  call-strings in `frontend/src`, references in 62 Python files, 16 spots in
  `hooks.py`, `www/scp_app.py`, and `public/js`. Moving a module changes its
  import path everywhere.
- **Frontend call-strings are the sharp edge:** a wrong dotted path still
  compiles (it is just a string) and only fails at runtime with a 404 on the
  whitelisted method. `yarn build` will NOT catch it.
- Backend `tests/` import several of these modules directly; those imports
  move too.
- Decision (agreed): cover **all 41 files**; **update all references, no
  compatibility shims**; execute **incrementally, one package per task**.

## Grouping scheme

Seven new subpackages. Existing subpackages (`spray_plan_creator/`,
`dashboard_aggregates/`, `mobile/`, `tests/`) are untouched. Every new
package gets an empty `__init__.py`.

### `scouting/` (12)
get_avocado_scouting, get_complete_scouting_entries, get_scouting_analysis,
get_scouting_observations, get_scouting_report, scouting_metrics,
scouting_metrics_api, scouting_prewarm, get_heatmap_data, observation_colors,
get_trap_data, populate_severity_defaults

### `geo/` (8)
geo_builders, get_beds_and_zones, get_orchard_trees, bed_zone_automation,
run_tree_automation, get_tanks_valves, warehouse_filter, populate_avocado

### `reports/` (5)
send_chemical_progress_email, send_daily_scouting_report,
send_fcm_weekly_excel_report, send_weekly_trap_report, report_recipients

### `store/` (7)
store_keeper_api, store_label_printing, ordering_api, thresholds_api,
get_bom_stock_balances, create_bom, create_application_work_order

### `qr/` (2)
qr_generator, regenerate_qrs

### `spray_plan_ops/` (3)
spray_plan_approval, spray_plan_labels, validate_frac_irac_guidelines

### `common/` (4)
cache_utils, _debug_errors, get_workspace_stats, weather

Total: 12 + 8 + 5 + 7 + 2 + 3 + 4 = 41. No module is left at the top level;
none appears in two packages.

New dotted-path shape: `upande_scp.serverscripts.<module>.<fn>` becomes
`upande_scp.serverscripts.<package>.<module>.<fn>`.

## Reference-update surface (per moved module)

Every occurrence of the old dotted path is rewritten to the new one, across:

- `frontend/src/**` — `call("upande_scp.serverscripts.<mod>.<fn>")` strings
  and any `import`-style path strings.
- `upande_scp/hooks.py` — `after_migrate`, `doc_events`, `scheduler_events`.
  Known loose-module hook references to update when their package moves:
  - `observation_colors.after_migrate` → `scouting/`
  - `cache_utils.invalidate_on_change`, `cache_utils.publish_scouting_dirty`
    (used broadly via the `_SCP_CACHE_INVALIDATOR` / `_SCP_REALTIME_DIRTY`
    vars) → `common/`
  - `send_daily_scouting_report`, `send_weekly_trap_report`,
    `send_fcm_weekly_excel_report`, `send_chemical_progress_email`
    (scheduler) → `reports/`
  - `scouting_prewarm.daily_prewarm`, `scouting_prewarm.hourly_prewarm`
    (scheduler) → `scouting/`
- `upande_scp/www/scp_app.py` — `from upande_scp.serverscripts import
  scouting_metrics_api as api` → `from upande_scp.serverscripts.scouting
  import scouting_metrics_api as api` (moves with `scouting/`).
- `upande_scp/public/js/**` — `bed_and_zone_automation.js` references
  `bed_zone_automation.create_beds_and_zones` (moves with `geo/`).
- Cross-module Python imports between these modules, and imports in
  `serverscripts/tests/**`.
- Any `bench execute` dotted paths referenced in comments/docs that name a
  moved module (rewrite for accuracy; comment-only).

## Verification (the anti-404 net)

A resolver helper is the backbone. It scans `frontend/src` for every
`upande_scp.serverscripts.*` call-string, and for each asserts the path
resolves via `frappe.get_attr(path)` to a callable whose `whitelisted`
attribute is true. It runs with the bench env Python
(`/home/ubuntu/stive/code/frappe15/env/bin/python`), which can import the
modules (they import `frappe`) without needing a live site. The helper lives
in the scratchpad (not committed).

Process:
1. **Before any move:** run the resolver → capture the baseline count of
   resolvable call-strings (must be all of them). This is the invariant.
2. **Per package task, after the move + reference rewrite:**
   a. `grep -rn "serverscripts\.<oldmod>\b"` for each moved module across the
      repo → must return **zero** hits at the old (unpackaged) path.
   b. Each moved module imports at its new path (Python smoke import).
   c. Resolver check passes with the same baseline count — every frontend
      call-string still resolves to a whitelisted function.
   d. `yarn build` clean (from `frontend/`).
   e. Backend unittest suite shows no new failures vs. the known baseline
      (1 pre-existing failure + 9 site-path errors from tests needing a live
      bench — unrelated to this refactor).
3. **After all packages:** the top level of `serverscripts/` contains only
   `__init__.py` and subpackages; a final repo-wide grep for any
   `upande_scp.serverscripts.<loose_module>` (old shape) returns zero.

## Execution order

One package per task/commit, lowest-blast-radius first so the flow is proven
before the risky ones:

1. `qr/` (2 files, few refs) — pilot; proves move+rewrite+verify.
2. `reports/` (5 files; hooks scheduler + a few refs).
3. `spray_plan_ops/` (3 files; frontend refs).
4. `geo/` (8 files; includes the `public/js` bed-zone ref).
5. `store/` (7 files; frontend refs + `tests/` imports).
6. `scouting/` (12 files; heaviest frontend blast radius + `www/scp_app.py`
   + hooks).
7. `common/` (4 files; `cache_utils` is wired into nearly every doc_event via
   hooks — done last, most careful).

Each task ends with a clean, independently reviewable commit and passes the
per-task verification above.

## Naming note

`spray_plan_ops/` sits beside the existing `spray_plan_creator/`. They are
distinct: `spray_plan_creator/` is the creator subsystem; `spray_plan_ops/`
holds approval, labels, and FRAC/IRAC validation (renamed from `spray_plan/`
at spec review to avoid confusion with `spray_plan_creator/`).

## Out of scope

- Splitting or refactoring the *contents* of any module (pure relocation).
- Any change to the existing subpackages
  (`spray_plan_creator/`, `dashboard_aggregates/`, `mobile/`, `tests/` layout).
- Any behavior change, signature change, or new/removed endpoint.
- Adding compatibility shims (explicitly rejected — full reference rewrite).
