# Mutara Hexa → Triad at 5 m — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mutara's 24 pivot blocks become Hexa → Triad at a 5 m standard triangle, scouts' GPS points land on a triangle, and every mutara map/summary/trap/trend reads triangles.

**Architecture:** Port the kaitet core + SCP Hexa work, add a site setting `triad_side_m` enforced at import, regenerate the pivot grid with a dry-run/apply bench script (shapely + pyproj, UTM), map GPS → Triad by point-in-polygon, and re-encode the field-geometry payload per triangle (hexa centre + per-slot template, edge triangles explicit).

**Tech Stack:** Frappe/ERPNext v16 (py3), shapely 2.1, pyproj, React + Vite + vitest, MapLibre.

**Spec:** `docs/superpowers/specs/2026-11-24-mutara-hexa-triad-design.md` (parent: kaitet `frappe15/apps/upande_scp/docs/superpowers/specs/2026-11-24-hexa-triad-and-farm-structure-design.md`).

## Global Constraints

- Bench `/home/ubuntu/stive/code/frappe16-mutara`, site **mutara.local only**. Never touch kaitet.local data, other sites, MariaDB, supervisor; **never restart** web/workers (`bench migrate` on mutara.local is allowed).
- Never `bench get-app`. Never push. Commits on branches only; **no `Co-Authored-By` trailer**.
- Repos/branches: `apps/upande_core` → new branch `feat/hexa-triad` from `main`; `apps/upande_scp` → new branch `feat/hexa-triad` from `mutara`. Kaitet SCP is fetchable as remote `kaitet` (branch `kaitet`); kaitet core at `/home/ubuntu/stive/code/frappe15/apps/upande_core` branch `feat/hexa-triad`.
- Names: Hexa = `Bed` with `unit_type="Hexa"`, name `"{block} - Hexa {n}"`; Triad name `"{block} - Hexa {n} - Triad {t}"`, `t ∈ 1..6`.
- Triangle slot `t` (k = t−1) = ring `[centre, V(30°+60°k), V(30°+60°(k+1)), centre]`, pointy-top hexagon, circumradius = side, angles CCW from east (1 = top-right). Ring always starts at the hexa centre for full triangles.
- Standard side: setting `triad_side_m` (Float, default **5**) on *Scouting and Crop Protection Settings*; full triangles must match within **2 %**.
- Hexa numbering per block: hexa rows north → south, within a row west → east; only hexas that keep ≥ 1 triangle get a number (1..N, no gaps).
- Edge pieces: clipped to the outline; keep pieces with area ≥ **0.5 m²**; a MultiPolygon piece keeps its largest part. Σ kept triangle area within **1 %** of outline area.
- Unit key everywhere = the Triad name. `Scouting Entry.row` holds the Hexa, `Scouting Entry.triad` (Link → Triad) the Triad.
- Run server tests: `cd /home/ubuntu/stive/code/frappe16-mutara && bench --site mutara.local run-tests --app <app> --module <dotted.module>`. Frontend: `cd apps/upande_scp/frontend && npx vitest run <path>`.

## Review Focus

1. A GPS point on a shared triangle edge, or just outside the block within accuracy → one triangle chosen deterministically (containing, else nearest centroid within the buffer); beyond the buffer → "To be mapped". (Task 5 tests.)
2. Running `--apply` twice on a block → second run is a no-op, no duplicates. (Task 4 test.)
3. A 3 m mapping-tool layout imported on a 5 m site → refused, message names measured and standard side. (Task 3 test.)
4. An edge piece that clips into a MultiPolygon → largest part kept, area check still passes. (Task 4 test.)
5. A farm mixing hexa blocks with row/tree blocks (P3 rows, avocado) → map draws triangles only for hexa blocks, others unchanged; trends count triads for hexa blocks and trees for tree blocks. (Tasks 6, 7 tests.)

---

### Task 1: Port the core Hexa rules

**Files:** `apps/upande_core` — cherry-pick kaitet core `a59d2c7` (and `44b41ff` only if it applies cleanly; skip otherwise and note it).

