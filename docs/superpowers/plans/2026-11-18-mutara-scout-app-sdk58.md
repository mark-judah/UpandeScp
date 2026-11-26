# Mutara Scout app on SDK 58 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mutara build of the Scout app on Kaitet's Expo SDK 58 standard. Scouts pick Phase or Pivot → Block, the crop follows the block, and every record saves with whatever GPS the phone has.

**Architecture:**
- **Server:** `upande_scp` (branch `mutara`) gains three things:
  - a per-site "save without a good GPS fix" setting
  - optional coordinates
  - a `gps_fix_status` on scout metadata
- **App:** a new branch `mutara-sdk58` cut from `kaitet-sdk58` carries Mutara's identity, the mobile kit, the livestock UI standards, a save-anyway decision on top of the existing `chooseSubmitFix`, and grouped Phase/Pivot pickers where the crop comes from the station.

**Tech Stack:** Frappe/ERPNext v16 (Python, `bench run-tests`), Expo SDK 58 / React Native 0.88 / expo-router, jest, `@upande/mobile-kit`.

**Spec:** `docs/superpowers/specs/2026-11-18-mutara-scout-app-sdk58-design.md` (upande_scp, branch `mutara`)

## Global Constraints

- **Repos:**
  - Server: `/mnt/data/code/frappe16-mutara/apps/upande_scp`, branch `mutara`, site `mutara.local`. Never use the Kaitet MCP.
  - App: `/mnt/data/code/reactnative/Upande-Scout`, a new worktree for branch `mutara-sdk58` from `kaitet-sdk58`. App root `upande_scout_rn/`.
- **App identity:**
  - package and bundle id `com.upande.scout.mutara`
  - name "Upande Scp"
  - EAS project `d6fc6264-d373-4003-b068-b91aee0242e3`
  - channels `preview-mutarafrappe16` and `production-mutarafrappe16`
  - OTA `https://mutara.fsn.frappe.cloud/api/method/upande_mobile.api.ota.manifest?app=Upande%20Scp`
  - **runtime `2.0.0-mutarafrappe16`**
- **Kaitet behaviour is unchanged when the setting is absent or off.** That means the GPS gate and the crop chosen at configure.
- **No hard-coded crop or place names in code.** Labels come from `warehouse_type` and crops from the bundle.
- **Commits:**
  - No `Co-Authored-By` trailer, and tell subagents too. Whole-file commits.
  - Push, EAS builds and deploys only when the user asks.
- **One server test run at a time on mutara.local.**
- **Code split:** sonnet subagents write code, opus reviews.

## Review Focus

1. **A record with no GPS fix and no row**, saved offline, then synced. It must reach the server and not loop in the retry queue. Test in Task 2 and Task 7.
2. **A fallow block (no crop resolved)** must not save with an empty crop silently; the scout is asked. Test in Task 8.
3. **A phone on an older bundle with no `crop` on stations** must keep Kaitet's crop-at-configure flow. Test in Task 8.
4. **Readers of `latitude`/`longitude`** on maps, gallery and reports must not crash on null. Test in Task 3.
5. **The setting is missing from a cached hierarchy** when the phone is offline on first launch after the update. It must fall back to Kaitet's gate. Test in Task 7 (`readSaveWithoutFix({})` is false).

---

## Part 1: Server (upande_scp `mutara`)

### Task 1: Setting "save without a good GPS fix", sent to the phone

**Files:**
- Modify: `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json`
- Modify: `upande_scp/serverscripts/mobile/get_farm_hierarchy_info.py`
- Test: `upande_scp/serverscripts/tests/test_mobile_hierarchy_levels.py`

**Interfaces:**
- Produces the field `save_without_gps_fix` (Check, default 0), labelled "Save scouting without a good GPS fix", on the Scouting tab.
- Produces the response key `save_without_gps_fix: bool` on `getFarmHierarchyInfo`.

- [ ] **Step 1: Write the failing tests**
  - `test_hierarchy_sends_save_without_gps_fix_default_false`: assert the key is in the response and is `False`.
  - `test_hierarchy_sends_save_without_gps_fix_when_on`: set the single to 1, assert `True`, and restore it in `tearDown`.
- [ ] **Step 2: Run the tests and see them fail**
  `bench --site mutara.local run-tests --module upande_scp.serverscripts.tests.test_mobile_hierarchy_levels`. Expected: FAIL with a KeyError.
