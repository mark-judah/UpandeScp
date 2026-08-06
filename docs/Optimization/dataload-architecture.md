# Making the data bridge fast — options paper

**Status:** options paper, not a spec. Ends with the decisions needed before a spec.
**Companion to:** `dataload.md` (the external research thread).
**Every number below was measured on `kaitet.local`** (297 131 Scouting Entries, 1–13 July 2026) unless labelled *projected*.

---

## 1. Goal and the invariant

**Goal:** make the bridge between MariaDB and the React frontend fast enough to hold at 30M–100M scouting entries, with many concurrent users on live-updating views.

**Invariant — nothing on screen changes.** Same pages, same numbers, same colours, same filters. This is a transport and serving change only. Section 4 describes how we *prove* that rather than hope for it.

Two things follow from the invariant that are worth stating early, because they rule out a lot of otherwise-reasonable ideas:

- We cannot "just show less data" — no reducing the date window, no capping zones, no downsampling the heatmap. Those are display changes.
- We cannot change what a number *means*. If `Observations` currently counts an entry with three pest rows as three, the new path counts it as three, including the edge cases nobody documented.

---

## 2. What we have today

### 2.1 The four layers

```
MariaDB  SERVER                                ║ BROWSER
   │                                           ║
   ├─►[L1] getScoutingEntriesChunk             ║
   │    per-ISO-week, whole site, unfiltered   ║
   │    └ Redis scp:scouting_payload_v2:{ver}: ║
   │      {year}-W{nn}  rows  TTL 24h ═════════╬═ 83.5 MB/wk UNCOMPRESSED ═► scouting-sync.ts
   ├─►[L2] get_entries_since                   ║                                  │
   │    delta by `modified` watermark ═════════╬══════════════════════════════►   ▼
   │                                           ║                          IndexedDB (idb.ts)
   │                                           ║                                  ▼
   │                                           ║                     readEntries() filters in JS
   │                                           ║                                  ▼
   │                                           ║    RoseScouting · Observations · TrapsMap ·
   │                                           ║    AvocadoHeatMap · AvocadoTreeMap
   ├─►[L3] dashboard_aggregates ◄ the good path║
   │    └ Redis scp:dash_agg:{...}  TTL 60s ═══╬═ ~KB ═► ApplicationPlan (already on L3)
   └─►[L4] scp:scouting:dirty broadcast ═══════╬═ nudge, site-wide ═► every client refetches
```

*Legend — every diagram below redraws this same skeleton.* `─►` unchanged flow · `║ ╬` the
browser boundary (the payload crossing it is annotated) · `═►` data crossing the boundary ·
`╳` removed vs this baseline · `★` new vs this baseline.

L1 is the problem. From its own header comment in `scouting-sync.ts:11`:

> *Filtering by greenhouse / farm / crop happens **after** IDB reads, never on the server side.*

The browser downloads the entire site's scouting data week by week, stores it in IndexedDB, and filters it in JavaScript. This is a **dataset replication** architecture. It was a reasonable choice at 50k rows. It does not survive 30M.

### 2.2 Measurements

```
 one L1 week crossing the ═╬═ boundary: 83.5 MB JSON · 154 640 entries · 566 B each
 ┌────────────────┬──────────────────────────────┬──────────────────────────────────────┐
 │ pests·diseases │ zone · greenhouse · lat/lng  │ owner · modified_by · modified · bed │
 │ ~15% — this IS │ needed by some views         │ read by no page (bed: rarely) —      │
 │ the payload    │ (lat/lng: maps only)         │ audit + sync bookkeeping             │
 └────────────────┴──────────────────────────────┴──────────────────────────────────────┘
   …and 53% of the entries carry zero observations at all
```

**One ISO week, site-wide** (`_build_month_entries('2026-07-06','2026-07-12')`):

| | |
|---|---|
| entries returned | 154 640 |
| JSON payload | **83.5 MB** |
| gzip *potential* (measured, zlib level 6) | 5.5 MB — a 15.1× ratio |
| **actually sent on the wire today** | **83.5 MB, uncompressed** — see §6.4 |
| server build time | 11.7 s |
| bytes per entry | 566 |
| entries carrying **zero** observations | **53%** |

**Where those bytes go** (sampled over 5 000 entries):

| field | KB | needed by any view? |
|---|---|---|
| `pests` | 218 | **yes** — this is the payload |
| `zone` | 185 | yes |
| `owner` | 151 | no |
| `modified_by` | 151 | no |
| `bed` | 141 | rarely |
| `modified` | 137 | no (sync bookkeeping only) |
| `greenhouse` | 96 | yes |
| `latitude` / `longitude` | 170 | maps only |
| `diseases` | 59 | yes |

So roughly **15% of the payload is the observation data**, 53% of the rows carry none at all, and several of the largest fields are never read by any page.

**The aggregate path (L3) has its own problem.** `EXPLAIN` on the ApplicationPlan diagnose query:

```
tabPests Scouting Entry   type=ALL    key=NULL   rows=156653
tabScouting Entry         type=eq_ref key=PRIMARY
```

The optimizer runs the join **backwards** — full-scans the child table, then does a primary-key lookup into the parent for every row, *then* applies the greenhouse and date filters. Cost is proportional to the whole child table, not to the slice requested. Proof:

| window | grouped rows | time |
|---|---|---|
| 1 day | 761 | 0.07 s |
| 1 week | 3 053 | **0.42 s** |
| 60 days | 6 127 | **0.43 s** |

A 60× wider window costs the same. Forcing parent-first order takes the 60-day case from 423 ms → **179 ms**, and — the actual point — makes cost track the slice instead of the table.

The `OR` in `WHERE (se.greenhouse = %s OR se.block = %s)` is what defeats the planner's selectivity estimate. Both `scouting_date_gh_idx` and `scouting_date_block_idx` exist and neither gets used.

**Redis is over budget by design:**

| | |
|---|---|
| `maxmemory` | **1.17 GB** |
| `maxmemory-policy` | **allkeys-lru** |
| one week of L1 payload | 83.5 MB |
| a 90-day window (13 weeks) | **1.08 GB** |

At *current* volume, caching one quarter of one site consumes the entire Redis budget. Because the policy is `allkeys-lru`, that eviction pressure falls on *every other key in the instance* — sessions, rate limiting, document cache, the L3 aggregates. The scouting payload doesn't just fail to stay warm; it makes everything else cold too. At the projected 600k entries/week a single week is ~340 MB *(projected)* and three weeks evict the entire instance.

**The realtime channel amplifies writes.** `publish_scouting_dirty` (`cache_utils.py:211`) broadcasts **site-wide** on every scouting write, and every listening client responds by re-running a delta sync. Cost is O(writes × connected clients). At the projected 600k/week — roughly 3 inserts/second during scouting hours — with 50 users connected, that is ~150 client-initiated refetches per second. This is the layer that most needs redesigning for the live-sync goal, and it is currently the one that scales worst.

---

## 3. The four bottlenecks, named

```
MariaDB  SERVER                                ║ BROWSER
   ├─►[L1] week chunk ─ Redis rows ◄ B3 ═══════╬═ 83.5 MB/wk ═► JSON.parse + 154 640 IDB
   ├─►[L2] delta ══════════════════════════════╬═►             writes ◄ B1 (the minute)
   ├─►[L3] aggregates ◄ B2  inverted join,     ║
   │       cost ∝ whole child table ═══════════╬═ 0.42 s flat, any window ═► ApplicationPlan
   └─►[L4] site-wide broadcast ◄ B4 ═══════════╬═ O(writes × clients) ═► refetch storm
```

| # | Bottleneck | Evidence | Scales with |
|---|---|---|---|
| **B1** | Client-side dataset replication | 83.5 MB/week parsed + 154 640 IDB writes | total rows in window |
| **B2** | Inverted join plan in aggregates | `EXPLAIN` type=ALL; flat 0.42 s across windows | total child table size |
| **B3** | Cache stores rows, not answers | 1.08 GB for 90 days vs 1.17 GB budget, `allkeys-lru` | total rows in window |
| **B4** | Broadcast invalidation, not deltas | site-wide publish per write | writes × clients |

The minute you see today is **B1** — `JSON.parse` of 83 MB and 154 640 IndexedDB transactions on the operator's machine.

The network is *also* a bottleneck, but avoidably so: nginx is not compressing JSON at all (§6.4), so the full 83.5 MB crosses the wire uncompressed. That is a one-line fix worth 15×, and it is independent of everything else in this document.

