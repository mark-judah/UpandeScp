# Crop Scouted & Flexible Farm Hierarchy

This document summarises the work that made scouting flexible across crops and
farm hierarchies. The original system assumed a single crop (Rose) with a
Farm → Greenhouse → Bed structure. The changes below generalise that so a farm
can grow any crop and follow either the existing Greenhouse/Bed hierarchy or a
new Section/Block/Row hierarchy (used by avocado farms such as Lokitela).

---

## 1. Overview

- Introduced a **Crop Scouted** master with per-crop configuration of pests,
  diseases, predators, weeds, incidents, physiological disorders, plant
  sections, and applicable farms.
- Added a parallel warehouse hierarchy (**Section → Block**) alongside the
  existing Greenhouse hierarchy, and repurposed the `Bed` doctype so a single
  record can represent a bed *or* a row.
- Mobile app onboarding is now **Farm → Crop → (Section → Block | Station)**.
  Observation categories and plant-section tabs adapt to the chosen crop.
- Fixed a profile-reconfigure bug that was silently caching Rose observations
  across crop changes.

---

## 2. Schema changes

### 2.1 New doctypes (all in `upande_scp/upande_scp/doctype/`)

| Doctype | Purpose |
| --- | --- |
| `Crop Scouted` | Master — one record per crop (Rose, Avocado, …). |
| `Pest Filter` | Child — Crop Scouted ⇄ Pest. |
| `Disease Filter` | Child — Crop Scouted ⇄ Plant Disease. |
| `Predator Filter` | Child — Crop Scouted ⇄ Predator. |
| `Weed Filter` | Child — Crop Scouted ⇄ Weed. |
| `Incident Filter` | Child — Crop Scouted ⇄ Incident. |
| `Physiological Disorder Filter` | Child — Crop Scouted ⇄ Physiological Disorder. |
| `Farm Filter` | Child — Crop Scouted ⇄ Farm. *Empty list = applies to all farms.* |
| `Plant Section Filter` | Child — Crop Scouted ⇄ Plant Section. *Empty list = all sections allowed.* |
| `Trap Filter` | Created but **not** attached to Crop Scouted (traps are warehouse-dependent and were intentionally decoupled; the file remains for future use). |

### 2.2 Modified doctypes

- **`Scouting Entry`** — new optional `crop_scouted` Link field (→ Crop Scouted)
  in the header. The single location pair `(greenhouse, bed, zone)` has been
  split into **six** fields so the two hierarchies no longer overload each
  other:
  - `greenhouse` / `bed` / `zone` — used by the Greenhouse flow (Rose).
  - `block` (Link Warehouse, new) / `row` (Link Bed, new) / `tree` (Link Zone,
    new) — used by the Block flow (Avocado).
  - Each field has a `depends_on` eval so the inactive half is hidden in the
    form: e.g. `block` uses `eval:!doc.greenhouse`, `row` uses
    `eval:doc.block`, `tree` uses `eval:doc.row`.
  - `greenhouse` and `zone` use `mandatory_depends_on` instead of `reqd: 1` so
    they're only required in the Greenhouse flow. `block` is
    `mandatory_depends_on: eval:!doc.greenhouse`.
  - `scouting_entry.py` rejects mixed flows (any of greenhouse/bed/zone +
    any of block/row/tree) and requires one of the two flows to be present.
- **`Bed`**
  - `unit_type` (Select: `Bed` / `Row`, default `Bed`) — disambiguator.
  - `number_of_trees` (Int) — used for rows under blocks.
  - `autoname` is now `{greenhouse} - {unit_type} {bed}`, backwards compatible
    with existing `Greenhouse - Bed N` names.

### 2.3 New Warehouse Types

`Section`, `Block` (records in `Warehouse Type`).

### 2.4 Scouting Entry filter JS

`scouting_entry.js` now hides each child-table section (Pests, Diseases,
Predators, Weeds, Incidents, Physiological Disorders) when the selected crop's
corresponding multi-select is empty, and filters the Link picker inside each
child table to only the masters tagged on that crop. **Traps are excluded from
this filter logic** by design.

---

## 3. Backend endpoints (`upande_scp/serverscripts/mobile/`)

