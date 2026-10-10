# Spread and Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show where an outbreak sits inside a greenhouse or block. A **patch** is a set of neighbouring infested stations (rose zones, avocado trees) in one house, one ISO week and one observation. The plan reports how each patch changed since the previous scouted week: New, Grew, Shrank, Moved or Stable, and lists the ones that are Gone. Agronomists can also **pin** an area and watch its weekly figure. A pin is a section of the 3 × 3 grid, a frozen copy of a patch, or an area drawn on the map. The greenhouse modal gets a Patches list and a Pins panel with sparklines. The rose Heatmaps modal and the avocado tree map draw patch outlines and let a user draw an area. The 17:00 digest's hot-spot rows say "patch of N zones, grew". A pin's owner gets one in-app notice a week when the pin's figure jumps 10 points or more. Clusters never raise notifications of their own.

**Architecture:** The pure rules live in a new `common/clusters.py`. It holds union-find over the C1 8-neighbour rank grid, the C2 size and top-5 cut, `track` (C3), the labels, ray-casting point-in-polygon, GeoJSON centroids, and the pin figure and rise rule (C7/C8). `common/prevalence.py` gains `rank_positions`, built from the same ordered groups as `grid_positions`. `_prevalence_rows` gains `station_ranks(warehouse)`, cached beside `station_grid` and dropped by the same invalidation. `StationWeeks` gains `scouted_set`. The new `scouting/spread.py` computes a house's patches on demand from `StationWeeks.load`, so piece 1 crop scoping holds. It exposes `get_house_clusters` through the dashboard aggregate cache (schema tag `pin1`) and gives the digest its `patch_note`. A new doctype **Scouting Pin** and `scouting/pins.py` handle save/list/delete with C9 visibility and edit rights, area pins resolved server-side from Zone / Orchard Tree centroids, the 8-week series, and `check_pins`. The hourly `run_threshold_check` calls `check_pins` after the alerts; a pin failure is logged and never blocks the alert check. On the frontend, `lib/spread-api.ts` and `lib/hull.ts` feed four new pieces: `HouseSpread` (SectionGrid + Patches + Pins in the greenhouse modal), `BedSvg` overlays and draft drawing, a `useDrawArea` hook, and the avocado `patch-features` GeoJSON builders.

**Tech Stack:** Frappe v16 / Python 3.14, MariaDB, Redis; React 19 + TypeScript + Vite + vitest (jsdom, @testing-library/react), maplibre-gl in `frontend/`.

**Spec:** `docs/superpowers/specs/2026-10-10-spread-and-pins-design.md` (binding; C1–C10 are rulings). It builds on piece 2 (`common/prevalence.py`, `_prevalence_rows.StationWeeks`, the station grid cache), 3a (`docs/superpowers/plans/2026-10-10-thresholds-and-actions.md`) and 3b (`docs/superpowers/plans/2026-10-10-hot-spots.md`). Line numbers below are hints taken at HEAD `2a856bc`. **3b is being built at the same time on this branch** and changes `thresholds_check.py`, `alert_digest.py`, `_gh_detail.py`, `_common.py`, `SectionGrid.tsx` and the GreenhouseModal tests. Always find code **by name** (function, constant, JSX element), never by line number alone.

## Global Constraints

- Site is **`kaitet.local`** only (read-only SQL: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT …"`). **Never use the Kaitet MCP** (`mcp__claude_ai_Kaitet*`), for anything.
- Commits: **no `Co-Authored-By` trailer** (CLAUDE.md). Style `feat(scp): …` / `fix(scp): …` / `feat(scp-ui): …`, lowercase sentence.
- Stage with explicit `git add <paths>` only. **Never stage** the unrelated uncommitted store/batch-transfer work: `frontend/src/components/store/TransferBatchPanel.tsx`, `frontend/src/lib/store-keeper-api.ts`, `frontend/src/pages/SprayPlanTransfers.tsx`, `upande_scp/serverscripts/store/batch_suggestion.py`, `upande_scp/serverscripts/store/store_keeper_api.py`, `upande_scp/serverscripts/tests/test_batch_suggestion.py`, `upande_scp/serverscripts/tests/test_transfer_batch_apply.py`, `upande_scp/serverscripts/tests/test_transfer_batch_gating.py`, `upande_scp/serverscripts/tests/test_transfer_batch_split.py`. Never `git add -A` / `git add .` / `git commit -a`. **Never `git stash`.** Run `git status --short` before every commit. Also never stage 3b's in-flight files unless a step here edits them. If a file this plan edits also carries uncommitted 3b changes, stop and wait for 3b's commit first. Never commit another plan's hunks.
- **NEVER restart anything on this server**: no `supervisorctl restart`, no `bench restart`, no MariaDB/Redis restart. Another live site streams data on this server. `yarn build` is allowed. Consequence: the running web workers keep the old Python until someone else restarts them. So every server-side check in this plan runs **in-process through the DB runner**, never through the web server.
- Schema changes go through doctype JSON. Apply them with the DB runner (`frappe.reload_doc(..., force=True)`, a patch's `execute()` plus a `Patch Log` row, `ensure_scp_custom_fields()`), as each task spells out. `bench --site kaitet.local migrate` restarts no service (verified in `apps/frappe/frappe/migrate.py`: it clears the site cache and kills that site's DB connections idle > 30 s). It does run every pending patch and hook of every app, so use it **only** if you have checked that nothing streams into kaitet.local's database (`_a0667cbad37a1f08`) at that moment. If unsure, use the DB-runner path. **This plan adds one doctype (Scouting Pin) and applies it with `reload_doc` only. It needs no migrate and no patch.**
- **No email is sent during tests**: every test that can reach `frappe.sendmail` patches it (`patch.object(frappe, "sendmail")`). Live email is at the free-Gmail cap. This piece sends **no email at all**. A patch reaches email only as a few words on an existing hot-spot row of the daily digest.
- Notifications go **only** through `common/notifications.notify(...)` with `category="scouting"`. `notify` writes `Notification Log.type = "Alert"`, which Frappe never emails (`is_email_notifications_enabled_for_type` returns False for "Alert"). **Clusters notify nobody** (C5). A pin notifies **its owner only**, at most once per pin per ISO week (C8).
- Indentation matches each file: 4 spaces in `common/clusters.py`, `common/prevalence.py`, `common/cache_utils.py`, `dashboard_aggregates/*`, `scouting/*` and every test module; **tabs** in doctype controllers (`scouting_pin.py`); 1 space in doctype JSON; 2 spaces in TS/TSX.
- UI: **no vertical accent strips and no coloured left-border bars**. Show accent through text colour, a tinted background, a pill, or a full outline. Patch and pin outlines on maps are **stroke only**: never a fill over the markers. The only fill is the faint wash of the polygon being drawn.
- **Piece 1 crop scoping, piece 2 figures, 3a alerts and 3b hot spots keep holding.** Every new scouting query goes through `StationWeeks.load` (→ `parent_filter_conditions` D5 + `obs_filter` D4). This plan adds two new reads, neither of which touches scouting. `station_ranks` reads the same Zone / Bed / Orchard Tree scan as `station_grid`. The save-time area resolution reads `Zone.geojson` / `Orchard Tree.geojson`. Regression gate, all green at the end of every task that touches their code: `test_dashboard_aggregates_{overview,pests_diseases,gh_detail,traps,fcm}`, `test_prevalence_{rows,overview,pests,trends}`, `test_crop_scoped_{aggregates,aggregate_detail,observations,spray_plan}`, `test_spray_compliance_enforcement`, `test_scouting_alerts`, `test_alert_digest`, `test_scouting_alert_creator`, `test_thresholds_measure`, `test_threshold_measure_dashboards`, `test_hot_spots` (DB), and `test_prevalence_pure`, `test_prevalence_rows_pure`, `test_trends_prevalence_pure`, `test_threshold_core_pure`, `test_threshold_counts_pure`, `test_hot_spots_pure` (pure).
- Exact spec numbers and strings:
  - Patches: **`MIN_SIZE = 3`** stations; **`TOP_N = 5`** largest per house and observation.
  - Neighbours: 8-neighbour on (group rank, rank in group), with **both** differences ≤ 1. Match by centroid when it lies within **`MATCH_RANKS = 2`**.
  - Change labels: **`New` / `Grew` / `Shrank` / `Moved` / `Stable` / `Gone`**. Grew is size ≥ **+25 % and ≥ +3**; Shrank is the mirror.
  - Labels read **`beds 20–24, zones 3–7`** (rose) and **`rows 4–6, trees 10–15`** (avocado), using an en dash and 1-based positions.
  - Pin figure: infested ÷ scouted among the pin's stations. Below **`PIN_MIN_SCOUTED = 5`** scouted it shows **"too few scouted"**.
  - Pin notice: a rise of **≥ `PIN_RISE_POINTS = 10`** points, with ≥ 5 scouted **both** weeks.
  - Series: the last **`SERIES_WEEKS = 8`** scouted weeks.
  - Pin kinds: **`Section` / `Patch` / `Area`**. Edit and delete rights: **owner, `SCP General Manager`, `System Manager`**.
  - Notice text: **`Pin <title> in <house>: <obs> <now>% (was <prev>%) — up <rise> points in <week>`**, where `<obs>` is "every pest and disease" when the pin has no observation.
  - Digest addition: **`patch of <N> <zones|trees>, <change in lowercase>`**.
- **3b concurrency.** Bump the dashboard cache tag `K_DASH_AGG_SCHEMA` to **`"pin1"`**; 3b moved it to `"hot1"`. If 3b's bump has not landed yet, still set `"pin1"` and keep both comment lines. Task 5 needs 3b's digest, where `render` reads `alert_type` / `section_label`, `_figure` knows a hot spot, and `ALERT_FIELDS` carries `alert_type`, `section_row`, `section_col`. If `grep -n "section_label" upande_scp/serverscripts/scouting/alert_digest.py` finds nothing, do Tasks 6–7 first and come back to Task 5.
- Test commands:
  - Pure (no site): `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q <path>`
  - DB (direct runner; tests roll back in `tearDown`): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); import importlib; M=importlib.import_module('upande_scp.serverscripts.tests.<module>'); r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M)); raise SystemExit(not r.wasSuccessful())"`. Written below as **DB-RUN `<module>`**.
  - One-off DB runner (schema): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe; frappe.init(site='kaitet.local'); frappe.connect(); <statements>; frappe.db.commit()"`. Written below as **DB-EXEC `<statements>`**.
  - Frontend: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run <path>`; typecheck `npx tsc --noEmit -p tsconfig.app.json`; build `yarn build`.
- DB tests seed raw-SQL Scouting Entries in **2031-W24 … 2031-W32 (2031-06-09 → 2031-08-10)** through the new `tests/spread_fixture.py`. No other module seeds those weeks: piece 2 uses W02–W13, 3a/3b use W19–W22, and 2032-W52 → 2033-W01 is taken too. kaitet.local has no real scouting in 2031 (its data runs 2026-07-18 → 2026-10-10). Every test that reaches "today" patches `TC.now_eat` to **Sun 2031-08-10 09:00 EAT** (2031-W32). The fixture houses are the first Rose greenhouse, `Chepsito GH 01 - KR`: 74 beds × 9 zones, Bed.bed 1…74, Zone.zone 1…9. The Avocado one is the first avocado block, `AIRSTRIP BLK 1 - KL`: row 1 has 10 trees, row 2 has 17, trees named `…_T<n>`. Tests look both up by fixture (`PF.rose_greenhouses(1)[0]`, `F.avocado_block()`), never by literal name.
- Tests that need other users use committed `_test_scp_pin_*@example.com` users (`TF.ensure_user`, the test_notifications pattern). Scope is patched in two places. `crop_scope.allowed_crops` / `allowed_farms` return `None` for everyone except the stranger, who gets `set()`. `pins._roles` names the GM. Nothing is granted for real.
- `get_house_clusters` writes the dashboard aggregate cache. Tests pass `force=1` so a cached 2031 payload from an earlier run is never read back.

## Review Focus

These are the five failure modes most likely to slip past the tests, each with the test that pins it:

1. **The neighbour rule and the ranks drift apart.** A diagonal that does not join, a gap of one bed that still joins, or ranks that do not follow the grid's own bed/zone order would make patches disagree with the 3 × 3 picture.
   - Task 1 `test_diagonal_neighbours_join`, `test_a_gap_of_one_rank_splits`, `test_rank_positions_share_the_grids_order`.
   - Task 2 `test_ranks_follow_bed_then_zone_order`, `test_the_grid_is_the_ranks_cut_in_thirds`.
2. **Tracking mislabels a patch.** The failures to guard against:
   - Moved where it overlapped, or a centroid match beating a real overlap.
   - A split patch shown as Gone.
   - A small patch that was 6th last week reading New, because the previous week was capped at 5.
   - Grew with only one of its two thresholds met.
   - Tests: Task 1 `test_matched_only_by_centroid_is_moved`, `test_overlap_beats_a_centroid_match`, `test_a_split_patch_keeps_its_parent_and_nothing_is_gone`, `test_grew_needs_a_quarter_and_three_stations`. Task 2 `test_the_previous_week_is_not_capped_at_five`.
3. **Pin visibility or rights leak.** The failures to guard against:
   - A private pin listed to someone else.
   - A non-owner who is not a GM deleting or editing through the endpoint, Desk or `doc.save`.
   - A user who cannot see the house listing its pins.
   - A patch pin smuggling in another house's stations.
   - Tests (Task 3): `test_a_shared_pin_is_seen_by_others_and_a_private_one_only_by_its_owner`, `test_only_the_owner_a_gm_or_a_system_manager_may_delete`, `test_another_user_cannot_edit_a_pin_even_through_the_document`, `test_a_stranger_can_neither_list_nor_save`, `test_a_patch_pin_keeps_only_this_houses_stations`.
4. **Pin notices spam or block.** The failures to guard against:
   - The hourly check re-notifying every hour.
   - A 9-point rise or a thin week notifying.
   - Anyone but the owner being told.
   - A pin failure stopping the alert check.
   - Tests (Task 4): `test_a_ten_point_rise_tells_the_owner_once_a_week`, `test_a_rise_under_ten_points_is_silent`, `test_a_thin_week_is_silent`, `test_notify_off_is_never_checked`, `test_the_hourly_check_runs_pins_after_alerts_and_survives_their_failure`.
5. **Area pins resolve the wrong stations.** The failures to guard against:
   - lat/lng swapped somewhere between the drawn SVG, the inverse projection, the stored GeoJSON and the server's point-in-polygon.
   - A zone's centroid computed differently from the map's.
   - Tests: Task 1 `test_point_in_polygon_reads_lng_lat`, `test_geometry_centroid_matches_the_maps`. Task 3 `test_an_area_pin_resolves_the_zone_under_its_polygon`, `test_an_area_pin_on_a_block_resolves_its_tree`. Task 7 `bed-projection.unproject.test.ts` ("unprojects every zone centroid back to its lng/lat").

---

## File Structure

| Path | Responsibility |
|---|---|
| `upande_scp/serverscripts/common/clusters.py` (new) | `MIN_SIZE`, `TOP_N`, `MATCH_RANKS`, `PIN_MIN_SCOUTED`, `PIN_RISE_POINTS`, change names; `components`, `clusters`, `change_of`, `track`, `label`, `parse_geojson`, `polygons`, `point_in_polygon`, `stations_in_polygon`, `geometry_centroid`, `share`, `pin_rises` |
| `upande_scp/serverscripts/common/prevalence.py` (mod) | `_ordered_groups` shared by `grid_positions` and the new `rank_positions` |
| `upande_scp/serverscripts/common/cache_utils.py` (mod) | `K_STATION_RANKS_PREFIX`; `invalidate_station_grid_for_doc` drops ranks too |
| `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (mod) | `_station_rows`, `_load_ranks`, `ranks_key`, `station_ranks`; `StationWeeks.scouted_set` |
| `upande_scp/serverscripts/dashboard_aggregates/_common.py` (mod) | `K_DASH_AGG_SCHEMA = "pin1"` |
| `upande_scp/serverscripts/scouting/spread.py` (new) | `house_clusters`, `get_house_clusters` (whitelisted, cached), `patch_note` |
| `upande_scp/upande_scp/doctype/scouting_pin/` (new) | `__init__.py`, `scouting_pin.json`, `scouting_pin.py` (edit/delete guard) |
| `upande_scp/serverscripts/scouting/pins.py` (new) | `may_edit`, `assert_may_edit`, `pin_stations`, `station_centroids`, `save_pin` / `list_pins` / `delete_pin` / `pin_series` (whitelisted), `check_pins` |
| `upande_scp/serverscripts/scouting/thresholds_check.py` (mod) | `run_threshold_check` calls `pins.check_pins` after the crops |
| `upande_scp/serverscripts/scouting/alert_digest.py` (mod) | `_patch_suffix` on hot-spot rows |
| `upande_scp/serverscripts/tests/spread_fixture.py` (new) | Weeks W24–W32, `by_rank`, `rect`, `seed`, `seed_cells`, `section_stations` |
| `upande_scp/serverscripts/tests/test_clusters_pure.py` (new) | Pure rules |
| `upande_scp/serverscripts/tests/test_spread.py` (new) | Ranks, house clusters, digest note (DB) |
| `upande_scp/serverscripts/tests/test_scouting_pins.py` (new) | Pins CRUD, visibility, area pins, series, the check (DB) |
| `frontend/src/lib/spread-api.ts` (+ test) (new) | Types, calls, `isoWeekKey`, `stationWord`, `patchLine`, `pinValueLabel`, `CHANGE_TONE` |
| `frontend/src/pages/dashboard/{PatchesList,PinsPanel,PinForm,HouseSpread}.tsx` (new) | Patches list + pills, pins + sparkline, the pin form, the modal's spread block |
| `frontend/src/pages/dashboard/SectionGrid.tsx` (mod) | Optional `onPinSection` ("Pin" per cell) |
| `frontend/src/pages/dashboard/GreenhouseModal.tsx` (mod) | Renders `HouseSpread` in place of the bare `SectionGrid` |
| `frontend/src/pages/dashboard/__tests__/GreenhouseModal.spread.test.tsx` (new), `GreenhouseModal.sections.test.tsx` (mod) | Patches, pins, sparkline, no strips; mock the new API |
| `frontend/src/lib/hull.ts` (+ test) (new) | `convexHull`, `outlinePath`, `closedRing` |
| `frontend/src/pages/maps/bed-projection.ts` (mod) | `ProjectedGeometry.unproject` |
| `frontend/src/pages/maps/BedSvg.tsx` (mod) | `overlays`, `draft`, `onCanvasClick`, `onCanvasDoubleClick` |
| `frontend/src/pages/maps/{use-draw-area,use-house-overlays}.ts`, `DrawAreaBar.tsx` (new) | Draw mode, a house's overlays, the draw/save bar |
| `frontend/src/pages/avocado/patch-features.ts` (+ test) (new) | GeoJSON for patches, pin outlines and the draft |
| `frontend/src/pages/Heatmaps.tsx`, `pages/avocado/{AvocadoTreeMap,AvocadoObservations}.tsx`, `tree-map-types.ts` (mod) | Wire overlays and drawing |
| `frontend/src/pages/maps/__tests__/{BedSvg.overlays.test.tsx,bed-projection.unproject.test.ts}`, `pages/avocado/__tests__/patch-features.test.ts` (new) | Outlines, drawing, inverse projection, avocado features |

---

### Task 1: The pure spread rules

**Files:**
- Create: `upande_scp/serverscripts/common/clusters.py`
- Modify: `upande_scp/serverscripts/common/prevalence.py` (`grid_positions`, lines 80–104)
- Test: `upande_scp/serverscripts/tests/test_clusters_pure.py` (new)

**Interfaces:**
- Consumes: `prevalence._order_key`, `prevalence.GRID`.
- Produces:
  - `P.rank_positions(stations) -> {name: (group_rank, rank_in_group)}`, 0-based. It takes the same `{"name", "group", "group_no", "no"}` input as `grid_positions`, and `grid_positions` now reads the same `_ordered_groups`.
  - `C.clusters(ranks, infested, limit=5) -> [{"stations": [sorted names], "size", "centroid": (r, c), "rows": (min, max), "cols": (min, max)}]`, sorted by size descending, then front-most, then name.
  - `C.track(current, previous, gone_limit=5) -> (current + {"change", "prev_size"}, gone + {"change": "Gone", "prev_size"})`.
  - `C.label(cluster, unit) -> "beds 1–3, zones 1–3"`.
  - `C.parse_geojson`, `C.polygons`, `C.point_in_polygon((lng, lat), geom)`, `C.stations_in_polygon({name: (lng, lat)}, geom) -> [sorted]`, `C.geometry_centroid(geom) -> (lng, lat) | None`.
  - `C.share(stations, scouted, infested) -> {"scouted", "infested", "value", "thin"}`, `C.pin_rises(before, now) -> bool`.

- [ ] **Step 1: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_clusters_pure.py`:

```python
"""Spread and pins (piece 3c) — the pure rules. Plain pytest, no site."""

import json
import unittest

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import prevalence as P


def house(rows, cols):
    """A full rows × cols house: station "r:c" sits at rank (r, c)."""
    return {f"{r}:{c}": (r, c) for r in range(rows) for c in range(cols)}


RANKS = house(16, 12)
SQUARE = {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]]}


def at(*cells):
    return {f"{r}:{c}" for r, c in cells}


def rect(r0, c0, h, w):
    return [(r, c) for r in range(r0, r0 + h) for c in range(c0, c0 + w)]


def patch(*cells):
    return C.clusters(RANKS, at(*cells), limit=None)[0]


def changes(current, previous):
    found, gone = C.track(current, previous)
    return [(c["size"], c["change"], c["prev_size"]) for c in found], [(g["size"], g["change"]) for g in gone]


class TestClusters(unittest.TestCase):
    def test_diagonal_neighbours_join(self):
        found = C.clusters(RANKS, at((0, 0), (1, 1), (2, 2)))
        self.assertEqual([c["stations"] for c in found], [["0:0", "1:1", "2:2"]])

    def test_a_gap_of_one_rank_splits(self):
        found = C.clusters(RANKS, at(*rect(0, 0, 1, 3), *rect(0, 4, 1, 3)))
        self.assertEqual([(c["size"], c["cols"]) for c in found], [(3, (0, 2)), (3, (4, 6))])
        # Bed ranks 0 and 2 never touch, whatever their zones.
        self.assertEqual(C.clusters(RANKS, at((0, 0), (0, 1), (2, 0))), [])

    def test_fewer_than_three_stations_are_no_patch(self):
        self.assertEqual(C.MIN_SIZE, 3)
        self.assertEqual(C.clusters(RANKS, at((0, 0), (0, 1), (9, 9))), [])

    def test_only_the_five_largest_are_reported(self):
        cells = []
        for k, size in enumerate((3, 3, 4, 5, 3, 6)):
            cells += rect(2 * k, 0, 1, size)              # rows 0, 2, …, 10: never touching
        found = C.clusters(RANKS, at(*cells))
        self.assertEqual(C.TOP_N, 5)
        self.assertEqual([(c["size"], c["rows"][0]) for c in found], [(6, 10), (5, 6), (4, 4), (3, 0), (3, 2)])
        self.assertEqual(len(C.clusters(RANKS, at(*cells), limit=None)), 6)

    def test_a_patch_carries_its_shape(self):
        c = C.clusters(RANKS, at(*rect(2, 3, 2, 2)))[0]
        self.assertEqual((c["size"], c["centroid"], c["rows"], c["cols"]), (4, (2.5, 3.5), (2, 3), (3, 4)))

    def test_stations_without_a_rank_are_ignored(self):
        self.assertEqual(C.clusters(RANKS, at((0, 0), (0, 1)) | {"not-in-this-house"}), [])


