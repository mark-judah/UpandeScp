# Dashboard Server-Side Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut /scp_app Dashboard load time at 500k-row scale from ~10 min to < 5 s by moving five tabs off raw-rows-to-browser onto Python aggregation endpoints with Redis caching.

**Architecture:** Five whitelisted endpoints under `upande_scp.serverscripts.dashboard_aggregates` (overview, pests, diseases, traps, fcm, plus greenhouse_detail) that each issue one or two SQL GROUP BYs and return compact JSON. Output cached in Redis keyed by SHA-1 of filters, version-bumped by the existing `K_SCOUTING_PAYLOAD_VERSION` stamp so the doc-event invalidator we already use also busts these keys. Frontend's `use-dashboard-aggregate` hook drives each tab; the existing IDB/sync layer stays in place for Observations / TrapsMap.

**Tech Stack:** Python 3.10 (Frappe 15), MariaDB, Redis, React 19, TypeScript, Vite 6, Tailwind, recharts.

**Spec:** `docs/superpowers/specs/2026-05-18-dashboard-server-aggregation-design.md`

---

## File Structure

**Server-side, all new:**

```
upande_scp/serverscripts/dashboard_aggregates/
├── __init__.py          # whitelisted entry points + force param dispatch
├── _common.py           # filter resolution, cache wrapper, severity, SQL helpers
├── _overview.py         # overview()
├── _pests_diseases.py   # pests() + diseases() (shared impl, kind="pest"/"disease")
├── _traps.py            # traps()
├── _fcm.py              # fcm()
└── _gh_detail.py        # greenhouse_detail()
```

**Server-side tests, all new:**

```
upande_scp/serverscripts/tests/
├── test_dashboard_aggregates_common.py        # filter resolution, cache key, severity
├── test_dashboard_aggregates_overview.py      # overview()
├── test_dashboard_aggregates_pests_diseases.py
├── test_dashboard_aggregates_traps.py
├── test_dashboard_aggregates_fcm.py
└── test_dashboard_aggregates_gh_detail.py
```

**Frontend, new file:**

```
frontend/src/hooks/use-dashboard-aggregate.ts
```

**Frontend, modified files:**

```
frontend/src/pages/Dashboard.tsx          # lift active-tab state, drop useScouting
frontend/src/pages/dashboard/OverviewTab.tsx
frontend/src/pages/dashboard/PestsTab.tsx
frontend/src/pages/dashboard/DiseasesTab.tsx
frontend/src/pages/dashboard/TrapsTab.tsx
frontend/src/pages/dashboard/FcmTab.tsx
frontend/src/pages/dashboard/aggregate.ts # trim functions no longer used
```

**Frontend, untouched in this plan:**

`scouting-api.ts`, `scouting-sync.ts`, `idb.ts`, `use-scouting.ts`, `use-realtime.ts`, the Observations / TrapsMap / Trends / Heatmaps / Rose / Avocado / Reports / TankMixes / Historical / Approvals / ApplicationPlan pages.

---

## Test Strategy

Three layers:

1. **Pure-function unit tests** (no Frappe site needed) — filter resolution, cache key, severity classifier, normalization. Live in `test_dashboard_aggregates_common.py`. Run with `pytest`.

2. **Integration tests with FrappeTestCase** — each endpoint runs against a small fixture inserted in `setUp`, asserts compact JSON output. Run with `bench --site kaitet run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_dashboard_aggregates_<endpoint>`.

3. **Frontend parity** — visual diff between the current tab and the refactored tab on the staging deployment, confirming numbers and chart shapes match.

**Common test fixture** (defined once, reused across endpoint tests): 12 Scouting Entries spanning 2 weeks × 3 greenhouses × 2 crops (Rose + Coffee), each carrying a mix of pests / diseases / traps / FCM child rows. Inserted in `setUp` via `frappe.get_doc({...}).insert()`. Defined in `test_dashboard_aggregates_fixture.py` (helper module imported by every endpoint test).

**Bench command for running these tests:**
```bash
bench --site kaitet run-tests --app upande_scp --module upande_scp.serverscripts.tests.<test_module>
```

---

## Phase 1 — Server Foundation

### Task 1: Common helpers — filter resolution

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/__init__.py` (empty placeholder for now)
- Create: `upande_scp/serverscripts/dashboard_aggregates/_common.py`
- Create: `upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py`

- [ ] **Step 1: Create the package shell**

Create `upande_scp/serverscripts/dashboard_aggregates/__init__.py` with one line:
```python
"""Server-side aggregation endpoints for the /scp_app Dashboard."""
```

- [ ] **Step 2: Write failing test for filter resolution**

Create `upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py`:
```python
import unittest
from unittest.mock import patch


