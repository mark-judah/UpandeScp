# Heatmaps Bed-Symbol Migration

## Status
Validated by the POC at `docs/superpowers/specs/2026-05-18-heatmap-poc-design.md`
— 350 ms end-to-end per greenhouse, 78 ms client-side projection for ~400
beds / ~2,800 zones. This spec extends the POC to the full page.

## Goal
Replace the existing `/scp_app#/heatmaps` data layer (raw entries via
`useScouting`) and render layer (`UprightHeatmap` + `upright-svg.ts`)
with one server endpoint and `BedSvg`. Keep the filter bar, mode toggle,
obs picker, card grid, and click-to-modal interactions exactly as they
are today; only the bytes flowing through change.

## Architecture

```
                          MariaDB
                                ▲
                                │ one GROUP BY parent.greenhouse,
                                │ child.<pest|disease>, parent.date,
                                │ parent.zone
                                │
                  upande_scp.serverscripts.dashboard_aggregates._heatmaps
                  heatmaps_grid(from, to, crop, farm?, greenhouse?, mode,
                                obs_name?, job_id?)
                                ▲
                                │ cached_aggregate (TTL 60 s)
                                │ key: scp:dash_agg:heatmaps_grid:<hash>
                                │
                  React Heatmaps page
                  - fetches geometry via fetchBedsAndZones (24 h cache)
                  - projects each greenhouse once via bed-projection.ts
                  - card grid renders BedSvg thumbnails
                  - modal renders 3-day strip (re-uses POC layout)
```

## API

```
upande_scp.serverscripts.dashboard_aggregates.heatmaps_grid
  request:
    {
      from_date, to_date,
      crop,                      # "" = no crop filter
      farm,                      # "" = all
      greenhouse,                # "" = all
      mode: "pest" | "disease",
      obs_name?,                 # "" / absent = all pests-or-diseases
      job_id?,                   # progress events on scp:dash_agg:progress
    }
  response:
    {
      cards: [
        {
          greenhouse: str,
          obsName: str,
          obsKind: "pest" | "disease",
          color: str,             # legend hex + fallback
          totalObs: int,
          zonesAffected: int,
          lastDate: str,
          recent: [               # ≤3, most recent first
            { date, zoneObs: { "<zone>": count } }
          ],
        }
      ]
    }
```

Cards are sorted: most-active first, then by greenhouse / obsName
alphabetically. Cards with zero observations are dropped (same as today).

### SQL shape

Single query joins `tabScouting Entry` with the relevant child table
(`tabPests Scouting Entry` or `tabDiseases Scouting Entry`), filters on
the request params, groups by `(greenhouse, obs_name, date, zone)`. The
endpoint then walks the result rows once in Python to build cards and
pick the three most-recent dates per (greenhouse, obs).

## Frontend changes

**Refactor `frontend/src/pages/Heatmaps.tsx`:**

- Drop `useScouting`, `obsOptions` derivation from entries, `buildCards`,
  `indexZonesByGh`, `LoadingOverlay`, and the per-entry filter pass.
- Add `useDashboardAggregate<HeatmapsGridPayload>("heatmaps_grid", filters)`.
  The progress overlay used by the dashboard tabs renders during cold
  computes (re-uses `ProgressOverlay` from the Dashboard migration).
- Geometry: `fetchBedsAndZones` once on mount, then `projectGeometry`
  per-greenhouse — but only for greenhouses that appear in the cards.
  Memoize on the greenhouse name so switching modes/filters doesn't
  re-project.
- Card grid: each card body becomes a `BedSvg` thumbnail with markers
  drawn from `recent[0].zoneObs` only (most recent date — gives a
  glance-able snapshot; older days surface in the modal).
- Modal: three side-by-side `BedSvg` panels driven by `picked.recent[0..2]`.
- The existing obs picker keeps its "all pests in scope" list — the
  options come straight from `cards.map(c => c.obsName)` instead of
  from per-entry scanning.

**Markers:**

For the full page we keep the POC's marker simplification:
- `pest` → circle (`MARKER_ID.pest`)
- `disease` → triangle (`MARKER_ID.disease`)
- Fill from the doctype's legend hex (with canonical fallback).

