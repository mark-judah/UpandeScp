# Hardcoded Values Audit — upande_scp

**Date:** 2026-07-07
**Scope:** Full app — Python backend (`upande_scp/`), React/TS SPA (`frontend/src/`),
legacy `www/` pages, `public/js/`, fixtures, patches, hooks, print formats.
**Method:** Three parallel code sweeps (backend identifiers, frontend values, config/secrets).

---

## TL;DR

- ✅ **No real secrets, API keys, passwords, or tokens are hardcoded anywhere.**
  Weather uses keyless Open-Meteo; all maps use keyless OSM/OpenFreeMap/MapLibre tiles.
  The SPA API client uses relative `/api/method/...` paths + an injected `window.SCP`
  bootstrap, so **no backend host/site is baked into the app.**
- The real exposure is in three buckets:
  1. **Personal email addresses** as fallback recipients for live scheduled reports.
  2. **Single-tenant coupling to "Karen Roses"** (company, warehouse, letterheads, DocType names).
  3. **Business rules / enums / thresholds** baked into code instead of settings.

All paths are relative to `/home/ubuntu/stive/code/frappe15/apps/upande_scp/`.

---

## 🔴 High priority

### 1. Personal email addresses as fallback report recipients
Live trap / FCM / scouting report data is emailed to these addresses when the settings
singleton is empty. Includes personal Gmail accounts.

| File:Line | Value |
|---|---|
| `upande_scp/serverscripts/send_weekly_trap_report.py:599-603` | `stephenechikoi@gmail.com`, `echikoistephene@gmail.com`, `vlabat@karenroses.com`, `rbundotich@karenroses.com` |
| `upande_scp/serverscripts/send_fcm_weekly_excel_report.py:755-758` | same four defaults (KEPHIS FCM report) |
| `upande_scp/serverscripts/send_fcm_weekly_excel_report.py:1017` | `recipients = ["stephenechikoi@gmail.com"]` — sole default, no settings fallback |
| `upande_scp/serverscripts/send_daily_scouting_report.py:372` | `default = ["stephene@upande.com"]` |
| `upande_scp/fixtures/trap_report_settings.json:9` | ships `weekly_report_recipients: "echikoistephene@gmail.com"` as default config on **every install** |
| `upande_scp/serverscripts/send_fcm_weekly_excel_report.py:356` | regulator email `rosafcmdata@kephis.org` in spreadsheet instruction text |

**Fix:** require the Trap Report Settings singleton to be populated; drop personal-Gmail
fallbacks (fail loudly or no-op instead of emailing private accounts). Clear the shipped
fixture default.

### 2. Single-tenant "Karen Roses" literals
These break any deployment for a different company/farm (e.g. the Mona port).

| File:Line | Value |
|---|---|
| `upande_scp/serverscripts/create_bom.py:85` | `bom_doc.company = "Karen Roses"` |
| `upande_scp/serverscripts/create_application_work_order.py:123-124` | throws unless `template_bom.company == "Karen Roses"` |
| `upande_scp/serverscripts/create_application_work_order.py:202` | `"company": "Karen Roses"` |
| `upande_scp/serverscripts/create_application_work_order.py:97` | default WIP warehouse `"Work In Progress - KR"` |
| `upande_scp/print_formats/scouting_obeservations.json:52` | letterhead `"Karen Roses Horizontal Logo"` |
| `upande_scp/print_formats/scouting_traps.json:12` | letterhead `"Karen Roses Horizontal Logo"` |
| `upande_scp/www/library_of_blooms/index.py:13` | title `"Library of Blooms — Karen Roses"` |

**Fix:** source company / default warehouse / letterhead from a settings singleton or
`frappe.defaults`.

### 3. Auto-privileged seed user
| File:Line | Value |
|---|---|
| `upande_scp/patches/v1_0/setup_spray_supervisor_role.py:60` | `SEED_USERS = ["micah.kayoswo@karenroses.com"]` — auto-granted Spray Supervisor role on patch run |

