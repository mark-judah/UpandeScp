# Chemical & Foliar DocTypes + Crop-Protection Settings — Design Spec

Date: 2026-07-22
Status: Approved for planning
App: `upande_scp` (Frappe/ERPNext v15, site `kaitet.local`)

## 1. Problem & motivation

Chemicals are modelled as ERPNext `Item` records in item_group `CHEMICALS`
(and case-variants), with ~17 `custom_*` fields on `Item` carrying all
agronomic/safety/regulatory metadata. Costs of the status quo:

1. **Permissions** — editing chemical metadata needs `Item` *write* permission.
   Agronomists / store staff should manage chemical properties without it.
2. **Standalone SCP** — SCP should own its chemical domain, not depend on custom
   fields bolted onto a shared ERPNext doctype.
3. **Room to grow** — no home for PHI, formulation, registration no., MRL.
4. **Per-crop behaviour** — the same product can have different label rates and
   different pest/disease targets on Rose vs Coffee vs Avocado.
5. **Fragility** — the "is this a chemical?" test is scattered across ~7 files
   as case-inconsistent `item_group in ("CHEMICALS"/"Chemicals"/"Chemical"…)`
   string matching.
6. **Foliars** — foliar feeds go into tank mixes too but aren't modelled at all.
7. **Hardcoded groups** — which item groups hold crop-protection products is
   hardcoded, not configurable.

**Hard constraint:** stock/procurement/accounting stay entirely on `Item`
(quantity is ERPNext `Bin`; BOM tank-mix lines, Work Orders, Stock Entries,
reorder keep pointing at Item). We do **not** move stock off Item.

## 2. Decisions (from brainstorming)

- Two SCP-owned sidecar masters, each 1:1 with an `Item`: **`Chemical`** and
  **`Foliar`**. Foliar **mirrors** Chemical's shape (metadata + per-crop
  override profiles).
- Per-crop **rates & targets** via standalone override-profile doctypes
  (`Chemical Crop Profile`, `Foliar Crop Profile`), mirroring the existing
  `Pest Filter`/`Disease Filter` standalone pattern (Frappe can't nest a table
  in a child-table row). PHI/MRL stay product-level.
- **Configurable groups, auto-classified:** the settings doctype holds two lists
  — chemical item groups and foliar item groups. Type is inferred from the
  group (an item in a chemical group → Chemical; in a foliar group → Foliar).
- **Full rename** of the settings Single doctype `Spray Plan Settings` →
  `Scouting and Crop Protection Settings`, reorganised into three tabs:
  **Spray Plan**, **Chemicals**, **Scouting**.
- **Clean-cut migration**: copy the 17 Item custom fields into Chemical, repoint
  readers, then drop the Item custom fields.

Rejected: keeping everything on Item; Chemical-as-primary-master (auto-creating
Items); per-crop data as extra child tables on the master (can't nest).

## 3. Data model

### 3.1 `Chemical` (master, module Upande Scp)
- `autoname = field:item` → one Chemical per Item.
- `item` — Link → Item, **unique, reqd** (the stock/procurement record).
- `chemical_name` — Data, fetched from `item.item_name`.
- `type` — Select: Insecticide / Fungicide / Adjuvant / pH Buffer.
- `active_ingredients` — Table → `Active Ingredient`.
- `toxicity` — Select: I / II / III / IV (WHO class).
- `reentry_interval_hrs` — Float.
- **`phi_days`** — Float (new, pre-harvest interval).
- **`formulation`** — Data (new).
- **`registration_no`** — Data (new).
- **`mrl`** — Data (new).
- `irac` / `irac_moa`, `frac` / `frac_moa`, `ghs` / `ghs_description` — as today
  (Table MultiSelect → IRAC/FRAC/GHS Code Filter + text).
- `low_stock_threshold` — Float.
- `default_lower_rate_limit` / `default_upper_rate_limit` — Float, per 1000 L.
- `default_targets` — Table → `Chemical Targets`.
- `default_requirements` — Table → `Chemical Requirements`.

### 3.2 `Chemical Crop Profile` (standalone, module Upande Scp)
- `autoname = hash`; `chemical` — Link → Chemical (reqd); `crop` — Link →
  Crop Scouted (reqd); unique (chemical, crop) in controller.
- `lower_rate_limit` / `upper_rate_limit` — per-crop override.
- `targets` — Table → `Chemical Targets`; `requirements` — Table →
  `Chemical Requirements`.
- Surfaced on the Chemical form via `links` (group "Crop Configuration").

### 3.3 `Foliar` (master) & `Foliar Crop Profile` (standalone)
Structurally identical to §3.1 / §3.2 (mirroring Chemical): `item` (unique),
`foliar_name`, `type`, `active_ingredients`, `toxicity`, `reentry_interval_hrs`,
`phi_days`, `formulation`, `registration_no`, `mrl`, IRAC/FRAC/GHS (typically
blank for foliars but kept for parity/safety data), `low_stock_threshold`,
`default_lower/upper_rate_limit`, `default_targets`, `default_requirements`; and
`Foliar Crop Profile` (foliar + crop, per-crop rate/target overrides).

### 3.4 Reused / new child doctypes
- Reused unchanged: `Active Ingredient`, `Chemical Targets`,
  `Chemical Requirements` (a child doctype may be used by multiple parents —
  they become children of Chemical/Foliar and their profiles).
- New: `Crop Protection Item Group` — child with one Link field `item_group`
  → Item Group; used by the two settings Table-MultiSelect fields.

### 3.5 Resolution rule
`get_product_rate(item_code, crop)` / `get_product_targets(item_code, crop)`
return the matching Crop Profile's values when a profile exists for (product,
crop); otherwise the master's `default_*`. Identical behaviour for products with
no per-crop overrides → trivial, behaviour-preserving migration.