class TestTrack(unittest.TestCase):
    def test_no_previous_week_means_new(self):
        self.assertEqual(changes([patch(*rect(0, 0, 1, 3))], []), ([(3, "New", None)], []))

    def test_grew_needs_a_quarter_and_three_stations(self):
        before = patch(*rect(0, 0, 2, 6))                                                  # 12
        self.assertEqual(changes([patch(*rect(0, 0, 3, 5))], [before])[0], [(15, "Grew", 12)])    # +3, +25 %
        self.assertEqual(changes([patch(*rect(0, 0, 2, 7))], [before])[0], [(14, "Stable", 12)])  # +2
        big = patch(*rect(0, 0, 4, 5))                                                     # 20
        self.assertEqual(changes([patch(*rect(0, 0, 4, 5), *rect(4, 0, 1, 3))], [big])[0],
                         [(23, "Stable", 20)])                                            # +3 but +15 %

    def test_shrank_mirrors_grew(self):
        before = patch(*rect(0, 0, 2, 6))                                                  # 12
        self.assertEqual(changes([patch(*rect(0, 0, 3, 3))], [before])[0], [(9, "Shrank", 12)])   # −3, −25 %
        self.assertEqual(changes([patch(*rect(0, 0, 2, 5))], [before])[0], [(10, "Stable", 12)])  # −2

    def test_matched_only_by_centroid_is_moved(self):
        before = patch(*rect(0, 0, 3, 1))                                                  # centroid (1, 0)
        self.assertEqual(changes([patch(*rect(0, 2, 3, 1))], [before]), ([(3, "Moved", 3)], []))
        self.assertEqual(changes([patch(*rect(0, 3, 3, 1))], [before]), ([(3, "New", None)], [(3, "Gone")]))

    def test_overlap_beats_a_centroid_match(self):
        a = patch(*rect(0, 0, 1, 3))                                                       # centroid (0, 1)
        b = patch(*rect(4, 0, 1, 3))                                                       # centroid (4, 1)
        t = patch((1, 0), (1, 1), (1, 2), (2, 1), (3, 1), (4, 1))                          # centroid (2, 1)
        self.assertEqual(changes([t], [a, b]), ([(6, "Grew", 3)], [(3, "Gone")]))
        self.assertEqual(C.track([t], [a, b])[1][0]["stations"], a["stations"])

    def test_a_split_patch_keeps_its_parent_and_nothing_is_gone(self):
        before = patch(*rect(0, 0, 1, 7))
        halves = [patch(*rect(0, 0, 1, 3)), patch(*rect(0, 4, 1, 3))]
        self.assertEqual(changes(halves, [before]), ([(3, "Shrank", 7), (3, "Shrank", 7)], []))

    def test_gone_lists_the_five_largest(self):
        previous = [patch(*rect(2 * k, 0, 1, 3 + k)) for k in range(6)]
        found, gone = C.track([], previous)
        self.assertEqual((found, [g["size"] for g in gone]), ([], [8, 7, 6, 5, 4]))


class TestLabels(unittest.TestCase):
    def test_labels_speak_beds_and_zones_or_rows_and_trees(self):
        self.assertEqual(C.label({"rows": (19, 23), "cols": (2, 6)}, "bed"), "beds 20–24, zones 3–7")
        self.assertEqual(C.label({"rows": (3, 5), "cols": (9, 14)}, "row"), "rows 4–6, trees 10–15")
        self.assertEqual(C.label({"rows": (4, 4), "cols": (2, 2)}, "bed"), "bed 5, zone 3")


class TestGeometry(unittest.TestCase):
    def test_point_in_polygon_reads_lng_lat(self):
        self.assertTrue(C.point_in_polygon((1.5, 0.5), SQUARE))
        self.assertFalse(C.point_in_polygon((0.5, 1.5), SQUARE))

    def test_holes_multipolygons_features_and_strings(self):
        holed = {"type": "Polygon", "coordinates": [[[0, 0], [4, 0], [4, 4], [0, 4]],
                                                    [[1, 1], [3, 1], [3, 3], [1, 3]]]}
        self.assertTrue(C.point_in_polygon((0.5, 0.5), holed))
        self.assertFalse(C.point_in_polygon((2, 2), holed))
        multi = {"type": "MultiPolygon",
                 "coordinates": [SQUARE["coordinates"], [[[10, 10], [11, 10], [11, 11], [10, 11]]]]}
        self.assertTrue(C.point_in_polygon((10.5, 10.5), multi))
        feature = json.dumps({"type": "Feature", "geometry": SQUARE})
        self.assertTrue(C.point_in_polygon((1, 0.5), feature))
        self.assertEqual(C.polygons("not json"), [])
        self.assertEqual(C.polygons({"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]}), [])

    def test_geometry_centroid_matches_the_maps(self):
        zone = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[35.0, 0.0], [35.2, 0.2]]}}]}
        lng, lat = C.geometry_centroid(zone)
        self.assertAlmostEqual(lng, 35.1)
        self.assertAlmostEqual(lat, 0.1)
        tree = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [34.85, 0.98]}}
        self.assertEqual(C.geometry_centroid(json.dumps(tree)), (34.85, 0.98))
        self.assertIsNone(C.geometry_centroid(None))
        self.assertIsNone(C.geometry_centroid("{}"))

    def test_stations_in_polygon(self):
        centroids = {"a": (0.5, 0.5), "b": (1.9, 0.9), "c": (2.5, 0.5)}
        self.assertEqual(C.stations_in_polygon(centroids, SQUARE), ["a", "b"])
        self.assertEqual(C.stations_in_polygon(centroids, None), [])


class TestPinRules(unittest.TestCase):
    def test_share_is_infested_over_scouted_among_the_pins_stations(self):
        stations = ["a", "b", "c", "d", "e", "f"]
        self.assertEqual(C.share(stations, set(stations) | {"x"}, {"a", "b", "x"}),
                         {"scouted": 6, "infested": 2, "value": 33.3, "thin": False})
        self.assertEqual(C.share(stations, {"a", "b", "c", "d"}, {"a"}),
                         {"scouted": 4, "infested": 1, "value": None, "thin": True})
        self.assertEqual(C.PIN_MIN_SCOUTED, 5)

    def test_a_rise_needs_ten_points_and_five_stations_both_weeks(self):
        def fig(v):
            return {"value": v}
        self.assertEqual(C.PIN_RISE_POINTS, 10)
        self.assertTrue(C.pin_rises(fig(50.0), fig(60.0)))
        self.assertFalse(C.pin_rises(fig(50.0), fig(59.9)))
        self.assertFalse(C.pin_rises(fig(None), fig(80.0)))
        self.assertFalse(C.pin_rises(fig(10.0), fig(None)))
        self.assertFalse(C.pin_rises(None, fig(80.0)))


class TestRanks(unittest.TestCase):
    def test_rank_positions_share_the_grids_order(self):
        stations = [
            {"name": f"B{b}-Z{z}", "group": f"Bed {b}", "group_no": b, "no": z}
            for b in (3, 1, 2, 10) for z in range(1, 2 + b)
        ]
        ranks = P.rank_positions(stations)
        grid = P.grid_positions(stations)
        self.assertEqual((ranks["B1-Z1"], ranks["B10-Z11"]), ((0, 0), (3, 10)))
        size: dict = {}
        for r, _c in ranks.values():
            size[r] = size.get(r, 0) + 1
        for name, (r, c) in ranks.items():
            self.assertEqual(grid[name], ((3 * r) // 4, (3 * c) // size[r]))

    def test_trees_rank_by_their_names_trailing_number(self):
        trees = [{"name": f"BLK1_ROW1_T{n}", "group": "Row 1", "group_no": 1,
                  "no": P.station_number(0, f"BLK1_ROW1_T{n}")} for n in (10, 2, 1)]
        self.assertEqual(P.rank_positions(trees),
                         {"BLK1_ROW1_T1": (0, 0), "BLK1_ROW1_T2": (0, 1), "BLK1_ROW1_T10": (0, 2)})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_clusters_pure.py`
Expected: collection FAILS with `ImportError: cannot import name 'clusters' from 'upande_scp.serverscripts.common'`.

- [ ] **Step 3: `rank_positions` in `prevalence.py`**

In `upande_scp/serverscripts/common/prevalence.py`, replace the whole `grid_positions` function (find it by name) with:

```python
def _ordered_groups(stations) -> list:
    """One house's stations as ordered groups: beds (orchard rows) by number,
    then name; each group's stations by number, then name. The one ordering
    both ``grid_positions`` and ``rank_positions`` read (spread spec §1)."""
    groups: dict = {}
    group_no: dict = {}
    for s in stations:
        g = s.get("group") or ""
        groups.setdefault(g, []).append(s)
        group_no.setdefault(g, s.get("group_no"))
    ordered = sorted(groups, key=lambda g: _order_key(group_no[g], g))
    return [sorted(groups[g], key=lambda s: _order_key(s.get("no"), s["name"])) for g in ordered]


def grid_positions(stations) -> dict:
    """``{station_name: (row, col)}`` for one greenhouse/block (spec D3).

    ``stations`` yields ``{"name", "group", "group_no", "no"}``: ``group`` is the
    bed (rose) or row (avocado) the station sits in, ``group_no`` / ``no`` their
    order numbers (``None`` = unparsable → name order). Groups are ranked ``b`` of
    ``B``; a station is ranked ``z`` of ``Z_b`` inside its group; its section is
    ``(floor(3·b/B), floor(3·z/Z_b))``. Fewer than 3 groups, or a group of 1–2
    stations, still maps every station; the unused sections stay empty.
    """
    ordered = _ordered_groups(stations)
    n_groups = len(ordered)
    out: dict = {}
    for b, members in enumerate(ordered):
        row = (GRID * b) // n_groups
        size = len(members)
        for z, s in enumerate(members):
            out[s["name"]] = (row, (GRID * z) // size)
    return out


def rank_positions(stations) -> dict:
    """``{station_name: (group rank, rank within the group)}``, 0-based: bed rank
    and zone rank within the bed (rose), row rank and tree rank within the row
    (avocado). Same ordering as ``grid_positions``, so a station's grid cell is
    always ``(3·b // B, 3·z // Z_b)`` of its ranks (spread spec §1)."""
    return {
        s["name"]: (b, z)
        for b, members in enumerate(_ordered_groups(stations))
        for z, s in enumerate(members)
    }
```

- [ ] **Step 4: Create `common/clusters.py`**

```python
"""Spread — patches of neighbouring infested stations, how they changed since
the previous scouted week, and the geometry and figures pins need.

Spec: docs/superpowers/specs/2026-10-10-spread-and-pins-design.md (C1–C3, C7, C8, §2).

* A **patch** (cluster) is a connected set of infested stations of one house,
  one ISO week and one observation. Two stations touch when their group ranks
  (bed / orchard row) differ by at most 1 **and** their ranks within the group
  (zone / tree) differ by at most 1: 8-neighbour on the rank grid (C1). No GPS.
* Only patches of ``MIN_SIZE`` (3) or more stations count, and the ``TOP_N`` (5)
  largest are reported (C2).
* ``track`` matches each patch with the previous scouted week's: by shared
  stations first, else by a centroid within ``MATCH_RANKS`` (2) ranks on both
  axes (C3).
* ``share`` / ``pin_rises`` are a pin's weekly figure and its notice rule (C7, C8).
* ``point_in_polygon`` / ``geometry_centroid`` resolve an area pin to its
  stations; every point is (lng, lat), GeoJSON order. Ray casting, always: the
  same answer on every site whether or not shapely is installed.

No frappe import: this runs under plain pytest.
"""

import json

MIN_SIZE = 3
TOP_N = 5
MATCH_RANKS = 2
GROW_SHARE = 0.25
GROW_MIN = 3
PIN_MIN_SCOUTED = 5
PIN_RISE_POINTS = 10

NEW, GREW, SHRANK, MOVED, STABLE, GONE = "New", "Grew", "Shrank", "Moved", "Stable", "Gone"
CHANGES = (NEW, GREW, SHRANK, MOVED, STABLE, GONE)

_NEIGHBOURS = tuple((dr, dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc)
_UNITS = {"bed": ("bed", "zone"), "row": ("row", "tree")}


# ── patches (C1, C2) ───────────────────────────────────────────────────────


def _root(parent: dict, x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def components(ranks: dict, infested) -> list:
    """Connected sets (C1) of the ``infested`` stations that have a rank;
    stations without one (not set up in the house) are ignored."""
    at: dict = {}
    for station in sorted(set(infested or ())):
        pos = ranks.get(station)
        if pos is not None:
            at[(int(pos[0]), int(pos[1]))] = station
    parent = {station: station for station in at.values()}
    for (r, c), station in at.items():
        for dr, dc in _NEIGHBOURS:
            other = at.get((r + dr, c + dc))
            if other is None:
                continue
            a, b = _root(parent, station), _root(parent, other)
            if a != b:
                parent[max(a, b)] = min(a, b)
    groups: dict = {}
    for station in parent:
        groups.setdefault(_root(parent, station), set()).add(station)
    return list(groups.values())


def _sort_key(c) -> tuple:
    return (-c["size"], c["rows"][0], c["cols"][0], c["stations"][0])


def _shape(stations, ranks) -> dict:
    pts = [ranks[s] for s in stations]
    rows = [int(p[0]) for p in pts]
    cols = [int(p[1]) for p in pts]
    return {
        "stations": sorted(stations),
        "size": len(pts),
        "centroid": (round(sum(rows) / len(pts), 2), round(sum(cols) / len(pts), 2)),
        "rows": (min(rows), max(rows)),
        "cols": (min(cols), max(cols)),
    }


def clusters(ranks: dict, infested, limit=TOP_N) -> list:
    """Patches of ≥ MIN_SIZE stations, largest first (ties: nearest the front
    of the house, then by name), at most ``limit`` (None = every patch)."""
    found = [_shape(g, ranks) for g in components(ranks, infested) if len(g) >= MIN_SIZE]
    found.sort(key=_sort_key)
    return found if limit is None else found[:limit]


# ── week to week (C3) ──────────────────────────────────────────────────────


def _distance(a, b) -> float:
    """Rank-space distance: the larger of the two axis differences, the same
    metric the 8-neighbour rule uses."""
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def change_of(size, prev_size, overlap) -> str:
    """C3 for a matched patch: Moved when it was matched only by centroid;
    else Grew / Shrank on a change of at least 25 % **and** at least 3
    stations; else Stable."""
    if not overlap:
        return MOVED
    delta = size - prev_size
    if delta >= GROW_MIN and delta >= GROW_SHARE * prev_size:
        return GREW
    if -delta >= GROW_MIN and -delta >= GROW_SHARE * prev_size:
        return SHRANK
    return STABLE


def track(current, previous, gone_limit=TOP_N) -> tuple:
    """``(current with change + prev_size, gone)`` (C3).

    Each current patch takes the previous patch it shares the most stations
    with (ties: the nearer centroid, then the earlier one). Failing any overlap,
    it takes the previous patch whose centroid is nearest, within MATCH_RANKS.
    Several current patches may take the same previous one (a patch that
    split). A previous patch nobody took is Gone: at most ``gone_limit``,
    largest first. Pass ``previous`` uncapped (``clusters(..., limit=None)``)
    so a small patch that was sixth last week still matches."""
    previous = list(previous or ())
    prev_sets = [set(p["stations"]) for p in previous]
    taken: set = set()
    out = []
    for c in current or ():
        mine = set(c["stations"])
        best, best_key = None, None
        for i, p in enumerate(previous):
            shared = len(mine & prev_sets[i])
            dist = _distance(c["centroid"], p["centroid"])
            if shared:
                key = (0, -shared, dist, i)
            elif dist <= MATCH_RANKS:
                key = (1, 0, dist, i)
            else:
                continue
            if best_key is None or key < best_key:
                best, best_key = i, key
        if best is None:
            out.append({**c, "change": NEW, "prev_size": None})
            continue
        taken.add(best)
        prev_size = previous[best]["size"]
        out.append({**c, "change": change_of(c["size"], prev_size, best_key[0] == 0), "prev_size": prev_size})
    gone = sorted((p for i, p in enumerate(previous) if i not in taken), key=_sort_key)
    if gone_limit is not None:
        gone = gone[:gone_limit]
    return out, [{**p, "change": GONE, "prev_size": p["size"]} for p in gone]


def _span(noun, lo, hi) -> str:
    if lo == hi:
        return f"{noun} {lo + 1}"
    return f"{noun}s {lo + 1}–{hi + 1}"


def label(cluster, unit="bed") -> str:
    """``beds 20–24, zones 3–7`` / ``rows 4–6, trees 10–15``: 1-based rank
    positions, which are the bed / zone numbers where a house numbers them 1…N."""
    group, member = _UNITS.get(unit, _UNITS["bed"])
    return f"{_span(group, *cluster['rows'])}, {_span(member, *cluster['cols'])}"


# ── geometry for area pins ─────────────────────────────────────────────────


def parse_geojson(value):
    """A GeoJSON dict from a dict or a JSON string; None for anything else."""
    if isinstance(value, dict):
        return value
    if not value or not isinstance(value, str):
        return None
    try:
        out = json.loads(value)
    except ValueError:
        return None
    return out if isinstance(out, dict) else None


def polygons(geom) -> list:
    """A Polygon, a MultiPolygon or a Feature of either → ``[[outer, hole, …], …]``
    with every ring a list of (lng, lat) of ≥ 3 points; ``[]`` when there is none."""
    geom = parse_geojson(geom)
    if not geom:
        return []
    if geom.get("type") == "Feature":
        return polygons(geom.get("geometry"))
    coords = geom.get("coordinates") or []
    if geom.get("type") == "Polygon":
        polys = [coords]
    elif geom.get("type") == "MultiPolygon":
        polys = list(coords)
    else:
        return []
    out = []
    try:
        for poly in polys:
            if not poly or len(poly[0]) < 3:
                continue
            out.append([[(float(p[0]), float(p[1])) for p in ring] for ring in poly if len(ring) >= 3])
    except (TypeError, ValueError, IndexError):
        return []
    return out


def _in_ring(x, y, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _in_polys(x, y, polys) -> bool:
    return any(_in_ring(x, y, rings[0]) and not any(_in_ring(x, y, h) for h in rings[1:]) for rings in polys)


def point_in_polygon(point, geom) -> bool:
    """Ray casting. ``point`` is (lng, lat), GeoJSON order: inside the outer
    ring of some polygon and inside none of its holes."""
    return _in_polys(float(point[0]), float(point[1]), polygons(geom))


def stations_in_polygon(centroids: dict, geom) -> list:
    """The stations whose (lng, lat) centroid lies inside ``geom``, sorted."""
    polys = polygons(geom)
    if not polys:
        return []
    return sorted(s for s, (x, y) in centroids.items() if _in_polys(float(x), float(y), polys))


def _vertices(geom) -> list:
    kind = geom.get("type")
    if kind == "Feature":
        return _vertices(geom.get("geometry") or {})
    if kind == "FeatureCollection":
        out = []
        for f in geom.get("features") or ():
            out += _vertices(f or {})
        return out
    coords = geom.get("coordinates")
    if kind == "Point":
        return [coords] if coords else []
    if kind == "LineString":
        return list(coords or ())
    if kind == "Polygon":
        return list((coords or [[]])[0])
    if kind == "MultiPolygon":
        return list(((coords or [[[]]])[0] or [[]])[0])
    return []


def geometry_centroid(geom):
    """(lng, lat): the mean of every vertex. That is a zone's bed-line points,
    a polygon's outer ring or a tree's point, matching the frontend's
    ``geometryCentroid``. None when there is nothing to average."""
    geom = parse_geojson(geom)
    if not geom:
        return None
    try:
        pts = [(float(p[0]), float(p[1])) for p in _vertices(geom)]
    except (TypeError, ValueError, IndexError):
        return None
    if not pts:
        return None
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


# ── pins (C7, C8) ──────────────────────────────────────────────────────────


def share(stations, scouted, infested, min_n=PIN_MIN_SCOUTED) -> dict:
    """C7: infested ÷ scouted among the pin's stations, as a 0–100 figure
    (1 dp). ``value`` is None (and ``thin`` True) below ``min_n`` scouted."""
    mine = set(stations or ())
    seen = mine & set(scouted or ())
    hit = seen & set(infested or ())
    n = len(seen)
    return {
        "scouted": n,
        "infested": len(hit),
        "value": round(100.0 * len(hit) / n, 1) if n >= min_n else None,
        "thin": n < min_n,
    }


def pin_rises(before, now) -> bool:
    """C8: up by at least PIN_RISE_POINTS with ≥ PIN_MIN_SCOUTED scouted both
    weeks (a thin week has no value)."""
    if not before or not now:
        return False
    if before.get("value") is None or now.get("value") is None:
        return False
    return now["value"] - before["value"] >= PIN_RISE_POINTS - 1e-9
```

- [ ] **Step 5: Run to pass, plus the pure regression**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_clusters_pure.py upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_trends_prevalence_pure.py upande_scp/serverscripts/tests/test_threshold_core_pure.py upande_scp/serverscripts/tests/test_threshold_counts_pure.py upande_scp/serverscripts/tests/test_hot_spots_pure.py`
Expected: all pass. `test_prevalence_pure` is what proves the `grid_positions` refactor changed nothing.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/common/clusters.py upande_scp/serverscripts/common/prevalence.py upande_scp/serverscripts/tests/test_clusters_pure.py
git commit -m "feat(scp): pure spread rules — patches of neighbouring infested stations, week-to-week tracking, labels and pin geometry"
```

---

### Task 2: Station ranks beside the grid, and a house's patches week to week

**Files:**
- Modify: `upande_scp/serverscripts/common/cache_utils.py` (`K_STATION_GRID_PREFIX` ~line 105; `invalidate_station_grid_for_doc` ~353–370)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (`_load_grids` ~46–100, `station_grid` ~103–110; `StationWeeks` "figures" block)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py` (`K_DASH_AGG_SCHEMA` and its comment block)
- Create: `upande_scp/serverscripts/scouting/spread.py`
- Create: `upande_scp/serverscripts/tests/spread_fixture.py`
- Test: `upande_scp/serverscripts/tests/test_spread.py` (new; classes `TestStationRanks`, `TestHouseClusters`)

**Interfaces:**
- Consumes: Task 1 `P.rank_positions`, `C.clusters`, `C.track`, `C.label`. Also `TC.now_eat`, `TC.EVAL_WINDOW_DAYS`, `TC._assert_can_see`, `_common.cached_aggregate`, `crop_catalog.resolve_crop`.
- Produces:
  - `R._station_rows(warehouses) -> {house: [station dict]}`, `R._load_ranks(warehouses)`, `R.ranks_key(wh)`, `R.station_ranks(wh) -> {station: (r, c)}` (cached, TTL_LONG).
  - `R.StationWeeks.scouted_set(wh, week) -> set`.
  - `cache_utils.K_STATION_RANKS_PREFIX = "scp:station_ranks_v1"`.
  - `S.empty(unit)`, `S.kind_key(kind)`, `S.normalize_week(week)`, `S.unit_for(wh)`.
  - `S.house_clusters(crop, warehouse, observation, kind, stage=None, week=None, today=None) -> {"week", "prev_week", "unit", "clusters", "gone"}`. Each patch is `{"id": "P1", "stations", "size", "centroid", "rows", "cols", "label", "change", "prev_size"}`.
  - `S.get_house_clusters(crop, warehouse, observation, kind, stage=None, week=None, force=0)`, whitelisted and cached as aggregate `house_clusters`.
  - `_common.K_DASH_AGG_SCHEMA = "pin1"`.

- [ ] **Step 1: The fixture**

Create `upande_scp/serverscripts/tests/spread_fixture.py`:

```python
"""Raw-SQL scouting placed by rank, for the spread and pins tests (piece 3c).

Same contract as prevalence_fixture: callers roll back in tearDown. Weeks
2031-W24…W32 (2031-06-09 → 2031-08-10) — no other module seeds them, and
kaitet.local has no real scouting in 2031.
"""

from datetime import date

from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import prevalence_fixture as PF

AVOCADO_PEST = "Fruit fly (Ceratitis)"   # Avocado Pest Filter only


def monday(week: int) -> str:
    """The Monday of 2031-W<week>, YYYY-MM-DD."""
    return date.fromisocalendar(2031, week, 1).isoformat()


def by_rank(warehouse) -> dict:
    """``{(group rank, rank in group): station}`` for one house."""
    return {tuple(pos): st for st, pos in R._load_ranks([warehouse])[warehouse].items()}


def rect(r0, c0, h, w) -> list:
    return [(r, c) for r in range(r0, r0 + h) for c in range(c0, c0 + w)]


def section_stations(warehouse, row, col, n) -> list:
    """The first ``n`` stations (by name) of one 3 × 3 section."""
    return PF.stations_by_section(R._load_grid(warehouse))[(row, col)][:n]


def seed(warehouse, day, stations, *, crop="Rose", infested=None, pest="Thrips", disease=None,
         stage="Adult", block=False) -> list:
    """One entry per station on ``day``. The ``infested`` ones (every station
    when None) carry ``pest`` at ``stage`` and ``disease``; the rest are clean."""
    hit = set(stations if infested is None else infested)
    names = []
    for st in stations:
        where = {"block": warehouse, "tree": st} if block else {"greenhouse": warehouse, "zone": st}
        on = st in hit
        names.append(PF.insert_station_entry(
            date=day, crop=crop, pests=[pest] if on and pest else [],
            diseases=[disease] if on and disease else [], pest_stage=stage, **where,
        ))
    return names


def seed_cells(warehouse, day, cells, **kw) -> list:
    """``seed`` on the stations at these (rank, rank) cells, all infested."""
    inv = by_rank(warehouse)
    return seed(warehouse, day, [inv[c] for c in cells], **kw)
```

- [ ] **Step 2: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_spread.py`:

```python
"""Spread (piece 3c): station ranks, a house's patches week to week, and the
digest's patch note. DB test — direct runner; rolled back in tearDown."""

import unittest
from datetime import date

import frappe

from upande_scp.serverscripts.common import cache_utils, crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import spread as S
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import spread_fixture as SF
from upande_scp.serverscripts.tests import thresholds_fixture as TF

U_STRANGER = "_test_scp_pin_stranger@example.com"   # may see no farm


class SpreadCase(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = PF.rose_greenhouses(1)[0]

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def found(self, week, gh=None, crop="Rose", obs="Thrips", stage=None):
        out = S.house_clusters(crop, gh or self.gh, obs, "pest", stage, week)
        return ([(c["size"], c["change"], c["prev_size"]) for c in out["clusters"]],
                [(g["size"], g["change"]) for g in out["gone"]], out)


class TestStationRanks(SpreadCase):
    def test_ranks_follow_bed_then_zone_order(self):
        ranks = R._load_ranks([self.gh])[self.gh]
        rows = frappe.db.sql(
            """select z.name, b.bed as bed_no, z.zone as zone_no from `tabZone` z
               left join `tabBed` b on b.name = z.bed where z.greenhouse = %s""",
            (self.gh,), as_dict=True,
        )
        self.assertEqual(len(ranks), len(rows))
        self.assertEqual(len(set(ranks.values())), len(ranks))          # one station per rank
        by_order = sorted(rows, key=lambda r: (int(r.bed_no), int(r.zone_no), r.name))
        self.assertEqual(sorted(ranks, key=ranks.get), [r.name for r in by_order])

    def test_the_grid_is_the_ranks_cut_in_thirds(self):
        ranks = R._load_ranks([self.gh])[self.gh]
        grid = R._load_grid(self.gh)
        groups = 1 + max(r for r, _c in ranks.values())
        size: dict = {}
        for r, _c in ranks.values():
            size[r] = size.get(r, 0) + 1
        for st, (r, c) in ranks.items():
            self.assertEqual(tuple(grid[st]), ((3 * r) // groups, (3 * c) // size[r]))

    def test_trees_rank_by_their_names_trailing_number(self):
        block = F.avocado_block()
        ranks = R._load_ranks([block])[block]
        self.assertEqual(len(ranks), frappe.db.count("Orchard Tree", {"block": block}))
        first_row = sorted((c, st) for st, (r, c) in ranks.items() if r == 0)
        numbers = [int(st.rsplit("T", 1)[1]) for _c, st in first_row]
        self.assertEqual(numbers, sorted(set(numbers)))

    def test_ranks_are_cached_and_a_zone_save_drops_them(self):
        cache_utils.invalidate(R.ranks_key(self.gh))
        first = R.station_ranks(self.gh)
        self.assertEqual(frappe.cache().get_value(R.ranks_key(self.gh), expires=True), first)
        zone = frappe.get_all("Zone", filters={"greenhouse": self.gh}, fields=["name", "greenhouse"], limit=1)[0]
        cache_utils.invalidate_station_grid_for_doc(frappe._dict(doctype="Zone", **zone))
        self.assertIsNone(frappe.cache().get_value(R.ranks_key(self.gh), expires=True))
        self.assertIsNone(frappe.cache().get_value(R.grid_key(self.gh), expires=True))


class TestHouseClusters(SpreadCase):
    def test_a_two_week_house_tracks_grew_new_and_gone(self):
        SF.seed_cells(self.gh, SF.monday(30), SF.rect(0, 0, 2, 3) + SF.rect(10, 0, 1, 3) + SF.rect(20, 0, 1, 2))
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 3, 3) + SF.rect(30, 0, 1, 4))
        now, gone, out = self.found("2031-W31")
        self.assertEqual((out["week"], out["prev_week"], out["unit"]), ("2031-W31", "2031-W30", "bed"))
        self.assertEqual(now, [(9, "Grew", 6), (4, "New", None)])        # the pair of 2 is no patch
        self.assertEqual(gone, [(3, "Gone")])
        top = out["clusters"][0]
        inv = SF.by_rank(self.gh)
        self.assertEqual(top["stations"], sorted(inv[c] for c in SF.rect(0, 0, 3, 3)))
        self.assertEqual((top["id"], top["label"], top["rows"], top["cols"]), ("P1", "beds 1–3, zones 1–3", [0, 2], [0, 2]))
        self.assertEqual(out["gone"][0]["label"], "bed 11, zones 1–3")

    def test_a_patch_two_beds_along_with_no_overlap_moved(self):
        SF.seed_cells(self.gh, SF.monday(30), SF.rect(40, 0, 1, 3))
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(42, 0, 1, 3))
        self.assertEqual(self.found("2031-W31")[:2], ([(3, "Moved", 3)], []))

    def test_the_previous_week_is_not_capped_at_five(self):
        cells = []
        for k in range(5):
            cells += SF.rect(3 * k, 0, 1, 4)                                # five patches of 4
        cells += SF.rect(15, 0, 1, 3)                                       # the sixth, of 3
        SF.seed_cells(self.gh, SF.monday(30), cells)
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(15, 0, 1, 3))
        now, gone, _out = self.found("2031-W31")
        self.assertEqual(now, [(3, "Stable", 3)])
        self.assertEqual(gone, [(4, "Gone")] * 5)

    def test_one_stage_narrows_and_every_stage_is_the_default(self):
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 1, 3), stage="Adult")
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(5, 0, 1, 3), stage="Larva")
        self.assertEqual(len(self.found("2031-W31")[2]["clusters"]), 2)
        larva = self.found("2031-W31", stage="Larva")[2]["clusters"]
        self.assertEqual([c["rows"] for c in larva], [[5, 5]])

    def test_an_avocado_block_speaks_rows_and_trees(self):
        block = F.avocado_block()
        SF.seed_cells(block, SF.monday(31), SF.rect(0, 0, 2, 2), crop="Avocado", pest=SF.AVOCADO_PEST, block=True)
        now, _gone, out = self.found("2031-W31", gh=block, crop="Avocado", obs=SF.AVOCADO_PEST)
        self.assertEqual((now, out["unit"]), ([(4, "New", None)], "row"))
        self.assertEqual(out["clusters"][0]["label"], "rows 1–2, trees 1–2")

    def test_a_week_without_scouting_is_empty(self):
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 1, 3))
        out = S.house_clusters("Rose", self.gh, "Thrips", "pest", None, "2031-W29")
        self.assertEqual((out["week"], out["clusters"], out["gone"]), (None, [], []))

    def test_the_endpoint_checks_access_and_resolves_the_crop(self):
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 1, 3))
        got = S.get_house_clusters("rose", self.gh, "Thrips", "Pest", week="2031-W31", force=1)
        self.assertEqual([c["size"] for c in got["clusters"]], [3])
        self.assertEqual(S.get_house_clusters("Rose", self.gh, "", "pest"), S.empty())
        with self.assertRaises(frappe.ValidationError):
            S.get_house_clusters("Rose", self.gh, "Thrips", "insect", week="2031-W31", force=1)
        TF.ensure_user(U_STRANGER)
        frappe.set_user(U_STRANGER)
        crop_scope.clear_cache()
        with self.assertRaises(frappe.PermissionError):
            S.get_house_clusters("Rose", self.gh, "Thrips", "pest", week="2031-W31", force=1)

    def test_the_dashboard_cache_schema_moves_to_pin1(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "pin1")
