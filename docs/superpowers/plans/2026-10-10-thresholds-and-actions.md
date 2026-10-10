# Thresholds and Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each crop's pests and diseases carry thresholds measured the way they are scouted (Percentage = piece 2's adjusted prevalence, Count = average count per scouted station). Crossing Moderate raises an **Alarming** notification; crossing High raises **Spray advised**, or **Scout first** when the figure is Low reliability. Every alert is stored as a **Scouting Alert**, a daily 17:00 EAT digest emails each recipient once, the spray plan creator offers **Create curative plan**, and SCP's bell shows only SCP notifications.

**Architecture:** The pure rules live in `common/threshold_bands.py` (band ordering, band → action, escalation, measure per stage, unit labels), with the count figure added to `common/prevalence.py` (`count_figures`). `dashboard_aggregates/_common.py` loads each crop's bands with their measure (`band_spec`), and `_prevalence_rows.StationWeeks` adds per-station counts, so dashboards, the new `scouting/thresholds_check.py` (evaluation, upsert, recipients, endpoints) and the block report all judge the same figure. An hourly self-gated job writes Scouting Alerts and notifies through `common/notifications.notify(..., category="scouting")`. A second hourly job, gated to 17:00 Africa/Nairobi, sends the digest. The React app gets a measure-aware Thresholds editor, Overview alerts with Acknowledge, and creator badges.

**Tech Stack:** Frappe v16 / Python 3.14, MariaDB (`YEARWEEK(d, 3)`), Redis (`SET NX EX` gates); React 19 + TypeScript + Vite + recharts 2.15 + vitest (jsdom, @testing-library/react) in `frontend/`.

**Spec:** `docs/superpowers/specs/2026-10-10-thresholds-and-actions-design.md` (binding)

## Global Constraints

- Site is **`kaitet.local`** only (read-only SQL: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT …"`). **Never use the Kaitet MCP** (`mcp__claude_ai_Kaitet*`), for anything.
- Commits: **no `Co-Authored-By` trailer** (CLAUDE.md). Style `feat(scp): …` / `fix(scp): …` / `feat(scp-ui): …`, lowercase sentence.
- Stage with explicit `git add <paths>` only. **Never stage** the unrelated uncommitted store/batch-transfer work: `frontend/src/components/store/TransferBatchPanel.tsx`, `frontend/src/lib/store-keeper-api.ts`, `frontend/src/pages/SprayPlanTransfers.tsx`, `upande_scp/serverscripts/store/batch_suggestion.py`, `upande_scp/serverscripts/store/store_keeper_api.py`, `upande_scp/serverscripts/tests/test_batch_suggestion.py`, `upande_scp/serverscripts/tests/test_transfer_batch_apply.py`, `upande_scp/serverscripts/tests/test_transfer_batch_gating.py`, `upande_scp/serverscripts/tests/test_transfer_batch_split.py`. Never `git add -A` / `git add .` / `git commit -a`. **Never `git stash`.** Run `git status --short` before every commit.
- **NEVER restart anything on this server**: no `supervisorctl restart`, no `bench restart`, no MariaDB/Redis restart — another live site streams data on this server. `yarn build` is allowed. Consequence: the running web workers keep the old Python until someone else restarts them, so every server-side check in this plan runs **in-process through the DB runner**, never through the web server.
- Schema changes go through doctype JSON. Apply them with the DB runner (`frappe.reload_doc(..., force=True)`, a patch's `execute()` plus a `Patch Log` row, `ensure_scp_custom_fields()`), as each task spells out. `bench --site kaitet.local migrate` restarts no service (verified in `apps/frappe/frappe/migrate.py`: it clears the site cache and kills that site's DB connections idle > 30 s) but it runs every pending patch and hook of every app; use it **only** if you have checked that nothing streams into kaitet.local's database (`_a0667cbad37a1f08`) at that moment. If unsure, use the DB-runner path.
- **No email is sent during tests**: every test that can reach `frappe.sendmail` patches it (`patch.object(frappe, "sendmail")`). Live email is at the free-Gmail cap: the only email this feature sends is the one digest per person per day; never one email per alert.
- Notifications go **only** through `common/notifications.notify(...)` with `category="scouting"` (alerts) or `"plan"` (the auto-cancel notice, Task 4). `notify` writes `Notification Log.type = "Alert"`, which Frappe never emails (`is_email_notifications_enabled_for_type` returns False for "Alert").
- Indentation matches each file: 4 spaces in `common/notifications.py`, `common/prevalence.py`, `common/threshold_bands.py` (new), `dashboard_aggregates/*`, `store/thresholds_api.py`, `scouting/*` (incl. new), `spray_plan_creator/*`, and every new test module; **tabs** in `common/custom_fields.py`, `reports/block_weekly_report.py`, `tests/test_block_weekly_report.py`, doctype controllers and patches. 2 spaces in TS/TSX.
- UI: **no vertical accent strips and no coloured left-border bars**. Show accent through text colour, a tinted background or a pill.
- **Piece 1 crop scoping and piece 2 figures keep holding.** Every new scouting query goes through `StationWeeks.load` (→ `parent_filter_conditions` D5 + `obs_filter` D4). Regression gate, all green at the end of every task that touches their code: `test_dashboard_aggregates_{overview,pests_diseases,gh_detail,traps,fcm}`, `test_prevalence_{rows,overview,pests,trends}`, `test_crop_scoped_{aggregates,aggregate_detail,observations,spray_plan}`, `test_spray_compliance_enforcement` (DB), and `test_prevalence_pure`, `test_prevalence_rows_pure`, `test_trends_prevalence_pure` (pure).
- Exact spec numbers and strings: measures **`Percentage` / `Count`**; actions **`Alarming` / `Spray advised` / `Scout first`**; statuses **`Open` / `Acknowledged` / `Resolved` / `Converted to plan`**; bands on the alert **`Moderate` / `High`**; escalation **Alarming < Scout first < Spray advised**; D4 recipients: **Alarming → farm's Spray Plan Creators + Spray Supervisors; Spray advised / Scout first → those + farm's Spray Plan Approvers + SCP General Managers** (crop-scoped); digest at **17:00 Africa/Nairobi**; count margin **1.96·sqrt(s²/m + v/N)** with Poisson floor **v = max(mean, 1)**; a section counts only when **n_j ≥ 3**; **m < 2 → margin None, "too clustered to judge"**; **m = 0 → raw Σcount/scouted**; hourly check gate **50 min**; new notification category **`scouting`**.
- Test commands:
  - Pure (no site): `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q <path>`
  - DB (direct runner; tests roll back in `tearDown`): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); import importlib; M=importlib.import_module('upande_scp.serverscripts.tests.<module>'); r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M)); raise SystemExit(not r.wasSuccessful())"` — written below as **DB-RUN `<module>`**.
  - One-off DB runner (schema, patches): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe; frappe.init(site='kaitet.local'); frappe.connect(); <statements>; frappe.db.commit()"` — written below as **DB-EXEC `<statements>`**.
  - Frontend: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run <path>`; typecheck `npx tsc --noEmit -p tsconfig.app.json`; build `yarn build`.
- DB tests seed raw-SQL Scouting Entries in **2031-W20 (2031-05-12…18), 2031-W21 (05-19…25) and 2031-W22 (05-26…06-01)**. No real scouting exists then (kaitet.local holds 2026-07-18 → 2026-10-10). `evaluate` / `check_crop` take an explicit `today` so they never scan real weeks in a test. `save_thresholds` commits, so tests that call it patch `frappe.db.commit`. Tests that need recipients use committed `_test_scp_alert_*@example.com` users (the `test_notifications` pattern) and replace the farm rosters with raw, rolled-back rows.
- `dashboard_aggregates/__init__.py` rebinds `_overview`, `_gh_detail`, `_trends` to functions: load them with `importlib.import_module("upande_scp.serverscripts.dashboard_aggregates._<name>")`.

## Review Focus

The five failure modes most likely to slip past the tests, each with the test that pins it:

1. **Scheduler double-runs and concurrency creating duplicate alerts or duplicate notifications.** The alert's name *is* its key (`alert_name(warehouse, kind, observation, stage, iso_week)`), so a second insert fails instead of duplicating; the loser re-reads and does not notify. The hourly job takes a Redis `SET NX EX 3000` gate. → Task 5 `test_rerunning_the_check_writes_one_alert_and_notifies_once`, `test_a_concurrent_insert_of_the_same_key_is_absorbed_silently`, `test_the_hourly_gate_lets_one_run_through`.
2. **Escalation vs repeat notifications across weeks.** A new week's alert at the same action as last week's live alert is carried silently. Only a higher action notifies, and so does a recurrence after a clean week. → Task 5 `test_escalation_within_a_week_notifies_again_and_a_repeat_does_not`, `test_next_week_at_the_same_action_is_silent_and_supersedes_the_old_alert`, `test_a_recurrence_after_a_clean_week_notifies`.
3. **Empty farm rosters and crop-blind GMs.** Alarming on a farm with no creators or supervisors falls back to the farm's crop-scoped GMs. With nobody left, the alert is still written with `notified` empty. A Rose-only GM never hears about Lokitela. → Task 5 `test_an_empty_roster_falls_back_to_the_farms_gms_for_alarming`, `test_nobody_to_tell_still_writes_the_alert`, `test_gms_are_crop_scoped`.
4. **HR / ERPNext Notification Log rows leaking into the SCP bell, and mixed Count/Checkbox pests.** The bell, the unread count and mark-all-read only touch rows whose `scp_category` is an SCP category. A Count row judges a Checkbox stage (Thrips "Damages") as a share, and its all-stage count sums only the counted stages. → Task 4 `test_the_bell_ignores_non_scp_rows`. Task 3 `test_a_tick_box_stage_under_a_count_row_is_judged_as_a_share`, `test_the_row_count_sums_only_counted_stages`. Task 1 `test_effective_measure`.
5. **The misordered Rose Thrips row (1 / 0.4 / 2) and the 17:00 digest's timezone.** The migration leaves the bands as they are, `get_thresholds` flags the row `invalid`, and nothing classifies or alerts on misordered bands. The digest gates on `Africa/Nairobi` (kaitet.local's System Settings time zone is Asia/Kolkata and the server clock is UTC). → Task 2 `test_the_misordered_rose_thrips_row_is_left_as_it_is_and_flagged`. Task 3 `test_misordered_bands_classify_nothing`. Task 6 `test_the_digest_follows_nairobi_time_not_the_site_or_server_clock`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `upande_scp/serverscripts/common/threshold_bands.py` (new) | Pure: measures, actions, `bands_ascending`, `band_of`, `action_for`, `escalates`, `effective_measure`, `count_allowed`, `unit_label`, `format_value` |
| `upande_scp/serverscripts/common/prevalence.py` (mod) | `count_figures` (D2) |
| `upande_scp/upande_scp/doctype/pest_filter/pest_filter.json`, `disease_filter/disease_filter.json` (mod) | `measure` Select |
| `upande_scp/patches/v1_0/set_threshold_measure.py` (new) + `upande_scp/patches.txt` (mod) | Old unit → measure |
| `upande_scp/serverscripts/store/thresholds_api.py` (mod) | Payload with measure / count_allowed / reading_type / invalid / station; save validation |
| `upande_scp/serverscripts/dashboard_aggregates/_common.py` (mod) | `station_word`, `clear_threshold_cache`, measure-aware `load_thresholds`, `band_spec`, `house_value`; `severity_for` judges the row's measure |
| `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (mod) | Per-station counts; `observations`, `station_counts`, `count_figures`, `count_latest` |
| `upande_scp/serverscripts/dashboard_aggregates/_overview.py`, `_gh_detail.py`, `_pests_diseases.py` (mod) | Severity fed `house_value` |
| `upande_scp/serverscripts/common/notifications.py` (mod) | `scouting` + `plan` categories; bell = SCP rows only |
| `upande_scp/serverscripts/common/custom_fields.py` (mod) | `scp_category` options |
| `upande_scp/serverscripts/spray_plan_creator/maintenance.py` (mod) | Auto-cancel notice through `notify(category="plan")` |
| `upande_scp/upande_scp/doctype/scouting_alert/` (new) | Scouting Alert doctype; name = key |
| `upande_scp/serverscripts/scouting/thresholds_check.py` (new) | `evaluate`, `upsert`, `check_crop`, `run_threshold_check`, recipients, `acknowledge_alert`, `open_alerts`, `creator_alerts`, `convert_to_plan`, `figures_for_houses`, `house_figures` |
| `upande_scp/serverscripts/scouting/alert_digest.py` (new) | 17:00 EAT digest |
| `upande_scp/hooks.py` (mod) | Two hourly jobs |
| `upande_scp/serverscripts/reports/block_weekly_report.py` (mod) | Shading from the house figure; Count / ha column |
| `upande_scp/serverscripts/spray_plan_creator/bootstrap.py`, `drafts.py` (mod) | `alerts` per house; `alert` on save converts it |
| `upande_scp/serverscripts/tests/test_threshold_core_pure.py`, `test_threshold_counts_pure.py` (new) | Pure tests |
| `upande_scp/serverscripts/tests/thresholds_fixture.py` (new) | W20–W22 seeding, band setters, roster replacement, test users |
| `upande_scp/serverscripts/tests/test_thresholds_measure.py`, `test_threshold_measure_dashboards.py`, `test_scouting_alerts.py`, `test_alert_digest.py`, `test_scouting_alert_creator.py` (new) | DB tests |
| `upande_scp/serverscripts/tests/test_notifications.py`, `test_block_weekly_report.py` (mod) | Bell scope; report shading |
| `frontend/src/lib/threshold-measure.ts` (+ test, new) | Measure/unit helpers, band ordering, Trends map |
| `frontend/src/lib/thresholds-api.ts`, `components/settings/ThresholdsTab.tsx` (+ test) (mod) | Measure select, suffixes, misorder error |
| `frontend/src/pages/Trends.tsx`, `pages/trends/ChartPanel.tsx` (mod) | Bands carry measure + unit |
| `frontend/src/lib/notifications-api.ts` (+ test), `pages/Notifications.tsx` (mod) | New categories |
| `frontend/src/lib/pest-bands.ts` (+ test), `lib/threshold-figures-api.ts` (new), `pages/avocado/AvocadoHeatMap.tsx` (mod) | Jobsheet reads the server figure |
| `frontend/src/lib/scouting-alerts-api.ts` (+ test, new), `pages/dashboard/OverviewTab.tsx`, `pages/Dashboard.tsx` (mod), `pages/dashboard/__tests__/OverviewAlerts.test.tsx` (new), `__tests__/PrevalenceFigure.test.tsx` (mod) | Active alerts + Acknowledge |
| `frontend/src/components/spray-plan/CurativeAlerts.tsx` (+ test, new), `lib/spray-plan-creator-api.ts`, `pages/ApplicationPlan.tsx` (mod), `pages/__tests__/ApplicationPlan.alerts.test.ts` (new) | Badges + Create curative plan |

---

### Task 1: The pure rules and the count figure

**Files:**
- Create: `upande_scp/serverscripts/common/threshold_bands.py`
- Modify: `upande_scp/serverscripts/common/prevalence.py` (append `count_figures`)
- Test: `upande_scp/serverscripts/tests/test_threshold_core_pure.py`

**Interfaces:**
- Consumes: `prevalence.GRID`, `SECTIONS`, `MIN_SECTION_N`, `Z95`, `CLUSTERED`, `NO_STATIONS`, `section_counts`, `reliability`, `_pct`.
- Produces:
  - `threshold_bands.PERCENTAGE = "Percentage"`, `COUNT = "Count"`, `MEASURES`, `ALARMING`, `SPRAY_ADVISED`, `SCOUT_FIRST`, `ACTION_RANK`, `BAND_LABEL`
  - `bands_ascending(low, moderate, high) -> bool`, `is_configured(low, moderate, high) -> bool`, `band_of(value, low, moderate, high) -> "high"|"moderate"|"low"|""|None`, `action_for(band, reliability) -> str|None`, `escalates(previous, new) -> bool`, `effective_measure(row_measure, reading_type=None) -> str`, `count_allowed(kind, reading_types) -> bool`, `unit_label(measure, station="zone") -> str`, `format_value(value, unit) -> str`
  - `prevalence.count_figures(grid, scouted, counts, scouted_counts=None) -> dict | None` (keys of `figures()` plus `value`; `prevalence` is None; sections carry `total` / `avg`)

- [ ] **Step 1: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_threshold_core_pure.py`:

```python
"""Thresholds piece 3a — the pure rules and the count figure. Plain pytest, no site."""

import unittest

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import threshold_bands as B


def grid_of(beds: int, zones: int) -> dict:
    return P.grid_positions(
        {"name": f"B{b}-Z{z}", "group": f"B{b}", "group_no": b, "no": z}
        for b in range(1, beds + 1)
        for z in range(1, zones + 1)
    )


def by_section(grid: dict) -> dict:
    out: dict = {}
    for name, pos in grid.items():
        out.setdefault(pos, []).append(name)
    return {k: sorted(v) for k, v in out.items()}


class TestBands(unittest.TestCase):
    def test_bands_must_rise_strictly_over_the_ones_that_are_set(self):
        self.assertTrue(B.bands_ascending(1, 2, 3))
        self.assertTrue(B.bands_ascending(0, 1, 2))          # Low unset
        self.assertTrue(B.bands_ascending(1, 0, 2))          # Moderate unset
        self.assertTrue(B.bands_ascending(0, 0, 0))          # unconfigured is allowed
        self.assertFalse(B.bands_ascending(1, 0.4, 2))       # Rose Thrips on kaitet.local
        self.assertFalse(B.bands_ascending(5, 5, 10))        # strictly
        self.assertFalse(B.bands_ascending(-1, 2, 3))

    def test_band_of_is_inclusive_and_refuses_unset_or_misordered_bands(self):
        self.assertEqual(B.band_of(2, 0, 1, 2), "high")
        self.assertEqual(B.band_of(1, 0, 1, 2), "moderate")
        self.assertEqual(B.band_of(0.5, 0, 1, 2), "")        # judged, below every band
        self.assertEqual(B.band_of(0.5, 0.5, 1, 2), "low")
        self.assertIsNone(B.band_of(5, 0, 0, 0))
        self.assertIsNone(B.band_of(5, 1, 0.4, 2))
        self.assertIsNone(B.band_of(None, 0, 1, 2))

    def test_action_mapping(self):
        self.assertEqual(B.action_for("moderate", "Low"), "Alarming")
        self.assertEqual(B.action_for("moderate", "Good"), "Alarming")
        self.assertEqual(B.action_for("high", "Good"), "Spray advised")
        self.assertEqual(B.action_for("high", "Fair"), "Spray advised")
        self.assertEqual(B.action_for("high", "Low"), "Scout first")
        self.assertEqual(B.action_for("high", None), "Scout first")
        for band in ("low", "", None):
            self.assertIsNone(B.action_for(band, "Good"))

    def test_escalation(self):
        self.assertTrue(B.escalates(None, "Alarming"))
        self.assertFalse(B.escalates("Alarming", "Alarming"))
        self.assertTrue(B.escalates("Alarming", "Scout first"))
        self.assertTrue(B.escalates("Alarming", "Spray advised"))
        self.assertTrue(B.escalates("Scout first", "Spray advised"))
        self.assertFalse(B.escalates("Spray advised", "Scout first"))
        self.assertFalse(B.escalates("Alarming", None))

    def test_effective_measure(self):
        # A Count row judges its own (all-stage) figure and its counted stages as
        # counts; a tick-box stage under it is a share — a tick is not a count.
        self.assertEqual(B.effective_measure("Count"), "Count")
        self.assertEqual(B.effective_measure("Count", "Count"), "Count")
        self.assertEqual(B.effective_measure("Count", "Checkbox"), "Percentage")
        self.assertEqual(B.effective_measure("Count", "Range"), "Percentage")
        self.assertEqual(B.effective_measure("Percentage", "Count"), "Percentage")
        self.assertEqual(B.effective_measure(None), "Percentage")

    def test_count_is_allowed_only_for_a_pest_with_a_counted_stage(self):
        self.assertTrue(B.count_allowed("pest", ["Count", "Checkbox"]))
        self.assertFalse(B.count_allowed("pest", ["Checkbox"]))
        self.assertFalse(B.count_allowed("pest", []))
        self.assertFalse(B.count_allowed("disease", ["Count"]))

    def test_unit_labels(self):
        self.assertEqual(B.unit_label("Percentage", "tree"), "%")
        self.assertEqual(B.unit_label("Count", "tree"), "per tree")
        self.assertEqual(B.unit_label("Count"), "per zone")
        self.assertEqual(B.format_value(33.3, "%"), "33.3%")
        self.assertEqual(B.format_value(1.2, "per zone"), "1.2 per zone")
        self.assertEqual(B.format_value(None, "%"), "—")


class TestCountFigures(unittest.TestCase):
    def test_even_sections_average_the_section_averages_with_a_hand_worked_margin(self):
        grid = grid_of(9, 3)                       # 27 stations, 3 per section
        sections = by_section(grid)
        per = [1, 1, 1, 2, 2, 2, 3, 3, 3]          # a_j, row-major
        counts = {}
        for j, pos in enumerate(sorted(sections)):
            for st in sections[pos]:
                counts[st] = per[j]
        fig = P.count_figures(grid, set(grid), counts)
        # mean(a_j) = 2.0; s² = 6/8 = 0.75; v = max(2, 1) = 2; N = 27
        # margin = 1.96·sqrt(0.75/9 + 2/27) = 1.96·0.39675 = 0.7776 → 0.8
        self.assertEqual((fig["value"], fig["margin"], fig["sections_scouted"]), (2.0, 0.8, 9))
        self.assertIsNone(fig["prevalence"])
        self.assertIsNone(fig["reason"])
        self.assertEqual(fig["reliability"], "Fair")   # 0.78 / 2 = 0.39 > 0.10
        self.assertEqual([s["avg"] for s in fig["sections"]], [1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 3.0, 3.0, 3.0])

    def test_an_all_zero_sample_never_reads_plus_minus_zero(self):
        grid = grid_of(9, 3)
        fig = P.count_figures(grid, set(grid), {})
        # Poisson floor: v = max(0, 1) = 1 → 1.96·sqrt(1/27) = 0.377 → 0.4
        self.assertEqual((fig["value"], fig["margin"]), (0.0, 0.4))

    def test_one_counted_section_is_too_clustered_to_judge(self):
        grid = grid_of(9, 3)
        sections = by_section(grid)
        scouted = set(sections[(0, 0)]) | {sections[(1, 1)][0], sections[(2, 2)][0]}
        fig = P.count_figures(grid, scouted, {sections[(0, 0)][0]: 6})
        self.assertEqual((fig["value"], fig["sections_scouted"]), (2.0, 1))
        self.assertIsNone(fig["margin"])
        self.assertEqual((fig["reason"], fig["reliability"]), ("too clustered to judge", "Low"))

    def test_no_counted_section_falls_back_to_the_raw_average(self):
        grid = grid_of(9, 3)
        sections = by_section(grid)
        a, b = sections[(0, 0)][0], sections[(2, 2)][0]
        fig = P.count_figures(grid, {a, b}, {a: 4, b: 2})
        self.assertEqual((fig["value"], fig["raw"], fig["sections_scouted"]), (3.0, 3.0, 0))
        self.assertIsNone(fig["margin"])
        self.assertEqual(fig["reliability"], "Low")

    def test_good_needs_a_tight_margin_relative_to_the_figure(self):
        grid = grid_of(9, 9)                       # 81 stations, 9 per section
        fig = P.count_figures(grid, set(grid), {st: 10 for st in grid})
        # 1.96·sqrt(0 + 10/81) = 0.689 → 0.7; 0.689 / 10 = 0.069 ≤ 0.10, m = 9 ≥ 7
        self.assertEqual((fig["value"], fig["margin"], fig["reliability"]), (10.0, 0.7, "Good"))

    def test_counts_outside_the_scouted_set_are_ignored_and_nothing_scouted_is_none(self):
        grid = grid_of(9, 3)
        self.assertIsNone(P.count_figures(grid, set(), {"B1-Z1": 5}))
        fig = P.count_figures(grid, set(grid), {"not-a-station": 99})
        self.assertEqual(fig["value"], 0.0)

    def test_a_house_with_no_stations_has_no_value(self):
        fig = P.count_figures({}, {"a"}, {"a": 4})
        self.assertIsNone(fig["value"])
        self.assertEqual((fig["reason"], fig["raw"]), ("no stations set up", 4.0))
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_threshold_core_pure.py`
Expected: FAIL at collection with `ImportError: cannot import name 'threshold_bands'`.

- [ ] **Step 3: Write `threshold_bands.py`**

Create `upande_scp/serverscripts/common/threshold_bands.py`:

```python
"""Threshold bands, measures and actions — the pure rules.

Spec: docs/superpowers/specs/2026-10-10-thresholds-and-actions-design.md
(D1 measure, D3 bands → action, D5 escalation). No frappe import: runs under
plain pytest.

* A Pest/Disease Filter row is measured as a **Percentage** (piece 2's adjusted
  prevalence, 0–100) or a **Count** (average count per scouted station). Count
  needs a pest stage that scouts record as a number.
* Bands are Low < Moderate < High, strictly ascending over the bands that are
  set. All three at zero = unconfigured. Misordered bands judge nothing.
* Moderate → Alarming; High → Spray advised, or Scout first when the figure's
  reliability is Low; Low → no action.
* A new notification only when the action escalates:
  Alarming < Scout first < Spray advised.
"""

PERCENTAGE = "Percentage"
COUNT = "Count"
MEASURES = (PERCENTAGE, COUNT)

ALARMING = "Alarming"
SPRAY_ADVISED = "Spray advised"
SCOUT_FIRST = "Scout first"
ACTIONS = (ALARMING, SPRAY_ADVISED, SCOUT_FIRST)
#: Escalation order (D5).
ACTION_RANK = {ALARMING: 1, SCOUT_FIRST: 2, SPRAY_ADVISED: 3}

#: Scouting Alert.band for the two bands that raise an alert.
BAND_LABEL = {"moderate": "Moderate", "high": "High"}


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def is_configured(low, moderate, high) -> bool:
    return any(_num(v) > 0 for v in (low, moderate, high))


def bands_ascending(low, moderate, high) -> bool:
    """True when the bands that are set rise strictly (D3). All-zero is
    unconfigured and allowed; a negative band never is."""
    values = [_num(low), _num(moderate), _num(high)]
    if any(v < 0 for v in values):
        return False
    set_ = [v for v in values if v > 0]
    return all(a < b for a, b in zip(set_, set_[1:]))


def band_of(value, low, moderate, high):
    """``"high" | "moderate" | "low"`` for a figure, ``""`` when judged and below
    every band, ``None`` when there is no figure or the bands are unset or
    misordered. Inclusive: a value exactly on a threshold is in that band."""
    if value is None or not is_configured(low, moderate, high):
        return None
    if not bands_ascending(low, moderate, high):
        return None
    v = float(value)
    for key, limit in (("high", high), ("moderate", moderate), ("low", low)):
        if _num(limit) > 0 and v >= _num(limit):
            return key
    return ""


def action_for(band, reliability):
    """D3: Moderate → Alarming; High → Spray advised, or Scout first when the
    figure's reliability is Low (or unknown); anything else → None."""
    if band == "moderate":
        return ALARMING
    if band == "high":
        return SCOUT_FIRST if (reliability or "Low") == "Low" else SPRAY_ADVISED
    return None


def escalates(previous, new) -> bool:
    """D5: notify only when ``new`` outranks what was already notified."""
    if new not in ACTION_RANK:
        return False
    return ACTION_RANK[new] > ACTION_RANK.get(previous or "", 0)


def effective_measure(row_measure, reading_type=None) -> str:
    """The measure a figure is judged in. ``reading_type`` None means the row's
    own all-stage figure. Under a Count row, a Checkbox or Range stage is judged
    as a Percentage: scouts record a tick there, not a number."""
    if row_measure != COUNT:
        return PERCENTAGE
    if reading_type is None:
        return COUNT
    return COUNT if reading_type == COUNT else PERCENTAGE


def count_allowed(kind, reading_types) -> bool:
    """D1: Count only for a pest with at least one stage recorded as a number."""
    return kind == "pest" and any(rt == COUNT for rt in (reading_types or ()))


def unit_label(measure, station="zone") -> str:
    """``%`` for a Percentage; ``per zone`` / ``per tree`` for a Count."""
    return "%" if measure != COUNT else f"per {station or 'zone'}"


def format_value(value, unit) -> str:
    """``33.3%`` / ``1.2 per zone`` / ``—``."""
    if value is None:
        return "—"
    return f"{value}%" if unit == "%" else f"{value} {unit}"
