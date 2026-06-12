# Per-recipe tank-mix BOMs (find-or-create) — design

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
- **Dedup:** reuse an existing BOM when the recipe matches; create a new BOM
  only when altered. (Avoids worsening the 1,649 existing BOMs.)
- **Recipe basis:** per-1000L **rates** (as BOMs already store —
  `quantity = 1 Tank Mix (1000L)`, item `stock_qty` = rate/1000L). Same recipe
  at any water volume reuses one BOM; the WO's `required_items` keep the
  water-scaled absolute qtys.

## Design

### New: `bom_resolver.resolve_bom_for_plan(fg_item, company, rate_recipe) -> bom_name`
`rate_recipe` = `{item_code: rate_per_1000L}`.
1. Query active, submitted BOMs for `fg_item` (+ company). Cheap pre-filter to
   those whose BOM-Item **set of item_codes equals** `rate_recipe`'s keys.
2. Among those, compare each item's `stock_qty` (rate) to the recipe within a
   small tolerance (abs `1e-4` or rel `0.5%`). First match → **reuse**.
3. No match → **create + submit a new BOM** for `fg_item`: `quantity=1`,
   `uom = "Tank Mix (1000L)"`, `is_active=1`, `is_default=0` (don't disturb the
   item's default), one BOM Item per chemical with `qty = rate`. Reuse/adapt the
   existing `serverscripts/create_bom.py` creation logic. Return its name.

Tolerance + set-equality are factored into a helper so both reuse and the
manufacture comparison share one definition of "matches".

### Rate derivation
`rate = required_qty * 1000 / water_volume` per chemical (inverse of the
existing `required = rate × water_volume/1000`). If `water_volume` is missing or
0, treat the entered qty as the rate (fallback) and log it.

### Integration points (`drafts.py`)
- `create_draft_spray_plan` and `update_draft_plan`: after `required_items` are
  built and `custom_water_volume` is set, derive `rate_recipe`, call
  `resolve_bom_for_plan(fg_item, company, rate_recipe)`, set `wo.bom_no` and
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
- Performance: if per-save matching against many BOMs (e.g. 532 for `th`) is
  slow, add a `custom_recipe_signature` field on BOM for O(1) dedup. Start
  without it; measure.

## Testing
- Unit: `resolve_bom_for_plan` — identical recipe reuses; altered rate creates a
  new BOM; different chemical set creates a new BOM; tolerance boundary.
- Integration (kaitet, rolled back): create a plan → `bom_no` matches recipe;
  edit a chemical rate → new BOM assigned; identical re-create → same BOM.
- Confirm Manufacture (native + endpoint) consumes `required_items` and that the
  guard is a no-op when the BOM is already correct.
