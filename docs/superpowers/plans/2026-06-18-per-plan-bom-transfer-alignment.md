# Per-plan BOM ↔ transfer alignment (Layer 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each per-plan tank-mix BOM store the *absolute* scaled chemical quantity (== the Work Order transfer) as its `stock_qty`, so a BOM backflush reproduces the transfer even when the `before_validate` guard does not run.

**Architecture:** Refactor `bom_resolver.py` to compute BOM item rows through two pure, unit-testable helpers — `build_bom_rows` (absolute qty + per-1000L rate from `(item_code, required_qty)` pairs) and `bom_item_payload` (the BOM child-row dict) — then wire `create_bom_for_plan` to use them. The minted BOM keeps `quantity = 1` and `uom = Tank Mix (1000L)`; `stock_qty`/`qty_consumed_per_unit` become absolute while `custom_application_rate` keeps the per-1000L recipe rate.

**Tech Stack:** Python, Frappe/ERPNext v15, `unittest` run via `bench run-tests`.

## Global Constraints

- Site for all DB/console/test commands: `kaitet.local` (authoritative). Never use the Kaitet MCP.
- Git commits: **no `Co-Authored-By` trailer**. Commit only the files listed per task.
- Target file: `upande_scp/serverscripts/spray_plan_creator/bom_resolver.py`.
- Invariant to preserve: at `fg_completed_qty == wo.qty == BOM.quantity == 1`, BOM backflush (`stock_qty × fg_completed_qty / BOM.quantity`) must equal the WO `required_qty` (the transfer). With those three equal to 1, that means **`stock_qty == required_qty`**.
- `custom_application_rate` / `custom_application_rateper_ha_` must continue to hold the **per-1000L rate** (consumers like `create_bom.py` and the rate-override check in `create_application_work_order.py` read these fields, not `stock_qty`).
- Spec: `docs/superpowers/specs/2026-06-18-per-plan-bom-transfer-alignment-design.md`.

---

### Task 1: `build_bom_rows` — absolute qty + per-1000L rate (pure)

Replaces the existing `rate_recipe_from_wo` (which returned only the per-1000L rate). New helper returns both numbers per item code, computed from plain `(item_code, required_qty)` pairs so it is testable without Frappe docs.

**Files:**
- Create: `upande_scp/serverscripts/tests/test_bom_resolver.py`
- Modify: `upande_scp/serverscripts/spray_plan_creator/bom_resolver.py:40-55` (replace `rate_recipe_from_wo`)

**Interfaces:**
- Produces: `build_bom_rows(pairs: Iterable[tuple[str, float]], water_volume: float) -> dict[str, dict[str, float]]` where each value is `{"qty": <absolute>, "rate": <per-1000L>}`. `qty` is the summed `required_qty`; `rate` is `qty / (water_volume/1000)`, or `qty` when `water_volume <= 0` (factor 1). Blank/None item codes are skipped; duplicate codes are summed.

- [ ] **Step 1: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_bom_resolver.py`:

```python
import unittest

from upande_scp.serverscripts.spray_plan_creator.bom_resolver import build_bom_rows


