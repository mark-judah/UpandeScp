# Data Caching Architecture

How scouting data flows from MariaDB → Redis → browser, why each layer
exists, and the rules for keeping the system small under scale.

## Status

All four phases are shipped against the `kaitet` branch.

| Phase | What | Status |
|---|---|---|
| 1a | SQL indexes on Scouting Entry | ✅ migrated |
| 1b | Month-aligned L1 keys + 90-day cap | ✅ shipped |
| 1c | Beds/zones + farms-by-greenhouse exposed to client | ✅ shipped |
| 2 | `get_entries_since` delta endpoint | ✅ shipped |
| 3 | Browser IndexedDB cache + delta sync | ✅ shipped |
| 4 | Frappe realtime "dirty" publisher | ✅ shipped |

The React shell at `/scp_app` (Dashboard + Trends) is the first consumer.
The legacy `/scouting_dashboard` and `/scouting_trends` pages are
unchanged and continue to use the same L1 cache transparently.

## File map

Where each piece of the architecture lives in this repo.

### Server (Python)

| Concern | File |
|---|---|
| L0 indexes (idempotent migration) | `upande_scp/patches/v1_0/add_scouting_indexes.py` |
| L1 month-cache + payload assembly | `upande_scp/serverscripts/get_complete_scouting_entries.py` |
| L2 delta endpoint | same file → `get_entries_since(...)` |
| Cache key registry, invalidation, version stamps | `upande_scp/serverscripts/cache_utils.py` |
| L4 realtime publisher | `upande_scp/serverscripts/cache_utils.py` → `publish_scouting_dirty` |
| Doc events wiring (invalidate + publish) | `upande_scp/hooks.py` |
| Beds/zones builders | `upande_scp/serverscripts/get_beds_and_zones.py` |
| Farm/warehouse + zone-count helpers | `upande_scp/serverscripts/scouting_metrics_api.py` |

### Client (TypeScript)

| Concern | File |
|---|---|
| IndexedDB wrapper (entries + meta stores, indexes, eviction) | `frontend/src/lib/idb.ts` |
| Sync orchestrator (hydrate, delta, invalidate) | `frontend/src/lib/scouting-sync.ts` |
| Frappe API client + reference-data helpers (beds/zones, farms) | `frontend/src/lib/scouting-api.ts` |
| Realtime subscription hook | `frontend/src/hooks/use-realtime.ts` |
| Page-facing data hook | `frontend/src/hooks/use-scouting.ts` |
| Frappe page shell (mount point + bootstrap) | `upande_scp/www/scp_app.py` + `scp_app.html` |

## Why caching at all

Every dashboard, trends panel, and heatmap reads the **same** scouting
entries. The only thing that differs between consumers is the *filter*
(farm / greenhouse / crop / date range / pest / disease). Re-running the
same SQL join (`Scouting Entry` × `Pests Scouting Entry` × `Diseases
Scouting Entry` × `Trap Scouting Entry`) for every page render is
wasteful and pegs MariaDB on full days of scouting traffic.

The fix is to fetch entries once at the source, hold them in a layer
that's cheap to read, and let each page filter in-memory.

## The four layers

```
┌────────────────────────────────────────────────────────────┐
│ L0   MariaDB                                               │
│      Scouting Entry + 3 child tables. Source of truth.     │
│      Indexed on (date_of_capture, greenhouse) + modified.  │
└──────────────────▲─────────────────────────────────────────┘
                   │ read on cache miss only
┌──────────────────┴─────────────────────────────────────────┐
│ L1   Redis (frappe.cache)                                  │
│      Per-month payloads, no greenhouse-suffix dupes.       │
│      Versioned key — bump to invalidate everything.        │
│      Doc-event hooks bump on Scouting Entry create/edit.   │
└──────────────────▲─────────────────────────────────────────┘
                   │ HTTP cache miss → 1 round-trip
┌──────────────────┴─────────────────────────────────────────┐
│ L2   Server delta endpoint                                 │
│      get_entries_since(since_iso) — only modified rows.    │
│      Cheap incremental sync, no full payload re-ship.      │
└──────────────────▲─────────────────────────────────────────┘
                   │ background ticker every 60–120s
┌──────────────────┴─────────────────────────────────────────┐
│ L3   Browser IndexedDB                                     │
│      Per-tab persistent store, shared across pages.        │
│      Same store powers Dashboard, Trends, Heatmaps.        │
└──────────────────▲─────────────────────────────────────────┘
                   │ optional WebSocket nudge
┌──────────────────┴─────────────────────────────────────────┐
│ L4   Frappe realtime (optional)                            │
│      Server publishes "scp:scouting:dirty" {month}.        │
│      Client invalidates that month and re-syncs delta.     │
└────────────────────────────────────────────────────────────┘
```

