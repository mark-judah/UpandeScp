# Thresholds and actions — design

Date: 2026-10-10. Piece 3a of the scouting programme (1 crop scoping ✅ → 2 station prevalence ✅ → **3a thresholds & actions** → 3b hot spots → 3c spread & pins → 4 stage/variety). Builds on piece 2 (`common/prevalence.py`, `dashboard_aggregates/_prevalence_rows.py`).

## Goal

Each crop's pests and diseases get thresholds an agronomist can trust, measured the right way for how they are scouted, and crossing them does something: Moderate raises an "Alarming" notification for closer monitoring, High raises a spray advisory (or "Scout first" when the figure is unreliable). Every alert is recorded. SCP's notification bell shows only SCP notifications.

## Decisions (agreed with the user)

| # | Decision |
|---|---|
| D1 | Per pest/disease row (per crop) a **Measure**: **Percentage** (piece 2 adjusted prevalence) or **Count** = average count per scouted station. Count is offered only for pests/stages scouts record as a number (`reading_type = Count`); tick-box pests and all diseases are Percentage. The measure field is built so **Per hectare** can be added later. |
| D2 | Count figure uses piece 2's 3×3 sections: mean of section averages (sections with ≥ 3 scouted stations), with a 95% margin and the same reliability rule. |
| D3 | Bands Low < Moderate < High (strictly ascending, enforced on save); stage bands override the row's bands as today. Low = no action; Moderate = **Alarming**; High = **Spray advised**, or **Scout first** when reliability is Low. |
| D4 | Recipients (option A): Alarming → the farm's Spray Plan Creators + Spray Supervisors; Spray advised / Scout first → those plus the farm's Approvers + SCP General Manager. In-app notifications + **one daily digest email per person at 17:00**; never one email per alert. |
| D5 | One alert per (house, observation, ISO week); a new notification only when the action escalates (Alarming → Spray advised/Scout first; Scout first → Spray advised). |
| D6 | Alerts are persisted (**Scouting Alert**) with status Open / Acknowledged / Resolved / Converted to plan. |
| D7 | Spray plan creator shows "Spray advised" / "Scout first" badges per greenhouse and a **Create curative plan** action that prefills greenhouse + target; saving links the plan to the alert and marks it Converted. The client-side zone-coverage "recommendation" is replaced by the band. |
| D8 | Reports use the same bands and figure; **count per hectare stays as a column** wherever the house has an area (Lokitela). |
| D9 | SCP's bell shows only SCP notifications: list, unread count and mark-all-read are limited to rows carrying an SCP category; new category `scouting`. |

## Verified facts (2026-10-10)

- Pest/Disease Filter carry `unit` (Per Zone % / Per Warehouse / Per Hectare), `low/moderate/high_threshold`, stage children with `reading_type` (Count/Checkbox/Range) and the same bands. Only Rose Thrips has bands (low 1, moderate 0.4, high 2 — misordered). `save_thresholds` has no ordering check and no `measure`.
- Dashboards (`_common.severity_for`) ignore `unit` and compare piece 2 prevalence; `reports/block_weekly_report._band` honours Per Hectare via `Warehouse.custom_area_ha`; `lib/pest-bands.ts` mirrors it; Trends ignores unit.
- `common/notifications.notify(...)` writes Notification Log (+ `scp_category`, realtime). `CATEGORIES = (loan, transfer, procurement, stock)`; the Select options live in `common/custom_fields.py`. `list_notifications`/`unread_count`/`mark_read` filter by user only — HR/ERPNext logs leak into the SCP bell.
- Rosters on Farm: Spray Plan Creators, Approvers, Spray Supervisors (`spray_supervisors`), Store Keepers. Scheduler: hourly + `*/10` prewarm hooks exist; the daily-report cron runs at 17:00.
- Live email is at the free-Gmail cap (~90% fail) — volume must stay minimal (digest only). Fixing email is the last roadmap step.

## Design

### 1. Settings model

- Pest Filter / Disease Filter gain `measure` (Select: `Percentage`, `Count`; default Percentage). The old `unit` field stays in the schema, read by nothing new, hidden in the editor (removing columns is a later cleanup).
- Patch: `measure = Count` where the row is a Pest Filter whose stages are all `reading_type = Count` and old unit was Per Warehouse/Per Hectare; else Percentage. Rows with misordered bands are left as they are but reported by `get_thresholds` (`invalid: true`) so the editor flags them.
- `get_thresholds(crop)` returns per row `measure`, `count_allowed` (any stage `reading_type = Count`; always False for diseases), bands, stages (with `reading_type`), `invalid`.
- `save_thresholds` validates: measure ∈ allowed (Count only if `count_allowed`); every non-zero band set strictly ascending (row and each stage); all-zero = unconfigured (allowed).
- Editor (`ThresholdsTab`): per row a Measure select (Count disabled with a hint when not allowed), band inputs suffixed "%" or "per zone"/"per tree"; misordered rows shown with an inline error; the old unit select removed.

