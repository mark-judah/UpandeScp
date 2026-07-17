# Avocado shared tree-map — reuse for Observations & Traps (+ rename)

**Date:** 2026-07-16
**Status:** Design approved, pending spec review
**Area:** `upande_scp` frontend — avocado map views (`AvocadoMap.tsx`, new `AvocadoTreeMap` shell, `App.tsx` routing, `AppSidebar` nav labels)

> Sub-project #1 of a 3-part avocado map effort. #2/#3 (a "Heat maps" page = 2D
> red→green gradient view + optional planning sidebar, replacing the grid
> Heatmaps and the Job Sheets placeholder for avocado) reuse the shell this
> sub-project extracts, and get their own spec later.

## Problem

Avocado's **Observations** and **Traps** views currently render the rose Leaflet
zone map (`MapBase`), which is greenhouse/bed/zone-shaped. Avocado has
blocks/rows/**trees**, so those views don't fit the crop. The avocado-native map
is the 3D tree map (`Map3D` + `TreesLayer`), but it only powers the Scouting Map
today, and its heading reads "Avocado · 3D".

## Goal

- Render avocado **Observations** and **Traps** on the shared 3D tree map, from
  the **same cached scouting fetch** (no new endpoints).
- Extract the map machinery now living in `AvocadoMap.tsx` into one reusable
  **`AvocadoTreeMap`** shell so Scouting / Observations / Traps (and later the
  Heat maps page) are thin wrappers over it.
- Drop "· 3D" from headings.

## Non-goals

- The **Heat maps page** (#2/#3) — separate spec. This sub-project only makes the
  shell reusable and adds the Observations + Traps modes.
- **Rose** Observations/Traps (Leaflet) — untouched; they stay as-is for rose.
- **Backend** — no changes. Everything derives from the existing `useScouting`
  payload (entries carry `latitude`, `longitude`, `block`, `row`, `tree`,
  `scouts_name`, `pests_scouting_entry`, `diseases_scouting_entry`,
  `trap_scouting_entry`) and the lean orchard-tree points.

## Architecture

### `AvocadoTreeMap` — the reusable shell (new component)

Extract from `AvocadoMap.tsx` into `frontend/src/pages/avocado/AvocadoTreeMap.tsx`.
It owns everything that is view-independent:

- `MapHeader` (farm/greenhouse/date filters + single-farm auto-select), the
  legend/count bar, the `Map3D` canvas + `TreesLayer`, the block/tank layers and
  the Layers menu (boundaries/tanks default off), the `LoadingOverlay`, the
  docked right-side panel container, and the fetches it already does:
  `useScouting` (cached), `fetchOrchardTreeRows` (tree points),
  `fetchBlocksGeojson`/`fetchTanksValvesGeojson`.

It renders per a **view descriptor** the wrapper supplies:

```ts
interface MarkerPoint {
  lng: number;
  lat: number;
  count: number;          // drives sqrt-scaled radius
  color: string;
  label?: string;         // popup / a11y
}

interface AvocadoView {
  title: string;
  subtitle: string;
  /** Per-tree tint from the cached entries. Empty map → all trees unscouted. */
  deriveColors: (data: ScoutingData) => Map<string /*treeName*/, string /*hex*/>;
  /** Optional point overlay (traps). Omit for tree-only views. */
  deriveMarkers?: (data: ScoutingData) => MarkerPoint[];
  /** Docked side-panel content (roster / legend / trap list). */
  renderPanel: (data: ScoutingData) => ReactNode;
  /** Optional controls for MapHeader's rightSlot (e.g. pest/disease toggle). */
  headerControls?: ReactNode;
}
```

- `deriveColors` feeds `TreesLayer` exactly as today (`updateColors`), so
  culling / LOD / the 2D-vs-3D behaviour are unchanged.
- `deriveMarkers` renders as a **MapLibre circle layer** over the trees — the
  same layer pattern as the existing tank dots, with radius sqrt-scaled by
  `count` and paint by `color` (mirrors the rose `TrapsMap` marker scaling).
  Absent → no marker layer added.
- The derivations are **pure functions** (data → colors/markers), unit-testable
  without the map.

`ScoutingData` is the existing `useScouting` `data` shape (`{ entries, … }`).

### The three views become thin wrappers

Files under `frontend/src/pages/avocado/`:

1. **`AvocadoScouting`** — the current `AvocadoMap` behaviour on the shell:
   `deriveColors` = per-scout palette colour of each visited tree (today's
   `treeColors`); `renderPanel` = the scout roster; title "Scouting Map".
   (`AvocadoMap.tsx` is refactored into this wrapper + the shell.)
2. **`AvocadoObservations`** — `deriveColors` = each scouted tree tinted by the
   **canonical colour of the dominant observation** on it (via
   `useObservationColors` → `pestColor`/`diseaseColor`, defaulting to
   `OBS_DEFAULT_COLOR`), for the active **kind** (pest | disease);
   `headerControls` = a pest/disease pill toggle (kind state lives in this
   wrapper); `renderPanel` = observations of that kind with per-name counts.
   Title "Observations".
3. **`AvocadoTraps`** — `deriveColors` = empty/faint (trees plain); `deriveMarkers`
   = trap catches aggregated from `trap_scouting_entry` by `latitude`/`longitude`
   (count = summed catches, colour = severity stop), reusing the rose
   `TrapsMap` aggregation + severity scale; `renderPanel` = traps ranked by
   catch count. Title "Traps".

Per-view derivations live in small pure modules
(e.g. `avocado/derive-observations.ts`, `avocado/derive-traps.ts`,
`avocado/derive-scouts.ts`) so they're testable and the wrappers stay declarative.

### Routing + nav labels

- `App.tsx`: mirror the existing scouting-map split for the two views —
  ```
  view === "observations": crop === "rose" ? <Observations …/> : <AvocadoObservations/>
  view === "traps":        crop === "rose" ? <TrapsMap …/>     : <AvocadoTraps/>
  view === "scouting-map": crop === "rose" ? <RoseScouting/>   : <AvocadoScouting/>
  ```
  (Rose keeps its Leaflet components; the crop is fixed by the route.)
- Headings: **"Scouting Map" / "Observations" / "Traps"** — no "· 3D" anywhere
  (fixes the `AvocadoMap` `MapHeader` `title="Avocado · 3D"`).
- `AppSidebar` `AVOCADO_NAV` labels already read "Scouting Map / Observations /
  Traps" — no nav change needed for #1.

## Data flow

```
useScouting(filters)  ─┐
fetchOrchardTreeRows ──┼─▶ AvocadoTreeMap
fetchBlocks/Tanks ─────┘        │  view.deriveColors(data) ─▶ TreesLayer.updateColors
                                │  view.deriveMarkers(data) ─▶ circle layer
                                └─ view.renderPanel(data)   ─▶ docked panel