```

- [ ] **Step 3: Run to see it fail**

Run: **DB-RUN `test_spread`**
Expected: the module fails to import with `ImportError: cannot import name 'spread'`. After you create an empty `spread.py`, it fails with `AttributeError: module '…_prevalence_rows' has no attribute '_load_ranks'`.

- [ ] **Step 4: The ranks cache key and invalidation**

In `upande_scp/serverscripts/common/cache_utils.py`, directly after `K_STATION_GRID_PREFIX = "scp:station_grid_v1"` add:

```python
# Per-house fine ranks for spread patches (_prevalence_rows.station_ranks):
# (bed rank, zone rank within the bed) or (row rank, tree rank within the row).
# Suffix is the greenhouse/block name; dropped with the grid by
# invalidate_station_grid_for_doc.
K_STATION_RANKS_PREFIX = "scp:station_ranks_v1"
```

In `invalidate_station_grid_for_doc`, the last line `invalidate(f"{K_STATION_GRID_PREFIX}:{wh}")` becomes:

```python
        invalidate(f"{K_STATION_GRID_PREFIX}:{wh}", f"{K_STATION_RANKS_PREFIX}:{wh}")
```

and its docstring's first line becomes `"""Drop the cached station grid and ranks of the house a Zone / Bed / Orchard Tree is in.`.

- [ ] **Step 5: `station_ranks` and `scouted_set` in `_prevalence_rows.py`**

(a) Replace the whole `_load_grids` function with these three functions. The two SQL statements move into `_station_rows` unchanged:

```python
def _station_rows(warehouses) -> dict:
    """``{house: [{"name", "group", "group_no", "no"}]}`` for several houses in
    one scan each of Zone (rose) and, for the houses with no zones, Orchard Tree
    (avocado). ``tabZone`` has no index on ``greenhouse``, so one batched scan
    replaces one full scan per house. Bed numbers come from ``Bed.bed``; zone
    numbers from ``Zone.zone``; tree numbers from the tree's name (``Orchard
    Tree.tree`` is 0 on every tree). A house with neither keeps ``[]``."""
    houses = sorted({wh for wh in (warehouses or ()) if wh})
    if not houses:
        return {}
    rows_by: dict = {}
    for r in frappe.db.sql(
        """
        SELECT z.greenhouse AS wh, z.name, z.bed AS grp, b.bed AS grp_no, z.zone AS no
        FROM `tabZone` z
        LEFT JOIN `tabBed` b ON b.name = z.bed
        WHERE z.greenhouse IN %(whs)s
        """,
        {"whs": tuple(houses)},
        as_dict=True,
    ):
        rows_by.setdefault(r.wh, []).append(r)
    blocks = tuple(wh for wh in houses if wh not in rows_by)
    if blocks:
        for r in frappe.db.sql(
            """
            SELECT t.block AS wh, t.name, t.`row` AS grp, b.bed AS grp_no, t.tree AS no
            FROM `tabOrchard Tree` t
            LEFT JOIN `tabBed` b ON b.name = t.`row`
            WHERE t.block IN %(whs)s
            """,
            {"whs": blocks},
            as_dict=True,
        ):
            rows_by.setdefault(r.wh, []).append(r)
    return {
        wh: [
            {
                "name": r.name,
                "group": r.grp or "",
                "group_no": P.station_number(r.grp_no, r.grp),
                "no": P.station_number(r.no, r.name),
            }
            for r in rows_by.get(wh, ())
        ]
        for wh in houses
    }


def _load_grids(warehouses) -> dict:
    """``{house: {station: (row, col)}}``: every station's 3 × 3 cell."""
    return {wh: P.grid_positions(rows) for wh, rows in _station_rows(warehouses).items()}


def _load_ranks(warehouses) -> dict:
    """``{house: {station: (group rank, rank in group)}}`` (spread spec §1), from
    the same rows and the same ordering as ``_load_grids``."""
    return {wh: P.rank_positions(rows) for wh, rows in _station_rows(warehouses).items()}
```

(b) Directly after `station_grid` add:

```python
def ranks_key(warehouse: str) -> str:
    return f"{cache_utils.K_STATION_RANKS_PREFIX}:{warehouse}"


def station_ranks(warehouse: str) -> dict:
    """Cached ``_load_ranks`` for one house, beside ``station_grid``; dropped by
    the same ``cache_utils.invalidate_station_grid_for_doc``."""
    if not warehouse:
        return {}
    return cache_utils.get_or_set(
        ranks_key(warehouse), lambda: _load_ranks([warehouse]).get(warehouse, {}), cache_utils.TTL_LONG,
    )
```

(c) In `class StationWeeks`, at the top of the `# ── figures ──` block (just before `def infested_set`) add:

```python
    def scouted_set(self, wh, week) -> set:
        """The stations scouted at ``wh`` that ISO week (a copy)."""
        return set(self._scouted.get((wh, week), ()))
```

- [ ] **Step 6: The schema tag**

In `upande_scp/serverscripts/dashboard_aggregates/_common.py`, set `K_DASH_AGG_SCHEMA = "pin1"` (it is `"hot1"` after 3b, `"thr1"` before). Add this line at the top of the comment block above it:

```python
# "pin1": the house_clusters aggregate (spread spec C4) joins the namespace.
```

- [ ] **Step 7: Create `scouting/spread.py`**

```python
"""Spread (piece 3c): a greenhouse's or block's patches of neighbouring infested
stations for one observation and ISO week, tracked against the previous
scouted week (spec 2026-10-10-spread-and-pins C1–C5, §3).

Computed on demand (C4), with no stored table. ``get_house_clusters`` caches
the payload in the dashboard aggregate cache, under the same version stamp
and TTL. Scouting comes through piece 2's ``StationWeeks``, so piece 1's crop
scoping (D4/D5) holds. Positions come from ``station_ranks``: the same Zone /
Bed / Orchard Tree order as the 3 × 3 grid. Clusters never notify anyone.
"""

import re
from datetime import date, timedelta

import frappe

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import cached_aggregate
from upande_scp.serverscripts.scouting import thresholds_check as TC

KINDS = ("pest", "disease")
STATION_WORDS = {"bed": "zones", "row": "trees"}
_WEEK = re.compile(r"^(\d{4})-W(\d{1,2})$")


def empty(unit="bed") -> dict:
    return {"week": None, "prev_week": None, "unit": unit, "clusters": [], "gone": []}


def kind_key(kind) -> str:
    """``Pest`` / ``pest`` → ``pest``; refused when it is neither kind."""
    k = (kind or "").strip().lower()
    if k not in KINDS:
        frappe.throw(f"Unknown kind: {kind}.", frappe.ValidationError)
    return k


def normalize_week(week) -> str:
    """``2031-W5`` → ``2031-W05``; ``""`` for blank; refused when unreadable."""
    week = (week or "").strip()
    if not week:
        return ""
    m = _WEEK.match(week)
    if not m or not 1 <= int(m.group(2)) <= 53:
        frappe.throw(f"Unreadable ISO week: {week}.", frappe.ValidationError)
    return f"{m.group(1)}-W{int(m.group(2)):02d}"


def unit_for(warehouse) -> str:
    """``row`` on a Block (orchard rows and trees), else ``bed``."""
    return "row" if frappe.db.get_value("Warehouse", warehouse, "warehouse_type") == "Block" else "bed"


def _window(week, today) -> tuple:
    if week:
        monday = P.week_monday(week)
        return monday, (date.fromisoformat(monday) + timedelta(days=6)).isoformat()
    today = today or TC.now_eat().date()
    return (today - timedelta(days=TC.EVAL_WINDOW_DAYS - 1)).isoformat(), today.isoformat()


def _public(c, unit, i) -> dict:
    return {
        "id": f"P{i}",
        "stations": list(c["stations"]),
        "size": c["size"],
        "centroid": list(c["centroid"]),
        "rows": list(c["rows"]),
        "cols": list(c["cols"]),
        "label": C.label(c, unit),
        "change": c["change"],
        "prev_size": c.get("prev_size"),
    }


def house_clusters(crop, warehouse, observation, kind, stage=None, week=None, today=None) -> dict:
    """``{week, prev_week, unit, clusters, gone}`` for one house, uncached.

    ``week`` (``YYYY-Www``) pins the week; without it, the house's latest
    scouted week in the last 14 days (the alerts' window). ``stage`` narrows to
    one stage; by default every stage counts (C1's live figure). Stations come
    by name, so the maps outline them from their own geometry."""
    kind = kind_key(kind)
    week = normalize_week(week)
    unit = unit_for(warehouse)
    out = empty(unit)
    start, end = _window(week, today)
    weeks = R.StationWeeks.load(start, end, crop, [warehouse], kinds=(kind,))
    latest, previous = weeks.latest_pair(warehouse)
    if not latest:
        return out
    ranks = R.station_ranks(warehouse)
    narrow = (stage or "").strip() or R.ANY
    now = C.clusters(ranks, weeks.infested_set(warehouse, latest, kind, observation, narrow))
    before = (
        C.clusters(ranks, weeks.infested_set(warehouse, previous, kind, observation, narrow), limit=None)
        if previous else []
    )
    tracked, gone = C.track(now, before)
    out.update(
        week=latest,
        prev_week=previous,
        clusters=[_public(c, unit, i) for i, c in enumerate(tracked, start=1)],
        gone=[_public(c, unit, i) for i, c in enumerate(gone, start=1)],
    )
    return out


@frappe.whitelist()
def get_house_clusters(crop, warehouse, observation, kind, stage=None, week=None, force=0) -> dict:
    """C5: the greenhouse modal's Patches and the maps' outlines. Cached with
    the dashboard aggregates; a call without ``week`` is keyed by today (EAT)."""
    crop = crop_catalog.resolve_crop(crop)
    warehouse = (warehouse or "").strip()
    observation = (observation or "").strip()
    if not crop or not warehouse or not observation:
        return empty()
    TC._assert_can_see(crop, frappe.db.get_value("Warehouse", warehouse, "custom_farm"))
    filters = {
        "crop": crop, "warehouse": warehouse, "observation": observation, "kind": kind_key(kind),
        "stage": (stage or "").strip(), "week": normalize_week(week),
    }
    if not filters["week"]:
        filters["today"] = TC.now_eat().date().isoformat()
    return cached_aggregate(
        "house_clusters", filters,
        lambda: house_clusters(crop, warehouse, observation, filters["kind"], filters["stage"], filters["week"]),
        force=str(force).strip().lower() in ("1", "true", "yes"),
    )
```

- [ ] **Step 8: Run to pass, plus the regression gate for the grid**

Run: **DB-RUN `test_spread`**, **DB-RUN `test_prevalence_rows`**, **DB-RUN `test_prevalence_overview`**, **DB-RUN `test_dashboard_aggregates_gh_detail`**, **DB-RUN `test_crop_scoped_aggregate_detail`**, **DB-RUN `test_hot_spots`**; and pure `test_prevalence_rows_pure.py`.
Expected: all OK. `test_prevalence_rows` (`test_every_zone_of_the_greenhouse_is_placed`, `test_the_grid_is_cached_and_a_tree_save_drops_it`) proves the `_station_rows` split kept the grid identical.

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/common/cache_utils.py upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py upande_scp/serverscripts/dashboard_aggregates/_common.py upande_scp/serverscripts/scouting/spread.py upande_scp/serverscripts/tests/spread_fixture.py upande_scp/serverscripts/tests/test_spread.py
git commit -m "feat(scp): station ranks beside the grid and a house's patches tracked week to week"
```

---

### Task 3: Scouting Pin — save, list and delete with visibility and edit rights

**Files:**
- Create: `upande_scp/upande_scp/doctype/scouting_pin/__init__.py` (empty)
- Create: `upande_scp/upande_scp/doctype/scouting_pin/scouting_pin.json`
- Create: `upande_scp/upande_scp/doctype/scouting_pin/scouting_pin.py`
- Create: `upande_scp/serverscripts/scouting/pins.py`
- Test: `upande_scp/serverscripts/tests/test_scouting_pins.py` (new; `PinCase`, `TestPins`)

**Interfaces:**
- Consumes: Task 1 `C.parse_geojson`, `C.polygons`, `C.stations_in_polygon`, `C.geometry_centroid`. Task 2 `R.station_ranks`, `R.station_grid`. Also `TC._assert_can_see`, `crop_catalog.resolve_crop`.
- Produces:
  - `PN.DOCTYPE = "Scouting Pin"`, `PN.KINDS`, `PN.EDIT_ROLES`, `PN.PIN_FIELDS`.
  - `PN._roles(user) -> set`, `PN.may_edit(pin, user=None) -> bool`, `PN.assert_may_edit(pin, user=None)`.
  - `PN.pin_stations(pin) -> [names]`: a Section pin's live grid cell, or the frozen list.
  - `PN.station_centroids(warehouse) -> {name: (lng, lat)}`.
  - Whitelisted: `PN.save_pin(crop, warehouse, kind, title, observation=None, obs_kind=None, stage=None, section_row=None, section_col=None, stations=None, polygon=None, source_week=None, shared=1, notify=1) -> pin dict`, `PN.list_pins(crop, warehouse, with_series=0) -> [pin dict]`, `PN.delete_pin(name) -> {"name"}`.
  - The pin dict: `name, title, crop, farm, warehouse, kind, observation, obs_kind, stage, section_row, section_col, stations, polygon (dict | None), source_week, shared, notify, owner, may_edit`.

- [ ] **Step 1: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_scouting_pins.py`:

```python
"""Scouting Pins (piece 3c): save / list / delete with visibility and edit
rights, area pins, the weekly series and the owner's notice.
DB test — direct runner; rolled back in tearDown. The four _test_scp_pin_*
users are committed once (the test_notifications pattern); scope and roles
are patched, never granted."""

import json
import unittest
from datetime import datetime
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import pins as PN
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import spread_fixture as SF
from upande_scp.serverscripts.tests import thresholds_fixture as TF

U_OWNER = "_test_scp_pin_owner@example.com"
U_OTHER = "_test_scp_pin_other@example.com"
U_GM = "_test_scp_pin_gm@example.com"
U_STRANGER = "_test_scp_pin_stranger@example.com"   # may see no farm


def _sees_everything(user=None):
    """crop_scope stand-in: every farm of the crop for all but the stranger."""
    return set() if (user or frappe.session.user) == U_STRANGER else None


def square(lng, lat, d=1e-7) -> dict:
    return {"type": "Polygon", "coordinates": [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d],
                                                [lng - d, lat + d], [lng - d, lat - d]]]}


class PinCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        for user in (U_OWNER, U_OTHER, U_GM, U_STRANGER):
            TF.ensure_user(user)

    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = PF.rose_greenhouses(1)[0]
        self.patches = [
            patch.object(crop_scope, "allowed_crops", side_effect=_sees_everything),
            patch.object(crop_scope, "allowed_farms", side_effect=_sees_everything),
            patch.object(PN, "_roles", side_effect=lambda user: {"SCP General Manager"} if user == U_GM else set()),
            patch.object(TC, "now_eat", return_value=datetime(2031, 8, 10, 9, 0, tzinfo=TC.EAT)),  # Sun 2031-W32
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def as_user(self, user):
        frappe.set_user(user)
        crop_scope.clear_cache()

    def section_pin(self, user=U_OWNER, row=0, col=0, **kw):
        self.as_user(user)
        args = {"crop": "Rose", "warehouse": self.gh, "kind": "Section", "title": "Thrips · first third · front",
                "observation": "Thrips", "obs_kind": "Pest", "section_row": row, "section_col": col, **kw}
        return PN.save_pin(**args)

    def names(self, user):
        self.as_user(user)
        return [p["name"] for p in PN.list_pins("Rose", self.gh, with_series=0)]


class TestPins(PinCase):
    def test_a_section_pin_saves_with_its_house_and_lists_for_its_owner(self):
        pin = self.section_pin(row=1, col=2)
        doc = frappe.get_doc("Scouting Pin", pin["name"])
        self.assertEqual(
            (doc.owner, doc.crop, doc.farm, doc.kind, doc.section_row, doc.section_col, doc.shared, doc.notify),
            (U_OWNER, "Rose", frappe.db.get_value("Warehouse", self.gh, "custom_farm"), "Section", 1, 2, 1, 1),
        )
        grid = R.station_grid(self.gh)
        self.assertEqual(pin["stations"], sorted(s for s, pos in grid.items() if tuple(pos) == (1, 2)))
        self.assertTrue(pin["may_edit"])
        self.assertEqual(self.names(U_OWNER), [pin["name"]])

    def test_a_shared_pin_is_seen_by_others_and_a_private_one_only_by_its_owner(self):
        shared = self.section_pin()
        private = self.section_pin(row=2, col=2, shared=0)
        self.assertEqual(set(self.names(U_OWNER)), {shared["name"], private["name"]})
        self.assertEqual(self.names(U_OTHER), [shared["name"]])
        self.assertEqual(self.names(U_GM), [shared["name"]])

    def test_a_stranger_can_neither_list_nor_save(self):
        self.section_pin()
        self.as_user(U_STRANGER)
        with self.assertRaises(frappe.PermissionError):
            PN.list_pins("Rose", self.gh)
        with self.assertRaises(frappe.PermissionError):
            PN.save_pin("Rose", self.gh, "Section", "mine", section_row=0, section_col=0)

    def test_only_the_owner_a_gm_or_a_system_manager_may_delete(self):
        pin = self.section_pin()
        self.as_user(U_OTHER)
        self.assertFalse(PN.list_pins("Rose", self.gh, with_series=0)[0]["may_edit"])
        with self.assertRaises(frappe.PermissionError):
            PN.delete_pin(pin["name"])
        self.as_user(U_GM)
        self.assertEqual(PN.delete_pin(pin["name"]), {"name": pin["name"]})
        self.assertFalse(frappe.db.exists("Scouting Pin", pin["name"]))
        mine = self.section_pin()
        self.as_user(U_OWNER)
        PN.delete_pin(mine["name"])
        self.assertFalse(frappe.db.exists("Scouting Pin", mine["name"]))
        theirs = self.section_pin()
        self.as_user("Administrator")
        PN.delete_pin(theirs["name"])
        self.assertFalse(frappe.db.exists("Scouting Pin", theirs["name"]))

    def test_another_user_cannot_edit_a_pin_even_through_the_document(self):
        pin = self.section_pin()
        self.as_user(U_OTHER)
        doc = frappe.get_doc("Scouting Pin", pin["name"])
        doc.title = "taken over"
        with self.assertRaises(frappe.PermissionError):
            doc.save(ignore_permissions=True)
        with self.assertRaises(frappe.PermissionError):
            frappe.delete_doc("Scouting Pin", pin["name"], ignore_permissions=True)

    def test_a_patch_pin_keeps_only_this_houses_stations(self):
        inv = SF.by_rank(self.gh)
        mine = [inv[c] for c in SF.rect(0, 0, 1, 3)]
        foreign = sorted(R.station_ranks(PF.rose_greenhouses(2)[1]))[:2]
        self.as_user(U_OWNER)
        pin = PN.save_pin("Rose", self.gh, "Patch", "Thrips · bed 1, zones 1–3", observation="Thrips",
                          obs_kind="pest", stations=json.dumps(mine + foreign), source_week="2031-W31")
        self.assertEqual(pin["stations"], sorted(mine))
        self.assertEqual((pin["obs_kind"], pin["source_week"]), ("Pest", "2031-W31"))
        with self.assertRaises(frappe.ValidationError):
            PN.save_pin("Rose", self.gh, "Patch", "nothing of mine", stations=json.dumps(foreign))

    def test_a_pin_needs_a_title_a_kind_a_cell_and_a_pest_or_disease_word(self):
        self.as_user(U_OWNER)
        for bad in (
            {"kind": "Section", "title": " ", "section_row": 0, "section_col": 0},
            {"kind": "Circle", "title": "x"},
            {"kind": "Section", "title": "x", "section_row": 3, "section_col": 0},
            {"kind": "Section", "title": "x", "section_row": 0, "section_col": 0, "observation": "Thrips"},
        ):
            with self.assertRaises(frappe.ValidationError, msg=str(bad)):
                PN.save_pin("Rose", self.gh, **bad)

    def test_an_area_pin_resolves_the_zone_under_its_polygon(self):
        centroids = PN.station_centroids(self.gh)
        zone = sorted(centroids)[0]
        area = square(*centroids[zone])
        self.as_user(U_OWNER)
        pin = PN.save_pin("Rose", self.gh, "Area", "one zone", polygon=json.dumps(area))
        self.assertEqual((pin["stations"], pin["polygon"]), ([zone], area))
        far = {"type": "Polygon", "coordinates": [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0]]]}
        with self.assertRaises(frappe.ValidationError):
            PN.save_pin("Rose", self.gh, "Area", "nowhere", polygon=json.dumps(far))
        with self.assertRaises(frappe.ValidationError):
            PN.save_pin("Rose", self.gh, "Area", "a line",
                        polygon=json.dumps({"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]}))

    def test_an_area_pin_on_a_block_resolves_its_tree(self):
        block = F.avocado_block()
        centroids = PN.station_centroids(block)
        tree = sorted(centroids)[0]
        self.as_user(U_OWNER)
        pin = PN.save_pin("Avocado", block, "Area", "one tree", polygon=json.dumps(square(*centroids[tree])))
        self.assertEqual(pin["stations"], [tree])
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_scouting_pins`**
Expected: the module fails to import with `ImportError: cannot import name 'pins'`.

- [ ] **Step 3: The doctype**

Create `upande_scp/upande_scp/doctype/scouting_pin/__init__.py` as an empty file.

Create `upande_scp/upande_scp/doctype/scouting_pin/scouting_pin.json`:

```json
{
 "actions": [],
 "autoname": "hash",
 "creation": "2026-10-10 18:00:00.000000",
 "doctype": "DocType",
 "engine": "InnoDB",
 "field_order": [
  "title",
  "crop",
  "farm",
  "warehouse",
  "column_break_what",
  "kind",
  "observation",
  "obs_kind",
  "stage",
  "source_week",
  "where_section",
  "section_row",
  "section_col",
  "stations",
  "polygon",
  "watch_section",
  "shared",
  "notify",
  "last_notified_week"
 ],
 "fields": [
  {
   "fieldname": "title",
   "fieldtype": "Data",
   "in_list_view": 1,
   "label": "Title",
   "length": 140,
   "reqd": 1
  },
  {
   "fieldname": "crop",
   "fieldtype": "Link",
   "in_standard_filter": 1,
   "label": "Crop",
   "options": "Crop Scouted",
   "reqd": 1
  },
  {
   "fieldname": "farm",
   "fieldtype": "Link",
   "in_standard_filter": 1,
   "label": "Farm",
   "options": "Farm"
  },
  {
   "fieldname": "warehouse",
   "fieldtype": "Link",
   "in_list_view": 1,
   "in_standard_filter": 1,
   "label": "Greenhouse / Block",
   "options": "Warehouse",
   "reqd": 1,
   "search_index": 1
  },
  {
   "fieldname": "column_break_what",
   "fieldtype": "Column Break"
  },
  {
   "description": "Section = one cell of the 3 × 3 grid; Patch = a frozen copy of a patch's stations; Area = a polygon drawn on the map.",
   "fieldname": "kind",
   "fieldtype": "Select",
   "in_list_view": 1,
   "label": "Kind",
   "options": "Section\nPatch\nArea",
   "reqd": 1
  },
  {
   "description": "Blank watches every pest and disease.",
   "fieldname": "observation",
   "fieldtype": "Data",
   "in_list_view": 1,
   "label": "Observation"
  },
  {
   "fieldname": "obs_kind",
   "fieldtype": "Select",
   "label": "Pest / Disease",
   "options": "\nPest\nDisease"
  },
  {
   "fieldname": "stage",
   "fieldtype": "Data",
   "label": "Stage"
  },
  {
   "description": "The ISO week the patch or area was pinned from.",
   "fieldname": "source_week",
   "fieldtype": "Data",
   "label": "Source Week"
  },
  {
   "fieldname": "where_section",
   "fieldtype": "Section Break",
   "label": "Where"
  },
  {
   "default": "-1",
   "description": "Grid row (0 first, 1 middle, 2 last third); -1 unless Kind is Section.",
   "fieldname": "section_row",
   "fieldtype": "Int",
   "label": "Section Row"
  },
  {
   "default": "-1",
   "description": "Grid column (0 front, 1 middle, 2 back); -1 unless Kind is Section.",
   "fieldname": "section_col",
   "fieldtype": "Int",
   "label": "Section Column"
  },
  {
   "description": "JSON list of Zone / Orchard Tree names (Patch and Area pins).",
   "fieldname": "stations",
   "fieldtype": "Long Text",
   "label": "Stations"
  },
  {
   "description": "GeoJSON polygon as drawn (Area pins).",
   "fieldname": "polygon",
   "fieldtype": "Long Text",
   "label": "Polygon"
  },
  {
   "fieldname": "watch_section",
   "fieldtype": "Section Break",
   "label": "Watching"
  },
  {
   "default": "1",
   "description": "Shared pins are seen by everyone who can see the house; private ones only by their owner.",
   "fieldname": "shared",
   "fieldtype": "Check",
   "label": "Shared"
  },
  {
   "default": "1",
   "description": "Tell the owner when the figure rises 10 points or more in a week.",
   "fieldname": "notify",
   "fieldtype": "Check",
   "label": "Notify Me"
  },
  {
   "fieldname": "last_notified_week",
   "fieldtype": "Data",
   "label": "Last Notified Week",
   "read_only": 1
  }
 ],
 "links": [],
 "modified": "2026-10-10 18:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Scouting Pin",
 "naming_rule": "Random",
 "owner": "Administrator",
 "permissions": [
  {
   "create": 1,
   "delete": 1,
   "email": 1,
   "export": 1,
   "print": 1,
   "read": 1,
   "report": 1,
   "role": "System Manager",
   "share": 1,
   "write": 1
  },
  {
   "create": 1,
   "delete": 1,
   "export": 1,
   "print": 1,
   "read": 1,
   "report": 1,
   "role": "SCP General Manager",
   "write": 1
  },
  {
   "create": 1,
   "delete": 1,
   "if_owner": 1,
   "read": 1,
   "role": "SCP Spray Plan Creator",
   "write": 1
  },
  {
   "create": 1,
   "delete": 1,
   "if_owner": 1,
   "read": 1,
   "role": "SCP Spray Plan Approver",
   "write": 1
  },
  {
   "create": 1,
   "delete": 1,
   "if_owner": 1,
   "read": 1,
   "role": "SCP Spray Supervisor",
   "write": 1
  },
  {
   "create": 1,
   "delete": 1,
   "if_owner": 1,
   "read": 1,
   "role": "SCP Scout",
   "write": 1
  }
 ],
 "row_format": "Dynamic",
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": [],
 "title_field": "title",
 "track_changes": 0
}
```

Create `upande_scp/upande_scp/doctype/scouting_pin/scouting_pin.py` (**tabs**):

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ScoutingPin(Document):
	# C9: only the owner, an SCP General Manager or a System Manager may change
	# or delete a pin, whichever path the change takes (endpoint, Desk, script).
	def validate(self):
		if not self.is_new():
			from upande_scp.serverscripts.scouting.pins import assert_may_edit

			assert_may_edit(self)

	def on_trash(self):
		from upande_scp.serverscripts.scouting.pins import assert_may_edit

		assert_may_edit(self)
```

- [ ] **Step 4: Create `scouting/pins.py`**

```python
"""Scouting Pins (piece 3c, spec 2026-10-10-spread-and-pins C6–C9): an area an
agronomist watches week by week. A pin is a section of the 3 × 3 grid, a
frozen copy of a patch, or an area drawn on the map. Its weekly figure is
infested ÷ scouted among its stations. When that figure jumps, the owner gets
one in-app notice a week (``check_pins``, added with the series).

Visibility (C9): shared pins are listed to everyone who may see the house
(``thresholds_check._assert_can_see``: crop scope + farm); private pins only to
their owner. Changing or deleting one takes its owner, an SCP General Manager
or a System Manager, and the doctype controller enforces that on every path.
"""

import json

import frappe

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import thresholds_check as TC

DOCTYPE = "Scouting Pin"
KINDS = ("Section", "Patch", "Area")
OBS_KINDS = {"pest": "Pest", "disease": "Disease"}
EDIT_ROLES = ("SCP General Manager", "System Manager")
PIN_FIELDS = [
    "name", "title", "crop", "farm", "warehouse", "kind", "observation", "obs_kind", "stage",
    "section_row", "section_col", "stations", "polygon", "source_week", "shared", "notify",
    "last_notified_week", "owner", "creation",
]


def _roles(user) -> set:
    return set(frappe.get_roles(user))


