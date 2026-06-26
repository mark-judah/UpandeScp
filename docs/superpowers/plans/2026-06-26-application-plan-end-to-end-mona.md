# Application Plan end-to-end (mona) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the React Application Plan work end-to-end on the mona site — correct latest-scout date, 1-hectare-per-greenhouse area, a resolvable chemical/fertilizer store, farm-scoped spray teams, kit→CSU destination, and the custom-field fixtures the flow needs.

**Architecture:** Five small, independently-testable fixes plus a fixtures addition. Pure logic (area math, team filtering, warehouse classification) is extracted into pure functions with unit tests; thin DB/HTTP layers wrap them. Backend in `upande_scp/serverscripts` + the `spray_plan_settings` doctype; frontend in `frontend/src`.

**Tech Stack:** Frappe v16 (Python 3, `unittest`/pytest), React + TypeScript (Vite, Vitest).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-26-application-plan-end-to-end-mona-design.md`.
- Site for manual checks: `mona.local`. Never use the Kaitet MCP; use `bench --site mona.local ...` for data.
- **Commit messages: NO `Co-Authored-By` trailer** (repo rule in CLAUDE.md). Commit per task.
- Fixtures change ships **fields only**, never records.
- Water rate constant: `WATER_VOLUME_RATE = 1000` L/ha (unchanged).
- Full greenhouse = exactly `1.000` ha; partial scope scaled by bed-count share.
- Spray-team scoping: show team when its `custom_farm` equals the greenhouse's farm OR is empty; hide other-farm teams.
- Python tests run with: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest <path> -v` (from `apps/upande_scp`).
- Frontend tests run with: `npx vitest run <path>` (from `frontend/`).

---

## File Structure

**Create:**
- `upande_scp/serverscripts/warehouse_classify.py` — shared store/CSU name predicates.
- `upande_scp/serverscripts/tests/test_warehouse_classify.py`
- `upande_scp/serverscripts/tests/test_allowed_store_warehouses.py`
- `upande_scp/serverscripts/tests/test_latest_scouting_date.py`
- `upande_scp/serverscripts/tests/test_fixtures_custom_fields.py`
- `frontend/src/lib/application-plan-area.ts` — pure `computeAreaHa`.
- `frontend/src/lib/spray-team-filter.ts` — pure `filterTeamsByFarm`.
- `frontend/src/lib/__tests__/application-plan-area.test.ts`
- `frontend/src/lib/__tests__/spray-team-filter.test.ts`

**Modify:**
- `upande_scp/hooks.py` — add 5 custom-field names to the `Custom Field` fixture allowlist.
- `upande_scp/serverscripts/spray_plan_creator/stock.py` — source regexes from the shared module.
- `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.py` — predicate-based store matching.
- `upande_scp/serverscripts/scouting_metrics_api.py` — `get_latest_scouting_date(greenhouse=None)`.
- `frontend/src/lib/scouting-api.ts` — `fetchLatestScoutingDate(greenhouse?)`.
- `frontend/src/pages/ApplicationPlan.tsx` — wire area, last-scout, team filter, kit CSU readout.

---

## Task 1: Add missing custom fields to fixtures

