# Crop scoping of farms, pests and diseases — design

Date: 2026-10-09. Piece 1 of 4 (crop scoping → prevalence measure → thresholds & actions → stage/variety weighting).

## Goal

Every screen in a crop's section shows only that crop's farms, greenhouses/blocks, pests and diseases. Rose screens never list Lokitela or an avocado pest; the avocado jobsheet never lists Karen. Filtering happens **on the server** — nothing outside the crop is fetched and hidden in the browser.

## Decisions (agreed with the user)

| # | Decision |
|---|---|
| D1 | The crop is the one in the route (`#/rose/…`, `#/avocado/…`, `#/coffee/…`). Pages stop carrying their own crop pickers where the route already fixes the crop. |
| D2 | A crop's pests and diseases are its `Pest Filter` / `Disease Filter` rows (`crop_scouted` = crop) — the same source the mobile app's `getObservationsDetails` uses, so web and phone agree. |
| D3 | A crop's farms are its `Crop Scouted` → `Farm Filter` rows, intersected with what the user may see (`crop_scope.scoped_farms(crop, user)`). Greenhouses/blocks follow their `Warehouse.custom_farm`. |
| D4 | **Option A:** observations of a pest or disease not linked to the crop are excluded from lists, charts and counts on Dashboard, Observations and Trends. They stay in the database. |
| D5 | A Scouting Entry with no `crop_scouted` counts under the crop of its greenhouse's farm. (Live: 7,902 such entries in the last 30 days, all rose farms, all "nothing found" — dropping them would undercount scouted stations, which piece 2's percentage depends on.) |
| D6 | Spray plan targets: **Preventive** = the crop's pests and diseases; **Curative** = observed in the greenhouse in the window **and** linked to the crop. The crop comes from the greenhouse (no more hard-coded "Rose"). Saving rejects a target not linked to the plan's crop. |
| D7 | Settings → Thresholds follows the route crop; its own crop picker is removed. |

## Verified facts (2026-10-09)

- Mobile `upande_scp/serverscripts/mobile/get_observations_details.py` already scopes pests/diseases by `crop_scouted`. Live: Rose 12 pests / 6 diseases, Avocado 12 / 4, Coffee 16 / 5; every row has stages and a common name; no duplicates; no unknown-crop errors in 30 days; no scout recorded an off-list pest in 30 days. **No mobile change needed.**
- `common/crop_scope.py` already has `farms_for_crop`, `scoped_farms`, `scoped_greenhouses`, `allowed_crops`.
- `scouting_metrics_api.get_farms_and_warehouses(crop)` already narrows by crop when given one; most pages call it **without** a crop.
- Gaps: `spray_plan_creator/bootstrap.py` returns the user's farms regardless of crop, and the full `Pest` / `Plant Disease` catalogs; `ApplicationPlan.tsx:384` hard-codes `crop: "Rose"` for diagnose; `validation.validate_targets_in_scope` (Preventive) only checks the catalog; dashboard aggregates filter on `se.crop_scouted` only (`_common.parent_filter_conditions`), so crop-less entries vanish; Dashboard/Trends keep their own crop selects; `ThresholdsTab` has its own crop picker.

## Design

### 1. One server module: `common/crop_catalog.py`

Pure lookups, cached with the existing crop-scope/severity cache invalidation (Pest Filter / Disease Filter / Crop Scouted changes already bust related keys in `cache_utils.py`).

- `pests_for_crop(crop) -> list[str]` and `diseases_for_crop(crop) -> list[str]` — from the filter rows.
- `targets_for_crop(crop) -> list[str]` — both, sorted.
- `crop_for_farm(farm) -> str | None` and `crop_for_greenhouse(wh) -> str | None` — via `Farm Filter` (first crop listing the farm). Replaces the private copy in `spray_compliance/context.crop_for_greenhouse`.
- SQL helper `entry_crop_condition(alias="se")` → `(se.crop_scouted = %(crop)s OR (ifnull(se.crop_scouted,'') = '' AND se.greenhouse IN %(crop_whs)s))` with `crop_whs` = the crop's greenhouses/blocks. Used by every aggregate that filters entries by crop (D5).

