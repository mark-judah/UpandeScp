# Data quality & scouting KPIs — design

Date: 2026-10-10. Roadmap item 7. Answers "can we trust the scouting data, and which scouts / houses need attention?" Built lean (one build + one review), per the user's request.

## Verified facts (kaitet.local, 2026-10-10)

- No coverage / scout-performance / GPS-quality page exists. The daily scouting email only counts entries per user.
- Scouting Entry: `scouts_name`, `greenhouse`/`block`, `bed`/`row`, `zone`/`tree`, `date_of_capture`, `time_of_capture`, `latitude`/`longitude`, `crop_scouted`, `creation`. No accuracy field.
- Scouting Entry Metadata (1:1 via `scouting_entry`): `gps_accuracy`, `gps_quality`, `distance` (fix → matched zone line, m), `zone_buffer`, `calculated_zone`, `stationary`, `app`, `client_id`. Reported accuracy median 1.39 m, yet `distance` > buffer on 114k of 170k rows and > 100 m on 5.3k — the map, not the phone, is often the problem.
- kaitet.local's last-12-weeks entries were pulled from live without their Metadata rows (only 6 of 1.0M recent entries have metadata); bulk-loaded rows also make `creation − capture` meaningless before 2026-09-02.
- Matching never rejects a fix (`geo_utils.get_zone_from_coordinates` returns the nearest line).

## Decisions (autonomous; recommended option each)

| # | Decision |
|---|---|
| Q1 | A **Data quality** tab on the crop dashboard (beside Traps/FCM), date range + farm/house scope like the other tabs; server aggregate `dashboard_aggregates/_quality.py` via `cached_aggregate`. |
| Q2 | **Per house** (greenhouse/block) rows: stations scouted ÷ stations (latest week in range, from piece 2's StationWeeks), sections scouted /9, entries, scouts, GPS off-zone share, median and p90 fix-to-zone distance, metadata coverage %. |
| Q3 | **Per scout** rows: entries, active days, entries per active hour (first→last capture per day), beds per day, "too fast" share (consecutive entries by the same scout < 5 s apart), nothing-found share (entries with no observation rows) vs the scope average, off-zone share, duplicates (same scout, same zone/tree, same date, > 1 entry), median sync delay (only entries created ≥ 2026-09-02). |
| Q4 | **Flags** ("Needs attention", ranked): house **map offset suspect** when its median fix-to-zone distance > 20 m with ≥ 50 metadata fixes; house **thin coverage** when < 30% of stations scouted in its latest week; scout **too fast** when > 20% of entries are < 5 s apart; scout **nothing-found outlier** when their nothing-found share exceeds the scope average by ≥ 25 points with ≥ 100 entries; scout **off-zone** when > 30% of fixes are outside the buffer; **duplicates** when > 2% of a scout's entries are duplicates; **metadata gap** when < 50% of a house's entries carry metadata (data incomplete — GPS figures shown greyed). |
| Q5 | Thresholds are constants in one module (`common/quality_rules.py`), not settings, for this piece. |
| Q6 | No notifications or emails (email work is last on the roadmap). |
| Q7 | Avocado uses trees/rows; coffee shows whatever stations exist. |
| Q8 | To make the GPS figures real on kaitet.local, pull the last 8 weeks of Scouting Entry Metadata from live read-only (same paced System Console method as the scouting pull), INSERT IGNORE by name. |

### Clarifications from build (2026-10-10)

The first real-data run (Rose, 4 weeks, 519k entries) flagged every scout, because scouts log one entry per observation, seconds apart, on the same zone. Controller rulings that amend Q3/Q4:

| # | Clarification |
|---|---|
| C1 | **Duplicate** = same scout + same zone/tree + same date + same `time_of_capture` to the second (a true double-submit). Same scout/zone/date at different seconds is normal. The > 2% flag stays, on this definition. |
| C2 | **Too fast** measures only moves *between* stations: consecutive entries by the same scout on the same day, on a different zone/tree, < 5 s apart, as a share of that scout's zone-to-zone moves. Same-zone multi-observation entries are not moves. The > 20% flag stays, on that share. |
| C3 | **Off-zone (scout)** fires only when the scout's off-zone share exceeds the off-zone share of the houses they scouted (weighted by the scout's fixes in each) by ≥ 25 points, with ≥ 50 fixes. The map problem stays the house-level **map offset suspect** flag. When the scope's off-zone share > 30%, the off-zone KPI reads "zone map needs checking". |
| C4 | **Thin coverage** uses each house's latest *complete* ISO week in range (a week whose Sunday is before today); the current, unfinished week is used only when nothing else is in range, and is then marked "partial week". |
| C5 | **Sync delay** stays an informational column (no flag); the UI says it is entry creation minus capture time. |

## Design

1. `common/quality_rules.py` (pure): constants; `too_fast_share(times)`, `active_hours(times)`, `flag_rows(houses, scouts)` → ranked flags.
2. `dashboard_aggregates/_quality.py`: three scoped SQL scans through `parent_filter_conditions` (entries; LEFT JOIN Metadata; observation-row existence via EXISTS on the pest/disease child tables), plus piece 2's `StationWeeks` for coverage/sections. Cached; progress events like `_traps`.
3. Whitelisted `quality(...)` in `dashboard_aggregates/__init__.py`.
4. Frontend: `Dashboard.tsx` tab "Data quality" → `DataQualityTab.tsx`: KPI tiles (coverage, off-zone %, too-fast %, metadata coverage), "Needs attention" list (pill per flag kind, never a left-border strip), sortable house and scout tables; GPS columns greyed with a note when metadata coverage < 50%.

## Out of scope

Notifications/emails; per-farm configurable thresholds; correcting the zone map (the flag points at it); the email fix.

## Testing

Pure: too-fast share, active hours, each flag's boundary. DB (2031 fixture, rolled back): per-house and per-scout figures for a crafted week with metadata rows; flags fire at their boundaries; crop scoping holds. Frontend (vitest): tab renders tiles, flags, tables; greyed GPS columns when metadata is thin; no left-border strips.