### 2. Count figure — `common/prevalence.py`

`count_figures(grid, scouted, counts)` where `counts = {station: total count}`: per section `j` with `n_j ≥ 3` scouted, `a_j = Σcount_j / n_j`; `m` = such sections; value `= mean(a_j)`; margin `= 1.96·sqrt(s²/m + v/N)` with `s²` the sample variance of `a_j` and `v = max(mean, 1)` (Poisson floor so an all-zero sample never reads ±0); `m < 2` → margin None, "too clustered to judge"; `m = 0` → fall back to the raw `Σcount/scouted`. Same output shape as `figures()` with `value` (count per station, 1 dp) beside `prevalence` (kept for Percentage). Reliability rule identical.

`_prevalence_rows.StationWeeks` additionally collects per-station counts for pest observations (sum of `count` per station per week) and exposes `count_latest(...)` mirroring `latest(...)`.

### 3. Evaluation — `scouting/thresholds_check.py`

- `measure_for(crop, kind, obs, stage)` → (measure, bands) from the filter rows (stage first).
- `evaluate(crop)` → for every house with scouting in its latest week and every banded observation: figure (Percentage or Count per D1/D2), band, action per D3.
- Hourly scheduler job `run_threshold_check()`: for each crop, `evaluate`, then upsert **Scouting Alert** per (house, obs, week); notify per D4/D5 via `notifications.notify(..., category="scouting")`. Self-gated (skips if run < 50 min ago). Never sends email.
- Daily 17:00 job `send_alert_digest()`: one email per recipient listing their farms' open alerts of the day (Alarming, Spray advised, Scout first), only if there is at least one; via the existing report email path.

### 4. Scouting Alert doctype

Fields: crop, farm, warehouse (greenhouse or block), kind (Pest/Disease), observation, stage, iso_week, measure, value, margin, reliability, sections_scouted, sections_total, band (Moderate/High), action (Alarming/Spray advised/Scout first), status (Open/Acknowledged/Resolved/Converted to plan), acknowledged_by/on, work_order (Link Work Order), notified (Small Text: users). Unique (warehouse, kind, observation, stage, iso_week). Permissions: SCP roles read; GM/System Manager write. A newer week for the same house/obs auto-resolves older Open alerts below the band.

### 5. Surfaces

- Overview "Active alerts" reads Open Scouting Alerts (crop-scoped, farm-scoped) with an Acknowledge action (`acknowledge_alert(name)`).
- Spray plan creator: bootstrap/diagnose return per-greenhouse open action; badges "Spray advised" / "Scout first"; "Create curative plan" prefills greenhouse + target and passes `alert` on save; `create_draft_spray_plan` links `Scouting Alert.work_order` and sets Converted. The client `recommendation` string is replaced by the band/action.
- Dashboards/Trends: `severity_for` uses the row's measure — Percentage vs `prevalence`, Count vs count `value`; Trends reference lines labelled in the measure's unit.
- Reports: `block_weekly_report` bands with the same figure/measure; adds a **Count per hectare** column where `custom_area_ha` exists. `lib/pest-bands.ts` follows.

### 6. SCP-only notifications

`CATEGORIES` gains `scouting` (Select options too). `list_notifications`, `unread_count`, and `mark_read(all)` filter `scp_category in CATEGORIES`. Existing SCP callers already pass categories; `spray_plan_creator/maintenance.py`'s direct Notification Log insert is switched to `notify(..., category=…)`.

## Out of scope

Hot spots (3b), spread & pins (3c), per-hectare bands (later, once all areas exist), push notifications to the phone, the email provider fix (last roadmap step), seeding band values (agronomist sets them).

## Error handling

- No bands for an observation → no alert, no badge.
- Figure None (no stations / not scouted that week) → no alert.
- Notification failure is logged and never blocks the check; the alert row is still written.
- Digest skipped when a recipient has no open alerts that day.

## Testing

- Pure: `count_figures` (even sections, clustered m<2, m=0 fallback, all-zero floor, hand-worked margin); band ordering validator; action mapping incl. Scout first; escalation rule.
- DB (2031 fixture, rolled back): migration patch mapping; save_thresholds rejects Count for tick-box pests and misordered bands; `evaluate` yields Alarming/Spray advised/Scout first for crafted weeks; one alert per (house, obs, week), re-notify only on escalation; recipients per D4 from farm rosters; acknowledge; Create-curative-plan conversion; notifications bell excludes non-SCP Notification Log rows; digest builds one email per recipient (sendmail mocked).
- Frontend (vitest): ThresholdsTab measure select (Count disabled when not allowed), unit suffixes, misorder error; Overview alerts + Acknowledge; creator badges + prefill; Trends reference-line unit.
