# kaitet15 — a working Frappe 15 line for upande_scp

**Date:** 2026-07-30
**Author:** dev@upande.com (with Claude)
**Status:** Design — pending review

## Goal

Stand up a **Frappe 15 / ERPNext 15** bench and site (`kaitet15.local`) running a v15
branch of `upande_scp`, restored from a slice of the live v15 production dump, so SCP
updates can be developed and shipped to production **now** — production is still on v15,
and the v16 transition is not finished.

## Context

- Since 2026-07-14 the `frappe15` bench has itself been **v16** (frappe 16.26.3 /
  erpnext 16.27.0). There is no v15 bench on this machine any more.
- The `kaitet` branch of `upande_scp` diverged from v15 at commit `3da96a5`
  ("remove bed/orchard_tree/zone doctypes (now owned by upande_core)"), which — with
  `4aa1e23` — moved SCP onto `upande_core` / `upande_ta` field names. Everything after
  that point assumes v16 + the split apps.
- Production (the Karen Roses "stream" server) still runs v15 with the original
  `upande_kaitet` doctypes and field names.
- A genuine v15 dump of that production database is on disk:
  `~/stive/code/frappe15/20260713_234519-stream-database.sql.gz` (5.8 GB gz, ~40 GB raw,
  1726 tables, taken 2026-07-13).
- The retired shim survives at `_archive/upande_kaitet_shim-2026-07-27.tar.gz`.
- Toolchain present: python3.12, node 18.20.8 (nvm), MariaDB 11.4, bench 5.29.1.
- **Disk is the binding constraint**: 4.7 GB free of 45 GB (90 % used).

## Decisions (confirmed with user)

1. **Data source:** the v15 production gz, extracting specific tables only. Its columns
   are already the v15 names the v15 branch expects — no reverse-mapping.
2. **Scouting window:** **July 2026 only** (297,131 of 1,740,340 rows). Everything else
   in the whitelist restores in full.
3. **App set:** `frappe`, `erpnext`, `upande_kaitet_shim`, `upande_scp`. No hrms, no
   livestock, no `upande_core`, no `upande_ta`.
4. **Base commit:** `d7edfea` (= `c7e2c99^`, "self-host Poppins via bundled @font-face").
5. **No backports.** The branch starts clean; post-Jul-17 features are not replayed.
6. **Serving:** bench at `~/stive/code/frappe15lts`, served like kaitet.local
   (supervisor + nginx + nip.io host).
7. **Users/roles restored** so farm-scoped flows can be exercised.
8. **kaitet.local is trimmed to July scouting** to free space, after a fresh backup.

### Why `d7edfea` and not "the commit before July 14"

The literal pre-Jul-14 commit is `a251dd0` (2026-07-07). The 30 commits between it and
`c7e2c99` were written on the v16 bench but are **v15-safe**: diffing the whole range
shows *zero* references to `upande_core`, `upande_ta`, `bio_employee`, `biometric_status`,
`farm_name`, `bed_area` or `farm_code`. They are the design-language port, the shared
avocado tree map, the coffee crop section, and two serverscripts.

The one v16-only artifact in that range is `c7e2c99` itself, which adds
`upande_scp/workspace_sidebar/upande_scp.json` — **`Workspace Sidebar` is a v16 DocType**
and would break `bench migrate` on v15. Forking at its parent keeps 29 commits of work
and excludes the incompatibility, with no revert commit needed.

## Space plan

Executed **before** anything is built. Current free: 4.7 GB.

| Action | Frees | Recoverable by |
| --- | ---: | --- |
| `hrms` frontend + roster `node_modules` (v16 bench) | 736 MB | `yarn install` |
| `erpnext/banking/node_modules` | 296 MB | `yarn install` |
| `crm` + `insights` in `frappe15_unused_apps` | 623 MB | public frappe repos (remote `upstream`) |
| bench logs (frappe15 86 MB + frappe16 163 MB) | 249 MB | n/a |
| two older kaitet.local backups (newest kept) | 340 MB | nightly cron |
| `_stage_tabCustom Field`, `_stage_tabProperty Setter` | 4 MB | the prod gz |
| kaitet.local scouting trimmed to July | ~1.85 GB | pre-trim backup + the prod gz |
| **Total** | **~4.1 GB** | → **~8.8 GB free** |

Spend: new bench ~4 GB at peak, ~2.8 GB after its `node_modules` are pruned post-build;
new database ~1.0 GB. **Ends at ~3.5–4 GB free**, with the 5.8 GB prod gz still on disk.

**Must not be deleted:** `upande_avocado`, `kaitet_taskwork`, `coffee_harvest`,
`upande_sensors` — these are **not git repositories** and exist nowhere else (52 KB–36 KB
each). Also off-limits: the prod gz, and `upande_scp/frontend/node_modules` (daily use).

### kaitet.local trim mechanics

