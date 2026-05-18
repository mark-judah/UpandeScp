# Dashboard Server-Side Aggregation

## Status

Design — pending review.

## Context

The React `/scp_app` Dashboard at `frontend/src/pages/Dashboard.tsx` is the
landing page for scouting operators. Today it ships **every Scouting Entry row
in the visible date range** to the browser, persists them in IndexedDB, then
computes KPIs / charts / breakdowns in JavaScript.

That architecture was designed against a small dataset (single-digit thousands
of entries per month). The Kaitet deployment now produces around **20,000
Scouting Entry rows per day** — about **600,000 rows in the default 30-day
window**. At that scale the dashboard takes around 10 minutes to load. The
bottleneck is not server compute; it is the round-trip:

| Stage | Estimated cost at 600k rows |
|---|---|
| MariaDB join (parent × pests × diseases × traps) | 2–4 s |
| Redis fetch (warm L1) | 0.5–1 s |
| JSON over the wire (~30 MB gzipped) | 5–15 s |
| Browser `JSON.parse` | 3–5 s |
| IndexedDB upsert of 600k records | 15–40 s |
| Client-side aggregation pass | 2–5 s |
| **Total floor** | **~30 s, realistically minutes** |

No amount of additional caching on the raw-rows path can hit the 5-second
target, because the network and browser-side costs scale with row count.

The legacy server-rendered pages at `/scouting_dashboard` and
`/scouting_trends` remain fast at this scale because they aggregate in SQL/
Python and ship summary numbers, not rows.

This spec covers the **Dashboard** screens only. Trends, Heatmaps, and the
other aggregation-heavy pages get their own subsequent specs that share the
infrastructure we build here. Observations and TrapsMap genuinely need
individual rows on screen and continue to use the existing
`useScouting` + IndexedDB path (out of scope here).

## Goal

Dashboard renders **all five tabs in under 5 seconds** at 500k+ rows in range,
with parity in displayed numbers, and a filter-change response under 300 ms on
a warm cache.

## Non-Goals

- Trends, Heatmaps, Historical, and the smaller aggregation pages. Separate
  specs.
- Observations, TrapsMap. They keep raw-row IDB access.
- Removing `useScouting`, `scouting-sync.ts`, `idb.ts`. They remain in service
  to the pages above.
- Pre-aggregated materialized tables in MariaDB. Out of scope unless
  Phase-1 cold-aggregate-compute profiling shows it is needed.

## Architecture

```
                          MariaDB (Scouting Entry + 3 child tables)
                                         ▲
                                         │ one GROUP BY query per endpoint,
                                         │ on indexed columns
                                         │ (date_of_capture, greenhouse,
                                         │  crop_scouted, modified)
                                         │
                            dashboard_aggregates/  (Python module)
                            ├ overview(from, to, filters)
                            ├ pests(from, to, filters)
                            ├ diseases(from, to, filters)
                            ├ traps(from, to, filters)
                            ├ fcm(from, to, filters)
                            └ greenhouse_detail(gh, from, to, crop)
                            returns dict, 5–50 KB
                                         ▲
                                         │ cached output (TTL 120 s)
                                         │
                          Redis: scp:dash_agg:v{N}:{endpoint}:{filter_hash}
                          N = K_SCOUTING_PAYLOAD_VERSION (reused),
                          bumped by existing doc-event invalidator
                                         ▲
                                         │ /api/method/... HTTP, gzipped
                                         │
                          React Dashboard
                          - No IndexedDB on this page
                          - useDashboardAggregate(endpoint, filters, enabled)
                          - Only the active tab fetches
                          - Filter change → new HTTP call
                          - scp:scouting:dirty realtime → refetch active tab
```

## API Contract

All five tab endpoints share the same request shape. `crop`, `farm`, and
`greenhouse` are optional. Empty string and absent are equivalent.

```python
{
    "from_date": "2026-04-18",
    "to_date":   "2026-05-18",
    "crop":      "Rose",
    "farm":      "Karen Farm",
    "greenhouse": "GH 12",
}
```

Filter resolution (mirrors `Dashboard.tsx` `greenhouseScope`):

- `greenhouse` set → scope is `[greenhouse]`.
- `greenhouse` empty + `farm` set → scope is the farm's greenhouses (via the
  existing `scouting_metrics.get_farms_and_warehouses()` map).