class TestBuildBomRows(unittest.TestCase):
    def test_absolute_qty_and_per_1000l_rate(self):
        # water_volume = 6 L -> factor 0.006; required_qty IS the transfer.
        rows = build_bom_rows(
            [("1114009", 0.006), ("1111156005", 0.0018), ("1113018", 0.0018)],
            6,
        )
        self.assertAlmostEqual(rows["1114009"]["qty"], 0.006)
        self.assertAlmostEqual(rows["1114009"]["rate"], 1.0)
        self.assertAlmostEqual(rows["1111156005"]["qty"], 0.0018)
        self.assertAlmostEqual(rows["1111156005"]["rate"], 0.3)
        self.assertAlmostEqual(rows["1113018"]["qty"], 0.0018)
        self.assertAlmostEqual(rows["1113018"]["rate"], 0.3)

    def test_no_water_volume_rate_equals_qty(self):
        rows = build_bom_rows([("X", 0.5)], 0)
        self.assertAlmostEqual(rows["X"]["qty"], 0.5)
        self.assertAlmostEqual(rows["X"]["rate"], 0.5)

    def test_aggregates_duplicate_codes(self):
        # water_volume = 1000 -> factor 1.0, so rate == qty.
        rows = build_bom_rows([("X", 0.002), ("X", 0.004)], 1000)
        self.assertAlmostEqual(rows["X"]["qty"], 0.006)
        self.assertAlmostEqual(rows["X"]["rate"], 0.006)

    def test_skips_blank_codes(self):
        rows = build_bom_rows([("", 1), (None, 2), ("X", 3)], 1000)
        self.assertEqual(set(rows), {"X"})


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bench --site kaitet.local run-tests --module upande_scp.serverscripts.tests.test_bom_resolver`
Expected: FAIL — `ImportError: cannot import name 'build_bom_rows'` (the symbol does not exist yet).

- [ ] **Step 3: Implement `build_bom_rows`**

In `upande_scp/serverscripts/spray_plan_creator/bom_resolver.py`, replace the whole `rate_recipe_from_wo` function (lines 40-55) with:

```python
def build_bom_rows(pairs, water_volume) -> dict[str, dict[str, float]]:
    """item_code -> {"qty": absolute, "rate": per-1000L}, from (code, required_qty) pairs.

    ``qty`` is the absolute amount for this plan (== the WO ``required_qty`` ==
    the transfer); it becomes the BOM item ``stock_qty`` so a guard-down BOM
    backflush at ``fg_completed_qty == wo.qty == BOM.quantity == 1`` consumes
    exactly the transfer. ``rate`` is the per-1000L recipe rate
    (``required_qty / (water_volume/1000)``), kept for display in
    ``custom_application_rate``. With no water volume the rate equals the qty
    (factor 1). Blank codes are skipped; duplicate codes are summed.
    """
    wv = flt(water_volume)
    factor = (wv / 1000.0) if wv > 0 else 1.0
    rows: dict[str, dict[str, float]] = {}
    for code, required_qty in pairs:
        if not code:
            continue
        rq = flt(required_qty)
        rate = rq / factor if factor else rq
        agg = rows.setdefault(code, {"qty": 0.0, "rate": 0.0})
        agg["qty"] = flt(agg["qty"]) + rq
        agg["rate"] = flt(agg["rate"]) + rate
    return rows
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bench --site kaitet.local run-tests --module upande_scp.serverscripts.tests.test_bom_resolver`
Expected: PASS (4 tests in `TestBuildBomRows`).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/tests/test_bom_resolver.py upande_scp/serverscripts/spray_plan_creator/bom_resolver.py
git commit -m "refactor(bom): build_bom_rows returns absolute qty + per-1000L rate"
```

---

### Task 2: `bom_item_payload` — BOM child row with absolute `stock_qty` (pure)

Isolates the field mapping that encodes the core fix: `qty`/`stock_qty`/`qty_consumed_per_unit` carry the absolute plan qty; the per-1000L rate lands only in the display fields.