def _truthy(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def may_edit(pin, user=None) -> bool:
    """C9: the owner, an SCP General Manager or a System Manager."""
    user = user or frappe.session.user
    if user == "Administrator" or user == pin.owner:
        return True
    return bool(_roles(user) & set(EDIT_ROLES))


def assert_may_edit(pin, user=None) -> None:
    if not may_edit(pin, user):
        frappe.throw("Only the pin's owner or an SCP General Manager may change or delete it.",
                     frappe.PermissionError)


def _house(crop, warehouse) -> tuple:
    """(canonical crop, farm, warehouse) once the user may see the house."""
    crop = crop_catalog.resolve_crop(crop)
    warehouse = (warehouse or "").strip()
    if not crop or not warehouse:
        frappe.throw("A pin needs a crop and a greenhouse or block.", frappe.ValidationError)
    farm = frappe.db.get_value("Warehouse", warehouse, "custom_farm")
    TC._assert_can_see(crop, farm)
    return crop, farm, warehouse


def _json_list(value) -> list:
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip() else []
        except ValueError:
            frappe.throw("Stations must be a JSON list of names.", frappe.ValidationError)
    return [str(s).strip() for s in (value or ()) if str(s).strip()]


def pin_stations(pin) -> list:
    """A Section pin's stations come from the current grid (they follow zone
    changes); Patch and Area pins keep the list frozen at save time."""
    if pin.kind == "Section":
        cell = (int(pin.section_row), int(pin.section_col))
        return sorted(st for st, pos in R.station_grid(pin.warehouse).items() if tuple(pos) == cell)
    return _json_list(pin.stations)


def station_centroids(warehouse) -> dict:
    """``{station: (lng, lat)}``: zone centroids (the mean of their bed-line
    points), or tree points on a block. Read once, when an area pin is saved."""
    rows = frappe.db.sql("SELECT name, geojson FROM `tabZone` WHERE greenhouse = %s", (warehouse,))
    if not rows:
        rows = frappe.db.sql("SELECT name, geojson FROM `tabOrchard Tree` WHERE block = %s", (warehouse,))
    out = {}
    for name, raw in rows:
        c = C.geometry_centroid(C.parse_geojson(raw))
        if c:
            out[name] = c
    return out


def _visible(pin, user) -> bool:
    return bool(int(pin.shared or 0)) or pin.owner == user


def _public(pin, user) -> dict:
    return {
        "name": pin.name, "title": pin.title, "crop": pin.crop, "farm": pin.farm,
        "warehouse": pin.warehouse, "kind": pin.kind, "observation": pin.observation or "",
        "obs_kind": pin.obs_kind or "", "stage": pin.stage or "",
        "section_row": pin.section_row, "section_col": pin.section_col,
        "stations": pin_stations(pin),
        "polygon": C.parse_geojson(pin.polygon) if pin.polygon else None,
        "source_week": pin.source_week or "", "shared": int(pin.shared or 0),
        "notify": int(pin.notify or 0), "owner": pin.owner, "may_edit": may_edit(pin, user),
    }


def _visible_rows(crop, warehouse, user) -> list:
    if not frappe.db.table_exists(DOCTYPE):
        return []
    rows = frappe.get_all(DOCTYPE, filters={"crop": crop, "warehouse": warehouse}, fields=PIN_FIELDS,
                          order_by="creation desc", limit_page_length=0)
    return [r for r in rows if _visible(r, user)]


@frappe.whitelist()
def list_pins(crop, warehouse, with_series=0) -> list:
    """C9: the house's pins this user may see: every shared pin plus their
    own private ones, newest first. ``may_edit`` says whether Delete shows."""
    crop, _farm, warehouse = _house(crop, warehouse)
    user = frappe.session.user
    return [_public(r, user) for r in _visible_rows(crop, warehouse, user)]


@frappe.whitelist()
def save_pin(crop, warehouse, kind, title, observation=None, obs_kind=None, stage=None,
             section_row=None, section_col=None, stations=None, polygon=None,
             source_week=None, shared=1, notify=1) -> dict:
    """C6: a Section (row/col of the 3 × 3 grid), a Patch (a frozen list of
    this house's stations) or an Area (a GeoJSON polygon, resolved now to the
    zones / trees whose centroid lies inside it; the polygon is kept for
    drawing). Blank ``observation`` watches every pest and disease."""
    crop, farm, warehouse = _house(crop, warehouse)
    kind = (kind or "").strip().title()
    if kind not in KINDS:
        frappe.throw(f"A pin is a Section, a Patch or an Area, not {kind or 'nothing'}.", frappe.ValidationError)
    title = (title or "").strip()[:140]
    if not title:
        frappe.throw("A pin needs a title.", frappe.ValidationError)
    observation = (observation or "").strip()
    obs_label = ""
    if observation:
        obs_label = OBS_KINDS.get((obs_kind or "").strip().lower(), "")
        if not obs_label:
            frappe.throw("Say whether the pinned observation is a pest or a disease.", frappe.ValidationError)
    doc = {
        "doctype": DOCTYPE, "title": title, "crop": crop, "farm": farm, "warehouse": warehouse,
        "kind": kind, "observation": observation, "obs_kind": obs_label,
        "stage": (stage or "").strip() if observation else "",
        "source_week": (source_week or "").strip(), "section_row": -1, "section_col": -1,
        "shared": 1 if _truthy(shared) else 0, "notify": 1 if _truthy(notify) else 0,
    }
    if kind == "Section":
        try:
            row, col = int(section_row), int(section_col)
        except (TypeError, ValueError):
            row = col = -1
        if not (0 <= row < P.GRID and 0 <= col < P.GRID):
            frappe.throw("A section pin needs a row and a column of the 3 × 3 grid.", frappe.ValidationError)
        doc.update(section_row=row, section_col=col)
    elif kind == "Patch":
        mine = set(R.station_ranks(warehouse))
        picked = sorted({s for s in _json_list(stations) if s in mine})
        if not picked:
            frappe.throw(f"None of those stations is in {warehouse}.", frappe.ValidationError)
        doc["stations"] = json.dumps(picked)
    else:
        geom = C.parse_geojson(polygon)
        if not C.polygons(geom):
            frappe.throw("Draw an area of at least three corners.", frappe.ValidationError)
        picked = C.stations_in_polygon(station_centroids(warehouse), geom)
        if not picked:
            frappe.throw(f"The area you drew holds no zone or tree of {warehouse}.", frappe.ValidationError)
        doc["stations"] = json.dumps(picked)
        doc["polygon"] = json.dumps(geom)
    pin = frappe.get_doc(doc).insert(ignore_permissions=True)
    return _public(pin.as_dict(), frappe.session.user)


@frappe.whitelist()
def delete_pin(name) -> dict:
    """C9: owner, SCP General Manager or System Manager, on a house they may see."""
    pin = frappe.get_doc(DOCTYPE, name)
    _house(pin.crop, pin.warehouse)
    assert_may_edit(pin)
    frappe.delete_doc(DOCTYPE, pin.name, ignore_permissions=True)
    return {"name": pin.name}
```

- [ ] **Step 5: Apply the schema**

Run: **DB-EXEC** `frappe.reload_doc('upande_scp', 'doctype', 'scouting_pin', force=True); print(frappe.db.table_exists('Scouting Pin'), [frappe.db.has_column('Scouting Pin', c) for c in ('title', 'kind', 'section_row', 'stations', 'polygon', 'shared', 'notify', 'last_notified_week')])`
Expected: `True [True, True, True, True, True, True, True, True]`.

- [ ] **Step 6: Run to pass**

Run: **DB-RUN `test_scouting_pins`**
Expected: all `TestPins` tests OK. `test_an_area_pin_*` read real Zone / Orchard Tree geometry. If `station_centroids` takes more than a few seconds, note it for the hand-off; it runs once per area save. Do not add an index (schema change, out of scope).

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/upande_scp/doctype/scouting_pin/__init__.py upande_scp/upande_scp/doctype/scouting_pin/scouting_pin.json upande_scp/upande_scp/doctype/scouting_pin/scouting_pin.py upande_scp/serverscripts/scouting/pins.py upande_scp/serverscripts/tests/test_scouting_pins.py
git commit -m "feat(scp): scouting pins — section, patch and drawn-area pins with owner/GM edit rights and shared visibility"
```

---

### Task 4: The pin series and the owner's weekly notice from the hourly check

**Files:**
- Modify: `upande_scp/serverscripts/scouting/pins.py` (imports; `list_pins`; append the series and the check)
- Modify: `upande_scp/serverscripts/scouting/thresholds_check.py` (`run_threshold_check`, ~line 575)
- Test: `upande_scp/serverscripts/tests/test_scouting_pins.py` (classes `TestSeries`, `TestPinCheck`)

**Interfaces:**
- Consumes: Task 1 `C.share`, `C.pin_rises`. Task 2 `StationWeeks.scouted_set`, `R.WINDOW`. Task 3 `pin_stations`, `_house`, `_visible`, `_visible_rows`. Also `notifications.notify`, `TC.dashboard_link`, `TC.now_eat`, `TC.EVAL_WINDOW_DAYS`.
- Produces:
  - `PN.SERIES_WEEKS = 8`, `PN.SERIES_LOOKBACK_DAYS = 112`.
  - `PN._series_for(crop, warehouse, pins, today, n) -> {pin name: [{"week", "scouted", "infested", "value", "thin"}]}`.
  - `PN.pin_series(name, weeks=8)` (whitelisted). `PN.list_pins(..., with_series=1)` now adds `series` to every pin.
  - `PN.check_pins(today=None) -> {"pins", "notified"}`.
  - `TC.run_threshold_check` output gains `"pins"`, and `"errors"` may hold `"pins"`.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_scouting_pins.py`:

```python
class TestSeries(PinCase):
    def seed_section(self, week, scouted, infested, **kw):
        stations = SF.section_stations(self.gh, 0, 0, scouted)
        SF.seed(self.gh, SF.monday(week), stations, infested=stations[:infested], **kw)

    def test_the_series_is_infested_over_scouted_among_the_pins_stations(self):
        self.seed_section(30, 6, 3)
        self.seed_section(31, 6, 6)
        self.seed_section(32, 4, 4)
        pin = self.section_pin()
        self.assertEqual(
            [(p["week"], p["scouted"], p["infested"], p["value"], p["thin"]) for p in PN.pin_series(pin["name"])],
            [("2031-W30", 6, 3, 50.0, False), ("2031-W31", 6, 6, 100.0, False), ("2031-W32", 4, 4, None, True)],
        )
        listed = PN.list_pins("Rose", self.gh)[0]
        self.assertEqual([p["week"] for p in listed["series"]], ["2031-W30", "2031-W31", "2031-W32"])

    def test_only_the_last_eight_scouted_weeks_are_shown(self):
        for week in range(24, 33):
            self.seed_section(week, 5, 1)
        pin = self.section_pin()
        self.assertEqual([p["week"] for p in PN.pin_series(pin["name"])], [f"2031-W{w}" for w in range(25, 33)])
        self.assertEqual([p["value"] for p in PN.pin_series(pin["name"], weeks=3)], [20.0, 20.0, 20.0])

    def test_a_pin_without_an_observation_watches_every_pest_and_disease(self):
        stations = SF.section_stations(self.gh, 0, 0, 6)
        SF.seed(self.gh, SF.monday(32), stations, infested=stations[:2], pest=None, disease="Downy Mildew")
        SF.seed(self.gh, SF.monday(32), stations[2:3], pest="Thrips")
        everything = self.section_pin(observation="", obs_kind="")
        thrips = self.section_pin()
        self.assertEqual(PN.pin_series(everything["name"])[-1]["infested"], 3)
        self.assertEqual(PN.pin_series(thrips["name"])[-1]["infested"], 1)

    def test_a_private_pins_series_is_its_owners_alone(self):
        private = self.section_pin(shared=0)
        self.as_user(U_OTHER)
        with self.assertRaises(frappe.PermissionError):
            PN.pin_series(private["name"])


class TestPinCheck(PinCase):
    def told(self, pin):
        return frappe.get_all("Notification Log", filters={"document_type": "Scouting Pin", "document_name": pin},
                              pluck="for_user")

    def seed_rise(self, before, now, n=10):
        stations = SF.section_stations(self.gh, 0, 0, n)
        SF.seed(self.gh, SF.monday(31), stations, infested=stations[:before])
        SF.seed(self.gh, SF.monday(32), stations, infested=stations[:now])

    def test_a_ten_point_rise_tells_the_owner_once_a_week(self):
        self.seed_rise(5, 6)                                                 # 50 % → 60 %
        pin = self.section_pin()
        self.as_user("Administrator")
        with patch.object(frappe, "sendmail") as mail:
            self.assertEqual(PN.check_pins()["notified"], 1)
            self.assertEqual(self.told(pin["name"]), [U_OWNER])              # the owner only
            subject = frappe.db.get_value("Notification Log", {"document_name": pin["name"]}, "subject")
            self.assertIn(f"Pin Thrips · first third · front in {self.gh}: Thrips 60.0% (was 50.0%)", subject)
            self.assertIn("up 10.0 points in 2031-W32", subject)
            self.assertEqual(frappe.db.get_value("Scouting Pin", pin["name"], "last_notified_week"), "2031-W32")
            self.assertEqual(PN.check_pins()["notified"], 0)                 # the next hour is silent
            self.assertEqual(self.told(pin["name"]), [U_OWNER])
            self.assertFalse(mail.called)

    def test_a_rise_under_ten_points_is_silent(self):
        self.seed_rise(5, 6, n=11)                                           # 45.5 % → 54.5 %
        pin = self.section_pin()
        self.as_user("Administrator")
        self.assertEqual(PN.check_pins()["notified"], 0)
        self.assertEqual(self.told(pin["name"]), [])

    def test_a_thin_week_is_silent(self):
        stations = SF.section_stations(self.gh, 0, 0, 10)
        SF.seed(self.gh, SF.monday(31), stations, infested=stations[:5])     # 5 of 10
        SF.seed(self.gh, SF.monday(32), stations[:4])                        # 4 of 4: too few scouted
        pin = self.section_pin()
        self.as_user("Administrator")
        self.assertEqual(PN.check_pins(), {"pins": 1, "notified": 0})
        self.assertEqual(self.told(pin["name"]), [])

    def test_notify_off_is_never_checked(self):
        self.seed_rise(5, 9)                                                 # 50 % → 90 %
        pin = self.section_pin(notify=0)
        self.as_user("Administrator")
        self.assertEqual(PN.check_pins(), {"pins": 0, "notified": 0})
        self.assertEqual(self.told(pin["name"]), [])

    def test_the_hourly_check_runs_pins_after_alerts_and_survives_their_failure(self):
        with patch.object(TC, "_crops_to_check", return_value=[]), \
                patch.object(PN, "check_pins", return_value={"pins": 0, "notified": 0}) as ran:
            out = TC.run_threshold_check(force=True, commit=False)
        ran.assert_called_once()
        self.assertEqual((out["pins"], out["errors"]), ({"pins": 0, "notified": 0}, []))
        with patch.object(TC, "_crops_to_check", return_value=[]), \
                patch.object(PN, "check_pins", side_effect=RuntimeError("boom")):
            out = TC.run_threshold_check(force=True, commit=False)
        self.assertEqual(out["errors"], ["pins"])
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_scouting_pins`**
Expected: `TestSeries` / `TestPinCheck` fail with `AttributeError: module '…pins' has no attribute 'pin_series'` / `'check_pins'`. `TestPins` stays OK.

- [ ] **Step 3: The series**

In `upande_scp/serverscripts/scouting/pins.py`:

(a) Imports become:

```python
import json
from datetime import timedelta

import frappe

from upande_scp.serverscripts.common import clusters as C
from upande_scp.serverscripts.common import crop_catalog, notifications
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import thresholds_check as TC
```

and after `EDIT_ROLES` add:

```python
#: C7: the Pins panel's sparkline, over the house's last scouted weeks.
SERIES_WEEKS = 8
#: How far back the series looks for those weeks (16 ISO weeks).
SERIES_LOOKBACK_DAYS = 16 * 7
```

(b) Replace `list_pins` with:

```python
@frappe.whitelist()
def list_pins(crop, warehouse, with_series=1, weeks=SERIES_WEEKS) -> list:
    """C9: the house's pins this user may see: every shared pin plus their
    own private ones, newest first. ``may_edit`` says whether Delete shows.
    With ``with_series`` every pin carries its last ``weeks`` scouted weeks
    (C7), all from one scouting load for the house."""
    crop, _farm, warehouse = _house(crop, warehouse)
    user = frappe.session.user
    rows = _visible_rows(crop, warehouse, user)
    out = [_public(r, user) for r in rows]
    if _truthy(with_series) and rows:
        series = _series_for(crop, warehouse, rows, TC.now_eat().date(), _weeks(weeks))
        for p in out:
            p["series"] = series.get(p["name"], [])
    return out
```

(c) Append to the module:

```python
# ── the weekly figure (C7) ─────────────────────────────────────────────────


def _weeks(n) -> int:
    try:
        return max(1, min(16, int(n)))
    except (TypeError, ValueError):
        return SERIES_WEEKS


def _infested(weeks, pin, week) -> set:
    """The pin's observation (one stage when it names one), or every pest and
    disease when it names none."""
    obs = (pin.observation or "").strip()
    if obs:
        kind = (pin.obs_kind or "Pest").strip().lower()
        return weeks.infested_set(pin.warehouse, week, kind, obs, (pin.stage or "").strip() or R.ANY)
    return weeks.infested_set(pin.warehouse, week, "pest") | weeks.infested_set(pin.warehouse, week, "disease")


def _figure(weeks, pin, stations, week) -> dict:
    return C.share(stations, weeks.scouted_set(pin.warehouse, week), _infested(weeks, pin, week))


def _series_for(crop, warehouse, pins, today, n=SERIES_WEEKS) -> dict:
    """``{pin: [{"week", "scouted", "infested", "value", "thin"}]}`` over the
    house's last ``n`` scouted weeks within 16 weeks of ``today``. A week the
    house was scouted but the pin's stations were not reads scouted 0, thin."""
    if not pins:
        return {}
    start = (today - timedelta(days=SERIES_LOOKBACK_DAYS - 1)).isoformat()
    weeks = R.StationWeeks.load(start, today.isoformat(), crop, [warehouse], lookback_days=0, weeks=R.WINDOW)
    labels = weeks.weeks(warehouse)[-n:]
    out = {}
    for pin in pins:
        stations = pin_stations(pin)
        out[pin.name] = [{"week": w, **_figure(weeks, pin, stations, w)} for w in labels]
    return out


@frappe.whitelist()
def pin_series(name, weeks=SERIES_WEEKS) -> list:
    """One pin's last ``weeks`` scouted weeks (C7), for whoever may see it."""
    pin = frappe.db.get_value(DOCTYPE, name, PIN_FIELDS, as_dict=True)
    if not pin:
        frappe.throw(f"No Scouting Pin {name}.", frappe.DoesNotExistError)
    crop, _farm, warehouse = _house(pin.crop, pin.warehouse)
    if not _visible(pin, frappe.session.user):
        frappe.throw("This pin is private.", frappe.PermissionError)
    return _series_for(crop, warehouse, [pin], TC.now_eat().date(), _weeks(weeks)).get(pin.name, [])


# ── the owner's notice (C8) ────────────────────────────────────────────────


def _notify_owner(pin, now, before, week) -> bool:
    what = pin.observation or "every pest and disease"
    rise = round(now["value"] - before["value"], 1)
    subject = (
        f"Pin {pin.title} in {pin.warehouse}: {what} {now['value']}% (was {before['value']}%) — "
        f"up {rise} points in {week}"
    )
    body = (
        f"{subject}. {now['infested']} of {now['scouted']} stations infested, "
        f"{before['infested']} of {before['scouted']} the scouted week before."
    )
    return bool(notifications.notify(
        [pin.owner], subject, body, DOCTYPE, pin.name, category="scouting", link=TC.dashboard_link(pin.crop),
    ))


def _check_one(weeks, pin) -> bool:
    latest, previous = weeks.latest_pair(pin.warehouse)
    if not latest or not previous or pin.last_notified_week == latest:
        return False
    stations = pin_stations(pin)
    now = _figure(weeks, pin, stations, latest)
    before = _figure(weeks, pin, stations, previous)
    if not C.pin_rises(before, now) or not _notify_owner(pin, now, before, latest):
        return False
    frappe.db.set_value(DOCTYPE, pin.name, "last_notified_week", latest, update_modified=False)
    return True


def check_pins(today=None) -> dict:
    """C8, hourly after the alerts. For each pin with ``notify`` it compares the
    figure in the house's latest scouted week (last 14 days, the alerts'
    window) with the previous scouted week. A rise of ≥ 10 points, with ≥ 5
    stations scouted both weeks, tells the owner in-app (category "scouting"),
    at most once per ISO week (``last_notified_week``). One scouting load per
    crop. A failing crop or pin is logged and never stops the others."""
    if not frappe.db.table_exists(DOCTYPE):
        return {"pins": 0, "notified": 0}
    today = today or TC.now_eat().date()
    rows = frappe.get_all(DOCTYPE, filters={"notify": 1}, fields=PIN_FIELDS, limit_page_length=0)
    by_crop: dict = {}
    for r in rows:
        by_crop.setdefault(r.crop, []).append(r)
    start = (today - timedelta(days=TC.EVAL_WINDOW_DAYS - 1)).isoformat()
    told = 0
    for crop, pins in sorted(by_crop.items()):
        try:
            weeks = R.StationWeeks.load(start, today.isoformat(), crop, sorted({p.warehouse for p in pins}))
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"pin check: {crop}")
            continue
        for pin in pins:
            try:
                told += 1 if _check_one(weeks, pin) else 0
            except Exception:
                frappe.log_error(frappe.get_traceback(), f"pin check: {pin.name}")
    return {"pins": len(rows), "notified": told}
```

- [ ] **Step 4: Hook into the hourly check**

In `upande_scp/serverscripts/scouting/thresholds_check.py`, inside `run_threshold_check`, after the `for crop in _crops_to_check():` loop and before `return out`, add:

```python
    # Spread piece 3c (C8): pins after the alerts. A pin failure is logged and
    # never blocks the alert check; pins.py imports this module, hence the late import.
    try:
        from upande_scp.serverscripts.scouting import pins

        out["pins"] = pins.check_pins(today)
        if commit:
            frappe.db.commit()
    except Exception:
        if commit:
            frappe.db.rollback()
        frappe.log_error(frappe.get_traceback(), "threshold check: pins")
        out["errors"].append("pins")
```

The 3b plan does not touch `run_threshold_check`. If it does by the time you get here, keep its changes and add this block last.

- [ ] **Step 5: Run to pass, plus the alert suites**

Run: **DB-RUN `test_scouting_pins`**, **DB-RUN `test_scouting_alerts`**, **DB-RUN `test_hot_spots`**, **DB-RUN `test_alert_digest`**
Expected: all OK.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/scouting/pins.py upande_scp/serverscripts/scouting/thresholds_check.py upande_scp/serverscripts/tests/test_scouting_pins.py
git commit -m "feat(scp): pin series over the last eight scouted weeks and the owner's weekly notice from the hourly check"
```

---

### Task 5: The digest's hot-spot rows name the patch they sit in

> Needs 3b's digest (see Global Constraints). Check first: `grep -n "section_label\|def _figure" upande_scp/serverscripts/scouting/alert_digest.py` must show 3b's hot-spot branch.

**Files:**
- Modify: `upande_scp/serverscripts/scouting/spread.py` (append `patch_note`)
- Modify: `upande_scp/serverscripts/scouting/alert_digest.py` (imports; new `_patch_suffix`; `render`)
- Test: `upande_scp/serverscripts/tests/test_spread.py` (class `TestDigestNote`)

**Interfaces:**
- Consumes: Task 2 `house_clusters`, `normalize_week`, `STATION_WORDS`, `R.station_grid`. Also 3b's `B.HOT_SPOT` and the alert rows' `alert_type`, `section_row`, `section_col`, `section_label`.
- Produces:
  - `S.patch_note(crop, warehouse, kind, observation, iso_week, section_row, section_col) -> "patch of 6 zones, new" | ""`.
  - `alert_digest._patch_suffix(alert, memo) -> " · patch of …" | ""`.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_spread.py`:

```python
class TestDigestNote(SpreadCase):
    def setUp(self):
        super().setUp()
        SF.seed_cells(self.gh, SF.monday(31), SF.rect(0, 0, 2, 3))         # 6 zones in "first beds · front"

    def test_a_hot_section_inside_a_patch_names_it(self):
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W31", 0, 0), "patch of 6 zones, new")
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W31", 2, 2), "")
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W30", 0, 0), "")
        self.assertEqual(S.patch_note("Rose", self.gh, "Pest", "Thrips", "2031-W31", -1, -1), "")

    def test_the_digest_adds_the_note_to_hot_spot_rows_only(self):
        from upande_scp.serverscripts.scouting import alert_digest as D

        base = frappe._dict(
            crop="Rose", farm=frappe.db.get_value("Warehouse", self.gh, "custom_farm"), warehouse=self.gh,
            kind="Pest", observation="Thrips", stage="", iso_week="2031-W31", measure="Percentage", unit="%",
            value=50.0, margin=None, reliability="Fair", sections_scouted=6, band="High",
        )
        spot = frappe._dict(base, action="Hot spot", alert_type="Hot spot", section_row=0, section_col=0,
                            section_label="first beds · front", sections_total=1)
        house = frappe._dict(base, action="Alarming", alert_type="House", section_row=-1, section_col=-1,
                             section_label="", sections_total=9)
        html = D.render([house, spot], date(2031, 8, 3))
        self.assertEqual(html.count("patch of 6 zones, new"), 1)
        self.assertIn("first beds · front · patch of 6 zones, new", html)
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_spread`**
Expected: `TestDigestNote` fails with `AttributeError: module '…spread' has no attribute 'patch_note'`.

- [ ] **Step 3: `patch_note`**

Append to `upande_scp/serverscripts/scouting/spread.py`:

```python
def patch_note(crop, warehouse, kind, observation, iso_week, section_row, section_col) -> str:
    """C5, for the digest: ``patch of 7 zones, grew`` for the largest patch of
    this house-week (all stages) with a station in the hot section; ``""`` when
    none lies there, for a House row (−1), or when the week was not scouted."""
    try:
        cell = (int(section_row), int(section_col))
    except (TypeError, ValueError):
        return ""
    week = normalize_week(iso_week)
    if cell[0] < 0 or cell[1] < 0 or not week:
        return ""
    data = house_clusters(crop, warehouse, observation, kind, None, week)
    if data["week"] != week:
        return ""
    grid = R.station_grid(warehouse)
    word = STATION_WORDS.get(data["unit"], "zones")
    for c in data["clusters"]:
        if any(tuple(grid.get(s) or ()) == cell for s in c["stations"]):
            return f"patch of {c['size']} {word}, {c['change'].lower()}"
    return ""
```

- [ ] **Step 4: The digest**

In `upande_scp/serverscripts/scouting/alert_digest.py`:

(a) Add to the imports, after `from upande_scp.serverscripts.scouting import thresholds_check as TC`:

```python
from upande_scp.serverscripts.scouting import spread
```

(b) Add above `def render`:

```python
def _patch_suffix(a, memo) -> str:
    """`` · patch of 7 zones, grew`` on a hot-spot row whose section holds part
    of a patch (spread spec C5); ``""`` otherwise, or when it cannot be read —
    the digest never fails over a patch."""
    if a.get("alert_type") != B.HOT_SPOT:
        return ""
    key = (a.crop, a.warehouse, a.kind, a.observation, a.iso_week, a.get("section_row"), a.get("section_col"))
    if key not in memo:
        try:
            memo[key] = spread.patch_note(*key)
        except Exception:
            frappe.log_error(frappe.get_traceback(), "alert digest: patch note")
            memo[key] = ""
    return f" · {frappe.utils.escape_html(memo[key])}" if memo[key] else ""
```

(c) In `render`, add `notes: dict = {}` as the first line after `cell = "padding:4px 8px"`. In the greenhouse cell (3b's line reading `f"<td style='{cell}'>{esc(a.warehouse)}{(' · ' + esc(a.section_label)) if a.get('section_label') else ''}</td>"`), insert `{_patch_suffix(a, notes)}` just before `</td>`:

```python
        f"<td style='{cell}'>{esc(a.warehouse)}{(' · ' + esc(a.section_label)) if a.get('section_label') else ''}"
        f"{_patch_suffix(a, notes)}</td>"
```

- [ ] **Step 5: Run to pass, plus the digest suites**

Run: **DB-RUN `test_spread`**, **DB-RUN `test_alert_digest`**, **DB-RUN `test_hot_spots`**
Expected: all OK. The existing digest tests seed no patch, so their HTML is unchanged.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/scouting/spread.py upande_scp/serverscripts/scouting/alert_digest.py upande_scp/serverscripts/tests/test_spread.py
git commit -m "feat(scp): the digest's hot-spot rows name the patch they sit in"
```

---

### Task 6: Patches and pins on the greenhouse modal

**Files:**
- Create: `frontend/src/lib/spread-api.ts`, `frontend/src/lib/spread-api.test.ts`
- Create: `frontend/src/pages/dashboard/PatchesList.tsx`, `PinsPanel.tsx`, `PinForm.tsx`, `HouseSpread.tsx`
- Modify: `frontend/src/pages/dashboard/SectionGrid.tsx` (props + cell body)
- Modify: `frontend/src/pages/dashboard/GreenhouseModal.tsx` (the `<SectionGrid sections={current.sections} />` line)
- Test: `frontend/src/pages/dashboard/__tests__/GreenhouseModal.spread.test.tsx` (new); `GreenhouseModal.sections.test.tsx` (add a mock)

**Interfaces:**
- Consumes: Task 2 `get_house_clusters` payload; Task 3/4 `save_pin`, `list_pins` (with `series`), `delete_pin`.
- Produces:
  - Types `Patch`, `HouseClusters`, `PinKind`, `PinPoint`, `ScoutingPin`, `SavePinArgs`; `NO_CLUSTERS`.
  - Calls: `getHouseClusters`, `listPins(crop, warehouse, withSeries = true)`, `savePin`, `deletePin`.
  - Helpers: `isoWeekKey`, `stationWord(unit)`, `patchLine(patch, unit)`, `pinValueLabel(point?)`, `CHANGE_TONE`.
  - `<HouseSpread crop greenhouse kind observation week sections />`, `<PatchesList data onPinPatch? />`, `<ChangePill change />`, `<PinsPanel pins onDelete? />`, `<Sparkline points testId? />`, `<PinForm defaultTitle busy? onSave onCancel />`.
  - `SectionGrid` gains `onPinSection?: (row, col) => void`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/spread-api.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("./frappe", () => ({ call: (...a: unknown[]) => call(...a) }));

import { NO_CLUSTERS, getHouseClusters, isoWeekKey, patchLine, pinValueLabel, savePin } from "./spread-api";

beforeEach(() => {
  call.mockReset().mockResolvedValue({ name: "PIN-1" });
});

describe("spread api", () => {
  it("pads the ISO week the server keys on", () => {
    expect(isoWeekKey("2031-W5")).toBe("2031-W05");
    expect(isoWeekKey("2031-W31")).toBe("2031-W31");
    expect(isoWeekKey(null)).toBeUndefined();
  });

  it("sends stations and the polygon as JSON, shared and notify as 0/1", async () => {
    await savePin({
      crop: "Rose", warehouse: "GH", kind: "Area", title: "corner", shared: false,
      polygon: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    });
    const [method, args] = call.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("upande_scp.serverscripts.scouting.pins.save_pin");
    expect(JSON.parse(args.polygon as string).type).toBe("Polygon");
    expect([args.shared, args.notify]).toEqual([0, 1]);
    await savePin({ crop: "Rose", warehouse: "GH", kind: "Patch", title: "p", stations: ["Z1", "Z2"] });
    expect((call.mock.calls[1][1] as Record<string, unknown>).stations).toBe('["Z1","Z2"]');
  });

  it("falls back to no clusters and pads the week it asks for", async () => {
    call.mockResolvedValueOnce(null);
    const got = await getHouseClusters({ crop: "Rose", warehouse: "GH", observation: "Thrips", kind: "pest", week: "2031-W5" });
    expect(got).toEqual(NO_CLUSTERS);
    expect((call.mock.calls[0][1] as Record<string, unknown>).week).toBe("2031-W05");
  });

  it("words a pin's figure and a patch", () => {
    expect(pinValueLabel(undefined)).toBe("not scouted");
    expect(pinValueLabel({ week: "2031-W31", scouted: 4, infested: 4, value: null, thin: true })).toBe("too few scouted");
    expect(pinValueLabel({ week: "2031-W31", scouted: 6, infested: 3, value: 50, thin: false })).toBe("50%");
    expect(patchLine({ size: 9, label: "beds 1–3, zones 1–3" }, "bed")).toBe("9 zones · beds 1–3, zones 1–3");
    expect(patchLine({ size: 4, label: "rows 1–2, trees 1–2" }, "row")).toBe("4 trees · rows 1–2, trees 1–2");
  });
});
```

Create `frontend/src/pages/dashboard/__tests__/GreenhouseModal.spread.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getHouseClusters = vi.fn();
const listPins = vi.fn();
const savePin = vi.fn();
const deletePin = vi.fn();
vi.mock("@/lib/spread-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spread-api")>()),
  getHouseClusters: (...a: unknown[]) => getHouseClusters(...a),
  listPins: (...a: unknown[]) => listPins(...a),
  savePin: (...a: unknown[]) => savePin(...a),
  deletePin: (...a: unknown[]) => deletePin(...a),
}));
const useDashboardAggregate = vi.fn();
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));

import { HouseSpread } from "../HouseSpread";
import { GreenhouseModal } from "../GreenhouseModal";
import type { SectionCell } from "@/lib/prevalence";

