# Hot-spot notifications — design

Date: 2026-10-10. Piece 3b of the scouting programme (1 crop scoping ✅ → 2 station prevalence ✅ → 3a thresholds & actions ✅ → **3b hot spots** → 3c spread & pins → 4 stage/variety). Builds on piece 2 (`common/prevalence.py` sections) and 3a (`common/threshold_bands.py`, `scouting/thresholds_check.py`, Scouting Alert, digest).

## Goal

Tell the field team when one part of a greenhouse or block is clearly worse than the house as a whole — "this area has high infestation, stay alert" — even when the house overall does not cross a band.

## Decisions

The user asked for autonomous build ("continue … till we are done"); each decision below is the recommended option, recorded as a ruling.

| # | Decision |
|---|---|
| H1 | A **section** is one cell of piece 2's 3×3 grid (rows = bed/row thirds, columns = front/middle/back). |
| H2 | **Hot spot** when the section's band (same row/stage bands and measure as 3a — Percentage vs section `pct`, Count vs section `avg`) is **higher than the house's band** and **at least Moderate**, and the section has **≥ 5 scouted stations** (`HOTSPOT_MIN_N = 5`). |
| H3 | Hot spots are **"stay alert"** only: no spray advisory (spraying stays driven by the house alert). Action label `Hot spot`. |
| H4 | Recipients: the Alarming audience (farm Spray Plan Creators + Spray Supervisors; crop GMs when both rosters are empty). In-app notification (category `scouting`) + the 3a daily digest. |
| H5 | One hot-spot alert per (house, observation, stage, ISO week, section). Notify on first raise and when the section's band escalates (Moderate → High); same rules as 3a otherwise (thin-sample guard, sweep, digest via `raised_at`). |
| H6 | A hot spot resolves when its section no longer meets H2 in a reliable later reading or the week ends (3a's thin-sample rule applies). |
| H7 | Shown on: Overview alerts card (with the section label), the greenhouse modal's 3×3 grid (hot cells ringed), and the digest. The spray plan creator is unchanged. |
| H8 | Cluster context ("the outbreak there grew / moved") is piece 3c; 3b only names the section. |

## Design

### 1. Section figures

`prevalence.figures` / `count_figures` already return per-section `{row, col, scouted, infested, pct}` / `{…, total, avg}`. A pure helper `hotspots(house_fig, sections, bands, measure)` in `common/threshold_bands.py` returns the sections meeting H2 with their band and value. Section labels: `section_label(row, col, crop_unit)` → e.g. "first beds · front" (rose) / "first rows · front" (avocado), from row ∈ {first, middle, last} and col ∈ {front, middle, back}.

### 2. Scouting Alert

New fields: `alert_type` (Select `House` / `Hot spot`, default House), `section_row` (Int, −1 for House), `section_col` (Int, −1), `section_label` (Data). The alert name stays the hashed key; **House keys hash exactly as before** (no rename of existing rows); Hot-spot keys add type + row + col. All key-based SQL (`_KEY_SQL`, `_key_params`, `_previous_live`, `_resolve`, the sweep) includes `alert_type`, `section_row`, `section_col`, so house and hot-spot alerts never resolve or carry each other. Apply via `reload_doc` (no migrate).

### 3. Evaluation

`thresholds_check.evaluate` already holds `fig["sections"]` for each house/observation; for each banded key it now also yields hot-spot findings per H2 (no extra query). `upsert` handles both types; hot-spot `value` = the section figure, `margin` = None (single section), `reliability` from the section's n (Fair if n ≥ 5, Good if n ≥ 10), `sections_scouted` = the section's scouted count. Notification text: "Hot spot in <house>, <section label>: Thrips 45% (house 12%) — high infestation in this area, stay alert."

### 4. Surfaces

- `open_alerts` returns `alert_type`, `section_label`; sorts House before Hot spot at the same action. Overview card shows a "Hot spot" pill + the section label.
- `_gh_detail` marks hot sections in the `sections` payload (`hot: true`); `SectionGrid` rings them (outline/ring, never a left-border strip).
- Digest lists hot spots under their house with the section label.
- `creator_alerts` excludes Hot-spot alerts.

## Out of scope

Clusters, movement, pins (3c); per-section margins beyond reliability-by-n; push notifications; the email provider fix (left alone per the user).

## Testing

- Pure: `hotspots` (higher band + ≥ Moderate + n ≥ 5; equal band no; n = 4 no; misordered bands none; Count measure uses `avg`); `section_label`.
- DB (2031 fixture, rolled back): a house at Low with one section at High → one Hot-spot alert, creators+supervisors notified, approvers not; same next hour → silent; section rises Moderate → High → re-notified; house rises to the section's band → hot spot resolved; House and Hot-spot alerts on the same key never resolve each other; existing House alert names unchanged; digest lists the hot spot with its label (sendmail mocked).
- Frontend (vitest): Overview shows the hot-spot pill + label; SectionGrid rings hot cells; no left-border strips.
