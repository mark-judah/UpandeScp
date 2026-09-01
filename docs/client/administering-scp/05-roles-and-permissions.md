---
title: Roles and permissions
route: scp/admin/roles-and-permissions
order: 6
---

# Roles and permissions

## The seven SCP roles

Every role the app owns is prefixed `SCP`, so that `upande_scp` is
self-contained and cannot be confused with a site's own roles. All seven have
desk access.

| Role | Job |
|---|---|
| **SCP General Manager** | Oversight. Full control of every SCP doctype |
| **SCP Spray Plan Creator** | Builds spray plans, raises chemical requirements |
| **SCP Spray Plan Approver** | Approves plans and decides postponements |
| **SCP Spray Supervisor** | Runs the spray on the day; declares postponements |
| **SCP Scout** | Records scouting entries |
| **SCP Scouting User** | Same scouting access, for non-field staff |
| **SCP Chemical Store Keeper** | Issues chemicals, prints labels, manages stock |

These were renamed from unprefixed names (`General Manager`, `Store Keeper`,
`Scout` and so on). ERPNext's own roles and any CEO-style site roles were left
alone — they are not SCP's to rename.

## What each role can reach

43 doctypes carry at least one SCP role. The shape is more useful than the full
table.

**SCP General Manager** has read/write/create/delete on essentially everything —
all the masters, all the chemistry, all the equipment, all the settings. It is
the administrator role.

**SCP Scout and SCP Scouting User** are identical in the permission table. Both
get:

- read on the observation masters — Pest, Plant Disease, Weed, Predator,
  Physiological Disorder, Trap, Stage, Crop Scouted, Plant Section, and the
  filters
- read on Map Settings
- **read/write/create on `Scouting Entry`** and its metadata
- read/write/create/delete/submit on `Spray Application Logsheet`

They cannot touch chemistry, spray plans or settings.

**SCP Spray Plan Creator** gets read on Chemical and Foliar and their crop
profiles, and create rights on the chemical requirement and transfer documents.
Notably it has **read-only** access to Chemical itself — a creator uses chemical
data, it does not maintain it.

**SCP Spray Plan Approver** is deliberately narrow: read on Chemical and Foliar,
and **read/write on `Spray Plan Postponement`**. Approving a plan is not a
doctype permission at all — it happens through the app's own endpoints.

**SCP Spray Supervisor** gets what the day of the spray needs: read on chemistry,
`Spray Session Token` (read/create), `Sprayer Movement Session`
(read/write/create), `Spray Application Logsheet` (read/write/create/submit),
`Chemical QR Label` (read), and `Spray Plan Postponement` (read/create) — create,
because the supervisor *declares* a postponement and the approver decides it.

**SCP Chemical Store Keeper** gets read/write/create/delete on `Chemical`,
`Foliar` and their crop profiles, plus the transfer and label documents. It is
the only role besides the General Manager that can change chemical data.

Everyone can **read** Scouting and Crop Protection Settings; only the General
Manager can change it.

## Two things permissions do not control

**The app's own screens check their own rules.** Spray plan submission checks
for the Creator role directly rather than relying on doctype permissions, and
the SCP app's sidebar shows or hides whole sections by role — a Chemical Store
Keeper sees only the Stores section. So a permission table alone will not tell
you what someone sees.

**Farm scope.** Users are additionally scoped to the farms they are assigned to,
through the `Farm Spray Plan Creator`, `Farm Spray Plan Approver` and
`Farm Store Keeper` doctypes. A Creator with no farm assignment has the role and
still sees nothing.

## Adding someone

1. Give the **User** the right SCP role.
2. Give their **Employee** the right designation — see [Teams](04-teams.md).
3. Link the Employee to the User (`user_id`).
4. Assign them to farms if they create, approve or keep stores.

Miss step 2 and they cannot be picked. Miss step 3 and anything resolving an
employee from the session fails. Miss step 4 and their lists are empty.