const GH = "Chepsito GH 01 - KR";
const sections: SectionCell[] = Array.from({ length: 9 }, (_, j) => ({
  row: Math.floor(j / 3), col: j % 3, scouted: 6, infested: 2, pct: 33.3,
}));
const grew = {
  id: "P1", stations: ["Z1", "Z2", "Z3", "Z4", "Z5", "Z6", "Z7", "Z8", "Z9"], size: 9, centroid: [1, 1],
  rows: [0, 2], cols: [0, 2], label: "beds 1–3, zones 1–3", change: "Grew", prev_size: 6,
};
const fresh = { ...grew, id: "P2", stations: ["Z40", "Z41", "Z42", "Z43"], size: 4, label: "bed 31, zones 1–4", change: "New", prev_size: null };
const old = { ...grew, id: "P1", stations: ["Z90", "Z91", "Z92"], size: 3, label: "bed 11, zones 1–3", change: "Gone", prev_size: 3 };
const pin = {
  name: "PIN-1", title: "Thrips · front", crop: "Rose", warehouse: GH, kind: "Section", observation: "Thrips",
  obs_kind: "Pest", section_row: 0, section_col: 0, stations: [], polygon: null, shared: 1, notify: 1,
  owner: "a@x", may_edit: true,
  series: [
    { week: "2031-W29", scouted: 6, infested: 1, value: 16.7, thin: false },
    { week: "2031-W30", scouted: 6, infested: 3, value: 50, thin: false },
    { week: "2031-W31", scouted: 4, infested: 4, value: null, thin: true },
  ],
};
const props = { crop: "Rose", greenhouse: GH, kind: "pest" as const, observation: "Thrips", week: "2031-W31", sections };

beforeEach(() => {
  getHouseClusters.mockReset().mockResolvedValue({ week: "2031-W31", prev_week: "2031-W30", unit: "bed", clusters: [grew, fresh], gone: [old] });
  listPins.mockReset().mockResolvedValue([pin]);
  savePin.mockReset().mockResolvedValue({ name: "PIN-2" });
  deletePin.mockReset().mockResolvedValue({ name: "PIN-1" });
});

describe("HouseSpread", () => {
  it("lists the patches with change pills and the gone ones muted", async () => {
    render(<HouseSpread {...props} />);
    const top = await screen.findByTestId("patch-P1");
    expect(top).toHaveTextContent("9 zones");
    expect(top).toHaveTextContent("beds 1–3, zones 1–3");
    expect(top).toHaveTextContent("was 6");
    expect(within(top).getByTestId("change-pill")).toHaveAttribute("data-change", "Grew");
    expect(within(screen.getByTestId("patch-P2")).getByTestId("change-pill")).toHaveTextContent("New");
    expect(within(screen.getByTestId("gone-P1")).getByTestId("change-pill")).toHaveAttribute("data-change", "Gone");
    expect(getHouseClusters).toHaveBeenCalledWith({ crop: "Rose", warehouse: GH, observation: "Thrips", kind: "pest", week: "2031-W31" });
  });

  it("pins a patch with its frozen station list", async () => {
    render(<HouseSpread {...props} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Pin this patch" }))[0]);
    expect(screen.getByLabelText("Pin title")).toHaveValue("Thrips · beds 1–3, zones 1–3");
    fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
    await waitFor(() => expect(savePin).toHaveBeenCalledWith(expect.objectContaining({
      crop: "Rose", warehouse: GH, kind: "Patch", stations: grew.stations, observation: "Thrips",
      obs_kind: "pest", source_week: "2031-W31", shared: true,
    })));
    await waitFor(() => expect(listPins).toHaveBeenCalledTimes(2));
  });

  it("pins a section from the grid", async () => {
    render(<HouseSpread {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Middle third · Middle" }));
    expect(screen.getByLabelText("Pin title")).toHaveValue("Thrips · Middle third · middle");
    fireEvent.click(screen.getByLabelText("Shared"));
    fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
    await waitFor(() => expect(savePin).toHaveBeenCalledWith(expect.objectContaining({
      kind: "Section", section_row: 1, section_col: 1, shared: false,
    })));
  });

  it("shows each pin's weeks as a sparkline and a thin week as too few scouted", async () => {
    render(<HouseSpread {...props} />);
    expect(await screen.findByTestId("pin-sparkline-PIN-1")).toHaveAttribute("data-points", "2");
    expect(screen.getByTestId("pin-PIN-1")).toHaveTextContent("too few scouted");
    fireEvent.click(screen.getByRole("button", { name: "Delete pin Thrips · front" }));
    await waitFor(() => expect(deletePin).toHaveBeenCalledWith("PIN-1"));
  });

  it("draws no left-border strips", async () => {
    const { container } = render(<HouseSpread {...props} />);
    await screen.findByTestId("patch-P1");
    const classes = Array.from(container.querySelectorAll("[class]")).map((el) => el.getAttribute("class") || "");
    expect(classes.some((c) => /(^|\s)border-l(-|\s|$)/.test(c))).toBe(false);
  });
});

describe("GreenhouseModal spread", () => {
  it("asks for the shown observation's patches in its week", async () => {
    useDashboardAggregate.mockReturnValue({
      data: {
        topPests: [{ name: "Thrips", count: 9 }], topDiseases: [], traps: [], daily: [], scouts: 1, alerts: 0,
        prevalence: [{ kind: "pest", name: "Thrips", prevalence: 33.3, margin: 10, sections_scouted: 9,
                       sections_total: 9, reliability: "Fair", reason: null, prev: null, week: "2031-W31", sections }],
      },
    });
    render(<GreenhouseModal greenhouse={GH} fromDate="2031-07-28" toDate="2031-08-03" crop="Rose" onClose={() => {}} />);
    await screen.findByTestId("patches");
    expect(getHouseClusters).toHaveBeenCalledWith({ crop: "Rose", warehouse: GH, observation: "Thrips", kind: "pest", week: "2031-W31" });
  });
});
```

In `frontend/src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx`, directly after its `vi.mock("@/hooks/use-dashboard-aggregate", …)` block, add:

```tsx
vi.mock("@/lib/spread-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spread-api")>()),
  getHouseClusters: vi.fn().mockResolvedValue({ week: null, prev_week: null, unit: "bed", clusters: [], gone: [] }),
  listPins: vi.fn().mockResolvedValue([]),
}));
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/spread-api.test.ts src/pages/dashboard/__tests__/GreenhouseModal.spread.test.tsx`
Expected: FAIL with `Failed to resolve import "./spread-api"` / `"../HouseSpread"`.

- [ ] **Step 3: `lib/spread-api.ts`**

```ts
/**
 * Spread and pins (spec 2026-10-10-spread-and-pins): a house's patches of
 * neighbouring infested stations tracked week to week, and the pins agronomists
 * watch. Figures come from the server; the browser only formats them.
 */
import { call } from "./frappe";

export type PatchChange = "New" | "Grew" | "Shrank" | "Moved" | "Stable" | "Gone";

export interface Patch {
  id: string;
  stations: string[];
  size: number;
  /** mean (bed rank, zone rank) — rank space, not geometry */
  centroid: [number, number];
  rows: [number, number];
  cols: [number, number];
  /** "beds 20–24, zones 3–7" / "rows 4–6, trees 10–15" */
  label: string;
  change: PatchChange;
  prev_size: number | null;
}

export interface HouseClusters {
  week: string | null;
  prev_week: string | null;
  /** "row" on an avocado block (rows and trees), else "bed" */
  unit: "bed" | "row";
  clusters: Patch[];
  gone: Patch[];
}

export const NO_CLUSTERS: HouseClusters = { week: null, prev_week: null, unit: "bed", clusters: [], gone: [] };

export type PinKind = "Section" | "Patch" | "Area";

export interface PinPoint {
  week: string;
  scouted: number;
  infested: number;
  /** infested ÷ scouted × 100; null below 5 scouted ("too few scouted") */
  value: number | null;
  thin: boolean;
}

export interface ScoutingPin {
  name: string;
  title: string;
  crop: string;
  warehouse: string;
  kind: PinKind;
  observation?: string | null;
  obs_kind?: "Pest" | "Disease" | "" | null;
  stage?: string | null;
  section_row?: number;
  section_col?: number;
  stations: string[];
  polygon?: { type: string; coordinates: unknown } | null;
  source_week?: string | null;
  shared: 0 | 1;
  notify: 0 | 1;
  owner: string;
  may_edit: boolean;
  series?: PinPoint[];
}

export interface SavePinArgs {
  crop: string;
  warehouse: string;
  kind: PinKind;
  title: string;
  observation?: string;
  obs_kind?: "pest" | "disease" | "Pest" | "Disease";
  stage?: string;
  section_row?: number;
  section_col?: number;
  stations?: string[];
  polygon?: { type: "Polygon"; coordinates: number[][][] };
  source_week?: string | null;
  shared?: boolean;
  notify?: boolean;
}

const SPREAD = "upande_scp.serverscripts.scouting.spread";
const PINS = "upande_scp.serverscripts.scouting.pins";

/** "2026-W9" → "2026-W09" (the server's key); anything else passes through. */
export function isoWeekKey(week?: string | null): string | undefined {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(week || "");
  return m ? `${m[1]}-W${m[2].padStart(2, "0")}` : week || undefined;
}

export function stationWord(unit: HouseClusters["unit"]): string {
  return unit === "row" ? "trees" : "zones";
}

/** "9 zones · beds 1–3, zones 1–3" */
export function patchLine(p: Pick<Patch, "size" | "label">, unit: HouseClusters["unit"]): string {
  return `${p.size} ${stationWord(unit)} · ${p.label}`;
}

/** "50%", "too few scouted" (< 5 scouted) or "not scouted" (no week yet). */
export function pinValueLabel(pt?: PinPoint): string {
  if (!pt) return "not scouted";
  if (pt.value == null) return "too few scouted";
  return `${pt.value}%`;
}

/** Text / outline colour per change; worse = red, better = green. */
export const CHANGE_TONE: Record<PatchChange, string> = {
  New: "var(--sd-data-purple)",
  Grew: "var(--sd-data-red)",
  Shrank: "var(--sd-data-green)",
  Moved: "var(--sd-data-amber)",
  Stable: "var(--muted-foreground)",
  Gone: "var(--muted-foreground)",
};

export async function getHouseClusters(args: {
  crop: string;
  warehouse: string;
  observation: string;
  kind: "pest" | "disease";
  stage?: string;
  week?: string | null;
}): Promise<HouseClusters> {
  const r = await call<HouseClusters>(`${SPREAD}.get_house_clusters`, {
    crop: args.crop,
    warehouse: args.warehouse,
    observation: args.observation,
    kind: args.kind,
    stage: args.stage || undefined,
    week: isoWeekKey(args.week),
  });
  return r || NO_CLUSTERS;
}

export async function listPins(crop: string, warehouse: string, withSeries = true): Promise<ScoutingPin[]> {
  const r = await call<ScoutingPin[]>(`${PINS}.list_pins`, { crop, warehouse, with_series: withSeries ? 1 : 0 });
  return r || [];
}

export async function savePin(a: SavePinArgs): Promise<ScoutingPin> {
  return call<ScoutingPin>(`${PINS}.save_pin`, {
    crop: a.crop,
    warehouse: a.warehouse,
    kind: a.kind,
    title: a.title,
    observation: a.observation || undefined,
    obs_kind: a.obs_kind || undefined,
    stage: a.stage || undefined,
    section_row: a.section_row,
    section_col: a.section_col,
    stations: a.stations ? JSON.stringify(a.stations) : undefined,
    polygon: a.polygon ? JSON.stringify(a.polygon) : undefined,
    source_week: isoWeekKey(a.source_week),
    shared: a.shared === false ? 0 : 1,
    notify: a.notify === false ? 0 : 1,
  });
}

export async function deletePin(name: string): Promise<{ name: string }> {
  return call(`${PINS}.delete_pin`, { name });
}
```

- [ ] **Step 4: The three small components**

Create `frontend/src/pages/dashboard/PatchesList.tsx`:

```tsx
import { CHANGE_TONE, stationWord, type HouseClusters, type Patch, type PatchChange } from "@/lib/spread-api";

/** New / Grew / Shrank / Moved / Stable / Gone, as a tinted pill (no strips). */
export function ChangePill({ change }: { change: PatchChange }) {
  const tone = CHANGE_TONE[change];
  return (
    <span
      data-testid="change-pill"
      data-change={change}
      className="shrink-0 rounded-full border px-1.5 py-px text-[0.6rem] font-medium"
      style={{ color: tone, borderColor: tone, background: `color-mix(in srgb, ${tone} 10%, transparent)` }}
    >
      {change}
    </span>
  );
}

/** C5: the house's patches this week (largest first) and last week's that are gone. */
export function PatchesList({ data, onPinPatch }: { data: HouseClusters | null; onPinPatch?: (p: Patch) => void }) {
  if (!data || !data.week) return null;
  const word = stationWord(data.unit);
  const none = !data.clusters.length && !data.gone.length;
  return (
    <div data-testid="patches" className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[0.7rem]">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">Patches</span>
        <span className="text-muted-foreground">
          {data.week}
          {data.prev_week ? ` vs ${data.prev_week}` : ""}
        </span>
      </div>
      {none ? (
        <span className="text-xs text-muted-foreground">No patch of 3 or more neighbouring {word}.</span>
      ) : null}
      {data.clusters.map((p) => (
        <div key={p.id} data-testid={`patch-${p.id}`} className="flex items-center gap-2 rounded bg-[var(--sd-bg-soft)] px-2 py-1 text-xs">
          <span className="shrink-0 font-semibold tabular-nums">
            {p.size} {word}
          </span>
          <span className="truncate text-muted-foreground">{p.label}</span>
          <ChangePill change={p.change} />
          {p.prev_size != null && p.change !== "Stable" ? (
            <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">was {p.prev_size}</span>
          ) : null}
          {onPinPatch ? (
            <button
              type="button"
              onClick={() => onPinPatch(p)}
              className="ml-auto shrink-0 rounded border px-1.5 py-px text-[0.65rem] hover:bg-muted"
            >
              Pin this patch
            </button>
          ) : null}
        </div>
      ))}
      {data.gone.map((p) => (
        <div key={`gone-${p.id}`} data-testid={`gone-${p.id}`} className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground opacity-70">
          <span className="shrink-0 tabular-nums">
            {p.size} {word}
          </span>
          <span className="truncate">{p.label}</span>
          <ChangePill change="Gone" />
        </div>
      ))}
    </div>
  );
}
```

Create `frontend/src/pages/dashboard/PinsPanel.tsx`:

```tsx
import { pinValueLabel, type ScoutingPin } from "@/lib/spread-api";

/** 0–100 values left to right; a null (thin or unscouted) week is a gap. */
export function Sparkline({ points, testId }: { points: (number | null)[]; testId?: string }) {
  const W = 84;
  const H = 22;
  const step = points.length > 1 ? W / (points.length - 1) : 0;
  const shown = points
    .map((v, i) => (v == null ? null : ([i * step, H - (Math.max(0, Math.min(100, v)) / 100) * H] as [number, number])))
    .filter((c): c is [number, number] => c != null);
  return (
    <svg data-testid={testId} data-points={shown.length} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 overflow-visible" aria-hidden>
      {shown.length > 1 ? (
        <polyline
          points={shown.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
          fill="none"
          stroke="var(--sd-data-purple)"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      ) : null}
      {shown.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.6} fill="var(--sd-data-purple)" />
      ))}
    </svg>
  );
}

/** C7: the house's pins with their last scouted weeks. */
export function PinsPanel({ pins, onDelete }: { pins: ScoutingPin[]; onDelete?: (name: string) => void }) {
  return (
    <div data-testid="pins" className="flex flex-col gap-1">
      {pins.length ? (
        pins.map((p) => {
          const series = p.series ?? [];
          const last = series[series.length - 1];
          return (
            <div key={p.name} data-testid={`pin-${p.name}`} className="flex items-center gap-2 rounded bg-[var(--sd-bg-soft)] px-2 py-1 text-xs">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{p.title}</span>
                <span className="truncate text-[0.65rem] text-muted-foreground">
                  {p.kind} · {p.observation || "every pest and disease"}
                  {p.shared ? "" : " · private"}
                </span>
              </div>
              <Sparkline points={series.map((s) => s.value)} testId={`pin-sparkline-${p.name}`} />
              <span className="ml-auto shrink-0 tabular-nums" title={last ? `${last.infested} of ${last.scouted} stations · ${last.week}` : undefined}>
                {pinValueLabel(last)}
              </span>
              {p.may_edit && onDelete ? (
                <button
                  type="button"
                  onClick={() => onDelete(p.name)}
                  aria-label={`Delete pin ${p.title}`}
                  className="shrink-0 rounded border px-1.5 py-px text-[0.65rem] hover:bg-muted"
                >
                  Delete
                </button>
              ) : null}
            </div>
          );
        })
      ) : (
        <span className="text-xs text-muted-foreground">No pins on this house yet.</span>
      )}
    </div>
  );
}
```

Create `frontend/src/pages/dashboard/PinForm.tsx`:

```tsx
import { useState } from "react";

/** Title + shared, then Save pin / Cancel. Shared defaults on (C6). */
export function PinForm({
  defaultTitle,
  busy,
  onSave,
  onCancel,
}: {
  defaultTitle: string;
  busy?: boolean;
  onSave: (title: string, shared: boolean) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [shared, setShared] = useState(true);
  return (
    <form
      data-testid="pin-form"
      className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave(title.trim(), shared);
      }}
    >
      <input
        aria-label="Pin title"
        value={title}
        maxLength={140}
        onChange={(e) => setTitle(e.target.value)}
        className="min-w-0 flex-1 rounded border bg-card px-2 py-1"
      />
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        Shared
      </label>
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="rounded border border-primary bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
      >
        Save pin
      </button>
      <button type="button" onClick={onCancel} className="rounded border px-2 py-1 hover:bg-muted">
        Cancel
      </button>
    </form>
  );
}
```

- [ ] **Step 5: `HouseSpread`, the "Pin" cells, and the modal**

Create `frontend/src/pages/dashboard/HouseSpread.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import type { SectionCell } from "@/lib/prevalence";
import {
  deletePin,
  getHouseClusters,
  listPins,
  savePin,
  type HouseClusters,
  type Patch,
  type ScoutingPin,
} from "@/lib/spread-api";
import { SectionGrid } from "./SectionGrid";
import { PatchesList } from "./PatchesList";
import { PinsPanel } from "./PinsPanel";
import { PinForm } from "./PinForm";

const ROW_WORDS = ["First third", "Middle third", "Last third"];
const COL_WORDS = ["front", "middle", "back"];

type Pending = { kind: "Section"; row: number; col: number } | { kind: "Patch"; patch: Patch };

export interface HouseSpreadProps {
  crop: string;
  greenhouse: string;
  kind: "pest" | "disease";
  observation: string;
  week?: string | null;
  sections: SectionCell[];
}

/** The greenhouse modal's "where it is" block (spread spec §6): the 3 × 3 grid
 *  with "Pin" per cell, the house's patches for this observation and week, and
 *  the house's pins with their sparklines. */
export function HouseSpread({ crop, greenhouse, kind, observation, week, sections }: HouseSpreadProps) {
  const [clusters, setClusters] = useState<HouseClusters | null>(null);
  const [pins, setPins] = useState<ScoutingPin[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setClusters(null);
    getHouseClusters({ crop, warehouse: greenhouse, observation, kind, week })
      .then((r) => live && setClusters(r))
      .catch(() => live && setClusters(null));
    return () => {
      live = false;
    };
  }, [crop, greenhouse, observation, kind, week]);

  const reloadPins = useCallback(() => {
    listPins(crop, greenhouse)
      .then(setPins)
      .catch(() => setPins([]));
  }, [crop, greenhouse]);
  useEffect(() => reloadPins(), [reloadPins]);
  useEffect(() => setPending(null), [greenhouse, observation, kind]);

  const defaultTitle = !pending
    ? ""
    : pending.kind === "Section"
      ? `${observation} · ${ROW_WORDS[pending.row]} · ${COL_WORDS[pending.col]}`
      : `${observation} · ${pending.patch.label}`;

  const save = async (title: string, shared: boolean) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await savePin({
        crop,
        warehouse: greenhouse,
        kind: pending.kind,
        title,
        observation,
        obs_kind: kind,
        shared,
        source_week: clusters?.week ?? week ?? null,
        ...(pending.kind === "Section"
          ? { section_row: pending.row, section_col: pending.col }
          : { stations: pending.patch.stations }),
      });
      setPending(null);
      reloadPins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the pin");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      await deletePin(name);
      reloadPins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the pin");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SectionGrid sections={sections} onPinSection={(row, col) => setPending({ kind: "Section", row, col })} />
      <PatchesList data={clusters} onPinPatch={(patch) => setPending({ kind: "Patch", patch })} />
      {pending ? (
        <PinForm key={defaultTitle} defaultTitle={defaultTitle} busy={busy} onSave={save} onCancel={() => setPending(null)} />
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-[var(--sd-data-red)]">
          {error}
        </span>
      ) : null}
      <div className="flex flex-col gap-1 border-t pt-2">
        <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">Pins</span>
        <PinsPanel pins={pins} onDelete={remove} />
      </div>
    </div>
  );
}
```

In `frontend/src/pages/dashboard/SectionGrid.tsx` (3b has changed this file: keep its ring, `data-hot` and legend):

(a) The signature becomes:

```tsx
export function SectionGrid({
  sections,
  onPinSection,
}: {
  sections: SectionCell[];
  /** When given, each cell carries a "Pin" button for this section (spread spec C6). */
  onPinSection?: (row: number, col: number) => void;
}) {
```

(b) In the cell `<div data-testid={`section-${r}-${c}`} …>`, replace the body `{scouted ? `${pct}%` : "not scouted"}` with:

```tsx
                  <span>{scouted ? `${pct}%` : "not scouted"}</span>
                  {onPinSection ? (
                    <button
                      type="button"
                      onClick={() => onPinSection(r, c)}
                      aria-label={`Pin ${label} · ${COLS[c]}`}
                      className="mt-0.5 block w-full text-[0.55rem] text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Pin
                    </button>
                  ) : null}
```

(`label` is the row label from `ROWS.map((label, r) => …)`. The existing `toHaveTextContent("33.3%")` / `"not scouted"` assertions still match.)

In `frontend/src/pages/dashboard/GreenhouseModal.tsx`:
- Add `import { HouseSpread } from "./HouseSpread";` beside the `SectionGrid` import. Drop the `SectionGrid` import if nothing else uses it; `noUnusedLocals` is off, so either way compiles.
- Replace `<SectionGrid sections={current.sections} />` with:

```tsx
              <HouseSpread
                crop={crop}
                greenhouse={greenhouse ?? ""}
                kind={current.kind}
                observation={current.name}
                week={current.week}
                sections={current.sections}
              />
```

- [ ] **Step 6: Run to pass, typecheck, build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/spread-api.test.ts src/pages/dashboard/__tests__ && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: all pass (GreenhouseModal.sections and 3b's ring tests included), no type errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add frontend/src/lib/spread-api.ts frontend/src/lib/spread-api.test.ts frontend/src/pages/dashboard/PatchesList.tsx frontend/src/pages/dashboard/PinsPanel.tsx frontend/src/pages/dashboard/PinForm.tsx frontend/src/pages/dashboard/HouseSpread.tsx frontend/src/pages/dashboard/SectionGrid.tsx frontend/src/pages/dashboard/GreenhouseModal.tsx frontend/src/pages/dashboard/__tests__/GreenhouseModal.spread.test.tsx frontend/src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx
```

If `yarn build` changed tracked build output (check `git status --short` for `upande_scp/public/…` paths), add those exact paths too, and nothing else. Then:

```bash
git commit -m "feat(scp-ui): patches and pins on the greenhouse modal"
```

---

### Task 7: Patch outlines and area drawing on the rose heatmap and the avocado tree map

**Files:**
- Create: `frontend/src/lib/hull.ts`, `frontend/src/lib/hull.test.ts`
- Modify: `frontend/src/pages/maps/bed-projection.ts` (`ProjectedGeometry`; the `return` of `projectGeometry`)
- Modify: `frontend/src/pages/maps/BedSvg.tsx`
- Create: `frontend/src/pages/maps/use-draw-area.ts`, `frontend/src/pages/maps/use-house-overlays.ts`, `frontend/src/pages/maps/DrawAreaBar.tsx`
- Create: `frontend/src/pages/avocado/patch-features.ts`
- Modify: `frontend/src/pages/Heatmaps.tsx` (imports; hooks after `isLoadingDetail`; the slice's `<BedSvg …>`, ~lines 800–806)
- Modify: `frontend/src/pages/avocado/tree-map-types.ts`, `AvocadoObservations.tsx`, `AvocadoTreeMap.tsx` (`onMapReady` ~447; the legend strip)
- Test: `frontend/src/pages/maps/__tests__/BedSvg.overlays.test.tsx`, `frontend/src/pages/maps/__tests__/bed-projection.unproject.test.ts`, `frontend/src/pages/avocado/__tests__/patch-features.test.ts` (new)

**Interfaces:**
- Consumes: Task 6 `spread-api` (`getHouseClusters`, `listPins(…, false)`, `savePin`, `patchLine`), `PinForm`.
- Produces:
  - `Pt`, `convexHull(points)`, `outlinePath(hull)`, `closedRing(hull)`.
  - `ProjectedGeometry.unproject?(x, y) -> [lng, lat]`.
  - `BedSvg` props: `overlays?: BedOverlay[]`, `draft?: Pt[] | null`, `onCanvasClick?(pt)`, `onCanvasDoubleClick?()`. Also `BedOverlay { id, zones?, points?, tone: "patch" | "pin", label? }`.
  - `useDrawArea(onFinish) -> { active, vertices, start, add, finish, cancel }` and `closeVertices(v, eps?)`.
  - `useHouseOverlays({crop, warehouse, observation, kind, week, withSeries}) -> { clusters, pins, reloadPins }` and `bedOverlays(clusters, pins)`.
  - `<DrawAreaBar draw pending busy disabled defaultTitle onSave onDiscard />`.
  - `patchFeatures`, `areaPinFeatures`, `draftFeatures`.
  - `AvocadoView.patchObservation?`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/hull.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { closedRing, convexHull, outlinePath } from "./hull";

describe("convexHull", () => {
  it("keeps the outer corners", () => {
    expect(convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]])).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
  });
  it("collapses a straight bed to its two ends and drops repeats", () => {
    expect(convexHull([[0, 0], [1, 1], [2, 2]])).toEqual([[0, 0], [2, 2]]);
    expect(convexHull([[1, 1], [1, 1]])).toEqual([[1, 1]]);
  });
  it("writes a closed SVG path and a closed ring", () => {
    expect(outlinePath([[0, 0], [2, 0], [1, 1.234]])).toBe("M0 0 L2 0 L1 1.23 Z");
    expect(outlinePath([])).toBe("");
    expect(closedRing([[0, 0], [1, 0]])).toEqual([[0, 0], [1, 0], [0, 0]]);
  });
});
```

Create `frontend/src/pages/maps/__tests__/bed-projection.unproject.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectGeometry, type ZoneGeoLike } from "../bed-projection";

