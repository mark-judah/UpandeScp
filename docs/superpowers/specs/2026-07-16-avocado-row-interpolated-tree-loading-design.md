# Avocado map — row-interpolated tree loading

**Date:** 2026-07-16
**Status:** Design approved, pending spec review
**Area:** `upande_scp` avocado 3D scouts map (`frontend/src/pages/AvocadoMap.tsx`, `maps/TreesLayer.ts`, `serverscripts/get_orchard_trees.py`)

## Problem

The avocado map draws every orchard tree (53,699 trees on farm *Lokitela*, 77 blocks,
1,870 rows). Even after the lean "points" endpoint (`get_orchard_tree_points`, ~3.6 MB
vs the old 17.3 MB GeoJSON) the payload is dominated by shipping a coordinate for
**every** tree. Fetch + parse is the remaining load cost.

Trees are planted in straight rows, ~5 m apart, numbered `1..N` per row. So a row's
interior tree positions are derivable from its two endpoints — we don't need to send
them. This is the optimization.

## Goal

- **Faster loading**: shrink the tree payload from ~3.6 MB to tens of KB by sending
  per-row endpoints instead of per-tree coordinates, and reconstructing interior trees
  on the client.
- Stack on top of the existing culling + per-tree LOD (unchanged).

## Non-goals

- **Not** reducing the number of *rendered* trees. All ~53.7k trees still render,
  still culled/LOD'd by `TreesLayer` exactly as today. This is purely a load/parse win.
- **No change** to `TreesLayer` (culling, LOD, coloring), the scouting data flow, or
  per-scout tree coloring.

## Grounding data (measured 2026-07-16)

Every row was analysed for collinearity (perpendicular deviation from the T1→TN line)
and spacing uniformity:

- All 1,870 rows have `tree_number` contiguous `1..N`, starting at 1, no gaps, no dups.
  (An earlier "gaps" reading was a bug: `tree_number` is stored as text, so SQL
  `MIN/MAX` compared it lexically.)
- **1,860 / 1,870 rows are perfectly linear** — every tree within **0.5 m** of the
  straight endpoint line, evenly spaced. Interpolation reproduces them exactly.
- **10 / 1,870 rows are irregular** — all in `AIRSTRIP BLK 10`. They are still perfectly
  collinear (`maxdev = 0.0 m`) but have a large **spacing gap** in the middle
  (40–130 m vs the ~5–8 m norm): the real-world *obstacle* case (a hill leaves a gap;
  trees cluster on each side but stay numbered `1..N`).
- Tree names are deterministic: `56HA_AIRSTRIPBLK1_ROW1_T10` = `<prefix>_ROW<r>_T<n>`,
  and `name == tree_code`. `Scouting Entry` references a tree by its `tree` (the
  Orchard Tree name); it also carries `block` and `row`.

Implication: interpolation is exact for 99.5% of rows; the ~10 obstacle rows must be
sent explicitly so trees aren't smeared across the gap ("ghost trees on the hill").

## Design

### Overview

A new lean endpoint returns, per (block, row), **either** endpoints (for uniform rows)
**or** explicit coordinates (for irregular rows), auto-classified server-side. The
client expands rows into the exact `{ names, coords }` shape `TreesLayer` already
consumes. `TreesLayer` and all downstream code are untouched.

```
Orchard Tree (DB)
   │  group by (block,row), order by tree_number
   ▼
get_orchard_tree_rows(farm|block)   ← new, Redis-cached
   │  per row: classify LINEAR vs EXPLICIT
   ▼  { rows: [ {k:"l", p, a, b, n} | {k:"e", p, c, n} ] }   (tens of KB)
fetchOrchardTreeRows()  →  expandTreeRows()   ← new client helpers
   ▼  { names:[…], coords:[…] }   (OrchardTreePoints — unchanged shape)
TreesLayer (unchanged)  →  culling + LOD + per-scout colour
```

### Backend — `get_orchard_trees.py`

New whitelisted endpoint `get_orchard_tree_rows(block=None, farm=None)`, mirroring the
existing `get_orchard_tree_points` (same block/farm resolution, same Redis caching).

Row builder, per (block, row) ordered by `CAST(tree_number AS UNSIGNED)`:

1. Parse each tree's coordinate from `geojson` (reuse the existing coordinate
   extraction used by `_points_from_trees`).
2. Derive the **name prefix** `p` from tree 1's name by stripping its trailing
   `tree_number` (e.g. `…ROW1_T1` → `…ROW1_T`). Verify `p + str(N) == last_tree.name`;
   if the names don't fit the pattern, treat the row as EXPLICIT **with an explicit
   `names` array** (safety — never emit a wrong name).
3. **Classify** the row by whether even interpolation reproduces it:
   for each tree *i* (1-based), compare its real position to
   `lerp(a, b, (i-1)/(N-1))`; let `maxerr` = max distance (meters, via local
   equirectangular scale).
   - `maxerr ≤ POS_TOL` (default **1.5 m**) → **LINEAR**.
   - otherwise → **EXPLICIT**.
   Rows with `N == 1` → EXPLICIT (single coord). `N == 2` → LINEAR (a, b).

