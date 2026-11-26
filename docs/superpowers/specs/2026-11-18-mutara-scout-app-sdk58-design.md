# Mutara Scout app on the Kaitet SDK 58 standard — design (2026-11-18)

Mobile repo: `Upande-Scout` (`/mnt/data/code/reactnative/Upande-Scout-mutara`, app in
`upande_scout_rn/`). Backend: `upande_scp` branch `mutara`, site `mutara.local`, live
`mutara.fsn.frappe.cloud`.

## Intent

Mutara's scouts should go into the avocado orchard and start recording straight away.
They pick a **Phase**, then a **Block**, and scout. The phone tracks GPS the whole time,
and every record carries its point. Nothing stops a record from being saved.

The block a scout picks is a starting label, not the truth. Once the farm's block
shapefile (`Trash/Docs/maps/blocks.zip`, 47 blocks, WGS84) is named and loaded, records
are placed onto the exact block from their GPS points. Being complete in the field matters
more than being exact at the moment of capture.

The app follows **Kaitet's Expo SDK 58 Scout app as the standard** (branch `kaitet-sdk58`).
It also takes on the mobile standards set on the livestock app (`upande-livestock-mutara`,
branch `mutara-beef-frappe16`).

## Goals

- A Mutara Scout build on Expo SDK 58, made from `kaitet-sdk58`, pointed at Mutara.
- Scouting is **Phase → Block**, chosen by hand as Kaitet does it. There is no
  GPS auto-pick.
- No restrictions on saving: every record is kept, with whatever GPS the phone has.
- Livestock mobile standards carried over (below).

## Non-goals (for now)