- [ ] **Step 3: Add the field and the key**
  - Add the field to the JSON.
  - In `getFarmHierarchyInfo`, read it with `frappe.db.get_single_value(..., cache=True)` and return `bool(...)`.
- [ ] **Step 4: Migrate and run the tests**
  `bench --site mutara.local migrate`, then the run-tests command again. Expected: PASS.
- [ ] **Step 5: Turn it on for mutara.local and commit**
  - Set it on for mutara.local with `bench --site mutara.local execute frappe.db.set_single_value --args "['Scouting and Crop Protection Settings','save_without_gps_fix',1]"`.
  - Commit the JSON, the .py and the test.

### Task 2: Save a record without coordinates and store `gps_fix_status`

**Files:**
- Modify: `upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json`. Set `latitude` and `longitude` to `reqd: 0`.
- Modify: `upande_scp/upande_scp/doctype/scouting_entry_metadata/scouting_entry_metadata.json`. Add `gps_fix_status`, a Select with options `good`, `coarse`, `none`, `clock-skew`, `stale`, after `gps_quality`.
- Modify: `upande_scp/serverscripts/mobile/create_scouting_entry.py`. Around lines 231–440 it reads `entry_data`, matches the zone or tree, and writes the metadata.
- Test: create `upande_scp/serverscripts/tests/test_create_scouting_entry_no_fix.py`

**Interfaces:**
- Consumes: the payload key `gps_fix_status` (str, optional), plus `latitude`, `longitude` and `accuracy`, any of which may be missing or null.
- Produces: `Scouting Entry` saved with null coordinates, and `Scouting Entry Metadata.gps_fix_status` stored as sent.

- [ ] **Step 1: Write the failing tests.** Use a Block station under `Pivot 1 - MUT` and one under `Phase 1 - MUT`, picked from the DB.
  - `test_block_entry_without_row_or_coordinates_is_saved`: `bed` and `tree` are blank, `latitude is None`, and the metadata has `gps_fix_status == "none"`.
  - `test_coarse_fix_saved_with_status`: `accuracy=40` and the record has its coordinates. Assert `gps_fix_status == "coarse"` and the latitude is stored.
  - `test_missing_status_leaves_field_blank`: the old phone payload has no key. Assert the record saves and `gps_fix_status` is blank.
  - `test_crop_scouted_filled_from_station_when_blank`: no `crop_scouted` is sent for a P1 block. Assert it equals `planting.crop_for_station(block, date)`.
- [ ] **Step 2: Run the tests and see them fail**
  `bench --site mutara.local run-tests --module upande_scp.serverscripts.tests.test_create_scouting_entry_no_fix`. Expected: FAIL on the mandatory latitude.
- [ ] **Step 3: Change the JSON and the server function**
  - Edit both JSON files.
  - In `create_scouting_entry`:
    - Pass `gps_fix_status` through to the metadata.
    - Skip zone or tree matching when there are no coordinates. The existing `if latitude and longitude and accuracy` guard already does this, so confirm it.
    - Don't coerce a missing latitude to 0.
- [ ] **Step 4: Migrate and run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**

### Task 3: Null-safe readers of scouting coordinates

**Files:**
- Modify: every reader found by `grep -rn -E "latitude|longitude" upande_scp/serverscripts upande_scp/api* frontend/src --include=*.py --include=*.ts --include=*.tsx` that does arithmetic or builds GeoJSON from a Scouting Entry. These are expected in the scouting map summary, the gallery location map, `reports/block_weekly_email.py` and the heat maps.
- Test: create `upande_scp/serverscripts/tests/test_scouting_null_coordinates.py`

**Interfaces:**
- Consumes: entries with null coordinates from Task 2.
- Produces: nothing new. Readers drop point-less entries from point layers, but keep them in per-block counts.

- [ ] **Step 1: Write the failing tests**
  - Insert one entry with null coordinates on a P1 block.
  - Call each server reader the grep found that has a Python entry point: the map summary, gallery feed and block weekly email builder.
  - Assert none raises.
  - Assert the per-block count for that block includes the entry.
  - Assert the point or GeoJSON outputs leave it out.
- [ ] **Step 2: Run the tests and see them fail.** This is the module run, as in Task 1.
- [ ] **Step 3: Add the guards**
  - Server readers filter on `latitude is not null` for point outputs only.
  - Frontend readers skip a falsy lat/lng before projecting.
