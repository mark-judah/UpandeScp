# Future Work: Server-Side Aggregation Endpoints

## Why

The current data path ships **raw scouting entries** from the server to the
browser and aggregates on the client. With weekly chunked loading we can
parallelise the fetch, but at site-scale (millions of entries) the
underlying SQL build per chunk is still the dominant cost — the dashboard
and trends pages render charts of ~30 points each, yet the wire payload
to feed them is tens of thousands of rows. That ratio is the bottleneck
we need to break next.

## What to build

Two thin endpoints that return **pre-aggregated** data instead of raw
entries.

### 1. `get_trend_series`

```
upande_scp.serverscripts.aggregations.get_trend_series(
    from_date, to_date,
    farms=None,           # optional list of farms; default = all
    greenhouses=None,     # optional list of greenhouses
    observations=None,    # ["pest:Thrips", "disease:Botrytis", ...]
    stages=None,
)
```

Returns:

```json
{
  "rows": [
    { "date": "2026-04-27", "farm": "Karen", "kind": "pest", "name": "Thrips",
      "stage": "Adult", "zones_with_obs": 23, "total_zones": 412 },
    ...
  ]
}
```

The chart panels consume this directly (% = `zones_with_obs / total_zones`).
Expected payload: hundreds of rows per request, regardless of how many raw
entries underlie the period.

### 2. `get_dashboard_kpis`

```
upande_scp.serverscripts.aggregations.get_dashboard_kpis(
    from_date, to_date,
    farms=None,
    greenhouses=None,
    crop=None,
)
```

Returns the totals + top-N + active-alerts blocks that the Overview tab
currently computes in JS from raw entries: `total_pests`, `total_diseases`,
`total_traps`, `top_pests`, `top_diseases`, `scout_count`, `alerts[]`.

## Implementation outline

- **SQL**: Use `GROUP BY date, greenhouse, pest_name, stage` over the
  `Scouting Entry` × `Pests Scouting Entry` join. Same for disease and
  trap tables.
- **Caching**: Per-week × per-scope Redis keys, mirroring the existing
  `_fetch_month_entries` pattern but with a smaller granularity. Cache
  warmth is a function of how many farm/observation combinations the team
  actively looks at — usually a small number.
- **Realtime invalidation**: The existing `scp:scouting:dirty` channel
  publishes affected months. The aggregation cache subscribes to the same
  channel and invalidates weeks within the month.
- **Backward compatibility**: Keep the raw-entry endpoint
  (`getScoutingEntriesChunk`) for pages that genuinely need per-row data
  (single-day map, traps map, heatmap zone detail). New endpoints serve
  only the aggregated views.

## Client-side changes

- `Trends.tsx` switches from `useScouting` (raw entries + client aggregation)
  to a new `useTrendSeries` hook that calls `get_trend_series`.
- Dashboard tabs (`OverviewTab`, `PestsTab`, `DiseasesTab`, `TrapsTab`,
  `FcmTab`) switch their KPI / trend strip data sources to
  `useDashboardKpis` and the aggregation endpoint.
- IDB cache for raw entries shrinks to "pages that need per-row data".
  The weekly-chunk hydrator stays but is invoked by fewer pages.

## Expected impact

- Wire payload for a 90-day trends view: **~50k rows → ~2-3k rows** (~20×
  smaller). Network transfer and JSON parse cost both drop proportionally.
- First-paint with cold Redis: SQL runs `GROUP BY` on the join, which
  scales with output rows, not input. Order-of-magnitude faster than the
  current "fetch every row, aggregate in browser" path.
- Memory footprint: the browser holds aggregated rows for the visible
  range instead of every entry — IDB cache for those pages becomes
  unnecessary, freeing storage and reducing eviction churn.

## Risks / unknowns

- Stage filtering: requires that the aggregation key includes stage and
  plant_section. Cache key surface area grows; check Redis memory.
- Severity thresholds + active alerts: currently derived from per-entry
  observations. Need to confirm the aggregation surfaces enough signal
  for the alert logic, or keep alerts on the raw path.
- Backfilling old data into the aggregation cache during deploy: warm
  weeks the dashboard team uses most so the first hit isn't cold.

## When to revisit

After the weekly client-chunk + filter-fix changes ship and we have real
numbers on:
1. How long first-paint takes at production row counts.
2. Whether the Redis monthly cache stays warm under the new request shape.
3. Which views the operators actually open (i.e. is the load-everything
   pattern justified, or can we narrow scope per page).