```

- [ ] **Step 4: Append `count_figures` to `prevalence.py`**

In `upande_scp/serverscripts/common/prevalence.py`, insert this function directly after `figures(...)` (before `def combine(figs):`):

```python
def count_figures(grid: dict, scouted, counts, scouted_counts=None):
    """Average count per scouted station for one house, ISO week and observation
    (thresholds spec §2, D2).

    ``counts`` is ``{station: total count}``; a scouted station absent from it
    counted 0. Per section j with n_j ≥ MIN_SECTION_N scouted: a_j = Σcount_j / n_j.
    ``value`` is the mean of the a_j over those m sections. The margin is
    1.96 · sqrt(s²/m + v/N), with s² the sample variance of the a_j, N = Σ n_j over
    them and v = max(value, 1) — a Poisson floor, so an all-zero sample never
    reads ±0. m < 2 → margin None ("too clustered to judge"); m = 0 → the raw
    Σcount / scouted. Reliability is ``reliability(m, margin / max(value, 1))``:
    the percentage rule applied to the margin relative to the figure.

    Same shape as ``figures`` plus ``value`` (1 dp); ``prevalence`` is None.
    """
    scouted = set(scouted or ())
    if not scouted:
        return None
    per = {s: float(c or 0) for s, c in (counts or {}).items() if s in scouted}
    raw = sum(per.values()) / len(scouted)
    infested = sum(1 for c in per.values() if c > 0)
    if not grid:
        return {
            "stations": 0, "scouted": len(scouted), "infested": infested,
            "coverage": None, "raw": round(raw, 1), "value": None, "prevalence": None,
            "margin": None, "sections_scouted": 0, "sections_total": SECTIONS,
            "reliability": "Low", "reason": NO_STATIONS, "sections": [],
        }
    n_by = scouted_counts if scouted_counts is not None else section_counts(grid, scouted)
    sums = [0.0] * SECTIONS
    for station, c in per.items():
        pos = grid.get(station)
        if pos is not None:
            sums[pos[0] * GRID + pos[1]] += c
    avgs, sections, n_total = [], [], 0
    for j in range(SECTIONS):
        n = n_by[j]
        avg = None
        if n >= MIN_SECTION_N:
            avg = sums[j] / n
            avgs.append(avg)
            n_total += n
        sections.append({
            "row": j // GRID, "col": j % GRID, "scouted": n,
            "total": round(sums[j], 1), "avg": None if avg is None else round(avg, 1),
        })
    m = len(avgs)
    value = sum(avgs) / m if m else raw
    margin = None
    if m >= 2:
        s2 = sum((a - value) ** 2 for a in avgs) / (m - 1)
        margin = Z95 * math.sqrt(s2 / m + max(value, 1.0) / n_total)
    return {
        "stations": len(grid),
        "scouted": len(scouted),
        "infested": infested,
        "coverage": _pct(sum(n_by) / len(grid)),
        "raw": round(raw, 1),
        "value": round(value, 1),
        "prevalence": None,
        "margin": None if margin is None else round(margin, 1),
        "sections_scouted": m,
        "sections_total": SECTIONS,
        "reliability": reliability(m, None if margin is None else margin / max(value, 1.0)),
        "reason": CLUSTERED if m < 2 else None,
        "sections": sections,
    }
```

- [ ] **Step 5: Run to pass (and keep piece 2's pure tests green)**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_threshold_core_pure.py upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_trends_prevalence_pure.py`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/common/threshold_bands.py upande_scp/serverscripts/common/prevalence.py upande_scp/serverscripts/tests/test_threshold_core_pure.py
git commit -m "feat(scp): pure threshold rules and the count-per-station figure"
```

---
### Task 2: `measure` on the filters, its migration, and the editor API

**Files:**
- Modify: `upande_scp/upande_scp/doctype/pest_filter/pest_filter.json`, `upande_scp/upande_scp/doctype/disease_filter/disease_filter.json`
- Create: `upande_scp/patches/v1_0/set_threshold_measure.py`; Modify: `upande_scp/patches.txt`
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py` (add `station_word`, `clear_threshold_cache`)
- Modify (full rewrite below): `upande_scp/serverscripts/store/thresholds_api.py`
- Test: `upande_scp/serverscripts/tests/test_thresholds_measure.py`

**Interfaces:**
- Consumes: Task 1 `threshold_bands` (`MEASURES`, `PERCENTAGE`, `COUNT`, `bands_ascending`, `count_allowed`); `crop_catalog.resolve_crop`, `crop_catalog.greenhouses_for_crop`.
- Produces:
  - Columns `tabPest Filter.measure`, `tabDisease Filter.measure` (Select `Percentage`/`Count`, default `Percentage`)
  - `set_threshold_measure.wanted_measure(doctype, unit, reading_types) -> str`, `execute()`
  - `_common.station_word(crop) -> "tree" | "zone"`, `_common.clear_threshold_cache() -> None`
  - `thresholds_api.get_thresholds(crop) -> {"crop", "station", "pests": [{"row", "pest", "measure", "count_allowed", "low", "moderate", "high", "invalid", "stages": [{"row", "stage", "reading_type", "low", "moderate", "high", "invalid"}]}], "diseases": [... "disease" ...]}` — no `unit` key any more
  - `thresholds_api.save_thresholds(crop, payload)` — writes `measure` + bands, never `unit`; raises `frappe.ValidationError` before any write on a bad row

- [ ] **Step 1: Add `measure` to both doctype JSONs**

In `upande_scp/upande_scp/doctype/pest_filter/pest_filter.json`:
1. In `field_order`, replace `"unit",` with `"unit",` followed by a new line `"measure",` (so the order reads `"unit", "measure", "low_threshold", …`).
2. In `fields`, directly after the `unit` object (the one ending `"options": "Per Zone %\nPer Warehouse\nPer Hectare"` + `},`), insert:

```json
  {
   "default": "Percentage",
   "description": "How the bands are read. Percentage: adjusted share of scouted stations carrying it (0–100). Count: average count per scouted station — only for a pest with a stage scouts record as a number.",
   "fieldname": "measure",
   "fieldtype": "Select",
   "in_list_view": 1,
   "label": "Measure",
   "options": "Percentage\nCount"
  },
```
3. Replace `"modified": "2026-05-30 00:00:00.000000",` with `"modified": "2026-10-10 12:00:00.000000",`.

Make the same three edits in `upande_scp/upande_scp/doctype/disease_filter/disease_filter.json`, with this description: `"How the bands are read. A disease is always a Percentage: adjusted share of scouted stations carrying it (0–100)."` (the options stay `Percentage\nCount` so Per hectare can join later; the API refuses Count for diseases).

- [ ] **Step 2: Apply the schema without migrate**

Run: **DB-EXEC** `frappe.reload_doc('upande_scp', 'doctype', 'pest_filter', force=True); frappe.reload_doc('upande_scp', 'doctype', 'disease_filter', force=True); print(frappe.db.has_column('Pest Filter', 'measure'), frappe.db.has_column('Disease Filter', 'measure'))`
Expected: `True True`. Every existing row now reads `Percentage` (the column default).

- [ ] **Step 3: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_thresholds_measure.py`:

```python
"""Thresholds piece 3a: the measure field, its migration and the editor API.
DB test — direct runner. Everything is rolled back in tearDown; save_thresholds
commits, so its calls run with frappe.db.commit patched out."""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.patches.v1_0 import set_threshold_measure as PATCH
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.store import thresholds_api as API


def _row(doctype, crop, field, obs):
    return frappe.db.get_value(doctype, {"crop_scouted": crop, field: obs}, "name")


def _measure(doctype, crop, field, obs):
    return frappe.db.get_value(doctype, _row(doctype, crop, field, obs), "measure")


class TestMeasureMigration(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")

    def tearDown(self):
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        frappe.db.rollback()

    def test_the_patch_maps_old_units_to_measures(self):
        PATCH.execute()
        self.assertEqual(_measure("Pest Filter", "Rose", "pest", "Aphids"), "Count")             # Per Warehouse, both stages counted
        self.assertEqual(_measure("Pest Filter", "Avocado", "pest", "FCM"), "Count")
        self.assertEqual(_measure("Pest Filter", "Avocado", "pest", "Caterpillars"), "Count")    # Per Hectare
        self.assertEqual(_measure("Pest Filter", "Rose", "pest", "Spidermites"), "Percentage")   # "Web" is a tick-box stage
        self.assertEqual(_measure("Pest Filter", "Avocado", "pest", "Scale Insects"), "Percentage")
        self.assertEqual(_measure("Pest Filter", "Coffee", "pest", "Antestia Bug"), "Percentage")  # Per Zone %
        self.assertEqual(_measure("Pest Filter", "Rose", "pest", "Thrips"), "Percentage")
        self.assertEqual(set(frappe.get_all("Disease Filter", pluck="measure")), {"Percentage"})

    def test_the_misordered_rose_thrips_row_is_left_as_it_is_and_flagged(self):
        name = _row("Pest Filter", "Rose", "pest", "Thrips")
        frappe.db.set_value("Pest Filter", name, {"low_threshold": 1, "moderate_threshold": 0.4, "high_threshold": 2})
        PATCH.execute()
        bands = frappe.db.get_value("Pest Filter", name, ["low_threshold", "moderate_threshold", "high_threshold"])
        self.assertEqual([float(b) for b in bands], [1.0, 0.4, 2.0])
        thrips = next(p for p in API.get_thresholds("Rose")["pests"] if p["pest"] == "Thrips")
        self.assertTrue(thrips["invalid"])

    def test_wanted_measure_needs_every_stage_counted(self):
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Warehouse", ["Count", "Count"]), "Count")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Hectare", ["Count"]), "Count")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Hectare", ["Count", "Checkbox"]), "Percentage")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Zone %", ["Count"]), "Percentage")
        self.assertEqual(PATCH.wanted_measure("Pest Filter", "Per Warehouse", []), "Percentage")
        self.assertEqual(PATCH.wanted_measure("Disease Filter", "Per Warehouse", ["Count"]), "Percentage")


