# Stage and Variety Weighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pest prevalence should mean "the live pest is there". Every Stage gets a **role**: **Life stage** (Eggs, Larvae, Adult …), **Form** (Motiles, Singles, Colonies …) or **Sign** (Damage, Web, Ragged Margins). It also gets a **weight**. An all-stage pest figure counts only Life stage and Form rows (S3). Sign rows become their own **signs** figure, shown beside the live one ("Thrips 12% · signs 30%", S4). A Count measure sums `weight × count` over the pest's counted Life stage and Form stages (S5). A crop's Pests Stages row can override the weight (S6). Agronomists also get a **By variety** table for the selected rose pest (`Scouting Entry.bed → Bed.variety`, S7) on the greenhouse modal and the Pests tab. Thresholds and alerts (3a/3b) judge the live figure. Signs are informational only.

**Architecture:** A new `common/stage_roles.py` holds the role and weight rules: pure helpers plus one site-wide Redis catalog built with raw SQL, the same pattern as `crop_catalog`. The catalog is dropped by Stage / Pest Filter / Pests Stages / Crop Scouted changes. `_prevalence_rows.StationWeeks` resolves each infested row's stage to a role. `infested_set` / `figures` / `latest` / `combined*` gain `role=LIVE|SIGNS`. The role filter applies only to an **all-stage pest** figure; a named stage or a disease reads its rows whatever their role. `station_counts` / `count_figures` / `count_latest` gain `weights`. `_common.load_thresholds` keeps Sign stages out of a row's `count_stages` and adds a hashable `count_weights`, which every Count reader passes on. The payloads gain `signs` (`prevalence.public` keys) on Overview cells and alerts, Pests ranking and pressure, and greenhouse-detail rows. Trends gains a `signsByStation` table. A new `dashboard_aggregates/_variety.py` groups each house's latest-week stations by bed variety. Its rows ride inside the cached `greenhouse_detail` pest rows and the `pests` payload. Schema: `Stage.stage_role` / `Stage.weight` and `Pests Stages.weight`, applied with `reload_doc`, then a fill-blanks seed patch run through the DB runner. The Settings → Thresholds editor shows each pest stage's role and edits its per-crop weight. The cache schema tag becomes `stg1`.

**Tech Stack:** Frappe v16 / Python 3.14, MariaDB; React 19 + TypeScript + Vite + vitest (jsdom, @testing-library/react) in `frontend/`.

**Spec:** `docs/superpowers/specs/2026-10-10-stage-variety-design.md` (binding; S1–S8 are rulings). It builds on piece 2 (`docs/superpowers/plans/2026-10-09-station-prevalence.md`), 3a (`…/2026-10-10-thresholds-and-actions.md`) and 3b (`…/2026-10-10-hot-spots.md`). Verified against HEAD `80edc9c` (3b Tasks 1–5 landed). **3b's frontend task and all of 3c (spread & pins) are still being built on this branch first.** They touch `thresholds_check.py`, `_gh_detail.py`, `_prevalence_rows.py` (3c adds `station_ranks`), `SectionGrid` / `GreenhouseModal`, and the cache schema tag (3b `"hot1"`, 3c `"pin1"`). **Locate every edit by function, class or JSX landmark name. Line numbers below are hints only.**

## Global Constraints

- Site is **`kaitet.local`** only (read-only SQL: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT …"`). **Never use the Kaitet MCP** (`mcp__claude_ai_Kaitet*`), for anything.
- Commits: **no `Co-Authored-By` trailer** (CLAUDE.md). Style `feat(scp): …` / `fix(scp): …` / `feat(scp-ui): …`, lowercase sentence.
- Stage with explicit `git add <paths>` only. **Never stage** the unrelated uncommitted store/batch-transfer work: `frontend/src/components/store/TransferBatchPanel.tsx`, `frontend/src/lib/store-keeper-api.ts`, `frontend/src/pages/SprayPlanTransfers.tsx`, `upande_scp/serverscripts/store/batch_suggestion.py`, `upande_scp/serverscripts/store/store_keeper_api.py`, `upande_scp/serverscripts/tests/test_batch_suggestion.py`, `upande_scp/serverscripts/tests/test_transfer_batch_apply.py`, `upande_scp/serverscripts/tests/test_transfer_batch_gating.py`, `upande_scp/serverscripts/tests/test_transfer_batch_split.py`. Never `git add -A` / `git add .` / `git commit -a`. **Never `git stash`.** Run `git status --short` before every commit. 3b/3c files that another worker has modified and not committed are not yours either: stage only the paths your task names.
- **NEVER restart anything on this server**: no `supervisorctl restart`, no `bench restart`, no MariaDB/Redis restart — another live site streams data on this server. `yarn build` is allowed. Consequence: the running web workers keep the old Python, and the old `hooks.py` (`doc_events`), until someone else restarts them. So every server-side check in this plan runs **in-process through the DB runner**, never through the web server. Tests call `cache_utils.invalidate_on_change` directly instead of relying on `doc_events`.
- Schema changes go through doctype JSON. Apply them with the DB runner (`frappe.reload_doc(..., force=True)`, a patch's `execute()` plus a `Patch Log` row), as each task spells out. `bench --site kaitet.local migrate` restarts no service, but it runs every pending patch and hook of every app. Use it **only** if you have checked that nothing streams into kaitet.local's database (`_a0667cbad37a1f08`) at that moment. If unsure, use the DB-runner path. **This plan uses `reload_doc` for two doctypes and one patch (`seed_stage_roles`), applied with `execute()` + a `Patch Log` row. It needs no migrate.**
- **The seed is fill-blanks-only.** `seed_stage_roles` writes a role only where `stage_role` is NULL or `""`, never touches `weight`, and never bumps `modified`. `Stage.stage_role` therefore has **no column default** in the JSON. A Select `"default"` becomes a MariaDB `DEFAULT`, which `ADD COLUMN` writes into every existing row, and then no row would look blank to the patch. New stages still get `Life stage`: it is the first Select option (Frappe's `create_new` default), and `Stage.validate` sets it as a fallback.
- **Redis is not transactional.** The stage-roles catalog (`scp:stage_roles_v1`) is cached site-wide. A test that changes a role or weight inside its rolled-back transaction leaves that value in Redis for up to an hour, unless it calls `SV.reset()` **after** `frappe.db.rollback()`. Every new DB test class does that in `tearDown`, so no test value reaches the live site.
- **No email is sent during tests**: every test that can reach `frappe.sendmail` or `notifications.notify` patches it. `save_thresholds` commits, so its test calls run with `frappe.db.commit` patched out (the `test_thresholds_measure` pattern).
- Indentation matches each file: 4 spaces in `common/stage_roles.py`, `common/cache_utils.py`, `hooks.py`, `dashboard_aggregates/*`, `scouting/*`, `store/thresholds_api.py` and every test module and fixture. **Tabs** in doctype controllers (`stage.py`) and patches (`seed_stage_roles.py`). 1 space in doctype JSON; 2 spaces in TS/TSX.
- UI: **no vertical accent strips and no coloured left-border bars**. Show accent through text colour, a tinted background or a pill. A greyed row is `text-muted-foreground opacity-60`.
- **Piece 1 crop scoping, piece 2 figures, 3a alerts and 3b hot spots keep holding.** Every new scouting query goes through `parent_filter_conditions` (D5) and, for child rows, `obs_filter` (D4). The only new query is `_variety.station_beds`, a parent-only scan with D5. Regression gate, all green at the end of every task that touches their code: `test_dashboard_aggregates_{overview,pests_diseases,gh_detail,traps,fcm}`, `test_prevalence_{rows,overview,pests,trends}`, `test_crop_scoped_{aggregates,aggregate_detail,observations,spray_plan}`, `test_spray_compliance_enforcement`, `test_scouting_alerts`, `test_alert_digest`, `test_scouting_alert_creator`, `test_thresholds_measure`, `test_threshold_measure_dashboards`, `test_hot_spots` (DB), and `test_prevalence_pure`, `test_prevalence_rows_pure`, `test_trends_prevalence_pure`, `test_threshold_core_pure`, `test_threshold_counts_pure`, `test_hot_spots_pure` (pure). **Plus 3c's suites once they exist**: run `ls upande_scp/serverscripts/tests/ | grep -E 'clust|pin|spread'` and add every module it lists (pure ones under pytest, the rest with DB-RUN).
- **S3 reaches every all-stage pest figure, including 3b's sections and 3c's clusters/pins.** They read `infested_set` / `figures` with no stage, so they turn live-only with no code change. If a piece 2 / 3a / 3b / 3c regression test fails only because it seeded a **Sign** stage (`Damages`, `Damage`, `Web`, `Ragged Margins`, `FCM Damage`) as its infestation and read an all-stage figure, change the seed to a Life stage (`Adult`) and add the comment `# piece 4 (S3): a Sign is not the live pest`. Never change an assertion to fit. At HEAD no such test exists: every all-stage seed uses `Adult` / `Singles`, and the `Damages` seeds in `test_threshold_measure_dashboards` read stage-specific cells, whose meaning is unchanged.
- Exact spec numbers and strings: roles **`Life stage` / `Form` / `Sign`** (default Life stage); weight default **1.0**; seed **Sign** = `Damage, Damages, FCM Damage, Web, Ragged Margins`, **Form** = `Motiles, Singles, Colonies, Scales, Scale Insects, Adult Cloud, Adult Singles`, everything else Life stage. On kaitet.local's 42 stages that is **Sign 5 / Form 7 / Life stage 30**. Pests Stages `weight` **0 = use the Stage's weight** (a Frappe Float is `NOT NULL DEFAULT 0`, so "blank" is 0). **`VARIETY_MIN_N = 10`** scouted stations, below which a variety is greyed **"too few"**. Stations on a bed with no variety are labelled **"No variety recorded"**. Payload key **`signs`**, Trends table **`signsByStation`** rows `[week, station, obs, signs %]`, gh-detail / pests key **`varieties`**, cache schema tag **`"stg1"`**.
- Test commands:
  - Pure (no site): `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q <path>`
  - DB (direct runner; tests roll back in `tearDown`): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); import importlib; M=importlib.import_module('upande_scp.serverscripts.tests.<module>'); r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M)); raise SystemExit(not r.wasSuccessful())"` — written below as **DB-RUN `<module>`**.
  - One-off DB runner (schema): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe; frappe.init(site='kaitet.local'); frappe.connect(); <statements>; frappe.db.commit()"` — written below as **DB-EXEC `<statements>`**.
  - Frontend: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run <path>`; typecheck `npx tsc --noEmit -p tsconfig.app.json`; build `yarn build`.
- DB tests seed raw-SQL Scouting Entries in **2031-W44 (2031-10-27…11-02) and 2031-W45 (11-03…09)**, through `TF.seed_week` (3 stations per 3 × 3 section, so 27 per house). Before Task 2, run `grep -rn "2031-1[01]-" upande_scp/serverscripts/tests/` and confirm no other module (3c included) seeds those dates. If one does, move this plan's two weeks to the next free pair and change `SV.WEEK_44` / `SV.WEEK_45` / `SUN_44` together. kaitet.local holds real scouting 2026-07-18 → 2026-10-10 only. `evaluate` takes an explicit `today`.
- `dashboard_aggregates/__init__.py` rebinds `_overview`, `_gh_detail`, `_trends` to functions: load them with `importlib.import_module("upande_scp.serverscripts.dashboard_aggregates._<name>")`.

## Review Focus

The five failure modes most likely to slip past the tests, each with the test that pins it:

1. **The seed silently does nothing, or overwrites an agronomist's choice.** Two ways this goes wrong. A `"default"` on `stage_role` would fill every existing row with `Life stage` on `ADD COLUMN`, so the fill-blanks patch would skip all 42 rows and Damages would stay "live" for ever. A patch that writes unconditionally would undo an agronomist's edit on the next migrate. → Task 2 `test_the_role_column_has_no_db_default_and_weights_default_to_one`, `test_the_patch_fills_blank_roles_only`.
2. **A Sign leaking into the live judgement by a side door.** Damage is a *Count* reading on Rose/Avocado FCM and on every avocado `Damages` row. If `count_stages` still listed it, a Count band would alert on damage alone. Likewise, `evaluate` must read the live figure. → Task 3 `test_a_count_row_never_sums_a_sign_stage`, `test_evaluate_judges_the_live_figure`.
3. **Stage-specific figures changing meaning.** A `Damages` stage band must still measure damage. A weight must scale only the row's all-stage Count, never a stage band's raw count. → Task 1 `test_a_named_sign_stage_still_measures_the_sign`. Task 3 `test_a_stage_band_reads_raw_counts_whatever_the_weight`.
4. **Stale or poisoned weights.** Three risks: a figure memoised without its weights (a weighted and a plain Count answer each other); a zero override read as "weight 0" instead of "inherit"; a test's rolled-back role change surviving in Redis. → Task 1 `test_weighted_and_plain_figures_are_memoised_apart`. Task 2 `test_a_zero_override_inherits_the_master_weight`, `test_a_rolled_back_role_change_never_outlives_the_test`, `test_a_stage_change_drops_the_cached_roles_and_the_dashboards`.
5. **The variety table counting the wrong stations.** It must use only each house's latest scouted week (not the whole range), never appear for avocado blocks (no bed variety), and grey varieties under 10 stations. → Task 5 `test_only_each_houses_latest_week_is_grouped`, `test_an_avocado_block_has_no_variety_table`, `test_varieties_group_by_bed_variety_and_grey_the_small_ones`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `upande_scp/serverscripts/common/stage_roles.py` (new) | Roles / weights rules (pure) + cached catalog: `role_map`, `master_weight`, `stage_weight`, `pest_weights`, `sign_stages`, `invalidate_stage_roles` |
| `upande_scp/serverscripts/common/cache_utils.py` (mod) | `K_STAGE_ROLES`; invalidation for Stage / Pests Stages / Pest Filter / Crop Scouted; Stage bumps the dashboard version |
| `upande_scp/hooks.py` (mod) | `"Stage": _SCP_CACHE_EVENTS` in `doc_events` |
| `upande_scp/upande_scp/doctype/stage/stage.json`, `stage.py` (mod) | `stage_role`, `weight`; `validate` fills a blank role |
| `upande_scp/upande_scp/doctype/pests_stages/pests_stages.json` (mod) | `weight` (0 = the Stage's) |
| `upande_scp/patches/v1_0/seed_stage_roles.py` (new), `upande_scp/patches.txt` (mod) | Fill-blanks seed of roles (S2) |
| `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (mod) | `LIVE` / `SIGNS`; role-aware `infested_set` & figures; weighted counts; `scouted_set`; `signs_latest` / `signs_combined_latest` |
| `upande_scp/serverscripts/dashboard_aggregates/_common.py` (mod) | Live `count_stages`, `count_weights`; `house_value` passes weights; `K_DASH_AGG_SCHEMA = "stg1"` |
| `upande_scp/serverscripts/scouting/thresholds_check.py` (mod) | `_figure` passes weights |
| `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` (mod) | `_mark_hot` passes weights; rows carry `signs`, `varieties` |
| `upande_scp/serverscripts/dashboard_aggregates/_overview.py`, `_pests_diseases.py`, `_trends.py` (mod) | `signs` on cells / alerts / ranking / pressure; `varieties` on pests; `signsByStation` |
| `upande_scp/serverscripts/dashboard_aggregates/_variety.py` (new) | `group_by_variety` (pure), `latest_weeks`, `station_beds`, `breakdown`, `variety_breakdown` |
| `upande_scp/serverscripts/store/thresholds_api.py` (mod) | Stage rows carry `role` / `master_weight` / `weight`; save writes `weight` |
| `upande_scp/serverscripts/tests/stage_variety_fixture.py` (new) | `WEEK_44/45`, `reset`, `set_role`, `set_master_weight`, `set_override`, `seeded_stations`, `set_bed_variety` |
| `upande_scp/serverscripts/tests/test_stage_variety_pure.py` (new) | Pure: roles, live/signs, weighted counts, variety grouping |
| `upande_scp/serverscripts/tests/test_stage_variety.py` (new) | DB: schema & seed, catalog, live judgement, payload signs, varieties, editor |
| `upande_scp/serverscripts/tests/test_prevalence_overview.py` (mod) | Schema-tag test reads `stg1` |
| `frontend/src/lib/prevalence.ts` (+ test) (mod) | `signs` in `PrevalenceFigures`, `figureLine`, tooltip; `VarietyRow` |
| `frontend/src/pages/dashboard/VarietyTable.tsx` (new) + `__tests__/VarietyTable.test.tsx` (new) | The By-variety table |
| `frontend/src/pages/dashboard/GreenhouseModal.tsx`, `PestsTab.tsx`, `pests-diseases-types.ts` (mod) + `__tests__/GreenhouseModal.sections.test.tsx` (mod) | Table placement, types |
| `frontend/src/pages/trends/trends-types.ts`, `aggregate.ts` (mod) + `__tests__/prevalence-band.test.ts` (mod) | `signsByStation` → `PrevalencePoint.signs` |
| `frontend/src/lib/thresholds-api.ts`, `frontend/src/components/settings/ThresholdsTab.tsx` (mod) + `__tests__/ThresholdsTab.test.tsx` (mod) | Role pill + weight input |

---

### Task 1: Stage roles, the live / signs split and weighted counts (pure)