The full FCM/trap shapes ship in `MarkerDefs` already but Heatmaps only
ever renders pest or disease — the unused symbols are dead weight in the
defs block, ~80 bytes total, not worth excluding.

**Geometry sharing:**

The 78 ms-per-greenhouse projection cost adds up if we render 30+ cards
for the same greenhouse (different obs). Memoize `projectGeometry` keyed
on the greenhouse name (or, more precisely, on the zone-array reference
the helper returns). One projection per visible greenhouse, used by every
card that targets it.

## Caching

Same pattern as the Dashboard endpoints:

- Key: `scp:dash_agg:heatmaps_grid:<filter_hash>`
- TTL: 60 s
- No `K_SCOUTING_PAYLOAD_VERSION` stamp on the key — TTL bounds staleness;
  realtime push on `scp:scouting:dirty` triggers client refetch.
- `force=1` arg available, hooked to the page's Reload button.

## Progress events

Reuse `scp:dash_agg:progress` and the `publish_progress(job_id, percent,
label)` helper. Step weights:

```
filter resolution   5%
counting parents    20%
loading obs rows    65%   ← biggest single step on a busy site
building cards      90%
done                100%
```

## Acceptance

- Cold load (filtered to no specific greenhouse, default 14-day range,
  ~500 k entries in scope, ~100 greenhouses × multiple obs each):
  **under 5 s** wall-clock.
- Warm: **under 300 ms**.
- Cards: same set as today, in the same order, with identical numbers
  (totalObs / zonesAffected / lastDate). Markers drawn at the same zone
  positions as the old `UprightHeatmap` per-zone polylines (just rendered
  as instanced shapes instead of coloured line segments).
- Modal: the 3-day strip renders the same dates as today, with markers
  at the same zones.

## Cleanup

Files deleted once the new page is verified:

- `frontend/src/components/UprightHeatmap.tsx`
- `frontend/src/pages/maps/upright-svg.ts`
- `frontend/src/pages/HeatmapPoc.tsx`
- `upande_scp/serverscripts/dashboard_aggregates/_heatmap_poc.py`
- The POC route block in `App.tsx` (the `usePocHashMatch` helper and the
  `HeatmapPoc` lazy import).
- The `heatmap_poc` whitelisted entry in `dashboard_aggregates/__init__.py`.

Files retained:
- `bed-projection.ts` — pure helper, used by the production page.
- `BedSvg.tsx` — replaces `UprightHeatmap.tsx`.
- `MarkerDefs.tsx` — already production-ready, exported as `MARKER_ID`.

## Risks

- **Card volume.** A busy site with no obs filter can produce 500–1000
  cards (100 greenhouses × 5–10 obs each). At ~400 ms initial cold compute
  we should be fine, but DOM weight of that many BedSvgs is 4–8 MB of
  SVG nodes. If scroll is choppy we can add a `<IntersectionObserver>` so
  off-screen cards don't render until they enter the viewport — that's a
  follow-up if profiling demands it.
- **Geometry endpoint.** `fetchBedsAndZones` returns all bed/zone GeoJSON
  for the whole tenant in one payload. We're not changing that here, but
  it's the single biggest fixed cost on first visit (~few MB gzipped,
  cached 24 h after). The dashboard work already paid this cost for the
  greenhouse filter dropdowns, so the Heatmaps page reuses the warm cache.
- **Label collision.** `BedSvg` currently labels every 7th bed; for beds
  whose leftmost point isn't in the gutter the label can land on top of
  the line. The POC accepted this; if the production page needs the
  label-slot system from the old `upright-svg.ts`, port it then.

## Out of scope

- The full upright-svg label-slot system (multi-block left-gutter + corridor
  slots round-robin). Defer until visual review shows it's needed.
- Server-side projection. The 78 ms client-side cost per greenhouse is
  comfortably within budget; moving projection server-side would save it
  but cost an SVG-emitter port to Python — not worth the engineering at
  this scale.
- Materialized daily-summary table for the heatmap aggregations. Only
  worth doing if cold-compute times prove painful in production.