- [ ] **Step 1:** `git checkout -b feat/hexa-triad main`; `git fetch /home/ubuntu/stive/code/frappe15/apps/upande_core feat/hexa-triad`; cherry-pick `a59d2c7` (resolve in favour of mutara's code + the Hexa rules).
- [ ] **Step 2:** `bench --site mutara.local migrate`. Expected: Bed.unit_type options `Bed\nRow\nHexa`.
- [ ] **Step 3:** Run `--app upande_core --module upande_core.upande_core.doctype.triad.test_triad` (path as in the commit). Expected: 6 pass.
- [ ] **Step 4:** Commit stays as cherry-picked (no trailer).

### Task 2: Port the kaitet SCP commits

**Files:** `apps/upande_scp` — cherry-pick from remote `kaitet`: `73c7dd7 ae5e494 4ac5947 0d4c57c 4a7bac7 70af23c 9191782` (skip `docs/` and `public/dist` hunks; dist is rebuilt in Task 8).

- [ ] **Step 1:** Create `feat/hexa-triad` from `mutara`, then commit `docs/superpowers/specs/2026-11-24-mutara-hexa-triad-design.md` and this plan as the branch's first commit.
- [ ] **Step 2:** Cherry-pick the seven commits in order; conflicts resolve to mutara's newer code plus the Hexa rules (mutara's FUA/run_automations/bundle carry mutara-only fixes — keep them).
- [ ] **Step 3:** `bench --site mutara.local migrate` (strips a stale `Band` option via ae5e494).
- [ ] **Step 4:** Run modules `test_field_unit_automation`, `test_crop_scouted_units`, `test_handset_bare_paths`, `test_farm_structure` (under `upande_scp.serverscripts.tests`) and `npx vitest run src/lib/__tests__/structure-tree.test.ts src/lib/__tests__/latest-only.test.ts`. Expected: all pass (existing mutara tests that assumed Triad-on-Row may fail — list them in the report; Tasks 5–7 own them).
- [ ] **Step 5:** Commit the conflict resolutions (if any) as part of the cherry-picks.

### Task 3: Standard triangle side setting + import check

**Files:**
- Modify: `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json` (Float `triad_side_m`, label "Triangle side (m)", default 5, in `scouting_tab` after `scouts_pick_unit`, description "Standard triad (triangle) side for Hexa layouts. Imports must match within 2 %.")
- Create: `upande_scp/serverscripts/geo/triad_size.py`
- Modify: `field_unit_automation.py` (Hexa import), `serverscripts/geo/farm_structure.py` (+ `triad_side_m` in payload), `frontend/src/lib/structure-api.ts`, `frontend/src/pages/FarmStructure.tsx` (show "Triangle side 5 m" beside the farm picker)
- Test: `upande_scp/serverscripts/tests/test_triad_size.py`, `test_field_unit_automation.py`

**Interfaces — Produces:**
- `standard_side_m() -> float` (setting, falls back to 5.0 when blank/0)
- `triangle_side_m(ring_lnglat: list) -> float | None` — mean side in metres if the ring is a closed 4-point equilateral triangle (each side within 2 % of the mean), else `None` (clipped piece)
- `check_side(ring_lnglat, standard: float) -> str | None` — `None` if OK or not a full triangle, else the refusal text `"Triangle side {measured:.2f} m differs from the standard {standard:g} m (±2 %)."`

