# Port kaitet → frappe16/mona (roses-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frappe16 `upande_scp` app (branch `mona`, site `mona.local`) equal to the kaitet branch app with all avocado code stripped, crop_husbandry preserved, migrating cleanly — landed as one clean commit.

**Architecture:** Snapshot the kaitet file tree into the frappe16 clone via a local git remote (true snapshot: tree == kaitet, keep-list = crop_husbandry only), re-graft crop_husbandry integration onto kaitet's shared files, surgically strip avocado from shared files and delete avocado-only files, rebuild the Vite frontend, then verify `bench migrate` on `mona.local`.

**Tech Stack:** Frappe v16 (Python), React + Vite + TypeScript frontend, Vitest, git, bench.

## Global Constraints

- All work happens in `/home/ubuntu/stive/code/frappe16/apps/upande_scp` on branch `mona`. (frappe15 is read-only source.)
- Source of truth tree: `local15/kaitet` (frappe15's kaitet branch fetched as a local remote).
- Roses-only: no avocado nav, routes, pages, doctypes, or serverscripts may remain.
- crop_husbandry_practices feature MUST be preserved (doctype dirs + integration hooks).
- DB target: `mona.local`, **migrate-clean** (no exceptions); orphaned tables acceptable.
- Final result is **one** squashed "port from kaitet (roses-only)" commit on `mona`, preceded by one commit capturing mona's pre-existing pending changes.
- **Per-task commits are WIP checkpoints.** Each task (2–8) ends by committing its work as `wip(port): task N - <summary>` so each task is independently reviewable as a commit range. Task 9 squashes all WIP commits into the single clean port commit via `git reset --soft`. The Task 1 pending-changes commit stays separate and is NOT squashed.
- Do NOT add a `Co-Authored-By` trailer to any commit (repo rule).
- Do NOT push. Commit only as the plan specifies.
- Vite build: `npm run build` → `upande_scp/public/dist` (rebuild, never copy stale dist).
- Frontend tests run with `npx vitest run` (no `test` npm script defined).

---

### Task 1: Commit mona's pending local changes

**Files:**
- Modify (already dirty): `upande_scp/patches.txt`, `upande_scp/serverscripts/mobile/create_scouting_entry.py`, `upande_scp/upande_scp/doctype/scouting_entry_metadata/scouting_entry_metadata.json`, `upande_scp/www/spray_plan_approval.py`
- Add (untracked): `upande_scp/patches/`

- [ ] **Step 1: Confirm branch and review the dirty state**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git rev-parse --abbrev-ref HEAD   # expect: mona
git status -s
git diff --stat
```
Expected: branch `mona`; the 4 modified files + untracked `upande_scp/patches/`.

- [ ] **Step 2: Stage and commit them as their own commit**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git add -A
git commit -m "chore(mona): commit pending local changes before kaitet port"
```
Expected: clean working tree afterward (`git status -s` empty).

- [ ] **Step 3: Verify**

Run: `git status -s` → empty. `git log --oneline -1` → shows the new commit.

---

### Task 2: Wire frappe15 as a local remote and snapshot the kaitet tree

**Files:**
- Whole app tree: `upande_scp/`, `frontend/`, plus repo-root files tracked on kaitet.

**Interfaces:**
- Produces: a working tree equal to `local15/kaitet` for all paths, except the crop_husbandry keep-list which is restored from `mona`.

- [ ] **Step 1: Add the local remote and fetch kaitet**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git remote add local15 /home/ubuntu/stive/code/frappe15/apps/upande_scp 2>/dev/null || git remote set-url local15 /home/ubuntu/stive/code/frappe15/apps/upande_scp
git fetch local15 kaitet
git rev-parse local15/kaitet   # sanity: prints a sha
```
Expected: fetch succeeds; sha printed.

- [ ] **Step 2: Confirm the crop_husbandry keep-list exists on mona**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git ls-tree -r --name-only mona -- \
  upande_scp/upande_scp/doctype/crop_husbandry_practices \
  upande_scp/upande_scp/doctype/crop_husbandry_practices_entry
```
Expected: lists the crop_husbandry doctype files (restored from `mona` in Step 4 — no temp file needed since `mona` is the source).

- [ ] **Step 3: Make the tree a true snapshot of kaitet**

Read kaitet's tree into the index and working tree for the app, removing files not present in kaitet:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git read-tree -u --reset local15/kaitet
```
This sets index + working tree exactly to kaitet's tree (deletes mona-only files including crop_husbandry — restored next step). HEAD stays on `mona`.

Expected: `git status -s` shows many staged changes; mona-only files now deleted.

- [ ] **Step 4: Restore the crop_husbandry keep-list from mona**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git checkout mona -- \
  upande_scp/upande_scp/doctype/crop_husbandry_practices \
  upande_scp/upande_scp/doctype/crop_husbandry_practices_entry
ls upande_scp/upande_scp/doctype/crop_husbandry_practices upande_scp/upande_scp/doctype/crop_husbandry_practices_entry
```
Expected: both doctype dirs present with their files.

- [ ] **Step 5: Sanity-verify the snapshot**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
# These mona-only flat files must now be GONE (kaitet restructured/deleted them):
ls upande_scp/www/variety_map.html upande_scp/www/scouts_map.py upande_scp/www/spray_plan_approval.css 2>&1 | grep -c "No such file"
# kaitet-only dirs must be PRESENT:
ls -d upande_scp/www/variety_map upande_scp/www/tank_mix_list upande_scp/www/scouting_trends
```
Expected: count `3` (all three flat files gone); the three kaitet www dirs listed.

- [ ] **Step 6: Commit the snapshot as a WIP checkpoint**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git add -A
git commit -m "wip(port): task 2 - snapshot kaitet tree, keep crop_husbandry"
```
Expected: one WIP commit (squashed in Task 9).

---

### Task 3: Re-graft crop_husbandry integration onto kaitet's shared files

**Files:**
- Modify: `upande_scp/serverscripts/get_scouting_report.py`
- Modify: `upande_scp/serverscripts/mobile/create_scouting_entry.py`
- Modify: `upande_scp/serverscripts/send_daily_scouting_report.py`
- Modify: `upande_scp/serverscripts/mobile/get_observations_details.py`
- Modify: `upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json`

**Interfaces:**
- Consumes: crop_husbandry_practices / crop_husbandry_practices_entry doctypes (restored in Task 2).
- Produces: kaitet's versions of the 5 files above, augmented with mona's crop_husbandry hooks.

- [ ] **Step 1: Extract mona's crop_husbandry additions per file**

For each file, diff mona vs the current (kaitet) version to see exactly what crop_husbandry lines mona added:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
for f in \
  upande_scp/serverscripts/get_scouting_report.py \
  upande_scp/serverscripts/mobile/create_scouting_entry.py \
  upande_scp/serverscripts/send_daily_scouting_report.py \
  upande_scp/serverscripts/mobile/get_observations_details.py \
  upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json ; do
  echo "===== $f ====="; git diff mona -- "$f" | grep -niE "husbandry|crop_husband" ; done
```
Expected: prints the crop_husbandry-referencing hunks that differ between mona and kaitet.

- [ ] **Step 2: For each file, view mona's full crop_husbandry usage in context**

Run (repeat per file):
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git show mona:upande_scp/serverscripts/get_scouting_report.py | grep -n -B3 -A6 -iE "husbandry"
```
Repeat the `git show mona:<path> | grep -n -B3 -A6 -iE "husbandry"` for each of the 5 files. For `scouting_entry.json`, look for the fieldname linking to Crop Husbandry Practices (e.g. a `Table`/`Link`/`Table MultiSelect` field with `options` referencing crop husbandry) and its entry in `field_order`.

- [ ] **Step 3: Apply only the crop_husbandry additions onto the kaitet version**

Edit each of the 5 files in place, inserting mona's crop_husbandry lines (the fetch/serialize/field code identified above) into the current kaitet version — without reverting any kaitet logic. For `scouting_entry.json`, add the crop_husbandry field object back into `fields` and its name into `field_order` (keep all kaitet fields).

- [ ] **Step 4: Syntax-check the Python edits**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
python -m py_compile \
  upande_scp/serverscripts/get_scouting_report.py \
  upande_scp/serverscripts/mobile/create_scouting_entry.py \
  upande_scp/serverscripts/send_daily_scouting_report.py \
  upande_scp/serverscripts/mobile/get_observations_details.py
python -c "import json; json.load(open('upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json'))"
```
Expected: no output / no errors (all compile; JSON valid).

- [ ] **Step 5: Verify crop_husbandry still referenced where expected**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
grep -rni "husbandry" upande_scp/serverscripts upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json | wc -l
```
Expected: > 0 (hooks present).

- [ ] **Step 6: Commit as a WIP checkpoint**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git add -A && git commit -m "wip(port): task 3 - re-graft crop_husbandry integration"
```

---

### Task 4: Delete avocado-only files

**Files (delete):**
- `frontend/src/pages/AvocadoMap.tsx`
- `frontend/src/pages/avocado/` (entire dir — `AvocadoJobSheets.tsx`)
- `upande_scp/upande_scp/doctype/orchard_tree/`
- `upande_scp/upande_scp/doctype/tree_and_row_automation/`
- `upande_scp/serverscripts/populate_avocado.py`
- `upande_scp/serverscripts/get_avocado_scouting.py`
- `upande_scp/serverscripts/get_orchard_trees.py`
- `upande_scp/serverscripts/run_tree_automation.py`

- [ ] **Step 1: Delete the avocado-only files**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git rm -r \
  frontend/src/pages/AvocadoMap.tsx \
  frontend/src/pages/avocado \
  upande_scp/upande_scp/doctype/orchard_tree \
  upande_scp/upande_scp/doctype/tree_and_row_automation \
  upande_scp/serverscripts/populate_avocado.py \
  upande_scp/serverscripts/get_avocado_scouting.py \
  upande_scp/serverscripts/get_orchard_trees.py \
  upande_scp/serverscripts/run_tree_automation.py
```
Expected: each path removed (git reports `rm`).

- [ ] **Step 2: Check hooks.py for references to the deleted serverscripts**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
grep -niE "populate_avocado|get_avocado|get_orchard|run_tree_automation|orchard_tree|tree_and_row" upande_scp/hooks.py
```
Expected: any matches here will be removed in Task 6 (scheduler events / whitelisted methods). Note them.

- [ ] **Step 3: Commit as a WIP checkpoint**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git add -A && git commit -m "wip(port): task 4 - delete avocado-only files"
```

---

### Task 5: Strip avocado branches from shared frontend files

**Files (modify — remove avocado branches, keep rose logic + crop-routing infra):**
`frontend/src/lib/router.ts`, `frontend/src/components/AppSidebar.tsx`, `frontend/src/App.tsx`, `frontend/src/components/Map3D.tsx`, `frontend/src/components/settings/FarmMapTab.tsx`, `frontend/src/components/settings/ThresholdsTab.tsx`, `frontend/src/pages/Dashboard.tsx`, `frontend/src/pages/dashboard/OverviewTab.tsx`, `frontend/src/pages/Trends.tsx`, `frontend/src/pages/maps/MapHeader.tsx`, `frontend/src/pages/maps/TreesLayer.ts`, `frontend/src/pages/trends/ChartPanel.tsx`, `frontend/src/pages/trends/aggregate.ts`, `frontend/src/lib/scouting-api.ts`, `frontend/src/pages/Heatmaps.tsx`, `frontend/src/pages/Observations.tsx`, `frontend/src/pages/TrapsMap.tsx`

- [ ] **Step 1: Remove the avocado imports/routes/pages first (these break the build loudest)**

Edit `App.tsx` and `lib/router.ts`: remove `import AvocadoMap` and `import AvocadoJobSheets` (now-deleted), remove their route entries, and remove `avocado` from any crop list/enum so roses is the only crop. Keep the crop-namespaced routing machinery (`#/<crop>/<view>`) intact with `roses` as the sole crop.

Edit `AppSidebar.tsx`: remove avocado entries from `navForCrop` (and its test expectations are handled in Task 7).

- [ ] **Step 2: Remove avocado branches from the remaining shared files**

For each file, locate avocado conditionals and remove only the avocado path:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp/frontend
grep -rniE "avocado" src --include=*.tsx --include=*.ts -n
```
For every hit: if the whole block/branch is avocado-specific (e.g. `if (crop === 'avocado') {...}`, an avocado `case`, an avocado-only component/legend/dataset), delete that block; if it's a ternary or list element, drop the avocado arm/element; keep the roses arm. Do not delete shared scaffolding.

- [ ] **Step 3: Type-check / build to catch breakage**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp/frontend
npm install
npm run build
```
Expected: `tsc -b && vite build` succeeds with no errors. Fix any "avocado is not defined" / unused-import / missing-case errors by completing the removal in the offending file, then re-run.

- [ ] **Step 4: Confirm no functional avocado refs remain in frontend**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp/frontend
grep -rniE "avocado" src --include=*.tsx --include=*.ts | grep -v "__tests__"
```
Expected: empty (or only incidental review-OK strings).

- [ ] **Step 5: Commit as a WIP checkpoint**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git add -A && git commit -m "wip(port): task 5 - strip avocado from shared frontend"
```

---

### Task 6: Strip avocado branches from shared backend files

**Files (modify):** `upande_scp/hooks.py`, and avocado branches in shared serverscripts: `upande_scp/serverscripts/scouting_metrics.py`, `scouting_metrics_api.py`, `weather.py`, `cache_utils.py`, `dashboard_aggregates/_trends.py`, `get_scouting_analysis.py`, `populate_severity_defaults.py`, `get_tanks_valves.py` (verify each).

- [ ] **Step 1: Find every backend avocado reference**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
grep -rniE "avocado|orchard|tree_and_row|populate_avocado" upande_scp --include=*.py -n
```
Expected: a list of hits across hooks.py and the shared serverscripts.

- [ ] **Step 2: Remove avocado from hooks.py**

Edit `upande_scp/hooks.py`: remove any scheduler events, `doc_events`, fixtures entries, or whitelisted-method registrations that point at the deleted avocado serverscripts/doctypes (`populate_avocado`, `get_avocado_scouting`, `get_orchard_trees`, `run_tree_automation`, `orchard_tree`, `tree_and_row_automation`). Leave all rose entries.

- [ ] **Step 3: Remove avocado branches from shared serverscripts**

For each Python file with hits: remove avocado-only functions and the avocado arm of any `if crop == "avocado"` / crop-dispatch branches, keeping the roses path. Where a function is purely avocado (e.g. tree automation helper), delete it.

- [ ] **Step 4: Syntax-check all modified backend files**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
python -m compileall -q upande_scp/hooks.py upande_scp/serverscripts
```
Expected: no errors.

- [ ] **Step 5: Confirm no avocado refs remain in backend**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
grep -rniE "avocado|orchard_tree|tree_and_row" upande_scp --include=*.py --include=*.json | grep -v "doctype/crop_husbandry"
```
Expected: empty.

- [ ] **Step 6: Commit as a WIP checkpoint**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git add -A && git commit -m "wip(port): task 6 - strip avocado from shared backend"
```

---

### Task 7: Fix frontend tests and confirm a clean build

**Files:**
- Modify: `frontend/src/components/__tests__/AppSidebar.test.tsx`, `frontend/src/pages/trends/__tests__/niceCeil.test.ts`

- [ ] **Step 1: Run the test suite to see avocado-related failures**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp/frontend
npx vitest run
```
Expected: failures in tests that assert avocado nav/crop behavior.

- [ ] **Step 2: Update the tests to roses-only expectations**

Edit `AppSidebar.test.tsx`: remove assertions that the sidebar renders avocado nav for an avocado crop; keep/adjust assertions to roses nav. Edit `niceCeil.test.ts` only if it references avocado datasets — drop those cases, keep the numeric-behavior cases.

- [ ] **Step 3: Re-run tests**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp/frontend
npx vitest run
```
Expected: all pass.

- [ ] **Step 4: Final production build (regenerate dist)**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp/frontend
npm run build
ls ../upande_scp/public/dist
```
Expected: build succeeds; `public/dist` contains fresh assets.

- [ ] **Step 5: Commit as a WIP checkpoint**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git add -A && git commit -m "wip(port): task 7 - fix tests, rebuild frontend dist"
```

---

### Task 8: Migrate mona.local and verify rose flows

**Files:** none (deploy + verify).

- [ ] **Step 1: Ensure the app is installed and migrate**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local migrate
```
Expected: completes with no traceback. New kaitet doctypes created; crop_husbandry tables retained. If migrate errors on a v16 incompatibility, fix the offending app code (record the fix) and re-run until clean.

- [ ] **Step 2: Confirm key doctypes exist and crop_husbandry survived**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local console <<'PY'
import frappe
for dt in ["Pest Filter","Disease Filter","Stage","Tank And Valve","Crop Husbandry Practices"]:
    print(dt, frappe.db.exists("DocType", dt))
print("scouting husbandry field:", bool(frappe.get_meta("Scouting Entry").get_field("custom_crop_husbandry_practices") or [f for f in frappe.get_meta("Scouting Entry").fields if "husband" in (f.fieldname or "").lower()]))
PY
```
Expected: filter/stage/tank doctypes `1`; `Crop Husbandry Practices` `1`; husbandry field truthy. (Adjust the husbandry fieldname to the actual one found in Task 3.)

- [ ] **Step 3: Build assets into the site and smoke-test the app route**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16
bench build --app upande_scp
bench --site mona.local clear-cache
```
Then load the SCP app page in a browser (or `curl -sI` the app route) and confirm: it renders, the sidebar shows roses nav only, **no avocado** nav/route, and core pages (scouting dashboard, heatmaps, maps, spray plan approval) load.

- [ ] **Step 4: Record verification evidence**

Capture the migrate output tail and the console check output as evidence.

- [ ] **Step 5: Commit any migrate/v16 fixes as a WIP checkpoint (only if code changed)**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git status -s
# If Step 1 required code fixes for migrate to pass:
git add -A && git commit -m "wip(port): task 8 - v16 migrate fixes" || echo "no changes to commit"
```
Expected: a WIP commit if fixes were made; otherwise nothing (the rebuilt dist was already committed in Task 7).

---

### Task 9: Squash WIP commits into one clean port commit on mona

**Files:** none (history rewrite of the local `mona` branch only — not pushed).

**Note for coordinator:** `<TASK1_COMMIT>` below is the sha of the Task 1
pending-changes commit (recorded in the progress ledger). The squash target is
that commit, so the Task 1 commit is preserved and only the Task 2–8 WIP commits
collapse into one.

- [ ] **Step 1: Confirm the WIP history**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git log --oneline e416bb0..HEAD
git status -s
```
Expected: the Task 1 pending-changes commit followed by the `wip(port): task N …` commits; clean working tree.

- [ ] **Step 2: Final avocado-free assertion across the whole app**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
grep -rniE "avocado|orchard_tree|tree_and_row" upande_scp frontend/src --include=*.py --include=*.json --include=*.ts --include=*.tsx | grep -v "doctype/crop_husbandry" | grep -v "__tests__"
```
Expected: empty.

- [ ] **Step 3: Soft-reset to the Task 1 commit and re-commit as one**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp
git reset --soft <TASK1_COMMIT>
git commit -m "feat: port kaitet app to mona (roses-only)

Snapshot the kaitet branch app into frappe16/mona: all kaitet scouting,
spray, BOM/transfer, labels, filters, and dashboard work. Strip all
avocado-specific code (pages, doctypes, serverscripts, branches) so this
is a roses-only app. Preserve the crop_husbandry_practices feature and its
scouting integration. Frontend rebuilt; mona.local migrates clean."
```
Expected: a single port commit replacing all WIP commits. Do NOT push (await explicit instruction).

- [ ] **Step 4: Final state check**

Run: `git log --oneline -3` and `git status -s`.
Expected: top two commits are the Task 9 port commit and the Task 1 pending-changes commit; clean tree. `git diff` between this and the pre-squash state is empty (squash changed history, not content).

---

## Self-Review Notes

- **Spec coverage:** sequence (Task 1–2, 9), avocado strip (Task 4–6), crop_husbandry re-graft (Task 3), frontend rebuild (Task 5 Step 3 / Task 7 Step 4), DB alignment (Task 8), one clean commit (Task 9), commit pending first (Task 1) — all covered.
- **Keep-list:** only crop_husbandry; all other 25 mona-only files intentionally dropped by the true snapshot (superseded by kaitet's restructure) per design.
- **Risk handling:** avocado strip and v16 drift are gated by `npm run build`, `npx vitest run`, and `bench migrate` rather than assumed.
- **Open item for executor:** the exact crop_husbandry fieldname on Scouting Entry is discovered in Task 3 Step 2 and reused in Task 8 Step 2.