**Files:**
- Create: `upande_scp/serverscripts/common/stage_roles.py`
- Modify: `upande_scp/serverscripts/common/cache_utils.py` (add one key beside `K_CROP_CATALOG`, line ~78)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (imports; constants after `PREVIOUS_LOOKBACK_DAYS`; `StationWeeks.__init__`, `load`, `infested_set`, `figures`, `latest`, `previous`, `combined`, `combined_latest`, `station_counts`, `count_figures`, `count_latest`)
- Test: `upande_scp/serverscripts/tests/test_stage_variety_pure.py` (new)

**Interfaces:**
- Produces:
  - `stage_roles.LIFE_STAGE / FORM / SIGN`, `ROLES`, `LIVE_ROLES`, `DEFAULT_WEIGHT`, `SEED_SIGNS`, `SEED_FORMS`, `SEED_ROLES`
  - pure: `seed_role(stage)`, `normalise_role(value)`, `role_of(stage, roles)`, `is_live(stage, roles)`, `resolve_weight(master, override)`, `build(stage_rows, filter_rows) -> {"roles", "weights", "pests"}`, `weight_in(cat, crop, pest, stage)`, `signs_in(cat, crop, pest=None)`
  - cached (DB): `catalog()`, `invalidate_stage_roles()`, `role_map()`, `master_weight(stage)`, `stage_weight(crop, pest, stage)`, `pest_weights(crop, pest)`, `sign_stages(crop, pest=None)`. Each column is read through `has_column`, so before Task 2's schema every stage reads Life stage / 1.0, which is today's behaviour.
  - `cache_utils.K_STAGE_ROLES = "scp:stage_roles_v1"`
  - `R.LIVE = "live"`, `R.SIGNS = "signs"`. `StationWeeks(scouted_rows, infested_rows, grid_loader=None, roles=None)`: `roles` None → the S2 seed (pure use). `StationWeeks.load(..., roles=None)`: None → `stage_roles.role_map()`.
  - `infested_set / figures / latest / previous / combined / combined_latest(..., role=R.LIVE)`. The role filters only when `kind == "pest"` and `stage is ANY`.
  - `station_counts / count_figures / count_latest(..., weights=None)`. `weights` is `((stage, w), …)` or a dict. A stage it does not name counts at 1.0, and a weight of 0 drops the stage.

- [ ] **Step 1: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_stage_variety_pure.py`:

```python
"""Stage & variety (piece 4): stage roles, the live / signs split and weighted
counts over hand-built rows. Plain pytest, no site."""

import unittest
from importlib import import_module

from upande_scp.serverscripts.common import stage_roles as S

R = import_module("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows")

# 27 stations, 3 in each of the 9 sections (the test_prevalence_rows_pure shape).
GRID = {f"Z{r}{c}{k}": (r, c) for r in range(3) for c in range(3) for k in range(3)}
YW, WEEK = 203144, "2031-W44"


def kth(k):
    """Station k (0, 1 or 2) of every section."""
    return sorted(n for n in GRID if n.endswith(str(k)))


def scouted(wh, yw, stations, in_win=1):
    return [{"wh": wh, "station": s, "yw": yw, "in_win": in_win} for s in stations]


def rows(wh, yw, stations, stage, obs="Thrips", kind="pest", count=0):
    return [{"wh": wh, "station": s, "yw": yw, "kind": kind, "obs": obs, "stage": stage,
             "section": "Leaf", "count": count} for s in stations]


def weeks(scouted_rows, infested_rows, roles=None):
    return R.StationWeeks(scouted_rows, infested_rows, grid_loader=lambda wh: dict(GRID), roles=roles)


CAT_STAGES = [
    {"name": "Eggs", "stage_role": None, "weight": 0.5},
    {"name": "Web", "stage_role": "Sign", "weight": 1},
]
CAT_FILTERS = [
    {"crop": "Rose", "pest": "Spidermites", "stage": "Eggs", "weight": 0.25},
    {"crop": "Rose", "pest": "Spidermites", "stage": "Web", "weight": 0},
    {"crop": "Rose", "pest": "Whiteflies", "stage": "Eggs", "weight": 0},
]


class TestStageRoles(unittest.TestCase):
    def test_the_seed_names_signs_and_forms_and_everything_else_is_a_life_stage(self):
        self.assertEqual([S.seed_role(s) for s in S.SEED_SIGNS], ["Sign"] * 5)
        self.assertEqual(S.SEED_SIGNS, ("Damage", "Damages", "FCM Damage", "Web", "Ragged Margins"))
        self.assertEqual([S.seed_role(s) for s in S.SEED_FORMS], ["Form"] * 7)
        self.assertEqual(S.SEED_FORMS, ("Motiles", "Singles", "Colonies", "Scales", "Scale Insects",
                                        "Adult Cloud", "Adult Singles"))
        self.assertEqual([S.seed_role(s) for s in ("Eggs", "Adult", "Larvae", "Egg Sacs", "Fresh", "", None)],
                         ["Life stage"] * 7)

    def test_a_blank_unknown_or_unlisted_role_reads_as_a_life_stage(self):
        roles = {"Damages": "Sign", "Eggs": "", "Odd": "Weird"}
        self.assertEqual([S.role_of(s, roles) for s in ("Damages", " Damages ", "Eggs", "Odd", "Unlisted", "", None)],
                         ["Sign", "Sign", "Life stage", "Life stage", "Life stage", "Life stage", "Life stage"])
        self.assertTrue(S.is_live("Motiles", {"Motiles": "Form"}))
        self.assertFalse(S.is_live("Damages", roles))

    def test_an_override_wins_zero_inherits_and_a_master_zero_stays_zero(self):
        self.assertEqual(S.resolve_weight(1.0, 0.25), 0.25)
        self.assertEqual(S.resolve_weight(0.5, 0), 0.5)
        self.assertEqual(S.resolve_weight(0.5, None), 0.5)
        self.assertEqual(S.resolve_weight(0.0, None), 0.0)
        self.assertEqual(S.resolve_weight(None, None), 1.0)
        self.assertEqual(S.resolve_weight(-2, None), 0.0)

    def test_build_folds_the_master_and_the_per_crop_overrides(self):
        cat = S.build(CAT_STAGES, CAT_FILTERS)
        self.assertEqual(cat["roles"], {"Eggs": "Life stage", "Web": "Sign"})
        self.assertEqual(cat["weights"], {"Eggs": 0.5, "Web": 1.0})
        self.assertEqual(cat["pests"], {"Rose": {"Spidermites": {"Eggs": 0.25, "Web": 1.0},
                                                 "Whiteflies": {"Eggs": 0.5}}})

    def test_weights_and_sign_stages_are_read_per_crop_and_pest(self):
        cat = S.build(CAT_STAGES, CAT_FILTERS)
        self.assertEqual(S.weight_in(cat, "Rose", "Spidermites", "Eggs"), 0.25)
        self.assertEqual(S.weight_in(cat, "Rose", "Aphids", "Eggs"), 0.5)          # not on that row: the master
        self.assertEqual(S.weight_in(cat, "Rose", "Spidermites", "Unknown"), 1.0)
        self.assertEqual(S.signs_in(cat, "Rose", "Spidermites"), ["Web"])
        self.assertEqual(S.signs_in(cat, "Rose", "Whiteflies"), [])
        self.assertEqual(S.signs_in(cat, "Rose"), ["Web"])                           # any pest of the crop
        self.assertEqual(S.signs_in(cat, "Avocado"), [])
        self.assertEqual(S.signs_in(cat, ""), [])


class TestLiveAndSigns(unittest.TestCase):
    """Adult on station 0 of each section; Damages on stations 0 and 1."""

    def setUp(self):
        self.w = weeks(scouted("GH A", YW, GRID),
                       rows("GH A", YW, kth(0), "Adult") + rows("GH A", YW, kth(0) + kth(1), "Damages"))

    def test_a_station_with_only_a_sign_is_not_infested_for_the_live_figure(self):
        live = self.w.infested_set("GH A", WEEK, "pest", "Thrips")
        self.assertEqual(live, set(kth(0)))
        self.assertNotIn("Z001", live)
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips")["prevalence"], 33.3)   # was 66.7 before S3

    def test_signs_are_their_own_figure(self):
        self.assertEqual(self.w.infested_set("GH A", WEEK, "pest", "Thrips", role=R.SIGNS), set(kth(0) + kth(1)))
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(self.w.combined_latest("pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(self.w.combined(WEEK, "pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)

    def test_a_named_sign_stage_still_measures_the_sign(self):
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", "Damages")["prevalence"], 66.7)
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", "Damages", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(self.w.latest("GH A", "pest", "Thrips", "Adult")["prevalence"], 33.3)

    def test_any_pest_reads_live_too(self):
        self.assertEqual(self.w.latest("GH A", "pest")["prevalence"], 33.3)
        self.assertEqual(self.w.latest("GH A", "pest", role=R.SIGNS)["prevalence"], 66.7)

    def test_diseases_ignore_roles(self):
        w = weeks(scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "Damages", obs="Botrytis", kind="disease"))
        self.assertEqual(w.latest("GH A", "disease", "Botrytis")["prevalence"], 33.3)
        self.assertEqual(w.latest("GH A", "disease", "Botrytis", role=R.SIGNS)["prevalence"], 33.3)

    def test_the_roles_given_decide(self):
        eggs = (scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "Eggs"))
        self.assertEqual(weeks(*eggs).latest("GH A", "pest", "Thrips")["prevalence"], 33.3)
        self.assertEqual(weeks(*eggs, roles={"Eggs": "Sign"}).latest("GH A", "pest", "Thrips")["prevalence"], 0.0)
        damages = (scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "Damages"))
        # No roles at all: every stage is a life stage — the pre-S3 figure.
        self.assertEqual(weeks(*damages, roles={}).latest("GH A", "pest", "Thrips")["prevalence"], 33.3)

    def test_a_pest_row_with_no_stage_is_live(self):
        w = weeks(scouted("GH A", YW, GRID), rows("GH A", YW, kth(0), "", count=2))
        self.assertEqual(w.latest("GH A", "pest", "Thrips")["prevalence"], 33.3)


