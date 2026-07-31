# kaitet15 — a working Frappe 15 line for upande_scp

**Date:** 2026-07-30
**Author:** dev@upande.com (with Claude)
**Status:** **Built and serving, 2026-07-31** — https://kaitet15.132.145.21.55.nip.io.
Five apps, `bench migrate` clean, frontend built, API smoke set and a farm-scoped flow both
green. Stock tables are deliberately absent (see As built). Sections below are the design as
agreed; **As built** records what actually happened, including four deviations and one
addition.

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
- The retired shim survives at `_archive/upande_kaitet_shim-2026-07-27.tar.gz`. **It turned
  out to be an empty skeleton** — see As built.
- Toolchain present: python3.12, node 18.20.8 (nvm), MariaDB 11.4, bench 5.29.1.
- **Disk is the binding constraint**: 4.7 GB free of 45 GB (90 % used).

## Decisions (confirmed with user)

1. **Data source:** the v15 production gz, extracting specific tables only. Its columns
   are already the v15 names the v15 branch expects — no reverse-mapping.
2. **Scouting window:** **July 2026 only** (297,131 of 1,740,340 rows). Everything else
   in the whitelist restores in full.
3. **App set:** `frappe`, `erpnext`, `upande_kaitet_shim`, `upande_scp`. No hrms, no
   livestock, no `upande_core`, no `upande_ta`. *(Built with the real `upande_kaitet`
   instead of the shim — see As built, deviation 1. `upande_livestock` was added
   afterwards on request — see As built, addition 5.)*
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

## As built (2026-07-31)

Bench, site, branch and the July data are in place; `bench migrate` exits 0 with no errors.

### Deviation 1 — the real `upande_kaitet`, not a shim

`_archive/upande_kaitet_shim-2026-07-27.tar.gz` is an **empty app skeleton**: 24 files, not
one doctype JSON. The five doctypes were only ever repointed at the shim's module *in the
kaitet.local database*, so nothing was written to disk and the archive carries no schema.

`_archive/upande_kaitet-2026-07-27.tar.gz` (6.1 MB) turned out to be the **real
upande_kaitet source** — 159 doctypes, including all five. On v15 there is no strict Link
validation to reject it (that was a v16 behaviour), which is exactly why production runs it
today. So the site installs the real app, giving prod-identical fields with no shim gaps to
discover later.

Its only hrms coupling is one line — the `Leave Application` entry in
`override_doctype_class`, whose module imports `hrms`. Removed and committed on the
bench's copy; `grep -rn "from hrms"` then returns nothing. hrms is not installed.

### Deviation 2 — `bench new-site --no-mariadb-socket` cannot work on this server

That flag creates the site's DB user at host `%`. This MariaDB has anonymous
`''@'localhost'` and `''@'arnie'` rows, which shadow any `user@'%'` for local connections,
so `bench new-site` failed at its own restore step with `ERROR 1045 Access denied`. Dropped
the half-made database and user and re-ran **without** the flag: the user is then created at
`localhost`, matching kaitet.local and mona.local. Do not pass that flag on this box.

### Deviation 3 — bench ports are 8002/9002/11002/13002

`bench init` assigned these itself (the plan said 8005/9005). They do not collide with the
v16 bench (8000/9000/13000/11000), so they were kept. Redis is not under supervisor yet and
was started by hand: `redis-server config/redis_cache.conf --daemonize yes` (and
`redis_queue.conf`). Without it, `install-app` dies with
`redis.exceptions.ConnectionError: Error 111 connecting to 127.0.0.1:11002`.

### Deviation 4 — one genuine v15 → v15 incompatibility

`upande_kaitet`'s `Vehicle.employee` ships `link_filters` in an **old dict form**:

```json
{ "designation": ["in", ["Driver", "Truck Driver", "Tractor Driver", "Executive Driver"]] }
```