**Files:**
- Modify: `upande_scp/hooks.py` (the `fixtures` list, `Custom Field` entry's `name in [...]`)
- Test: `upande_scp/serverscripts/tests/test_fixtures_custom_fields.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `hooks.fixtures` contains a `Custom Field` dict whose filter `in`-list includes the 5 names.

- [ ] **Step 1: Write the failing test**

```python
# upande_scp/serverscripts/tests/test_fixtures_custom_fields.py
import unittest

from upande_scp import hooks


REQUIRED = [
    "Warehouse-custom_farm",
    "BOM-custom_farm",
    "Cost Center-custom_farm",
    "Work Order-custom_chemical_scans",
    "Work Order-custom_spray_application_logsheet",
]


def _custom_field_names():
    for f in hooks.fixtures:
        if isinstance(f, dict) and f.get("doctype") == "Custom Field":
            # filters == [["name", "in", [ ...names... ]]]
            return f["filters"][0][2]
    raise AssertionError("no Custom Field fixture found")


class TestRequiredCustomFieldFixtures(unittest.TestCase):
    def test_required_fields_present(self):
        names = _custom_field_names()
        for n in REQUIRED:
            self.assertIn(n, names)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_fixtures_custom_fields.py -v`
Expected: FAIL — `Warehouse-custom_farm` (and others) not in list.

- [ ] **Step 3: Add the names to the fixtures allowlist**

In `upande_scp/hooks.py`, find the `Custom Field` fixture's name list (it currently contains entries like `"Warehouse-custom_zone_numbering"`, `"Spray Team-custom_farm"`). Add these five lines inside that `[...]` list (place near related entries; exact position doesn't matter):

```python
                        # Farm scoping backbone + spray-execution fields
                        # needed by the Application Plan flow.
                        "Warehouse-custom_farm",
                        "BOM-custom_farm",
                        "Cost Center-custom_farm",
                        "Work Order-custom_chemical_scans",
                        "Work Order-custom_spray_application_logsheet",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_fixtures_custom_fields.py -v`
Expected: PASS.

- [ ] **Step 5: Sanity-check the fixture still exports**

Run: `cd /home/ubuntu/stive/code/frappe16 && bench --site mona.local export-fixtures --app upande_scp`
Expected: completes without error (it reads the same `custom_farm`/etc. fields that already exist on mona).

- [ ] **Step 6: Commit**

```bash
git add upande_scp/hooks.py upande_scp/serverscripts/tests/test_fixtures_custom_fields.py
git commit -m "feat(fixtures): ship custom fields the application-plan flow needs

Add Warehouse-custom_farm (farm-scoping backbone), BOM-custom_farm,
Cost Center-custom_farm, Work Order-custom_chemical_scans and
Work Order-custom_spray_application_logsheet to the Custom Field fixtures
so sites that lack them (the live site) get them on migrate. Fields only."
```

---

## Task 2: Shared warehouse classification module

**Files:**
- Create: `upande_scp/serverscripts/warehouse_classify.py`
- Test: `upande_scp/serverscripts/tests/test_warehouse_classify.py`

**Interfaces:**
- Produces:
  - `is_chemical_store(name: str | None) -> bool`
  - `is_fertilizer_store(name: str | None) -> bool`
  - `is_csu(name: str | None) -> bool`
  - module constants `CHEMICAL_STORE_RE`, `FERTILIZER_STORE_RE`, `CSU_RE` (compiled).

- [ ] **Step 1: Write the failing test**

```python
# upande_scp/serverscripts/tests/test_warehouse_classify.py
import unittest

from upande_scp.serverscripts.warehouse_classify import (
    is_chemical_store,
    is_fertilizer_store,
    is_csu,
)


class TestWarehouseClassify(unittest.TestCase):
    def test_chemical_store_variants(self):
        self.assertTrue(is_chemical_store("Chemical Main Store - MFK"))
        self.assertTrue(is_chemical_store("Chemical Store - ABC"))
        self.assertFalse(is_chemical_store("Fertilizer Main Store - MFK"))
        self.assertFalse(is_chemical_store("Main CSU A - MFK"))
        self.assertFalse(is_chemical_store(""))
        self.assertFalse(is_chemical_store(None))

    def test_fertilizer_store_variants(self):
        self.assertTrue(is_fertilizer_store("Fertilizer Main Store - MFK"))
        self.assertFalse(is_fertilizer_store("Chemical Main Store - MFK"))
        self.assertFalse(is_fertilizer_store("Main CSU B - MFK"))

    def test_csu(self):
        self.assertTrue(is_csu("Main CSU - MFK"))
        self.assertTrue(is_csu("Main CSU A - MFK"))
        self.assertFalse(is_csu("Chemical Main Store - MFK"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_warehouse_classify.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the module**

```python
# upande_scp/serverscripts/warehouse_classify.py
"""Shared warehouse-name classification for the spray-plan flow.

One source of truth for "is this a chemical store / fertilizer store / CSU?"
so the store-keeper dashboard (stock.py) and the Spray Plan Settings
warehouse resolver agree. Names vary by site: the chemical store is
"Chemical Store - <farm>" on some sites and "Chemical Main Store - <farm>"
on mona, so match "chemical" ... "store" anywhere rather than a literal
prefix. CSUs ("Main CSU - MFK") carry no "store" token.
"""
from __future__ import annotations

import re

CHEMICAL_STORE_RE = re.compile(r"\bchemical\b.*\bstore\b", re.IGNORECASE)
FERTILIZER_STORE_RE = re.compile(r"\bfertilizer\b.*\bstore\b", re.IGNORECASE)
CSU_RE = re.compile(r"\bcsu\b", re.IGNORECASE)


def is_chemical_store(name: str | None) -> bool:
    return bool(CHEMICAL_STORE_RE.search(name or ""))


def is_fertilizer_store(name: str | None) -> bool:
    return bool(FERTILIZER_STORE_RE.search(name or ""))


def is_csu(name: str | None) -> bool:
    return bool(CSU_RE.search(name or ""))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_warehouse_classify.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/warehouse_classify.py upande_scp/serverscripts/tests/test_warehouse_classify.py
git commit -m "feat(scp): shared warehouse-name classification helpers"
```

---

## Task 3: Source stock.py regexes from the shared module

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/stock.py` (lines ~31-66: `_CSU_RE`, `_STORE_RE`, `_classify`)

**Interfaces:**
- Consumes: `warehouse_classify.is_chemical_store`, `is_csu` (Task 2).
- Produces: unchanged public behavior of `stock.py` (`_classify` still returns `"chemical_store" | "csu" | None`).

- [ ] **Step 1: Replace the local regexes with shared predicates**

In `stock.py`, delete the local `_CSU_RE` and `_STORE_RE` definitions (the two `re.compile(...)` lines near the top, ~line 32 and ~line 39) and change `_classify` to use the shared predicates. Add the import near the other relative imports (`from .bulk import ...`):

```python
from upande_scp.serverscripts.warehouse_classify import is_chemical_store, is_csu
```

Replace the body of `_classify`:

```python
def _classify(warehouse_name: str) -> str | None:
    if is_chemical_store(warehouse_name):
        return "chemical_store"
    if is_csu(warehouse_name):
        return "csu"
    return None
```

Note: this changes the chemical-store check from `_STORE_RE.match` (anchored) to `.search`, which matches the module docstring's intent ("anywhere") and is a safe broadening; mona's `Chemical Main Store - MFK` is unaffected.

- [ ] **Step 2: Verify nothing else referenced the deleted names**

Run: `grep -n "_STORE_RE\|_CSU_RE" upande_scp/serverscripts/spray_plan_creator/stock.py`
Expected: no output (both removed).

- [ ] **Step 3: Compile-check**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m py_compile upande_scp/serverscripts/spray_plan_creator/stock.py`
Expected: no output (success).

- [ ] **Step 4: Run the shared-module tests again (regression)**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_warehouse_classify.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/stock.py
git commit -m "refactor(scp): stock.py classifies warehouses via shared helper"
```

---

## Task 4: Fix the Spray Plan Settings store matcher

**Files:**
- Modify: `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.py`
- Test: `upande_scp/serverscripts/tests/test_allowed_store_warehouses.py`

**Interfaces:**
- Consumes: `warehouse_classify.is_chemical_store`, `is_fertilizer_store` (Task 2).
- Produces: `get_allowed_chemical_store_warehouses()` and `get_allowed_fertilizer_unit_warehouses()` return farm-scoped names matched by the broad regex.

- [ ] **Step 1: Write the failing test**

```python
# upande_scp/serverscripts/tests/test_allowed_store_warehouses.py
import unittest
from unittest import mock

from upande_scp.upande_scp.doctype.spray_plan_settings import spray_plan_settings as sps


WAREHOUSES = [
    "Chemical Main Store - MFK",
    "Fertilizer Main Store - MFK",
    "General Main Store - MFK",
    "Main CSU - MFK",
    "Main CSU A - MFK",
]


class TestAllowedStoreWarehouses(unittest.TestCase):
    def test_chemical_store_matched(self):
        with mock.patch.object(sps, "get_allowed_farms", return_value=["Main"]), \
             mock.patch.object(sps.frappe, "get_all", return_value=list(WAREHOUSES)):
            self.assertEqual(
                sps.get_allowed_chemical_store_warehouses(),
                ["Chemical Main Store - MFK"],
            )

    def test_fertilizer_store_matched(self):
        with mock.patch.object(sps, "get_allowed_farms", return_value=["Main"]), \
             mock.patch.object(sps.frappe, "get_all", return_value=list(WAREHOUSES)):
            self.assertEqual(
                sps.get_allowed_fertilizer_unit_warehouses(),
                ["Fertilizer Main Store - MFK"],
            )

    def test_no_farms_returns_empty(self):
        with mock.patch.object(sps, "get_allowed_farms", return_value=[]):
            self.assertEqual(sps.get_allowed_chemical_store_warehouses(), [])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_allowed_store_warehouses.py -v`
Expected: FAIL — current prefix matcher returns `[]` for `Chemical Main Store - MFK`.

- [ ] **Step 3: Replace the matcher with predicate-based filtering**

In `spray_plan_settings.py`, add the import at the top with the other imports:

```python
from upande_scp.serverscripts.warehouse_classify import (
    is_chemical_store,
    is_fertilizer_store,
)
```

Add a predicate-based helper next to `_allowed_warehouses_by_prefix` (keep the prefix helper in place for any other callers):

```python
def _allowed_warehouses_matching(predicate):
    """Non-disabled Warehouse names whose ``custom_farm`` is in the allowed-
    farms list and whose name satisfies ``predicate``. Empty when no farms
    are configured."""
    farms = get_allowed_farms()
    if not farms:
        return []
    rows = frappe.get_all(
        "Warehouse",
        filters={"custom_farm": ("in", farms), "disabled": 0},
        pluck="name",
        order_by="name asc",
    )
    return [name for name in rows if predicate(name)]
```

Change the two store getters to use it:

```python
def get_allowed_chemical_store_warehouses():
    """Chemical-store warehouses scoped to allowed farms."""
    return _allowed_warehouses_matching(is_chemical_store)


def get_allowed_fertilizer_unit_warehouses():
    """Fertilizer-store warehouses scoped to allowed farms."""
    return _allowed_warehouses_matching(is_fertilizer_store)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_allowed_store_warehouses.py -v`
Expected: PASS.

- [ ] **Step 5: Manual check on mona**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local console <<'PY'
from upande_scp.upande_scp.doctype.spray_plan_settings import spray_plan_settings as sps
print("chem:", sps.get_allowed_chemical_store_warehouses())
print("fert:", sps.get_allowed_fertilizer_unit_warehouses())
PY
```
Expected: `chem` includes `Chemical Main Store - MFK`; `fert` includes `Fertilizer Main Store - MFK`. (If empty, confirm `Main` is in Spray Plan Settings allowed farms — see Task 4b.)

- [ ] **Step 6: Commit**

```bash
git add upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.py upande_scp/serverscripts/tests/test_allowed_store_warehouses.py
git commit -m "fix(scp): resolve chemical/fertilizer store by broad name match

Spray Plan Settings matched the literal 'Chemical Store ' prefix, so mona's
'Chemical Main Store - MFK' resolved to no source. Match via the shared
chemical/fertilizer-store predicates instead, scoped to allowed farms."
```

---

## Task 4b: Verify allowed-farms config on mona (no code unless missing)

**Files:** none unless a fix is needed.

- [ ] **Step 1: Check Spray Plan Settings allowed farms includes the greenhouse farm**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local console <<'PY'
from upande_scp.upande_scp.doctype.spray_plan_settings.spray_plan_settings import get_allowed_farms
print("allowed farms:", get_allowed_farms())
PY
```
Expected: list includes `Main`. If it does, this task is complete (no change).

- [ ] **Step 2: If `Main` is missing**, add it via the Spray Plan Settings UI / a data step (NOT a fixture record) and re-run Task 4 Step 5. Document the action in the task notes. No commit if no code changed.

---

## Task 5: Per-greenhouse latest scouting date (backend)

**Files:**
- Modify: `upande_scp/serverscripts/scouting_metrics_api.py` (`get_latest_scouting_date`, ~line 84)
- Test: `upande_scp/serverscripts/tests/test_latest_scouting_date.py`

**Interfaces:**
- Produces: `get_latest_scouting_date(greenhouse=None) -> str | None` — absolute max `date_of_capture`, optionally filtered by greenhouse, unaffected by any date window or observation filter.

- [ ] **Step 1: Write the failing test**

```python
# upande_scp/serverscripts/tests/test_latest_scouting_date.py
import unittest
from unittest import mock

from upande_scp.serverscripts import scouting_metrics_api as api


class TestLatestScoutingDate(unittest.TestCase):
    def test_greenhouse_filtered_query(self):
        captured = {}

        def fake_sql(query, values=None):
            captured["query"] = query
            captured["values"] = values
            return [["2026-03-01"]]

        with mock.patch.object(api.frappe.db, "sql", side_effect=fake_sql):
            out = api.get_latest_scouting_date(greenhouse="Main GH 01 - MFK")

        self.assertEqual(out, "2026-03-01")
        self.assertIn("greenhouse", captured["query"].lower())
        self.assertEqual(captured["values"], ("Main GH 01 - MFK",))

    def test_no_greenhouse_sitewide(self):
        with mock.patch.object(api.frappe.db, "sql", return_value=[["2026-05-09"]]):
            self.assertEqual(api.get_latest_scouting_date(), "2026-05-09")

    def test_none_when_empty(self):
        with mock.patch.object(api.frappe.db, "sql", return_value=[[None]]):
            self.assertIsNone(api.get_latest_scouting_date(greenhouse="X"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_latest_scouting_date.py -v`
Expected: FAIL — current `get_latest_scouting_date()` takes no `greenhouse` arg (TypeError).

- [ ] **Step 3: Extend the method**

Replace the existing `get_latest_scouting_date` body in `scouting_metrics_api.py` with:

```python
@frappe.whitelist()
def get_latest_scouting_date(greenhouse=None):
    """Most recent ``Scouting Entry.date_of_capture`` (YYYY-MM-DD) or None.

    With ``greenhouse`` set, returns that greenhouse's absolute latest scout
    date — independent of any dashboard date window or observation filter, so
    the Application Plan header shows the true last scouted day. Without it,
    returns the site-wide latest (used by the map pages to seed date ranges).
    """
    greenhouse = (greenhouse or "").strip()
    if greenhouse:
        row = frappe.db.sql(
            "SELECT MAX(date_of_capture) FROM `tabScouting Entry` WHERE greenhouse=%s",
            (greenhouse,),
        )
    else:
        row = frappe.db.sql(
            "SELECT MAX(date_of_capture) FROM `tabScouting Entry`"
        )
    return str(row[0][0]) if row and row[0] and row[0][0] else None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest upande_scp/serverscripts/tests/test_latest_scouting_date.py -v`
Expected: PASS.

- [ ] **Step 5: Manual check on mona**

Run:
```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local console <<'PY'
from upande_scp.serverscripts.scouting_metrics_api import get_latest_scouting_date
print("gh:", get_latest_scouting_date(greenhouse="Main GH 01 - MFK"))
print("site:", get_latest_scouting_date())
PY
```
Expected: a real date for the greenhouse (or None if it truly has no entries); site-wide date unchanged from before.

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/scouting_metrics_api.py upande_scp/serverscripts/tests/test_latest_scouting_date.py
git commit -m "feat(scp): get_latest_scouting_date accepts a greenhouse filter

Returns the absolute latest scout date for a greenhouse, independent of the
diagnose date window/filters, so the Application Plan header is accurate.
No-arg site-wide behaviour preserved for the map pages."
```

---

## Task 6: Pure area helper (frontend)

**Files:**
- Create: `frontend/src/lib/application-plan-area.ts`
- Test: `frontend/src/lib/__tests__/application-plan-area.test.ts`

**Interfaces:**
- Produces:
  - `type AreaScope = "Full Greenhouse" | "Specific Variety" | "Specific Bed(s)" | string`
  - `interface AreaBed { bed?: string | number | null; variety?: string | null }`
  - `computeAreaHa(scope: AreaScope, beds: AreaBed[], selectedVarieties: ReadonlySet<string>, selectedBeds: ReadonlySet<string>): number` — full GH = 1; partial = (matching beds ÷ total beds); 0 when no beds/unknown scope.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/__tests__/application-plan-area.test.ts
import { describe, it, expect } from "vitest";
import { computeAreaHa } from "@/lib/application-plan-area";

// 142 beds: 60 are FAR041, 82 are FAR149; beds numbered 1..142.
const beds = Array.from({ length: 142 }, (_, i) => ({
  bed: String(i + 1),
  variety: i < 60 ? "FAR041" : "FAR149",
}));

describe("computeAreaHa", () => {
  it("full greenhouse is exactly 1 ha", () => {
    expect(computeAreaHa("Full Greenhouse", beds, new Set(), new Set())).toBe(1);
  });

  it("variety scope is bed-count share of 1 ha", () => {
    const ha = computeAreaHa("Specific Variety", beds, new Set(["FAR041"]), new Set());
    expect(ha).toBeCloseTo(60 / 142, 6);
  });

  it("bed scope is bed-count share of 1 ha", () => {
    const sel = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    const ha = computeAreaHa("Specific Bed(s)", beds, new Set(), sel);
    expect(ha).toBeCloseTo(10 / 142, 6);
  });

  it("returns 0 when greenhouse has no beds", () => {
    expect(computeAreaHa("Full Greenhouse", [], new Set(), new Set())).toBe(0);
  });

  it("returns 0 for unknown scope", () => {
    expect(computeAreaHa("", beds, new Set(), new Set())).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/lib/__tests__/application-plan-area.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```ts
// frontend/src/lib/application-plan-area.ts
/**
 * mona area rule: a full greenhouse counts as exactly 1 hectare. A partial
 * scope (specific varieties or beds) is the share of the greenhouse's active
 * beds it covers, times 1 ha. Every mona bed has equal area, so bed-count
 * share equals area share. Water volume is derived elsewhere as ha * 1000.
 */
export type AreaScope =
  | "Full Greenhouse"
  | "Specific Variety"
  | "Specific Bed(s)"
  | string;

export interface AreaBed {
  bed?: string | number | null;
  variety?: string | null;
}

export function computeAreaHa(
  scope: AreaScope,
  beds: AreaBed[],
  selectedVarieties: ReadonlySet<string>,
  selectedBeds: ReadonlySet<string>,
): number {
  const total = beds.length;
  if (!total) return 0;

  if (scope === "Full Greenhouse") return 1;

  if (scope === "Specific Variety") {
    const n = beds.filter(
      (b) => b.variety != null && selectedVarieties.has(b.variety),
    ).length;
    return n / total;
  }

  if (scope === "Specific Bed(s)") {
    const n = beds.filter(
      (b) => b.bed != null && selectedBeds.has(String(b.bed)),
    ).length;
    return n / total;
  }

  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npx vitest run src/lib/__tests__/application-plan-area.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/application-plan-area.ts frontend/src/lib/__tests__/application-plan-area.test.ts
git commit -m "feat(application-plan): pure 1-ha-per-greenhouse area helper"
```

---

## Task 7: Wire the area helper into ApplicationPlan.tsx

**Files:**
- Modify: `frontend/src/pages/ApplicationPlan.tsx` (the `{ areaHa, waterVolumeL }` useMemo, ~lines 484-521)

**Interfaces:**
- Consumes: `computeAreaHa` (Task 6).
- Produces: `areaHa`/`waterVolumeL` now follow the 1-ha rule; downstream `setArea`/`setWaterVolume` effect unchanged.

- [ ] **Step 1: Import the helper**

Add to the imports at the top of `ApplicationPlan.tsx`:

```ts
import { computeAreaHa } from "@/lib/application-plan-area";
```

- [ ] **Step 2: Replace the area useMemo body**

Replace the entire `const { areaHa, waterVolumeL } = useMemo(() => { ... }, [...]);` block (the one summing `bed__area`) with:

```ts
  const { areaHa, waterVolumeL } = useMemo(() => {
    if (!greenhouse || !scope) return { areaHa: 0, waterVolumeL: 0 };
    const beds = bedsByGh[greenhouse] || [];
    const selectedBeds = parseBedRanges(bedNumbers);
    // mona rule: full greenhouse = 1 ha; partial scope scaled by bed-count
    // share. See @/lib/application-plan-area.
    const ha = computeAreaHa(scope, beds, selectedVarieties, selectedBeds);
    return {
      areaHa: ha,
      waterVolumeL: ha > 0 ? ha * WATER_VOLUME_RATE : 0,
    };
  }, [greenhouse, scope, bedsByGh, selectedVarieties, bedNumbers]);
```

(`parseBedRanges`, `WATER_VOLUME_RATE`, `selectedVarieties` are already in scope in this file.)

- [ ] **Step 3: Type-check / build the frontend**

Run (from `frontend/`): `npx tsc -b`
Expected: no errors. (If `parseBedRanges` returns `Set<string>`, the helper's `ReadonlySet<string>` accepts it.)

- [ ] **Step 4: Run the area unit tests (regression)**

Run (from `frontend/`): `npx vitest run src/lib/__tests__/application-plan-area.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual check**

Build and load `/scp_app#/application-plan` on mona (dev server or `npm run build`). Select `Main GH 01 - MFK`, scope `Full Greenhouse` → Area = `1.0000`, Water volume = `1000.00`. Switch to a single variety → area = its bed-count share.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/ApplicationPlan.tsx
git commit -m "feat(application-plan): full greenhouse = 1 ha, partials by bed share"
```

---

## Task 8: Farm-scoped spray teams

**Files:**
- Create: `frontend/src/lib/spray-team-filter.ts`
- Test: `frontend/src/lib/__tests__/spray-team-filter.test.ts`
- Modify: `frontend/src/pages/ApplicationPlan.tsx` (the `<SprayTeamEditor teams=...>` prop, ~line 1645)

**Interfaces:**
- Produces: `filterTeamsByFarm<T extends { custom_farm?: string | null }>(teams: T[], farm: string): T[]` — keep teams whose `custom_farm` equals `farm` (case-insensitive) or is empty; when `farm` is empty, keep all.
- Consumes (in TSX): `greenhouseFarm` (already defined ~line 779), `bootstrap.spray_teams`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/__tests__/spray-team-filter.test.ts
import { describe, it, expect } from "vitest";
import { filterTeamsByFarm } from "@/lib/spray-team-filter";

const teams = [
  { name: "Team A", custom_farm: "Main" },
  { name: "Team B", custom_farm: "" },
  { name: "Team C", custom_farm: null as string | null },
  { name: "Team D", custom_farm: "Main" },
  { name: "Team X", custom_farm: "Other" },
];

describe("filterTeamsByFarm", () => {
  it("keeps farm-matching and unfarmed teams, hides other-farm", () => {
    const out = filterTeamsByFarm(teams, "Main").map((t) => t.name);
    expect(out).toEqual(["Team A", "Team B", "Team C", "Team D"]);
  });

  it("is case-insensitive on the farm name", () => {
    const out = filterTeamsByFarm(teams, "main").map((t) => t.name);
    expect(out).toContain("Team A");
    expect(out).not.toContain("Team X");
  });

  it("shows all teams when no farm is selected", () => {
    expect(filterTeamsByFarm(teams, "").length).toBe(teams.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/lib/__tests__/spray-team-filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```ts
// frontend/src/lib/spray-team-filter.ts
/**
 * Scope spray teams to a greenhouse's farm. A team shows when its custom_farm
 * matches the farm (case-insensitive) OR is empty/null (treated as global).
 * When no farm is known yet, all teams show. Teams tagged to a different farm
 * are hidden.
 */
export function filterTeamsByFarm<T extends { custom_farm?: string | null }>(
  teams: T[],
  farm: string,
): T[] {
  const f = (farm || "").trim().toLowerCase();
  if (!f) return teams;
  return teams.filter((t) => {
    const tf = (t.custom_farm || "").trim().toLowerCase();
    return !tf || tf === f;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npx vitest run src/lib/__tests__/spray-team-filter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into ApplicationPlan.tsx**

Add the import:

```ts
import { filterTeamsByFarm } from "@/lib/spray-team-filter";
```

Add a memo near the other derived lists (e.g. just after `kitList`):

```ts
  const scopedTeams = useMemo(
    () => filterTeamsByFarm(bootstrap?.spray_teams || [], greenhouseFarm),
    [bootstrap, greenhouseFarm],
  );
```

Change the `SprayTeamEditor` prop from `teams={bootstrap?.spray_teams || []}` to:

```tsx
                <SprayTeamEditor
                  teams={scopedTeams}
                  team={sprayTeam}
                  onTeamChange={setSprayTeam}
                  members={teamMembers}
                  onMembersChange={setTeamMembers}
                />
```

- [ ] **Step 6: Type-check**

Run (from `frontend/`): `npx tsc -b`
Expected: no errors (`CreatorSprayTeam` has `custom_farm: string`, satisfying the constraint).

- [ ] **Step 7: Manual check**

On mona, pick a greenhouse on the `Main` farm → team dropdown shows Team A, B, C, D, scouting team; a team tagged to a different farm would not appear.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/spray-team-filter.ts frontend/src/lib/__tests__/spray-team-filter.test.ts frontend/src/pages/ApplicationPlan.tsx
git commit -m "feat(application-plan): farm-scope the spray-team dropdown"
```

---

## Task 9: Application Plan reads the true last-scout date

**Files:**
- Modify: `frontend/src/lib/scouting-api.ts` (`fetchLatestScoutingDate`, ~line 398)
- Modify: `frontend/src/pages/ApplicationPlan.tsx` (the `latestScoutingDate` memo ~line 644 + a fetch effect)

**Interfaces:**
- Consumes: backend `get_latest_scouting_date(greenhouse=None)` (Task 5).
- Produces: `fetchLatestScoutingDate(greenhouse?: string): Promise<string | null>` — optional greenhouse filter; header uses it.

- [ ] **Step 1: Extend the API function (keep no-arg behavior for Heatmaps)**

Replace `fetchLatestScoutingDate` in `scouting-api.ts` with:

```ts
export async function fetchLatestScoutingDate(
  greenhouse?: string,
): Promise<string | null> {
  try {
    const r = await call<string | null>(
      "upande_scp.serverscripts.scouting_metrics_api.get_latest_scouting_date",
      greenhouse ? { greenhouse } : {},
    );
    return r || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify the existing Heatmaps caller still type-checks**

Run (from `frontend/`): `npx tsc -b`
Expected: no errors — `Heatmaps.tsx` calls `fetchLatestScoutingDate()` with no arg, still valid.

- [ ] **Step 3: Add greenhouse-scoped last-scout state + fetch in ApplicationPlan.tsx**

Add the import (extend the existing `scouting-api` import line):

```ts
import { fetchLatestScoutingDate } from "@/lib/scouting-api";
```

Add state near the other `useState` declarations:

```ts
  const [lastScoutDate, setLastScoutDate] = useState<string | null>(null);
```

Add an effect that loads it whenever the greenhouse changes (place near the other effects):

```ts
  // True absolute last scouted day for the picked greenhouse — independent
  // of the diagnose date window / pest filters (which can hide it).
  useEffect(() => {
    let cancelled = false;
    if (!greenhouse) {
      setLastScoutDate(null);
      return;
    }
    fetchLatestScoutingDate(greenhouse).then((d) => {
      if (!cancelled) setLastScoutDate(d);
    });
    return () => {
      cancelled = true;
    };
  }, [greenhouse]);
```

- [ ] **Step 4: Use it for the header instead of `diagnose.latestDate`**

Replace the `latestScoutingDate` memo:

```ts
  const latestScoutingDate = lastScoutDate;
```

(Leave the header JSX as-is; it already renders `latestScoutingDate`. Optionally update the empty-state copy from "No entries in 60 days" to "No scouting entries".)

- [ ] **Step 5: Type-check + build**

Run (from `frontend/`): `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Manual check**

On mona, select `Main GH 01 - MFK` → the "Latest scouting" header shows the greenhouse's true latest date even if it is older than 60 days, and it does NOT change when you apply a pest/stage filter chip.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/scouting-api.ts frontend/src/pages/ApplicationPlan.tsx
git commit -m "fix(application-plan): show the true last scouted day

Read get_latest_scouting_date(greenhouse) for the header instead of the
diagnose payload's latestDate, which was bounded by the 60-day window and
contaminated by the active pest/section/stage filter."
```

---

## Task 10: Kit → destination CSU (verify + surface)

**Files:**
- Modify: `frontend/src/pages/ApplicationPlan.tsx` (kit `<Select>` area, ~lines 1653-1668)

**Interfaces:**
- Consumes: `kitList` (already `{kit, warehouse}`), `kit` state. Server already maps kit→`wip_warehouse` (`_apply_kit_warehouse`, commit `345452e`).
- Produces: a visible "Destination CSU" readout for the selected kit; confirms `custom_kit` is in the submit payload.

- [ ] **Step 1: Confirm the payload already sends the kit**

Run: `grep -n "custom_kit:" frontend/src/pages/ApplicationPlan.tsx`
Expected: shows `custom_kit: kit,` in `draftPayload`. No change needed — the server derives the CSU from this.

- [ ] **Step 2: Add a selected-kit CSU memo**

Add near `kitList`:

```ts
  const kitWarehouse = useMemo(
    () => kitList.find((k) => k.kit === kit)?.warehouse || "",
    [kitList, kit],
  );
```

- [ ] **Step 3: Show the destination CSU under the kit picker**

Immediately after the kit `<Select>...</Select>` closing tag (inside the same kit `<div className="flex flex-col gap-1 col-span-2">`), add:

```tsx
                {kit ? (
                  <span className="text-xs text-muted-foreground">
                    {kitWarehouse
                      ? `Chemicals go to ${kitWarehouse}`
                      : "This kit has no destination CSU mapped — submission will be blocked."}
                  </span>
                ) : null}
```

- [ ] **Step 4: Type-check + build**

Run (from `frontend/`): `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Manual end-to-end check on mona**

Build, open the Application Plan, select a greenhouse + scope + BOM, pick kit `Central spray unit A` → readout shows `Chemicals go to Main CSU A - MFK`. Submit a draft → confirm the created Work Order's `wip_warehouse` is the kit's CSU:

```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local mariadb -e "SELECT name, custom_kit, wip_warehouse FROM \`tabWork Order\` ORDER BY creation DESC LIMIT 3;"
```
Expected: latest draft's `wip_warehouse` = the kit's CSU (e.g. `Main CSU A - MFK`). An unmapped kit should surface the server's throw.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/ApplicationPlan.tsx
git commit -m "feat(application-plan): surface the kit's destination CSU"
```

---

## Task 11: Full end-to-end verification + asset rebuild

**Files:** none (verification only).

- [ ] **Step 1: Run all new backend tests**

Run (from `apps/upande_scp`):
```bash
/home/ubuntu/stive/code/frappe16/env/bin/python -m pytest \
  upande_scp/serverscripts/tests/test_warehouse_classify.py \
  upande_scp/serverscripts/tests/test_allowed_store_warehouses.py \
  upande_scp/serverscripts/tests/test_latest_scouting_date.py \
  upande_scp/serverscripts/tests/test_fixtures_custom_fields.py -v
```
Expected: all PASS.

- [ ] **Step 2: Run all new frontend tests**

Run (from `frontend/`):
```bash
npx vitest run src/lib/__tests__/application-plan-area.test.ts src/lib/__tests__/spray-team-filter.test.ts
```
Expected: all PASS.

- [ ] **Step 3: Build the frontend bundle**

Run (from `frontend/`): `npm run build`
Expected: built; `Approvals`/`ApplicationPlan` chunks emitted. (On mona dev the assets symlink serves it immediately.)

- [ ] **Step 4: Migrate mona so the new fixtures apply locally**

Run: `cd /home/ubuntu/stive/code/frappe16 && bench --site mona.local migrate`
Expected: completes; the 5 custom fields exist (they already did on mona — this confirms no breakage).

- [ ] **Step 5: Manual full pass on `/scp_app#/application-plan`**

Select `Main GH 01 - MFK` → latest scout date correct; Full Greenhouse = 1.0000 ha / 1000 L; pick a `Main`-farm team; pick kit A → "Chemicals go to Main CSU A - MFK"; chemical source = `Chemical Main Store - MFK`; submit draft → Work Order created with `wip_warehouse` = Main CSU A - MFK. Confirm no console errors.

- [ ] **Step 6: Final commit (if any docs/notes changed)**

```bash
git add -A
git commit -m "test(application-plan): end-to-end verification notes" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- §1 Last scouted day → Tasks 5, 9. ✓
- §2 Area rule (1 ha) → Tasks 6, 7. ✓
- §3 Chemical/fertilizer store matcher → Tasks 2, 3, 4 (+4b config check). ✓
- §4 Kit → CSU → Task 10 (verify + surface; server already done in `345452e`). ✓
- §5 Spray team farm scoping → Task 8. ✓
- §6 Fixtures (5 fields) → Task 1. ✓

**Type consistency:** `computeAreaHa(scope, beds, selectedVarieties, selectedBeds)` defined in Task 6 and called identically in Task 7. `filterTeamsByFarm(teams, farm)` defined in Task 8 and used there. `fetchLatestScoutingDate(greenhouse?)` defined in Task 9 matches backend `get_latest_scouting_date(greenhouse=None)` from Task 5. `is_chemical_store`/`is_fertilizer_store`/`is_csu` defined in Task 2 and consumed in Tasks 3, 4.

**Placeholder scan:** no TBD/TODO; every code step shows full code; every test step shows the assertions and the run command with expected result.
