# Scouting & Crop Protection tab on shared doctypes — Design (v3)

**Date:** 2026-07-21
**Status:** Approved (design), pending implementation plan
**Scope:** Give five shared doctypes one dedicated "Scouting and Crop Protection"
tab holding all of upande_scp's crop-protection/scouting custom fields.
Form-layout only — no field renames, type changes, data, or behavior changes.

> **History.** v1 (edit the shipped fixture subset + trailing tab) FAILED
> verification and was rolled back — the shipped `custom_field.json` is a
> curated subset, every custom field has `module=None`, and fields are
> cross-app `insert_after`-chained, so a subset-built tab swept foreign fields
> in. v2 switched the mechanism to a code-driven full-layout enforcer. v3
> replaces the earlier name-guess classification with an evidence-based one.

## How SCP fields were determined (classification method)

`module` is null on every custom field, so it gives no ownership signal. The
authoritative signal used is **cross-app code reference, disambiguated by
doctype**: a field belongs to SCP iff `upande_scp` code references it for that
doctype and no other app (`upande_ta`, `upande_livestock`, `upande_core`,
erpnext/frappe) owns it there. Concretely:

- Every field upande_scp **ships** in its fixture for a doctype is SCP (it is
  also, in every case, referenced by SCP code — the two signals agree).
- A **non-shipped** field is SCP only if SCP code references it *for that
  doctype* and no other app does. This admitted four extra fields
  (`custom_chemical_scans`, `custom_spray_application_logsheet` on Work Order;
  `custom_work_order` on BOM; `spray_plan_approvers` on Farm).
- **Name collisions across doctypes were checked by reading the usage sites.**
  Item's `custom_greenhouse` and `custom_application_rate` matched SCP code
  only because same-named fields exist on Work Order / BOM Item; nothing in SCP
  touches *Item*'s copies, so both are excluded from Item.
- A field referenced by another app on the same doctype is excluded even if SCP
  ships/uses it elsewhere: `custom_farm` (BOM/Warehouse) is core/livestock/ta
  shared → excluded. `custom_cost_center` (Work Order/Warehouse) is SCP-owned
  there (the livestock hit is a same-named field on a livestock doctype) → kept.

Name-based guessing (FRAC-sounds-like-chemistry etc.) is explicitly NOT used;
fields like `custom_formulation`, `custom_recommended_use`, `custom_spray_interval`,
`custom_hydrolysis_rate`, `custom_is_ppe`, `custom_ppe_lifespan` have no SCP
code reference and are excluded.

## Classification (final SCP tab membership per doctype)

Everything else on each doctype (all standard fields + every custom field not
listed here) stays outside the tab.

### Item — 16 (+ tab break)
custom_type, custom_frac, custom_frac_moa, custom_irac, custom_irac_moa,
custom_ghs, custom_ghs_description, custom_toxicity, custom_reentry_interval_hrs,
custom_active_ingredients, custom_targets, custom_lower_rate_limit,
custom_upper_rate_limit, custom_low_stock_threshold, custom_section_break_vuei1,
custom_chemical_intervention_threshhold.
(All 16 are the fields SCP ships for Item. No other Item custom field is
SCP-owned by the code signal.)

Item tab order: custom_type, custom_frac, custom_frac_moa, custom_irac,
custom_irac_moa, custom_ghs, custom_ghs_description, custom_toxicity,
custom_active_ingredients, custom_targets, custom_reentry_interval_hrs,
custom_lower_rate_limit, custom_upper_rate_limit, custom_low_stock_threshold,
custom_section_break_vuei1, custom_chemical_intervention_threshhold.

