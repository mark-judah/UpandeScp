# `required_qty` as the single absolute truth (source-side) — Layer 0

**Date:** 2026-06-19
**Status:** Design — corrected after reading the real frappe15 frontend; approved for minimal fix
**Related:** `2026-06-18-per-plan-bom-transfer-alignment-design.md` (Approach A, the
BOM half), `2026-06-12-per-recipe-tank-mix-bom-design.md`

## Principle

> **What we require is what is manufactured.**

There is exactly one physical fact per chemical per plan: the **absolute amount**
that goes into the tank. It is simultaneously what is *required*, *transferred*, what
the per-plan BOM lists (`stock_qty`), and what is *consumed*. The per-1000 L **rate**
is a derived display/validation value. This design makes `required_qty` hold that one
absolute truth and removes the one place that corrupts it.

## What the frontend actually sends (verified)

The live frappe15 page is `frontend/src/pages/ApplicationPlan.tsx` (not the older
`ApplicationFloorPlan.tsx` on the `mona` branch). Its data flow:

- The operator edits a per-1000 L **`rate`** (`ChemRow.rate`, comment at line 181-186).
- The UI **auto-derives the absolute** total: `stock_qty = rate × waterVolume / 1000`
  (effect at lines 560-573).
- The payload **sends the absolute**: `application_rate: c.stock_qty` (line 1030).
- The operator already **sees** the derived total in the UI.

**Conclusion: the backend receives the already-scaled absolute amount.** No
backend scaling is needed or correct — scaling again would double-scale.

## Problem

`drafts.py:341` correctly stores `required_qty = application_rate` (the absolute)
verbatim. The corruption is a single later pass:

**`bulk.py:_recalc_required_qty_from_water_volume`** rebases `required_qty` to
`bom_rate × water_volume/1000` on bulk-submit, where `bom_rate` is the per-plan BOM
line `stock_qty` (which Approach A already made absolute). So it multiplies an
already-absolute value by `wv/1000` again — **double-scaling** `0.1 → 0.01`.

### Observed (live `kaitet.local` dump, `MFG-WO-2026-02419`, water_volume = 100)

Correct absolute for the recipe (Pyretone 1, TELDOR 1, Amisil 0.4 per 1000 L, at
100 L) is **0.1 / 0.1 / 0.04**.

| Field | Pyretone | TELDOR | Amisil | Verdict |
|---|---|---|---|---|
| WO `required_qty` | 0.01 | 0.01 | 0.004 | absolute ÷ 10 — **bulk.py double-scale** |
| WO `custom_updated_required_qty` | 0.1 | 0.1 | 0.04 | the absolute the frontend computed |
| BOM `exploded_items.stock_qty` | 0.1 | 0.1 | 0.04 | correct absolute |
| BOM item `qty`/`stock_qty` | 1 | 1 | 0.4 | per-1000 L rate (minted from a stale water-volume state; see note) |

The BOM-item `qty = 1` reflects this plan being created/edited across water-volume
changes (the dump's `water_volume = 100` doesn't match its `area = 0.6368` ha ⇒ ~637,
so the volume was overridden after mint). With water volume mandatory and the bulk
rebase gone, a freshly created plan reconciles cleanly; repairing legacy plans is
separate cleanup.

## Goal / invariant

```
required_qty (absolute, sent by the frontend, stored verbatim)
  == bom_item.stock_qty            (BOM half — already done, Approach A)
  == transferred_qty               (Material Transfer for Manufacture)
  == consumed_qty                  (Manufacture; guard enforces consume == transfer)
```

Per-1000 L rate is **derived** where needed: `rate = required_qty / (water_volume/1000)`.

## The change (minimal)

### 1. Delete the double-scaler — `bulk.py`

Remove `_recalc_required_qty_from_water_volume` and its call site in the bulk-submit
path. With the frontend sending the absolute and `drafts.py` storing it verbatim,
this rebase is pure corruption. Its `looks_unscaled` heuristic and override
protection go with it.

### 2. Derive the per-1000 L rate at the two read sites that compare/display it

`required_qty` is now reliably the absolute, but these sites need the rate:

- **`approval_review.py:35`** — compares against `custom_lower_rate_limit` /
  `custom_upper_rate_limit`, which are **per-1000 L**. Comparing the absolute (0.1)
  against a rate limit (e.g. 1.0) falsely flags every plan "below". Use
  `absolute_to_rate(required_qty, water_volume)`.
- **`spray_session.py:552`** (SAL) — the `rate` field must be the per-1000 L rate;
  `pesticide_quantity` (line 553) stays the absolute (the amount actually weighed).

Add one helper `absolute_to_rate(required_qty, water_volume)` and route
`build_bom_rows`'s existing inline rate calc through it too (DRY).

### 3. Make water volume mandatory — `drafts._validate_payload`

Throw if `custom_water_volume <= 0`. The frontend's derive effect already returns
early when water volume is 0 (sending `stock_qty = 0`), so a zero-volume plan is
meaningless; enforce it server-side. This also makes the read-path
`absolute_to_rate` division safe for any new plan.

## Not changing (and why)

- **`drafts.py:341`** — already stores the absolute verbatim. No scaling. (Adding
  scaling would double-scale.)
- **Frontend** — already derives and displays the absolute; sends it correctly.
- **Draft read-back `drafts.py:655`** — returns `application_rate = required_qty`
  (absolute), symmetric with what the frontend sends. The React edit-load seeds the
  per-1000 L `rate` from the BOM (`fetchBomDetails`, lines 388-409), not from this
  endpoint, so no change is required.
- **BOM minting / `bom_item_payload`** — Approach A already correct.

## Edge cases

- **water_volume mandatory** (§3) removes the only zero/missing branch on the write
  path. `absolute_to_rate` keeps a `wv <= 0 → return qty` guard for safely displaying
  any legacy row.
- **Operator rate override:** handled entirely in the frontend (re-derives
  `stock_qty`); backend just stores the absolute it receives.
- **Rounding:** `required_qty` is stored verbatim; the BOM copies it verbatim, so
  BOM == transfer exactly.

## Testing

- **Unit:** `absolute_to_rate(0.1, 100) == 1.0`; `absolute_to_rate(0.04, 100) == 0.4`;
  `absolute_to_rate(0.5, 0) == 0.5` (legacy read safety). Existing `build_bom_rows`
  tests stay green after the DRY refactor.
- **Integration (`kaitet.local`, rolled back):** bulk-submit a draft and assert
  `required_qty` is unchanged (== the frontend absolute), not divided again; BOM
  `stock_qty == required_qty`; approval review reports `ok` for a rate inside limits.
- **Regression:** bulk submit path works with the rebase removed.

## Out of scope

- Retiring `custom_updated_required_qty` (orphaned parallel field; no live reader —
  optional later cleanup).
- Backfill/repair of already-corrupted in-flight plans.
- Layer 2/3 guard hardening & reconciliation (see `2026-06-18` spec).
- Agronomic correctness of the scaling formula (water-volume basis vs area).
- The `mona`-branch `ApplicationFloorPlan.tsx` (different, older page).
