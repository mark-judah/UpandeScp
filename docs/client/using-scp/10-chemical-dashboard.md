---
title: Chemical Dashboard
route: scp/using/chemical-dashboard
order: 11
---

# Chemical Dashboard

`/scp_app#/<crop>/chemical-dashboard`.

This is the store's view of chemicals: what is held, where, and how it is moving
against the spray plans that need it.

## Who sees it

It sits in the **Stores** section of the sidebar, which is visible only to the
**SCP Chemical Store Keeper** role. If you hold that role it is one of the four
views you have; if you do not, you will not see the section at all.

It is also reachable directly from the Desk sidebar's **Chemical Dashboard**
link, which is how people with broader oversight get to it.

## What it shows

Stock on hand per chemical and per store, with low-stock flagged against each
chemical's own threshold. That threshold is set per chemical, not globally, so a
product used in litres and one used in grams can both be sensible.

Because approved spray plans reserve the chemicals they will need, the figures
distinguish what is physically present from what is already committed. A drum
that is on the shelf but spoken for by an approved plan is not available for a
new one.

## The store keeper's other three views

| View | What it is for |
|---|---|
| **Spray Plan Transfers** | Issuing chemicals against approved plans |
| **Labels** | Printing the chemical transfer labels that travel with the issue |
| **Chemical Progress** | Every plan's lifecycle from the store's angle — what has been issued, mixed, sprayed |

## Checking stock before planning

Spray Plan Creators have their own read-only view of the same underlying
figures, **Chemical Stock**, under Crop Protection. Use it before committing to
a plan rather than discovering a shortfall after approval.

## Not covered here

Procurement — allocations, procurement cycles, purchase requirements and
farm-to-farm loaning — is documented in a later pass. Those views exist in the
app for the roles that use them.