class TestEditorApi(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self.rose = API.get_thresholds("Rose")

    def tearDown(self):
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        frappe.db.rollback()

    def _pest(self, name):
        return next(p for p in self.rose["pests"] if p["pest"] == name)

    def test_the_payload_carries_measure_count_allowed_and_reading_types(self):
        thrips = self._pest("Thrips")
        self.assertIn(thrips["measure"], ("Percentage", "Count"))
        self.assertTrue(thrips["count_allowed"])
        self.assertEqual(
            {s["stage"]: s["reading_type"] for s in thrips["stages"]},
            {"Adult": "Count", "Larvae": "Count", "Damages": "Checkbox"},
        )
        self.assertNotIn("unit", thrips)
        self.assertFalse(self._pest("Scale Insects")["count_allowed"])
        self.assertTrue(all(not d["count_allowed"] for d in self.rose["diseases"]))

    def test_the_count_unit_follows_the_crops_stations(self):
        self.assertEqual(self.rose["station"], "zone")
        self.assertEqual(API.get_thresholds("Avocado")["station"], "tree")
        self.assertEqual(_common.station_word("Coffee"), "zone")

    def test_count_is_refused_for_a_tick_box_pest(self):
        scale = dict(self._pest("Scale Insects"), measure="Count")
        with self.assertRaises(frappe.ValidationError) as cm:
            API.save_thresholds("Rose", {"pests": [scale], "diseases": []})
        self.assertIn("Count needs a stage", str(cm.exception))

    def test_count_is_refused_for_a_disease(self):
        disease = dict(self.rose["diseases"][0], measure="Count")
        with self.assertRaises(frappe.ValidationError):
            API.save_thresholds("Rose", {"pests": [], "diseases": [disease]})

    def test_misordered_bands_are_refused_on_the_row_and_on_a_stage(self):
        thrips = self._pest("Thrips")
        bad_row = dict(thrips, measure="Percentage", low=1, moderate=0.4, high=2,
                       stages=[dict(s, low=0, moderate=0, high=0) for s in thrips["stages"]])
        with self.assertRaises(frappe.ValidationError) as cm:
            API.save_thresholds("Rose", {"pests": [bad_row], "diseases": []})
        self.assertIn("bands must rise", str(cm.exception))
        stages = [dict(s, low=5, moderate=5, high=10) if s["stage"] == "Adult" else dict(s, low=0, moderate=0, high=0)
                  for s in thrips["stages"]]
        bad_stage = dict(thrips, measure="Percentage", low=0, moderate=0, high=0, stages=stages)
        with self.assertRaises(frappe.ValidationError) as cm:
            API.save_thresholds("Rose", {"pests": [bad_stage], "diseases": []})
        self.assertIn("Thrips · Adult", str(cm.exception))

    def test_a_refused_save_writes_nothing(self):
        before = float(frappe.db.get_value("Pest Filter", self._pest("Aphids")["row"], "high_threshold") or 0)
        aphids = dict(self._pest("Aphids"), low=1, moderate=2, high=before + 3)
        scale = dict(self._pest("Scale Insects"), measure="Count")
        with self.assertRaises(frappe.ValidationError):
            API.save_thresholds("Rose", {"pests": [aphids, scale], "diseases": []})
        self.assertEqual(float(frappe.db.get_value("Pest Filter", aphids["row"], "high_threshold") or 0), before)

    def test_a_valid_save_stores_measure_and_bands_and_clears_the_flag(self):
        thrips = dict(self._pest("Thrips"), measure="Count", low=0, moderate=1, high=2,
                      stages=[dict(s, low=0, moderate=0, high=0) for s in self._pest("Thrips")["stages"]])
        with patch.object(frappe.db, "commit"):
            API.save_thresholds("Rose", {"pests": [thrips], "diseases": []})
        measure, mod, high = frappe.db.get_value("Pest Filter", thrips["row"], ["measure", "moderate_threshold", "high_threshold"])
        self.assertEqual((measure, float(mod), float(high)), ("Count", 1.0, 2.0))
        self.assertFalse(next(p for p in API.get_thresholds("Rose")["pests"] if p["pest"] == "Thrips")["invalid"])

    def test_all_zero_is_unconfigured_and_allowed(self):
        thrips = dict(self._pest("Thrips"), measure="Percentage", low=0, moderate=0, high=0,
                      stages=[dict(s, low=0, moderate=0, high=0) for s in self._pest("Thrips")["stages"]])
        with patch.object(frappe.db, "commit"):
            out = API.save_thresholds("Rose", {"pests": [thrips], "diseases": []})
        self.assertTrue(out["ok"])
```

- [ ] **Step 4: Run it to see it fail**

Run: **DB-RUN** `test_thresholds_measure`
Expected: FAIL at import — `ModuleNotFoundError: No module named 'upande_scp.patches.v1_0.set_threshold_measure'`.

- [ ] **Step 5: Write the patch and register it**

Create `upande_scp/patches/v1_0/set_threshold_measure.py` (tabs):

```python
"""Pest/Disease Filter.measure from the old unit (thresholds spec §1).

A Pest Filter becomes Count when every one of its stages is recorded as a number
(`reading_type = Count`) and its old unit was Per Warehouse or Per Hectare — the
two units that compared a raw count. Everything else, and every Disease Filter,
is Percentage. Bands are not touched: a row whose bands are misordered (Rose
Thrips 1 / 0.4 / 2 on kaitet.local) keeps them, and the editor flags it.

It recomputes from `unit` on every run, so it runs once from patches.txt; the
editor owns `measure` afterwards.
"""

import frappe

COUNT_UNITS = ("Per Warehouse", "Per Hectare")
KINDS = (("Pest Filter", "Pests Stages"), ("Disease Filter", "Disease Stages"))


def wanted_measure(doctype, unit, reading_types) -> str:
	if doctype != "Pest Filter":
		return "Percentage"
	if not reading_types or any(rt != "Count" for rt in reading_types):
		return "Percentage"
	return "Count" if (unit or "") in COUNT_UNITS else "Percentage"


def execute():
	for doctype, child in KINDS:
		if not frappe.db.has_column(doctype, "measure"):
			continue
		stages: dict = {}
		for parent, reading_type in frappe.db.sql(
			f"select parent, reading_type from `tab{child}` where parenttype = %s", (doctype,)
		):
			stages.setdefault(parent, []).append(reading_type or "")
		for name, unit in frappe.db.sql(f"select name, unit from `tab{doctype}`"):
			frappe.db.set_value(
				doctype, name, "measure", wanted_measure(doctype, unit, stages.get(name)),
				update_modified=False,
			)
	# Dashboard severity cached before this ran was computed without a measure.
	cache = frappe.cache()
	for key in cache.get_keys("scp:dash_agg:*"):
		cache.delete_value(key)
```

Append to the end of `upande_scp/patches.txt` (the `[post_model_sync]` section):

```
# Pest/Disease Filter.measure from the old unit (thresholds & actions, piece 3a).
upande_scp.patches.v1_0.set_threshold_measure
```

- [ ] **Step 6: Add `station_word` and `clear_threshold_cache` to `_common.py`**

In `upande_scp/serverscripts/dashboard_aggregates/_common.py`, directly after `def _threshold_cache() -> dict:` (its body ends `return cache`), insert:

```python
def clear_threshold_cache() -> None:
    """Drop the per-request threshold memo — after any band or measure write."""
    if hasattr(frappe.local, _THRESHOLD_CACHE_ATTR):
        delattr(frappe.local, _THRESHOLD_CACHE_ATTR)


def station_word(crop: str) -> str:
    """The station a Count is "per": ``"tree"`` for a crop scouted on Block
    warehouses (Orchard Trees — Lokitela's avocado), else ``"zone"``. Read from
    the crop's houses, so a new block crop needs no code change."""
    houses = crop_catalog.greenhouses_for_crop(crop) if crop else []
    if houses and frappe.db.count("Warehouse", {"name": ["in", houses], "warehouse_type": "Block"}):
        return "tree"
    return "zone"
```

(`crop_catalog` is already imported at `_common.py:13`.)

- [ ] **Step 7: Rewrite `store/thresholds_api.py`**

Replace the whole file with:

```python
"""Per-crop, per-stage threshold editor backend.

Powers the Settings → Thresholds tab. Returns and persists the ``measure`` and
the ``low / moderate / high`` bands on every Pest Filter / Disease Filter row of
one crop, and the bands on their Pests Stages / Disease Stages children.

Measures (thresholds spec D1): **Percentage** = piece 2's adjusted prevalence;
**Count** = average count per scouted station, offered only for a pest with a
stage scouts record as a number. Bands must rise strictly over the ones that are
set (D3); all-zero is "unconfigured". A row stored with misordered bands comes
back ``invalid: true`` so the editor flags it; a save that would store one is
refused whole, before any write. The old ``unit`` column stays in the schema but
is neither returned nor written.

Permissions: System Manager / Administrator / SCP General Manager write. Read is
whitelisted so the page can populate for read-only viewers.
"""

import json

import frappe

from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common


_WRITE_ROLES = {"System Manager", "Administrator", "SCP General Manager"}


def _check_write_perm():
    roles = set(frappe.get_roles(frappe.session.user) or [])
    if not (roles & _WRITE_ROLES):
        frappe.throw(
            "You need a Spray Plan settings role to edit thresholds.",
            frappe.PermissionError,
        )


@frappe.whitelist()
def list_crops() -> list:
    """Crops the GM can pick from in the threshold editor — anything
    that has at least one Pest Filter or Disease Filter row, so empty
    Crop Scouted docs don't show up as targets with nothing to edit."""
    rows = frappe.db.sql(
        """
        SELECT DISTINCT crop
        FROM (
            SELECT crop_scouted AS crop FROM `tabPest Filter` WHERE crop_scouted IS NOT NULL
            UNION
            SELECT crop_scouted AS crop FROM `tabDisease Filter` WHERE crop_scouted IS NOT NULL
        ) t
        WHERE crop != ''
        ORDER BY crop
        """,
        as_dict=True,
    )
    return [r["crop"] for r in rows if r.get("crop")]


def _f(value) -> float:
    return float(value or 0)


def _filter_rows(crop: str, doctype: str, child: str, obs_col: str, kind: str) -> list:
    measure_col = "measure" if frappe.db.has_column(doctype, "measure") else "'Percentage'"
    parents = frappe.db.sql(
        f"""
        SELECT name, `{obs_col}` AS obs, {measure_col} AS measure,
               low_threshold, moderate_threshold, high_threshold
        FROM `tab{doctype}`
        WHERE crop_scouted = %(crop)s
        ORDER BY idx
        """,
        {"crop": crop},
        as_dict=True,
    )
    stages = frappe.db.sql(
        f"""
        SELECT name, parent, stage, reading_type,
               low_threshold, moderate_threshold, high_threshold
        FROM `tab{child}`
        WHERE parenttype = %(pt)s AND parent IN %(parents)s
        ORDER BY parent, idx
        """,
        {"pt": doctype, "parents": [r["name"] for r in parents] or [""]},
        as_dict=True,
    )
    by_parent: dict = {}
    for s in stages:
        by_parent.setdefault(s["parent"], []).append(s)

    out = []
    for r in parents:
        stage_rows = [
            {
                "row": s["name"],
                "stage": s["stage"] or "",
                "reading_type": s["reading_type"] or "",
                "low": _f(s["low_threshold"]),
                "moderate": _f(s["moderate_threshold"]),
                "high": _f(s["high_threshold"]),
                "invalid": not B.bands_ascending(
                    s["low_threshold"], s["moderate_threshold"], s["high_threshold"],
                ),
            }
            for s in by_parent.get(r["name"], [])
        ]
        row_invalid = not B.bands_ascending(
            r["low_threshold"], r["moderate_threshold"], r["high_threshold"],
        )
        out.append({
            "row": r["name"],
            obs_col: r["obs"],
            "measure": r["measure"] if r["measure"] in B.MEASURES else B.PERCENTAGE,
            "count_allowed": B.count_allowed(kind, [s["reading_type"] for s in stage_rows]),
            "low": _f(r["low_threshold"]),
            "moderate": _f(r["moderate_threshold"]),
            "high": _f(r["high_threshold"]),
            "invalid": row_invalid or any(s["invalid"] for s in stage_rows),
            "stages": stage_rows,
        })
    return out


@frappe.whitelist()
def get_thresholds(crop: str) -> dict:
    """The editor payload for one crop.

    ``station`` is what a Count is "per" (``zone`` / ``tree``). Each row carries
    ``measure``, ``count_allowed`` (a stage with ``reading_type = Count``; never
    for a disease), its bands, ``invalid`` (misordered bands on the row or any
    stage) and ``stages`` with their ``reading_type``, bands and ``invalid``.
    Stage rows are the ones on the doc; the GM adds stages from the doctype.
    """
    crop = crop_catalog.resolve_crop(crop)
    if not crop:
        return {"crop": "", "station": "zone", "pests": [], "diseases": []}
    return {
        "crop": crop,
        "station": _common.station_word(crop),
        "pests": _filter_rows(crop, "Pest Filter", "Pests Stages", "pest", "pest"),
        "diseases": _filter_rows(crop, "Disease Filter", "Disease Stages", "disease", "disease"),
    }


_KINDS = (
    ("pests", "Pest Filter", "Pests Stages"),
    ("diseases", "Disease Filter", "Disease Stages"),
)


def _assert_rows_belong(crop: str, payload: dict) -> None:
    """Refuse the whole save if any row is not `crop`'s (spec §5).

    Checked before the first write: `save_thresholds` commits at the end, so a
    half-applied payload would be permanent.
    """
    for key, doctype, child in _KINDS:
        rows = [r for r in (payload.get(key) or []) if r.get("row")]
        if not rows:
            continue
        owners = dict(frappe.db.sql(
            f"select name, crop_scouted from `tab{doctype}` where name in %(n)s",
            {"n": [r["row"] for r in rows]},
        ))
        wrong = [r["row"] for r in rows if owners.get(r["row"]) != crop]
        if wrong:
            frappe.throw(f"{doctype} rows {', '.join(wrong)} are not {crop} rows.", frappe.ValidationError)
        for r in rows:
            stages = [s["row"] for s in (r.get("stages") or []) if s.get("row")]
            if not stages:
                continue
            parents = dict(frappe.db.sql(
                f"select name, parent from `tab{child}` where name in %(n)s and parenttype = %(pt)s",
                {"n": stages, "pt": doctype},
            ))
            stray = [s for s in stages if parents.get(s) != r["row"]]
            if stray:
                frappe.throw(f"{child} rows {', '.join(stray)} do not belong to {r['row']}.", frappe.ValidationError)


def _validate(payload: dict) -> None:
    """Refuse the whole save on any bad row, before the first write (D1, D3).

    Count is checked against the stages' reading types in the database, never
    against what the client claims. All problems are reported at once.
    """
    errors = []
    for key, doctype, child in _KINDS:
        kind = "pest" if key == "pests" else "disease"
        rows = [r for r in (payload.get(key) or []) if r.get("row")]
        if not rows:
            continue
        reading_types: dict = {}
        for parent, rt in frappe.db.sql(
            f"select parent, reading_type from `tab{child}` where parenttype = %(pt)s and parent in %(n)s",
            {"pt": doctype, "n": [r["row"] for r in rows]},
        ):
            reading_types.setdefault(parent, []).append(rt or "")
        for r in rows:
            label = r.get("pest") or r.get("disease") or r["row"]
            measure = r.get("measure") or B.PERCENTAGE
            if measure not in B.MEASURES:
                errors.append(f"{label}: unknown measure {measure}.")
            elif measure == B.COUNT and not B.count_allowed(kind, reading_types.get(r["row"])):
                errors.append(f"{label}: Count needs a stage scouts record as a number.")
            if not B.bands_ascending(r.get("low"), r.get("moderate"), r.get("high")):
                errors.append(f"{label}: bands must rise, Low < Moderate < High.")
            for s in r.get("stages") or []:
                if not B.bands_ascending(s.get("low"), s.get("moderate"), s.get("high")):
                    errors.append(
                        f"{label} · {s.get('stage') or s.get('row')}: bands must rise, Low < Moderate < High."
                    )
    if errors:
        frappe.throw("\n".join(errors), frappe.ValidationError)


@frappe.whitelist()
def save_thresholds(crop: str, payload: str | dict) -> dict:
    """Persist measure + band edits in bulk. ``payload`` is the shape
    ``get_thresholds`` returns (the editor sends back the whole crop).

    Updates existing rows by their ``row`` name only — rows and stages are added
    or removed from the doctype, never here. Validation runs before any write.
    """
    _check_write_perm()

    crop = crop_catalog.resolve_crop(crop)
    if not crop:
        frappe.throw("Missing crop", frappe.ValidationError)
    if isinstance(payload, str):
        payload = json.loads(payload)
    _assert_rows_belong(crop, payload)
    _validate(payload)

    updated = {"pests": 0, "pest_stages": 0, "diseases": 0, "disease_stages": 0}
    for key, doctype, child in _KINDS:
        stage_key = "pest_stages" if key == "pests" else "disease_stages"
        for r in payload.get(key) or []:
            if not r.get("row"):
                continue
            frappe.db.set_value(
                doctype, r["row"],
                {
                    "measure": r.get("measure") or B.PERCENTAGE,
                    "low_threshold": _f(r.get("low")),
                    "moderate_threshold": _f(r.get("moderate")),
                    "high_threshold": _f(r.get("high")),
                },
                update_modified=True,
            )
            updated[key] += 1
            for s in r.get("stages") or []:
                if not s.get("row"):
                    continue
                frappe.db.set_value(
                    child, s["row"],
                    {
                        "low_threshold": _f(s.get("low")),
                        "moderate_threshold": _f(s.get("moderate")),
                        "high_threshold": _f(s.get("high")),
                    },
                    update_modified=True,
                )
                updated[stage_key] += 1

    # The next aggregate call must see the new bands immediately.
    _common.clear_threshold_cache()
    cache = frappe.cache()
    for k in cache.get_keys("scp:dash_agg:*"):
        cache.delete_value(k)
    frappe.db.commit()
    return {"ok": True, "updated": updated}
```

- [ ] **Step 8: Run to pass**

Run: **DB-RUN** `test_thresholds_measure`
Expected: 11 tests OK.

- [ ] **Step 9: Run the migration for real and log it**

Run: **DB-EXEC** `from upande_scp.patches.v1_0 import set_threshold_measure as p; p.execute(); frappe.get_doc({'doctype': 'Patch Log', 'patch': 'upande_scp.patches.v1_0.set_threshold_measure'}).insert(ignore_permissions=True)`
Then verify: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SELECT crop_scouted, measure, COUNT(*) FROM \`tabPest Filter\` GROUP BY 1,2; SELECT measure, COUNT(*) FROM \`tabDisease Filter\` GROUP BY 1; SELECT low_threshold, moderate_threshold, high_threshold FROM \`tabPest Filter\` WHERE crop_scouted='Rose' AND pest='Thrips';"`
Expected: Avocado Count 10 / Percentage 2, Coffee Percentage 16, Rose Count 2 / Percentage 10; diseases all Percentage; Rose Thrips still `1 / 0.4 / 2`.

- [ ] **Step 10: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/upande_scp/doctype/pest_filter/pest_filter.json upande_scp/upande_scp/doctype/disease_filter/disease_filter.json upande_scp/patches/v1_0/set_threshold_measure.py upande_scp/patches.txt upande_scp/serverscripts/dashboard_aggregates/_common.py upande_scp/serverscripts/store/thresholds_api.py upande_scp/serverscripts/tests/test_thresholds_measure.py
git commit -m "feat(scp): thresholds carry a measure (percentage or count) with ascending-band validation"
```

---
### Task 3: Count figures through `StationWeeks` and measure-aware severity on the dashboards

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py`
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py` (`load_thresholds`, `_load_kind`, `severity_for`; add `band_spec`, `house_value`)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_overview.py:209,252-253`, `_gh_detail.py:7-13,125`, `_pests_diseases.py:15-22,148`
- Create: `upande_scp/serverscripts/tests/thresholds_fixture.py`
- Test: `upande_scp/serverscripts/tests/test_threshold_counts_pure.py`, `upande_scp/serverscripts/tests/test_threshold_measure_dashboards.py`

**Interfaces:**
- Consumes: Task 1 `prevalence.count_figures`, `threshold_bands.*`; Task 2 `measure` column, `_common.clear_threshold_cache`.
- Produces:
  - `StationWeeks.observations(wh, week, kind) -> list[str]`
  - `StationWeeks.station_counts(wh, week, kind, obs=ANY, stages=ANY, section=ANY) -> dict[str, float]` (`stages` is a `frozenset` or `ANY`)
  - `StationWeeks.count_figures(wh, week, kind, obs=ANY, stages=ANY, section=ANY) -> dict | None` (+ `week`)
  - `StationWeeks.count_latest(wh, kind, obs=ANY, stages=ANY, section=ANY) -> dict | None` (+ `prev` = previous scouted week's `value`)
  - `_common.load_thresholds(crop) -> {(kind, obs, stage): {"low", "mod", "high", "measure", "row_measure", "count_stages", "reading_types"}}` — unset and misordered bands omitted
  - `_common.band_spec(crop, kind, obs_name, stage="") -> dict | None`
  - `_common.house_value(crop, kind, obs_name, stage, weeks, wh, fig) -> float | None`
  - `_common.severity_for(crop, kind, obs_name, stage, value) -> "high" | "moderate" | "low" | None` (same 5-argument signature; `value` is now in the row's measure)
  - `thresholds_fixture`: `WEEK_20`, `WEEK_21`, `WEEK_22`, `seed_week(...)`, `set_bands(...)`, `clear_all_bands(crop)`, `set_roster(farm, roster, users)`, `ROSTERS`, `ensure_user(email)`

- [ ] **Step 1: Write the failing pure tests**

Create `upande_scp/serverscripts/tests/test_threshold_counts_pure.py`:

```python
"""StationWeeks per-station counts over hand-built rows — plain pytest, no site."""

import unittest
from importlib import import_module

R = import_module("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows")

# 27 stations, 3 in each of the 9 sections (same shape as test_prevalence_rows_pure).
GRID = {f"Z{r}{c}{k}": (r, c) for r in range(3) for c in range(3) for k in range(3)}
FIRSTS = sorted(n for n in GRID if n.endswith("0"))   # first station of each section


def scouted(wh, yw, stations, in_win=1):
    return [{"wh": wh, "station": s, "yw": yw, "in_win": in_win} for s in stations]


def counted(wh, yw, stations, count, stage="Adult", obs="Thrips", kind="pest", section="Leaf"):
    return [{"wh": wh, "station": s, "yw": yw, "kind": kind, "obs": obs, "stage": stage,
             "section": section, "count": count} for s in stations]


def weeks(scouted_rows, infested_rows):
    return R.StationWeeks(scouted_rows, infested_rows, grid_loader=lambda wh: dict(GRID))


class TestStationCounts(unittest.TestCase):
    def test_counts_sum_only_the_named_stages(self):
        w = weeks(scouted("GH A", 203110, GRID),
                  counted("GH A", 203110, ["Z000"], 3, stage="Adult")
                  + counted("GH A", 203110, ["Z000"], 1, stage="Damages")
                  + counted("GH A", 203110, ["Z010"], 2, stage="Larvae"))
        self.assertEqual(
            w.station_counts("GH A", "2031-W10", "pest", "Thrips", frozenset({"Adult", "Larvae"})),
            {"Z000": 3.0, "Z010": 2.0},
        )
        self.assertEqual(w.station_counts("GH A", "2031-W10", "pest", "Thrips"),
                         {"Z000": 4.0, "Z010": 2.0})

    def test_count_latest_reads_the_latest_week_with_the_previous_value(self):
        w = weeks(scouted("GH A", 203109, GRID, in_win=0) + scouted("GH A", 203110, GRID),
                  counted("GH A", 203109, FIRSTS, 6) + counted("GH A", 203110, FIRSTS, 3))
        fig = w.count_latest("GH A", "pest", "Thrips", frozenset({"Adult"}))
        self.assertEqual((fig["week"], fig["value"], fig["prev"]), ("2031-W10", 1.0, 2.0))
        self.assertEqual(fig["sections_scouted"], 9)

    def test_a_house_scouted_clean_counts_zero_with_the_poisson_floor(self):
        w = weeks(scouted("GH A", 203110, GRID), [])
        fig = w.count_latest("GH A", "pest", "Thrips")
        self.assertEqual((fig["value"], fig["margin"]), (0.0, 0.4))

    def test_observations_lists_what_was_recorded_that_week(self):
        w = weeks(scouted("GH A", 203110, GRID),
                  counted("GH A", 203110, ["Z000"], 3)
                  + counted("GH A", 203110, ["Z001"], 1, obs="Aphids")
                  + counted("GH A", 203110, ["Z002"], 0, obs="Botrytis", kind="disease"))
        self.assertEqual(w.observations("GH A", "2031-W10", "pest"), ["Aphids", "Thrips"])
        self.assertEqual(w.observations("GH A", "2031-W10", "disease"), ["Botrytis"])
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_threshold_counts_pure.py`
Expected: FAIL — `AttributeError: 'StationWeeks' object has no attribute 'station_counts'`.

- [ ] **Step 3: Collect counts in `_prevalence_rows.py`**

1. Replace the whole `_fetch_infested` function with:

```python
def _fetch_infested(where: str, params: dict, kinds, pairs=None) -> list:
    """(house, station, ISO week, kind, observation, stage, section, count) per
    child row.

    A pest infests when the row has a count > 0 or a recorded stage; a disease
    when the row exists (spec §1). ``count`` is the pest row's count (0 for a
    disease) — the Count measure sums it per station (thresholds spec §2). Not
    DISTINCT — deduplicated into sets."""
    restrict = _pairs_clause(pairs)
    parts = []
    if "pest" in kinds:
        parts.append(f"""
        SELECT {_WH}, {_STATION}, {_WEEK}, 'pest', c.pest,
               COALESCE(c.stage, ''), COALESCE(c.plant_section, ''), COALESCE(c.`count`, 0)
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("pest", "c.pest", params)}
          AND COALESCE({_STATION}, '') <> ''{restrict}
          AND (COALESCE(c.`count`, 0) > 0 OR COALESCE(c.stage, '') <> '')
        """)
    if "disease" in kinds:
        parts.append(f"""
        SELECT {_WH}, {_STATION}, {_WEEK}, 'disease', c.disease,
               COALESCE(c.stage, ''), COALESCE(c.plant_section, ''), 0
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("disease", "c.disease", params)}
          AND COALESCE({_STATION}, '') <> ''{restrict}
        """)
    if not parts:
        return []
    return frappe.db.sql(" UNION ALL ".join(parts), params)
```

2. In `StationWeeks.__init__`, after `self._labels: dict = {}` add:

```python
        self._station_counts: dict = {}  # (wh, week) -> {(kind, obs, stage, section): {station: Σcount}}
        self._count_memo: dict = {}
```
and change the infested loop's call to
`self._add_infested(r["wh"], r["station"], r["yw"], r["kind"], r["obs"], r["stage"], r["section"], r.get("count", 0))`.

3. Replace `_add_infested` with:

```python
    def _add_infested(self, wh, station, yw, kind, obs, stage, section, count=0):
        wh = (wh or "").strip()
        station = (station or "").strip()
        week = self._label(yw)
        if not wh or not station or not week:
            return
        key = (kind, (obs or "").strip(), (stage or "").strip(), (section or "").strip())
        self._infested.setdefault((wh, week), {}).setdefault(key, set()).add(station)
        if count:
            per = self._station_counts.setdefault((wh, week), {}).setdefault(key, {})
            per[station] = per.get(station, 0.0) + float(count)
```

4. In `load`, replace
`for wh, station, yw, kind, obs, stage, section in _fetch_infested(where, params, kinds, pairs):` / `out._add_infested(wh, station, yw, kind, obs, stage, section)`
with
`for wh, station, yw, kind, obs, stage, section, count in _fetch_infested(where, params, kinds, pairs):` / `out._add_infested(wh, station, yw, kind, obs, stage, section, count)`.

5. Append these methods to `StationWeeks` (after `combined_latest`):

```python
    # ── counts (thresholds spec §2) ────────────────────────────────────────

    def observations(self, wh, week, kind) -> list:
        """Observations of ``kind`` recorded at ``wh`` that ISO week, sorted."""
        return sorted({o for (k, o, _g, _s) in self._infested.get((wh, week), {}) if k == kind and o})

    def station_counts(self, wh, week, kind, obs=ANY, stages=ANY, section=ANY) -> dict:
        """``{station: Σcount}`` that week; ``stages`` (a frozenset) keeps only
        those stages — a Count row sums its counted stages, never its ticks."""
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
            for station, c in per.items():
                out[station] = out.get(station, 0.0) + c
        return out

    def count_figures(self, wh, week, kind, obs=ANY, stages=ANY, section=ANY):
        key = (wh, week, kind, obs, stages, section)
        if key not in self._count_memo:
            scouted = self._scouted.get((wh, week))
            fig = None
            if scouted:
                grid = self.grid(wh)
                if (wh, week) not in self._counts:
                    self._counts[(wh, week)] = P.section_counts(grid, scouted)
                fig = P.count_figures(
                    grid, scouted,
                    self.station_counts(wh, week, kind, obs, stages, section),
                    scouted_counts=self._counts[(wh, week)],
                )
                if fig is not None:
                    fig["week"] = week
            self._count_memo[key] = fig
        return self._count_memo[key]

    def count_latest(self, wh, kind, obs=ANY, stages=ANY, section=ANY):
        """``count_figures`` for the house's latest week, ``prev`` = the previous
        scouted week's value (mirrors ``latest``)."""
        latest, previous = self.latest_pair(wh)
        if latest is None:
            return None
        fig = self.count_figures(wh, latest, kind, obs, stages, section)
        if fig is None:
            return None
        prev = self.count_figures(wh, previous, kind, obs, stages, section) if previous else None
        return {**fig, "prev": prev["value"] if prev else None}
```

- [ ] **Step 4: Run the pure tests to pass**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_threshold_counts_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py`
Expected: all pass.

- [ ] **Step 5: Create the shared DB fixture**

Create `upande_scp/serverscripts/tests/thresholds_fixture.py`:

```python
"""Raw-SQL scouting, band settings and rosters for the thresholds tests (piece 3a).

Same contract as prevalence_fixture: callers roll back in tearDown and pass
force="1" to cached aggregates. Weeks 2031-W20/W21/W22 — no other module seeds
them, and kaitet.local has no real scouting in 2031.
"""

import frappe
from frappe.utils import now

from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import prevalence_fixture as PF

WEEK_20 = ("2031-05-12", "2031-05-18")  # 2031-W20
WEEK_21 = ("2031-05-19", "2031-05-25")  # 2031-W21
WEEK_22 = ("2031-05-26", "2031-06-01")  # 2031-W22

#: roster key -> (child doctype, Farm parentfield)
ROSTERS = {
    "creators": ("Farm Spray Plan Creator", "spray_plan_creators"),
    "approvers": ("Farm Spray Plan Approver", "spray_plan_approvers"),
    "supervisors": ("Farm Spray Supervisor", "spray_supervisors"),
}


def seed_week(warehouse, date, *, crop, per_section=3, infested_per_section=1, pest="Thrips",
              stage="Adult", count=3, sections=None, block=False) -> list:
    """`per_section` stations scouted in each 3 × 3 section (only the (row, col)
    pairs in `sections` when given); the first `infested_per_section` of them
    carry `pest` at `stage` with `count`. Same stations on every call."""
    names = []
    for pos, stations in sorted(PF.stations_by_section(R._load_grid(warehouse)).items()):
        if sections is not None and tuple(pos) not in sections:
            continue
        for i, st in enumerate(stations[:per_section]):
            hit = i < infested_per_section
            where = {"block": warehouse, "tree": st} if block else {"greenhouse": warehouse, "zone": st}
            names.append(PF.insert_station_entry(
                date=date, crop=crop, pests=[pest] if hit else [],
                pest_stage=stage, pest_count=count, **where,
            ))
    return names


def set_bands(crop, pest, low, moderate, high, measure="Percentage", stage_bands=None) -> str:
    """Measure + row bands on the crop's Pest Filter for `pest`; every stage band
    zeroed unless given in `stage_bands` = {stage: (low, moderate, high)}."""
    name = frappe.db.get_value("Pest Filter", {"crop_scouted": crop, "pest": pest}, "name")
    frappe.db.set_value("Pest Filter", name, {
        "measure": measure, "low_threshold": low, "moderate_threshold": moderate, "high_threshold": high,
    })
    for s in frappe.get_all("Pests Stages", filters={"parent": name, "parenttype": "Pest Filter"},
                            fields=["name", "stage"]):
        b = (stage_bands or {}).get(s.stage, (0, 0, 0))
        frappe.db.set_value("Pests Stages", s.name, {
            "low_threshold": b[0], "moderate_threshold": b[1], "high_threshold": b[2],
        })
    _common.clear_threshold_cache()
    return name


def clear_all_bands(crop) -> None:
    """Zero every band of the crop, so only what a test sets can classify or alert."""
    for doctype, child in (("Pest Filter", "Pests Stages"), ("Disease Filter", "Disease Stages")):
        for name in frappe.get_all(doctype, filters={"crop_scouted": crop}, pluck="name"):
            frappe.db.sql(
                f"update `tab{doctype}` set low_threshold=0, moderate_threshold=0, high_threshold=0 where name=%s",
                (name,),
            )
            frappe.db.sql(
                f"update `tab{child}` set low_threshold=0, moderate_threshold=0, high_threshold=0 "
                "where parent=%s and parenttype=%s",
                (name, doctype),
            )
    _common.clear_threshold_cache()


def set_roster(farm, roster, users) -> None:
    """Replace one Farm roster (`creators` / `approvers` / `supervisors`) with `users`."""
    child, parentfield = ROSTERS[roster]
    frappe.db.sql(f"delete from `tab{child}` where parent=%s and parenttype='Farm'", (farm,))
    for i, user in enumerate(users, start=1):
        frappe.db.sql(
            f"""insert into `tab{child}`
               (name, creation, modified, owner, modified_by, docstatus, idx, user,
                parent, parentfield, parenttype)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s, %(u)s,
                %(f)s, %(pf)s, 'Farm')""",
            {"n": "_TEST-TH-" + frappe.generate_hash(length=10), "ts": now(), "i": i,
             "u": user, "f": farm, "pf": parentfield},
        )


def ensure_user(email) -> str:
    """A committed, enabled user (the test_notifications pattern)."""
    if not frappe.db.exists("User", email):
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": email.split("@")[0],
            "send_welcome_email": 0, "enabled": 1,
        }).insert(ignore_permissions=True)
        frappe.db.commit()
    return email
```

- [ ] **Step 6: Write the failing DB tests**

Create `upande_scp/serverscripts/tests/test_threshold_measure_dashboards.py`:

```python
"""The row's measure drives dashboard severity. DB test — direct runner."""

import unittest
from importlib import import_module

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import thresholds_fixture as TF

O = import_module("upande_scp.serverscripts.dashboard_aggregates._overview")


class TestMeasureOnDashboards(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        TF.clear_all_bands("Rose")

    def tearDown(self):
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        frappe.db.rollback()

    def _cell(self, stage):
        where, params = _common.parent_filter_conditions(TF.WEEK_20[0], TF.WEEK_20[1], "Rose", None)
        weeks = R.StationWeeks.load(TF.WEEK_20[0], TF.WEEK_20[1], "Rose", None)
        cells = O._classify_cells(O._observation_rows(where, params), "Rose", weeks)[1]
        return next(c for c in cells
                    if c["greenhouse"] == self.gh and c["obs_name"] == "Thrips" and c["stage"] == stage)

    def test_a_count_row_judges_the_average_count_not_the_share(self):
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Adult", count=3)
        cell = self._cell("Adult")
        self.assertEqual(cell["prevalence"], 33.3)
        # 1 of 3 stations per section, 3 each → 1.0 per zone: Moderate. Read as a
        # percentage, 33.3 would have been High.
        self.assertEqual(cell["severity"], "moderate")

    def test_a_percentage_row_still_judges_the_share(self):
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Adult", count=3)
        self.assertEqual(self._cell("Adult")["severity"], "high")

    def test_a_tick_box_stage_under_a_count_row_is_judged_as_a_share(self):
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Damages", count=1)
        self.assertEqual(_common.band_spec("Rose", "pest", "Thrips", "Damages")["measure"], "Percentage")
        self.assertEqual(self._cell("Damages")["severity"], "high")      # 33.3 % ≥ 2

    def test_the_row_count_sums_only_counted_stages(self):
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        spec = _common.band_spec("Rose", "pest", "Thrips", "")
        self.assertEqual((spec["measure"], spec["count_stages"]), ("Count", frozenset({"Adult", "Larvae"})))
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Adult", count=3)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", stage="Damages", count=1)
        weeks = R.StationWeeks.load(TF.WEEK_20[0], TF.WEEK_20[1], "Rose", None)
        self.assertEqual(weeks.count_latest(self.gh, "pest", "Thrips", stages=spec["count_stages"])["value"], 1.0)

    def test_misordered_bands_classify_nothing(self):
        TF.set_bands("Rose", "Thrips", 1, 0.4, 2)
        self.assertIsNone(_common.band_spec("Rose", "pest", "Thrips", ""))
        self.assertIsNone(_common.severity_for("Rose", "pest", "Thrips", "", 50.0))

    def test_a_stage_band_wins_over_the_row_band(self):
        TF.set_bands("Rose", "Thrips", 0, 50, 90, stage_bands={"Adult": (0, 10, 30)})
        self.assertEqual(_common.severity_for("Rose", "pest", "Thrips", "Adult", 33.3), "high")
        self.assertEqual(_common.severity_for("Rose", "pest", "Thrips", "Larvae", 33.3), None)
        self.assertIsNone(_common.severity_for("Rose", "pest", "Thrips", "Adult", None))
```

- [ ] **Step 7: Run them to see them fail**

Run: **DB-RUN** `test_threshold_measure_dashboards`
Expected: FAIL — `AttributeError: module '..._common' has no attribute 'band_spec'`.

- [ ] **Step 8: Make `_common.py` measure-aware**

1. Add beside the other imports at the top of `_common.py`: `from upande_scp.serverscripts.common import threshold_bands as B`.
2. Replace everything from `def load_thresholds(crop: str) -> dict:` down to (and including) the last line of `_load_kind` (`        }` closing the stage entry) with:

```python
def load_thresholds(crop: str) -> dict:
    """``{(kind, obs_name, stage): spec}`` for one Crop Scouted; ``stage=""`` is
    the row's own (all-stage) band.

    A spec is ``{"low", "mod", "high", "measure", "row_measure", "count_stages",
    "reading_types"}``. ``measure`` is what this key is judged in
    (``threshold_bands.effective_measure``). ``count_stages`` are the stages a
    Count figure sums: every counted stage for the row key, the stage itself for
    a stage key. Unset (all-zero) and misordered bands are left out, so they
    classify nothing. Memoised per request; ``clear_threshold_cache`` drops it.
    """
    crop = (crop or "").strip()
    if not crop:
        return {}
    cache = _threshold_cache()
    if crop in cache:
        return cache[crop]

    if not frappe.db.exists("Crop Scouted", crop):
        cache[crop] = {}
        return cache[crop]

    out: dict = {}
    _load_kind(
        out, crop,
        parent_table="Pest Filter", child_table="Pests Stages",
        obs_col="pest", kind="pest",
    )
    _load_kind(
        out, crop,
        parent_table="Disease Filter", child_table="Disease Stages",
        obs_col="disease", kind="disease",
    )

    cache[crop] = out
    return out


def _usable(low, mod, high) -> bool:
    return B.is_configured(low, mod, high) and B.bands_ascending(low, mod, high)


def _load_kind(out: dict, crop: str, *, parent_table: str, child_table: str, obs_col: str, kind: str) -> None:
    """Populate ``out`` for one kind with one LEFT JOIN. A filter row with no
    stage children comes back once with every ``s_*`` column NULL; that is not a
    stage entry. Count is honoured only for a pest with a counted stage (D1)."""
    measure_col = "pf.measure" if frappe.db.has_column(parent_table, "measure") else "'Percentage'"
    rows = frappe.db.sql(
        f"""
        SELECT pf.name AS row_name, pf.`{obs_col}` AS obs, {measure_col} AS measure,
               pf.low_threshold, pf.moderate_threshold, pf.high_threshold,
               s.stage AS s_stage, s.reading_type AS s_rt, s.low_threshold AS s_low,
               s.moderate_threshold AS s_mod, s.high_threshold AS s_high
        FROM `tab{parent_table}` pf
        LEFT JOIN `tab{child_table}` s
            ON s.parent = pf.name AND s.parenttype = %(parent_table)s
        WHERE pf.crop_scouted = %(crop)s
        """,
        {"crop": crop, "parent_table": parent_table},
        as_dict=True,
    )
    by_row: dict = {}
    for r in rows:
        by_row.setdefault(r["row_name"], []).append(r)

    for group in by_row.values():
        head = group[0]
        obs = head["obs"]
        stages = [r for r in group if r["s_stage"] is not None]
        reading_types = {(r["s_stage"] or "").strip(): (r["s_rt"] or "") for r in stages}
        counted = frozenset(s for s, rt in reading_types.items() if rt == B.COUNT)
        row_measure = head["measure"] if head["measure"] in B.MEASURES else B.PERCENTAGE
        if kind != "pest" or not counted:
            row_measure = B.PERCENTAGE
        shared = {"row_measure": row_measure, "reading_types": reading_types}

        if _usable(head["low_threshold"], head["moderate_threshold"], head["high_threshold"]):
            out[(kind, obs, "")] = {
                "low":  float(head["low_threshold"] or 0),
                "mod":  float(head["moderate_threshold"] or 0),
                "high": float(head["high_threshold"] or 0),
                "measure": row_measure,
                "count_stages": counted,
                **shared,
            }
        for r in stages:
            if not _usable(r["s_low"], r["s_mod"], r["s_high"]):
                continue
            stage = (r["s_stage"] or "").strip()
            out[(kind, obs, stage)] = {
                "low":  float(r["s_low"] or 0),
                "mod":  float(r["s_mod"] or 0),
                "high": float(r["s_high"] or 0),
                "measure": B.effective_measure(row_measure, reading_types.get(stage, "")),
                "count_stages": frozenset({stage}),
                **shared,
            }
```

3. Replace the whole `severity_for` function with:

```python
def band_spec(crop: str, kind: str, obs_name: str, stage: str = "") -> dict | None:
    """The bands a (kind, observation, stage) figure is judged against, and the
    measure it is judged in: the stage's own bands first, else the row's bands
    read in the stage's measure (a tick-box stage under a Count row is a share,
    and its Count — were it counted — would be that stage's alone)."""
    thresholds = load_thresholds(crop)
    if not thresholds:
        return None
    stage = (stage or "").strip()
    if stage:
        own = thresholds.get((kind, obs_name, stage))
        if own:
            return own
    row = thresholds.get((kind, obs_name, ""))
    if not row or not stage:
        return row
    return {
        **row,
        "measure": B.effective_measure(row["row_measure"], row["reading_types"].get(stage, "")),
        "count_stages": frozenset({stage}),
    }


def house_value(crop: str, kind: str, obs_name: str, stage: str, weeks, wh: str, fig) -> float | None:
    """A house's latest-week figure in the measure its bands are read in:
    ``fig["prevalence"]`` for a Percentage, the average count per scouted
    station (``weeks.count_latest``) for a Count. None when there is none."""
    spec = band_spec(crop, kind, obs_name, stage)
    if spec and spec["measure"] == B.COUNT:
        cfig = weeks.count_latest(wh, kind, obs_name, stages=spec["count_stages"])
        return cfig["value"] if cfig else None
    return fig.get("prevalence") if fig else None


def severity_for(
    crop: str,
    kind: str,
    obs_name: str,
    stage: str,
    value: float | None,
) -> str | None:
    """Classify ``value`` — already in the measure ``band_spec`` names; get it
    with ``house_value`` — against the stage band, else the row band."""
    if value is None:
        return None
    return severity_from_pct(value, band_spec(crop, kind, obs_name, stage))
```

(`_zero_band` stays: `tests/check_thresholds.py` imports it. That script is a one-off equivalence check for the old N+1 fix, part of no suite, and will now report a divergence because specs gained keys. That is expected.)

- [ ] **Step 9: Feed `house_value` to the three dashboards**

`_overview.py` — in `_classify_cells`, replace
`    from upande_scp.serverscripts.dashboard_aggregates._common import severity_for`
with
`    from upande_scp.serverscripts.dashboard_aggregates._common import house_value, severity_for`
and replace

```python
        pct = fig["prevalence"]
        sev = severity_for(crop, kind, obs_name, stage, pct) if pct is not None else None
```
with
```python
        pct = fig["prevalence"]
        value = house_value(crop, kind, obs_name, stage, weeks, gh, fig)
        sev = severity_for(crop, kind, obs_name, stage, value) if value is not None else None
```

`_gh_detail.py` — add `house_value,` to the `from upande_scp.serverscripts.dashboard_aggregates._common import (...)` list, and replace
```python
                if severity_for(filters["crop"], kind, obs_name, stage, fig["prevalence"]) == "high":
```
with
```python
                value = house_value(filters["crop"], kind, obs_name, stage, weeks, gh, fig)
                if severity_for(filters["crop"], kind, obs_name, stage, value) == "high":
```

`_pests_diseases.py` — add `house_value,` to its `_common` import list, and replace
```python
        sev = severity_for(crop, kind, obs_name, stage, fig["prevalence"])
```
with
```python
        sev = severity_for(crop, kind, obs_name, stage, house_value(crop, kind, obs_name, stage, weeks, wh, fig))
```

- [ ] **Step 10: Run to pass, then the regression gate**

Run: **DB-RUN** `test_threshold_measure_dashboards` → 6 OK.
Then, one module per DB-RUN: `test_dashboard_aggregates_overview`, `test_dashboard_aggregates_pests_diseases`, `test_dashboard_aggregates_gh_detail`, `test_dashboard_aggregates_traps`, `test_dashboard_aggregates_fcm`, `test_prevalence_rows`, `test_prevalence_overview`, `test_prevalence_pests`, `test_prevalence_trends`, `test_crop_scoped_aggregates`, `test_crop_scoped_aggregate_detail`, `test_thresholds_measure`.
Expected: all OK. (The `severity_for` patches in `test_prevalence_overview` / `test_prevalence_pests` still bite: the dashboards look the name up at call time, and the 5-argument signature is unchanged.)

- [ ] **Step 11: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py upande_scp/serverscripts/dashboard_aggregates/_common.py upande_scp/serverscripts/dashboard_aggregates/_overview.py upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py upande_scp/serverscripts/tests/thresholds_fixture.py upande_scp/serverscripts/tests/test_threshold_counts_pure.py upande_scp/serverscripts/tests/test_threshold_measure_dashboards.py
git commit -m "feat(scp): dashboards judge each row in its measure, counts per station included"
```

---
### Task 4: SCP's bell shows only SCP notifications (`scouting` and `plan` categories)

**Files:**
- Modify: `upande_scp/serverscripts/common/notifications.py:25` (CATEGORIES), `:144-205` (read API)
- Modify: `upande_scp/serverscripts/common/custom_fields.py:519` (`scp_category` options, tabs)
- Modify: `upande_scp/serverscripts/spray_plan_creator/maintenance.py:151-174` (`_notify_creator`)
- Modify: `upande_scp/serverscripts/tests/test_notifications.py`
- Modify: `frontend/src/lib/notifications-api.ts`, `frontend/src/lib/notifications-api.test.ts`, `frontend/src/pages/Notifications.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `notifications.CATEGORIES = ("loan", "transfer", "procurement", "stock", "scouting", "plan")`. `list_notifications`, `unread_count` and `mark_read(all=1)` only touch rows with `scp_category IN CATEGORIES`, and `list_notifications(category=<unknown>)` lists nothing. TS `ScpCategory` gains `"scouting" | "plan"`.

- [ ] **Step 1: Write the failing tests**

In `upande_scp/serverscripts/tests/test_notifications.py`:

1. Give every `notify` call that a read-API test then reads back a category, because an uncategorised row no longer reaches the bell (spec D9). In `test_unread_count_is_per_user` make the three calls `N.notify([U1], "a", category="loan")`, `N.notify([U1], "b", category="loan")`, `N.notify([U2], "c", category="loan")`. In `test_mark_all_read_clears_only_the_session_user`: `N.notify([U1], "a", category="loan")`, `N.notify([U2], "b", category="loan")`. In `test_unread_only_filter`: `N.notify([U1], "one", category="loan")`, `N.notify([U1], "two", category="loan")`. In `test_limit_is_clamped_and_offset_paginates`: `N.notify([U1], f"n{i}", category="loan")`. Put this comment above the first of them: `# Categorised: since thresholds D9 the bell lists SCP-category rows only.`
2. Append to `class TestNotifications`:

