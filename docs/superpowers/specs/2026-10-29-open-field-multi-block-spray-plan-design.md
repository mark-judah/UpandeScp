# Open-field multi-block spray plan — design (2026-10-29)

Branch `mutara` of upande_scp, site `mutara.local`.

## Problem

Mutara is open field. The greenhouse Application Plan plans one house at a time. In the
field an agronomist selects several blocks (avocado blocks, or the slices of a pivot)
and plans each one separately, then sends them together for approval. The selection
only makes the work quicker; every block still gets its own programme.

## Decisions

1. **Same data model, same approval.** One Work Order (`Application Floor Plan`,
   `Pending Submission`) per block, `custom_greenhouse` = the block warehouse. Nothing in
   `drafts.create_draft_spray_plan`, the approval workflow, the stock entries or the
   cost-centre rule changes. The cost centre of a plan is `derive_cost_center(block
   warehouse)` exactly as today (`Warehouse.custom_cost_center`, else the cost centre
   named like the warehouse, e.g. `P1-B7 - MUT`), unless the plan carries an override.
2. **Batch creation.** New endpoint `open_field.create_draft_plans_batch(plans)`: validates
   every block's plan first (classification, team or roster, tank mix, at least one
   chemical, area), then creates all drafts inside one savepoint. Any failure rolls the
   whole batch back and the error names the block. It returns one result per block. The
   drafts land in the existing draft list (`DraftBatchPanel`), so "Submit all" sends them
   together, and each can still be sent or deleted alone. Approvals are per Work Order,
   so they can be approved individually or in bulk, as for roses.
3. **Block directory.** `open_field.get_open_field_blocks(crop=None)` returns the blocks
   the user may plan on (farm scope, `warehouse_type = Block`), grouped by their nearest
   Pivot ancestor, else Section, else farm, each with `crop` (resolved by
   `common.planting`, never by name), `area_ha` and `cost_center`. The picker never
   depends on the number of blocks per group.
4. **Per-block findings.** `open_field.get_block_findings(blocks, days)` returns, per
   block, the pests and diseases scouted there in the last N days (count, last seen),
   read from Scouting Entry `block`. They become the block's targets and feed the
   existing `suggestProducts` ranking (`SuggestedProductsCard`) for that block.
5. **Mode, not a fork.** The page is a new view `open-field-plan`, shown in the sidebar
   of block-grown crops only (`isBlockGrown`, decided from the crop's stations). Roses
   keep `application-plan` unchanged. Shared pieces (suggestions card, BOM picker, team
   editor, draft batch panel, toasts) are reused.

## UI

- **Left**: `BlockMultiPicker`. Groups (pivot or section) with a select-all checkbox per
  group, a search box, and one row per block with the crop as a highlighted chip. 12
  blocks per pivot scroll comfortably. Selecting a block adds it to the right panel;
  deselecting removes it (and its entered plan).
- **Right**: `BlockPlanPanel`, one section per selected block, in selection order:
  block name with the crop highlighted, area (from the warehouse, editable when it is
  missing), the block's scouted findings and suggested chemicals, Preventive / Curative
  (reason when preventive), spray team, tank mix (BOM) with its chemicals and rates.
  A **jump dropdown** at the top lists every selected block (with a done tick) and
  scrolls to / opens it.
- **Collapse**: with more than 2 blocks selected, each section collapses to a header
  dropdown (name, crop, state) and one is open at a time, so the planning flow is
  classification -> team -> BOM for a block, then the next. With 1-2 blocks all sections
  are open.
- **Submit**: "Create N draft plans" sends the batch; completed drafts appear in the
  draft list below, with the existing Submit for approval.
- Toasts for success and errors, skeletons while the blocks and bootstrap load, Poppins
  and the pill toolbar of the other SCP pages.

## Crop highlight in the scouting block picker

The "Block for patches" picker on the Fruits & Vegetables scouting map shows, for each
block of a pivot, the crop it is currently growing as a highlighted chip next to the
block name, using the same block directory (`crop` per block).

## Out of scope / site data

Teams, tank mixes (BOMs), block areas and the Farm "Spray Plan Creators" roster are site
data. The code does not create them; tests build fixtures. The site gaps are listed in
the hand-over report.
