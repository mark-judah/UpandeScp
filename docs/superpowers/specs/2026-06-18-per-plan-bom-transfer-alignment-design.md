# Per-plan BOM ↔ transfer alignment (guard-down safety) — Layer 1

**Date:** 2026-06-18
**Status:** SUPERSEDED (2026-06-30). Approach A shipped as designed, then was
replaced by **Approach B** (`wo.qty = water_volume/1000`, per-1000L BOM) at the
product owner's request — the Work Order / manufacture / issue must visibly
reflect the chosen water volume (2000 L → qty 2), not always read 1. See the
**Addendum (2026-06-30)** at the end of this file for the implemented change.
**Related:** `2026-06-12-per-recipe-tank-mix-bom-design.md`, commit `a101ac1`
(`fix(spray): guard all manufacture paths to consume the transfer, not the BOM`)

## Problem

For Application Floor Plan (AFP) work orders, the consume-what-was-transferred
invariant ("floor-plan-is-truth") currently lives **entirely** in one runtime
hook: `stock_entry_state.before_validate` →
`spray_session._rebuild_manufacture_from_transfer`. On every AFP `Manufacture`
Stock Entry it discards ERPNext's BOM backflush and rebuilds raw consumption to
equal exactly what was transferred into the CSU for that WO.

When the guard is up it is robust to all normal paths (mobile, API, console,
desk "Finish"), because any ledger-affecting Manufacture goes through
`submit → validate → before_validate`. **But the invariant has no redundancy.**
If the guard does not run — app version with `a101ac1` not deployed, `hooks.py`
edited / app uninstalled / hook reordered, the rebuild raising and being
swallowed upstream, or a Manufacture written through a path that skips
`validate` — consumption silently reverts to **BOM backflush**, and the BOM
dictates everything again.

### What guard-down looks like (already observed)

The pre-`a101ac1` (2026-06-10) Manufacture entries on `kaitet.local` *are*
guard-down behaviour:

| WO | BOM-driven consume | Transferred | Result |
|----|--------------------|-------------|--------|
| MFG-WO-2026-02405 | 0.3 | 2.0 | 1.7 stranded in CSU |
| MFG-WO-2026-02411 | 0.3 | 1.0 | 0.7 stranded in CSU |
| MFG-WO-2026-02414 | 0.3 | 1.0 | 0.7 stranded in CSU |

For a **current** per-plan WO the failure is worse than stranding. Example
`MFG-WO-2026-02416` (`THR/BOT`, water_volume = 6):

- Transfer = `required_items` → TELDOR 0.006 / Amisil 0.0018 / MOSPILAN 0.0018.
- BOM (`BOM-THR/BOT-052`) stores the **per-1000L rate** → TELDOR 1 / Amisil 0.3
  / MOSPILAN 0.3, with `BOM.quantity = 1`.
- Guard-down backflush = `stock_qty × (fg_completed_qty / BOM.quantity)` =
  `1 × (1 / 1)` = **1.0** — ~167× the transfer.

On the **shared** CSU (`Chepsito CSU Phase 1 - KR`) that would either silently
drain other work orders' balances (consuming stock never transferred for this
WO) or throw negative-stock. The BOM's inflated cost (15,386 KES vs the real
~92 KES) would also hit the GL.

### Root cause of the divergence

In the per-plan flow:

- `drafts.py:439` hardcodes `wo.qty = 1`, so `fg_completed_qty` defaults to 1.
- `drafts.py:341` sets `required_qty` straight from the payload
  (`application_rate`) — this is the transfer amount (e.g. 0.006).
- `bom_resolver.create_bom_for_plan` back-derives a **per-1000L rate**
  (`rate = required_qty ÷ (water_volume/1000)` = 1) and stores *that* as the BOM
  item `qty` / `stock_qty` / `qty_consumed_per_unit`, with `BOM.quantity = 1`.

So the BOM and the transfer are computed by different formulas and only agree
when `fg_completed_qty == water_volume/1000` — which never holds, because
`wo.qty = 1`.

