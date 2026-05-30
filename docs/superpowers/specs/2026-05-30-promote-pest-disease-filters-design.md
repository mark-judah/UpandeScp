# Promote Pest Filter & Disease Filter to Standalone DocTypes

**Date:** 2026-05-30
**Status:** Approved (pending spec review)
**Author:** dev@upande.com (with Claude)

## Problem

`Pests Stages` is a **grandchild** table: it is a child of `Pest Filter`, which is
itself a child table of `Crop Scouted`. Frappe's ORM only manages **one** level of
child tables. When `Crop Scouted` is saved, Frappe tears down and rebuilds its
`Pest Filter` rows — sometimes under fresh `name`s — but it has no knowledge of the
`Pests Stages` rows hanging off those rows. The stages still point at the old
`Pest Filter` row names via `parent`, so they are orphaned and disappear from the
mobile scouting flow. The same defect exists for `Disease Filter → Disease Stages`.

The migrate patch's own docstring admits the limitation: *"Frappe's parent.save()
doesn't cascade into grandchildren."* The current mitigation is a manual repair
script (`doc references/fixes/repair_pest_filter_observations_console.py`) that
re-attaches stages — and has to be re-run roughly daily, every time someone edits a
Crop Scouted record or its filters. This is a symptom fix for an architectural
problem.

### Scope

Only two filters carry the grandchild defect:

| Filter (child of Crop Scouted) | Grandchild table        | Affected? |
| ------------------------------ | ----------------------- | --------- |
| **Pest Filter**                | `stages` → Pests Stages | Yes       |
| **Disease Filter**             | `stages` → Disease Stages | Yes     |
| Predator Filter                | — (flat)                | No        |
| Weed Filter                    | — (flat)                | No        |
| Incident Filter                | — (flat)                | No        |
| Physiological Disorder Filter  | — (flat)                | No        |

This redesign covers **Pest Filter** and **Disease Filter** only. The four flat
filters are single-level child tables that Frappe manages correctly; they remain
inline on the Crop Scouted form and are **not** touched. (`Predator Stages` exists as
a doctype but is not nested under Predator Filter, so it is out of scope.)

## Solution

Convert `Pest Filter` and `Disease Filter` from child tables (`istable: 1`) into
**standalone DocTypes** (`istable: 0`), each carrying a `crop_scouted` **Link** field
back to `Crop Scouted`. Their `stages` tables (`Pests Stages` / `Disease Stages`)
**remain child tables** — but now they are children of a *top-level* document, so
Frappe manages them natively. The grandchild relationship is gone, and with it the
entire class of orphaning bugs.

### Key safety properties

- **Doctype names are unchanged** (`Pest Filter`, `Disease Filter`, `Pests Stages`,
  `Disease Stages`). Every code reference to a doctype *name* stays valid, and the
  underlying tables (`tabPest Filter`, etc.) and their data stay in place.
- **No existing row is renamed.** Existing `Pests Stages` rows already have
  `parent = <filter row name>`, `parenttype = "Pest Filter"`. Because the filter row
  names do not change, those links remain valid — **no stage re-attachment is needed
  during migration.** This keeps the migration low-risk.

## Data model changes

For **each** of `Pest Filter` and `Disease Filter`:

- `istable: 1 → 0`.
- Add field `crop_scouted`: Link → `Crop Scouted`, `reqd: 1`, indexed
  (`search_index: 1`, `in_standard_filter: 1`).
- `autoname: "hash"` — matches the existing hash row names, so no renames occur.
- Add explicit **permissions** (child tables had none; they inherited from the
  parent). Write = `System Manager`, `General Manager` (matching the write gate in
  `thresholds_api.py`); read for general scouting operators.
- Add **Document Links** so the filter form surfaces its crop and the Crop Scouted
  form surfaces its filters (Connections tab).

On **Crop Scouted**:

- Remove the `pests` and `diseases` Table fields and their section breaks
  (`section_break_pests`, `section_break_diseases`) from `field_order` and `fields`.
- Leave the four flat filters (`predators`, `weeds`, `incidents`,
  `physiological_disorders`) exactly as they are.

The `stages` field on `Pest Filter` / `Disease Filter` and the `Pests Stages` /
`Disease Stages` doctypes are unchanged.

## UI / editing model