- [ ] **Step 4: Run the tests and see them pass**
  - Also run `cd frontend && npx tsc --noEmit`. Expected: no errors.
  - If frontend files changed, rebuild the web app bundle per the repo's convention as a separate build commit.
- [ ] **Step 5: Commit.** Code first, then the build commit.

---

## Part 2: App (Upande-Scout, branch `mutara-sdk58`)

### Task 4: Branch, Mutara identity and runtime

**Files:**
- Create the worktree: `git -C /mnt/data/code/reactnative/Upande-Scout worktree add ../Upande-Scout-mutara-sdk58 -b mutara-sdk58 kaitet-sdk58`
- Modify: `upande_scout_rn/app.json`, `upande_scout_rn/eas.json`, `upande_scout_rn/src/services/instanceMapper.ts`
- Test: `upande_scout_rn/src/services/__tests__/appLineage.test.ts`, `instanceMapper.test.ts`

**Interfaces:**
- Produces: a buildable app with the Global Constraints identity.

- [ ] **Step 1: Cherry-pick the three identity commits**
  - Run `git cherry-pick 73c5925 a456172 0075fd1` from `mutara-frappe16`.
  - On conflicts in app.json and eas.json, take the Mutara values and keep SDK 58's everything else.
- [ ] **Step 2: Set the runtime and OTA url**
  - Set `runtimeVersion` to `2.0.0-mutarafrappe16` and the OTA `updates.url` to the Mutara one.
  - Update `appLineage.test.ts` to expect `2.0.0-mutarafrappe16`.
- [ ] **Step 3: Install and run the checks**
  - `npm ci && npx jest src/services/__tests__/appLineage.test.ts src/services/__tests__/instanceMapper.test.ts && npx tsc --noEmit`. Expected: PASS and no type errors.
  - `npx expo-doctor`. Expected: no SDK mismatch.
- [ ] **Step 4: Commit**

### Task 5: Mobile kit on SDK 58, held off until the site has `upande_mobile`, themed

**Files:**
- Port from `mutara-frappe16` `83d85c8`:
  - `src/mobile-kit.ts`, `app/mobile-kit/settings.tsx`, `app/mobile-kit/devices.tsx`
  - the `MobileKitProvider` in `app/_layout.tsx`
  - `.github/workflows/release.yml`, `upgrade-kit.yml`
  - the `package.json` dependency
- Port from livestock `upande-livestock-mutara`:
  - `src/kit/kitServer.ts` (`edbdba8`)
  - the theme wiring of `27b7ca8`
- Test: create `upande_scout_rn/src/kit/__tests__/kitServer.test.ts`, adapted from livestock's test if it has one.

**Interfaces:**
- Consumes: the app's auth store and API client (`src/services/api.ts`).
- Produces: `kitServer.hasUpandeMobile(): Promise<boolean>`. The kit's calls are refused locally when it's false.

- [ ] **Step 1: Write the failing test.** `kit calls are refused when the site lacks upande_mobile` and `kit calls pass when installed`, by mocking the installed-apps probe livestock uses.
- [ ] **Step 2: Run** `npx jest src/kit`. Expected: FAIL.
- [ ] **Step 3: Port the files**
  - Use the kit version livestock runs on SDK 58; copy its `package.json` pin.
  - Point the release workflow at Mutara's release repo, the same one `83d85c8` used.
  - Route the kit's banners and pages through Scout's palette (`src/ui/palette.ts`) and font.