Note that B1, B3 and B4 all have the same root cause: **we move rows across the bridge when we should be moving answers.** B2 is independent and cheaper to fix.

---

## 4. How we change the bridge without changing the display

The invariant is only credible if it's mechanically enforced. Proposal:

```
                 ┌─► OLD  L1 rows ► IndexedDB ► JS aggregation ──┬─────► renders (unchanged)
 real operator ──┤                                               ▼
 traffic         └─►★NEW  server aggregate ─────────────────► compare ──► mismatch? → console
 (page, filters)                                                 ▲
                     golden fixtures, captured from today's JS output, gate every migration
```

1. **Golden-output harness.** For a fixed list of (page, filter-combination) cases, capture what the current JS pipeline computes — the exact `zoneObs` map, KPI numbers, chart series, list rows — as JSON fixtures.
2. **Equivalence test.** Each new server endpoint must reproduce its fixture byte-for-byte after normalisation (key order, float rounding). A migration is not "done" until its fixture matches.
3. **Shadow mode.** For one release, the page runs both paths and logs mismatches to the console without changing what renders. Real operator traffic, real filter combinations, zero risk.
4. **Then** delete the old path.

This matters because the JS aggregation has accumulated behaviour nobody wrote down — how it treats `count` nulls, entries with no zone, `crop_scouted` defaulting to `"Rose"` (`scouting-sync.ts:240`). Re-implementing it server-side from reading the code will get some of those wrong. The fixtures catch it.

**This harness is the first deliverable of any approach below.** Without it we are guessing.

---

## 5. Approaches

### A0 — Keep the architecture, tune it

Bigger Redis, more gunicorn workers, more RAM for the buffer pool, tighter `evictOldMonths`.

```
MariaDB  SERVER                                ║ BROWSER
   ├─►[L1] week chunk ─ Redis ★bigger ═════════╬═ still 83.5 MB/wk ═► sync ► IDB ► 5 pages
   ├─►[L2] delta ══════════════════════════════╬═►             (B1 untouched — still parsed)
   ├─►[L3] aggregates  ★more workers, RAM ═════╬═ ~KB ═► ApplicationPlan
   └─►[L4] site-wide broadcast ════════════════╬═► every client refetches  (B4 untouched)
```

- **Effort:** days. **Risk:** none. **Ceiling:** low.
- Buys maybe 2× on B1 and nothing structural. The 83.5 MB still gets parsed by the browser. At 600k/week it fails; at 30M it is not on the table.
- **Worth doing anyway:** the Redis `maxmemory` / policy issue (§7) is real and cheap to fix regardless of which approach wins.
- **Verdict:** necessary hygiene, not a strategy.

### A1 — Slice-proportional queries

Fix B2 only. No schema change, no client change.

```
MariaDB  SERVER                                ║ BROWSER
   ├─►[L1] week chunk ═════════════════════════╬═ 83.5 MB/wk ═► sync ► IDB ► 5 pages
   ├─►[L2] delta ══════════════════════════════╬═►            (B1 untouched — that is A2)
   ├─►[L3] ★parent-first join  ★covering index ║
   │       ★filter push-down  ★split cache key ║
   │       cost now ∝ slice  423 ms ► 179 ms ══╬═ ~KB ═► ApplicationPlan
   └─►[L4] site-wide broadcast ════════════════╬═► every client refetches
```

- Force parent-first join order; replace the `greenhouse OR block` disjunction with a single equality predicate on whichever column the scope's `warehouse_type` selects (see §12.3 — `Block` → `se.block`, everything else → `se.greenhouse`). That is what lets `scouting_date_gh_idx` / `scouting_date_block_idx` drive the query at all.
- Composite index on child tables `(parent, pest, plant_section, stage, count)` so the join never leaves the index.
- Push `pest` / `section` / `stage` into `WHERE` — today `_application_plan.py:106` fetches all rows and filters in Python, so selecting one pest still costs all of them.
- Split the cache key: `filterOpts` depends only on `(greenhouse, window, crop)`, `zoneObs` on the full filter set. Today they share a key, so every chip click recomputes both.

**Measured:** 423 ms → 179 ms, and cost becomes proportional to the slice.
**Effort:** ~3 days. **Risk:** low, reversible. **Ceiling:** medium — fixes L3, leaves B1 untouched.
**Verdict:** do it first regardless. It is the cheapest real win and it unblocks A2.

### A2 — Aggregate bridge: ship answers, not rows

Fix B1. Migrate the five IDB pages onto server-side aggregation, then delete `scouting-sync.ts`, `idb.ts` and `getScoutingEntriesChunk`.

```
MariaDB  SERVER                                ║ BROWSER
   ├─╳[L1] week chunk ── deleted ──────────────╫─╳ scouting-sync.ts / idb.ts — deleted
   ├─╳[L2] delta ── deleted ───────────────────╫
   ├─►★S1 aggregate  farm/site-wide, no zone ══╬═ ~KB ═► dashboards · KPIs · trends
   ├─►★S2 aggregate  one gh, zone grain (A1) ══╬═ ~80 KB (was 618 KB) ═► maps · heatmaps
   ├─►★S3 narrow row projection ═══════════════╬═ packed arrays ═► tracks · drill-down
   └─►[L4] broadcast  unchanged — A4's job ════╬═► every client refetches
```

Every read becomes one of three declared shapes. Nothing else is permitted:

| shape | used by | served from |
|---|---|---|
| **S1** aggregate, farm/site-wide, no zone | dashboards, KPIs, trends, counts | rollup (A3) or live query |
| **S2** aggregate, one greenhouse, zone-grained | bed maps, heatmaps, diagnose | live query on raw, A1 access path |
| **S3** narrow row projection | scouting tracks, entry drill-down | direct, columns only |

S3 is the answer to "we need the actual rows sometimes" — a scouting track needs `(lat, lng, time)` as packed parallel arrays for one scout-day, not documents. It is still a row read; it is just not a *document* read.

*Projected* payload for the ApplicationPlan case: 618 KB → ~80 KB with S2 plus compact encoding (columnar arrays, a colour palette indexed by integer instead of a hex string repeated per zone).

**Effort:** ~2–3 weeks, one page at a time. **Risk:** medium — this is where the invariant can break, which is what §4 is for. **Ceiling:** high. Removes B1 entirely.
**Verdict:** this is the one that makes the minute disappear.

### A3 — Rollup / fact layer

Fix B3 and give S1 a permanent home. A maintained summary table so dashboards never touch raw.

```
MariaDB  SERVER                                ║ BROWSER
   │ raw (T4)                                  ║
   ├─►★incremental rollup ─► ★T3 summary table ║
   │    block grain 33×/29×  (zone grain ╳)    ║
   │      └─► S1 reads rollup, never raw ══════╬═ ~KB ═► dashboards · KPIs · trends
   ├─► S2 stays a live query on raw (A1) ══════╬═ ~80 KB ═► maps · heatmaps · diagnose
   └─►[L4] broadcast — A4's job ═══════════════╬═►
```

**The grain is the whole decision, and I measured it:**

| grain | rows | compression |
|---|---|---|
| raw pest child rows | 153 771 | — |
| `(date, gh, **zone**, pest, section, stage)` | 127 318 | **1.21×** |
| `(date, gh, pest, section, stage)` | 4 600 | **33×** |
| raw disease child rows | 48 965 | — |
| `(date, gh, **zone**, disease, section, stage)` | 41 824 | **1.17×** |
| `(date, gh, disease, section, stage)` | 1 715 | **29×** |

**Zone grain does not compress.** 3 756 distinct zones in a single greenhouse, 118 136 site-wide across 97 greenhouses — each scouting entry is essentially one zone-visit, so grouping by zone removes nothing. A zone-grained summary table would be a second table nearly as large as the first, with backfill cost, staleness, and no speed benefit.

This is where `dataload.md` needs correcting: it assumed block grain (30M → 500k, ~30×), which is right for *its* question and wrong for our bed maps. The 33×/29× rows above are the block-grain equivalent and they are excellent — but only for S1.

So: **rollup serves S1; S2 stays a live query forever.** That is not a compromise, it is the correct decomposition — S2 is inherently bounded (one greenhouse × one window) once A1 makes the access path honest.

The same rollup feeds `_overview`, `_pests_diseases`, `_trends`, `_gh_detail`, `_fcm` — all five carry the same join pattern today — and answers the exact-count question from `dataload.md` permanently.

