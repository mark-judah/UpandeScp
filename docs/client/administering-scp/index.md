---
title: Administering SCP
route: scp/admin
order: 1
---

# Administering Upande SCP

For whoever configures SCP: the reference data scouts pick from, the farm
structure the map is drawn on, the chemistry behind spray plans, and who is
allowed to do what.

If you are looking for how to record an observation or build a spray plan, that
is the other book — [Using SCP](/scp/using).

## Where you work

Administration is **Desk work**. The five links at the top of the SCP sidebar go
out to the separate app at `/scp_app`; everything below them is Desk, and that
is where this book lives.

## Read this first — several labels are not what they say

The SCP sidebar renames standard ERPNext doctypes to farm language. This is good
for users and confusing for administrators, because the doctype you need to
search for is not the one on the label.

| Sidebar label | Actual DocType |
|---|---|
| **Greenhouses** | `Warehouse` |
| **Crops** | `Item` |
| **Chemicals** | `Item` |
| **Scouts / Sprayers / Spray Supervisors / Spray Applicators / Pump Operators** | `Employee`, filtered |
| **Application Floor Plans** | `Work Order` |

There is no Greenhouse doctype, no Crop doctype and no Spray Plan doctype. If
you go looking for one you will not find it.

Two of those labels also point somewhere slightly out of date:

- **Chemicals** opens the Item list, but a chemical's agronomic properties no
  longer live on the Item — they live on a separate **Chemical** record. See
  [Chemistry](03-chemistry.md).
- **Beds** and **Zones** are real doctypes, but they belong to **upande_core**,
  not to SCP. Changes there affect other apps.

## Chapters

1. [Observations and threats](01-observations-and-threats.md) — what scouts can record
2. [Farm and infrastructure](02-farm-and-infrastructure.md) — the map's skeleton
3. [Chemistry](03-chemistry.md) — chemicals, foliars, FRAC/IRAC/GHS
4. [Teams](04-teams.md) — the Employee-backed lists
5. [Roles and permissions](05-roles-and-permissions.md) — the seven SCP roles
6. [The spray workflow](06-the-spray-workflow.md) — seven states end to end

## Settings live in one place

Nearly every threshold, window and toggle in this book is in **Scouting and
Crop Protection Settings** — a single doctype with tabs for the spray plan and
for chemicals. Where a chapter says "configurable", that is where.

## Not covered yet

Chemical procurement — allocations, procurement cycles, purchase requirements,
transfer requests and the FRAC/IRAC/GHS compliance reporting built on them — is
a second pass.