```python
    # -- SCP-only bell (thresholds spec D9) ------------------------------
    def _foreign_row(self, user, subject="Leave approved"):
        """A Notification Log row another app wrote: no scp_category."""
        doc = frappe.get_doc({"doctype": "Notification Log", "for_user": user,
                              "type": "Alert", "subject": subject})
        doc.insert(ignore_permissions=True)
        return doc.name

    def test_the_bell_ignores_non_scp_rows(self):
        foreign = self._foreign_row(U1)
        N.notify([U1], "Spray advised: Thrips", category="scouting")
        frappe.set_user(U1)
        self.assertEqual([r.subject for r in N.list_notifications()["notifications"]],
                         ["Spray advised: Thrips"])
        self.assertEqual(N.unread_count(), 1)
        N.mark_read(all=1)
        frappe.set_user("Administrator")
        self.assertEqual(frappe.db.get_value("Notification Log", foreign, "read"), 0,
                         "mark-all-read touched another app's notification")

    def test_an_unknown_category_filter_lists_nothing(self):
        N.notify([U1], "loan one", category="loan")
        frappe.set_user(U1)
        self.assertEqual(N.list_notifications(category="hr")["notifications"], [])

    def test_scouting_and_plan_are_scp_categories(self):
        self.assertIn("scouting", N.CATEGORIES)
        self.assertIn("plan", N.CATEGORIES)
        self.assertEqual(N.notify([U1], "Alarming: Thrips", category="scouting"), [U1])
        self.assertEqual(frappe.db.get_value("Notification Log", {"for_user": U1}, "scp_category"), "scouting")

    def test_the_auto_cancel_notice_goes_through_notify_as_a_plan(self):
        from unittest.mock import patch

        from upande_scp.serverscripts.spray_plan_creator import maintenance as M

        wo = frappe._dict(owner=U1, name="WO-TEST-0001", custom_greenhouse="GH X",
                          creation="2031-01-01 08:00:00")
        with patch.object(N, "notify") as notify:
            M._notify_creator(wo)
        args, kwargs = notify.call_args
        self.assertEqual(args[0], [U1])
        self.assertEqual(args[3:5], ("Work Order", "WO-TEST-0001"))
        self.assertEqual(kwargs["category"], "plan")
```

In `frontend/src/lib/notifications-api.test.ts` change the expected keys to
`["loan", "plan", "procurement", "scouting", "stock", "transfer"]`.

- [ ] **Step 2: Run them to see them fail**

Run: **DB-RUN** `test_notifications`
Expected: FAIL — `test_the_bell_ignores_non_scp_rows` (two rows listed), `test_scouting_and_plan_are_scp_categories` (`'scouting' not found`), `test_the_auto_cancel_notice_goes_through_notify_as_a_plan` (`notify` never called).
Run: `cd frontend && npx vitest run src/lib/notifications-api.test.ts` → FAIL (keys differ).

- [ ] **Step 3: Widen the Select options on the live field**

In `upande_scp/serverscripts/common/custom_fields.py` (tabs), replace `"options": "\nloan\ntransfer\nprocurement\nstock",` with `"options": "\nloan\ntransfer\nprocurement\nstock\nscouting\nplan",`.
Apply only that field (not the whole `ensure_scp_custom_fields` pass, which also prunes):
**DB-EXEC** `cf = frappe.get_doc('Custom Field', 'Notification Log-scp_category'); cf.options = '\nloan\ntransfer\nprocurement\nstock\nscouting\nplan'; cf.save(ignore_permissions=True); print(frappe.get_meta('Notification Log').get_field('scp_category').options.split())`
Expected: `['loan', 'transfer', 'procurement', 'stock', 'scouting', 'plan']`.

- [ ] **Step 4: Scope the read API to SCP rows**

In `common/notifications.py` replace the `CATEGORIES = (...)` line with:

```python
#: ``scouting`` = threshold alerts (piece 3a); ``plan`` = spray-plan lifecycle
#: notices (auto-cancel). The bell lists only rows carrying one of these (D9).
CATEGORIES = ("loan", "transfer", "procurement", "stock", "scouting", "plan")
```

Replace the bodies of the three read endpoints (keep the decorators):

```python
@frappe.whitelist()
def list_notifications(category=None, unread_only=0, limit=50, offset=0):
    """The session user's SCP notifications. A Notification Log row without an
    SCP category (HR, ERPNext, Desk) never reaches this bell (spec D9)."""
    if category and category not in CATEGORIES:
        return {"notifications": [], "unread": unread_count()}
    filters = {
        "for_user": frappe.session.user,
        "scp_category": category or ["in", list(CATEGORIES)],
    }
    if str(unread_only) in ("1", "true", "True"):
        filters["read"] = 0
    try:
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        limit, offset = 50, 0

    rows = frappe.get_all(
        "Notification Log",
        filters=filters,
        fields=[
            "name", "subject", "email_content", "read", "creation",
            "document_type", "document_name", "scp_category",
        ],
        order_by="creation desc",
        limit_page_length=limit,
        limit_start=offset,
    )
    return {"notifications": rows, "unread": unread_count()}


@frappe.whitelist()
def unread_count():
    return frappe.db.count(
        "Notification Log",
        {"for_user": frappe.session.user, "read": 0, "scp_category": ["in", list(CATEGORIES)]},
    )


@frappe.whitelist()
def mark_read(names=None, all=0):
    """Mark specific notifications, or every SCP one of the user's, as read."""
    import json

    user = frappe.session.user
    if str(all) in ("1", "true", "True"):
        frappe.db.sql(
            """UPDATE `tabNotification Log` SET `read` = 1
               WHERE for_user = %(user)s AND `read` = 0 AND scp_category IN %(cats)s""",
            {"user": user, "cats": CATEGORIES},
        )
        frappe.db.commit()
        return {"unread": 0}

    if isinstance(names, str):
        try:
            names = json.loads(names)
        except (TypeError, ValueError):
            names = [names]
    for name in (names or []):
        # Scoped by for_user as well as name, so a guessed name from another
        # user's inbox can't be touched.
        frappe.db.set_value(
            "Notification Log", {"name": name, "for_user": user}, "read", 1,
            update_modified=False,
        )
    frappe.db.commit()
    return {"unread": unread_count()}
```

- [ ] **Step 5: Route the auto-cancel notice through `notify`**

In `spray_plan_creator/maintenance.py` replace the whole `_notify_creator` function with:

```python
def _notify_creator(wo) -> None:
    """Tell the plan's creator, through the one SCP notification path (category
    "plan", so it reaches the SCP bell). Best-effort: ``notify`` logs and swallows."""
    if not wo.owner or wo.owner in ("Administrator", "Guest"):
        return
    from upande_scp.serverscripts.common import notifications

    notifications.notify(
        [wo.owner],
        f"Spray plan {wo.name} auto-cancelled — unapproved for over {DORMANT_DAYS} days",
        (
            f"Your spray plan for {wo.custom_greenhouse or 'a greenhouse'} "
            f"(created {wo.creation}) was automatically cancelled because it "
            f"was not approved within {DORMANT_DAYS} days."
        ),
        "Work Order",
        wo.name,
        category="plan",
    )
```

- [ ] **Step 6: Frontend categories**

In `frontend/src/lib/notifications-api.ts`:
- `export type ScpCategory = "loan" | "transfer" | "procurement" | "stock" | "scouting" | "plan";`
- `CATEGORY_LABEL` becomes:

```ts
export const CATEGORY_LABEL: Record<ScpCategory, string> = {
  loan: "Loans",
  transfer: "Transfers",
  procurement: "Procurement",
  stock: "Stock",
  scouting: "Scouting",
  plan: "Spray plans",
};
```

In `frontend/src/pages/Notifications.tsx` add `"scouting",` and `"plan",` after `"stock",` in `CATEGORIES`, and change the empty-state sentence to `"Loan requests, transfers, procurement reviews and scouting alerts will show up here."`.

- [ ] **Step 7: Run to pass**

Run: **DB-RUN** `test_notifications` → all OK.
Run: `cd frontend && npx vitest run src/lib/notifications-api.test.ts && npx tsc --noEmit -p tsconfig.app.json` → pass, no type errors.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/common/notifications.py upande_scp/serverscripts/common/custom_fields.py upande_scp/serverscripts/spray_plan_creator/maintenance.py upande_scp/serverscripts/tests/test_notifications.py frontend/src/lib/notifications-api.ts frontend/src/lib/notifications-api.test.ts frontend/src/pages/Notifications.tsx
git commit -m "feat(scp): the scp bell lists only scp notifications; scouting and plan categories"
```

---
### Task 5: Scouting Alert, the hourly check, recipients, Acknowledge and the open-alerts endpoint

**Files:**
- Create: `upande_scp/upande_scp/doctype/scouting_alert/__init__.py` (empty), `scouting_alert.json`, `scouting_alert.py`
- Create: `upande_scp/serverscripts/scouting/thresholds_check.py`
- Modify: `upande_scp/hooks.py` (`scheduler_events["hourly"]`)
- Test: `upande_scp/serverscripts/tests/test_scouting_alerts.py`

**Interfaces:**
- Consumes: Task 1 `threshold_bands`; Task 3 `_common.load_thresholds` / `band_spec` / `station_word` / `clear_threshold_cache`, `StationWeeks.figures` / `count_figures` / `latest_pair` / `warehouses`; Task 4 `notifications.notify(..., category="scouting")`, `notifications.users_for_role`, `notifications._clean`; `crop_scope.scoped_farms` / `assert_crop`; `crop_catalog.canonical` / `resolve_crop` / `catalog`.
- Produces (module `scouting.thresholds_check`, alias `TC` below):
  - `EAT`, `DOCTYPE = "Scouting Alert"`, `EVAL_WINDOW_DAYS = 14`, `CHECK_GATE_KEY`, `CHECK_GATE_SECONDS = 3000`, `KIND_LABEL`, `OPEN_STATES`, `LIVE_STATES`, `ALERT_FIELDS`
  - `now_eat() -> datetime` (aware, Africa/Nairobi); `alert_name(warehouse, kind_label, observation, stage, iso_week) -> str`; `take_gate(key, seconds) -> bool`; `clear_gate(key) -> None`
  - `banded_crops() -> list[str]`; `evaluate(crop, today=None) -> list[finding]`. A finding is `{"crop", "warehouse", "kind", "observation", "stage", "iso_week", "measure", "unit", "value", "margin", "reliability", "sections_scouted", "sections_total", "band", "action"}`.
  - `upsert(finding, now=None) -> str | None`; `check_crop(crop, today=None) -> {"findings", "alerts"}`; `run_threshold_check(today=None, force=False, commit=True) -> dict`
  - `recipients_for(farm, crop, action) -> list[str]`; `_gms(farm, crop) -> list[str]`; `_existing(name)`
  - whitelisted `acknowledge_alert(name) -> {"name", "status"}`, `open_alerts(crop, farm=None, greenhouse=None) -> list[dict]` (each row + `unit`)

- [ ] **Step 1: Create the doctype**

`upande_scp/upande_scp/doctype/scouting_alert/scouting_alert.json`:

```json
{
 "actions": [],
 "creation": "2026-10-10 12:00:00.000000",
 "doctype": "DocType",
 "engine": "InnoDB",
 "field_order": [
  "crop",
  "farm",
  "warehouse",
  "kind",
  "observation",
  "stage",
  "iso_week",
  "figure_section",
  "measure",
  "value",
  "margin",
  "reliability",
  "sections_scouted",
  "sections_total",
  "action_section",
  "band",
  "action",
  "status",
  "raised_on",
  "acknowledged_by",
  "acknowledged_on",
  "work_order",
  "notified_action",
  "notified"
 ],
 "fields": [
  {"fieldname": "crop", "fieldtype": "Link", "label": "Crop", "options": "Crop Scouted", "in_standard_filter": 1, "reqd": 1},
  {"fieldname": "farm", "fieldtype": "Link", "label": "Farm", "options": "Farm", "in_standard_filter": 1, "search_index": 1},
  {"fieldname": "warehouse", "fieldtype": "Link", "label": "Greenhouse / Block", "options": "Warehouse", "in_list_view": 1, "reqd": 1, "search_index": 1},
  {"fieldname": "kind", "fieldtype": "Select", "label": "Kind", "options": "Pest\nDisease", "reqd": 1},
  {"fieldname": "observation", "fieldtype": "Data", "label": "Pest / Disease", "in_list_view": 1, "reqd": 1},
  {"fieldname": "stage", "fieldtype": "Data", "label": "Stage", "description": "Blank = the row's all-stage band."},
  {"fieldname": "iso_week", "fieldtype": "Data", "label": "ISO Week", "in_list_view": 1, "reqd": 1, "search_index": 1},
  {"fieldname": "figure_section", "fieldtype": "Section Break", "label": "Figure"},
  {"fieldname": "measure", "fieldtype": "Select", "label": "Measure", "options": "Percentage\nCount"},
  {"fieldname": "value", "fieldtype": "Float", "label": "Value", "precision": "1"},
  {"fieldname": "margin", "fieldtype": "Float", "label": "Margin (±)", "precision": "1"},
  {"fieldname": "reliability", "fieldtype": "Select", "label": "Reliability", "options": "Good\nFair\nLow"},
  {"fieldname": "sections_scouted", "fieldtype": "Int", "label": "Sections Scouted"},
  {"fieldname": "sections_total", "fieldtype": "Int", "label": "Sections Total"},
  {"fieldname": "action_section", "fieldtype": "Section Break", "label": "Action"},
  {"fieldname": "band", "fieldtype": "Select", "label": "Band", "options": "Moderate\nHigh"},
  {"fieldname": "action", "fieldtype": "Select", "label": "Action", "options": "Alarming\nSpray advised\nScout first", "in_list_view": 1, "in_standard_filter": 1},
  {"default": "Open", "fieldname": "status", "fieldtype": "Select", "label": "Status", "options": "Open\nAcknowledged\nResolved\nConverted to plan", "in_list_view": 1, "in_standard_filter": 1, "search_index": 1},
  {"fieldname": "raised_on", "fieldtype": "Date", "label": "Raised On (EAT)", "description": "Africa/Nairobi date the alert was raised or last escalated — the daily digest's day."},
  {"fieldname": "acknowledged_by", "fieldtype": "Link", "label": "Acknowledged By", "options": "User"},
  {"fieldname": "acknowledged_on", "fieldtype": "Datetime", "label": "Acknowledged On"},
  {"fieldname": "work_order", "fieldtype": "Link", "label": "Curative Plan", "options": "Work Order"},
  {"fieldname": "notified_action", "fieldtype": "Select", "label": "Highest Action Raised", "options": "\nAlarming\nScout first\nSpray advised", "description": "Escalation is measured against this (spec D5)."},
  {"fieldname": "notified", "fieldtype": "Small Text", "label": "Notified Users"}
 ],
 "in_create": 1,
 "links": [],
 "modified": "2026-10-10 12:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Scouting Alert",
 "naming_rule": "By script",
 "owner": "Administrator",
 "permissions": [
  {"create": 1, "delete": 1, "email": 1, "export": 1, "print": 1, "read": 1, "report": 1, "role": "System Manager", "share": 1, "write": 1},
  {"export": 1, "print": 1, "read": 1, "report": 1, "role": "SCP General Manager", "write": 1},
  {"read": 1, "report": 1, "role": "SCP Spray Plan Creator"},
  {"read": 1, "report": 1, "role": "SCP Spray Plan Approver"},
  {"read": 1, "report": 1, "role": "SCP Spray Supervisor"},
  {"read": 1, "report": 1, "role": "SCP Chemical Store Keeper"},
  {"read": 1, "report": 1, "role": "SCP Scout"}
 ],
 "row_format": "Dynamic",
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": [],
 "title_field": "observation",
 "track_changes": 1
}
```

`upande_scp/upande_scp/doctype/scouting_alert/scouting_alert.py` (tabs):

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document

from upande_scp.serverscripts.scouting.thresholds_check import alert_name


class ScoutingAlert(Document):
	def autoname(self):
		# The name IS the unique key (house, kind, observation, stage, ISO week):
		# a second insert of the same key fails instead of duplicating (spec §4).
		self.name = alert_name(self.warehouse, self.kind, self.observation, self.stage, self.iso_week)
```

Create the table — but only after Step 3, because the controller imports `thresholds_check`: **DB-EXEC** `frappe.reload_doc('upande_scp', 'doctype', 'scouting_alert', force=True); print(frappe.db.table_exists('Scouting Alert'))` → `True`.

- [ ] **Step 2: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_scouting_alerts.py`:

```python
"""Scouting Alerts: evaluation, one alert per key, escalation, recipients and the
endpoints (thresholds spec D3–D6). DB test — direct runner; rolled back in tearDown.
The four _test_scp_alert_* users are committed once, like test_notifications'."""

import unittest
from datetime import date, datetime
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF
from upande_scp.serverscripts.tests import thresholds_fixture as TF

U_CREATOR = "_test_scp_alert_creator@example.com"
U_SUPER = "_test_scp_alert_super@example.com"
U_APPROVER = "_test_scp_alert_approver@example.com"
U_GM = "_test_scp_alert_gm@example.com"
SUN_20, SUN_21, SUN_22 = date(2031, 5, 18), date(2031, 5, 25), date(2031, 6, 1)


def at(day, hour=9, minute=0):
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=TC.EAT)


class AlertCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        for user in (U_CREATOR, U_SUPER, U_APPROVER, U_GM):
            TF.ensure_user(user)

    def setUp(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh, self.gh2 = PF.rose_greenhouses(2)
        self.farm = frappe.db.get_value("Warehouse", self.gh, "custom_farm")
        TF.clear_all_bands("Rose")
        TF.set_roster(self.farm, "creators", [U_CREATOR])
        TF.set_roster(self.farm, "supervisors", [U_SUPER])
        TF.set_roster(self.farm, "approvers", [U_APPROVER])
        self.gms = patch.object(TC, "_gms", return_value=[U_GM])
        self.gms.start()
        self.clock = patch.object(TC, "now_eat", return_value=at(SUN_20))
        self.clock.start()

    def tearDown(self):
        self.gms.stop()
        self.clock.stop()
        frappe.set_user("Administrator")
        _common.clear_threshold_cache()
        crop_scope.clear_cache()
        frappe.db.rollback()

    def alert(self, gh=None, week="2031-W20", stage=""):
        return frappe.db.get_value(
            "Scouting Alert", TC.alert_name(gh or self.gh, "Pest", "Thrips", stage, week),
            ["name", "action", "status", "notified_action", "notified", "value", "reliability", "raised_on"],
            as_dict=True,
        )

    def told(self, user, alert):
        return frappe.db.count("Notification Log", {
            "for_user": user, "document_type": "Scouting Alert", "document_name": alert,
            "scp_category": "scouting",
        })

    def raise_spray_advised(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")              # 9 of 27 → 33.3 %, Fair
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        TC.check_crop("Rose", SUN_20)
        return self.alert().name


class TestEvaluate(AlertCase):
    def _found(self):
        return {f["warehouse"]: f for f in TC.evaluate("Rose", SUN_20) if f["observation"] == "Thrips"}

    def test_bands_map_to_alarming_spray_advised_and_scout_first(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.seed_week(self.gh2, TF.WEEK_20[0], crop="Rose", sections={(0, 0)})   # one section: Low
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        found = self._found()
        self.assertEqual((found[self.gh]["value"], found[self.gh]["reliability"], found[self.gh]["action"]),
                         (33.3, "Fair", "Spray advised"))
        self.assertEqual((found[self.gh2]["value"], found[self.gh2]["reliability"], found[self.gh2]["action"]),
                         (33.3, "Low", "Scout first"))
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        self.assertEqual(self._found()[self.gh]["action"], "Alarming")
        TF.set_bands("Rose", "Thrips", 0, 50, 90)
        below = self._found()[self.gh]
        self.assertEqual((below["band"], below["action"]), ("", None))

    def test_a_count_row_is_evaluated_per_zone(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose", count=3)
        TF.set_bands("Rose", "Thrips", 0, 1, 2, measure="Count")
        f = self._found()[self.gh]
        self.assertEqual((f["measure"], f["value"], f["unit"], f["action"]), ("Count", 1.0, "per zone", "Alarming"))

    def test_no_bands_or_no_scouting_means_no_finding(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        self.assertEqual(TC.evaluate("Rose", SUN_20), [])
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        self.assertEqual(TC.evaluate("Rose", date(2031, 7, 6)), [])


class TestAlerts(AlertCase):
    def test_rerunning_the_check_writes_one_alert_and_notifies_once(self):
        name = self.raise_spray_advised()
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual(frappe.db.count("Scouting Alert", {"warehouse": self.gh, "iso_week": "2031-W20"}), 1)
        self.assertEqual((a.action, a.status, a.notified_action), ("Spray advised", "Open", "Spray advised"))
        for user in (U_CREATOR, U_SUPER, U_APPROVER, U_GM):
            self.assertEqual(self.told(user, name), 1, user)
        self.assertEqual(sorted(a.notified.split("\n")), sorted([U_APPROVER, U_CREATOR, U_GM, U_SUPER]))
        self.assertEqual(str(a.raised_on), "2031-05-18")

    def test_a_concurrent_insert_of_the_same_key_is_absorbed_silently(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.set_bands("Rose", "Thrips", 0, 10, 30)
        finding = next(f for f in TC.evaluate("Rose", SUN_20) if f["warehouse"] == self.gh)
        name = TC.upsert(finding)                       # the other worker got there first
        winner = TC._existing(name)
        with patch.object(TC, "_existing", side_effect=[None, winner]):
            self.assertEqual(TC.upsert(finding), name)  # inserts, collides, re-reads
        self.assertEqual(frappe.db.count("Scouting Alert", {"name": name}), 1)
        self.assertEqual(self.told(U_CREATOR, name), 1)

    def test_the_hourly_gate_lets_one_run_through(self):
        TC.clear_gate(TC.CHECK_GATE_KEY)
        try:
            first = TC.run_threshold_check(today=SUN_20, commit=False)
            second = TC.run_threshold_check(today=SUN_20, commit=False)
        finally:
            TC.clear_gate(TC.CHECK_GATE_KEY)
        self.assertIn("crops", first)
        self.assertEqual(second, {"skipped": "ran less than 50 minutes ago"})

    def test_escalation_within_a_week_notifies_again_and_a_repeat_does_not(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")                       # 33.3 %
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual(a.action, "Alarming")
        self.assertEqual((self.told(U_CREATOR, a.name), self.told(U_SUPER, a.name)), (1, 1))
        self.assertEqual((self.told(U_APPROVER, a.name), self.told(U_GM, a.name)), (0, 0))   # D4
        TF.seed_week(self.gh, "2031-05-15", crop="Rose", infested_per_section=2)  # same week → 66.7 %
        TC.check_crop("Rose", SUN_20)
        TC.check_crop("Rose", SUN_20)
        a = self.alert()
        self.assertEqual((a.action, a.notified_action), ("Spray advised", "Spray advised"))
        self.assertEqual(self.told(U_CREATOR, a.name), 2)
        self.assertEqual((self.told(U_APPROVER, a.name), self.told(U_GM, a.name)), (1, 1))

    def test_next_week_at_the_same_action_is_silent_and_supersedes_the_old_alert(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        TF.seed_week(self.gh, TF.WEEK_21[0], crop="Rose")
        TC.check_crop("Rose", SUN_21)
        old, new = self.alert(week="2031-W20"), self.alert(week="2031-W21")
        self.assertEqual(old.status, "Resolved")
        self.assertEqual((new.action, new.status, new.notified_action), ("Alarming", "Open", "Alarming"))
        self.assertEqual(self.told(U_CREATOR, new.name), 0)          # carried, not re-announced (D5)
        TF.seed_week(self.gh, "2031-05-22", crop="Rose", infested_per_section=2)
        TC.check_crop("Rose", SUN_21)
        self.assertEqual(self.told(U_CREATOR, new.name), 1)          # an escalation does notify

    def test_a_recurrence_after_a_clean_week_notifies(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        TF.seed_week(self.gh, TF.WEEK_21[0], crop="Rose", infested_per_section=0)   # scouted clean
        TC.check_crop("Rose", SUN_21)
        self.assertEqual(self.alert(week="2031-W20").status, "Resolved")
        self.assertIsNone(self.alert(week="2031-W21"))
        TF.seed_week(self.gh, TF.WEEK_22[0], crop="Rose")
        TC.check_crop("Rose", SUN_22)
        self.assertEqual(self.told(U_CREATOR, self.alert(week="2031-W22").name), 1)

    def test_acknowledged_stays_acknowledged_until_it_escalates(self):
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TC.check_crop("Rose", SUN_20)
        TC.acknowledge_alert(self.alert().name)
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(self.alert().status, "Acknowledged")
        TF.seed_week(self.gh, "2031-05-15", crop="Rose", infested_per_section=2)
        TC.check_crop("Rose", SUN_20)
        self.assertEqual((self.alert().status, self.alert().action), ("Open", "Spray advised"))

    def test_the_check_never_sends_email(self):
        with patch.object(frappe, "sendmail") as sendmail:
            name = self.raise_spray_advised()
        sendmail.assert_not_called()
        self.assertEqual(
            frappe.db.get_value("Notification Log", {"document_name": name, "for_user": U_CREATOR}, "type"),
            "Alert",   # Frappe never emails an "Alert" notification
        )

    def test_a_recipient_failure_never_blocks_the_alert(self):
        with patch.object(TC, "recipients_for", side_effect=RuntimeError("roster down")), \
                patch.object(frappe, "log_error") as log_error:
            self.raise_spray_advised()
        self.assertEqual(self.alert().action, "Spray advised")
        log_error.assert_called()


class TestRecipients(AlertCase):
    def test_recipients_follow_d4(self):
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.ALARMING), sorted([U_CREATOR, U_SUPER]))
        everyone = sorted([U_APPROVER, U_CREATOR, U_GM, U_SUPER])
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.SPRAY_ADVISED), everyone)
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.SCOUT_FIRST), everyone)

    def test_an_empty_roster_falls_back_to_the_farms_gms_for_alarming(self):
        TF.set_roster(self.farm, "creators", [])
        TF.set_roster(self.farm, "supervisors", [])
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.ALARMING), [U_GM])
        self.assertEqual(TC.recipients_for(self.farm, "Rose", B.SPRAY_ADVISED), sorted([U_APPROVER, U_GM]))

    def test_nobody_to_tell_still_writes_the_alert(self):
        for roster in ("creators", "supervisors", "approvers"):
            TF.set_roster(self.farm, roster, [])
        with patch.object(TC, "_gms", return_value=[]):
            self.raise_spray_advised()
        a = self.alert()
        self.assertEqual((a.action, a.status), ("Spray advised", "Open"))
        self.assertFalse(a.notified)

    def test_gms_are_crop_scoped(self):
        self.gms.stop()
        try:
            self.assertIn(F.PETER, TC._gms(self.farm, "Rose"))
            self.assertNotIn(F.PETER, TC._gms("Lokitela", "Avocado"))
        finally:
            self.gms.start()


class TestEndpoints(AlertCase):
    def test_acknowledge_records_who_and_is_idempotent(self):
        name = self.raise_spray_advised()
        frappe.set_user(F.PETER)
        self.assertEqual(TC.acknowledge_alert(name), {"name": name, "status": "Acknowledged"})
        self.assertEqual(TC.acknowledge_alert(name)["status"], "Acknowledged")
        frappe.set_user("Administrator")
        self.assertEqual(frappe.db.get_value("Scouting Alert", name, "acknowledged_by"), F.PETER)

    def test_acknowledge_is_refused_outside_the_users_crops(self):
        name = self.raise_spray_advised()
        frappe.set_user(U_CREATOR)                     # no Employee: sees no crop
        with self.assertRaises(frappe.PermissionError):
            TC.acknowledge_alert(name)

    def test_open_alerts_are_crop_and_farm_scoped(self):
        name = self.raise_spray_advised()
        mine = next(r for r in TC.open_alerts("Rose") if r.name == name)
        self.assertEqual((mine.unit, mine.action, mine.value, mine.status), ("%", "Spray advised", 33.3, "Open"))
        self.assertEqual(TC.open_alerts("Rose", farm="Lokitela"), [])
        self.assertNotIn(name, [r.name for r in TC.open_alerts("Rose", greenhouse=self.gh2)])
        frappe.set_user(F.PETER)
        self.assertIn(name, [r.name for r in TC.open_alerts("Rose")])
        with self.assertRaises(frappe.PermissionError):
            TC.open_alerts("Avocado")

    def test_resolved_alerts_are_not_open(self):
        name = self.raise_spray_advised()
        frappe.db.set_value("Scouting Alert", name, "status", "Resolved")
        self.assertNotIn(name, [r.name for r in TC.open_alerts("Rose")])
```

Run: **DB-RUN** `test_scouting_alerts`
Expected: FAIL at import — `ModuleNotFoundError: No module named 'upande_scp.serverscripts.scouting.thresholds_check'`.

- [ ] **Step 3: Write `scouting/thresholds_check.py`**

```python
"""Thresholds → actions → Scouting Alerts (spec 2026-10-10 §3–§5, D3–D6).

For each crop with usable bands, ``evaluate`` reads every house scouted in its
latest ISO week (window: the last 14 days to today, Africa/Nairobi) and judges
each banded (kind, observation, stage) in its measure: the adjusted prevalence
for a Percentage, the average count per scouted station for a Count (piece 2's
StationWeeks, so piece 1's crop scoping holds).

``upsert`` keeps one **Scouting Alert** per (house, kind, observation, stage,
ISO week). The alert's name IS that key, so a concurrent second insert fails
instead of duplicating, and the loser re-reads without notifying. A
notification (in-app, category "scouting", never email) goes out only when the
action escalates over the highest action already raised (D5). Within a week
that is this alert's own ``notified_action``. Across weeks it is the house's
live alert of an earlier week, so a new week at the same action is recorded
silently. A newer week supersedes older Open / Acknowledged alerts (Resolved),
a figure below Moderate resolves its week's alert, and a Converted alert is
never touched.

``run_threshold_check`` (hourly) is gated by a Redis ``SET NX EX``: one run per
50 minutes across workers. The 17:00 EAT digest (``alert_digest``) is the only
email.
"""

import hashlib
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope, notifications
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R

EAT = ZoneInfo("Africa/Nairobi")
DOCTYPE = "Scouting Alert"
EVAL_WINDOW_DAYS = 14
CHECK_GATE_KEY = "scp:threshold_check:gate"
CHECK_GATE_SECONDS = 50 * 60
GM_ROLE = "SCP General Manager"
KIND_LABEL = {"pest": "Pest", "disease": "Disease"}
OPEN_STATES = ("Open", "Acknowledged")
LIVE_STATES = ("Open", "Acknowledged", "Converted to plan")
ALERT_FIELDS = [
    "name", "crop", "farm", "warehouse", "kind", "observation", "stage", "iso_week",
    "measure", "value", "margin", "reliability", "sections_scouted", "sections_total",
    "band", "action", "status", "raised_on", "acknowledged_by", "work_order",
]
_KEY_SQL = (
    "warehouse = %(wh)s AND kind = %(kind)s AND observation = %(obs)s "
    "AND COALESCE(stage, '') = %(stage)s"
)


def now_eat() -> datetime:
    """Now on the farms' clock (Africa/Nairobi), whatever the site's System
    Settings time zone (Asia/Kolkata on kaitet.local) or the server (UTC) say."""
    return datetime.now(EAT)


def alert_name(warehouse, kind, observation, stage, iso_week) -> str:
    """A Scouting Alert's name: its unique key, hashed (spec §4)."""
    key = "|".join([warehouse or "", kind or "", observation or "", stage or "", iso_week or ""])
    return f"SA-{iso_week}-{hashlib.sha1(key.encode()).hexdigest()[:10]}"


def take_gate(key, seconds) -> bool:
    """True for the first caller in ``seconds``; atomic across workers."""
    cache = frappe.cache()
    return bool(cache.set(cache.make_key(key), 1, ex=int(seconds), nx=True))


def clear_gate(key) -> None:
    frappe.cache().delete_value(key)


# ── evaluation ─────────────────────────────────────────────────────────────


def banded_crops() -> list:
    """Crops with at least one usable band."""
    return [c for c in crop_catalog.catalog().get("crops", []) if _common.load_thresholds(c)]


def _figure(weeks, wh, week, kind, obs, stage, spec):
    """(figure, value) for one key, in its measure."""
    if spec["measure"] == B.COUNT:
        fig = weeks.count_figures(wh, week, kind, obs, stages=spec["count_stages"])
        return fig, (fig or {}).get("value")
    fig = weeks.figures(wh, week, kind, obs, stage or R.ANY)
    return fig, (fig or {}).get("prevalence")


def evaluate(crop, today=None) -> list:
    """Findings for every house scouted in its latest ISO week of the window ×
    every banded key. ``band`` "" (below Low) or "low" carries ``action`` None —
    those findings resolve alerts rather than raise them."""
    crop = crop_catalog.canonical(crop)
    keys = sorted(_common.load_thresholds(crop)) if crop else []
    if not keys:
        return []
    today = today or now_eat().date()
    from_date = (today - timedelta(days=EVAL_WINDOW_DAYS - 1)).isoformat()
    kinds = tuple(sorted({kind for kind, _obs, _stage in keys}))
    weeks = R.StationWeeks.load(from_date, today.isoformat(), crop, None, kinds=kinds, lookback_days=0)
    station = _common.station_word(crop)
    out = []
    for wh in weeks.warehouses():
        week, _previous = weeks.latest_pair(wh)
        if not week:
            continue
        for kind, obs, stage in keys:
            spec = _common.band_spec(crop, kind, obs, stage)
            if not spec:
                continue
            fig, value = _figure(weeks, wh, week, kind, obs, stage, spec)
            if value is None:
                continue
            band = B.band_of(value, spec["low"], spec["mod"], spec["high"])
            out.append({
                "crop": crop, "warehouse": wh, "kind": kind, "observation": obs,
                "stage": stage, "iso_week": week, "measure": spec["measure"],
                "unit": B.unit_label(spec["measure"], station), "value": value,
                "margin": fig.get("margin"), "reliability": fig.get("reliability") or "Low",
                "sections_scouted": fig.get("sections_scouted") or 0,
                "sections_total": fig.get("sections_total") or P.SECTIONS,
                "band": band, "action": B.action_for(band, fig.get("reliability")),
            })
    return out


# ── alerts ─────────────────────────────────────────────────────────────────


def _key_params(finding) -> dict:
    return {
        "wh": finding["warehouse"], "kind": KIND_LABEL[finding["kind"]],
        "obs": finding["observation"], "stage": finding["stage"] or "",
        "week": finding["iso_week"],
    }


def _existing(name):
    return frappe.db.get_value(
        DOCTYPE, name, ["name", "status", "notified_action", "notified"], as_dict=True,
    )


def _previous_live(params):
    rows = frappe.db.sql(
        f"""SELECT name, notified_action FROM `tabScouting Alert`
            WHERE {_KEY_SQL} AND iso_week < %(week)s AND status IN %(live)s
            ORDER BY iso_week DESC LIMIT 1""",
        {**params, "live": LIVE_STATES},
        as_dict=True,
    )
    return rows[0] if rows else None


def _resolve(params, include_week: bool) -> None:
    """Resolve the key's Open / Acknowledged alerts of earlier weeks (and of
    this week when ``include_week``). Converted alerts are left alone."""
    op = "<=" if include_week else "<"
    frappe.db.sql(
        f"""UPDATE `tabScouting Alert` SET status = 'Resolved', modified = %(now)s
            WHERE {_KEY_SQL} AND iso_week {op} %(week)s AND status IN %(open)s""",
        {**params, "open": OPEN_STATES, "now": frappe.utils.now()},
    )


def upsert(finding, now=None, _retry=True):
    """Write one finding. Returns the alert's name, or None for a finding below
    Moderate (which resolves the key's open alerts up to its week)."""
    now = now or now_eat()
    params = _key_params(finding)
    action = finding["action"]
    if not action:
        _resolve(params, include_week=True)
        return None

    name = alert_name(params["wh"], params["kind"], params["obs"], params["stage"], params["week"])
    fields = {
        "measure": finding["measure"], "value": finding["value"], "margin": finding["margin"],
        "reliability": finding["reliability"], "sections_scouted": finding["sections_scouted"],
        "sections_total": finding["sections_total"], "band": B.BAND_LABEL[finding["band"]],
        "action": action,
    }
    existing = _existing(name)
    if existing:
        frappe.db.set_value(DOCTYPE, name, fields)
        already, status = existing.notified_action, existing.status
    else:
        previous = _previous_live(params)
        doc = frappe.get_doc({
            "doctype": DOCTYPE, "crop": finding["crop"],
            "farm": frappe.db.get_value("Warehouse", params["wh"], "custom_farm"),
            "warehouse": params["wh"], "kind": params["kind"], "observation": params["obs"],
            "stage": params["stage"], "iso_week": params["week"], **fields,
            "status": "Open", "raised_on": now.date(),
            # Carried across weeks: the same action again is not news (D5).
            "notified_action": previous.notified_action if previous else None,
        })
        try:
            doc.insert(ignore_permissions=True)
        except frappe.DuplicateEntryError:
            # Another run inserted this key first; it owns the notification.
            if not _retry:
                raise
            return upsert(finding, now, _retry=False)
        already, status = doc.notified_action, "Open"
        existing = frappe._dict(notified="")

    updates = {}
    if status == "Resolved":
        # This week's figure dropped below Moderate and came back.
        updates.update(status="Open", raised_on=now.date())
    if B.escalates(already, action):
        updates.update(notified_action=action, raised_on=now.date())
        if status == "Acknowledged":
            updates["status"] = "Open"
        sent = _notify(name, finding, action)
        if sent:
            told = set(filter(None, (existing.notified or "").split("\n"))) | set(sent)
            updates["notified"] = "\n".join(sorted(told))
    if updates:
        frappe.db.set_value(DOCTYPE, name, updates)
    _resolve(params, include_week=False)   # a newer week supersedes older alerts
    return name


def _notify(name, finding, action) -> list:
    """In-app only (category "scouting"). Returns who was told. A recipient
    failure is logged and never blocks the alert."""
    try:
        farm = frappe.db.get_value("Warehouse", finding["warehouse"], "custom_farm")
        users = recipients_for(farm, finding["crop"], action)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "threshold check: recipients")
        return []
    stage = f" · {finding['stage']}" if finding["stage"] else ""
    value = B.format_value(finding["value"], finding["unit"])
    tail = " — the figure is unreliable, scout again before spraying" if action == B.SCOUT_FIRST else ""
    subject = (
        f"{action}: {finding['observation']}{stage} {value} in {finding['warehouse']} "
        f"({finding['iso_week']}){tail}"
    )
    margin = f"±{finding['margin']}" if finding["margin"] is not None else "too clustered to judge"
    body = (
        f"{subject}. {finding['crop']} · {margin} · "
        f"{finding['sections_scouted']}/{finding['sections_total']} sections scouted · "
        f"reliability {finding['reliability']}."
    )
    return notifications.notify(users, subject, body, DOCTYPE, name, category="scouting")


