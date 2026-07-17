# Farm→Store Mapping, Draft-Aware Stock, Store-Keeper Scoping & Dashboard — Design

**Date:** 2026-07-07
**Branch:** kaitet
**Status:** Approved (design), pending implementation

## Problem

Three coupled gaps in the spray-planning + store flow:

1. **Store selection is unconstrained.** In `ApplicationPlan.tsx` the source (chemical/fertilizer)
   store is picked per chemical row from *all* warehouses on the BOM. A planner for one farm can
   pull from another farm's store, and sees every store's stats.
2. **Stock is not draft-aware.** Available stock = raw on-hand `Bin.actual_qty`, never decremented
   by what's already planned. A planner with 5 kg on hand can keep planning to 60 kg across rows,
   batched drafts, and submitted plans without ever being told they exceeded stock.
3. **The Chemical Dashboard shows every store to every permitted user.** A Store Keeper sees all
   farms' chemical + fertilizer stock. They should only see the farms assigned to them, and the
   dashboard should present per-store-type aggregates as table + bar + pie.

## Decisions (locked)

- **Store lock:** ApplicationPlan locks to the farm's mapped store (no override).
- **Reservation scope:** available = on-hand − (current form rows + batched drafts + submitted-unissued plans).
- **Cardinality:** exactly one chemical store + one fertilizer store per farm.
- **Store-keeper config:** a Store Keepers column added to the existing per-farm Access tab.
- **Fertilizer parity:** fertilizer stores are scoped and visualized identically to chemical stores.
- **Settings layout:** the two Farm→store selects live in the same per-farm Access grid as the role
  rosters (unified grid). Revisit to a separate "Stores" tab only if the grid proves too wide.

## Reference: what Mona did (and didn't)

Mona never built a clean farm→store structure. It hardcoded `source_warehouses`
(`Chemical Store <Farm> - KR`), later collapsed to a single `Chemical Store - MFL`, then made stock
fully store-agnostic. Its `Farm` doctype (`b58d799`) has only `farm_name` — no store links. The
farm↔warehouse relationship is carried entirely by `Warehouse.custom_farm`. **We are building the
proper per-farm store mapping Mona lacked**, keyed off the existing `Warehouse.custom_farm` join and
the existing kaitet per-farm roster pattern.

---

## Architecture

The **Farm** record becomes the single source of per-farm config: its stores, and who may
create/approve/keep-store for it. This mirrors the existing Creator/Approver child-table pattern
(`upande_scp/serverscripts/spray_plan_creator/admin.py` `_set_farm_roster`).

### Component 1 — Data model

Add to `upande_scp/fixtures/custom_field.json` (attaching to `Farm`, same as `Farm-spray_plan_creators`):

| Fieldname | Type | Options |
|---|---|---|
| `custom_chemical_store` | Link | Warehouse |
| `custom_fertilizer_store` | Link | Warehouse |
| `store_keepers` | Table | Farm Store Keeper |

New child doctype **`Farm Store Keeper`** under `upande_scp/upande_scp/doctype/farm_store_keeper/`
— a copy of `farm_spray_plan_creator` (`istable:1`, `user` Link→User, `full_name` Data).

Unmapped farms are valid: everything falls back to current behavior when a farm has no mapped store.

### Component 2 — Settings (Access tab)

`frontend/src/components/settings/AccessTab.tsx` per-farm row becomes:
Creators · Approvers · **Store Keepers** · **Chemical Store** · **Fertilizer Store**.

- Store Keepers: a third `CreatorChipPicker` (`kind="storekeeper"`), identical dirty/save pattern.
- Chemical/Fertilizer Store: two `<Select>` columns, options from `list_store_warehouse_candidates`.

`frontend/src/lib/spray-plan-admin-api.ts` gains: `setFarmStoreKeepers`, `setFarmStores`,
`listStoreKeeperCandidates`, `listStoreWarehouseCandidates`.

`upande_scp/serverscripts/spray_plan_creator/admin.py` gains (all behind `_require_admin`):
- `set_farm_store_keepers(farm, users)` — reuses `_set_farm_roster` with child_field `store_keepers`,
  role `Store Keeper`.
