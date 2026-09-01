---
title: Application Plan
route: scp/using/application-plan
order: 9
---

# Application Plan — building a spray plan

`/scp_app#/<crop>/application-plan` — sidebar **Crop Protection → Application
Plan**. Roses only.

You need the **SCP Spray Plan Creator** role. Without it the page will not let
you submit.

## What a spray plan is

A spray plan is an **Application Floor Plan**: which greenhouses get sprayed,
with what, at what rate, on what date, against which targets. Behind the scenes
it is stored as an ERPNext Work Order — which is why the Desk sidebar calls the
list "Application Floor Plans".

## Building one

Broadly: pick the greenhouses, pick the chemicals, set rates, name the targets,
set the date, save the draft, then submit it for approval.

A new plan sits at **Pending Submission** until you submit it. Up to that point
it is a draft you can keep editing.

### The greenhouse list is filtered

You will not see every greenhouse on the site. Two settings control the list:

- an **allowed farms** list — only greenhouses on it are offered, and
- an **exclude keywords** list — any greenhouse whose name contains one of those
  substrings is dropped.

Your visible list is also scoped to the farms you are assigned to. If a
greenhouse you expect is missing, it is one of those three, not a fault.

### Targets are required and are checked

**At least one target is required.** A plan that does not say what it is
spraying against is rejected.

Targets are also checked against scope — you cannot name a target that does not
apply to what you are spraying.

### Rates are checked against limits

Each chemical carries a lower and upper rate limit. Entering a rate outside them
is refused, with a message naming the limit. This is the guard that stops a
mistyped decimal becoming a real over-application.

The screen works in **rate**, but what is stored is the **absolute quantity** —
the rate scaled by the area being sprayed. That conversion happens as you
build the plan, so what the approver and the store see is the real amount of
chemical the plan needs.

### Preventive sprays need a reason

If you classify a spray as preventive rather than a response to something
scouted, you must say why. A curative spray is justified by the scouting record
behind it; a preventive one has no such record, so the reason is the
justification.

### Resistance warnings

When you name chemicals, the app looks back over recent sprays on the same
greenhouse and warns if you are about to repeat an **IRAC** or **FRAC** mode of
action too soon — the rotation windows are set by your administrator (commonly
14 days for IRAC, 21 for FRAC).

These are **warnings, not blocks**. Repeating a mode of action is sometimes the
right call; doing it without noticing is not.

## Submitting

Submitting moves the plan from **Pending Submission** to **Awaiting Approval**
and puts it in front of an approver. See
[Approvals and the spray lifecycle](09-approvals.md).

Normally you can only submit your own drafts. An administrator can switch that
off site-wide so any creator may submit any draft.

## Drafts do not live forever

If enabled, a daily job stops plans that have sat unapproved for too long. The
number of days is a setting. A plan stopped this way was abandoned, not
postponed — if you want to move a spray, postpone it properly rather than
letting it lapse.

## Supporting views

| View | Use |
|---|---|
| **Chemical Stock** | What is actually on hand before you commit to a plan |
| **Historical** | Plans you have created before, and where each got to |
| **Postponements** | Plans moved off their original date |
| **Tank Mixes** | The mixes produced from approved plans |