def check_crop(crop, today=None) -> dict:
    findings = evaluate(crop, today)
    alerts = [n for n in (upsert(f) for f in findings) if n]
    return {"findings": len(findings), "alerts": len(alerts)}


def run_threshold_check(today=None, force=False, commit=True) -> dict:
    """Hourly scheduler entry (hooks.py). One run per 50 minutes across workers;
    each crop commits on its own so one failing crop never loses the others."""
    if not force and not take_gate(CHECK_GATE_KEY, CHECK_GATE_SECONDS):
        return {"skipped": "ran less than 50 minutes ago"}
    if not frappe.db.table_exists(DOCTYPE):
        return {"skipped": "no Scouting Alert doctype"}
    _common.clear_threshold_cache()
    out = {"crops": {}, "errors": []}
    for crop in banded_crops():
        try:
            out["crops"][crop] = check_crop(crop, today)
            if commit:
                frappe.db.commit()
        except Exception:
            if commit:
                frappe.db.rollback()
            frappe.log_error(frappe.get_traceback(), f"threshold check: {crop}")
            out["errors"].append(crop)
    return out


# ── recipients (D4) ────────────────────────────────────────────────────────


def _roster(child, farm) -> list:
    if not farm or not frappe.db.table_exists(child):
        return []
    return frappe.get_all(child, filters={"parent": farm, "parenttype": "Farm"}, pluck="user")


def _gms(farm, crop) -> list:
    """SCP General Managers whose crop scope covers this farm."""
    out = []
    for user in notifications.users_for_role(GM_ROLE):
        farms = crop_scope.scoped_farms(crop, user)
        if farms is None or farm in farms:
            out.append(user)
    return out


def recipients_for(farm, crop, action) -> list:
    """D4. Alarming → the farm's Spray Plan Creators + Spray Supervisors, or its
    crop-scoped GMs when both rosters are empty (somebody must hear). Spray
    advised / Scout first → those + the farm's Spray Plan Approvers + the
    crop-scoped SCP General Managers."""
    base = _roster("Farm Spray Plan Creator", farm) + _roster("Farm Spray Supervisor", farm)
    if action == B.ALARMING:
        users = base or _gms(farm, crop)
    else:
        users = base + _roster("Farm Spray Plan Approver", farm) + _gms(farm, crop)
    return notifications._clean(users)


# ── endpoints ──────────────────────────────────────────────────────────────


def _assert_can_see(crop, farm) -> None:
    crop_scope.assert_crop(crop)
    farms = crop_scope.scoped_farms(crop)
    if farms is not None and farm not in farms:
        frappe.throw(f"{farm} is not a farm you have access to for {crop}.", frappe.PermissionError)


@frappe.whitelist()
def acknowledge_alert(name: str) -> dict:
    """Mark an Open alert seen. Anyone who may see its crop and farm may."""
    row = frappe.db.get_value(DOCTYPE, name, ["name", "crop", "farm", "status"], as_dict=True)
    if not row:
        frappe.throw(f"Scouting alert {name} does not exist.", frappe.DoesNotExistError)
    _assert_can_see(row.crop, row.farm)
    if row.status != "Open":
        return {"name": name, "status": row.status}
    frappe.db.set_value(DOCTYPE, name, {
        "status": "Acknowledged",
        "acknowledged_by": frappe.session.user,
        "acknowledged_on": frappe.utils.now_datetime(),
    })
    return {"name": name, "status": "Acknowledged"}


@frappe.whitelist()
def open_alerts(crop: str, farm: str | None = None, greenhouse: str | None = None) -> list:
    """Open + Acknowledged alerts of one crop on the farms the user may see,
    worst action first. Uncached: Acknowledge must show at once."""
    crop = crop_catalog.resolve_crop(crop)
    if not crop or not frappe.db.table_exists(DOCTYPE):
        return []
    farms = crop_scope.scoped_farms(crop)
    filters = {"crop": crop, "status": ["in", list(OPEN_STATES)]}
    if farm:
        if farms is not None and farm not in farms:
            return []
        filters["farm"] = farm
    elif farms is not None:
        if not farms:
            return []
        filters["farm"] = ["in", sorted(farms)]
    if greenhouse:
        filters["warehouse"] = greenhouse
    rows = frappe.get_all(DOCTYPE, filters=filters, fields=ALERT_FIELDS, limit_page_length=500)
    station = _common.station_word(crop)
    for r in rows:
        r["unit"] = B.unit_label(r.measure, station)
    rows.sort(key=lambda r: (
        -B.ACTION_RANK.get(r.action, 0), r.status != "Open", -(r.value or 0),
        r.warehouse or "", r.observation or "", r.stage or "",
    ))
    return rows
```

- [ ] **Step 4: Create the table and run the tests**

Run the reload from Step 1: **DB-EXEC** `frappe.reload_doc('upande_scp', 'doctype', 'scouting_alert', force=True); print(frappe.db.table_exists('Scouting Alert'))` → `True`.
Run: **DB-RUN** `test_scouting_alerts`
Expected: 20 tests OK.

- [ ] **Step 5: Schedule it**

In `upande_scp/hooks.py` (4-space block), add to `scheduler_events["hourly"]` after the `send_chemical_progress_email` entry:

```python
        # Thresholds → Scouting Alerts → in-app notifications (category
        # "scouting", never email). Self-gated: one run per 50 min across workers.
        "upande_scp.serverscripts.scouting.thresholds_check.run_threshold_check",
```
(The scheduler is disabled on kaitet.local — `enable_scheduler = 0` — so nothing runs here; Task 11 syncs the job types.)

- [ ] **Step 6: Regression gate and commit**

Run (one per DB-RUN): `test_scouting_alerts`, `test_threshold_measure_dashboards`, `test_notifications`, `test_prevalence_overview`, `test_dashboard_aggregates_overview` → all OK.

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/upande_scp/doctype/scouting_alert upande_scp/serverscripts/scouting/thresholds_check.py upande_scp/hooks.py upande_scp/serverscripts/tests/test_scouting_alerts.py
git commit -m "feat(scp): scouting alerts raised hourly from thresholds, notified in-app on escalation"
```

---
### Task 6: The 17:00 EAT digest — one email per person, only when there is something to say

**Files:**
- Create: `upande_scp/serverscripts/scouting/alert_digest.py`
- Modify: `upande_scp/hooks.py` (`scheduler_events["hourly"]`)
- Test: `upande_scp/serverscripts/tests/test_alert_digest.py`

**Interfaces:**
- Consumes: Task 5 `TC.DOCTYPE`, `TC.ALERT_FIELDS`, `TC.EAT`, `TC.now_eat`, `TC.take_gate`, `TC.clear_gate`, `TC.recipients_for`; `_common.station_word`; `threshold_bands.unit_label` / `format_value` / `ACTION_RANK`; `reports.send_chemical_progress_email._email_for(user) -> str | None` (the existing report email path: enabled user → address).
- Produces: `alert_digest.DIGEST_HOUR = 17`, `DIGEST_GATE_PREFIX`, `build_digests(day) -> {user: [alert]}`, `render(alerts, day) -> str`, `send_alert_digest(now=None) -> dict`.

- [ ] **Step 1: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_alert_digest.py`:

```python
"""The 17:00 EAT scouting-alert digest (thresholds spec §3, D4). DB test — direct
runner; frappe.sendmail is mocked in every test that could reach it."""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

import frappe

from upande_scp.serverscripts.scouting import alert_digest as D
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.tests import thresholds_fixture as TF
from upande_scp.serverscripts.tests.test_scouting_alerts import (
    SUN_20, U_APPROVER, U_CREATOR, U_GM, U_SUPER, AlertCase, at,
)


class TestDigest(AlertCase):
    def setUp(self):
        super().setUp()
        self.gate = f"{D.DIGEST_GATE_PREFIX}:2031-05-18"
        TC.clear_gate(self.gate)

    def tearDown(self):
        TC.clear_gate(self.gate)
        super().tearDown()

    def _two_alerts(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")                                    # Thrips 33.3 %
        TF.seed_week(self.gh2, TF.WEEK_20[0], crop="Rose", pest="Aphids", stage="Singles")   # Aphids 33.3 %
        TF.set_bands("Rose", "Thrips", 0, 10, 30)      # → Spray advised
        TF.set_bands("Rose", "Aphids", 0, 30, 60)      # → Alarming
        TC.check_crop("Rose", SUN_20)

    def test_one_email_per_recipient_listing_their_alerts(self):
        self._two_alerts()
        digests = D.build_digests(SUN_20)
        self.assertEqual(sorted(a.observation for a in digests[U_CREATOR]), ["Aphids", "Thrips"])
        self.assertEqual([a.observation for a in digests[U_APPROVER]], ["Thrips"])   # Alarming is not theirs (D4)
        with patch.object(frappe, "sendmail") as sendmail:
            out = D.send_alert_digest(at(SUN_20, 17, 5))
        self.assertEqual((sendmail.call_count, out["sent"]), (4, 4))
        by_to = {c.kwargs["recipients"][0]: c.kwargs for c in sendmail.call_args_list}
        self.assertEqual(set(by_to), {U_CREATOR, U_SUPER, U_APPROVER, U_GM})
        self.assertTrue(by_to[U_CREATOR]["subject"].endswith("(2)"))
        self.assertTrue(by_to[U_APPROVER]["subject"].endswith("(1)"))
        self.assertIn("Spray advised", by_to[U_CREATOR]["message"])
        self.assertIn("33.3%", by_to[U_CREATOR]["message"])

    def test_no_open_alert_today_means_no_email(self):
        with patch.object(frappe, "sendmail") as sendmail:
            out = D.send_alert_digest(at(SUN_20, 17, 5))
        sendmail.assert_not_called()
        self.assertEqual(out["sent"], 0)

    def test_acknowledged_and_resolved_alerts_are_left_out(self):
        self._two_alerts()
        names = frappe.get_all("Scouting Alert", filters={"iso_week": "2031-W20"}, pluck="name")
        frappe.db.set_value("Scouting Alert", names[0], "status", "Acknowledged")
        for name in names[1:]:
            frappe.db.set_value("Scouting Alert", name, "status", "Resolved")
        self.assertEqual(D.build_digests(SUN_20), {})

    def test_the_digest_follows_nairobi_time_not_the_site_or_server_clock(self):
        self._two_alerts()
        with patch.object(frappe, "sendmail") as sendmail:
            early = D.send_alert_digest(at(SUN_20, 16, 59))
            # 17:00 on kaitet.local's own System Settings clock (Asia/Kolkata) is 14:30 EAT.
            site_17 = D.send_alert_digest(datetime(2031, 5, 18, 17, 0, tzinfo=ZoneInfo("Asia/Kolkata")))
            # 14:05 UTC — the server's clock — is 17:05 EAT.
            utc_14 = D.send_alert_digest(datetime(2031, 5, 18, 14, 5, tzinfo=timezone.utc))
        self.assertEqual(early, {"skipped": "not the send hour", "hour": 16})
        self.assertEqual(site_17, {"skipped": "not the send hour", "hour": 14})
        self.assertEqual(utc_14["sent"], 4)
        self.assertEqual(sendmail.call_count, 4)
        self.clock.stop()
        try:
            self.assertEqual(TC.now_eat().utcoffset(), timedelta(hours=3))
        finally:
            self.clock.start()

    def test_twice_in_the_hour_sends_once(self):
        self._two_alerts()
        with patch.object(frappe, "sendmail") as sendmail:
            D.send_alert_digest(at(SUN_20, 17, 5))
            again = D.send_alert_digest(at(SUN_20, 17, 50))
        self.assertEqual(again, {"skipped": "already sent today"})
        self.assertEqual(sendmail.call_count, 4)
```

- [ ] **Step 2: Run them to see them fail**

Run: **DB-RUN** `test_alert_digest`
Expected: FAIL at import — `cannot import name 'alert_digest'`.

- [ ] **Step 3: Write `scouting/alert_digest.py`**

```python
"""The daily scouting-alert digest: one email per person at 17:00 EAT (spec §3, D4).

The hourly scheduler calls ``send_alert_digest``. It sends only in the 17:00
hour on the farms' clock (Africa/Nairobi — not the site's System Settings time
zone, Asia/Kolkata on kaitet.local, and not the server's UTC), and only once
that EAT day (Redis ``SET NX`` per date, so two workers cannot both send).
Each recipient gets one email listing the Open alerts raised or escalated that
day on the farms D4 would notify them for — recomputed here, so an alert
carried silently into a new week still reaches the digest. No alerts, no email.
Live email sits at the free-Gmail cap, so this is the only email the feature
sends; there is never one email per alert.
"""

import frappe

from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.reports.send_chemical_progress_email import _email_for
from upande_scp.serverscripts.scouting import thresholds_check as TC

DIGEST_HOUR = 17
DIGEST_GATE_PREFIX = "scp:alert_digest"
DIGEST_GATE_SECONDS = 2 * 24 * 3600


def build_digests(day) -> dict:
    """``{user: [alert]}`` — Open alerts raised on ``day`` (EAT), per D4 recipient."""
    if not frappe.db.table_exists(TC.DOCTYPE):
        return {}
    rows = frappe.get_all(
        TC.DOCTYPE,
        filters={"status": "Open", "raised_on": day},
        fields=TC.ALERT_FIELDS,
        order_by="farm asc, warehouse asc, observation asc",
    )
    stations: dict = {}
    out: dict = {}
    for r in rows:
        if r.crop not in stations:
            stations[r.crop] = _common.station_word(r.crop)
        r["unit"] = B.unit_label(r.measure, stations[r.crop])
        for user in TC.recipients_for(r.farm, r.crop, r.action):
            out.setdefault(user, []).append(r)
    for alerts in out.values():
        alerts.sort(key=lambda r: (
            -B.ACTION_RANK.get(r.action, 0), r.farm or "", r.warehouse or "", r.observation or "",
        ))
    return out


def render(alerts, day) -> str:
    """Compact HTML: one table, worst first. No emoji, no accent strips."""
    esc = frappe.utils.escape_html
    cell = "padding:4px 8px"
    rows = "".join(
        "<tr>"
        f"<td style='{cell}'><b>{esc(a.action)}</b></td>"
        f"<td style='{cell}'>{esc(a.warehouse)}</td>"
        f"<td style='{cell}'>{esc(a.observation)}{(' · ' + esc(a.stage)) if a.stage else ''}</td>"
        f"<td style='{cell};text-align:right'>{esc(B.format_value(a.value, a.unit))}</td>"
        f"<td style='{cell}'>{esc(a.reliability or '')}</td>"
        f"<td style='{cell}'>{esc(a.iso_week)}</td>"
        "</tr>"
        for a in alerts
    )
    head = "".join(
        f"<th align='{align}' style='{cell}'>{label}</th>"
        for label, align in (("Action", "left"), ("Greenhouse / block", "left"), ("Pest / disease", "left"),
                             ("Figure", "right"), ("Reliability", "left"), ("Week", "left"))
    )
    plural = "s" if len(alerts) != 1 else ""
    return (
        "<div style='font-family:Poppins,Arial,sans-serif;font-size:13px;color:#1a1a1a'>"
        f"<p>{len(alerts)} scouting alert{plural} raised on "
        f"{frappe.utils.formatdate(day, 'dd-MMM-yyyy')} on your farms. "
        "Scout first means the figure is unreliable: scout again before spraying.</p>"
        f"<table style='border-collapse:collapse'><tr style='background:#f2f2f2'>{head}</tr>{rows}</table>"
        "</div>"
    )


def send_alert_digest(now=None) -> dict:
    """Hourly scheduler entry: sends in the 17:00 EAT hour, once per EAT day."""
    now = (now or TC.now_eat()).astimezone(TC.EAT)
    if now.hour != DIGEST_HOUR:
        return {"skipped": "not the send hour", "hour": now.hour}
    day = now.date()
    if not TC.take_gate(f"{DIGEST_GATE_PREFIX}:{day.isoformat()}", DIGEST_GATE_SECONDS):
        return {"skipped": "already sent today"}
    sent = []
    for user, alerts in sorted(build_digests(day).items()):
        email = _email_for(user)
        if not email:
            continue
        try:
            frappe.sendmail(
                recipients=[email],
                subject=f"Scouting alerts — {frappe.utils.formatdate(day, 'dd-MMM-yyyy')} ({len(alerts)})",
                message=render(alerts, day),
                reference_doctype=TC.DOCTYPE,
            )
            sent.append(email)
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"scouting alert digest: {email}")
    return {"sent": len(sent), "recipients": sent}
```

- [ ] **Step 4: Schedule it**

In `upande_scp/hooks.py`, directly after the `run_threshold_check` entry added in Task 5:

```python
        # The day's scouting alerts, one email per person, at 17:00 EAT
        # (gated on Africa/Nairobi, whatever the site time zone; once per day).
        "upande_scp.serverscripts.scouting.alert_digest.send_alert_digest",
```

- [ ] **Step 5: Run to pass**

Run: **DB-RUN** `test_alert_digest` → 5 OK. **DB-RUN** `test_scouting_alerts` → still 20 OK.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/scouting/alert_digest.py upande_scp/hooks.py upande_scp/serverscripts/tests/test_alert_digest.py
git commit -m "feat(scp): one scouting-alert digest email per person at 17:00 eat"
```

---

### Task 7: The block report and the Jobsheet judge the same figure (D8)

**Files:**
- Modify: `upande_scp/serverscripts/scouting/thresholds_check.py` (append `figures_for_houses`, `house_figures`)
- Modify: `upande_scp/serverscripts/reports/block_weekly_report.py` (tabs)
- Modify: `upande_scp/serverscripts/tests/test_block_weekly_report.py` (tabs)
- Modify: `frontend/src/lib/pest-bands.ts`, `frontend/src/lib/pest-bands.test.ts`, `frontend/src/pages/avocado/AvocadoHeatMap.tsx`
- Create: `frontend/src/lib/threshold-figures-api.ts`