**Effort:** ~1 week plus backfill. **Risk:** medium — dual-write correctness, backfill window. **Ceiling:** high for S1.
**Verdict:** yes, but **after** A2, so the grain is chosen from endpoints in real use rather than guessed.

### A4 — Push deltas instead of broadcasting invalidation

Fix B4. This is the "live like a stock ticker" requirement, and it is a genuinely different model from what we have.

**Today:** write → site-wide broadcast → every client refetches everything. O(writes × clients), and each refetch is expensive.

**Proposed:** snapshot + delta stream + periodic reconcile.

```
MariaDB  SERVER                                ║ BROWSER
 write ─► doc event                            ║
   │  ╳ site-wide nudge to everyone — deleted  ║
   └─►★delta {zone, obs, stage, +n}            ║
       └─►★room per greenhouse, coalesced      ║
          ≤1 publish/s/room ═══════════════════╬═ tens of bytes ═► clients in that room only
                                               ║                    └► patch in-memory agg
 A2 aggregate, now cheap ══════════════════════╬═ every 30–60 s ═► ★reconcile — self-heals
```

1. **Rooms scoped to what's on screen.** A client viewing a greenhouse joins that greenhouse's room. Frappe already gives us this for free: `doc_subscribe("Warehouse", "<greenhouse>")` joins `doc_room`, and `realtime/handlers.js:58` permission-checks the subscribe. No Frappe patch, and permission scoping comes with it.
2. **Publish the delta, not a nudge.** The doc-event handler computes the aggregate change the write causes — `{zone, obs, stage, +n}` — and publishes it to the affected room via `publish_realtime(..., doctype="Warehouse", docname=greenhouse)`. Payload is tens of bytes.
3. **Client applies the patch** to its in-memory aggregate. No refetch, no re-render of anything but the changed zone.
4. **Coalesce.** A per-room Redis throttle (`SET room:tok 1 EX 1 NX`) caps publishes at ~1/second/room; writes inside the window set a dirty bit merged into the next publish.
5. **Reconcile.** Every 30–60 s the client refetches its (now cheap) aggregate and replaces state, so any dropped or mis-applied patch self-heals. This is what makes it robust rather than clever.

Cost becomes O(writes), fanned out only to interested rooms, independent of user count within a room. A user watching greenhouse A is unaffected by writes in greenhouse B — which today is not true.

**Effort:** ~1 week. **Risk:** medium — delta arithmetic must match the aggregate exactly, which is why step 5 exists. **Depends on:** A2 (there must be a server-side aggregate to patch).
**Verdict:** required for the live-sync goal. Not optional at many-users scale.

### A5 — Columnar offload

Replicate to ClickHouse / DuckDB, dashboards read from there. `dataload.md` strategies 5–6.

```
MariaDB  SERVER                                ║ BROWSER
   ├─►★sync pipeline ─► ★ClickHouse / DuckDB   ║
   │     a second service to keep correct;     ║
   │     30M rows ► 1–3 GB columnar ═══════════╬═ ad-hoc, full history, <500 ms ═► dashboards
   └─► S1/S2/S3 seam unchanged (A2) ═══════════╬═► same pages — A5 slots in behind the seam
```

- **Effort:** weeks, plus a second service, plus a sync pipeline to keep correct.
- **Ceiling:** very high — 30M rows compress to 1–3 GB columnar, ad-hoc slicing over full history in <500 ms.
- **But:** A2 + A3 keep Frappe's native path viable well past 30M, because no query ever scans more than one greenhouse-window or a 33×-compressed rollup. A5 solves a problem we will not have until ad-hoc analytics over multi-year history becomes a product requirement.
- **Verdict:** shelf it, revisit at ~100M or when analytics demands arrive. Note that A2's shape contract (S1/S2/S3) is exactly the seam you'd swap a columnar backend in behind — so doing A2 makes A5 *cheaper* later, not harder.

### Comparison

| | A0 tune | A1 queries | A2 aggregate | A3 rollup | A4 deltas | A5 columnar |
|---|---|---|---|---|---|---|
| Fixes B1 (client replication) | — | — | **✓** | — | — | ✓ |
| Fixes B2 (join plan) | — | **✓** | — | ✓ | — | ✓ |
| Fixes B3 (cache of rows) | partial | — | ✓ | **✓** | — | ✓ |
| Fixes B4 (broadcast storm) | — | — | — | — | **✓** | — |
| Display unchanged | ✓ | ✓ | ✓ (§4) | ✓ (§4) | ✓ (§4) | ✓ (§4) |
| Schema change | no | index only | no | new table | no | new service |
| Reversible | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Effort | days | ~3d | 2–3w | ~1w | ~1w | weeks |
| Holds at 30M | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Holds at 100M | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |

---

## 6. Delivery-layer concerns — sectional loading, indexes, Redis

Three concerns raised during review, each checked against what is actually deployed. The short version: **one is half-built and capped by infrastructure, one is half-built and silently incomplete, one is a genuine choice — and while checking them I found two free wins bigger than any of the three.**

```
MariaDB  SERVER                                ║ BROWSER
   │                              ┌────────────╫────────────┐
   │   gunicorn -w 9 ◄ 6.1 ceiling│  HTTP/1.1  ║  ~6 conns  │◄ 6.1 ceiling
   ├─►[L1/L2/L3] ─────────────────┤  no gzip   ║  40 ms per │
   │    ▲ 6.2 indexes:            │  on JSON   ║  call      │
   │      parent ✓(3 of 4)        │  ◄ 6.4     ║  POST = no │
   │      child  ╳ none           └────────────╫─ cache ◄6.4│
   └─►[L4] ── redis 13000 ── shared with socketio ◄ 6.3 ────┘
              maxmemory 1199mb · allkeys-lru
```

### 6.1 Sectional loading — *partially implemented, and capped*

**Status: half-built.** Parallel fan-out already happens in two places — `ApplicationPlan.tsx:347-369` fires four bootstrap endpoints concurrently, and `hydrateRange` (`scouting-sync.ts:162`) fetches all missing weeks through one `Promise.all`. So the *pattern* exists. What does not exist is per-section endpoints for the dashboard and map pages; those still take one giant payload and slice it in JS.

The idea is sound — split a page into sections that each fetch their own narrow endpoint, so no single request carries the whole page and the first section paints early. But it runs into two hard ceilings that must be raised first, or the fan-out makes things *worse*:

| ceiling | measured | consequence |
|---|---|---|
| Browser connections per origin | **HTTP/1.1** — no `http2` on `listen 443 ssl` | ~6 concurrent requests; a 7th section queues |
| Server worker pool | **`gunicorn -w 9`** | 9 concurrent requests **for the entire site, all users** |
| Fixed cost per call | **~40 ms** (`frappe.ping`, warm) | 8 sections = ~320 ms of pure overhead |
| Cold connection | **706 ms** TLS handshake | paid per new connection on a cold page load |

The worker pool is the dangerous one. Fanning one page load out to 8 parallel calls means **a single operator can occupy 8 of the 9 workers**. Two operators opening dashboards simultaneously saturate the pool, and every other user — including the mobile scouts posting entries — queues behind them. Sectional loading converts a latency problem into a concurrency problem.

**Verdict: worth doing, but strictly after A2, and with limits.** Once endpoints return KB instead of MB (A2), sections are cheap and fan-out is safe. Doing it *first*, against today's payloads, multiplies the strain rather than splitting it. When we do it: cap concurrent sections at 4–6, raise `-w` in step with it, and enable HTTP/2 (§6.4) so the connection limit stops binding.

### 6.2 Database indexes — *partially implemented, silently incomplete*

**Status: parent table mostly covered, child tables not at all.**

A patch already exists — `upande_scp/patches/v1_0/add_scouting_indexes.py`, registered at `patches.txt:12`. It declares four indexes. Three are present on `kaitet.local`; the fourth is not:

| index | declared in patch | on `kaitet.local` |
|---|---|---|
| `scouting_date_gh_idx` (date, greenhouse) | ✓ | **✓ present** |
| `scouting_date_block_idx` (date, block) | ✓ | **✓ present** |
| `scouting_modified_idx` (modified) | ✓ | **✓ present** |
| `scouting_crop_idx` (crop_scouted) | ✓ | **╳ MISSING** |

The patch is also absent from `tabPatchLog`. Frappe runs each patch once and records it; a patch edited after its first run never re-executes. So `scouting_crop_idx` was almost certainly appended to the tuple after the original run and will never be created by `bench migrate`. **Any index added to that file from now on is dead code unless the patch is renamed or made re-runnable.** That is a trap worth fixing before we add more.

