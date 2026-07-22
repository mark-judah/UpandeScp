# Chemical & Foliar DocTypes — Implementation Audit

**Date:** 2026-07-22
**Scope:** `upande_scp` — move chemical metadata off the ERPNext `Item` custom
fields onto SCP-owned `Chemical` / `Foliar` doctypes; rename the settings Single;
cut all readers over to the new source; remove the Item chemical fields.
**Site verified:** `kaitet.local`.
**Design spec:** [`docs/superpowers/specs/2026-07-22-chemical-doctype-design.md`](../superpowers/specs/2026-07-22-chemical-doctype-design.md)
**Commits:** `166c5d2`, `8594936`, `2c35799`, `7490c82`, `f8fe7ac` (+ tests/docs).

---

## 1. Motivation

Chemicals were ERPNext `Item`s in item_group `CHEMICALS` with ~17 `custom_*`
fields carrying all agronomic/safety/regulatory metadata. Problems:

- editing chemical metadata required `Item` **write** permission;
- SCP depended on custom fields bolted onto a shared ERPNext doctype;
- no home for PHI / formulation / registration no. / MRL;
- no way to express **per-crop** rates/targets (same product differs by crop);
- the "is this a chemical?" test was scattered as case-inconsistent
  `item_group in ("CHEMICALS"/"Chemicals"/…)` string matching.

**Hard constraint:** stock/procurement/accounting stay on `Item` (Bin, BOM,
Work Order, Stock Entry). Only metadata moved.

## 2. What was built

### DocTypes
- **`Chemical`** and **`Foliar`** — sidecar masters, `autoname = field:item`
  (so `name` == item code, exactly one per Item). Hold type, active
  ingredients, WHO/toxicity class, re-entry interval, **PHI, formulation,
  registration no., MRL** (new), IRAC/FRAC/GHS + MOA, low-stock threshold, and
  **default** rate limits + targets.
- **`Chemical Crop Profile`** / **`Foliar Crop Profile`** — standalone, unique on
  (product, crop), holding **per-crop overrides** of rate limits + targets +
  requirements. Mirrors the existing `Pest Filter` / `Disease Filter` pattern.
- **`Crop Protection Item Group`** — child table used by the settings config.

### Settings
`Spray Plan Settings` was **renamed** to **`Scouting and Crop Protection
Settings`** and reorganised into **Spray Plan / Chemicals / Scouting** tabs. The
Chemicals tab configures `chemical_item_groups` / `foliar_item_groups` and offers
**Export to Chemicals / Foliars** backfill buttons.

### Resolution helper — `serverscripts/common/crop_protection.py`
Single source of truth. `chemical_groups()`/`foliar_groups()` (config),
`is_chemical()`/`is_foliar()`, `classify_item_group()`, `get_product_rate()`,
`get_product_targets()`, `get_product_type()`, `get_product_codes()`
(crop-profile override → master default), `crop_protection_item_codes()`,
`ensure_product_record()` (creates + copies legacy fields), `item_dashboard()`.

### Auto-registration
`Item` `after_insert` hook auto-creates the sidecar for items in a configured
group (with a desk notice). The Chemical/Foliar form scripts carry the MOA
fetch + target toggle that used to live on the Item form.

## 3. Migration & data (kaitet)

| Patch | Effect |
|---|---|
| `rename_spray_plan_settings_doctype` (pre-model-sync) | rename Single + repoint child rows |
| `introduce_chemical_foliar_doctypes` | seed chemical groups; **475 Chemicals** created, copying the 17 custom fields |
| `configure_fertilizer_as_foliar` | `Fertilizer` → foliar group; **210 Foliars** created |
| `drop_item_chemical_custom_fields` | delete 15 Item Custom Fields |
| `drop_orphan_item_chemical_columns` | `ALTER TABLE tabItem DROP COLUMN` × 9 |

## 4. Reader cutover

All chemical reads now resolve through the helper (sidecar-authoritative):

- **Dosing:** `create_bom` (both rate paths), `create_application_work_order`,
  `bootstrap._fetch_rate_limits`, `approval_review`, `stock` low-stock join.
