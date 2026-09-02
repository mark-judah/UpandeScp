# SCP staging deployability + Spray Product consolidation

**Date:** 2026-09-02
**Status:** approved, ready for implementation

## Problem

`upande_scp` was installed on `kaitetv16-staging.nbg.frappe.cloud` and key
functionality failed. Every failure traces to the same root cause class: the app
depends on facts that exist on `kaitet.local` by accident of history, and does
not create or derive them on a fresh site.

Verified live against staging (not inferred):

| Symptom (user-reported) | Verified cause |
| --- | --- |
| Spray plan does not pick up the area | `get_beds_by_greenhouse` → `1054 Unknown column 'custom_active' in 'WHERE'` |
| `1054 Unknown column 'workflow_state'` on a draft spray plan | `Work Order.workflow_state` does not exist on staging |
| "Failed to load work orders" when approving | `get_pending_work_orders` → same `workflow_state` 1054 |
| `Rate must be > 0 for 'Acrecio' (row #1)` | Frontend/backend payload mismatch; the BOM modal has no rate field at all |
| QR codes minted for every Material Transfer for Manufacture | `issue_for_stock_entry` gates on `purpose` only, never on the Work Order being an AFP |
| All farms visible in loaning / historical / tank mixes | Three endpoints apply no farm scope |
| Item leaving a configured item group keeps its Chemical record | Only `after_insert` is hooked on Item |

Alongside these, the chemical/foliar data model duplicates every field across two
master doctypes and two per-crop override doctypes.

## Evidence

```
POST /api/method/…spray_plan_approval.get_pending_work_orders
  → MySQLdb.OperationalError: (1054, "Unknown column 'workflow_state' in 'WHERE'")

POST /api/method/…scouting_metrics_api.get_beds_by_greenhouse
  → MySQLdb.OperationalError: (1054, "Unknown column 'custom_active' in 'WHERE'")
```

Staging `Custom Field` census:

- `Work Order.workflow_state` — absent
- `Farm.spray_plan_approvers` — absent (`custom_chemical_store`,
  `custom_fertilizer_store`, `spray_plan_creators`, `store_keepers` present)
- `Bed.custom_active` — absent; staging carries `Bed.status`
  (`Empty | Planted | Producing | Harvesting | Transplanted | Uprooted`) instead
- `Spray Team.custom_farm` — present as a Custom Field on an app-owned doctype

Staging `Bed` data: 20,469 rows; 17,476 with `bed_area > 0`; status counts
Planted 11,874, Empty 7,679, Uprooted 2.

`kaitet.local` record counts: `Chemical` 479, `Foliar` 233,
`Chemical Crop Profile` 0, `Foliar Crop Profile` 0, `Crop Scouted` 3.

The zero crop-profile counts are what make section 1 cheap: the per-crop override
doctypes carry no data anywhere, so consolidating them migrates nothing.

## Design

### 1. `Spray Product` — one doctype for chemicals and foliars

Rename `Chemical` → `Spray Product`. The 479 existing records keep their names
(`autoname: field:item` is unchanged), so nothing that links to them by name
breaks.

New fields:

| Field | Type | Notes |
| --- | --- | --- |
| `category` | Select `Chemical`\|`Foliar` | Backfilled `Chemical` for all 479 existing rows |
| `crop_rates` | Table → `Spray Product Crop Rate` | Replaces both Crop Profile doctypes |
| `disabled` | Check | Set when the item leaves a configured item group (section 5) |

`Spray Product Crop Rate` (child, `istable: 1`):

| Field | Type |
| --- | --- |
| `crop` | Link → Crop Scouted |
| `lower_rate_limit` | Float |
| `upper_rate_limit` | Float |

Rate resolution order, unchanged in spirit: the `crop_rates` row for the crop,
falling back to the product's `default_lower_rate_limit` /
`default_upper_rate_limit`. Both `default_*` fields stay — they are the answer
for a product with no per-crop row, which is every product today.

Targets and requirements stay at product level (`default_targets`,
`default_requirements`). They are not per-crop. Frappe cannot nest a table inside
a table, so per-crop targets would require reintroducing a linked profile
doctype — the exact structure being removed.