The bigger gap — the child tables carry no useful index at all:

| table | indexes present |
|---|---|
| `tabPests Scouting Entry` | `PRIMARY(name)`, `parent` |
| `tabDiseases Scouting Entry` | `PRIMARY(name)`, `parent` |
| `tabTrap Scouting Entry` | `PRIMARY(name)`, `parent` |
| `tabWeeds Scouting Entry` | `PRIMARY(name)`, `parent` |

No `search_index` is set on any child field (`pests_scouting_entry.json` → `plant_section`, `pest`, `stage`, `count` all `0`). This is exactly why the planner full-scans the child table (§2.2): with only `parent` available and no covering index, driving from the child and probing the parent by primary key looks cheap to the optimizer.

**Effect on data load:** A1's composite index `(parent, pest, plant_section, stage, count)` is the missing piece that makes the join covering — the query never leaves the index, so no clustered-index lookup per child row. Note the ordering trap from `dataload.md`: an index on `pest` *alone* is worse than useless here, because our filter is on `parent`. Lead with `parent`.

**Verdict: not implemented for the path that matters. Highest-value index work in this document, and it belongs in A1.**

### 6.3 Our own Redis, or ERPNext's? — *a real choice*

**Status: currently sharing, and sharing more than you would expect.**

```
127.0.0.1:13000 ── redis_cache     ── maxmemory 1199mb · allkeys-lru
                └─ redis_socketio  ── SAME INSTANCE  ◄ the surprise
127.0.0.1:11000 ── redis_queue     ── background jobs
127.0.0.1:6379  ── system redis    ── running, unused by any bench
```

`common_site_config.json` points `redis_socketio` at **13000 — the same instance as `redis_cache`**. So the realtime layer shares an `allkeys-lru` pool with application payloads. Today that is harmless because usage is 7 MB of a 1.17 GB budget. Under the live-sync design (§8), where realtime becomes load-bearing, it means cache pressure and socket delivery compete for the same memory and the same eviction policy.

The options:

| option | pros | cons |
|---|---|---|
| **Keep sharing ERPNext's cache** | zero setup; one thing to operate | app payloads evict sessions/socketio; single policy for very different data; no isolation |
| **Separate DB index on 13000** (`redis://…/2`) | free; namespaced; one-line config | **no isolation of memory or eviction** — `maxmemory` is per *instance*, not per DB. Cosmetic only |
| **Own Redis instance for SCP** ★ | own `maxmemory`, own policy, own persistence; app load cannot evict sessions or socketio; can be tuned/restarted independently | one more process to supervise; a second thing to monitor |

**Recommendation: our own instance, but only once T2 (§7) exists.** The reason is not capacity — §7's rule 2 keeps every entry small enough to live within 1.17 GB. The reason is **blast radius**: aggregate payloads should not be able to evict a user's session or starve socket delivery, and `allkeys-lru` on a shared pool makes that possible by design. A separate instance also lets us pick `allkeys-lru` for aggregates (where eviction is safe — it just recomputes) while ERPNext's own cache keeps whatever policy it needs.

Cheap intermediate step available today: **repoint `redis_socketio` off 13000**, so realtime stops sharing an evicting pool with cached payloads. That is a config line plus a restart, and it de-risks §8 before we build it.

### 6.4 Two free wins found while checking the above

Neither is in any approach above. Both are configuration, not code, and both are larger than most of what this document proposes.

**JSON is not compressed. At all.**

`/etc/nginx/nginx.conf:46` has `gzip on;` — but `gzip_types` is **commented out** on line 53, so nginx falls back to its default of `text/html` only. Verified against the live host:

```
$ curl -I -H "Accept-Encoding: gzip" .../api/method/frappe.ping
HTTP/1.1 200 OK
Content-Type: application/json
                                  ◄ no Content-Encoding header — NOT compressed

$ curl -I -H "Accept-Encoding: gzip" .../assets/...   (text/html 404 page)
Content-Encoding: gzip            ◄ HTML is compressed, JSON is not
```

So the 83.5 MB week crosses the wire **uncompressed**, and every aggregate endpoint we build will too. Uncommenting one line to include `application/json` yields a measured **15.1×** reduction on exactly the payloads this document is about. This is the single highest return-on-effort item found anywhere in this analysis.

**HTTP/1.1, no HTTP/2.** `listen 443 ssl;` has no `http2` token (nginx 1.18 supports it). This is what caps the browser at ~6 concurrent connections and forces a 706 ms handshake per new one. Enabling it is one token per server block, and it is a precondition for §6.1 paying off.

| | change | effort | effect |
|---|---|---|---|
| **W1** | `gzip_types … application/json;` | one line | **15.1×** less bytes on every API response |
| **W2** | `listen 443 ssl http2;` | one token | lifts the ~6-connection cap that bounds §6.1 |
| **W3** | repoint `redis_socketio` off 13000 | config line | realtime stops sharing an evicting pool (§6.3) |

One caveat on W1/W2: both edit the nginx config that also serves live `kaitet.132.145.21.55.nip.io`. Test with `nginx -t` and reload rather than restart.

### 6.5 A related finding: every API call is a POST

`frontend/src/lib/frappe.ts:52` issues every request as `POST`. POST responses are uncacheable by the browser, by nginx, and by any CDN — so a section that has not changed is re-fetched and re-serialised in full, every time.

Moving the **read-only** aggregate endpoints to `GET` with `Cache-Control` and an `ETag` would let an unchanged section cost a `304 Not Modified` with no body at all. That composes especially well with §6.1: sectional loading plus per-section ETags means a dashboard refresh re-downloads only the sections that actually changed.

Not free — it needs CSRF handling reviewed for GET and a check that no endpoint mutates. Worth scoping alongside A2, since A2 is already rewriting these endpoints.

---

## 7. Caching architecture

The current cache stores **rows**. The new cache stores **answers**. That single change is what makes the Redis budget work.

```
          BROWSER ◄══ answers only, bounded shapes ══╗       (rows never cross again)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ T0  in-process  masters per request (frappe.local)                  KB    │  ▲ hotter
 │ T1  Redis       masters: pests · diseases · zones · geometry     ~10 MB   │
 │ T2  Redis       S1/S2 answers  97 gh × 13 wk × ~100 KB ≈        ~126 MB   │ ◄ 1.17 GB
 │ T3  MariaDB     rollup table (A3)           ~180k rows/yr (projected)     │    budget
 │ T4  MariaDB     raw entries + children           grows with history       │  ▼ colder
 └───────────────────────────────────────────────────────────────────────────┘
  ╳ today instead: rows in Redis — 83.5 MB/key, one 90-day window = 1.08 GB, LRU thrash
```

### What's wrong now

- 83.5 MB per cached week — one 90-day window is 1.08 GB against a 1.17 GB `maxmemory`.
- `allkeys-lru` means that pressure evicts sessions, document cache and the L3 aggregates too.
- The key is `{version}:{year}-W{nn}` — site-wide, so a viewer of one greenhouse pays to warm all 97.
- `scouting_payload_version()` bumps globally on writes, orphaning every week at once.

### Proposed tiers

| tier | contents | key | size | TTL | invalidation |
|---|---|---|---|---|---|
| **T0** in-process | master data per request (stage icons, colours) | `frappe.local` | KB | request | n/a |
| **T1** Redis: masters | pests, diseases, zones, geometry, thresholds | existing `K_*` keys | ~10 MB | 1–24 h | doc events (already correct) |
| **T2** Redis: hot aggregates | S1/S2 answers per `(endpoint, scope, window, filters)` | `scp:agg:v1:{endpoint}:{gh}:{week}:{hash}` | ~100 KB each | 15 min | room-scoped delta or event |
| **T3** MariaDB: rollup | A3 summary table | table | ~180k rows/yr *(projected)* | permanent | incremental on write |
| **T4** raw | Scouting Entry + children | tables | grows | permanent | — |

**Sizing T2:** 97 greenhouses × 13 weeks × ~100 KB ≈ **126 MB**. The same Redis budget that today holds *one quarter of one site, thrashing*, would hold *every greenhouse for a quarter* with 90% headroom.

**Three rules that make it robust:**