class TestResolveGreenhouseScope(unittest.TestCase):
    def test_explicit_greenhouse_wins(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        farms_map = {"Karen Farm": ["GH 12", "GH 13"]}
        self.assertEqual(
            resolve_greenhouse_scope(greenhouse="GH 12", farm="Karen Farm",
                                     farms_map=farms_map),
            ["GH 12"],
        )

    def test_farm_expands_to_greenhouses(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        farms_map = {"Karen Farm": ["GH 12", "GH 13"]}
        self.assertEqual(
            resolve_greenhouse_scope(greenhouse="", farm="Karen Farm",
                                     farms_map=farms_map),
            ["GH 12", "GH 13"],
        )

    def test_both_empty_returns_none(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        farms_map = {"Karen Farm": ["GH 12"]}
        self.assertIsNone(
            resolve_greenhouse_scope(greenhouse="", farm="", farms_map=farms_map),
        )

    def test_unknown_farm_returns_empty_list(self):
        # Distinguishes "no filter" (None) from "filter excludes everything" ([]).
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            resolve_greenhouse_scope,
        )
        self.assertEqual(
            resolve_greenhouse_scope(greenhouse="", farm="Missing",
                                     farms_map={}),
            [],
        )
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
pytest /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py::TestResolveGreenhouseScope -v
```
Expected: ImportError on `resolve_greenhouse_scope`.

- [ ] **Step 4: Implement resolve_greenhouse_scope**

Create `upande_scp/serverscripts/dashboard_aggregates/_common.py`:
```python
"""Shared helpers for the dashboard aggregation endpoints.

These functions are pure where possible so they can be unit-tested without a
Frappe site; functions that hit the database take explicit dependencies.
"""

from typing import Optional


def resolve_greenhouse_scope(
    greenhouse: str,
    farm: str,
    farms_map: dict,
) -> Optional[list]:
    """Match the Dashboard.tsx greenhouseScope rule:

    - explicit greenhouse wins → [greenhouse]
    - farm without greenhouse → farms_map[farm] (empty list if farm unknown)
    - both empty → None (i.e. no greenhouse filter)
    """
    if greenhouse:
        return [greenhouse]
    if farm:
        return list(farms_map.get(farm, []))
    return None
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
pytest /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py -v
```
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/ \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py
git commit -m "feat(dashboard-agg): filter resolution helper"
```

---

### Task 2: Common helpers — cache key + severity

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py`
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py`

- [ ] **Step 1: Add failing tests for cache key + severity**

Append to `test_dashboard_aggregates_common.py`:
```python
class TestFilterHash(unittest.TestCase):
    def test_same_inputs_same_hash(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import filter_hash
        h1 = filter_hash({"from_date": "2026-04-18", "to_date": "2026-05-18",
                          "crop": "Rose"})
        h2 = filter_hash({"crop": "Rose", "to_date": "2026-05-18",
                          "from_date": "2026-04-18"})  # different key order
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 20)

    def test_different_inputs_different_hash(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import filter_hash
        h1 = filter_hash({"crop": "Rose"})
        h2 = filter_hash({"crop": "Coffee"})
        self.assertNotEqual(h1, h2)


class TestSeverity(unittest.TestCase):
    def test_pest_severity_thresholds(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import pest_severity
        self.assertEqual(pest_severity(0), None)
        self.assertEqual(pest_severity(5), None)
        self.assertEqual(pest_severity(6), "moderate")
        self.assertEqual(pest_severity(15), "moderate")
        self.assertEqual(pest_severity(16), "high")

    def test_disease_severity_keywords(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import disease_severity
        self.assertEqual(disease_severity("High"), "high")
        self.assertEqual(disease_severity("severe outbreak"), "high")
        self.assertEqual(disease_severity("Active"), "high")
        self.assertEqual(disease_severity("Moderate"), "moderate")
        self.assertEqual(disease_severity("medium"), "moderate")
        self.assertEqual(disease_severity("low"), None)
        self.assertEqual(disease_severity(""), None)
        self.assertEqual(disease_severity(None), None)
```

- [ ] **Step 2: Run to confirm failure**

```bash
pytest /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py::TestFilterHash -v
```
Expected: ImportError.

- [ ] **Step 3: Implement filter_hash and severity classifiers**

Append to `_common.py`:
```python
import hashlib
import json
import re


def filter_hash(filters: dict) -> str:
    """20-char hex of SHA-1(JSON with sorted keys). Stable across argument order."""
    payload = json.dumps(filters, sort_keys=True, default=str)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:20]


def pest_severity(count) -> Optional[str]:
    """Mirror aggregate.ts sevByMagnitude: count > 15 → high, > 5 → moderate."""
    try:
        n = int(count or 0)
    except (TypeError, ValueError):
        return None
    if n > 15:
        return "high"
    if n > 5:
        return "moderate"
    return None


_HIGH_RE = re.compile(r"high|severe|active", re.IGNORECASE)
_MOD_RE = re.compile(r"moderate|medium", re.IGNORECASE)


def disease_severity(s) -> Optional[str]:
    """Mirror aggregate.ts sevByDiseaseKeyword."""
    text = (s or "").strip()
    if not text:
        return None
    if _HIGH_RE.search(text):
        return "high"
    if _MOD_RE.search(text):
        return "moderate"
    return None
```

- [ ] **Step 4: Confirm passing**

```bash
pytest /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py -v
```
Expected: 9 passed (4 from Task 1 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_common.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py
git commit -m "feat(dashboard-agg): filter hash and severity classifiers"
```

---

### Task 3: Common helpers — cache wrapper

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py`
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py`

- [ ] **Step 1: Add failing test for cached_aggregate**

Append to `test_dashboard_aggregates_common.py`:
```python
class TestCachedAggregate(unittest.TestCase):
    def test_cache_hit_skips_compute(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            cached_aggregate,
        )
        calls = {"n": 0}

        def compute():
            calls["n"] += 1
            return {"x": 1}

        # First call: miss → compute. Second call: hit → no compute.
        # We patch the Redis adapter so we don't need a live cache.
        with patch(
            "upande_scp.serverscripts.dashboard_aggregates._common._cache_get_set"
        ) as gs:
            gs.side_effect = [
                ("miss", {"x": 1}),    # first call returns the just-computed value
                ("hit",  {"x": 1}),
            ]
            v1 = cached_aggregate("overview", {"a": 1}, compute, force=False)
            v2 = cached_aggregate("overview", {"a": 1}, compute, force=False)
        self.assertEqual(v1, {"x": 1})
        self.assertEqual(v2, {"x": 1})

    def test_force_bypasses_cache(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            cached_aggregate,
        )

        def compute():
            return {"x": 2}

        with patch(
            "upande_scp.serverscripts.dashboard_aggregates._common._cache_set"
        ) as setter:
            v = cached_aggregate("overview", {"a": 1}, compute, force=True)
            self.assertEqual(v, {"x": 2})
            setter.assert_called_once()  # forced path still writes back
```

- [ ] **Step 2: Run to confirm failure**

```bash
pytest /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py::TestCachedAggregate -v
```
Expected: ImportError.

- [ ] **Step 3: Implement the cache wrapper**

Append to `_common.py`:
```python
import frappe

from upande_scp.serverscripts.cache_utils import scouting_payload_version


K_DASH_AGG_PREFIX = "scp:dash_agg"
DASH_AGG_TTL = 120  # seconds


def _build_key(endpoint: str, filters: dict) -> str:
    v = scouting_payload_version()
    return f"{K_DASH_AGG_PREFIX}:v{v}:{endpoint}:{filter_hash(filters)}"


def _cache_get_set(key: str):
    """Read-through wrapper. Returns ('hit', value) or ('miss', None)."""
    cache = frappe.cache()
    value = cache.get_value(key)
    if value is not None:
        return ("hit", value)
    return ("miss", None)


def _cache_set(key: str, value):
    frappe.cache().set_value(key, value, expires_in_sec=DASH_AGG_TTL)


def cached_aggregate(endpoint: str, filters: dict, compute, force: bool = False):
    """Read-through cache for an aggregate endpoint.

    `compute` is a zero-arg callable producing the payload. `force=True` skips
    the read and overwrites the cached value with a freshly computed one.
    """
    key = _build_key(endpoint, filters)
    if not force:
        status, cached = _cache_get_set(key)
        if status == "hit":
            return cached
    payload = compute()
    _cache_set(key, payload)
    return payload
```

- [ ] **Step 4: Confirm passing**

```bash
pytest /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py -v
```
Expected: 11 passed (9 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_common.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py
git commit -m "feat(dashboard-agg): version-stamped Redis cache wrapper"
```

---

### Task 4: Common helpers — SQL primitives

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py`

- [ ] **Step 1: Add the SQL primitives**

The endpoints all need the same shape of filter clause and the same join across `tabScouting Entry` and its three observation tables. Centralise it.

Append to `_common.py`:
```python
from datetime import date


def parent_filter_conditions(
    from_date: str,
    to_date: str,
    crop: str,
    greenhouse_scope: Optional[list],
) -> tuple:
    """Build a ``(sql_where, params_dict)`` pair restricting tabScouting Entry.

    Returns ('1=0', {}) if greenhouse_scope is an empty list (i.e. farm with
    no greenhouses — filter excludes everything). None means no greenhouse
    filter at all.
    """
    if greenhouse_scope == []:
        return "1=0", {}

    parts = ["se.date_of_capture BETWEEN %(from_date)s AND %(to_date)s"]
    params = {"from_date": from_date, "to_date": to_date}

    if crop:
        parts.append("se.crop_scouted = %(crop)s")
        params["crop"] = crop

    if greenhouse_scope is not None:
        # MySQL/MariaDB: place-holder list expansion via frappe.db.escape
        gh_list = ", ".join(frappe.db.escape(g) for g in greenhouse_scope)
        parts.append(f"(se.greenhouse IN ({gh_list}) OR se.block IN ({gh_list}))")

    return " AND ".join(parts), params


def coerce_date(value, default=None) -> str:
    """Accept date/datetime/'YYYY-MM-DD' and return canonical 'YYYY-MM-DD'."""
    if not value:
        return default or ""
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    return str(value)[:10]
```

- [ ] **Step 2: Add a unit test for parent_filter_conditions**

Append to `test_dashboard_aggregates_common.py`:
```python
class TestParentFilterConditions(unittest.TestCase):
    def test_includes_date_range_always(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            parent_filter_conditions,
        )
        where, params = parent_filter_conditions("2026-04-18", "2026-05-18", "", None)
        self.assertIn("BETWEEN %(from_date)s AND %(to_date)s", where)
        self.assertEqual(params["from_date"], "2026-04-18")
        self.assertEqual(params["to_date"], "2026-05-18")

    def test_empty_scope_excludes_all(self):
        from upande_scp.serverscripts.dashboard_aggregates._common import (
            parent_filter_conditions,
        )
        where, params = parent_filter_conditions("2026-04-18", "2026-05-18", "",
                                                  greenhouse_scope=[])
        self.assertEqual(where, "1=0")
        self.assertEqual(params, {})
```

- [ ] **Step 3: Run all common tests**

```bash
pytest /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py -v
```
Expected: 13 passed.

- [ ] **Step 4: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_common.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_common.py
git commit -m "feat(dashboard-agg): SQL filter clause helper"
```

---

### Task 5: Test fixture for integration tests

**Files:**
- Create: `upande_scp/serverscripts/tests/test_dashboard_aggregates_fixture.py`

- [ ] **Step 1: Build the fixture module**

This is imported (not run directly) by every endpoint integration test.

```python
"""Shared Scouting Entry fixture for dashboard aggregate integration tests.

Inserts a deterministic set of entries — 12 total — covering:
  - 3 greenhouses across 2 farms
  - 2 crops (Rose, Coffee)
  - 14 dates spanning two ISO weeks
  - mix of pests / diseases / traps / FCM-flagged moths
  - high / moderate / low severity entries

Tests call ``insert_fixture()`` in ``setUp`` and rely on Frappe's
test-DB rollback to clean up automatically.
"""

import frappe


# Use names that won't collide with production data. Created on demand if
# missing so a fresh test DB still has the master rows.
_TEST_FARM_A = "_TEST Karen Farm"
_TEST_FARM_B = "_TEST Naivasha Farm"
_TEST_GH_1 = "_TEST GH 1"
_TEST_GH_2 = "_TEST GH 2"
_TEST_GH_3 = "_TEST GH 3"
_TEST_BED = "_TEST Bed 1"
_TEST_ZONE = "_TEST Zone 1"
_TEST_PEST_THRIPS = "_TEST Thrips"
_TEST_PEST_FCM = "_TEST False Codling Moth"
_TEST_DISEASE_PM = "_TEST Powdery Mildew"
_TEST_TRAP = "_TEST Yellow Sticky"
_TEST_SCOUT = "_TEST Scout 001"


def _ensure_warehouse(name: str, is_group: int = 0, parent: str = ""):
    if not frappe.db.exists("Warehouse", name):
        doc = frappe.get_doc({
            "doctype": "Warehouse",
            "warehouse_name": name.replace("_TEST ", ""),
            "name": name,
            "is_group": is_group,
            "parent_warehouse": parent,
        })
        doc.insert(ignore_permissions=True, ignore_if_duplicate=True)


def _ensure_pest(name: str):
    if not frappe.db.exists("Pest", name):
        frappe.get_doc({"doctype": "Pest", "pest_name": name}).insert(
            ignore_permissions=True, ignore_if_duplicate=True,
        )


def _ensure_disease(name: str):
    if not frappe.db.exists("Plant Disease", name):
        frappe.get_doc({
            "doctype": "Plant Disease",
            "disease_name": name,
        }).insert(ignore_permissions=True, ignore_if_duplicate=True)


def _ensure_trap(name: str):
    if not frappe.db.exists("Trap", name):
        frappe.get_doc({"doctype": "Trap", "trap_name": name}).insert(
            ignore_permissions=True, ignore_if_duplicate=True,
        )


def _ensure_masters():
    _ensure_warehouse(_TEST_FARM_A, is_group=1)
    _ensure_warehouse(_TEST_FARM_B, is_group=1)
    _ensure_warehouse(_TEST_GH_1, parent=_TEST_FARM_A)
    _ensure_warehouse(_TEST_GH_2, parent=_TEST_FARM_A)
    _ensure_warehouse(_TEST_GH_3, parent=_TEST_FARM_B)
    _ensure_pest(_TEST_PEST_THRIPS)
    _ensure_pest(_TEST_PEST_FCM)
    _ensure_disease(_TEST_DISEASE_PM)
    _ensure_trap(_TEST_TRAP)


_FIXTURE = [
    # (date,        greenhouse,  crop,    pest_obs?,                                disease_obs?,                                trap_obs?)
    ("2026-05-04",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult",  3)], [],                                          []),
    ("2026-05-05",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult",  7)], [],                                          []),
    ("2026-05-06",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult", 22)], [],                                          []),
    ("2026-05-07",  _TEST_GH_2,  "Rose",   [],                                          [(_TEST_DISEASE_PM, "Leaf", "Active")],      []),
    ("2026-05-08",  _TEST_GH_2,  "Rose",   [],                                          [(_TEST_DISEASE_PM, "Leaf", "Moderate")],    []),
    ("2026-05-09",  _TEST_GH_3,  "Coffee", [(_TEST_PEST_FCM,    "Fruit","Adult",  2)], [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T1",  5)]),
    ("2026-05-10",  _TEST_GH_3,  "Coffee", [],                                          [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T1", 12)]),
    ("2026-05-11",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Stem", "Larvae", 4)], [],                                          []),
    ("2026-05-12",  _TEST_GH_2,  "Rose",   [],                                          [(_TEST_DISEASE_PM, "Leaf", "Low")],         []),
    ("2026-05-13",  _TEST_GH_3,  "Coffee", [(_TEST_PEST_FCM,    "Fruit","Adult", 18)], [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T2", 30)]),
    ("2026-05-14",  _TEST_GH_1,  "Rose",   [(_TEST_PEST_THRIPS, "Leaf", "Adult", 11)], [(_TEST_DISEASE_PM, "Leaf", "Severe")],      []),
    ("2026-05-15",  _TEST_GH_3,  "Coffee", [],                                          [],                                          [(_TEST_TRAP, _TEST_PEST_FCM, "T1",  1)]),
]


def insert_fixture():
    _ensure_masters()
    names = []
    for i, (date_str, gh, crop, pests, diseases, traps) in enumerate(_FIXTURE):
        doc = frappe.get_doc({
            "doctype": "Scouting Entry",
            "date_of_capture": date_str,
            "time_of_capture": f"08:{i:02d}:00",
            "greenhouse": gh,
            "bed": _TEST_BED,
            "zone": _TEST_ZONE,
            "crop_scouted": crop,
            "scouts_name": _TEST_SCOUT,
            "pests_scouting_entry": [
                {"pest": p[0], "plant_section": p[1], "stage": p[2], "count": p[3]}
                for p in pests
            ],
            "diseases_scouting_entry": [
                {"disease": d[0], "plant_section": d[1], "stage": d[2]}
                for d in diseases
            ],
            "trap_scouting_entry": [
                {"trap": t[0], "pest": t[1], "location": t[2], "count": t[3]}
                for t in traps
            ],
        })
        doc.insert(ignore_permissions=True)
        names.append(doc.name)
    return names
```

- [ ] **Step 2: Commit (no test runs yet — this is a helper module)**

```bash
git add upande_scp/serverscripts/tests/test_dashboard_aggregates_fixture.py
git commit -m "test(dashboard-agg): shared Scouting Entry fixture"
```

---

### Task 6: Overview endpoint — shell + KPIs

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/_overview.py`
- Create: `upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py`

The Overview tab consumes nine aggregations: kpis, daily, rangeTotals, ghHealth, topScouts, scoutsPerDay, scoutPerformance, recentActivity, activeAlerts. Implement them one at a time, each driven by a test.

- [ ] **Step 1: Write the KPIs test**

```python
from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture, _TEST_FARM_A,
)


class TestOverviewKpis(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._overview import overview
        args = {
            "from_date": "2026-05-04",
            "to_date":   "2026-05-15",
            "crop": "",
            "farm": "",
            "greenhouse": "",
        }
        args.update(overrides)
        return overview(args)

    def test_total_scouts_counts_distinct_scouts_name(self):
        payload = self._call()
        # Fixture uses one scout for every row.
        self.assertEqual(payload["kpis"]["totalScouts"], 1)

    def test_zones_scouted_counts_entries_with_obs(self):
        payload = self._call()
        # 12 fixture rows but two have no obs at all (rows for 2026-05-10
        # and 2026-05-15 are trap-only — they still count).
        # All 12 have at least one of pests/diseases/traps.
        self.assertEqual(payload["kpis"]["zonesScouted"], 12)

    def test_greenhouse_count_unique_in_range(self):
        payload = self._call()
        self.assertEqual(payload["kpis"]["greenhouseCount"], 3)

    def test_crop_filter_restricts_results(self):
        payload = self._call(crop="Rose")
        self.assertEqual(payload["kpis"]["greenhouseCount"], 2)  # only GH 1 + GH 2
```

- [ ] **Step 2: Run to confirm failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_overview
```
Expected: ImportError on `overview`.

- [ ] **Step 3: Implement the overview() shell + KPIs**

Create `_overview.py`:
```python
"""Overview tab aggregator."""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    resolve_greenhouse_scope,
)


def overview(args: dict, force: bool = False) -> dict:
    """Return the Overview tab payload (9 aggregations).

    See spec §API Contract for the exact response shape.
    """
    from_date = args.get("from_date", "")
    to_date   = args.get("to_date", "")
    crop      = (args.get("crop") or "").strip()
    farm      = (args.get("farm") or "").strip()
    gh        = (args.get("greenhouse") or "").strip()

    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(gh, farm, farms_map)

    cache_filters = {
        "from_date": from_date, "to_date": to_date,
        "crop": crop, "farm": farm, "greenhouse": gh,
    }
    return cached_aggregate(
        "overview",
        cache_filters,
        lambda: _build(from_date, to_date, crop, scope),
        force=force,
    )


def _build(from_date, to_date, crop, scope) -> dict:
    where, params = parent_filter_conditions(from_date, to_date, crop, scope)

    kpis = _kpis(where, params)

    return {
        "kpis": kpis,
        "daily": [],            # next steps fill these
        "rangeTotals": {"pests": 0, "diseases": 0, "traps": 0},
        "ghHealth": [],
        "topScouts": [],
        "scoutsPerDay": [],
        "scoutPerformance": [],
        "recentActivity": [],
        "activeAlerts": [],
    }


def _kpis(where: str, params: dict) -> dict:
    row = frappe.db.sql(
        f"""
        SELECT
            COUNT(DISTINCT se.scouts_name) AS total_scouts,
            COUNT(DISTINCT se.name)        AS zones_scouted,
            COUNT(DISTINCT COALESCE(NULLIF(se.greenhouse, ''), se.block)) AS gh_count
        FROM `tabScouting Entry` se
        WHERE {where}
        """,
        params,
        as_dict=True,
    )[0] or {}
    return {
        "totalScouts":     int(row.get("total_scouts") or 0),
        "zonesScouted":    int(row.get("zones_scouted") or 0),
        "greenhouseCount": int(row.get("gh_count") or 0),
        "highAlerts":      0,  # set in Task 7 alongside ghHealth
    }
```

- [ ] **Step 4: Confirm KPIs pass**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_overview
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_overview.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py
git commit -m "feat(dashboard-agg): overview kpis"
```

---

### Task 7: Overview — daily, rangeTotals, ghHealth, activeAlerts

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_overview.py`
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py`

These four share a single observation join. Compute them in one SQL pass.

- [ ] **Step 1: Tests for daily + rangeTotals + ghHealth + activeAlerts**

Append to `test_dashboard_aggregates_overview.py`:
```python
class TestOverviewDailyAndTotals(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._overview import overview
        args = {
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }
        args.update(overrides)
        return overview(args, force=True)  # bypass cache between assertions

    def test_daily_has_one_row_per_observed_date(self):
        payload = self._call()
        dates = {d["date"] for d in payload["daily"]}
        # 12 distinct dates in fixture
        self.assertEqual(len(dates), 12)

    def test_daily_pest_count_for_2026_05_06(self):
        # One entry on 2026-05-06: 1 pest obs (Thrips count=22) → counted as 1 row.
        payload = self._call()
        row = next(d for d in payload["daily"] if d["date"] == "2026-05-06")
        self.assertEqual(row["pests"], 1)
        self.assertEqual(row["diseases"], 0)
        self.assertEqual(row["traps"], 0)

    def test_range_totals(self):
        payload = self._call()
        # Pests obs: 7 rows have pests with at least one obs each → sum of rows.
        # Diseases obs: 4 disease rows. Traps: 4 trap rows.
        # See fixture: pest rows on 05-04,05,06,11,13,14,(09 has 1 pest obs too) = 7
        # plus 05-09 → 7. Disease rows: 05-07,08,12,14 → 4. Trap rows: 05-09,10,13,15 → 4.
        self.assertEqual(payload["rangeTotals"]["pests"],    7)
        self.assertEqual(payload["rangeTotals"]["diseases"], 4)
        self.assertEqual(payload["rangeTotals"]["traps"],    4)

    def test_gh_health_ranked_by_total(self):
        payload = self._call()
        self.assertTrue(payload["ghHealth"])
        names = [g["name"] for g in payload["ghHealth"]]
        # GH 1 has most activity (pests-heavy) so it should be first.
        self.assertEqual(names[0], "_TEST GH 1")

    def test_active_alerts_high_first(self):
        payload = self._call()
        # 2026-05-06 thrips count=22 → high pest alert.
        # 2026-05-13 thrips count=18 → high pest alert.
        # Disease "Active"/"Severe" rows → high disease alerts.
        kinds = [a["kind"] for a in payload["activeAlerts"][:4]]
        sevs  = [a["severity"] for a in payload["activeAlerts"][:4]]
        # First alerts should be 'high' severity.
        self.assertTrue(all(s == "high" for s in sevs))
        self.assertIn("pest", kinds)
        self.assertIn("disease", kinds)
```

- [ ] **Step 2: Run to confirm failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_overview
```
Expected: original 4 pass, new 5 fail.

- [ ] **Step 3: Implement the four aggregations**

Update `_build` in `_overview.py` and add the helpers below:

```python
def _build(from_date, to_date, crop, scope) -> dict:
    where, params = parent_filter_conditions(from_date, to_date, crop, scope)

    kpis    = _kpis(where, params)
    obs     = _observation_rows(where, params)
    daily, range_totals = _daily_and_totals(obs)
    gh_health, alerts_total = _gh_health(obs)
    active = _active_alerts(obs)
    top_scouts, scouts_per_day, scout_perf = _scout_aggs(obs)
    recent = _recent_activity(where, params)

    kpis["highAlerts"] = alerts_total

    return {
        "kpis": kpis,
        "daily": daily,
        "rangeTotals": range_totals,
        "ghHealth": gh_health,
        "topScouts": top_scouts,
        "scoutsPerDay": scouts_per_day,
        "scoutPerformance": scout_perf,
        "recentActivity": recent,
        "activeAlerts": active,
    }


def _observation_rows(where: str, params: dict) -> list:
    """One row per (entry, observation kind, observation row). Sub-queries
    UNION pests/diseases/traps so a single Python pass can derive most of
    the Overview metrics."""
    return frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.scouts_name, se.zone, se.bed, se.tree,
               'pest'    AS kind,
               p.pest    AS obs_name, p.count AS count,
               p.stage   AS stage,    p.plant_section AS plant_section
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
        UNION ALL
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.scouts_name, se.zone, se.bed, se.tree,
               'disease' AS kind,
               d.disease AS obs_name, NULL AS count,
               d.stage   AS stage, d.plant_section AS plant_section
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}
        UNION ALL
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.scouts_name, se.zone, se.bed, se.tree,
               'trap'    AS kind,
               t.trap    AS obs_name, t.count AS count,
               NULL      AS stage, t.location AS plant_section
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )


def _daily_and_totals(obs: list) -> tuple:
    """Counts a row per (date, kind). One observation = one count; this mirrors
    the JS aggregator's append() which pushes one element per child row."""
    by_date = {}
    totals = {"pests": 0, "diseases": 0, "traps": 0}
    for r in obs:
        d = str(r.date_of_capture)[:10]
        bucket = by_date.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})
        if r.kind == "pest":
            bucket["pests"] += 1
            totals["pests"] += 1
        elif r.kind == "disease":
            bucket["diseases"] += 1
            totals["diseases"] += 1
        elif r.kind == "trap":
            bucket["traps"] += 1
            totals["traps"] += 1
    return sorted(by_date.values(), key=lambda x: x["date"]), totals


def _gh_health(obs: list) -> tuple:
    """Per-greenhouse counts + alert count. Alert rule:
       - pest count > 15 → +1 alert
       - disease severity high/active/severe → +1 alert
       - trap count > 10 → +1 alert (matches greenhouseDetail in aggregate.ts)"""
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        pest_severity, disease_severity,
    )
    by_gh = {}
    total_alerts = 0
    scouts_by_gh = {}
    for r in obs:
        gh = r.greenhouse or r.block or "—"
        bucket = by_gh.setdefault(gh, {"name": gh, "pests": 0, "diseases": 0,
                                       "traps": 0, "scoutCount": 0, "alerts": 0})
        scouts_by_gh.setdefault(gh, set()).add(r.scouts_name or "")
        if r.kind == "pest":
            bucket["pests"] += 1
            if pest_severity(r.count) == "high":
                bucket["alerts"] += 1
                total_alerts += 1
        elif r.kind == "disease":
            bucket["diseases"] += 1
            if disease_severity(r.stage) == "high":
                bucket["alerts"] += 1
                total_alerts += 1
        elif r.kind == "trap":
            bucket["traps"] += 1
            if (r.count or 0) > 10:
                bucket["alerts"] += 1
                total_alerts += 1
    for gh, bucket in by_gh.items():
        bucket["scoutCount"] = len([s for s in scouts_by_gh[gh] if s])
        a = bucket["alerts"]
        bucket["status"] = "critical" if a > 2 else "warning" if a > 0 else "good"
    out = sorted(
        by_gh.values(),
        key=lambda x: x["pests"] + x["diseases"] + x["traps"],
        reverse=True,
    )
    return out, total_alerts


def _active_alerts(obs: list, n: int = 8) -> list:
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        pest_severity, disease_severity,
    )
    out = []
    for r in obs:
        gh   = r.greenhouse or r.block or "—"
        zone = r.zone or r.tree or ""
        date = str(r.date_of_capture)[:10]
        if r.kind == "pest":
            sev = pest_severity(r.count)
            if sev:
                out.append({"name": r.obs_name, "kind": "pest", "severity": sev,
                            "count": int(r.count or 0),
                            "greenhouse": gh, "zone": zone, "date": date})
        elif r.kind == "disease":
            sev = disease_severity(r.stage)
            if sev:
                out.append({"name": r.obs_name, "kind": "disease", "severity": sev,
                            "count": 1,
                            "greenhouse": gh, "zone": zone, "date": date})
    out.sort(key=lambda a: (0 if a["severity"] == "high" else 1, -ord(a["date"][0]),
                            a["date"]), reverse=True)
    # The composite key above mirrors the JS comparator: high-first, then date desc.
    out.sort(key=lambda a: (a["severity"] != "high", -int(a["date"].replace("-", ""))))
    return out[:n]
```

(The double-sort in `_active_alerts` is the simplest port of the JS comparator
that returns `-1` when `a.severity === 'high'` and `b.date.localeCompare(a.date)`
otherwise. Sorting twice — primary key second — gives stable ordering with
plain `list.sort`.)

- [ ] **Step 4: Run; iterate until passing**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_overview
```
Expected: 9 passed (4 old + 5 new).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_overview.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py
git commit -m "feat(dashboard-agg): overview daily/totals/ghHealth/alerts"
```

---

### Task 8: Overview — scout aggs + recent activity

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_overview.py`
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py`

- [ ] **Step 1: Tests**

```python
class TestOverviewScouts(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self):
        from upande_scp.serverscripts.dashboard_aggregates._overview import overview
        return overview({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)

    def test_top_scouts_returns_scout_ids(self):
        payload = self._call()
        ids = [s["scoutId"] for s in payload["topScouts"]]
        self.assertIn("_TEST Scout 001", ids)

    def test_scouts_per_day_distinct(self):
        payload = self._call()
        # Every fixture entry uses the same scout; each date has exactly 1.
        self.assertTrue(all(d["scouts"] == 1 for d in payload["scoutsPerDay"]))

    def test_recent_activity_top_8_with_scoutId(self):
        payload = self._call()
        self.assertLessEqual(len(payload["recentActivity"]), 8)
        for r in payload["recentActivity"]:
            self.assertIn("scoutId", r)
            self.assertIn("kind", r)
```

- [ ] **Step 2: Run, expect failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_overview
```

- [ ] **Step 3: Implement _scout_aggs and _recent_activity**

Append to `_overview.py`:
```python
def _scout_aggs(obs: list) -> tuple:
    """Returns (topScouts, scoutsPerDay, scoutPerformance) — all keyed by scoutId."""
    entries_by_scout = {}
    obs_by_scout = {}
    scouts_by_date = {}
    seen_entries = set()
    for r in obs:
        sid = (r.scouts_name or "").strip()
        date = str(r.date_of_capture)[:10]
        if not sid:
            continue
        if r.name not in seen_entries:
            seen_entries.add(r.name)
            entries_by_scout[sid] = entries_by_scout.get(sid, 0) + 1
            scouts_by_date.setdefault(date, set()).add(sid)
        ob = obs_by_scout.setdefault(sid, {"pests": 0, "diseases": 0})
        if r.kind == "pest":
            ob["pests"] += 1
        elif r.kind == "disease":
            ob["diseases"] += 1
    top = [{"scoutId": s, "entries": n} for s, n in entries_by_scout.items()]
    top.sort(key=lambda x: x["entries"], reverse=True)
    perf = [
        {"scoutId": s, "zones": entries_by_scout.get(s, 0),
         "pests": ob["pests"], "diseases": ob["diseases"]}
        for s, ob in obs_by_scout.items()
    ]
    perf.sort(key=lambda x: x["zones"], reverse=True)
    spd = [{"date": d, "scouts": len(s)} for d, s in scouts_by_date.items()]
    spd.sort(key=lambda x: x["date"])
    return top[:6], spd, perf[:8]


def _recent_activity(where: str, params: dict, n: int = 8) -> list:
    """Top N most recent entries with their primary observation kind."""
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.time_of_capture,
               se.greenhouse, se.block, se.zone, se.tree, se.scouts_name,
               EXISTS(SELECT 1 FROM `tabPests Scouting Entry` p WHERE p.parent = se.name)    AS has_pest,
               EXISTS(SELECT 1 FROM `tabDiseases Scouting Entry` d WHERE d.parent = se.name) AS has_disease,
               EXISTS(SELECT 1 FROM `tabTrap Scouting Entry` t WHERE t.parent = se.name)     AS has_trap
        FROM `tabScouting Entry` se
        WHERE {where}
        ORDER BY se.date_of_capture DESC, se.time_of_capture DESC
        LIMIT %(limit)s
        """,
        {**params, "limit": n},
        as_dict=True,
    )
    out = []
    for r in rows:
        kind = ("pest"    if r.has_pest
                else "disease" if r.has_disease
                else "trap"    if r.has_trap
                else "other")
        out.append({
            "name":       r.name,
            "date":       str(r.date_of_capture)[:10],
            "time":       str(r.time_of_capture or ""),
            "greenhouse": r.greenhouse or r.block or "—",
            "zone":       r.zone or r.tree or "",
            "scoutId":    r.scouts_name or "",
            "kind":       kind,
        })
    return out
```

- [ ] **Step 4: Run, expect pass**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_overview
```
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_overview.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_overview.py
git commit -m "feat(dashboard-agg): overview scout aggregations and recent activity"
```

---

### Task 9: Pests / Diseases endpoint — shared shell

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py`
- Create: `upande_scp/serverscripts/tests/test_dashboard_aggregates_pests_diseases.py`

Both endpoints share the same shape; the only difference is which child table
they read and whether the keyword is "pest" or "disease".

- [ ] **Step 1: Tests for pests() ranking + filterOptions**

```python
from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestPestsEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._pests_diseases import pests
        args = {
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
            "observation": "", "section": "", "stage": "",
        }
        args.update(overrides)
        return pests(args, force=True)

    def test_ranking_orders_by_total_count(self):
        payload = self._call()
        names = [r["name"] for r in payload["ranking"]]
        # Thrips total: 3+7+22+4+11 = 47; FCM total: 2+18 = 20.
        self.assertEqual(names[0], "_TEST Thrips")
        self.assertEqual(names[1], "_TEST False Codling Moth")

    def test_filter_options_lists_distinct_values(self):
        payload = self._call()
        self.assertEqual(set(payload["filterOptions"]["pests"]),
                         {"_TEST Thrips", "_TEST False Codling Moth"})
        self.assertIn("Leaf", payload["filterOptions"]["sections"])
        self.assertIn("Fruit", payload["filterOptions"]["sections"])

    def test_severity_buckets(self):
        payload = self._call()
        thrips = next(r for r in payload["ranking"] if r["name"] == "_TEST Thrips")
        # Thrips counts: 3, 7, 22, 4, 11 → low (3,4), moderate (7,11), high (22)
        self.assertEqual(thrips["low"], 2)
        self.assertEqual(thrips["moderate"], 2)
        self.assertEqual(thrips["high"], 1)
```

- [ ] **Step 2: Run, expect failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_pests_diseases
```

- [ ] **Step 3: Implement pests() with ranking + filter options**

Create `_pests_diseases.py`:
```python
"""Pests and Diseases tabs aggregator (shared)."""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    pest_severity,
    resolve_greenhouse_scope,
)


def pests(args: dict, force: bool = False) -> dict:
    return _build_endpoint("pest", args, force)


def diseases(args: dict, force: bool = False) -> dict:
    return _build_endpoint("disease", args, force)


_TABLE = {
    "pest":    ("tabPests Scouting Entry",    "pest"),
    "disease": ("tabDiseases Scouting Entry", "disease"),
}


def _build_endpoint(kind: str, args: dict, force: bool) -> dict:
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    filters = {
        "kind": kind,
        "from_date": args.get("from_date", ""),
        "to_date":   args.get("to_date", ""),
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse":(args.get("greenhouse") or "").strip(),
        "observation":(args.get("observation") or "").strip(),
        "section":   (args.get("section") or "").strip(),
        "stage":     (args.get("stage") or "").strip(),
    }
    return cached_aggregate(
        kind + "s",
        filters,
        lambda: _build(kind, filters, scope),
        force=force,
    )


def _build(kind: str, filters: dict, scope) -> dict:
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    table, col = _TABLE[kind]
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.zone, se.bed, se.tree,
               c.{col} AS obs_name, c.plant_section AS plant_section,
               c.stage AS stage,
               { "c.count AS count" if kind == "pest" else "NULL AS count" }
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )

    ranking = _ranking(kind, rows)
    filter_options = _filter_options(rows)

    return {
        "filterOptions": filter_options,
        "ranking": ranking,
        "distribution": [],         # filled in Task 10
        "sectionSplit": [],
        "greenhousePressure": [],
        "dailyPercent": [],
        "trendSeries": {"rows": [], "keys": []},
    }


def _ranking(kind: str, rows: list) -> list:
    by_name = {}
    for r in rows:
        bucket = by_name.setdefault(r.obs_name,
                                    {"name": r.obs_name, "total": 0,
                                     "high": 0, "moderate": 0, "low": 0})
        if kind == "pest":
            n = int(r.count or 0)
            bucket["total"] += n
            sev = pest_severity(n)
            bucket["high"     if sev == "high" else
                   "moderate" if sev == "moderate" else
                   "low"] += 1
        else:
            bucket["total"] += 1
            from upande_scp.serverscripts.dashboard_aggregates._common import (
                disease_severity,
            )
            sev = disease_severity(r.stage)
            bucket["high"     if sev == "high" else
                   "moderate" if sev == "moderate" else
                   "low"] += 1
    return sorted(by_name.values(), key=lambda x: x["total"], reverse=True)


def _filter_options(rows: list) -> dict:
    obs       = sorted({r.obs_name for r in rows if r.obs_name})
    sections  = sorted({r.plant_section for r in rows if r.plant_section})
    stages    = sorted({(r.stage or "") for r in rows if (r.stage or "")})
    return {
        # Re-use the JS key names so the frontend doesn't need to rename.
        "pests" if False else "items": obs,  # placeholder swap below
        "sections": sections,
        "stages": stages,
    }
```

Wait — the JS returns `pests` for pestsTab and `diseases` for diseasesTab.
We need to swap that key in `_build_endpoint`. Replace the `_filter_options`
call site:

```python
filter_options = _filter_options(rows)
filter_options[kind + "s"] = filter_options.pop("items")
```

And remove the `"items":` -> `"pests" if False else "items"` line; just use
`"items"` consistently in `_filter_options` (the swap happens in `_build`).

So the final `_filter_options` returns:
```python
return {"items": obs, "sections": sections, "stages": stages}
```

- [ ] **Step 4: Run, expect pass**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_pests_diseases
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_pests_diseases.py
git commit -m "feat(dashboard-agg): pests/diseases ranking + filterOptions"
```

---

### Task 10: Pests/Diseases — distribution, sectionSplit, ghPressure, dailyPercent, trendSeries

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py`
- Modify: `upande_scp/serverscripts/tests/test_dashboard_aggregates_pests_diseases.py`

These are zone-based percentages and time-series — port from `aggregate.ts`
lines 348–597 and 234–264.

- [ ] **Step 1: Tests**

Append to `test_dashboard_aggregates_pests_diseases.py`:
```python
class TestPestsZoneMetrics(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, **overrides):
        from upande_scp.serverscripts.dashboard_aggregates._pests_diseases import pests
        args = {
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
            "observation": "", "section": "", "stage": "",
        }
        args.update(overrides)
        return pests(args, force=True)

    def test_distribution_returns_one_row_per_pest(self):
        payload = self._call()
        names = {d["name"] for d in payload["distribution"]}
        self.assertEqual(names, {"_TEST Thrips", "_TEST False Codling Moth"})

    def test_section_split_filters_by_observation(self):
        payload = self._call(observation="_TEST Thrips")
        # Thrips appears in 'Leaf' and 'Stem' sections.
        names = {s["name"] for s in payload["sectionSplit"]}
        self.assertIn("Leaf", names)
        self.assertIn("Stem", names)

    def test_daily_percent_one_row_per_date_with_match(self):
        payload = self._call(observation="_TEST Thrips")
        dates = [r["date"] for r in payload["dailyPercent"]]
        # Thrips dates: 05-04, 05-05, 05-06, 05-11, 05-14
        self.assertEqual(set(dates), {"2026-05-04", "2026-05-05", "2026-05-06",
                                      "2026-05-11", "2026-05-14"})

    def test_trend_series_top_n(self):
        payload = self._call()
        # Two distinct pests → two keys.
        self.assertEqual(set(payload["trendSeries"]["keys"]),
                         {"_TEST Thrips", "_TEST False Codling Moth"})
```

- [ ] **Step 2: Run, expect failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_pests_diseases
```

- [ ] **Step 3: Implement zone-percent metrics + trend series**

Add helpers to `_pests_diseases.py`. The implementation must mirror the JS
`uniqueZoneKey` rule from `aggregate.ts:335-345`:
- if block → `block::tree::tree` (tree may be empty)
- else if zone → `zone::zone`
- else if bed → `bed::bed`
- else empty (skip)

```python
from upande_scp.serverscripts.scouting_metrics import get_zone_counts_by_greenhouse


def _zone_key(row) -> str:
    """Mirror aggregate.ts uniqueZoneKey."""
    if row.block:
        return f"{row.block}::tree::{row.tree or ''}"
    if row.zone:
        return f"zone::{row.zone}"
    if row.bed:
        return f"bed::{row.bed}"
    return ""


def _filter_row(row, filters: dict) -> bool:
    """Apply observation/section/stage filters to a single child row."""
    if filters["observation"] and row.obs_name != filters["observation"]:
        return False
    if filters["section"] and row.plant_section != filters["section"]:
        return False
    if filters["stage"] and (row.stage or "") != filters["stage"]:
        return False
    return True


def _distribution(rows, filters, zones_by_gh) -> list:
    """% of total zones in scope that have each observation type."""
    ghs_in_scope = {r.greenhouse or r.block for r in rows
                    if (r.greenhouse or r.block)}
    denom = max(1, sum(zones_by_gh.get(gh, 0) for gh in ghs_in_scope))
    by_obs = {}
    for r in rows:
        if not _filter_row(r, {**filters, "observation": ""}):
            continue
        u = _zone_key(r)
        if not u:
            continue
        by_obs.setdefault(r.obs_name, set()).add(u)
    out = [{"name": n, "zones": len(s),
            "pct": round(len(s) / denom * 1000) / 10}
           for n, s in by_obs.items()]
    out.sort(key=lambda x: x["zones"], reverse=True)
    return out


def _section_split(rows, filters) -> list:
    sections = {}
    for r in rows:
        if filters["observation"] and r.obs_name != filters["observation"]:
            continue
        if filters["stage"] and (r.stage or "") != filters["stage"]:
            continue
        sec = (r.plant_section or "Unknown").strip() or "Unknown"
        u = _zone_key(r)
        if not u:
            continue
        sections.setdefault(sec, set()).add(u)
    total = max(1, sum(len(s) for s in sections.values()))
    out = [{"name": n, "zones": len(s),
            "pct": round(len(s) / total * 1000) / 10}
           for n, s in sections.items()]
    out.sort(key=lambda x: x["zones"], reverse=True)
    return out


def _gh_pressure(rows, filters, zones_by_gh) -> list:
    gh_to_zones = {}
    for r in rows:
        if not _filter_row(r, filters):
            continue
        gh = r.greenhouse or r.block
        if not gh:
            continue
        u = _zone_key(r)
        if not u:
            continue
        gh_to_zones.setdefault(gh, set()).add(u)
    out = [{"name": gh, "zones": len(s),
            "pct": round(len(s) / max(1, zones_by_gh.get(gh, 0)) * 1000) / 10}
           for gh, s in gh_to_zones.items()]
    out.sort(key=lambda x: x["pct"], reverse=True)
    return out


def _daily_percent(rows, filters, zones_by_gh) -> list:
    ghs = {r.greenhouse or r.block for r in rows if (r.greenhouse or r.block)}
    denom = max(1, sum(zones_by_gh.get(gh, 0) for gh in ghs))
    by_date = {}
    by_entry = {}
    for r in rows:
        if not _filter_row(r, filters):
            continue
        u = _zone_key(r)
        if not u:
            continue
        date = str(r.date_of_capture)[:10]
        if by_entry.get((date, r.name)) == u:
            continue
        by_entry[(date, r.name)] = u
        by_date.setdefault(date, set()).add(u)
    out = [{"date": d, "value": round(len(s) / denom * 1000) / 10}
           for d, s in by_date.items()]
    out.sort(key=lambda x: x["date"])
    return out


def _trend_series(rows, kind: str, top_n: int = 5) -> dict:
    """One row per date, one key per top-N observation, value = sum of count
    (pest) or 1-per-row (disease)."""
    pairs = {}
    for r in rows:
        bucket = pairs.setdefault(r.obs_name, {"name": r.obs_name, "total": 0,
                                                "daily": {}})
        date = str(r.date_of_capture)[:10]
        v = int(r.count or 0) if kind == "pest" else 1
        bucket["daily"][date] = bucket["daily"].get(date, 0) + v
        bucket["total"] += v
    top = sorted(pairs.values(), key=lambda x: x["total"], reverse=True)[:top_n]
    if not top:
        return {"rows": [], "keys": []}
    dates = sorted({d for p in top for d in p["daily"]})
    keys = [p["name"] for p in top]
    out_rows = []
    for d in dates:
        row = {"date": d}
        for p in top:
            row[p["name"]] = p["daily"].get(d, 0)
        out_rows.append(row)
    return {"rows": out_rows, "keys": keys}
```

Update `_build` to call them:

```python
def _build(kind: str, filters: dict, scope) -> dict:
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    table, col = _TABLE[kind]
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.zone, se.bed, se.tree,
               c.{col} AS obs_name, c.plant_section AS plant_section,
               c.stage AS stage,
               { "c.count AS count" if kind == "pest" else "NULL AS count" }
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )
    zones_by_gh = get_zone_counts_by_greenhouse() or {}

    ranking = _ranking(kind, rows)
    fo = _filter_options(rows)
    fo[kind + "s"] = fo.pop("items")
    return {
        "filterOptions":      fo,
        "ranking":             ranking,
        "distribution":       _distribution(rows, filters, zones_by_gh),
        "sectionSplit":       _section_split(rows, filters),
        "greenhousePressure": _gh_pressure(rows, filters, zones_by_gh),
        "dailyPercent":       _daily_percent(rows, filters, zones_by_gh),
        "trendSeries":        _trend_series(rows, kind),
    }
```

- [ ] **Step 4: Run, expect pass**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_pests_diseases
```
Expected: 7 passed.

- [ ] **Step 5: Diseases test**

Append a small smoke test class that exercises `diseases()` and confirms the
returned shape uses `"diseases"` (not `"pests"`) as the filter-options key:

```python
class TestDiseasesEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def test_diseases_endpoint_returns_disease_keyed_filter_options(self):
        from upande_scp.serverscripts.dashboard_aggregates._pests_diseases import (
            diseases,
        )
        payload = diseases({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
            "observation": "", "section": "", "stage": "",
        }, force=True)
        self.assertIn("diseases", payload["filterOptions"])
        self.assertIn("_TEST Powdery Mildew", payload["filterOptions"]["diseases"])
        self.assertTrue(payload["ranking"])
```

Run:
```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_pests_diseases
```
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_pests_diseases.py
git commit -m "feat(dashboard-agg): pests/diseases zone-percent metrics and trend series"
```

---

### Task 11: Traps endpoint

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/_traps.py`
- Create: `upande_scp/serverscripts/tests/test_dashboard_aggregates_traps.py`

- [ ] **Step 1: Tests**

```python
from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestTrapsEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self):
        from upande_scp.serverscripts.dashboard_aggregates._traps import traps
        return traps({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)

    def test_ranking_by_pest_total(self):
        payload = self._call()
        # Trap counts: 5 + 12 + 30 + 1 = 48 for FCM via Yellow Sticky.
        first = payload["ranking"][0]
        self.assertEqual(first["trap"], "_TEST Yellow Sticky")
        self.assertEqual(first["pest"], "_TEST False Codling Moth")
        self.assertEqual(first["total"], 48)
        self.assertEqual(first["avg"], 12)  # 48/4 → 12

    def test_pest_breakdown(self):
        payload = self._call()
        names = {b["name"]: b["value"] for b in payload["pestBreakdown"]}
        self.assertEqual(names["_TEST False Codling Moth"], 48)

    def test_trend_series_keys_and_rows(self):
        payload = self._call()
        self.assertEqual(set(payload["trendSeries"]["keys"]),
                         {"_TEST False Codling Moth"})
        self.assertEqual(len(payload["trendSeries"]["rows"]), 4)
```

- [ ] **Step 2: Run, expect failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_traps
```

- [ ] **Step 3: Implement traps()**

Create `_traps.py`:
```python
"""Traps tab aggregator."""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    resolve_greenhouse_scope,
)


def traps(args: dict, force: bool = False) -> dict:
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    filters = {
        "from_date": args.get("from_date", ""),
        "to_date":   args.get("to_date", ""),
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse":(args.get("greenhouse") or "").strip(),
    }
    return cached_aggregate(
        "traps", filters, lambda: _build(filters, scope), force=force,
    )


def _build(filters: dict, scope) -> dict:
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )
    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               t.trap, t.pest, t.location, t.count
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )

    return {
        "ranking":       _ranking(rows),
        "pestBreakdown": _pest_breakdown(rows),
        "trendSeries":   _trend_series(rows),
    }


def _ranking(rows: list) -> list:
    by_key = {}
    for r in rows:
        k = f"{r.trap}-{r.pest}"
        b = by_key.setdefault(k, {"key": k, "trap": r.trap, "pest": r.pest,
                                  "total": 0, "_count": 0})
        b["total"] += int(r.count or 0)
        b["_count"] += 1
    out = []
    for b in by_key.values():
        avg = round(b["total"] / b["_count"]) if b["_count"] else 0
        out.append({"key": b["key"], "trap": b["trap"], "pest": b["pest"],
                    "total": b["total"], "avg": avg})
    out.sort(key=lambda x: x["total"], reverse=True)
    return out


def _pest_breakdown(rows: list) -> list:
    by_pest = {}
    for r in rows:
        by_pest[r.pest] = by_pest.get(r.pest, 0) + int(r.count or 0)
    return sorted(
        [{"name": k, "value": v} for k, v in by_pest.items()],
        key=lambda x: x["value"], reverse=True,
    )


def _trend_series(rows: list, top_n: int = 5) -> dict:
    by_pest = {}
    for r in rows:
        p = by_pest.setdefault(r.pest, {"name": r.pest, "total": 0, "daily": {}})
        v = int(r.count or 0)
        d = str(r.date_of_capture)[:10]
        p["daily"][d] = p["daily"].get(d, 0) + v
        p["total"] += v
    top = sorted(by_pest.values(), key=lambda x: x["total"], reverse=True)[:top_n]
    if not top:
        return {"rows": [], "keys": []}
    dates = sorted({d for p in top for d in p["daily"]})
    keys = [p["name"] for p in top]
    out_rows = []
    for d in dates:
        row = {"date": d}
        for p in top:
            row[p["name"]] = p["daily"].get(d, 0)
        out_rows.append(row)
    return {"rows": out_rows, "keys": keys}
```

- [ ] **Step 4: Run, expect pass**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_traps
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_traps.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_traps.py
git commit -m "feat(dashboard-agg): traps endpoint"
```

---

### Task 12: FCM endpoint

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/_fcm.py`
- Create: `upande_scp/serverscripts/tests/test_dashboard_aggregates_fcm.py`

`FcmTab.tsx:31` defines the focus regex `/fcm|moth|codling|tortrix|noctuid/i`.
Apply it server-side to pest and trap names.

- [ ] **Step 1: Tests**

```python
from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestFcmEndpoint(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self):
        from upande_scp.serverscripts.dashboard_aggregates._fcm import fcm
        return fcm({
            "from_date": "2026-05-04", "to_date": "2026-05-15",
            "crop": "", "farm": "", "greenhouse": "",
        }, force=True)

    def test_kpis(self):
        p = self._call()
        # Trap counts: 5 + 12 + 30 + 1 = 48 → trapTotal=48
        # Scouting pest counts (FCM only): 2 + 18 = 20 → pestTotal=20
        self.assertEqual(p["kpis"]["trapTotal"], 48)
        self.assertEqual(p["kpis"]["pestTotal"], 20)
        self.assertEqual(p["kpis"]["greenhouseCount"], 1)  # only GH 3

    def test_daily_has_traps_and_scouting(self):
        p = self._call()
        # 4 trap dates + 2 pest dates with FCM, deduped → 5 unique dates.
        dates = [d["date"] for d in p["daily"]]
        self.assertEqual(set(dates), {"2026-05-09", "2026-05-10", "2026-05-13",
                                      "2026-05-15", "2026-05-09"})
        # Has both keys.
        sample = p["daily"][0]
        self.assertIn("traps", sample)
        self.assertIn("scouting", sample)

    def test_breakdown_filters_focus_only(self):
        p = self._call()
        names = {b["name"] for b in p["pestBreakdown"]}
        self.assertEqual(names, {"_TEST False Codling Moth"})

    def test_focus_pests_list_top_n(self):
        p = self._call()
        names = [r["name"] for r in p["focusPests"]]
        self.assertIn("_TEST False Codling Moth", names)
```

- [ ] **Step 2: Run, expect failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_fcm
```

- [ ] **Step 3: Implement fcm()**

Create `_fcm.py`:
```python
"""FCM tab aggregator — pulls trap + pest rows whose names match the focus
regex /fcm|moth|codling|tortrix|noctuid/i."""

import re

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
    resolve_greenhouse_scope,
)


_FOCUS_RE = re.compile(r"fcm|moth|codling|tortrix|noctuid", re.IGNORECASE)


def fcm(args: dict, force: bool = False) -> dict:
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    scope = resolve_greenhouse_scope(
        (args.get("greenhouse") or "").strip(),
        (args.get("farm") or "").strip(),
        farms_map,
    )
    filters = {
        "from_date": args.get("from_date", ""),
        "to_date":   args.get("to_date", ""),
        "crop":      (args.get("crop") or "").strip(),
        "farm":      (args.get("farm") or "").strip(),
        "greenhouse":(args.get("greenhouse") or "").strip(),
    }
    return cached_aggregate(
        "fcm", filters, lambda: _build(filters, scope), force=force,
    )


def _build(filters: dict, scope) -> dict:
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"], scope,
    )

    pests = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               se.zone,
               p.pest, p.count
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )
    traps = frappe.db.sql(
        f"""
        SELECT se.name, se.date_of_capture, se.greenhouse, se.block,
               t.trap, t.pest, t.count
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
        """,
        params,
        as_dict=True,
    )

    focus_pests = [r for r in pests if _FOCUS_RE.search(r.pest or "")]
    focus_traps = [r for r in traps if _FOCUS_RE.search(r.pest or "")]

    trap_total = sum(int(r.count or 0) for r in focus_traps)
    pest_total = sum(int(r.count or 0) for r in focus_pests)
    zones = {r.zone for r in focus_pests if r.zone}
    ghs = {(r.greenhouse or r.block) for r in focus_traps if (r.greenhouse or r.block)}

    daily = {}
    for r in focus_traps:
        d = str(r.date_of_capture)[:10]
        b = daily.setdefault(d, {"date": d, "traps": 0, "scouting": 0})
        b["traps"] += int(r.count or 0)
    for r in focus_pests:
        d = str(r.date_of_capture)[:10]
        b = daily.setdefault(d, {"date": d, "traps": 0, "scouting": 0})
        b["scouting"] += int(r.count or 0)

    breakdown = {}
    for r in focus_traps:
        breakdown[r.pest] = breakdown.get(r.pest, 0) + int(r.count or 0)

    focus_pest_totals = {}
    for r in focus_pests:
        focus_pest_totals[r.pest] = focus_pest_totals.get(r.pest, 0) + int(r.count or 0)

    return {
        "kpis": {
            "trapTotal":       trap_total,
            "pestTotal":       pest_total,
            "focusZones":      len(zones),
            "greenhouseCount": len(ghs),
        },
        "daily":         sorted(daily.values(), key=lambda x: x["date"]),
        "pestBreakdown": sorted(
            [{"name": n, "value": v} for n, v in breakdown.items()],
            key=lambda x: x["value"], reverse=True,
        ),
        "focusPests":    sorted(
            [{"name": n, "total": v} for n, v in focus_pest_totals.items()],
            key=lambda x: x["total"], reverse=True,
        )[:10],
    }
```

- [ ] **Step 4: Run, expect pass**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_fcm
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_fcm.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_fcm.py
git commit -m "feat(dashboard-agg): fcm endpoint"
```

---

### Task 13: Greenhouse-detail endpoint

**Files:**
- Create: `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py`
- Create: `upande_scp/serverscripts/tests/test_dashboard_aggregates_gh_detail.py`

Ports `aggregate.ts greenhouseDetail` (line 693) verbatim.

- [ ] **Step 1: Tests**

```python
from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.tests.test_dashboard_aggregates_fixture import (
    insert_fixture,
)


class TestGreenhouseDetail(FrappeTestCase):
    def setUp(self):
        insert_fixture()

    def _call(self, gh):
        from upande_scp.serverscripts.dashboard_aggregates._gh_detail import (
            greenhouse_detail,
        )
        return greenhouse_detail({
            "greenhouse": gh,
            "from_date": "2026-05-04",
            "to_date":   "2026-05-15",
            "crop":      "",
        }, force=True)

    def test_top_pests_for_gh1(self):
        p = self._call("_TEST GH 1")
        names = [t["name"] for t in p["topPests"]]
        self.assertEqual(names[0], "_TEST Thrips")

    def test_traps_for_gh3(self):
        p = self._call("_TEST GH 3")
        self.assertTrue(p["traps"])
        self.assertEqual(p["traps"][0]["pest"], "_TEST False Codling Moth")

    def test_alerts_for_high_severity(self):
        p = self._call("_TEST GH 1")
        # GH 1 has a pest count of 22 (>15 → high). +1 alert.
        # 2026-05-14 has a 'Severe' disease. +1 alert.
        self.assertGreaterEqual(p["alerts"], 2)
```

- [ ] **Step 2: Run, expect failure**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_gh_detail
```

- [ ] **Step 3: Implement greenhouse_detail()**

Create `_gh_detail.py`:
```python
"""Greenhouse drill-down used by GreenhouseModal."""

import frappe

from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
)


def greenhouse_detail(args: dict, force: bool = False) -> dict:
    gh = (args.get("greenhouse") or "").strip()
    filters = {
        "greenhouse": gh,
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
    }
    if not gh:
        return _empty()
    return cached_aggregate(
        "greenhouse_detail", filters, lambda: _build(filters), force=force,
    )


def _empty() -> dict:
    return {"topPests": [], "topDiseases": [], "traps": [], "daily": [],
            "scouts": 0, "alerts": 0}


def _build(filters: dict) -> dict:
    where, params = parent_filter_conditions(
        filters["from_date"], filters["to_date"], filters["crop"],
        [filters["greenhouse"]],
    )

    pests = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, p.pest, p.count
        FROM `tabScouting Entry` se
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}
    """, params, as_dict=True)

    diseases = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, d.disease, d.stage
        FROM `tabScouting Entry` se
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}
    """, params, as_dict=True)

    traps = frappe.db.sql(f"""
        SELECT se.name, se.date_of_capture, t.pest, t.count
        FROM `tabScouting Entry` se
        JOIN `tabTrap Scouting Entry` t ON t.parent = se.name
        WHERE {where}
    """, params, as_dict=True)

    scout_rows = frappe.db.sql(f"""
        SELECT DISTINCT scouts_name FROM `tabScouting Entry` se WHERE {where}
    """, params, as_dict=True)

    pest_map = {}
    disease_map = {}
    trap_map = {}
    daily = {}
    alerts = 0

    for r in pests:
        n = int(r.count or 0)
        pest_map[r.pest] = pest_map.get(r.pest, 0) + (n if n else 1)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["pests"] += 1
        if n > 15:
            alerts += 1

    for r in diseases:
        disease_map[r.disease] = disease_map.get(r.disease, 0) + 1
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["diseases"] += 1

    for r in traps:
        pname = r.pest or "Unknown"
        trap_map[pname] = trap_map.get(pname, 0) + int(r.count or 0)
        d = str(r.date_of_capture)[:10]
        daily.setdefault(d, {"date": d, "pests": 0, "diseases": 0, "traps": 0})["traps"] += 1
        if (int(r.count or 0)) > 10:
            alerts += 1

    from upande_scp.serverscripts.dashboard_aggregates._common import disease_severity
    for r in diseases:
        if disease_severity(r.stage) == "high":
            alerts += 1

    def _top(d, n=6):
        return sorted(
            [{"name": k, "count": v} for k, v in d.items()],
            key=lambda x: x["count"], reverse=True,
        )[:n]

    return {
        "topPests":    _top(pest_map),
        "topDiseases": _top(disease_map),
        "traps":       sorted(
            [{"pest": k, "total": v} for k, v in trap_map.items()],
            key=lambda x: x["total"], reverse=True,
        )[:6],
        "daily": sorted(daily.values(), key=lambda x: x["date"]),
        "scouts": len({(r.scouts_name or "").strip() for r in scout_rows
                       if (r.scouts_name or "").strip()}),
        "alerts": alerts,
    }
```

- [ ] **Step 4: Run, expect pass**

```bash
bench --site kaitet run-tests --app upande_scp --module \
  upande_scp.serverscripts.tests.test_dashboard_aggregates_gh_detail
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py \
        upande_scp/serverscripts/tests/test_dashboard_aggregates_gh_detail.py
git commit -m "feat(dashboard-agg): greenhouse_detail endpoint"
```

---

### Task 14: Whitelist the public endpoints

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/__init__.py`

- [ ] **Step 1: Export and wrap with @frappe.whitelist**

Replace `__init__.py` contents with:
```python
"""Server-side aggregation endpoints for the /scp_app Dashboard.

Each whitelisted entry point delegates to a private module that does the
actual SQL and aggregation work.
"""

import frappe

from upande_scp.serverscripts.dashboard_aggregates._overview        import overview as _overview
from upande_scp.serverscripts.dashboard_aggregates._pests_diseases  import pests    as _pests
from upande_scp.serverscripts.dashboard_aggregates._pests_diseases  import diseases as _diseases
from upande_scp.serverscripts.dashboard_aggregates._traps           import traps    as _traps
from upande_scp.serverscripts.dashboard_aggregates._fcm             import fcm      as _fcm
from upande_scp.serverscripts.dashboard_aggregates._gh_detail       import (
    greenhouse_detail as _gh_detail,
)


def _truthy(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "y")


def _call(impl, **kwargs):
    """Common entry: read force flag, drop it, delegate to the impl."""
    force = _truthy(kwargs.pop("force", "")) if "force" in kwargs else False
    return impl(kwargs, force=force)


@frappe.whitelist()
def overview(**kwargs):
    return _call(_overview, **kwargs)


@frappe.whitelist()
def pests(**kwargs):
    return _call(_pests, **kwargs)


@frappe.whitelist()
def diseases(**kwargs):
    return _call(_diseases, **kwargs)


@frappe.whitelist()
def traps(**kwargs):
    return _call(_traps, **kwargs)


@frappe.whitelist()
def fcm(**kwargs):
    return _call(_fcm, **kwargs)


@frappe.whitelist()
def greenhouse_detail(**kwargs):
    return _call(_gh_detail, **kwargs)
```

- [ ] **Step 2: Smoke-test via bench console**

```bash
bench --site kaitet console <<'PY'
from upande_scp.serverscripts.dashboard_aggregates import overview
r = overview(from_date="2026-04-18", to_date="2026-05-18", crop="", farm="", greenhouse="")
print(list(r.keys()))
PY
```
Expected output includes `['kpis', 'daily', 'rangeTotals', …]`.

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/__init__.py
git commit -m "feat(dashboard-agg): expose whitelisted endpoints"
```

---

## Phase 2 — Frontend

### Task 15: useDashboardAggregate hook

**Files:**
- Create: `frontend/src/hooks/use-dashboard-aggregate.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/frappe";
import { useRealtime } from "@/hooks/use-realtime";

export type Endpoint =
  | "overview"
  | "pests"
  | "diseases"
  | "traps"
  | "fcm"
  | "greenhouse_detail";

export interface AggregateFilters {
  from_date: string;
  to_date: string;
  crop?: string;
  farm?: string;
  greenhouse?: string;
  observation?: string;
  section?: string;
  stage?: string;
}

export interface AggregateState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: (opts?: { force?: boolean }) => void;
}

const METHOD: Record<Endpoint, string> = {
  overview:           "upande_scp.serverscripts.dashboard_aggregates.overview",
  pests:              "upande_scp.serverscripts.dashboard_aggregates.pests",
  diseases:           "upande_scp.serverscripts.dashboard_aggregates.diseases",
  traps:              "upande_scp.serverscripts.dashboard_aggregates.traps",
  fcm:                "upande_scp.serverscripts.dashboard_aggregates.fcm",
  greenhouse_detail:  "upande_scp.serverscripts.dashboard_aggregates.greenhouse_detail",
};

export function useDashboardAggregate<T>(
  endpoint: Endpoint,
  filters: AggregateFilters,
  enabled: boolean,
): AggregateState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);

  // Stringify filters once per render so the effect only fires on value change.
  const key = JSON.stringify({ endpoint, ...filters, enabled });

  const fetchOnce = useCallback(
    async (force: boolean) => {
      if (!enabled) return;
      const token = ++tokenRef.current;
      setLoading(true);
      setError(null);
      try {
        const resp = await call<{ message?: T } | T>(
          METHOD[endpoint],
          { ...filters, ...(force ? { force: 1 } : {}) },
        );
        if (tokenRef.current !== token) return;
        // Frappe wraps whitelisted return in { message: ... }
        const payload = (resp as any)?.message ?? (resp as T);
        setData(payload);
      } catch (e: any) {
        if (tokenRef.current !== token) return;
        setError(e?.message || "Failed to load dashboard data");
      } finally {
        if (tokenRef.current === token) setLoading(false);
      }
    },
    // Recompute the closure only when the serialized filter set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    void fetchOnce(false);
  }, [fetchOnce]);

  // Realtime invalidation: a new scouting write busts the server cache,
  // so we just refetch (server returns the fresh version, cached or not).
  useRealtime<{ months?: string[] }>("scp:scouting:dirty", () => {
    void fetchOnce(false);
  });

  return {
    data,
    loading,
    error,
    reload: (opts) => void fetchOnce(Boolean(opts?.force)),
  };
}
```

- [ ] **Step 2: Type-check**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx tsc -b --noEmit 2>&1 | tail -20
```
Expected: no errors related to this file.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/use-dashboard-aggregate.ts
git commit -m "feat(dashboard-agg): useDashboardAggregate hook"
```

---

### Task 16: Refactor OverviewTab

**Files:**
- Modify: `frontend/src/pages/dashboard/OverviewTab.tsx`
- Create: `frontend/src/pages/dashboard/overview-types.ts`

- [ ] **Step 1: Define the payload type**

Create `overview-types.ts`:
```ts
export interface OverviewKpis {
  totalScouts: number;
  zonesScouted: number;
  greenhouseCount: number;
  highAlerts: number;
}

export interface OverviewDailyRow {
  date: string;
  pests: number;
  diseases: number;
  traps: number;
}

export interface GhHealthRow {
  name: string;
  pests: number;
  diseases: number;
  traps: number;
  scoutCount: number;
  alerts: number;
  status: "good" | "warning" | "critical";
}

export interface TopScout    { scoutId: string; entries: number }
export interface ScoutPerf   { scoutId: string; zones: number; pests: number; diseases: number }
export interface ScoutsDay   { date: string; scouts: number }
export interface RecentRow   {
  name: string; date: string; time: string;
  greenhouse: string; zone: string; scoutId: string;
  kind: "pest" | "disease" | "trap" | "other";
}
export interface ActiveAlert {
  name: string; kind: "pest" | "disease";
  severity: "high" | "moderate";
  count: number; greenhouse: string; zone: string; date: string;
}

export interface OverviewPayload {
  kpis: OverviewKpis;
  daily: OverviewDailyRow[];
  rangeTotals: { pests: number; diseases: number; traps: number };
  ghHealth: GhHealthRow[];
  topScouts: TopScout[];
  scoutsPerDay: ScoutsDay[];
  scoutPerformance: ScoutPerf[];
  recentActivity: RecentRow[];
  activeAlerts: ActiveAlert[];
}
```

- [ ] **Step 2: Rewrite OverviewTab to consume the payload directly**

Replace `OverviewTab.tsx` contents. The render JSX stays nearly identical; the
data sourcing changes from `computeOverviewKpis(data)` etc. to direct payload
reads. Skip the aggregator imports.

New imports + signature:
```ts
import { useState } from "react";
import { /* recharts, charts, cards, Kpi etc. — unchanged */ } from "...";
import { GreenhouseModal } from "./GreenhouseModal";
import type { OverviewPayload } from "./overview-types";
import { weekTickFormatter } from "@/lib/iso-week";
import { EmptyHint } from "./EmptyHint";

const series: ChartConfig = {
  pests:    { label: "Pests",    color: "var(--sd-data-cyan)"   },
  diseases: { label: "Diseases", color: "var(--sd-data-pink)"   },
  traps:    { label: "Traps",    color: "var(--sd-data-purple)" },
};

const STATUS_DOT: Record<string, string> = {
  good:     "bg-[var(--sd-data-green)]",
  warning:  "bg-[var(--sd-target)]",
  critical: "bg-[var(--sd-data-red)]",
};

export function OverviewTab({
  data,
  scoutLookup,
}: {
  data: OverviewPayload | null;
  scoutLookup: Record<string, string>;
}) {
  const [openGh, setOpenGh] = useState<string | null>(null);
  if (!data) return null;

  const k = data.kpis;
  const daily = data.daily;
  const totals = [
    { name: "pests",    value: data.rangeTotals.pests    },
    { name: "diseases", value: data.rangeTotals.diseases },
    { name: "traps",    value: data.rangeTotals.traps    },
  ];
  const totalsMax = Math.max(1, totals.reduce((s, t) => s + t.value, 0));
  const ghs = data.ghHealth;
  const scouts = data.topScouts.map((s) => ({
    ...s,
    displayName: scoutLookup[s.scoutId] || s.scoutId,
  }));
  const recent = data.recentActivity.map((r) => ({
    ...r,
    scout: scoutLookup[r.scoutId] || r.scoutId,
  }));
  const alerts = data.activeAlerts;
  const scoutsDaily = data.scoutsPerDay;
  const perf = data.scoutPerformance.map((p) => ({
    ...p,
    name: scoutLookup[p.scoutId] || p.scoutId,
  }));

  return (
    /* ... existing JSX, with the variables above feeding the charts/cards ... */
  );
}
```

The rest of the JSX (cards, charts, modals) is copied wholesale from the
existing file. Where it referenced `e.scout`, `s.displayName`, `p.name`, etc.,
the new payload-shaped values feed them directly.

- [ ] **Step 3: Update Dashboard.tsx to pass the new payload**

This is Task 21 territory, but stage a minimal compile-fix here so the type
errors don't block. In Dashboard.tsx, temporarily cast the OverviewTab data
prop (`data as any` plus a // TODO comment). The real wiring lands in Task 21.

```ts
<OverviewTab
  data={overviewPayload as any}      // wired in Task 21
  scoutLookup={scoutLookup}
/>
```

- [ ] **Step 4: Type-check**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx tsc -b --noEmit 2>&1 | tail -20
```
Expected: no errors (or only the `data as any` cast in Dashboard.tsx pending).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/dashboard/OverviewTab.tsx \
        frontend/src/pages/dashboard/overview-types.ts \
        frontend/src/pages/Dashboard.tsx
git commit -m "refactor(dashboard): overviewtab consumes server payload"
```

---

### Task 17: Refactor PestsTab + DiseasesTab

**Files:**
- Modify: `frontend/src/pages/dashboard/PestsTab.tsx`
- Modify: `frontend/src/pages/dashboard/DiseasesTab.tsx`
- Create: `frontend/src/pages/dashboard/pests-diseases-types.ts`

- [ ] **Step 1: Payload types**

Create `pests-diseases-types.ts`:
```ts
export interface ItemPercent { name: string; pct: number; zones: number }
export interface RankingRow  { name: string; total: number; high: number;
                                moderate: number; low: number }
export interface DailyPctRow { date: string; value: number }
export interface TrendSeries {
  rows: Array<Record<string, string | number>>;
  keys: string[];
}

export interface PestsPayload {
  filterOptions: { pests: string[]; sections: string[]; stages: string[] };
  ranking: RankingRow[];
  distribution: ItemPercent[];
  sectionSplit: ItemPercent[];
  greenhousePressure: ItemPercent[];
  dailyPercent: DailyPctRow[];
  trendSeries: TrendSeries;
}

export interface DiseasesPayload extends Omit<PestsPayload, "filterOptions"> {
  filterOptions: { diseases: string[]; sections: string[]; stages: string[] };
}
```

- [ ] **Step 2: Rewrite PestsTab**

Replace the body of PestsTab.tsx — drop the `useMemo` aggregator calls; read
directly from the payload. The component-local filter trio
(`observation` / `section` / `stage`) stays in component state but is now
passed UP through the hook (Dashboard.tsx Task 21 wires it). For this task,
accept them as props.

```ts
import { /* recharts, cards, etc. unchanged */ } from "...";
import { useObservationColors } from "@/lib/observation-colors";
import { DashFilterRow } from "./DashFilterRow";
import type { PestsPayload } from "./pests-diseases-types";

export interface PestsTabProps {
  data: PestsPayload | null;
  pestName: string;       // page-level filter (the "observation" filter)
  section: string;
  stage: string;
  onFiltersChange: (next: { observation: string; section: string; stage: string }) => void;
}

export function PestsTab({ data, pestName, section, stage, onFiltersChange }: PestsTabProps) {
  const { pest: pestColor } = useObservationColors();
  if (!data) return null;

  const total = data.ranking.reduce((s, r) => s + r.total, 0);
  const high  = data.ranking.reduce((s, r) => s + r.high,  0);
  const top   = data.ranking[0];

  /* ...JSX uses data.distribution, data.sectionSplit, data.greenhousePressure,
        data.dailyPercent, data.trendSeries, data.ranking directly... */
}
```

- [ ] **Step 3: Mirror for DiseasesTab**

Same pattern, swap pest → disease.

- [ ] **Step 4: Type-check**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx tsc -b --noEmit
```
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/dashboard/PestsTab.tsx \
        frontend/src/pages/dashboard/DiseasesTab.tsx \
        frontend/src/pages/dashboard/pests-diseases-types.ts
git commit -m "refactor(dashboard): pests/diseases tabs consume server payload"
```

---

### Task 18: Refactor TrapsTab

**Files:**
- Modify: `frontend/src/pages/dashboard/TrapsTab.tsx`
- Create: `frontend/src/pages/dashboard/traps-types.ts`

- [ ] **Step 1: Types**

```ts
export interface TrapsPayload {
  ranking: Array<{ key: string; trap: string; pest: string; total: number; avg: number }>;
  pestBreakdown: Array<{ name: string; value: number }>;
  trendSeries: { rows: Array<Record<string, string | number>>; keys: string[] };
}
```

- [ ] **Step 2: Drop the aggregator imports; consume payload**

In TrapsTab.tsx, replace `trapRanking`, `trapPestBreakdown`, `trapTrendSeries`
with the equivalent payload fields:
- `data.ranking`
- `data.pestBreakdown`
- `data.trendSeries`

The JSX is unchanged.

- [ ] **Step 3: Type-check, commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx tsc -b --noEmit
git add frontend/src/pages/dashboard/TrapsTab.tsx \
        frontend/src/pages/dashboard/traps-types.ts
git commit -m "refactor(dashboard): trapstab consumes server payload"
```

---

### Task 19: Refactor FcmTab

**Files:**
- Modify: `frontend/src/pages/dashboard/FcmTab.tsx`
- Create: `frontend/src/pages/dashboard/fcm-types.ts`

- [ ] **Step 1: Types**

```ts
export interface FcmPayload {
  kpis: { trapTotal: number; pestTotal: number; focusZones: number;
          greenhouseCount: number };
  daily: Array<{ date: string; traps: number; scouting: number }>;
  pestBreakdown: Array<{ name: string; value: number }>;
  focusPests: Array<{ name: string; total: number }>;
}
```

- [ ] **Step 2: Drop client-side regex + aggregator**

Replace the FcmTab body. KPIs come from payload; daily series, breakdown, and
focus pest list are direct array reads.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/dashboard/FcmTab.tsx \
        frontend/src/pages/dashboard/fcm-types.ts
git commit -m "refactor(dashboard): fcmtab consumes server payload"
```

---

### Task 20: Update GreenhouseModal to use greenhouse_detail endpoint

**Files:**
- Modify: `frontend/src/pages/dashboard/GreenhouseModal.tsx`

- [ ] **Step 1: Swap aggregate.ts call for the hook**

Replace the `greenhouseDetail(data, greenhouse)` call with
`useDashboardAggregate("greenhouse_detail", { greenhouse, from_date, to_date, crop }, isOpen)`.

The component currently receives `data: ProcessedData | null` and computes
detail on the fly. New signature accepts the active filter values directly:
```ts
interface GreenhouseModalProps {
  greenhouse: string | null;
  fromDate: string;
  toDate: string;
  crop: string;
  onClose: () => void;
}
```

Renders identically; the displayed numbers come from the hook's `data` field.

- [ ] **Step 2: Type-check + commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx tsc -b --noEmit
git add frontend/src/pages/dashboard/GreenhouseModal.tsx
git commit -m "refactor(dashboard): greenhousemodal consumes greenhouse_detail endpoint"
```

---

### Task 21: Rewire Dashboard.tsx

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Replace useScouting with five tab hooks**

The page now drives five `useDashboardAggregate` calls, gating each by the
active tab. The filter bar (crop / farm / greenhouse / from / to) flows down
unchanged into each hook's `filters`.

Active-tab state is lifted into Dashboard.tsx so the hook's `enabled` prop is
correct. The `Tabs` component is switched to controlled mode.

```tsx
import { useEffect, useState } from "react";
import { LayoutGrid, Bug, Hexagon, Crosshair, Sparkles,
         FileText, RefreshCw } from "lucide-react";
import {
  fetchCrops, fetchFarmsAndWarehouses, fetchScoutLookup,
  fetchZonesByGreenhouse, DEFAULT_CROP,
} from "@/lib/scouting-api";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { DatePicker } from "@/components/DatePicker";
import { OverviewTab }  from "./dashboard/OverviewTab";
import { PestsTab }     from "./dashboard/PestsTab";
import { DiseasesTab }  from "./dashboard/DiseasesTab";
import { TrapsTab }     from "./dashboard/TrapsTab";
import { FcmTab }       from "./dashboard/FcmTab";
import { ymd } from "@/lib/utils";
import type { OverviewPayload } from "./dashboard/overview-types";
import type { PestsPayload, DiseasesPayload } from "./dashboard/pests-diseases-types";
import type { TrapsPayload } from "./dashboard/traps-types";
import type { FcmPayload } from "./dashboard/fcm-types";

const ALL_FARMS = "__all__";
const ALL_GH = "__all__";

function defaultRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  return { from: ymd(from), to: ymd(today) };
}

type TabId = "overview" | "pests" | "diseases" | "traps" | "fcm";

export function Dashboard() {
  // -- Filter-bar state (unchanged from current Dashboard.tsx) --
  const [crop, setCrop] = useState<string>(DEFAULT_CROP);
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [greenhouse, setGreenhouse] = useState<string>(ALL_GH);
  const [{ from, to }, setRange] = useState(defaultRange);
  const [crops, setCrops] = useState<Array<{ name: string; crop_name: string;
                                              farms?: string[] }>>([
    { name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }
  ]);
  const [farms, setFarms] = useState<Record<string, string[]>>({});
  const [scoutLookup, setScoutLookup] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchCrops().then((r) => {
      if (!r.length) return;
      const hasDefault = r.some((c) => c.crop_name === DEFAULT_CROP);
      setCrops(hasDefault ? r : [
        { name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }, ...r,
      ]);
    });
    fetchFarmsAndWarehouses().then(setFarms);
    fetchScoutLookup().then(setScoutLookup);
    void fetchZonesByGreenhouse();  // primes the existing cache used by other pages
  }, []);

  const farmList = (() => {
    const cropAllow = crops.find((c) => c.crop_name === crop)?.farms || [];
    const all = Object.keys(farms);
    if (!cropAllow.length) return all;
    const allowSet = new Set(cropAllow);
    return all.filter((f) => allowSet.has(f));
  })();

  const greenhouseList = (() => {
    if (farm === ALL_FARMS)
      return Array.from(new Set(farmList.flatMap((f) => farms[f] || []))).sort();
    return (farms[farm] || []).slice().sort();
  })();

  // -- Tab state --
  const [tab, setTab] = useState<TabId>("overview");

  // -- Pest/Disease tab-local filters --
  const [pestFilters, setPestFilters] = useState({
    observation: "", section: "", stage: "",
  });
  const [diseaseFilters, setDiseaseFilters] = useState({
    observation: "", section: "", stage: "",
  });

  // -- Shared filter base --
  const base = {
    from_date: from,
    to_date: to,
    crop: crop === DEFAULT_CROP ? "" : crop,
    farm: farm === ALL_FARMS ? "" : farm,
    greenhouse: greenhouse === ALL_GH ? "" : greenhouse,
  };

  // -- Five aggregate hooks --
  const overview  = useDashboardAggregate<OverviewPayload>("overview",  base, tab === "overview");
  const pests     = useDashboardAggregate<PestsPayload>(   "pests",     { ...base, ...pestFilters },    tab === "pests");
  const diseases  = useDashboardAggregate<DiseasesPayload>("diseases",  { ...base, ...diseaseFilters }, tab === "diseases");
  const traps     = useDashboardAggregate<TrapsPayload>(   "traps",     base, tab === "traps");
  const fcm       = useDashboardAggregate<FcmPayload>(     "fcm",       base, tab === "fcm");

  const reloadActive = () => {
    const h = ({overview, pests, diseases, traps, fcm} as const)[tab];
    h.reload({ force: true });
  };

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80
                          backdrop-blur px-4 py-3 md:px-6 md:py-4">
        {/* ...filter bar UI: unchanged from current Dashboard.tsx lines 113-230,
              except the Reload button calls reloadActive() ... */}
      </header>

      <div className="flex-1 px-4 py-4 md:px-6 md:py-6">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as TabId)}
          className="flex flex-col gap-4"
        >
          <TabsList className="self-start flex-wrap">
            <TabsTrigger value="overview"><LayoutGrid />Overview</TabsTrigger>
            <TabsTrigger value="pests"><Bug />Pests</TabsTrigger>
            <TabsTrigger value="diseases"><Hexagon />Diseases</TabsTrigger>
            <TabsTrigger value="traps"><Crosshair />Traps</TabsTrigger>
            <TabsTrigger value="fcm"><Sparkles />FCM &amp; Moths</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            {overview.loading && !overview.data ? <KpiSkeleton /> :
              <OverviewTab data={overview.data} scoutLookup={scoutLookup} />}
          </TabsContent>
          <TabsContent value="pests">
            {pests.loading && !pests.data ? <KpiSkeleton /> :
              <PestsTab data={pests.data}
                        pestName={pestFilters.observation}
                        section={pestFilters.section}
                        stage={pestFilters.stage}
                        onFiltersChange={setPestFilters} />}
          </TabsContent>
          <TabsContent value="diseases">
            {diseases.loading && !diseases.data ? <KpiSkeleton /> :
              <DiseasesTab data={diseases.data}
                           diseaseName={diseaseFilters.observation}
                           section={diseaseFilters.section}
                           stage={diseaseFilters.stage}
                           onFiltersChange={setDiseaseFilters} />}
          </TabsContent>
          <TabsContent value="traps">
            {traps.loading && !traps.data ? <KpiSkeleton /> :
              <TrapsTab data={traps.data} />}
          </TabsContent>
          <TabsContent value="fcm">
            {fcm.loading && !fcm.data ? <KpiSkeleton /> :
              <FcmTab data={fcm.data} />}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}
```

(The filter-bar JSX block — Crop/Farm/Greenhouse selects, two DatePicker
inputs, Reload + Reports buttons — is copied wholesale from the current
`Dashboard.tsx:113-230`; only the Reload button's `onClick` changes to
`reloadActive`. The `LoadingOverlay` is gone.)

- [ ] **Step 2: Type-check, build, smoke-test**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
npx tsc -b --noEmit
npm run build 2>&1 | tail -8
```
Expected: no type errors, build succeeds.

- [ ] **Step 3: Restart Frappe and smoke-test in the browser**

```bash
cd /home/ubuntu/stive/code/frappe15 && bench restart
```

Open `https://kaitet.132.145.21.55.nip.io/scp_app` in a browser. Confirm:
- Filter bar still works
- Each tab renders without error
- Filter changes trigger a new HTTP call (visible in DevTools Network tab)
- Reload button forces a refetch (look for `force=1` in the payload)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "refactor(dashboard): drive tabs from server aggregate endpoints"
```

---

## Phase 3 — Cleanup

### Task 22: Trim aggregate.ts

**Files:**
- Modify: `frontend/src/pages/dashboard/aggregate.ts`

- [ ] **Step 1: Identify still-used exports**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend
grep -rE "from .+/aggregate(\.ts)?\"" src/ | sort -u
```

Expected: only `GreenhouseModal.tsx` may still pull a helper. If
Task 20 fully migrated it to the endpoint, this grep should return empty —
delete the file. Otherwise delete the unused functions.

- [ ] **Step 2: Remove unused exports / delete file**

If deletable:
```bash
git rm frontend/src/pages/dashboard/aggregate.ts
```

Otherwise edit out the functions whose names don't appear in the grep above
(everything except those still imported).

- [ ] **Step 3: Type-check, build, commit**

```bash
npx tsc -b --noEmit && npm run build 2>&1 | tail -3
git add frontend/src/pages/dashboard/aggregate.ts || true
git commit -m "chore(dashboard): trim client-side aggregator"
```

---

### Task 23: Performance acceptance test

**Files:**
- Manual test, no code changes.

- [ ] **Step 1: Cold-cache load**

```bash
cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet console <<'PY'
import frappe
# Bust both layers to simulate cold start.
from upande_scp.serverscripts.cache_utils import invalidate_scouting_payload
invalidate_scouting_payload()
PY
```

Open `/scp_app` in a fresh incognito window. Use DevTools → Network →
Timing on the `overview` request to record TTFB and download time.

Acceptance: dashboard's first meaningful paint **< 5 s** wall-clock.

- [ ] **Step 2: Warm filter change**

Without busting the cache, change the Crop selector to a different value.
Acceptance: **< 300 ms** for the overview request to complete and the page
to re-render.

- [ ] **Step 3: Tab switch**

After Overview has loaded once and you've already visited Pests, click
back to Overview. Acceptance: **< 100 ms**, no network call (the hook's
data is still in React state).

- [ ] **Step 4: Realtime push**

In another window create a Scouting Entry on the same site. Within ~5 s
the open Dashboard should refetch and reflect the new totals.

- [ ] **Step 5: If any acceptance fails, file a follow-up note in the spec**

Specifically: if cold-cache fails the 5 s bar, the most likely culprit
is unindexed columns in the UNION-ALL `_observation_rows` query. Confirm
with `EXPLAIN` in `bench mariadb` console and add an index migration if
needed (out of scope to write here, but capture the index name in a
follow-up issue).

---

## Self-Review

After writing the plan, walked it back through the spec:

- **§API Contract → Tasks 6–14.** Every endpoint covered. Filter resolution
  (Task 1), cache (Task 3), force-flag (Task 14).
- **§Caching → Tasks 2–3.** Key shape, version-stamp reuse, TTL, force flag.
- **§Frontend Refactor → Tasks 15–21.** Hook, type files, each tab, modal,
  Dashboard.tsx wiring.
- **§Server Files → Tasks 1–14.** Module structure matches the spec.
- **§Parity Guarantee → Tasks 5, 6, 7, 8, 9, 10, 11, 12, 13.** Every endpoint
  has an integration test with the shared fixture.
- **§Acceptance → Task 23.** All four numeric bars covered.

No `TBD`, `TODO`, or "implement later" markers. All function/type names in
later tasks match what's defined in earlier tasks
(`OverviewPayload`, `PestsPayload`, `DiseasesPayload`, `TrapsPayload`,
`FcmPayload`, `useDashboardAggregate`, `cached_aggregate`, `filter_hash`,
`pest_severity`, `disease_severity`, `parent_filter_conditions`,
`resolve_greenhouse_scope`).

One known sharp edge: the JS-to-Python port for `activeAlerts` ordering is
verified by test, not by line-by-line equivalence. The double-sort in
Task 7's `_active_alerts` is correct because Python's `list.sort` is
stable — primary key sorted last to mirror the JS comparator's tiebreak
semantics.