The custom dialog editor (`pest_filter_api.py` + the grid hijack in
`crop_scouted.js`) existed only because Frappe cannot render a nested editable grid
inside an expanded grandchild row. Once the filter is standalone, **stages become a
normal inline grid on the Pest Filter form** and the workaround is unnecessary.

- **Retire** `serverscripts/pest_filter_api.py` (`get_pest_filter_stages`,
  `set_pest_filter_stages`) and the hijack logic in
  `doctype/crop_scouted/crop_scouted.js`. Stages are edited inline on the standalone
  Pest Filter / Disease Filter form.
- **Crop Scouted** gets a **Connections** tab (via Document Links) listing
  `Pest Filter` and `Disease Filter`, with an **+ Add** action that pre-fills
  `crop_scouted`. This is how operators create and manage filters per crop.
- The React **Thresholds** settings page (`ThresholdsTab.tsx`, `thresholds-api.ts`)
  is unaffected in shape — it already addresses rows by their `name` (`row`); only the
  backend query changes (see below).

## Migration

Converting `istable` from 1 to 0 drops the `parent` / `parenttype` / `parentfield`
columns, so ordering matters. A single **pre-model-sync** patch
(`upande_scp.patches.v1_0.promote_filters_to_standalone`):

1. While `parent` still exists, for each of `tabPest Filter` and `tabDisease Filter`:
   - `ALTER TABLE` to add a `crop_scouted` column (if absent).
   - `UPDATE ... SET crop_scouted = parent WHERE parenttype = 'Crop Scouted'`.
2. Model sync then flips `istable` and drops `parent` — the crop link is already
   preserved in `crop_scouted`.

`Pests Stages` / `Disease Stages` rows need **no** changes. The patch is idempotent
(skips a table whose `crop_scouted` is already populated) and logs row counts.

After this patch ships and runs:

- `upande_scp.patches.v1_0.migrate_pest_stages_to_pest_filter` is obsolete — remove
  it from `patches.txt` (leave the already-run history intact) and delete the module.
- The repair/diagnose console scripts under `doc references/fixes/` are deleted (the
  daily run is no longer needed).

## Read / write sites to update

From the full codebase sweep. All changes are mechanical: replace the
"child of crop" filter with the `crop_scouted` Link filter. The
`Pests Stages` / `Disease Stages` sub-queries (`parenttype = 'Pest Filter'`,
`parent IN (...)`) are **unchanged**.

Swap `parent = <crop> AND parenttype = 'Crop Scouted'` → `crop_scouted = <crop>` in:

- `serverscripts/thresholds_api.py` (`list_crops`, `get_thresholds`)
- `serverscripts/scouting_metrics.py`
- `serverscripts/dashboard_aggregates/_common.py`
- `serverscripts/mobile/get_observations_details.py`
- `serverscripts/get_scouting_report.py`
- `serverscripts/cache_utils.py` (`load_pests_with_stages`, invalidation map)

Seeding scripts switch from `doc.append("pests", ...)` to creating standalone
`Pest Filter` docs with `crop_scouted` set:

- `serverscripts/populate_avocado.py`
- `doc references/create_avocado_crop.py`

`hooks.py` `doc_events` keys stay (doctype names unchanged); verify the cache
invalidator resolves the crop via `crop_scouted` rather than `parent`.

## Lifecycle & edge cases

- **Delete cascade:** child tables are auto-deleted with their parent; standalone docs
  are not. Add `Crop Scouted.on_trash` (controller hook) to delete its `Pest Filter` /
  `Disease Filter` docs, which then cascade to their stages natively.
- **Fixtures:** standalone filters can now be exported as fixtures *with* their stages
  (Frappe exports child tables with the parent doc) — a bonus fix for the seeding path,
  which previously also lost grandchildren. If filters should ship as fixtures, add
  `Pest Filter` / `Disease Filter` to `hooks.fixtures`.

## Testing

- **Migration test:** seed a crop with filters + stages as child rows, run the patch,
  assert `crop_scouted` is populated and every stage is still attached by name.
- **Regression test (the actual bug):** save a Crop Scouted and re-save a Pest Filter
  repeatedly; assert the stages survive. This is the scenario that fails today.
- **Read-path smoke tests:** mobile observation details, thresholds get/save, scouting
  metrics, dashboard aggregates — all return the same shape after the query swap.

## Out of scope

- The four flat filters (Predator, Weed, Incident, Physiological Disorder).
- `Predator Stages` (not nested under Predator Filter).
- Any change to the Pests Stages / Disease Stages field set.