- [ ] **Step 4: Run** `npx jest && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**

### Task 6: Livestock UI standards (connection dot, frosted sheet, logo, logout)

**Files:**
- Port and adapt from `upande-livestock-mutara`:
  - `components/OnlineDot.tsx` (FloatingOnlineDot, StatusSheetHost)
  - `src/sync/dotAnchor.ts`, `src/sync/statusSheet.ts`
  - `components/BlurBackdrop.tsx` (FrostedBackdrop)
  - the `useSyncParts` module
  - `src/auth/authStore.ts` background logout, from `4cdfbdf`
- Modify:
  - `upande_scout_rn/app/(tabs)/_layout.tsx`: mount the dot once over the tab pages, in a fixed top-right slot.
  - `components/ScpLogo.tsx`: 1.5 s each way, ease-in-out, rest on the Upande mark.
  - `app/(tabs)/profile/index.tsx`: long names wrap instead of clipping.
  - Replace Scout's existing live-updates toast or sync strip with the dot and syncing bar.
- Add deps: `expo-blur`, `@react-native-masked-view/masked-view`, at the versions livestock pins for SDK 58.
- Test: port livestock's tests for the dot anchor and the logout ordering.

**Interfaces:**
- Consumes: Scout's existing sync state (pending queue counts in `src/services/syncBreakdown.ts`).
- Produces: a `useSyncParts()` hook that reads Scout's queues, not livestock's.

- [ ] **Step 1: Write the failing tests**
  - `dot anchor is the same slot on every tab page`.
  - `logout navigates before server sign-out resolves`.
- [ ] **Step 2: Run** `npx jest`. Expected: the new tests FAIL.
- [ ] **Step 3: Port and adapt the code.** Keep Scout's own `src/ui/alert.ts` and `src/ui/calendar.ts`, and don't import livestock's equivalents.
- [ ] **Step 4: Run** `npx jest && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** The native deps mean this needs a new APK, which Task 9 builds.

### Task 7: Save anyway: decision, note and payload

**Files:**
- Create: `upande_scout_rn/src/services/saveDecision.ts`
- Modify: `upande_scout_rn/app/(tabs)/index.tsx`. That's the submit handler at about line 1630 (`getSubmitLocation`, the row-required check and the payload build at about line 1687), and where the hierarchy response is parsed, to cache `save_without_gps_fix`.
- Test: create `upande_scout_rn/src/services/__tests__/saveDecision.test.ts`

**Interfaces:**
- Consumes: `SubmitResult`, `SubmitFailureReason`, `CLEAN_ACCURACY_LIMIT_METERS` from `src/services/submitFix.ts`.
- Produces:
  - `type GpsFixStatus = "good" | "coarse" | "none" | "clock-skew" | "stale"`
  - `decideSave(result: SubmitResult, saveWithoutFix: boolean, best: SubmitSample | null): { save: true; fix: { lat: number; lng: number; acc: number } | null; status: GpsFixStatus } | { save: false; failure: SubmitFailure }`
  - `readSaveWithoutFix(hierarchy: unknown): boolean`

- [ ] **Step 1: Write the failing tests** in `saveDecision.test.ts`:
  - `ok result → save, status "good", fix from result`
  - For each of `no-permission`, `no-fixes`, `accuracy`, `clock-skew`, `stale` with `saveWithoutFix=false` → `save: false` with the same failure. This is Kaitet's behaviour.
  - `accuracy` with true and best `{acc: 40}` → `save: true`, `status: "coarse"`, `fix.acc === 40`.
  - `no-fixes` with true → `save: true`, `fix: null`, `status: "none"`.
  - `no-permission` with true → `fix: null`, `status: "none"`.
  - `clock-skew` with true → `status: "clock-skew"`, with the best sample's coordinates when present.
  - `stale` with true → `status: "stale"`, with the last sample's coordinates.
  - `readSaveWithoutFix({})`, `readSaveWithoutFix(null)` and `readSaveWithoutFix({save_without_gps_fix: 0})` are all false; `{save_without_gps_fix: true}` is true.
- [ ] **Step 2: Run** `npx jest src/services/__tests__/saveDecision.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `saveDecision.ts`, then wire it into `index.tsx`**
  - Read the flag with `readSaveWithoutFix` from the cached hierarchy.
  - When `save: true` with a non-good status:
    - send `latitude`, `longitude` and `accuracy` as null when `fix` is null
    - send `gps_fix_status` only when the flag is true
    - show a non-blocking toast, "Weak GPS — saved anyway"
  - The row is no longer required when the flag is true. The block is still required.
  - The date of capture uses `src/services/siteClock.ts`.
- [ ] **Step 4: Check the offline queue.** Add `queued no-fix entry drains` to the existing offline-queue tests; it covers Review Focus item 1. Assert a payload with null coordinates is accepted by the dispatcher and not retried forever.
- [ ] **Step 5: Run** `npx jest && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 6: Commit**

### Task 8: Grouped Phase/Pivot pickers, crop from the block

**Files:**
- Create: `upande_scout_rn/src/services/stationGroups.ts`
- Modify:
  - `upande_scout_rn/app/(auth)/configure.tsx`: the section picker at about line 206 and the crop step at about lines 863–940.
  - `upande_scout_rn/app/(tabs)/index.tsx`: the in-tab station switch dialog (`showGreenhouseDialog`) and `setStationInfo` at about lines 1174 and 1417, which today take `userCrop`.
