---
title: Teams
route: scp/admin/teams
order: 5
---

# Teams

**Sidebar → Teams.** Five of these six entries open the same `Employee` list,
filtered.

## People are defined by designation, not by role

This is the thing to know. Each Teams entry is the Employee list filtered on
**designation**:

| Sidebar entry | Employee designation |
|---|---|
| Scouts | `Scouter` |
| Sprayers | `Sprayer` |
| Spray Supervisors | `Spray Supervisor` |
| Spray Applicators | `Spray Applicator` |
| Pump Operators | `Spray Pump Operator` |

So **you make someone a scout by setting their Employee designation to
`Scouter`** — not by granting a role. Note the spelling: the designation is
`Scouter`, while the role is `SCP Scout`. They are different strings and both
have to be right.

The two are independent and both matter:

| | Controls |
|---|---|
| **Designation** | Whether the person appears in the pickers — as a scout on an entry, a sprayer on a plan |
| **Role** | Whether their *user* can open the screen and save anything |

A person with the role but not the designation can log in and see the app but
cannot be selected. A person with the designation but not the role appears in
dropdowns but cannot log in and record anything. Most "why can't I find so-and-so"
questions are one of these two.

## An Employee also needs a User

Anyone who will actually use the app needs an **Employee record linked to a
User** — the `user_id` field. Several flows resolve the Employee from the logged-in
user, and fail cleanly when there is no link.

This is a known live problem: at least one account has been unable to complete
chemical scans purely because no Employee was linked to it.

## Spray Team

`Spray Team` is SCP's own doctype and the one genuine record in this group.

| Field | Purpose |
|---|---|
| `team_name` | The record name |
| `enabled` | Turn a team off without deleting it |
| `team` | A **Spray Team Details** child table — the members |

Teams group the people who spray together, so a plan can name a team rather
than listing individuals.

Only the **SCP General Manager** can create or change Spray Teams.

## Equipment

Not under Teams in the sidebar, but adjacent in practice:

| DocType | Holds |
|---|---|
| `Spray Equipment`, `Spray Equipment Details` | Sprayers and their specifications |
| `Chemical Equipment` | Equipment used in the store |
| `Tank And Valve` | Tanks and valves for mixing |

All are General Manager only.