**Interfaces:**
- Consumes: Task 3 `band_spec`, `station_word`, `load_thresholds`, `StationWeeks.observations`; Task 5 `_figure`, `_assert_can_see`.
- Produces:
  - `TC.figures_for_houses(crop, houses, from_date, to_date) -> {house: {pest: {"measure", "unit", "value", "margin", "reliability", "sections_scouted", "sections_total", "band", "action", "week"}}}`
  - whitelisted `TC.house_figures(crop, warehouse, from_date, to_date) -> {pest: figure}`
  - `block_weekly_report._per_hectare(total, area_ha) -> float | None`; `_band` removed; `_thresholds_for_crop(crop) -> {pest: {"measure", "low", "moderate", "high"}}`; sheet column 3 = `Count / ha`, pests from column 4
  - TS `HouseFigure`, `judgedLabel(f) -> string | null`, `perHectare(count, areaHa) -> number | null`, `fetchHouseFigures(crop, warehouse, from, to)`; `bandFor`, `judgedValue`, `specsByPest`, `BandSpec` removed

- [ ] **Step 1: Write the failing tests**

In `upande_scp/serverscripts/tests/test_block_weekly_report.py` (tabs):
1. Imports — after `from upande_scp.serverscripts.reports import block_weekly_report as R` add:

```python
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import thresholds_fixture as TF

PEST = "Fruit fly (Ceratitis)"
```
2. Replace the comment block and `FIRST_PEST_COL = 3` with:

```python
# Header on row 6 (an explanatory line sits above it). Block, Area (ha) and
# Count / ha lead; the pests start at column 4 since thresholds piece 3a kept
# count per hectare as a column (D8).
HEADER_ROW = 6
FIRST_BLOCK_ROW = HEADER_ROW + 1
FIRST_PEST_COL = 4
```
3. In `test_pests_are_columns_and_cells_are_counts`, after `self.assertEqual(header[1], "Area (ha)")` add `self.assertEqual(header[2], "Count / ha")`.
4. Replace the whole `class TestSeverityBands(unittest.TestCase):` (through `test_per_warehouse_compares_the_raw_count`) with:

```python
class TestPerHectare(unittest.TestCase):
	"""Count per hectare stays a column (thresholds D8). Pure logic."""

	def test_divides_the_weeks_total_by_the_blocks_area(self):
		self.assertEqual(R._per_hectare(30, 3.0), 10.0)
		self.assertEqual(R._per_hectare(30, 30.0), 1.0)

	def test_no_area_is_not_a_zero_area(self):
		"""Dividing by a missing denominator would invent a figure."""
		self.assertIsNone(R._per_hectare(30, None))
		self.assertIsNone(R._per_hectare(30, 0))


class TestShadingFollowsTheFigure(unittest.TestCase):
	"""The sheet shades with the alerts' figure and bands (D8). DB, rolled back;
	2031-W20 holds only what the test seeds."""

	def setUp(self):
		frappe.set_user("Administrator")
		self.block = F.avocado_block()
		TF.clear_all_bands("Avocado")

	def tearDown(self):
		frappe.set_user("Administrator")
		_common.clear_threshold_cache()
		frappe.db.rollback()

	def _seed(self):
		TF.seed_week(self.block, TF.WEEK_20[0], crop="Avocado", pest=PEST, stage="Adult", count=3, block=True)

	def _cell(self, pest):
		from openpyxl import load_workbook

		ws = load_workbook(io.BytesIO(R.build_workbook_bytes("Avocado", "Lokitela", 2031, 20))).active
		header = {ws.cell(row=HEADER_ROW, column=c).value: c for c in range(1, ws.max_column + 1)}
		row = next(r for r in range(FIRST_BLOCK_ROW, ws.max_row + 1) if ws.cell(row=r, column=1).value == self.block)
		return ws, row, ws.cell(row=row, column=header[pest])

	def test_a_count_row_shades_on_the_average_count_per_tree(self):
		TF.set_bands("Avocado", PEST, 0, 1, 2, measure="Count")
		self._seed()
		ws, row, cell = self._cell(PEST)
		self.assertEqual(cell.value, 27)                              # still the week's count: 9 trees × 3
		self.assertTrue(cell.fill.fgColor.rgb.endswith("F7B9B9"))     # 1.0 per tree → Moderate
		area = frappe.db.get_value("Warehouse", self.block, "custom_area_ha")
		self.assertEqual(ws.cell(row=row, column=3).value, round(27 / float(area), 2))

	def test_a_percentage_row_shades_on_the_share_of_trees(self):
		TF.set_bands("Avocado", PEST, 0, 10, 30)
		self._seed()
		_ws, _row, cell = self._cell(PEST)
		self.assertTrue(cell.fill.fgColor.rgb.endswith("E98080"))     # 33.3 % → High

	def test_misordered_bands_leave_the_cell_unshaded(self):
		TF.set_bands("Avocado", PEST, 1, 0.4, 2)
		self._seed()
		_ws, _row, cell = self._cell(PEST)
		self.assertNotEqual(cell.fill.fill_type, "solid")
```

Replace `frontend/src/lib/pest-bands.test.ts` with:

```ts
import { describe, expect, it } from "vitest";

import { bandRank, judgedLabel, perHectare, type HouseFigure } from "./pest-bands";

/** The figure and band come from the server (thresholds_check.figures_for_houses),
 *  the same ones test_block_weekly_report shades the weekly sheet with. */
const fig = (over: Partial<HouseFigure> = {}): HouseFigure => ({
  measure: "Count", unit: "per tree", value: 1.2, margin: 0.4, reliability: "Fair",
  sections_scouted: 9, sections_total: 9, band: "moderate", action: "Alarming",
  week: "2031-W20", ...over,
});

describe("judgedLabel", () => {
  it("prints the figure in its measure's unit", () => {
    expect(judgedLabel(fig())).toBe("1.2 per tree");
    expect(judgedLabel(fig({ measure: "Percentage", unit: "%", value: 33.3 }))).toBe("33.3%");
  });

  it("has nothing to print without a figure", () => {
    expect(judgedLabel(null)).toBeNull();
    expect(judgedLabel(fig({ value: null }))).toBeNull();
  });
});

describe("perHectare", () => {
  it("divides the week's count by the block's hectares", () => {
    expect(perHectare(30, 3)).toBe(10);
    expect(perHectare(27, 3.4)).toBe(7.94);
  });

  it("refuses without an area rather than inventing one", () => {
    expect(perHectare(30, null)).toBeNull();
    expect(perHectare(30, 0)).toBeNull();
  });
});

describe("bandRank", () => {
  it("ranks pressure, putting the unjudged last rather than dropping them", () => {
    const order = [null, "", "low", "moderate", "high"] as const;
    const ranked = [...order].sort((a, b) => bandRank(b) - bandRank(a));
    expect(ranked.slice(0, 3)).toEqual(["high", "moderate", "low"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: **DB-RUN** `test_block_weekly_report` → FAIL (`module ... has no attribute '_per_hectare'`; header[2] is a pest).
Run: `cd frontend && npx vitest run src/lib/pest-bands.test.ts` → FAIL (`judgedLabel` is not exported).

- [ ] **Step 3: Server figures for houses**

Append to `upande_scp/serverscripts/scouting/thresholds_check.py`:

```python
# ── figures for the block report and the Jobsheet (D8) ────────────────────


def figures_for_houses(crop, houses, from_date, to_date) -> dict:
    """``{house: {pest: figure}}`` — each house's latest scouted ISO week in the
    window, every pest recorded that week, judged exactly as the alerts judge
    it (same measure, figure and row bands). ``band`` is None when the pest has
    no usable bands."""
    crop = crop_catalog.canonical(crop)
    houses = sorted({h for h in (houses or ()) if h})
    if not crop or not houses:
        return {}
    weeks = R.StationWeeks.load(from_date, to_date, crop, houses, kinds=("pest",), lookback_days=0)
    station = _common.station_word(crop)
    out = {}
    for wh in weeks.warehouses():
        week, _previous = weeks.latest_pair(wh)
        per = {}
        for obs in weeks.observations(wh, week, "pest"):
            spec = _common.band_spec(crop, "pest", obs, "")
            measure = spec["measure"] if spec else B.PERCENTAGE
            fig, value = _figure(weeks, wh, week, "pest", obs, "", spec or {"measure": B.PERCENTAGE})
            fig = fig or {}
            band = B.band_of(value, spec["low"], spec["mod"], spec["high"]) if spec else None
            per[obs] = {
                "measure": measure, "unit": B.unit_label(measure, station), "value": value,
                "margin": fig.get("margin"), "reliability": fig.get("reliability") or "Low",
                "sections_scouted": fig.get("sections_scouted") or 0,
                "sections_total": fig.get("sections_total") or P.SECTIONS,
                "band": band, "action": B.action_for(band, fig.get("reliability")), "week": week,
            }
        out[wh] = per
    return out


@frappe.whitelist()
def house_figures(crop: str, warehouse: str, from_date: str, to_date: str) -> dict:
    """The Jobsheet's per-pest figures for one block or greenhouse."""
    crop = crop_catalog.resolve_crop(crop)
    if not crop or not warehouse:
        return {}
    _assert_can_see(crop, frappe.db.get_value("Warehouse", warehouse, "custom_farm"))
    return figures_for_houses(crop, [warehouse], from_date, to_date).get(warehouse, {})
```

- [ ] **Step 4: The block report**

In `reports/block_weekly_report.py` (tabs):
1. Imports — after `from upande_scp.serverscripts.common import crop_scope` add:

```python
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.scouting import thresholds_check
```
2. Replace the whole `_thresholds_for_crop` function with:

```python
def _thresholds_for_crop(crop: str) -> dict:
	"""{pest: {"measure", "low", "moderate", "high"}} — the crop's row bands, for
	the legend. Read through `_common.load_thresholds`, so the legend lists exactly
	the bands the shading (and the dashboards and alerts) judged with: a pest with
	no bands, or misordered ones, is absent (thresholds spec D3)."""
	out = {}
	for (kind, obs, stage), spec in _common.load_thresholds(crop).items():
		if kind != "pest" or stage or not obs:
			continue
		out[obs] = {
			"measure": spec["measure"],
			"low": spec["low"],
			"moderate": spec["mod"],
			"high": spec["high"],
		}
	return out
```
3. Replace the whole `_band` function with:

```python
def _per_hectare(total: float, area_ha: float | None):
	"""The week's count over the block's hectares, or None without an area —
	dividing by a missing denominator would invent a figure (Endebess's coffee
	blocks carry none). Kept as a column, not a band (thresholds D8)."""
	if not area_ha:
		return None
	return round(float(total or 0) / float(area_ha), 2)
```
4. In `build_workbook_bytes`:
   - after `areas = _block_areas(blocks)` add
     `	figs = thresholds_check.figures_for_houses(crop, blocks, str(monday), str(sunday))` and
     `	station = _common.station_word(crop)`
   - replace the `ws["A4"] = (...)` string with:

```python
	ws["A4"] = (
		"Shading is the severity band from the crop's thresholds, judged on the same "
		"figure as the dashboards and alerts: the share of scouted trees carrying the "
		"pest (Percentage) or the average count per scouted tree (Count), over the "
		"block's 3 × 3 sections. Count / ha is the week's total over the block's "
		"area; a block with no area shows —."
	)
```
   - replace `first_pest_col = 3` with `first_pest_col = 4`, and after `ws.cell(row=header_row, column=2, value="Area (ha)")` add `	ws.cell(row=header_row, column=3, value="Count / ha")`
   - replace

```python
			if value:
				band = _band(value, thresholds.get(pest), area)
				if band:
					cell.fill = band_fills[band]
```
with
```python
			band = (figs.get(block, {}).get(pest) or {}).get("band")
			if value and band:
				cell.fill = band_fills[band]
```
   - replace `		ws.cell(row=r, column=first_pest_col + len(pests), value=row_total)` with

```python
		ws.cell(row=r, column=first_pest_col + len(pests), value=row_total)
		per_ha = _per_hectare(row_total, area)
		per_ha_cell = ws.cell(row=r, column=3, value=per_ha if per_ha is not None else "—")
		if per_ha is None:
			per_ha_cell.alignment = Alignment(horizontal="center")
```
   - replace

```python
	if total_area:
		ws.cell(row=total_row, column=2, value=round(total_area, 2)).font = Font(bold=True)
```
with
```python
	if total_area:
		ws.cell(row=total_row, column=2, value=round(total_area, 2)).font = Font(bold=True)
		ws.cell(row=total_row, column=3, value=_per_hectare(sum(column_totals), total_area)).font = Font(bold=True)
```
   (the `column_totals` loop runs before the total row is written, so `sum(column_totals)` is final there.)
   - in the legend, replace `ws.cell(row=legend_row, column=2, value="Unit")` with `ws.cell(row=legend_row, column=2, value="Measure")`, and `ws.cell(row=legend_row + n, column=2, value=spec["unit"] or "Per Warehouse")` with `ws.cell(row=legend_row + n, column=2, value=f"{spec['measure']} ({B.unit_label(spec['measure'], station)})")`
   - in the missing-area note, replace `"per-hectare thresholds could not be judged. Set Area (ha) on the "` with `"count per hectare cannot be shown. Set Area (ha) on the "`
   - after `ws.column_dimensions["B"].width = 10` add `	ws.column_dimensions["C"].width = 11`
   - the module docstring's "What a cell holds" paragraph stays true; append one sentence to it: `Shading comes from \`thresholds_check.figures_for_houses\`, the alerts' own figure.`

- [ ] **Step 5: The Jobsheet reads the server's figure**

Replace `frontend/src/lib/pest-bands.ts` with:

```ts
/**
 * Severity bands as the server judged them, for the avocado Jobsheet.
 *
 * The band is computed server-side (`scouting/thresholds_check.figures_for_houses`)
 * from the same figure and bands the dashboards, the alerts and the weekly block
 * sheet use (thresholds spec D8): the share of scouted trees carrying a pest
 * (Percentage) or the average count per scouted tree (Count). The browser only
 * formats it. Count per hectare stays a plain fact beside it.
 */

/** "" means judged and below the lowest band — NOT the same as `null`, which
 *  means it cannot be judged at all. */
export type Band = "high" | "moderate" | "low" | "" | null;

export const BAND_LABEL: Record<"high" | "moderate" | "low", string> = {
  high: "High",
  moderate: "Moderate",
  low: "Low",
};

/** One hue, three depths — the same ramp the weekly sheet shades with. */
export const BAND_COLOR: Record<"high" | "moderate" | "low", string> = {
  high: "#9b1c1c",
  moderate: "#cf4a4a",
  low: "#e08585",
};

export interface HouseFigure {
  measure: "Percentage" | "Count";
  /** "%", "per tree" or "per zone" */
  unit: string;
  value: number | null;
  margin: number | null;
  reliability: "Good" | "Fair" | "Low";
  sections_scouted: number;
  sections_total: number;
  band: Band;
  action: "Alarming" | "Spray advised" | "Scout first" | null;
  week: string;
}

/** "33.3%" / "1.2 per tree" — the figure the band was judged on. */
export function judgedLabel(f: HouseFigure | null | undefined): string | null {
  if (!f || f.value == null) return null;
  return f.unit === "%" ? `${f.value}%` : `${f.value} ${f.unit}`;
}

/** The week's count over the block's hectares (2 dp); null without an area. */
export function perHectare(count: number, areaHa: number | null | undefined): number | null {
  if (!areaHa) return null;
  return Math.round((Number(count || 0) / Number(areaHa)) * 100) / 100;
}

/** Sort key so the worst pressure leads. Unjudged pests sort below judged
 *  ones rather than being dropped — the count is still a fact. */
export function bandRank(band: Band): number {
  if (band === "high") return 3;
  if (band === "moderate") return 2;
  if (band === "low") return 1;
  return 0;
}
```

Create `frontend/src/lib/threshold-figures-api.ts`:

```ts
import { call } from "./frappe";
import type { HouseFigure } from "./pest-bands";

/** Per-pest figures for one block or greenhouse — its latest scouted ISO week in
 *  the window, judged on the server like the alerts (thresholds spec D8). */
export async function fetchHouseFigures(
  crop: string,
  warehouse: string,
  from: string,
  to: string,
): Promise<Record<string, HouseFigure>> {
  try {
    const r = await call<Record<string, HouseFigure>>(
      "upande_scp.serverscripts.scouting.thresholds_check.house_figures",
      { crop, warehouse, from_date: from, to_date: to },
    );
    return r || {};
  } catch {
    return {};
  }
}
```

In `frontend/src/pages/avocado/AvocadoHeatMap.tsx`:
1. Delete `import { getThresholds, type ThresholdPestRow } from "@/lib/thresholds-api";`. Replace the `@/lib/pest-bands` import with
   `import { BAND_COLOR, BAND_LABEL, bandRank, judgedLabel, perHectare, type Band, type HouseFigure } from "@/lib/pest-bands";`
   and add `import { fetchHouseFigures } from "@/lib/threshold-figures-api";`.
2. Replace `const [pestSpecs, setPestSpecs] = useState<Record<string, ReturnType<typeof specsByPest>[string]>>({});` with `const [houseFigs, setHouseFigs] = useState<Record<string, HouseFigure>>({});`, and the comment above it with `// The server's per-pest figures for the selected block, and block areas for count per hectare.`
3. Replace

```tsx
    void Promise.all([
      getThresholds(filters.crop).catch(() => null),
      fetchBlockAreas({ farm }).catch(() => ({})),
    ]).then(([bundle, areas]) => {
      if (cancelled) return;
      setPestSpecs(specsByPest((bundle?.pests as ThresholdPestRow[]) || []));
      setBlockAreas(areas || {});
    });
    return () => {
      cancelled = true;
    };
  }, [filters.crop, filters.farm]);
```
with
```tsx
    void fetchBlockAreas({ farm })
      .catch(() => ({}))
      .then((areas) => {
        if (!cancelled) setBlockAreas(areas || {});
      });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);
```
4. Directly after the `const selectedAgg = useMemo(...)` block add:

```tsx
  // Each pest of the selected block, judged on the server exactly as the
  // alerts and the weekly sheet judge it (thresholds D8).
  const selectedBlock = selectedAgg?.block ?? null;
  useEffect(() => {
    if (!selectedBlock) {
      setHouseFigs({});
      return;
    }
    let cancelled = false;
    void fetchHouseFigures(filters.crop, selectedBlock, filters.from, filters.to).then((f) => {
      if (!cancelled) setHouseFigs(f);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedBlock, filters.crop, filters.from, filters.to]);
```
5. Replace the whole `const rankedPests = useMemo(...)` (and its comment) with:

```tsx
  // Pests for the selected block, ranked by the band the server judged — the
  // pest furthest over its threshold leads, not merely the biggest count. A pest
  // with no band keeps its place by count rather than being dropped.
  const rankedPests = useMemo(() => {
    if (!selectedAgg) return [] as Array<readonly [string, number, Band, HouseFigure | null]>;
    return Array.from(selectedAgg.pests.entries())
      .map(([name, count]) => {
        const f = houseFigs[name] ?? null;
        return [name, count, f?.band ?? null, f] as const;
      })
      .sort((a, b) => bandRank(b[2]) - bandRank(a[2]) || b[1] - a[1])
      .slice(0, 8);
  }, [selectedAgg, houseFigs]);
```
6. Replace

```tsx
                                {(judged as { value: number }).value.toFixed(1)}
                                {(judged as { suffix: string }).suffix}
```
with
```tsx
                                {judgedLabel(judged as HouseFigure)}
```
7. Replace

```tsx
                      {selectedAgg.obs} observations · {selectedAgg.trees.size}{" "}
                      trees scouted
```
with
```tsx
                      {selectedAgg.obs} observations · {selectedAgg.trees.size}{" "}
                      trees scouted
                      {(() => {
                        const ha = perHectare(
                          Array.from(selectedAgg.pests.values()).reduce((s, c) => s + c, 0),
                          blockAreas[selectedAgg.block],
                        );
                        return ha != null ? ` · ${ha} pests / ha` : "";
                      })()}
```

- [ ] **Step 6: Run to pass**

Run: **DB-RUN** `test_block_weekly_report` → all OK.
Run: `cd frontend && npx vitest run src/lib/pest-bands.test.ts src/pages/avocado && npx tsc --noEmit -p tsconfig.app.json` → pass, no type errors (`grep -rn "bandFor\|judgedValue\|specsByPest" frontend/src` → no hits).

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/scouting/thresholds_check.py upande_scp/serverscripts/reports/block_weekly_report.py upande_scp/serverscripts/tests/test_block_weekly_report.py frontend/src/lib/pest-bands.ts frontend/src/lib/pest-bands.test.ts frontend/src/lib/threshold-figures-api.ts frontend/src/pages/avocado/AvocadoHeatMap.tsx
git commit -m "feat(scp): block sheet and jobsheet shade with the alerts' figure; count per hectare kept"
```

---
### Task 8: The Thresholds editor and the Trends reference lines speak the measure

**Files:**
- Create: `frontend/src/lib/threshold-measure.ts`, `frontend/src/lib/threshold-measure.test.ts`
- Modify: `frontend/src/lib/thresholds-api.ts`
- Modify (full rewrite below): `frontend/src/components/settings/ThresholdsTab.tsx`; Modify: `frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx`
- Modify: `frontend/src/pages/Trends.tsx:5-37,116-152`, `frontend/src/pages/trends/ChartPanel.tsx:106-150,445-452,~580,655-700`
- Create: `frontend/src/pages/trends/__tests__/count-bands.test.ts`

**Interfaces:**
- Consumes: Task 2 payload (`station`, `measure`, `count_allowed`, `invalid`, stage `reading_type`).
- Produces:
  - `threshold-measure.ts`: `type Measure`, `bandsAscending(low, moderate, high)`, `effectiveMeasure(rowMeasure, readingType?)`, `unitFor(measure, station)`, `formatBandValue(value, unit)`, `interface MeasuredBand { low?, moderate?, high?, measure, unit }`, `thresholdMapFromBundle(bundle) -> Map<string, MeasuredBand>`, `countBandNote(band) -> string`
  - `thresholds-api.ts`: `ThresholdStageRow.reading_type`, rows' `measure` / `count_allowed` / `invalid`, `ThresholdsBundle.station`; `unit` removed
  - `ThresholdsTab` exports `rowInvalid(row)`; `ChartPanel`'s `ThresholdBand` gains `measure?` / `unit?`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/threshold-measure.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  bandsAscending,
  countBandNote,
  effectiveMeasure,
  formatBandValue,
  thresholdMapFromBundle,
  unitFor,
} from "./threshold-measure";
import type { ThresholdsBundle } from "./thresholds-api";

/** Mirrors test_threshold_core_pure (threshold_bands.py) — the server re-checks on save. */
describe("bandsAscending", () => {
  it("needs the bands that are set to rise strictly", () => {
    expect(bandsAscending(1, 2, 3)).toBe(true);
    expect(bandsAscending(0, 1, 2)).toBe(true);
    expect(bandsAscending(0, 0, 0)).toBe(true);
    expect(bandsAscending(1, 0.4, 2)).toBe(false); // Rose Thrips on kaitet.local
    expect(bandsAscending(5, 5, 10)).toBe(false);
    expect(bandsAscending(-1, 2, 3)).toBe(false);
  });
});

describe("measure and unit", () => {
  it("reads a tick-box stage under a Count row as a share", () => {
    expect(effectiveMeasure("Count")).toBe("Count");
    expect(effectiveMeasure("Count", "Count")).toBe("Count");
    expect(effectiveMeasure("Count", "Checkbox")).toBe("Percentage");
    expect(effectiveMeasure("Percentage", "Count")).toBe("Percentage");
  });

  it("labels the unit per crop station", () => {
    expect(unitFor("Percentage", "tree")).toBe("%");
    expect(unitFor("Count", "tree")).toBe("per tree");
    expect(unitFor("Count", "zone")).toBe("per zone");
    expect(formatBandValue(30, "%")).toBe("30%");
    expect(formatBandValue(5, "per zone")).toBe("5 per zone");
  });
});

const bundle: ThresholdsBundle = {
  crop: "Rose",
  station: "zone",
  pests: [
    {
      row: "p1", pest: "Thrips", measure: "Count", count_allowed: true, invalid: false,
      low: 0, moderate: 1, high: 2,
      stages: [
        { row: "s1", stage: "Adult", reading_type: "Count", low: 0, moderate: 3, high: 6 },
        { row: "s2", stage: "Damages", reading_type: "Checkbox", low: 0, moderate: 10, high: 30 },
      ],
    },
    { row: "p2", pest: "Aphids", measure: "Percentage", count_allowed: true, invalid: true,
      low: 1, moderate: 0.4, high: 2, stages: [] },
    { row: "p3", pest: "Mites", measure: "Percentage", count_allowed: true, invalid: false,
      low: 0, moderate: 0, high: 0, stages: [] },
  ],
  diseases: [
    { row: "d1", disease: "Botrytis", measure: "Percentage", count_allowed: false, invalid: false,
      low: 0, moderate: 20, high: 40, stages: [] },
  ],
};

describe("thresholdMapFromBundle", () => {
  it("keys bands by kind, name and stage with their measure and unit", () => {
    const m = thresholdMapFromBundle(bundle);
    expect(m.get("pest::Thrips::")).toEqual({ low: 0, moderate: 1, high: 2, measure: "Count", unit: "per zone" });
    expect(m.get("pest::Thrips::Adult")?.unit).toBe("per zone");
    expect(m.get("pest::Thrips::Damages")).toEqual({ low: 0, moderate: 10, high: 30, measure: "Percentage", unit: "%" });
    expect(m.get("disease::Botrytis::")?.unit).toBe("%");
  });

  it("leaves out unset and misordered bands, as the server does", () => {
    const m = thresholdMapFromBundle(bundle);
    expect(m.has("pest::Aphids::")).toBe(false);
    expect(m.has("pest::Mites::")).toBe(false);
    expect(thresholdMapFromBundle(null).size).toBe(0);
  });

  it("describes count bands Trends cannot draw on a share axis", () => {
    expect(countBandNote({ low: 0, moderate: 1, high: 2, measure: "Count", unit: "per zone" })).toBe(
      "Count thresholds (per zone): Mod 1 · High 2 — Trends plots the share of stations, so they are not drawn here",
    );
  });
});
```

Create `frontend/src/pages/trends/__tests__/count-bands.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("Trends reference lines follow the row's measure", () => {
  const panel = src("../ChartPanel.tsx");
  const page = src("../../Trends.tsx");

  it("draws only share bands and describes count bands instead", () => {
    expect(panel).toContain('measuredBand.measure !== "Count"');
    expect(panel).toContain('data-testid="count-band-note"');
    expect(panel).toContain("countBandNote(");
  });

  it("labels each line in the band's unit", () => {
    expect(panel).toContain("formatBandValue(value, unit)");
    expect(panel).not.toMatch(/\$\{value\}%/);
  });

  it("builds the lookup from the bundle helper", () => {
    expect(page).toContain("thresholdMapFromBundle(thresholdBundle)");
  });
});
```

In `frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx`:
1. Change the first import line to `import { render, screen, waitFor, within } from "@testing-library/react";`.
2. Append inside `describe("ThresholdsTab", ...)`:

```tsx
  const rose = {
    crop: "Rose",
    station: "zone",
    pests: [
      {
        row: "p1", pest: "Thrips", measure: "Count", count_allowed: true, invalid: false,
        low: 0, moderate: 1, high: 2,
        stages: [
          { row: "s1", stage: "Adult", reading_type: "Count", low: 0, moderate: 0, high: 0, invalid: false },
          { row: "s2", stage: "Damages", reading_type: "Checkbox", low: 0, moderate: 0, high: 0, invalid: false },
        ],
      },
      { row: "p2", pest: "Scale Insects", measure: "Percentage", count_allowed: false, invalid: false,
        low: 0, moderate: 10, high: 30, stages: [] },
    ],
    diseases: [],
  };
  const misordered = {
    row: "p3", pest: "Aphids", measure: "Percentage", count_allowed: true, invalid: true,
    low: 1, moderate: 0.4, high: 2, stages: [],
  };

  it("offers Count only where scouts record a number, with a hint", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const scale = await screen.findByTestId("threshold-row-p2");
    expect(within(scale).getByRole("radio", { name: "Count" })).toBeDisabled();
    expect(within(scale).getByTestId("count-hint-p2")).toHaveTextContent("Count needs a stage scouts record as a number");
    expect(within(screen.getByTestId("threshold-row-p1")).getByRole("radio", { name: "Count" })).not.toBeDisabled();
  });

  it("suffixes bands in the measure's unit; a tick-box stage under Count reads %", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const thrips = await screen.findByTestId("threshold-row-p1");
    expect(within(thrips).getAllByText("per zone")).toHaveLength(6);   // row + Adult
    expect(within(thrips).getAllByText("%")).toHaveLength(3);          // Damages
    await userEvent.click(within(thrips).getByRole("radio", { name: "Percentage" }));
    expect(within(thrips).queryAllByText("per zone")).toHaveLength(0);
    expect(within(thrips).getAllByText("%")).toHaveLength(9);
  });

  it("flags misordered bands inline and holds Save until they rise", async () => {
    getThresholds.mockResolvedValue({ ...rose, pests: [...rose.pests, misordered] });
    render(<ThresholdsTab crop="Rose" />);
    expect(await screen.findByTestId("band-error-p3")).toHaveTextContent("Bands must rise");
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toBeDisabled();
    await userEvent.clear(within(screen.getByTestId("threshold-row-p3")).getByLabelText("Low"));
    expect(screen.queryByTestId("band-error-p3")).toBeNull();
    expect(save).not.toBeDisabled();
  });

  it("sends the chosen measure on save", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const thrips = await screen.findByTestId("threshold-row-p1");
    await userEvent.click(within(thrips).getByRole("radio", { name: "Percentage" }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(saveThresholds.mock.calls[0][1].pests[0].measure).toBe("Percentage");
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/threshold-measure.test.ts src/pages/trends/__tests__/count-bands.test.ts src/components/settings/__tests__/ThresholdsTab.test.tsx`
Expected: FAIL — `threshold-measure` cannot be resolved; no `threshold-row-p2` test id; ChartPanel lacks `measuredBand`.

