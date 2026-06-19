# `required_qty` as the Single Absolute Truth — Implementation Plan (corrected)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the backend from corrupting the absolute chemical amount the frontend already computes — so the Work Order `required_qty` stays equal to the per-plan BOM `stock_qty`, the Material Transfer, and the consumed quantity ("what we require is what is manufactured").

**Architecture:** The frappe15 React page `ApplicationPlan.tsx` lets the operator edit a per-1000 L rate, derives the absolute `stock_qty = rate × waterVolume/1000`, and sends that absolute as `application_rate`. `drafts.py` already stores it verbatim as `required_qty`, and `bom_resolver` (Approach A) already copies it into the BOM `stock_qty`. The single corruption is `bulk.py`'s rebase, which multiplies the already-absolute value by `wv/1000` again on bulk-submit. We delete that rebase, derive the per-1000 L rate where it's genuinely needed (approval rate-limit check, SAL display), and make water volume mandatory.

**Tech Stack:** Python 3.10 (Frappe/ERPNext v15 app `upande_scp`, frappe15 bench), pure-function `unittest` tests via pytest. **No frontend change** (the frontend already computes and displays the absolute correctly).

## Global Constraints

- **No backend scaling of `required_qty`.** The frontend sends the absolute; the backend stores and forwards it verbatim. The only conversion in the backend is the inverse (`absolute → rate`) for display/validation reads.
- **No fallbacks / heuristics.** Water volume is mandatory (validated `> 0`). No "looks unscaled" guessing. (`absolute_to_rate` keeps a `wv ≤ 0 → return qty` read-path guard only, for displaying legacy rows.)
- **Exactness.** `required_qty`, BOM `stock_qty`, and the transfer stay byte-identical — no re-rounding.
- **Commits:** Per repo `CLAUDE.md` — **no `Co-Authored-By` trailer**. Commit per task; executing the plan is the authorization to commit. All work lands on branch `kaitet` (frappe15); the operator will port any later mona-branch frontend separately (none needed here).
- **Frappe-coupled verification** uses the authoritative local site only: `bench --site kaitet.local console` (per `CLAUDE.md`; never the Kaitet MCP). Wrap any console write in `frappe.db.rollback()`.

**Test commands (reference):**
- Pure unit tests: `cd /home/ubuntu/stive/code/frappe15 && env/bin/python -m pytest apps/upande_scp/upande_scp/serverscripts/tests/<file>.py -v`

---

### Task 1: Pure `absolute_to_rate` helper

**Files:**
- Create: `upande_scp/serverscripts/spray_plan_creator/quantities.py`
- Test: `upande_scp/serverscripts/tests/test_quantities.py`

**Interfaces:**
- Produces: `absolute_to_rate(required_qty, water_volume) -> float` — `required_qty / (water_volume/1000)`; `wv ≤ 0` returns `required_qty` unchanged (read-path safety).

- [ ] **Step 1: Write the failing test**

Create `upande_scp/serverscripts/tests/test_quantities.py`:

```python
import unittest

from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate


class TestAbsoluteToRate(unittest.TestCase):
    def test_recovers_per_1000l_rate_from_absolute(self):
        self.assertAlmostEqual(absolute_to_rate(0.1, 100), 1.0)
        self.assertAlmostEqual(absolute_to_rate(0.04, 100), 0.4)
        self.assertAlmostEqual(absolute_to_rate(1.0, 1000), 1.0)

    def test_zero_water_volume_returns_qty_unchanged(self):
        # Read-path safety for legacy rows with no water volume.
        self.assertAlmostEqual(absolute_to_rate(0.5, 0), 0.5)

    def test_zero_qty_is_zero(self):
        self.assertEqual(absolute_to_rate(0, 100), 0.0)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/ubuntu/stive/code/frappe15 && env/bin/python -m pytest apps/upande_scp/upande_scp/serverscripts/tests/test_quantities.py -v`
Expected: FAIL — `ModuleNotFoundError: ... quantities`.

- [ ] **Step 3: Write the module**

Create `upande_scp/serverscripts/spray_plan_creator/quantities.py`:

```python
"""Pure conversion between a tank-mix absolute amount and its per-1000 L rate.

The frontend (``ApplicationPlan.tsx``) computes the ABSOLUTE amount for a tank
(``rate x water_volume / 1000``) and sends it; the backend stores it verbatim as
the Work Order ``required_qty`` (== transfer == per-plan BOM ``stock_qty`` ==
consumed). The per-1000 L rate is derived only for display and agronomic
rate-limit checks.
"""
from frappe.utils import flt


def absolute_to_rate(required_qty, water_volume) -> float:
    """Absolute tank amount -> per-1000 L rate.

    Read-path safety: a legacy row with no water volume returns the stored qty
    unchanged (factor 1). Write paths validate ``water_volume > 0`` (see
    ``drafts._validate_payload``), so that branch only guards display of
    pre-existing data.
    """
    wv = flt(water_volume)
    if wv <= 0:
        return flt(required_qty)
    return flt(required_qty) / (wv / 1000.0)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/ubuntu/stive/code/frappe15 && env/bin/python -m pytest apps/upande_scp/upande_scp/serverscripts/tests/test_quantities.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/quantities.py upande_scp/serverscripts/tests/test_quantities.py
git commit -m "feat(qty): pure absolute_to_rate helper for per-1000L derivation"
```

---

### Task 2: Route `build_bom_rows` through the shared helper (DRY)

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/bom_resolver.py:43-65`
- Test: `upande_scp/serverscripts/tests/test_bom_resolver.py` (existing — must stay green)

**Interfaces:**
- Consumes: `absolute_to_rate` (Task 1).
- Produces: `build_bom_rows(pairs, water_volume)` — unchanged signature/return shape (`{code: {"qty": absolute, "rate": per-1000L}}`).

- [ ] **Step 1: Baseline — confirm existing tests pass**

Run: `cd /home/ubuntu/stive/code/frappe15 && env/bin/python -m pytest apps/upande_scp/upande_scp/serverscripts/tests/test_bom_resolver.py -v`
Expected: PASS (5 tests).

- [ ] **Step 2: Refactor `build_bom_rows`**

In `bom_resolver.py`, add after `from frappe.utils import flt`:

```python
from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate
```

Replace the body of `build_bom_rows` (lines 54-65) with:

```python
    rows: dict[str, dict[str, float]] = {}
    for code, required_qty in pairs:
        if not code:
            continue
        rq = flt(required_qty)
        agg = rows.setdefault(code, {"qty": 0.0, "rate": 0.0})
        agg["qty"] = flt(agg["qty"]) + rq
        agg["rate"] = flt(agg["rate"]) + absolute_to_rate(rq, water_volume)
    return rows
```

- [ ] **Step 3: Run existing BOM tests**

Run: `cd /home/ubuntu/stive/code/frappe15 && env/bin/python -m pytest apps/upande_scp/upande_scp/serverscripts/tests/test_bom_resolver.py -v`
Expected: PASS (5 tests) — identical behaviour, now DRY.

- [ ] **Step 4: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/bom_resolver.py
git commit -m "refactor(bom): build_bom_rows derives rate via shared absolute_to_rate"
```

---

### Task 3: Delete the `bulk.py` rebase (the double-scaler)

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/bulk.py` — remove `_recalc_required_qty_from_water_volume` (lines ~17-79) and its call site (lines ~121-127)

**Interfaces:**
- Produces: bulk submit path no longer re-scales `required_qty`; the absolute the frontend sent (stored by `drafts.py`) flows through unchanged.

- [ ] **Step 1: Remove the call site**

In `bulk.py`, delete the pre-flight comment block and call (lines ~121-127):

```python
        # Pre-flight: rebase each Work Order Item's required_qty so the
        # downstream Material Transfer for Manufacture inherits the
        # water-volume-driven ceiling. Legacy drafts created before the
        # frontend fix often hold a flat BOM line value; bulk-submit
        # uses raw SQL and bypasses the watchdog Server Script, so we
        # inline the same recalc here.
        _recalc_required_qty_from_water_volume(name)
```

- [ ] **Step 2: Remove the function**

Delete the entire `_recalc_required_qty_from_water_volume` definition (lines ~17-79). Leave `frappe`/`flt` imports (used elsewhere in the file — verify with a quick grep before removing any import).

- [ ] **Step 3: Verify the module imports clean and the symbol is gone**

Run: `bench --site kaitet.local console`:

```python
import importlib
from upande_scp.serverscripts.spray_plan_creator import bulk
importlib.reload(bulk)
assert not hasattr(bulk, "_recalc_required_qty_from_water_volume"), "rebase still present"
print("bulk rebase removed; module imports clean")
```

Expected: prints the success line.

- [ ] **Step 4: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/bulk.py
git commit -m "fix(spray): drop bulk required_qty rebase (frontend already sends the absolute)"
```

---

### Task 4: Derive the per-1000 L rate at the two read sites

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/approval_review.py:35`
- Modify: `upande_scp/serverscripts/spray_plan_creator/spray_session.py:548-555`

**Interfaces:**
- Consumes: `absolute_to_rate` (Task 1); `required_qty` is the absolute.
- Produces: approval rate-limit checks and the SAL `rate` field use the derived per-1000 L rate; SAL `pesticide_quantity` stays the absolute.

- [ ] **Step 1: Approval review — compare the rate, not the absolute**

In `approval_review.py`, add the import (with the other module imports):

```python
from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate
```

Replace line 35:

```python
        rate = r.required_qty