Row shapes (JSON):

```jsonc
// LINEAR — interior trees interpolated on the client
{ "k": "l", "p": "56HA_AIRSTRIPBLK1_ROW1_T", "a": [lng, lat], "b": [lng, lat], "n": 80 }

// EXPLICIT — coords shipped verbatim (obstacle rows, odd names, N==1)
{ "k": "e", "p": "56HA_AIRSTRIPBLK10_ROW14_T", "c": [lng, lat, lng, lat, …], "n": 38 }
// If names don't match the prefix pattern, add "names": ["…", …] and omit "p".
```

Return `{ "rows": [ … ] }`. Endpoint returns `{ "rows": [] }` when neither block nor
farm is given, or when a farm has no blocks/trees (e.g. "All farms").

**Caching / invalidation** (`cache_utils.py`):
- Cache keys: `{K_ORCHARD_TREES_PREFIX}:rows:{block}` and
  `{K_ORCHARD_TREES_PREFIX}:rows:farm:{farm}`, TTL `TTL_LONG`.
- Add these keys to `invalidate_orchard_trees_for_block` and the farm branch of
  `invalidate_orchard_trees_for_doc`, alongside the existing `:` and `:pts:` keys. No
  new hook wiring — `Orchard Tree` already routes through `invalidate_on_change`.

`POS_TOL` is a module constant so it can be tuned.

### Frontend — `lib/scouting-api.ts`

- `interface OrchardTreeRow` — the row shapes above (discriminated on `k`).
- `fetchOrchardTreeRows({ block?, farm? }): Promise<{ rows: OrchardTreeRow[] }>` —
  mirrors `fetchOrchardTreePoints` (same `call()` + in-memory `cached()` wrapper).
- `expandTreeRows(rows): OrchardTreePoints` — pure function, unit-testable:
  - LINEAR: for `i` in `1..n` push name `p + i` and coord `lerp(a, b, (i-1)/(n-1))`
    (`n == 1` → the single point `a`).
  - EXPLICIT: push `c[…]` verbatim; name is `p + i` (or `names[i-1]` when provided).
  - Returns the same `{ names, coords }` structure `TreesLayer` already eats.
- `primeAvocadoGeo()`: warm `fetchOrchardTreeRows` for the avocado farm the same way it
  currently warms geo, so the map's own fetch finds it cached.

### Frontend — `AvocadoMap.tsx`

One change to the tree-fetch effect: replace
`fetchOrchardTreePoints({ farm })` with
`fetchOrchardTreeRows({ farm }).then(r => expandTreeRows(r.rows))`, then
`setTreePoints(...)` as today. Everything downstream — `treePoints` state,
`treeCoords`, `treeColors`, the `TreesLayer` creation/`updateColors`, the
`treesPlacing` loader gate — is unchanged, because the produced object is the same
`OrchardTreePoints` shape.

### Fidelity

- 1,860 linear rows: interpolation error ≤ 0.5 m (measured) — visually identical.
- 10 obstacle rows: shipped explicit → pixel-exact, no ghost trees on the gap.
- Scouted trees: positioned from the same row data (user chose interpolation, no
  separate exact set). Exact on explicit rows, ≤ 0.5 m on linear rows. Colored by name
  via the existing `treeColors` map (names reconstructed as `p + i`).

## Edge cases

- **All farms selected** → no trees today (all on Lokitela); endpoint returns
  `{ rows: [] }`, loader clears immediately (existing behavior).
- **Row with 1 tree** → EXPLICIT single coord.
- **Trees missing `geojson`** → skipped in the row build (as today).
- **Name doesn't match `<prefix>T<n>`** → EXPLICIT with an explicit `names` array, so a
  wrong reconstructed name can never break coloring/hover.
- **Duplicated/rebuilt layer** → unchanged; `expandTreeRows` output feeds the same path.

## Testing

- **Unit (frontend)** `expandTreeRows`:
  - linear row `n=5` → 5 evenly spaced coords, names `p1..p5`, endpoints exactly `a`/`b`.
  - explicit row → coords verbatim, names from `p`/`names`.
  - `n=1` linear/explicit → single point.
- **Backend classification**:
  - synthetic evenly-spaced row → LINEAR; row with a mid gap → EXPLICIT.
  - the 10 known `AIRSTRIP BLK 10` rows classify EXPLICIT; a sample of clean rows LINEAR.
  - `expand(classify(row)) ≈ original coords` within `POS_TOL` for a sample of real rows
    (round-trip fidelity).
- **Payload**: assert the farm response is < ~250 KB (was ~3.6 MB).
- **Manual/verify**: load the avocado map for Lokitela — trees appear in place, scouted
  trees colored correctly, obstacle rows (AIRSTRIP BLK 10) show the gap (no trees on the
  hill), culling/LOD unchanged.

## Rollout

- Keep `get_orchard_tree_points` in place during transition; switch `AvocadoMap.tsx` to
  the rows endpoint. The points endpoint can be removed in a later cleanup once the rows
  path is confirmed in production.
- No fixture/migration/desk changes; ship endpoint + frontend together, rebuild the SPA.