1. **Scope the key to the query, not the dataset.** A greenhouse-scoped key means a viewer warms only what they look at, and a write to greenhouse A cannot invalidate greenhouse B.
2. **Never cache anything unbounded.** A cache entry whose size grows with the dataset is a time bomb — that is precisely how we got 83.5 MB keys. Every T2 entry has a bounded shape (zones in one greenhouse × observations × stages).
3. **Separate the instances, or at least the budget.** Large application payloads should not share an `allkeys-lru` pool with sessions. Either move aggregates to their own Redis DB with its own policy, or keep every entry small enough that LRU pressure never becomes structural. The second is preferable and falls out of rule 2 for free.

**Prewarming.** `scouting_prewarm.py` already exists. Under T2 it becomes genuinely useful: after the nightly rollup, warm the current week for every active greenhouse — ~97 entries, a few seconds, and the morning's first operator hits a warm cache instead of paying the cold build.

---

## 8. Live sync — the target behaviour

What "live like stock" actually means, and what we'd guarantee:

```
 TODAY ╳ broadcast storm                     │ TARGET ★ snapshot + delta + reconcile
 write ─► site-wide nudge ─► ALL clients     │ write ─► delta {zone, obs, stage, +n}
          each refetches the whole week      │        └─► room(gh) ═ tens of bytes ═►
 O(writes × all clients)                     │            clients patch in place, < 1 s
 dropped message → silently stale            │ every 30–60 s: cheap snapshot ► self-heals
```

| property | today | target |
|---|---|---|
| latency, write → screen | full refetch, seconds–minutes | < 1 s |
| bytes per update | whole week re-fetched | tens of bytes |
| cost model | O(writes × all clients) | O(writes × clients *in that room*) |
| cross-greenhouse isolation | none | complete |
| behaviour on dropped message | silently stale | self-heals within 60 s |
| behaviour on reconnect | full re-hydrate | one snapshot fetch |

The reconcile pass (A4 step 5) is what turns this from a demo into something we can put in front of a big client. Delta streams drift — from dropped sockets, from races between a patch and a snapshot, from a delta computed against a row that was later amended. A cheap periodic re-snapshot means drift has a bounded lifetime, and it is only affordable *because* A2 made the snapshot cheap. The two are a package.

---

## 9. Scaling to 30M and 100M

*All projections from the measured per-unit figures above.*

```
 bytes crossing the ═╬═ boundary for one week's view          (log scale, schematic)
 ~340 MB ┤             current ●━━━━━━━━━━━━━━● grows with data volume (×13 for 90 days)
         │            ╱
 83.5 MB ┤ current ●
         │
  ~80 KB ┤ A2 ★    ●━━━━━━━━━━━●━━━━━━━━━━━━━━● flat — sized by zones per gh, not history
         └─────────┴───────────┴──────────────┴──
                 today        30M            100M
```

| | today (300k) | 30M (~1 yr at 600k/wk) | 100M (~3 yr) |
|---|---|---|---|
| raw parent table | 147 MB | ~15 GB | ~50 GB |
| pest child table | 72 MB | ~7.6 GB | ~25 GB |
| **current bridge:** one week to browser | 83.5 MB | ~340 MB | ~340 MB |
| **A2 bridge:** one greenhouse-week | — | ~80 KB | ~80 KB |
| T3 rollup rows | 6 315 / 13 days | ~180k/yr | ~600k total |
| S2 live query (one gh × week) | 179 ms | ~180 ms | ~180 ms |

The two rows that matter: the current bridge's payload **grows with the client's total data volume**, while A2's payload is **flat** — it depends on how many zones are in one greenhouse, which is a property of the farm, not of history. That is the difference between an architecture with a shelf life and one without.

Hardware still matters for T4 (§`dataload.md` on buffer pool sizing, and 32 GB being the meaningful threshold), but under A2+A3 no user-facing request depends on the raw table fitting in RAM.

---

## 10. Recommended path

**W → A1 → A2 → A4 → A3**, with A5 shelved.

The free wins (§6.4) come first because they are configuration, take an afternoon, and their benefit applies to every payload every later step produces.

```
 baseline ─W─► ★gzip JSON · ★http2 · ★socketio off 13000   15.1× fewer bytes, day one
          ─0─► ★golden harness (§4) + Redis hygiene        nothing deleted yet — safety first
          ─1─► A1  ★join order · ★child index · key split  L3: 423 ms ► 179 ms, cost ∝ slice
          ─2─► A2  ★S1/S2/S3   ╳L1 ╳L2 ╳sync ╳idb          boundary: 83.5 MB/wk ► ~80 KB
          ─3─► A4  ★rooms · deltas · reconcile  ╳L4         O(writes × clients) ► O(writes)
          ─4─► A3  ★T3 rollup feeds S1                      dashboards never touch raw again
          ─5─► §6.1 sectional loading · §6.5 GET+ETag        safe only once payloads are KB
```

| step | work | why here |
|---|---|---|
| **W** | **§6.4 free wins** — `gzip_types` for `application/json`, `http2` on the listen directive, repoint `redis_socketio`. | An afternoon of config for 15.1× on the wire. Nothing later is worth doing while JSON ships uncompressed. |
| **0** | Golden-output harness (§4). Fix Redis `maxmemory`/policy. Make `add_scouting_indexes` re-runnable (§6.2) so the missing `scouting_crop_idx` — and every future index — actually applies. | Nothing else is safe without the harness. |
| **1** | **A1** — join order, **child-table composite index (§6.2)**, filter push-down, cache key split. | 3 days, reversible, unblocks A2. Converts L3 from unbounded to bounded. |
| **2** | **A2** — migrate the five IDB pages to S1/S2/S3, one at a time, shadow-mode each. Delete `scouting-sync.ts`, `idb.ts`, `getScoutingEntriesChunk`. | This is where the minute disappears. |
| **3** | **A4** — rooms, delta publish, coalescing, reconcile. | Needs A2's aggregates to patch. Delivers the live-sync requirement. |
| **4** | **A3** — rollup table, backfill, cut S1 over to it. | Grain chosen from endpoints in real use, not guessed. |

A4 before A3 is deliberate: live sync is a stated product requirement, and A3 is an optimisation of something A2 already made acceptable. If priorities shift, they swap without rework.

Sectional loading (§6.1) is last, not first, and that ordering matters. Against today's multi-megabyte payloads and a 9-worker pool, fanning a page out to 8 endpoints lets one operator occupy the whole server. Against A2's KB-sized sections it is safe and genuinely improves perceived speed. Same idea, opposite outcome, depending only on what comes before it.

---

## 10a. Zone geometry compression — **BUILT.** 54.80 MB → 5.13 MB

**Status: implemented and verified** (commits `9904f3f`, `cff29a5`, `b4e1192`).

| | before | after | |
|---|---|---|---|
| `getBedsAndZones` raw | **54.80 MB** | **5.13 MB** | **10.7×** |
| `getBedsAndZones` gzipped | 5.10 MB | **1.08 MB** | 4.7× |
| full page load, raw | 61.2 MB | **~11.5 MB** | 5.3× |
| full page load, gzipped | 5.48 MB | **~1.5 MB** | 3.7× |

**Lossless, proven across every zone — not a sample:**

```
check_zone_encoding             PASSED — 0 mismatches across 154 290 zones
check_zone_encoding (served)    PASSED — 0 mismatches, 1 500 zones / 1 440 beds
contiguous beds                 18 351 / 18 472  (99.34%)
```

### What was actually built — and what was dropped

The original proposal was to interpolate zone positions from a bed's endpoints. Measurement
showed that was the wrong trade:

| encoding | raw | gzipped |
|---|---|---|
| A. current (`raw_geojson` strings) | 54.80 MB | 5.10 MB |
| B. drop the never-read GeoJSON wrapper | 17.86 MB | 3.47 MB |
| C. + round to 7 dp (~1.1 cm) | 12.77 MB | 1.72 MB |
| **D. + per-bed, contiguous, short names** | **5.06 MB** | **1.02 MB** |

**D needs no interpolation.** Contiguity alone — zone N ends exactly where N+1 begins, true
for 99.34% of beds — means only each zone's *end* point need be sent. Adding
start+delta+count interpolation on top would have gained ~30% more while requiring a
fallback path for non-conforming beds and a validator to catch new beds drifting out of
conformance. The simple encoding was chosen deliberately: same insight, none of the fragility.

Three things made the payload big, and only one of them was geometry:

1. Each zone shipped a full escaped GeoJSON `FeatureCollection`, of which the frontend reads
   exactly two fields — `geometry.coordinates` and `properties.line_id`. `type`, `Feature`,
   `fid`, `segment_id` and `zone_id` were never read by any page.
