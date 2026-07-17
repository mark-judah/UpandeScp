# Extend shared farm-structure DocTypes for upande_scp (Bed, Orchard Tree, Triad)

Supersedes #5. This is the refined, core-only scope. Biometric/employee DocTypes
now move to `upande_ta` (tracked in a separate Upande-TA issue), and
`Feeding Ration Item` stays in `upande_livestock`, so they are no longer part of
this issue.

## Goal

`upande_core` is the shared base app for the farm/greenhouse structure. Installing
`upande_scp` should require only `upande_core`, `upande_ta`, ERPNext, and Frappe.
This issue covers the shared structure DocTypes in core that need extra fields so
SCP can run on core's versions instead of its own.

## Farm - no change needed

Resolved. SCP will align on its side:
- SCP's display field `farm` maps to core `farm_name`.
- SCP's `kephis_farm_id` maps to core `farm_code`.

Keep `name` stable on any data migration (existing rows are named by the old
`farm` value and are referenced as Link values across SCP).

## Bed - add fields

Core `Bed` models a single bed. SCP also uses `Bed` to represent rows
(`unit_type = Row`) and to carry variety data. Add:
- `unit_type` (Select: Bed / Row) - distinguishes rows from beds
  (`run_tree_automation`, `get_model_trees`, `scouting_metrics`).
- `variety` (Link -> Item) - `get_scouting_report`, `get_beds_and_zones`, `scouting_metrics`.

`total_variety_area` is not needed: core `bed_area` is the variety area, and SCP
will read `bed_area` instead of `total_variety_area`.

Reconcile the `Bed` autoname with `unit_type` so row/bed naming stays correct
(core uses `format:{greenhouse} - Bed {bed}`; with `unit_type` it can follow
`format:{greenhouse} - {unit_type} {bed}`).

## Orchard Tree - add fields and reconcile hierarchy

Core `Orchard Tree` is modelled on `Row`/`Triad`; SCP's is modelled on
`Bed`(as row)/`block`. Add:
- `block` (Link -> Warehouse) - `get_orchard_trees` filters on `block`.
- `is_model` (Check) - `get_model_trees` selects model trees.
- `tree_code` (Data), `tree_number` (Data).

Reconcile the `row` link target (SCP links `Orchard Tree.row` to `Bed`; core links
it to `Row`).

Hierarchy change (agreed): `Triad` is at the same level as `Zone`/`Tree`, so adjust
the model accordingly.

## Zone - no change needed

Aligned. SCP will read core `geojson` in place of its `raw_geojson`, and treat
`zone` as core defines it.

## Handled on the SCP side (not part of this issue)

Simple naming/spelling differences SCP will align to core:
- `Bed.bed__area` (double underscore) -> `bed_area`
- `Zone.raw_geojson` / `Orchard Tree.raw_geojson` -> `geojson`
- `Farm.farm` -> `farm_name`, `kephis_farm_id` -> `farm_code`

## Acceptance criteria

- Core `Bed` carries `unit_type` and `variety`; autoname reconciled.
- Core `Orchard Tree` carries `block`, `is_model`, `tree_code`, `tree_number`; `row`
  link target reconciled; `Triad` positioned at the Zone/Tree level.
- A clean install of `upande_core` + `upande_scp` (+ `upande_ta`), with only ERPNext
  and Frappe otherwise, runs the scouting, map, and tree-automation flows end to end.
