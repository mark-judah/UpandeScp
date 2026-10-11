# Quality aggregate: cached per-date partials

Date: 2026-10-11 · Scope: `dashboard_aggregates/_quality.py` (Personnel ▸ Scouts, Coverage report)

## Problem

`quality()` re-scanned every entry of the range on each cold call. Rose, 4 complete
weeks (2026-09-07..10-04, 511k entries) on kaitet.local: ~11–16 s, of which ~7.7 s is
MariaDB shipping rows and ~4.6 s is `Fold.add_day`. The payload cache is keyed on the
exact range + farm and orphaned by every dashboard version bump (at most every 20 min
during scouting), so first visits were nearly always cold.

## Design

**Unit: one capture date, not one ISO week.** Every figure the fold makes is per row
or per scout-day (gaps, moves, duplicates, beds, active hours are all within a
scout-day), so one date's `Fold` is a self-contained building block. A per-date unit:

- needs no special case for a range that cuts a week — a range is just its dates;
- matches the write pattern — mobile writes land on today, so a write drops one date
  (~0.4 s to re-read for Rose, all farms), not a week (~3 s);
- keeps each Redis value small (≤ ~100 KB zlib-pickled for Rose all farms).

Week grouping is still needed for station coverage, and it is applied at assembly
(below), so nothing is lost by storing dates.

**Partial** = `(Fold over that date's rows, {house: [stations, first-seen order]})`,
built with the same SQL as before (one query per date).

**Assembly** (`_build`): for the range's dates newest first, `Fold.merge(partial)` and
note the date's stations into each house's latest complete / partial week
(`_note_stations`, same rule as before). Coverage, rows, KPIs and flags are then
computed exactly as before.

**Exactness.** `Fold.merge` is sums, set unions, histogram merges (distance at 0.1 m,
sync delay per minute — the same histograms the scan built, so median / p90 are the
same nearest-rank values) and a max. Merging newest first reproduces the scan's dict
insertion order, which the float sums in `scout_rows` (leave-one-out baseline) and
`kpis` follow, and its float `hours` addition order. Result: byte-identical payloads,
not merely close ones.

**Key** `scp:dash_agg:qpart:qp1:<scope sig>:<date>:<gen>`

- *scope sig* = hash of the query's WHERE + params minus the dates: crop, the crop's
  houses / pests / diseases (D4, D5), the greenhouse scope. A house moved between
  farms, or a pest linked to a crop, gives a new signature — a partial is never
  served for a query it was not read with.
- *gen* = per-date generation stamp `scp:dash_agg:qgen:<date>`, a fresh unique value
  (not a counter, so an evicted / flushed stamp can never re-match an old partial).
- TTL: 1 h for dates within 7 days of today, 24 h for older ones. Writes drop
  partials at once; the TTL only bounds out-of-band writes (raw SQL loads).

`K_DASH_AGG_SCHEMA` is unchanged (`psn1`): the payload's shape and values are identical.

## Invalidation

`cache_utils.invalidate_quality_days(*dates)` replaces the dates' stamps — at once and
again after commit (so a partial read between the write and its commit, which cannot
see the row, is not kept). Called from:

- `invalidate_on_change` for the Scouting Entry family (entry, pest / disease / trap
  rows) — the existing per-ISO-week hook path; for a Scouting Entry also the date it
  had before the save, so an edit that moves the date drops both;
- a new `Scouting Entry Metadata` doc event (on_update / on_trash): the fix-to-zone
  distance lives there and the mobile sync inserts it after the entry.

## Warming

`prewarm.prewarm_quality`, run from the existing `*/10` `prewarm_dashboard_aggregates`
job (no new Scheduled Job Type): for each named crop, at "all farms" and at each of
its farms, build any missing partial of the last `MAX_RANGE_DAYS` (56) days, a week
at a time under a 180 s budget; then assemble the Scouts page's default range per
crop so that payload is warm too. A warm run is two Redis round trips per scope
(~0.2 s total). After a flush the request path builds missing dates itself and the
next run (≤ 10 min) refills the rest.

## SQL aggregation (considered, not used)

The module's own measurement (2026-10-10): a LAG()/GROUP BY form costs 12.2 + 9.8 +
4.5 + 1.6 s — each grouping is its own pass over half a million rows, slower than the
single row pass (6.8 s) it would replace. With partials the row pass runs once per
date per scope and is then cached, so it is no longer on the request path.

## Measured (kaitet.local, Rose)

| case | before | cold partials | 7 newest dates cold | warm partials |
|---|---|---|---|---|
| 4 weeks, all farms (511k) | 11.2 s | 11.5 s | 3.4 s | 0.36 s |
| 4 weeks, Karen | 1.5 s | 1.4 s | 0.55 s | 0.22 s |
| 09-10..10-01 (cut weeks), all farms | 9.5 s | 9.8 s | 3.3 s | 0.33 s |
| 8 weeks, all farms | — | — | — | 0.65 s |

`get_scouts` end to end: 11.7 s cold → 0.37 s with warm partials → 0.01 s warm payload.
Warmer: ~40 s first fill (Rose + other crops, 10 scopes), 0.2 s per warm run.
Redis: ≤ ~100 KB per date per scope; ~10–15 MB for 8 weeks of every Rose scope.