2. Coordinates carried 17 significant figures — nanometre precision on a bed map.
3. Zone names alone were **5.84 MB**, repeated in full per zone.

### Wire format

```
per bed: [bed_name, line_id, [x0,y0], ends_or_pairs, name_suffixes, contiguous]
  contiguous=1 -> zone i spans points[i-1] -> points[i]   (points[-1] = the bed's start)
  contiguous=0 -> explicit [[xa,ya],[xb,yb]] pairs, that bed only
```

Contiguity is detected **per bed**, so the 121 non-conforming beds (0.66%) fall back to
explicit pairs without dragging the other 18 351 with them.

### Why this mattered more than compression

gzip fixed the wire and did nothing for the browser, which still had to parse 55 MB of
escaped JSON strings. The five consumers now read `coords` and `lineId` directly and the
string-parsing helpers (`parseGeo`, `parseRawGeo`) are deleted — so this removes the *data*,
not just its transport.

### Notes for whoever touches this next

- Served under a **new cache key** (`K_BEDS_AND_ZONES_V2`) with a `"v": 2` marker. The v1 key
  was abandoned rather than overwritten: with a 24 h TTL, a rolling deploy serving a v1
  payload to a v2 frontend would break every map and could persist all day.
- The GeoJSON `properties.zone_id` **disagrees with the name-derived zone number on 558 of
  154 290 zones**. The codec orders by name, which is what every consumer already treats as
  truth. Do not reach for `zone_id`.
- Coordinates are rounded to 7 dp (~1.1 cm at the equator) — far below display resolution,
  but it is a deliberate, bounded loss and the round-trip guard asserts against it.

---

## 10a-orig. The original measurement that justified this

Raised during review and initially parked. A subsequent nginx access-log capture of a real
operator page load promoted it to the top of the list.

**Measured from `/var/log/nginx/access.log`, one real `/scp_app` session (192 requests, 59.6 MB total):**

| response | size | share of page load |
|---|---|---|
| **`getBedsAndZones`** | **54.80 MB** | **92%** |
| `Map3D` JS chunk | 1.01 MB | 2% |
| `application_plan_diagnose` (×3) | 0.64 MB | 1% |
| everything else (188 requests) | ~3.1 MB | 5% |

For scale: `heatmaps_grid` was 13.98 MB before optimisation and 5.08 MB after — a hard-won
8.9 MB saving sitting next to a **54.80 MB** response six times larger, on the same page load.
And per §6.4 nginx does not compress JSON, so all 54.80 MB crossed the wire uncompressed.

Called by `ApplicationPlan.tsx:363`, `Heatmaps.tsx:279` and `HeatmapPoc.tsx:98` (client-cached
after first fetch, so once per session rather than per page).

Two independent fixes stack here:

| | fix | effort | result |
|---|---|---|---|
| **W1** | `gzip_types … application/json` (§6.4) | one nginx line | 54.80 MB → ~3–4 MB *(projected)* on the wire |
| **Z1** | zone encoding below | a task | 40.2 MB source → ~3.5 MB; with W1, ~0.4 MB on the wire |

It targets the **geometry** layer, not the aggregation layer, so it is independent of everything above.

**The observation:** beds are straight lines, so zone positions could be derived rather than stored.

**Measured on kaitet (154 290 zones with geometry, 17 914 beds):**

| property | result |
|---|---|
| zone N ends exactly where N+1 begins | **99.2%** |
| collinear with the bed's end-to-end line | **99.2%** (median deviation **0.000 cm**, p95 0.000 cm) |
| bed modal zone length | **4.0 m — all 17 914 beds** (not the assumed 3 m) |
| beds uniform ± one trailing remainder → encodable | **17 455 (97.44%)** |
| beds needing exact geometry retained | 459 (2.56%) |
| total zone geojson at source | **40.2 MB** (273 B/zone) |
| `getBedsAndZones` cold | **2.0 s** |

**Encoding** (note: *not* first + last + count — that assumes even division and misplaces the remainder):

```
per bed:   start_point · end_point · unit_len (4.0) · zone_ids[] · remainder_len
per zone:  nothing — position = start + direction × (index × unit_len)
```

*Projected* ~40.2 MB → ~3.5 MB (≈11×). Requires a build-time validator that checks each bed against its stored geometry and falls back to exact for any that fail, so new beds from `bed_zone_automation` can never be silently distorted.

**Does not help the dashboards.** The 13.65 MB `heatmaps_grid` payload is observation *counts* keyed by zone name — measured values, not positions, and not interpolable.

---

## 10b. What we actually built — results, failures, and the 300M projection

Everything below was measured on `kaitet.local` after implementation. Eight commits on
branch `kaitet`, plus one infrastructure change. Nothing is pushed.

### The architecture as implemented

```
MariaDB  SERVER                                    ║ BROWSER
   │                                               ║
   ├─►[L1] getScoutingEntriesChunk  UNCHANGED ═════╬═ 83.5 MB/wk ═► scouting-sync.ts ─► IDB
   │        (A2 not attempted — 5 pages still here)║         ◄ the big one, still open
   │                                               ║
   ├─►[L3] dashboard_aggregates  ★REWORKED         ║
   │    ├ ★covering child indexes (T2)             ║
   │    ├ ★warehouse_type predicate, no OR (T3)    ║
   │    ├ ★24 sorts given a total order (T2b)      ║
   │    ├ ★row cache split from chip filters (T5)  ║
   │    │   └ Redis scp:dash_agg:{ep}:{hash}       ║
   │    │     SHARED across users · TTL 60s ═══════╬═ ~2-30 KB gz ═► Dashboard · Trends
   │    └ ★heatmaps grid/detail split (T6) ════════╬═ 301 KB gz ═► Heatmaps grid
   │         └ ★heatmap_card_detail ═══════════════╬═ on card open ═► modal
   │                                               ║
   ├─╳[T4] STRAIGHT_JOIN — IMPLEMENTED, REVERTED   ║  (made this dataset 25% slower)
   │                                               ║
   └─►[geo] getBedsAndZones  UNTOUCHED ════════════╬═ 5.12 MB gz (55.4 MB raw) ═► maps
                                                   ║         ◄ 92% of the page load
   ★ nginx gzip now covers application/json ───────╫─ applies to EVERY row above
```

### What worked

| # | Change | Measured result |
|---|---|---|
| **W1** | nginx `gzip_types` now covers `application/json` | **61.2 MB → 5.48 MB** per page load (**11.2×**) |
| **T6** | Heatmap grid ships 1 date, modal fetches 3 | 13 981 KB → **5 080 KB** (−63.7%) |
| **T5** | Diagnose row cache split from chip filters | chip click **835 ms → 12.9 ms** (**65×**) |
| **T2b** | 24 sorts given a total order | **a real production bug fixed** — see below |
| **T2/T3** | Covering child indexes; `warehouse_type` predicate | child scan `ALL`→`index`; correct groundwork, **no measurable win here** |

### What failed

**T4 — forcing parent-first join order. Implemented, measured, reverted.**

`STRAIGHT_JOIN` flipped the plan exactly as intended, and made the benchmark **25% worse**
(16 998 → 21 254 ms). The cause is a property of the test data, not the change:

```
total_rows  in_window   pct     days_of_data
297 131     297 131     100.0%  13
```

kaitet holds 13 days, so the benchmark window selects **100%** of the table. With a
zero-selectivity date filter, driving from the parent scans everything to find rows that
all match anyway — worse than scanning the smaller child table. MariaDB's original
child-first choice was correct *for this data*.

**This also invalidated the original diagnosis.** The paper's headline evidence — "1 week
0.42 s, 60 days 0.43 s, so cost is independent of the window" — was confounded: both
windows return every row in a 13-day dataset. The inverted join was real (`EXPLAIN type=ALL`)
but not harmful here. That claim is withdrawn.

What survives: `STRAIGHT_JOIN` *does* win where a filter genuinely narrows the parent —
**340 ms → 150 ms** on a single-greenhouse query — and should win on production, where a
13-day window is ~2% of the table rather than 100%. **We cannot prove that on this dataset.**

### The bug that mattered more than the speed

Adding an index changed the scan order and moved 9 of 14 equivalence cases. Root cause:
**24 sorts and truncations picked arbitrarily among tied rows.**

