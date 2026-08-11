# Trends: incidence over scouted units, not over every unit that exists

**Date:** 2026-08-10
**Status:** approved, implementing

## Problem

`frontend/src/pages/trends/aggregate.ts:347` plots `num / denom` where `denom`
comes from `denomForSelection` → `payload.unitTotalsByStation`, set in
`_trends.py:64` to the **structural** unit count (every zone / tree / triad that
exists in the selected stations). The numerator can only ever count units a scout
actually visited. So the page plots

```
incidence × coverage
```

Measured on `kaitet.local` for `2026-07-13`:

| Greenhouse | Units exist | Scouted | With pest | Charted | Actual incidence |
| --- | --- | --- | --- | --- | --- |
| Torongo GH 07 - KR | 2,016 | 843 (42%) | 683 | 33.9% | **81.0%** |
| Kaptumbo GH 06 - KR | 1,872 | 737 (39%) | 615 | 32.9% | **83.4%** |
| Kapkolia GH 18 - KR | 1,892 | 766 (40%) | 150 | 7.9% | **19.6%** |

Three consequences:

1. **Understates by 2–2.5×**, and the factor varies per station (coverage ranged
   27–42% that day), so cross-greenhouse comparison is invalid.
2. **The line tracks scouting effort.** Fewer scouts in a week lowers the line and
   reads as improvement. This is the worst failure — reading trends is the point
   of the page.
3. **Clean units are invisible.** `_fetch_observations` INNER JOINs the pest and
   disease child tables, so a unit scouted and found clean produces no row. Of
   297,131 Scouting Entries only 102,335 have pests and 37,412 have diseases —
   the majority of scouting work is unrepresented, and the scouted set cannot be
   recovered from the current query.

## Supporting facts

- `Pests Scouting Entry.count` is populated on **all** 153,771 rows (mean 2.48,
  max 15) — real intensity data. `Diseases Scouting Entry` has no count column,
  only `stage`, so pests and diseases cannot share one formula.
- **Repeat visits are common**: 123,530 zone-days visited once, 44,584 twice,
  11,531 three times, tailing past 8. Distinct-unit treatment is required, and
  intensity must decide sum-vs-mean across revisits.
- **`Scouting Entry.week_number` is unusable** — `0` on all 297,131 rows. Bucket
  with `YEARWEEK(date_of_capture, 3)` (ISO, Monday-start).

## Decisions

| Question | Decision |
| --- | --- |
| Metric | Incidence as the headline %, plus a separate pest-only intensity series |
| Bucket | ISO week (matches the real scouting cycle; near-complete sample per bucket) |
| Low samples | Suppress the point when `n < n_min` (configurable, default 10) |

## The equations

`B` = ISO week bucket, `S` = selected stations, `o` = pest/disease, `g` = optional
stage. A *unit* is the crop's scouting unit, keyed station-prefixed as today.

**Sample size** — distinct units with any entry in the bucket, collapsing repeat
visits. Requires a **child-free** pass over `tabScouting Entry`; this is what makes
clean units countable:

```
Scouted(B,S) = { u : ∃ entry e, unit(e)=u, station(e)∈S, isoweek(e)=B }
n = |Scouted(B,S)|
```

**Affected units:**

```
Affected(B,S,o,g) = { u ∈ Scouted : ∃ matching child row on an entry for u in B }
k = |Affected(B,S,o,g)|
```

**Incidence** (headline percentage):

```
Incidence = 100 × k / n     when n ≥ n_min
          = null (gap)      when n < n_min
```

Every observation row hangs off a Scouting Entry, so `Affected ⊆ Scouted` holds by
construction: `k ≤ n`, and incidence can never exceed 100%. Asserted in tests —
an invariant the current model cannot even express.

**Coverage** (new, separate — what the old chart was half-measuring):

```
Coverage = 100 × n / Σ_{s∈S} |units(s)|
```

`unitTotalsByStation` is therefore **repurposed, not deleted**: it was correct for
this question all along.

**Intensity** (pests only). Per unit, collapse repeat visits by mean:

```
c(u) = mean over entries e for u in B of ( Σ count over rows matching o on e )

Pressure = Σ_{u∈Affected} c(u) / n    "mean pests per zone scouted"  (plotted)
Severity = Σ_{u∈Affected} c(u) / k    "mean pests where present"     (tooltip)
```

They decompose exactly, which is the reason for the pairing:

```
Pressure = (Incidence/100) × Severity
```

Pressure is a **count, not a percentage** — separate panel with its own axis, not
a second line on the incidence chart.

Diseases get incidence only. Stage-weighted disease severity is deliberately out
of scope.

## Server changes — `upande_scp/serverscripts/dashboard_aggregates/_trends.py`

- New `scoutedByStation`: `[weekIdx, stationIdx, n]` from a child-free query.
- Re-bucket `byAny` / `byKindName` / `byKindNameStage` from date → ISO week.
- New `intensityByStation`: `[weekIdx, stationIdx, obsIdx, Σc(u)]` via two-level
  aggregation (per-entry sum → per-unit mean → per-station sum).
- Keep `unitTotalsByStation` for coverage.
- The unit-key expression **must be identical** between the scouted and affected
  queries or `k ≤ n` breaks. Drive both from one shared SQL fragment.

## Client changes

- `denomForSelection` reads `scoutedByStation` for the bucket instead of summing
  structural totals; structural totals feed a coverage readout.
- X-axis becomes ISO weeks.
- Suppress at `n < n_min` (default 10, Settings-configurable). Tooltip shows
  `k / n` and coverage so every point is auditable.

## Risks

1. **Every number on the page jumps upward — measured 3.6× to 47.7×**, not the
   2–2.5× the day-level sample first suggested. Weekly coverage varies far more
   than daily, and thinly-sampled houses distort worst. Real examples from
   `2026-07-06..19`, crop Rose:

   | Station | Week | Observation | Old | New | Factor |
   | --- | --- | --- | --- | --- | --- |
   | Simotwo GH 17 - KR | W29 | pest:Thrips | 1.3% | **62.1%** | **47.7×** |
   | Simotwo GH 20 - KR | W29 | disease:Powdery Mildew | 12.6% | 83.4% | 6.6× |
   | Kaptumbo GH 09 - KR | W28 | pest:Thrips | 9.7% | 73.5% | 7.6× |
   | Torongo GH17 - KR | W29 | pest:Spidermites | 12.1% | 60.8% | 5.0× |

   Simotwo GH 17 had 103 of 4,914 zones scouted (2% coverage): the page read
   "1.3%" while 62% of everything inspected was infested. This is the correction,
   not a regression, but it is dramatic — warn the team before it ships.
2. **Cost.** The scouted-set query touches all entries, not only those with
   observations (297k local, more on live). Same 60s cache; benchmark before
   shipping, since this page has a performance history.

## Out of scope

- Stage-weighted disease severity.
- Wilson confidence intervals (considered, rejected in favour of suppression).
- Backfilling `Scouting Entry.week_number`.