**Files:**
- Modify: `upande_scp/serverscripts/tests/test_bom_resolver.py` (add a test class)
- Modify: `upande_scp/serverscripts/spray_plan_creator/bom_resolver.py` (add helper above `create_bom_for_plan`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `bom_item_payload(item_code: str, qty: float, rate: float, stock_uom: str) -> dict` — the dict appended to `bom.items`. `qty == stock_qty == qty_consumed_per_unit`; `custom_application_rate == custom_application_rateper_ha_ == rate`; `include_item_in_manufacturing == 1`; `conversion_factor == 1`.

- [ ] **Step 1: Write the failing test**

Append to `upande_scp/serverscripts/tests/test_bom_resolver.py` (before the `if __name__` block):

```python
class TestBomItemPayload(unittest.TestCase):
    def test_stock_qty_is_absolute_not_rate(self):
        from upande_scp.serverscripts.spray_plan_creator.bom_resolver import (
            bom_item_payload,
        )
        row = bom_item_payload("1114009", 0.006, 1.0, "Kilogram")
        # The fix: physical consumption fields hold the ABSOLUTE qty...
        self.assertEqual(row["qty"], 0.006)
        self.assertEqual(row["stock_qty"], 0.006)
        self.assertEqual(row["qty_consumed_per_unit"], 0.006)
        # ...and the per-1000L rate only lands on the display fields.
        self.assertEqual(row["custom_application_rate"], 1.0)
        self.assertEqual(row["custom_application_rateper_ha_"], 1.0)
        self.assertEqual(row["uom"], "Kilogram")
        self.assertEqual(row["stock_uom"], "Kilogram")
        self.assertEqual(row["include_item_in_manufacturing"], 1)
        self.assertEqual(row["conversion_factor"], 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bench --site kaitet.local run-tests --module upande_scp.serverscripts.tests.test_bom_resolver`
Expected: FAIL — `ImportError: cannot import name 'bom_item_payload'`.

- [ ] **Step 3: Implement `bom_item_payload`**

In `bom_resolver.py`, add this function immediately above `def create_bom_for_plan(`:

```python
def bom_item_payload(item_code, qty, rate, stock_uom) -> dict:
    """One ``bom.items`` row for a per-plan BOM.

    ``qty``/``stock_qty``/``qty_consumed_per_unit`` all carry the ABSOLUTE plan
    quantity so a BOM backflush at ``fg_completed_qty == BOM.quantity`` equals
    the transfer; the per-1000L ``rate`` lands only on the display fields.
    """
    return {
        "item_code": item_code,
        "qty": qty,
        "stock_qty": qty,
        "uom": stock_uom,
        "stock_uom": stock_uom,
        "qty_consumed_per_unit": qty,
        "custom_application_rate": rate,
        "custom_application_rateper_ha_": rate,
        "include_item_in_manufacturing": 1,
        "conversion_factor": 1,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bench --site kaitet.local run-tests --module upande_scp.serverscripts.tests.test_bom_resolver`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/tests/test_bom_resolver.py upande_scp/serverscripts/spray_plan_creator/bom_resolver.py
git commit -m "feat(bom): bom_item_payload stores absolute stock_qty, rate as display only"
```

---

### Task 3: Wire `create_bom_for_plan` to the new helpers + update docstring

Switch `create_bom_for_plan` from the per-1000L recipe loop to the absolute-qty rows, and correct the module docstring that still claims the BOM stores per-1000L rates. Verified by a rolled-back console run against `kaitet.local` that proves a guard-down BOM backflush would equal the transfer.

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/bom_resolver.py:1-20` (module docstring) and `:58-122` (`create_bom_for_plan` body)

**Interfaces:**
- Consumes: `build_bom_rows` (Task 1), `bom_item_payload` (Task 2).
- Produces: `create_bom_for_plan(wo) -> str | None` (signature unchanged). The minted BOM now has `items[*].stock_qty == wo.required_items[*].required_qty` and `items[*].custom_application_rate ==` per-1000L rate.

- [ ] **Step 1: Replace the recipe loop in `create_bom_for_plan`**

In `bom_resolver.py`, change the head of `create_bom_for_plan` from:

```python
    fg_item = getattr(wo, "production_item", None)
    recipe = rate_recipe_from_wo(wo)
    if not fg_item or not recipe:
        return None
```

to:

```python
    fg_item = getattr(wo, "production_item", None)
    pairs = [(r.item_code, r.required_qty) for r in (wo.required_items or [])]
    rows = build_bom_rows(pairs, getattr(wo, "custom_water_volume", 0))
    if not fg_item or not rows:
        return None
```

Then replace the item-append loop (currently lines ~98-114):

```python
    for code in recipe:
        rate = flt(recipe[code])
        if rate <= 0:
            continue
        suom = frappe.db.get_value("Item", code, "stock_uom")
        bom.append("items", {
            "item_code": code,
            "qty": rate,
            "stock_qty": rate,
            "uom": suom,
            "stock_uom": suom,
            "qty_consumed_per_unit": rate,
            "custom_application_rate": rate,
            "custom_application_rateper_ha_": rate,
            "include_item_in_manufacturing": 1,
            "conversion_factor": 1,
        })
```

with:

```python
    for code, agg in rows.items():
        qty = flt(agg["qty"])
        if qty <= 0:
            continue
        suom = frappe.db.get_value("Item", code, "stock_uom")
        bom.append("items", bom_item_payload(code, qty, flt(agg["rate"]), suom))
```

- [ ] **Step 2: Update the module docstring**

In `bom_resolver.py`, replace this bullet in the top docstring (lines ~11-13):

```python
  * The BOM stores per-1000L rates (``quantity = 1 Tank Mix (1000L)``); the WO's
    ``required_items`` carry the water-scaled absolute qtys, so
    ``rate = required_qty × 1000 / water_volume``.
```

with:

```python
  * The BOM stores the ABSOLUTE per-plan qtys as ``stock_qty`` (== the WO's
    ``required_items`` == the transfer), with ``quantity = 1 Tank Mix (1000L)``
    and ``wo.qty = 1``, so a BOM backflush reproduces the transfer even with the
    ``before_validate`` guard down. The per-1000L recipe rate
    (``required_qty × 1000 / water_volume``) is kept in ``custom_application_rate``
    for display.
```

- [ ] **Step 3: Confirm no dangling references to the removed function**

Run: `grep -rn "rate_recipe_from_wo" upande_scp --include=*.py | grep -v __pycache__`
Expected: **no output** (the function was removed in Task 1 and had no other callers).

- [ ] **Step 4: Verify the wiring against real data (rolled-back console)**

This builds a synthetic in-memory Work Order with the `MFG-WO-2026-02416` chemicals (real item codes), mints a BOM, asserts `stock_qty == required_qty` and `custom_application_rate ==` per-1000L rate, then **rolls back** so nothing persists.

Run: `bench --site kaitet.local console` and paste:

```python
import frappe
wo = frappe._dict(
    production_item="THR/BOT",
    company="Karen Roses",
    custom_farm="Kapkolia",
    custom_greenhouse="Kapkolia GH 07 - KR",
    custom_water_volume=6,
    custom_water_ph="5.5",
    custom_water_hardness="60",
    required_items=[
        frappe._dict(item_code="1114009", required_qty=0.006),
        frappe._dict(item_code="1111156005", required_qty=0.0018),
        frappe._dict(item_code="1113018", required_qty=0.0018),
    ],
)
from upande_scp.serverscripts.spray_plan_creator.bom_resolver import create_bom_for_plan
name = create_bom_for_plan(wo)
bom = frappe.get_doc("BOM", name)
expected_qty = {"1114009": 0.006, "1111156005": 0.0018, "1113018": 0.0018}
expected_rate = {"1114009": 1.0, "1111156005": 0.3, "1113018": 0.3}
for it in bom.items:
    print(it.item_code, "stock_qty=", it.stock_qty, "rate=", it.custom_application_rate)
    assert abs(it.stock_qty - expected_qty[it.item_code]) < 1e-9, it.item_code
    assert abs(it.custom_application_rate - expected_rate[it.item_code]) < 1e-9, it.item_code
print("OK total_cost (should be ~92, not ~15386):", bom.total_cost)
frappe.db.rollback()
print("rolled back — no BOM persisted")
```

Expected: prints three rows with `stock_qty` 0.006 / 0.0018 / 0.0018 and `rate` 1.0 / 0.3 / 0.3, `OK total_cost` near 92, and `rolled back`. No `AssertionError`.

- [ ] **Step 5: Re-run the unit suite**

Run: `bench --site kaitet.local run-tests --module upande_scp.serverscripts.tests.test_bom_resolver`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/bom_resolver.py
git commit -m "fix(bom): mint per-plan BOM with absolute stock_qty == transfer

create_bom_for_plan now stores the WO required_qty (the transfer amount)
as each BOM item stock_qty/qty_consumed_per_unit, keeping the per-1000L
rate in custom_application_rate. A BOM backflush at fg_completed_qty ==
wo.qty == BOM.quantity == 1 therefore equals the transfer, so the
consume==transfer invariant no longer depends solely on the
before_validate guard firing. Also fixes the inflated BOM cost."
```

---

## Self-Review

**1. Spec coverage:**
- "BOM item qty/stock_qty/qty_consumed_per_unit = required_qty" → Task 2 (`bom_item_payload`) + Task 3 wiring. ✓
- "keep custom_application_rate / custom_application_rateper_ha_ = per-1000L rate" → Task 1 (`rate`) + Task 2 (display fields). ✓
- "BOM.quantity stays 1; uom stays Tank Mix (1000L)" → unchanged in `create_bom_for_plan` (lines 89-90 untouched). ✓
- "store qty verbatim (no re-rounding)" → `build_bom_rows`/`bom_item_payload` never round. ✓
- "water_volume = 0/missing → rate falls back to qty (factor 1)" → Task 1 `test_no_water_volume_rate_equals_qty`. ✓
- "re-mint path inherits the same logic" → both `drafts.py` callers (`:452`, `:586`) go through the same `create_bom_for_plan`; no change needed. ✓
- "regression: create_bom.py / rate-override read custom_application_rate, unaffected" → those fields keep the per-1000L rate (Task 1/2); Step 3 grep confirms no other coupling to the removed function. ✓
- Edge: duplicate item codes summed → Task 1 `test_aggregates_duplicate_codes`. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows full code. ✓

**3. Type consistency:** `build_bom_rows` returns `dict[str, dict[str, float]]` with keys `"qty"`/`"rate"`; Task 3 reads `agg["qty"]`/`agg["rate"]`. `bom_item_payload(item_code, qty, rate, stock_uom)` call in Task 3 passes `(code, qty, flt(agg["rate"]), suom)` — order and arity match. ✓

## Out of scope (tracked for later)
Layer 2 (hard-assert guard blocks `consume != transfer`), Layer 3 (reconciliation report), stranded legacy CSU residual cleanup, agronomic correctness of the scaling formula, and Approach B (`wo.qty` = number of 1000L tanks) — all per the spec's "Out of scope" section.