- Both empty → no greenhouse filter.

`crop` is applied directly on the parent row's `crop_scouted` column.

### Endpoint: `overview`

```
upande_scp.serverscripts.dashboard_aggregates.overview
  → {
       kpis: {
         totalScouts:        int,
         zonesScouted:       int,
         greenhouseCount:    int,
         highAlerts:         int,
       },
       daily: [{ date, pests, diseases, traps }],
       rangeTotals: { pests, diseases, traps },
       ghHealth: [{ name, pests, diseases, traps, scoutCount, alerts, status }],
       topScouts: [{ scoutId, entries }],
       scoutsPerDay: [{ date, scouts }],
       scoutPerformance: [{ scoutId, zones, pests, diseases }],
       recentActivity: [{ name, date, time, greenhouse, zone, scoutId, kind }],
       activeAlerts: [{ name, kind, severity, count, greenhouse, zone, date }],
    }
```

Display rules — `status` is `critical` if alerts > 2, `warning` if > 0, else
`good`. `severity` follows the existing client rule (pest: count > 15 high,
> 5 moderate, else null; disease: keyword match on `severity_level`/`stage`).
These rules move from `aggregate.ts` into Python verbatim.

**Scout display-name resolution stays client-side.** Endpoints ship the
raw `scoutId` (the `scouts_name` / fallback chain that lands in
`ScoutingEntry.scouts_name` today). The Dashboard already fetches the
Employee lookup once per session via `fetchScoutLookup()`; tabs use that
map to render the display name. The new endpoints do **not** join
against Employee, keeping the GROUP-BY queries lean.

### Endpoint: `pests`

```
upande_scp.serverscripts.dashboard_aggregates.pests
  → {
       filterOptions: { pests: [str], sections: [str], stages: [str] },
       ranking:       [{ name, total, high, moderate, low }],
       distribution:  [{ name, pct, zones }],
       sectionSplit:  [{ name, pct, zones }],
       greenhousePressure: [{ name, pct, zones }],
       dailyPercent:  [{ date, value }],
       trendSeries:   { rows: [{ date, <pest1>: n, <pest2>: n, ... }], keys: [str] },
    }
```

Request additionally accepts the tab-local filter triple
`{ observation, section, stage }` (each `""` = all) that the existing
`PestsTab` keeps in component state. These compose with the page-level
filters; output reflects both. (Same idea for `diseases`.)

### Endpoint: `diseases`

Identical request and response shapes as `pests`, with disease-specific
fields (`disease` instead of `pest`). One Python implementation shared
between the two via a `kind` parameter.

### Endpoint: `traps`

```
upande_scp.serverscripts.dashboard_aggregates.traps
  → {
       ranking:        [{ key, trap, pest, total, avg }],
       pestBreakdown:  [{ name, value }],
       trendSeries:    { rows: [], keys: [] },
    }
```

### Endpoint: `fcm`

Shape verified against `frontend/src/pages/dashboard/FcmTab.tsx` during
implementation. The tab is small (~195 lines); the response will be a
direct port of what it consumes.

### Endpoint: `greenhouse_detail`

Drives the `GreenhouseModal` drill-down.

```
upande_scp.serverscripts.dashboard_aggregates.greenhouse_detail
    (greenhouse, from_date, to_date, crop?)
  → {
       topPests: [{ name, count }],
       topDiseases: [{ name, count }],
       traps: [{ pest, total }],
       daily: [{ date, pests, diseases, traps }],
       scouts: int,
       alerts: int,
    }
```

### Bootstrap (already exists)

The page mount calls the existing endpoints to populate filter dropdowns:
`fetchCrops`, `fetchFarmsAndWarehouses`, `fetchScoutLookup`,
`fetchZonesByGreenhouse`. No change.

## Caching

**Key**

```
scp:dash_agg:v{N}:{endpoint}:{filter_hash}
```

- `N` = `cache_utils.scouting_payload_version()` — the existing global
  version stamp. Bumped by `invalidate_on_change` on every
  Scouting Entry / Pests/Diseases/Trap Scouting Entry / Zone / Bed / Warehouse /
  Farm change. Reusing it means writes invalidate both the L1 raw cache and
  the new aggregate cache in one step.