| Endpoint | Purpose |
| --- | --- |
| `get_crops_scouted.py → getCropsScouted(farm=None)` | Returns `[{name, crop_name, variety, image}]`. When `farm` is supplied, filters by `Farm Filter`; crops with an empty `farms` list are treated as applies-to-all. |
| `get_farm_hierarchy_info.py → getFarmHierarchyInfo(farm)` | Returns `{farm_warehouse, station_type: "Greenhouse" \| "Block", has_sections, sections[]}` — used by the mobile to decide whether to insert a Section picker. |
| `get_observations_details.py → getObservationsDetails(crop=None)` | **Existing endpoint, updated.** Filters each category by its `<X> Filter` child rows. Categories with an empty filter are omitted. Response now also carries `allowed_plant_sections`. Trap is out of scope here. |
| `create_scouting_entry.py → createScoutingEntry` | **Updated** to persist `crop_scouted` on the new Scouting Entry, and (later) to accept `block`/`row`/`tree` for the Block flow. Server-side zone detection only runs when `bed` is provided — Block flow relies on the mobile selecting `tree` explicitly. Duplicate checks use whichever location tuple was sent. Trap fields unchanged. |

---

## 4. Mobile app (`~/stive/code/reactnative/Upande-Scout/upande_scout_rn`)

### 4.1 `src/services/api.ts`
- `fetchScoutingObservations(crop?)` — passes crop in body.
- `fetchCrops(farm?)` — hits `getCropsScouted`.
- `fetchFarmHierarchy(farm)` — hits `getFarmHierarchyInfo`.
- `fetchBlockRows(block)` — alias over `fetchGreenhouseBeds` for the Block
  flow. Same underlying server script because rows are `Bed` records whose
  `greenhouse` field points at the block warehouse.

### 4.2 `src/services/scoutingCacheDb.ts`
- `station_info` table — new `crop`, `station_type`, `row_wh`, `tree` columns.
- `observations` table — new `crop` and `plant_sections` columns.
- Setter / getter signatures updated:
  - `setStationInfo({farm, greenhouse, crop?, stationType?, row?, tree?})` —
    `greenhouse` holds the selected warehouse (greenhouse name or block name).
    `stationType` is `"Greenhouse"` or `"Block"` and tells downstream screens
    which flow to render.
  - `setCachedObservations(payload, crop?, plantSections?)`
  - `hasCachedObservations(crop?)` — matches only when cached crop equals query.
  - `getCachedPlantSections()` — new.
- Schema migration is safe: uses `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`
  so existing installs auto-upgrade.

### 4.3 `hooks/auth/use-configure-utils.ts`
- New `parseAllowedPlantSections(res)` helper.

### 4.4 `hooks/tabs/use-scouting-utils.ts`
- `buildScoutingSubmissionEntry({…, crop, stationType, tree})` now includes
  `crop_scouted` in the submission payload, and sends the correct location
  tuple per flow:
  - `Greenhouse` flow → `{greenhouse, bed, zone: ""}` (server derives `zone`).
  - `Block` flow → `{block, row, tree}`.
- `extractBedNumberFromName` now also matches `"... Row N"` names.

### 4.5 `app/(auth)/configure.tsx`
- Added Crop, Section picker states and dialogs.
- Adaptive flow: **Farm → Crop (filtered by farm) → [Section → Block] OR
  [Station (Greenhouse)]** based on `hierarchyInfo.has_sections` /
  `station_type`.
- `filterWarehousesForFarm` now enforces `is_group=0` and accepts only
  `warehouse_type IN (Greenhouse, Block)`; supports filtering by a parent
  warehouse (used when a Section is picked).
- Submit now stores `userCrop`, `userSection`, `userStationType` in
  `USER_STATION` and in SQLite. `userStationType` drives terminology on the
  scouting screen ("Row" vs "Bed").