Each layer is independently useful — you can stop after L1 if your
load is small, or layer on L2/L3/L4 as scale demands.

## Cache keys (the contract)

### L1 — Redis

The payload cache stores **whole calendar months** keyed by:

```
scp:scouting_payload_v1:{version}:{YYYY-MM}
```

- **`{version}`** comes from `K_SCOUTING_PAYLOAD_VERSION`. Any
  Scouting Entry / child / Zone / Bed / Warehouse / Farm change bumps
  this stamp via `cache_utils.invalidate_scouting_payload`. All keys
  prefixed with the previous version orphan and TTL out within an hour
  — no scanning required.
- **`{YYYY-MM}`** is the month of `date_of_capture`. A request for an
  arbitrary range (e.g. last 23 days) loads the months that touch it
  and stitches them client-side. **Greenhouse / farm filters are
  applied in-memory after the cache read.**

Why no `greenhouse` suffix on the key? Because then we'd cache:
- `2026-04:greenhouseA`
- `2026-04:greenhouseB`
- `2026-04:` (all)

That's 3× the storage and 3× the build cost for the same source rows.
Filtering in Python on a hot Redis read is cheap; duplicating data is
not.

### L1 ancillary keys

Already in `cache_utils.py`. Long-TTL because they change rarely:

| Key | What | TTL |
|---|---|---|
| `scp:beds_and_zones_payload_v1` | bed × zone tree (denominators) | 24h |
| `scp:sm_units_by_wh_v1` | per-warehouse zone/tree counts | 24h |
| `scp:sm_zone_counts_by_gh_v1` | zones per greenhouse | 24h |
| `scp:sm_farms_and_whs_v1` | farm → warehouses map | 24h |
| `scp:crops_scouted_v1` | crop list with farm allow-list | 1h |
| `scp:scouting_dashboard:pest_colors` | pest legend colors | 5m |

These are invalidated by their respective doc events (Bed, Zone,
Warehouse, Farm, Crop Scouted, Pest, Plant Disease).

### L3 — IndexedDB

Database: `upande_scp` · Stores:

- **`entries`** — keyed by `name` (Scouting Entry doc name). Indexes on:
  - `month` (string `YYYY-MM`) — for range queries
  - `greenhouse`
  - `block`
  - `modified` (ISO string) — for "what changed since" queries

- **`meta`** — keyed by `key`. Holds:
  - `watermark` — last sync's `server_now` ISO timestamp
  - `loaded_months` — array of `YYYY-MM` strings the client has fetched
    in full (so we know whether to do a full month load or only delta)

The same database is shared between Dashboard, Trends, and Heatmap.
Filtering happens with IDB cursors / index range scans — no payload
duplication per page.

## Memory budget

A rough estimate of what the system actually consumes at scale.

| Layer | Per month | At 90 days | At 1 year | Eviction |
|---|---|---|---|---|
| Redis L1 | ~6 MB | ~18 MB | ~72 MB | TTL 1h + version bump |
| IndexedDB L3 | ~6 MB | ~18 MB | ~72 MB | rolling 90-day window |
| MariaDB L0 | unbounded | — | — | (source of truth) |

Numbers measured against Chepsito (~6 MB for 7 days, ~24 MB for a
month) — multiply by site count for multi-tenant deployments. The
**90-day rolling window** is the hard cap: requests for older data
fall through to the L0 query without writing the result back to L1.

Storage discipline:

- L1 stores the **un-filtered, full-month** payload only.
- L3 stores **flat entry rows** (no per-page projections, no
  pre-aggregated tabs).