- `endpoint` ∈ {`overview`, `pests`, `diseases`, `traps`, `fcm`,
  `greenhouse_detail`}.
- `filter_hash` = first 20 hex chars of the SHA-1 of the JSON of normalized
  `{from_date, to_date, crop, farm, greenhouse, observation, section, stage}`
  with keys sorted. 80 bits is more than enough to keep distinct filter
  combos collision-free at the scale of an operator session.

**TTL**: 120 seconds. Caps staleness when realtime push misses; on the
high-write farm the version-bump invalidates faster than the TTL most of
the time.

**Invalidation**: piggy-backs on the existing hooks in `hooks.py`:

- `cache_utils.invalidate_on_change` (already wired) → version-bump.
- `cache_utils.publish_scouting_dirty` (already wired) → realtime
  `scp:scouting:dirty` event.

The frontend hook subscribes to that realtime event and refetches the
**currently visible** tab's aggregate only. Backgrounded tabs revalidate
the next time they become active (cache will already be warm because of
the realtime invalidation + adjacent operators triggering the cold
compute first).

**Out of scope (deferred)**: per-day or per-greenhouse granular
invalidation; scheduler-driven pre-warming. Either can be added without
changing the API contract if profiling demands it.

**Reload button behavior**: each endpoint accepts an optional `force` flag
(`force=1`). When set, the endpoint computes fresh, overwrites the cache,
and returns the new payload. The Dashboard's `Reload` button is rewired to
call the active tab's `reload({ force: true })`. Realtime-driven refetches
omit `force` since the version-bump on the write already invalidates the
cache.

## Frontend Refactor

**New hook** — `frontend/src/hooks/use-dashboard-aggregate.ts`:

```ts
type Endpoint = "overview" | "pests" | "diseases" | "traps" | "fcm";

interface AggregateFilters {
  from: string;
  to: string;
  crop?: string;
  farm?: string;
  greenhouse?: string;
  // Tab-local filters; tabs that don't use them omit the field.
  observation?: string;
  section?: string;
  stage?: string;
}

function useDashboardAggregate<T>(
  endpoint: Endpoint,
  filters: AggregateFilters,
  enabled: boolean,
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};
```

- Fires one HTTP call when `(endpoint, filters)` change and `enabled` is true.
- `enabled` lets each tab gate its fetch; only the active tab pulls data on
  filter change.
- Subscribes via `useRealtime("scp:scouting:dirty", …)` and refetches itself.
- Holds the previous payload while a new fetch is in flight so the screen
  does not blank between filters (stale-while-revalidate).

**`Dashboard.tsx`**:

- Removes the `useScouting` import and its use.
- Tracks the active tab as a controlled value of `<Tabs>` (currently
  defaults to `overview`, lifts state up so the hooks know which tab is
  active).
- Passes the new payload shape to each tab.

**Tab files** (`OverviewTab.tsx`, `PestsTab.tsx`, `DiseasesTab.tsx`,
`TrapsTab.tsx`, `FcmTab.tsx`):

- Stop calling the local aggregators (`computeOverviewKpis`, `dailySeries`,
  `pestDailyPercent`, etc.). Read the values straight from the new payload.
- Recharts components and visual layout unchanged.
- `PestsTab` and `DiseasesTab` keep their three component-state filters
  (observation / section / stage); they flow into the new hook's
  `AggregateFilters`.

**Files untouched in this spec**:
`scouting-api.ts`, `scouting-sync.ts`, `idb.ts`, `use-scouting.ts`,
`use-realtime.ts` (consumed as-is), `LoadingOverlay.tsx` (used by other
pages). The dashboard chunk drops the `<LoadingOverlay open={loading} … />`
because hydrate-by-week progress no longer exists for this page.

## Server Files

```
upande_scp/serverscripts/dashboard_aggregates/
  __init__.py         # public whitelisted functions; routes to private modules
  _common.py          # filter resolution, SQL helpers, cache wrappers
  _overview.py        # overview() impl
  _pests_diseases.py  # pests() + diseases() shared impl
  _traps.py           # traps() impl
  _fcm.py             # fcm() impl
  _gh_detail.py       # greenhouse_detail() impl
```

Each file aims to stay under ~300 lines. The whitelisted entry points sit in
`__init__.py` so the call-path matches the spec
(`upande_scp.serverscripts.dashboard_aggregates.overview`).