Production's older frappe accepted that. frappe 15.116 validates `link_filters` as a list of
`[doctype, fieldname, operator, value]` rows (`doctype.py:validate_link_filters`) and throws
inside `sync_customizations`, which aborts **every** `bench migrate` on the site. Rewritten
as `[["Employee","designation","in",[...]]]` and committed (`ff32e80`). Worth reporting
upstream to the kaitet app — production will hit this the moment it takes a v15 point-release
update.

### Addition 5 — `upande_livestock` on the same recipe

Added on request, using the identical method: find the last commit that predates the v16
work, branch it as `kaitet15`, install, restore its tables from the same dump.

Cut point is **`a81b6a4` (2026-07-02)**, "optional treatment dosage; require positive milk
yield". Everything later is v16-era — `c8e9fda` onward is the desk workspace / Desktop Icon
/ native-custom-field sweep, and **`424fc3f` pins Frappe v16 outright** via
`[tool.bench.frappe-dependencies]`, which alone would block installation on v15. `a81b6a4`
has no frappe pin.

All 19 livestock doctypes exist in the dump (18 tables + `Livestock Settings`, a Single)
and total **0.6 MB**, so this pass carried no disk risk. Loaded in 3m04s:

| | rows |
| --- | ---: |
| Animal / Animal Event / Herds | 366 / 576 / 9 |
| Animal Health Case / Milk Recording / Breed | 22 / 2 / 0 |
| `tabSingles` (Livestock Settings) | +48 |

`Breed` at 0 and `Milk Recording` at 2 are production's real state, not a failed load.

`tabSingles` had to be merged a second time: pass 1 restricted it to `doctype IN (SELECT
name FROM tabDocType)`, and livestock's doctypes did not exist yet, so its settings were
skipped. The re-merge is scoped to `doctype = 'Livestock Settings'` — a blanket re-merge
would duplicate every Singles row already present, since that table has no unique key on
(doctype, field).

`installed_apps` must be re-set whenever an app is added — it is now the five-app list.

### Addition 6 — assets (flocks) and the accounting documents

Added on request. **Poultry flocks are ERPNext `Asset` records**, not a custom doctype:
`asset_category = "Flocks"`, `item_code = "Flock"`, `location = "Torongo"`, named
`Flock 4-332865` (asset_name + suffix), purchased 2024-10-24 at ~KES 80,595 each. There is
no flock/poultry table anywhere in the dump — a scan of all 1,726 table names returns
nothing (the one apparent hit, `tabPegged Currency Details`, matches on "egg").

The Asset family was missing because it is not in the SCP dependency manifest. Restored in
one 3m03s pass, 33 tables / 243 MB:

| | rows |
| --- | ---: |
| Asset (of which **13 flocks** — 8 Sold, 4 Submitted, 1 Cancelled) | 1,820 |
| Asset Category / Movement / Activity | 23 / 1,788 / 22,702 |
| Location / Supplier | 13 / 1,707 |
| GL Entry / Journal Entry | 129,370 / 3,190 |
| Sales Invoice / Purchase Invoice | 13,780 / 4,073 |

Plus the rest of the asset family (Finance Book, Depreciation Schedule, Repair, Maintenance,
Capitalization, Value Adjustment, Shift tables) and the invoice item children.

**Caveat:** `tabStock Ledger Entry` is still absent, so **the GL does not reconcile against
stock movements**. Fine for flocks-as-assets and for reading accounting documents; not usable
for stock-vs-GL reconciliation.

**The same data was then mirrored into kaitet.local (v16)** — it had `tabAsset` (1,820, from
the July restore) but nothing around it: Asset Category was empty, so even the flocks' own
category link dangled, and there were no movements, activity, locations, invoices or journal
entries.

Because kaitet.local is **v16 against a v15 dump**, the kaitet15 method does not apply there:
dropping and recreating from production DDL would replace v16 tables with v15 schema. Every
table was staged and merged by column intersection with `INSERT IGNORE`
(`load_assets_kaitet.sh`), so the existing 1,820 Assets and 10 Suppliers survived untouched —
`tabAsset` merged **+0 rows**, exactly as intended. Landed: Asset Activity 22,702, Movement
1,788 (+1,789 items), Maintenance Log 774, Repair 499, Depreciation Schedule 244, Finance
Book 274, Asset Category 23 (+34 accounts), Location 13, Supplier 1,717, Journal Entry 3,190
(+16,290 accounts), Purchase Invoice 4,073 (+8,380 items), Sales Invoice 13,780 (+62,544
items), GL Entry 129,723. Flocks now resolve their category, with 13 movements and 65
activity records.