Migration:

1. Rename the `Chemical` doctype to `Spray Product`.
2. Set `category = "Chemical"` on every existing row.
3. Copy the 233 `Foliar` records in with `category = "Foliar"`, including their
   child tables (`active_ingredients`, `default_targets`,
   `default_requirements`, `irac`, `frac`, `ghs`).
4. Delete the `Foliar`, `Chemical Crop Profile` and `Foliar Crop Profile`
   doctypes.

`serverscripts/common/crop_protection.py` collapses:

- `_PRODUCTS` and `_master_for` are deleted — there is one master doctype.
- `is_chemical` / `is_foliar` → `is_spray_product(item_code, category=None)`.
- `get_chemical` / `get_foliar` → `get_spray_product(item_code)`.
- `get_product_rate`, `get_product_targets`, `get_product_type`,
  `get_product_codes`, `get_reentry_interval_hrs` lose their two-doctype loop.

The `chemical_item_groups` / `foliar_item_groups` settings tables are unchanged.
They are what assigns `category`, and remain the data-driven source of truth for
which Item Groups hold which kind of product.

`is_foliar_group(item_group)` keeps its current meaning and callers — the
chemical-vs-fertilizer split still decides which warehouse list a row gets.

### 2. Custom fields become declarative; `custom_field.json` is deleted

`upande_scp/fixtures/custom_field.json` holds 45 fields across BOM, BOM Item,
Farm, Item, Notification Log, Warehouse, Work Order and Work Order Item. A
fixture only restores what some site last exported, so a field that was never
exported — or was deleted anywhere — is absent on every fresh install. That is
precisely how `workflow_state` and `spray_plan_approvers` went missing.

The repo already solved this once, for Stock Entry, and states why in
`serverscripts/store/stock_entry_fields.py`:

> Why declarative rather than a fixture: a fixture only restores what was last
> exported from some site's database, so a field deleted anywhere is gone until
> somebody re-exports. Declaring fields here means a reset-to-defaults, a fresh
> install and a new site all converge.

Generalise that module into `serverscripts/common/custom_fields.py`:

- Owns all 45 current fixture fields plus `Work Order.workflow_state` and
  `Farm.spray_plan_approvers`.
- Keeps `stock_entry_fields.py`'s spec-is-truth reconciliation: an SCP-owned
  Custom Field on a managed doctype that is not in the spec is deleted.
- Keeps its two exemptions: the layout tab break, and any fieldname owned by an
  ERPNext Accounting Dimension.
- Runs on `after_migrate`, before `scouting_tab_layout.enforce`.

Then delete `custom_field.json` and remove `Custom Field` from `fixtures` in
`hooks.py`.

`Work Order.workflow_state` is declared as `Data`, read-only, no `options`. It is
deliberately not a Frappe Workflow field: the Workflow was deleted by
`delete_application_floor_plan_workflow` and the app sets and reads the value
itself. The seven `Workflow State` fixture records stay as the value vocabulary.

`Spray Team.custom_farm` does not belong in this module — `Spray Team` is an
app-owned doctype, so it becomes a plain `farm` field in `spray_team.json`, with
a patch copying `custom_farm` → `farm` and deleting the Custom Field.

### 3. Hardcodes

**Farm ↔ greenhouse resolves by link, never by name.**

New `serverscripts/common/farm_map.py` with `farm_for_warehouse(name)` and
`warehouses_for_farm(farm)`, both reading `Warehouse.custom_farm` — the only
warehouse→Farm edge that exists. Replaces:

- `spray_plan_approval.get_pending_work_orders`: `custom_greenhouse LIKE '<farm> GH%'`
- `spray_plan_approval._derive_farm`: splitting the greenhouse name on `" - "`
- `scouting_metrics_api.list_application_work_orders`: both the `" - "` split and
  the `f_low in custom_greenhouse.lower()` substring fallback

**Stores resolve by link, never by name prefix.**