const zones: ZoneGeoLike[] = [
  { name: "Z1", coords: [[35.7542, 0.0679], [35.75417, 0.06792]], lineId: 1 },
  { name: "Z2", coords: [[35.75417, 0.06792], [35.75414, 0.06794]], lineId: 1 },
  { name: "Z3", coords: [[35.7543, 0.06795], [35.75427, 0.06797]], lineId: 2 },
];

describe("projectGeometry.unproject", () => {
  it("unprojects every zone centroid back to its lng/lat", () => {
    const g = projectGeometry(zones)!;
    for (const z of zones) {
      const c = g.zoneCentroids[z.name];
      const [lng, lat] = g.unproject!(c.cx, c.cy);
      expect(lng).toBeCloseTo((z.coords![0][0] + z.coords![1][0]) / 2, 9);
      expect(lat).toBeCloseTo((z.coords![0][1] + z.coords![1][1]) / 2, 9);
    }
  });
});
```

Create `frontend/src/pages/maps/__tests__/BedSvg.overlays.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BedSvg } from "../BedSvg";
import { closeVertices, useDrawArea } from "../use-draw-area";
import type { ProjectedGeometry } from "../bed-projection";
import type { Pt } from "@/lib/hull";

const geometry: ProjectedGeometry = {
  viewBox: "0 0 100 100",
  width: 100,
  height: 100,
  beds: [],
  zoneCentroids: { Z1: { cx: 10, cy: 10 }, Z2: { cx: 30, cy: 10 }, Z3: { cx: 20, cy: 30 }, Z4: { cx: 20, cy: 15 } },
};

function Harness({ onFinish }: { onFinish: (ring: Pt[]) => void }) {
  const draw = useDrawArea(onFinish);
  return (
    <>
      <button type="button" onClick={draw.start}>
        Draw area
      </button>
      <BedSvg
        geometry={geometry}
        markers={[]}
        draft={draw.active ? draw.vertices : null}
        onCanvasClick={draw.active ? draw.add : undefined}
        onCanvasDoubleClick={draw.active ? draw.finish : undefined}
      />
      <span data-testid="active">{draw.active ? "yes" : "no"}</span>
    </>
  );
}

describe("BedSvg overlays", () => {
  it("outlines a patch as the hull of its zones, stroke only", () => {
    render(
      <BedSvg
        geometry={geometry}
        markers={[]}
        overlays={[
          { id: "patch-P1", zones: ["Z1", "Z2", "Z3", "Z4"], tone: "patch", label: "4 zones" },
          { id: "pin-A", points: [[50, 50], [60, 50], [55, 60]], tone: "pin", label: "my area" },
          { id: "patch-none", zones: ["missing"], tone: "patch" },
        ]}
      />,
    );
    const patch = screen.getByTestId("overlay-patch-P1");
    expect(patch.getAttribute("d")).toBe("M10 10 L30 10 L20 30 Z");        // Z4 lies inside the hull
    expect(patch.getAttribute("fill")).toBe("none");
    expect(screen.getByTestId("overlay-pin-A").getAttribute("stroke-dasharray")).toBeTruthy();
    expect(screen.queryByTestId("overlay-patch-none")).toBeNull();
  });

  it("draws the draft and reports clicks in SVG space", () => {
    const onClick = vi.fn();
    const onDbl = vi.fn();
    render(<BedSvg geometry={geometry} markers={[]} draft={[[1, 2], [3, 4]]} onCanvasClick={onClick} onCanvasDoubleClick={onDbl} />);
    expect(screen.getByTestId("draw-draft")).toHaveAttribute("data-vertices", "2");
    const svg = document.querySelector("svg")!;
    fireEvent.click(svg, { clientX: 12, clientY: 34 });
    expect(onClick).toHaveBeenCalledWith([12, 34]);
    fireEvent.doubleClick(svg);
    expect(onDbl).toHaveBeenCalledTimes(1);
  });
});

describe("drawing an area", () => {
  it("adds a corner per click and closes on double-click", () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} />);
    fireEvent.click(screen.getByText("Draw area"));
    const svg = document.querySelector("svg")!;
    for (const [x, y] of [[0, 0], [10, 0], [10, 10]]) fireEvent.click(svg, { clientX: x, clientY: y });
    expect(screen.getByTestId("draw-draft")).toHaveAttribute("data-vertices", "3");
    fireEvent.click(svg, { clientX: 10, clientY: 10 });                   // the double-click's own click
    fireEvent.doubleClick(svg, { clientX: 10, clientY: 10 });
    expect(onFinish).toHaveBeenCalledWith([[0, 0], [10, 0], [10, 10]]);
    expect(screen.getByTestId("active")).toHaveTextContent("no");
  });

  it("keeps drawing below three corners, and Esc cancels", () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} />);
    fireEvent.click(screen.getByText("Draw area"));
    const svg = document.querySelector("svg")!;
    fireEvent.click(svg, { clientX: 0, clientY: 0 });
    fireEvent.click(svg, { clientX: 5, clientY: 0 });
    fireEvent.doubleClick(svg);
    expect(onFinish).not.toHaveBeenCalled();
    expect(screen.getByTestId("active")).toHaveTextContent("yes");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("active")).toHaveTextContent("no");
    expect(screen.queryByTestId("draw-draft")).toBeNull();
  });

  it("closeVertices drops repeats and a closing corner", () => {
    expect(closeVertices([[0, 0], [1, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});
```

Create `frontend/src/pages/avocado/__tests__/patch-features.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { areaPinFeatures, draftFeatures, patchFeatures } from "../patch-features";
import type { Patch, ScoutingPin } from "@/lib/spread-api";

const coords = new Map<string, [number, number]>([["T1", [0, 0]], ["T2", [1, 0]], ["T3", [0, 1]]]);
const patch: Patch = {
  id: "P1", stations: ["T1", "T2", "T3"], size: 3, centroid: [0, 0], rows: [0, 1], cols: [0, 1],
  label: "rows 1–2, trees 1–2", change: "New", prev_size: null,
};
const base = { crop: "Avocado", warehouse: "B", shared: 1 as const, notify: 1 as const, owner: "a", may_edit: true };

describe("avocado patch features", () => {
  it("outlines a patch as a closed hull line and skips one with no placed trees", () => {
    const fc = patchFeatures(
      { week: "2031-W31", prev_week: null, unit: "row", gone: [], clusters: [patch, { ...patch, id: "P2", stations: ["T9"] }] },
      coords,
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: "LineString", coordinates: [[0, 0], [1, 0], [0, 1], [0, 0]] });
    expect(fc.features[0].properties.change).toBe("New");
  });

  it("draws area pins by their polygon and patch pins by their trees, never section pins", () => {
    const pins: ScoutingPin[] = [
      { ...base, name: "A", title: "drawn", kind: "Area", stations: ["T1"],
        polygon: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] } },
      { ...base, name: "P", title: "frozen", kind: "Patch", stations: ["T1", "T2", "T3"], polygon: null },
      { ...base, name: "S", title: "section", kind: "Section", stations: ["T1", "T2", "T3"], polygon: null },
    ];
    const fc = areaPinFeatures(pins, coords);
    expect(fc.features.map((f) => f.properties.name)).toEqual(["A", "P"]);
    expect(fc.features[0].geometry.coordinates).toEqual([[0, 0], [2, 0], [2, 2], [0, 0]]);
  });

  it("the draft is a line from two corners and a faint polygon from three", () => {
    expect(draftFeatures([[0, 0]]).features).toHaveLength(0);
    expect(draftFeatures([[0, 0], [1, 1]]).features.map((f) => f.geometry.type)).toEqual(["LineString"]);
    expect(draftFeatures([[0, 0], [1, 0], [1, 1]]).features.map((f) => f.geometry.type)).toEqual(["LineString", "Polygon"]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/hull.test.ts src/pages/maps/__tests__ src/pages/avocado/__tests__/patch-features.test.ts`
Expected: FAIL with `Failed to resolve import "./hull"`, `"../use-draw-area"`, `"../patch-features"`. The unproject test fails with `g.unproject is not a function`.

- [ ] **Step 3: `lib/hull.ts` and the inverse projection**

Create `frontend/src/lib/hull.ts`:

```ts
/** Convex hulls for patch and pin outlines (spread spec §6): the same code
 *  draws in SVG space (BedSvg) and in lng/lat (the avocado map). */
export type Pt = [number, number];

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Monotone chain. Repeats dropped; collinear points collapse to the two ends
 *  (a patch along one bed outlines as a line). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p] as const)).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (pts.length <= 2) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** "M x y L x y … Z" (2 dp); "" for no points. */
export function outlinePath(hull: Pt[]): string {
  if (!hull.length) return "";
  return `${hull.map((p, i) => `${i ? "L" : "M"}${fmt(p[0])} ${fmt(p[1])}`).join(" ")} Z`;
}

/** The hull with its first point repeated at the end (a closed GeoJSON ring). */
export function closedRing(hull: Pt[]): Pt[] {
  return hull.length ? [...hull, hull[0]] : [];
}
```

In `frontend/src/pages/maps/bed-projection.ts`:
- Add to `interface ProjectedGeometry`, after `zoneCentroids`:

```ts
  /** SVG point → [lng, lat]: the exact inverse of the projection, so an area
   *  drawn on the SVG is saved as real coordinates (spread spec C10). */
  unproject?: (x: number, y: number) => [number, number];
```

- In `projectGeometry`'s final `return { … }`, add after `zoneCentroids,`:

```ts
    unproject: (sx: number, sy: number): [number, number] => {
      const x = minX + (sx - LABEL_MARGIN) / scale;
      const y = maxY - (sy - PAD) / scale;
      const x0 = x * cosR + y * sinR;
      const y0 = -x * sinR + y * cosR;
      return [(x0 + cxRaw) / latScale, y0 + cyRaw];
    },
```

- [ ] **Step 4: `BedSvg` overlays and the draw hook**

In `frontend/src/pages/maps/BedSvg.tsx`:

(a) Add to the imports:

```tsx
import type { MouseEvent as ReactMouseEvent } from "react";
import { convexHull, outlinePath, type Pt } from "@/lib/hull";
```

(b) Add after `interface BedMarker`:

```tsx
/** A patch or pin outline: the hull of its zones' centroids, or explicit
 *  points in SVG space. Stroke only — never a fill over the markers. */
export interface BedOverlay {
  id: string;
  zones?: string[];
  points?: Pt[];
  tone: "patch" | "pin";
  label?: string;
}

const OVERLAY_COLOR: Record<BedOverlay["tone"], string> = {
  patch: "var(--sd-data-red)",
  pin: "var(--sd-data-purple)",
};

function overlayPoints(o: BedOverlay, centroids: ProjectedGeometry["zoneCentroids"]): Pt[] {
  if (o.points) return o.points;
  const out: Pt[] = [];
  for (const z of o.zones ?? []) {
    const c = centroids[z];
    if (c) out.push([c.cx, c.cy]);
  }
  return out;
}

/** Client → SVG user space; the raw client point where the browser (or jsdom)
 *  has no screen CTM. */
function svgPoint(e: ReactMouseEvent<SVGSVGElement>): Pt {
  const svg = e.currentTarget;
  const ctm = typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
  if (ctm && typeof svg.createSVGPoint === "function") {
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(ctm.inverse());
    return [q.x, q.y];
  }
  return [e.clientX, e.clientY];
}
```

(c) `BedSvgProps` gains:

```tsx
  /** Patch / pin outlines drawn over the markers (spread spec C5). */
  overlays?: BedOverlay[];
  /** The area being drawn, in SVG space; null/undefined when not drawing. */
  draft?: Pt[] | null;
  onCanvasClick?: (pt: Pt) => void;
  onCanvasDoubleClick?: () => void;
```

(d) Destructure `overlays, draft, onCanvasClick, onCanvasDoubleClick` in `BedSvg(...)`. The `<svg …>` opening tag gains:

```tsx
      onClick={onCanvasClick ? (e) => onCanvasClick(svgPoint(e)) : undefined}
      onDoubleClick={onCanvasDoubleClick ? () => onCanvasDoubleClick() : undefined}
      style={draft ? { cursor: "crosshair" } : undefined}
```

(e) After the marker layer `</g>` (before `</svg>`), add:

```tsx
      {/* Patch and pin outlines (spread spec C5): stroke only, on top. */}
      {overlays?.length ? (
        <g data-testid="bed-overlays" fill="none">
          {overlays.map((o) => {
            const hull = convexHull(overlayPoints(o, geometry.zoneCentroids));
            if (!hull.length) return null;
            const common = {
              stroke: OVERLAY_COLOR[o.tone],
              strokeWidth: o.tone === "pin" ? 0.9 : 1.2,
              strokeDasharray: o.tone === "pin" ? "2.5 1.5" : undefined,
              strokeLinejoin: "round" as const,
              strokeLinecap: "round" as const,
              fill: "none",
            };
            return hull.length === 1 ? (
              <circle key={o.id} data-testid={`overlay-${o.id}`} cx={hull[0][0]} cy={hull[0][1]} r={markerSize} {...common}>
                <title>{o.label}</title>
              </circle>
            ) : (
              <path key={o.id} data-testid={`overlay-${o.id}`} d={outlinePath(hull)} {...common}>
                <title>{o.label}</title>
              </path>
            );
          })}
        </g>
      ) : null}

      {/* The area being drawn (C10). */}
      {draft && draft.length ? (
        <g data-testid="draw-draft" data-vertices={draft.length} fill="none">
          <polyline
            points={draft.map((p) => `${p[0]},${p[1]}`).join(" ")}
            stroke="var(--sd-data-purple)"
            strokeWidth={0.9}
            strokeDasharray="2 1.5"
          />
          {draft.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={1.2} stroke="var(--sd-data-purple)" strokeWidth={0.6} />
          ))}
        </g>
      ) : null}
```

Create `frontend/src/pages/maps/use-draw-area.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { Pt } from "@/lib/hull";

/** Drop consecutive repeats (a double-click's own clicks land on the last
 *  corner) and a last corner that closes back onto the first. */
export function closeVertices(v: Pt[], eps = 1e-9): Pt[] {
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
  const out: Pt[] = [];
  for (const p of v) {
    if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  }
  if (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  return out;
}

export interface DrawArea {
  active: boolean;
  vertices: Pt[];
  start: () => void;
  add: (p: Pt) => void;
  finish: () => void;
  cancel: () => void;
}

/** C10: click adds a corner, double-click (or Finish) closes, Esc cancels. No
 *  draw library. ``finish`` with fewer than three distinct corners keeps
 *  drawing. Works in any plane (SVG units or lng/lat). */
export function useDrawArea(onFinish: (ring: Pt[]) => void): DrawArea {
  const [active, setActive] = useState(false);
  const [vertices, setVertices] = useState<Pt[]>([]);
  const verticesRef = useRef<Pt[]>([]);
  const activeRef = useRef(false);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const setBoth = useCallback((v: Pt[]) => {
    verticesRef.current = v;
    setVertices(v);
  }, []);
  const cancel = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setBoth([]);
  }, [setBoth]);
  const start = useCallback(() => {
    activeRef.current = true;
    setActive(true);
    setBoth([]);
  }, [setBoth]);
  const add = useCallback(
    (p: Pt) => {
      if (activeRef.current) setBoth([...verticesRef.current, p]);
    },
    [setBoth],
  );
  const finish = useCallback(() => {
    if (!activeRef.current) return;
    const ring = closeVertices(verticesRef.current);
    if (ring.length < 3) return;
    cancel();
    finishRef.current(ring);
  }, [cancel]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, cancel]);

  return { active, vertices, start, add, finish, cancel };
}
```

Create `frontend/src/pages/maps/use-house-overlays.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { getHouseClusters, listPins, patchLine, type HouseClusters, type ScoutingPin } from "@/lib/spread-api";
import type { BedOverlay } from "./BedSvg";

/** One house's patches (one observation, one week) and its pins, for a map. */
export function useHouseOverlays(args: {
  crop: string;
  warehouse: string | null;
  observation: string | null;
  kind: "pest" | "disease";
  week?: string | null;
  withSeries?: boolean;
}) {
  const { crop, warehouse, observation, kind, week, withSeries = false } = args;
  const [clusters, setClusters] = useState<HouseClusters | null>(null);
  const [pins, setPins] = useState<ScoutingPin[]>([]);

  useEffect(() => {
    if (!warehouse || !observation) {
      setClusters(null);
      return;
    }
    let live = true;
    getHouseClusters({ crop, warehouse, observation, kind, week })
      .then((r) => live && setClusters(r))
      .catch(() => live && setClusters(null));
    return () => {
      live = false;
    };
  }, [crop, warehouse, observation, kind, week]);

  const reloadPins = useCallback(() => {
    if (!warehouse) {
      setPins([]);
      return;
    }
    listPins(crop, warehouse, withSeries)
      .then(setPins)
      .catch(() => setPins([]));
  }, [crop, warehouse, withSeries]);
  useEffect(() => reloadPins(), [reloadPins]);

  return { clusters, pins, reloadPins };
}

/** Patches (red, solid) and Patch / Area pins (purple, dashed) as BedSvg
 *  overlays. Section pins live on the 3 × 3 grid, not the map. */
export function bedOverlays(clusters: HouseClusters | null, pins: ScoutingPin[]): BedOverlay[] {
  const out: BedOverlay[] = (clusters?.clusters ?? []).map((p) => ({
    id: `patch-${p.id}`,
    zones: p.stations,
    tone: "patch",
    label: `${patchLine(p, clusters?.unit ?? "bed")} · ${p.change}`,
  }));
  for (const pin of pins) {
    if (pin.kind !== "Section" && pin.stations.length) {
      out.push({ id: `pin-${pin.name}`, zones: pin.stations, tone: "pin", label: pin.title });
    }
  }
  return out;
}
```

Create `frontend/src/pages/maps/DrawAreaBar.tsx`:

```tsx
import type { Pt } from "@/lib/hull";
import { PinForm } from "@/pages/dashboard/PinForm";
import type { DrawArea } from "./use-draw-area";

/** "Draw area" → corners with Finish / Cancel → the pin form for the drawn area. */
export function DrawAreaBar({
  draw,
  pending,
  busy,
  disabled,
  defaultTitle,
  onSave,
  onDiscard,
}: {
  draw: DrawArea;
  pending: Pt[] | null;
  busy?: boolean;
  disabled?: boolean;
  defaultTitle: string;
  onSave: (title: string, shared: boolean) => void;
  onDiscard: () => void;
}) {
  if (pending) return <PinForm defaultTitle={defaultTitle} busy={busy} onSave={onSave} onCancel={onDiscard} />;
  if (draw.active) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[0.7rem]">
        <span className="text-muted-foreground">Click to add corners · double-click or Finish to close · Esc cancels</span>
        <button
          type="button"
          onClick={draw.finish}
          disabled={draw.vertices.length < 3}
          className="rounded border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
        >
          Finish
        </button>
        <button type="button" onClick={draw.cancel} className="rounded border px-2 py-0.5 hover:bg-muted">
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={draw.start}
      disabled={disabled}
      className="self-start rounded border px-2 py-0.5 text-[0.7rem] hover:bg-muted disabled:opacity-50"
    >
      Draw area
    </button>
  );
}
```

- [ ] **Step 5: The avocado features**

Create `frontend/src/pages/avocado/patch-features.ts`:

```ts
import type { GeoJsonFC } from "@/lib/scouting-api";
import { closedRing, convexHull, type Pt } from "@/lib/hull";
import type { HouseClusters, ScoutingPin } from "@/lib/spread-api";

type Feature = GeoJsonFC["features"][number];

const fc = (features: Feature[]): GeoJsonFC => ({ type: "FeatureCollection", features });

const line = (coordinates: Pt[], properties: Record<string, unknown>): Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "LineString", coordinates },
});

function hullOf(stations: string[], coords: Map<string, Pt>): Pt[] {
  return convexHull(stations.map((s) => coords.get(s)).filter((c): c is Pt => !!c));
}

/** Each patch as a closed hull line over its trees (stroke only, C5). */
export function patchFeatures(clusters: HouseClusters | null, coords: Map<string, Pt>): GeoJsonFC {
  const out: Feature[] = [];
  for (const p of clusters?.clusters ?? []) {
    const hull = hullOf(p.stations, coords);
    if (hull.length >= 2) out.push(line(closedRing(hull), { id: p.id, change: p.change, size: p.size, label: p.label }));
  }
  return fc(out);
}

/** Area pins by the polygon they were drawn as; Patch pins by their trees' hull. */
export function areaPinFeatures(pins: ScoutingPin[], coords: Map<string, Pt>): GeoJsonFC {
  const out: Feature[] = [];
  for (const pin of pins) {
    const ring = pin.polygon?.type === "Polygon" ? ((pin.polygon.coordinates as Pt[][])[0] ?? []) : [];
    if (pin.kind === "Area" && ring.length >= 3) {
      out.push(line(ring, { name: pin.name, title: pin.title }));
    } else if (pin.kind !== "Section") {
      const hull = hullOf(pin.stations, coords);
      if (hull.length >= 2) out.push(line(closedRing(hull), { name: pin.name, title: pin.title }));
    }
  }
  return fc(out);
}