---

## 🟡 Medium — should be config-driven

### Per-tenant DocType branching
| File:Line | Value |
|---|---|
| `upande_scp/serverscripts/get_scouting_report.py:309-310` | `karen_doctype = "Items Greenhouses"` vs `mona_doctype = "Varieties per GH"` |

### Farm / crop rosters & naming conventions
| File:Line | Value |
|---|---|
| `upande_scp/patches/v1_0/seed_spray_plan_settings.py:11` | `SEED_FARMS = (Chepsito, Kaptumbo, Kapkolia, Torongo, Simotwo, Karen)` |
| `upande_scp/patches/v1_0/seed_spray_plan_settings.py:12` | `SEED_KEYWORDS = (phase, tunnel, ipm, wetland, csu)` |
| `upande_scp/serverscripts/populate_avocado.py:58,487,494` | `CROP_NAME = "Avocado"`; default `farm="Lokitela"` |
| `upande_scp/serverscripts/get_avocado_scouting.py:22` | `"crop_scouted": "Avocado"` filter literal |
| `upande_scp/serverscripts/store_keeper_api.py:165,197-198` | `"Chemical Store%"` store-name prefix filter |
| `upande_scp/serverscripts/spray_plan_creator/loaning.py:93,145` | `"Chemical Store%"` filter |
| `upande_scp/serverscripts/spray_plan_creator/stock.py:33` | `_STORE_RE = re.compile(r"^\s*chemical store\b")` |
| `serverscripts/spray_plan_creator/validation.py`, `store_keeper_api.py`, `send_fcm_weekly_excel_report.py` | implicit `- KR` / `- KL` warehouse-suffix parsing |

### Business thresholds baked into code
| File:Line | Value |
|---|---|
| `upande_scp/serverscripts/populate_severity_defaults.py:20-40` | full pest/disease low/mod/high catalogue (e.g. Thrips 5/15/30, FCM 1/3/6, Mealybugs 3/8/16) |
| `upande_scp/serverscripts/spray_plan_creator/stock.py:41` | `CSU_MAX_AGE_DAYS = 5` — comment notes it must stay in sync with a React page + runbook |
| `upande_scp/serverscripts/spray_plan_creator/stock.py:48` | `_CSU_AGE_HORIZON_DAYS = 60` |
| `upande_scp/serverscripts/store_label_printing.py:123,132` | label date window `days = 60` |
| `upande_scp/serverscripts/get_complete_scouting_entries.py:85` | `CACHE_WINDOW_DAYS = 90` |
| `upande_scp/serverscripts/store_keeper_api.py:589` | `_SCAN_FRESHNESS_SEC = 120` |
| `upande_scp/serverscripts/dashboard_aggregates/_common.py:263` | `DASH_AGG_TTL = 60` |
| `upande_scp/serverscripts/weather.py:19` | `_TTL_SECONDS = 30 * 60` |
| `upande_scp/patches/v1_0/backfill_spray_team_farm.py:7` | `>=80%` team-farm dominance rule |
| `frontend/src/pages/ApplicationPlan.tsx:107` | `WATER_VOLUME_RATE = 1000` — comment: "may need tweaking" |

### Item groups & chemical catalogue
| File:Line | Value |
|---|---|
| `upande_scp/serverscripts/spray_plan_creator/stock.py:31` | `_CHEMICAL_GROUPS = ("CHEMICALS", "Fertilizer")` |
| `upande_scp/serverscripts/populate_avocado.py:63+,192-197` | trap-type catalogue (McPhail/Delta/Femtrack/Crytrack/CSR) + avocado pest list |