- Test: create `upande_scout_rn/src/services/__tests__/stationGroups.test.ts`

**Interfaces:**
- Consumes: from the hierarchy and bundle, `levels: {name, warehouse_name, warehouse_type, parent}[]` and stations `{name, warehouse_name, parent, crop: string | null}`. `farmStations.stationsFromBundle` already unwraps the bundle.
- Produces:
  - `groupParents(levels, stations): { type: string; parents: { name: string; label: string }[] }[]`. It returns only parents that hold at least one station, grouped by `warehouse_type` in first-seen order.
  - `blocksFor(parent, stations): { name: string; label: string; crop: string | null }[]`, sorted naturally (B2 before B10).
  - `cropsAreStationLevel(stations): boolean`, true when any station carries the `crop` key.

- [ ] **Step 1: Write the failing tests.** Use a fixture copied from the mutara.local bundle: Phase 1/2, Pivot 1–4, Section A, with P1 blocks carrying mixed crops and P3 blocks carrying null.
  - `groupParents` gives the groups `Phase`, `Pivot`, `Section`. Pivot holds `Pivot 1 - MUT` to `Pivot 4 - MUT`.
  - `blocksFor("Pivot 1 - MUT")` returns 12, in the order P1-B1, P1-B2 … P1-B12, with the crop on each.
  - `blocksFor("Pivot 3 - MUT")[0].crop === null`.
  - `cropsAreStationLevel(stationsWithoutCropKey) === false`. This is the old-server case, Review Focus item 3.
- [ ] **Step 2: Run** `npx jest src/services/__tests__/stationGroups.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `stationGroups.ts`, then wire it in**
  - When `cropsAreStationLevel`, `configure.tsx` skips the crop step. It shows the grouped parent picker with group headings from `warehouse_type` (pluralised with an "s"), then blocks, each with its crop or "No crop".
  - Picking a block sets the station crop to the block's crop.
  - A null crop opens the existing crop picker before continuing. This covers Review Focus item 2.
  - The in-tab switch dialog does the same, and updates `setStationInfo({crop})` and the pest lists.
  - When `!cropsAreStationLevel`, the existing Kaitet flow is untouched.
- [ ] **Step 4: Run** `npx jest && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit**

### Task 10: Server — `scouts_pick_unit` setting, GPS mapping to the nearest unit, `mapping_status`

Spec: the design doc's Addendum (2026-11-18).

**Files:**
- Modify: `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json` (add `scouts_pick_unit`, Check, default 1, after `save_without_gps_fix`)
- Modify: `upande_scp/serverscripts/mobile/get_farm_hierarchy_info.py` (return `scouts_pick_unit: bool`)
- Modify: `upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json` (add `mapping_status`, Select `\nMapped\nTo be mapped`, read_only 1, in_list_view 0, near tree/row)
- Modify: `upande_scp/serverscripts/mobile/geo_utils.py` (add `nearest_unit_in_block(latitude, longitude, accuracy, block) -> tuple[str|None, str|None]` returning (tree, row); `nearest_zone_in_greenhouse(latitude, longitude, accuracy, greenhouse) -> str|None`), reusing the existing zone/tree caches and the same buffer rule
- Modify: `upande_scp/serverscripts/mobile/create_scouting_entry.py` (when no row/bed sent and coordinates+accuracy present, call the helpers; set `mapping_status`)
- Test: `upande_scp/serverscripts/tests/test_scouting_unit_mapping.py`; extend `test_mobile_hierarchy_levels.py`

**Interfaces:**
- Produces: `scouts_pick_unit` (hierarchy response, bool); `Scouting Entry.mapping_status` ∈ {Mapped, To be mapped}.

- [ ] **Step 1: Failing tests**
  - `test_hierarchy_sends_scouts_pick_unit_default_true`; `..._when_off` (set 0, assert False).
  - `test_block_entry_without_row_maps_to_nearest_tree`: coordinates of an existing Orchard Tree in PH1-B1 (read one from the DB) → entry.tree == that tree, entry.row == tree.row, mapping_status == "Mapped".
  - `test_block_entry_far_from_any_tree_is_to_be_mapped`: point 500 m outside the block → tree blank, "To be mapped".
  - `test_entry_without_coordinates_is_to_be_mapped`.
  - `test_scout_picked_row_is_mapped_as_before`: row sent → behaviour as today, "Mapped" when a tree is matched.
