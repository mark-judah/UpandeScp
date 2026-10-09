# Station prevalence with a spatial confidence — design

Date: 2026-10-09. Piece 2 of 4 (crop scoping ✅ → **prevalence measure** → thresholds & actions → stage/variety weighting). Builds on piece 1 (`common/crop_catalog.py`, crop-scoped aggregates, commits 076132d..e057c70).

## Goal

Dashboards and Trends say how much of a greenhouse (or avocado block) a pest or disease is in **among the stations actually scouted**, corrected for scouting that bunches in one part of the house, and say how far to trust the figure. Roses first; avocado on the same measure.

## Decisions (agreed with the user)

| # | Decision |
|---|---|
| D1 | Prevalence is per **station** (rose zone, avocado tree) and its denominator is stations **scouted**, not all stations. User's example: 800 zones, 400 scouted, 200 with thrips → 50%. |
| D2 | **Option C:** an adjusted prevalence (sections averaged) **and** a confidence margin + spread. |
| D3 | Sections are a fixed **3 × 3 grid** per greenhouse/block, built from bed/zone (row/tree) order — no geometry, no setup. |
| D4 | **Per ISO week.** A dashboard range shows the latest week in the range for each greenhouse, with the previous week beside it; Trends plots every week. |
| D5 | Reports keep per-hectare (area) — out of scope here. |
| D6 | Every dashboard chart reveals **left to right** (existing `RevealLTR`); no chart grows from the middle. |

## Verified facts (kaitet.local, 2026-10-09)

- Today `_overview._classify_cells`, `_pests_diseases._ranking/_gh_pressure/_distribution/_daily_percent` and `_gh_detail` divide distinct affected zones by **all** zones (`scouting_metrics.get_zone_counts_by_greenhouse`). Rose zone coverage per greenhouse-week: median 45%, p10 28%, p90 80% → today's figures run at roughly half of D1's. `_trends.py` already divides by zones scouted that week.
- Scouting is bed-clustered: scouted beds have ~6 of ~8.4 zones scouted; bed coverage ~68% vs zone coverage ~45%.
- Rose: `Zone` has `greenhouse`, `bed` (Link Bed, name "<GH> - Bed N"), `zone` (int); 504–4,914 zones per greenhouse (median 1,350), median 9 zones per bed. Scouting Entry → `greenhouse`, `bed`, `zone`.
- Avocado: `Orchard Tree` has `block`, `row` (Link Bed), `tree` (int), Point geojson; 195–1,497 trees per block. Scouting Entry → `block`, `row`, `tree`. Weekly tree coverage median ~7%, row coverage ~100%.
- No `section` data exists (0 zones with `section`).
- `index.css` already has `scp-reveal-ltr` / `components/RevealLTR.tsx`; several dashboard charts still use recharts' default animation (e.g. `FcmTab` Bar, `OverviewTab` Area/Pie).

## Design

### 1. The measure — `common/prevalence.py` (pure, no frappe import)

Input for one greenhouse/block, one ISO week, one observation (pest or disease): the station list with grid positions, and the set of scouted stations with which of them carry the observation.

**Grid position (D3).**
- Rose: beds of the greenhouse ordered by bed number → bed rank `b` of `B` beds; a zone's rank `z` among its own bed's zones ordered by zone number, of `Z_b`. Section = (`floor(3·b/B)`, `floor(3·z/Z_b)`), values 0–2 each → 9 sections.
- Avocado: rows ordered by row number → row rank of `R`; tree rank within its row of `T_r`. Same formula.
- A greenhouse with fewer than 3 beds (or a bed with fewer than 3 zones) still maps every station into the grid; empty sections simply have no stations.

**Figures** (per greenhouse/block, week, observation):
- `stations` = all stations; `scouted` = stations with ≥1 Scouting Entry that week (crop-less entries included per piece 1 D5); `coverage = scouted / stations`.
- A station is **infested** if any entry that week records the observation on it (pest: count > 0 or a recorded stage; disease: presence).
- `raw = infested / scouted` over all scouted stations.
- For each section `j` with `n_j ≥ 3` scouted stations: `p_j = x_j / n_j`. `m` = number of such sections.
- **Adjusted prevalence** `p = mean(p_j)` over those `m` sections. Sections with 0–2 scouted stations are reported as **not scouted** and do not enter `p`.
- **Margin (95%)**: `margin = 1.96 · sqrt( s²/m + p(1−p)/N )`, where `s²` is the sample variance of the `p_j` and `N = Σ n_j`. Clipped to [0, 1].
- `m < 2` → `p` is still reported but `margin = None` and the reason is **"too clustered to judge"**.
- **Spread** = `m / 9`.
- **Reliability**: **Good** if `m ≥ 7` and `margin ≤ 0.10`; **Fair** if `m ≥ 4`; else **Low**.

Output shape (one dict): `{stations, scouted, coverage, raw, prevalence, margin, sections_scouted, reliability, reason, sections: [{row, col, scouted, infested, pct|None}]}`. Percentages are returned as 0–100 floats rounded to 1 dp.

### 2. Wiring into the aggregates