- Removes observations from the pre-batch download (observations need the crop
  which isn't known yet at that point).

### 4.6 `app/(tabs)/index.tsx` (scouting screen)
- Reads `userCrop` and `userStationType` from `USER_STATION` on mount.
- `stationType` state drives labels: "Enter Row Number" / "Row Number" dialog
  copy when the user is on the Block flow, "Bed Number" otherwise.
- `buildScoutingSubmissionEntry` is now called with `stationType` so the
  submission payload uses the right location keys (`{block,row,tree}` or
  `{greenhouse,bed,zone}`).
- Observations cache now keyed by crop; stale caches refresh automatically.
- New state `allowedPlantSections`. Plant-part tabs are built from this list;
  falls back to the old hardcoded `BASE_PLANT_PARTS` only when the list is
  unavailable (old builds / no crop).
- `Incidents` and `Comments` tabs still appended based on category presence.

### 4.7 `app/(tabs)/profile/index.tsx`
- **Bug fix**: `handleSaveStation` previously dropped `userCrop` on save,
  causing stale observations to be used after reconfigure.
  It now preserves `userCrop`, `userSection`, and `userStationType`, and uses
  the crop when checking / fetching observations.

---

## 5. Seed data (kaitet.local)

- **Warehouse Types**: `Section`, `Block` created.
- **Lokitela hierarchy** (under `Lokitela - KL` / `warehouse_type=Farm`):
  - Sections: `23HA_SECTION - KL`, `70HA_SECTION - KL`.
  - Blocks: `WESA BL 1 - KL`, `WESA BL 2 - KL`.
  - Rows (3 per block) as `Bed` rows with `unit_type=Row`, `bed_length=50`,
    `number_of_trees=20`.
  - Trees: 2 Zone records under `WESA BL 1 - KL - Row 1`.
  - Trap: `Lokitela - 2001`, `greenhouse=WESA BL 1 - KL`, type FCM.
- **Plant Section master**: added `Leaf`, `Fruit` (existing: Stem, Base, Middle,
  Top, Buds).
- **Crop Scouted**
  - `Rose`
    - Farms: all 12 non-Lokitela farms.
    - Plant sections: Stem, Base, Middle, Top, Buds, Leaf, Fruit.
    - Pests/Diseases/… multi-selects: tagged to every existing master row (via
      the backfill script), so existing 132 k scouting entries remain
      unaffected.
  - `Avocado`
    - Farms: Lokitela.
    - Plant sections: Stem, Fruit, Leaf.
    - Pests: Leaf Rollers, Mosquito Bugs, Caterpillars, Unidentified Insects,
      Scale Insects (each with an Adult stage).
    - Diseases, Predators, Weeds, Incidents, Physiological Disorders: empty →
      those sections hide on Scouting Entry when Avocado is selected.
- **Existing scouting entries**: 132 038 rows backfilled with
  `crop_scouted = Rose`.

---

## 6. Scripts reference (at repo root of `upande_scp/`)

| Script | Purpose |
| --- | --- |
| `sync_crop_doctypes.py` | Initial per-app sync of the Crop Scouted family + Scouting Entry. Used when `bench migrate` fails on an unrelated doctype. |
| `sync_all_upande_scp.py` | Comprehensive per-app sync of every upande_scp doctype touched by this work (11 doctypes). Safe substitute for `bench migrate` until the pre-existing Sampling Table conflict is resolved. |
| `resync_crop_scouted.py` | Re-imports Crop Scouted only; used when removing the `traps` field. Also cleans up orphaned `Trap Filter` rows. |
| `backfill_crop_scouted_rose.py` | Creates Rose Crop Scouted with every existing pest/disease/predator/weed/incident/disorder tagged, then sets `crop_scouted = Rose` on all existing Scouting Entry rows. |
| `create_avocado_crop.py` | Creates the four missing Avocado pest masters (with Adult stage), ensures Scale Insects has an Adult stage, creates the Avocado Crop Scouted record, and tags all five pests. |
| `seed_lokitela_hierarchy.py` | Ensures the `Bed` / `Farm Filter` / `Crop Scouted` schemas, creates Section and Block warehouse types, builds the Lokitela hierarchy (2 sections, 2 blocks, 6 rows, 2 trees, 1 trap), and tags Avocado → Lokitela. |
| `seed_plant_sections.py` | Re-syncs Plant Section Filter + Crop Scouted, adds Leaf and Fruit Plant Section records, and tags Rose + Avocado with their sections. |
| `migrate_block_row_fields.py` | Migrates existing Lokitela Scouting Entry rows onto the new `block`/`row`/`tree` fields and clears the legacy `greenhouse`/`bed`/`zone` columns. Idempotent. |
| `delete_duplicate_scouting_entries.py` | Pre-existing utility (not part of this change set). |

All scripts are run via `bench --site <site> console`:

```bash
bench --site kaitet.local console
>>> exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/<script>.py').read())
```

---

## 7. How to apply the full change set from scratch

If starting from a site without any of this work:

1. Sync the upande_scp doctypes:

   ```bash
   exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/sync_all_upande_scp.py').read())
   ```

2. Backfill Rose and existing Scouting Entry rows:

   ```bash
   exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/backfill_crop_scouted_rose.py').read())
   ```

3. Seed Lokitela hierarchy + Avocado:

   ```bash
   exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/create_avocado_crop.py').read())
   exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/seed_lokitela_hierarchy.py').read())
   ```

4. Seed plant sections:

   ```bash
   exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/seed_plant_sections.py').read())
   ```

   Then migrate any Lokitela Scouting Entry rows that were previously saved
   under the overloaded `greenhouse`/`bed`/`zone` columns:

   ```bash
   exec(open('/home/ubuntu/stive/code/frappe15/apps/upande_scp/migrate_block_row_fields.py').read())
   ```

5. Tag Rose with the correct farms (strict per-farm filtering):

   ```bash
   bench --site <site> console
   >>> import frappe
   >>> rose = frappe.get_doc('Crop Scouted', 'Rose')
   >>> for f in [f for f in frappe.get_all('Farm', pluck='name') if f not in ('Lokitela', 'Post Harvest')]:
   ...     if f not in {r.farm for r in (rose.get('farms') or [])}:
   ...         rose.append('farms', {'farm': f})
   >>> rose.save(ignore_permissions=True)
   >>> frappe.db.commit()
   ```

6. On the mobile app: re-login or trigger a fresh fetch so the crop-keyed
   observation cache gets populated.

---

## 8. Known issues / blockers

- **`bench migrate` currently fails** on a pre-existing `Sampling Table.bed_no`
  schema conflict between the `agriculture` app (defines it as `Int`) and the
  `upande_kaitet` app (defines it as `Link`). Live data contains strings like
  `'Chepsito GH 15 - KR - Bed 184'`, so the Int migration fails the MySQL
  `Truncated incorrect INTEGER value` error. This has nothing to do with the
  crop work. Resolve separately with the owners of those apps; meanwhile use
  `sync_all_upande_scp.py` as the substitute.

- **Trap crop-filtering was intentionally skipped** (traps are warehouse-bound,
  not crop-bound). `Trap Filter` doctype exists but is unused.

- **Existing cached observation rows on devices** still have
  `plant_sections = NULL`. Re-fetching (configure reconfigure or crop change)
  populates the column, after which the adaptive plant-part tabs take effect.

- Fixtures hook (`hooks.py`) registers `Crop Scouted` so its records ship
  between environments. Related child-doctype schemas are shipped by the app
  code itself (not fixtures).

---

## 9. Crop Modelling (sample-tree observations)

Introduced a lightweight sample-tree observation flow on top of the Block/Row
flow. Trees are now a **dedicated doctype** (previously they were Zone records
overloaded via `unit_type`). A *model tree* is a Tree flagged `is_model=1`;
scouts pick one per block per visit to record leaf size/color, fruit stage,
and a root-flush check.

### 9.1 Schema

- **`Tree`** — new standalone doctype. Fields: `row` (Link Bed), `block`
  (Link Warehouse, fetched from row), `tree_number` (Data), `is_model`
  (Check), `tree_code` (Data, read-only). `autoname` is `Prompt` with Python
  logic in `tree.py`: prefers a manually set `tree_code`, otherwise computes
  `{section}_{block}_ROW{n}_T{n}` via `build_tree_code(row, tree_number)`.
- **`Crop Modelling Entry`** — new child (`istable=1`) attached to Scouting
  Entry. Fields: `tree` (Link Tree, reqd), `leaf_size`, `leaf_color`,
  `fruit_stage`, `root_flush` (Check).
- **`Scouting Entry`** — new child table field `crop_modelling_entry` plus a
  section break, both `depends_on: eval:doc.block` so they only surface on the
  Block flow. The existing `tree` header field now links to **Tree** (was
  Zone).
- **`Zone`** — unchanged. The "zone-as-tree" overload is retired.

### 9.2 Backend endpoints

| Endpoint | Purpose |
| --- | --- |
| `get_model_trees.py → getModelTrees(block)` | Returns `[{name, tree_code, row, tree_number, label}]` for Tree rows under the block flagged `is_model=1`. |
| `create_scouting_entry.py → createScoutingEntry` | Now also persists `crop_modelling_entry` child rows when the mobile sends them. `tree` on the header is a Tree reference. |

### 9.3 Mobile app

- `api.ts` — new `fetchModelTrees(block)`.
- `submissionQueue.ts` — `SubmissionType` gains `"crop_model"`; the new type is
  whitelisted in `submissionSync.ts` and flows through the same
  `createKaitetScoutingEntry` batch path.
- `(tabs)/traps/index.tsx` — when `userStationType === "Block"`, a **Crop
  Models** section renders above the trap list. Each card shows the tree code
  and a leaf icon; tapping it opens a modal with chip-style toggles for leaf
  size, leaf color, fruit stage, and root flush (Yes/No). Submitting the modal
  enqueues one Scouting Entry payload per model tree with a single
  `crop_modelling_entry` child row.

### 9.4 Scripts

| Script | Purpose |
| --- | --- |
| `sync_crop_modelling.py` | Per-app sync for `Tree`, `Crop Modelling Entry`, and the updated `Scouting Entry`. |
| `backfill_tree_codes.py` | Migrates legacy tree-Zones to the new Tree doctype: for each Zone under a Row-type Bed, creates a matching Tree (name=`{section}_{block}_ROW{n}_T{n}`) and re-points `Scouting Entry.tree` from the old Zone name to the new Tree name. |