- [ ] **Step 2: Run, see them fail** (module runs as in Task 1/2).
- [ ] **Step 3: Implement** fields, hierarchy key, helpers, wiring.
- [ ] **Step 4: Migrate, run the new module plus `test_create_scouting_entry_no_fix` and `test_mobile_hierarchy_levels`; all pass.**
- [ ] **Step 5: Set `scouts_pick_unit` = 0 on mutara.local; commit.**

### Task 11: App — hide the row/bed picker when `scouts_pick_unit` is off

**Files:**
- Create: `upande_scout_rn/src/services/unitPicking.ts` (`readScoutsPickUnit(hierarchy: unknown): boolean` — missing/non-boolean → true)
- Modify: `upande_scout_rn/app/(tabs)/index.tsx` (picker + required check), wherever the row/bed list header renders
- Test: `upande_scout_rn/src/services/__tests__/unitPicking.test.ts`

**Interfaces:**
- Consumes: Task 10's `scouts_pick_unit`; Task 7's cached-hierarchy read and quiet refresh.

- **Rule (user):** the unit level is also hidden when the station has no beds/rows/bands in the phone's data, whatever the setting. Expose `showUnitPicker(scoutsPickUnit: boolean, unitCount: number): boolean` (= `scoutsPickUnit && unitCount > 0`) in `unitPicking.ts` and drive every hide/require decision from it.
- [ ] **Step 1: Failing tests** — `showUnitPicker(true, 0)` false, `(true, 5)` true, `(false, 5)` false; `readScoutsPickUnit({})` true, `(null)` true, `({scouts_pick_unit: false})` false, `({scouts_pick_unit: true})` true.
- [ ] **Step 2: Run, see fail.**
- [ ] **Step 3: Implement**; when false: hide every row/bed-level view on the scouting screen (picker, header, row/bed grid, odd/even and bed-progress views), never require a unit, send no `bed`/`row`; show instead an **entries list** for the current block today (newest first: time, pest/disease or observation, count, status). Status: "Waiting to sync" for queued entries, "To be mapped" for synced ones (read-only; the server's `mapping_status` is not fetched back in this task). Put the list-building logic in `src/services/blockEntries.ts` (`entriesForBlock(entries, block, siteDay): BlockEntryRow[]`) with a test `entriesForBlock filters to the block and site day, newest first, queued marked Waiting to sync`. When true: unchanged.
- [ ] **Step 4: `npx jest` + `npx tsc --noEmit`** (no new tsc errors).
- [ ] **Step 5: Commit.**

**Order:** Tasks 10 and 11 run after Task 8 and before Task 9 (verification covers them: in Step 2 of Task 9, check that no row picker shows and that a saved entry's `mapping_status` is Mapped near a tree and "To be mapped" with GPS off).

### Task 9: Device check and preview build

**Files:** none (verification only).

- [ ] **Step 1: Point a dev build at mutara.local**
  - Run `npx expo start --dev-client` from the worktree, against `https://mutara.132.145.18.63.nip.io`. Expo Go can't load the kit's native code.
  - Build the dev APK only when the user asks.
- [ ] **Step 2: Walk through it on the phone**
  1. Sign in as the Mutara demo scout.
  2. Pick Phase 1 → PH1-B3; the crop shows Avocado. Save with GPS on.
  3. Turn location off and save again; the "Weak GPS — saved anyway" toast appears.
  4. Pick Pivot 1 → a Potato block; the pest list shows potato pests. Save with no row.
  5. Pick Pivot 3 → a block; you're asked for the crop.
  6. Check the connection dot stays in the same place across tabs.
- [ ] **Step 3: Check the server records**
  - `bench --site mutara.local mariadb -e "select e.name, e.block, e.crop_scouted, e.latitude, m.gps_fix_status from \`tabScouting Entry\` e left join \`tabScouting Entry Metadata\` m on m.scouting_entry=e.name order by e.creation desc limit 6"`. Adjust the join column to the metadata's real link field.
  - Expected: the rows match the walkthrough, including a null latitude with `none`.
- [ ] **Step 4: Report to the user.**
  - Push, the preview APK (`[native]` release) and the Frappe Cloud deploy of Part 1 wait for the user.
  - Order: deploy the server, then the APK, then scouts sync the old app before installing.