Swap-rebuild, **not** `DELETE`: a `DELETE` of 1.44M rows leaves the tablespace allocated
(frees nothing without a rebuild) and generates enormous undo.

Per table: `CREATE TABLE x_new LIKE x` → `INSERT INTO x_new SELECT … WHERE <july>` →
`RENAME TABLE` → `DROP` the old. Capture the July parent-name set into a temp table
first, trim the children against it, and trim `tabScouting Entry` last. Tables in scope:
`tabScouting Entry`, `tabScouting Entry Metadata`, `tabPests Scouting Entry`,
`tabDiseases Scouting Entry`, `tabWeeds Scouting Entry`, `tabTrap Scouting Entry`,
`tabIncidents Scouting Entry`, `tabPredators Scouting Entry`.

`tabScouting Entry Metadata` has no date column — confirm its link field to
`Scouting Entry` before trimming it, and filter on that.

Take a fresh `bench --site kaitet.local backup` first; delete it only once the trim
verifies.

## Branch

`kaitet15`, forked from `d7edfea`, in its own clone (a bench pins one branch per app, so
the new bench cannot share the existing working tree). The clone fetches from the local
path `/home/ubuntu/stive/code/frappe15/apps/upande_scp`, the same local-remote trick the
frappe16 port used. Not pushed to any remote without explicit instruction.

## Bench — `~/stive/code/frappe15lts`

```
cd ~/stive/code
bench init frappe15lts --frappe-branch version-15 --python /usr/bin/python3.12
cd frappe15lts
bench get-app erpnext --branch version-15
# shim: untar _archive/upande_kaitet_shim-2026-07-27.tar.gz into apps/, then
bench get-app ~/stive/code/frappe15lts/apps/upande_kaitet_shim
# scp: clone from the existing tree, branch kaitet15 off d7edfea
git clone -b kaitet15 ~/stive/code/frappe15/apps/upande_scp apps/upande_scp
bench get-app ~/stive/code/frappe15lts/apps/upande_scp
```

Node 18.20.8 (nvm) for the asset build only. Ports: web 8005, socketio 9005, redis cache
13005 / queue 11005 — no collision with the v16 bench (8000/9000/13000/11000).

## Site — `kaitet15.local`

Fresh site; install erpnext, the shim, upande_scp; **`bench migrate` must run clean before
any data is loaded**, so the schema is v15-native and the dump's rows land in tables that
already match. Because dump and site are both v15, app-owned tables are dropped and
recreated from the dump's own DDL — none of the column-intersection staging that v16
forced in July.

## Data slice

Table list is §3 of `docs/audits/2026-07-14-scp-livestock-dependency-manifest.md`
(bench root). Tables are streamed one at a time straight out of the gzip (awk section
select) — never a full decompress, never a temp database.

**Restored in full**

- Geometry: `tabZone`, `tabBed`, `tabBlock Sectors`, `tabGreenhouse Sectors`,
  `tabPlant Section`, `tabFarm Map Coordinate`, `tabMap Settings`.
- Catalog/filters/codes: `tabPest`, `tabPlant Disease`, `tabPredator`, `tabWeed`,
  `tabIncident`, `tabPhysiological Disorder`, `tabStage`, `tabTrap`, all `*Filter`,
  `*Stages`, `*Targets`, `tabFilter Priority`, `tabScouting Severity Scale`,
  `tabActive Ingredient`, `tabIRAC Code`, `tabFRAC Code`, `tabGHS Code` and their
  guideline/frequency children.
- Chemicals/spray: `tabChemical Transfer Request` (+ Source), `tabChemical Requirements`,
  `tabChemical Stock Baseline`, `tabChemical Equipment`, `tabPermitted Chemicals`,
  `tabSpray Team` (+ Details), `tabSpray Equipment` (+ Details),
  `tabSpray Application Logsheet` (+ Pesticide, + Applicator), `tabSpray Plan Settings`
  (+ Allowed Farm, + Exclude Keyword), `tabCustom Spray Plan Team Member`,
  `tabTank And Valve`, `tabWork Order Chemical Scan`, `tabSprayer GPS Log`,
  `tabSprayer Movement Session`.
- Role/settings tables: `tabFarm Spray Plan Approver`, `tabFarm Spray Plan Creator`,
  `tabFarm Store Keeper`, `tabTrap Report Settings`.
- Shim-owned: `tabFarm` (+ children), `tabBlocks`, `tabItems Greenhouses`.
- ERPNext masters: `tabItem`, `tabItem Group`, `tabUOM`, `tabWarehouse`,
  `tabWarehouse Type`, `tabBOM`, `tabBOM Item`, `tabBin`, `tabWork Order`,
  `tabWork Order Item`, `tabEmployee`, `tabCompany`, `tabCost Center`, `tabAccount`.
- Avocado geometry (`tabOrchard Tree`, `tabTree And Row Automation`,
  `tabBed And Zone Automation`) — kept, the branch is multi-crop.

**Restored July 2026 only**