- **"Chappels"** (the user's next level below Block): later. The design leaves room
  for a level under Block (see the open item at the end) but builds none.
- **Pivot sub-levels:** none. A pivot is a group of blocks, its pizza slices, and is
  scouted as Pivot → Block. (Pivots were added to scope on 2026-11-18. See section 4b.)
- **Auto-selecting the block from GPS:** rejected by the user ("do as kaitet does").
- **Re-mapping records onto the shapefile blocks:** a later server-side job, once the
  shapefile blocks are named and loaded.

## Anti-goals

- A scout standing in a block is told they cannot save. That includes poor GPS,
  denied permission, a wrong phone clock, no fix, or no row picked.
- A Mutara build reaching Kaitet's phones, or a Kaitet build reaching Mutara's phones,
  through a shared runtime or update channel.
- The app breaking on a site that doesn't have `upande_mobile` installed.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | New branch `mutara-sdk58` from `kaitet-sdk58`; re-apply Mutara's few commits, the livestock standards and the Phase/no-restriction changes on top. | Starts from exactly what Kaitet runs; later Kaitet fixes come across cleanly. New branch name; `mutara-frappe16` stays as the fallback. |
| B | Merge `kaitet-sdk58` into `mutara-frappe16`. | Keeps the branch name. The SDK 54→58 merge touches the same package and app config Mutara changed, so it's messy and hard to check. |
| C | Stay on SDK 54 and port features. | Ruled out: the user set SDK 58 as the standard. |

The user handed over the choice; A is the call.

## What exists today (facts the design rests on)

- **`kaitet-sdk58`** is Expo `~58.0.24` on RN 0.88.1, runtime `2.0.0-kaitetfrappe16`.
  - It has a Block flow (`stationType` "Greenhouse" | "Block", built for Lokitela avocado),
    with words that follow the station type.
  - It tracks GPS in the foreground and background.
  - It does **not** have `@upande/mobile-kit`. The kit is only on `kaitet-frappe16`, which
    is SDK 54.
- **Kaitet refuses to save** in four cases (`getSubmitLocation` → `describeSubmitFailure`,
  tested in `src/services/__tests__/submitFix.test.ts`): `no-permission`, `accuracy` (over
  `CLEAN_ACCURACY_LIMIT_METERS`), `clock-skew`, and `no-fixes`. Separately, it insists on
  picking a row ("Please select block and row").
- **The Mutara server** (`mobile/get_farm_hierarchy_info`, `get_farm_data_bundle`, per the
  2026-10-28 design D4) sends the direct parents of stations as `sections`. On Mutara those
  are `Phase 1 - MUT` and `Phase 2 - MUT`, plus `Section A - MUT` for two demo blocks. It also
  sends `levels` and each station's `parent` and `crop`.
- **mutara.local** has 26 Phase blocks: 17 in Phase 1, 9 in Phase 2. It also has 1,255 rows
  and about 116k Orchard Trees, all generated from hand-drawn block shapes. Those shapes will
  be replaced by the shapefile.
- **The server never refuses on GPS.** `create_scouting_entry` stores `latitude`,
  `longitude` and `gps_accuracy`, and only uses them to match a zone or tree when a row
  is given.
- **Mutara-only commits on `mutara-frappe16`:**
  - `73c5925`: runtime `1.0.0-mutarafrappe16`, EAS channels, instance title.
  - `a456172`: own package so it installs beside Kaitet's; preview builds an APK.
  - `0075fd1`: app name "Upande Scp".
  - `83d85c8`: mobile-kit v0.18.1, release workflow, site `mutara.fsn.frappe.cloud`.

## Design

### 1. Branch and identity
- Create `mutara-sdk58` from `kaitet-sdk58`.
- Re-apply Mutara's identity:
  - app name "Upande Scp"
  - package `com.upande.scout.mutara`, iOS bundle id the same
  - instance title, and the Mutara site as the default server
- Set a new runtime, **`2.0.0-mutarafrappe16`**, and its own EAS channels and release
  repo, kept apart from Kaitet's.
- Native code changes going from SDK 54 to 58, so phones need a **new APK**; an OTA
  update can't deliver this. The version number goes past 1.0.10.

### 2. Mobile kit, SDK 58, and held off until the site has it
- Bring `@upande/mobile-kit` over, the same as livestock commit `edbdba8`. It covers the
  settings page, OTA and APK updates, device register, crash monitoring and support.
- The kit is only switched on when the signed-in site has `upande_mobile`. Its calls go
  through the app's own client.
- Use the kit build that works on SDK 58, as livestock does.

### 3. Livestock mobile standards
Port these from `upande-livestock-mutara`. The commit hashes are references; adapt rather
than copy, since the apps differ.
- **Kit through our theme (`27b7ca8`):** the kit's banners, toasts, and its Settings and
  Devices pages use the app's palette and font.
- **Connection dot:**
  - One fixed, continuously blinking online dot in the app bar's top right on every tab
    page (`ee038da`, `b63667f`).
  - It never moves, including when it turns orange.
  - The header dot and syncing bar replace the live-updates toast (`37a1020`, `ae4ee40`).
- **Frosted connection sheet:** a gradient blur backdrop, following steve228uk's
  GradientMaskedBlurHeader (`8cd77e2`), using expo-blur and masked-view. The user wants it
  to stay a gradient.
- **Logo:**
  - The login logo plays a short preview, eases back to the Upande mark and rests there,
    at 1.5 s each way.
  - The app icon is SCP's Upande mark (`upande_logo_no_bg.png`, `upande_logo.png`).
  - Scout already has `ScpLogo`. Keep its scene and give it the livestock timing.
- **Fast logout (`4cdfbdf`):** the app goes straight to login, and server sign-out and
  the local wipe finish in the background. Long names don't clip on small screens.
- **Themed alerts and date pickers (`f968270`, `ad36d02`):** only where Scout doesn't
  already have its own. `kaitet-sdk58` has `src/ui/alert.ts` and `src/ui/calendar.ts`.
  Keep Scout's and don't duplicate.

### 4. Phase → Block
- The first picker is **Phase** for a Mutara scout. Its label comes from the parent's
  `warehouse_type`, which the server already sends in `levels`, rather than being
  hard-coded. This keeps Kaitet's "Section" working unchanged.
- The second picker is **Block**, the blocks under the chosen Phase.
- Station type is Block. Greenhouse and bed UI stay hidden, as in Kaitet's Block flow.
- **Row:** optional. If the scout picks a row, the server matches a tree as it does today.
  If not, the record is saved against the block with its GPS point.

### 4b. Pivots and the crop follows the block (user, 2026-11-18)
Mutara scouts **avocado and fruit and vegetables**. The pivots are grouped into blocks.
- **The first picker** lists every direct parent of stations: `Phase 1`, `Phase 2`,
  `Pivot 1` to `Pivot 4`, plus the demo `Section A`.
  - The list is grouped under headings by `warehouse_type` (Phases, Pivots), each
    labelled from the type.
  - The second picker lists that parent's blocks: PH1-B…, or P1-B1 to P1-B12.
- **The crop comes from the block, not the scout's sign-in:**
  - Kaitet sets the crop once at configure (`userCrop`). On Mutara a pivot block's crop
    rotates by season. Today on mutara.local P1 holds Potato, Onion, Cabbage, Corn and
    Passion Fruit side by side.
  - When a block is picked, the crop becomes that station's `crop` from the bundle,
    resolved by the server through `planting.crops_for_stations` from the production
    crop cycle.
  - The pest, disease and plant-part lists then follow that crop, and the record's
    `crop_scouted` is that crop.
- **No crop resolved:** this is a fallow block, or a block with no cycle. Pivot 3 and 4
  are like this today.
  - The scout picks the crop from the farm's crops, so this is no restriction.
  - Each block shows its crop name next to it in the picker. Fallow blocks show "no crop".
- **Sync:** the station's crop is cached with the bundle for offline use. It's resolved
  for the day the bundle was fetched, which is fine because rotations change seasonally,
  not daily.
- **Rows and trees:** pivot blocks have rows (about 50 per block in Pivots 1 and 2) and
  no trees. The row is optional, as for avocado.

### 5. No restrictions on saving
- Never refuse a scouting record for `no-permission`, `accuracy`, `clock-skew` or
  `no-fixes`.
- Save with the best point the buffer has. If no point exists, save without coordinates.
- Always send `accuracy`, and add a **location quality** flag to the record:
  - `good`: within Kaitet's clean limit
  - `coarse`: over the limit
  - `none`: no fix
  - `clock-skew`
- Use a field on the existing scout metadata, so the later re-mapping job knows which
  points to trust.
- **Warnings:** the scout sees a small, non-blocking note ("weak GPS, saved anyway")
  instead of a refusal dialog.
- **Permission:** still asked for at sign-in. If it's denied, the app still scouts.
- This behaviour is for Mutara only. Kaitet's gate stays as it is, controlled by a per-site
  setting the server sends (default: Kaitet's behaviour). It isn't forked in code.

### 6. GPS tracking
- Unchanged from Kaitet: foreground watcher, background updates and the watchdog.
- The point stored on each record is the one already sent today (`latitude`, `longitude`,
  `accuracy`).

## Server changes (upande_scp `mutara`)
- **The setting:** e.g. "Scouting: save without a good GPS fix", on Scouting and Crop
  Protection Settings. It's sent in the data the phone already fetches. On for Mutara, off
  by default.
- **The quality flag:** accept it and store it on scout metadata, next to `gps_accuracy`.
- **Coordinates optional:** `Scouting Entry.latitude` and `longitude` are `reqd: 1` today.
  - Make them optional, through a Property Setter or a JSON change on the `mutara` branch,
    so a no-fix record can be saved.
  - Check every reader of those fields for a null guard: maps, zone matching, the
    gallery and reports.
- **Row optional:** in `create_scouting_entry`, `row` is already optional. Confirm a
  Block station with no row and no point goes through end to end.

## Calls made after the builder check
- **Row-less and point-less records in reports (my call):**
  - They count in the per-ha block numbers and the Monday per-ha email. Those are keyed
    on the block.
  - They don't feed per-tree hot spots until the shapefile re-mapping places them. Those
    need a tree.
  - This matches the user's "map it later".
- **Record date when the clock is skewed (my call):** use the app's skew-corrected site
  time. `kaitet-sdk58` already has `src/services/siteClock.ts`. The flag still says
  `clock-skew` so the point can be weighed later.
- **Before the setting arrives (my call):**
  - Scouting needs a signed-in session, so the setting is always fetched first.
  - It's cached for offline use.
  - If it's missing (an older server), the app falls back to Kaitet's gate. That keeps
    one code path, and the per-site setting controls behaviour, not the build.
- **Build identity (from the project):**
  - Keep what `mutara-frappe16` already uses:
    - package and bundle id `com.upande.scout.mutara`
    - EAS project `d6fc6264-…` with channels `preview-` and `production-mutarafrappe16`
    - OTA from `mutara.fsn.frappe.cloud` through `upande_mobile`
  - The same package and the same EAS signing key mean the new APK installs over the old
    one. Only the runtime changes, to `2.0.0-mutarafrappe16`.
- **Rollout order (my call):**
  1. Server change first: deploy and migrate on `mutara.fsn.frappe.cloud`.
  2. Then the APK.
  3. Scouts open the old app and let it sync before installing the new one, so nothing
     queued is lost.
  - The app only sends the quality flag when the server's setting is present, so a
    server that hasn't been migrated never sees an unknown field.
- **Phase label (confirmed):** `get_farm_hierarchy_info.derive_levels` sends
  `{name, warehouse_name, warehouse_type, parent}`. The two demo blocks under
  `Section A - MUT` are listed under that Section like any other parent. The label comes
  from the type, so they show as a Section.

## Testing
- Unit tests in the app's existing style (`src/services/__tests__`):
  - the save-anyway decision for each of the four former refusal reasons
  - the quality flag
  - the Phase label coming from `levels`
- Server tests on mutara.local, one run at a time:
  - a Block record with no row
  - no coordinates
  - a coarse fix
  - the setting off, which keeps Kaitet's behaviour
- Device check through an Expo dev or preview build against mutara.local: pick Phase,
  pick Block, save with GPS off, save with GPS on.

## Left to the builder
- Exact names for the setting and the quality field.
- Copy for the non-blocking GPS note.
- How much of the livestock code moves as is versus adapted.
- Commit order. Keep the identity and runtime commits first, so a build exists early.

## Open (later, not in this build)
- "Chappels" below Block: the name, and whether it's a Warehouse level or a Bed-like
  unit.
- Naming the 47 shapefile blocks, the PH2-B2/B4/B7 split question, and the re-mapping job.

## Addendum (user, 2026-11-18): no row/bed picking — map from GPS

User: make the row option disappear behind a setting; let the scout scout freely, and map
each entry to the nearest point on the sub-level (block → row → tree; greenhouse → bed →
zone). If it can't be mapped, the entry shows a read-only field saying "To be mapped".

- **Setting** `scouts_pick_unit` (Check, default **1** = today's Kaitet behaviour), label
  "Scouts pick the row / bed", on Scouting and Crop Protection Settings next to
  `save_without_gps_fix`; sent on `getFarmHierarchyInfo` as `scouts_pick_unit: bool`
  (missing key → true). Off for Mutara.
- **App:** when `scouts_pick_unit` is false, the row/bed picker and its column/header are
  hidden and never required; the scout picks Phase/Pivot → Block (or Greenhouse) only. When
  true or missing, unchanged.
- **Server mapping** in `createScoutingEntry`, only when no row/bed is sent and the entry has
  coordinates and accuracy:
  - Block station: nearest Orchard Tree within the block (its `row` filled from the tree),
    else nearest row (Bed with `greenhouse` = block) when the block has rows but no trees.
  - Greenhouse station: nearest zone/bed within the greenhouse.
  - Search radius as `get_zone_from_coordinates` uses today (buffer max(3, min(acc, 50)) m);
    outside it → not mapped.
- **Read-only status** `mapping_status` (Select: `Mapped` / `To be mapped`, read-only) on
  Scouting Entry, shown on the desk form. `Mapped` when a tree/row/zone was set (by the scout
  or by GPS); `To be mapped` otherwise (no point, coarse beyond range, or no geometry). The
  shapefile re-mapping job later works from `To be mapped` entries.
- Entries without a unit still count in per-block numbers (unchanged rule).
- **User, 2026-11-18 (follow-up):** "when the level is turned off we don't have to see [it]
  on the app, we can just see entries". With `scouts_pick_unit` off, the app shows no
  row/bed level anywhere on the scouting screen — no row picker, no row/bed grid, no
  odd/even or bed-progress views. In their place the scout sees the **entries** they have
  recorded for the current block today (newest first: time, pest/disease or observation,
  count, and a read-only status "To be mapped" until the server reports it mapped; queued
  offline entries show "Waiting to sync").
- **User, 2026-11-18 (rule):** "if the app does not find beds, rows or bands it does not show
  the option to select them". Independently of `scouts_pick_unit`: when the current station
  has no beds/rows/bands in the phone's data, the unit picker (and its header/grid) is hidden
  and no unit is required — the scout records against the station and the entries list is
  shown, exactly as when the setting is off. Applies to every site (Kaitet too): a station
  with no units can't be scouted today, so hiding the picker there only removes a dead end.
