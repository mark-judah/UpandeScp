# Chemical procurement cycle — phase 3 design

**Date:** 2026-08-17
**Status:** implemented
**Follows:** `2026-08-11-store-model-and-notifications-design.md` (phase 0/1),
`2026-08-11-chemical-procurement-decisions.md` (the decisions this implements)

## What it does

Farms state what they need, two reviews turn that into one budgeted order, and the
receipt is split back to the farms in amounts the store can actually measure.

```
requirement (per farm)
      │ submit
      ▼
review 1 — the farm's planner ──reject──▶ amendment request ──grant──▶ back to review 1
      │ approve
      ▼
consolidate ──▶ review 2 — the GM cuts per chemical ──▶ lock as final
      │
      ▼
one Material Request (draft) ──▶ purchasing submits ──▶ PO ──▶ general store
      │
      ▼
apportion by request + carried credit, in whole steps
      │                                    │
      ▼                                    ▼
transfer to each farm's store        remainder stays in the pool
                                           │
                                           ▼
                                    planner asks ──▶ keeper decides ──▶ transfer
```

## Doctypes

| Doctype | Role |
| --- | --- |
| `Chemical Procurement Cycle` | the container: period, company, general store, status, consolidated `lines`, resulting `allocations` |
| `Chemical Procurement Cycle Item` | one consolidated chemical: requested total, reduction mode/value, approved qty, allocation step, `final_approved` |
| `Chemical Procurement Allocation` | one (chemical, farm) outcome: requested, credit in, basis, allocated, steps, credit out, target store, stock entry |
| `Chemical Purchase Requirement` | one farm's ask for one cycle, with its review state |
| `Chemical Purchase Requirement Item` | a line: item, qty, UOM, kind, note, and a `suggested_qty` slot for the consumption-based suggestion (not yet filled) |
| `Chemical Requirement Amendment` (+ `… Item`) | a structured change request: who, what each figure should become, why, and the decision |
| `Chemical Allocation Credit` | the carry-forward ledger, one row per (farm, item), named `farm::item_code` |
| `Chemical Allocation Change` | the audit spine: what changed, from, to, by whom, when, and who was notified |

`Chemical Transfer Request` is reused for pool draws with a new
`from_general_store` check. A pool draw *is* a directed request whose lender is the
shared store — same lines, same per-line decisions, same history. Only two things
differ: there is no lender farm, and the decider is the store keeper.

## The rules the code enforces

**A requirement is only edited while it is a Draft.** After review it takes an
amendment. `EDITABLE_STATES = ("Draft",)` is the whole rule; everything else falls
out of it. A rejection therefore requires a reason, because that reason is all the
planner has to work from.

**A granted amendment applies the figure and logs it in the same call.** Not "grant,
then let the requester save" — that leaves a window where the number has moved and
nothing says who moved it. A granted amendment returns the requirement to
`Submitted`, not `Draft`: the numbers are settled, what is needed is the
confirmation.

**Only planner-approved requirements count.** `COUNTED_STATES = ("Planner
Approved",)`. A draft is not a claim on the budget.

**Both reduction modes collapse to one quantity** before apportionment
(`_resolve_reduction`), clamped to the request — approving more than anybody asked
for is not a reduction.

**A final figure does not move.** `final_approved` blocks `set_reduction`, and
`consolidate` — which is re-runnable as requirements keep arriving — preserves the
approved quantity while still refreshing `total_requested`, so the GM can see the
ask moved after they locked it. That second path is the one that would have leaked.

**Every change is logged and announced together.** `log_change()` writes the row
and notifies the affected farm's planners in one function, naming the amount, the
actor and the direction. A change that is logged but not announced, or announced
but not logged, is the half-measure that makes an audit trail worthless.

## Apportionment and carry-forward

The maths lives in `store/apportion.py` (pure, no Frappe) and is unchanged from
phase 1 except for carry-forward:

* basis = this cycle's request **+** the farm's carried credit;
* largest-remainder in whole steps, deterministic ties;
* `credit_out = exact share of the distributable − allocated`, which makes the
  credits sum to **exactly** the stock left in the pool.

Measured on a 95/5 split with a 10 g step: the small farm goes from never being
served to being served every other cycle, and the ledger clears itself each time it
pays out.

Two properties the tests pin:

* **Credits conserve.** A farm the Hamilton pass rounded up carries a *debit*.
  Forgiving it would mint entitlement and the pool would stop reconciling.
* **A budget cut is not a debt.** 30/70 cut from 100 to 50 with a 10 g step: the
  small farm loses 15 g to the budget and 5 g to the step, and only the 5 carries.
  Crediting the 15 would make the reduction meaningless next cycle.

A farm that requests nothing keeps its credit rather than being pushed stock. A
debit larger than the new request stays outstanding rather than being written off
or turning the allocation negative.

## Deliberate choices

**The Material Request is left as a draft.** Submitting is purchasing's decision,
made in ERPNext with its own validations; auto-submitting from a crop-protection
screen would remove a checkpoint from a document that commits money. (It also does
not work on kaitet, which has no Price List records — but the reason stands
independently of that.)

**The consolidated MR names no farm.** kaitet makes `Material Request.custom_farm`
mandatory, but a cycle order belongs to the company, not one farm; naming an
arbitrary farm would make the order look like that farm's. Mandatory checking is
waived for that one document rather than inventing an owner. Site-local fields are
written only when `_has_field` finds them, since they have no owning module and do
not exist on a fresh site.

**One Stock Entry per farm, not per chemical.** The farm is the unit the movement is
about, and a keeper receiving eight chemicals wants one document to check against.
Rows with no target store are reported as skipped rather than silently dropped.

**Pool availability is net of what is already promised.** Without
`_reserved_from_pool`, two planners can each be approved for the last 5 kg and the
second transfer fails at the ledger — after the keeper has already said yes.
Approval re-checks it rather than trusting the number from request time.

**Asking for more than the pool holds is reported, not refused.** The keeper may
know stock is arriving, and a planner should not have to guess the pool's contents
to ask a question.

**Row-level visibility had to be extended.** A pool request has no lender farm, so
the existing `permission_query` would have hidden it from the very person who
decides it. The keeper's stores are now a clause of their own.

## What is not built

* **The consumption-based suggestion.** `suggested_qty` exists on the requirement
  line and stays blank. Decision 5 of the record still applies: it must come from
  actual Material Issues against spray Work Orders, normalised by farm size, with a
  minimum history before it says anything.
* **Step-size overrides.** `DEFAULT_STEPS` is by UOM only. A 500 g bottle is not
  split at all, so a per-item override is the obvious next need.
* **Receiving.** `preview_allocation` / `publish_allocation` accept a `received`
  map so the split follows what actually arrived, but nothing reads the Purchase
  Receipt automatically yet.

## Tests

* `test_apportion` — 31 cases, no site. The apportionment and carry-forward maths,
  including the six-cycle starvation trace.
* `test_procurement` — 30 cases against the live site. Review flow, amendment
  application and logging, both reduction modes, the final-figure lock **and** the
  re-consolidation path, credit reconciliation with the pool, pool reservation, and
  the permission refusals (against a real non-elevated planner).
* `procurement-api.test.ts` — the client-side `resolveReduction` mirror, so the
  preview the GM sees cannot drift from the server's answer.
