# Station Prevalence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboards and Trends report what share of a greenhouse (rose zones) or avocado block (trees) carries a pest or disease, counting only the stations actually scouted. Scouting that bunches in one part of the house is corrected for, and every figure says how far to trust it (margin, spread, Good/Fair/Low).

**Architecture:** A pure module, `common/prevalence.py`, owns the measure: the 3 × 3 grid mapping, section rates, adjusted prevalence, margin, reliability, scope-wide combination and ISO-week labels. One DB helper, `dashboard_aggregates/_prevalence_rows.py`, loads the cached station grid per greenhouse/block and, per ISO week, the scouted and infested station sets for a crop, scope and window. It reuses piece 1's `parent_filter_conditions` (D5) and `obs_filter` (D4) and exposes a `StationWeeks` object that the Overview, Pests/Diseases, Greenhouse-detail and Trends aggregates read. The React dashboard shows a one-line figure with a reliability pill, the greenhouse modal shows a 3 × 3 grid, Trends shades a margin band, and every dashboard chart reveals left to right.

**Tech Stack:** Frappe v16 / Python 3.14, MariaDB (`YEARWEEK(d, 3)` = ISO week), Redis cache; React + TypeScript + Vite + recharts 2.15 + vitest 4 (jsdom, @testing-library/react) in `frontend/`.

**Spec:** `docs/superpowers/specs/2026-10-09-station-prevalence-design.md`

## Global Constraints

- Site is **`kaitet.local`** only. Query it read-only with `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SELECT …"`. **Never use the Kaitet MCP** (`mcp__claude_ai_Kaitet*`), for anything.
- Commits: **no `Co-Authored-By` trailer** (CLAUDE.md). Style: `feat(scp): …` / `fix(scp): …` / `feat(scp-ui): …` / `fix(scp-ui): …`, lowercase sentence.
- Stage with explicit `git add <paths>` only. The working tree carries someone else's uncommitted store/batch-transfer work: `frontend/src/components/store/TransferBatchPanel.tsx`, `frontend/src/lib/store-keeper-api.ts`, `frontend/src/pages/SprayPlanTransfers.tsx`, `upande_scp/serverscripts/store/batch_suggestion.py`, `upande_scp/serverscripts/store/store_keeper_api.py`, `upande_scp/serverscripts/tests/test_batch_suggestion.py`, `upande_scp/serverscripts/tests/test_transfer_batch_apply.py`, `upande_scp/serverscripts/tests/test_transfer_batch_gating.py`, `upande_scp/serverscripts/tests/test_transfer_batch_split.py` and `docs/superpowers/specs/2026-10-09-station-prevalence-design.md`. **Never stage those files, never `git add -A`/`git add .`/`git commit -a`, and never `git stash`.** Run `git status --short` before each commit.
- Indentation matches each file. Every Python file touched or created here uses **4 spaces**. Every TS/TSX file uses **2 spaces**.
- **All computation happens on the server.** The browser formats the figures it receives and never recomputes prevalence. The one exception is the Trends band: it looks up rows the server already computed.
- **Piece-1 crop scoping must keep holding.** Every new query goes through `_common.parent_filter_conditions` (D5 entry rule) and `_common.obs_filter` (D4 child rule). `test_crop_scoped_aggregates` and `test_crop_scoped_aggregate_detail` stay green.
- UI: **no vertical accent strips and no coloured left-border bars** on cards, rows, cells or pills. Show accent through text colour, a tinted background or a pill.
- Exact numbers from the spec: **3 × 3 grid**; a section counts only when **n_j ≥ 3** scouted stations; **z = 1.96**; **margin = 1.96 · sqrt(s²/m + p(1−p)/N)**, where s² is the sample variance of the p_j, N = Σ n_j over counted sections, and the result is clipped to [0, 1]; **Good** = m ≥ 7 and margin ≤ 0.10; **Fair** = m ≥ 4; otherwise **Low**; **m < 2 → margin `None`, reason "too clustered to judge"**; no stations → reason "no stations set up"; percentages are **0–100 floats rounded to 1 dp**; aggregate cache schema tag **`"prev1"`**.
- Test commands:
  - Pure (no site): `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q <path>`
  - DB (direct runner; each test rolls back in `tearDown`): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); import importlib; M=importlib.import_module('upande_scp.serverscripts.tests.<module>'); r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M)); raise SystemExit(not r.wasSuccessful())"`. Below this is written as **DB-RUN `<module>`**.
  - Frontend: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run <path>`. Typecheck with `npx tsc --noEmit -p tsconfig.app.json` (plain `-p .` checks nothing). Build with `yarn build`.
- **Regression gate.** The five suites `test_dashboard_aggregates_{overview,pests_diseases,gh_detail,traps,fcm}` pass on kaitet.local (31 tests). Every task that touches `dashboard_aggregates/` re-runs them, one module per DB-RUN. When an assertion pinned the old all-zones denominator, update it and write the reason in a comment beside it. Do not delete it. Tasks 3 and 4 do exactly that.
- DB tests insert Scouting Entries with **raw SQL** dated 2031–2033. No real data exists then (kaitet.local scouting runs 2026-07-01 → 2026-09-09). Raw inserts skip the controller and the cache-busting doc events, so every aggregate call in a test passes `force="1"`.
- `dashboard_aggregates/__init__.py` rebinds the names `_overview`, `_gh_detail` and `_trends` to the endpoint *functions*. Load those submodules with `importlib.import_module("upande_scp.serverscripts.dashboard_aggregates._<name>")`, never with `from … import _<name>`. `_common` and `_prevalence_rows` are not shadowed.
- After Python changes, manual checks need `sudo -n supervisorctl restart frappe15-web:` (workers preload code).

## Review Focus

These are the five failure modes most likely to slip past the tests, each with the test that pins it:

1. **ISO week 53 and the year boundary.** Python's `isocalendar()` labels must agree with MariaDB's `YEARWEEK(d, 3)`. A Sunday dated 2033-01-02 belongs to **2032-W53**, and the week before 2033-W01 is 2032-W53. → Task 1 `test_week_labels_cross_the_year_boundary`. Task 2 `test_mariadb_iso_weeks_match_python_at_week_53` puts a real entry on 2033-01-02 and reads `latest_pair == ("2033-W01", "2032-W53")`.
2. **Station numbers that don't parse, and avocado rows of 1–2 trees.** `Orchard Tree.tree` is **0 on all 53,699 trees**, so the number has to come from the name (`…_T38`). Bed names like "Bed 7a" must fall back to name order and must never be dropped. → Task 1 `test_station_number_prefers_the_int_column_then_the_name`, `test_unparsable_numbers_fall_back_to_name_order` and `test_rows_of_one_or_two_trees_map_into_the_grid`. Task 2 `test_every_tree_of_a_block_with_tiny_rows_is_placed` covers a real block with a 1-tree row.
3. **A house with stations but no scouting that week, and latest vs previous when only one week has data.** Such a house must be omitted, not shown as 0%. "(was …)" must come from the previous *scouted* week, even when that week falls before the range. → Task 2 `test_a_house_not_scouted_that_week_is_omitted`, `test_the_previous_scouted_week_comes_from_before_the_window` and `test_one_week_of_data_has_no_previous`. Task 4 `test_a_house_scouted_clean_counts_in_the_scope_wide_figure`. Task 6 `omits "(was …)" when there is no previous week`.
4. **Cache keys and stale grids.** A payload cached under `crop2` must never be served to the new client, and a Zone, Bed or Orchard Tree save must drop that house's cached grid. → Task 2 `test_zone_bed_and_tree_saves_drop_their_houses_grid` and `test_the_grid_is_cached_and_a_tree_save_drops_it`. Task 3 `test_aggregate_keys_carry_the_prev1_schema`.
5. **Recharts animation regressions.** A series that keeps recharts' own animation grows from the middle and fights `RevealLTR`. → Task 8 `chart-animation.test.ts` scans every dashboard tab, the greenhouse modal, `TrendStrip` and the Trends `ChartPanel` source. It checks that each series has `isAnimationActive={false}` and that each `ChartContainer` sits inside `RevealLTR`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `upande_scp/serverscripts/common/prevalence.py` (new) | Pure measure: `station_number`, `grid_positions`, `section_counts`, `figures`, `reliability`, `combine`, `public`, `yearweek_label`, `week_monday`, `latest_and_previous`, constants |
| `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py` (new) | Station grid per house (Zone / Orchard Tree, cached); `StationWeeks` = scouted and infested station sets per (house, ISO week) for a crop, scope and window; latest/previous week choice |
| `upande_scp/serverscripts/common/cache_utils.py` (mod) | `K_STATION_GRID_PREFIX`; `invalidate_station_grid_for_doc`; dispatch from `invalidate_on_change` |
| `upande_scp/serverscripts/dashboard_aggregates/_common.py` (mod) | `K_DASH_AGG_SCHEMA = "prev1"` |
| `upande_scp/serverscripts/dashboard_aggregates/_overview.py` (mod) | Cells and alerts from latest-week prevalence; figure fields on cells and alerts; avocado trees count as stations |
| `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` (mod) | Alerts from latest-week prevalence; `prevalence` list with the 3 × 3 `sections` |
| `upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py` (mod) | Ranking severity + scope figure, distribution, pressure, weekly trend on adjusted prevalence |
| `upande_scp/serverscripts/dashboard_aggregates/_trends.py` (mod) | `prevalenceByStation`, `prevalenceByFarm`, `vocab.farms`, `vocab.reliability` |
| `upande_scp/serverscripts/tests/test_prevalence_pure.py` (new) | Pure measure tests |
| `upande_scp/serverscripts/tests/test_prevalence_rows_pure.py` (new) | `StationWeeks` with injected grids (no site) |
| `upande_scp/serverscripts/tests/prevalence_fixture.py` (new) | Raw-SQL entries on real stations; `seed_even_week`; weeks W10/W11 2031, 2032-W53, 2033-W01 |
| `upande_scp/serverscripts/tests/test_prevalence_rows.py` (new) | DB: grids, cache, week sets, ISO-53, crop scoping |
| `upande_scp/serverscripts/tests/test_prevalence_overview.py` (new) | DB: overview cells/alerts, greenhouse detail, schema tag |
| `upande_scp/serverscripts/tests/test_prevalence_pests.py` (new) | DB: pests/diseases figures |
| `upande_scp/serverscripts/tests/test_trends_prevalence_pure.py` (new) | Pure: Trends prevalence tables |
| `upande_scp/serverscripts/tests/test_prevalence_trends.py` (new) | DB: Trends prevalence tables |
| `upande_scp/serverscripts/tests/test_cache_invalidation.py` (mod) | Station-grid invalidation dispatch |
| `upande_scp/serverscripts/tests/test_dashboard_aggregates_fixture.py` (mod) | `STATION_GRID` / `fixture_station_grid`; `ZONES_PER_GH` retired |
| `upande_scp/serverscripts/tests/test_dashboard_aggregates_{overview,gh_detail,pests_diseases}.py` (mod) | Assertions that pinned the all-zones denominator, updated with reasons |
| `frontend/src/lib/prevalence.ts` (new) | `PrevalenceFigures`/`SectionCell` types, `figureLine`, `figureTooltip` |
| `frontend/src/lib/prevalence.test.ts` (new) | figure line formats |
| `frontend/src/pages/dashboard/PrevalenceFigure.tsx` (new) | `PrevalenceFigure` line + `ReliabilityPill` |
| `frontend/src/pages/dashboard/SectionGrid.tsx` (new) | 3 × 3 grid, unscouted cells greyed |
| `frontend/src/pages/dashboard/overview-types.ts`, `pests-diseases-types.ts` (mod) | Payload types carry the figures |
| `frontend/src/pages/dashboard/OverviewTab.tsx`, `PestsTab.tsx`, `DiseasesTab.tsx`, `GreenhouseModal.tsx` (mod) | Figure line on alerts and severity rows; card copy; modal grid |
| `frontend/src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx`, `GreenhouseModal.sections.test.tsx` (new) | UI tests |
| `frontend/src/pages/trends/trends-types.ts`, `aggregate.ts`, `ChartPanel.tsx` (mod) | Prevalence index, margin band, `ComposedChart`, tooltip line |
| `frontend/src/pages/trends/__tests__/prevalence-band.test.ts` (new) | band lookups |
| `frontend/src/pages/dashboard/TrapsTab.tsx`, `FcmTab.tsx`, `TrendStrip.tsx` (mod) | `RevealLTR` + `isAnimationActive={false}` |
| `frontend/src/pages/dashboard/__tests__/chart-animation.test.ts` (new) | source scan for D6 |

---

### Task 1: `common/prevalence.py` — the pure measure

**Files:**
- Create: `upande_scp/serverscripts/common/prevalence.py`
- Create: `upande_scp/serverscripts/tests/test_prevalence_pure.py`

**Interfaces:**
- Consumes: nothing (stdlib only: `math`, `re`, `datetime.date`). **No frappe import.**
- Produces (module `upande_scp.serverscripts.common.prevalence`):
  - constants `GRID = 3`, `SECTIONS = 9`, `MIN_SECTION_N = 3`, `Z95 = 1.96`, `GOOD_MIN_SECTIONS = 7`, `GOOD_MAX_MARGIN = 0.10`, `FAIR_MIN_SECTIONS = 4`, `RELIABILITY = ("Good", "Fair", "Low")`, `CLUSTERED = "too clustered to judge"`, `NO_STATIONS = "no stations set up"`, `PUBLIC_KEYS`, `EMPTY`
  - `station_number(value, name) -> int | None`
  - `grid_positions(stations: Iterable[dict]) -> dict[str, tuple[int, int]]` (each dict `{"name", "group", "group_no", "no"}`)
  - `section_counts(grid: dict, stations: Iterable[str]) -> list[int]` (9 counts, row-major)
  - `reliability(m: int, margin: float | None) -> str` (margin as a 0–1 fraction)
  - `figures(grid, scouted, infested, scouted_counts=None) -> dict | None` with keys `stations, scouted, infested, coverage, raw, prevalence, margin, sections_scouted, sections_total, reliability, reason, sections:[{row, col, scouted, infested, pct}]`
  - `combine(figs: list[dict]) -> dict | None`, `public(fig: dict | None) -> dict`
  - `yearweek_label(value) -> str`, `week_monday(label: str) -> str`, `latest_and_previous(window_weeks, all_weeks) -> tuple[str | None, str | None]`

- [ ] **Step 1: Write the failing test.** Create `upande_scp/serverscripts/tests/test_prevalence_pure.py`:

```python
"""The station-prevalence measure — runs under plain pytest, no site."""

import unittest

from upande_scp.serverscripts.common import prevalence as P


def grid_of(beds: int, zones: int) -> dict:
    """beds × zones stations named B{b}-Z{z}, numbered in order."""
    return P.grid_positions(
        {"name": f"B{b}-Z{z}", "group": f"B{b}", "group_no": b, "no": z}
        for b in range(1, beds + 1)
        for z in range(1, zones + 1)
    )


def by_section(grid: dict) -> dict:
    out: dict = {}
    for name, pos in grid.items():
        out.setdefault(pos, []).append(name)
    return {k: sorted(v, key=lambda n: (int(n.split("-Z")[0][1:]), int(n.split("-Z")[1])))
            for k, v in out.items()}


class TestGrid(unittest.TestCase):
    def test_grid_for_uneven_beds_of_1_2_and_13_zones(self):
        stations = [{"name": "A1", "group": "Bed 1", "group_no": 1, "no": 1}]
        stations += [{"name": f"B{z}", "group": "Bed 2", "group_no": 2, "no": z} for z in (1, 2)]
        stations += [{"name": f"C{z}", "group": "Bed 3", "group_no": 3, "no": z} for z in range(1, 14)]
        grid = P.grid_positions(stations)
        self.assertEqual(len(grid), 16)
        self.assertEqual(grid["A1"], (0, 0))
        self.assertEqual((grid["B1"], grid["B2"]), ((1, 0), (1, 1)))
        self.assertEqual([grid[f"C{z}"][1] for z in range(1, 14)], [0] * 5 + [1] * 4 + [2] * 4)
        self.assertEqual({grid[f"C{z}"][0] for z in range(1, 14)}, {2})

    def test_fewer_than_three_beds_still_places_every_zone(self):
        two = grid_of(2, 3)
        self.assertEqual(len(two), 6)
        self.assertEqual({p[0] for p in two.values()}, {0, 1})
        one = grid_of(1, 3)
        self.assertEqual(sorted(one.values()), [(0, 0), (0, 1), (0, 2)])

    def test_rows_of_one_or_two_trees_map_into_the_grid(self):
        # Orchard Tree.tree is 0 on every tree on kaitet.local: the number comes from the name.
        trees = [("Row 1", 1), ("Row 2", 2), ("Row 3", 10)]
        stations = [
            {"name": f"BLK_ROW{r[-1]}_T{t}", "group": f"BLK - {r}",
             "group_no": P.station_number(None, f"BLK - {r}"),
             "no": P.station_number(0, f"BLK_ROW{r[-1]}_T{t}")}
            for r, n in trees for t in range(1, n + 1)
        ]
        grid = P.grid_positions(stations)
        self.assertEqual(len(grid), 13)
        self.assertEqual(grid["BLK_ROW1_T1"], (0, 0))
        self.assertEqual((grid["BLK_ROW2_T1"], grid["BLK_ROW2_T2"]), ((1, 0), (1, 1)))
        self.assertEqual(grid["BLK_ROW3_T10"], (2, 2))

    def test_station_number_prefers_the_int_column_then_the_name(self):
        self.assertEqual(P.station_number(5, "Zone 9"), 5)
        self.assertEqual(P.station_number("88", "Bed 88"), 88)
        self.assertEqual(P.station_number(0, "70HA_KINYOROBLK4_ROW6_T38"), 38)
        self.assertEqual(P.station_number(None, "AIRSTRIP BLK 1 - KL - Row 10"), 10)
        self.assertIsNone(P.station_number("7a", "Chepsito GH 01 - KR - Bed 7a"))
        self.assertIsNone(P.station_number(None, ""))

    def test_unparsable_numbers_fall_back_to_name_order(self):
        stations = []
        for bed in ("Bed 10", "Bed 2", "Bed X"):
            for zone in ("Zone B", "Zone A"):
                stations.append({"name": f"{bed} - {zone}", "group": bed,
                                 "group_no": P.station_number(None, bed), "no": None})
        grid = P.grid_positions(stations)
        self.assertEqual(len(grid), 6)                       # never dropped
        self.assertEqual(grid["Bed 2 - Zone A"][0], 0)       # numbered beds first, 2 before 10
        self.assertEqual(grid["Bed 10 - Zone A"][0], 1)
        self.assertEqual(grid["Bed X - Zone A"][0], 2)       # unnumbered last
        self.assertEqual((grid["Bed X - Zone A"][1], grid["Bed X - Zone B"][1]), (0, 1))  # name order


class TestFigures(unittest.TestCase):
    def test_even_scouting_is_good_with_a_narrow_margin(self):
        grid = grid_of(30, 30)                                # 100 stations per section
        sec = by_section(grid)
        scouted = {n for names in sec.values() for n in names[:30]}
        infested = {n for names in sec.values() for n in names[:3]}
        fig = P.figures(grid, scouted, infested)
        self.assertEqual((fig["stations"], fig["scouted"], fig["infested"]), (900, 270, 27))
        self.assertEqual((fig["raw"], fig["prevalence"], fig["margin"]), (10.0, 10.0, 3.6))
        self.assertEqual((fig["sections_scouted"], fig["sections_total"]), (9, 9))
        self.assertEqual((fig["reliability"], fig["reason"]), ("Good", None))
        self.assertEqual(fig["coverage"], 30.0)

    def test_scouting_in_one_corner_is_too_clustered_to_judge(self):
        grid = grid_of(30, 30)
        corner = by_section(grid)[(0, 0)]
        fig = P.figures(grid, set(corner[:10]), set(corner[:4]))
        self.assertEqual((fig["sections_scouted"], fig["prevalence"]), (1, 40.0))
        self.assertIsNone(fig["margin"])
        self.assertEqual((fig["reason"], fig["reliability"]), (P.CLUSTERED, "Low"))

    def test_one_hot_section_moves_prevalence_by_a_ninth_and_raw_by_its_share(self):
        grid = grid_of(30, 30)
        sec = by_section(grid)
        scouted, infested = set(), set()
        for pos, names in sec.items():
            if pos == (1, 1):
                scouted |= set(names[:50])
                infested |= set(names[:25])
            else:
                scouted |= set(names[:10])
        fig = P.figures(grid, scouted, infested)
        self.assertEqual(fig["prevalence"], round(50 / 9, 1))      # 5.6: one section of nine at 50%
        self.assertEqual(fig["raw"], round(25 / 130 * 100, 1))     # 19.2: its 50 of 130 stations
        self.assertEqual((fig["margin"], fig["reliability"]), (11.6, "Fair"))

    def test_sections_under_three_scouted_are_not_scouted(self):
        grid = grid_of(30, 30)
        sec = by_section(grid)
        scouted, infested = set(), set()
        for pos, names in sec.items():
            if pos == (2, 2):
                scouted |= set(names[:2])
                infested |= set(names[:2])
            else:
                scouted |= set(names[:3])
                infested |= set(names[:1])
        fig = P.figures(grid, scouted, infested)
        corner = next(s for s in fig["sections"] if (s["row"], s["col"]) == (2, 2))
        self.assertEqual((corner["scouted"], corner["infested"], corner["pct"]), (2, 2, None))
        self.assertEqual(fig["sections_scouted"], 8)
        self.assertEqual(fig["prevalence"], 33.3)                   # the 2/2 corner stays out
        self.assertEqual(fig["raw"], round(10 / 26 * 100, 1))       # but raw counts it

    def test_the_users_800_400_200_example_reads_50_percent(self):
        grid = grid_of(80, 10)
        scouted = {f"B{b}-Z{z}" for b in range(1, 81) for z in range(1, 6)}
        infested = {f"B{b}-Z{z}" for b in range(1, 81) for z in (1, 3)}
        infested |= {f"B{b}-Z5" for b in range(1, 81) if b % 2}
        fig = P.figures(grid, scouted, infested)
        self.assertEqual((fig["stations"], fig["scouted"], fig["infested"]), (800, 400, 200))
        self.assertEqual((fig["raw"], fig["coverage"]), (50.0, 50.0))

    def test_no_section_reaching_three_falls_back_to_raw(self):
        grid = grid_of(30, 30)
        sec = by_section(grid)
        scouted = {names[0] for names in sec.values()}            # one per section
        fig = P.figures(grid, scouted, set(list(sorted(scouted))[:3]))
        self.assertEqual((fig["sections_scouted"], fig["prevalence"], fig["raw"]), (0, 33.3, 33.3))
        self.assertIsNone(fig["margin"])
        self.assertEqual((fig["reason"], fig["reliability"]), (P.CLUSTERED, "Low"))

    def test_no_stations_set_up(self):
        fig = P.figures({}, {"Z1"}, {"Z1"})
        self.assertIsNone(fig["prevalence"])
        self.assertEqual((fig["reason"], fig["reliability"], fig["stations"]), (P.NO_STATIONS, "Low", 0))

    def test_nothing_scouted_is_omitted(self):
        self.assertIsNone(P.figures(grid_of(3, 3), set(), set()))

    def test_infested_outside_the_scouted_set_is_ignored(self):
        grid = grid_of(3, 3)
        fig = P.figures(grid, {"B1-Z1"}, {"B1-Z1", "B2-Z2"})
        self.assertEqual(fig["infested"], 1)

    def test_percentages_are_rounded_to_one_decimal(self):
        grid = grid_of(9, 9)
        sec = by_section(grid)
        scouted = {n for names in sec.values() for n in names[:3]}
        infested = {names[0] for names in sec.values()}
        fig = P.figures(grid, scouted, infested)
        self.assertEqual((fig["prevalence"], fig["margin"]), (33.3, 17.8))
        self.assertTrue(all(s["pct"] == 33.3 for s in fig["sections"]))

    def test_precomputed_scouted_counts_give_the_same_answer(self):
        grid = grid_of(9, 9)
        sec = by_section(grid)
        scouted = {n for names in sec.values() for n in names[:3]}
        infested = {names[0] for names in sec.values()}
        self.assertEqual(
            P.figures(grid, scouted, infested, scouted_counts=P.section_counts(grid, scouted)),
            P.figures(grid, scouted, infested),
        )

    def test_reliability_bands(self):
        self.assertEqual(P.reliability(7, 0.10), "Good")
        self.assertEqual(P.reliability(7, 0.11), "Fair")
        self.assertEqual(P.reliability(9, None), "Fair")
        self.assertEqual(P.reliability(4, 0.5), "Fair")
        self.assertEqual(P.reliability(3, 0.01), "Low")


