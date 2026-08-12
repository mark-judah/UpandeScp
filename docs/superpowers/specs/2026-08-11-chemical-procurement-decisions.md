# Chemical procurement, loaning and budget — decisions record

**Date:** 2026-08-11
**Status:** decisions captured, NOT a spec — phases 2–4 each need their own
**Companion to:** `2026-08-11-store-model-and-notifications-design.md`

This records the corrections and decisions from the design conversation so they
survive until each phase is specced properly. It is deliberately not an
implementation plan.

## The target flow (as described)

Today: chemical planners raise orders for everything, merge into one Material
Request by hand, a PO lands in one chemical store, and distribution to the other
stores is manual.

Wanted:

1. Each farm raises its own desired quantity per chemical.
2. **Review 1** — the farm's spray-plan planner confirms it is what the farm
   needs.
3. **Review 2** — the General Manager sees the consolidated total and makes the
   financial call, either amending one farm's line or reducing a chemical's total.
4. The GM consolidates into **one Material Request**.
5. PO receives into the **general store** (phase 0).
6. The received quantity is split to farm stores **pro-rata by original request**,
   in physically measurable increments.
7. The sub-increment remainder **stays in the general store**.
8. Planners raise **transfer requests** against that shared pool; the general
   store keeper decides.
9. Everything is recorded so a farm exceeding its allocation is visible.

## Corrections agreed

### 1. Round-down apportionment starves small farms — use largest remainder

Rounding each farm's share *down* to a measurable step gives a farm entitled to
4.5 g **zero**. Five such farms → 22.5 g all sits in the general store and nobody
gets anything. Not the intent.

**Use largest-remainder (Hamilton) apportionment in step units:**

```
steps_total = floor(reduced_qty / step)
entitlement_i = steps_total * (request_i / sum(requests))
allocated_i  = floor(entitlement_i)              # whole steps
leftover     = steps_total - sum(allocated_i)     # whole steps still unassigned
                                                  # hand out one at a time, to
                                                  # the largest fractional parts
remainder    = reduced_qty - steps_total * step    # stays in the general store
```

Properties that matter: never over-allocates (you cannot ship stock you do not
have), every allocation is physically measurable, and the split is proportional.
Ties broken by larger original request, then farm name, so the result is
deterministic and reproducible.

### 2. The worked example needs reconciling — **still open**

"5 farms wanting 10 each, reduced 50 → 45" gives **9 each**, not the 4.5 quoted.
4.5 would mean 50 → 22.5. **Resolved for entry mode** (see below), but the
example itself should be re-checked against a real case before implementing, in
case it reveals a different intent.

### 3. Reduction entry: either mode, per chemical

The GM can enter **either** a new absolute total (Amisil 50 → 45) **or** a
percentage cut, chosen per chemical line. Both resolve to a target quantity
before apportionment, so the algorithm above sees one number either way.

### 4. Step size is data, not code

"10 g is easier to measure than 1 g" is a per-UOM judgement, and sometimes
per-item — a 500 g bottle is not split at all, you hand over whole bottles.

The allocation step must be **configurable**, expressed in the item's stock UOM,
and converted through **ERPNext's own UOM conversion factors** (see
`crop_protection.item_uom_options` / `to_stock_qty`, added 2026-08-11). No
conversion table in application code: a constant would drift from whatever the
user maintains on the Item.

Default suggestion, to be confirmed: step = 1 for whole-number UOMs (Bottle,
Nos), 10 for Gram / ml, 0.1 for Kg / Litre.

### 5. Consumption averages need a source and a size normaliser

The suggestive figure ("average consumption per month") must come from **actual
Material Issues against spray Work Orders**, not planned quantities — otherwise
the suggestion just echoes last cycle's plan and compounds its errors.

It must also be **normalised by farm size** (per hectare, or per zone/bed count).
Raw monthly averages are not comparable across farms of different size and would
systematically under-serve the large ones.

Needs a minimum history before it suggests anything ("after several uses" — N to
be defined). Below that, no suggestion rather than a bad one.

This is explicitly a **suggestion the planner can override**, and lands after the
manual path works.

### 6. "More than half their stock" — define it, don't gate on it

Half of the lender's **on-hand at request time, net of already-approved outgoing
loans** — reuse the draft-aware availability logic already built
(`availableStock` / `rowAvailable`).

Note the compositional gap: two requests of 40% each trigger nothing
individually but together take 80%. Accepted, because this is an informational
nudge and not a control.

### 7. Loan privacy is a permissions job

"Only they can see this transaction" requires a `permission_query_conditions`
hook so a lender's users only ever load requests addressed to them. Filtering in
the frontend would leave the rows readable over the REST API.

### 8. Multi-item loaning is a doctype migration

`Chemical Transfer Request` holds `item_code` / `uom` / `requested_qty` on the
**parent**. Multi-item means moving them to a child table, with a patch
converting existing single-item requests into one-line children. Existing
`sources` (per-lender split with per-source approval) stay — but the relationship
between item lines and source lines needs deciding: per-item sources, or one
source set for the whole request.

### 9. Budget = the approved allocation

"Which farm is using more than they budgeted" becomes computable once phase 3
records each farm's approved allocation per chemical. The metric is
**consumption vs allocation**, with loans in/out as adjustments — a farm that
borrows raises its consumption without raising its allocation, so loans must
appear in the reconciliation or a borrower looks like an overspender.

## Open questions for the later phases

- Review 1: "the number does not have an override" — read as *the planner
  confirms their own figure and nobody else silently changes it*, with the GM's
  phase-2 amendment explicit and attributed. **Needs confirming.**
- Does a farm's allocation carry forward if unused, or reset each cycle?
- Can a planner revise after review 1 but before the GM's review?
- Per-item or per-request source sets on multi-item loans (see 8).
- Step-size defaults per UOM (see 4).
