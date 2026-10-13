# Outdoor crops: pest heatmap + joined blocks

Avocado and coffee (page `pages/avocado/AvocadoHeatMap.tsx`, the outdoor Jobsheet, routed
for every non-rose crop) — 2026-10-13.

## Why

- The heat field today sums *every* pest and disease at each scouting point and lets a
  kernel density spread it. It peaks where scouts walked, not where a pest is: a
  coverage map. There is no way to ask "where are the fruit flies?".
- Outdoor crops are sprayed across adjacent blocks in one run, but a plan holds one block
  (`custom_greenhouse`) with one cost centre.

## Part A — the pest heatmap (one observation at a time)

1. **Pick the observation.** A searchable pill (FilterSelect pattern) of the pests and
   diseases seen in the window, ranked by count, default the top pest. One at a time.
   "All pressure" is not offered — that is what made it a coverage map.
2. **Values, zeros included.** Every scouting entry with coordinates in the window is a
   sample: value = that observation's count on the entry (pests: `count || 1`; diseases:
   1 per row, or the severity if the row has one), **0 when scouted and not found**. The
   zeros are the point — a scouted clean tree pulls the field down; it is not a gap.
   For pests, trap readings of that pest at the trap's fixed location are samples too
   (fruit flies are mostly caught in traps), scaled to the scouting value per the
   pest's threshold if one exists, otherwise taken as is.
3. **Fill the gaps by proximity (IDW).** Lay a grid (~10 m cells, coarser if > 40k
   cells) clipped to the block polygons. Each cell = inverse-distance-weighted mean
   (power 2) of the k=8 nearest samples within R = 120 m. Cells with no sample within R
   stay unfilled (drawn as a faint hatch: "not scouted"). Opacity fades with distance to
   the nearest sample, so interpolated areas read as estimates, measured points as
   facts. Pure functions in `lib/idw.ts` with a bucket grid index; unit-tested.
4. **Colour by threshold.** Green / amber / red against the observation's threshold band
   (reuse the threshold-band helpers the rose heatmaps and `useHouseFigures` use); with
   no threshold, fall back to quantiles of the non-zero values and say so in the legend.
5. **Render** as a MapLibre `image`/canvas source or a fill layer of cells under the tree
   dots and block outlines. Legend: band colours, "estimated (no scout within N m)",
   "not scouted".
6. Block sidebar ranks blocks by the picked observation (mean interpolated value and
   share of area in red), not by total observations.

## Part B — pick blocks, join the touching ones

1. **Pick on the map.** Click blocks to toggle them (also from the sidebar list).
   Selected blocks are outlined and filled lightly.
2. **Join.** Selected blocks that touch (any edge within 15 m) are drawn as one group
   with a single outline; the panel lists each group: its blocks, each block's
   `custom_area_ha`, and the group total. Selections that do not touch form separate
   groups and the panel says so ("2 separate runs").
3. **Plan a group.** `BlockSprayPlan` takes a list of blocks: area = sum, water = area x
   1000 L/ha, quantities from that. The plan submits as one Work Order:
   `custom_greenhouse` = the largest block (keeps every downstream consumer working)
   plus a new child table **Spray Plan Block** on Work Order (`block`, `area_ha`,
   `cost_center`, `share` = area / total), filled server-side in
   `create_draft_spray_plan` from `custom_blocks`.
4. **Cost centre.** Each block row carries its derived cost centre and area share. The
   Work Order keeps the largest block's cost centre for now; splitting the issued
   cost across the shares is a **follow-up** (the user flagged it as the open issue) —
   the panel shows the split so it is visible from day one.
5. Separate groups → one plan per group (a button per group), never one plan across
   blocks that don't touch.

## Not in scope

Cost-centre split at posting time; the rose heatmaps; mobile.