class TestCombine(unittest.TestCase):
    def fig(self, stations, prevalence, margin, rel, scouted=10, infested=1):
        return {"stations": stations, "scouted": scouted, "infested": infested,
                "coverage": 10.0, "raw": 10.0, "prevalence": prevalence, "margin": margin,
                "sections_scouted": 9, "sections_total": 9, "reliability": rel,
                "reason": None, "sections": []}

    def test_combine_weights_by_station_count(self):
        out = P.combine([self.fig(100, 10.0, 4.0, "Good"), self.fig(300, 30.0, 6.0, "Fair")])
        self.assertEqual((out["prevalence"], out["margin"]), (25.0, 4.6))
        self.assertEqual((out["reliability"], out["stations"], out["houses"]), ("Fair", 400, 2))
        self.assertEqual((out["sections_scouted"], out["sections_total"]), (18, 18))

    def test_one_too_clustered_house_leaves_the_margin_unknown(self):
        out = P.combine([self.fig(100, 10.0, None, "Low"), self.fig(300, 30.0, 6.0, "Good")])
        self.assertIsNone(out["margin"])
        self.assertEqual((out["reason"], out["reliability"]), (P.CLUSTERED, "Low"))

    def test_houses_without_figures_are_skipped(self):
        self.assertIsNone(P.combine([None, P.figures({}, {"a"}, set())]))

    def test_public_fills_the_empty_shape(self):
        self.assertEqual(P.public(None), P.EMPTY)
        self.assertEqual(set(P.public(self.fig(1, 1.0, 1.0, "Good"))), set(P.PUBLIC_KEYS))


class TestWeeks(unittest.TestCase):
    def test_week_labels_cross_the_year_boundary(self):
        self.assertEqual(P.yearweek_label(203253), "2032-W53")
        self.assertEqual(P.yearweek_label("203301"), "2033-W01")
        self.assertEqual(P.yearweek_label(None), "")
        self.assertEqual(P.week_monday("2032-W53"), "2032-12-27")
        self.assertEqual(
            P.latest_and_previous({"2033-W01"}, ["2032-W52", "2032-W53", "2033-W01"]),
            ("2033-W01", "2032-W53"),
        )

    def test_one_week_of_data_has_no_previous(self):
        self.assertEqual(P.latest_and_previous({"2031-W10"}, ["2031-W10"]), ("2031-W10", None))
        self.assertEqual(P.latest_and_previous(set(), ["2031-W10"]), (None, None))

    def test_the_latest_comes_from_the_window_the_previous_from_anywhere_before(self):
        self.assertEqual(
            P.latest_and_previous({"2031-W10", "2031-W11"}, ["2031-W08", "2031-W10", "2031-W11", "2031-W12"]),
            ("2031-W11", "2031-W10"),
        )
```

- [ ] **Step 2: Run it and watch it fail.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_prevalence_pure.py`
  Expected: collection error `ModuleNotFoundError: No module named 'upande_scp.serverscripts.common.prevalence'`.

- [ ] **Step 3: Implement.** Create `upande_scp/serverscripts/common/prevalence.py`:

```python
"""Station prevalence with a spatial confidence — the pure measure.

Spec: docs/superpowers/specs/2026-10-09-station-prevalence-design.md §1.

A *station* is a rose Zone or an avocado Orchard Tree. For one greenhouse/block,
one ISO week and one observation:

* ``raw``         = infested / scouted over every scouted station (D1).
* sections        = a fixed 3 × 3 grid from bed (row) order × zone (tree) order
                    within the bed (D3) — no geometry, no setup.
* ``prevalence``  = mean of the section rates over the sections with at least
                    ``MIN_SECTION_N`` scouted stations, so scouting that bunches in
                    one part of the house does not drag the figure toward that part.
* ``margin``      = 1.96 · sqrt(s²/m + p(1−p)/N), clipped to [0, 1].
* ``reliability`` = Good (m ≥ 7 and margin ≤ 0.10) / Fair (m ≥ 4) / Low.

Every percentage leaves this module as a 0–100 float rounded to 1 dp.
No frappe import: this runs under plain pytest.
"""

import math
import re
from datetime import date

GRID = 3
SECTIONS = GRID * GRID
MIN_SECTION_N = 3
Z95 = 1.96
GOOD_MIN_SECTIONS = 7
GOOD_MAX_MARGIN = 0.10
FAIR_MIN_SECTIONS = 4
RELIABILITY = ("Good", "Fair", "Low")
CLUSTERED = "too clustered to judge"
NO_STATIONS = "no stations set up"

#: The figure fields every aggregate payload carries (see ``public``).
PUBLIC_KEYS = (
    "prevalence", "prev", "margin", "sections_scouted", "sections_total",
    "reliability", "reason", "raw", "coverage", "scouted", "stations", "week",
)
EMPTY = {
    "prevalence": None, "prev": None, "margin": None,
    "sections_scouted": 0, "sections_total": SECTIONS,
    "reliability": "Low", "reason": NO_STATIONS,
    "raw": None, "coverage": None, "scouted": 0, "stations": 0, "week": None,
}

# Digits at the very end of a name: "… - Bed 77", "… - Row 10", "…_T38".
# Anchored to the end on purpose — "GH 01 - KR - Bed 7a" must NOT read as 1.
_TRAILING_INT = re.compile(r"(\d+)\s*$")


def station_number(value, name) -> int | None:
    """A station's (or bed's / row's) order number.

    The doctype's own number when it is a positive integer (``Zone.zone``,
    ``Bed.bed``), else the trailing integer of the name (``Orchard Tree.tree`` is
    0 on every tree on kaitet.local, so trees always land here), else ``None`` —
    the station is then placed by name order, never dropped.
    """
    try:
        n = int(str(value).strip()) if value not in (None, "") else 0
    except (TypeError, ValueError):
        n = 0
    if n > 0:
        return n
    m = _TRAILING_INT.search(str(name or ""))
    return int(m.group(1)) if m else None


def _order_key(number, name) -> tuple:
    return (number is None, number if number is not None else 0, str(name or ""))


def grid_positions(stations) -> dict:
    """``{station_name: (row, col)}`` for one greenhouse/block (spec D3).

    ``stations`` yields ``{"name", "group", "group_no", "no"}``: ``group`` is the
    bed (rose) or row (avocado) the station sits in, ``group_no`` / ``no`` their
    order numbers (``None`` = unparsable → name order). Groups are ranked ``b`` of
    ``B``; a station is ranked ``z`` of ``Z_b`` inside its group; its section is
    ``(floor(3·b/B), floor(3·z/Z_b))``. Fewer than 3 groups, or a group of 1–2
    stations, still maps every station; the unused sections stay empty.
    """
    groups: dict = {}
    group_no: dict = {}
    for s in stations:
        g = s.get("group") or ""
        groups.setdefault(g, []).append(s)
        group_no.setdefault(g, s.get("group_no"))
    ordered = sorted(groups, key=lambda g: _order_key(group_no[g], g))
    n_groups = len(ordered)
    out: dict = {}
    for b, g in enumerate(ordered):
        row = (GRID * b) // n_groups
        members = sorted(groups[g], key=lambda s: _order_key(s.get("no"), s["name"]))
        size = len(members)
        for z, s in enumerate(members):
            out[s["name"]] = (row, (GRID * z) // size)
    return out


def section_counts(grid: dict, stations) -> list:
    """How many of ``stations`` fall in each section, row-major (9 numbers).
    Stations missing from the grid are not counted."""
    counts = [0] * SECTIONS
    for name in stations:
        pos = grid.get(name)
        if pos is not None:
            counts[pos[0] * GRID + pos[1]] += 1
    return counts


def _pct(fraction):
    return None if fraction is None else round(fraction * 100, 1)


def reliability(m: int, margin) -> str:
    """Good if m ≥ 7 and margin ≤ 0.10; Fair if m ≥ 4; else Low. ``margin`` is a
    0–1 fraction; ``None`` (too clustered) can never be Good."""
    if m >= GOOD_MIN_SECTIONS and margin is not None and margin <= GOOD_MAX_MARGIN:
        return "Good"
    if m >= FAIR_MIN_SECTIONS:
        return "Fair"
    return "Low"


def figures(grid: dict, scouted, infested, scouted_counts=None):
    """The figures for one greenhouse/block, one ISO week, one observation.

    ``scouted``  — stations with at least one Scouting Entry that week.
    ``infested`` — stations where an entry that week records the observation;
                   anything outside ``scouted`` is ignored.
    ``scouted_counts`` — ``section_counts(grid, scouted)`` when the caller already
                   has it (it is the same for every observation of the week).

    Returns ``None`` when nothing was scouted (the week is omitted, not 0%), and a
    "no stations set up" shape when the house has no Zone / Orchard Tree rows.
    When no section reaches ``MIN_SECTION_N`` scouted stations (m = 0) the only
    estimate left is ``raw``, which is reported with no margin.
    """
    scouted = set(scouted or ())
    if not scouted:
        return None
    infested = set(infested or ()) & scouted
    if not grid:
        return {
            "stations": 0, "scouted": len(scouted), "infested": len(infested),
            "coverage": None, "raw": None, "prevalence": None, "margin": None,
            "sections_scouted": 0, "sections_total": SECTIONS,
            "reliability": "Low", "reason": NO_STATIONS, "sections": [],
        }
    counts = scouted_counts if scouted_counts is not None else section_counts(grid, scouted)
    hits = section_counts(grid, infested)
    sections, rates, n_total = [], [], 0
    for j in range(SECTIONS):
        n, x = counts[j], hits[j]
        pct = None
        if n >= MIN_SECTION_N:
            rates.append(x / n)
            n_total += n
            pct = _pct(x / n)
        sections.append({"row": j // GRID, "col": j % GRID, "scouted": n, "infested": x, "pct": pct})
    m = len(rates)
    raw = len(infested) / len(scouted)
    p = sum(rates) / m if m else raw
    margin = None
    if m >= 2:
        s2 = sum((q - p) ** 2 for q in rates) / (m - 1)
        margin = min(1.0, max(0.0, Z95 * math.sqrt(s2 / m + p * (1 - p) / n_total)))
    return {
        "stations": len(grid),
        "scouted": len(scouted),
        "infested": len(infested),
        "coverage": _pct(sum(counts) / len(grid)),
        "raw": _pct(raw),
        "prevalence": _pct(p),
        "margin": _pct(margin),
        "sections_scouted": m,
        "sections_total": SECTIONS,
        "reliability": reliability(m, margin),
        "reason": CLUSTERED if m < 2 else None,
        "sections": sections,
    }


def combine(figs):
    """Scope-wide figures from per-house ones (several greenhouses / blocks).

    Prevalence is the station-weighted mean of the houses' adjusted prevalence
    ("how much of the farm"). The margin is the weighted houses' margins added in
    quadrature — unknown (``None``) as soon as one house is too clustered to judge.
    Reliability is the worst house's. Houses without figures are skipped.
    """
    figs = [f for f in (figs or []) if f and f.get("prevalence") is not None and f.get("stations")]
    if not figs:
        return None
    weight = sum(f["stations"] for f in figs)
    scouted = sum(f.get("scouted") or 0 for f in figs)
    infested = sum(f.get("infested") or 0 for f in figs)
    in_grid = sum((f.get("coverage") or 0) * f["stations"] / 100 for f in figs)
    p = sum(f["stations"] * f["prevalence"] for f in figs) / weight
    if any(f.get("margin") is None for f in figs):
        margin = None
    else:
        margin = math.sqrt(sum((f["stations"] * f["margin"]) ** 2 for f in figs)) / weight
    worst = max(RELIABILITY.index(f.get("reliability") or "Low") for f in figs)
    return {
        "stations": weight,
        "scouted": scouted,
        "infested": infested,
        "coverage": round(in_grid / weight * 100, 1),
        "raw": round(infested / scouted * 100, 1) if scouted else None,
        "prevalence": round(p, 1),
        "margin": None if margin is None else round(margin, 1),
        "sections_scouted": sum(f.get("sections_scouted") or 0 for f in figs),
        "sections_total": sum(f.get("sections_total") or SECTIONS for f in figs),
        "reliability": RELIABILITY[worst],
        "reason": CLUSTERED if margin is None else None,
        "houses": len(figs),
        "sections": [],
    }


def public(fig) -> dict:
    """The figure fields a payload row carries; ``EMPTY`` when there are none."""
    if not fig:
        return dict(EMPTY)
    return {k: fig.get(k) for k in PUBLIC_KEYS}


def yearweek_label(value) -> str:
    """MariaDB ``YEARWEEK(d, 3)`` (e.g. 203253) → ``"2032-W53"``, the label
    ``_trends.week_key`` produces. ``""`` for anything unreadable."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return ""
    year, week = divmod(v, 100)
    if year <= 0 or not 1 <= week <= 53:
        return ""
    return f"{year:04d}-W{week:02d}"


def week_monday(label: str) -> str:
    """``"2032-W53"`` → ``"2032-12-27"`` (the ISO Monday, as YYYY-MM-DD)."""
    year, week = label.split("-W")
    return date.fromisocalendar(int(year), int(week), 1).isoformat()


def latest_and_previous(window_weeks, all_weeks) -> tuple:
    """Spec D4: the latest week with scouting inside the window, and the most
    recent scouted week before it (which may lie before the window)."""
    window = sorted(set(window_weeks or ()))
    if not window:
        return None, None
    latest = window[-1]
    earlier = sorted(w for w in set(all_weeks or ()) if w < latest)
    return latest, (earlier[-1] if earlier else None)
```

- [ ] **Step 4: Run it and watch it pass.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_prevalence_pure.py`
  Expected: `24 passed`.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add upande_scp/serverscripts/common/prevalence.py upande_scp/serverscripts/tests/test_prevalence_pure.py
git commit -m "feat(scp): station prevalence measure with a 3 × 3 spatial confidence"
```

---

### Task 2: `_prevalence_rows.py` — cached station grids and weekly station sets

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py`
- Modify: `upande_scp/serverscripts/common/cache_utils.py` (key block ends at `K_ZONE_CENTROIDS`, :100; `invalidate_on_change`, :667)
- Create: `upande_scp/serverscripts/tests/prevalence_fixture.py`, `upande_scp/serverscripts/tests/test_prevalence_rows_pure.py`, `upande_scp/serverscripts/tests/test_prevalence_rows.py`
- Modify: `upande_scp/serverscripts/tests/test_cache_invalidation.py` (append one class)

**Interfaces:**
- Consumes: Task 1 `prevalence` (`station_number`, `grid_positions`, `section_counts`, `figures`, `combine`, `yearweek_label`, `latest_and_previous`). `_common.parent_filter_conditions(from_date, to_date, crop, scope) -> (where, params)` (:455) and `_common.obs_filter(kind, column, params) -> str` (:501). `cache_utils.get_or_set(key, builder, ttl)`, `cache_utils.invalidate(*keys)`, `cache_utils.TTL_LONG`.
- Produces:
  - `cache_utils.K_STATION_GRID_PREFIX = "scp:station_grid_v1"`, `cache_utils.invalidate_station_grid_for_doc(doc) -> None`
  - module `upande_scp.serverscripts.dashboard_aggregates._prevalence_rows`: `ANY = None`, `PREVIOUS_LOOKBACK_DAYS = 35`, `grid_key(warehouse) -> str`, `_load_grid(warehouse) -> dict`, `station_grid(warehouse) -> dict`
  - `class StationWeeks(scouted_rows, infested_rows, grid_loader=None)` with:
    - `StationWeeks.load(from_date, to_date, crop, scope, kinds=("pest", "disease"), lookback_days=35, grid_loader=None) -> StationWeeks` (classmethod)
    - `.warehouses() -> list[str]`, `.window_weeks() -> list[str]`, `.warehouses_in(week) -> list[str]`, `.weeks(wh) -> list[str]`, `.latest_pair(wh) -> (str | None, str | None)`
    - `.infested_set(wh, week, kind, obs=ANY, stage=ANY, section=ANY) -> set[str]`
    - `.figures(wh, week, kind, obs=ANY, stage=ANY, section=ANY) -> dict | None` (adds `"week"`)
    - `.latest(wh, kind, obs=ANY, stage=ANY, section=ANY) -> dict | None` (adds `"week"`, `"prev"`)
    - `.previous(wh, kind, obs=ANY, stage=ANY, section=ANY) -> dict | None`
    - `.combined_latest(kind, obs=ANY, stage=ANY, section=ANY) -> dict | None` (adds `"prev"`)
  - test fixture `prevalence_fixture`: `WEEK_10`, `WEEK_11`, `WEEK_53`, `WEEK_01`, `insert_station_entry(...)`, `stations_by_section(grid)`, `seed_even_week(...)`, `rose_greenhouses(n)`

- [ ] **Step 1: Write the failing tests.**

Create `upande_scp/serverscripts/tests/prevalence_fixture.py`:

```python
"""Raw-SQL Scouting Entries placed on real stations, for the station-prevalence tests.

Same contract as crop_scoping_fixture: raw inserts skip the controller and the
cache-busting doc events, so callers roll back in tearDown and pass ``force="1"``
to cached aggregates. Dated 2031–2033: kaitet.local has no scouting there (its
data runs 2026-07-01 → 2026-09-09), so a window holds only what a test inserted.
"""

import frappe
from frappe.utils import now

from upande_scp.serverscripts.tests import crop_scoping_fixture as F

WEEK_10 = ("2031-03-03", "2031-03-09")  # 2031-W10
WEEK_11 = ("2031-03-10", "2031-03-16")  # 2031-W11
WEEK_53 = ("2032-12-27", "2033-01-02")  # 2032-W53 — 2033-01-02 (a Sunday) still belongs to it
WEEK_01 = ("2033-01-03", "2033-01-09")  # 2033-W01


def rose_greenhouses(n: int = 2) -> list:
    """The first `n` Rose greenhouses (by name) that have Zone rows."""
    farms = tuple(r[0] for r in frappe.db.sql(
        "select farm from `tabFarm Filter` where parenttype='Crop Scouted' and parent='Rose'"))
    return [r[0] for r in frappe.db.sql(
        """select w.name from `tabWarehouse` w
           where w.custom_farm in %(f)s and w.is_group=0 and w.warehouse_type='Greenhouse'
             and w.disabled=0 and w.name like '%%GH%%'
             and exists (select 1 from `tabZone` z where z.greenhouse = w.name)
           order by w.name limit %(n)s""",
        {"f": farms, "n": n},
    )]


def insert_station_entry(*, date, greenhouse=None, zone=None, block=None, tree=None,
                         crop=None, pests=(), diseases=(), pest_count=3, pest_stage="Adult") -> str:
    """One Scouting Entry on a real Zone (rose) or Orchard Tree (avocado)."""
    name = "_TEST-SP-" + frappe.generate_hash(length=10)
    bed = frappe.db.get_value("Zone", zone, "bed") if zone else None
    row = frappe.db.get_value("Orchard Tree", tree, "row") if tree else None
    stamp = now()
    frappe.db.sql(
        """insert into `tabScouting Entry`
           (name, creation, modified, owner, modified_by, docstatus, idx, naming_series,
            scouts_name, greenhouse, block, zone, bed, tree, `row`, date_of_capture,
            time_of_capture, crop_scouted, latitude, longitude)
           values (%(name)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, 0,
            'SCE-.YYYY.-', %(scout)s, %(gh)s, %(block)s, %(zone)s, %(bed)s, %(tree)s, %(row)s,
            %(date)s, '08:00:00', %(crop)s, '0', '0')""",
        {
            "name": name, "ts": stamp, "scout": F._scout(),
            "gh": greenhouse, "block": block, "zone": zone, "bed": bed,
            "tree": tree, "row": row, "date": date, "crop": crop,
        },
    )
    for i, pest in enumerate(pests, start=1):
        frappe.db.sql(
            """insert into `tabPests Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, pest, stage, plant_section, `count`)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s,
                %(p)s, 'Scouting Entry', 'pests_scouting_entry', %(pest)s, %(stage)s, 'Leaf', %(c)s)""",
            {"n": frappe.generate_hash(length=12), "ts": stamp, "i": i, "p": name,
             "pest": pest, "stage": pest_stage, "c": pest_count},
        )
    for i, disease in enumerate(diseases, start=1):
        frappe.db.sql(
            """insert into `tabDiseases Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, disease, stage, plant_section)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s,
                %(p)s, 'Scouting Entry', 'diseases_scouting_entry', %(d)s, 'Active', 'Leaf')""",
            {"n": frappe.generate_hash(length=12), "ts": stamp, "i": i, "p": name, "d": disease},
        )
    return name


