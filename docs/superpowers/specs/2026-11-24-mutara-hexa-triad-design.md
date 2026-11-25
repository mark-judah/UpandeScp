# Mutara: Hexa → Triad at a 5 m standard

Date: 2026-11-24 · Status: draft for approval · Site: mutara.local (frappe16-mutara bench), first; kaitet follows
Parent design: kaitet `docs/superpowers/specs/2026-11-24-hexa-triad-and-farm-structure-design.md` (built on kaitet, commits 7deef81..9191782 + core feat/hexa-triad a59d2c7).

## Why

The Hexa → Triad model applies to both kaitet and mutara, mutara first. Mutara's vegetable pivots
(24 blocks, P1-B1…P2-B12) are already a hexagon grid, but modelled as Block → Row ("band") →
"Triad" where each Triad record is really a **3 m hexagon** (24,351 of them, geojson
`kind:"hexagon"`). The user decided:

* scouts record at the **triangle** (triad), not the hexagon;
* the **standard triangle side is 5 m** for every site (compared against 3 m and 8 m; maps already
  draw polygons efficiently, as on Lokitela);
* pair is Hexa → Triad, 6 triads per hexa, edge hexas may hold fewer.

Mutara has **0 Scouting Entries**, so the grid can be replaced without orphaning history.

## Goals

1. Core + SCP on mutara run the same Hexa → Triad rules as kaitet (port the kaitet commits).
2. A site-wide **standard triangle side (m)** setting, default **5**, enforced by the layout import
   (full triangles must match within 2 %) and shown on the Farm Structure page.
3. Mutara's 24 pivot blocks are **regenerated at 5 m**: each block's outline = union of its
   current hexagons; Hexas numbered per block (rows of hexes north → south, then west → east);
   Triads 1–6 in the mapping tool's `tri` order; edge pieces clipped to the outline. The old Rows
   and 3 m "Triads" are deleted. ≈ 8.2 k Hexas, ≈ 50 k Triads.
4. Scouting records the triangle: GPS → Triad (point-in-polygon, nearest centroid fallback),
   stored on the entry; `mapping_status` counts a triad as mapped.
5. Mutara's maps, heat maps, summaries, trap units, gallery and trends read Hexa → Triad.

## Non-goals

* No triangle picker in the Scout app (mutara has `scouts_pick_unit` = 0; the server maps from GPS).
  The app keeps showing "Hexa" labels (already shipped in RN 95498d5).
* No change to rose (Bed → Zone) or avocado orchard (Row → Tree) paths.
* No new map engine — reuse the existing MapLibre field layers.

## Anti-goals

* Touching mutara data without a dry-run report and a DB backup first.
* Breaking avocado/tree blocks on mutara (Row → Tree keeps working).

## Design decisions

* **Entry fields:** `Scouting Entry.row` (Link Bed) holds the **Hexa**; `Scouting Entry.triad`
  becomes a **Link to Triad** (was Data) holding the Triad name
  `"{block} - Hexa {n} - Triad {t}"`. Unit key everywhere = the Triad name (one string per
  triangle), so `triad-colors`/`triad-multi` keep working unchanged.
* **Map payload (`field_geo`):** per block, the Hexa lattice origin + rotation + side, and for each
  hexa its number and centre; a regular triangle is derived on the client from (hexa centre,
  t, side). Edge triangles (clipped) are sent explicitly. Row lines are dropped; hexa outlines
  become a layer. Zoom thresholds retuned for 5 m.
* **Regeneration** runs as a bench script with `--dry-run` (counts per block, sample names, area
  check: Σ new triangle area ≈ outline area within 1 %) and `--apply` (backup reminder; deletes
  old Triads + Rows of those blocks, inserts Hexas + Triads in bulk, sets the farm's structure
  levels). Idempotent per block.
* **Standard size setting** lives on Scouting and Crop Protection Settings
  (`triad_side_m`, Float, default 5). The import checks it; the regeneration script uses it.
* **Trap units:** a trap may sit on a Triad (its triangle) or a Hexa (its outline = union of its
  triads); "On hexagon …" wording becomes "On triad …"/"On hexa …".
* **Trends / coverage denominators:** a triad is a station; hexa counts derive from triads.

## Port strategy

* **upande_core (mutara, branch main efe95a7):** new branch `feat/hexa-triad`; cherry-pick kaitet
  core a59d2c7 (and 44b41ff only if it applies cleanly). Drop the local
  `docs/upande_core_patches/band-as-row-like-unit-type.patch` usage.
* **upande_scp (mutara branch):** add kaitet's local repo as a remote, cherry-pick 73c7dd7, ae5e494,
  4ac5947, 0d4c57c, 4a7bac7, 70af23c, 9191782, resolving conflicts in favour of mutara's newer
  code plus the Hexa rules. Then the mutara-specific rework above.
* Kaitet later gets the mutara-specific pieces that are crop-generic (triad capture, field_geo,
  setting) by cherry-picking back.

## Left to the builder

Exact client triangle derivation code, zoom values, test layout, bulk-insert batching.

## Follow-ups

Kaitet: same regeneration for Endebess once its blocks are mapped; RN triangle picker if a site
turns `scouts_pick_unit` on; map performance pass for 4 GB machines.
