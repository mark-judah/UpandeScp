# Reliable "Stop Spray Plan" + post-manufacture reconciliation data

**Date:** 2026-06-19
**Status:** Design — pending user review
**Scope:** Backend only (`spray_plan_creator/spray_session.py`, `auto_material_issue.py`). The RN mobile app (not in this repo) renders the modal and calls the endpoints; this spec defines the backend contract it consumes.

## Background

The spray-plan lifecycle endpoints (`manufacture_tank_mix`, `start_spray_session`,
`end_spray_session`) are driven by a **React Native mobile app that is not checked
into these repos**. The web frontend (`frontend/`) does not call them. So both
deliverables here are backend changes; the app's UI (the modal, the Stop button) is
wired separately by whoever owns the RN app against the contract below.

## Part 1 — "Stop Spray Plan" must work regardless of who presses it

### Problem

`end_spray_session` ("Stop Spray Plan") already creates the Material Issue that takes
the manufactured tank mix **out of the greenhouse** (`build_and_submit_material_issue`
→ FG rows, `from_warehouse = greenhouse`). Verified working in a rolled-back run:
Material Issue issuing `thrips/bot` qty 1.0 out of `Kapkolia GH 09`.

It fails only at one line: `spray_session.py:749` calls
`_resolve_employee_from_session()` to set the SAL `supervisor_name`. That helper
**throws if the logged-in user has no active linked Employee** (and always throws for
`Administrator`). The RN app swallows the server error, so the operator sees "nothing
happens — it doesn't stop." Everything after that line already works.

### Fix

Resolve the supervisor the same robust, team-based way the Material Issue already
does — `resolve_supervisor_employee(wo)` (reads the WO's spray-team roster) — instead
of the session user. Stop then no longer depends on *who* is logged in.

Concretely, in `end_spray_session`:
- Replace `supervisor_emp = _resolve_employee_from_session()` with
  `supervisor_emp = resolve_supervisor_employee(wo)` (already imported in the module).
- This single value feeds `sal.supervisor_name`. The Material Issue independently
  calls `resolve_supervisor_employee(wo)` already, so both now agree.

### Idempotency (so a double-tap / retry "just works")

If the WO is **already `Completed`**, return success instead of throwing (mirror the
converge-to-existing pattern in `manufacture_tank_mix`), so a double-tap / retry is
safe:

```
if current_state == STATE_COMPLETED:
    return {"workflow_state": STATE_COMPLETED,
            "sal_submitted": wo.custom_spray_application_logsheet,
            "already": True}
```

The Material Issue has no WO backlink field, so the idempotent return does not
re-locate it (the goal is "don't throw on retry," not to re-report the MI). The
precondition for a *fresh* stop stays `Spraying In Progress` (unchanged).

### Out of scope (RN app)

"Remove the spray-plan watch and place it on a different component" is RN-app UI
wiring. With the backend no longer throwing, a plain Stop button calling
`end_spray_session(work_order)` succeeds. No backend change can move the RN watcher.

## Part 2 — Post-manufacture reconciliation data

The RN app wants a modal after "Confirm Tank Mix" showing the quantities manufactured
and whether they reconcile with what was scanned. Provide the data two ways.

### Reconciliation block (shared shape)

A new pure-ish helper `build_manufacture_reconciliation(wo, manufacture_se) -> dict`:

```python
{
  "manufactured": True,                 # a submitted Manufacture SE exists
  "produced_qty": 1.0,                  # FG tank-mix qty produced
  "chemicals": [
    {"item_code": "1114009", "item_name": "TELDOR",
     "consumed": 0.1,                   # raw qty consumed by the Manufacture SE
     "transferred": 0.1,                # WO required_items.transferred_qty
     "required": 0.1,                   # WO required_items.required_qty
     "scanned": True},                  # item_code present in wo.custom_chemical_scans
    ...
  ],
  "all_scanned": True,                  # every required chemical was scanned
  "quantities_match": True              # per row: consumed == transferred == required (tol 1e-6)
}
```

Computation:
- `consumed`: sum `qty` of Manufacture SE rows with `s_warehouse and not t_warehouse`, grouped by `item_code`.
- `produced_qty`: sum `qty` of rows with `t_warehouse and not s_warehouse` (the FG).
- `transferred` / `required`: from `wo.required_items` (`transferred_qty` / `required_qty`).
- `scanned`: `item_code in _scanned_codes(wo)`.
- `all_scanned`: `_required_chemical_codes(wo).issubset(_scanned_codes(wo))`.
- `quantities_match`: for every required item, `consumed ≈ transferred ≈ required` within `1e-6`.

Iterate over `wo.required_items` (the source of truth for what should be in the mix),
so a chemical that was transferred but somehow not consumed shows `consumed: 0` and
trips `quantities_match: False`.

### Wiring

1. **In the manufacture response** — `manufacture_tank_mix` adds
   `"reconciliation": build_manufacture_reconciliation(wo, manu_se)` to its return,
   including the two "already manufactured / converge-to-existing" branches (compute
   from the existing submitted Manufacture SE).

2. **Standalone endpoint** — new `@frappe.whitelist() get_manufacture_reconciliation(work_order)`:
   - Loads the WO, asserts AFP.
   - Finds the submitted Manufacture SE via `_find_submitted_manufacture_se(wo.name)`.
   - If none yet: return `{"manufactured": False, "produced_qty": 0, "chemicals": [...],
     "all_scanned": <bool>, "quantities_match": False}` (chemicals still list
     required/transferred/scanned so the app can show progress pre-manufacture).
   - If found: return `build_manufacture_reconciliation(wo, se)`.

## Components / files

- `spray_session.py`:
  - `end_spray_session` — swap supervisor resolution; add already-Completed idempotent return.
  - `build_manufacture_reconciliation(wo, manufacture_se)` — new helper.
  - `manufacture_tank_mix` — add `reconciliation` to all return branches.
  - `get_manufacture_reconciliation(work_order)` — new whitelisted endpoint.
- No change to `auto_material_issue.py` (already team-based and correct).

## Testing

- **Unit (pure):** `build_manufacture_reconciliation` against a synthetic WO + SE stub
  (dicts/SimpleNamespace) → asserts `consumed/transferred/required`, `all_scanned`,
  `quantities_match` true; and a mismatch case (consumed ≠ transferred) → `False`.
- **Integration (`kaitet.local`, rolled back):** drive scan → manufacture as a
  no-Employee user (e.g. Administrator) and assert `end_spray_session` **no longer
  throws** and creates the Material Issue out of the greenhouse. Assert
  `manufacture_tank_mix(...)["reconciliation"]["quantities_match"]` is `True` and
  `get_manufacture_reconciliation` returns the same block. Re-call `end_spray_session`
  on the Completed WO → returns existing MI, no throw (idempotency).

## Out of scope

- The RN app modal UI and Stop-button component (not in these repos).
- Any change to scan semantics (scans remain quantity-less presence records).
- The earlier `required_qty` single-absolute-truth work (separate, already merged on `kaitet`).