def stations_by_section(grid: dict) -> dict:
    """{(row, col): [station names sorted]}"""
    out: dict = {}
    for name, pos in grid.items():
        out.setdefault(tuple(pos), []).append(name)
    return {k: sorted(v) for k, v in out.items()}


def seed_even_week(warehouse, date, *, crop, per_section=3, infested_per_section=1,
                   pest="Thrips", disease=None, block=False) -> list:
    """`per_section` stations scouted in each of the 9 sections on `date`; the first
    `infested_per_section` of them carry `pest` (and `disease`). Same stations every
    call, so two weeks seeded this way share their scouted set."""
    from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R

    names = []
    for _pos, stations in sorted(stations_by_section(R._load_grid(warehouse)).items()):
        for i, st in enumerate(stations[:per_section]):
            hit = i < infested_per_section
            where = {"block": warehouse, "tree": st} if block else {"greenhouse": warehouse, "zone": st}
            names.append(insert_station_entry(
                date=date, crop=crop,
                pests=[pest] if hit and pest else [],
                diseases=[disease] if hit and disease else [],
                **where,
            ))
    return names
```

Create `upande_scp/serverscripts/tests/test_prevalence_rows_pure.py`:

```python
"""StationWeeks over hand-built rows — runs under plain pytest, no site."""

import unittest
from importlib import import_module
from unittest.mock import patch

R = import_module("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows")

# 27 stations, 3 in each of the 9 sections.
GRID = {f"Z{r}{c}{k}": (r, c) for r in range(3) for c in range(3) for k in range(3)}
EVEN = sorted(n for n in GRID if n.endswith("0") or n.endswith("1") or n.endswith("2"))


def scouted(wh, yw, stations, in_win=1):
    return [{"wh": wh, "station": s, "yw": yw, "in_win": in_win} for s in stations]


def infested(wh, yw, stations, obs="Thrips", stage="Adult", section="Leaf", kind="pest"):
    return [{"wh": wh, "station": s, "yw": yw, "kind": kind, "obs": obs,
             "stage": stage, "section": section} for s in stations]


def first_of_each_section(k=1):
    return [n for n in GRID if int(n[-1]) < k]


def weeks(scouted_rows, infested_rows):
    return R.StationWeeks(scouted_rows, infested_rows, grid_loader=lambda wh: dict(GRID))


