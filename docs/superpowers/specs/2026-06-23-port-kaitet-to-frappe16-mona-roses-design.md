# Port kaitet → frappe16/mona (roses-only)

**Date:** 2026-06-23
**Author:** james@upande.com (with Claude)
**Status:** Design — pending review

## Goal

Make the `upande_scp` app in `~/stive/code/frappe16/apps/upande_scp` (branch `mona`,
site `mona.local`) equal to the current `kaitet` branch app from
`~/stive/code/frappe15/apps/upande_scp`, with **all avocado-specific code stripped**, so
frappe16/mona becomes a **roses-only** app whose schema migrates cleanly against the
`mona.local` database.

## Context

- frappe15 (source) is on branch `kaitet`; frappe16 (target) is on branch `mona`.
- Both directories are clones of the **same** upstream repo (`mark-judah/UpandeScp`), but
  the branches have diverged heavily in **both** directions (~40 commits each since merge
  base `3569c4e`, PR #35). A `git merge` would be conflict-heavy and re-introduce avocado.
- Full-tree diff `mona…kaitet` ≈ 666 files / ~111k insertions.
- Frontend builds with `vite build` → `upande_scp/public/dist` (base
  `/assets/upande_scp/dist/`). The compiled `dist` must be **rebuilt** in frappe16, not
  copied.
- `hooks.py` declares no frappe version pin; v15→v16 incompatibilities will surface at
  build / `bench migrate` time and are verified there.

## Decisions (confirmed with user)

1. **Roses scope:** strip avocado out entirely; frappe16/mona is a roses-only app.
2. **Integration mechanism:** port everything (snapshot the kaitet tree over mona), not a
   git merge or cherry-pick.
3. **mona pending local changes:** commit them first (their own commit on `mona`), then
   port on top.
4. **DB alignment target:** local `mona.local`, **migrate-clean**. Orphaned tables are
   acceptable in principle.
5. **Keep `crop_husbandry_practices`:** mona's crop-husbandry feature is preserved (not a
   pure snapshot — see Re-graft section).
6. **One clean commit:** the port collapses kaitet's WIP history into a single
   "port from kaitet (roses-only)" commit on `mona`.

## Sequence of operations

1. **Commit mona's pending local changes** as their own commit on `mona`:
   `upande_scp/patches.txt`, `serverscripts/mobile/create_scouting_entry.py`,
   `doctype/scouting_entry_metadata/scouting_entry_metadata.json`,
   `www/spray_plan_approval.py`, and the new `upande_scp/patches/` dir.
2. **Wire frappe15 as a local git remote** in frappe16 and fetch kaitet:
   `git remote add local15 /home/ubuntu/stive/code/frappe15/apps/upande_scp`
   `git fetch local15 kaitet`.
3. **Snapshot the kaitet tree** over the app: bring kaitet's version of every tracked path
   (`git checkout local15/kaitet -- upande_scp frontend …`). For files present in both,
   kaitet's version wins.
4. **Preserve crop_husbandry** (re-graft, see below) — do NOT let the snapshot delete its
   doctype dirs, and re-apply its integration onto kaitet's versions of the shared files.
5. **Strip avocado** (see below).
6. **Rebuild frontend** in frappe16: `cd frontend && npm install && npm run build` →
   fresh `public/dist`.
7. **Migrate & verify** on `mona.local`.
8. **Commit** the port as one squashed commit on `mona`.

## Avocado strip

Two kinds of removal — both required; the result must compile and migrate clean.

**Delete avocado-only files:**
- Frontend: `frontend/src/pages/avocado/` (AvocadoJobSheets.tsx), `pages/AvocadoMap.tsx`.
- Doctypes: `orchard_tree`, `tree_and_row_automation`.
- Serverscripts: `populate_avocado.py`, `get_avocado_scouting.py`, `get_orchard_trees.py`,
  `run_tree_automation.py`.

