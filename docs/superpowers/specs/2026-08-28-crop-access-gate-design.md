# Crop access gate

**Status:** approved, phase 1 in progress
**Date:** 2026-08-28

Limit what a user sees to the crops grown on farms belonging to their Employee's
company — and to every company beneath it in the company tree.

## Why

Everyone sees every crop. The SCP Navigation workspace block builds one tile per
`Crop Scouted` from a plain `frappe.db.get_list`, so all three crops appear for
everyone. Peter Kamuren (Karen Roses) should see roses; Elvis Koskei (Kaitet Ltd.)
should see coffee and avocado; a Kaitet Group user should see all three.

## The chain

```
user → Employee.user_id → Employee.company
     → Company lft BETWEEN c.lft AND c.rgt      (descendants; nested set, one query)
     → Farm.company IN (…)
     → Crop Scouted.farms ∋ farm
```

Company is a real nested-set tree: `Kaitet Group` spans lft 1–16; `Karen Roses`
is a leaf at 2–3. Descendants are one indexed range query, never recursion.

## Rules

| question | answer |
|---|---|
| empty `Crop Scouted.farms` | visible to **nobody** (inverts today's "applies to all") |
| no Employee, or Employee with no company | sees nothing |
| bypass | Administrator and System Manager only |
| `SCP General Manager` | **not** a bypass — Peter is a GM and still sees only roses |
| more than one Employee row | union of their companies |

`None` from a resolver means unrestricted and is returned only for the two bypass
roles. Everyone else gets a set, and an **empty set means nothing, never everything**.
This mirrors the `None`-means-unscoped sentinel `_approver_allowed_greenhouses`
already uses.

## `crop_scope.py`

```python
allowed_companies(user=None) -> set[str] | None
allowed_farms(user=None)     -> set[str] | None
allowed_crops(user=None)     -> set[str] | None
assert_crop(crop, user=None) -> None            # raises PermissionError
```

Cached per request in `frappe.local`: four indexed queries, hit repeatedly per page.

## Data corrections

```
+ Coffee → Endebess
+ Coffee → Saboti
− Rose   → Vale        # bad input; this is what would have leaked roses to Elvis
```

Left in place deliberately, for the validation to surface rather than a guess to
remove:

- `Rose → Eldama` — Eldama has no company, so no user reaches it through the chain.
- `Rose → SIMO` — SIMO's company is *Kaitet Group*, the parent, so only a
  group-level user gets it. Peter does not.

A `Crop Scouted` validate hook **warns** when a tagged farm has no beds of that
crop's unit type (Bed=rose, Row=avocado, Band=coffee). Warn, not throw: a farm can
be planted before it is scouted, which is exactly coffee's position today — it has
no beds, no scouting entries and no farms on kaitet.

## Enforcement — two surfaces, one resolver

**Hooks**, for the desk and everything generic:

```python
permission_query_conditions = {"Crop Scouted", "Scouting Entry", "Work Order"}
has_permission              = { the same three }
```

Each returns a SQL fragment, or `1=0` when the set is empty — that is what makes it
fail closed. This covers the workspace tiles with **no change to the navigation
block**, because `frappe.db.get_list` is permission-checked; and list views, link
dropdowns, standard reports and REST come with it.

**The helper**, for SCP's own endpoints. Hooks cannot reach `frappe.get_all` or raw
SQL, and that is most of this app's read path. Each endpoint opts in by calling the
resolver. The list is written down because a missed call site is a hole:

```
getCropsScouted · get_farm_data_bundle · get_farm_hierarchy_info
dashboard_aggregates/* · reports/* · notification recipients
spray_plan_approval (fold crop into _approver_allowed_greenhouses)
```

## Phases

1. resolver + data patch + validation + `Crop Scouted` hook — fixes the workspace
   symptom, hides nothing that exists.
2. `Scouting Entry` / `Work Order` conditions + the read endpoints — this is where
   live data starts being hidden.
3. notifications, approvals, reports.

## Out of scope

Per-crop reports (avocado per-block, coffee KEPHIS weekly on ISO weeks) are a build,
not a gate, and get their own design.