class TestStationWeeks(unittest.TestCase):
    def test_latest_week_and_the_previous_scouted_week(self):
        w = weeks(
            scouted("GH A", 203109, EVEN, in_win=0) + scouted("GH A", 203110, EVEN),
            infested("GH A", 203109, first_of_each_section(2)) + infested("GH A", 203110, first_of_each_section(1)),
        )
        self.assertEqual(w.latest_pair("GH A"), ("2031-W10", "2031-W09"))
        fig = w.latest("GH A", "pest", "Thrips")
        self.assertEqual((fig["week"], fig["prevalence"], fig["prev"]), ("2031-W10", 33.3, 66.7))

    def test_only_one_week_has_no_previous(self):
        w = weeks(scouted("GH A", 203110, EVEN), infested("GH A", 203110, first_of_each_section(1)))
        self.assertIsNone(w.latest("GH A", "pest", "Thrips")["prev"])

    def test_a_house_not_scouted_that_week_is_omitted(self):
        w = weeks(
            scouted("GH A", 203110, EVEN) + scouted("GH B", 203109, EVEN, in_win=0),
            infested("GH B", 203109, first_of_each_section(1)),
        )
        self.assertEqual(w.warehouses(), ["GH A"])                    # B only has lookback weeks
        self.assertEqual(w.warehouses_in("2031-W10"), ["GH A"])
        self.assertIsNone(w.figures("GH A", "2031-W11", "pest", "Thrips"))
        self.assertIsNone(w.latest("GH B", "pest", "Thrips"))

    def test_a_clean_scouted_house_reads_zero_not_absent(self):
        w = weeks(scouted("GH A", 203110, EVEN), [])
        self.assertEqual(w.latest("GH A", "pest", "Thrips")["prevalence"], 0.0)

    def test_stage_and_section_filters_narrow_the_infested_set(self):
        rows = (infested("GH A", 203110, ["Z000"], stage="Adult", section="Leaf")
                + infested("GH A", 203110, ["Z010"], stage="Larvae", section="Stem")
                + infested("GH A", 203110, ["Z020"], obs="Aphids"))
        w = weeks(scouted("GH A", 203110, EVEN), rows)
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest", "Thrips"), {"Z000", "Z010"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest", "Thrips", stage="Larvae"), {"Z010"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest", section="Leaf"), {"Z000", "Z020"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "pest"), {"Z000", "Z010", "Z020"})
        self.assertEqual(w.infested_set("GH A", "2031-W10", "disease"), set())

    def test_the_grid_loader_is_looked_up_when_called(self):
        # The regression suites patch _prevalence_rows.station_grid; that only works
        # if StationWeeks resolves it at call time, not at definition time.
        w = R.StationWeeks(scouted("GH A", 203110, EVEN), [])
        with patch.object(R, "station_grid", return_value=dict(GRID)) as loader:
            self.assertEqual(w.latest("GH A", "pest", "Thrips")["stations"], 27)
        loader.assert_called_once_with("GH A")

    def test_combined_latest_weights_the_houses(self):
        w = weeks(
            scouted("GH A", 203110, EVEN) + scouted("GH B", 203110, EVEN),
            infested("GH A", 203110, first_of_each_section(1)),
        )
        out = w.combined_latest("pest", "Thrips")
        # Equal-sized houses at 33.3% and 0%: (27·33.3 + 27·0) / 54, rounded the way combine does.
        self.assertEqual((out["prevalence"], out["houses"], out["prev"]), (round(27 * 33.3 / 54, 1), 2, None))

    def test_year_boundary_weeks_order_correctly(self):
        w = weeks(scouted("GH A", 203253, EVEN, in_win=0) + scouted("GH A", 203301, EVEN), [])
        self.assertEqual(w.latest_pair("GH A"), ("2033-W01", "2032-W53"))
        self.assertEqual(w.window_weeks(), ["2033-W01"])

    def test_rows_without_a_station_are_ignored(self):
        w = weeks([{"wh": "GH A", "station": "", "yw": 203110, "in_win": 1}], [])
        self.assertEqual(w.warehouses(), [])
```

Append to `upande_scp/serverscripts/tests/test_cache_invalidation.py`:

```python


class TestStationGridInvalidation(unittest.TestCase):
    """A Zone, Bed or Orchard Tree save drops its house's cached 3 × 3 grid."""

    def _keys(self, doc):
        from upande_scp.serverscripts.common import cache_utils as cu
        with patch.object(cu, "invalidate") as inv, \
             patch.object(cu, "invalidate_scouting_payload"), \
             patch.object(cu, "invalidate_farm_bundle_for_doc"), \
             patch.object(cu, "invalidate_orchard_trees_for_doc"):
            cu.invalidate_on_change(doc)
        return [a for c in inv.call_args_list for a in c.args]

    def test_zone_bed_and_tree_saves_drop_their_houses_grid(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        cases = [
            (SimpleNamespace(doctype="Zone", name="Z", greenhouse="GH 1", bed="GH 1 - Bed 1"), "GH 1"),
            (SimpleNamespace(doctype="Bed", name="GH 2 - Bed 1", greenhouse="GH 2"), "GH 2"),
            (SimpleNamespace(doctype="Orchard Tree", name="T", block="BLK 1", row="BLK 1 - Row 1"), "BLK 1"),
        ]
        for doc, wh in cases:
            self.assertIn(f"{cu.K_STATION_GRID_PREFIX}:{wh}", self._keys(doc), doc.doctype)

    def test_a_zone_without_a_greenhouse_drops_no_grid(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        keys = self._keys(SimpleNamespace(doctype="Zone", name="Z-1"))
        self.assertFalse([k for k in keys if str(k).startswith(cu.K_STATION_GRID_PREFIX)])
```

Create `upande_scp/serverscripts/tests/test_prevalence_rows.py`:

```python
"""Station grids and weekly station sets on kaitet.local. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts.common import cache_utils, crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF

AVOCADO_PEST = "Fruit fly (Ceratitis)"  # Avocado Pest Filter only


class TestStationGrid(unittest.TestCase):
    def tearDown(self):
        frappe.db.rollback()

    def test_every_zone_of_the_greenhouse_is_placed(self):
        gh = F.rose_greenhouse()
        grid = R._load_grid(gh)
        self.assertEqual(len(grid), frappe.db.count("Zone", {"greenhouse": gh}))
        self.assertEqual(set(grid.values()), {(r, c) for r in range(3) for c in range(3)})

    def test_every_tree_of_a_block_with_tiny_rows_is_placed(self):
        tiny = frappe.db.sql(
            """select block, `row` from `tabOrchard Tree` group by block, `row`
               having count(*) <= 2 order by block, `row` limit 1""", as_dict=True)
        if not tiny:
            self.skipTest("no orchard row of 1–2 trees on this site")
        block, row = tiny[0].block, tiny[0].row
        grid = R._load_grid(block)
        self.assertEqual(len(grid), frappe.db.count("Orchard Tree", {"block": block}))
        cols = {grid[t][1] for t in frappe.get_all("Orchard Tree", filters={"row": row}, pluck="name")}
        self.assertTrue(cols <= {0, 1})

    def test_the_grid_is_cached_and_a_tree_save_drops_it(self):
        block = F.avocado_block()
        cache_utils.invalidate(R.grid_key(block))
        first = R.station_grid(block)
        self.assertEqual(frappe.cache().get_value(R.grid_key(block), expires=True), first)
        tree = frappe.get_all("Orchard Tree", filters={"block": block}, fields=["name", "block", "row"], limit=1)[0]
        cache_utils.invalidate_station_grid_for_doc(frappe._dict(doctype="Orchard Tree", **tree))
        self.assertIsNone(frappe.cache().get_value(R.grid_key(block), expires=True))


class TestStationWeeks(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _zone(self):
        return sorted(R._load_grid(self.gh))[0]

    def test_even_scouting_reads_the_house_prevalence(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        weeks = R.StationWeeks.load(*PF.WEEK_10, "Rose", [self.gh])
        fig = weeks.latest(self.gh, "pest", "Thrips")
        self.assertEqual((fig["scouted"], fig["infested"]), (27, 9))
        self.assertEqual((fig["prevalence"], fig["margin"]), (33.3, 17.8))
        self.assertEqual((fig["sections_scouted"], fig["reliability"]), (9, "Fair"))
        self.assertEqual(fig["stations"], frappe.db.count("Zone", {"greenhouse": self.gh}))
        self.assertEqual((fig["week"], fig["prev"]), ("2031-W10", None))

    def test_the_previous_scouted_week_comes_from_before_the_window(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        PF.seed_even_week(self.gh, PF.WEEK_11[0], crop="Rose", infested_per_section=0)
        weeks = R.StationWeeks.load(*PF.WEEK_11, "Rose", [self.gh])
        self.assertEqual(weeks.latest_pair(self.gh), ("2031-W11", "2031-W10"))
        fig = weeks.latest(self.gh, "pest", "Thrips")
        self.assertEqual((fig["prevalence"], fig["prev"]), (0.0, 33.3))

    def test_a_house_not_scouted_in_the_window_is_omitted(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        weeks = R.StationWeeks.load(*PF.WEEK_11, "Rose", [self.gh])
        self.assertEqual(weeks.warehouses(), [])
        self.assertIsNone(weeks.latest(self.gh, "pest", "Thrips"))

    def test_mariadb_iso_weeks_match_python_at_week_53(self):
        z = self._zone()
        # 2033-01-02 is a Sunday: ISO week 2032-W53, not 2033-W01.
        PF.insert_station_entry(date=PF.WEEK_53[1], greenhouse=self.gh, zone=z, crop="Rose", pests=["Thrips"])
        PF.insert_station_entry(date=PF.WEEK_01[0], greenhouse=self.gh, zone=z, crop="Rose")
        weeks = R.StationWeeks.load(*PF.WEEK_01, "Rose", [self.gh])
        self.assertEqual(weeks.latest_pair(self.gh), ("2033-W01", "2032-W53"))
        fig = weeks.latest(self.gh, "pest", "Thrips")
        self.assertEqual((fig["prevalence"], fig["prev"]), (0.0, 100.0))

    def test_a_pest_row_with_no_count_and_no_stage_does_not_infest(self):
        z = self._zone()
        PF.insert_station_entry(date=PF.WEEK_10[0], greenhouse=self.gh, zone=z, crop="Rose",
                                pests=["Thrips"], pest_count=0, pest_stage="")
        weeks = R.StationWeeks.load(*PF.WEEK_10, "Rose", [self.gh])
        self.assertEqual(weeks.infested_set(self.gh, "2031-W10", "pest", "Thrips"), set())
        self.assertEqual(weeks.latest(self.gh, "pest", "Thrips")["scouted"], 1)

    def test_piece_one_crop_scoping_still_holds(self):
        z = self._zone()
        PF.insert_station_entry(date=PF.WEEK_10[0], greenhouse=self.gh, zone=z, crop=None,
                                pests=["Thrips", AVOCADO_PEST])
        rose = R.StationWeeks.load(*PF.WEEK_10, "Rose", None)
        self.assertIn(self.gh, rose.warehouses())                                        # D5
        self.assertEqual(rose.infested_set(self.gh, "2031-W10", "pest", AVOCADO_PEST), set())  # D4
        self.assertEqual(rose.infested_set(self.gh, "2031-W10", "pest", "Thrips"), {z})
        avocado = R.StationWeeks.load(*PF.WEEK_10, "Avocado", None)
        self.assertNotIn(self.gh, avocado.warehouses())

    def test_avocado_stations_are_trees(self):
        block = F.avocado_block()
        PF.seed_even_week(block, PF.WEEK_10[0], crop="Avocado", pest=AVOCADO_PEST, block=True)
        weeks = R.StationWeeks.load(*PF.WEEK_10, "Avocado", [block])
        fig = weeks.latest(block, "pest", AVOCADO_PEST)
        self.assertEqual(fig["stations"], frappe.db.count("Orchard Tree", {"block": block}))
        self.assertEqual((fig["scouted"], fig["prevalence"], fig["sections_scouted"]), (27, 33.3, 9))
```

- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_cache_invalidation.py`
  Expected: `ModuleNotFoundError: No module named 'upande_scp.serverscripts.dashboard_aggregates._prevalence_rows'` for the first file. `TestStationGridInvalidation` fails with `AttributeError: module … has no attribute 'K_STATION_GRID_PREFIX'`.
  Then run DB-RUN `test_prevalence_rows`. Expected: `ImportError` on `_prevalence_rows`.

- [ ] **Step 3: Implement.**

In `upande_scp/serverscripts/common/cache_utils.py`, directly after the line `K_ZONE_CENTROIDS = "scp:zone_centroids_v1"` (:100), add:

```python
# Per-house 3 × 3 station grid for station prevalence (dashboard_aggregates/
# _prevalence_rows.py). Suffix is the greenhouse/block name. Dropped by
# invalidate_station_grid_for_doc whenever a Zone, Bed or Orchard Tree of that
# house is saved or deleted.
K_STATION_GRID_PREFIX = "scp:station_grid_v1"
```

In the same file, directly above `def invalidate_farm_bundle_for_doc(doc):`, add:

```python
def invalidate_station_grid_for_doc(doc):
    """Drop the cached station grid of the house a Zone / Bed / Orchard Tree is in.

    An avocado row is a Bed whose ``greenhouse`` is the block, so Bed covers both
    crops. A tree saved before ``block`` is set resolves it through its row.
    """
    dt = getattr(doc, "doctype", None)
    if dt in ("Zone", "Bed"):
        wh = getattr(doc, "greenhouse", None)
    elif dt == "Orchard Tree":
        wh = getattr(doc, "block", None)
        row = getattr(doc, "row", None)
        if not wh and row:
            wh = frappe.db.get_value("Bed", row, "greenhouse")
    else:
        return
    if wh:
        invalidate(f"{K_STATION_GRID_PREFIX}:{wh}")
```

In `invalidate_on_change` (:667), directly after the block

```python
    # Drop the per-block Orchard Tree FeatureCollection when trees move.
    if doc.doctype == "Orchard Tree":
        invalidate_orchard_trees_for_doc(doc)
```

add:

```python
    # Drop the house's 3 × 3 station grid when its stations or beds change.
    if doc.doctype in ("Zone", "Bed", "Orchard Tree"):
        invalidate_station_grid_for_doc(doc)
```

Create `upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py`:

```python
"""Station prevalence rows — the database side of ``common/prevalence.py``.

For a crop + greenhouse scope + date window this loads, per greenhouse/block and
ISO week, the stations SCOUTED (any Scouting Entry, clean ones included) and the
stations INFESTED per (kind, observation, stage, plant section), and hands them
to the pure measure. Crop scoping is piece 1's: ``parent_filter_conditions``
(D5 — a crop-less entry counts under its greenhouse's crop) and ``obs_filter``
(D4 — off-crop pests/diseases drop out).

A station is ``Scouting Entry.zone`` (a rose ``Zone``) or, when the entry is on a
block, ``Scouting Entry.tree`` (an avocado ``Orchard Tree``). An entry with
neither (bed-only legacy rows) places no station and stays out of prevalence.

Week choice (spec D4): per house, the latest ISO week with scouting dated inside
the window, and the most recent scouted week before it — looked up to
``PREVIOUS_LOOKBACK_DAYS`` before the window, so a one-week range still has a
"was" figure. A week that straddles the window start uses that whole ISO week.
ISO weeks come from MariaDB ``YEARWEEK(d, 3)``, the same weeks Python's
``isocalendar()`` gives (pinned at week 53 by test_prevalence_rows).
"""

from datetime import datetime, timedelta

import frappe

from upande_scp.serverscripts.common import cache_utils
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates._common import (
    obs_filter,
    parent_filter_conditions,
)

#: "any value" for the observation / stage / section selectors.
ANY = None
PREVIOUS_LOOKBACK_DAYS = 35

_WH = "CASE WHEN COALESCE(se.block, '') <> '' THEN se.block ELSE se.greenhouse END"
_STATION = "CASE WHEN COALESCE(se.block, '') <> '' THEN se.tree ELSE se.zone END"
_WEEK = "YEARWEEK(se.date_of_capture, 3)"


def grid_key(warehouse: str) -> str:
    return f"{cache_utils.K_STATION_GRID_PREFIX}:{warehouse}"


def _load_grid(warehouse: str) -> dict:
    """{station: (row, col)} built from Zone (rose) or, failing that, Orchard Tree
    (avocado). Bed numbers come from ``Bed.bed``; zone numbers from ``Zone.zone``;
    tree numbers from the tree's name (``Orchard Tree.tree`` is 0 on every tree)."""
    rows = frappe.db.sql(
        """
        SELECT z.name, z.bed AS grp, b.bed AS grp_no, z.zone AS no
        FROM `tabZone` z
        LEFT JOIN `tabBed` b ON b.name = z.bed
        WHERE z.greenhouse = %(wh)s
        """,
        {"wh": warehouse},
        as_dict=True,
    )
    if not rows:
        rows = frappe.db.sql(
            """
            SELECT t.name, t.`row` AS grp, b.bed AS grp_no, t.tree AS no
            FROM `tabOrchard Tree` t
            LEFT JOIN `tabBed` b ON b.name = t.`row`
            WHERE t.block = %(wh)s
            """,
            {"wh": warehouse},
            as_dict=True,
        )
    return P.grid_positions(
        {
            "name": r.name,
            "group": r.grp or "",
            "group_no": P.station_number(r.grp_no, r.grp),
            "no": P.station_number(r.no, r.name),
        }
        for r in rows
    )


def station_grid(warehouse: str) -> dict:
    """Cached ``_load_grid``; dropped by ``cache_utils.invalidate_station_grid_for_doc``."""
    if not warehouse:
        return {}
    return cache_utils.get_or_set(
        grid_key(warehouse), lambda: _load_grid(warehouse), cache_utils.TTL_LONG,
    )


def _shift(day: str, days: int) -> str:
    if not day or not days:
        return day
    return (datetime.strptime(str(day)[:10], "%Y-%m-%d").date() + timedelta(days=days)).isoformat()


def _fetch_scouted(where: str, params: dict, win_from: str) -> list:
    """Distinct (house, station, ISO week) with any entry; ``in_win`` marks weeks
    that have scouting dated inside the requested window."""
    return frappe.db.sql(
        f"""
        SELECT DISTINCT {_WH} AS wh, {_STATION} AS station, {_WEEK} AS yw,
               (se.date_of_capture >= %(win_from)s) AS in_win
        FROM `tabScouting Entry` se
        WHERE {where} AND COALESCE({_STATION}, '') <> ''
        """,
        {**params, "win_from": win_from},
        as_dict=True,
    )


def _fetch_infested(where: str, params: dict, kinds) -> list:
    """Distinct (house, station, ISO week, kind, observation, stage, section).

    A pest infests when the row has a count > 0 or a recorded stage; a disease
    when the row exists (spec §1)."""
    parts = []
    if "pest" in kinds:
        parts.append(f"""
        SELECT DISTINCT {_WH} AS wh, {_STATION} AS station, {_WEEK} AS yw,
               'pest' AS kind, c.pest AS obs, COALESCE(c.stage, '') AS stage,
               COALESCE(c.plant_section, '') AS section
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("pest", "c.pest", params)}
          AND COALESCE({_STATION}, '') <> ''
          AND (COALESCE(c.`count`, 0) > 0 OR COALESCE(c.stage, '') <> '')
        """)
    if "disease" in kinds:
        parts.append(f"""
        SELECT DISTINCT {_WH} AS wh, {_STATION} AS station, {_WEEK} AS yw,
               'disease' AS kind, c.disease AS obs, COALESCE(c.stage, '') AS stage,
               COALESCE(c.plant_section, '') AS section
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` c ON c.parent = se.name
        WHERE {where}{obs_filter("disease", "c.disease", params)}
          AND COALESCE({_STATION}, '') <> ''
        """)
    if not parts:
        return []
    return frappe.db.sql(" UNION ALL ".join(parts), params, as_dict=True)


class StationWeeks:
    """Scouted / infested station sets per (house, ISO week) and the figures over them."""

    def __init__(self, scouted_rows, infested_rows, grid_loader=None):
        self._grid_loader = grid_loader
        self._scouted: dict = {}    # (wh, week) -> {station}
        self._in_window: dict = {}  # wh -> {week with scouting inside the window}
        self._infested: dict = {}   # (wh, week) -> {(kind, obs, stage, section): {station}}
        self._grids: dict = {}
        self._counts: dict = {}
        self._pairs: dict = {}
        self._memo: dict = {}
        for r in scouted_rows or []:
            wh = (r["wh"] or "").strip()
            station = (r["station"] or "").strip()
            week = P.yearweek_label(r["yw"])
            if not wh or not station or not week:
                continue
            self._scouted.setdefault((wh, week), set()).add(station)
            if int(r["in_win"] or 0):
                self._in_window.setdefault(wh, set()).add(week)
        for r in infested_rows or []:
            wh = (r["wh"] or "").strip()
            station = (r["station"] or "").strip()
            week = P.yearweek_label(r["yw"])
            if not wh or not station or not week:
                continue
            key = (
                r["kind"],
                (r["obs"] or "").strip(),
                (r["stage"] or "").strip(),
                (r["section"] or "").strip(),
            )
            self._infested.setdefault((wh, week), {}).setdefault(key, set()).add(station)

    @classmethod
    def load(cls, from_date, to_date, crop, scope, kinds=("pest", "disease"),
             lookback_days=PREVIOUS_LOOKBACK_DAYS, grid_loader=None):
        where, params = parent_filter_conditions(
            _shift(from_date, -lookback_days), to_date, crop, scope,
        )
        return cls(
            _fetch_scouted(where, params, from_date),
            _fetch_infested(where, params, kinds),
            grid_loader=grid_loader,
        )

    # ── structure ──────────────────────────────────────────────────────────

    def grid(self, wh: str) -> dict:
        if wh not in self._grids:
            loader = self._grid_loader or station_grid  # looked up now, so tests can patch it
            self._grids[wh] = loader(wh) or {}
        return self._grids[wh]

    def warehouses(self) -> list:
        """Houses with scouting inside the window, sorted."""
        return sorted(self._in_window)

    def window_weeks(self) -> list:
        return sorted({w for weeks in self._in_window.values() for w in weeks})

    def warehouses_in(self, week: str) -> list:
        return sorted(wh for wh, weeks in self._in_window.items() if week in weeks)

    def weeks(self, wh: str) -> list:
        return sorted(self._in_window.get(wh, ()))

    def latest_pair(self, wh: str) -> tuple:
        if wh not in self._pairs:
            all_weeks = [w for (h, w) in self._scouted if h == wh]
            self._pairs[wh] = P.latest_and_previous(self._in_window.get(wh, ()), all_weeks)
        return self._pairs[wh]

    # ── figures ────────────────────────────────────────────────────────────

    def infested_set(self, wh, week, kind, obs=ANY, stage=ANY, section=ANY) -> set:
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
            out |= stations
        return out

    def figures(self, wh, week, kind, obs=ANY, stage=ANY, section=ANY):
        key = (wh, week, kind, obs, stage, section)
        if key not in self._memo:
            scouted = self._scouted.get((wh, week))
            fig = None
            if scouted:
                grid = self.grid(wh)
                if (wh, week) not in self._counts:
                    self._counts[(wh, week)] = P.section_counts(grid, scouted)
                fig = P.figures(
                    grid, scouted,
                    self.infested_set(wh, week, kind, obs, stage, section),
                    scouted_counts=self._counts[(wh, week)],
                )
                if fig is not None:
                    fig["week"] = week
            self._memo[key] = fig
        return self._memo[key]

    def latest(self, wh, kind, obs=ANY, stage=ANY, section=ANY):
        latest, previous = self.latest_pair(wh)
        if latest is None:
            return None
        fig = self.figures(wh, latest, kind, obs, stage, section)
        if fig is None:
            return None
        prev = self.figures(wh, previous, kind, obs, stage, section) if previous else None
        return {**fig, "prev": prev["prevalence"] if prev else None}

    def previous(self, wh, kind, obs=ANY, stage=ANY, section=ANY):
        _latest, previous = self.latest_pair(wh)
        return self.figures(wh, previous, kind, obs, stage, section) if previous else None

    def combined_latest(self, kind, obs=ANY, stage=ANY, section=ANY):
        """Scope-wide figures: every house's latest week, station-weighted."""
        houses = self.warehouses()
        out = P.combine([self.latest(wh, kind, obs, stage, section) for wh in houses])
        if out is None:
            return None
        prev = P.combine([self.previous(wh, kind, obs, stage, section) for wh in houses])
        return {**out, "prev": prev["prevalence"] if prev else None}
```

- [ ] **Step 4: Run them and watch them pass.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_cache_invalidation.py`
  Expected: all `test_prevalence_*` tests pass, and `test_cache_invalidation.py` passes in full (including the existing `test_master_data_keeps_global_bump`).
  Then run DB-RUN `test_prevalence_rows`. Expected: `Ran 10 tests … OK`. `test_every_tree_of_a_block_with_tiny_rows_is_placed` runs on `AIRSTRIP BLK 11 - KL`, which has a 1-tree row.
  Then run the regression gate (DB-RUN each of `test_dashboard_aggregates_overview`, `…_pests_diseases`, `…_gh_detail`, `…_traps`, `…_fcm`). Expected: all OK, because no aggregate reads the new module yet.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_prevalence_rows.py \
        upande_scp/serverscripts/common/cache_utils.py \
        upande_scp/serverscripts/tests/prevalence_fixture.py \
        upande_scp/serverscripts/tests/test_prevalence_rows_pure.py \
        upande_scp/serverscripts/tests/test_prevalence_rows.py \
        upande_scp/serverscripts/tests/test_cache_invalidation.py
git commit -m "feat(scp): weekly scouted and infested station sets with cached station grids"
```

---

### Task 3: Overview and greenhouse detail read latest-week prevalence (+ schema `prev1`)

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py:260-264` (schema tag)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_overview.py` (imports :1-12, `_build` :48-81, `_classify_cells` :184-276, `_active_alerts_from_cells` :279-310)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` (imports :1-12, `_empty` :31-33, `_build` :36-145)
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_fixture.py` (after `ZONES_PER_GH`, :179)
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py` (`test_active_alerts_high_first`), `upande_scp/serverscripts/tests/test_dashboard_aggregates_gh_detail.py` (`test_alerts_for_high_severity`)
- Create: `upande_scp/serverscripts/tests/test_prevalence_overview.py`

**Interfaces:**
- Consumes: Task 2 `StationWeeks.load(...)`, `.latest(wh, kind, obs, stage)`. Task 1 `prevalence.public(fig)` and `PUBLIC_KEYS`. `_common.severity_for(crop, kind, obs_name, stage, pct)` (:242), unchanged and now fed the adjusted prevalence.
- Produces:
  - `_common.K_DASH_AGG_SCHEMA == "prev1"`
  - `_overview._classify_cells(obs: list, crop: str, weeks: StationWeeks) -> (gh_health, cells, total_alerts)`. Each cell is `{greenhouse, kind, obs_name, stage, zones (= infested), total (= scouted), pct (= prevalence), severity, count, date}` plus every `PUBLIC_KEYS` field.
  - overview `activeAlerts[]` gains every `PUBLIC_KEYS` field, and `zone` becomes `"<infested>/<scouted> scouted · <week>"`.
  - greenhouse detail gains `prevalence: [{kind, name, sections:[{row, col, scouted, infested, pct}], …PUBLIC_KEYS}]` for the top 3 pests and top 3 diseases. `alerts` counts High cells on latest-week prevalence.
  - fixture `STATION_GRID`, `fixture_station_grid(warehouse) -> dict`

- [ ] **Step 1: Write the failing test.** Create `upande_scp/serverscripts/tests/test_prevalence_overview.py`:

```python
"""Overview + greenhouse detail on station prevalence. DB test — direct runner."""

import unittest
from importlib import import_module
from unittest.mock import patch

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF

O = import_module("upande_scp.serverscripts.dashboard_aggregates._overview")
G = import_module("upande_scp.serverscripts.dashboard_aggregates._gh_detail")
AVOCADO_PEST = "Fruit fly (Ceratitis)"


class TestOverviewPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _cells(self, from_date, to_date, crop):
        where, params = _common.parent_filter_conditions(from_date, to_date, crop, None)
        weeks = R.StationWeeks.load(from_date, to_date, crop, None)
        return O._classify_cells(O._observation_rows(where, params), crop, weeks)[1]

    def _seed_two_weeks(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")                          # 9 of 27
        PF.seed_even_week(self.gh, PF.WEEK_11[0], crop="Rose", infested_per_section=2)   # 18 of 27

    def test_a_cell_reads_the_latest_week_with_the_previous_beside_it(self):
        self._seed_two_weeks()
        cell = next(c for c in self._cells(PF.WEEK_10[0], PF.WEEK_11[1], "Rose")
                    if c["greenhouse"] == self.gh and c["obs_name"] == "Thrips" and c["stage"] == "Adult")
        self.assertEqual((cell["prevalence"], cell["prev"], cell["pct"]), (66.7, 33.3, 66.7))
        self.assertEqual((cell["zones"], cell["total"], cell["week"]), (18, 27, "2031-W11"))
        self.assertEqual((cell["sections_scouted"], cell["margin"], cell["reliability"]), (9, 17.8, "Fair"))

    def test_alerts_carry_the_figures(self):
        self._seed_two_weeks()
        with patch.object(_common, "severity_for", return_value="high"):
            out = DA.overview(from_date=PF.WEEK_10[0], to_date=PF.WEEK_11[1], crop="Rose", force="1")
        alert = next(a for a in out["activeAlerts"] if a["greenhouse"] == self.gh and a["name"] == "Thrips")
        self.assertEqual((alert["prevalence"], alert["prev"], alert["reliability"]), (66.7, 33.3, "Fair"))
        self.assertEqual((alert["sections_scouted"], alert["sections_total"]), (9, 9))
        self.assertEqual(alert["zone"], "18/27 scouted · 2031-W11")
        self.assertEqual(out["kpis"]["highAlerts"], 1)

    def test_avocado_trees_now_make_cells(self):
        block = F.avocado_block()
        PF.seed_even_week(block, PF.WEEK_10[0], crop="Avocado", pest=AVOCADO_PEST, block=True)
        cell = next(c for c in self._cells(PF.WEEK_10[0], PF.WEEK_10[1], "Avocado") if c["greenhouse"] == block)
        self.assertEqual(cell["prevalence"], 33.3)
        self.assertEqual(cell["stations"], frappe.db.count("Orchard Tree", {"block": block}))

    def test_aggregate_keys_carry_the_prev1_schema(self):
        self.assertEqual(_common.K_DASH_AGG_SCHEMA, "prev1")
        self.assertIn(":prev1:overview:", _common._build_key("overview", {"crop": "Rose"}))


class TestGreenhouseDetailPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_the_top_observations_map_onto_the_3x3_grid(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose", disease="Powdery Mildew")
        out = DA.greenhouse_detail(greenhouse=self.gh, from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1],
                                   crop="Rose", force="1")
        thrips = next(p for p in out["prevalence"] if p["name"] == "Thrips")
        self.assertEqual(thrips["kind"], "pest")
        self.assertEqual([(s["row"], s["col"]) for s in thrips["sections"]],
                         [(r, c) for r in range(3) for c in range(3)])
        self.assertEqual([s["pct"] for s in thrips["sections"]], [33.3] * 9)
        self.assertEqual((thrips["prevalence"], thrips["sections_scouted"]), (33.3, 9))
        self.assertIn("Powdery Mildew", {p["name"] for p in out["prevalence"] if p["kind"] == "disease"})

    def test_alerts_use_the_latest_week(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        PF.seed_even_week(self.gh, PF.WEEK_11[0], crop="Rose", infested_per_section=2)
        high_at_50 = lambda crop, kind, obs, stage, pct: "high" if pct >= 50 else None  # noqa: E731
        with patch.object(G, "severity_for", side_effect=high_at_50):
            both = DA.greenhouse_detail(greenhouse=self.gh, from_date=PF.WEEK_10[0],
                                        to_date=PF.WEEK_11[1], crop="Rose", force="1")
            first = DA.greenhouse_detail(greenhouse=self.gh, from_date=PF.WEEK_10[0],
                                         to_date=PF.WEEK_10[1], crop="Rose", force="1")
        self.assertEqual(both["alerts"], 1)    # W11: 66.7%
        self.assertEqual(first["alerts"], 0)   # W10: 33.3%
```

- [ ] **Step 2: Run it and watch it fail.**
  Run: DB-RUN `test_prevalence_overview`.
  Expected failures:
  - `TypeError`/`AttributeError` in `_classify_cells`: it takes a zone-count dict, so `weeks.get` / `zones_by_gh.get(gh)` is called on a `StationWeeks`.
  - `KeyError: 'prevalence'` on the overview and detail payloads.
  - `AssertionError: 'crop2' != 'prev1'`.

- [ ] **Step 3: Implement.**

`_common.py` — replace lines 261-264:

```python
# Bumped when an aggregate's meaning changes without its filters changing, so a
# deploy never serves a payload computed under the old rules. "crop2": crop-less
# entries count under their greenhouse's crop and off-crop pests/diseases drop out.
K_DASH_AGG_SCHEMA = "crop2"
```

with:

```python
# Bumped when an aggregate's meaning changes without its filters changing, so a
# deploy never serves a payload computed under the old rules. "crop2": crop-less
# entries count under their greenhouse's crop and off-crop pests/diseases drop out.
# "prev1": percentages are station prevalence per ISO week over stations SCOUTED
# (common/prevalence.py), and payloads carry margin / sections / reliability.
K_DASH_AGG_SCHEMA = "prev1"
```

`_overview.py` — replace the import block (lines 1-12) with:

```python
"""Overview tab aggregator."""

import frappe

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    obs_filter,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
)
```

In `_build` (lines 55-61), replace:

```python
    publish_progress(job_id, 35, "loading observations")
    obs     = _observation_rows(where, params)
    zones_by_gh = scouting_metrics.get_zone_counts_by_greenhouse() or {}

    publish_progress(job_id, 85, "computing summaries")
    daily, range_totals = _daily_and_totals(obs)
    gh_health, cells, alerts_total = _classify_cells(obs, crop, zones_by_gh)
```

with:

```python
    publish_progress(job_id, 35, "loading observations")
    obs     = _observation_rows(where, params)

    publish_progress(job_id, 60, "loading scouted stations")
    weeks = _prevalence_rows.StationWeeks.load(from_date, to_date, crop, scope)

    publish_progress(job_id, 85, "computing summaries")
    daily, range_totals = _daily_and_totals(obs)
    gh_health, cells, alerts_total = _classify_cells(obs, crop, weeks)
```

Replace the whole `_classify_cells` function (lines 184-276) with:

```python
def _classify_cells(obs: list, crop: str, weeks) -> tuple:
    """Single pass over ``obs`` produces:

      * ``by_gh``        — per-greenhouse counts + scouts + alerts
      * ``cells``        — one row per (gh, kind, obs_name, stage) carrying the
                           house's station prevalence for its LATEST scouted ISO
                           week in the range, the previous scouted week beside it,
                           margin / sections / reliability (common/prevalence.py),
                           the severity classification, the latest scouting date
                           in that cell and the summed pest/trap count
      * ``total_alerts`` — Σ alerts across greenhouses

    ``weeks`` is a ``_prevalence_rows.StationWeeks`` for the same crop, scope and
    range. The denominator is stations SCOUTED that week (spec D1), never every
    zone in the house. A station is the entry's zone (rose) or tree (avocado).

    Severity uses the per-stage thresholds (with aggregate fallback) from the Crop
    Scouted doc — see ``_common.severity_for`` — fed the adjusted prevalence. Traps
    keep the legacy ``count > 10`` rule because trap thresholds aren't part of the
    Crop Scouted threshold model yet."""
    from upande_scp.serverscripts.dashboard_aggregates._common import severity_for

    by_gh: dict = {}
    scouts_by_gh: dict = {}
    # (gh, kind, obs_name, stage) → {count_sum, latest_date}
    cells: dict = {}
    total_alerts = 0

    for r in obs:
        gh = r.greenhouse or r.block or "—"
        bucket = by_gh.setdefault(gh, {
            "name": gh, "pests": 0, "diseases": 0, "traps": 0,
            "scoutCount": 0, "alerts": 0,
        })
        scouts_by_gh.setdefault(gh, set()).add(r.scouts_name or "")
        date = str(r.date_of_capture)[:10]
        if r.kind == "trap":
            bucket["traps"] += 1
            # Trap alerts stay count-based until trap thresholds get the
            # same treatment — single-row check, no zone aggregation.
            if (r.count or 0) > 10:
                bucket["alerts"] += 1
                total_alerts += 1
            continue
        if r.kind == "pest":
            bucket["pests"] += 1
        elif r.kind == "disease":
            bucket["diseases"] += 1

        station = (r.zone or r.tree or "").strip()
        if not station:
            continue
        key = (gh, r.kind, r.obs_name or "", (r.stage or "").strip())
        cell = cells.setdefault(key, {"count_sum": 0, "latest_date": ""})
        cell["count_sum"] += int(r.count or 0)
        if date > (cell["latest_date"] or ""):
            cell["latest_date"] = date

    out_cells: list = []
    for (gh, kind, obs_name, stage), cell in cells.items():
        fig = weeks.latest(gh, kind, obs_name, stage)
        if not fig or fig["prevalence"] is None:
            continue
        pct = fig["prevalence"]
        sev = severity_for(crop, kind, obs_name, stage, pct)
        if sev == "high":
            by_gh[gh]["alerts"] += 1
            total_alerts += 1
        out_cells.append({
            "greenhouse": gh,
            "kind":       kind,
            "obs_name":   obs_name,
            "stage":      stage,
            "zones":      fig["infested"],
            "total":      fig["scouted"],
            "pct":        pct,
            "severity":   sev,
            "count":      cell["count_sum"],
            "date":       cell["latest_date"],
            **P.public(fig),
        })

    for gh, bucket in by_gh.items():
        bucket["scoutCount"] = len([s for s in scouts_by_gh[gh] if s])
        a = bucket["alerts"]
        bucket["status"] = "critical" if a > 2 else "warning" if a > 0 else "good"

    # Total order: total observations desc, then greenhouse name — by_gh is
    # keyed by greenhouse so the name makes ties total. Without it, two
    # greenhouses with equal counts swap places depending on scan order.
    gh_out = sorted(
        by_gh.values(),
        key=lambda x: (-(x["pests"] + x["diseases"] + x["traps"]), x["name"]),
    )
    return gh_out, out_cells, total_alerts
```

In `_active_alerts_from_cells`, replace the `out = [...]` comprehension (lines 284-296) with:

```python
    out = [
        {
            "name":       c["obs_name"],
            "kind":       c["kind"],
            "severity":   c["severity"],
            "count":      c["count"],
            "greenhouse": c["greenhouse"],
            "zone":       f"{c['zones']}/{c['total']} scouted · {c['week']}",
            "date":       c["date"],
            "stage":      c["stage"],
            **{k: c.get(k) for k in P.PUBLIC_KEYS},
        }
        for c in flagged
    ]
```

`_gh_detail.py` — replace the import block (lines 1-12) with:

```python
"""Greenhouse drill-down used by GreenhouseModal."""

import frappe

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    obs_filter,
    parent_filter_conditions,
    publish_progress,
    severity_for,
)

#: How many of the top pests and of the top diseases get a 3 × 3 grid.
_GRID_TOP_N = 3
```

Replace `_empty` (lines 31-33) with:

```python
def _empty() -> dict:
    return {"topPests": [], "topDiseases": [], "traps": [], "daily": [],
            "scouts": 0, "alerts": 0, "prevalence": []}
```

Replace the whole `_build` function (lines 36-145) with:

```python
def _build(filters: dict, job_id: str = "") -> dict:
    publish_progress(job_id, 10, "resolving filters")
    gh = filters["greenhouse"]
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], [gh],
    )

    pest_obs = obs_filter("pest", "p.pest", params)
    disease_obs = obs_filter("disease", "d.disease", params)

    publish_progress(job_id, 25, "loading pest rows")
    pests = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, se.zone, se.tree, p.pest, p.stage, p.count
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}{pest_obs}
    """, params, as_dict=True)

    publish_progress(job_id, 45, "loading disease rows")
    diseases = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, se.zone, se.tree, d.disease, d.stage
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}{disease_obs}
    """, params, as_dict=True)

    publish_progress(job_id, 60, "loading trap rows")
    traps = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, t.pest, t.count
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
    """, params, as_dict=True)

    publish_progress(job_id, 70, "counting scouts")
    scout_rows = frappe.db.sql(f"""
        SELECT DISTINCT scouts_name FROM `tabScouting Entry` se WHERE {where}
    """, params, as_dict=True)

    publish_progress(job_id, 80, "loading scouted stations")
    weeks = _prevalence_rows.StationWeeks.load(
        filters["from_date"], filters["to_date"], filters["crop"], [gh],
    )

    pest_map = {}
    disease_map = {}
    trap_map = {}
    daily = {}
    alerts = 0
    # (kind, obs_name, stage) cells seen on a station (zone or tree) of this house.
    cells: set = set()

    for r in pests:
        n = int(r.count or 0)
        pest_map[r.pest] = pest_map.get(r.pest, 0) + (n if n else 1)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["pests"] += 1
        if (r.zone or r.tree or "").strip():
            cells.add(("pest", r.pest or "", (r.stage or "").strip()))

    for r in diseases:
        disease_map[r.disease] = disease_map.get(r.disease, 0) + 1
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["diseases"] += 1
        if (r.zone or r.tree or "").strip():
            cells.add(("disease", r.disease or "", (r.stage or "").strip()))

    for r in traps:
        pname = r.pest or "Unknown"
        trap_map[pname] = trap_map.get(pname, 0) + int(r.count or 0)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["traps"] += 1
        if (int(r.count or 0)) > 10:
            alerts += 1

    # Pest + disease alerts come from this house's station prevalence in its
    # latest scouted ISO week (common/prevalence.py) against the per-stage
    # thresholds (with aggregate fallback) on Crop Scouted. Traps stay
    # count-based until trap thresholds get the same treatment.
    for kind, obs_name, stage in sorted(cells):
        fig = weeks.latest(gh, kind, obs_name, stage)
        if not fig or fig["prevalence"] is None:
            continue
        if severity_for(filters["crop"], kind, obs_name, stage, fig["prevalence"]) == "high":
            alerts += 1

    def _top(d, n=6):
        # d is keyed by name, so it's a total-order tie-break.
        return sorted(
            [{"name": k, "count": v} for k, v in d.items()],
            key=lambda x: (-x["count"], x["name"]),
        )[:n]

    top_pests = _top(pest_map)
    top_diseases = _top(disease_map)

    # The 3 × 3 picture (spec §3) for the top observations, latest scouted week.
    prevalence_rows = []
    for kind, top in (("pest", top_pests), ("disease", top_diseases)):
        for t in top[:_GRID_TOP_N]:
            fig = weeks.latest(gh, kind, t["name"])
            if not fig:
                continue
            prevalence_rows.append({
                "kind": kind,
                "name": t["name"],
                **P.public(fig),
                "sections": fig.get("sections") or [],
            })

    payload = {
        "topPests":    top_pests,
        "topDiseases": top_diseases,
        "traps":       sorted(
            [{"pest": k, "total": v} for k, v in trap_map.items()],
            key=lambda x: (-x["total"], x["pest"]),
        )[:6],
        "daily": sorted(daily.values(), key=lambda x: x["date"]),
        "scouts": len({(r.scouts_name or "").strip() for r in scout_rows
                       if (r.scouts_name or "").strip()}),
        "alerts": alerts,
        "prevalence": prevalence_rows,
    }
    publish_progress(job_id, 100, "")
    return payload
```

`test_dashboard_aggregates_fixture.py` — directly after `ZONES_PER_GH = {_TEST_GH_1: 2, _TEST_GH_2: 2, _TEST_GH_3: 2}` (:179), add:

```python


# --- Station prevalence (common/prevalence.py) ------------------------------
# Severity is now fed each greenhouse's station prevalence in its LATEST scouted
# ISO week, over stations SCOUTED (spec D1/D4). The fixture greenhouses have no
# Zone rows, so tests patch _prevalence_rows.station_grid with this grid. Every
# fixture entry sits on _TEST_ZONE, so a greenhouse-week has one scouted station:
# no section reaches 3, the adjusted prevalence falls back to raw, and a cell
# reads 100% when its observation was recorded that week and 0% when it was not.
STATION_GRID = {_TEST_ZONE: (0, 0), "_TEST Zone 2": (2, 2)}


def fixture_station_grid(warehouse: str) -> dict:
    """Stand-in for _prevalence_rows.station_grid on the fixture greenhouses."""
    return dict(STATION_GRID) if warehouse in (_TEST_GH_1, _TEST_GH_2, _TEST_GH_3) else {}
```

`test_dashboard_aggregates_overview.py` — replace the whole `test_active_alerts_high_first` method with:

```python
    def test_active_alerts_high_first(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            configure_rose_thresholds, fixture_station_grid,
        )
        configure_rose_thresholds()
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            payload = self._call(crop="Rose")
        sevs = [a["severity"] for a in payload["activeAlerts"]]
        # Was 5 High under the all-zones denominator (every cell 1 of 2 zones = 50%).
        # Prevalence is now per greenhouse's latest scouted ISO week over stations
        # SCOUTED (spec D1/D4): both houses' latest week is 2026-W20, where the one
        # scouted station reads 100% for what it carried that week and 0% otherwise.
        # High: GH 1 Thrips Adult (stage band 50), Thrips Larvae (aggregate band 90),
        # Powdery Mildew Severe (40); GH 2 Powdery Mildew Low. GH 2's Active and
        # Moderate cells were W19-only → 0% → unclassified.
        self.assertEqual(sevs.count("high"), 4)
        self.assertEqual(sevs, sorted(sevs, key=lambda s: s != "high"))
        high_kinds = {a["kind"] for a in payload["activeAlerts"] if a["severity"] == "high"}
        self.assertEqual(high_kinds, {"pest", "disease"})
```

`test_dashboard_aggregates_gh_detail.py` — replace the whole `test_alerts_for_high_severity` method with:

```python
    def test_alerts_for_high_severity(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.dashboard_aggregates._gh_detail import greenhouse_detail
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            configure_rose_thresholds, fixture_station_grid,
        )
        configure_rose_thresholds()
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            p = greenhouse_detail({"greenhouse": "_TEST GH 1", "from_date": "2026-05-04",
                                   "to_date": "2026-05-15", "crop": "Rose"}, force=True)
        # Was 2 under the all-zones denominator (50% of zones: Larvae only Low).
        # Station prevalence reads GH 1's latest scouted week, 2026-W20, where its one
        # scouted station carried Thrips Adult, Thrips Larvae and Powdery Mildew
        # Severe → 100% each → High on every band (Adult 50, Larvae aggregate 90,
        # Powdery Mildew 40). Three alerts.
        self.assertEqual(p["alerts"], 3)
```

- [ ] **Step 4: Run it and watch it pass.**
  Run: DB-RUN `test_prevalence_overview`. Expected: `Ran 6 tests … OK`.
  Run the regression gate: DB-RUN `test_dashboard_aggregates_overview`, `test_dashboard_aggregates_pests_diseases`, `test_dashboard_aggregates_gh_detail`, `test_dashboard_aggregates_traps`, `test_dashboard_aggregates_fcm`. Expected: all OK. Pests is still on the old code and still imports `ZONES_PER_GH`, which stays in place until Task 4.
  Run piece-1 regression: DB-RUN `test_crop_scoped_aggregates` and DB-RUN `test_crop_scoped_aggregate_detail`. Expected: both OK.
  Run DB-RUN `test_prevalence_rows`. Expected: OK.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_common.py \
        upande_scp/serverscripts/dashboard_aggregates/_overview.py \
        upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_fixture.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_gh_detail.py \
        upande_scp/serverscripts/tests/test_prevalence_overview.py
git commit -m "feat(scp): overview and greenhouse detail read latest-week station prevalence"
```

---

### Task 4: Pests / Diseases on adjusted prevalence

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py` (imports :1-14, `_build` :58-99, `_ranking` :102-146, `_distribution` :206-224, `_gh_pressure` :248-265, `_daily_percent` :268-287)
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_pests_diseases.py` (`test_severity_buckets`, `test_daily_percent_one_row_per_date_with_match`)
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_fixture.py` (retire `ZONES_PER_GH`)
- Create: `upande_scp/serverscripts/tests/test_prevalence_pests.py`

**Interfaces:**
- Consumes: Task 2 `StationWeeks.load(..., kinds=(kind,))`, `.latest`, `.figures`, `.combined_latest`, `.warehouses()`, `.window_weeks()`, `.warehouses_in(week)`, `ANY`. Task 1 `prevalence.public`, `combine`, `week_monday`. `_common.severity_for`.
- Produces (pests and diseases payloads):
  - `ranking[]`: `{name, total, high, moderate, low}` plus every `PUBLIC_KEYS` field. This is the scope-wide combined latest-week figure for that observation, all stages.
  - `distribution[]`: `{name, zones, pct}` plus `PUBLIC_KEYS`. `pct` is the scope-wide latest-week adjusted prevalence (`None` when no house has stations), honouring section/stage filters. Sorted by pct desc (None last), then name.
  - `greenhousePressure[]`: `{name, zones, pct}` plus `PUBLIC_KEYS`, one per house scouted in the range, honouring observation/section/stage filters. Sorted by pct desc, then name.
  - `dailyPercent[]`: `{date (ISO Monday), week, value, margin, reliability}`, one per ISO week in the range with scouting.
  - `sectionSplit`, `filterOptions`, `trendSeries` are unchanged.
  - `_ranking(kind, rows, crop, weeks)`, `_distribution(kind, rows, filters, weeks)`, `_gh_pressure(kind, filters, weeks)`, `_daily_percent(kind, filters, weeks)`, `_select(filters) -> (obs, stage, section)`

- [ ] **Step 1: Write the failing test.** Create `upande_scp/serverscripts/tests/test_prevalence_pests.py`:

```python
"""Pests / Diseases tabs on station prevalence. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.tests import prevalence_fixture as PF


class TestPestsPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh, self.other = PF.rose_greenhouses(2)

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _pests(self, **kw):
        return DA.pests(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Rose", force="1", **kw)

    def test_ranking_carries_the_scope_wide_figure(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        row = next(r for r in self._pests()["ranking"] if r["name"] == "Thrips")
        self.assertEqual((row["prevalence"], row["sections_scouted"], row["reliability"]), (33.3, 9, "Fair"))
        self.assertEqual(row["margin"], 17.8)
        self.assertIsNone(row["prev"])

    def test_pressure_and_distribution_read_the_latest_week(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        out = self._pests()
        gh_row = next(r for r in out["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual((gh_row["pct"], gh_row["zones"], gh_row["margin"]), (33.3, 9, 17.8))
        dist = next(r for r in out["distribution"] if r["name"] == "Thrips")
        self.assertEqual((dist["pct"], dist["zones"]), (33.3, 9))

    def test_the_trend_is_a_weekly_series(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        out = self._pests(observation="Thrips")
        self.assertEqual(out["dailyPercent"], [
            {"date": "2031-03-03", "week": "2031-W10", "value": 33.3, "margin": 17.8, "reliability": "Fair"},
        ])

    def test_the_stage_filter_narrows_the_infested_stations(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")       # every hit is stage Adult
        out = self._pests(observation="Thrips", stage="Larvae")
        gh_row = next(r for r in out["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual(gh_row["pct"], 0.0)

    def test_a_house_scouted_clean_counts_in_the_scope_wide_figure(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")
        PF.seed_even_week(self.other, PF.WEEK_10[0], crop="Rose", infested_per_section=0)
        a = frappe.db.count("Zone", {"greenhouse": self.gh})
        b = frappe.db.count("Zone", {"greenhouse": self.other})
        dist = next(r for r in self._pests()["distribution"] if r["name"] == "Thrips")
        self.assertEqual(dist["pct"], round((a * 33.3 + b * 0.0) / (a + b), 1))
        pressure = {r["name"]: r["pct"] for r in self._pests()["greenhousePressure"]}
        self.assertEqual(pressure[self.other], 0.0)

    def test_diseases_read_the_same_measure(self):
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose", pest=None, disease="Powdery Mildew")
        out = DA.diseases(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Rose", force="1")
        row = next(r for r in out["ranking"] if r["name"] == "Powdery Mildew")
        self.assertEqual((row["prevalence"], row["reliability"]), (33.3, "Fair"))
        gh_row = next(r for r in out["greenhousePressure"] if r["name"] == self.gh)
        self.assertEqual(gh_row["pct"], 33.3)
```

- [ ] **Step 2: Run it and watch it fail.**
  Run: DB-RUN `test_prevalence_pests`.
  Expected: `KeyError: 'prevalence'` on the ranking rows; `AssertionError` on the pressure pct (old all-zones value, e.g. `1.4 != 33.3`); the `dailyPercent` dict mismatch.

- [ ] **Step 3: Implement.**

Replace the import block (lines 1-14) with:

```python
"""Pests and Diseases tabs aggregator (shared).

Percentages are station prevalence (common/prevalence.py): per greenhouse/block
and ISO week over stations SCOUTED, sections averaged, with a margin. Scope-wide
figures weight each house by its station count (``prevalence.combine``).
"""

import frappe

from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows
from upande_scp.serverscripts.dashboard_aggregates._prevalence_rows import ANY
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    obs_filter,
    parent_filter_conditions,
    publish_progress,
    resolve_greenhouse_scope,
    severity_for,
)
```

In `_build`, replace lines 82-96:

```python
    publish_progress(job_id, 75, "computing zone metrics")
    zones_by_gh = get_zone_counts_by_greenhouse() or {}

    ranking = _ranking(kind, rows, filters["crop"], zones_by_gh)
    fo = _filter_options(rows)
    fo[kind + "s"] = fo.pop("items")

    payload = {
        "filterOptions":      fo,
        "ranking":             ranking,
        "distribution":       _distribution(rows, filters, zones_by_gh),
        "sectionSplit":       _section_split(rows, filters),
        "greenhousePressure": _gh_pressure(rows, filters, zones_by_gh),
        "dailyPercent":       _daily_percent(rows, filters, zones_by_gh),
        "trendSeries":        _trend_series(rows, kind),
    }
```

with:

```python
    publish_progress(job_id, 55, "loading scouted stations")
    weeks = _prevalence_rows.StationWeeks.load(
        filters["from_date"], filters["to_date"], filters["crop"], scope, kinds=(kind,),
    )

    publish_progress(job_id, 75, "computing prevalence")
    ranking = _ranking(kind, rows, filters["crop"], weeks)
    fo = _filter_options(rows)
    fo[kind + "s"] = fo.pop("items")

    payload = {
        "filterOptions":      fo,
        "ranking":             ranking,
        "distribution":       _distribution(kind, rows, filters, weeks),
        "sectionSplit":       _section_split(rows, filters),
        "greenhousePressure": _gh_pressure(kind, filters, weeks),
        "dailyPercent":       _daily_percent(kind, filters, weeks),
        "trendSeries":        _trend_series(rows, kind),
    }
```

Replace the whole `_ranking` function (lines 102-146) with:

```python
def _ranking(kind: str, rows: list, crop: str, weeks) -> list:
    """Per-observation ranking.

    ``high / moderate / low`` count the (greenhouse, stage) cells of the
    observation whose LATEST-week station prevalence classifies into each band
    against the per-stage thresholds (with aggregate fallback) on ``Crop
    Scouted``. ``total`` sums the observation counts (pest count for pests, row
    count for diseases) as before. Each row also carries the scope-wide adjusted
    prevalence of the observation (all stages, every scouted house, latest week)
    with its margin / sections / reliability."""
    by_name: dict = {}
    cells: set = set()
    for r in rows:
        bucket = by_name.setdefault(
            r.obs_name,
            {"name": r.obs_name, "total": 0, "high": 0, "moderate": 0, "low": 0},
        )
        if kind == "pest":
            bucket["total"] += int(r.count or 0)
        else:
            bucket["total"] += 1
        gh = r.greenhouse or r.block or ""
        if gh:
            cells.add((gh, r.obs_name or "", (r.stage or "").strip()))

    for gh, obs_name, stage in sorted(cells):
        fig = weeks.latest(gh, kind, obs_name, stage)
        if not fig or fig["prevalence"] is None:
            continue
        sev = severity_for(crop, kind, obs_name, stage, fig["prevalence"])
        if not sev:
            continue
        bucket = by_name.setdefault(
            obs_name,
            {"name": obs_name, "total": 0, "high": 0, "moderate": 0, "low": 0},
        )
        bucket[sev] += 1

    for name, bucket in by_name.items():
        bucket.update(P.public(weeks.combined_latest(kind, name or "")))

    # by_name is keyed by obs_name, so it's a total-order tie-break.
    return sorted(by_name.values(), key=lambda x: (-x["total"], x["name"]))
```

Directly below `_filter_row` (after line 203), add:

```python
def _select(filters: dict) -> tuple:
    """(observation, stage, section) for StationWeeks — an empty filter is ANY."""
    return (
        filters["observation"] or ANY,
        filters["stage"] or ANY,
        filters["section"] or ANY,
    )
```

Replace the whole `_distribution` function (lines 206-224) with:

```python
def _distribution(kind: str, rows, filters, weeks) -> list:
    """Per observation: the scope-wide adjusted prevalence in each house's latest
    scouted week (every scouted house counts, clean ones included), honouring the
    section and stage filters. ``pct`` is ``None`` when no house in scope has
    stations set up."""
    _obs, stage, section = _select(filters)
    names = sorted({
        r.obs_name for r in rows
        if r.obs_name and _filter_row(r, {**filters, "observation": ""})
    })
    out = []
    for name in names:
        fig = weeks.combined_latest(kind, name, stage, section)
        out.append({
            "name": name,
            "zones": (fig or {}).get("infested") or 0,
            "pct": (fig or {}).get("prevalence"),
            **P.public(fig),
        })
    out.sort(key=lambda x: (x["pct"] is None, -(x["pct"] or 0), x["name"]))
    return out
```

Replace the whole `_gh_pressure` function (lines 248-265) with:

```python
def _gh_pressure(kind: str, filters, weeks) -> list:
    """One row per house scouted in the range: its latest-week adjusted prevalence
    for the filtered observation / stage / section (any observation when none is
    picked). Houses without stations set up are left out."""
    obs, stage, section = _select(filters)
    out = []
    for wh in weeks.warehouses():
        fig = weeks.latest(wh, kind, obs, stage, section)
        if not fig or fig["prevalence"] is None:
            continue
        out.append({"name": wh, "zones": fig["infested"], "pct": fig["prevalence"], **P.public(fig)})
    # One row per house, so name is a total-order tie-break.
    out.sort(key=lambda x: (-x["pct"], x["name"]))
    return out
```

Replace the whole `_daily_percent` function (lines 268-287) with:

```python
def _daily_percent(kind: str, filters, weeks) -> list:
    """The trend line: one point per ISO week with scouting in the range, the
    scope-wide adjusted prevalence of the filtered observation that week, dated
    on the week's Monday so the dashboard's week ticks land on it."""
    obs, stage, section = _select(filters)
    out = []
    for week in weeks.window_weeks():
        fig = P.combine([
            weeks.figures(wh, week, kind, obs, stage, section)
            for wh in weeks.warehouses_in(week)
        ])
        if fig is None:
            continue
        out.append({
            "date": P.week_monday(week),
            "week": week,
            "value": fig["prevalence"],
            "margin": fig["margin"],
            "reliability": fig["reliability"],
        })
    return out
```

Then delete `_zone_key` (lines 184-192) **only if** `_section_split` no longer uses it. It does still use it, so keep `_zone_key`. Also delete the now-unused import line `from upande_scp.serverscripts.scouting.scouting_metrics import get_zone_counts_by_greenhouse`. It was in the old import block, which the new block above no longer contains.

`test_dashboard_aggregates_pests_diseases.py` — replace the whole `test_severity_buckets` method with:

```python
    def test_severity_buckets(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            configure_rose_thresholds, fixture_station_grid,
        )
        configure_rose_thresholds()
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            payload = self._call(crop="Rose")
        thrips = next(r for r in payload["ranking"] if r["name"] == "_TEST Thrips")
        # Was High 1 / Low 1 under the all-zones denominator (each cell 1 of 2 zones = 50%).
        # Station prevalence reads GH 1's latest scouted week, 2026-W20, where its one
        # scouted station carried Thrips Adult and Larvae → 100% each: Adult on its
        # stage band (High at 50), Larvae on the aggregate band (High at 90).
        self.assertEqual(thrips["high"], 2)
        self.assertEqual(thrips["moderate"], 0)
        self.assertEqual(thrips["low"], 0)
```

…and replace the whole `test_daily_percent_one_row_per_date_with_match` method with:

```python
    def test_daily_percent_one_row_per_date_with_match(self):
        from unittest.mock import patch
        from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
            fixture_station_grid,
        )
        with patch("upande_scp.serverscripts.dashboard_aggregates._prevalence_rows.station_grid",
                   side_effect=fixture_station_grid):
            payload = self._call(observation="_TEST Thrips")
        dates = [r["date"] for r in payload["dailyPercent"]]
        # Was one row per scouting DATE with Thrips (all-zones denominator). The trend
        # is now weekly adjusted prevalence (spec §2), one point per ISO week with
        # scouting, dated on its Monday: 2026-W19 and 2026-W20.
        self.assertEqual(dates, ["2026-05-04", "2026-05-11"])
```

`test_dashboard_aggregates_fixture.py` — `ZONES_PER_GH` has no readers now. Delete these lines (:174-179):

```python
# --- Severity under the current model ---------------------------------------
# Severity is "% of a greenhouse's zones carrying the observation" classified
# against the crop's Pest/Disease Filter bands (stage band first, then the
# observation's aggregate band). The fixture puts every entry in one zone, so
# with ZONES_PER_GH zones each (gh, observation, stage) cell is 50%.
ZONES_PER_GH = {_TEST_GH_1: 2, _TEST_GH_2: 2, _TEST_GH_3: 2}
```

Then confirm: `grep -rn ZONES_PER_GH upande_scp/` prints nothing.

- [ ] **Step 4: Run it and watch it pass.**
  Run: DB-RUN `test_prevalence_pests`. Expected: `Ran 6 tests … OK`.
  Run the regression gate: DB-RUN each of the five `test_dashboard_aggregates_*` modules. Expected: all OK.
  Run DB-RUN `test_crop_scoped_aggregate_detail` and DB-RUN `test_crop_scoped_aggregates`. Expected: OK.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_pests_diseases.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_fixture.py \
        upande_scp/serverscripts/tests/test_prevalence_pests.py
git commit -m "feat(scp): pests and diseases tabs read adjusted station prevalence"
```

---

### Task 5: Trends carries per-station and per-farm prevalence

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_trends.py` (imports :47-57, `_build` :80-126, new `_prevalence_tables` after `_aggregate`)
- Create: `upande_scp/serverscripts/tests/test_trends_prevalence_pure.py`, `upande_scp/serverscripts/tests/test_prevalence_trends.py`

**Interfaces:**
- Consumes: Task 2 `StationWeeks.load(from_date, to_date, crop, None, lookback_days=0)`, `.figures(wh, week, kind, obs)` and `.warehouses_in(week)`. Task 1 `prevalence.combine` and `RELIABILITY`. `scouting_metrics.get_farms_and_warehouses()`.
- Produces (Trends payload additions; every existing key is unchanged, including `scoutedByStation` and its incidence semantics):
  - `prevalenceByStation: [[weekIdx, stationIdx, obsIdx, prevalence, margin | None, reliabilityIdx]]`, one row per `byKindName` row whose house has figures
  - `prevalenceByFarm: [[weekIdx, farmIdx, obsIdx, prevalence, margin | None, reliabilityIdx]]`, combined over every house of the farm scouted that week, clean houses included
  - `vocab.farms: list[str]` (sorted), `vocab.reliability: ["Good", "Fair", "Low"]`
  - `_trends._prevalence_tables(payload: dict, weeks) -> dict` (keys `prevalenceByStation`, `prevalenceByFarm`, `vocab`)

- [ ] **Step 1: Write the failing tests.**

Create `upande_scp/serverscripts/tests/test_trends_prevalence_pure.py`:

```python
"""Trends prevalence tables — pure; the farms map and the week sets are faked."""

import unittest
from importlib import import_module
from unittest.mock import patch

_trends = import_module("upande_scp.serverscripts.dashboard_aggregates._trends")

FARMS = {"Karen Farm": ["GH 12", "GH 13"]}
PAYLOAD = {
    "vocab": {"weeks": ["2031-W10"], "stations": ["GH 12", "GH 13"],
              "obs": ["pest:Thrips"], "stages": [""]},
    "byKindName": [[0, 0, 0, 3]],
}


def fig(stations, prevalence, margin, reliability, infested=1):
    return {"stations": stations, "scouted": 10, "infested": infested, "coverage": 10.0,
            "raw": 10.0, "prevalence": prevalence, "margin": margin, "sections_scouted": 9,
            "sections_total": 9, "reliability": reliability, "reason": None, "sections": []}


class FakeWeeks:
    def __init__(self, figs):
        self.figs = figs  # (station, week, kind, obs) -> figures

    def figures(self, wh, week, kind, obs=None, stage=None, section=None):
        return self.figs.get((wh, week, kind, obs))

    def warehouses_in(self, week):
        return sorted({k[0] for k in self.figs if k[1] == week})


def tables(figs):
    with patch.object(_trends.scouting_metrics, "get_farms_and_warehouses", return_value=FARMS):
        return _trends._prevalence_tables(PAYLOAD, FakeWeeks(figs))


FIGS = {
    ("GH 12", "2031-W10", "pest", "Thrips"): fig(100, 30.0, 5.0, "Fair"),
    ("GH 13", "2031-W10", "pest", "Thrips"): fig(300, 0.0, 2.0, "Good", infested=0),
}


class TestPrevalenceTables(unittest.TestCase):
    def test_station_rows_follow_the_observation_table(self):
        self.assertEqual(tables(FIGS)["prevalenceByStation"], [[0, 0, 0, 30.0, 5.0, 1]])

    def test_farm_rows_weight_every_scouted_house_clean_ones_included(self):
        out = tables(FIGS)
        self.assertEqual(out["vocab"]["farms"], ["Karen Farm"])
        # (100·30 + 300·0) / 400 = 7.5; sqrt((100·5)² + (300·2)²) / 400 = 1.95 → 2.0; worst = Fair
        self.assertEqual(out["prevalenceByFarm"], [[0, 0, 0, 7.5, 2.0, 1]])

    def test_reliability_vocab_is_published_and_the_rest_kept(self):
        out = tables(FIGS)
        self.assertEqual(out["vocab"]["reliability"], ["Good", "Fair", "Low"])
        self.assertEqual(out["vocab"]["stations"], ["GH 12", "GH 13"])

    def test_a_too_clustered_house_leaves_the_margin_unknown(self):
        figs = dict(FIGS)
        figs[("GH 12", "2031-W10", "pest", "Thrips")] = fig(100, 30.0, None, "Low")
        out = tables(figs)
        self.assertEqual(out["prevalenceByStation"], [[0, 0, 0, 30.0, None, 2]])
        self.assertIsNone(out["prevalenceByFarm"][0][4])

    def test_a_house_without_stations_writes_no_row(self):
        figs = {("GH 12", "2031-W10", "pest", "Thrips"): dict(fig(0, None, None, "Low"), stations=0)}
        out = tables(figs)
        self.assertEqual((out["prevalenceByStation"], out["prevalenceByFarm"]), ([], []))
```

Create `upande_scp/serverscripts/tests/test_prevalence_trends.py`:

```python
"""Trends prevalence tables on kaitet.local. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.tests import crop_scoping_fixture as F
from upande_scp.serverscripts.tests import prevalence_fixture as PF


class TestTrendsPrevalence(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        PF.seed_even_week(self.gh, PF.WEEK_10[0], crop="Rose")

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _trends(self):
        return DA.trends(from_date=PF.WEEK_10[0], to_date=PF.WEEK_10[1], crop="Rose", force="1")

    def test_station_and_farm_rows_carry_the_house_figures(self):
        out = self._trends()
        v = out["vocab"]
        w, s, o = v["weeks"].index("2031-W10"), v["stations"].index(self.gh), v["obs"].index("pest:Thrips")
        self.assertEqual(v["reliability"], ["Good", "Fair", "Low"])
        self.assertIn([w, s, o, 33.3, 17.8, 1], out["prevalenceByStation"])
        farm = next(f for f, ss in out["stationsByFarm"].items() if self.gh in ss)
        self.assertIn([w, v["farms"].index(farm), o, 33.3, 17.8, 1], out["prevalenceByFarm"])

    def test_the_incidence_tables_are_unchanged(self):
        out = self._trends()
        v = out["vocab"]
        w, s, o = v["weeks"].index("2031-W10"), v["stations"].index(self.gh), v["obs"].index("pest:Thrips")
        self.assertIn([w, s, 27], out["scoutedByStation"])
        self.assertIn([w, s, o, 9], out["byKindName"])
```

- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_trends_prevalence_pure.py`
  Expected: `AttributeError: module '…_trends' has no attribute '_prevalence_tables'`.
  Run: DB-RUN `test_prevalence_trends`. Expected: `KeyError: 'reliability'` in `test_station_and_farm_rows…`. `test_the_incidence_tables_are_unchanged` passes already.

- [ ] **Step 3: Implement.**

In `_trends.py`, replace the import block (lines 47-57):

```python
from datetime import date, datetime

import frappe

from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    obs_filter,
    parent_filter_conditions,
    publish_progress,
)
```

with:

```python
from datetime import date, datetime

import frappe

from upande_scp.serverscripts.common import prevalence
from upande_scp.serverscripts.scouting import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    obs_filter,
    parent_filter_conditions,
    publish_progress,
)
```

In `_build`, replace:

```python
    publish_progress(job_id, 70, "aggregating")
    payload = _aggregate(rows, scouted_rows)
```

with:

```python
    publish_progress(job_id, 70, "aggregating")
    payload = _aggregate(rows, scouted_rows)

    # Adjusted station prevalence + margin beside the incidence above (spec §2):
    # every week is plotted, so no previous-week lookback.
    publish_progress(job_id, 85, "computing prevalence")
    weeks = _prevalence_rows.StationWeeks.load(from_date, to_date, crop, None, lookback_days=0)
    payload.update(_prevalence_tables(payload, weeks))
```

Append to the end of `_trends.py`:

```python


def _prevalence_tables(payload: dict, weeks) -> dict:
    """Adjusted station prevalence beside the incidence tables.

    * ``prevalenceByStation`` rows ``[week, station, obs, prevalence, margin, rel]``
      — one per ``byKindName`` row (the observation was seen there that week)
      whose house has stations set up. Prevalence is over all stages.
    * ``prevalenceByFarm`` rows ``[week, farm, obs, prevalence, margin, rel]`` —
      ``prevalence.combine`` over EVERY house of the farm scouted that week,
      clean ones included (they are part of the farm's sample).

    ``margin`` is ``None`` when too clustered to judge; ``rel`` indexes
    ``vocab.reliability``; ``farm`` indexes ``vocab.farms``.
    """
    vocab = payload["vocab"]
    rel = {r: i for i, r in enumerate(prevalence.RELIABILITY)}
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    station_to_farm = {s: f for f, stations in farms_map.items() for s in (stations or [])}

    def _row(a, b, o, fig):
        return [a, b, o, fig["prevalence"], fig["margin"], rel[fig["reliability"]]]

    by_station = []
    observed = set()
    for w_i, s_i, o_i, _n in payload.get("byKindName", []):
        week, station, obs_key = vocab["weeks"][w_i], vocab["stations"][s_i], vocab["obs"][o_i]
        kind, _sep, name = obs_key.partition(":")
        observed.add((w_i, station_to_farm.get(station, "Unknown"), o_i))
        fig = weeks.figures(station, week, kind, name)
        if fig and fig.get("prevalence") is not None:
            by_station.append(_row(w_i, s_i, o_i, fig))

    farms = sorted({station_to_farm.get(s, "Unknown") for s in vocab["stations"]})
    idx_farm = {f: i for i, f in enumerate(farms)}
    by_farm = []
    for w_i, farm, o_i in sorted(observed):
        week = vocab["weeks"][w_i]
        kind, _sep, name = vocab["obs"][o_i].partition(":")
        fig = prevalence.combine([
            weeks.figures(s, week, kind, name)
            for s in weeks.warehouses_in(week)
            if station_to_farm.get(s, "Unknown") == farm
        ])
        if fig and fig.get("prevalence") is not None:
            by_farm.append(_row(w_i, idx_farm[farm], o_i, fig))

    return {
        "prevalenceByStation": sorted(by_station, key=lambda r: (r[0], r[1], r[2])),
        "prevalenceByFarm": sorted(by_farm, key=lambda r: (r[0], r[1], r[2])),
        "vocab": {**vocab, "farms": farms, "reliability": list(prevalence.RELIABILITY)},
    }
```

- [ ] **Step 4: Run them and watch them pass.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_trends_prevalence_pure.py`. Expected: `5 passed`.
  Run: DB-RUN `test_prevalence_trends`. Expected: `Ran 2 tests … OK`.
  Run DB-RUN `test_dashboard_aggregates_trends`. Its `TestSprayEventFold` needs a site, so it must run this way. Expected: OK.
  Run DB-RUN `test_crop_scoped_aggregates` (Trends crop options and the clean-entry denominator). Expected: OK.
  Run the regression gate (the five suites). Expected: all OK.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add upande_scp/serverscripts/dashboard_aggregates/_trends.py \
        upande_scp/serverscripts/tests/test_trends_prevalence_pure.py \
        upande_scp/serverscripts/tests/test_prevalence_trends.py
git commit -m "feat(scp): trends carries per-station and per-farm prevalence with margins"
```

---

### Task 6: Figure line, reliability pill and the greenhouse 3 × 3 grid

**Files:**
- Create: `frontend/src/lib/prevalence.ts`, `frontend/src/lib/prevalence.test.ts`
- Create: `frontend/src/pages/dashboard/PrevalenceFigure.tsx`, `frontend/src/pages/dashboard/SectionGrid.tsx`
- Create: `frontend/src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx`, `frontend/src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx`
- Modify: `frontend/src/pages/dashboard/overview-types.ts` (`ActiveAlert`, :34-38), `frontend/src/pages/dashboard/pests-diseases-types.ts` (:1-31)
- Modify: `frontend/src/pages/dashboard/OverviewTab.tsx` (imports :32-37; alert row :297-300)
- Modify: `frontend/src/pages/dashboard/PestsTab.tsx` (imports :26-31; copy :68, :110, :172, :313; severity row :280-294)
- Modify: `frontend/src/pages/dashboard/DiseasesTab.tsx` (same places: imports :26-31; copy :107, :168, :309; severity row)
- Modify: `frontend/src/pages/dashboard/GreenhouseModal.tsx` (imports :1-19; `GhDetailPayload` :27-34; body)

**Interfaces:**
- Consumes: the payloads from Tasks 3–4 (`activeAlerts[]`, `ranking[]`, `distribution[]`, `greenhousePressure[]`, `dailyPercent[]`, detail `prevalence[]`).
- Produces:
  - `@/lib/prevalence`: `type Reliability = "Good" | "Fair" | "Low"`, `interface PrevalenceFigures`, `interface SectionCell`, `const CLUSTERED`, `figureLine(f: PrevalenceFigures): string`, `figureTooltip(f: PrevalenceFigures): string`
  - `PrevalenceFigure({ fig, className })`, `ReliabilityPill({ value })` from `pages/dashboard/PrevalenceFigure.tsx`
  - `SectionGrid({ sections })` from `pages/dashboard/SectionGrid.tsx`
  - `GhPrevalence` type exported from `GreenhouseModal.tsx`

- [ ] **Step 1: Write the failing tests.**

Create `frontend/src/lib/prevalence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CLUSTERED, figureLine, figureTooltip, type PrevalenceFigures } from "./prevalence";

const base: PrevalenceFigures = {
  prevalence: 34,
  prev: 50,
  margin: 6,
  sections_scouted: 8,
  sections_total: 9,
  reliability: "Good",
  reason: null,
};

describe("figureLine", () => {
  it("reads like the spec: 34% (was 50%) · ±6 · 8/9", () => {
    expect(figureLine(base)).toBe("34% (was 50%) · ±6 · 8/9");
  });

  it('omits "(was …)" when there is no previous week', () => {
    expect(figureLine({ ...base, prev: null })).toBe("34% · ±6 · 8/9");
  });

  it('says "too clustered to judge" when the margin is unknown', () => {
    expect(figureLine({ ...base, margin: null, reason: CLUSTERED, sections_scouted: 1 })).toBe(
      "34% (was 50%) · too clustered to judge · 1/9",
    );
  });

  it("keeps one decimal and scope-wide section totals", () => {
    expect(figureLine({ ...base, prevalence: 33.3, prev: null, margin: 17.8, sections_scouted: 52, sections_total: 63 }))
      .toBe("33.3% · ±17.8 · 52/63");
  });

  it("reports the reason when there are no stations", () => {
    expect(figureLine({ ...base, prevalence: null, reason: "no stations set up" })).toBe("no stations set up");
  });
});

describe("figureTooltip", () => {
  it("explains the four figures, one line each", () => {
    const lines = figureTooltip(base).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Prevalence:/);
    expect(lines[1]).toMatch(/^Was:/);
    expect(lines[2]).toMatch(/^±:/);
    expect(lines[3]).toMatch(/^8\/9:/);
  });
});
```

Create `frontend/src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#000", disease: () => "#000" }),
}));
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: () => ({ data: null, loading: false, error: null, progress: null, reload: vi.fn() }),
}));