- [ ] **Step 3: `threshold-measure.ts` and the API types**

Create `frontend/src/lib/threshold-measure.ts`:

```ts
/**
 * Measures and bands for the Thresholds editor and the Trends reference lines.
 * Mirrors serverscripts/common/threshold_bands.py (thresholds spec D1, D3);
 * the server re-checks everything on save, this only spares a round trip.
 */
import type { ThresholdsBundle } from "./thresholds-api";

export type Measure = "Percentage" | "Count";

/** The bands that are set must rise strictly; all-zero is unconfigured. */
export function bandsAscending(low: number, moderate: number, high: number): boolean {
  const values = [low, moderate, high].map((v) => Number(v) || 0);
  if (values.some((v) => v < 0)) return false;
  const set = values.filter((v) => v > 0);
  return set.every((v, i) => i === 0 || set[i - 1] < v);
}

/** `readingType` omitted = the row's own figure. Under a Count row a tick-box
 *  (or range) stage is judged as a share: a tick is not a count. */
export function effectiveMeasure(rowMeasure: Measure, readingType?: string | null): Measure {
  if (rowMeasure !== "Count") return "Percentage";
  if (readingType == null) return "Count";
  return readingType === "Count" ? "Count" : "Percentage";
}

/** "%" for a Percentage; "per zone" / "per tree" for a Count. */
export function unitFor(measure: Measure, station: string = "zone"): string {
  return measure === "Count" ? `per ${station || "zone"}` : "%";
}

/** "30%" / "5 per zone" */
export function formatBandValue(value: number, unit: string): string {
  return unit === "%" ? `${value}%` : `${value} ${unit}`;
}

export interface MeasuredBand {
  low?: number;
  moderate?: number;
  high?: number;
  measure: Measure;
  unit: string;
}

function usable(b: { low: number; moderate: number; high: number }): boolean {
  const set = (b.low || 0) > 0 || (b.moderate || 0) > 0 || (b.high || 0) > 0;
  return set && bandsAscending(b.low, b.moderate, b.high);
}

/** `${kind}::${name}::${stage}` (stage "" = the row) → its band, measure and
 *  unit. Unset and misordered bands are left out, as the server leaves them out. */
export function thresholdMapFromBundle(bundle: ThresholdsBundle | null): Map<string, MeasuredBand> {
  const m = new Map<string, MeasuredBand>();
  if (!bundle) return m;
  const station = bundle.station || "zone";
  const add = (key: string, b: { low: number; moderate: number; high: number }, measure: Measure) => {
    if (!usable(b)) return;
    m.set(key, { low: b.low, moderate: b.moderate, high: b.high, measure, unit: unitFor(measure, station) });
  };
  for (const p of bundle.pests) {
    const rowMeasure: Measure = p.measure === "Count" ? "Count" : "Percentage";
    add(`pest::${p.pest}::`, p, rowMeasure);
    for (const s of p.stages) add(`pest::${p.pest}::${s.stage}`, s, effectiveMeasure(rowMeasure, s.reading_type));
  }
  for (const d of bundle.diseases) {
    add(`disease::${d.disease}::`, d, "Percentage");
    for (const s of d.stages) add(`disease::${d.disease}::${s.stage}`, s, "Percentage");
  }
  return m;
}

/** One line for a Count band on a chart whose axis is a share. */
export function countBandNote(b: MeasuredBand): string {
  const parts = (
    [["Low", b.low], ["Mod", b.moderate], ["High", b.high]] as Array<[string, number | undefined]>
  )
    .filter(([, v]) => Number(v) > 0)
    .map(([label, v]) => `${label} ${v}`);
  return `Count thresholds (${b.unit}): ${parts.join(" · ")} — Trends plots the share of stations, so they are not drawn here`;
}
```

In `frontend/src/lib/thresholds-api.ts` replace the three row interfaces and the bundle with:

```ts
export interface ThresholdStageRow {
  row: string;        // Frappe doc name of the Pests Stages / Disease Stages row
  stage: string;
  /** Count / Checkbox / Range — how scouts record this stage */
  reading_type: string;
  low: number;
  moderate: number;
  high: number;
  invalid?: boolean;
}

export interface ThresholdPestRow {
  row: string;        // Frappe doc name of the Pest Filter row
  pest: string;
  measure: "Percentage" | "Count";
  /** a stage scouts record as a number exists (spec D1) */
  count_allowed: boolean;
  /** bands on the row or a stage do not rise */
  invalid?: boolean;
  low: number;
  moderate: number;
  high: number;
  stages: ThresholdStageRow[];
}

export interface ThresholdDiseaseRow {
  row: string;
  disease: string;
  measure: "Percentage" | "Count";
  count_allowed: boolean;
  invalid?: boolean;
  low: number;
  moderate: number;
  high: number;
  stages: ThresholdStageRow[];
}

export interface ThresholdsBundle {
  crop: string;
  /** what a Count is "per": "zone" or "tree" */
  station?: string;
  pests: ThresholdPestRow[];
  diseases: ThresholdDiseaseRow[];
}
```
and in `getThresholds` change the fallback object to `{ crop, station: "zone", pests: [], diseases: [] }`.

- [ ] **Step 4: Rewrite `ThresholdsTab.tsx`**

```tsx
/**
 * Settings → Thresholds editor (thresholds spec §1, D1, D3).
 *
 * Per Pest/Disease Filter row of the route crop (`#/<crop>/settings`): a Measure
 * — Percentage (share of scouted stations carrying it, sections averaged) or
 * Count (average count per scouted station; only for a pest with a stage
 * scouts record as a number) — and the Low / Moderate / High bands, suffixed
 * in that measure's unit. Stage rows override the row for that stage; a
 * tick-box stage under a Count row is judged as a share, so its bands read "%".
 * Bands that are set must rise: a misordered row is flagged inline and Save
 * waits until it is fixed. All zeros = unconfigured (no alerts).
 */

import { useEffect, useMemo, useState } from "react";
import { Bug, Hexagon, Save, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  getThresholds,
  saveThresholds,
  type ThresholdPestRow,
  type ThresholdDiseaseRow,
  type ThresholdStageRow,
  type ThresholdsBundle,
} from "@/lib/thresholds-api";
import { bandsAscending, effectiveMeasure, unitFor, type Measure } from "@/lib/threshold-measure";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/errors";

type FilterRow = ThresholdPestRow | ThresholdDiseaseRow;

function isPest(row: FilterRow): row is ThresholdPestRow {
  return (row as ThresholdPestRow).pest !== undefined;
}

/** The row's or any stage's bands do not rise. */
export function rowInvalid(row: FilterRow): boolean {
  return (
    !bandsAscending(row.low, row.moderate, row.high) ||
    row.stages.some((s) => !bandsAscending(s.low, s.moderate, s.high))
  );
}

