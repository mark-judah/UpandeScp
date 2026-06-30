# Per-recipe tank-mix BOMs (find-or-create) — design

> **Current model (2026-06-30):** the per-1000 L *rate* BOM basis described here
> (§Recipe basis) is live again, paired with `wo.qty = water_volume/1000`. The
> intervening absolute-qty/`wo.qty=1` model from
> `2026-06-18-per-plan-bom-transfer-alignment-design.md` was reverted — see that
> file's **Addendum (2026-06-30)**.

## Problem
A spray plan carries two recipes that can diverge: `required_items` (the
chemicals the operator picks, scaled by water volume) and `bom_no` (a reused
template BOM). ERPNext's native Manufacture backflushes `bom_no`, so when the
picked BOM ≠ the plan it consumes the wrong chemicals. We patched manufacture
to consume the transfer (floor-plan-is-truth) and added a `before_validate`
guard, but the BOM itself is still wrong/meaningless — and we want correct
BOMs for **traceability**.

## Goal
Whenever a chemical plan is created or altered, ensure `bom_no` is a BOM whose
recipe matches the plan. Reuse an existing matching BOM; create a new one only
when the recipe is altered.

## Decisions (agreed)
- **Tank mix = FG item** (`pm`, `dm`, `th`, `pm/dm`, …). The operator still
  picks a tank mix (today a BOM); we use that BOM's FG item as the tank-mix
  identity. No frontend change required initially.
- **Always create a new BOM** — no reuse/dedup. Every plan create, and every
  alter, mints a fresh BOM for that tank mix's FG item. Gives 1:1 plan↔BOM
  traceability. Proliferation is accepted (de-scoped to clean up later).
- **Recipe basis:** per-1000L **rates** (as BOMs already store —
  `quantity = 1 Tank Mix (1000L)`, item `stock_qty` = rate/1000L). The new BOM
  stores rates so it's a normal tank-mix BOM; the WO's `required_items` keep the
  water-scaled absolute qtys.

## Design

### New: `bom_resolver.create_bom_for_plan(fg_item, company, rate_recipe) -> bom_name`
`rate_recipe` = `{item_code: rate_per_1000L}`.
- **Always create + submit a new BOM** for `fg_item`: `quantity = 1`,
  `uom = "Tank Mix (1000L)"`, `is_active = 1`, `is_default = 0` (don't disturb
  the item's default BOM), one BOM Item per chemical with `qty = rate`. Reuse /
  adapt the existing `serverscripts/create_bom.py` creation logic. Return the
  new BOM's name. No matching/tolerance/signature logic.

Replacement on alter: when `update_draft_plan` mints a new BOM, the
previously-assigned BOM (if it was auto-created for this still-draft WO and is
referenced by nothing else) is cancelled, so repeated draft edits don't leave a
trail of orphan BOMs. A BOM already used by a submitted Stock Entry is never
touched.

### Rate derivation
`rate = required_qty * 1000 / water_volume` per chemical (inverse of the
existing `required = rate × water_volume/1000`). If `water_volume` is missing or
0, treat the entered qty as the rate (fallback) and log it.

### Integration points (`drafts.py`)
- `create_draft_spray_plan` and `update_draft_plan`: after `required_items` are
  built and `custom_water_volume` is set, derive `rate_recipe`, call
  `create_bom_for_plan(fg_item, company, rate_recipe)`, set `wo.bom_no` and
  `wo.production_item = fg_item`.
- `fg_item` = the FG item of the operator-picked tank mix (`bom_meta["item"]`,
  as today).

### Manufacture
With a correct `bom_no`, ERPNext's native backflush is now right. The existing
`before_validate` guard (`stock_entry_state.before_validate`) stays as a
belt-and-suspenders safety net — it rebuilds consumption from the transfer
regardless, so even a stale/odd BOM can't post wrong chemicals.

## Out of scope (separate follow-ups)
- Frontend change to pick a tank-mix *type* directly (current pick-a-BOM UX
  still works via its FG item).
- Backfilling/deduping the 1,649 historical BOMs.
- Reversal/re-issue of already-wrong manufactures and the Material-Issue
  posting-date cleanup (tracked separately).

## Testing
- Unit: `create_bom_for_plan` — mints an active, submitted BOM for the FG item
  whose BOM Items == the rate recipe; `is_default` untouched.
- Integration (kaitet, rolled back): create a plan → `bom_no` is a new BOM whose
  rates == `required_qty × 1000 / water_volume`; edit a chemical → a new BOM is
  assigned and the prior auto-created draft BOM is cancelled (if unreferenced);
  a BOM used by a submitted SE is never cancelled.
- Confirm Manufacture (native + endpoint) consumes `required_items` and that the
  guard is a no-op when the BOM already matches.