`tabScouting Entry` and its children (`Metadata`, `Pests`, `Diseases`, `Weeds`, `Trap`,
`Incidents`, `Predators`), plus `tabStock Entry`, `tabStock Entry Detail` and
`tabStock Ledger Entry` on the same window. The window is
`date_of_capture >= '2026-07-01'` for scouting (the dump ends 2026-07-13) and `posting_date`
for the stock tables.

Method: stage one table at a time (`_stage_tabX`), `INSERT … SELECT` the window into the
real table, drop the stage immediately. Peak transient cost is therefore **one** table
(worst case `Scouting Entry Metadata`, ~961 MB), not all of them at once. Children filter
on the July parent-name set.

**Users**

`tabUser` (INSERT IGNORE so Administrator survives), `tabHas Role`, `tabUser Permission`,
`tabDefaultValue`. `__Auth` is **not** restored — nobody logs in with a production
password; test users get a locally-set one, and server-side `set_user` works for scripted
checks.

## Post-load repairs

Each of these was diagnosed during the v16 restore and will recur here:

1. Reset the `installed_apps` DB global to this bench's four apps — the dump overwrites it
   with production's 28-app list, and the website renderer loops it unfiltered, so every
   web page 500s with `ModuleNotFoundError`.
2. Dedupe `tabDefaultValue` for `parent IN ('__default','Administrator')` — production
   rows land on top of the fresh site's, making every global default a *list*, which
   breaks desk boot with `SessionBootFailed`. Needs `SET SQL_SAFE_UPDATES=0`.
3. Backfill `Notification Settings` for restored users — SQL-inserted users skip the
   auto-create hook, and a missing doc 500s `get_bootinfo`.
4. `System Settings.setup_complete = 1`, `enable_onboarding = 0`; Global Defaults to
   Karen Roses / KES / Kenya; Administrator timezone Africa/Nairobi.
5. Carry `tabSeries` (ON DUPLICATE KEY UPDATE) so document naming continues from
   production's counters instead of restarting at 1.
6. `bench clear-cache` **and** a restart — gunicorn workers cache the old boot.

## Serving

Supervisor programs + an nginx server block modelled on the existing frappe15 stack:
host `kaitet15.132.145.21.55.nip.io` → 127.0.0.1:8005 (gunicorn) and :9005 (socketio),
with a Let's Encrypt certificate. `sites/currentsite.txt` = `kaitet15.local` (its absence
was the bug that broke the frappe15 stack in July).

## Verification

- `bench --site kaitet15.local migrate` exits clean.
- `cd frontend && yarn install && yarn build` succeeds on node 18.
- Site boots: `/app` 200, `/scp_app` 200 (or 403 auth-gate, not a crash).
- API smoke set returns real data: `fetch_creator_bootstrap`, `getFarmsAndGreenhouses`,
  `getCropsScouted`, `creator_stock_overview`, `chemical_stock_overview`,
  `getAllChemicals`, `getAllScoutedGreenhouses?date=…`, `getBomStockBalances`.
- One farm-scoped flow driven as a real spray-plan creator (scope, allowed warehouses,
  Bin-backed stock) — not just as Administrator.
- Scouting, heatmap and trends pages render July data; the workspace loads.
- Final database ≈ 1.0 GB; free disk ≥ 3 GB.

## Out of scope

- Backporting any post-`d7edfea` feature.
- `upande_livestock`, `hrms`, `upande_core`, `upande_ta`.
- File attachments — the dump is database-only, so `tabFile` rows may dangle.
- `tabGL Entry`, `tabJournal Entry`, and ledger history before July.
- Any change to the frappe16/mona bench, and any change to kaitet.local beyond the
  agreed scouting trim.

## Risks

- **Disk.** Every step is sequenced so the reclaim happens first and the prod gz is never
  decompressed. If the bench build overruns the estimate, `upande_scp/frontend/node_modules`
  on the v16 bench (405 MB) is the next reclaim, then `crm`'s remaining tree.
- **Bin without full ledger.** Bin restores in full while the ledger is July-only, so
  stock *balances* are real but do not reconcile against *history* before July. This is
  the same tradeoff kaitet.local already runs with and does not affect spray/store work.
- **Shim completeness.** The shim was hand-cut to five doctypes; if production rows carry
  columns the shim's DocType JSONs lack, those columns are dropped on load. Detect by
  diffing the dump's DDL for `tabFarm`/`tabBlocks`/`tabItems Greenhouses` against the
  created tables, and add missing fields to the shim rather than patching data.
- **v15 patch replay.** Restoring a 15.x production database into a `version-15` tip site
  will run any pending v15 patches on migrate. That is correct behaviour and mirrors what
  a production update would do, but it must be run *after* the load and watched.
- **Two live sites, one MariaDB.** kaitet15.local and kaitet.local share the server;
  the trim and the restore both need `SET SQL_SAFE_UPDATES=0` and must name their
  database explicitly.