```

All views share one `useScouting` cache entry per filter set, so switching
Scouting ↔ Observations ↔ Traps (kept mounted via keep-alive) refetches nothing.

## Edge cases

- **No scouting in the window** → empty colors (all trees unscouted), empty
  marker layer, panel shows an empty state. Map + trees still render.
- **Entry without a tree / without coords** → skipped in derivations (as the
  current scout-color memo already does).
- **Trap catch without lat/lng** → skipped (rose `TrapsMap` already guards this).
- **"All Farms"** → no trees load (existing behaviour); single-farm auto-select
  already lands avocado on Lokitela.

## Testing

- **Unit (pure derivations)** — Vitest:
  - `deriveScoutColors`: trees tinted per scout; palette by first-seen order.
  - `deriveObservationColors`: dominant pest/disease → canonical colour;
    default colour when none; respects kind (pest vs disease).
  - `deriveTrapMarkers`: catches aggregated by coordinate; count summed;
    entries without coords dropped; radius/colour scale as specified.
- **Manual** — on the avocado map: Observations tints trees by pest/disease and
  the kind toggle flips it; Traps shows sized catch markers with plain trees;
  Scouting Map unchanged; all headings read without "· 3D"; switching between
  the three refetches nothing (keep-alive) and the map doesn't re-init.

## Rollout

- Frontend-only; build the SPA + `clear-cache`. No fixtures/migrations.
- `AvocadoMap.tsx` is replaced by `AvocadoScouting` + `AvocadoTreeMap`; keep the
  route/import swap in one change so nothing dangles.
- The shell is the reuse point for the #2/#3 Heat maps page (a red→green
  `deriveColors` gradient mode in a 2D/top-down camera + a planning sidebar).