### Roles (drift-prone duplicated sets)
| File:Line | Value |
|---|---|
| `upande_scp/serverscripts/store_keeper_api.py:34` | `_WRITE_ROLES = {"Store Keeper", "System Manager", "Administrator"}` |
| `upande_scp/serverscripts/thresholds_api.py:19` | `_WRITE_ROLES = {"System Manager", "Administrator", "General Manager"}` |
| `frontend/src/App.tsx:177` & `frontend/src/components/AppSidebar.tsx:261` | `["System Manager","Administrator","General Manager"]` (duplicated) |
| `frontend/src/components/AppSidebar.tsx:80,153,160,167,174` | `STORE_KEEPER_ROLE` + inline `requireRoles` feature gates |

---

## 🟡 Frontend — "Rose" assumptions & duplicated constants

### Crop magic-strings & default crop
| File:Line | Value |
|---|---|
| `frontend/src/lib/scouting-api.ts:14` | `DEFAULT_CROP = "Rose"` |
| `frontend/src/lib/router.ts:65` | `DEFAULT_CROP_SLUG = "rose"` |
| `frontend/src/App.tsx:223` | `crop === "rose" ? <RoseScouting /> : <AvocadoMap />` |
| `frontend/src/components/AppSidebar.tsx:247-248` | nav chosen by literal `"rose"` / `"avocado"` |
| `frontend/src/pages/dashboard/OverviewTab.tsx:68` | label switch on literal `"avocado"` |
| `frontend/src/pages/RoseScouting.tsx:130` | `crop: filters.crop || "Rose"` |
| `frontend/src/pages/Observations.tsx:81` | `crop: initialCrop ?? "Rose"` |

### Hardcoded per-crop navigation trees
| File:Line | Value |
|---|---|
| `frontend/src/components/AppSidebar.tsx:82-244` | `ROSE_NAV`, `AVOCADO_NAV`, `DEFAULT_CROP_NAV` — new crop requires a code change |

### Map defaults (geographic literals)
| File:Line | Value |
|---|---|
| `frontend/src/components/MapBase.tsx:26-27` | `DEFAULT_CENTER = [-1.387, 36.756]` ("Karen Roses HQ"), `DEFAULT_ZOOM = 12` |
| `frontend/src/components/Map3D.tsx:24` | `DEFAULT_CENTER = [36.756, -1.387]` (same coords, duplicated) |

### Domain enums / dropdown lists (look backend-sourced)
| File:Line | Value |
|---|---|
| `frontend/src/pages/ApplicationPlan.tsx:109-118` | `SPRAY_TYPES`, `SCOPES` |
| `frontend/src/components/spray-plan/SprayTeamEditor.tsx:54` | `ROLE_OPTIONS = ["Supervisor","Sprayer","Pump Operator"]` |
| `frontend/src/pages/Settings.tsx:43` | `TABS = [access, spray-plan, thresholds, ordering, farms, chemicals]` |
| `frontend/src/components/settings/ThresholdsTab.tsx:320-321` | `"Per Warehouse"` / `"Per Hectare"` |

### Business-logic colors keyed by pest/disease name
| File:Line | Value |
|---|---|
| `frontend/src/lib/observation-colors.ts:40-70+` | `PEST_PALETTE`, `DISEASE_PALETTE`, `PEST_LOOKUP` synonym table (documented as fallback mirroring backend `observation_colors.py`, overridden by live fetch — but taxonomy + colors still hardcoded) |
| `frontend/src/pages/maps/TreesLayer.ts:14` | `UNSCOUTED_COLOR = "#7c8b6a"` |

### Mock/sample data with real-looking values
| File:Line | Value |
|---|---|
| `frontend/src/pages/Labels.tsx:152-162` | `SAMPLE`: `STE-2026-00042`, `Pyretone 40EC`, `Chemical Store Kapkolia`, `Kapkolia CSU Phase 1`, `31 May 2026 09:00`, `Kapkolia GH 04` |