```

with:

```python
        # Rate limits (custom_lower_rate_limit/custom_upper_rate_limit) are
        # per-1000 L; required_qty is the absolute, so derive the rate to compare.
        rate = absolute_to_rate(r.required_qty, wo.custom_water_volume)
```

- [ ] **Step 2: SAL — rate is derived, quantity is the absolute**

In `spray_session.py`, add the import:

```python
from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate
```

Replace the appended dict body (lines 551-553):

```python
                "pesticide_name": r.item_name or r.item_code,
                "rate": str(r.required_qty) if r.required_qty else None,
                "pesticide_quantity": flt(r.required_qty) if r.required_qty else None,
```

with:

```python
                "pesticide_name": r.item_name or r.item_code,
                "rate": (
                    str(absolute_to_rate(r.required_qty, wo.custom_water_volume))
                    if r.required_qty else None
                ),
                "pesticide_quantity": flt(r.required_qty) if r.required_qty else None,
```

- [ ] **Step 3: Verify on `kaitet.local` (read-only)**

Run: `bench --site kaitet.local console`:

```python
from upande_scp.serverscripts.spray_plan_creator.quantities import absolute_to_rate
wo = frappe.get_doc("Work Order", frappe.get_all(
    "Work Order", {"custom_type": "Application Floor Plan"},
    order_by="creation desc", limit=1)[0].name)
for r in wo.required_items:
    print(r.item_code, "abs=", r.required_qty,
          "rate=", absolute_to_rate(r.required_qty, wo.custom_water_volume))
```

Expected: `rate` values are clean per-1000 L figures (legacy/corrupted WOs may differ — that's pre-fix data, not this code).

- [ ] **Step 4: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/approval_review.py upande_scp/serverscripts/spray_plan_creator/spray_session.py
git commit -m "fix(spray): derive per-1000L rate from absolute at approval check + SAL"
```

---

### Task 5: Make water volume mandatory

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/drafts.py` — `_validate_payload` (line ~352-369)

**Interfaces:**
- Produces: `_validate_payload` raises when `custom_water_volume <= 0`.

- [ ] **Step 1: Confirm `flt` is imported in `drafts.py`**

Check the top of `drafts.py` for `from frappe.utils import flt`. If absent, add it.

- [ ] **Step 2: Add the validation**

In `_validate_payload`, after the existing chemical check (the `if not chems ...` block), add:

```python
    wv = flt(payload.get("custom_water_volume"))
    if wv <= 0:
        frappe.throw("Water volume (L) is required and must be greater than zero.")
```

- [ ] **Step 3: Verify on `kaitet.local` (rolled back)**

Run: `bench --site kaitet.local console`:

```python
from upande_scp.serverscripts.spray_plan_creator.drafts import _validate_payload
import frappe.exceptions
try:
    _validate_payload({"custom_classification": "Curative", "chemicals": [{"x": 1}],
                       "_skip_target_validation": 1, "_skip_bom_validation": 1,
                       "custom_water_volume": 0}, {})
    print("FAIL: did not raise")
except frappe.exceptions.ValidationError:
    print("OK: zero water volume rejected")
frappe.db.rollback()
```

Expected: prints `OK: zero water volume rejected`. (If the chemicals/target guards trip first, adjust the payload so water-volume is the failing check.)

- [ ] **Step 4: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/drafts.py
git commit -m "fix(spray): require water volume > 0 on plan creation"
```

---

## Self-Review

**Spec coverage:**
- Delete `bulk.py` rebase → Task 3. ✓
- Derive rate at approval + SAL → Task 4. ✓
- Water volume mandatory → Task 5. ✓
- `absolute_to_rate` helper + DRY `build_bom_rows` → Tasks 1-2. ✓
- No declaration scaling / no frontend change / no read-back change → reflected by their *absence* (Global Constraints + spec "Not changing"). ✓

**Placeholder scan:** No TBD/TODO; every code step shows actual code.

**Type consistency:** `absolute_to_rate(qty, wv)` used identically in Tasks 2 and 4. `flt` import confirmed in Task 5.

## Notes / risks

- **Legacy in-flight plans** carry corrupted quantities (the dump's `0.01`/`1`). This plan fixes the source; backfilling existing plans is out of scope.
- **Order:** Task 1 before 2 and 4 (they import the helper). Tasks 3/4/5 are independent of each other.
- **`custom_updated_required_qty`** (orphaned parallel field) retirement is deferred — no live reader; optional later cleanup.