**Surgically remove avocado branches from shared files** (keep the crop-namespaced routing
infrastructure; default roses as the only crop):
- Frontend: `lib/router.ts`, `components/AppSidebar.tsx`, `App.tsx`,
  `components/Map3D.tsx`, `components/settings/FarmMapTab.tsx`,
  `components/settings/ThresholdsTab.tsx`, `pages/Dashboard.tsx`,
  `pages/dashboard/OverviewTab.tsx`, `pages/Trends.tsx`, `pages/maps/MapHeader.tsx`,
  `pages/maps/TreesLayer.ts`, `pages/trends/ChartPanel.tsx`, `pages/trends/aggregate.ts`,
  `lib/scouting-api.ts`, `pages/Heatmaps.tsx`, `pages/Observations.tsx`,
  `pages/TrapsMap.tsx`.
- Backend: `hooks.py`, and avocado branches in shared serverscripts
  (`scouting_metrics.py`, `scouting_metrics_api.py`, `weather.py`, `cache_utils.py`,
  `dashboard_aggregates/_trends.py`, `get_scouting_analysis.py`,
  `populate_severity_defaults.py`, `get_tanks_valves.py` — verify each: remove only the
  avocado path, keep rose logic).

**Tests:** update `components/__tests__/AppSidebar.test.tsx` and
`pages/trends/__tests__/niceCeil.test.ts` for avocado removal; they must pass.

The strip is the highest-risk step: removal is surgical inside shared files, not just file
deletes.

## Preserve crop_husbandry (re-graft)

Keep the doctype dirs `doctype/crop_husbandry_practices` and
`doctype/crop_husbandry_practices_entry`. Because kaitet's versions of the shared files
below do not contain the crop-husbandry hooks, re-apply mona's crop_husbandry integration
onto kaitet's versions of:
- `serverscripts/get_scouting_report.py`
- `serverscripts/mobile/create_scouting_entry.py`
- `serverscripts/send_daily_scouting_report.py`
- `serverscripts/mobile/get_observations_details.py`
- `doctype/scouting_entry/scouting_entry.json` (the crop-husbandry field)

Diff mona's version of each against kaitet's, isolate the crop_husbandry additions, and
apply only those onto the kaitet version. Verify the field appears on Scouting Entry after
migrate.

## Database alignment (`mona.local`, migrate-clean)

- New kaitet doctypes (all `*_filter`, `stage`, `chemical_transfer_request*`, `spray_*`,
  `tank_and_valve`, `chemical_stock_baseline`, `farm_*`, `crop_modelling_entry`,
  `crop_scouted`, `custom_spray_plan_team_member`, `block_sectors`,
  `farm_map_coordinate`, `work_order_chemical_scan`, etc.) are created by `bench migrate`.
- crop_husbandry tables remain (preserved).
- Acceptance: `bench --site mona.local migrate` runs clean (no exceptions), the site
  boots, and core rose flows load.

## Verification

- `cd frontend && npm install && npm run build` succeeds (catches v16 / TS breakage).
- Frontend unit tests pass (`npm run test` if configured) — at minimum the two touched
  test files.
- `bench --site mona.local migrate` runs clean.
- App loads at its route; **no** avocado nav entries, routes, or pages remain; rose pages
  (scouting dashboard, heatmaps, maps, spray plan approval) render.
- Crop Husbandry Practices field present on Scouting Entry.
- `grep -rni avocado frontend/src upande_scp` returns nothing functional (only incidental
  strings if any, reviewed).

## Out of scope

- No git merge / cherry-pick; no preservation of kaitet's granular commit history.
- No migration of live Mona production data (local `mona.local` only).
- No new features; this is a port + strip only.
- No unrelated refactoring of either branch.

## Risks

- **Surgical avocado removal** breaking rose logic in shared files — mitigated by build +
  migrate + visual verification.
- **v15→v16 framework drift** — surfaces at build / migrate; addressed reactively if it
  appears.
- **crop_husbandry re-graft** missing a hook — mitigated by diffing mona vs kaitet per
  file and verifying the field post-migrate.