```python
out.sort(key=lambda a: a["date"], reverse=True)
out.sort(key=lambda a: a["severity"] != "high")
return out[:n]                    # n = 8 — which 8? whichever the plan emitted first
```

Distribution: `_overview` 10, `_pests_diseases` 7, `_gh_detail` 4, `_fcm`/`_common`/
`_heatmaps`/`_traps` 3 each, plus zone `color`/`kind` (**28.4% of diagnose-map zones carry
≥2 observations**) and `_trends`' vocabulary interning, where first-seen row order decided
every integer ID in the payload.

**This is a live production bug.** MariaDB re-plans on its own as tables grow, so the top-8
alert list and the map's colours could change with no deploy and no code change.

Four of the 24 sites were invisible to grep. They were found by the acceptance test:
run the harness with the indexes **present, dropped, and restored**, and require
byte-identical output all three times. Enumeration would have missed a sixth of them.

### Sectional loading — partially, and capped

**Not implemented as sections.** Parallel fan-out exists (`ApplicationPlan.tsx:347` fires four
endpoints at once; `hydrateRange` fetches weeks concurrently), but pages still take one large
payload and slice it client-side.

Two ceilings must be raised before more fan-out helps, and neither has been:

| ceiling | measured | consequence |
|---|---|---|
| Browser connections/origin | **HTTP/1.1**, no `http2` | ~6 concurrent; a 7th section queues |
| Server worker pool | **`gunicorn -w 9`** | 9 concurrent requests for the **whole site** |
| Per-call overhead | **~40 ms** warm | 8 sections ≈ 320 ms of pure overhead |

Fanning one page out to 8 calls lets a single operator occupy 8 of 9 workers. Sectional
loading is safe *after* payloads are small, not before.

### Does one user's fetch warm the cache for everyone? — **Yes**

```
cache key : scp:dash_agg:overview:e4ad4daad53a2eec0313
user id in the key?  NO — shared across all users
store     : Redis (per-site), TTL 60s
```

The key is `(endpoint, filters)` only. User B calling the same dashboard within 60 s of user A
gets a **~3 ms** Redis hit instead of a **~5 000 ms** cold rebuild. That is a ~1 600× difference
and it is already live for every `dashboard_aggregates` endpoint.

Two caveats. The 60 s TTL means a quiet site is nearly always cold — this is the single
cheapest remaining tuning knob. And these endpoints carry **no permission checks**, so shared
caching is safe only because every authenticated user may already read every greenhouse's
aggregates (pre-existing posture, unchanged by this work).

### Will compression survive a deploy? — **Now yes; previously no**

The fix was applied by hand to `/etc/nginx/nginx.conf` and existed nowhere in the repo. A
deploy to a new production server would have silently lost it — no error, no log line, just an
11× slower site. Now shipped:

| artifact | purpose |
|---|---|
| `deploy/nginx/scp-compression.conf` | drop-in for `/etc/nginx/conf.d/` |
| `upande_scp/serverscripts/tests/check_compression.py` | post-deploy gate, **exit 1** when compression is off |

The check is verified against its negative case — with the directive removed it reports the
asset at 315 407 B and exits 1; restored, 97 577 B and passes.

### Measured compression, per endpoint (nginx level 5)

| endpoint | raw | gzipped | ratio |
|---|---|---|---|
| `getBedsAndZones` | 55.4 MB | **5.12 MB** | 10.8× |
| `heatmaps_grid` | 5 080 KB | **301 KB** | 16.9× |
| `application_plan_diagnose` | 618 KB | **27.9 KB** | 22.1× |
| `trends` | 145 KB | 31.0 KB | 4.7× |
| `overview` | 17.1 KB | 2.3 KB | 7.4× |
| **full page load** | **61.2 MB** | **5.48 MB** | **11.2×** |

**Compression fixes the wire, not the CPU.** The browser still parses 61.2 MB of JSON. That is
why zone encoding (§10a) matters independently — it removes the data, not just its transport.

### End-to-end: what happens at 300M scouting entries

Measured cost per parent row, from two real window sizes:

```
1 day    30 394 rows   overview 1 003 ms   33.0 us/row
13 days 297 131 rows   overview 4 922 ms   16.6 us/row      <- per-row cost falls (fixed overhead amortises)
```

Extrapolating **16.6 µs/row** — optimistic, because at 300M the working set no longer fits in
the buffer pool and per-row cost would rise:

| query shape at 300M (≈10 yrs at 600k/wk) | rows touched | projected | verdict |
|---|---|---|---|
| Site-wide, all history | 300 000 000 | **~83 min** | impossible — 40× past the 120 s HTTP timeout |
| Site-wide, 13-day window | ~1 100 000 | **~18 s** | unusable as a dashboard |
| **One greenhouse, 13-day window** | ~11 500 | **~0.2 s** | **fine — and flat as history grows** |
| Site-wide 13-day **via rollup** (33×) | ~33 000 | **~0.5 s** | **fine** |

**The conclusion is the architecture, not the hardware.** Nothing about 300M is survivable if a
request's cost scales with total history; everything about it is fine if each request is bounded
by one greenhouse-window or a rollup row count. That is exactly the S1/S2/S3 split in §5 — and
the two pieces that deliver it, **A2** and **A3**, are still unbuilt.

### Honest scorecard

| | status |
|---|---|
| Wire bytes | **solved** — 11.2× everywhere, deployable, self-checking |
| Aggregate correctness | **solved** — 24 nondeterministic sites, a real production bug |
| Heatmap payload | **solved** — −63.7% |
| Chip interaction | **solved** — 65× |
| Query time on this dataset | **unchanged** — and honestly unmeasurable here |
| Geometry payload (54.8 MB) | **untouched** — now the largest single item |
| Client-side replication (L1) | **untouched** — A2 not attempted |
| 300M readiness | **not yet** — needs A2 + A3 |

---

## 10c. End-to-end verification — the state as shipped

Everything below was re-run after the final `bench build --app upande_scp && bench restart`.

```
INFRASTRUCTURE
  frappe15-web / node-socketio      RUNNING (restarted)
  protocol                          HTTP/2
  JS bundle                         content-encoding: gzip
  docs page                         HTTP 200

CHECKS  (all exit 0)
  check_compression                 passed
  check_agg_cache                   3 passed
  equivalence.verify                14 passed, 0 failed, 0 missing
  check_scope                       5 passed
  check_diagnose_cache              1 passed
  check_card_detail                 2 passed
  check_zone_encoding               0 mismatches / 154 290 zones
  check_zone_encoding (served)      0 mismatches / 1 500 zones, 1 440 beds
```

### Measured, browser-observed, start to finish

| | at the start | now |
|---|---|---|
| page load, on the wire | **59.6 MB** | **1.14 MB** |
| `getBedsAndZones` | 54.80 MB raw | **1.08 MB wire / 5.13 MB raw** |
| `heatmaps_grid` payload | 13 981 KB | **5 080 KB** |
| slowest trivial API call | 5.08 s (queued) | **425 ms** |
| cumulative API time / page | 32.07 s | **18.79 s** |
| `getBedsAndZones` parse | 245.4 ms | **94.1 ms** |
| chip click (ApplicationPlan) | 835 ms | **12.9 ms** |
| dashboard warm hit | recomputed every 60 s | **3.4 ms, held 30 min** |

**~52× less data over the wire.** Three of those wins came from things that were never about query optimisation at all: compression that was silently disabled, a protocol setting, and a payload full of fields nobody read.

### What did NOT improve, stated plainly

**Dashboard cold query time is unchanged** — `TOTAL COLD` 16 998 ms → 16 890 ms. The covering indexes and the `warehouse_type` predicate are correct groundwork, but kaitet holds 13 days and the benchmark window selects 100% of the table, so no date filter is selective and there was nothing for them to win. Forcing the join order (`STRAIGHT_JOIN`) was implemented, measured 25% *worse*, and reverted.

The cold path is now *rare* (debounced invalidation, 30-min TTL) rather than *cheap*. Making it cheap is still open — see R4 below.

---

## 10d. Recommendations — what to do next, in order

### Immediate (hours, no new machinery)

