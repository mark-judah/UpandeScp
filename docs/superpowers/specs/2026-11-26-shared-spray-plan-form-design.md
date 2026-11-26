# One spray-plan form for greenhouses and field blocks

Status: approach A chosen in conversation 2026-11-26 ("go with A, each block its own tank mix").
First site: mutara (avocado Application Floor Plan). Roses must behave exactly as today.

## Why

The roses Application Plan (`pages/ApplicationPlan.tsx`) has the working plan form: New tank mix dialog,
Add chemical, Available stock, Batch, Scheduled Application. The field Application Floor Plan
(`components/spray-plan/BlockPlanPanel.tsx`) is a slimmer copy without them, so planners cannot build a
tank mix, see stock or pick batches, and every block shares one time.

## Goals

1. **One shared form component** extracted from the roses page: classification, spray team, kit, MOA,
   tank mix (BOM) picker + **New tank mix** dialog, chemical table with **Add chemical**, **Available**
   (net of other draft plans, as roses computes it), **Batch** (only for batch-tracked items, same rules and
   submit gate as roses), rates per unit (today's rates work) and **Scheduled Application** date/time.
   Roses' page uses it for its greenhouse; the field planner renders it once per selected block.
2. **Each block is its own plan**: its own tank mix, chemicals, quantities, batch and scheduled time. One
   draft Work Order per block, as today (`create_draft_plans_batch`).
3. **MOA on the same row** as Spray team and Kit, same pill style, label "MOA", tooltip "Method of
   application". Options and default as in the spray-ticket spec.
4. **Sidebar prompt**: on the field Application Floor Plan, a one-line hint asks the user to collapse the
   sidebar and highlights the sidebar's Collapse button (pulse/ring, not an accent strip). Collapsing widens
   the right-hand block panel. Dismissible; remembered per user in localStorage; not shown when already
   collapsed.
5. **The whole-farm heatmap stays** on the left of the field page; the form replaces only the per-block
   panel contents.

## Non-goals

- Changing roses behaviour, its bed/zone map, or its API calls.
- One shared tank mix across blocks.
- The map/header/legend/triad-colour work (separate, in progress).

## Anti-goals

- Roses regressions: every existing ApplicationPlan test passes unchanged in meaning.
- A field plan sent with quantities computed differently from the server's check (required_qty stays
  absolute; rates through `spray_rates`).
- Hard-coded crop/farm/product names; native selects; vertical accent strips.

## Constraints

- Stock/batch/BOM endpoints are the ones roses already calls; a block's source store is its farm's chemical
  store, the same rule roses uses for a greenhouse.
- Area-based quantities use the block's area; water-based use the water typed for that block.
- Poppins, black and white, FilterSelect pills, skeletons while loading.

## Approaches considered

- **A. Extract a shared form (chosen).** One form to maintain; careful surgery on the roses page with its
  tests as the guard.
- B. Copy roses pieces into the field panel — fast, but two copies drift (the field panel already did).
- C. Open the roses page for a block — built around greenhouses and beds, loses the farm map.

## Left to the builder

Component boundaries and names, how per-block state is held, exact hint wording and highlight effect,
test structure.