### Work Order — 25
custom_type, custom_classification, custom_preventive_reason,
custom_application_floor_plan, custom_greenhouse, custom_reentry_period_hrs,
custom_cost_center, custom_rate_overridden, custom_weather_snapshot,
custom_scheduled_application_time, custom_reentry_time, custom_scope,
custom_scope_details, custom_area, custom_water_volume, custom_water_ph,
custom_water_hardness, custom_variety, custom_spray_type, custom_kit,
custom_targets, custom_spray_team, custom_spray_plan_team_members,
custom_chemical_scans, custom_spray_application_logsheet.
(23 shipped + 2 SCP-code fields. `custom_greenhouse` here IS SCP — unlike
Item's. `custom_cost_center` kept — SCP-owned on Work Order.)

### Warehouse — 6
custom_location, custom_raw_geojson, custom_cost_center, custom_bed_numbering,
custom_zone_numbering, custom_area_ha.

### BOM — 4
custom_item_group, custom_water_ph, custom_water_hardness, custom_work_order.
(`custom_farm` excluded — core/livestock/ta-shared.)

### Farm — 5
custom_chemical_store, custom_fertilizer_store, spray_plan_creators,
store_keepers, spray_plan_approvers.

## Approach: an after_migrate layout enforcer

A single function shipped in app code and registered on `after_migrate` (so it
runs after fixture sync and is authoritative for layout). Per doctype, using
the hard-coded classification above, it:

1. **Ensures the tab break exists** — a `Tab Break` custom field
   `custom_scouting_and_crop_protection_tab`, label `Scouting and Crop
   Protection`. Item's already exists (keep it + its
   `depends_on: eval:doc.item_group=='CHEMICALS'`); the other four are created
   if missing (`depends_on` null, `module` null, `is_system_generated` 0),
   cloning the shape of Item's row.
2. **Detaches foreign fields from the SCP block** — any custom field NOT in the
   doctype's SCP set whose `insert_after` points at an SCP field (or the tab
   break) is re-pointed to the nearest preceding non-SCP field in the current
   order, so it keeps its vicinity and does not trail into the tab.
3. **Anchors the tab as a trailing tab** — `tab.insert_after` = the last field
   (current meta order) not in the SCP set.
4. **Chains the SCP fields** in the doctype's defined order (first → tab break,
   each next → previous SCP field).
5. **Saves** only custom-field docs whose `insert_after` changed, then
   `frappe.clear_cache(doctype=dt)`.

Idempotent (re-run changes nothing when already correct); touches only
`insert_after`; never a field's content or a standard field.

## Excluded doctypes

`BOM Item`, `Work Order Item` (child tables — no tabs), `Spray Team`
(upande_scp's own), all upande_ta doctypes.

## Delivery

- New module `upande_scp/serverscripts/common/scouting_tab_layout.py` holding
  the enforcer + classification map.
- Register on `after_migrate` in `hooks.py` (append to the existing list).
- No `fixtures/custom_field.json` or hooks-filter change (v1's fixture edits
  were reverted).
- Apply with `bench --site kaitet.local migrate`.

## Verification

- `bench migrate` clean.
- Meta-walk check per doctype: exactly one Scouting tab break; every SCP field
  resolves to it (zero orphans); NO non-SCP field resolves to it (zero
  intruders). All five PASS.
- Idempotency: a second enforcer run reports zero fields changed.
- Manual Desk smoke: Item, Work Order, Warehouse, BOM, Farm each show one
  "Scouting and Crop Protection" tab with exactly the classified fields;
  foreign fields stay put; Item's tab still gates on CHEMICALS.

## Risks

- Classification is hard-coded (module=None). A misclassification shows in the
  wrong tab — caught by the intruder/orphan verification + Desk smoke.
- Foreign-field re-pointing touches a few non-SCP fields' `insert_after` (only
  those chained onto SCP fields) — layout-only, re-anchored to their nearest
  preceding non-SCP field.
- Runs every migrate — idempotent, 5 doctypes, negligible cost, saves only
  changed docs.

## Out of scope

- Field renames, type/option/`depends_on`/validation changes, removals.
- Non-classified custom fields' membership.
- Child-table doctypes, Spray Team, upande_ta.