| | action | evidence |
|---|---|---|
| **R1** | **Prewarm the aggregates after every deploy/restart.** A `daily_prewarm`/`hourly_prewarm` pair already exists (`hooks.py:286,293`) but warms the *scouting week payloads*, not the dashboards. Add the aggregate endpoints. | cold 4 856 ms vs warm 3.4 ms — **1 400×**. The first operator after a restart currently pays full price on every dashboard. |
| **R2** | **Repoint `redis_socketio` off port 13000.** It currently shares the `allkeys-lru` cache instance with application payloads. | Harmless at 7 MB of a 1.17 GB budget today; under live-sync it means cache pressure can evict socket state. One config line. |
| **R3** | **Re-run `check_compression` in the deploy pipeline.** It exits 1 when compression is off. | The fix lived only in `/etc/nginx/nginx.conf` for a day and would have vanished on the first deploy — 11× regression, no error, no log line. |

### Near term (days)

| | action | evidence |
|---|---|---|
| **R4** | **Cold dashboard time — deprioritised after measurement.** See the correction below; the cheap wins here are not real. | Warm is 3.4 ms and the debounce makes cold rare. Only a genuine refactor of `_build` moves it, for ~2×. |
| **R5** | **Same treatment for `heatmaps_grid`** (4 839 ms cold) if it shows the same shape. | Second-largest cold cost. |
| **R6** | **Fix the patch trap.** `add_scouting_indexes.py` was edited after its first run, so its `scouting_crop_idx` was never created and never will be. | Frappe records patches in `tabPatchLog` and never re-runs one. Any index appended to that file today is dead code. |

### Correction: where `overview`'s cold time really goes

An earlier draft of R4 claimed `load_thresholds` was a 324.8 ms N+1 worth ~418×. **That measurement was wrong** — it was taken in a fresh `bench execute` process and was dominated by one-time `Crop Scouted` doctype-meta loading, not by the N+1. Measured correctly, with meta already warm:

```
load_thresholds (true per-request cost)    1.90 ms
```

The N+1 was fixed anyway (21 round trips → 3; `overview` 28 SQL statements → 7, commit `f34c55d`) because fewer round trips scale better — but it produced **no wall-clock improvement**, and the claim that it would was an artifact of the harness.

The real distribution, measured per statement:

```
overview cold      4 894 ms   (7 SQL statements)
SQL total          3 635 ms
   1 395 ms  _observation_rows          — the 201k-row UNION
   1 063 ms  COUNT(DISTINCT scouts_name) KPI
   1 041 ms  _recent_activity
     133 ms  zone counts
  ~1 260 ms  Python
```

**Three independent heavy queries, each scanning the same date range.** There is no single hot spot and no plan pathology — it is three full passes over the same 200k joined rows. The only structural lever is merging them into one pass, which is a real refactor of `_build` with genuine risk of changing output, for an optimistic 4.9 s → ~2.5 s.

**Deprioritised.** Warm is 3.4 ms; the debounced invalidation makes cold rare. Halving a rarely-hit path is poor value against R7.

**Method note worth keeping:** never quote a timing taken in a cold `bench execute` process. Frappe loads doctype metadata lazily on first touch, and that one-time cost can dwarf the thing being measured. Warm the path once, then measure.

### The real remaining work (weeks)

| | action | evidence |
|---|---|---|
| **R7** | **A2 — retire the client-side dataset replication.** `scouting-sync.ts` still downloads **83.5 MB per ISO week, site-wide, unfiltered** into IndexedDB for five pages (`RoseScouting`, `Observations`, `TrapsMap`, `AvocadoHeatMap`, `AvocadoTreeMap`). | Untouched by all of this work. It is the last unbounded thing in the system and the one that actually blocks 300M. |
| **R8** | **A4 — room-scoped realtime.** `publish_scouting_dirty` broadcasts site-wide on every write; every client then refetches. | O(writes × clients). At 600k/week with 50 users that is ~150 refetches/second. Frappe gives permission-checked rooms free via `doc_subscribe`. |
| **R9** | **A3 (rollup) — only for additive measures.** | **Measured non-viable as originally scoped.** Severity is *"% of zones affected"*, a `COUNT(DISTINCT zone)` over the window, and distinct counts are not additive: for Mealybugs in one greenhouse the true figure is **2 001 zones** while summing per-day distincts gives **2 743** (+37%). A dated rollup would inflate every severity band. Zone grain compresses only 1.21×, so the exact version buys nothing. |

### Correctness and posture, found along the way

| | finding |
|---|---|
| **R10** | **The aggregate endpoints have no permission checks.** Every `dashboard_aggregates` method is `@frappe.whitelist()` with scope taken purely from arguments, so any authenticated user can read any greenhouse's data. Pre-existing, unchanged by this work — but it is also *why* the shared Redis cache is safe, so the two must be decided together. |
| **R11** | **The published docs page is unauthenticated.** `/scp-docs/` is served by nginx before Frappe's auth. Basic auth is two lines if that matters. |
| **R12** | **Data inconsistency: `zone_id` vs zone name.** The GeoJSON `properties.zone_id` disagrees with the name-derived number on **558 of 154 290 zones**. Everything treats the name as truth; the codec does too. Worth reconciling at source. |
| **R13** | **Zone length is 4.0 m, not 3 m.** All 18 472 beds have a 4.0 m modal segment. If 3 m is the documented spec, the field data has diverged from it. |
| **R14** | **Two open product questions on zone colour.** Should it be the *dominant* observation by count — which `upright-svg.ts:19` already claims it is — and should pests outrank diseases at all? The latter is currently an accident of list concatenation order, not a decision. Affects 28.4% of diagnose-map zones. |

### What NOT to spend time on

- **Sectional loading**, until R7 lands. With `gunicorn -w 9`, fanning a page into 8 parallel calls lets one operator occupy 8 of 9 workers. HTTP/2 removed the *client* ceiling; the server one remains.
- **A rollup for severity** — see R9. The arithmetic does not work.
- **Chasing dashboard query time on kaitet.** The dataset is 13 days and every window selects 100% of it, so it cannot measure selectivity. Any conclusion drawn there will not transfer to production.

---

## 11. Explicitly not doing

| | why |
|---|---|
| Zone-grained summary table | Measured 1.21× compression. All the cost, none of the benefit. |
| Denormalising `greenhouse`/`date` onto child tables | Only needed if A1 underperforms. Don't pay for it speculatively. |
| Columnar offload now | A2+A3 hold past 30M. Revisit at ~100M. |
| Postgres for parallel counts | `dataload.md` is right that it's the honest answer to "can counting go faster", and right that switching engines to fix counting is not worth it. A3 removes the question. |
| Narrowing date windows / capping zones | Violates the invariant — that's a display change. |

---

## 12. Decisions needed before a spec

1. **Live sync scope** — does every view get delta streaming, or only the heatmaps and dashboards a supervisor keeps open? This sets how much of A4 is in v1.
2. **Freshness for non-live views** — is a few minutes' lag acceptable on the dashboards, or must everything be sub-second? Decides T2 TTLs and whether A3 is incremental-on-write or scheduled.
3. ~~**`greenhouse` vs `block`**~~ — **RESOLVED.** The two columns are mutually exclusive across the entire table, and the discriminator is the scope's `warehouse_type`, not the crop:

   | filtered via | `warehouse_type` | distinct locations | entries |
   |---|---|---|---|
   | `se.greenhouse` | Greenhouse | 97 | 293 769 |
   | `se.block` | Block | 55 | 3 362 |

   Zero rows carry both columns, zero carry neither. **Rule: `Block` → filter `se.block`; everything else → `se.greenhouse`.** Deliberately keyed on warehouse type rather than crop, for two reasons: 2 775 entries have `crop_scouted = NULL` and use `greenhouse`, so a `crop == "Rose" ? gh : block` test would silently drop them; and Coffee then works the day it lands without touching the query layer. The lookup is free — `get_units_by_warehouse()` already builds this map and caches it under `K_SM_UNITS_BY_WH` for 24h, so it is a dict hit, not a query.
4. **Migration order for A2** — which page hurts most in daily use: `Observations`, the Rose heatmap, or `TrapsMap`? First one migrated proves the pattern and the harness.
5. **Redis instance policy** — is raising `maxmemory` above 1.17 GB available on the target hardware, or do we design strictly to the current budget? (§7 rule 2 means we can live within it either way; this only affects headroom.)
6. **Own Redis instance?** (§6.3) — my recommendation is yes, but for blast-radius rather than capacity, and only once T2 exists. Do you want it provisioned up front instead, so there is one migration rather than two?
7. **Green light for the §6.4 config changes?** They edit the nginx config that also serves live `kaitet.132.145.21.55.nip.io`. Low risk (`nginx -t` then reload, no restart), high payoff, but it touches a running production host — so your call, not mine.