### 2. Spray plan (Application Floor Plan + avocado BlockSprayPlan)

- `fetch_creator_bootstrap(crop=None)` takes the crop. Farms = `scoped_farms(crop, user)` ∩ the user's spray-plan farms; greenhouses, blocks, spray teams and tank mixes follow those farms. `pest_catalog` / `disease_catalog` become the crop's lists. No crop → today's behaviour (back-compat for callers not yet passing one).
- Frontend `fetchCreatorBootstrap(crop)` passes the route crop (`ApplicationPlan` initialCrop, `BlockSprayPlan` "Avocado").
- Diagnose (`_application_plan.py`) receives the crop derived from the greenhouse and drops targets not linked to it; `ApplicationPlan.tsx` stops sending `"Rose"`.
- `validate_targets_in_scope(..., crop)`: Preventive — each target must be in `targets_for_crop(crop)`; Curative — observed **and** in the crop's list. Error names the crop.

### 3. Jobsheet (avocado heat map) and other map headers

- Farm lists come from `get_farms_and_warehouses(crop)` with the route crop (`AvocadoHeatMap`, `Heatmaps`, `MapHeader`, `RangeHeader`, `SingleDayHeader`, `TrapsMap`). Their crop selects are removed where the route fixes the crop.

### 4. Dashboard, Observations, Trends

- Farm/greenhouse/block pickers: `get_farms_and_warehouses(route crop)`; the page-level crop `Select` goes (Dashboard, Trends).
- Aggregates (`_pests_diseases`, `_overview`, `_trends`, `_gh_detail`, heatmaps) filter entries with `entry_crop_condition` and child rows to `pest in pests_for_crop` / `disease in diseases_for_crop` (D4). The Trends `options` bundle (observation dropdown, stations tree) is therefore crop-only.
- Observations (`get_complete_scouting_entries`) applies the same two filters server-side; child rows of other crops' pests/diseases are not returned.

### 5. Settings → Thresholds

- `Settings` passes `initialCrop` to `ThresholdsTab`; the tab drops its crop picker and calls `get_thresholds(crop)` (already crop-keyed). `save_thresholds` rejects rows whose crop ≠ the request's crop.

## Out of scope

Thresholds model changes (piece 3), prevalence/spatial measure (piece 2), stage/variety weighting (piece 4), mobile changes (none needed), predators/weeds/incidents/disorders (already crop-scoped on mobile; web lists unchanged).

## Error handling

- Unknown or not-allowed crop → `crop_scope.assert_crop` throws (403-style), never "show everything".
- Crop with no linked pests/diseases → empty lists, not the full catalog.
- Greenhouse whose farm is on no crop → excluded from every crop-scoped list (no warning screen in this piece).

## Testing

- Server (direct DB runner, rolled back): for Rose vs Avocado — bootstrap farms/greenhouses/catalog contain no other-crop item; `get_farms_and_warehouses(crop)`; diagnose drops off-crop targets; Preventive/Curative validation rejects an off-crop target; a crop-less entry on a rose greenhouse counts in the rose aggregates and not the avocado ones; an off-crop pest child row is excluded from `_pests_diseases` and `_trends` options.
- Pure: `entry_crop_condition` SQL shape; `crop_catalog` with a stubbed db.
- Frontend (vitest): ThresholdsTab follows the prop, has no crop picker; Dashboard/Trends send the route crop and render no crop select; ApplicationPlan sends the route crop to bootstrap and no hard-coded "Rose".
- Manual: rose application plan lists no Lokitela; avocado jobsheet lists no Karen; Trends observation dropdown on rose shows the 12 + 6.