- All charts/tabs derive their views in JavaScript from the same flat
  rows. No store ever holds "the dashboard view" or "the trends view"
  separately — that would duplicate data.

## Filters (where each one runs)

| Filter | Where | Why |
|---|---|---|
| Date range | client (IDB index range) | trivial in-memory slice |
| Farm | client | farm → greenhouse map already cached |
| Greenhouse | client | direct equality on entry row |
| Crop | client | direct equality on `crop_scouted` |
| Pest / disease / stage | client | walks child obs arrays |
| User permissions | server (delta endpoint) | scoped at the SQL level |

The server is responsible for **permission scoping** (what the user is
allowed to see) but never for *display* filters. This keeps L1 keyed
by month-only and lets one Redis read serve every consumer.

## Invalidation

The hardest problem in caching is knowing *when to drop*. Strategy:

1. **Doc event bumps the version stamp.** `cache_utils.invalidate_on_change`
   already runs on `on_update` / `on_trash` of Scouting Entry, the
   three child tables, and master data that affects denominators
   (Zone, Bed, Warehouse, Farm, Orchard Tree).
2. **Old keys orphan.** Because keys embed the version stamp, the
   pre-bump payload simply becomes unreachable. Redis cleans them up
   on TTL expiry (1 hour).
3. **L2 delta endpoint advances the client watermark.** Even if L1
   was busted, the client only ships *changed rows* on the next sync
   tick.
4. **L4 realtime push (optional).** If sub-minute freshness matters,
   the server publishes `scp:scouting:dirty` with the affected month.
   Clients listening invalidate that month in IDB and immediately
   re-run a delta call.

## Pre-fetch policy

A common pitfall: "download everything on login." Don't.

- **Never block login.** Bootstrapping the user shouldn't ship 50 MB.
- **Lazy-prefetch after first paint.** Once Dashboard renders from
  IDB (~50 ms), schedule a `requestIdleCallback` to fetch the
  delta-since-watermark in the background.
- **Only prefetch the last 30 days by default.** Older months load on
  demand when the user picks a wider range.

## Endpoints

### Read (whitelisted)

| Method | Purpose | Cache |
|---|---|---|
| `getScoutingEntriesChunk(from_date, to_date, greenhouse?, include_meta?)` | Date-range read; aligns to month internally | L1, 1h |
| `get_entries_since(since_iso, farm?, greenhouse?)` | Delta sync; rows with `modified > since_iso` | none (always fresh) |
| `getBedsAndZones()` | Bed × Zone tree | L1, 24h |
| `scouting_metrics_api.get_farms_and_warehouses` | farm → warehouses map | L1, 24h |
| `scouting_metrics_api.get_crops_with_farms` | crop allow-list per farm | L1, 1h |

### Realtime channels

| Event | Payload | Triggered by |
|---|---|---|
| `scp:scouting:dirty` | `{ months: ["YYYY-MM", ...] }` (empty list = global) | Scouting Entry + 3 child tables, on `after_insert` / `on_update` / `on_trash` (`after_commit`) |

Subscribers: `frontend/src/hooks/use-realtime.ts`. The handler in
`use-scouting.ts` calls `invalidateMonth(month)` for each entry then
re-renders, which triggers a fresh `runDelta()` on the new mount.

## Rollout order

The phases are independent — each one ships separately and delivers
value alone. Status reflects the current `kaitet` branch.

1. ✅ **Phase 1a** — SQL indexes on Scouting Entry.
   - `patches/v1_0/add_scouting_indexes.py` creates 4 indexes:
     `(date_of_capture, greenhouse)`, `(date_of_capture, block)`,
     `modified` (for delta scans), and `crop_scouted`.
   - Idempotent — re-runs are no-ops via `INFORMATION_SCHEMA` lookup.
   - Registered in `patches.txt`.

2. ✅ **Phase 1b** — Month-aligned L1 keys + 90-day cap.
   - `_month_cache_key(year, month)` and `_fetch_month_entries(...)` in
     `get_complete_scouting_entries.py`.
   - `_fetch_scouting_payload(...)` stitches multiple months and
     applies greenhouse/block + date filtering in-memory.
   - Months older than `CACHE_WINDOW_DAYS` (90) still build but skip
     the `cache.set_value` write — old data serves uncached.
   - Cache TTL: `TTL_MEDIUM` (1h). Version-stamp invalidation already
     wired via `cache_utils.invalidate_scouting_payload` and the
     existing `_SCOUTING_PAYLOAD_INVALIDATORS` doc-event hooks.