import { PrevalenceFigure } from "../PrevalenceFigure";
import { PestsTab } from "../PestsTab";
import { OverviewTab } from "../OverviewTab";
import type { PestsPayload } from "../pests-diseases-types";
import type { OverviewPayload } from "../overview-types";

const fig = {
  prevalence: 33.3, prev: 50, margin: 6, sections_scouted: 8, sections_total: 9,
  reliability: "Fair" as const, reason: null,
};

describe("PrevalenceFigure", () => {
  it("renders the figure line and the reliability pill", () => {
    render(<PrevalenceFigure fig={fig} />);
    expect(screen.getByText("33.3% (was 50%) · ±6 · 8/9")).toBeInTheDocument();
    expect(screen.getByTestId("reliability-pill")).toHaveTextContent("Fair");
    expect(screen.getByTestId("prevalence-figure").getAttribute("title")?.split("\n")).toHaveLength(4);
  });

  it("shows too clustered to judge with a Low pill", () => {
    render(<PrevalenceFigure fig={{ ...fig, margin: null, reason: "too clustered to judge", sections_scouted: 1, reliability: "Low" }} />);
    expect(screen.getByText("33.3% (was 50%) · too clustered to judge · 1/9")).toBeInTheDocument();
    expect(screen.getByTestId("reliability-pill")).toHaveTextContent("Low");
  });

  it("uses no coloured left border", () => {
    render(<PrevalenceFigure fig={fig} />);
    const el = screen.getByTestId("prevalence-figure");
    expect(el.className).not.toMatch(/border-l/);
    expect(screen.getByTestId("reliability-pill").className).not.toMatch(/border-l/);
  });

  it("renders nothing without figures", () => {
    const { container } = render(<PrevalenceFigure fig={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Pests tab severity rows", () => {
  it("carry the scope-wide figure line", () => {
    const data: PestsPayload = {
      filterOptions: { pests: ["Thrips"], sections: [], stages: [] },
      ranking: [{ name: "Thrips", total: 9, high: 1, moderate: 0, low: 0, ...fig }],
      distribution: [],
      sectionSplit: [],
      greenhousePressure: [],
      dailyPercent: [],
      trendSeries: { rows: [], keys: [] },
    };
    render(<PestsTab data={data} pestName="" section="" stage="" onFiltersChange={() => {}} />);
    expect(screen.getByText("33.3% (was 50%) · ±6 · 8/9")).toBeInTheDocument();
  });
});

describe("Overview active alerts", () => {
  it("carry the figure line under the greenhouse", () => {
    const data: OverviewPayload = {
      kpis: { totalScouts: 1, zonesScouted: 27, greenhouseCount: 1, blockCount: 0, highAlerts: 1 },
      daily: [],
      rangeTotals: { pests: 0, diseases: 0, traps: 0 },
      ghHealth: [],
      topScouts: [],
      scoutsPerDay: [],
      scoutPerformance: [],
      recentActivity: [],
      activeAlerts: [{
        name: "Thrips", kind: "pest", severity: "high", count: 27,
        greenhouse: "Chepsito GH 01 - KR", zone: "9/27 scouted · 2031-W10", date: "2031-03-03",
        ...fig,
      }],
    };
    render(<OverviewTab data={data} scoutLookup={{}} fromDate="2031-03-03" toDate="2031-03-09" />);
    expect(screen.getByText("33.3% (was 50%) · ±6 · 8/9")).toBeInTheDocument();
  });
});
```

Create `frontend/src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useDashboardAggregate = vi.fn();
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));

import { SectionGrid } from "../SectionGrid";
import { GreenhouseModal } from "../GreenhouseModal";
import type { SectionCell } from "@/lib/prevalence";

function cells(pct: (r: number, c: number) => number | null): SectionCell[] {
  const out: SectionCell[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const p = pct(r, c);
      out.push({ row: r, col: c, scouted: p == null ? 2 : 3, infested: p == null ? 0 : 1, pct: p });
    }
  return out;
}

describe("SectionGrid", () => {
  it("shows each section's % and greys the ones below 3 scouted stations", () => {
    render(<SectionGrid sections={cells((r, c) => (r === 2 && c === 2 ? null : 33.3))} />);
    expect(screen.getByTestId("section-0-0")).toHaveTextContent("33.3%");
    expect(screen.getByTestId("section-0-0")).toHaveAttribute("data-scouted", "true");
    const corner = screen.getByTestId("section-2-2");
    expect(corner).toHaveTextContent("not scouted");
    expect(corner).toHaveAttribute("data-scouted", "false");
    expect(screen.getByText("Front")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
  });
});

describe("GreenhouseModal 3 × 3", () => {
  beforeEach(() => {
    const figure = { margin: 17.8, sections_scouted: 9, sections_total: 9, reliability: "Fair" as const, reason: null, prev: null };
    useDashboardAggregate.mockReset().mockReturnValue({
      data: {
        topPests: [{ name: "Thrips", count: 9 }],
        topDiseases: [{ name: "Downy Mildew", count: 3 }],
        traps: [], daily: [], scouts: 1, alerts: 0,
        prevalence: [
          { kind: "pest", name: "Thrips", prevalence: 33.3, ...figure, sections: cells(() => 33.3) },
          { kind: "disease", name: "Downy Mildew", prevalence: 11.1, ...figure,
            sections: cells((r, c) => (r === 0 && c === 0 ? 100 : 0)) },
        ],
      },
    });
  });

  it("maps the top observation first and switches on click", () => {
    render(<GreenhouseModal greenhouse="Chepsito GH 01 - KR" fromDate="2031-03-03" toDate="2031-03-09" crop="Rose" onClose={() => {}} />);
    expect(screen.getByTestId("section-1-1")).toHaveTextContent("33.3%");
    expect(screen.getByText("33.3% · ±17.8 · 9/9")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Downy Mildew" }));
    expect(screen.getByTestId("section-0-0")).toHaveTextContent("100%");
    expect(screen.getByTestId("section-1-1")).toHaveTextContent("0%");
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/prevalence.test.ts src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx`
  Expected: `Failed to resolve import "./prevalence"`, `"../PrevalenceFigure"` and `"../SectionGrid"`.

- [ ] **Step 3: Implement.**

Create `frontend/src/lib/prevalence.ts`:

```ts
/** Station prevalence figures as the dashboard aggregates send them — see
 *  upande_scp/serverscripts/common/prevalence.py. Every percentage is 0–100 with
 *  one decimal; the browser only formats them, it never recomputes. */
export type Reliability = "Good" | "Fair" | "Low";

export interface PrevalenceFigures {
  /** adjusted prevalence: section rates averaged (null = no stations set up) */
  prevalence: number | null;
  /** the same figure for the previous scouted week */
  prev?: number | null;
  /** 95% margin in percentage points; null = too clustered to judge */
  margin: number | null;
  /** sections (3 × 3 per house) with at least 3 stations scouted */
  sections_scouted: number;
  /** 9 per house; 9 × houses for a scope-wide figure */
  sections_total?: number;
  reliability: Reliability;
  reason?: string | null;
  raw?: number | null;
  coverage?: number | null;
  scouted?: number;
  stations?: number;
  week?: string | null;
}

export interface SectionCell {
  row: number;
  col: number;
  scouted: number;
  infested: number;
  /** null when fewer than 3 stations were scouted there ("not scouted") */
  pct: number | null;
}

export const CLUSTERED = "too clustered to judge";

/** "34% (was 50%) · ±6 · 8/9" — the one line the dashboard shows. */
export function figureLine(f: PrevalenceFigures): string {
  if (f.prevalence == null) return f.reason || "no stations set up";
  const was = f.prev != null ? ` (was ${f.prev}%)` : "";
  const margin = f.margin != null ? `±${f.margin}` : f.reason || CLUSTERED;
  return `${f.prevalence}%${was} · ${margin} · ${f.sections_scouted}/${f.sections_total ?? 9}`;
}

/** Hover text: what each of the four figures means, one line each. */
export function figureTooltip(f: PrevalenceFigures): string {
  return [
    "Prevalence: share of scouted stations carrying it, each part of the house counted equally (latest scouted week)",
    "Was: the same figure for the previous scouted week",
    "±: 95% margin, from how much the parts of the house disagree and how many stations were scouted",
    `${f.sections_scouted}/${f.sections_total ?? 9}: parts of the house (3 × 3 grid) with at least 3 stations scouted`,
  ].join("\n");
}
```

Create `frontend/src/pages/dashboard/PrevalenceFigure.tsx`:

```tsx
import { cn } from "@/lib/utils";
import {
  figureLine,
  figureTooltip,
  type PrevalenceFigures,
  type Reliability,
} from "@/lib/prevalence";

const TONE: Record<Reliability, string> = {
  Good: "var(--sd-data-green)",
  Fair: "var(--sd-data-amber)",
  Low: "var(--sd-muted)",
};

/** Good / Fair / Low as a small tinted pill — colour on text and background,
 *  never a border strip. */
export function ReliabilityPill({ value }: { value: Reliability }) {
  const tone = TONE[value] ?? TONE.Low;
  return (
    <span
      data-testid="reliability-pill"
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {value}
    </span>
  );
}

/** `34% (was 50%) · ±6 · 8/9` + reliability pill; hover explains the figures. */
export function PrevalenceFigure({
  fig,
  className,
}: {
  fig: PrevalenceFigures | null | undefined;
  className?: string;
}) {
  if (!fig) return null;
  return (
    <div
      data-testid="prevalence-figure"
      title={figureTooltip(fig)}
      className={cn(
        "flex items-center gap-1.5 text-[0.7rem] text-muted-foreground tabular-nums",
        className,
      )}
    >
      <span className="truncate">{figureLine(fig)}</span>
      <ReliabilityPill value={fig.reliability} />
    </div>
  );
}
```

Create `frontend/src/pages/dashboard/SectionGrid.tsx`:

```tsx
import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { SectionCell } from "@/lib/prevalence";

const ROWS = ["First third", "Middle third", "Last third"];
const COLS = ["Front", "Middle", "Back"];

/** The house as a 3 × 3 grid: rows are thirds of its beds (or orchard rows) in
 *  order, columns the front / middle / back of each bed. Each cell shows its
 *  prevalence; a cell with fewer than 3 stations scouted is greyed "not scouted"
 *  because it does not enter the adjusted figure. */
export function SectionGrid({ sections }: { sections: SectionCell[] }) {
  const at = new Map(sections.map((s) => [`${s.row}:${s.col}`, s]));
  return (
    <div
      data-testid="section-grid"
      className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-1 text-[0.7rem]"
    >
      <span />
      {COLS.map((c) => (
        <span key={c} className="text-center text-[0.6rem] uppercase tracking-wide text-muted-foreground">
          {c}
        </span>
      ))}
      {ROWS.map((label, r) => (
        <Fragment key={label}>
          <span className="self-center whitespace-nowrap pr-2 text-muted-foreground">{label}</span>
          {COLS.map((_c, c) => {
            const s = at.get(`${r}:${c}`);
            const pct = s?.pct ?? null;
            const scouted = pct != null;
            return (
              <div
                key={c}
                data-testid={`section-${r}-${c}`}
                data-scouted={scouted ? "true" : "false"}
                title={s ? `${s.infested} of ${s.scouted} stations scouted` : "no stations"}
                className={cn(
                  "rounded-md border px-2 py-2 text-center tabular-nums",
                  scouted ? "text-foreground" : "bg-[var(--sd-bg-soft)] text-muted-foreground opacity-60",
                )}
                style={
                  scouted
                    ? { background: `color-mix(in srgb, var(--sd-data-red) ${Math.min(60, Math.round(pct))}%, var(--sd-card))` }
                    : undefined
                }
              >
                {scouted ? `${pct}%` : "not scouted"}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
```

`overview-types.ts`. Add at the top of the file:

```ts
import type { PrevalenceFigures } from "@/lib/prevalence";

```

Replace the `ActiveAlert` interface (:34-38) with:

```ts
/** One flagged (greenhouse, observation, stage) cell. The figures are the
 *  house's station prevalence in its latest scouted ISO week. */
export interface ActiveAlert extends PrevalenceFigures {
  name: string; kind: "pest" | "disease";
  severity: "high" | "moderate";
  count: number; greenhouse: string; zone: string; date: string;
}
```

`pests-diseases-types.ts` — replace lines 1-31 (from `export interface ItemPercent` through the `PestsPayload` closing brace) with:

```ts
import type { PrevalenceFigures, Reliability } from "@/lib/prevalence";

export interface ItemPercent { name: string; pct: number; zones: number }
/** Distribution / pressure row: `pct` is the adjusted prevalence (null when no
 *  house in scope has stations set up), `zones` the infested stations. */
export interface PrevalenceItem extends PrevalenceFigures {
  name: string; pct: number | null; zones: number;
}
export interface RankingRow extends PrevalenceFigures {
  name: string; total: number; high: number; moderate: number; low: number;
}
/** One ISO week of the trend line, dated on the week's Monday. */
export interface DailyPctRow {
  date: string; week?: string; value: number | null;
  margin?: number | null; reliability?: Reliability;
}
export interface TrendSeries {
  rows: Array<Record<string, string | number>>;
  keys: string[];
}

/** Stage options for the dashboard filter row.
 *
 *  `stages` is the flat union across every observation — right only while no
 *  specific pest/disease is picked. `stagesByItem` narrows it per observation,
 *  so choosing a pest stops the picker offering stages that pest never has.
 *  Optional because a payload cached before the server emitted it will lack it;
 *  consumers fall back to the flat list. */
export interface StageFilterOptions {
  sections: string[];
  stages: string[];
  stagesByItem?: Record<string, string[]>;
}

export interface PestsPayload {
  filterOptions: StageFilterOptions & { pests: string[] };
  ranking: RankingRow[];
  distribution: PrevalenceItem[];
  sectionSplit: ItemPercent[];
  greenhousePressure: PrevalenceItem[];
  dailyPercent: DailyPctRow[];
  trendSeries: TrendSeries;
}
```

`OverviewTab.tsx`. After `import { GreenhouseModal } from "./GreenhouseModal";` add:

```tsx
import { PrevalenceFigure } from "./PrevalenceFigure";
```

Then replace:

```tsx
                  <div className="text-[0.7rem] text-muted-foreground truncate">
                    {a.greenhouse}
                    {a.zone ? ` · ${a.zone}` : ""}
                  </div>
```

with:

```tsx
                  <div className="text-[0.7rem] text-muted-foreground truncate">
                    {a.greenhouse}
                    {a.zone ? ` · ${a.zone}` : ""}
                  </div>
                  <PrevalenceFigure fig={a} />
```

`PestsTab.tsx`:
- After `import { DashFilterRow } from "./DashFilterRow";` add `import { PrevalenceFigure } from "./PrevalenceFigure";`.
- Replace `    pct: { label: "% zones", color: "var(--sd-data-cyan)" },` with `    pct: { label: "% scouted (adjusted)", color: "var(--sd-data-cyan)" },`.
- Replace `                {trend.pestName} · zones infected (%) · daily data points` with `                {trend.pestName} · adjusted prevalence (% of scouted stations) · weekly`.
- Replace `<CardDescription>% of zones in scope with each pest</CardDescription>` with `<CardDescription>Adjusted prevalence across the scope · latest scouted week</CardDescription>`.
- Replace `<CardDescription>% zones infected per greenhouse</CardDescription>` with `<CardDescription>Adjusted prevalence · each greenhouse's latest scouted week</CardDescription>`.
- Replace:

```tsx
                            style={{ width: `${(r.low / tot) * 100}%` }}
                          />
                        </div>
                      </div>
```

with:

```tsx
                            style={{ width: `${(r.low / tot) * 100}%` }}
                          />
                        </div>
                        <PrevalenceFigure fig={r} className="mt-1" />
                      </div>
```

`DiseasesTab.tsx` gets the same five edits. Add the import after `import { DashFilterRow } from "./DashFilterRow";`, and change the `pct` label line the same way. Replace `                {trend.diseaseName} · zones infected (%) · daily data points` with `                {trend.diseaseName} · adjusted prevalence (% of scouted stations) · weekly`. Replace `<CardDescription>% of zones in scope with each disease</CardDescription>` with `<CardDescription>Adjusted prevalence across the scope · latest scouted week</CardDescription>`. Replace `<CardDescription>% zones infected per greenhouse</CardDescription>` with `<CardDescription>Adjusted prevalence · each greenhouse's latest scouted week</CardDescription>`. Make the identical severity-row edit (same anchor text).

`GreenhouseModal.tsx`:
- Replace the first line `import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";` with:

```tsx
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
```

- After `import { weekTickFormatter } from "@/lib/iso-week";` add:

```tsx
import type { PrevalenceFigures, SectionCell } from "@/lib/prevalence";
import { PrevalenceFigure } from "./PrevalenceFigure";
import { SectionGrid } from "./SectionGrid";
```

- Replace the `GhDetailPayload` interface with:

```tsx
/** One top observation's station prevalence in the house's latest scouted week,
 *  with its 3 × 3 sections. */
export interface GhPrevalence extends PrevalenceFigures {
  kind: "pest" | "disease";
  name: string;
  sections: SectionCell[];
}

export interface GhDetailPayload {
  topPests:    Array<{ name: string; count: number }>;
  topDiseases: Array<{ name: string; count: number }>;
  traps:       Array<{ pest: string; total: number }>;
  daily:       Array<{ date: string; pests: number; diseases: number; traps: number }>;
  scouts:      number;
  alerts:      number;
  prevalence?: GhPrevalence[];
}
```

- Replace:

```tsx
  const detail = data ?? { topPests: [], topDiseases: [], traps: [], daily: [],
                           scouts: 0, alerts: 0 };
```

with:

```tsx
  const detail = data ?? { topPests: [], topDiseases: [], traps: [], daily: [],
                           scouts: 0, alerts: 0, prevalence: [] };
  const mapped = detail.prevalence ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [greenhouse]);
  const current = mapped.find((m) => `${m.kind}:${m.name}` === picked) ?? mapped[0] ?? null;
```

- Insert a new card directly before the Daily Trend card. Replace:

```tsx
        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Daily Trend</CardTitle>
```

with:

```tsx
        {current && (
          <Card className="p-4">
            <CardHeader className="p-0 pb-2">
              <CardTitle>Where it is · {current.week ?? "latest scouted week"}</CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                {mapped.map((m) => {
                  const on = m === current;
                  return (
                    <button
                      key={`${m.kind}:${m.name}`}
                      type="button"
                      onClick={() => setPicked(`${m.kind}:${m.name}`)}
                      className={
                        on
                          ? "rounded-full border px-2.5 py-0.5 text-xs bg-primary text-primary-foreground border-primary"
                          : "rounded-full border px-2.5 py-0.5 text-xs bg-card text-muted-foreground hover:bg-muted"
                      }
                    >
                      {m.name}
                    </button>
                  );
                })}
              </div>
              <PrevalenceFigure fig={current} />
              <SectionGrid sections={current.sections} />
            </CardContent>
          </Card>
        )}

        <Card className="p-4">
          <CardHeader className="p-0 pb-2">
            <CardTitle>Daily Trend</CardTitle>
```

- [ ] **Step 4: Run them and watch them pass.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/prevalence.test.ts src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx`
  Expected: all pass (6 + 6 + 2 tests).
  Run: `npx vitest run src/pages/dashboard src/pages/__tests__/Dashboard.crop.test.tsx`. Expected: all pass.
  Run: `npx tsc --noEmit -p tsconfig.app.json`. Expected: no errors. Any file still building a `RankingRow`/`ActiveAlert` without the figure fields must get them. Only the tests above do so.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add frontend/src/lib/prevalence.ts frontend/src/lib/prevalence.test.ts \
        frontend/src/pages/dashboard/PrevalenceFigure.tsx frontend/src/pages/dashboard/SectionGrid.tsx \
        frontend/src/pages/dashboard/overview-types.ts frontend/src/pages/dashboard/pests-diseases-types.ts \
        frontend/src/pages/dashboard/OverviewTab.tsx frontend/src/pages/dashboard/PestsTab.tsx \
        frontend/src/pages/dashboard/DiseasesTab.tsx frontend/src/pages/dashboard/GreenhouseModal.tsx \
        frontend/src/pages/dashboard/__tests__/PrevalenceFigure.test.tsx \
        frontend/src/pages/dashboard/__tests__/GreenhouseModal.sections.test.tsx
git commit -m "feat(scp-ui): prevalence figure line, reliability pill and greenhouse 3 × 3 grid"
```

---

### Task 7: Trends — a shaded margin band on each line

**Files:**
- Modify: `frontend/src/pages/trends/trends-types.ts` (`TrendsVocab` :24-32, `TrendsPayload` :41-78)
- Modify: `frontend/src/pages/trends/aggregate.ts` (append)
- Modify: `frontend/src/pages/trends/ChartPanel.tsx` (recharts import :2-9; aggregate import :39-44; `IncidenceTooltip` :170-239; memos after `statsByWeek` :302-313; `yMax` :413-425; main chart :535-657; card description)
- Create: `frontend/src/pages/trends/__tests__/prevalence-band.test.ts`

**Interfaces:**
- Consumes: the Task 5 payload (`prevalenceByStation`, `prevalenceByFarm`, `vocab.farms`, `vocab.reliability`) and the existing `MatrixIndex` from `buildMatrixIndex`.
- Produces (in `pages/trends/aggregate.ts`):
  - `BAND_SUFFIX = "__band"`
  - `interface PrevalencePoint { prevalence: number; margin: number | null; reliability: string; lo: number | null; hi: number | null }`
  - `interface PrevalenceIndex { station: Map<string, PrevalencePoint>; farm: Map<string, PrevalencePoint>; farmIdxByName: Map<string, number> }`
  - `buildPrevalenceIndex(payload: TrendsPayload): PrevalenceIndex`
  - `prevalenceForCell(index: MatrixIndex, pIndex: PrevalenceIndex, sel: Selection, week: string, obs: ObsKey | null, stage: string | null): PrevalencePoint | null`
  - `buildPrevalenceByWeek(weeks: string[], index, pIndex, selections, obs, stage): Map<string, Map<string, PrevalencePoint>>`
  - `buildMarginBands(byWeek, selections): Map<string, Record<string, [number, number]>>`
  - `trends-types.ts`: `type PrevalenceRow = [number, number, number, number, number | null, number]`

- [ ] **Step 1: Write the failing test.** Create `frontend/src/pages/trends/__tests__/prevalence-band.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BAND_SUFFIX,
  buildMarginBands,
  buildMatrixIndex,
  buildPrevalenceByWeek,
  buildPrevalenceIndex,
  prevalenceForCell,
} from "../aggregate";
import type { ObsKey, Selection, TrendsPayload } from "../trends-types";

const GH12: Selection = { kind: "station", farm: "Karen Farm", station: "GH 12", label: "GH 12" };
const FARM: Selection = { kind: "farm", farm: "Karen Farm", label: "Karen Farm" };
const THRIPS: ObsKey = { kind: "pest", name: "Thrips", label: "Thrips" };

function payload(over: Partial<TrendsPayload> = {}): TrendsPayload {
  return {
    options: { farmStations: {}, pests: {}, diseases: {}, stagesByObs: {} },
    vocab: {
      weeks: ["2031-W10"], stations: ["GH 12", "GH 13"], obs: ["pest:Thrips"], stages: [""],
      farms: ["Karen Farm"], reliability: ["Good", "Fair", "Low"],
    },
    byAny: [[0, 0, 9]],
    byKindName: [[0, 0, 0, 9]],
    byKindNameStage: [],
    scoutedByStation: [[0, 0, 27]],
    intensityByStation: [],
    stationsByFarm: { "Karen Farm": ["GH 12", "GH 13"] },
    unitsByStation: { "GH 12": 27 },
    allWeeks: ["2031-W10"],
    unitTotalsByStation: { "GH 12": 666, "GH 13": 500 },
    unitLabel: "zone",
    unitLabelPlural: "zones",
    prevalenceByStation: [[0, 0, 0, 33.3, 17.8, 1]],
    prevalenceByFarm: [[0, 0, 0, 30, null, 2]],
    ...over,
  };
}

function lookup(p: TrendsPayload, sel: Selection, obs: ObsKey | null, stage: string | null = null) {
  return prevalenceForCell(buildMatrixIndex(p), buildPrevalenceIndex(p), sel, "2031-W10", obs, stage);
}

describe("prevalence band lookups", () => {
  it("reads a station's adjusted prevalence and its band", () => {
    expect(lookup(payload(), GH12, THRIPS)).toEqual({
      prevalence: 33.3, margin: 17.8, reliability: "Fair", lo: 15.5, hi: 51.1,
    });
  });

  it("reads a farm row, with no band when too clustered to judge", () => {
    expect(lookup(payload(), FARM, THRIPS)).toEqual({
      prevalence: 30, margin: null, reliability: "Low", lo: null, hi: null,
    });
  });

  it("has nothing for all observations or for a stage child", () => {
    expect(lookup(payload(), GH12, null)).toBeNull();
    expect(lookup(payload(), GH12, THRIPS, "Adult")).toBeNull();
  });

  it("floors at 0 and caps at 100", () => {
    const p = payload({ prevalenceByStation: [[0, 0, 0, 3, 8, 2]] });
    expect(lookup(p, GH12, THRIPS)).toMatchObject({ lo: 0, hi: 11 });
    const q = payload({ prevalenceByStation: [[0, 0, 0, 97, 8, 2]] });
    expect(lookup(q, GH12, THRIPS)).toMatchObject({ lo: 89, hi: 100 });
  });

  it("tolerates a payload without the prevalence tables", () => {
    const p = payload({ prevalenceByStation: undefined, prevalenceByFarm: undefined });
    expect(lookup(p, GH12, THRIPS)).toBeNull();
  });

  it("builds bands keyed by the selection's series", () => {
    const p = payload();
    const byWeek = buildPrevalenceByWeek(p.allWeeks, buildMatrixIndex(p), buildPrevalenceIndex(p), [GH12, FARM], THRIPS, null);
    const bands = buildMarginBands(byWeek, [GH12, FARM]);
    expect(bands.get("2031-W10")).toEqual({ [`GH 12${BAND_SUFFIX}`]: [15.5, 51.1] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/pages/trends/__tests__/prevalence-band.test.ts`
  Expected: `SyntaxError`/`TypeError` because `BAND_SUFFIX`, `buildPrevalenceIndex` and the rest are not exported from `../aggregate`. Typecheck would also flag the unknown `farms`/`prevalenceByStation` keys.

- [ ] **Step 3: Implement.**

`trends-types.ts` — in `TrendsVocab`, replace

```ts
  stages: string[]; // index 0 is the empty-stage sentinel
}
```

with:

```ts
  stages: string[]; // index 0 is the empty-stage sentinel
  /** farm names that `prevalenceByFarm` rows index into */
  farms?: string[];
  /** reliability labels that prevalence rows index into: Good / Fair / Low */
  reliability?: string[];
}

/** [weekIdx, stationIdx | farmIdx, obsIdx, prevalence %, margin % | null, reliabilityIdx] */
export type PrevalenceRow = [number, number, number, number, number | null, number];
```

In `TrendsPayload`, replace

```ts
  sprayEvents?: Record<string, SprayEvent[]>;
}
```

with:

```ts
  sprayEvents?: Record<string, SprayEvent[]>;
  /** Adjusted station prevalence per (week, station, observation): section rates
   *  averaged over the 3 × 3 grid, with a 95% margin — see common/prevalence.py.
   *  Optional: a payload cached before it existed simply draws no band. */
  prevalenceByStation?: PrevalenceRow[];
  /** The same, combined over every house of a farm scouted that week. */
  prevalenceByFarm?: PrevalenceRow[];
}
```

`aggregate.ts` — change the type import at the top to include `PrevalenceRow`:

```ts
import type {
  ObsKey,
  PrevalenceRow,
  Selection,
  TreeNode,
  TrendsPayload,
  TrendsOptions,
} from "./trends-types";
```

Then append to the end of the file:

```ts

/* =============================================================
 * Adjusted prevalence + margin band
 *
 * The server computes station prevalence per (week, station|farm, obs) — see
 * _trends._prevalence_tables. The client only looks the rows up: the line keeps
 * plotting incidence, and a shaded band shows where the adjusted prevalence
 * lies (prevalence ± margin). Per observation over all stages, so there is no
 * band on "All observations" or on a stage child panel.
 * ============================================================= */

export const BAND_SUFFIX = "__band";

export interface PrevalencePoint {
  prevalence: number;
  margin: number | null;
  reliability: string;
  /** prevalence − margin, floored at 0; null when the margin is unknown */
  lo: number | null;
  /** prevalence + margin, capped at 100; null when the margin is unknown */
  hi: number | null;
}

export interface PrevalenceIndex {
  station: Map<string, PrevalencePoint>;
  farm: Map<string, PrevalencePoint>;
  farmIdxByName: Map<string, number>;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function toPoint(row: PrevalenceRow, reliability: string[]): PrevalencePoint {
  const [, , , prevalence, margin, rel] = row;
  return {
    prevalence,
    margin,
    reliability: reliability[rel] ?? "Low",
    lo: margin == null ? null : Math.max(0, round1(prevalence - margin)),
    hi: margin == null ? null : Math.min(100, round1(prevalence + margin)),
  };
}

export function buildPrevalenceIndex(payload: TrendsPayload): PrevalenceIndex {
  const rel = payload.vocab.reliability ?? ["Good", "Fair", "Low"];
  const station = new Map<string, PrevalencePoint>();
  for (const row of payload.prevalenceByStation ?? []) {
    station.set(`${row[0]}|${row[1]}|${row[2]}`, toPoint(row, rel));
  }
  const farm = new Map<string, PrevalencePoint>();
  for (const row of payload.prevalenceByFarm ?? []) {
    farm.set(`${row[0]}|${row[1]}|${row[2]}`, toPoint(row, rel));
  }
  const farmIdxByName = new Map((payload.vocab.farms ?? []).map((f, i) => [f, i]));
  return { station, farm, farmIdxByName };
}

export function prevalenceForCell(
  index: MatrixIndex,
  pIndex: PrevalenceIndex,
  sel: Selection,
  week: string,
  obs: ObsKey | null,
  stage: string | null,
): PrevalencePoint | null {
  if (!obs || stage) return null;
  const w = index.weekIdxByWeek.get(week);
  const o = index.obsIdxByKey.get(`${obs.kind}:${obs.name}`);
  if (w === undefined || o === undefined) return null;
  if (sel.kind === "station") {
    const s = index.stationIdxByName.get(sel.station);
    return s === undefined ? null : pIndex.station.get(`${w}|${s}|${o}`) ?? null;
  }
  const f = pIndex.farmIdxByName.get(sel.farm);
  return f === undefined ? null : pIndex.farm.get(`${w}|${f}|${o}`) ?? null;
}

/** week → selection label → prevalence point (only where one exists). */
export function buildPrevalenceByWeek(
  weeks: string[],
  index: MatrixIndex,
  pIndex: PrevalenceIndex,
  selections: Selection[],
  obs: ObsKey | null,
  stage: string | null,
): Map<string, Map<string, PrevalencePoint>> {
  const out = new Map<string, Map<string, PrevalencePoint>>();
  for (const wk of weeks) {
    const inner = new Map<string, PrevalencePoint>();
    for (const sel of selections) {
      const p = prevalenceForCell(index, pIndex, sel, wk, obs, stage);
      if (p) inner.set(sel.label, p);
    }
    out.set(wk, inner);
  }
  return out;
}

/** week → { "<label>__band": [lo, hi] } for every point that has a margin. */
export function buildMarginBands(
  byWeek: Map<string, Map<string, PrevalencePoint>>,
  selections: Selection[],
): Map<string, Record<string, [number, number]>> {
  const out = new Map<string, Record<string, [number, number]>>();
  for (const [wk, inner] of byWeek) {
    const rec: Record<string, [number, number]> = {};
    for (const sel of selections) {
      const p = inner.get(sel.label);
      if (p && p.lo != null && p.hi != null) rec[`${sel.label}${BAND_SUFFIX}`] = [p.lo, p.hi];
    }
    out.set(wk, rec);
  }
  return out;
}
```

`ChartPanel.tsx`:

1. Replace the recharts import (lines 2-9) with:

```tsx
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
```

2. Replace the aggregate import (lines 39-44) with:

```tsx
import {
  BAND_SUFFIX,
  buildMarginBands,
  buildPrevalenceByWeek,
  buildPrevalenceIndex,
  buildSeries,
  cellStats,
  type CellStats,
  type MatrixIndex,
  type PrevalencePoint,
} from "./aggregate";
```

3. In `IncidenceTooltip`, replace the props destructuring and type:

```tsx
  statsByWeek,
  unitLabelPlural,
  sprayByWeek,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; dataKey?: string; value?: number; color?: string }>;
  label?: string;
  statsByWeek: Map<string, Map<string, CellStats>>;
  unitLabelPlural: string;
  sprayByWeek?: Map<string, SprayMark>;
}) {
```

with:

```tsx
  statsByWeek,
  unitLabelPlural,
  sprayByWeek,
  prevalenceByWeek,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; dataKey?: string; value?: number | number[]; color?: string }>;
  label?: string;
  statsByWeek: Map<string, Map<string, CellStats>>;
  unitLabelPlural: string;
  sprayByWeek?: Map<string, SprayMark>;
  prevalenceByWeek?: Map<string, Map<string, PrevalencePoint>>;
}) {
```

   Replace `        {items.map((it) => {` with `        {items.filter((it) => !String(it.dataKey ?? it.name ?? "").endsWith(BAND_SUFFIX)).map((it) => {`.

   Replace:

```tsx
                  {s.pressure != null
                    ? ` · ${s.pressure.toFixed(2)}/${unitLabelPlural.replace(/s$/, "")}`
                    : ""}
                </div>
              )}
```

with:

```tsx
                  {s.pressure != null
                    ? ` · ${s.pressure.toFixed(2)}/${unitLabelPlural.replace(/s$/, "")}`
                    : ""}
                </div>
              )}
              {(() => {
                const p = prevalenceByWeek?.get(label)?.get(key);
                if (!p) return null;
                return (
                  <div className="pl-3.5 font-mono text-[0.65rem] text-muted-foreground tabular-nums">
                    adjusted {p.prevalence}%
                    {p.margin != null ? ` ±${p.margin}` : " · too clustered to judge"} · {p.reliability}
                  </div>
                );
              })()}
```

4. Insert the prevalence memos right after the `statsByWeek` memo. Replace:

```tsx
  }, [payload, index, selections, obs, child?.stage]);

  /** Pest pressure — mean count per unit SCOUTED. A count, not a percentage, so
```

with:

```tsx
  }, [payload, index, selections, obs, child?.stage]);

  /** Adjusted prevalence ± margin per week and selection (server-computed rows,
   *  looked up). Drawn as a shaded band behind each incidence line. */
  const pIndex = useMemo(() => buildPrevalenceIndex(payload), [payload]);
  const prevalenceByWeek = useMemo(
    () =>
      buildPrevalenceByWeek(payload.allWeeks, index, pIndex, selections, obs, child?.stage || null),
    [payload.allWeeks, index, pIndex, selections, obs, child?.stage],
  );
  const marginBands = useMemo(
    () => buildMarginBands(prevalenceByWeek, selections),
    [prevalenceByWeek, selections],
  );
  const chartData = useMemo(
    () => seriesData.map((p) => ({ ...p, ...(marginBands.get(String(p.date)) ?? {}) })),
    [seriesData, marginBands],
  );

  /** Pest pressure — mean count per unit SCOUTED. A count, not a percentage, so
```

5. In the `yMax` memo, replace:

```tsx
    if (band) {
      max = Math.max(max, band.high ?? 0, band.moderate ?? 0, band.low ?? 0);
    }
    return niceCeilPercent(max);
  }, [seriesData, band]);
```

with:

```tsx
    if (band) {
      max = Math.max(max, band.high ?? 0, band.moderate ?? 0, band.low ?? 0);
    }
    for (const rec of marginBands.values()) {
      for (const k in rec) max = Math.max(max, rec[k][1]);
    }
    return niceCeilPercent(max);
  }, [seriesData, band, marginBands]);
```

6. Main chart. Replace:

```tsx
              <LineChart
                data={seriesData}
                margin={{ left: 4, right: 8, top: 8 }}
                onMouseLeave={leave}
              >
```

with:

```tsx
              <ComposedChart
                data={chartData}
                margin={{ left: 4, right: 8, top: 8 }}
                onMouseLeave={leave}
              >
```

   Replace:

```tsx
              </LineChart>
            </ChartContainer>
          </div>
          <div className="md:w-48 shrink-0 md:border-l md:pl-3 pt-2 md:pt-0">
```

with:

```tsx
              </ComposedChart>
            </ChartContainer>
          </div>
          <div className="md:w-48 shrink-0 md:border-l md:pl-3 pt-2 md:pt-0">
```

   (That `md:border-l` is the existing legend column divider, not an accent bar. Leave it.)

   Pass the map to the tooltip: replace

```tsx
                      sprayByWeek={sprayByWeek}
                    />
```

with:

```tsx
                      sprayByWeek={sprayByWeek}
                      prevalenceByWeek={prevalenceByWeek}
                    />
```

   Draw the bands under the lines. Replace:

```tsx
                {selections.map((s, i) => {
                  const isHover = hovered === s.label;
                  const dim = hovered != null && !isHover;
                  return (
                    <Line
                      key={`${s.kind}:${s.label}`}
```

with:

```tsx
                {selections.map((s, i) => (
                  <Area
                    key={`band:${s.kind}:${s.label}`}
                    type="monotone"
                    dataKey={`${s.label}${BAND_SUFFIX}`}
                    stroke="none"
                    fill={PALETTE[i % PALETTE.length]}
                    fillOpacity={hovered != null && hovered !== s.label ? 0.04 : 0.12}
                    connectNulls
                    activeDot={false}
                    legendType="none"
                    isAnimationActive={false}
                  />
                ))}
                {selections.map((s, i) => {
                  const isHover = hovered === s.label;
                  const dim = hovered != null && !isHover;
                  return (
                    <Line
                      key={`${s.kind}:${s.label}`}
```

7. Card description. Replace:

```tsx
            matching observations, per week
```

with:

```tsx
            matching observations, per week
            {obs && !child ? " · band: adjusted prevalence ± margin" : ""}
```

- [ ] **Step 4: Run it and watch it pass.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/pages/trends`. Expected: the new 6 tests pass and the existing `aggregate.test.ts` / `niceCeil.test.ts` still pass.
  Run: `npx vitest run src/pages/__tests__/Trends.crop.test.tsx`. Expected: pass.
  Run: `npx tsc --noEmit -p tsconfig.app.json`. Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add frontend/src/pages/trends/trends-types.ts frontend/src/pages/trends/aggregate.ts \
        frontend/src/pages/trends/ChartPanel.tsx frontend/src/pages/trends/__tests__/prevalence-band.test.ts
git commit -m "feat(scp-ui): trends lines carry a shaded prevalence margin band"
```

---

### Task 8: Every dashboard chart reveals left to right (D6)

**Files:**
- Modify: `frontend/src/pages/dashboard/OverviewTab.tsx` (Areas :154/:162/:170, Pie :197)
- Modify: `frontend/src/pages/dashboard/TrapsTab.tsx` (imports :34-37; ChartContainer :89, :121; Bar :105; Pie :124)
- Modify: `frontend/src/pages/dashboard/FcmTab.tsx` (imports :25-28; ChartContainer :59, :103; Lines :73, :80; Bar :109)
- Modify: `frontend/src/pages/dashboard/GreenhouseModal.tsx` (ChartContainer :159)
- Modify: `frontend/src/pages/dashboard/TrendStrip.tsx` (imports :17-18; ChartContainer :73)
- Create: `frontend/src/pages/dashboard/__tests__/chart-animation.test.ts`
- Reference only, no change: `frontend/src/components/RevealLTR.tsx`, `frontend/src/index.css:295-305` (`.scp-reveal-ltr`, which already honours `prefers-reduced-motion`)

**Interfaces:**
- Consumes: `RevealLTR` from `@/components/RevealLTR`.
- Produces: no API. Every recharts series in the dashboard tabs, modal, `TrendStrip` and the Trends `ChartPanel` has `isAnimationActive={false}`. Every dashboard `ChartContainer` is wrapped as `<RevealLTR><ChartContainer …>…</ChartContainer></RevealLTR>`.

- [ ] **Step 1: Write the failing test.** Create `frontend/src/pages/dashboard/__tests__/chart-animation.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Spec D6: every dashboard chart reveals left to right through RevealLTR; no
 *  recharts series keeps its own animation (a vertical Bar's default animation
 *  grows from the middle, and two animations fight). Scans the source so a new
 *  chart that forgets either rule fails here. */
const DASHBOARD = ["OverviewTab", "PestsTab", "DiseasesTab", "TrapsTab", "FcmTab", "GreenhouseModal", "TrendStrip"];
const SERIES = /<(Area|Bar|Line|Pie|Scatter|Radar|RadialBar|Funnel)[\s>]/g;
const OFF = /isAnimationActive=\{false\}/g;
const CONTAINER = /<ChartContainer[\s>]/g;
const WRAPPED = /<RevealLTR[^>]*>\s*<ChartContainer[\s>]/g;

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("dashboard charts reveal left to right", () => {
  for (const name of DASHBOARD) {
    const src = source(`../${name}.tsx`);

    it(`${name}: every recharts series has its own animation off`, () => {
      expect(count(src, SERIES)).toBeGreaterThan(0);
      expect(count(src, OFF)).toBe(count(src, SERIES));
    });

    it(`${name}: every chart sits inside RevealLTR`, () => {
      expect(count(src, CONTAINER)).toBeGreaterThan(0);
      expect(count(src, WRAPPED)).toBe(count(src, CONTAINER));
    });
  }

  it("Trends chart panel: every series has its own animation off", () => {
    const src = source("../../trends/ChartPanel.tsx");
    expect(count(src, OFF)).toBe(count(src, SERIES));
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/pages/dashboard/__tests__/chart-animation.test.ts`
  Expected failures:
  - `OverviewTab` series: `expected 4 to be 8`.
  - `TrapsTab`: series `0` vs `2`, and RevealLTR `0` vs `2`.
  - `FcmTab`: series `0` vs `3`, and RevealLTR `0` vs `2`.
  - `GreenhouseModal` RevealLTR: `0` vs `1`.
  - `TrendStrip` RevealLTR: `0` vs `1`.
  `PestsTab`, `DiseasesTab` and `ChartPanel` already pass.

- [ ] **Step 3: Implement.**

`OverviewTab.tsx`. Use `replace_all` on the Areas: replace

```tsx
                    fillOpacity={0.18}
                  />
```

with:

```tsx
                    fillOpacity={0.18}
                    isAnimationActive={false}
                  />
```

(3 occurrences). Then replace:

```tsx
                      stroke="var(--sd-card)"
                      strokeWidth={2}
                    >
```

with:

```tsx
                      stroke="var(--sd-card)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    >
```

`TrapsTab.tsx`. After `import { EmptyHint } from "./EmptyHint";` add `import { RevealLTR } from "@/components/RevealLTR";`. Then:
- Replace `<ChartContainer config={barConfig} className="h-72">` with `<RevealLTR><ChartContainer config={barConfig} className="h-72">`.
- Replace `<ChartContainer config={pieConfig} className="h-72">` with `<RevealLTR><ChartContainer config={pieConfig} className="h-72">`.
- Replace all `</ChartContainer>` with `</ChartContainer></RevealLTR>` (`replace_all`; both containers in this file are now wrapped).
- Replace `<Bar dataKey="total" fill="var(--color-total)" radius={[4, 4, 4, 4]} />` with `<Bar isAnimationActive={false} dataKey="total" fill="var(--color-total)" radius={[4, 4, 4, 4]} />`.
- Replace:

```tsx
                    stroke="var(--sd-card)"
                    strokeWidth={2}
                  >
```

  with:

```tsx
                    stroke="var(--sd-card)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
```

`FcmTab.tsx`. After `import { EmptyHint } from "./EmptyHint";` add `import { RevealLTR } from "@/components/RevealLTR";`. Then:
- Replace `<ChartContainer config={lineConfig} className="h-64">` with `<RevealLTR><ChartContainer config={lineConfig} className="h-64">`.
- Replace `<ChartContainer config={barConfig} className="h-60">` with `<RevealLTR><ChartContainer config={barConfig} className="h-60">`.
- Replace all `</ChartContainer>` with `</ChartContainer></RevealLTR>` (`replace_all`).
- Replace (`replace_all`; 2 occurrences, the `traps` and `scouting` lines):

```tsx
                  strokeWidth={2}
                  dot={false}
                />
```

  with:

```tsx
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
```

- Replace `<Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} />` with `<Bar isAnimationActive={false} dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} />`.

`GreenhouseModal.tsx`. After `import { Badge } from "@/components/ui/badge";` add `import { RevealLTR } from "@/components/RevealLTR";`. Then:
- Replace `<ChartContainer config={SERIES} className="h-48">` with `<RevealLTR><ChartContainer config={SERIES} className="h-48">`.
- Replace `</ChartContainer>` (one occurrence) with `</ChartContainer></RevealLTR>`.

`TrendStrip.tsx`. After `import { EmptyHint } from "./EmptyHint";` add `import { RevealLTR } from "@/components/RevealLTR";`. Then:
- Replace `<ChartContainer config={config} className="h-56">` with `<RevealLTR><ChartContainer config={config} className="h-56">`.
- Replace `</ChartContainer>` (one occurrence) with `</ChartContainer></RevealLTR>`.

- [ ] **Step 4: Run it and watch it pass.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/pages/dashboard`. Expected: all pass, including the 15 tests in `chart-animation.test.ts` and the Task 6 tests.
  Run: `npx tsc --noEmit -p tsconfig.app.json`. Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git status --short
git add frontend/src/pages/dashboard/OverviewTab.tsx frontend/src/pages/dashboard/TrapsTab.tsx \
        frontend/src/pages/dashboard/FcmTab.tsx frontend/src/pages/dashboard/GreenhouseModal.tsx \
        frontend/src/pages/dashboard/TrendStrip.tsx \
        frontend/src/pages/dashboard/__tests__/chart-animation.test.ts
git commit -m "fix(scp-ui): every dashboard chart reveals left to right"
```

---

### Task 9: Final regression and a manual server-level check

**Files:**
- No source changes expected. Commit only if a step finds and fixes something, and stage only the files that fix touched.

**Interfaces:**
- Consumes: everything above.
- Produces: green suites, a built bundle, and a recorded real-data sanity check.

- [ ] **Step 1: Run the pure suites.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_prevalence_pure.py upande_scp/serverscripts/tests/test_prevalence_rows_pure.py upande_scp/serverscripts/tests/test_trends_prevalence_pure.py upande_scp/serverscripts/tests/test_cache_invalidation.py upande_scp/serverscripts/tests/test_crop_catalog_pure.py`
  Expected: all pass.

- [ ] **Step 2: Run the DB suites, one DB-RUN each.**
  Modules: `test_prevalence_rows`, `test_prevalence_overview`, `test_prevalence_pests`, `test_prevalence_trends`, `test_dashboard_aggregates_overview`, `test_dashboard_aggregates_pests_diseases`, `test_dashboard_aggregates_gh_detail`, `test_dashboard_aggregates_traps`, `test_dashboard_aggregates_fcm`, `test_dashboard_aggregates_trends`, `test_crop_scoped_aggregates`, `test_crop_scoped_aggregate_detail`, `test_crop_catalog`.
  Expected: every module `OK`. The `peter` test may report a skip if Peter Kamuren has no Employee record.

- [ ] **Step 3: Run the frontend checks.**
  Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && yarn build`
  Expected: all vitest files pass, no type errors, and the build succeeds.

- [ ] **Step 4: Run the manual server-level check against real data.**
  Restart workers so they load the new code: `sudo -n supervisorctl restart frappe15-web:`.
  Pull the Rose pests aggregate for the densest real weeks (2026-W28/W29):

```bash
cd /home/ubuntu/stive/code/frappe15 && time bench --site kaitet.local execute \
  upande_scp.serverscripts.dashboard_aggregates.pests \
  --kwargs "{'from_date': '2026-07-06', 'to_date': '2026-07-19', 'crop': 'Rose', 'force': '1'}" \
  > /tmp/scp-prev-pests.json
../env/bin/python - <<'EOF'
import json, collections
d = json.load(open("/tmp/scp-prev-pests.json"))
gp = d["greenhousePressure"]
print("houses:", len(gp), "reliability:", collections.Counter(r["reliability"] for r in gp))
for r in gp[:5]:
    print(r["name"], r["week"], "prev", r["pct"], "raw", r["raw"], "±", r["margin"],
          f"{r['sections_scouted']}/{r['sections_total']}", "scouted", r["scouted"], "of", r["stations"])
print("weekly:", d["dailyPercent"])
EOF
```

  Expected:
  - `week` is `2026-W29` for houses scouted that week.
  - `scouted ≤ stations`.
  - `coverage` sits mostly in the 28–80% band from the spec.
  - Most houses are Good or Fair.
  - `dailyPercent` has one point per ISO week, dated on Mondays (2026-07-06, 2026-07-13).

  Cross-check one house's denominator against SQL. Take the first `name` printed (call it `<GH>`):

```bash
cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "
SELECT COUNT(DISTINCT se.zone) AS scouted
FROM \`tabScouting Entry\` se
WHERE se.greenhouse = '<GH>' AND YEARWEEK(se.date_of_capture, 3) = 202629
  AND COALESCE(se.zone, '') <> '';"
```

  Expected: `scouted` equals that house's `scouted` in the payload. A difference can only come from entries of another crop in the house (D5), so look at those before accepting it. Record the `time` of the cold call. If it is more than about twice the ~16 s cold overview figure noted in `_common.py`, report it before shipping instead of tuning ad hoc.

- [ ] **Step 5: Look at the UI by hand.**
  Open `/scp_app#/rose/dashboard` for 2026-07-06 → 2026-07-19 and check each of these:
  - The alerts and the pest/disease severity rows show `NN% (was NN%) · ±N · m/9` with a Good/Fair/Low pill.
  - Hovering the line shows four lines of explanation.
  - A greenhouse modal shows the 3 × 3 grid, with thin sections greyed "not scouted".
  - Every chart wipes in from the left; none grows from the middle.
  - No card or row has a coloured left border.
  Open `/scp_app#/rose/trends`, pick one greenhouse and Thrips, and check that a shaded band sits behind the line and the tooltip shows "adjusted …% ±… · Fair".
  Open `/scp_app#/avocado/dashboard` and check that block alerts now appear with wide margins. That is the honest answer at ~7% tree coverage.
  Record what you saw in the PR description. No commit is needed for this task unless a fix was made. If one was, commit only the files you changed, as `fix(scp): …` or `fix(scp-ui): …`, with no trailer.