The merge log lists every column dropped on the way in. Two kinds, both expected: **v15→v16
renames** (`gross_purchase_amount`, `is_existing_asset`, `is_composite_asset`) and **fields
from apps this bench does not have** (csf_ke's `custom_etims_*`, lending's `loan*`). If a v16
report needs `gross_purchase_amount`, read it from v16's replacement field rather than
expecting the restore to have carried it.

### Addition 7 — synthetic opening stock (instead of restoring the ledger)

Historical stock was unaffordable (see above), so the flows were given **synthetic
opening stock** rather than production history. Scope is deliberately targeted: seeding
everything everywhere is 15,672 items × 507 farm warehouses ≈ **16 GB per site**, which
does not fit. What the flows actually consume does:

| | | |
| --- | ---: | ---: |
| SCP: items `CHEMICALS` + `Fertilizer` × the 11 Farm-mapped stores and 12 CSUs | 678 × 23 = **15,594** | 100 units each |
| Livestock: the herd BOMs' raw materials × their own default warehouses | 13 × 5 = **65** | 1,000 units each (feed moves in bulk) |

Result on kaitet15: **115 + 5 Material Receipt entries, zero failures**, 15,594 ledger rows,
bins with stock 2,501 → 17,672, for **~100 MB** — in line with the 85–110 MB estimate.
Real Stock Entries, not hand-written Bin rows: only a proper receipt produces consistent
SLE + Bin + GL, which is what the transfer/mix/manufacture path validates against.

kaitet.local was **not** seeded — it only needed the flocks and their processes.

**Reference patterns were sampled from the dump first**, since they are unrecoverable once
it is deleted. Two techniques, both avoiding the 2.9 GB staging that failed:
`stream_sample.sh` takes the first N extended-INSERT statements of a table (position-based),
and `stream_grep.sh` takes only statements matching a regex (content-based). 19 MB bought
6,383 real Stock Entries, 9,051 details and 12,918 ledger rows — including
`SE-2026-1000676`, a *Material Transfer for Manufacture* into `Chepsito CSU Phase 1 - KR`
against `MFG-WO-2026-00788`. Kept as `_ref_*` / `_mfg_*` tables on kaitet15.

### Four more things a fresh v15 site needs

Found while making the seeding actually run — none is about the data:

11. **`server_script_enabled` must be set bench-wide.** upande_kaitet and upande_livestock
    ship Server Script fixtures bound to doc events; without the flag every Stock Entry
    submit dies with "Server Scripts are disabled". kaitet.local has it; the new bench did
    not.
12. **The site had NO Fiscal Years at all** — the setup wizard never ran — so every posting
    failed with "Date … is not in any active Fiscal Year". Production uses calendar years;
    2021–2028 were created to match what the restored GL rows reference.
13. **Custom Fields whose *link target* doctype does not exist must go** — a different class
    from the missing-column sweep, and invisible to it, because `Table`/`Link` fields are in
    `no_value_fields`. 67 of them, led by `Item.custom_present_greenhouses` → `Item
    Greenhouses` (production has that doctype; the kaitet app never defined it, and its
    production table is empty). Any Item load raised `DoesNotExistError` until it was
    removed. Their **columns and data survive** — only the definitions are dropped.
14. **`upande_kaitet` ships 40 doctypes as fixtures, but the DocType entry in its `fixtures`
    hook is commented out**, so `Business Unit`, `Loss Reason` and 38 others never install
    on a fresh site. This is why some restored Custom Fields (`Stock Entry.custom_business_
    unit`, `Warehouse.custom_business_unit`) point at nothing. SCP already guards for the
    absence of `custom_business_unit`; if a flow ever needs those doctypes, uncomment that
    hook entry rather than hand-creating them.