class TestWeightedCounts(unittest.TestCase):
    """Spidermites on station 0 of each section: Adult 3 and Eggs 6."""

    def setUp(self):
        self.w = weeks(scouted("GH A", YW, GRID),
                       rows("GH A", YW, kth(0), "Adult", obs="Spidermites", count=3)
                       + rows("GH A", YW, kth(0), "Eggs", obs="Spidermites", count=6))
        self.stages = frozenset({"Adult", "Eggs"})

    def counts(self, weights=None):
        return self.w.station_counts("GH A", WEEK, "pest", "Spidermites", self.stages, weights=weights)

    def test_weights_of_one_reproduce_the_plain_sum(self):
        self.assertEqual(self.counts()["Z000"], 9.0)
        self.assertEqual(self.counts((("Adult", 1.0), ("Eggs", 1.0))), self.counts())

    def test_half_weight_on_eggs_halves_their_contribution(self):
        self.assertEqual(self.counts({"Eggs": 0.5})["Z000"], 6.0)
        fig = self.w.count_latest("GH A", "pest", "Spidermites", self.stages, weights=(("Eggs", 0.5),))
        self.assertEqual(fig["value"], 2.0)                                 # (3 + 0.5·6) / 3 per section

    def test_a_zero_weight_drops_the_stage(self):
        self.assertEqual(self.counts({"Eggs": 0})["Z000"], 3.0)

    def test_weighted_and_plain_figures_are_memoised_apart(self):
        vals = [self.w.count_figures("GH A", WEEK, "pest", "Spidermites", self.stages, weights=w)["value"]
                for w in (None, (("Eggs", 0.5),), None, (("Eggs", 1.0),))]
        self.assertEqual(vals, [3.0, 2.0, 3.0, 3.0])
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_stage_variety_pure.py`
Expected: collection ERROR, `ModuleNotFoundError: No module named 'upande_scp.serverscripts.common.stage_roles'`.

- [ ] **Step 3: The cache key**

In `upande_scp/serverscripts/common/cache_utils.py`, directly below `K_CROP_CATALOG = "scp:crop_catalog_v1"` add:

```python
#: Stage roles (Life stage / Form / Sign), master weights and per-crop weight
#: overrides — common/stage_roles.py (stage & variety spec S1–S6).
K_STAGE_ROLES = "scp:stage_roles_v1"
```

- [ ] **Step 4: `common/stage_roles.py`**

Create `upande_scp/serverscripts/common/stage_roles.py`:

```python
"""Stage roles and weights (stage & variety spec S1–S6).

A Stage is a **Life stage** (Eggs, Larvae, Adult …), a **Form** the live pest
takes (Motiles, Singles, Colonies …) or a **Sign** of the pest (Damage, Web,
Ragged Margins). Live-pest prevalence counts Life stage and Form rows only; a
Sign row is reported as its own figure ("signs") and never as the pest (S3, S4).

``weight`` scales a stage's count in a pest's all-stage Count (S5): the Stage
master's weight, overridden for one crop's pest by its Pest Filter's Pests
Stages row (S6). A Frappe Float cannot be NULL, so an override of 0 means "use
the master's weight"; to drop a stage from every Count, set the master to 0.

**One site-wide Redis entry, built with raw SQL**, like ``crop_catalog``, and
dropped by any Stage / Pest Filter / Pests Stages / Crop Scouted change
(``cache_utils._DOC_INVALIDATIONS``) and by the thresholds editor's save. Every
column is read through ``has_column``: before the schema exists every stage
reads Life stage / 1.0, which is the pre-S3 behaviour.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.common.cache_utils import (
    K_STAGE_ROLES,
    TTL_MEDIUM,
    get_or_set,
    invalidate,
)

LIFE_STAGE = "Life stage"
FORM = "Form"
SIGN = "Sign"
ROLES = (LIFE_STAGE, FORM, SIGN)
#: The roles that are the live pest (S3).
LIVE_ROLES = frozenset({LIFE_STAGE, FORM})
DEFAULT_WEIGHT = 1.0

#: S2 — the seed. Every stage not listed is a Life stage.
SEED_SIGNS = ("Damage", "Damages", "FCM Damage", "Web", "Ragged Margins")
SEED_FORMS = ("Motiles", "Singles", "Colonies", "Scales", "Scale Insects", "Adult Cloud", "Adult Singles")
SEED_ROLES = {**{s: SIGN for s in SEED_SIGNS}, **{s: FORM for s in SEED_FORMS}}


# ── pure ───────────────────────────────────────────────────────────────────


def seed_role(stage) -> str:
    """The S2 role for a stage name (the seed patch's rule)."""
    return SEED_ROLES.get((stage or "").strip(), LIFE_STAGE)


def normalise_role(value) -> str:
    """A stored role, or Life stage for a blank / unknown one (the S1 default)."""
    value = (value or "").strip()
    return value if value in ROLES else LIFE_STAGE


def role_of(stage, roles) -> str:
    """The role of ``stage`` in ``roles`` (``{stage: role}``). A pest row with
    no stage, or a stage the master does not list, is a Life stage."""
    stage = (stage or "").strip()
    if not stage:
        return LIFE_STAGE
    return normalise_role((roles or {}).get(stage))


def is_live(stage, roles) -> bool:
    return role_of(stage, roles) in LIVE_ROLES


def _float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def resolve_weight(master, override) -> float:
    """S6: the Pests Stages override when it is set (> 0), else the master's
    weight (never negative), else 1.0."""
    o = _float(override)
    if o is not None and o > 0:
        return o
    m = _float(master)
    if m is None:
        return DEFAULT_WEIGHT
    return max(0.0, m)


def build(stage_rows, filter_rows) -> dict:
    """Fold the raw rows into the catalog. Pure.

    ``stage_rows``: ``{"name", "stage_role", "weight"}`` per Stage.
    ``filter_rows``: ``{"crop", "pest", "stage", "weight"}`` per Pests Stages row
    of a Pest Filter. Returns ``{"roles": {stage: role}, "weights": {stage:
    master weight}, "pests": {crop: {pest: {stage: effective weight}}}}`` —
    ``pests`` also lists which stages each crop's pest records."""
    roles: dict = {}
    weights: dict = {}
    for r in stage_rows or ():
        name = (r.get("name") or "").strip()
        if not name:
            continue
        roles[name] = normalise_role(r.get("stage_role"))
        weights[name] = resolve_weight(r.get("weight"), None)
    pests: dict = {}
    for r in filter_rows or ():
        crop = (r.get("crop") or "").strip()
        pest = (r.get("pest") or "").strip()
        stage = (r.get("stage") or "").strip()
        if not (crop and pest and stage):
            continue
        pests.setdefault(crop, {}).setdefault(pest, {})[stage] = resolve_weight(weights.get(stage), r.get("weight"))
    return {"roles": roles, "weights": weights, "pests": pests}


def weight_in(cat, crop, pest, stage) -> float:
    """``stage``'s weight for ``crop``'s ``pest``: the row's effective weight,
    else the master's, else 1.0."""
    stage = (stage or "").strip()
    per = ((cat.get("pests") or {}).get(crop or "") or {}).get(pest or "") or {}
    if stage in per:
        return per[stage]
    return resolve_weight((cat.get("weights") or {}).get(stage), None)


def signs_in(cat, crop, pest=None) -> list:
    """The Sign stages ``crop``'s Pest Filter lists for ``pest`` (any pest when
    None), sorted. Empty → the pest has no signs figure (S4)."""
    per = (cat.get("pests") or {}).get(crop or "") or {}
    roles = cat.get("roles") or {}
    pests = [pest] if pest else list(per)
    return sorted({s for p in pests for s in (per.get(p) or {}) if role_of(s, roles) == SIGN})


# ── cached catalog ─────────────────────────────────────────────────────────


def _load() -> dict:
    has = frappe.db.has_column
    role_col = "stage_role" if has("Stage", "stage_role") else "NULL"
    weight_col = "weight" if has("Stage", "weight") else "NULL"
    override_col = "s.weight" if has("Pests Stages", "weight") else "0"
    return build(
        frappe.db.sql(
            f"select name, {role_col} as stage_role, {weight_col} as weight from `tabStage`",
            as_dict=True,
        ),
        frappe.db.sql(
            f"""select pf.crop_scouted as crop, pf.pest as pest, s.stage as stage, {override_col} as weight
                from `tabPests Stages` s
                join `tabPest Filter` pf on pf.name = s.parent
                where s.parenttype = 'Pest Filter'
                  and ifnull(pf.crop_scouted, '') != '' and ifnull(pf.pest, '') != ''""",
            as_dict=True,
        ),
    )


def catalog() -> dict:
    return get_or_set(K_STAGE_ROLES, _load, ttl=TTL_MEDIUM) or {}


def invalidate_stage_roles() -> None:
    invalidate(K_STAGE_ROLES)


def role_map() -> dict:
    """``{stage: role}`` for every Stage."""
    return dict(catalog().get("roles") or {})


def master_weight(stage) -> float:
    return resolve_weight((catalog().get("weights") or {}).get((stage or "").strip()), None)


def stage_weight(crop, pest, stage) -> float:
    return weight_in(catalog(), crop, pest, stage)


def pest_weights(crop, pest) -> dict:
    """``{stage: effective weight}`` for every stage ``crop``'s ``pest`` records."""
    return dict(((catalog().get("pests") or {}).get(crop or "") or {}).get(pest or "") or {})


def sign_stages(crop, pest=None) -> list:
    return signs_in(catalog(), crop, pest)
```

- [ ] **Step 5: `StationWeeks` reads roles and weights**

In `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py`:

(a) Imports: below `from upande_scp.serverscripts.common import prevalence as P` add `from upande_scp.serverscripts.common import stage_roles`.

(b) Below `PREVIOUS_LOOKBACK_DAYS = 35` add:

```python
#: Role selectors for an all-stage pest figure (stage & variety S3, S4).
LIVE = "live"     # Life stage + Form rows: the live pest (the default)
SIGNS = "signs"   # Sign rows: damage, webs, ragged margins
_SIGN_ROLES = frozenset({stage_roles.SIGN})


def _weights_key(weights):
    """A hashable memo key for ``weights`` (``((stage, w), …)`` or a dict)."""
    return tuple(sorted(dict(weights).items())) if weights else None
```

(c) `StationWeeks.__init__`: the signature becomes `def __init__(self, scouted_rows, infested_rows, grid_loader=None, roles=None):`. Append to its docstring: "``roles`` is ``{stage: role}``; None (the hand-built path) is the S2 seed, and ``load`` passes the Stage master's." Right after `self._grid_loader = grid_loader` add:

```python
        self._roles = dict(stage_roles.SEED_ROLES) if roles is None else dict(roles)
        self._role_memo: dict = {}
```

(d) `StationWeeks.load`: the signature gains `roles=None` after `weeks=LATEST`. The line `out = cls([], [], grid_loader=grid_loader)` becomes:

```python
        out = cls([], [], grid_loader=grid_loader,
                  roles=stage_roles.role_map() if roles is None else roles)
```

(e) Replace `infested_set` and `figures` with:

```python
    def _wanted_roles(self, kind, stage, role):
        """S3/S4: an all-stage pest figure reads Life stage + Form rows (``LIVE``)
        or Sign rows (``SIGNS``). A named stage, or a disease, reads its rows
        whatever their role — a stage-specific figure on a Sign measures the sign."""
        if kind != "pest" or stage is not ANY:
            return None
        return _SIGN_ROLES if role == SIGNS else stage_roles.LIVE_ROLES

    def _role(self, stage) -> str:
        role = self._role_memo.get(stage)
        if role is None:
            role = self._role_memo[stage] = stage_roles.role_of(stage, self._roles)
        return role

    def infested_set(self, wh, week, kind, obs=ANY, stage=ANY, section=ANY, role=LIVE) -> set:
        wanted = self._wanted_roles(kind, stage, role)
        out: set = set()
        for (k, o, g, s), stations in self._infested.get((wh, week), {}).items():
            if k != kind:
                continue
            if obs is not ANY and o != obs:
                continue
            if stage is not ANY and g != stage:
                continue
            if section is not ANY and s != section:
                continue
            if wanted is not None and self._role(g) not in wanted:
                continue
            out |= stations
        return out

    def figures(self, wh, week, kind, obs=ANY, stage=ANY, section=ANY, role=LIVE):
        key = (wh, week, kind, obs, stage, section, role)
        if key not in self._memo:
            scouted = self._scouted.get((wh, week))
            fig = None
            if scouted:
                grid = self.grid(wh)
                if (wh, week) not in self._counts:
                    self._counts[(wh, week)] = P.section_counts(grid, scouted)
                fig = P.figures(
                    grid, scouted,
                    self.infested_set(wh, week, kind, obs, stage, section, role),
                    scouted_counts=self._counts[(wh, week)],
                )
                if fig is not None:
                    fig["week"] = week
            self._memo[key] = fig
        return self._memo[key]
```

(f) Thread `role` through `latest`, `previous`, `combined`, `combined_latest`. Each signature gains `role=LIVE` as its last parameter, and each inner `self.figures(...)` / `self.latest(...)` / `self.previous(...)` call passes `role=role`:

```python
    def latest(self, wh, kind, obs=ANY, stage=ANY, section=ANY, role=LIVE):
        latest, previous = self.latest_pair(wh)
        if latest is None:
            return None
        fig = self.figures(wh, latest, kind, obs, stage, section, role)
        if fig is None:
            return None
        prev = self.figures(wh, previous, kind, obs, stage, section, role) if previous else None
        return {**fig, "prev": prev["prevalence"] if prev else None}

    def previous(self, wh, kind, obs=ANY, stage=ANY, section=ANY, role=LIVE):
        _latest, previous = self.latest_pair(wh)
        return self.figures(wh, previous, kind, obs, stage, section, role) if previous else None

    def combined(self, week, kind, obs=ANY, stage=ANY, section=ANY, role=LIVE):
        """Scope-wide figures for one ISO week: every house scouted that week,
        station-weighted (``prevalence.combine``). ``None`` when no house has a
        figure that week."""
        return P.combine([
            self.figures(wh, week, kind, obs, stage, section, role)
            for wh in self.warehouses_in(week)
        ])
```

and in `combined_latest` the signature becomes `def combined_latest(self, kind, obs=ANY, stage=ANY, section=ANY, role=LIVE):`, with its two inner calls becoming `self.latest(wh, kind, obs, stage, section, role)` and `self.previous(wh, kind, obs, stage, section, role)`. `latest_by_house` is unchanged: it calls `latest` with the default `LIVE`.

(g) Replace `station_counts`, `count_figures` and `count_latest` with:

```python
    def station_counts(self, wh, week, kind, obs=ANY, stages=ANY, section=ANY, weights=None) -> dict:
        """``{station: Σ weight × count}`` that week; ``stages`` (a frozenset)
        keeps only those stages — a Count row sums its counted stages, never its
        ticks. ``weights`` (``((stage, w), …)`` or a dict; S5) scales each
        stage's count; a stage it does not name counts at 1.0, and a weight of 0
        drops the stage."""
        factors = dict(weights or ())
        out: dict = {}
        for (k, o, g, s), per in self._station_counts.get((wh, week), {}).items():
            if k != kind:
                continue
            if obs is not ANY and o != obs:
                continue
            if stages is not ANY and g not in stages:
                continue
            if section is not ANY and s != section:
                continue
            factor = float(factors.get(g, 1.0))
            if not factor:
                continue
            for station, c in per.items():
                out[station] = out.get(station, 0.0) + c * factor
        return out

    def count_figures(self, wh, week, kind, obs=ANY, stages=ANY, section=ANY, weights=None):
        key = (wh, week, kind, obs, stages, section, _weights_key(weights))
        if key not in self._count_memo:
            scouted = self._scouted.get((wh, week))
            fig = None
            if scouted:
                grid = self.grid(wh)
                if (wh, week) not in self._counts:
                    self._counts[(wh, week)] = P.section_counts(grid, scouted)
                fig = P.count_figures(
                    grid, scouted,
                    self.station_counts(wh, week, kind, obs, stages, section, weights),
                    scouted_counts=self._counts[(wh, week)],
                )
                if fig is not None:
                    fig["week"] = week
            self._count_memo[key] = fig
        return self._count_memo[key]

    def count_latest(self, wh, kind, obs=ANY, stages=ANY, section=ANY, weights=None):
        """``count_figures`` for the house's latest week, ``prev`` = the previous
        scouted week's value (mirrors ``latest``)."""
        latest, previous = self.latest_pair(wh)
        if latest is None:
            return None
        fig = self.count_figures(wh, latest, kind, obs, stages, section, weights)
        if fig is None:
            return None
        prev = self.count_figures(wh, previous, kind, obs, stages, section, weights) if previous else None
        return {**fig, "prev": prev["value"] if prev else None}
```

Add one line to the module docstring, after the "A station is …" paragraph: "Pest rows carry a stage **role** (``common/stage_roles``): an all-stage pest figure counts Life stage and Form rows only (``LIVE``), and ``SIGNS`` reads the Sign rows on their own (stage & variety S3, S4)."

- [ ] **Step 6: Run to pass, plus the pure regression**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_stage_variety_pure.py upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_trends_prevalence_pure.py upande_scp/serverscripts/tests/test_threshold_core_pure.py upande_scp/serverscripts/tests/test_threshold_counts_pure.py upande_scp/serverscripts/tests/test_hot_spots_pure.py`
Expected: all pass. The existing pure suites seed `Adult` and read `station_counts` with no weights, so they are unchanged.

- [ ] **Step 7: The DB regression (the schema does not exist yet: every stage reads Life stage)**

Run: **DB-RUN** `test_prevalence_rows`, `test_prevalence_overview`, `test_prevalence_pests`, `test_prevalence_trends`, `test_threshold_measure_dashboards`, `test_scouting_alerts`, `test_hot_spots`.
Expected: all OK. Without the `stage_role` column, `role_map()` gives Life stage for every stage, so the figures are today's.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/common/stage_roles.py upande_scp/serverscripts/common/cache_utils.py upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py upande_scp/serverscripts/tests/test_stage_variety_pure.py
git commit -m "feat(scp): stage roles and the live / signs split in station weeks, with weighted counts"
```

---

### Task 2: Stage role and weight on the master, per-crop weight on pest stages, the fill-blanks seed

**Files:**
- Modify: `upande_scp/upande_scp/doctype/stage/stage.json`, `upande_scp/upande_scp/doctype/stage/stage.py`
- Modify: `upande_scp/upande_scp/doctype/pests_stages/pests_stages.json`
- Create: `upande_scp/patches/v1_0/seed_stage_roles.py`; modify `upande_scp/patches.txt` (end of `[post_model_sync]`)
- Modify: `upande_scp/serverscripts/common/cache_utils.py` (`_DOC_INVALIDATIONS`, `_CROP_CATALOG_SOURCES`)
- Modify: `upande_scp/hooks.py` (`doc_events`, beside `"Pests Stages": _SCP_CACHE_EVENTS`)
- Create: `upande_scp/serverscripts/tests/stage_variety_fixture.py`
- Test: `upande_scp/serverscripts/tests/test_stage_variety.py` (new; classes `StageCase`, `TestSchemaAndSeed`)

**Interfaces:**
- Consumes: Task 1 `stage_roles`.
- Produces:
  - `Stage.stage_role` (Select `Life stage\nForm\nSign`, **no default**), `Stage.weight` (Float, default 1, non-negative); `Pests Stages.weight` (Float, 0 = the Stage's)
  - `seed_stage_roles.execute()`, which fills blank roles only
  - `SV.WEEK_44`, `SV.WEEK_45`, `SV.reset()`, `SV.set_role(stage, role)`, `SV.set_master_weight(stage, w)`, `SV.set_override(crop, pest, stage, w)`, `SV.seeded_stations(warehouse, rows=(0, 1, 2), per_section=3) -> list`, `SV.set_bed_variety(stations, variety) -> set`

- [ ] **Step 1: The fixture**

Create `upande_scp/serverscripts/tests/stage_variety_fixture.py`:

```python
"""Stage roles, weights and bed varieties for the stage & variety tests (piece 4).

Callers roll back in tearDown and THEN call ``reset()``: the stage-roles catalog
lives in Redis, which a rollback does not touch, so a test's role or weight
would otherwise be served to the live site for up to an hour. Weeks 2031-W44 /
W45 — no other module seeds them, and kaitet.local has no real scouting in 2031.
"""

import frappe

from upande_scp.serverscripts.common import stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import prevalence_fixture as PF

WEEK_44 = ("2031-10-27", "2031-11-02")  # 2031-W44
WEEK_45 = ("2031-11-03", "2031-11-09")  # 2031-W45


def reset() -> None:
    """Drop every cached copy of roles, weights and bands."""
    stage_roles.invalidate_stage_roles()
    _common.clear_threshold_cache()


def set_role(stage, role) -> None:
    frappe.db.sql("update `tabStage` set stage_role=%s where name=%s", (role, stage))
    reset()


def set_master_weight(stage, weight) -> None:
    frappe.db.sql("update `tabStage` set weight=%s where name=%s", (weight, stage))
    reset()


def set_override(crop, pest, stage, weight) -> None:
    """The crop's Pests Stages weight for `pest` × `stage` (0 = the Stage's)."""
    parent = frappe.db.get_value("Pest Filter", {"crop_scouted": crop, "pest": pest}, "name")
    frappe.db.sql(
        "update `tabPests Stages` set weight=%s where parent=%s and parenttype='Pest Filter' and stage=%s",
        (weight, parent, stage),
    )
    reset()


def seeded_stations(warehouse, rows=(0, 1, 2), per_section=3) -> list:
    """The stations `thresholds_fixture.seed_week` uses, in the grid rows given
    (row r = the r-th third of the house's beds)."""
    out = []
    for (r, _c), stations in sorted(PF.stations_by_section(R._load_grid(warehouse)).items()):
        if r in rows:
            out.extend(stations[:per_section])
    return out


def set_bed_variety(stations, variety) -> set:
    """Set (rolled back) the variety of the beds those zones lie on; returns the beds."""
    beds = {b for b in (frappe.db.get_value("Zone", s, "bed") for s in stations) if b}
    for bed in beds:
        frappe.db.sql("update `tabBed` set variety=%s where name=%s", (variety, bed))
    return beds
```

- [ ] **Step 2: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_stage_variety.py`:

```python
"""Stage & variety weighting (piece 4). DB test — direct runner; everything is
rolled back in tearDown, then the stage-roles Redis entry is dropped (SV.reset)."""

import unittest
from datetime import date
from importlib import import_module
from unittest.mock import patch

import frappe

from upande_scp.patches.v1_0 import seed_stage_roles
from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import cache_utils, crop_catalog, crop_scope, stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import stage_variety_fixture as SV
from upande_scp.serverscripts.tests import thresholds_fixture as TF

SUN_44 = date(2031, 11, 2)


class StageCase(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        SV.reset()
        self.gh, self.gh2 = PF.rose_greenhouses(2)
        TF.clear_all_bands("Rose")

    def tearDown(self):
        frappe.set_user("Administrator")
        frappe.db.rollback()
        SV.reset()                       # after the rollback: Redis is not transactional
        crop_scope.clear_cache()


class TestSchemaAndSeed(StageCase):
    def test_the_role_column_has_no_db_default_and_weights_default_to_one(self):
        cols = dict(frappe.db.sql(
            """select COLUMN_NAME, COLUMN_DEFAULT from information_schema.COLUMNS
               where TABLE_SCHEMA = database() and TABLE_NAME = 'tabStage'
                 and COLUMN_NAME in ('stage_role', 'weight')"""
        ))
        self.assertIn(cols["stage_role"], (None, "NULL"))   # else ADD COLUMN would pre-fill every row
        self.assertEqual(float(cols["weight"]), 1.0)
        self.assertTrue(frappe.db.has_column("Pests Stages", "weight"))

    def test_a_new_stage_is_a_life_stage_weighing_one(self):
        doc = frappe.get_doc({"doctype": "Stage", "stage_name": "_TEST Stage SV"}).insert(ignore_permissions=True)
        self.assertEqual((doc.stage_role, doc.weight), ("Life stage", 1.0))
        doc.stage_role = ""
        doc.save(ignore_permissions=True)
        self.assertEqual(frappe.db.get_value("Stage", doc.name, "stage_role"), "Life stage")

    def test_the_patch_fills_blank_roles_only(self):
        names = ("Damages", "Motiles", "Eggs", "Colonies", "Web", "Adult")
        stamp = frappe.db.get_value("Stage", "Damages", "modified")
        frappe.db.sql("update `tabStage` set stage_role=NULL where name in ('Damages', 'Motiles', 'Eggs')")
        frappe.db.sql("update `tabStage` set stage_role='' where name='Colonies'")
        frappe.db.sql("update `tabStage` set stage_role='Life stage' where name='Web'")   # an agronomist's call
        frappe.db.sql("update `tabStage` set stage_role='Form' where name='Adult'")
        seed_stage_roles.execute()

        def roles():
            return dict(frappe.db.sql("select name, stage_role from `tabStage` where name in %s", (names,)))

        expected = {"Damages": "Sign", "Motiles": "Form", "Eggs": "Life stage", "Colonies": "Form",
                    "Web": "Life stage", "Adult": "Form"}
        self.assertEqual(roles(), expected)
        self.assertEqual(frappe.db.get_value("Stage", "Damages", "modified"), stamp)
        seed_stage_roles.execute()                                # a rerun changes nothing
        self.assertEqual(roles(), expected)

    def test_the_catalog_reads_roles_weights_and_per_crop_overrides(self):
        for stage, role in (("Web", "Sign"), ("Eggs", "Life stage"), ("Motiles", "Form"),
                            ("Singles", "Form"), ("Colonies", "Form")):
            SV.set_role(stage, role)
        SV.set_master_weight("Eggs", 0.5)
        SV.set_override("Rose", "Spidermites", "Eggs", 0.25)
        self.assertEqual(stage_roles.role_map()["Web"], "Sign")
        self.assertEqual(stage_roles.master_weight("Eggs"), 0.5)
        self.assertEqual(stage_roles.stage_weight("Rose", "Spidermites", "Eggs"), 0.25)
        self.assertEqual(stage_roles.stage_weight("Rose", "Whiteflies", "Eggs"), 0.5)
        self.assertEqual(stage_roles.pest_weights("Rose", "Spidermites")["Eggs"], 0.25)
        self.assertEqual(stage_roles.sign_stages("Rose", "Spidermites"), ["Web"])
        self.assertEqual(stage_roles.sign_stages("Rose", "Aphids"), [])            # Singles, Colonies: forms

    def test_a_zero_override_inherits_the_master_weight(self):
        SV.set_master_weight("Eggs", 0.5)
        SV.set_override("Rose", "Spidermites", "Eggs", 0)
        self.assertEqual(stage_roles.stage_weight("Rose", "Spidermites", "Eggs"), 0.5)

    def test_a_stage_change_drops_the_cached_roles_and_the_dashboards(self):
        SV.set_role("Eggs", "Life stage")
        self.assertEqual(stage_roles.role_map()["Eggs"], "Life stage")           # now cached
        frappe.db.sql("update `tabStage` set stage_role='Sign' where name='Eggs'")
        self.assertEqual(stage_roles.role_map()["Eggs"], "Life stage")           # still the cached copy
        before = _common.dash_agg_version()
        cache_utils.invalidate_on_change(frappe._dict(doctype="Stage", name="Eggs"))
        self.assertEqual(stage_roles.role_map()["Eggs"], "Sign")
        self.assertNotEqual(_common.dash_agg_version(), before)                  # payloads judged by roles
        frappe.db.sql("update `tabPests Stages` set weight=0.25 where parenttype='Pest Filter' and stage='Eggs'")
        self.assertNotEqual(stage_roles.master_weight("Eggs"), None)             # warm the cache again
        cache_utils.invalidate_on_change(frappe._dict(doctype="Pests Stages"))
        self.assertEqual(stage_roles.stage_weight("Rose", "Spidermites", "Eggs"), 0.25)

    def test_a_rolled_back_role_change_never_outlives_the_test(self):
        real = stage_roles.role_map().get("Eggs")
        SV.set_role("Eggs", "Sign" if real != "Sign" else "Life stage")
        self.assertNotEqual(stage_roles.role_map()["Eggs"], real)                # cached inside the transaction
        self.tearDown()                                                          # rollback, then SV.reset()
        self.assertEqual(stage_roles.role_map()["Eggs"], real)
```

- [ ] **Step 3: Run to see it fail**

Run: **DB-RUN `test_stage_variety`**
Expected: import ERROR, `ModuleNotFoundError: No module named 'upande_scp.patches.v1_0.seed_stage_roles'`. Once the patch module exists (Step 6), it fails with `OperationalError (1054, "Unknown column 'stage_role' …")` until the schema is applied (Step 8).

- [ ] **Step 4: The doctype JSON**

(a) `upande_scp/upande_scp/doctype/stage/stage.json`: in `field_order`, after `"default_reading_type"` add `"stage_role", "weight"`. Append to `fields` after the `default_reading_type` object:

```json
  {
   "description": "Life stage and Form count as the live pest. A Sign (damage, webs, ragged margins) is reported beside the pest as its own figure and never counted as it. No column default on purpose: the seed patch fills blank roles only.",
   "fieldname": "stage_role",
   "fieldtype": "Select",
   "in_list_view": 1,
   "in_standard_filter": 1,
   "label": "Stage Role",
   "options": "Life stage\nForm\nSign"
  },
  {
   "default": "1",
   "description": "Scales this stage's count in a pest's Count measure (1 = as recorded, 0 = left out). A crop's Pest Filter stage row can override it.",
   "fieldname": "weight",
   "fieldtype": "Float",
   "in_list_view": 1,
   "label": "Weight",
   "non_negative": 1,
   "precision": "3"
  }
```

and set `"modified": "2026-10-10 20:00:00.000000"`.

(b) `upande_scp/upande_scp/doctype/pests_stages/pests_stages.json`: in `field_order`, after `"reading_type"` add `"weight"`. After the `reading_type` field object insert:

```json
  {
   "description": "This crop's weight for the stage in a Count. 0 = use the Stage's own weight.",
   "fieldname": "weight",
   "fieldtype": "Float",
   "label": "Weight",
   "non_negative": 1,
   "precision": "3"
  },
```

and set `"modified": "2026-10-10 20:00:00.000000"`.

- [ ] **Step 5: The controller**

Replace `upande_scp/upande_scp/doctype/stage/stage.py` (tabs) with:

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document

from upande_scp.serverscripts.common import stage_roles


class Stage(Document):
	def validate(self):
		# stage_role has no column default (the seed patch fills blanks only, and
		# a DB default would make every existing stage look already set), so a
		# blank role is made the S1 default here.
		if not (self.stage_role or "").strip():
			self.stage_role = stage_roles.LIFE_STAGE
```

- [ ] **Step 6: The seed patch**

Create `upande_scp/patches/v1_0/seed_stage_roles.py` (tabs):

```python
"""Stage.stage_role from the stage name (stage & variety spec S2).

Sign = Damage, Damages, FCM Damage, Web, Ragged Margins; Form = Motiles, Singles,
Colonies, Scales, Scale Insects, Adult Cloud, Adult Singles; every other stage a
Life stage. FILLS BLANKS ONLY: a role already set — by an agronomist, or by an
earlier run — stands, so the patch is safe to rerun. Weights are not touched:
the column defaults to 1.0 and the agronomist sets real ones.
"""

import frappe

from upande_scp.serverscripts.common import stage_roles


def execute():
	if not frappe.db.has_column("Stage", "stage_role"):
		return
	for name, role in frappe.db.sql("select name, stage_role from `tabStage`"):
		if (role or "").strip():
			continue
		frappe.db.set_value("Stage", name, "stage_role", stage_roles.seed_role(name), update_modified=False)
	stage_roles.invalidate_stage_roles()
	# Pest prevalence cached before this ran counted signs as the pest.
	cache = frappe.cache()
	for key in cache.get_keys("scp:dash_agg:*"):
		cache.delete_value(key)
```

Append to `upande_scp/patches.txt` (the last lines, inside `[post_model_sync]`):

```
# Stage roles (Life stage / Form / Sign) for live-pest prevalence (stage & variety, piece 4). Fills blanks only.
upande_scp.patches.v1_0.seed_stage_roles
```

- [ ] **Step 7: Invalidation**

In `upande_scp/serverscripts/common/cache_utils.py`:

(a) Import `K_STAGE_ROLES`. It is defined in this module (Task 1), so no import is needed. In `_DOC_INVALIDATIONS`:
- `"Pests Stages": (K_OBSERVATION_TYPES,)` becomes `"Pests Stages": (K_OBSERVATION_TYPES, K_STAGE_ROLES),`
- `"Crop Scouted": (…, K_CROP_CATALOG)` gains `K_STAGE_ROLES` at the end.
- `"Pest Filter": (…, K_CROP_CATALOG)` gains `K_STAGE_ROLES` at the end.
- Add a new entry right after `"Predator Stages"`: `"Stage": (K_STAGE_ROLES,),`

(b) `_CROP_CATALOG_SOURCES = ("Crop Scouted", "Pest Filter", "Disease Filter")` becomes:

```python
# The crop-catalog sources whose change also shifts the dashboard aggregates —
# and Stage, whose role decides what counts as the live pest (stage & variety S3).
_CROP_CATALOG_SOURCES = ("Crop Scouted", "Pest Filter", "Disease Filter", "Stage")
```

In `upande_scp/hooks.py` `doc_events`, directly after `"Pests Stages": _SCP_CACHE_EVENTS,` add:

```python
    # Stage roles / weights (stage & variety, piece 4) drive live-pest prevalence.
    "Stage": _SCP_CACHE_EVENTS,
```

(The hook goes live only after the user restarts the workers and clears the `app_hooks` cache. Until then, edits on the Stage form reach the dashboards within `TTL_MEDIUM` (1 h). The thresholds editor invalidates explicitly in Task 6.)

- [ ] **Step 8: Apply the schema and the seed**

Run: **DB-EXEC** `frappe.reload_doc('upande_scp', 'doctype', 'stage', force=True); frappe.reload_doc('upande_scp', 'doctype', 'pests_stages', force=True); print(frappe.db.sql("SELECT COUNT(*) FROM \`tabStage\` WHERE stage_role IS NULL")); from upande_scp.patches.v1_0 import seed_stage_roles as p; p.execute(); frappe.get_doc({'doctype': 'Patch Log', 'patch': 'upande_scp.patches.v1_0.seed_stage_roles'}).insert(ignore_permissions=True)`
Expected: `((42,),)`. Every existing stage reads NULL before the seed, which proves the column has no default.

Then verify: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SELECT stage_role, COUNT(*) FROM \`tabStage\` GROUP BY 1; SELECT COUNT(*) FROM \`tabStage\` WHERE weight <> 1; SELECT COUNT(*) FROM \`tabPests Stages\` WHERE weight <> 0; SELECT name FROM \`tabStage\` WHERE stage_role='Sign' ORDER BY 1; SELECT patch FROM \`tabPatch Log\` WHERE patch LIKE '%seed_stage_roles';"`
Expected: `Form 7`, `Life stage 30`, `Sign 5`; `0`; `0`; `Damage, Damages, FCM Damage, Ragged Margins, Web`; one Patch Log row.

- [ ] **Step 9: Run to pass, plus the gate**

Run: **DB-RUN `test_stage_variety`**, then the DB regression gate from Global Constraints (every module), and `../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_stage_variety_pure.py`.
Expected: all OK. Real Damages rows now leave the live figure, but no gate test seeds a Sign for an all-stage figure (Global Constraints). If one fails for that reason only, apply the documented seed change.

- [ ] **Step 10: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/upande_scp/doctype/stage/stage.json upande_scp/upande_scp/doctype/stage/stage.py upande_scp/upande_scp/doctype/pests_stages/pests_stages.json upande_scp/patches/v1_0/seed_stage_roles.py upande_scp/patches.txt upande_scp/serverscripts/common/cache_utils.py upande_scp/hooks.py upande_scp/serverscripts/tests/stage_variety_fixture.py upande_scp/serverscripts/tests/test_stage_variety.py
git commit -m "feat(scp): stage role and weight on the stage master, a per-crop weight on pest stages, seeded fill-blanks-only"
```

---

### Task 3: Thresholds judge the live pest; a Count sums weighted life stages and forms

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py` (imports; `load_thresholds` docstring, `_load_kind`, `band_spec`, `house_value`)
- Modify: `upande_scp/serverscripts/scouting/thresholds_check.py` (`_figure`)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` (`_mark_hot`, from 3b)
- Test: `upande_scp/serverscripts/tests/test_stage_variety.py` (class `TestLiveFigure`)

**Interfaces:**
- Consumes: Task 1 `stage_roles.is_live`, `stage_weight`, `role_map`; `StationWeeks(..., weights=)`.
- Produces:
  - A spec's `count_stages` for the row key (`stage=""`) holds only Count-reading **Life stage / Form** stages (S5). D1's "a pest with a counted stage" now means a counted live stage.
  - `spec["count_weights"]`: `((stage, weight), …)` sorted, for the row key; `()` for a stage key and for diseases. A stage band reads raw counts.
  - Every Count reader passes `weights=spec.get("count_weights")`.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_stage_variety.py`:

```python
TC = import_module("upande_scp.serverscripts.scouting.thresholds_check")


class TestLiveFigure(StageCase):
    def setUp(self):
        super().setUp()
        for stage, role in (("Adult", "Life stage"), ("Damages", "Sign"), ("Damage", "Sign"),
                            ("Motiles", "Form"), ("Eggs", "Life stage"), ("Web", "Sign"),
                            ("Adult Moth", "Life stage"), ("Larvae", "Life stage"), ("Pupae", "Life stage")):
            SV.set_role(stage, role)
        for stage in ("Motiles", "Eggs", "Adult Moth", "Larvae", "Pupae"):
            SV.set_master_weight(stage, 1)
            SV.set_override("Rose", "Spidermites", stage, 0)

    def test_a_damages_only_station_is_out_of_the_live_figure_and_in_signs(self):
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Adult", infested_per_section=1)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Damages", infested_per_section=2)
        weeks = R.StationWeeks.load(*SV.WEEK_44, "Rose", None)
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips")["prevalence"], 33.3)
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips", role=R.SIGNS)["prevalence"], 66.7)
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips", "Damages")["prevalence"], 66.7)

    def test_evaluate_judges_the_live_figure(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Damages", infested_per_section=3)  # signs 100 %
        found = [f for f in TC.evaluate("Rose", SUN_44)
                 if f["warehouse"] == self.gh and f["observation"] == "Thrips" and not f["stage"]]
        house = [f for f in found if f.get("alert_type", "House") == "House"]
        self.assertEqual([(f["value"], f["action"]) for f in house], [(0.0, None)])
        self.assertFalse([f for f in found if f["action"]])                  # no hot spot either
        with patch.object(TC.notifications, "notify", return_value=[]), patch.object(frappe, "sendmail"):
            TC.check_crop("Rose", SUN_44)
        self.assertEqual(frappe.db.count("Scouting Alert", {"warehouse": self.gh, "iso_week": "2031-W44"}), 0)

    def test_a_count_row_never_sums_a_sign_stage(self):
        TF.set_bands("Rose", "FCM", 0, 1, 2, measure="Count")
        spec = _common.band_spec("Rose", "pest", "FCM", "")
        self.assertEqual(spec["measure"], "Count")
        self.assertEqual(spec["count_stages"], frozenset({"Adult Moth", "Larvae", "Eggs", "Pupae"}))  # no "Damage"
        self.assertEqual(dict(spec["count_weights"]), {"Adult Moth": 1.0, "Larvae": 1.0, "Eggs": 1.0, "Pupae": 1.0})

    def _spidermites(self):
        """Motiles 3 and Eggs 6 on station 0 of each section: 1.0 + 2.0 per zone."""
        TF.set_bands("Rose", "Spidermites", 0, 1, 5, measure="Count")
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", pest="Spidermites", stage="Motiles", count=3)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", pest="Spidermites", stage="Eggs", count=6)
        return R.StationWeeks.load(*SV.WEEK_44, "Rose", None)

    def _value(self, weeks, stage=""):
        _common.clear_threshold_cache()
        return _common.house_value("Rose", "pest", "Spidermites", stage, weeks, self.gh, None)

    def test_weights_of_one_reproduce_todays_count(self):
        weeks = self._spidermites()
        plain = weeks.count_latest(self.gh, "pest", "Spidermites", stages=frozenset({"Motiles", "Eggs"}))
        self.assertEqual((self._value(weeks), plain["value"]), (3.0, 3.0))

    def test_half_weight_on_eggs_halves_their_contribution(self):
        weeks = self._spidermites()
        SV.set_master_weight("Eggs", 0.5)
        self.assertEqual(self._value(weeks), 2.0)                            # 1.0 + 0.5 × 2.0

    def test_a_crop_override_beats_the_master_and_zero_inherits(self):
        weeks = self._spidermites()
        SV.set_master_weight("Eggs", 0.5)
        SV.set_override("Rose", "Spidermites", "Eggs", 0.25)
        self.assertEqual(self._value(weeks), 1.5)                            # 1.0 + 0.25 × 2.0
        SV.set_override("Rose", "Spidermites", "Eggs", 0)
        self.assertEqual(self._value(weeks), 2.0)

    def test_a_stage_band_reads_raw_counts_whatever_the_weight(self):
        TF.set_bands("Rose", "Spidermites", 0, 1, 5, measure="Count", stage_bands={"Eggs": (0, 1, 3)})
        weeks = self._spidermites()
        SV.set_master_weight("Eggs", 0.5)
        self.assertEqual(_common.band_spec("Rose", "pest", "Spidermites", "Eggs")["count_weights"], ())
        self.assertEqual(self._value(weeks, "Eggs"), 2.0)                    # 6 / 3, unweighted
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_stage_variety`**
Expected: `TestLiveFigure` FAILS. `test_a_count_row_never_sums_a_sign_stage` gets `count_stages` containing `"Damage"` and `KeyError: 'count_weights'`. The weight tests read `3.0` where `2.0` / `1.5` is expected. `test_a_damages_only_station…` and `test_evaluate_judges_the_live_figure` already PASS, because Task 1 made the figures live. They stay as the pins.

- [ ] **Step 3: The loader**

In `upande_scp/serverscripts/dashboard_aggregates/_common.py`:

(a) Imports: below `from upande_scp.serverscripts.common import crop_catalog` add `from upande_scp.serverscripts.common import stage_roles`.

(b) In the `load_thresholds` docstring, the spec line becomes ``A spec is ``{"low", "mod", "high", "measure", "row_measure", "count_stages", "count_weights", "reading_types"}``.`` Add this sentence after the `count_stages` one: "``count_stages`` for the row key holds counted Life stage / Form stages only — a Sign is never the pest (stage & variety S5) — and ``count_weights`` carries their weights (``((stage, w), …)``); a stage key reads its raw count (``()``)."

(c) Add above `_load_kind`:

```python
def _count_weights(crop: str, obs: str, stages) -> tuple:
    """S5/S6: ``((stage, weight), …)`` for a row's Count, sorted — hashable,
    so the StationWeeks memo can key on it."""
    return tuple(sorted((s, stage_roles.stage_weight(crop, obs, s)) for s in stages))
```

(d) In `_load_kind`, right before `for group in by_row.values():` add `roles = stage_roles.role_map() if kind == "pest" else {}`. Replace the line `counted = frozenset(s for s, rt in reading_types.items() if rt == B.COUNT)` with:

```python
        # S5: a pest's Count sums its counted LIVE stages — a Sign (damage,
        # webs) recorded as a number is still not the pest.
        counted = frozenset(
            s for s, rt in reading_types.items()
            if rt == B.COUNT and (kind != "pest" or stage_roles.is_live(s, roles))
        )
```

In the row-key spec dict (`out[(kind, obs, "")] = {…}`), after `"count_stages": counted,` add `"count_weights": _count_weights(crop, obs, counted) if kind == "pest" else (),`. In the stage-key spec dict, after `"count_stages": frozenset({stage}),` add `"count_weights": (),`.

(e) In `band_spec`'s fallback dict (the `return {**row, "measure": …, "count_stages": frozenset({stage})}`), add `"count_weights": (),`.

(f) In `house_value`, the Count line becomes:

```python
        cfig = weeks.count_latest(wh, kind, obs_name, stages=spec["count_stages"],
                                  weights=spec.get("count_weights"))
```

- [ ] **Step 4: Every Count reader passes the weights**

(a) `upande_scp/serverscripts/scouting/thresholds_check.py` `_figure`: the Count line becomes `fig = weeks.count_figures(wh, week, kind, obs, stages=spec["count_stages"], weights=spec.get("count_weights"))`.

(b) `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` `_mark_hot` (3b): `cfig = weeks.count_latest(gh, kind, obs, stages=spec["count_stages"]) or {}` becomes `cfig = weeks.count_latest(gh, kind, obs, stages=spec["count_stages"], weights=spec.get("count_weights")) or {}`.

(c) Then run `grep -rn 'count_stages"\]' upande_scp/serverscripts --include=*.py | grep -v /tests/`. Every hit, including any 3c added, must pass `weights=spec.get("count_weights")` too. Expected hits: `_common.house_value`, `thresholds_check._figure`, `_gh_detail._mark_hot`, plus any new 3c reader.

- [ ] **Step 5: Run to pass, plus the gate**

Run: **DB-RUN `test_stage_variety`**, **DB-RUN `test_threshold_measure_dashboards`**, **DB-RUN `test_thresholds_measure`**, **DB-RUN `test_scouting_alerts`**, **DB-RUN `test_hot_spots`**, **DB-RUN `test_alert_digest`**, **DB-RUN `test_dashboard_aggregates_gh_detail`**
Expected: all OK. `test_the_row_count_sums_only_counted_stages` still reads `{"Adult", "Larvae"}`, because Thrips' `Damages` is a tick-box, so it was never counted.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_common.py upande_scp/serverscripts/scouting/thresholds_check.py upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py upande_scp/serverscripts/tests/test_stage_variety.py
git commit -m "feat(scp): thresholds judge the live pest — a count sums weighted life stages and forms, never signs"
```

---

### Task 4: Signs beside the live figure on the payloads; schema tag `stg1`

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (two module functions at the end)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_overview.py` (`_classify_cells` `out_cells.append`, `_active_alerts_from_cells`)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py` (`_ranking`, `_gh_pressure`)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` (the `prevalence_rows.append({…})` row)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_trends.py` (imports, `_build`, `_prevalence_tables`)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py` (`K_DASH_AGG_SCHEMA` + its comment block)
- Modify: `upande_scp/serverscripts/tests/test_prevalence_overview.py` (the schema-tag test)
- Test: `upande_scp/serverscripts/tests/test_stage_variety.py` (class `TestSignsOnPayloads`)

**Interfaces:**
- Consumes: Task 1 `role=R.SIGNS`, `stage_roles.sign_stages`.
- Produces:
  - `R.signs_latest(weeks, crop, wh, obs=ANY, section=ANY) -> dict | None` and `R.signs_combined_latest(weeks, crop, obs=ANY, section=ANY) -> dict | None`. Each returns `prevalence.public` keys, or None when the crop lists no Sign stage for the pest (or for any pest, when `obs` is ANY).
  - `signs` on: Overview cells and `activeAlerts` rows (pest-level, every stage cell of the pest); Pests `ranking` rows; Pests `greenhousePressure` rows (when no stage is picked); greenhouse-detail `prevalence` pest rows. Diseases carry `None`.
  - Trends `signsByStation`: `[week idx, station idx, obs idx, signs %]` for each per-station prevalence row of a pest with a Sign stage. `_prevalence_tables(payload, weeks, crop="")`.
  - `K_DASH_AGG_SCHEMA = "stg1"`.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_stage_variety.py`:

```python
O = import_module("upande_scp.serverscripts.dashboard_aggregates._overview")


class TestSignsOnPayloads(StageCase):
    """Thrips Adult on station 0 of each section (live 33.3 %), Damages on
    stations 0 and 1 (signs 66.7 %); Aphids Singles on station 0 (no Sign stage)."""

    def setUp(self):
        super().setUp()
        for stage, role in (("Adult", "Life stage"), ("Larvae", "Life stage"), ("Damages", "Sign"),
                            ("Singles", "Form"), ("Colonies", "Form")):
            SV.set_role(stage, role)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Adult", infested_per_section=1)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", stage="Damages", infested_per_section=2)
        TF.seed_week(self.gh, SV.WEEK_44[0], crop="Rose", pest="Aphids", stage="Singles", infested_per_section=1)
        self.range = {"from_date": SV.WEEK_44[0], "to_date": SV.WEEK_44[1], "crop": "Rose", "force": "1"}

    def test_overview_cells_and_alerts_carry_the_signs(self):
        TF.set_bands("Rose", "Thrips", 5, 20, 50)          # the Adult cell (33.3 %) reads Moderate
        where, params = _common.parent_filter_conditions(*SV.WEEK_44, "Rose", None)
        weeks = R.StationWeeks.load(*SV.WEEK_44, "Rose", None)
        cells = O._classify_cells(O._observation_rows(where, params), "Rose", weeks)[1]
        adult = next(c for c in cells
                     if c["greenhouse"] == self.gh and c["obs_name"] == "Thrips" and c["stage"] == "Adult")
        self.assertEqual((adult["prevalence"], adult["signs"]["prevalence"]), (33.3, 66.7))
        aphids = next(c for c in cells if c["greenhouse"] == self.gh and c["obs_name"] == "Aphids")
        self.assertIsNone(aphids["signs"])                  # Singles / Colonies: no Sign stage on the row
        alert = next(a for a in O._active_alerts_from_cells(cells) if a["name"] == "Thrips" and a["stage"] == "Adult")
        self.assertEqual(alert["signs"]["prevalence"], 66.7)

    def test_pests_ranking_and_pressure_carry_the_signs(self):
        out = DA.pests(**self.range)
        thrips = next(r for r in out["ranking"] if r["name"] == "Thrips")
        self.assertEqual((thrips["prevalence"], thrips["signs"]["prevalence"]), (33.3, 66.7))
        self.assertIsNone(next(r for r in out["ranking"] if r["name"] == "Aphids")["signs"])
        picked = DA.pests(observation="Thrips", **self.range)
        row = next(r for r in picked["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual((row["pct"], row["signs"]["prevalence"]), (33.3, 66.7))
        staged = DA.pests(observation="Thrips", stage="Damages", **self.range)
        row = next(r for r in staged["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual((row["pct"], row["signs"]), (66.7, None))             # a named stage: no signs beside it

    def test_the_greenhouse_detail_row_carries_the_signs(self):
        out = DA.greenhouse_detail(greenhouse=self.gh, **self.range)
        thrips = next(p for p in out["prevalence"] if p["name"] == "Thrips")
        self.assertEqual((thrips["prevalence"], thrips["signs"]["prevalence"]), (33.3, 66.7))

    def test_trends_carry_signs_rows_beside_the_live_rows(self):
        out = DA.trends(**self.range)
        v = out["vocab"]
        w, s, o = v["weeks"].index("2031-W44"), v["stations"].index(self.gh), v["obs"].index("pest:Thrips")
        live = next(r for r in out["prevalenceByStation"] if r[:3] == [w, s, o])
        self.assertEqual(live[3], 33.3)
        self.assertIn([w, s, o, 66.7], out["signsByStation"])
        aphids = v["obs"].index("pest:Aphids")
        self.assertEqual([r for r in out["signsByStation"] if r[2] == aphids], [])

    def test_aggregate_keys_carry_the_stg1_schema(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "stg1")
        self.assertIn(":stg1:pests:", _common._build_key("pests", {"crop": "Rose"}))
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_stage_variety`**
Expected: `TestSignsOnPayloads` FAILS with `KeyError: 'signs'` / `KeyError: 'signsByStation'`, and `AssertionError: 'hot1' != 'stg1'` (or `'pin1'` once 3c has landed).

- [ ] **Step 3: The signs helpers**

Append to `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py`:

```python
# ── signs (stage & variety S4) ─────────────────────────────────────────────


def signs_latest(weeks, crop, wh, obs=ANY, section=ANY):
    """A pest's Sign figure for the house's latest week (``prevalence.public``
    keys), or None when the crop's Pest Filter lists no Sign stage for it (for
    any pest when ``obs`` is ANY) — so a pest without signs never reads
    "signs 0%"."""
    if not stage_roles.sign_stages(crop, None if obs is ANY else obs):
        return None
    fig = weeks.latest(wh, "pest", obs, ANY, section, role=SIGNS)
    return P.public(fig) if fig else None


def signs_combined_latest(weeks, crop, obs=ANY, section=ANY):
    """``signs_latest`` scope-wide: every house's latest week, station-weighted."""
    if not stage_roles.sign_stages(crop, None if obs is ANY else obs):
        return None
    fig = weeks.combined_latest("pest", obs, ANY, section, role=SIGNS)
    return P.public(fig) if fig else None
```

- [ ] **Step 4: The payloads**

(a) `_overview.py` `_classify_cells`: in `out_cells.append({…})`, after `"date": cell["latest_date"],` add:

```python
            # S4: the pest's signs beside its live figure (pest-level, every stage cell).
            "signs": _prevalence_rows.signs_latest(weeks, crop, gh, obs_name) if kind == "pest" else None,
```

and in `_active_alerts_from_cells`, after `"stage": c["stage"],` add `"signs": c.get("signs"),`.

(b) `_pests_diseases.py` `_ranking`: replace the final `for name, bucket in by_name.items():` loop body with:

```python
    for name, bucket in by_name.items():
        bucket.update(P.public(weeks.combined_latest(kind, name or "")))
        bucket["signs"] = (
            _prevalence_rows.signs_combined_latest(weeks, crop, name or "") if kind == "pest" else None
        )
```

`_gh_pressure`: in `out.append({…})`, after `**P.public(fig),` add:

```python
            "signs": (
                _prevalence_rows.signs_latest(weeks, filters["crop"], wh, obs, section)
                if kind == "pest" and stage is ANY else None
            ),
```

(c) `_gh_detail.py`: in the `prevalence_rows.append({…})` dict (it carries 3b's `"sections": _mark_hot(…)` and possibly 3c keys), add:

```python
                "signs": _prevalence_rows.signs_latest(weeks, filters["crop"], gh, t["name"]) if kind == "pest" else None,
```

(d) `_trends.py`: add `from upande_scp.serverscripts.common import stage_roles` beside `from upande_scp.serverscripts.common import prevalence`. In `_build`, `payload.update(_prevalence_tables(payload, weeks))` becomes `payload.update(_prevalence_tables(payload, weeks, crop))`. In `_prevalence_tables`:
- The signature becomes `def _prevalence_tables(payload: dict, weeks, crop: str = "") -> dict:`.
- Add to the docstring: "* ``signsByStation`` rows ``[week, station, obs, signs %]`` — beside each per-station row of a pest whose crop row lists a Sign stage (stage & variety S4); none without a crop."
- Replace the `by_station` loop with:

```python
    has_signs: dict = {}

    def _signs_for(name) -> bool:
        if name not in has_signs:
            has_signs[name] = bool(crop) and bool(stage_roles.sign_stages(crop, name))
        return has_signs[name]

    by_station = []
    signs_rows = []
    for s_i, o_i in sorted(seen_at_house):
        station = vocab["stations"][s_i]
        kind, _sep, name = vocab["obs"][o_i].partition(":")
        for week in weeks.weeks(station):
            w_i = idx_week.get(week)
            if w_i is None:
                continue
            fig = weeks.figures(station, week, kind, name)
            if fig and fig.get("prevalence") is not None:
                by_station.append(_row(w_i, s_i, o_i, fig))
                if kind == "pest" and _signs_for(name):
                    sfig = weeks.figures(station, week, kind, name, role=_prevalence_rows.SIGNS)
                    if sfig and sfig.get("prevalence") is not None:
                        signs_rows.append([w_i, s_i, o_i, sfig["prevalence"]])
```

- In the `return {…}`, add `"signsByStation": sorted(signs_rows, key=lambda r: r[:3]),`.

(e) `_common.py`: `K_DASH_AGG_SCHEMA = "hot1"` (or `"pin1"` if 3c bumped it) becomes `K_DASH_AGG_SCHEMA = "stg1"`. Add a line to the comment block above it: `# "stg1": pest prevalence counts live stages only and payloads carry ``signs`` / ``varieties`` (stage & variety spec S3, S4, S7).`

(f) `test_prevalence_overview.py`: the schema-tag test (currently `test_aggregate_keys_carry_the_hot1_schema`, or `…_pin1_…`) becomes:

```python
    def test_aggregate_keys_carry_the_stg1_schema(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "stg1")
        self.assertIn(":stg1:overview:", _common._build_key("overview", {"crop": "Rose"}))
```

- [ ] **Step 5: Run to pass, plus the gate**

Run: **DB-RUN `test_stage_variety`**, then the full DB regression gate (every module in Global Constraints), and the pure suites `test_trends_prevalence_pure`, `test_stage_variety_pure`.
Expected: all OK. `test_trends_prevalence_pure` calls `_prevalence_tables(payload, FakeWeeks(...))` with no crop, so it gets no signs rows and its `FakeWeeks.figures` is never called with `role`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py upande_scp/serverscripts/dashboard_aggregates/_overview.py upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py upande_scp/serverscripts/dashboard_aggregates/_trends.py upande_scp/serverscripts/dashboard_aggregates/_common.py upande_scp/serverscripts/tests/test_prevalence_overview.py upande_scp/serverscripts/tests/test_stage_variety.py
git commit -m "feat(scp): signs beside the live figure on the overview, pests, greenhouse detail and trends payloads"
```

---

### Task 5: By variety — live prevalence and signs per rose variety for the selected pest

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/_variety.py`
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (`StationWeeks.scouted_set`, beside `observations`)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` (imports; before and inside the prevalence-rows loop)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py` (imports; `_build` payload)
- Test: `upande_scp/serverscripts/tests/test_stage_variety_pure.py` (class `TestGroupByVariety`), `upande_scp/serverscripts/tests/test_stage_variety.py` (class `TestVarieties`)

**Interfaces:**
- Consumes: Task 1 `role=R.SIGNS`; Task 4 schema tag (no new bump: same release).
- Produces:
  - `_variety.VARIETY_MIN_N = 10`
  - `group_by_variety(station_beds, scouted, live, signs=None) -> list` (pure). Rows are `{"variety", "beds", "scouted", "infested", "prevalence", "signs", "few"}`: named varieties first by stations scouted (descending) then name, `""` (no variety recorded) last. Returns `[]` when no scouted station's bed has a variety. `signs` is None when the pest has no Sign stage.
  - `latest_weeks(weeks, houses=None) -> {house: ISO week}`; `station_beds(crop, chosen) -> {(house, station): (bed, variety)}` (one scan of the chosen house-weeks, D5); `breakdown(weeks, crop, pest, chosen, beds) -> list`; `variety_breakdown(weeks, crop, pest, houses=None) -> list`
  - `StationWeeks.scouted_set(wh, week) -> set`
  - `greenhouse_detail(...)["prevalence"][i]["varieties"]`: a list for a pest row, `None` for a disease row. `pests(...)["varieties"]`: the list for `observation` (pests only), `[]` without one.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_stage_variety_pure.py`:

```python
V = import_module("upande_scp.serverscripts.dashboard_aggregates._variety")


class TestGroupByVariety(unittest.TestCase):
    def test_groups_by_bed_variety_and_greys_below_ten(self):
        beds = {("GH", f"Z{i:02d}"): (f"B{i // 4}", "Red" if i < 12 else "White") for i in range(16)}
        rows = V.group_by_variety(beds, set(beds), {("GH", "Z00"), ("GH", "Z12")}, {("GH", "Z01")})
        self.assertEqual(rows, [
            {"variety": "Red", "beds": 3, "scouted": 12, "infested": 1, "prevalence": 8.3, "signs": 8.3, "few": False},
            {"variety": "White", "beds": 1, "scouted": 4, "infested": 1, "prevalence": 25.0, "signs": 0.0, "few": True},
        ])

    def test_ten_stations_are_enough(self):
        self.assertEqual(V.VARIETY_MIN_N, 10)
        beds = {("GH", f"Z{i}"): ("B1", "Red") for i in range(10)}
        self.assertFalse(V.group_by_variety(beds, set(beds), set())[0]["few"])

    def test_no_variety_anywhere_is_no_table_and_unvaried_stations_come_last(self):
        beds = {("GH", "Z1"): ("B1", ""), ("GH", "Z2"): ("B1", "")}
        self.assertEqual(V.group_by_variety(beds, set(beds), set()), [])
        beds[("GH", "Z3")] = ("B2", "Red")
        rows = V.group_by_variety(beds, set(beds) | {("GH", "Z9")}, set())    # Z9: no bed row at all
        self.assertEqual([(r["variety"], r["scouted"], r["beds"], r["signs"]) for r in rows],
                         [("Red", 1, 1, None), ("", 3, 1, None)])

    def test_only_scouted_stations_count(self):
        beds = {("GH", "Z1"): ("B1", "Red"), ("GH", "Z2"): ("B1", "Red")}
        rows = V.group_by_variety(beds, {("GH", "Z1")}, {("GH", "Z2")})
        self.assertEqual((rows[0]["scouted"], rows[0]["infested"]), (1, 0))
```

Append to `upande_scp/serverscripts/tests/test_stage_variety.py`:

```python
class TestVarieties(StageCase):
    """Thrips Adult on station 0, Damages on stations 0 and 1, of each section."""

    def setUp(self):
        super().setUp()
        for stage, role in (("Adult", "Life stage"), ("Larvae", "Life stage"), ("Damages", "Sign"),
                            ("Singles", "Form"), ("Colonies", "Form")):
            SV.set_role(stage, role)

    def _seed(self, date=SV.WEEK_44[0]):
        TF.seed_week(self.gh, date, crop="Rose", stage="Adult", infested_per_section=1)
        TF.seed_week(self.gh, date, crop="Rose", stage="Damages", infested_per_section=2)

    def _varieties(self, pest="Thrips", to_date=SV.WEEK_44[1]):
        out = DA.greenhouse_detail(greenhouse=self.gh, from_date=SV.WEEK_44[0], to_date=to_date,
                                   crop="Rose", force="1")
        return next(p for p in out["prevalence"] if p["name"] == pest)["varieties"]

    def test_varieties_group_by_bed_variety_and_grey_the_small_ones(self):
        self._seed()
        beds_a = SV.set_bed_variety(SV.seeded_stations(self.gh, rows=(0, 1)), "_TEST Variety A")
        beds_b = SV.set_bed_variety(SV.seeded_stations(self.gh, rows=(2,)), "_TEST Variety B")
        self.assertFalse(beds_a & beds_b)                          # a bed lies in one third of the house
        self.assertEqual(self._varieties(), [
            {"variety": "_TEST Variety A", "beds": len(beds_a), "scouted": 18, "infested": 6,
             "prevalence": 33.3, "signs": 66.7, "few": False},
            {"variety": "_TEST Variety B", "beds": len(beds_b), "scouted": 9, "infested": 3,
             "prevalence": 33.3, "signs": 66.7, "few": True},
        ])

    def test_stations_on_beds_without_a_variety_are_grouped_last(self):
        self._seed()
        SV.set_bed_variety(SV.seeded_stations(self.gh, rows=(0, 1)), "_TEST Variety A")
        SV.set_bed_variety(SV.seeded_stations(self.gh, rows=(2,)), None)
        self.assertEqual([(r["variety"], r["scouted"]) for r in self._varieties()],
                         [("_TEST Variety A", 18), ("", 9)])

    def test_no_variety_anywhere_hides_the_table(self):
        self._seed()
        SV.set_bed_variety(SV.seeded_stations(self.gh), None)
        self.assertEqual(self._varieties(), [])

    def test_only_each_houses_latest_week_is_grouped(self):
        self._seed()                                                # W44: 27 stations
        TF.seed_week(self.gh, SV.WEEK_45[0], crop="Rose", stage="Adult", infested_per_section=3,
                     sections={(0, 0), (0, 1), (0, 2)})            # W45: 9 stations, all live
        SV.set_bed_variety(SV.seeded_stations(self.gh), "_TEST Variety A")
        rows = self._varieties(to_date=SV.WEEK_45[1])
        self.assertEqual([(r["variety"], r["scouted"], r["prevalence"], r["few"]) for r in rows],
                         [("_TEST Variety A", 9, 100.0, True)])

    def test_an_avocado_block_has_no_variety_table(self):
        block = F.avocado_block()
        TF.seed_week(block, SV.WEEK_44[0], crop="Avocado", pest="Mealybugs", stage="Singles", block=True)
        out = DA.greenhouse_detail(greenhouse=block, from_date=SV.WEEK_44[0], to_date=SV.WEEK_44[1],
                                   crop="Avocado", force="1")
        self.assertEqual(next(p for p in out["prevalence"] if p["name"] == "Mealybugs")["varieties"], [])

    def test_a_disease_row_has_no_variety_table(self):
        PF.seed_even_week(self.gh, SV.WEEK_44[0], crop="Rose", disease="Powdery Mildew")
        out = DA.greenhouse_detail(greenhouse=self.gh, from_date=SV.WEEK_44[0], to_date=SV.WEEK_44[1],
                                   crop="Rose", force="1")
        self.assertIsNone(next(p for p in out["prevalence"] if p["kind"] == "disease")["varieties"])

    def test_the_pests_tab_carries_the_table_for_the_selected_pest_only(self):
        self._seed()
        SV.set_bed_variety(SV.seeded_stations(self.gh), "_TEST Variety A")
        base = {"from_date": SV.WEEK_44[0], "to_date": SV.WEEK_44[1], "crop": "Rose", "force": "1"}
        self.assertEqual(DA.pests(**base)["varieties"], [])
        rows = DA.pests(observation="Thrips", **base)["varieties"]
        self.assertEqual([(r["variety"], r["scouted"], r["prevalence"], r["signs"]) for r in rows],
                         [("_TEST Variety A", 27, 33.3, 66.7)])
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_stage_variety_pure.py` and **DB-RUN `test_stage_variety`**
Expected: the pure run ERRORS with `ModuleNotFoundError: …_variety`. The DB run's `TestVarieties` FAILS with `KeyError: 'varieties'`.

- [ ] **Step 3: `_variety.py` and `scouted_set`**

In `_prevalence_rows.py`, add to `StationWeeks` right before `observations`:

```python
    def scouted_set(self, wh, week) -> set:
        """Stations scouted at ``wh`` that ISO week."""
        return set(self._scouted.get((wh, week), ()))
```

Create `upande_scp/serverscripts/dashboard_aggregates/_variety.py`:

```python
"""By-variety live prevalence and signs for one pest (stage & variety spec S7).

Rose in practice: a station's variety is the variety of the bed it was scouted
on (``Scouting Entry.bed → Bed.variety``; 14,230 of kaitet's 20,668 beds carry
one). Avocado and coffee entries have no bed variety, so the table comes back
empty and the frontend hides it.

Per house, its latest scouted ISO week (``StationWeeks.latest_pair``); a scope
(the Pests tab) is the union of every house's latest week. Figures are raw
shares — infested ÷ scouted stations of the variety — because a variety's beds
are not a 3 × 3 sample, so the section estimator does not apply. A variety with
fewer than ``VARIETY_MIN_N`` scouted stations is ``few`` (greyed "too few").
No per-variety thresholds (S8).
"""

from datetime import datetime, timedelta

import frappe

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.dashboard_aggregates._common import parent_filter_conditions

#: S7: a variety with fewer scouted stations than this is greyed "too few".
VARIETY_MIN_N = 10


def _pct(x, n):
    return round(100.0 * x / n, 1) if n else None


def group_by_variety(station_beds, scouted, live, signs=None) -> list:
    """Pure. ``station_beds`` = ``{(house, station): (bed, variety)}``;
    ``scouted`` / ``live`` / ``signs`` are sets of ``(house, station)``. A
    scouted station with no bed row, or a bed with no variety, falls in the
    ``""`` group (listed last). ``signs`` None → the pest has no Sign stage, and
    each row's ``signs`` is None. ``[]`` when no scouted station has a variety."""
    groups: dict = {}
    for key in sorted(scouted):
        bed, variety = station_beds.get(key) or ("", "")
        g = groups.setdefault((variety or "").strip(), {"beds": set(), "scouted": 0, "live": 0, "signs": 0})
        if bed:
            g["beds"].add(bed)
        g["scouted"] += 1
        g["live"] += key in live
        if signs is not None:
            g["signs"] += key in signs
    if not any(groups):
        return []
    rows = [{
        "variety": v,
        "beds": len(g["beds"]),
        "scouted": g["scouted"],
        "infested": g["live"],
        "prevalence": _pct(g["live"], g["scouted"]),
        "signs": _pct(g["signs"], g["scouted"]) if signs is not None else None,
        "few": g["scouted"] < VARIETY_MIN_N,
    } for v, g in groups.items()]
    rows.sort(key=lambda r: (r["variety"] == "", -r["scouted"], r["variety"]))
    return rows


def latest_weeks(weeks, houses=None) -> dict:
    """``{house: its latest scouted ISO week}`` (every house in the window when
    ``houses`` is None)."""
    out = {}
    for wh in (weeks.warehouses() if houses is None else houses):
        week, _previous = weeks.latest_pair(wh)
        if week:
            out[wh] = week
    return out


def station_beds(crop, chosen) -> dict:
    """``{(house, station): (bed, variety)}`` for the chosen (house, ISO week)
    pairs, in one parent-only scan through piece 1's crop scoping (D5). A
    station seen on two beds that week keeps one with a variety."""
    if not chosen:
        return {}
    mondays = sorted(P.week_monday(w) for w in chosen.values())
    last = (datetime.strptime(mondays[-1], "%Y-%m-%d").date() + timedelta(days=6)).isoformat()
    where, params = parent_filter_conditions(mondays[0], last, crop, sorted(chosen))
    pairs = tuple(sorted((wh, int(w.replace("-W", ""))) for wh, w in chosen.items()))
    params["sw_pairs"] = pairs
    out: dict = {}
    for wh, station, bed, variety in frappe.db.sql(
        f"""
        SELECT {R._WH}, {R._STATION}, se.bed, b.variety
        FROM `tabScouting Entry` se
        LEFT JOIN `tabBed` b ON b.name = se.bed
        WHERE {where} AND COALESCE({R._STATION}, '') <> ''{R._pairs_clause(pairs)}
        """,
        params,
    ):
        key = ((wh or "").strip(), (station or "").strip())
        value = ((bed or "").strip(), (variety or "").strip())
        if key not in out or (value[1] and not out[key][1]):
            out[key] = value
    return out


def breakdown(weeks, crop, pest, chosen, beds) -> list:
    """The table for ``pest`` over the ``chosen`` house-weeks (``latest_weeks``)
    with their ``beds`` (``station_beds``)."""
    if not pest or not chosen or not any(v for _bed, v in beds.values()):
        return []
    scouted, live, signs = set(), set(), set()
    for wh, week in chosen.items():
        scouted |= {(wh, s) for s in weeks.scouted_set(wh, week)}
        live |= {(wh, s) for s in weeks.infested_set(wh, week, "pest", pest)}
        signs |= {(wh, s) for s in weeks.infested_set(wh, week, "pest", pest, role=R.SIGNS)}
    with_signs = bool(stage_roles.sign_stages(crop, pest))
    return group_by_variety(beds, scouted, live, signs if with_signs else None)


def variety_breakdown(weeks, crop, pest, houses=None) -> list:
    """``breakdown`` for every house in ``weeks`` (or ``houses``), latest week each."""
    if not pest:
        return []
    chosen = latest_weeks(weeks, houses)
    return breakdown(weeks, crop, pest, chosen, station_beds(crop, chosen))
```

- [ ] **Step 4: Into the payloads**

(a) `_gh_detail.py`: the import `from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows` becomes `from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows, _variety`. Directly before the prevalence-rows loop (`prevalence_rows = []`), add:

```python
    # S7: the house's latest-week stations by bed variety, one scan for every top pest.
    variety_weeks = _variety.latest_weeks(weeks, [gh])
    variety_beds = _variety.station_beds(filters["crop"], variety_weeks) if top_pests else {}
```

and in the `prevalence_rows.append({…})` dict add:

```python
                "varieties": (
                    _variety.breakdown(weeks, filters["crop"], t["name"], variety_weeks, variety_beds)
                    if kind == "pest" else None
                ),
```

(b) `_pests_diseases.py`: add `from upande_scp.serverscripts.dashboard_aggregates import _variety` beside the `_prevalence_rows` import. In `_build`'s `payload = {…}`, add:

```python
        # S7: the selected pest by rose variety (each house's latest scouted week).
        "varieties": (
            _variety.variety_breakdown(weeks, filters["crop"], filters["observation"])
            if kind == "pest" and filters["observation"] else []
        ),
```

- [ ] **Step 5: Run to pass, plus the gate**

Run: the pure suites (`test_stage_variety_pure` and the pure gate), **DB-RUN `test_stage_variety`**, **DB-RUN `test_dashboard_aggregates_gh_detail`**, **DB-RUN `test_dashboard_aggregates_pests_diseases`**, **DB-RUN `test_prevalence_pests`**, **DB-RUN `test_prevalence_overview`**, **DB-RUN `test_crop_scoped_aggregate_detail`**, **DB-RUN `test_hot_spots`**
Expected: all OK.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_variety.py upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py upande_scp/serverscripts/tests/test_stage_variety_pure.py upande_scp/serverscripts/tests/test_stage_variety.py
git commit -m "feat(scp): by-variety live prevalence and signs for the selected pest on the greenhouse detail and pests tab"
```

---

### Task 6: The thresholds editor shows each pest stage's role and edits its crop weight

**Files:**
- Modify: `upande_scp/serverscripts/store/thresholds_api.py` (module docstring, `_filter_rows`, `_validate`, `save_thresholds`)
- Modify: `frontend/src/lib/thresholds-api.ts` (`ThresholdStageRow`)
- Modify: `frontend/src/components/settings/ThresholdsTab.tsx` (`FilterEditor` stage rows; two new components after `ThInput`)
- Test: `upande_scp/serverscripts/tests/test_stage_variety.py` (class `TestEditor`), `frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx`

**Interfaces:**
- Consumes: Task 1 `stage_roles.role_of`, `role_map`, `master_weight`, `invalidate_stage_roles`.
- Produces:
  - `get_thresholds` **pest** stage rows gain `role` (read-only, from the Stage master), `master_weight` and `weight` (the crop override, 0 = the master's). Disease stage rows carry none of them.
  - `save_thresholds` writes a pest stage row's `weight` when the key is present, so an old client leaves it alone. It refuses a negative weight before any write, and drops the stage-roles cache.
  - TS `ThresholdStageRow.role?`, `weight?`, `master_weight?`. The UI shows a `stage-role-<row>` pill and a `Weight for <stage>` input (text, decimal; empty = the master's, shown as placeholder) on pest stage rows only.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_stage_variety.py`:

```python
TA = import_module("upande_scp.serverscripts.store.thresholds_api")


class TestEditor(StageCase):
    def setUp(self):
        super().setUp()
        for stage, role in (("Motiles", "Form"), ("Eggs", "Life stage"), ("Web", "Sign")):
            SV.set_role(stage, role)
            SV.set_master_weight(stage, 1)
            SV.set_override("Rose", "Spidermites", stage, 0)

    def _row(self, bundle=None):
        bundle = bundle or TA.get_thresholds("Rose")
        return next(r for r in bundle["pests"] if r["pest"] == "Spidermites")

    def test_pest_stage_rows_carry_their_role_and_weights(self):
        SV.set_master_weight("Eggs", 0.5)
        stages = {s["stage"]: (s["role"], s["master_weight"], s["weight"]) for s in self._row()["stages"]}
        self.assertEqual(stages, {"Motiles": ("Form", 1.0, 0.0), "Eggs": ("Life stage", 0.5, 0.0),
                                  "Web": ("Sign", 1.0, 0.0)})

    def test_disease_stage_rows_carry_no_role_or_weight(self):
        stage = next(s for r in TA.get_thresholds("Rose")["diseases"] for s in r["stages"])
        self.assertFalse({"role", "weight", "master_weight"} & set(stage))

    def test_a_saved_weight_override_is_read_at_once(self):
        TF.set_bands("Rose", "Spidermites", 0, 1, 5, measure="Count")
        self.assertEqual(dict(_common.band_spec("Rose", "pest", "Spidermites", "")["count_weights"])["Eggs"], 1.0)
        row = self._row()
        next(s for s in row["stages"] if s["stage"] == "Eggs")["weight"] = 0.25
        with patch.object(frappe.db, "commit"):
            TA.save_thresholds("Rose", {"pests": [row], "diseases": []})
        self.assertEqual(frappe.db.get_value("Pests Stages", {"parent": row["row"], "stage": "Eggs"}, "weight"), 0.25)
        self.assertEqual(stage_roles.stage_weight("Rose", "Spidermites", "Eggs"), 0.25)   # no stale cache
        self.assertEqual(dict(_common.band_spec("Rose", "pest", "Spidermites", "")["count_weights"])["Eggs"], 0.25)

    def test_a_negative_weight_is_refused_before_any_write(self):
        row = self._row()
        row["low"] = 0.5
        next(s for s in row["stages"] if s["stage"] == "Eggs")["weight"] = -1
        with patch.object(frappe.db, "commit"), self.assertRaisesRegex(frappe.ValidationError, "weight cannot be negative"):
            TA.save_thresholds("Rose", {"pests": [row], "diseases": []})
        self.assertEqual(frappe.db.get_value("Pest Filter", row["row"], "low_threshold"), 0.0)

    def test_an_old_client_without_weights_leaves_the_override_alone(self):
        SV.set_override("Rose", "Spidermites", "Eggs", 0.25)
        row = self._row()
        for s in row["stages"]:
            s.pop("weight", None)
        with patch.object(frappe.db, "commit"):
            TA.save_thresholds("Rose", {"pests": [row], "diseases": []})
        self.assertEqual(frappe.db.get_value("Pests Stages", {"parent": row["row"], "stage": "Eggs"}, "weight"), 0.25)
```

In `frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx`:

(a) `import { render, screen, waitFor, within } from "@testing-library/react";` becomes `import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";`.

(b) In the `rose` fixture, the two stage rows become:

```tsx
          { row: "s1", stage: "Adult", reading_type: "Count", low: 0, moderate: 0, high: 0, invalid: false,
            role: "Life stage", weight: 0, master_weight: 1 },
          { row: "s2", stage: "Damages", reading_type: "Checkbox", low: 0, moderate: 0, high: 0, invalid: false,
            role: "Sign", weight: 0, master_weight: 1 },
```

and `diseases: []` becomes:

```tsx
    diseases: [
      { row: "d1", disease: "Downy Mildew", measure: "Percentage", count_allowed: false, invalid: false,
        low: 0, moderate: 0, high: 0,
        stages: [{ row: "ds1", stage: "Active", reading_type: "Range", low: 0, moderate: 0, high: 0, invalid: false }] },
    ],
```

(c) Append inside `describe("ThresholdsTab", …)`:

```tsx
  it("shows each pest stage's role and its crop weight, the stage's own weight as placeholder", async () => {
    getThresholds.mockResolvedValue({
      ...rose,
      pests: [{ ...rose.pests[0], stages: [{ ...rose.pests[0].stages[0], weight: 0.5 }, rose.pests[0].stages[1]] }, rose.pests[1]],
    });
    render(<ThresholdsTab crop="Rose" />);
    const thrips = await screen.findByTestId("threshold-row-p1");
    expect(within(thrips).getByTestId("stage-role-s1")).toHaveTextContent("Life stage");
    expect(within(thrips).getByTestId("stage-role-s2")).toHaveTextContent("Sign");
    expect(within(thrips).getByLabelText("Weight for Adult")).toHaveValue("0.5");
    const damages = within(thrips).getByLabelText("Weight for Damages");
    expect(damages).toHaveValue("");
    expect(damages).toHaveAttribute("placeholder", "1");
    expect(thrips.innerHTML).not.toMatch(/border-l-|border-left/);
  });

  it("shows no role or weight on a disease stage", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const downy = await screen.findByTestId("threshold-row-d1");
    expect(within(downy).queryByTestId("stage-role-ds1")).toBeNull();
    expect(within(downy).queryByLabelText("Weight for Active")).toBeNull();
  });

  it("sends a weight override on save, and an emptied weight as 0", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const thrips = await screen.findByTestId("threshold-row-p1");
    fireEvent.change(within(thrips).getByLabelText("Weight for Adult"), { target: { value: "0.5" } });
    fireEvent.change(within(thrips).getByLabelText("Weight for Damages"), { target: { value: "" } });
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    const stages = saveThresholds.mock.calls[0][1].pests[0].stages;
    expect([stages[0].weight, stages[1].weight]).toEqual([0.5, 0]);
  });
```

The existing unit-suffix test still expects 6 × "per zone" and 3 × "%" in Thrips. The new pill and weight input add neither string.

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_stage_variety`** and `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/components/settings/__tests__/ThresholdsTab.test.tsx`
Expected: `TestEditor` FAILS (`KeyError: 'role'`, the override not saved, no `ValidationError`). The three new vitest tests FAIL (`Unable to find … data-testid="stage-role-s1"`). The old ones pass, the disease row included.

- [ ] **Step 3: The API**

In `upande_scp/serverscripts/store/thresholds_api.py`:

(a) Imports: add `from upande_scp.serverscripts.common import stage_roles`. Add this paragraph to the module docstring: "Pest stage rows also carry their **role** (Life stage / Form / Sign, read from the Stage master and edited there) and **weight**: the crop's override of the Stage's weight in a Count (0 = the Stage's; stage & variety S1, S5, S6). Diseases carry neither."

(b) In `_filter_rows`: before the `stages = frappe.db.sql(` call add:

```python
    with_weights = kind == "pest" and frappe.db.has_column(child, "weight")
    roles = stage_roles.role_map() if kind == "pest" else {}
```

The stage `SELECT` list becomes `SELECT name, parent, stage, reading_type, {"weight" if with_weights else "0"} AS weight, low_threshold, moderate_threshold, high_threshold`. In the `stage_rows` comprehension, after `"invalid": …,` add:

```python
                **({
                    "role": stage_roles.role_of(s["stage"], roles),
                    "master_weight": stage_roles.master_weight(s["stage"]),
                    "weight": _f(s["weight"]),
                } if kind == "pest" else {}),
```

(c) In `_validate`, inside `for s in r.get("stages") or []:` after the bands check, add:

```python
                if kind == "pest" and "weight" in s and _f(s.get("weight")) < 0:
                    errors.append(f"{label} · {s.get('stage') or s.get('row')}: weight cannot be negative.")
```

(d) In `save_thresholds`, the stage `frappe.db.set_value(child, s["row"], {…}, update_modified=True)` becomes:

```python
                stage_values = {
                    "low_threshold": _f(s.get("low")),
                    "moderate_threshold": _f(s.get("moderate")),
                    "high_threshold": _f(s.get("high")),
                }
                if key == "pests" and "weight" in s:
                    # No key = an old client: the stored override stands.
                    stage_values["weight"] = _f(s.get("weight"))
                frappe.db.set_value(child, s["row"], stage_values, update_modified=True)
```

and right after `_common.clear_threshold_cache()` add `stage_roles.invalidate_stage_roles()   # set_value fires no doc_events`.

- [ ] **Step 4: The editor**

(a) `frontend/src/lib/thresholds-api.ts`, in `ThresholdStageRow` after `high: number;` add:

```ts
  /** pests only: Life stage / Form count as the live pest; a Sign is reported beside it (set on the Stage master) */
  role?: "Life stage" | "Form" | "Sign";
  /** pests only: this crop's weight for the stage in a Count; 0 = the Stage's own weight */
  weight?: number;
  /** pests only: the Stage master's weight */
  master_weight?: number;
}
```

(the closing brace replaces the interface's existing one).

(b) `frontend/src/components/settings/ThresholdsTab.tsx`:
- In the header comment, add: "Pest stages show their role (Life stage / Form / Sign, set on the Stage master) and this crop's weight for the stage in a Count (empty = the stage's own weight)."
- `import { useEffect, useMemo, useState } from "react";` stays (it already has `useState`, `useEffect`).
- In `FilterEditor`, under the `Per-stage overrides` heading `div`, add for pests:

```tsx
          {isPest(row) && (
            <div className="text-[0.65rem] text-muted-foreground">
              Signs (damage, webs, ragged margins) are reported beside the pest, never counted as it. Weight scales a
              stage's count in a Count; leave it empty for the stage's own weight.
            </div>
          )}
```

- In the stage row, after `<span className="text-xs min-w-20 text-muted-foreground">{s.stage || "—"}</span>` add `{isPest(row) && s.role && <StageRolePill role={s.role} testId={`stage-role-${s.row}`} />}`. After the stage's `<ThresholdInputs … />` add:

```tsx
                {isPest(row) && (
                  <WeightInput
                    stage={s.stage}
                    value={s.weight ?? 0}
                    master={s.master_weight ?? 1}
                    onChange={(v) => onStagePatch(i, { weight: v })}
                  />
                )}
```

- Append after `ThInput`:

```tsx
const ROLE_TONE: Record<string, string> = {
  "Life stage": "var(--sd-data-green)",
  Form: "var(--sd-data-cyan)",
  Sign: "var(--sd-data-amber)",
};

/** A stage's role (stage & variety S1), set on the Stage master — a tinted
 *  pill, never a strip. */
function StageRolePill({ role, testId }: { role: string; testId: string }) {
  const tone = ROLE_TONE[role] ?? "var(--sd-muted)";
  return (
    <span
      data-testid={testId}
      title={role === "Sign" ? "A sign of the pest: reported beside it, never counted as it" : "Counts as the live pest"}
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {role}
    </span>
  );
}

/** This crop's weight for the stage in a Count (S5, S6). Empty = the stage's
 *  own weight, shown as the placeholder. A text field with its own draft, so
 *  "0." can be typed on the way to "0.5". */
function WeightInput({
  stage,
  value,
  master,
  onChange,
}: {
  stage: string;
  value: number;
  master: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(value > 0 ? String(value) : "");
  useEffect(() => {
    setText((t) => (parseFloat(t) || 0) === value ? t : value > 0 ? String(value) : "");
  }, [value]);
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">Weight</span>
      <Input
        type="text"
        inputMode="decimal"
        aria-label={`Weight for ${stage}`}
        placeholder={String(master)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(Math.max(0, parseFloat(e.target.value) || 0));
        }}
        className="h-7 w-14 text-xs tabular-nums"
      />
    </div>
  );
}
```

- [ ] **Step 5: Run to pass, typecheck**

Run: **DB-RUN `test_stage_variety`**, **DB-RUN `test_thresholds_measure`**, then `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/components/settings && npx tsc --noEmit -p tsconfig.app.json`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/store/thresholds_api.py upande_scp/serverscripts/tests/test_stage_variety.py frontend/src/lib/thresholds-api.ts frontend/src/components/settings/ThresholdsTab.tsx frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx
git commit -m "feat(scp): the thresholds editor shows each pest stage's role and edits its crop weight"
```

---

### Task 7: The frontend — signs in the figure line, the By-variety table, Trends signs

**Files:**
- Modify: `frontend/src/lib/prevalence.ts` (`PrevalenceFigures`, `figureLine`, `figureTooltip`; `VarietyRow`, `VARIETY_MIN_N`) + `frontend/src/lib/prevalence.test.ts`
- Create: `frontend/src/pages/dashboard/VarietyTable.tsx` + `frontend/src/pages/dashboard/__tests__/VarietyTable.test.tsx`
- Modify: `frontend/src/pages/dashboard/GreenhouseModal.tsx` (`GhPrevalence`; below `<SectionGrid …/>`, after any 3c Patches / Pins block) + `__tests__/GreenhouseModal.sections.test.tsx`
- Modify: `frontend/src/pages/dashboard/pests-diseases-types.ts` (`PestsPayload`), `frontend/src/pages/dashboard/PestsTab.tsx` (a card right after the "Pest Pressure by Greenhouse" card)
- Modify: `frontend/src/pages/trends/trends-types.ts`, `frontend/src/pages/trends/aggregate.ts` (`PrevalencePoint`, `buildPrevalenceIndex`) + `__tests__/prevalence-band.test.ts`

**Interfaces:**
- Consumes: Task 4 `signs` / `signsByStation`; Task 5 `varieties`.
- Produces: `PrevalenceFigures.signs?`; `figureLine` → `"33.3% · ±18 · 9/9 · signs 66.7%"`; `VarietyRow`; `<VarietyTable rows pest? />`, which returns null without rows; `GhPrevalence.varieties?`; `PestsPayload.varieties?`; `SignsRow`, `TrendsPayload.signsByStation?`; `PrevalencePoint.signs?`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/prevalence.test.ts`, inside `describe("figureLine", …)`:

```ts
  it("adds the pest's signs at the end when it has any", () => {
    const signs = { ...base, prevalence: 66.7, prev: null };
    expect(figureLine({ ...base, prev: null, signs })).toBe("34% · ±6 · 8/9 · signs 66.7%");
    expect(figureLine({ ...base, prev: null, signs: null })).toBe("34% · ±6 · 8/9");
    expect(figureLine({ ...base, prevalence: null, reason: "no stations set up", signs })).toBe("no stations set up");
  });
```

and inside `describe("figureTooltip", …)`:

```ts
  it("explains the signs line only when there is one", () => {
    expect(figureTooltip({ ...base, signs: { ...base, prevalence: 30 } })).toContain("Signs: share of scouted stations showing signs of it");
    expect(figureTooltip(base)).not.toContain("Signs:");
  });
```

Create `frontend/src/pages/dashboard/__tests__/VarietyTable.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VarietyTable } from "../VarietyTable";
import type { VarietyRow } from "@/lib/prevalence";

const ROWS: VarietyRow[] = [
  { variety: "Fuchsiana", beds: 6, scouted: 18, infested: 6, prevalence: 33.3, signs: 66.7, few: false },
  { variety: "Red Naomi", beds: 3, scouted: 9, infested: 3, prevalence: 33.3, signs: 66.7, few: true },
  { variety: "", beds: 1, scouted: 2, infested: 0, prevalence: 0, signs: 0, few: true },
];

describe("VarietyTable", () => {
  it("lists each variety with its beds, stations, live share and signs", () => {
    render(<VarietyTable rows={ROWS} pest="Thrips" />);
    expect(screen.getByText("By variety · Thrips")).toBeInTheDocument();
    const [first] = screen.getAllByTestId("variety-row");
    for (const text of ["Fuchsiana", "6", "18", "33.3%", "66.7%"]) {
      expect(within(first).getByText(text)).toBeInTheDocument();
    }
    expect(first).toHaveAttribute("data-few", "false");
  });

  it("greys the varieties with fewer than 10 stations scouted", () => {
    render(<VarietyTable rows={ROWS} />);
    const few = screen.getAllByTestId("variety-row")[1];
    expect(few).toHaveAttribute("data-few", "true");
    expect(few.className).toMatch(/opacity-60/);
    expect(within(few).getByText("too few")).toBeInTheDocument();
  });

  it("names stations on beds with no variety", () => {
    render(<VarietyTable rows={ROWS} />);
    expect(screen.getByText("No variety recorded")).toBeInTheDocument();
  });

  it("drops the signs column when the pest has no sign stage", () => {
    render(<VarietyTable rows={ROWS.map((r) => ({ ...r, signs: null }))} />);
    expect(screen.queryByText("Signs")).toBeNull();
  });

  it("is hidden without varieties (avocado, coffee) and draws no left-border strip", () => {
    const { container, rerender } = render(<VarietyTable rows={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VarietyTable rows={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VarietyTable rows={ROWS} />);
    expect(container.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});
```

Append to `frontend/src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx`:

```tsx
describe("GreenhouseModal by variety", () => {
  const figure = { margin: 17.8, sections_scouted: 9, sections_total: 9, reliability: "Fair" as const, reason: null, prev: null };
  beforeEach(() => {
    useDashboardAggregate.mockReset().mockReturnValue({
      data: {
        topPests: [{ name: "Thrips", count: 9 }], topDiseases: [{ name: "Downy Mildew", count: 3 }],
        traps: [], daily: [], scouts: 1, alerts: 0,
        prevalence: [
          { kind: "pest", name: "Thrips", prevalence: 33.3, ...figure, sections: cells(() => 33.3),
            signs: { prevalence: 66.7, ...figure },
            varieties: [{ variety: "Fuchsiana", beds: 6, scouted: 18, infested: 6, prevalence: 33.3, signs: 66.7, few: false }] },
          { kind: "disease", name: "Downy Mildew", prevalence: 11.1, ...figure, sections: cells(() => 11.1), varieties: null },
        ],
      },
    });
  });

  it("shows the picked pest's varieties and signs, and nothing for a disease", () => {
    render(<GreenhouseModal greenhouse="Chepsito GH 01 - KR" fromDate="2031-10-27" toDate="2031-11-02" crop="Rose" onClose={() => {}} />);
    expect(screen.getByTestId("variety-table")).toHaveTextContent("Fuchsiana");
    expect(screen.getByTestId("prevalence-figure")).toHaveTextContent("signs 66.7%");
    fireEvent.click(screen.getByRole("button", { name: "Downy Mildew" }));
    expect(screen.queryByTestId("variety-table")).toBeNull();
  });
});
```

Append to `frontend/src/pages/trends/__tests__/prevalence-band.test.ts`:

```ts
describe("signs beside the station prevalence", () => {
  it("attaches the signs share to the matching station point only", () => {
    const idx = buildPrevalenceIndex(payload({ signsByStation: [[0, 0, 0, 66.7]] }));
    expect(idx.station.get("0|0|0")?.signs).toBe(66.7);
    expect(idx.farm.get("0|0|0")?.signs).toBeUndefined();
    expect(buildPrevalenceIndex(payload()).station.get("0|0|0")?.signs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/prevalence.test.ts src/pages/dashboard/__tests__/VarietyTable.test.tsx src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx src/pages/trends/__tests__/prevalence-band.test.ts`
Expected: FAIL. `VarietyTable` cannot be resolved; the figure line lacks `· signs 66.7%`; `variety-table` is not found; `signs` is undefined on the point.

- [ ] **Step 3: `lib/prevalence.ts`**

(a) In `PrevalenceFigures`, after `houses?: number;` add:

```ts
  /** stage & variety S4: the same figures for SIGNS of the pest (damage, webs,
   *  ragged margins) — reported beside the live figure, never counted as it.
   *  null / absent: the pest has no Sign stage. */
  signs?: PrevalenceFigures | null;
```

(b) After `SectionCell` add:

```ts
/** stage & variety S7: one rose variety's stations for the selected pest
 *  (each house's latest scouted week). Raw shares, 0–100. */
export interface VarietyRow {
  /** "" = stations on beds with no variety recorded */
  variety: string;
  beds: number;
  scouted: number;
  infested: number;
  prevalence: number | null;
  /** null when the pest has no Sign stage */
  signs: number | null;
  /** fewer than VARIETY_MIN_N stations scouted: greyed "too few" */
  few: boolean;
}

export const VARIETY_MIN_N = 10;
```

(c) `figureLine` becomes:

```ts
/** "34% (was 50%) · ±6 · 8/9 · signs 30%" — the one line the dashboard shows;
 *  the signs part only when the pest has a Sign stage. */
export function figureLine(f: PrevalenceFigures): string {
  if (f.prevalence == null) return f.reason || "no stations set up";
  const was = f.prev != null ? ` (was ${f.prev}%)` : "";
  const margin = f.margin != null ? `±${f.margin}` : f.reason || CLUSTERED;
  const signs = f.signs?.prevalence != null ? ` · signs ${f.signs.prevalence}%` : "";
  return `${f.prevalence}%${was} · ${margin} · ${f.sections_scouted}/${f.sections_total ?? 9}${signs}`;
}
```

(d) In `figureTooltip`'s array, before `...(mix ? …)`, add:

```ts
    ...(f.signs?.prevalence != null
      ? ["Signs: share of scouted stations showing signs of it (damage, webs, ragged margins) — beside the pest, never counted as it"]
      : []),
```

- [ ] **Step 4: `VarietyTable.tsx`**

Create `frontend/src/pages/dashboard/VarietyTable.tsx`:

```tsx
import { cn } from "@/lib/utils";
import type { VarietyRow } from "@/lib/prevalence";

/** Stage & variety S7: the selected pest by rose variety — a station's variety
 *  is the variety of the bed it was scouted on, each house's latest scouted
 *  week. Hidden when nothing carries a variety (avocado, coffee). A variety
 *  with fewer than 10 scouted stations is greyed "too few". */
export function VarietyTable({ rows, pest }: { rows: VarietyRow[] | null | undefined; pest?: string }) {
  if (!rows?.length) return null;
  const withSigns = rows.some((r) => r.signs != null);
  const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
  return (
    <div data-testid="variety-table" className="flex flex-col gap-1">
      <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
        {pest ? `By variety · ${pest}` : "By variety"}
      </div>
      <table className="w-full text-[0.7rem] tabular-nums">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-0.5 font-medium">Variety</th>
            <th className="py-0.5 text-right font-medium">Beds</th>
            <th className="py-0.5 text-right font-medium">Stations</th>
            <th className="py-0.5 text-right font-medium">Live</th>
            {withSigns && <th className="py-0.5 text-right font-medium">Signs</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.variety || "__none"}
              data-testid="variety-row"
              data-few={r.few ? "true" : "false"}
              title={r.few ? "Fewer than 10 stations scouted: too few to read much into" : undefined}
              className={cn("border-t border-[var(--sd-line)]", r.few && "text-muted-foreground opacity-60")}
            >
              <td className="max-w-40 truncate py-0.5">
                {r.variety || "No variety recorded"}
                {r.few && <span className="ml-1 text-[0.6rem]">too few</span>}
              </td>
              <td className="py-0.5 text-right">{r.beds}</td>
              <td className="py-0.5 text-right">{r.scouted}</td>
              <td className="py-0.5 text-right">{pct(r.prevalence)}</td>
              {withSigns && <td className="py-0.5 text-right">{pct(r.signs)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 5: Placement and types**

(a) `GreenhouseModal.tsx`: the import `import type { PrevalenceFigures, SectionCell } from "@/lib/prevalence";` becomes `import type { PrevalenceFigures, SectionCell, VarietyRow } from "@/lib/prevalence";`. Add `import { VarietyTable } from "./VarietyTable";`. In `GhPrevalence`, after `sections: SectionCell[];` add `/** pests only (S7); null for a disease */ varieties?: VarietyRow[] | null;`. In the prevalence card, after `<SectionGrid … />` and after any 3c Patches / Pins block that follows it, add:

```tsx
              {current.kind === "pest" && <VarietyTable rows={current.varieties} pest={current.name} />}
```

(b) `pests-diseases-types.ts`: the import becomes `import type { PrevalenceFigures, Reliability, VarietyRow } from "@/lib/prevalence";`. In `PestsPayload`, after `trendSeries: TrendSeries;` add `/** the selected pest by rose variety (S7); [] without a selected pest or variety */ varieties?: VarietyRow[];`.

(c) `PestsTab.tsx`: add `import { VarietyTable } from "./VarietyTable";`. Directly after the closing `</Card>` of the card titled "Pest Pressure by Greenhouse", add:

```tsx
        {pestName && (data?.varieties?.length ?? 0) > 0 && (
          <Card className="p-4">
            <CardHeader className="p-0 pb-2">
              <CardTitle>By Variety</CardTitle>
              <CardDescription>
                Live prevalence and signs of {pestName} by rose variety · each greenhouse's latest scouted week
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <VarietyTable rows={data?.varieties} />
            </CardContent>
          </Card>
        )}
```

(d) `trends/trends-types.ts`: after `PrevalenceRow` add:

```ts
/** [weekIdx, stationIdx, obsIdx, signs %] — beside a per-station prevalence row
 *  of a pest with a Sign stage (stage & variety S4) */
export type SignsRow = [number, number, number, number];
```

and in `TrendsPayload`, after `prevalenceByFarm?: PrevalenceRow[];` add `/** Signs of a pest beside its live per-station figure. */ signsByStation?: SignsRow[];`.

(e) `trends/aggregate.ts`: in `PrevalencePoint`, after `hi: number | null;` add `/** signs of the pest at this station that week (S4); absent when it has none */ signs?: number | null;`. In `buildPrevalenceIndex`, after the `prevalenceByStation` loop add:

```ts
  for (const row of payload.signsByStation ?? []) {
    const point = station.get(`${row[0]}|${row[1]}|${row[2]}`);
    if (point) point.signs = row[3];
  }
```

- [ ] **Step 6: Run to pass, typecheck, build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib src/pages/dashboard src/pages/trends src/components/settings && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: all pass, no type errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add frontend/src/lib/prevalence.ts frontend/src/lib/prevalence.test.ts frontend/src/pages/dashboard/VarietyTable.tsx frontend/src/pages/dashboard/__tests__/VarietyTable.test.tsx frontend/src/pages/dashboard/GreenhouseModal.tsx frontend/src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx frontend/src/pages/dashboard/pests-diseases-types.ts frontend/src/pages/dashboard/PestsTab.tsx frontend/src/pages/trends/trends-types.ts frontend/src/pages/trends/aggregate.ts frontend/src/pages/trends/__tests__/prevalence-band.test.ts
```

If `yarn build` changed tracked build output (check `git status --short` for `upande_scp/public/…` paths), add those exact paths too, and nothing else. Then:

```bash
git commit -m "feat(scp-ui): signs in the figure line and a by-variety table on the greenhouse modal and pests tab"
```

---

### Task 8: Final regression and an in-process check on the real data

**Files:** none changed. If a check fails, fix it in the owning task's files and re-run that task's tests.

- [ ] **Step 1: Pure suites**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_stage_variety_pure.py upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_trends_prevalence_pure.py upande_scp/serverscripts/tests/test_threshold_core_pure.py upande_scp/serverscripts/tests/test_threshold_counts_pure.py upande_scp/serverscripts/tests/test_hot_spots_pure.py` plus every pure 3c suite (Global Constraints).
Expected: all pass.

- [ ] **Step 2: DB suites, one module per DB-RUN**

New: `test_stage_variety`.
Regression: `test_hot_spots`, `test_scouting_alerts`, `test_alert_digest`, `test_scouting_alert_creator`, `test_thresholds_measure`, `test_threshold_measure_dashboards`, `test_notifications`, `test_block_weekly_report`, `test_dashboard_aggregates_overview`, `test_dashboard_aggregates_pests_diseases`, `test_dashboard_aggregates_gh_detail`, `test_dashboard_aggregates_traps`, `test_dashboard_aggregates_fcm`, `test_prevalence_rows`, `test_prevalence_overview`, `test_prevalence_pests`, `test_prevalence_trends`, `test_crop_scoped_aggregates`, `test_crop_scoped_aggregate_detail`, `test_crop_scoped_observations`, `test_crop_scoped_spray_plan`, `test_spray_compliance_enforcement`, and every 3c DB suite.
Expected: every module OK. Then confirm nothing leaked: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT COUNT(*) FROM \`tabScouting Entry\` WHERE name LIKE '\_TEST-%'; SELECT COUNT(*) FROM \`tabStage\` WHERE name LIKE '\_TEST%'; SELECT COUNT(*) FROM \`tabBed\` WHERE variety LIKE '\_TEST%'; SELECT stage_role, COUNT(*) FROM \`tabStage\` GROUP BY 1; SELECT COUNT(*) FROM \`tabStage\` WHERE weight <> 1; SELECT COUNT(*) FROM \`tabPests Stages\` WHERE weight <> 0;"` → `0`, `0`, `0`, `Form 7 / Life stage 30 / Sign 5`, `0`, `0`. Also drop any test-time copy: **DB-EXEC** `from upande_scp.serverscripts.common import stage_roles; stage_roles.invalidate_stage_roles()`.

- [ ] **Step 3: Frontend**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: the whole vitest suite passes, no type errors, the build succeeds. The built assets are served at once, but the web workers keep the old Python until **the user** restarts them; never restart anything yourself. Against old workers the payloads carry no `signs` / `varieties`, so the UI shows neither.

- [ ] **Step 4: In-process check on the real data, rolled back**

Run (read-only; the old figure comes from `roles={}`, i.e. every stage a life stage):

```bash
cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "
import time, frappe
from collections import Counter
frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator')
from upande_scp.serverscripts.common import stage_roles
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R, _variety as V
try:
    print('roles', Counter(stage_roles.role_map().values()))
    fr, to = '2026-09-27', '2026-10-10'
    t = time.time(); live = R.StationWeeks.load(fr, to, 'Rose', None); print('load Rose %.1fs, %d houses' % (time.time() - t, len(live.warehouses())))
    old = R.StationWeeks.load(fr, to, 'Rose', None, roles={})
    for pest in ('Thrips', 'Spidermites', 'Mealybugs', 'Aphids', 'Whiteflies', 'Weevils'):
        a = (old.combined_latest('pest', pest) or {}).get('prevalence')
        b = (live.combined_latest('pest', pest) or {}).get('prevalence')
        s = (R.signs_combined_latest(live, 'Rose', pest) or {}).get('prevalence')
        print('%-12s before %-6s live %-6s signs %s' % (pest, a, b, s))
    t = time.time(); rows = V.variety_breakdown(live, 'Rose', 'Thrips'); dt = time.time() - t
    print('varieties Rose Thrips %.1fs: %d rows, %d too few' % (dt, len(rows), sum(r['few'] for r in rows)))
    print([(r['variety'], r['scouted'], r['prevalence'], r['signs']) for r in rows[:6]])
    gh = live.warehouses()[0]
    t = time.time(); one = V.variety_breakdown(live, 'Rose', 'Thrips', [gh]); print(gh, '%.2fs' % (time.time() - t), one[:4])
    avo = R.StationWeeks.load(fr, to, 'Avocado', None)
    print('avocado varieties', V.variety_breakdown(avo, 'Avocado', 'Mealybugs'))
finally:
    frappe.db.rollback()
"
```

Expected: `roles` shows `Life stage 30, Form 7, Sign 5`. For Thrips (≈33k Damages rows in the last two weeks), `live` ≤ `before` and `signs` is non-null. Aphids (`Singles` / `Colonies`: forms) shows `live == before` and `signs None`. The scope-wide variety table finishes in a few seconds with up to ~90 varieties, some greyed. The one-house table is sub-second. Avocado is `[]`. Report the numbers.

- [ ] **Step 5: Hand-off notes**

Report to the user, with the Step 4 numbers:
- **Live pest prevalence now excludes signs.** Give the before / live / signs figures for the main rose pests. Thrips and other pests with `Damages` rows read lower, and the Damage figure is shown beside them as "signs".
- **Weights are all 1.0.** An agronomist sets real ones in Settings → Thresholds (per crop) or on the Stage master. Roles are edited on the Stage doctype.
- **Coffee "Yellow Termites"** records only `Damages` (a Sign), so its live figure is always 0 % and only its signs show. This follows S3; the agronomist may want to re-role that stage.
- The backend goes live only after the user restarts the web and worker processes, then runs `bench --site kaitet.local clear-cache`. The clear-cache makes the new `Stage` doc-event hook load, because hooks are cached in Redis. Nothing was restarted here. Live sites need `bench migrate` (or the same DB-runner steps) to get the two columns and run `seed_stage_roles`.

- [ ] **Step 6: Confirm the tree is clean of this work**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short && git log --oneline -10`
Expected: only the unrelated store/batch-transfer files (and any uncommitted 3b/3c work that is not yours) remain modified or untracked, plus seven commits from this plan (Tasks 1–7).

---

## Ambiguities resolved

1. **`stage_role` has no column default.** A Select `"default"` becomes a MariaDB `DEFAULT`, which `ADD COLUMN` writes into every existing row, so a fill-blanks seed would find nothing blank. New stages still get Life stage: it is the first option (Frappe's `create_new`), and `Stage.validate` sets it as a fallback. Readers treat NULL / `""` / unknown as Life stage.
2. **"Blank = master" for `Pests Stages.weight` is 0.** Frappe Floats are `NOT NULL DEFAULT 0`, so an override of 0 inherits the master's weight. A per-crop "drop this stage" is done by setting the master weight to 0. A master weight of 0 is honoured.
3. **Weights apply only to a row's all-stage Count** (`count_weights` on the row key). A stage-specific band reads its raw count, per spec Design §3 ("stage-filtered figures unchanged in meaning"). Percentage figures are unweighted (presence only).
4. **S5's "Count-reading Life-stage/Form stages" also drives D1.** A pest row is Count-eligible in the loader only with a counted live stage. The editor's `count_allowed` is unchanged; no kaitet row differs.
5. **The role filter applies only to all-stage pest figures,** including `obs=ANY` (pressure, trend lines) and 3b / 3c's section and cluster reads. A named stage and every disease read their rows whatever the role. A pest row with no stage is live.
6. **`signs` is present only where the crop's Pest Filter lists a Sign stage for the pest** (any pest for `obs=ANY`). Otherwise it is `None`, so no "signs 0%" for Aphids. Diseases carry `None`. On a Pests pressure row with a stage filter picked, `signs` is `None`.
7. **Overview "cells" carry the pest-level signs on every stage cell,** and so do the `activeAlerts` rows built from them (the cells themselves are internal).
8. **Trends gets a separate `signsByStation` table `[week, station, obs, signs%]`** instead of a seventh element on `prevalenceByStation`. This keeps the existing row type and its pure / DB suites intact. Farm rows get no signs. The Trends index exposes `PrevalencePoint.signs`; drawing it on the chart is left for later.
9. **There is no new whitelisted variety endpoint.** `varieties` rides inside the cached `greenhouse_detail` pest rows and the `pests` payload (only when an observation is picked). Both surfaces get it under the same cache and crop checks. Diseases get `None`.
10. **Variety figures are raw shares** (infested ÷ scouted stations of the variety), each house's latest scouted week, and the union of houses for a scope. A variety's beds are not a 3 × 3 sample. Stations with no bed or no variety form a `""` group ("No variety recorded"), listed last. The table is hidden when no station has a variety. "Beds" counts distinct scouted beds.
11. **Roles are edited only on the Stage doctype.** The editor shows the role read-only and edits the per-crop weight, with the master weight as placeholder. Disease stages show neither.
12. **A hand-built `StationWeeks` defaults to the S2 seed roles** (so pure tests need no site). `StationWeeks.load` reads the Stage master. Before the schema exists, every stage reads Life stage, which is today's behaviour.
13. **Coffee Yellow Termites (only `Damages`) reads live 0 %.** That is S3 applied as written. It is flagged in the hand-off, not special-cased.
14. **A Stage edit bumps the dashboard aggregate version,** because "Stage" is added to `_CROP_CATALOG_SOURCES`. A role change alters every pest figure. The new `doc_events` hook needs the user's restart + clear-cache, so tests call `invalidate_on_change` directly.
15. **Test weeks are 2031-W44 / W45,** clear of 3a/3b (W20–W22) and piece 1/2 (W02–W11, W53/W01). Implementers grep first in case 3c took them.