`Farm.custom_chemical_store` and `Farm.custom_fertilizer_store` already exist and
are already the documented mapping. `LIKE 'Chemical Store%'` /
`LIKE 'Fertilizer Store%'` is removed from `loaning._farm_chemical_stores`,
`loaning._all_chemical_farms`, `loaning.capture_baseline_on_receipt`,
`loaning_v2.list_lender_farms` and `loaning_v2`'s store-prefix helper.

The prefix is deleted rather than kept as a fallback. A silent fallback to a
wrong warehouse is worse than an error telling the GM to map the store on the
Farm record.

**Company comes from data.**

`create_bom._resolve_bom_company(farm)` → `Farm.company` →
`Global Defaults.default_company`. Removes `bom_doc.company = "Karen Roses"` in
`create_bom.py` and both literals in `create_application_work_order.py`
(the `template_bom.company != "Karen Roses"` guard and the `"company"` value).
Removes the `or "Roses"` business-unit default in `bom_resolver.py`.

**Tank-mix conventions become settings.**

Two fields on the Scouting and Crop Protection Settings Chemicals tab:

| Field | Type | Default |
| --- | --- | --- |
| `tank_mix_item_group` | Link → Item Group | `Chemical Mix` |
| `tank_mix_uom` | Link → UOM | `Tank Mix (1000L)` |

Both ensured to exist on `after_migrate` (create the Item Group and UOM records
if absent, then set the settings default if unset). Replaces the literals in
`create_bom.py`, `bom_resolver.py`, `spray_plan_creator/bootstrap.py`,
`scouting_metrics_api.py` (two sites) and `scouting/get_scouting_report.py`.

`scouting_tab_layout.CHEMICAL_MIX` reads the setting too, so the BOM tab's
`depends_on` follows configuration.

### 4. Visibility

One rule, in `serverscripts/common/crop_scope.py`:

```
visible_farms(user, roster_field) = roster(user, roster_field) ∩ company_scope(user)
```

- `company_scope` is the existing `allowed_farms()` — Employee → Company subtree
  → Farm.
- `roster` is the user's rows in the named `Farm` child table:
  `spray_plan_creators`, `spray_plan_approvers` or `store_keepers`.
- `None` (unscoped) is returned only for Administrator and System Manager.
  `SCP General Manager` is scoped like everyone else.
- An empty set means nothing is visible — never everything. This preserves
  `crop_scope`'s existing safety property.

Applied to the three leaks:

| Endpoint | Today | After |
| --- | --- | --- |
| `loaning_v2.list_lender_farms` | Every farm with a chemical or fertilizer store | Lender farms within the borrower's company scope, minus the requesting farm |
| `scouting_metrics_api.list_application_work_orders` | Farm/greenhouse dropdowns from a raw SQL `DISTINCT` over all Work Orders, bypassing `permission_query_conditions` | Dropdowns built from the user's visible farms |
| `scouting_metrics_api.list_tank_mixes` | No scope | BOMs filtered to visible farms via `BOM.custom_farm` |

`loaning._user_farms`'s `ELEVATED` bypass is narrowed to Administrator and
System Manager, matching `crop_scope.BYPASS_ROLES`.

React: `Historical.tsx`, `TankMixes.tsx` and `ChemicalLoaning.tsx` hide the farm
`Select` entirely when the returned farm list has one entry.

Borrowing is already correctly constrained by `_assert_farm_access`; it inherits
the narrowed rule for free.

### 5. Item group membership

Add `on_update` to the `Item` `doc_events` hook alongside the existing
`after_insert`:

- Item enters a configured chemical or foliar group → create the `Spray Product`
  if absent (existing `ensure_product_record` path), or clear `disabled` if one
  exists.
- Item leaves every configured group → set `disabled = 1` on its `Spray Product`.
  The record, its rates, its IRAC/FRAC codes and its targets survive; BOMs, past
  spray plans and issued QR labels still resolve.
- Item moves between a chemical group and a foliar group → update `category`.

`disabled = 1` removes the product from `crop_protection_item_codes`, every
product picker, the store dashboards and the reports.

Only `Item.item_group` changes trigger any of this — the hook returns early
otherwise.

### 6. Bed area

`scouting_metrics._bed_active_condition()` probes the schema once per request:

```
has_column("Bed", "custom_active")  → "custom_active = 1"
has_column("Bed", "status")         → "status != 'Uprooted'"
neither                             → no condition
```