- **Resistance:** `validate_frac_irac_guidelines` (type + IRAC/FRAC codes).
- **Editor:** `settings.list_chemicals` overlays sidecar values and its group
  filter is now **config-driven** (previously the hardcoded tuple excluded
  `AVOCADO CHEMICALS`); `settings.save_chemical` writes to the sidecar
  (rates → `default_*`, targets → `default_targets`) while `enabled/disabled`
  stays on the Item.

## 5. What was removed vs kept

**Removed from Item (15):** section break, `custom_type`, `custom_toxicity`,
`custom_reentry_interval_hrs`, `custom_lower/upper_rate_limit`,
`custom_low_stock_threshold`, `custom_active_ingredients`, `custom_targets`,
`custom_irac(+moa)`, `custom_frac(+moa)`, `custom_ghs(+description)`.

**Kept on Item:** `custom_chemical_intervention_threshhold` +
`custom_scouting_and_crop_protection_tab` — this is **per-variety** data (used by
Spray/Standard Roses), never chemical. `item.js` was reduced to a toggle for it.

## 6. Findings / gotchas (for future work)

1. **Doctype rename** — the controller class must equal `name.replace(" ","")`
   *preserving case* (`ScoutingandCropProtectionSettings`, lowercase "and"); a
   wrong casing makes `get_controller` raise `ImportError`, and migrate then
   **orphan-deletes** the doctype every run. `rename_doc` has no
   `ignore_permissions` kwarg (v15) and updates child `parenttype` but **not**
   `parent` — child rows must be repointed or `get_single` loads no children.
2. **Custom Field delete ≠ column drop** — deleting a Custom Field removes it
   from the form/meta but leaves the DB column; a separate
   `ALTER TABLE … DROP COLUMN` patch is required.
3. **Field entanglement** — `custom_type`/`custom_toxicity` held garbage default
   values (`Insecticide`/`I`) on **1,694 non-chemical items** (hardware,
   uniforms, vehicle parts); safe to drop. `custom_chemical_intervention_threshhold`
   is variety data — must be kept. Both discovered by per-field usage audit
   before dropping anything.
4. **`Chemical.name == item code`** — child-table queries filtered by `parent`
   alone double-count Item vs sidecar rows; always filter by `parenttype`.
5. **MariaDB case-insensitive collation** — seeding a "Chemicals" group matched
   "CHEMICALS" and created a duplicate config row; resolve names via
   `frappe.db.get_value("Item Group", …)` and dedupe.

## 7. Verification

- **E2E test suite:** `serverscripts/tests/test_crop_protection.py` (8 tests) —
  auto-create hook, classification, rate default→profile override, type/code
  resolution, editor save→sidecar + config-driven listing, Item-columns-gone,
  and the group-overlap guard. Self-cleaning (`tearDownClass`).

  ```
  bench --site kaitet.local run-tests \
      --module upande_scp.serverscripts.tests.test_crop_protection
  ```
  (Tests must be enabled: `bench --site kaitet.local set-config allow_tests true`.)

- **Manual smoke on kaitet:** `get_product_rate` matches migrated values,
  `getAllChemicals` (471), `bootstrap` rate map (48), `list_chemicals` all
  resolve from sidecars; 210 fertilizer Foliars carry copied values.

## 8. Known follow-ups (not done)

- `serverscripts/store/stock.py` and `store_keeper_api.py` keep a **local
  hardcoded** `_CHEMICAL_GROUPS = ("CHEMICALS","Fertilizer")` for stock
  aggregation — should move to `crop_protection.crop_protection_item_codes()`
  so `AVOCADO CHEMICALS` and future foliar groups are included in store views.
- Frontend "Chemicals" settings tab labels/comments still say "Spray Plan
  Settings" (cosmetic; endpoints unchanged, no rebuild needed).
- PHI/MRL are product-level; could become per-crop profile overrides later.
- Fertilizers are modelled as `Foliar`; if a distinct Fertilizer doctype is
  wanted, split it out and re-point `foliar_groups()`.
