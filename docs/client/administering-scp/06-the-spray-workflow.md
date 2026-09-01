---
title: The spray workflow
route: scp/admin/the-spray-workflow
order: 7
---

# The spray workflow

## There is no Frappe Workflow

This surprises people, so it comes first.

The site has **no `Workflow` document** for spray plans. The seven states exist
as `Workflow State` records and are stored in `Work Order.workflow_state`, but
the transitions between them are driven by application code, not by a Frappe
workflow definition with transition rows.

Consequences worth knowing:

- You **cannot** change who may move a plan between states by editing a Workflow
  in Desk. There is nothing there to edit.
- The workflow-state field on a Work Order can be set by code paths that a
  Frappe workflow would have gated.
- The audit trail is the Work Order's **Workflow comments**, which the writing
  code leaves behind deliberately. That is what the lifecycle timeline reads.

## A spray plan is a Work Order

An **Application Floor Plan** is an ERPNext `Work Order` with `custom_type` set
to `Application Floor Plan`. The sidebar's Applications section opens the
filtered Work Order list.

The chemicals a plan needs are its `required_items`, and the quantity stored is
the **absolute quantity** — the rate already scaled by area. The app's screens
work in rate and convert before storing; anything reading the Work Order
directly is reading absolutes.

## The seven states

| Rank | State | Meaning |
|---|---|---|
| 0 | Pending Submission | Draft |
| 1 | Awaiting Approval | Submitted, waiting on a decision |
| 2 | Approved | Cleared for the store to issue |
| 3 | Chemical Issued | Chemicals out of the store |
| 4 | Tank Mix Manufactured | The mix exists |
| 5 | Spraying In Progress | Being sprayed |
| 6 | Completed | Done |

Anything with no state — a freshly created Work Order — is treated as Pending
Submission.

### Who writes each transition

The lifecycle module that renders the timeline **owns no transition**. Three
other modules are the writers: the approval path, the spray session, and the
stock-entry state handler. If a plan is stuck in a state, the fault is in one of
those three, not in the timeline.

## The eighth state in the data

**`Chemicals Issued Direct`** exists on 176 Work Orders created between
2026-03-10 and 2026-06-13.

Nothing in the current code produces or reads it. It is **not** in the state
ranking, so the lifecycle treats a plan in that state as rank -1 — it renders as
though it were at the very beginning.

It is legacy data. Leave it unless you are doing a deliberate migration; do not
add it to the ranking without deciding what it should mean.

## Postponement

A separate document, `Spray Plan Postponement`. The **supervisor declares, the
approver decides** — which is exactly why the supervisor has create-but-not-write
and the approver has read/write.

Two rules, both configurable:

**Only up to Tank Mix Manufactured.** Allowed while the plan is Pending
Submission, Awaiting Approval, Approved or Chemical Issued. Once the tank mix
exists it is no longer a plan but mixed chemical with a short life, and moving
the date would record a spray using a mix that is no longer what it was.

**A daily cutoff.** On the plan's own spray date, `spray_cutoff_time` (default
10:00) is the deadline. After it, no postponement may be declared and no spray
may be started. The declaration gets `postponement_grace_minutes` of slack; the
spray does not — a late spray is not a spray anyone planned for. The cutoff also
binds a plan whose date has passed, which is what stops yesterday's plan being
sprayed today.

`postponement_max_days` caps how far a spray can move.

## Auto-cancelling dormant plans

A daily job can stop plans that have sat unapproved too long. It ships
**disabled**.

| Setting | Effect |
|---|---|
| `auto_cancel_enabled` | The master switch |
| `auto_cancel_dormant_days` | Days since creation before an unapproved plan is stopped |
| `auto_cancel_apply_to_backlog` | When off, only plans created after activation are affected |
| `auto_cancel_activated_on` | Stamped the first time it is enabled |

Turn it on only after deciding about the backlog. With
`auto_cancel_apply_to_backlog` on, enabling it will stop every old dormant plan
at once.

## Other gates in Settings

| Setting | Effect |
|---|---|
| `bypass_owner_check` | When on, any Creator may submit any draft, not only their own |
| `allow_submit_without_biometric` | Offers a non-biometric path on Spray Plan Transfers |
| `csu_scan_verification` | How a sprayer confirms each chemical taken from the store |
| `loaning_enabled` | Farm-to-farm chemical loaning, with a depletion percentage and a request timeout |
| `progress_email_enabled` | A daily digest of today's scheduled sprays, at a configurable hour |
| `app_timezone` / `timezone_locked` | Leave blank to follow ERPNext, which is almost always right. Locked by default |

The two biometric-related switches weaken a control that exists for a reason.
Turn them on deliberately, and turn them back off.