### The processes actually run

Proof, not inference:

- **Livestock feed manufacture**, end to end: `manufacture_herd_feed('0-2')` produced
  Work Order `MFG-WO-2026-05198`, transfer entry `SE-2026-2562419` and manufacture entry
  `SE-2026-2562420` — 45 kg TMR Calves Meal into `Feed Store - TMR Store - KR`. The same
  shape as the sampled production pattern.
- **SCP stock visibility** as a real scoped user (`festus.muasya@karenroses.com`):
  `creator_stock_overview` shows Chemical Store Simotwo with 678 items at qty 100;
  `chemical_stock_overview` returns 679 items and 15,724 matrix rows, all non-zero.

**A find worth keeping:** the Livestock Settings *values* (`custom_milk_item = "Westwood
Milk"`, `custom_milk_target_warehouse = "Westwood Milk - KR"`) were already present, carried
in by the Singles restore. Production has the configuration and is missing only the field
**definitions** — so production's milk recording is almost certainly failing the same way.
Backported as fixtures in `upande_livestock` `68f40a8`.

### The frontend build

Builds clean: `✓ built in 17.69s`, 3.6 MB into `upande_scp/public/dist`.

Two traps, both mine: the app is an **npm** project (`package-lock.json`, no `yarn.lock`
until `67cd0ef`, which postdates this branch), and one dependency
(`@mapbox/jsonlint-lines-primitives`) requires **node ≥ 22**. Building with yarn on node 18
aborts the install on the engine check, leaving `node_modules` incomplete — which then
surfaces confusingly as `Cannot find native binding` from `@tailwindcss/oxide`. Use
`npm ci && npm run build` on **node 24**. Node 18 is only needed for frappe's own asset
build, not for this app.

### Space — actual

4.7 GB → **8.4 GB** free before building. Zero-risk reclaims came in at ~2.25 GB
(hrms + banking `node_modules` 1.03 GB, `crm`+`insights` 623 MB, logs 249 MB, two old
backups 340 MB). `crm`, `insights` and `print_designer` are re-clonable — their remote is
named `upstream`, not `origin`, which is why a naive `git remote get-url origin` reported
"NO-GIT" for every app in that directory. The four Upande apps there
(`upande_avocado`, `kaitet_taskwork`, `coffee_harvest`, `upande_sensors`) really are **not
git repositories** and exist nowhere else — they were left alone.

The kaitet.local trim went as designed via swap-rebuild: **3.0 GB → 1.3 GB**, 297,131 July
rows kept across all nine scouting tables (`2026-07-01 → 2026-07-13`), rollback backup
`20260731_033514`. `tabCrop Modelling Entry` came out at 0 rows — checked against the backup
before continuing, and it was already empty, so nothing was lost.

### The restore — actual

The whitelist was generated from the branch's own DocType JSONs rather than transcribed:
80 SCP doctypes on `kaitet15`, **76 present in the dump** (`Map Settings`, `Spray Plan
Settings`, `Trap Report Settings` are Singles with no table; `Spray Equipment` postdates the
production deploy). Final lists: **103 full tables**, 9 scouting tables staged, 9 selective.

Pass 1 streamed in **5m47s** and loaded:

| | |
| --- | ---: |
| Scouting Entry (July) + Metadata | 297,131 + 297,131 |
| Pests / Diseases / Weeds / Trap / Incidents / Predators / Physio | 153,771 / 48,965 / 53,295 / 10,784 / 1,255 / 224 / 6,555 |
| Item / Warehouse / BOM / Work Order / Bin / Employee | 16,470 / 603 / 2,557 / 5,136 / 10,090 / 4,055 |
| Zone / Bed / Farm | 154,341 / 20,668 / 16 |
| User / Has Role / User Permission / DefaultValue / Role | 549 / 15,380 / 706 / 782 / 125 |
| Series / Singles / Custom Field / Property Setter | 2,700 / 1,252 / 1,007 / 837 |