No field is added to `upande_core`'s `Bed`. Neither flag is declared there — both
are site-local, and the app must read whichever the site has.

`Empty` beds still count: a bed with no crop in it right now is still part of the
greenhouse being sprayed. Only physically-gone beds are excluded.

The same helper is applied in `scouting/get_scouting_report.py:443`, which reads
Bed rows for the same purpose.

### 7. The BOM modal

`ApplicationPlan.tsx`'s create-BOM dialog has no rate input, and sends
`{item_code, item_name, qty: 1, stock_uom}`. `create_bom.py:112` reads
`chem.get("custom_application_rate")`, which is therefore always absent, so the
modal fails for every user on every site with `Rate must be > 0`.

- Add a rate column to the dialog's chemical table, prefilled from the product's
  `crop_rates` row for the greenhouse's crop, else `default_lower_rate_limit`.
- Validate `> 0` client-side before enabling Create.
- Send `custom_application_rate` in each row.
- Extend `CreateBomArgs.items` in `scouting-api.ts` to carry it.

The server-side rate-limit guard (`create_bom.py:131-155`) is unchanged and now
resolves limits through the `Spray Product` `crop_rates` table.

### 8. QR labels and the Stock Entry tab

`stock_entry_state.on_submit` already reads `wo_type` and returns when it is not
`Application Floor Plan` — at line 121, four lines *after* it calls
`issue_for_stock_entry` at line 116.

- Move the `issue_for_stock_entry(doc)` call below that check.
- Add the same guard inside `chemical_labels.issue_for_stock_entry` and
  `chemical_labels.backfill`, so console, API and backfill callers cannot bypass
  it.
- `scouting_tab_layout.TAB_DEPENDS_ON["Stock Entry"]` gains the AFP condition, so
  the label fields are hidden on non-AFP transfers.

No app-side change. The RN app reads labels (`get_print_jobs`, scan
verification); it never mints them.

## Build order

1. **Section 2** — declarative custom fields. Unblocks both 1054 crashes on
   staging and is a prerequisite for anything that touches those fields.
2. **Section 6** — bed active detection. Restores the area chain.
3. **Section 7** — BOM modal rate. Completes the create-BOM flow.
4. **Section 8** — QR gating. Two-line change, independent.
5. **Section 3** — hardcodes.
6. **Section 4** — visibility.
7. **Section 1** — `Spray Product`. Last, because it touches roughly twenty
   modules and benefits from a green suite underneath it.

## Testing

- New unit tests per section under `serverscripts/tests/`, following the existing
  file-per-concern convention.
- `test_custom_fields.py`: every declared field materialises on migrate; a
  field removed from the spec is pruned; an accounting-dimension field is never
  pruned.
- `test_bed_active_condition.py`: each of the three schema shapes.
- `test_crop_scope.py`: extended for `visible_farms`, including the
  empty-set-means-nothing property and the narrowed GM rule.
- `test_crop_protection.py`: rewritten for the single-doctype resolver, including
  `crop_rates` precedence over `default_*`.
- `test_spray_product_migration.py`: the 233 Foliars land with `category`
  set and their child tables intact.
- Frontend: `vitest` for the BOM modal's rate validation.

The full suite cannot run on `kaitet.local` (pre-existing constraint). Sections
are verified individually against `kaitet.local` and then against
`kaitetv16-staging` via its API token.

## Out of scope

- `custom_business_unit` — an ERPNext Accounting Dimension, already guarded with
  `has_column` where it is written.
- React crop-namespaced routing.
- The 2,993 staging beds with `bed_area = 0` — a data gap, not a code defect.
- Per-crop targets and requirements — deliberately dropped, see section 1.

## Implementation notes carried forward

From `docs/audits/2026-07-22-chemical-foliar-doctype.md` §6, which documented
these while building the doctypes this spec now consolidates:

1. **Doctype rename** — the controller class must equal
   `name.replace(" ", "")` preserving case, so `Spray Product` →
   `class SprayProduct`. A wrong casing makes `get_controller` raise
   `ImportError`, and migrate then **orphan-deletes the doctype on every run**.