/** `crop` is the route crop (spec D7); the tab carries no picker of its own. */
export function ThresholdsTab({ crop }: { crop: string }) {
  const [bundle, setBundle] = useState<ThresholdsBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string>("");

  useEffect(() => {
    if (!crop) {
      setBundle(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getThresholds(crop)
      .then((b) => {
        if (!cancelled) setBundle(b);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e, "Failed to load thresholds"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [crop]);

  const patchRow = (key: "pests" | "diseases", i: number, patch: Partial<FilterRow>) => {
    if (!bundle) return;
    if (key === "pests") {
      const pests = bundle.pests.slice();
      pests[i] = { ...pests[i], ...patch } as ThresholdPestRow;
      setBundle({ ...bundle, pests });
    } else {
      const diseases = bundle.diseases.slice();
      diseases[i] = { ...diseases[i], ...patch } as ThresholdDiseaseRow;
      setBundle({ ...bundle, diseases });
    }
  };
  const patchStage = (key: "pests" | "diseases", i: number, si: number, patch: Partial<ThresholdStageRow>) => {
    if (!bundle) return;
    const rows: FilterRow[] = key === "pests" ? bundle.pests : bundle.diseases;
    const stages = rows[i].stages.slice();
    stages[si] = { ...stages[si], ...patch };
    patchRow(key, i, { stages } as Partial<FilterRow>);
  };

  const invalidRows = useMemo(
    () => (bundle ? [...bundle.pests, ...bundle.diseases].filter(rowInvalid).length : 0),
    [bundle],
  );

  const onSave = async () => {
    if (!bundle || !crop || invalidRows) return;
    setSaving(true);
    setError(null);
    try {
      await saveThresholds(crop, bundle);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(errorText(e, "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const summary = useMemo(() => {
    if (!bundle) return { pests: 0, diseases: 0, stages: 0 };
    const stages =
      bundle.pests.reduce((s, p) => s + p.stages.length, 0) +
      bundle.diseases.reduce((s, d) => s + d.stages.length, 0);
    return { pests: bundle.pests.length, diseases: bundle.diseases.length, stages };
  }, [bundle]);

  const station = bundle?.station || "zone";

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">Severity Thresholds{crop ? ` · ${crop}` : ""}</CardTitle>
          <CardDescription>
            Each row is measured as a Percentage (share of scouted stations carrying it) or a
            Count (average per scouted {station}). Moderate raises an Alarming notice, High a spray
            advisory. Stage values override the row. Bands must rise; zero = not set (no alerts).
          </CardDescription>
        </div>
        <div className="flex items-end gap-2">
          {invalidRows > 0 && (
            <span className="text-[0.7rem] text-destructive">
              {invalidRows} row{invalidRows !== 1 ? "s" : ""} need rising bands before saving.
            </span>
          )}
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || loading || !bundle || invalidRows > 0}
            className="h-9 gap-2"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <div className="text-xs text-destructive whitespace-pre-line">{error}</div>}
        {!crop && (
          <div className="text-xs text-muted-foreground py-6 text-center">
            Open Settings from a crop's section to edit its thresholds.
          </div>
        )}
        {savedAt && !error && !saving && (
          <div className="text-[0.7rem] text-muted-foreground">Saved at {savedAt}.</div>
        )}
        {loading && !bundle && (
          <div className="text-xs text-muted-foreground py-6 text-center">Loading thresholds…</div>
        )}

        {bundle && (
          <>
            <div className="flex flex-wrap gap-2 text-[0.7rem] text-muted-foreground">
              <Badge variant="outline">{summary.pests} pests</Badge>
              <Badge variant="outline">{summary.diseases} diseases</Badge>
              <Badge variant="outline">{summary.stages} stage rows</Badge>
            </div>

            <Section title="Pests" icon={Bug} empty="No Pest Filter rows on this crop.">
              {bundle.pests.map((p, i) => (
                <FilterEditor
                  key={p.row}
                  row={p}
                  station={station}
                  onPatch={(patch) => patchRow("pests", i, patch)}
                  onStagePatch={(si, patch) => patchStage("pests", i, si, patch)}
                />
              ))}
            </Section>

            <Section title="Diseases" icon={Hexagon} empty="No Disease Filter rows on this crop.">
              {bundle.diseases.map((d, i) => (
                <FilterEditor
                  key={d.row}
                  row={d}
                  station={station}
                  onPatch={(patch) => patchRow("diseases", i, patch)}
                  onStagePatch={(si, patch) => patchStage("diseases", i, si, patch)}
                />
              ))}
            </Section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  icon: Icon,
  empty,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  empty: string;
  children: React.ReactNode;
}) {
  const arr = Array.isArray(children) ? children : [children];
  const hasAny = arr.some(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      {hasAny ? (
        <div className="flex flex-col gap-2">{children}</div>
      ) : (
        <div className="text-[0.72rem] text-muted-foreground italic px-2 py-3 border border-dashed rounded-md">
          {empty}
        </div>
      )}
    </div>
  );
}

function MeasureToggle({
  name,
  value,
  countAllowed,
  onChange,
}: {
  name: string;
  value: Measure;
  countAllowed: boolean;
  onChange: (m: Measure) => void;
}) {
  return (
    <div role="radiogroup" aria-label={`Measure for ${name}`} className="inline-flex rounded-md border p-0.5">
      {(["Percentage", "Count"] as const).map((m) => {
        const disabled = m === "Count" && !countAllowed;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value === m}
            disabled={disabled}
            onClick={() => onChange(m)}
            className={cn(
              "h-6 rounded px-2 text-[0.7rem] transition-colors",
              value === m ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
            )}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

function BandError({ testId }: { testId: string }) {
  return (
    <div data-testid={testId} role="alert" className="mt-1 text-[0.7rem] text-destructive">
      Bands must rise: Low &lt; Moderate &lt; High (leave a band at 0 to skip it).
    </div>
  );
}

function FilterEditor({
  row,
  station,
  onPatch,
  onStagePatch,
}: {
  row: FilterRow;
  station: string;
  onPatch: (patch: Partial<FilterRow>) => void;
  onStagePatch: (i: number, patch: Partial<ThresholdStageRow>) => void;
}) {
  const name = isPest(row) ? row.pest : row.disease;
  const measure: Measure = row.measure === "Count" ? "Count" : "Percentage";
  return (
    <div className="border rounded-md p-2.5 bg-card" data-testid={`threshold-row-${row.row}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{name}</span>
        <MeasureToggle
          name={name}
          value={measure}
          countAllowed={row.count_allowed}
          onChange={(m) => onPatch({ measure: m } as Partial<FilterRow>)}
        />
        {!row.count_allowed && (
          <span className="text-[0.65rem] text-muted-foreground" data-testid={`count-hint-${row.row}`}>
            {isPest(row) ? "Count needs a stage scouts record as a number" : "Diseases are measured as a share"}
          </span>
        )}
        <ThresholdInputs
          unit={unitFor(measure, station)}
          values={{ low: row.low, moderate: row.moderate, high: row.high }}
          onChange={(patch) => onPatch(patch as Partial<FilterRow>)}
        />
      </div>
      {!bandsAscending(row.low, row.moderate, row.high) && <BandError testId={`band-error-${row.row}`} />}
      {row.stages.length > 0 && (
        <div className="mt-2 pl-3 flex flex-col gap-1.5">
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            Per-stage overrides
          </div>
          {row.stages.map((s, i) => (
            <div key={s.row} className="flex flex-col">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs min-w-20 text-muted-foreground">{s.stage || "—"}</span>
                <ThresholdInputs
                  unit={unitFor(effectiveMeasure(measure, s.reading_type), station)}
                  values={{ low: s.low, moderate: s.moderate, high: s.high }}
                  onChange={(patch) => onStagePatch(i, patch)}
                />
              </div>
              {!bandsAscending(s.low, s.moderate, s.high) && <BandError testId={`band-error-${s.row}`} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThresholdInputs({
  unit,
  values,
  onChange,
}: {
  unit: string;
  values: { low: number; moderate: number; high: number };
  onChange: (patch: { low?: number; moderate?: number; high?: number }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ThInput label="Low" short="Low" unit={unit} value={values.low} onChange={(v) => onChange({ low: v })} />
      <ThInput label="Moderate" short="Mod" unit={unit} value={values.moderate} onChange={(v) => onChange({ moderate: v })} />
      <ThInput label="High" short="High" unit={unit} value={values.high} onChange={(v) => onChange({ high: v })} />
    </div>
  );
}

function ThInput({
  label,
  short,
  unit,
  value,
  onChange,
}: {
  label: string;
  short: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">{short}</span>
      <Input
        type="number"
        step="0.1"
        min="0"
        aria-label={label}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="h-7 w-16 text-xs tabular-nums"
      />
      <span className="text-[0.6rem] text-muted-foreground">{unit}</span>
    </div>
  );
}
```

- [ ] **Step 5: Trends — bands carry their measure**

`frontend/src/pages/Trends.tsx`:
- add `import { thresholdMapFromBundle } from "@/lib/threshold-measure";`
- replace the whole block from the comment line ``  // Flat lookup keyed by ``${kind}::${name}::${stage}`` (stage="" = aggregate).`` through its `  }, [thresholdBundle]);` with:

```tsx
  // Flat lookup keyed by `${kind}::${name}::${stage}` (stage "" = the row), each
  // band carrying its measure and unit. Unset and misordered bands are left out,
  // as the server leaves them out (thresholds spec §5).
  const thresholdMap = useMemo(() => thresholdMapFromBundle(thresholdBundle), [thresholdBundle]);
```

`frontend/src/pages/trends/ChartPanel.tsx`:
- add `import { countBandNote, formatBandValue, type MeasuredBand } from "@/lib/threshold-measure";`
- `ThresholdBand` becomes:

```tsx
export interface ThresholdBand {
  low?: number;
  moderate?: number;
  high?: number;
  /** the row's measure (thresholds spec D1); a Count band is not drawn on a share axis */
  measure?: "Percentage" | "Count";
  /** "%", "per zone", "per tree" */
  unit?: string;
}
```
- `renderThresholdLabel` gains a last parameter `unit: string`; replace both `${value}%` in `tip` with `${formatBandValue(value, unit)}`, and replace the text child `{tier === "Moderate" ? "Mod" : tier} {value}%` with `{tier === "Moderate" ? "Mod" : tier} {formatBandValue(value, unit)}`. Add `band.unit ?? "%",` as the last argument of each of the three `renderThresholdLabel(...)` calls (Low / Moderate / High).
- replace

```tsx
  const band: ThresholdBand | null = useMemo(() => {
    if (!showThresholds || !thresholdLookup || !obs) return null;
    return thresholdLookup(obs.kind, obs.name, child?.stage || "");
  }, [showThresholds, thresholdLookup, obs, child?.stage]);
```
with
```tsx
  const measuredBand: ThresholdBand | null = useMemo(() => {
    if (!showThresholds || !thresholdLookup || !obs) return null;
    return thresholdLookup(obs.kind, obs.name, child?.stage || "");
  }, [showThresholds, thresholdLookup, obs, child?.stage]);
  // Trends plots the share of scouted stations. A Count row's bands are in
  // another unit, so they are described under the chart, not drawn on it.
  const band = measuredBand && measuredBand.measure !== "Count" ? measuredBand : null;
  const countNote =
    measuredBand && measuredBand.measure === "Count" ? countBandNote(measuredBand as MeasuredBand) : null;
```
- directly inside `<div ref={exportRef} className="flex flex-col gap-3">`, as its first child:

```tsx
        {countNote ? (
          <div data-testid="count-band-note" className="text-[0.7rem] text-muted-foreground">
            {countNote}
          </div>
        ) : null}
```

- [ ] **Step 6: Run to pass**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/threshold-measure.test.ts src/pages/trends src/components/settings src/pages/__tests__/Trends.crop.test.tsx && npx tsc --noEmit -p tsconfig.app.json`
Expected: all pass, no type errors. `grep -rn '\.unit\b' src/components/settings src/pages/Trends.tsx` shows no read of the removed row `unit`.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add frontend/src/lib/threshold-measure.ts frontend/src/lib/threshold-measure.test.ts frontend/src/lib/thresholds-api.ts frontend/src/components/settings/ThresholdsTab.tsx frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx frontend/src/pages/Trends.tsx frontend/src/pages/trends/ChartPanel.tsx frontend/src/pages/trends/__tests__/count-bands.test.ts
git commit -m "feat(scp-ui): thresholds editor picks the measure, flags misordered bands; trends lines carry the unit"
```

---
### Task 9: Overview "Active alerts" lists stored Scouting Alerts, with Acknowledge

**Files:**
- Create: `frontend/src/lib/scouting-alerts-api.ts`, `frontend/src/lib/scouting-alerts-api.test.ts`, `frontend/src/components/AlertActionPill.tsx`
- Modify: `frontend/src/pages/dashboard/OverviewTab.tsx:1,36,52-64,97,282-313`, `frontend/src/pages/Dashboard.tsx:196-202`
- Create: `frontend/src/pages/dashboard/__tests__/OverviewAlerts.test.tsx`; Modify: `frontend/src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx` (the "Overview active alerts" block)

**Interfaces:**
- Consumes: Task 5 `open_alerts(crop, farm, greenhouse)` (rows + `unit`), `acknowledge_alert(name)`.
- Produces: `ScoutingAlert`, `CreatorAlert`, `AlertAction`, `listOpenAlerts({crop, farm?, greenhouse?})`, `acknowledgeAlert(name)`, `alertFigureLine(a)`, `ACTION_TONE`, `ghActionBadge(alerts) -> "Spray advised" | "Scout first" | null`; `<AlertActionPill action />`; `OverviewTab` props gain `farm?`, `greenhouse?`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/scouting-alerts-api.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { alertFigureLine, ghActionBadge, type CreatorAlert } from "./scouting-alerts-api";

const a = (over: Partial<CreatorAlert> = {}): CreatorAlert => ({
  name: "SA-1", warehouse: "GH 01", observation: "Thrips", stage: "", action: "Spray advised",
  value: 33.3, unit: "%", reliability: "Fair", iso_week: "2031-W20", status: "Open",
  margin: 18, sections_scouted: 9, sections_total: 9, ...over,
});

describe("alertFigureLine", () => {
  it("prints the figure in its unit with margin and sections", () => {
    expect(alertFigureLine(a())).toBe("33.3% · ±18 · 9/9");
    expect(alertFigureLine(a({ unit: "per zone", value: 1.2, margin: null, sections_scouted: 1 }))).toBe(
      "1.2 per zone · too clustered to judge · 1/9",
    );
  });
});

describe("ghActionBadge", () => {
  it("shows the worst spray action on the greenhouse", () => {
    expect(ghActionBadge([a({ action: "Scout first" }), a()])).toBe("Spray advised");
    expect(ghActionBadge([a({ action: "Scout first" })])).toBe("Scout first");
    expect(ghActionBadge([a({ action: "Alarming" as CreatorAlert["action"] })])).toBeNull();
    expect(ghActionBadge(undefined)).toBeNull();
  });
});
```

Create `frontend/src/pages/dashboard/__tests__/OverviewAlerts.test.tsx`:

```tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listOpenAlerts = vi.fn();
const acknowledgeAlert = vi.fn();
vi.mock("@/lib/scouting-alerts-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scouting-alerts-api")>()),
  listOpenAlerts: (...a: unknown[]) => listOpenAlerts(...a),
  acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a),
}));
vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#000", disease: () => "#000" }),
}));
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: () => ({ data: null, loading: false, error: null, progress: null, reload: vi.fn() }),
}));

import { OverviewTab } from "../OverviewTab";

const thrips = {
  name: "SA-2031-W20-abc", crop: "Rose", farm: "Chepsito", warehouse: "Chepsito GH 01 - KR",
  kind: "Pest", observation: "Thrips", stage: "", iso_week: "2031-W20", measure: "Percentage",
  unit: "%", value: 33.3, margin: 18, reliability: "Fair", sections_scouted: 9, sections_total: 9,
  band: "High", action: "Spray advised", status: "Open",
};
const aphids = {
  ...thrips, name: "SA-2031-W20-def", observation: "Aphids", measure: "Count", unit: "per zone",
  value: 1.2, margin: null, sections_scouted: 1, reliability: "Low", band: "Moderate", action: "Alarming",
};

beforeEach(() => {
  listOpenAlerts.mockReset().mockResolvedValue([thrips, aphids]);
  acknowledgeAlert.mockReset().mockResolvedValue({ name: thrips.name, status: "Acknowledged" });
});

const renderTab = (extra = {}) =>
  render(<OverviewTab data={null} scoutLookup={{}} fromDate="2031-05-12" toDate="2031-05-18" crop="Rose" {...extra} />);

describe("Overview active alerts", () => {
  it("lists the stored alerts of the crop, farm and greenhouse in scope", async () => {
    renderTab({ farm: "Chepsito", greenhouse: "" });
    const rows = await screen.findAllByTestId("active-alert");
    expect(listOpenAlerts).toHaveBeenCalledWith({ crop: "Rose", farm: "Chepsito", greenhouse: "" });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("33.3% · ±18 · 9/9")).toBeInTheDocument();
    expect(within(rows[0]).getByTestId("alert-action")).toHaveTextContent("Spray advised");
    expect(within(rows[1]).getByText("1.2 per zone · too clustered to judge · 1/9")).toBeInTheDocument();
    expect(within(rows[1]).getByTestId("reliability-pill")).toHaveTextContent("Low");
  });

  it("acknowledges in place", async () => {
    renderTab();
    const [first] = await screen.findAllByTestId("active-alert");
    await userEvent.click(within(first).getByRole("button", { name: "Acknowledge" }));
    expect(acknowledgeAlert).toHaveBeenCalledWith(thrips.name);
    await waitFor(() => expect(within(first).getByText("Acknowledged")).toBeInTheDocument());
    expect(within(first).queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("asks for nothing without a crop", () => {
    render(<OverviewTab data={null} scoutLookup={{}} fromDate="" toDate="" />);
    expect(listOpenAlerts).not.toHaveBeenCalled();
    expect(screen.getByText("No active alerts")).toBeInTheDocument();
  });
});
```

In `frontend/src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx` replace

```tsx
describe("Overview active alerts", () => {
  it("carry the figure line under the greenhouse", () => {
```
with
```tsx
describe("Overview active alerts", () => {
  // Since thresholds piece 3a the card lists stored Scouting Alerts (see
  // OverviewAlerts.test.tsx); the cached payload's activeAlerts is not drawn.
  it("no longer draws the cached payload's alerts", () => {
```
and, in that block only, replace
```tsx
    render(<OverviewTab data={data} scoutLookup={{}} fromDate="2031-03-03" toDate="2031-03-09" />);
    expect(screen.getByText("33.3% (was 50%) · ±6 · 8/9")).toBeInTheDocument();
```
with
```tsx
    render(<OverviewTab data={data} scoutLookup={{}} fromDate="2031-03-03" toDate="2031-03-09" />);
    expect(screen.queryByText("33.3% (was 50%) · ±6 · 8/9")).toBeNull();
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/scouting-alerts-api.test.ts src/pages/dashboard/__tests__`
Expected: FAIL — `scouting-alerts-api` cannot be resolved; no `active-alert` rows.

- [ ] **Step 3: The alerts client and pill**

Create `frontend/src/lib/scouting-alerts-api.ts`:

```ts
/**
 * Scouting Alerts (thresholds spec §4–§5): the Overview's Active alerts with
 * Acknowledge, and the spray plan creator's badges. Figures come from the
 * server; the browser only formats them.
 */
import { call } from "./frappe";

export type AlertAction = "Alarming" | "Spray advised" | "Scout first";
export type AlertStatus = "Open" | "Acknowledged" | "Resolved" | "Converted to plan";

export interface ScoutingAlert {
  name: string;
  crop: string;
  farm: string;
  warehouse: string;
  kind: "Pest" | "Disease";
  observation: string;
  stage?: string | null;
  iso_week: string;
  measure: "Percentage" | "Count";
  /** "%", "per zone" or "per tree" */
  unit: string;
  value: number | null;
  margin: number | null;
  reliability: "Good" | "Fair" | "Low";
  sections_scouted: number;
  sections_total: number;
  band: "Moderate" | "High";
  action: AlertAction;
  status: AlertStatus;
  acknowledged_by?: string | null;
  work_order?: string | null;
}

export type CreatorAlert = Pick<
  ScoutingAlert,
  | "name" | "warehouse" | "observation" | "stage" | "action" | "value" | "unit"
  | "reliability" | "iso_week" | "status" | "margin" | "sections_scouted" | "sections_total"
>;

const BASE = "upande_scp.serverscripts.scouting.thresholds_check";

export async function listOpenAlerts(args: {
  crop: string;
  farm?: string;
  greenhouse?: string;
}): Promise<ScoutingAlert[]> {
  const r = await call<ScoutingAlert[]>(`${BASE}.open_alerts`, {
    crop: args.crop,
    farm: args.farm || undefined,
    greenhouse: args.greenhouse || undefined,
  });
  return r || [];
}

export async function acknowledgeAlert(name: string): Promise<{ name: string; status: AlertStatus }> {
  return call(`${BASE}.acknowledge_alert`, { name });
}

/** "33.3% · ±18 · 9/9" — the figure in its unit, the margin, sections scouted. */
export function alertFigureLine(
  a: Pick<ScoutingAlert, "value" | "unit" | "margin" | "sections_scouted" | "sections_total">,
): string {
  const value = a.value == null ? "—" : a.unit === "%" ? `${a.value}%` : `${a.value} ${a.unit}`;
  const margin = a.margin != null ? `±${a.margin}` : "too clustered to judge";
  return `${value} · ${margin} · ${a.sections_scouted}/${a.sections_total ?? 9}`;
}

/** Text colour on a tinted pill — never a border strip. */
export const ACTION_TONE: Record<AlertAction, string> = {
  "Spray advised": "var(--sd-data-red)",
  "Scout first": "var(--sd-data-amber)",
  Alarming: "var(--sd-target)",
};

/** The creator's badge for a greenhouse: its worst open spray action (D7). */
export function ghActionBadge(alerts?: CreatorAlert[] | null): "Spray advised" | "Scout first" | null {
  if (alerts?.some((a) => a.action === "Spray advised")) return "Spray advised";
  if (alerts?.some((a) => a.action === "Scout first")) return "Scout first";
  return null;
}
```

Create `frontend/src/components/AlertActionPill.tsx`:

```tsx
import { ACTION_TONE, type AlertAction } from "@/lib/scouting-alerts-api";

/** Alarming / Spray advised / Scout first as a tinted pill (no border strip). */
export function AlertActionPill({ action }: { action: AlertAction }) {
  const tone = ACTION_TONE[action] ?? "var(--sd-muted)";
  return (
    <span
      data-testid="alert-action"
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none whitespace-nowrap"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {action}
    </span>
  );
}
```

- [ ] **Step 4: Wire the Overview card**

In `frontend/src/pages/dashboard/OverviewTab.tsx`:
1. `import { useState } from "react";` → `import { useEffect, useState } from "react";`
2. Replace `import { PrevalenceFigure } from "./PrevalenceFigure";` with `import { ReliabilityPill } from "./PrevalenceFigure";` and add:

```tsx
import { Button } from "@/components/ui/button";
import { AlertActionPill } from "@/components/AlertActionPill";
import { cn } from "@/lib/utils";
import {
  acknowledgeAlert,
  alertFigureLine,
  listOpenAlerts,
  type ScoutingAlert,
} from "@/lib/scouting-alerts-api";
```
3. In the props destructuring add `farm = "",` and `greenhouse = "",` after `crop = "",`, and in the props type add `farm?: string;` and `greenhouse?: string;` after `crop?: string;`.
4. Replace `  const alerts = data?.activeAlerts ?? [];` with:

```tsx
  // Active alerts are the stored Scouting Alerts (thresholds spec §5), read
  // uncached so an Acknowledge shows at once. The cached payload's
  // `activeAlerts` is no longer drawn.
  const [alerts, setAlerts] = useState<ScoutingAlert[]>([]);
  const [acking, setAcking] = useState<string | null>(null);
  useEffect(() => {
    if (!crop) {
      setAlerts([]);
      return;
    }
    let cancelled = false;
    listOpenAlerts({ crop, farm, greenhouse })
      .then((rows) => {
        if (!cancelled) setAlerts(rows);
      })
      .catch(() => {
        if (!cancelled) setAlerts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [crop, farm, greenhouse]);
  const acknowledge = async (name: string) => {
    setAcking(name);
    try {
      const r = await acknowledgeAlert(name);
      setAlerts((rows) => rows.map((a) => (a.name === name ? { ...a, status: r.status } : a)));
    } catch {
      // Left Open; the next load shows the truth.
    } finally {
      setAcking(null);
    }
  };
```
5. Replace the whole Active Alerts `<Card className="p-4">…</Card>` (from `<CardTitle>Active Alerts</CardTitle>`'s card through its closing `</Card>`) with:

```tsx
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Active Alerts</CardTitle>
            <CardDescription>
              {alerts.filter((a) => a.status === "Open").length} open · thresholds crossed in the
              latest scouted week
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 flex flex-col gap-1.5">
            {alerts.length ? (
              alerts.map((a) => (
                <div
                  key={a.name}
                  data-testid="active-alert"
                  className={cn(
                    "flex flex-col gap-1 px-3 py-2 rounded-md border bg-[var(--sd-bg-soft)]",
                    a.status !== "Open" && "opacity-70",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {a.observation}
                      {a.stage ? ` · ${a.stage}` : ""}
                    </span>
                    <AlertActionPill action={a.action} />
                    <ReliabilityPill value={a.reliability} />
                  </div>
                  <div className="text-[0.7rem] text-muted-foreground truncate">
                    {a.warehouse} · {a.iso_week}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.7rem] tabular-nums">{alertFigureLine(a)}</span>
                    {a.status === "Open" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[0.65rem]"
                        disabled={acking === a.name}
                        onClick={() => void acknowledge(a.name)}
                      >
                        Acknowledge
                      </Button>
                    ) : (
                      <span className="text-[0.65rem] text-muted-foreground">Acknowledged</span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <EmptyHint title="No active alerts" hint="No threshold crossed in the latest scouted week." />
            )}
          </CardContent>
        </Card>
```

In `frontend/src/pages/Dashboard.tsx`, in the `<OverviewTab … />` element add `farm={base.farm}` and `greenhouse={base.greenhouse}` after `crop={base.crop}`.

- [ ] **Step 5: Run to pass**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/scouting-alerts-api.test.ts src/pages/dashboard src/pages/__tests__/Dashboard.crop.test.tsx && npx tsc --noEmit -p tsconfig.app.json`
Expected: pass, no type errors.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add frontend/src/lib/scouting-alerts-api.ts frontend/src/lib/scouting-alerts-api.test.ts frontend/src/components/AlertActionPill.tsx frontend/src/pages/dashboard/OverviewTab.tsx frontend/src/pages/Dashboard.tsx frontend/src/pages/dashboard/__tests__/OverviewAlerts.test.tsx frontend/src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx
git commit -m "feat(scp-ui): overview active alerts are the stored scouting alerts, with acknowledge"
```

---

### Task 10: Spray plan creator — badges and "Create curative plan" (D7)

**Files:**
- Modify: `upande_scp/serverscripts/scouting/thresholds_check.py` (append `creator_alerts`, `convert_to_plan`)
- Modify: `upande_scp/serverscripts/spray_plan_creator/bootstrap.py` (imports; return dict ~`:191-219`; `_empty_bootstrap`)
- Modify: `upande_scp/serverscripts/spray_plan_creator/drafts.py:494-497` (after the plan-BOM backlink)
- Test: `upande_scp/serverscripts/tests/test_scouting_alert_creator.py`
- Create: `frontend/src/components/spray-plan/CurativeAlerts.tsx`, `frontend/src/components/__tests__/CurativeAlerts.test.tsx`, `frontend/src/pages/__tests__/ApplicationPlan.alerts.test.ts`
- Modify: `frontend/src/lib/spray-plan-creator-api.ts:98-113,139-164`, `frontend/src/pages/ApplicationPlan.tsx`

**Interfaces:**
- Consumes: Task 5 alerts; Task 9 `CreatorAlert`, `ghActionBadge`, `alertFigureLine`, `AlertActionPill`.
- Produces: `TC.CREATOR_ACTIONS`, `TC.creator_alerts(warehouses) -> {warehouse: [alert + unit]}` (Open/Acknowledged Spray advised + Scout first only), `TC.convert_to_plan(alert, work_order, greenhouse) -> work_order`; bootstrap key `alerts`; draft payload key `alert`; `<CurativeAlerts alerts activeAlert onCreate />`.

- [ ] **Step 1: Write the failing backend tests**

Create `upande_scp/serverscripts/tests/test_scouting_alert_creator.py`:

```python
"""Creator badges and Create-curative-plan conversion (thresholds spec D7).
DB test — direct runner; rolled back in tearDown."""

import inspect

import frappe

from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.spray_plan_creator import bootstrap as BOOT
from upande_scp.serverscripts.spray_plan_creator import drafts as D
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import thresholds_fixture as TF
from upande_scp.serverscripts.tests.test_scouting_alerts import SUN_20, AlertCase


class TestCreatorAlerts(AlertCase):
    def test_creator_alerts_carry_the_spray_actions_per_greenhouse(self):
        name = self.raise_spray_advised()
        out = TC.creator_alerts([self.gh, self.gh2])
        self.assertEqual([(a.name, a.action, a.unit) for a in out[self.gh]], [(name, "Spray advised", "%")])
        self.assertNotIn(self.gh2, out)

    def test_alarming_is_not_a_creator_badge(self):
        TF.seed_week(self.gh, TF.WEEK_20[0], crop="Rose")
        TF.set_bands("Rose", "Thrips", 0, 30, 60)
        TC.check_crop("Rose", SUN_20)
        self.assertEqual(TC.creator_alerts([self.gh]), {})

    def test_the_bootstrap_carries_them(self):
        name = self.raise_spray_advised()
        F.add_creator_roster(self.farm)                 # Administrator on the farm's roster
        boot = BOOT.fetch_creator_bootstrap("Rose")
        self.assertEqual(boot["alerts"][self.gh][0]["name"], name)
        self.assertEqual(BOOT._empty_bootstrap()["alerts"], {})

    def test_convert_to_plan_links_the_work_order_and_marks_the_alert(self):
        name = self.raise_spray_advised()
        wo = frappe.db.get_value("Work Order", {}, "name")
        self.assertEqual(TC.convert_to_plan(name, wo, self.gh), wo)
        status, linked = frappe.db.get_value("Scouting Alert", name, ["status", "work_order"])
        self.assertEqual((status, linked), ("Converted to plan", wo))
        self.assertNotIn(name, [r.name for r in TC.open_alerts("Rose")])
        TC.check_crop("Rose", SUN_20)                   # a later hourly run leaves it converted
        self.assertEqual(frappe.db.get_value("Scouting Alert", name, "status"), "Converted to plan")
        self.assertEqual(TC.convert_to_plan(name, "WO-LATER", self.gh), wo)   # keeps its first plan

    def test_convert_refuses_an_alert_for_another_greenhouse(self):
        name = self.raise_spray_advised()
        with self.assertRaises(frappe.ValidationError):
            TC.convert_to_plan(name, "WO-NOPE", self.gh2)
        with self.assertRaises(frappe.ValidationError):
            TC.convert_to_plan("SA-NOPE", "WO-NOPE", self.gh)

    def test_create_draft_spray_plan_converts_the_alert_it_was_given(self):
        src = inspect.getsource(D.create_draft_spray_plan)
        self.assertIn('thresholds_check.convert_to_plan(alert, wo.name, payload["custom_greenhouse"])', src)
        self.assertLess(src.index("wo.insert("), src.index("convert_to_plan("))
```

Run: **DB-RUN** `test_scouting_alert_creator` → FAIL (`module ... has no attribute 'creator_alerts'`).

- [ ] **Step 2: Server side**

Append to `upande_scp/serverscripts/scouting/thresholds_check.py`:

```python
# ── the spray plan creator (D7) ────────────────────────────────────────────

CREATOR_ACTIONS = (B.SPRAY_ADVISED, B.SCOUT_FIRST)


def creator_alerts(warehouses) -> dict:
    """``{warehouse: [alert]}`` — Open / Acknowledged Spray advised and Scout
    first alerts on these houses, worst first: the creator's badges."""
    houses = sorted({w for w in (warehouses or ()) if w})
    if not houses or not frappe.db.table_exists(DOCTYPE):
        return {}
    rows = frappe.get_all(
        DOCTYPE,
        filters={
            "warehouse": ["in", houses],
            "status": ["in", list(OPEN_STATES)],
            "action": ["in", list(CREATOR_ACTIONS)],
        },
        fields=ALERT_FIELDS,
        limit_page_length=0,
    )
    stations: dict = {}
    out: dict = {}
    for r in rows:
        if r.crop not in stations:
            stations[r.crop] = _common.station_word(r.crop)
        r["unit"] = B.unit_label(r.measure, stations[r.crop])
        out.setdefault(r.warehouse, []).append(r)
    for alerts in out.values():
        alerts.sort(key=lambda r: (-B.ACTION_RANK.get(r.action, 0), r.observation or "", r.stage or ""))
    return out


def convert_to_plan(alert, work_order, greenhouse):
    """Link the curative plan saved from ``alert`` and mark it Converted (D7).
    Refuses an alert of another greenhouse; an already-converted alert keeps its
    first plan."""
    row = frappe.db.get_value(DOCTYPE, alert, ["name", "warehouse", "status", "work_order"], as_dict=True)
    if not row:
        frappe.throw(f"Scouting alert {alert} does not exist.", frappe.ValidationError)
    if row.warehouse != greenhouse:
        frappe.throw(f"Scouting alert {alert} is for {row.warehouse}, not {greenhouse}.", frappe.ValidationError)
    if row.status == "Converted to plan" and row.work_order:
        return row.work_order
    frappe.db.set_value(DOCTYPE, alert, {"status": "Converted to plan", "work_order": work_order})
    return work_order
```

`spray_plan_creator/bootstrap.py`:
- add `from upande_scp.serverscripts.scouting import thresholds_check` after `from upande_scp.serverscripts.common.tank_mix import tank_mix_item_group`
- in the returned dict, after `"farm_stores": farm_stores,` add:

```python
        # Open spray actions per greenhouse/block (thresholds D7) — the picker's
        # "Spray advised" / "Scout first" badges and "Create curative plan".
        "alerts": thresholds_check.creator_alerts(
            [g["name"] for g in greenhouses] + [b["name"] for b in blocks]
        ),
```
- in `_empty_bootstrap`, add `"alerts": {},` after `"cost_centers": [], "farm_stores": {},`.

`spray_plan_creator/drafts.py` — in `create_draft_spray_plan`, directly after

```python
    if plan_bom:
        set_plan_bom_wo(plan_bom, wo.name)
```
add
```python

    # Saved from a Scouting Alert's "Create curative plan" (thresholds D7): link
    # the plan to the alert and mark it Converted. A wrong alert raises, and the
    # request's transaction — the plan with it — rolls back.
    alert = (payload.get("alert") or "").strip()
    if alert:
        from upande_scp.serverscripts.scouting import thresholds_check

        thresholds_check.convert_to_plan(alert, wo.name, payload["custom_greenhouse"])
```

Run: **DB-RUN** `test_scouting_alert_creator` → 6 OK. **DB-RUN** `test_crop_scoped_spray_plan` → OK.

- [ ] **Step 3: Write the failing frontend tests**

Create `frontend/src/components/__tests__/CurativeAlerts.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CurativeAlerts } from "@/components/spray-plan/CurativeAlerts";
import type { CreatorAlert } from "@/lib/scouting-alerts-api";

const alert: CreatorAlert = {
  name: "SA-1", warehouse: "Chepsito GH 01 - KR", observation: "Thrips", stage: "", action: "Spray advised",
  value: 33.3, unit: "%", reliability: "Fair", iso_week: "2031-W20", status: "Open",
  margin: 18, sections_scouted: 9, sections_total: 9,
};

describe("CurativeAlerts", () => {
  it("shows the server's action and figure and starts a curative plan", async () => {
    const onCreate = vi.fn();
    render(<CurativeAlerts alerts={[alert]} onCreate={onCreate} />);
    expect(screen.getByTestId("alert-action")).toHaveTextContent("Spray advised");
    expect(screen.getByText("33.3% · ±18 · 9/9")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create curative plan" }));
    expect(onCreate).toHaveBeenCalledWith(alert);
  });

  it("marks the alert the plan is being made for", () => {
    render(<CurativeAlerts alerts={[alert]} activeAlert="SA-1" onCreate={() => {}} />);
    expect(screen.getByRole("button", { name: "In this plan" })).toBeInTheDocument();
  });

  it("says plainly when no spray threshold is crossed", () => {
    render(<CurativeAlerts alerts={[]} onCreate={() => {}} />);
    expect(screen.getByTestId("no-curative-alerts")).toHaveTextContent(
      "No spray threshold crossed in the latest scouted week.",
    );
  });
});
```

Create `frontend/src/pages/__tests__/ApplicationPlan.alerts.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A variable path on purpose: Vite rewrites `new URL("<literal>", import.meta.url)`
// into an asset URL, which readFileSync cannot open (ApplicationPlan.crop.test.ts
// uses the same helper).
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ApplicationPlan curative alerts (thresholds D7)", () => {
  const page = src("../ApplicationPlan.tsx");

  it("replaces the client-side recommendation with the server's band", () => {
    expect(page).not.toContain("Heavy infestation");
    expect(page).not.toMatch(/const recommendation\s*=/);
    expect(page).toContain("<CurativeAlerts");
  });

  it("badges greenhouses and links the saved plan to its alert", () => {
    expect(page).toContain("ghActionBadge(bootstrap?.alerts?.[g])");
    expect(page).toContain("alert: curativeAlert || undefined");
  });

  it("prefills greenhouse, Curative and the target", () => {
    expect(page).toContain("prefillRef.current = { greenhouse: a.warehouse, target: a.observation }");
    expect(page).toContain('setClassification("Curative")');
  });
});
```

Run: `cd frontend && npx vitest run src/components/__tests__/CurativeAlerts.test.tsx src/pages/__tests__/ApplicationPlan.alerts.test.ts` → FAIL (component missing; page still has `recommendation`).

- [ ] **Step 4: `CurativeAlerts` and the creator types**

Create `frontend/src/components/spray-plan/CurativeAlerts.tsx`:

```tsx
/**
 * Open spray actions on the picked greenhouse, each with "Create curative plan"
 * (thresholds spec D7). Replaces the old client-side zone-coverage
 * "recommendation": the band and the action come from the server.
 */
import { Button } from "@/components/ui/button";
import { AlertActionPill } from "@/components/AlertActionPill";
import { alertFigureLine, type CreatorAlert } from "@/lib/scouting-alerts-api";

export function CurativeAlerts({
  alerts,
  activeAlert,
  onCreate,
}: {
  alerts: CreatorAlert[];
  activeAlert?: string;
  onCreate: (a: CreatorAlert) => void;
}) {
  if (!alerts.length) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="no-curative-alerts">
        No spray threshold crossed in the latest scouted week.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="curative-alerts">
      {alerts.map((a) => (
        <div key={a.name} className="flex flex-wrap items-center gap-2 text-xs">
          <AlertActionPill action={a.action} />
          <span className="font-medium">
            {a.observation}
            {a.stage ? ` · ${a.stage}` : ""}
          </span>
          <span className="tabular-nums text-muted-foreground">{alertFigureLine(a)}</span>
          <span className="text-muted-foreground">{a.iso_week}</span>
          <Button
            type="button"
            size="sm"
            variant={activeAlert === a.name ? "default" : "outline"}
            className="ml-auto h-6 px-2 text-[0.65rem]"
            onClick={() => onCreate(a)}
          >
            {activeAlert === a.name ? "In this plan" : "Create curative plan"}
          </Button>
        </div>
      ))}
    </div>
  );
}
```

In `frontend/src/lib/spray-plan-creator-api.ts`:
- add `import type { CreatorAlert } from "./scouting-alerts-api";` beside the other imports
- in `CreatorBootstrap`, after `farm_stores: Record<string, CreatorFarmStores>;` add
  `  /** open Spray advised / Scout first alerts per greenhouse (thresholds D7) */`
  `  alerts?: Record<string, CreatorAlert[]>;`
- in `DraftPayload`, after `spray_rule_overrides?: OverrideInput[];` add
  `  /** the Scouting Alert this curative plan answers; saving marks it Converted */`
  `  alert?: string;`

- [ ] **Step 5: Wire `ApplicationPlan.tsx`**

1. Imports — add:

```tsx
import { CurativeAlerts } from "@/components/spray-plan/CurativeAlerts";
import { ghActionBadge, type CreatorAlert } from "@/lib/scouting-alerts-api";
```
2. After `  const [greenhouse, setGreenhouse] = useState<string>("");` add:

```tsx
  // The Scouting Alert a curative plan is being made from (thresholds D7). The
  // prefill ref survives the greenhouse/classification reset effect below.
  const [curativeAlert, setCurativeAlert] = useState<string>("");
  const prefillRef = useRef<{ greenhouse: string; target: string } | null>(null);
```
3. Replace

```tsx
  useEffect(() => {
    setSelectedTargets(new Set());
  }, [greenhouse, classification]);
```
with
```tsx
  useEffect(() => {
    const p = prefillRef.current;
    prefillRef.current = null;
    if (p && p.greenhouse === greenhouse && classification === "Curative") {
      setSelectedTargets(new Set([p.target]));
      return;
    }
    setSelectedTargets(new Set());
    setCurativeAlert("");
  }, [greenhouse, classification]);

  const startCurative = useCallback(
    (a: CreatorAlert) => {
      prefillRef.current = { greenhouse: a.warehouse, target: a.observation };
      setFarmFilter("");
      setGreenhouse(a.warehouse);
      setClassification("Curative");
      setCurativeAlert(a.name);
      // When neither changed the effect does not run; set the target directly.
      setSelectedTargets(new Set([a.observation]));
    },
    [],
  );
```
4. Delete the `const recommendation = …;` statement (the `coveragePct >= 30 ? "Heavy infestation …" : …` chain). Keep `totalZones`, `affectedZones` and `coveragePct`, which other panels still print.
5. In the Greenhouse picker replace

```tsx
                {ghList.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
```
with
```tsx
                {ghList.map((g) => {
                  const badge = ghActionBadge(bootstrap?.alerts?.[g]);
                  return (
                    <SelectItem key={g} value={g}>
                      <span className="flex items-center gap-2">
                        {g}
                        {badge ? (
                          <Badge
                            variant={badge === "Spray advised" ? "destructive" : "secondary"}
                            className="text-[0.6rem]"
                          >
                            {badge}
                          </Badge>
                        ) : null}
                      </span>
                    </SelectItem>
                  );
                })}
```
6. Replace the "Chemical Requirements" box — from `<div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">` / `Chemical Requirements` through the closing `</div>` of the `{coveragePct}% of zones flagged` line — with:

```tsx
                  <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                    Thresholds
                  </div>
                  <CurativeAlerts
                    alerts={(greenhouse && bootstrap?.alerts?.[greenhouse]) || []}
                    activeAlert={curativeAlert}
                    onCreate={startCurative}
                  />
                  <div className="text-[0.65rem] text-muted-foreground mt-1 tabular-nums">
                    {coveragePct}% of zones flagged
                  </div>
```
(the surrounding `<div className="rounded-md border bg-[var(--sd-bg-soft)] p-2.5">` and its closing tag stay; the coloured coverage bar goes, because its 30 % / 10 % cut-offs were the client-side recommendation.)
7. In `draftPayload`, after `spray_rule_overrides: overrides ?? [],` add `        alert: curativeAlert || undefined,`.
8. After a successful save, inside the `try` right after the `if (r?.compliance?.status === "Awaiting Override") { … }` block, add:

```tsx
      if (curativeAlert) {
        // Converted on the server; drop its badge without a reload.
        const done = curativeAlert;
        setBootstrap((b) =>
          b
            ? {
                ...b,
                alerts: Object.fromEntries(
                  Object.entries(b.alerts || {}).map(([w, list]) => [w, list.filter((x) => x.name !== done)]),
                ),
              }
            : b,
        );
        setCurativeAlert("");
      }
```

- [ ] **Step 6: Run to pass**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/components/__tests__/CurativeAlerts.test.tsx src/pages/__tests__ && npx tsc --noEmit -p tsconfig.app.json`
Expected: pass (including `ApplicationPlan.crop.test.ts`), no type errors.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/scouting/thresholds_check.py upande_scp/serverscripts/spray_plan_creator/bootstrap.py upande_scp/serverscripts/spray_plan_creator/drafts.py upande_scp/serverscripts/tests/test_scouting_alert_creator.py frontend/src/components/spray-plan/CurativeAlerts.tsx frontend/src/components/__tests__/CurativeAlerts.test.tsx frontend/src/lib/spray-plan-creator-api.ts frontend/src/pages/ApplicationPlan.tsx frontend/src/pages/__tests__/ApplicationPlan.alerts.test.ts
git commit -m "feat(scp-ui): creator badges spray advised / scout first and creates curative plans from alerts"
```

---
### Task 11: Final regression and an in-process server-level check

**Files:** none changed (unless a check fails — then fix in the owning task's files and re-run that task's tests).

- [ ] **Step 1: Pure suites**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_threshold_core_pure.py upande_scp/serverscripts/tests/test_threshold_counts_pure.py upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_trends_prevalence_pure.py`
Expected: all pass.

- [ ] **Step 2: DB suites, one module per DB-RUN**

New: `test_thresholds_measure`, `test_threshold_measure_dashboards`, `test_scouting_alerts`, `test_alert_digest`, `test_scouting_alert_creator`, `test_notifications`, `test_block_weekly_report`.
Regression: `test_dashboard_aggregates_overview`, `test_dashboard_aggregates_pests_diseases`, `test_dashboard_aggregates_gh_detail`, `test_dashboard_aggregates_traps`, `test_dashboard_aggregates_fcm`, `test_prevalence_rows`, `test_prevalence_overview`, `test_prevalence_pests`, `test_prevalence_trends`, `test_crop_scoped_aggregates`, `test_crop_scoped_aggregate_detail`, `test_crop_scoped_observations`, `test_crop_scoped_spray_plan`, `test_spray_compliance_enforcement`.
Expected: every module OK. Then confirm nothing leaked: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT COUNT(*) FROM \`tabScouting Alert\`; SELECT COUNT(*) FROM \`tabScouting Entry\` WHERE name LIKE '\_TEST-%'; SELECT COUNT(*) FROM \`tabFarm Spray Plan Creator\` WHERE name LIKE '\_TEST-TH-%';"` → `0`, `0`, `0`.

- [ ] **Step 3: Frontend**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: the whole vitest suite passes, no type errors, the build succeeds. (The built assets are served at once, but the web workers keep the old Python until **the user** restarts them — never restart anything yourself. Against old workers the new UI degrades quietly: `listOpenAlerts` / `fetchHouseFigures` fail into empty lists, the bootstrap has no `alerts`, and the editor shows every row as Percentage.)

- [ ] **Step 4: Register the two hourly jobs**

Run: **DB-EXEC** `from frappe.core.doctype.scheduled_job_type.scheduled_job_type import sync_jobs; sync_jobs(); print(frappe.get_all('Scheduled Job Type', filters={'method': ['like', '%scouting.%']}, fields=['method', 'frequency']))`
Expected: `…thresholds_check.run_threshold_check` and `…alert_digest.send_alert_digest`, both `Hourly`. (kaitet.local runs with `enable_scheduler = 0`, so neither fires here.)

- [ ] **Step 5: In-process check on the real data, rolled back**

Run (one command; bands are set only inside the transaction, notifications and email are patched out):

```bash
cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "
import time, frappe
from collections import Counter
from unittest.mock import patch
frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator')
from upande_scp.serverscripts.scouting import thresholds_check as TC
from upande_scp.serverscripts.reports import block_weekly_report as BW
from upande_scp.serverscripts.tests import thresholds_fixture as TF
try:
    TF.set_bands('Rose', 'Thrips', 0, 30, 60)
    TF.set_bands('Rose', 'Aphids', 0, 1, 3, measure='Count')
    t = time.time(); found = TC.evaluate('Rose'); dt = time.time() - t
    print('evaluate Rose: %.1fs, %d findings, actions %s' % (dt, len(found), Counter(f['action'] for f in found)))
    with patch.object(TC.notifications, 'notify', return_value=[]), patch.object(frappe, 'sendmail') as mail:
        print('check_crop', TC.check_crop('Rose'))
        assert not mail.called
    rows = TC.open_alerts('Rose')
    print('open alerts', len(rows), [(r.warehouse, r.observation, r.action, r.value, r.unit) for r in rows[:3]])
    t = time.time(); BW.build_workbook_bytes('Avocado', 'Lokitela', 2026, 41); print('block sheet W41: %.1fs' % (time.time() - t))
finally:
    frappe.db.rollback()
"
```
Expected: `evaluate Rose` finishes in well under a minute with one finding per (scouted house × banded row). Thrips is Spray advised or Alarming where the house's latest-week prevalence crosses 60 or 30. Aphids findings are `per zone`. `open alerts` lists them worst-first, and the block sheet builds. Write the numbers into the hand-off. Afterwards `SELECT COUNT(*) FROM \`tabScouting Alert\`` is still `0`.

- [ ] **Step 6: Note the deliberate behaviour changes for the hand-off**

Report to the user, with the Step 5 numbers:
- kaitet.local has **no usable bands** today. Rose Thrips is misordered (1 / 0.4 / 2) and every other row is 0 / 0 / 0, so dashboards classify nothing and no alert fires until an agronomist sets bands in Settings → Thresholds, where the Thrips row is flagged. Before this piece, the misordered Thrips row still classified.
- Migration result: 12 Pest Filters are Count (Rose Aphids, FCM; 10 avocado pests); everything else is Percentage.
- The backend goes live only after the user restarts the web and worker processes. Nothing was restarted here.

- [ ] **Step 7: Confirm the tree is clean of this work**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short && git log --oneline a0b3ea8..HEAD`
Expected: only the unrelated store/batch-transfer files remain modified/untracked, and ten commits from this plan (Tasks 1–10).
