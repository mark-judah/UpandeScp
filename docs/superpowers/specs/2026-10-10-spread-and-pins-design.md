# Spread and pins — design

Date: 2026-10-10. Piece 3c of the scouting programme (… 3a thresholds ✅ → 3b hot spots → **3c spread & pins** → 4 stage & variety). Builds on piece 2 (`common/prevalence.py`, `_prevalence_rows.StationWeeks`, station grid cache) and 3a/3b (Scouting Alert, digest).

## Goal

Show where an outbreak is inside a greenhouse or block, as patches of neighbouring infested stations, and whether each patch grew, shrank, moved or appeared since the last scouted week. Let agronomists pin an area (a section, a frozen patch, or an area they draw) and watch its figure week by week.

## Decisions

The user asked for autonomous build ("continue … till we are done"); each decision below is the recommended option, recorded as a ruling.

| # | Decision |
|---|---|
| C1 | A **cluster** is a connected set of infested stations in one house and one ISO week, for one observation (all stages, the live figure). Neighbours: rose — same or adjacent bed rank **and** zone rank within 1 (8-neighbour on (bed rank, zone rank)); avocado — row rank ±1 and tree rank ±1. Ranks come from the same Zone/Bed and Orchard Tree ordering as piece 2's grid. No GPS check (bed U-shapes make bed-number adjacency imperfect; accepted). |
| C2 | Only clusters of **≥ 3 stations** are reported; at most the **5 largest** per house/observation. |
| C3 | Week-to-week tracking compares each cluster with the previous scouted week's clusters (same house, observation): matched when the station sets overlap or their centroids (in rank space) lie within 2 ranks. Change: **New** (no match), **Grew** (size ≥ +25% and ≥ +3 stations), **Shrank** (≤ −25% and ≥ −3), **Moved** (matched only by centroid, no overlap), **Stable** otherwise. A previous cluster with no match is reported as **Gone**. |
| C4 | Clusters are computed on demand for the greenhouse modal (one house, one week, one observation) — no stored table, cached in Redis with the dashboard cache. |
| C5 | Surfaces: the greenhouse modal gains a **Patches** list under the 3×3 grid (size, beds/rows span, change pill); the rose Heatmaps modal and the avocado tree map draw each patch's outline (hull of the stations) over the map. The digest's hot-spot lines add "patch of N zones, grew" when a patch lies in the hot section. No new notifications for clusters (keeps email/in-app volume low). |
| C6 | **Pins** (new doctype **Scouting Pin**): kinds **Section** (row/col of the 3×3 grid), **Patch** (a frozen copy of a cluster's station list) and **Area** (a polygon drawn on the map, resolved to stations at save time by point-in-polygon on zone/tree centroids; polygon kept for drawing). A pin has a title, house, crop, observation (optional — blank watches every pest/disease shown), owner, `shared` (default on). |
| C7 | A pin's weekly figure = infested ÷ scouted among its stations (raw share; with < 5 scouted stations shown as "too few scouted"). The modal's **Pins** panel lists the house's pins with the last 8 scouted weeks as a sparkline. |
| C8 | The pin owner gets one in-app notification (category `scouting`) per pin per week when its figure rises by ≥ 10 points over the previous scouted week with ≥ 5 stations scouted both weeks. Owner only; no email. |
| C9 | Visibility: shared pins are visible to every SCP user who can see the house; private pins only to the owner. Edit/delete: owner, SCP General Manager, System Manager. |
| C10 | Drawing: click to add a vertex, double-click (or "Finish") to close, Esc cancels — on the rose Heatmaps modal (SVG) and the avocado tree map (maplibre). No draw library. |

## Design

### 1. Fine positions

`_prevalence_rows` gains `station_ranks(warehouse) → {station: (row_rank, col_rank)}` from the same ordered `groups`/`members` used by `grid_positions` (bed rank, zone rank within bed; row rank, tree rank within row — tree number from the name's trailing int since `tree` is 0). Cached beside `station_grid` with the same key family and invalidation.

### 2. Clusters — `common/clusters.py` (pure)

- `clusters(ranks, infested) → [{stations, size, centroid, rows:(min,max), cols:(min,max)}]` — union-find over C1 neighbours, size ≥ 3, sorted by size desc, top 5.
- `track(current, previous) → current with change ∈ {New, Grew, Shrank, Moved, Stable}` + `gone` list, per C3.
- Labels: "beds 20–24, zones 3–7" (rose) / "rows 4–6, trees 10–15" (avocado).

### 3. Endpoints

- `get_house_clusters(crop, warehouse, observation, kind, stage=None, week=None)` → `{week, prev_week, clusters, gone}`; stations returned by name so the maps can outline them from their geometry.
- `list_pins(crop, warehouse)`, `save_pin(...)`, `delete_pin(name)`, `pin_series(name, weeks=8)`.
- Area pins: `save_pin` with `polygon` (GeoJSON) resolves stations server-side (zone/tree centroid inside polygon, using existing geometry + `zone-utils` equivalents in Python via shapely if present, else a ray-casting helper in `clusters.py`).

### 4. Scouting Pin doctype

Fields: title, crop, farm, warehouse, kind (Section/Patch/Area), observation, obs_kind (Pest/Disease), stage, section_row, section_col, stations (Long Text JSON list), polygon (Long Text GeoJSON), source_week, shared, notify (Check, default 1), last_notified_week. Permissions per C9 (controller checks owner/GM for write and delete). Applied with `reload_doc` (no migrate).

### 5. Pin check

The hourly `run_threshold_check` calls `check_pins()` after alerts: per pin with `notify`, compute this week vs previous scouted week (C7/C8), notify the owner at most once per ISO week (`last_notified_week`). Failures are logged and never block the alert check.

### 6. Frontend

- `GreenhouseModal`: Patches list (change pills: New/Grew/Shrank/Moved/Stable, Gone listed muted); Pins panel with sparkline and "Pin this section" on SectionGrid cells, "Pin this patch" on a patch row.
- `BedSvg`: `overlays` prop draws patch outlines and area pins (stroke only, no fills over markers; no left-border strips); Heatmaps modal gets a "Draw area" mode.
- `AvocadoTreeMap`: a `patches` geojson source (line layer) and a draw mode with a temporary line/fill source.

## Out of scope

GPS-based adjacency; cluster notifications; pins on Terrain3D; editing a pin's shape after save (delete and redraw); the email provider fix (left alone per the user).

## Testing

- Pure: union-find neighbours incl. diagonal; size < 3 dropped; top-5 cap; tracking New/Grew/Shrank/Moved/Stable/Gone with hand-built sets; point-in-polygon.
- DB (2031 fixture, rolled back): `station_ranks` matches bed/zone order; `get_house_clusters` for a crafted two-week house; save/list/delete pins incl. visibility and permission; area pin resolves stations; pin series; pin notification once per week, owner only, ≥10 points rule.
- Frontend (vitest): Patches list + pills; pin buttons; Pins panel sparkline; overlays render outlines; draw mode adds vertices and finishes on double-click.