2. **`rename_doc` has no `ignore_permissions` kwarg** on v15, and updates child
   rows' `parenttype` but not `parent`.
3. **Deleting a Custom Field does not drop its DB column.** Any field this spec
   removes needs a separate `ALTER TABLE … DROP COLUMN` patch if the column is
   to go.
4. **`Spray Product.name == item code`**, inherited from `Chemical`. Child-table
   queries filtered by `parent` alone double-count Item rows against product
   rows — always filter by `parenttype` as well.

---

# Implementation record

Built 2026-09-02, verified on `kaitet.local`. What shipped, and where it differs
from the design above.

## Found during implementation, not in the original design

Three defects surfaced while building and are fixed here:

1. **`upande_core`'s `Farm.farm_type` blocks every app.** It is a
   `Table MultiSelect` carrying `in_list_view: 1`, a combination Frappe forbids —
   and Frappe validates the whole doctype whenever a Custom Field is added to it.
   So `Farm` could not be extended by anybody, which is the real reason
   `spray_plan_approvers` never existed. Patch in
   `docs/upande_core_patches/farm-type-not-in-list-view.patch`; SCP also repairs
   the flag itself on `after_migrate`, because the failure is silent.
2. **Seed-data patches never run on a fresh install.**
   `installer.install_app` calls `set_all_patches_as_completed(app)`, marking
   every entry in `patches.txt` done without executing it. That is correct for a
   schema patch and wrong for a seeding one: `kaitetv16-staging` had **none** of
   the four spray Stock Entry Types, so `approve_and_forward` could not set
   `stock_entry_type` at all. Now ensured on `after_migrate`
   (`spray_stock_types.ensure_spray_stock_entry_types`).
3. **The farm name-parse was wrong on kaitet, not merely unportable.** It
   disagreed with `Warehouse.custom_farm` on **51 of the 158** linked
   greenhouses.

## Deviations from the design

**`Spray Team.custom_farm` left alone** (design §2 proposed a `farm` field).
`common/farm_fields.py` already owns it declaratively with deliberate
create-only semantics. Renaming would churn ~325 references for no gain.

**The store name-prefix fallback was kept, not deleted** (design §3 said delete).
Five kaitet farms — Lokitela, Saboti, Vale, Chepsito, Endebess — have a chemical
store warehouse but no `Farm.custom_chemical_store` link, so deleting the
fallback would have silently disabled loaning for them. It now lives in one
module (`common/stores.py`) instead of six, is clearly secondary to the link, and
`stores.unmapped_farms()` names exactly who depends on it. Map those five and the
fallback can go.

**`chemical_name` was renamed to `product_name`**, not kept. The doctype holds
foliars now.

**The consolidation is two patches, not one.** `rename_chemical_to_spray_product`
(pre_model_sync) does schema identity; `consolidate_spray_products`
(post_model_sync) does the data. One patch cannot do both: the fields the data
half writes (`category`, `crop_rates`) do not exist until the sync between them
creates them.

## Results on kaitet

| | |
| --- | --- |
| Spray Products | 710 — 479 Chemical + 231 Foliar |
| Foliars skipped | 2, both with a deleted Item (`_test_scp_proc_a/b`) |
| Doctypes removed | `Foliar`, `Chemical Crop Profile`, `Foliar Crop Profile` |
| Stray QR labels found | 34, across 13 non-AFP stock entries |
| Tests | 260 backend, 194 frontend, all passing |

`bench migrate` runs clean twice in a row, and `test_manager_permissions` carries
one pre-existing Stock Entry failure unrelated to this work (confirmed by
stashing every change and re-running).

## Follow-ups this work surfaced but did not take

- `Farm.farm_type` is `reqd: 1` yet ~10 of 11 kaitet farms have no value.
- `Warehouse.custom_farm` on kaitet points at `Chepsito` and `Endebess`, neither
  of which is a `Farm` record.
- 2,993 staging beds have `bed_area = 0`, so their greenhouses compute no area.
- Five farms need their `custom_chemical_store` / `custom_fertilizer_store` links
  set; see `stores.unmapped_farms()`.