## 4. Settings doctype: rename + tabs (`Scouting and Crop Protection Settings`)

Full rename of the Single `Spray Plan Settings` → `Scouting and Crop Protection
Settings` (§8 covers the mechanics). Reorganised with Tab Breaks:

- **Spray Plan tab** — all existing fields (the default_* accounts, spray flow
  settings, lifecycle toggles, etc.) unchanged, just grouped here.
- **Chemicals tab** — new crop-protection configuration:
  - `chemical_item_groups` — Table MultiSelect → `Crop Protection Item Group`
    (which Item Groups hold chemicals).
  - `foliar_item_groups` — Table MultiSelect → `Crop Protection Item Group`
    (which Item Groups hold foliars).
  - **Export/backfill buttons** (client `add_custom_button`s calling whitelisted
    methods): "Export to Chemicals" iterates every Item under
    `chemical_item_groups` and creates a `Chemical` where missing; "Export to
    Foliars" does the same for `foliar_item_groups`. Idempotent; reports counts.
- **Scouting tab** — scouting-related settings (starts with any existing
  scouting config; a home for future scouting options). May be minimal in v1.

Note: a group must not appear in both lists; controller `validate` guards
against overlap (auto-classification must be unambiguous).

## 5. Config-driven "is-chemical / is-foliar" test

New helper module `serverscripts/common/crop_protection.py`, reading the
settings lists (cached):
- `chemical_groups()` / `foliar_groups()` — configured Item Group names.
- `is_chemical(item_code)` / `is_foliar(item_code)` — a `Chemical`/`Foliar`
  links to the item.
- `get_chemical(item_code)` / `get_foliar(item_code)` — cached master fetch.
- `get_product_rate(item_code, crop)` / `get_product_targets(item_code, crop)` —
  §3.5 resolution (works for either type).
- `crop_protection_item_codes(kind=None)` — Item codes under the configured
  chemical/foliar groups (replaces the `item_group IN (...)` stock filters).

The scattered `_CHEMICAL_GROUPS` string tests are replaced by these helpers.
`item_group` is used only via the configured lists (for stock aggregation and
the auto-ensure hook), never as a hardcoded literal.

Scope: v1 covers **Chemicals** and **Foliars**. **Fertilizers** and the
**`Chemical Mix`** tank-mix output items are **out of scope** (no sidecar record
created). Foliars are now valid tank-mix components (create_bom must accept
both chemical and foliar groups as mix inputs — §6).

## 6. Read-refactor sites (repoint Item → Chemical/Foliar, config groups)

Via the §5 helpers:
- `spray_plan_creator/settings.py` — `_CHEMICAL_GROUPS`, `_kind_of`,
  `list_chemicals` (assemble from Chemical; add a parallel foliar path).
- `store/create_bom.py` — rate-limit enforcement resolves per-crop rate via
  `get_product_rate(item, crop)`; the `{"item_group": "CHEMICALS"}` / mix-input
  filters use `crop_protection_item_codes` and now include foliar groups.
- `store/store_keeper_api.py` — chemical-stock aggregation via
  `crop_protection_item_codes`.
- `scouting/get_scouting_report.py`, `scouting/scouting_metrics_api.py` —
  item_group filters.
- `spray_plan_ops/validate_frac_irac_guidelines.py` — codes from the master;
  per-crop targets from the profile.
- `frontend/src/lib/settings-api.ts` — read/write chemical (and foliar) settings
  via the new endpoints; `list_chemicals` keeps its response shape.
- `public/js/item.js` — remove the chemical-field visibility toggle (fields gone
  from Item); add the auto-create modal (§7).

## 7. Auto-create on Item creation (hook + modal)

- **Server (authoritative, all creation paths incl. import/API):** `Item`
  `after_insert` → if `item_group` ∈ `chemical_groups()` and no Chemical exists,
  create a stub `Chemical` linked to the Item; else if ∈ `foliar_groups()`,
  create a stub `Foliar`. Guard excludes `Chemical Mix`/fertilizer groups.
  Registered in `hooks.py` `doc_events`.
