# One farm and greenhouse picker — design

Date: 2026-10-12. UI polish, part 4 ("how selection happens"). Built lean: one build, then one review.

## What the user asked for

"Start with the farm and greenhouse pickers": how selection happens and how it looks. The pickers should be one consistent thing across SCP.

## Facts (inventory, 2026-10-12)

There are about 30 farm, greenhouse or avocado block pickers.

- **Separate controls.** Most pages use two plain Radix Selects, Farm and Greenhouse. With "All Farms" chosen, the greenhouse list shows every greenhouse (20–80+), and nothing can be searched. Only Heatmaps and Trends (`TristateTree`, multi-select) have search.
- **Mixed wording.**
  - Farm: "All Farms", "All farms", "All my farms".
  - Greenhouse: "All Greenhouses", "All Houses", "All".
- **Names shown three ways:** "Chepsito GH 16 - KR", "Chepsito GH 16" or "GH 16". There are four private copies of the shortening logic: `shortGreenhouse`, `shortHouse`, `ghShort`, and `farmOf` (which guesses the farm with a regex).
- **Cascades differ.**
  - Most pages show the union of all greenhouses when "All" is chosen.
  - Approvals disables the greenhouse picker until a farm is picked.
  - Historical matches greenhouses to a farm by substring.
  - TrapsMap's greenhouse list ignores the farm.
- **Single-farm users.** Some pages hide the picker, others always show it.
- **Nothing is remembered.** No page keeps the farm or greenhouse in local storage or the URL, so every visit starts again.
- **Farm sources.**
  - Most pages: `useCropFarms(crop)` (`get_farms_and_warehouses`, scoped to the crop and the user).
  - Several pages use their own payload's `farms`.
  - Approvals: `fetchFarmsAndGreenhouses`.
  - ApplicationPlan: the creator bootstrap.
  - Loaning and Procurement: `fetchMyFarms`.
- `pages/maps/SingleDayHeader.tsx` has no consumers.

## Decisions

| # | Decision |
|---|---|
| G1 | **One control, `PlacePicker`** (`components/PlacePicker.tsx`). It is a single pill (the `HEADER_PILL` look) that opens a popover. The popover has:<br>• a search box at the top, focused on open;<br>• "All farms";<br>• each farm as a row, with its greenhouses indented beneath it, written short ("GH 16").<br>Picking a farm row filters to the farm; picking a greenhouse filters to that house (and its farm).<br>**The pill reads:** "All farms" · "Chepsito" · "Chepsito · GH 16".<br>**Search** matches farm and greenhouse names, ignoring case and spaces ("gh16", "chep 16"). A matched greenhouse keeps its farm row visible as a header.<br>**Keyboard:** ↑/↓ move, Enter picks, Esc closes; listbox and option roles.<br>It replaces the farm and greenhouse Select pair wherever a page filters by both. |
| G2 | **`level` prop.**<br>• `"farm"`: farms only. Use it where a page filters by farm alone: Coverage, Scouts, Schedule, Labels, TankMixes, ChemicalProgress, CreatorStock, Procurement, Loaning "my farm". It has the same pill and search, without the house rows.<br>• `"greenhouse"`: a greenhouse must be chosen; there is no "All", and farm rows are headers only. Use it for the ApplicationPlan diagnose step, in the `variant="field"` boxed form style. |
| G3 | **One wording, sentence case:** "All farms", "All greenhouses". Greenhouse names are written by one shared helper, `lib/places.ts`:<br>• `shortHouse(name, farm)` → "GH 16" (drops the " - KR" company suffix and the farm prefix);<br>• `houseLabel(name, farm)` → "Chepsito · GH 16".<br>The full warehouse name stays the value and appears as the option's title/tooltip. The four private copies are replaced. `farmOf` uses the farm data, not the name. |
| G4 | **Remembered per crop.** The last farm and greenhouse picked on any page is kept per crop in `localStorage` (`scp.place.<crop>`, wrapped in try/catch) and is where the next page starts. Pick Chepsito on the Dashboard and Gallery, Coverage and the maps open on Chepsito. A remembered value the current page doesn't offer falls back to "All farms" (or the page's own default) and does not overwrite the stored value. A `remember={false}` prop opts out (dialogs, settings). |
| G5 | **Single-farm users:** the pill shows the farm and is not openable at farm level (it still opens for greenhouses at `level` "both"). It is never hidden, so the header layout is the same for every user. |
| G6 | **Data.** `PlacePicker` takes `farms: Record<farm, greenhouse[]>`, the `useCropFarms` shape, or a farm list for `level="farm"`. Pages keep their current source; there are no endpoint changes. Historical's substring match and ChemicalProgress's regex are replaced by real farm→house data where the page has it, otherwise by `lib/places.ts` matching on the farm prefix. |
| G7 | **Multi-select stays separate.** The multi-select pickers stay as they are: Heatmaps and Trends `TristateTree`, and TrapsMap `MultiPicker`. They get the shared names (`shortHouse`) and wording only. A later piece can unify them. |
| G8 | **Out of scope:**<br>• the user's uncommitted Transfers files (`SprayPlanTransfers.tsx`, `TransferBatchPanel.tsx`, `store-keeper-api.ts`);<br>• settings "Add farm" pickers and the per-team farm field;<br>• Reports and BlockWeeklyReport form fields (labelled forms; their farm lists are short);<br>• avocado block picking (map-driven).<br>`SingleDayHeader.tsx` is deleted as dead code. |

## Testing

- **Vitest for `PlacePicker`:**
  - search ("gh16" finds "Chepsito GH 16 - KR");
  - picking a farm vs a house;
  - keyboard navigation;
  - the pill text;
  - single-farm behaviour;
  - `level="farm"` and `level="greenhouse"`;
  - remember and restore per crop;
  - fallback when the remembered value is missing;
  - storage that throws.
- **Vitest for `lib/places.ts`.**
- Existing page tests updated where they drove the old Selects.
- The full suite, tsc and `yarn build` pass, and the no-native-dropdowns guard stays green.
- **Browser check** on kaitet.local: Dashboard, then Gallery, keeps Chepsito; ApplicationPlan greenhouse search.