/** The area being drawn: a line from two corners, plus a faint polygon from three. */
export function draftFeatures(vertices: Pt[]): GeoJsonFC {
  if (vertices.length < 2) return fc([]);
  const out: Feature[] = [line(vertices, {})];
  if (vertices.length >= 3) {
    out.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [closedRing(vertices)] } });
  }
  return fc(out);
}
```

- [ ] **Step 6: Run the new tests to pass**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/hull.test.ts src/pages/maps/__tests__ src/pages/avocado/__tests__/patch-features.test.ts`
Expected: all pass.

- [ ] **Step 7: Wire the rose Heatmaps modal**

In `frontend/src/pages/Heatmaps.tsx`:

(a) Imports, after the `./maps/BedSvg` import:

```tsx
import { savePin } from "@/lib/spread-api";
import type { Pt } from "@/lib/hull";
import { useDrawArea } from "./maps/use-draw-area";
import { bedOverlays, useHouseOverlays } from "./maps/use-house-overlays";
import { DrawAreaBar } from "./maps/DrawAreaBar";
```

(b) Directly after `const isLoadingDetail = picked !== null && pickedDetail === null;` (still before the component's `return (`), add:

```tsx
  // Spread (piece 3c): the latest week's patches and this house's patch / area
  // pins, outlined on the "Latest week" panel, and a draw mode for area pins.
  const latestWeek = modalRecent.length ? modalRecent[modalRecent.length - 1].date : null;
  const spread = useHouseOverlays({
    crop,
    warehouse: picked?.greenhouse ?? null,
    observation: picked?.obsName ?? null,
    kind: picked?.obsKind ?? "pest",
    week: latestWeek,
  });
  const overlays = useMemo(() => bedOverlays(spread.clusters, spread.pins), [spread.clusters, spread.pins]);
  const [pendingArea, setPendingArea] = useState<Pt[] | null>(null);
  const [areaBusy, setAreaBusy] = useState(false);
  const [areaError, setAreaError] = useState<string | null>(null);
  const draw = useDrawArea(setPendingArea);
  const cancelDraw = draw.cancel;
  useEffect(() => {
    cancelDraw();
    setPendingArea(null);
    setAreaError(null);
  }, [picked, cancelDraw]);
  const saveArea = async (title: string, shared: boolean) => {
    const geom = picked ? geometryByGh[picked.greenhouse] : null;
    if (!picked || !pendingArea || !geom?.unproject) return;
    const ring = pendingArea.map(([x, y]) => geom.unproject!(x, y));
    setAreaBusy(true);
    setAreaError(null);
    try {
      await savePin({
        crop,
        warehouse: picked.greenhouse,
        kind: "Area",
        title,
        observation: picked.obsName,
        obs_kind: picked.obsKind,
        shared,
        polygon: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
        source_week: latestWeek,
      });
      setPendingArea(null);
      spread.reloadPins();
    } catch (e) {
      setAreaError(e instanceof Error ? e.message : "Could not save the area");
    } finally {
      setAreaBusy(false);
    }
  };
```

(c) In the modal's per-slice block, replace the `<BedSvg geometry={geom} markers={dayMarkers} className="min-h-[420px] [&_svg]:max-h-[520px] [&_svg]:w-full" />` element with:

```tsx
                            <BedSvg
                              geometry={geom}
                              markers={dayMarkers}
                              overlays={fromEnd === 0 ? overlays : undefined}
                              draft={fromEnd === 0 && draw.active ? draw.vertices : null}
                              onCanvasClick={fromEnd === 0 && draw.active ? draw.add : undefined}
                              onCanvasDoubleClick={fromEnd === 0 && draw.active ? draw.finish : undefined}
                              className="min-h-[420px] [&_svg]:max-h-[520px] [&_svg]:w-full"
                            />
                            {fromEnd === 0 ? (
                              <div className="flex flex-col gap-1 text-[0.7rem] text-muted-foreground">
                                <span>
                                  {spread.clusters?.clusters.length ?? 0} patch
                                  {(spread.clusters?.clusters.length ?? 0) === 1 ? "" : "es"} outlined
                                  {spread.clusters?.clusters.length
                                    ? ` · ${spread.clusters.clusters.map((p) => `${p.size} ${p.change.toLowerCase()}`).join(", ")}`
                                    : ""}
                                </span>
                                <DrawAreaBar
                                  draw={draw}
                                  pending={pendingArea}
                                  busy={areaBusy}
                                  disabled={!geom.unproject}
                                  defaultTitle={`${picked.obsName} · area`}
                                  onSave={saveArea}
                                  onDiscard={() => setPendingArea(null)}
                                />
                                {areaError ? (
                                  <span role="alert" className="text-[var(--sd-data-red)]">
                                    {areaError}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
```

`useMemo`, `useEffect` and `useState` are already imported at the top of the file.

- [ ] **Step 8: Wire the avocado tree map**

In `frontend/src/pages/avocado/tree-map-types.ts`, add to `interface AvocadoView`:

```ts
  /** The observation whose patches the map outlines on a picked block
   *  (spread spec C5); null/absent = no patches. */
  patchObservation?: { kind: "pest" | "disease"; name: string } | null;
```

In `frontend/src/pages/avocado/AvocadoObservations.tsx`:
- Add `const [pickedObs, setPickedObs] = useState<string | null>(null);` under the `kind` state.
- The kind toggle's `onClick={() => setKind(k)}` becomes `onClick={() => { setKind(k); setPickedObs(null); }}`.
- Add `patchObservation: pickedObs ? { kind, name: pickedObs } : null,` to the returned view object, and add `pickedObs` to the `useMemo` dependency list.
- The roster row `<div key={o.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">…</div>` becomes a button with the same children:

```tsx
                  <button
                    key={o.name}
                    type="button"
                    aria-pressed={pickedObs === o.name}
                    title="Outline this observation's patches on a block"
                    onClick={() => setPickedObs((p) => (p === o.name ? null : o.name))}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted ${pickedObs === o.name ? "bg-muted font-medium" : ""}`}
                  >
```

(with the closing `</div>` of that row changed to `</button>`).

In `frontend/src/pages/avocado/AvocadoTreeMap.tsx`:

(a) Imports, after `import { SCOUT_PALETTE } from "./derive-scouts";`:

```tsx
import { savePin } from "@/lib/spread-api";
import type { Pt } from "@/lib/hull";
import { useDrawArea } from "../maps/use-draw-area";
import { useHouseOverlays } from "../maps/use-house-overlays";
import { DrawAreaBar } from "../maps/DrawAreaBar";
import { areaPinFeatures, draftFeatures, patchFeatures } from "./patch-features";
```

(b) After the `treeCoords` `useMemo`, add:

```tsx
  // Spread (piece 3c): patches of the view's picked observation on a picked
  // block, its patch / area pins, and drawing an area pin (C5, C10).
  const obs = view.patchObservation ?? null;
  const [block, setBlock] = useState<string | null>(null);
  const spread = useHouseOverlays({
    crop: filters.crop,
    warehouse: obs ? block : null,
    observation: obs?.name ?? null,
    kind: obs?.kind ?? "pest",
    week: null,
  });
  const [pendingArea, setPendingArea] = useState<Pt[] | null>(null);
  const [areaBusy, setAreaBusy] = useState(false);
  const [areaError, setAreaError] = useState<string | null>(null);
  const draw = useDrawArea(setPendingArea);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const cancelDraw = draw.cancel;
  useEffect(() => {
    cancelDraw();
    setPendingArea(null);
  }, [block, obs?.name, obs?.kind, cancelDraw]);
  const blockNames = useMemo(
    () =>
      (blocks?.features ?? [])
        .filter((f) => filters.farm === ALL || f.properties?.farm === filters.farm)
        .map((f) => String(f.properties?.block ?? ""))
        .filter(Boolean)
        .sort(),
    [blocks, filters.farm],
  );
  const saveArea = async (title: string, shared: boolean) => {
    if (!pendingArea || !block || !obs) return;
    setAreaBusy(true);
    setAreaError(null);
    try {
      await savePin({
        crop: filters.crop,
        warehouse: block,
        kind: "Area",
        title,
        observation: obs.name,
        obs_kind: obs.kind,
        shared,
        polygon: { type: "Polygon", coordinates: [[...pendingArea, pendingArea[0]]] },
        source_week: spread.clusters?.week ?? null,
      });
      setPendingArea(null);
      spread.reloadPins();
    } catch (e) {
      setAreaError(e instanceof Error ? e.message : "Could not save the area");
    } finally {
      setAreaBusy(false);
    }
  };
```

(c) After the "Scout movement tracks" layer effect, add:

```tsx
  // Patch outlines (red), patch / area pins (purple, dashed) and the area being
  // drawn. MapLibre paint takes literal colours: these mirror --sd-data-red /
  // --sd-data-purple. Lines only; the draft alone gets a faint fill.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const put = (id: string, data: GeoJsonFC, paint: Record<string, unknown>) => {
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data as never);
        return;
      }
      map.addSource(id, { type: "geojson", data: data as never });
      map.addLayer({ id: `${id}-line`, type: "line", source: id, paint: paint as never });
    };
    put("patches", patchFeatures(spread.clusters, treeCoords), { "line-color": "#C2453A", "line-width": 2.5, "line-opacity": 0.9 });
    put("pin-areas", areaPinFeatures(spread.pins, treeCoords), { "line-color": "#8466C7", "line-width": 2, "line-dasharray": [2, 1.5] });
    put("draw-area", draftFeatures(draw.vertices), { "line-color": "#8466C7", "line-width": 2, "line-dasharray": [1, 1] });
    if (!map.getLayer("draw-area-fill")) {
      map.addLayer({
        id: "draw-area-fill",
        type: "fill",
        source: "draw-area",
        filter: ["==", ["geometry-type"], "Polygon"] as never,
        paint: { "fill-color": "#8466C7", "fill-opacity": 0.08 },
      });
    }
  }, [spread.clusters, spread.pins, treeCoords, draw.vertices, mapReady]);

  // While drawing, a double-click closes the area instead of zooming.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (draw.active) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [draw.active, mapReady]);
```

(d) In `onMapReady`, change the `blocks-fill` click handler's first lines to:

```tsx
    map.on("click", "blocks-fill", (e) => {
      if (drawRef.current.active) return;
      const f = e.features?.[0];
      if (!f) return;
      const name = (f.properties as Record<string, unknown> | null)?.block;
      if (name) setBlock(String(name));
```

(the `fitBounds` part stays) and add, before `map.on("mouseenter", "blocks-fill", …)`:

```tsx
    map.on("click", (e) => {
      const d = drawRef.current;
      if (d.active) d.add([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("dblclick", (e) => {
      const d = drawRef.current;
      if (!d.active) return;
      e.preventDefault();
      d.finish();
    });
```

(e) In the legend strip (`<div className="flex items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b">`), make it wrap (`flex flex-wrap items-center …`) and insert before `<span className="ml-auto tabular-nums">`:

```tsx
        {obs ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Block for patches"
              value={block ?? ""}
              onChange={(e) => setBlock(e.target.value || null)}
              className="rounded border bg-card px-1.5 py-0.5 text-xs"
            >
              <option value="">Pick a block</option>
              {blockNames.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            {block ? (
              <span className="tabular-nums">
                {obs.name}: {spread.clusters?.clusters.length ?? 0} patch
                {(spread.clusters?.clusters.length ?? 0) === 1 ? "" : "es"}
                {spread.clusters?.week ? ` · ${spread.clusters.week}` : ""}
              </span>
            ) : null}
            <DrawAreaBar
              draw={draw}
              pending={pendingArea}
              busy={areaBusy}
              disabled={!block}
              defaultTitle={`${obs.name} · area`}
              onSave={saveArea}
              onDiscard={() => setPendingArea(null)}
            />
            {areaError ? (
              <span role="alert" className="text-[var(--sd-data-red)]">
                {areaError}
              </span>
            ) : null}
          </div>
        ) : null}
```

- [ ] **Step 9: Run everything, typecheck, build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: the whole vitest suite passes, no type errors, and the build succeeds.

- [ ] **Step 10: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add frontend/src/lib/hull.ts frontend/src/lib/hull.test.ts frontend/src/pages/maps/bed-projection.ts frontend/src/pages/maps/BedSvg.tsx frontend/src/pages/maps/use-draw-area.ts frontend/src/pages/maps/use-house-overlays.ts frontend/src/pages/maps/DrawAreaBar.tsx frontend/src/pages/maps/__tests__/BedSvg.overlays.test.tsx frontend/src/pages/maps/__tests__/bed-projection.unproject.test.ts frontend/src/pages/avocado/patch-features.ts frontend/src/pages/avocado/__tests__/patch-features.test.ts frontend/src/pages/avocado/tree-map-types.ts frontend/src/pages/avocado/AvocadoObservations.tsx frontend/src/pages/avocado/AvocadoTreeMap.tsx frontend/src/pages/Heatmaps.tsx
```

Add tracked build output paths only if `yarn build` changed them, as in Task 6. Then:

```bash
git commit -m "feat(scp-ui): patch outlines and area drawing on the rose heatmap and the avocado tree map"
```

---

### Task 8: Final regression and an in-process check on the real data

**Files:** none changed. If a check fails, fix it in the owning task's files and re-run that task's tests.

- [ ] **Step 1: Pure suites**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_clusters_pure.py upande_scp/serverscripts/tests/test_hot_spots_pure.py upande_scp/serverscripts/tests/test_threshold_core_pure.py upande_scp/serverscripts/tests/test_threshold_counts_pure.py upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_trends_prevalence_pure.py`
Expected: all pass.

- [ ] **Step 2: DB suites, one module per DB-RUN**

New: `test_spread`, `test_scouting_pins`.
Regression: `test_hot_spots`, `test_scouting_alerts`, `test_alert_digest`, `test_scouting_alert_creator`, `test_thresholds_measure`, `test_threshold_measure_dashboards`, `test_notifications`, `test_block_weekly_report`, `test_dashboard_aggregates_overview`, `test_dashboard_aggregates_pests_diseases`, `test_dashboard_aggregates_gh_detail`, `test_dashboard_aggregates_traps`, `test_dashboard_aggregates_fcm`, `test_prevalence_rows`, `test_prevalence_overview`, `test_prevalence_pests`, `test_prevalence_trends`, `test_crop_scoped_aggregates`, `test_crop_scoped_aggregate_detail`, `test_crop_scoped_observations`, `test_crop_scoped_spray_plan`, `test_spray_compliance_enforcement`.
Expected: every module OK. Then confirm nothing leaked: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT COUNT(*) FROM \`tabScouting Pin\`; SELECT COUNT(*) FROM \`tabScouting Entry\` WHERE name LIKE '\_TEST-%'; SELECT COUNT(*) FROM \`tabNotification Log\` WHERE document_type = 'Scouting Pin';"` → `0`, `0`, `0`.

- [ ] **Step 3: Frontend**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: all pass, no type errors, and the build succeeds. The built assets are served at once, but the web workers keep the old Python until **the user** restarts them; never restart anything yourself. Against old workers, `get_house_clusters` and the pin endpoints do not exist yet. The modal's `HouseSpread` then catches the errors: no Patches, "No pins on this house yet", and a save shows its error line.

- [ ] **Step 4: In-process check on the real data, rolled back**

Run (one command; pins are written only inside the transaction, and notifications and email are patched out):

```bash
cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python - <<'PY'
import json, time, frappe
from unittest.mock import patch
frappe.init(site="kaitet.local"); frappe.connect(); frappe.set_user("Administrator")
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.scouting import pins as PN
from upande_scp.serverscripts.scouting import spread as S
frappe.db.sql("SET SQL_BIG_SELECTS=1")
BUSIEST = """
    SELECT COALESCE(NULLIF(se.block, ''), se.greenhouse) wh, YEARWEEK(se.date_of_capture, 3) yw, c.pest,
           COUNT(DISTINCT CASE WHEN COALESCE(se.block, '') <> '' THEN se.tree ELSE se.zone END) n
    FROM `tabScouting Entry` se JOIN `tabPests Scouting Entry` c ON c.parent = se.name
    WHERE se.crop_scouted = %(crop)s AND (COALESCE(c.`count`, 0) > 0 OR COALESCE(c.stage, '') <> '')
      AND COALESCE(CASE WHEN COALESCE(se.block, '') <> '' THEN se.tree ELSE se.zone END, '') <> ''
    GROUP BY wh, yw, c.pest ORDER BY n DESC LIMIT 1"""
try:
    for crop in ("Rose", "Avocado"):
        hit = frappe.db.sql(BUSIEST, {"crop": crop})
        if not hit:
            print(crop, "no infested stations on file"); continue
        wh, yw, pest, n = hit[0]
        week = P.yearweek_label(yw)
        t = time.time(); ranks = R._load_ranks([wh])[wh]; t_r = time.time() - t
        t = time.time(); out = S.house_clusters(crop, wh, pest, "pest", None, week); t_c = time.time() - t
        print(crop, wh, pest, week, "infested", n, "stations", len(ranks), "ranks %.2fs clusters %.2fs" % (t_r, t_c))
        print("  prev", out["prev_week"], [(c["size"], c["change"], c["label"]) for c in out["clusters"]], "gone", len(out["gone"]))
        t = time.time(); cents = PN.station_centroids(wh); print("  centroids", len(cents), "%.2fs" % (time.time() - t))
        with patch.object(PN.notifications, "notify", return_value=["x"]) as told, patch.object(frappe, "sendmail") as mail:
            PN.save_pin(crop, wh, "Section", "check section", observation=pest, obs_kind="Pest", section_row=1, section_col=1)
            if out["clusters"]:
                pat = PN.save_pin(crop, wh, "Patch", "check patch", observation=pest, obs_kind="Pest",
                                  stations=json.dumps(out["clusters"][0]["stations"]), source_week=week)
                print("  patch pin stations", len(pat["stations"]))
            name, (lng, lat) = sorted(cents.items())[0]
            d = 1e-7
            ring = [[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]
            area = PN.save_pin(crop, wh, "Area", "check area", polygon=json.dumps({"type": "Polygon", "coordinates": [ring]}))
            print("  area pin resolves its station:", area["stations"] == [name])
            t = time.time(); listed = PN.list_pins(crop, wh)
            print("  list_pins %.2fs" % (time.time() - t), [(p["kind"], len(p["series"]), [s["value"] for s in p["series"]][-3:]) for p in listed])
            t = time.time(); print("  check_pins", PN.check_pins(), "%.2fs" % (time.time() - t), "notices", told.call_count)
            assert not mail.called
finally:
    frappe.db.rollback()
print("pins left:", frappe.db.count("Scouting Pin"))
PY
```

Expected:
- `house_clusters` finishes in a second or two, `_load_ranks` in well under a second.
- The patch list has at most 5 entries, each ≥ 3 stations, with labels in beds/zones (rose) or rows/trees (avocado).
- `area pin resolves its station: True`.
- `list_pins` gives every pin a series of ≤ 8 weeks.
- `check_pins` returns without error; the notice count can be 0 (it depends on real rises).
- `pins left: 0`.

Report the timings, the patch sizes and changes, and how long `station_centroids` took. Zone has no index on `greenhouse`, so that read is a full scan, paid once per area save.

- [ ] **Step 5: Hand-off notes**

Report to the user, with the Step 4 numbers:
- Patches show for any observation with infested stations; they need no bands. Pins notify only their owner, at most weekly, and never by email.
- `station_centroids` timing. If it is several seconds, an index on `tabZone.greenhouse` would help. That is a schema decision for the user and is not part of this plan.
- The backend (endpoints, the hourly pin check, the digest note) goes live only after the user restarts the web and worker processes. Nothing was restarted here. The Scouting Pin table already exists (from `reload_doc`).

- [ ] **Step 6: Confirm the tree is clean of this work**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short && git log --oneline -10`
Expected: only the unrelated store/batch-transfer files remain modified or untracked (plus any of 3b's still-uncommitted work, untouched), and the seven commits from Tasks 1–7.

---

## Ambiguities resolved

1. **Rank-space distance (C3 "within 2 ranks")** is Chebyshev: the larger of |Δbed rank| and |Δzone rank|. It is the same metric as C1's 8-neighbour rule.
2. **Matching order (C3).** A current patch takes the previous patch it shares the most stations with (ties: nearer centroid, then the earlier one). Only when nothing overlaps does a centroid within 2 count, and that match is **Moved**, which beats Grew/Shrank. Several current patches may take one previous patch, so a split shows both halves Shrank (or Stable) and nothing Gone.
3. **Grew / Shrank thresholds** are measured against the previous patch's size, and both conditions must hold: ≥ 25 % **and** ≥ 3 stations.
4. **The previous week is uncapped for matching.** The top-5 cut (C2) applies to what is shown, not to what a patch can match. So a patch that was 6th last week is not "New". Gone lists at most the 5 largest unmatched.
5. **Labels use 1-based rank positions** ("beds 1–3" = the 1st–3rd bed in bed order). These equal the bed / zone numbers on kaitet, where beds are 1…N with no gaps. A single bed or zone reads singular ("bed 5, zone 3").
6. **Stages.** Patches count every stage by default (C1's live figure); `stage` narrows. The digest note always uses every stage, even when the hot spot was raised on one stage's band.
7. **Point-in-polygon is always the pure ray-caster** in `clusters.py`. shapely is installed here but optional elsewhere, so every site gives the same answer.
8. **A station's centroid** is the mean of all its geometry's vertices, matching `zone-utils.geometryCentroid`: a zone's bed-line points, or a tree's point. Zones without geojson (51 on kaitet) cannot be caught by an area.
9. **Pin stations.** Section pins resolve live from the current 3 × 3 grid, so they follow zone changes. Patch and Area pins freeze at save. Patch stations are filtered to the house, and an Area that holds no station is refused.
10. **A pin with a blank observation** watches every pest and every disease of the crop (D4 still applies). A pin that names one must say Pest or Disease, and its stage is kept only then.
11. **The series** is the house's last 8 scouted weeks within 16 weeks of today (EAT). A week the house was scouted but the pin's stations were not reads "too few scouted"; it is not left out.
12. **The pin check** uses the alerts' window (latest scouted week in the last 14 days vs the previous scouted week). `last_notified_week` is written only when a notice was actually delivered. Pins owned by Administrator or a disabled user are never notified (`notify` drops them).
13. **Visibility** reuses `thresholds_check._assert_can_see` (crop scope + the house's farm). A GM may edit or delete any pin of a house they can see, private ones included (C9 grants edit/delete by role). Desk permissions give other SCP roles `if_owner` only, and the controller enforces C9 on every save/delete path.
14. **`get_house_clusters` without a week** uses the latest scouted week in the last 14 days, and its cache key carries today's EAT date. Tests pass `force=1`.
15. **The ranks cache** is a sibling key family, `scp:station_ranks_v1:<house>`, dropped by the same `invalidate_station_grid_for_doc` as the grid.
16. **Maps.**
    - The rose Heatmaps modal outlines patches and Patch/Area pins only on its "Latest week" panel. Area pins are drawn there as the hull of their resolved zones, while the avocado map draws their polygon.
    - A rose area is drawn in SVG space and saved as lng/lat through the projection's exact inverse (`unproject`).
    - On avocado, patches need a block and an observation. The Observations view's roster rows become selectable, and the map strip gets a block picker, as does clicking a block when boundaries are shown. The Scouting and Traps views are unchanged.
    - Section pins are never drawn on maps; they live on the grid.
17. **Drawing.** Finishing with fewer than three distinct corners keeps drawing. A double-click's own clicks are de-duplicated. While drawing on maplibre, double-click zoom is off and block clicks do not fly.
18. **Delete is a hard delete.** Editing a pin's shape is out of scope (spec): delete it and redraw.