## Goal / invariant

At full production (`fg_completed_qty == wo.qty == 1`), **BOM backflush must
equal the WO `required_items`** (the transfer):

```
bom_item.stock_qty × (fg_completed_qty / BOM.quantity) == required_qty
```

With `fg_completed_qty = wo.qty = 1` and `BOM.quantity = 1`, this reduces to
`bom_item.stock_qty == required_qty`.

Achieving this makes the guard a **redundant** belt-and-suspenders rather than
the only thing standing between the operation and wrong consumption.

## Approaches considered

### A — BOM carries the absolute scaled qty (chosen)

In `create_bom_for_plan`, set each BOM item's `qty` / `stock_qty` /
`qty_consumed_per_unit` to the WO's **absolute `required_qty`** (e.g. TELDOR
0.006). Keep `BOM.quantity = 1`. Keep `custom_application_rate` /
`custom_application_rateper_ha_` holding the **per-1000L rate** (the current
`rate_recipe_from_wo` value) for recipe display/traceability.

Backflush becomes `required_qty × (1 / 1) = required_qty` = transfer. ✓

- **Pro:** single-file change in `bom_resolver.py`; no change to `wo.qty` or any
  qty-dependent downstream logic; BOM cost becomes truthful; recipe metadata
  preserved in `custom_application_rate`.
- **Bonus:** closes a latent bug — if ERPNext ever recomputes `required_items`
  from this BOM (any WO re-save), an absolute-qty BOM reproduces the *same*
  `required_items` (`stock_qty × wo.qty / BOM.quantity = required_qty`), whereas
  today's per-1000L BOM would overwrite them with the 167×-too-large values.

### B — Make `wo.qty` the number of 1000L tanks (`water_volume/1000`)

Keep the BOM per-1000L; set `wo.qty = water_volume/1000` so backflush
`= rate × (water_volume/1000) = required_qty`. More physically coherent (matches
`BOM.uom = Tank Mix (1000L)`) and aligns the new flow with the legacy
`create_application_work_order.py` (`wo_qty = water_volume/1000`). **Deferred** —
it changes `wo.qty` / `produced_qty` / FG-stock semantics, valuation-per-unit and
status math, a much larger blast radius for the same guard-down benefit. Could
be a separate later cleanup.

**Decision:** Approach A.

## The change (Approach A)

`upande_scp/serverscripts/spray_plan_creator/bom_resolver.py`,
`create_bom_for_plan`:

- Per item: `qty = stock_qty = qty_consumed_per_unit = required_qty` taken
  verbatim from the WO `required_items` row (no re-rounding, so BOM == transfer
  exactly).
