# Pest gallery (item 8) and crop-protection finance (item 9) — design

Date: 2026-10-10. Built lean (one build + one review each), rulings by the controller per the user's autonomous-build instruction.

## Item 8 — Pest gallery pop-up

| # | Decision |
|---|---|
| G1 | Clicking a pest or disease name opens a **gallery pop-up** from: the Pests/Diseases tab ranking rows, the greenhouse modal's top pests/diseases, and the heatmap card dialog header. |
| G2 | Contents: reference image (`Pest/Plant Disease.damage_symptoms`, public) + scientific name + identification guideline if present; **by scout** table for the current scope and date range (entries, stations, total count for pests, houses, last seen); **photos** grid from `Scouting Entry Photo` (`subject` = the observation name) newest first, 24 per page with "load more" — each with caption, scout, house, date; photo click opens full size. Disease rows: no count column. |
| G3 | One endpoint `observation_gallery(crop, kind, name, from_date, to_date, greenhouse=None, farm=None, page=0)` in `dashboard_aggregates`, crop-scoped (piece 1 D4/D5), cached like other aggregates (photos page uncached or short TTL). Same permission gate as the dashboard aggregates. |
| G4 | Photos are private files: served to logged-in users via their session (same origin). Only return photos of entries the scope covers. |
| G5 | Empty states: "No photos yet — scouts can add them when the manager allows photos (Settings → Spray plan → Scouting capture)". |

## Item 9 — Crop-protection finance (port of Mona's `reports/finances.py` + `Finance.tsx`)

| # | Decision |
|---|---|
| F1 | Port Mona's `chemical_cost_by_target(from_date, to_date, farm=None)` and the Finance page (route `#/<crop>/finances`, sidebar entry for all crops on kaitet), adapted to kaitet's `Spray Product` + `crop_protection` helpers (`get_product_targets`, `product_groups`). Roles: SCP General Manager, System Manager (Mona's `FINANCE_ROLES` renamed). |
| F2 | **Count each unit of product once, where it leaves the store for use**: Material Transfer for Manufacture (into the CSU, attributed to its Work Order) and Material Issue; kaitet's custom type **Chemical Spray** is counted only when its source warehouse is not a CSU/WIP warehouse already fed by a transfer (else it is already counted). **Excluded**: Chemical Loaning (farm-to-farm move), Chemical Mixing and Manufacture (tank-mix internal), Material Receipt. Values from `Stock Entry Detail.amount` (valuation at posting). |
| F3 | Attribution (Mona's `_attribute`): WO targets the product treats → those targets; foliar without a matching target → "Nutrition"; otherwise split equally across the plan's targets (marked split); no WO → "Unattributed" by cost centre. Targets from `Work Order.custom_targets`; product targets from `Spray Product.default_targets`. |
| F4 | Output and UI as Mona: farms → greenhouse rows × target cells, totals by kind, unattributed and untargeted items; plus a **cost per target** summary (pest/disease → total, share, houses) for the "cost to treat pest X in this period" question. Crop scoping: the route crop limits farms/greenhouses (piece 1). |
| F5 | Zero-valuation rows (kaitet.local has some) are counted as 0 and listed as "no valuation" so missing costs are visible. |

## Out of scope

Editing photos; budget vs actual; per-hectare cost; the email fix.

## Testing

Item 8: DB fixture (2031) with entries, pest rows and photo rows — by-scout figures, photo paging, crop scoping, kind=disease; vitest for the pop-up from each entry point. Item 9: port `test_finances.py` adapted (attribution cases, the F2 inclusion/exclusion matrix incl. Chemical Spray from CSU vs store), vitest port of `Finance.test.tsx`; a real-data in-process run over the last 6 months.
