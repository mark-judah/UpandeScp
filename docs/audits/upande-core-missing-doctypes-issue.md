# Shared and external DocTypes/fields required by upande_scp and upande_livestock

## Goal

`upande_core` should be the single base app that holds every shared and external
DocType the SCP and Livestock apps depend on. The target is:

> Installing `upande_scp` (or `upande_livestock`) should require only
> `upande_core`, ERPNext, and Frappe for all modules to run independently.

Today neither app can do that: they still depend on DocTypes that live nowhere
in `upande_core` (they were provided by the retired `upande_kaitet`), and some
shared DocTypes that already exist in `upande_core` are missing fields the apps
read. This issue lists everything `upande_core` needs to add or extend.

Note on scope: everything else the two apps use resolves to ERPNext/Frappe core.
No other Upande or third-party app is required.

Simple naming/spelling differences (listed at the end) will be aligned on the
app side and are not part of this issue.

---

## A. Shared DocTypes already in core that are missing fields

These DocTypes exist in `upande_core` but do not yet carry fields the apps read.
Since they are now shared and owned by core, the fields should be added here.

### Farm (upande_scp)
- `kephis_farm_id` (Data) - read by the weekly report (`send_fcm_weekly_excel_report`).
  Add if the KEPHIS id must appear on the report; otherwise the app can drop it.
- Note: `farm` vs `farm_name`. Core uses `farm_name`; SCP will align its reads to
  `farm_name` on the app side, so no core change is needed for the name itself.
  Keep `name` stable on any data migration (existing rows are named by the old
  `farm` value and are referenced as Link values across SCP).

### Bed (upande_scp)
Core `Bed` models a single bed; SCP overloads `Bed` to also represent rows
(`unit_type = Row`) and to carry variety/area data. Core needs either these
fields, or an agreed mapping of SCP's row-as-bed model onto core's separate `Row`.
- `unit_type` (Select: Bed / Row) - used to distinguish rows from beds
  (`run_tree_automation`, `get_model_trees`, `scouting_metrics`).
- `variety` (Link -> Item) - `get_scouting_report`, `get_beds_and_zones`, `scouting_metrics`.
- `total_variety_area` (Float) - `get_scouting_report`.

### Orchard Tree (upande_scp)
Core `Orchard Tree` is modelled on `Row`/`Triad`; SCP's is modelled on
`Bed`(as row)/`block`. Core needs these fields, or an agreed mapping.
- `block` (Link -> Warehouse) - `get_orchard_trees` filters on `block`.
- `is_model` (Check) - `get_model_trees` selects model trees.
- `tree_code`, `tree_number` (Data).
- `row` currently links to `Bed` in SCP vs `Row` in core - reconcile the link target.

### Zone (upande_scp)
Effectively aligned; only naming/type differences, handled on the app side.

---

## B. External DocTypes missing from core entirely (must be added)

These were provided by `upande_kaitet` and are not in `upande_core`. Without them
the apps cannot run on a core-only install. They belong in core as shared base
DocTypes.

### Employee Request (upande_scp) - child table (istable = 1)
Used as the `custom_employee_data` child on Stock Entry (store-keeper transfer flow).
- `employee` (Link -> Employee)
- `employee_name` (Data)

### Biometric Data (upande_scp) - child table (istable = 1)
Used as the `custom_biometric_data` child on Stock Entry (biometric-authorized submit).
- `employee` (Link -> Employee)
- `employee_name` (Data)
- `biometric_id` (Data)

### Biometric Logs (upande_scp) - standard DocType
Read-only by SCP for live finger-scan verification (`store_keeper_api`). Rows are
written by the biometric-device integration, but the DocType definition must exist
in core so a core-only install does not error.
- `employee` (Link -> Employee or Data)
- `employee_name` (Data)
- `biometric_id` (Data)
- `time` (Datetime)

### Feeding Ration Item (upande_livestock) - child table (istable = 1)
Used as the `ration_items` child on Herds.
- `item_code` (Link -> Item)
- `qty` (Float)
- `uom` (Link -> UOM)

### CFU Inspection Item (upande_livestock) - child table (istable = 1)
Used as the `inspection_items` child on Milking Palour Checksheet.
- `equipment` (Data)
- `part_name` (Data)
- `parameter_checked` (Data)
- `status` (Select)
- `notes` (Small Text)

---

## C. Supporting custom fields on core DocTypes

`upande_core` already ships `Warehouse.custom_farm` (Link -> Farm). It should also
ship the Stock Entry custom fields that bind the external DocTypes above:
- `Stock Entry.custom_employee_data` -> Table of Employee Request
- `Stock Entry.custom_biometric_data` -> Table of Biometric Data
- `Stock Entry.custom_biometric_verified` (Check) - read by SCP after biometric submit

---

## D. Handled on the app side (not part of this issue)

These are simple naming/spelling differences that SCP will align to core:
- `Bed.bed__area` (double underscore) -> core `bed_area`
- `Zone.raw_geojson` / `Orchard Tree.raw_geojson` -> core `geojson`
- `Farm.farm` reads -> core `farm_name`

---

## Acceptance criteria

- `upande_core` provides the missing external DocTypes: `Employee Request`,
  `Biometric Data`, `Biometric Logs`, `Feeding Ration Item`, `CFU Inspection Item`,
  with the fields above.
- The shared DocTypes `Farm`, `Bed`, `Orchard Tree` carry the fields listed in
  section A (or an agreed mapping is documented).
- The Stock Entry custom fields in section C exist and target the new DocTypes.
- A clean install of `upande_core` + `upande_scp` (and `upande_core` +
  `upande_livestock`), with only ERPNext and Frappe otherwise, installs and runs:
  store-keeper transfer, biometric submit, scouting/map, herds, and milking parlour
  flows all work end to end.