3. ✅ **Phase 1c** — Reference data exposed to the client.
   - `get_zone_counts_by_greenhouse` whitelisted in
     `scouting_metrics_api.py` (was previously only an internal
     builder). Joins the existing `getBedsAndZones` and
     `get_farms_and_warehouses` whitelisted endpoints.
   - `frontend/src/lib/scouting-api.ts` adds `fetchBedsAndZones`,
     `fetchGreenhouseToFarm`, `fetchZonesByGreenhouse` with a 30-min
     in-memory dedup so repeated hook calls in the same tab don't
     re-hit the network.

4. ✅ **Phase 2** — `get_entries_since` delta endpoint.
   - In `get_complete_scouting_entries.py`. Returns
     `{ server_now, since, entries, has_more }` ordered by
     `modified asc`, paginated at 2000 rows by default.
   - Optional `farm` filter resolves to its allowlisted greenhouses
     via the cached `get_farms_and_warehouses` map; greenhouse/block
     filter falls through to the index.

5. ✅ **Phase 3** — Browser IndexedDB.
   - `frontend/src/lib/idb.ts` defines DB `upande_scp` v1 with the
     `entries` store (indexed on `month`, `greenhouse`, `block`,
     `modified`) and the `meta` key/value store. Includes
     `evictOldMonths()` enforcing the 90-day rolling window.
   - `frontend/src/lib/scouting-sync.ts` orchestrates
     `hydrateRange()` (fill missing months), `runDelta()` (advance
     watermark), `readEntries()` (filter from IDB), and
     `invalidateMonth()` (drop a month after a realtime nudge).
   - `frontend/src/hooks/use-scouting.ts` is the single consumer hook.
     First paint reads from IDB; delta sync runs in the background and
     re-renders only when the diff is non-empty.

6. ✅ **Phase 4** — Realtime publish.
   - `cache_utils.publish_scouting_dirty(doc, method)` resolves the
     affected month and calls
     `frappe.publish_realtime("scp:scouting:dirty", {months: [...]},
     after_commit=True)`. Wrapped in a try/except so a realtime
     failure can never break the underlying write.
   - Wired in `hooks.py` via `_SCP_SCOUTING_EVENTS` for the parent
     `Scouting Entry` plus the three child tables. Both `on_update`
     and `on_trash` run the cache invalidator and the publisher; an
     extra `after_insert` covers the create path because parent
     `on_update` doesn't fire on the first save.
   - `frontend/src/hooks/use-realtime.ts` subscribes via
     `window.frappe.realtime` if Frappe's socket client is present;
     no-ops otherwise (the standalone `/scp_app` shell has no socket
     dependency).

After Phase 1, the system handles the current load comfortably with
zero client changes. Phases 2–4 are scaling investments — only build
them if Phase 1 isn't enough. (We built them anyway; the code is in
place but each layer can be disabled independently if it ever causes
trouble.)

## What this is *not*

- A queue. We're not streaming entries, we're caching them.
- A search index. Filtering is done client-side; complex search
  belongs in a separate Frappe report.
- A write path. All writes go through Frappe's normal doc API; the
  doc events here only invalidate, they don't intercept writes.
- An offline mode. IDB lets the page render fast on warm cache, but
  we still need the server reachable for delta syncs.

## Operations

To bust everything by hand (e.g. after restoring from backup):

```python
import frappe
from upande_scp.serverscripts.cache_utils import invalidate_scouting_payload
invalidate_scouting_payload()
```

To inspect what's in Redis:

```bash
bench --site SITE redis-cache LLEN  # nothing — frappe.cache is k/v
bench --site SITE redis-cache GET "scp:scouting_payload_ver"
bench --site SITE redis-cache KEYS "scp:scouting_payload_v1:*"
```

To force a fresh full sync on the client, clear IDB:

```js
indexedDB.deleteDatabase("upande_scp");
location.reload();
```
