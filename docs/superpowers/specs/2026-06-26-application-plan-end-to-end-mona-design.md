# Application Plan end-to-end (mona) — design

**Date:** 2026-06-26
**Branch:** mona
**Status:** Approved design — ready for implementation plan

## Problem

The React Application Plan (`frontend/src/pages/ApplicationPlan.tsx`) does not work
end-to-end on the mona site. Five concrete defects plus a deployment gap block a
planner from creating a correct draft spray plan:

1. The "Latest scouting" date does not reflect the true last scouted day.
2. Area-to-spray is derived from raw bed geometry, not the mona convention of
   "one greenhouse = one hectare".
3. The chemical (and fertilizer) store warehouse is not found, so the BOM/plan has
   no valid chemical source.
4. The spray kit → destination CSU wiring needs verification end-to-end.
5. The spray-team dropdown is not farm-scoped.
6. Custom fields the flow depends on exist on the dev site but are missing from the
   app's `Custom Field` fixtures, so they are absent on the main/live site.

The goal is a planner can select a greenhouse, see the correct latest scouting date
and area, pick a farm-appropriate spray team and kit, resolve a real chemical store
source, and submit a draft spray plan whose chemicals are destined for the kit's CSU.

## Background / current behavior (as found)

- **Area data:** `tabBed.bed__area` is populated on mona (every bed = 44.8 m²).
  Both the old www page and React sum `bed__area` then divide by 10,000. A full
  greenhouse therefore comes out at its true geometric area (e.g. Main GH 01 - MFK =
  142 beds × 44.8 = 6,361 m² = 0.64 ha), **not** 1 ha.
- **Last-scout date:** `application_plan_diagnose`
  (`upande_scp/serverscripts/dashboard_aggregates/_application_plan.py`) computes
  `latestDate` as the max `date_of_capture` among rows that pass BOTH the date window
  (default 60 days) AND the active pest/section/stage filter (`_build`, ~line 149).
  So an older-than-window last scout returns `null`, and applying a filter chip
  changes the displayed date.
- **Chemical store:** `get_allowed_chemical_store_warehouses()`
  (`upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.py`) calls
  `_allowed_warehouses_by_prefix("Chemical Store")`, which filters
  `name LIKE "Chemical Store %"`. mona's warehouse is `Chemical Main Store - MFK`, so
  the prefix never matches and the function returns `[]`. The same applies to
  fertilizer (`Fertilizer Main Store - MFK` vs prefix `Fertilizer Store`). The
  store-keeper path was already fixed in commit `55c91f1` using a broad regex in
  `serverscripts/spray_plan_creator/stock.py`
  (`_STORE_RE = re.compile(r"\bchemical\b.*\bstore\b", re.IGNORECASE)`); the
  Spray Plan Settings path was missed.
- **Kit → CSU:** Server side already implemented in commit `345452e`:
  `_apply_kit_warehouse` (`serverscripts/spray_plan_creator/drafts.py`) sets
  `wo.wip_warehouse` from the kit's `Spray Equipment Details.warehouse` and throws if
  the kit is unmapped. Wired into create and update draft flows.
- **Spray team:** React loads all enabled teams from `fetch_creator_bootstrap` with
  `custom_farm` attached, but the dropdown applies no farm filter. mona teams: Team A
  and Team D = farm `Main`; Team B, Team C, `scouting team` = no farm.
- **Fixtures:** `hooks.py` exports a curated `Custom Field` allowlist. It already
  includes `Spray Team-custom_farm` and `Material Request-custom_farm`, but omits
  `Warehouse-custom_farm` and other fields the flow reads.

## Design

### 1. Last scouted day — true absolute latest

Add a whitelisted backend method that returns the absolute most-recent scouting date
for a greenhouse, independent of any date window or observation filter:

- New method `get_last_scouting_date(greenhouse)` (in `scouting_metrics_api.py`,
  delegating to a helper). Returns `max(date_of_capture)` from `Scouting Entry`
  filtered by `greenhouse` only — mirroring the old www `get_scouting_report` logic.
- Cache keyed by greenhouse (short/medium TTL), since it is filter-independent.
- `ApplicationPlan.tsx` header "Latest scouting" reads this value instead of
  `diagnose.latestDate`. The zone diagnosis keeps its windowed/filtered behavior.

**Why a separate method, not folding into diagnose:** the displayed date must never
depend on the active pest/section/stage chips or the 60-day window. A dedicated,
greenhouse-keyed query keeps that guarantee and is cheap.

### 2. Area rule — full greenhouse = 1 hectare

In `ApplicationPlan.tsx`, replace the `sqm / 10000` computation with a bed-count
share of a fixed 1 hectare. Total bed count comes from the already-loaded
`bedsByGh[greenhouse]` (active beds).

- Full Greenhouse → `areaHa = 1.000`
- Specific Variety → `areaHa = (count of beds whose variety is selected ÷ total
  active beds in GH) × 1`
- Specific Bed(s) → `areaHa = (count of selected beds ÷ total active beds in GH) × 1`
- `waterVolumeL = areaHa × 1000` (`WATER_VOLUME_RATE` unchanged).

Because every mona bed has equal area (44.8 m²), "by bed count" equals "by area
share". Bed-count is the chosen, explicit basis. Guard against a zero total
bed-count (→ area 0).

### 3. Chemical / fertilizer store — fix the matcher

Broaden the Spray Plan Settings warehouse resolver to the same convention as the
store-keeper path so the two cannot drift:

- Replace the literal-prefix match in `_allowed_warehouses_by_prefix` (for the
  chemical and fertilizer store cases) with the regex convention
  `\bchemical\b.*\bstore\b` / `\bfertilizer\b.*\bstore\b` (case-insensitive), still
  scoped to allowed farms and `disabled = 0`.
- Centralize the store-classification regex so `stock.py` and
  `spray_plan_settings.py` share one definition. Preferred: a small shared helper
  (e.g. in `stock.py` or a new `warehouse_classify` module) imported by both.
- `get_allowed_chemical_store_warehouses` and `get_allowed_fertilizer_unit_warehouses`
  keep their signatures; only the matching predicate changes.

### 4. Kit → destination CSU — verify end-to-end

No new backend logic (already in `345452e`). Verify and, if needed, fix:

- `ApplicationPlan.tsx` submit sends `custom_kit` (the kit name) in the draft
  payload so `_apply_kit_warehouse` can resolve the CSU.
- Surface the resolved destination CSU ("Work in progress house" = Main CSU A/B/C)
  in the kit UI so the planner sees where chemicals will land. Kits already carry
  `warehouse` in the bootstrap payload.
- Confirm an unmapped kit surfaces the server's error rather than failing silently.

### 5. Spray team — farm-scoped (keep unfarmed)

Filter the team dropdown client-side in `ApplicationPlan.tsx` using the
`custom_farm` already present on each bootstrap team and the selected greenhouse's
farm (already known in the page):

- Show a team when `team.custom_farm` equals the greenhouse's farm OR
  `team.custom_farm` is empty/null (treated as global/unscoped).
- Hide teams tagged to a different farm.
- No data migration is forced; unfarmed teams remain visible.

Client-side is preferred because the page already has the greenhouse's farm and the
team list is small; no backend change required.

### 6. Fixtures — add missing custom fields (fields only)

Add the following entries to the `Custom Field` allowlist in `hooks.py`
(`fixtures`). Fields only — no records are shipped.

| Field | Reason |
|---|---|
| `Warehouse-custom_farm` | Backbone of farm scoping (scope, bootstrap, stock, BOM resolver, auto-material-issue, settings). Critical. |
| `BOM-custom_farm` | Tank-mix / BOM farm scoping (`bootstrap`, `bom_resolver`). |
| `Cost Center-custom_farm` | Cost-center grouping/badging (`validation`, `bootstrap`). |
| `Work Order-custom_chemical_scans` | Scan-verification step. |
| `Work Order-custom_spray_application_logsheet` | Spray execution logsheet. |

Explicitly excluded: `custom_kit_warehouse`, `custom_biometric_verified`,
`custom_business_unit` — these are payload keys / kaitet-only and do not exist as
Custom Fields on mona.

## Components touched

- `frontend/src/pages/ApplicationPlan.tsx` — area rule (2), last-scout source (1),
  team scoping (5), kit destination display + payload check (4).
- `upande_scp/serverscripts/scouting_metrics_api.py` (+ `scouting_metrics.py`
  helper) — `get_last_scouting_date` (1).
- `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.py` —
  store matcher (3).
- `upande_scp/serverscripts/spray_plan_creator/stock.py` (or a new shared module) —
  centralized store regex (3).
- `upande_scp/hooks.py` — fixtures allowlist (6).
- Frontend API lib(s) as needed for the new endpoint (1).

## Data flow (after changes)

1. Planner picks a greenhouse → page knows the greenhouse's farm (Warehouse.custom_farm).
2. Header shows `get_last_scouting_date(greenhouse)` (true latest).
3. Scope (Full / Variety / Beds) → `areaHa` via bed-count share of 1 ha → water volume.
4. Spray-team dropdown shows farm-matching + unfarmed teams.
5. Kit dropdown shows kit + resolved CSU; submit sends `custom_kit`.
6. BOM/chemical source resolves real `Chemical Main Store - MFK` (and fertilizer).
7. Submit → draft Work Order with `wip_warehouse` = kit's CSU.

## Error handling

- `get_last_scouting_date`: no entries → `null`; header renders an explicit
  "No scouting entries" rather than a windowed message.
- Area: zero total active beds → `areaHa = 0`, water = 0 (no divide-by-zero).
- Store matcher: empty allowed-farms or no matching warehouse → `[]` (unchanged
  contract); the UI already handles an empty source list.
- Kit: unmapped kit → server `frappe.throw` surfaces to the UI (existing behavior).

## Testing

- **Backend unit tests:** `get_last_scouting_date` returns the absolute max and is
  unaffected by date window/filters; store matcher returns `Chemical Main Store - MFK`
  and `Fertilizer Main Store - MFK` and still excludes CSUs/greenhouses.
- **Frontend unit tests:** area computation for the three scopes (full = 1 ha;
  variety/bed = proportional; zero-bed guard); team filter (farm match + unfarmed
  shown, other-farm hidden).
- **Manual end-to-end on mona.local:** select Main GH 01 - MFK → latest date shows;
  full GH = 1.000 ha / 1000 L; pick Team A; pick a kit → CSU shown; chemical source =
  Chemical Main Store - MFK; submit draft → Work Order `wip_warehouse` = kit CSU.
- **Fixtures:** `bench --site <site> export-fixtures` / migrate brings the 5 fields to
  a site lacking them.

## Out of scope

- Shipping Spray Team / Spray Equipment records as fixtures (fields only).
- Removing/cleaning the legacy `www/new_application_floor_plan` page.
- Any change to the scan-verification or logsheet feature logic (only the fixture
  fields are added).
- Employee/Stock Entry/Sales Order `custom_farm` (not used by this flow).