### Inconsistent sentinel strings
| File:Line | Value |
|---|---|
| `Dashboard.tsx:30`, `Labels.tsx:78`, `SprayPlanTransfers.tsx:55`, `ApplicationPlan.tsx:119` | `ALL_FARMS/ALL = "__all__"` |
| `frontend/src/pages/CreatorStock.tsx:155` | `ALL_FARMS = "__all_farms"` (**inconsistent value**) |
| `frontend/src/components/settings/SprayPlanTab.tsx:49` | `ALL_FARM_PICKER = "__pick__"` |

---

## 🟢 Legacy `www/` pages (heavier Rose-centric hardcoding)

| File:Line | Value |
|---|---|
| `upande_scp/www/scouting_dashboard/scouting_dashboard.js:43` | `var DEFAULT_CROP = "Rose"` (+ L105, L1014) |
| `upande_scp/www/scouting_trends/scouting_trends.js:23,348,1243` | `crop: "Rose"` default / filter |
| `upande_scp/www/scouting_trends/index.html:22`, `scouting_dashboard/index.html:22` | only `<option value="Rose">Rose</option>` |
| `upande_scp/www/rose_scouting/index.html:695`, `index.py:3` | `crops: ['', 'Rose', 'Roses']` filter |
| `upande_scp/www/library_of_blooms/library_of_blooms.js:546,575`, `index.py:124` | `BUSINESS_UNITS = ["Roses", "Endebess Coffee"]`; default `"Roses"` |
| `upande_scp/www/variety_map/index.html:234` | site-specific tileset `res.cloudinary.com/.../eldama-ravine_gdtrsv.pmtiles` (+ Google/ArcGIS tile URLs L222,230) |
| `upande_scp/www/library_of_blooms/library_of_blooms.js:9` | image host prefix `https://images.unsplash.com/photo-` |

---

## 🟢 Low risk / informational

- **Runtime CDN dependencies** (supply-chain consideration, not secrets): `cdn.tailwindcss.com`
  (`www/chemical_base.html:11`), flatpickr/maplibre/three/leaflet/turf/gsap via unpkg / jsDelivr /
  cdnjs across `www/` map pages, Google Fonts / rsms.me preconnects.
- **Fixed cron times** — `hooks.py:236-266` report schedules (`0 14 * * *`, `0 5 * * 1`, `0 8 * * 2` EAT).
- **Cache TTLs / windows** — see thresholds table above (mostly benign tuning).
- **Standard Frappe metadata** — `hooks.py:5` `app_email = "info@upande.com"`; doctype/report JSON `owner`
  fields (`judah@upande.com`, one `stephene@upande.com`).
- **Debug helper defaults** — `_debug_errors.py:166` `email="stephene@upande.com"`, `:180` role set.
- **Docstring examples only** (not executed) — `run_tree_automation.py:5,7` (`kaitet.local`, `/tmp/blk6.geojson`,
  `"DAIRY BLK 6 - KL"`), `create_sprayer_entry.py:116` (`sprayer@example.com`), various `- KL` warehouse names
  in mobile docstrings.
- **Test fixtures** — all `2026-05-*` / `2026-06-*` date literals live in `serverscripts/tests/` (intentional).
- **Printer** — `store_label_printing.py` targets a Bluetooth Zebra ZQ520; no MAC/pairing key hardcoded
  (device selected client-side).

---

## Recommended remediation order

1. **Email recipients** (§1) — route through the settings singleton, drop personal-Gmail fallbacks,
   clear the shipped fixture. *Highest data-exposure risk.*
2. **"Karen Roses" company / warehouse / letterhead** (§2) — settings-driven; unblocks other tenants
   (Mona port).
3. **Seed user** (§3) — remove or gate the auto-privilege.
4. **Per-tenant DocType branching + farm rosters** (medium) — settings/config table.
5. **Business thresholds** (`CSU_MAX_AGE_DAYS`, `WATER_VOLUME_RATE`, severity defaults) — move to editable
   settings; the CSU value is already flagged in-code as needing cross-file sync.
6. **Frontend crop/nav/role duplication** — derive nav & role gates from a single config; fix the
   `__all_farms` sentinel inconsistency.