**Three columns were dropped on load** — `station`, `week_number`, `data_rovl` on Scouting
Entry (production-side fields absent from the DocType). Checked before deciding: they are in
neither the `d7edfea` nor the `kaitet` DocType JSON, and nothing reads them — the weekly trap
report computes `WEEK(se.date_of_capture, 1)` in SQL, and the frontend's "station" is a
UI grouping. No backfill needed.

**The stock tables are far larger than the design assumed.** Indexing the dump once (one awk
pass recording per-table byte counts, kept at `dump_table_sizes.tsv`) showed
`tabStock Entry` **2,466 MB**, `tabStock Ledger Entry` **1,925 MB**, `tabStock Entry Detail`
**1,822 MB** of dump text — 6.2 GB combined, impossible to stage together on this disk. They
therefore get **one pass each**: stage, keep the July window, drop the stage, check free
space, next. `load_stock.sh` refuses to stage a table with under 3 GB free.

For scale, the same index shows what the whitelist correctly excludes: `tabVersion`
10.4 GB, `tabEmail Queue` 6.2 GB, `tabDeleted Document` 1.1 GB, `tabError Log` 998 MB.

**The stock pass was attempted and abandoned — stock is NOT restored.** Staging
`tabStock Entry` reached **2.88 GB** in InnoDB (against 2.47 GB of dump text) and was still
growing, with free disk down to 2.0 GB on a volume shared with the live kaitet.local and
mona.local databases. The pass was killed and the stage dropped, returning the site to
**1,023 MB** and the disk to **5.0 GB free**. The July slice would have been worth roughly
150 MB, which does not justify running the other two sites' database out of space.

Consequence: `tabStock Entry`, `tabStock Entry Detail` and `tabStock Ledger Entry` are all
empty. **`tabBin` is fully restored, so stock balances are real**; what is missing is the
documents and the ledger behind them. This is how kaitet.local has run since July.

To add stock later, do it when there is headroom — moving the 5.8 GB production gz off this
volume first leaves ~10 GB, at which point `load_stock.sh` runs comfortably one table at a
time. Note the script's own guard (refuse under 3 GB free) was not enough: it checks
*before* staging, and a single table can consume more than 3 GB. Raise it to 4 GB, or add a
mid-stage watchdog, before re-running.

GOTCHA that cost a session kill, twice: **never `pkill -f <pattern>` where the pattern also
appears in the killing command's own cmdline** (`pkill -f "20260713_234519-stream"`,
`pkill -f "while pgrep"`). It matches your own shell and kills the session with exit 144 —
the same trap as `pkill -f skip-grant-tables` during the v16 upgrade. Kill by explicit PID.

### Post-load repairs — three more than planned

Beyond the five in the section above:

6. **`tabDefaultValue` dedupe must include `parent='__global'`.** That is where
   `installed_apps` lives. Deduping only `__default`/`Administrator` left production's row
   beside the corrected one, `get_global()` returned a list, and migrate kept trying to
   import `fleet_management`. The repair script now deletes the `installed_apps` row before
   re-setting it, and dedupes `__global` too.
7. **Custom Fields with no backing column must be deleted** — 544 of them (print_designer on
   Print Format, livestock fields, other uninstalled apps), or migrate dies with
   `Unknown column 'print_designer_print_format'`. Exclude `frappe.model.no_value_fields`
   (Section/Column/Tab Break, Table, HTML) — 289 such layout fields legitimately have no
   column. Safe because anything an installed app really ships returns from its fixtures on
   the next migrate.
8. **`tabProperty Setter` keys its doctype as `doc_type`, not `dt`** (that is `tabCustom
   Field`). The merge filter must differ per table.

### Serving — as built

Live at **https://kaitet15.132.145.21.55.nip.io** (Let's Encrypt, HTTP redirects to HTTPS).
Supervisor group `frappe15lts` (7 programs: gunicorn 3 workers on 8002, schedule, short and
long workers, both redis, socketio on node 18), nginx site `frappe15lts`,
`sites/currentsite.txt` = `kaitet15.local`. The manually-started redis instances must be
shut down (`redis-cli -p 13002 shutdown nosave`) before supervisor takes over the ports.