- **Client (desk UX):** on saving a new Item whose group is configured, a modal
  announces "Registered as Chemical/Foliar" with **[Open record]** (to fill
  metadata) and **[Not one — remove]** (deletes the stub) actions. Because
  classification is by group, the modal confirms rather than asks.

## 8. Full doctype rename (Spray Plan Settings → Scouting and Crop Protection Settings)

Single doctype rename — mechanics:
1. Rename the doctype dir `doctype/spray_plan_settings/` →
   `doctype/scouting_and_crop_protection_settings/`, the JSON `name`, and the
   controller class; update `field_order` with the three Tab Breaks.
2. Patch (post-model-sync) calling
   `frappe.rename_doc("DocType", "Spray Plan Settings",
   "Scouting and Crop Protection Settings", force=True)` — migrates `tabSingles`
   rows (the Single's stored values) automatically.
3. Grep-and-replace every string reference across the app:
   `frappe.get_single(...)`, `get_doc("Spray Plan Settings")`,
   `get_single_value("Spray Plan Settings", ...)`, fixtures, hooks, workspace
   links, client scripts (known consumers include `auto_material_issue.py` and
   the spray flow settings/diagram). Enumerate with
   `grep -rn "Spray Plan Settings"` and fix each.
4. Update any Workspace shortcut / navbar label to the new name.

Risk: missed references throw at runtime → mitigate with an exhaustive grep and
a test that loads the Single and exercises `auto_material_issue`.

## 9. Migration (clean cut) + config seeding

Patch `patches/v1_0/introduce_chemical_foliar_doctypes.py`:
1. **Seed config** so nothing breaks day one: put today's chemical item-group
   variants (`CHEMICALS`, `AVOCADO CHEMICALS`, …) into the new
   `chemical_item_groups`; leave `foliar_item_groups` empty for the user to set.
2. For each Item under the configured chemical groups, create a `Chemical` and
   copy: `custom_type`→type; `custom_toxicity`→toxicity;
   `custom_reentry_interval_hrs`→reentry_interval_hrs;
   `custom_lower/upper_rate_limit`→default_lower/upper_rate_limit;
   `custom_low_stock_threshold`→low_stock_threshold;
   `custom_active_ingredients`→active_ingredients;
   `custom_targets`→default_targets;
   `custom_chemical_intervention_threshhold`→default_requirements;
   `custom_irac/frac/ghs`(+moa/description)→irac/frac/ghs(+…). New fields blank.
3. **No** Crop Profiles created (defaults preserve behaviour).
4. After readers are repointed (§6) and verified, **remove the 17 Item custom
   fields** from `fixtures/custom_field.json` + `hooks.py` export and drop the
   columns (same release).

Ordering: rename settings + create doctypes + seed config + create Chemicals →
repoint readers → remove Item custom fields. Foliars have no legacy data, so
they're created going forward via the hook / Export button.

## 10. Permissions & connections
- `Chemical`, `Chemical Crop Profile`, `Foliar`, `Foliar Crop Profile`:
  read/write for `SCP General Manager` + `SCP Chemical Store Keeper`; full for
  `System Manager`. No `Item` write needed to edit metadata.
- Connections: master forms list their Crop Profiles (`links`); the Item form
  gets a dashboard entry (`override_doctype_dashboards`) to its Chemical/Foliar
  via `link_fieldname = item`.

## 11. Risks & mitigations
- **Reader coverage** — grep each `custom_*` field name before dropping columns;
  helper module centralises access.
- **Settings rename fallout** — exhaustive `grep -rn "Spray Plan Settings"`; the
  rename patch + a smoke test of `auto_material_issue`.
- **create_bom crop context** — confirm the crop is available at rate
  enforcement; fall back to master defaults if absent.
- **Group overlap** — controller validation forbids a group in both lists.
- **1:1 integrity** — unique `item` autoname + auto-ensure hook + validation.

## 12. Out of scope (v1)
- Fertilizers and `Chemical Mix` items (no sidecar).
- Per-crop PHI/MRL (product-level; movable to profiles later).
- Any change to stock/Bin/BOM/Work Order/Stock Entry mechanics.
- Deduping the historical item_group label variants (separate cleanup).

## 13. Testing
- Unit: `is_chemical`/`is_foliar`, `get_product_rate`/`targets` (profile vs
  default), auto-ensure hook (fires per configured group; not for mix/
  fertilizer), group-overlap validation, 1:1 uniqueness.
- Migration: on a kaitet copy, every chemical Item gets a Chemical with matching
  copied values + child rows; config seeded; counts reconcile.
- Rename: Single loads under the new name; `auto_material_issue` and spray-flow
  settings still resolve.
- Regression: `create_bom` rate enforcement (incl. foliar mix inputs) and
  `validate_frac_irac` behave using resolved values; store-keeper stock returns
  the same products.
- Frontend: Chemicals settings tab (group selectors + Export buttons) works;
  `list_chemicals` shape unchanged.