- [ ] **Step 1: Failing tests** — `test_full_5m_triangle_measures_5`, `test_clipped_piece_returns_none`, `test_3m_triangle_refused_on_5m_standard` (message contains `"3.00 m"` and `"5 m"`), `test_blank_setting_defaults_to_5`; in FUA tests `test_hexa_import_refuses_off_standard_block` (a block fixture at 3 m → block counted refused with the message; nothing inserted for that block).
- [ ] **Step 2:** Run, expect fail. **Step 3:** Implement (metres via local equirectangular at the ring's latitude, 111 320 m/deg). **Step 4:** Run, expect pass; migrate. **Step 5:** Commit.

### Task 4: Regenerate the pivot grid (dry-run / apply)

**Files:**
- Create: `upande_scp/serverscripts/geo/hexa_grid.py` (pure geometry), `upande_scp/serverscripts/geo/regenerate_hexa_grid.py` (bench entry points)
- Test: `upande_scp/serverscripts/tests/test_hexa_grid.py`, `test_regenerate_hexa_grid.py`

**Interfaces — Produces:**
- `hexa_grid.cut(outline_utm: Polygon, side_m: float) -> list[Piece]` where `Piece = (hexa_no: int, t: int, polygon_utm: Polygon, full: bool)`; lattice origin = outline bounds (minx, maxy); rules from Global Constraints.
- `regenerate_hexa_grid.plan_block(block: str, side_m: float | None = None) -> dict` → `{block, outline_m2, pieces_m2, area_ok, hexas, triads, edge_hexas, sample: [3 names], old_rows, old_triads}`; outline = `unary_union` of the block's current Triad polygons (projected to UTM, `buffer(0.05).buffer(-0.05)`).
- `dry_run(farm="Mutara", blocks=None) -> dict` → `{side_m, blocks: [plan_block…], totals}`; also writes JSON to `sites/mutara.local/private/files/hexa_regen_dry_run.json`.
- `apply(farm="Mutara", blocks=None, confirm=0) -> dict` — refuses unless `confirm=1`; per block, in one transaction: skip if the block already holds only Hexas at this side (idempotent); remap Traps whose `unit` is an old Triad to the new Triad containing the old hexagon's centroid; delete old Triads + Rows (Beds `greenhouse=block`, `unit_type="Row"` that held Triads); insert Hexas then Triads via `frappe.db.bulk_insert` in chunks of 2000 (geojson Feature with properties `kind:"triad"`, `block`, `hexa`, `t`, `name`, `area_m2`, `edge`); add the farm's "Has Blocks"/"Has Triads" levels (reuse the ported `ensure_farm_levels`); `bump_geo_version()`; commit per block.
- Run as `bench --site mutara.local execute upande_scp.serverscripts.geo.regenerate_hexa_grid.dry_run`.

- [ ] **Step 1: Failing tests** — `test_square_100m_at_5m` (cut a 100 × 100 m square: every full piece has side 5 ± 0.01 m; pieces' area sum within 1 % of 10 000 m²; hexa numbers contiguous from 1; hexa 1 is the north-west-most); `test_slot_order` (in a full hexa, slot 1's centroid bearing ≈ 60°, slot 2 ≈ 120°, … CCW from east); `test_multipolygon_piece_keeps_largest` (a C-shaped outline); `test_slivers_under_half_m2_dropped`; `test_apply_is_idempotent` (test warehouse + farm fixtures under `_Test` names, two old Rows with 3 m hexagon Triads → apply twice → same counts, no duplicates); `test_apply_remaps_trap` (trap on old Triad → new Triad containing its centroid); `test_apply_requires_confirm`; `test_inserted_triad_passes_validate` (re-run `frappe.get_doc("Triad", name).validate()` on a sample).
- [ ] **Step 2:** Run, expect fail. **Step 3:** Implement. **Step 4:** Run, expect pass. **Step 5:** Run `dry_run` on mutara.local; report totals (expect ≈ 8.2 k hexas, ≈ 50 k triads, all `area_ok`) in the task report. **Do not run `apply` on mutara data.** **Step 6:** Commit.

### Task 5: Scouting records the triangle (GPS → Triad)

**Files:**
- Modify: `upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json` (`triad`: Link → Triad, label "Triad"), `scouting_entry.py` (block flow includes `triad`; `mapping_status` "Mapped" if any of tree/row/zone/bed/triad)
- Modify: `upande_scp/serverscripts/mobile/geo_utils.py`, `mobile/create_scouting_entry.py` (block flow: if the block holds Triads → set `row`=hexa, `triad`=triad; return `triad` in the success result)
- Test: `upande_scp/serverscripts/tests/test_scouting_unit_mapping.py` (extend)

**Interfaces — Produces:**
- `geo_utils.triad_in_block(latitude, longitude, accuracy, block) -> tuple[str | None, str | None]` = `(triad, hexa)`: per-block cache (same TTLs as `_get_block_trees`, cleared by `clear_tree_cache`) of UTM polygons in a shapely `STRtree`; containing polygon first (ties → lowest name), else nearest centroid within `max(3, min(accuracy, 50))` m, else `(None, None)`. Never searches outside the block.

- [ ] **Step 1: Failing tests** — `test_point_inside_triangle_maps_it`, `test_point_on_shared_edge_is_deterministic`, `test_point_outside_within_buffer_takes_nearest`, `test_point_beyond_buffer_unmapped` (`mapping_status == "To be mapped"`), `test_entry_stores_hexa_in_row_and_triad`, `test_tree_block_still_maps_trees`.
- [ ] **Step 2–4:** fail → implement → pass (`bench migrate` for the JSON). **Step 5:** Commit.

### Task 6: Field geometry per triangle (server + map)

**Files:**
- Modify: `upande_scp/serverscripts/geo/field_geo.py`; `frontend/src/lib/field-geo.ts`, `frontend/src/lib/hex-centroids.ts`, `frontend/src/pages/maps/field-layers.ts`, `AvocadoHeatMap.tsx`, `AvocadoTreeMap.tsx`, `components/gallery/FindingLocationMap.tsx`
- Test: `test_field_geo.py`, `src/lib/__tests__/field-geo.test.ts`, `src/lib/hex-centroids.test.ts`, `src/pages/maps/__tests__/field-layers.test.ts`, `FindingLocationMap.triad.test.tsx`

**Interfaces — Produces:**
- Payload `get_field_layers(farm, have)` → `{version, blocks, tri}`; `rows` is dropped. `tri = {q, blocks: {block: {tpl: {"1": [[dx,dy]×3] … "6"}, reg: [hexa, t, x, y, …], irr: [[hexa, t, delta_ring], …]}}}` — `x,y` = quantized hexa centre; `tpl[t]` = offsets of the triangle's 3 corners from the centre (most common per slot in the block); a triangle is regular iff its ring is `[centre, a, b, centre]` matching `tpl[t]` within 1 quantum, else irregular.
- `encode_triads(rows) -> dict` (replaces `encode_hexes`), `decode_triad(x, y, tpl_t) -> ring`.
- TS: `decodeTriads(tri): TriadSet` (`{features, idByName}`, feature props `{name, block, hexa, t}`, name rebuilt as `"{block} - Hexa {hexa} - Triad {t}"`), `hexaEdges(tri): GeoJsonFC` (outer edge `a→b` of each regular triangle), `triadCentroids(set): Map<string,[number,number]>` (renamed from `hexCentroids`).
- Layers: `fg-tri-fill` from zoom **15.5**, `fg-tri-line` from **18**, `fg-hexa-line` from **16.5**; `fg-rows` removed; `setFieldVisibility(map, {tri, hexa})`.

- [ ] **Step 1: Failing tests** — py: `test_regular_triangles_encode_as_centre_plus_slot` (round-trip ring equality within 1 quantum), `test_edge_triangle_encoded_explicitly`, `test_payload_has_no_rows`; TS: decode round-trip of a fixture with one full hexa + one clipped triangle, `hexaEdges` gives 6 segments for a full hexa, centroid of a triangle = mean of its 3 corners, layers registered with the zooms above, a block without triads draws no triangles.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit.

### Task 7: Summaries, trends, traps, seed

**Files:**
- Modify: `dashboard_aggregates/_trends.py` (`_unit_key`: block + triad → `f"{block}::triad::{triad}"` before the tree check), `scouting/scouting_metrics.py::get_units_by_warehouse` (block with Triads → `type "triad"`, count = Triads), `frontend/src/pages/trends/aggregate.ts` (same unitKey rule), `traps/trap_units.py` (a `Bed` unit with `unit_type="Hexa"` → geometry = union of its Triads, marker at its centroid; placement text "On hexa {n}" / "On triad {t} of hexa {n}"), `frontend/src/lib/trap-units.ts` (same wording), `scouting/unit_summary.py` + `scouting-summary.ts` (docstrings/wording "triad"; key logic unchanged), `migrate/seed_mutara_scouting.py` (read sites from Triads with `row` = Hexa; store `row` = hexa)
- Test: `test_unit_summary.py`, `test_trap_units.py`, a new `test_trends_triad_units.py`, `src/lib/__tests__/trap-units.test.ts`, `src/pages/trends` aggregate test

- [ ] **Step 1: Failing tests** — `test_triad_entry_counts_as_unit` (trends), `test_hexa_block_total_is_triad_count` and `test_tree_block_total_unchanged` (metrics), `test_trap_on_hexa_uses_union_outline`, `test_trap_on_triad_text`, TS wording + unitKey mirror.
- [ ] **Step 2–4:** fail → implement → pass. **Step 5:** Commit.

### Task 8: Build, full test run, dry-run report (controller stops here)

- [ ] **Step 1:** `cd frontend && npx vitest run && yarn build`; commit `public/dist` as "Rebuild SCP bundle".
- [ ] **Step 2:** Run all server modules touched in Tasks 2–7; record counts.
- [ ] **Step 3:** Controller presents the Task 4 dry-run totals to the user. **Apply on mutara.local only after the user says go**: `bench --site mutara.local backup`, then `execute …regenerate_hexa_grid.apply --kwargs "{'confirm': 1}"`, then a browser check of the Scouting Map on P1-B1 (triangles at zoom 18, hexa edges at 16.5) and a test entry from a GPS point inside a triangle.
