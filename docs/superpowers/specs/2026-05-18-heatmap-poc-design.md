# Heatmap Rendering POC

## Status
Throwaway proof-of-concept. Validates the bed-symbol-instance rendering
approach before committing to the full Heatmaps migration.

## Goal
Measure how long it takes to render last-3-scouting-days of one
greenhouse × one observation as three side-by-side bed plots using
prerendered bed paths and `<use>`-instanced markers. Compare against the
current `Heatmaps.tsx` path for the same greenhouse.

## Scope
- One route: `/scp_app#poc-heatmap` (or a dev-only nav button).
- Hard-coded URL hash params: `gh=<greenhouse>&obs=<name>&kind=pest|disease`.
- No card grid, no filter row, no modal — just three SVG panels and
  a console-logged timing record.
- Geometry comes from the existing `fetchBedsAndZones` endpoint (already
  cached aggressively). New code only ports the projection math into a
  single SVG-emitting client component.
- Observations come from a new minimal server endpoint that hits MariaDB
  once for the chosen greenhouse + obs.

## API

```
upande_scp.serverscripts.dashboard_aggregates.heatmap_poc
  (greenhouse, obs_name, obs_kind="pest")
  → { greenhouse, obsName, obsKind, color,
      recent: [{ date, zoneObs: { "<zone>": count } } × ≤3, newest first] }
```

`color` resolves from the Pest / Plant Disease doctype's legend field
with a canonical fallback (reuse `_cached_pest_colors` /
`_cached_disease_colors` from `get_complete_scouting_entries.py`).

`recent` is built from one SQL: join `tabScouting Entry` × the relevant
child table, filter by greenhouse + obs, group by `(date_of_capture,
zone)`, take the three most-recent distinct dates.

Cached under `scp:dash_agg:heatmap_poc:<filter_hash>` with 60s TTL —
reuses `cached_aggregate` from `_common.py`.

## Frontend

**New files:**
- `frontend/src/pages/maps/MarkerDefs.tsx` — `<defs>` block with four
  `<symbol>` entries (pest circle, disease triangle, trap square, fcm
  star) plus an exported `MARKER_ID` const map.
- `frontend/src/pages/maps/BedSvg.tsx` — receives projected `beds` (one
  path per bed) and `markers` (`{cx, cy, kind, color}` list). Renders
  one `<svg>` with the bed paths in `<defs>` and `<use>` instances per
  marker. No state.
- `frontend/src/pages/HeatmapPoc.tsx` — reads the URL hash params,
  fetches geometry via `fetchBedsAndZones`, projects once via a slimmed
  local helper (drops the per-zone polyline output that
  `buildGreenhouseUprightSvg` currently emits), calls `heatmap_poc`,
  renders three `BedSvg` panels, and emits one `console.log("[poc-timing]", ...)` per render.

**Routing:**
- `App.tsx` checks `window.location.hash === "#poc-heatmap"` on mount
  and renders `HeatmapPoc` instead of the normal view. Cheapest possible
  wiring — no router lib changes.

## Timing record

```js
console.log("[poc-timing]", {
  fetch_ms,        // network roundtrip
  parse_ms,        // JSON.parse on the response body
  first_paint_ms,  // requestAnimationFrame after the panels mount
  full_ready_ms    // request sent → onscreen rendered
});
```

## Comparison protocol

1. Open `/scp_app` (regular Heatmaps page), select the same greenhouse
   and observation, time how long until the relevant card renders.
2. Open `/scp_app#poc-heatmap?gh=<...>&obs=<...>&kind=pest`, read the
   POC timing record.
3. Decide whether the full Heatmaps migration is justified.

## Out of scope
- Card grid, modal, filter row.
- Server-side projection math (deferred unless POC numbers say it's needed).
- Caching geometry differently from the existing `fetchBedsAndZones`
  path.
- Any cleanup of `UprightHeatmap.tsx` or `upright-svg.ts` — POC is
  additive only.

## Risk
The "lines prerendered" win is purely a render-side optimization. If
the bottleneck turns out to be the projection math (one CPU pass over
all the zone LineStrings), the POC will surface that — we'll see a
large `full_ready_ms - fetch_ms - parse_ms` gap and know to move
projection server-side in the real migration.