**`tabSingles` duplicates broke website rendering.** Pass 1 merged production's Singles with
`INSERT IGNORE`, but that table has **no unique key on (doctype, field)** — so every field
ended up with two rows, 1,089 pairs in all. `/` and `/scp_app` then 500'd with
`DoesNotExistError: Web Template Footer not found`, because `Website Settings.footer_template`
resolved to production's value pointing at a Web Template this site does not have
(`tabWeb Template` was not restored). Fixed by deduping every (doctype, field) pair — keeping
the non-empty value — and then clearing `footer_template`.

Order matters: dedupe **first**, clear the dangling reference **second**. Clearing it first
does not survive, because the dedupe prefers the non-empty row and puts `'Footer'` straight
back. Also note `frappe.db.set_single_value` on a field that does not exist on the doctype
throws and rolls back everything uncommitted in that script.

### The desk — two v15-specific traps

The desk boots and renders (`/app`, `/app/upande-scp`, and Item / Scouting Entry / Work
Order list views all 200; `get_bootinfo` clean with five apps and 24 workspaces; the Upande
SCP workspace returns its shortcuts). Getting there needed two fixes the v16 playbook does
not cover:

9. **`desktop:home_page` was still `setup-wizard`.** A fresh site records that default before
   setup finishes, it survives the restore, and `load_home_page` reads it directly — so the
   desk kept opening the ERPNext setup wizard even though setup *was* complete. Delete the
   `tabDefaultValue` row; boot then falls back to `Workspaces`.
10. **On v15, `frappe.is_setup_complete()` reads `tabInstalled Application.is_setup_complete`
    for frappe and erpnext — not `System Settings.setup_complete`.** That is the v16 shape.
    Set both; here the Installed Application flags happened to be right already, so the
    symptom was purely the stale default above.

### Verification — results

| Check | Result |
| --- | --- |
| `bench --site kaitet15.local migrate` | **exit 0**, no errors, five apps |
| Frontend build | `✓ built in 17.69s`, 3.6 MB dist |
| `bench build` (all apps) | clean |
| `/`, `/api/method/ping` | 200, `{"message":"pong"}` |
| `/app`, `/scp_app` logged in | 200, 200 |
| `getFarmsAndGreenhouses` | 6 farms with greenhouses |
| `getCropsScouted` | 2 crops |
| `chemical_stock_overview` | 174 items, 38 warehouses, 553 matrix rows, 12 CSUs |
| `getAllChemicals` | 471 chemicals, 207 fertilizers |
| Desk `/app`, `/app/upande-scp`, list views | 200; Scouting Entry list returns July rows |
| `get_bootinfo` | clean, 5 apps, 24 workspaces, `home_page: Workspaces` |
| `fetch_creator_bootstrap` as `festus.muasya@karenroses.com` | farms [Simotwo, Eldama], 32 warehouses, 20 greenhouses |
| `creator_stock_overview` (same user) | 3 CSUs / 1 chemical store / 2 farms |
| kaitet.local + mona.local unaffected | 200 |

`fetch_creator_bootstrap` returns empty scope for Administrator — expected, Administrator has
no farm-creator mapping; drive it as a real user.

### Outstanding

- Stock tables, if wanted — see above; needs disk headroom first.
- Supervisor + nginx on `kaitet15.132.145.21.55.nip.io` (templates read from the existing
  `frappe15` configs; redis needs moving under supervisor at the same time).
- API smoke set and one farm-scoped flow as a real creator user.
- Optionally reclaim the 5.8 GB production gz once the site is signed off.

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
- **Bin without any ledger.** Bin restores in full, so stock *balances* are real, but no
  Stock Entry / Stock Ledger Entry rows exist at all (see As built). Spray and store flows
  read Bin and create their own documents, so development works; anything that reads stock
  *history* will show nothing.
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