Tests live at `upande_scp/serverscripts/tests/test_dashboard_aggregates.py`.

## Parity Guarantee

Every number the Dashboard renders today must match the new implementation
on a fixed dataset, within stated rounding.

Approach:

1. Capture a snapshot of `ProcessedData` produced by the current
   `buildScoutingData` on a small representative fixture (say, 200 entries
   covering 3 greenhouses × 2 crops × 14 days × pests / diseases / traps /
   FCM).
2. Run the JS aggregators on the snapshot and dump their outputs to JSON
   golden files.
3. Build the new Python aggregators against the same fixture (inserted via
   test setUp) and assert equality against the goldens.
4. For known float-precision differences (percentages rounded to one
   decimal), pin both sides to the same rounding rule (`round(x * 10) / 10`).

Output deltas found during this phase become spec amendments — there is no
"server is right, client was wrong" without explicit acknowledgement.

## Migration Plan

**Phase 1 — Server foundation**

1. `dashboard_aggregates/_common.py`: filter resolution, SQL helpers, Redis
   wrappers, severity classifier ports.
2. `_overview.py` + tests. Establish the parity test harness.
3. `_pests_diseases.py` + tests.
4. `_traps.py` + tests.
5. `_fcm.py` + tests (after reading `FcmTab.tsx`).
6. `_gh_detail.py` + tests.
7. `dashboard_aggregates/__init__.py` whitelisted entry points.

**Phase 2 — Frontend**

8. `use-dashboard-aggregate.ts` with `useRealtime` integration.
9. Refactor tabs one at a time, in this order: Overview → Pests → Diseases →
   Traps → FCM. Each PR has its tab visually diffed against the live
   `/scp_app` on staging before merging.
10. Refactor `Dashboard.tsx`: drop `useScouting`, lift active-tab state,
    rewire `Reload` to call the active hook's `reload()`.

**Phase 3 — Cleanup**

11. Trim `frontend/src/pages/dashboard/aggregate.ts`: keep functions still
    used by `GreenhouseModal` (until it migrates), remove the rest.
12. Remove the `<LoadingOverlay>` and the `progress` / `weeksLoaded` /
    `weeksTotal` plumbing from `Dashboard.tsx`. (`LoadingOverlay.tsx` itself
    stays — used by Heatmaps, Observations, etc.)

## Acceptance

- Cold cache, 500k entries, default 30-day range — Dashboard initial paint
  **< 5 s wall-clock** in Chrome on a typical office connection.
- Filter change (warm cache) — **< 300 ms**.
- Tab switch (warm cache) — **< 100 ms** (renders cached payload).
- All five tabs' numeric output matches the current implementation on the
  fixture dataset within rounding tolerance.
- No regression on `/scp_app` Observations, TrapsMap, Trends, Heatmaps,
  Reports, or any other page on the React shell.

## Risks & Trade-offs

- **Filter change is no longer instant.** Mitigation: SHA-1 cache keys
  mean repeat combos snap back. A spinner overlay is shown only while a
  fetch is in flight; the previous payload stays on screen until the new
  one arrives.
- **Parity drift in port.** Six aggregation pipelines are re-implemented
  in Python; some will drift in edge cases (timezones, empty-string
  handling, scout-name fallback chain). The fixture-based golden tests
  exist to catch this.
- **Stale window of up to 120 s** if both the realtime push and any other
  intervening write miss. Acceptable for an operational dashboard.
- **Mobile-sync `__last_sync_on` problem (the previous bug)** — solved
  for free. The aggregator queries SQL directly; the `modified >
  watermark` mismatch from the IDB delta path does not exist here.
- **Redis memory.** Each cached payload 5–50 KB × low-hundreds of distinct
  filter combos per active period ≈ single-digit MB. Negligible next to
  the existing per-week raw payloads.
- **Bundle size**. The dashboard chunk shrinks once unused aggregators are
  trimmed in Phase 3.

## Out of Scope (Future Work)

- Trends migration (next spec).
- Heatmaps migration (next-next spec).
- Historical + small-page KPI strips + IDB code path retirement (final
  spec in the series).
- Materialized daily-summary table — only if cold-aggregate compute
  becomes the bottleneck.
- Per-`(date, greenhouse)` granular invalidation — only if the global
  version-bump churns the cache too aggressively.