- `set_farm_stores(farm, chemical_store, fertilizer_store)` — sets the two Link fields.
- `list_store_keeper_candidates(q)` — reuses `_candidates_for_role("Store Keeper", q)`.
- `list_store_warehouse_candidates(q)` — `Warehouse` where `is_group=0, disabled=0`,
  `warehouse_type` not in (Greenhouse, Work In Progress).
- `list_farms_with_creators` extends its return with `store_keepers`, `chemical_store`,
  `fertilizer_store`.

### Component 3 — ApplicationPlan store lock

- `upande_scp/serverscripts/spray_plan_creator/bootstrap.py` `fetch_creator_bootstrap` returns
  `farm_stores: { [farm]: { chemical_store, fertilizer_store } }`.
- `get_bom_details` restricts `chemical_warehouses` to `[farm.custom_chemical_store]` and
  `fertilizer_warehouses` to `[farm.custom_fertilizer_store]` (and balances to those), given the
  selected greenhouse's farm. Falls back to all warehouses when the farm is unmapped.
- `frontend/src/pages/ApplicationPlan.tsx`: resolve the mapped store from
  greenhouse → `custom_farm` → `farm_stores`. The per-row source `<Select>` (lines ~2018-2044)
  becomes a static label of the mapped store; the stock matrix collapses to a single column. Row
  `source` is force-set to the mapped store. If the farm is unmapped, keep the current dropdown.

### Component 4 — Draft-aware available stock

- New endpoint `get_store_reservations(warehouse, item_codes)` → `{ item_code: reserved_qty }`,
  summing planned quantities from **draft batch plans + submitted spray plans not yet
  material-issued** for that warehouse.
  *(Implementation note: the exact spray-plan doctype + the status/workflow_state that means
  "submitted, not yet issued" will be pinned during plan-writing by inspecting
  `spray_plan_creator/drafts.py` + `lifecycle.py` and the material-issue trigger in
  `mobile/start_work_order.py`.)*
- Frontend (`ApplicationPlan.tsx`): availability =
  `on_hand(balances[store]) − reserved[item] − (other current-form rows for same item+store)`.
  Feeds the existing `stockShortRows` guard and submit-disable — no new guard UI needed.

### Component 5 — ChemicalDashboard scoping + three-view aggregates

**Scoping (server-side):** `upande_scp/serverscripts/store_keeper_api.py` gains
`_allowed_farms_for(user)`: returns `None` (all) for System Manager / Administrator / General
Manager; otherwise the farms where the user is in `store_keepers`. `chemical_stock_overview` and
`chemical_store_levels` add `warehouse.custom_farm IN (allowed_farms)` when not `None`. Filtered
data never reaches the client.

**Aggregates + visualizations:** the overview payload is grouped into two buckets — **chemical**
(item_group `CHEMICALS`) and **fertilizer** (item_group `Fertilizer`) — each carrying:
per-store totals, per-item totals, a matrix, and a grand total across the allowed farms.
`frontend/src/pages/ChemicalDashboard.tsx` renders, for each bucket:
- an aggregate **total** KPI across allowed stores,
- a **table** (per store / per item),
- a **bar graph**,
- a **pie chart**,

so the three views mirror the contents of the chemical stores and the fertilizer stores
respectively.

---

## Testing

- **Backend:** unit-test `_allowed_farms_for` (admin vs plain store keeper), `set_farm_stores`,
  `get_store_reservations` (draft + submitted-unissued summed, issued excluded), and the
  farm-scoped `chemical_stock_overview`. Follow existing `serverscripts/tests/` fixtures.
- **Manual:** query `kaitet.local` via bench to confirm reservation math and farm scoping against
  real data. (Never the Kaitet MCP.)
- **Frontend:** verify the store lock (dropdown gone, single column), the over-plan guard trips at
  the reservation-adjusted number, and a Store Keeper sees only assigned farms with correct
  table/bar/pie aggregates.

## Risk / rollout

- Ships safe on unmapped farms (fallbacks everywhere).
- Custom fields + new child doctype require `bench migrate` + fixture export.
- `chemical_stock_overview` return shape changes (bucketed) — update the `store-keeper-api.ts` type
  and all consumers together.
