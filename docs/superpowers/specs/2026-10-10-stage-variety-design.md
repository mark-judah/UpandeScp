# Stage and variety weighting — design

Date: 2026-10-10. Piece 4 of the scouting programme (… 3a thresholds ✅ → 3b hot spots → 3c spread & pins → **4 stage & variety**). Builds on piece 2 (`common/prevalence.py`, `_prevalence_rows.StationWeeks`) and 3a (`threshold_bands`, measures, Scouting Alert).

## Goal

Prevalence should mean "the live pest is there", weighted by the life stages scouts find, with signs of the pest (damage, webs, ragged margins) reported separately rather than counted as the pest. And agronomists should see how a pest differs between rose varieties.

## Decisions

The user asked for autonomous build; each decision is the recommended option, recorded as a ruling.

| # | Decision |
|---|---|
| S1 | Stage master gains **`stage_role`** (Select: `Life stage`, `Form`, `Sign`; default `Life stage`) and **`weight`** (Float, default 1.0). |
| S2 | Seeded roles (patch, fill-blanks only): **Sign** = Damage, Damages, FCM Damage, Web, Ragged Margins; **Form** = Motiles, Singles, Colonies, Scales, Scale Insects, Adult Cloud, Adult Singles; everything else **Life stage**. Weights all **1.0** — the agronomist sets real weights; nothing is invented. |
| S3 | **Live-pest prevalence** (the figure 2/3a/3b use for pests): a station is infested only by **Life stage** or **Form** rows; **Sign** rows no longer make a station infested. A stage-specific figure on a Sign stage still works (it measures the sign). |
| S4 | **Signs** become their own figure per pest: `signs` = share of scouted stations with a sign (same sections/margin machinery), shown beside the live figure ("Thrips 12% · signs 30%"). |
| S5 | **Count measure** sums `weight × count` over the pest's Count-reading Life-stage/Form stages (weights 1.0 → today's behaviour). |
| S6 | Pests Stages rows may override the master weight per crop (`weight`, blank = master). |
| S7 | **Variety** (rose): derived at query time via `Scouting Entry.bed → Bed.variety`. Greenhouse detail and the Pests tab get a **"By variety"** table for the selected pest: variety, beds, stations scouted, live prevalence, signs. Varieties with < 10 scouted stations shown greyed ("too few"). Avocado/coffee: no variety recorded → the table is hidden. |
| S8 | No per-variety thresholds in this piece (the existing per-variety Item table has 11 rows; left untouched). |

## Design

1. **Schema**: Stage `stage_role`, `weight`; Pests Stages `weight` (blank = inherit). Seed patch (fill blanks only), applied via the DB runner (no migrate, no restart).
2. **Catalog**: `crop_catalog` (or a small `stage_roles.py`) exposes `stage_role(stage)`, `stage_weight(crop, pest, stage)` from the master + override, cached with the existing catalog invalidation (Stage / Pest Filter changes bust it).
3. **StationWeeks**: when collecting pest rows, tag each row with its role; `infested_set` for the all-stage figure uses Life stage + Form rows only (S3); a new `signs_set` uses Sign rows; `station_counts` multiplies by weight (S5). Stage-filtered figures unchanged in meaning.
4. **Figures**: `prevalence.figures` unchanged; callers pass the live set or the signs set. Payloads gain `signs` (public figure keys) beside the pest figure on Overview cells, Pests ranking/pressure, GH detail, Trends per-station rows. Cache schema tag bumped.
5. **Variety**: `_prevalence_rows` (or a new `variety_breakdown(crop, house|scope, week, pest)`) groups scouted/infested stations by bed variety for the latest week. Endpoint used by GH modal and Pests tab.
6. **Thresholds/alerts**: 3a/3b judge the live figure (S3); signs are informational (no alerts).
7. **Frontend**: Settings → Thresholds shows each stage's role + weight (editable by GM; role read from master, weight override per row); figure lines add "· signs N%"; "By variety" table component.

## Out of scope

Per-variety thresholds; avocado variety capture; weighting diseases (disease stages are severity, not life stages).

## Testing

- Pure: role tagging; weighted counts; signs figure.
- DB (fixture, rolled back): a station with only Damages is no longer infested for the live figure but is in signs; weights 1.0 reproduce today's counts; a weight of 0.5 on Eggs halves egg contribution; variety breakdown groups stations by bed variety and greys < 10; patch seeds roles fill-blanks-only and leaves edited rows alone; piece 2/3a regression suites updated where a Sign stage changed a figure (with the reason).
- Frontend: Thresholds role/weight display + edit; "signs" in the figure line; By-variety table (greyed small varieties; hidden without variety).
