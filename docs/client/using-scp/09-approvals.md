---
title: Approvals and the spray lifecycle
route: scp/using/approvals
order: 10
---

# Approvals and the spray lifecycle

`/scp_app#/<crop>/approvals` — sidebar **Crop Protection → Approvals**.

## The seven states

Every spray plan moves along one chain:

```
Pending Submission → Awaiting Approval → Approved → Chemical Issued
    → Tank Mix Manufactured → Spraying In Progress → Completed
```

| State | Means | Moved on by |
|---|---|---|
| **Pending Submission** | A draft still being built | The creator, by submitting |
| **Awaiting Approval** | Waiting for a decision | The approver |
| **Approved** | Cleared to draw chemicals | The store, by issuing |
| **Chemical Issued** | Chemicals are out of the store | The store / supervisor, by mixing |
| **Tank Mix Manufactured** | The mix exists and has a short life | The supervisor, by starting the spray |
| **Spraying In Progress** | Being sprayed now | The supervisor, on finishing |
| **Completed** | Done | — |

The Approvals page shows plans waiting on a decision, scoped to the farms and
crop you are responsible for.

## Approving

Open a plan and you get the review: the greenhouses, the chemicals, the rates
and the targets — plus the **IRAC and FRAC resistance warnings**, which tell you
whether the same mode of action has been used on that greenhouse inside the
rotation window.

Read those warnings before approving. They are the main reason a second person
looks at a plan at all.

Approving moves the plan to **Approved** and releases it to the store.

## Following a plan through

Any plan can be expanded into a **timeline** showing each step, who did it and
when — approval, the chemical issue, whether labels were printed and scanned,
when spraying started, when it completed.

The same timeline is what the creator sees under **Historical** and the store
keeper under **Chemical Progress**. One lifecycle, three audiences.

## Postponing a plan

A plan that does not go out on its day is normal. Postponing it says so
properly, instead of leaving it to lapse or stopping it as abandoned.

**The supervisor declares a postponement; the approver decides it.**

Two rules govern it:

**Only up to Tank Mix Manufactured.** Postponement is allowed while the plan is
Pending Submission, Awaiting Approval, Approved or Chemical Issued. Once the tank
mix exists, it is not a plan any more — it is mixed chemical with a short life,
and moving the date would record a spray using a mix that is no longer what it
was. Past that point the plan is either sprayed or stopped.

**There is a daily cutoff.** On the plan's own spray date there is a deadline —
commonly 10:00. After it, a supervisor can no longer declare a postponement, and
the spray can no longer be started.

The two windows differ on purpose: the declaration gets a few minutes of grace
for the supervisor standing in the field at 10:01; starting a spray does not,
because the whole point of the cutoff is that a late spray is not a spray anyone
planned for.

The cutoff binds a plan whose date has already passed, too. That is what stops
yesterday's plan being quietly sprayed today.

A postponement also cannot move a spray more than a set number of days.

## A state you may see in old records

**Chemicals Issued Direct** appears on plans created between March and June
2026. Nothing in the app produces it any more, and it is not part of the chain
above — the timeline treats such a plan as though it were at the beginning.
Treat it as historical.