- One DB helper `dashboard_aggregates/_prevalence_rows.py` fetches, for a crop + date window, the station grid (Zone / Orchard Tree, cached per greenhouse/block, invalidated with the existing Zone/Orchard Tree cache events) and the week's scouted / infested stations, then calls `prevalence.py`. All crop scoping reuses piece 1 (`parent_filter_conditions`, `obs_filter`).
- **Week choice (D4):** per greenhouse, the latest ISO week in the requested range that has scouting; the previous ISO week with scouting is computed too.
- **Overview** (`_overview._classify_cells`): health and alerts use `prevalence` of the latest week; payload adds `{prevalence, prev, margin, sections_scouted, reliability}` per cell.
- **Pests / Diseases** (`_pests_diseases`): ranking severity cells and "Pressure by greenhouse" use the adjusted prevalence; "Distribution" and "Trends" become weekly series of adjusted prevalence.
- **Greenhouse detail** (`_gh_detail`): adds the 3 × 3 `sections` for the top observations.
- **Trends** (`_trends`): per station-week adds `prevalence`, `margin`, `reliability` beside the existing scouted-denominator incidence.
- **Severity** (`_common.severity_for`) is fed the adjusted prevalence (still the existing Low/Moderate/High bands until piece 3).
- Cache keys: bump the aggregate schema tag (`K_DASH_AGG_SCHEMA` → `"prev1"`).

### 3. Frontend

- Overview / Pests / Diseases: show `34% (was 50%) · ±6 · 8/9` with the reliability as a small pill (Good / Fair / Low); `"too clustered to judge"` replaces the margin when it is `None`. Tooltip explains the four figures in one line each.
- Greenhouse modal: a 3 × 3 grid (rows = bed thirds, columns = front/middle/back), each cell its %, greyed with "not scouted" when below 3 stations.
- Trends: the weekly line carries a shaded margin band; coverage display unchanged.
- **D6:** wrap every dashboard chart in `RevealLTR` and set `isAnimationActive={false}` on recharts series that still animate (`FcmTab`, `OverviewTab` Area/Pie, any other found).
- No vertical accent strips or coloured left-border bars.

### 4. Avocado

Same module and screens; stations are trees, grid from row/tree order. Expect wide margins (≈7% weekly tree coverage); that is the honest answer, not a defect. Avocado pages that read these aggregates (`AvocadoHeatMap` ranking) are out of scope for this piece unless they already call the changed endpoints.

## Clarifications from planning (2026-10-09)

- No section has ≥ 3 scouted stations (m = 0) → prevalence falls back to `raw`, margin None, reason "too clustered to judge", Low.
- Scope-wide figures (several houses): station-weighted mean of house prevalences, margins combined in quadrature, reliability shown as the share of houses per rating (`reliability_mix`, e.g. Good 64 · Fair 28 · Low 3 — user's choice, 2026-10-09; `reliability` keeps the worst house's for back-compat), spread shown as sections scouted / sections in scope; any house with margin None makes the combined margin None.
- "Was" = the latest scouted week before the shown week, looked up to 35 days back.
- Pests/Diseases "Distribution" = latest-week adjusted prevalence per observation; the weekly series is the "Trends" card.
- Trends margin band shows only for one observation with no stage; in that mode the line plots adjusted prevalence so the band surrounds its own line.
- Houses are keyed block-first: `COALESCE(NULLIF(block,''), greenhouse)`.
- **Margin floor (final review, 2026-10-09):** the binomial term uses the Agresti–Coull adjusted rate `p̃ = (X + 2) / (N + 4)` (X = infested across counted sections), i.e. `margin = 1.96 · sqrt( s²/m + p̃(1−p̃)/N )`, so an all-clean or all-infested sample never reads ±0. The reported prevalence is unchanged.
- Trends band mode plots every week a house/farm was scouted for an observation seen there in the window — a clean scouted week is 0%, not a gap; only unscouted weeks are gaps.
- Latest/previous selection fetches station sets only for each house's latest and previous scouted week; the lookback start snaps to the ISO Monday.

## Out of scope

Thresholds model and actions (piece 3); stage/variety weighting (piece 4); per-hectare reports; Heatmaps page figures; coffee triads (no triad scouting data exists).

## Error handling

- Greenhouse with no Zone rows (or block with no trees) → figures `None`, reliability **Low**, reason "no stations set up".
- Week with no scouting → that greenhouse is omitted from the week's figures (not shown as 0%).
- Unknown bed/zone numbers (unparsable) → station placed by name order; never dropped.

## Testing

- Pure (`prevalence.py`, pytest): even 3 × 3 scouting gives Good with a narrow margin; all scouting in one corner section gives `m = 1`, "too clustered to judge", Low; one hot section among clean ones moves `prevalence` by ≈1/m of its rate while `raw` moves by its station share; sections under 3 scouted stations are "not scouted"; grid mapping for uneven beds (1, 2, 13 zones) and for <3 beds; the user's 800/400/200 example gives raw 50%.
- DB (direct runner, 2031-dated raw-SQL fixture, rolled back): Overview/Pests/Trends/GH detail return the new fields for Rose and Avocado; latest-vs-previous week selection; crop scoping from piece 1 still holds; the five `test_dashboard_aggregates_*` suites stay green (updated where they asserted the old all-zones denominator).
- Frontend (vitest): the figure line and reliability pill render; "too clustered to judge" path; 3 × 3 grid greys unscouted cells; no recharts series with animation active inside dashboard tabs.