- `custom_application_rate = custom_application_rateper_ha_ = ` the per-1000L
  rate (today's `rate_recipe_from_wo` output), kept for display/recipe.
- `BOM.quantity` stays 1; `BOM.uom` stays `Tank Mix (1000L)`.
- The re-mint path (draft re-edit → `cancel_orphan_plan_bom` + recreate)
  inherits the same logic, so the BOM stays in sync with edited
  `required_items`.

Practically, `create_bom_for_plan` needs both numbers per item: the absolute
`required_qty` (for `qty`/`stock_qty`) and the per-1000L rate (for
`custom_application_rate`). The current `rate_recipe_from_wo` already computes
the rate; the loop should also carry the originating `required_qty`.

## Edge cases

- **water_volume = 0 / missing:** `qty` comes from `required_qty` directly (no
  factor needed). `custom_application_rate` falls back to `required_qty`
  (factor 1) exactly as today.
- **Partial production** (`fg_completed_qty < 1`): backflush scales down
  proportionally; if the guard is up it scales to the actual transfer — same
  direction, acceptable. Exact match holds at the nominal full-production case,
  which is the realistic guard-down scenario.
- **Multiple transfers / re-issues:** the BOM is fixed at mint time, but it is
  minted from the same `required_items` that drive the transfer, and edits
  re-mint the BOM — so they stay in sync.
- **Rounding:** store `qty` verbatim from `required_qty` so BOM == transfer
  exactly.

## Testing

- **Unit:** mint a BOM from a synthetic WO (water_volume = 6, rates 1/0.3/0.3) →
  assert each BOM item `stock_qty == required_qty` (0.006/0.0018/0.0018) and
  `custom_application_rate ==` per-1000L rate (1/0.3/0.3); assert
  `BOM.quantity == 1`.
- **Integration (rolled-back console):** build a `Manufacture` for such a WO
  with the guard disabled, backflush from the BOM, assert consumption ==
  transfer. Repeat with the guard enabled → identical result.
- **Regression:** confirm `create_bom.py` (the template-BOM dialog) and the
  rate-override detection in `create_application_work_order.py` — both of which
  read `custom_application_rate`, not the minted BOM `stock_qty` — are
  unaffected.

## Out of scope (later layers / separate work)

- **Layer 2:** turn the guard into a hard assertion that *blocks* submit when
  `consume != transfer`, so a partial/failed rebuild cannot pass silently.
- **Layer 3:** scheduled reconciliation report flagging any AFP WO where
  transferred ≠ consumed (catches guard-down drift after the fact).
- Cleanup of stranded legacy (pre-`a101ac1`) CSU residuals.
- The agronomic correctness of the scaling formula itself
  (`required_qty = application_rate × water_volume/1000`, area not applied).
- Approach B (`wo.qty` = number of 1000L tanks). — **now implemented, see below.**

---

## Addendum — 2026-06-30: switched to Approach B

**Why:** Approach A made BOM == transfer at `wo.qty = 1`, so raw consumption was
correct — but the Work Order quantity (and therefore the manufactured / issued
*tank-mix* quantity) always read **1** regardless of water volume. For a 2000 L
spray the operator expects the WO to read **2** and 2× tank mix to be
manufactured and issued, matching the legacy `create_application_work_order.py`
(`wo_qty = water_volume/1000`). This is the "Approach B" deferred above.

**What changed (implemented):**

- `spray_plan_creator/drafts.py` — `create_draft_spray_plan` now sets
  `wo.qty = round(custom_water_volume / 1000, 2)` (was hardcoded `1`), after
  `_apply_payload` populates the water volume. Falls back to 1 when volume is 0.
- `spray_plan_creator/bom_resolver.py` — `create_bom_for_plan` now stores the
  **per-1000 L recipe rate** as each BOM item `qty`/`stock_qty`/
  `qty_consumed_per_unit` (reverting Approach A's absolute value), with
  `BOM.quantity = 1`. `custom_application_rate` still mirrors the rate.

**Resulting invariant** (replaces the §66 invariant):

```
required_qty == bom_item.stock_qty (rate) × wo.qty (water_volume/1000)
             == transfer == backflush at fg_completed_qty == wo.qty
```

So `planned == transferred == manufactured == issued` (all = the absolute
amount), and `wo.qty` / `produced_qty` / FG tank-mix qty now scale with volume.
This realigns with the original `2026-06-12` spec, whose BOM basis was always
per-1000 L rates (§24-27).

**Verified:** fresh 2000 L plan → `wo.qty = 2.0`, `required_qty = rate × 2`
(absolute), BOM item `qty = rate`; `BOM × qty == required`. `test_bom_resolver`
and `test_quantities` green.

**Residual risk to watch** (the blast-radius this spec originally flagged for
Approach B): `produced_qty` / FG-stock valuation-per-unit and Work Order status
math now operate on `qty = N` rather than `1`. Raw-material *consumption*
remains protected by the `before_validate` guard (consume == transfer), and the
FG quantity is now physically coherent (N × 1000 L), but downstream
valuation/status edge cases on multi-tank WOs were not exhaustively re-tested
and should be watched. (Layer-2 hard-assert / Layer-3 reconciliation from the
original "Out of scope" still apply.)
