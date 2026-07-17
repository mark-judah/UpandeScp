# Farm→Store Mapping, Draft-Aware Stock, Store-Keeper Scoping & Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map each farm to one chemical + one fertilizer store; lock ApplicationPlan to the farm's store with draft-aware available stock; scope the Chemical Dashboard to a Store Keeper's assigned farms and show table+bar+pie aggregates per store type.

**Architecture:** The `Farm` record becomes the single source of per-farm config (stores + creator/approver/store-keeper rosters), reusing the existing per-farm child-table pattern in `spray_plan_creator/admin.py`. Reservation = sum of `Work Order Item.required_qty` for Application-Floor-Plan Work Orders that are drafted/submitted-but-not-yet-issued. All scoping is enforced server-side.

**Tech Stack:** Frappe/ERPNext (Python 3.10, `frappe.whitelist` endpoints, DocType JSON + fixtures), React + TypeScript + Vite frontend (shadcn/ui, Recharts), pytest (backend pure logic), vitest (frontend pure logic).

## Global Constraints

- Spray plans are **Work Orders** with `custom_type = "Application Floor Plan"`; child table `required_items` (DocType `Work Order Item`), fields `item_code`, `required_qty` (absolute tank amount), `source_warehouse`.
- Farm↔warehouse join is `Warehouse.custom_farm`. Work Orders have **no** farm field; greenhouse = `Work Order.fg_warehouse` / `custom_greenhouse`.
- "Reserved" states = `docstatus < 2` AND `status != 'Stopped'` AND `COALESCE(workflow_state,'Pending Submission') NOT IN ('Chemical Issued','Tank Mix Manufactured','Spraying In Progress','Completed')`.
- Admin/unscoped roles = `System Manager`, `Administrator`, `General Manager`. Store keeper role string = `Store Keeper`.
- Item groups: chemicals = `CHEMICALS`, fertilizers = `Fertilizer`.
- **Data access:** query only `kaitet.local` via `bench` — never the Kaitet MCP.
- **Commits:** no `Co-Authored-By` trailer. Commit after each task's tests pass (the developer runs commits; do not push).
- Everything must be safe on **unmapped farms** — fall back to current behavior when a farm has no mapped store / no store-keeper roster.

---

### Task 1: `Farm Store Keeper` child doctype + Farm custom fields

**Files:**
- Create: `upande_scp/upande_scp/doctype/farm_store_keeper/__init__.py`
- Create: `upande_scp/upande_scp/doctype/farm_store_keeper/farm_store_keeper.json`
- Create: `upande_scp/upande_scp/doctype/farm_store_keeper/farm_store_keeper.py`
- Modify: `upande_scp/fixtures/custom_field.json` (append 3 Farm custom fields)

**Interfaces:**
- Produces: DocType `Farm Store Keeper` (istable; fields `user` Link→User, `full_name` Data). Farm gains fields `custom_chemical_store` (Link→Warehouse), `custom_fertilizer_store` (Link→Warehouse), `store_keepers` (Table→Farm Store Keeper).

- [ ] **Step 1: Copy the creator child doctype as a template**

Read `upande_scp/upande_scp/doctype/farm_spray_plan_creator/farm_spray_plan_creator.json` and `.py`. Create the new folder mirroring it.

`farm_store_keeper/__init__.py`: empty file.

`farm_store_keeper/farm_store_keeper.py`:
```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class FarmStoreKeeper(Document):
	pass
```

`farm_store_keeper/farm_store_keeper.json`:
```json
{
 "actions": [],
 "allow_rename": 1,
 "creation": "2026-07-07 00:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": ["user", "full_name"],
 "fields": [
  {"fieldname": "user", "fieldtype": "Link", "in_list_view": 1, "label": "User", "options": "User", "reqd": 1},
  {"fieldname": "full_name", "fieldtype": "Data", "in_list_view": 1, "label": "Full Name", "read_only": 1}
 ],
 "index_web_pages_for_search": 1,
 "istable": 1,
 "links": [],
 "modified": "2026-07-07 00:00:00.000000",
 "module": "Upande Scp",
 "name": "Farm Store Keeper",
 "owner": "Administrator",
 "permissions": [],
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": []
}
```

- [ ] **Step 2: Append the three Farm custom fields to the fixture**

In `upande_scp/fixtures/custom_field.json`, find the existing `Farm-spray_plan_creators` object to copy its shape (dt `Farm`, fieldtype `Table`). Append three objects to the top-level array (adjust `insert_after` to an existing Farm field such as `spray_plan_approvers`):

```json
 {
  "dt": "Farm",
  "fieldname": "custom_chemical_store",
  "fieldtype": "Link",
  "label": "Chemical Store",
  "options": "Warehouse",
  "insert_after": "spray_plan_approvers",
  "module": "Upande Scp",
  "name": "Farm-custom_chemical_store"
 },
 {
  "dt": "Farm",
  "fieldname": "custom_fertilizer_store",
  "fieldtype": "Link",
  "label": "Fertilizer Store",
  "options": "Warehouse",
  "insert_after": "custom_chemical_store",
  "module": "Upande Scp",
  "name": "Farm-custom_fertilizer_store"
 },
 {
  "dt": "Farm",
  "fieldname": "store_keepers",
  "fieldtype": "Table",
  "label": "Store Keepers",
  "options": "Farm Store Keeper",
  "insert_after": "custom_fertilizer_store",
  "module": "Upande Scp",
  "name": "Farm-store_keepers"
 },
```

(Match the exact key set — `owner`, `docstatus`, etc. — used by the sibling `Farm-spray_plan_creators` entry so `bench migrate` accepts it.)

- [ ] **Step 3: Migrate and verify the fields exist**

Run: `bench --site kaitet.local migrate`
Then: `bench --site kaitet.local console` and run:
```python
import frappe
meta = frappe.get_meta("Farm")
print([f.fieldname for f in meta.fields if f.fieldname in ("custom_chemical_store","custom_fertilizer_store","store_keepers")])
print(frappe.db.exists("DocType", "Farm Store Keeper"))
```
Expected: `['custom_chemical_store', 'custom_fertilizer_store', 'store_keepers']` and a truthy DocType name.

- [ ] **Step 4: Commit**

```bash
git add upande_scp/upande_scp/doctype/farm_store_keeper upande_scp/fixtures/custom_field.json
git commit -m "feat(farm): add store-keeper child table + chemical/fertilizer store fields"
```

---

### Task 2: Pure reservation aggregator + reserved-state predicate (TDD)

**Files:**
- Create: `upande_scp/serverscripts/spray_plan_creator/reservations.py`
- Create: `upande_scp/serverscripts/tests/test_reservations.py`

**Interfaces:**
- Produces:
  - `RESERVED_EXCLUDED_STATES: set[str]` = `{"Chemical Issued","Tank Mix Manufactured","Spraying In Progress","Completed"}`
  - `is_reserved_state(workflow_state: str | None, status: str | None) -> bool`
  - `aggregate_reservations(rows: list[dict]) -> dict[str, dict[str, float]]` — input rows have `item_code`, `source_warehouse`, `required_qty`; output is `{item_code: {warehouse: qty}}`.

- [ ] **Step 1: Write the failing test**

`test_reservations.py`:
```python
import unittest

from upande_scp.serverscripts.spray_plan_creator.reservations import (
    RESERVED_EXCLUDED_STATES,
    is_reserved_state,
    aggregate_reservations,
)


class TestIsReservedState(unittest.TestCase):
    def test_none_workflow_state_counts_as_draft(self):
        self.assertTrue(is_reserved_state(None, None))

    def test_pending_and_awaiting_and_approved_are_reserved(self):
        for s in ("Pending Submission", "Awaiting Approval", "Approved"):
            self.assertTrue(is_reserved_state(s, None), s)

    def test_issued_and_later_are_not_reserved(self):
        for s in RESERVED_EXCLUDED_STATES:
            self.assertFalse(is_reserved_state(s, None), s)

    def test_stopped_status_is_not_reserved(self):
        self.assertFalse(is_reserved_state("Approved", "Stopped"))


class TestAggregateReservations(unittest.TestCase):
    def test_sums_by_item_and_warehouse(self):
        rows = [
            {"item_code": "A", "source_warehouse": "W1", "required_qty": 2.0},
            {"item_code": "A", "source_warehouse": "W1", "required_qty": 3.0},
            {"item_code": "A", "source_warehouse": "W2", "required_qty": 1.0},
            {"item_code": "B", "source_warehouse": "W1", "required_qty": 5.0},
        ]
        out = aggregate_reservations(rows)
        self.assertAlmostEqual(out["A"]["W1"], 5.0)
        self.assertAlmostEqual(out["A"]["W2"], 1.0)
        self.assertAlmostEqual(out["B"]["W1"], 5.0)

    def test_skips_blank_item_or_warehouse_and_treats_none_qty_as_zero(self):
        rows = [
            {"item_code": "", "source_warehouse": "W1", "required_qty": 9},
            {"item_code": "A", "source_warehouse": None, "required_qty": 9},
            {"item_code": "A", "source_warehouse": "W1", "required_qty": None},
        ]
        out = aggregate_reservations(rows)
        self.assertEqual(out, {"A": {"W1": 0.0}})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && python -m pytest upande_scp/serverscripts/tests/test_reservations.py -v`
Expected: FAIL — `ModuleNotFoundError: ... reservations`.

- [ ] **Step 3: Write the pure logic**

`reservations.py`:
```python
"""Draft-aware reservation math for Application Floor Plan work orders.

Pure helpers (no frappe imports) live at the top so they are unit-testable;
the whitelisted DB endpoint is added in a later task.
"""

RESERVED_EXCLUDED_STATES = {
    "Chemical Issued",
    "Tank Mix Manufactured",
    "Spraying In Progress",
    "Completed",
}


def is_reserved_state(workflow_state, status):
    """True when a work order still reserves source stock (drafted/submitted,
    not yet material-issued, not stopped)."""
    if status == "Stopped":
        return False
    state = workflow_state or "Pending Submission"
    return state not in RESERVED_EXCLUDED_STATES


def aggregate_reservations(rows):
    """rows: dicts with item_code, source_warehouse, required_qty.
    Returns {item_code: {warehouse: summed_qty}}. Blank item/warehouse skipped;
    missing qty treated as 0."""
    out = {}
    for r in rows:
        item = r.get("item_code")
        wh = r.get("source_warehouse")
        if not item or not wh:
            continue
        qty = float(r.get("required_qty") or 0)
        out.setdefault(item, {})
        out[item][wh] = out[item].get(wh, 0.0) + qty
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && python -m pytest upande_scp/serverscripts/tests/test_reservations.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/reservations.py upande_scp/serverscripts/tests/test_reservations.py
git commit -m "feat(reservations): pure reserved-state predicate and aggregator"
```

---

### Task 3: `get_store_reservations` whitelisted endpoint

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/reservations.py` (append the endpoint)

**Interfaces:**
- Consumes: `is_reserved_state`, `aggregate_reservations` (Task 2). Reserved-state SQL from Global Constraints.
- Produces: `get_store_reservations(warehouse: str, item_codes: str | list) -> dict[str, float]` — whitelisted; returns `{item_code: reserved_qty}` for that one warehouse. `item_codes` accepts a JSON string or list.

- [ ] **Step 1: Append the endpoint**

Add to `reservations.py`:
```python
import json

import frappe


@frappe.whitelist()
def get_store_reservations(warehouse, item_codes=None):
    """Reserved qty per item at one source warehouse, from AFP work orders that
    are drafted/submitted but not yet material-issued."""
    if isinstance(item_codes, str):
        item_codes = json.loads(item_codes) if item_codes.strip().startswith("[") else [item_codes]
    item_codes = [c for c in (item_codes or []) if c]
    if not warehouse or not item_codes:
        return {}

    rows = frappe.db.sql(
        """
        SELECT woi.item_code, woi.source_warehouse, woi.required_qty
        FROM `tabWork Order Item` woi
        JOIN `tabWork Order` wo ON wo.name = woi.parent
        WHERE wo.custom_type = 'Application Floor Plan'
          AND wo.docstatus < 2
          AND (wo.status IS NULL OR wo.status != 'Stopped')
          AND COALESCE(wo.workflow_state, 'Pending Submission') NOT IN
              ('Chemical Issued','Tank Mix Manufactured','Spraying In Progress','Completed')
          AND woi.source_warehouse = %(warehouse)s
          AND woi.item_code IN %(items)s
        """,
        {"warehouse": warehouse, "items": tuple(item_codes)},
        as_dict=True,
    )
    agg = aggregate_reservations(rows)
    return {item: agg.get(item, {}).get(warehouse, 0.0) for item in item_codes}
```

- [ ] **Step 2: Verify against real data**

Run: `bench --site kaitet.local console`:
```python
import frappe
frappe.set_user("Administrator")
from upande_scp.serverscripts.spray_plan_creator.reservations import get_store_reservations
# pick a real chemical store + item that appears on a pending plan:
wh = frappe.db.sql("""SELECT DISTINCT source_warehouse FROM `tabWork Order Item`
  WHERE source_warehouse IS NOT NULL LIMIT 1""")[0][0]
items = [r[0] for r in frappe.db.sql("""SELECT DISTINCT item_code FROM `tabWork Order Item`
  WHERE source_warehouse=%s LIMIT 3""", wh)]
print(wh, items, get_store_reservations(wh, items))
```
Expected: a dict mapping each item to a non-negative float; spot-check one against a manual sum of `required_qty` for pending plans at that warehouse.

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/reservations.py
git commit -m "feat(reservations): get_store_reservations endpoint"
```

---

### Task 4: Admin endpoints — store-keeper roster, farm stores, candidates

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/admin.py`

**Interfaces:**
- Consumes: existing `_require_admin()`, `_candidates_for_role(role, q)`, `_set_farm_roster(farm, users, role, child_field)`, `list_farms_with_creators()`.
- Produces (all whitelisted):
  - `set_farm_store_keepers(farm, users)` → rebuilds `store_keepers` child table (role-validated `Store Keeper`).
  - `set_farm_stores(farm, chemical_store, fertilizer_store)` → sets the two Link fields.
  - `list_store_keeper_candidates(q=None)` → users holding `Store Keeper`.
  - `list_store_warehouse_candidates(q=None)` → `[{name, custom_farm}]` selectable source stores.
  - `list_farms_with_creators()` extended to also return `store_keepers`, `chemical_store`, `fertilizer_store` per farm.

- [ ] **Step 1: Add roster + store setters and candidate lists**

Read `admin.py` first to match `_set_farm_roster`'s exact signature. Append:
```python
@frappe.whitelist()
def list_store_keeper_candidates(q=None):
    return _candidates_for_role("Store Keeper", q)


@frappe.whitelist()
def set_farm_store_keepers(farm, users):
    return _set_farm_roster(farm, users, "Store Keeper", "store_keepers")


@frappe.whitelist()
def list_store_warehouse_candidates(q=None):
    _require_admin()
    filters = {
        "is_group": 0,
        "disabled": 0,
        "warehouse_type": ("not in", ["Greenhouse", "Work In Progress"]),
    }
    if q:
        filters["name"] = ("like", f"%{q}%")
    return frappe.get_all(
        "Warehouse", filters=filters, fields=["name", "custom_farm"],
        order_by="custom_farm, name", limit_page_length=200,
    )


@frappe.whitelist()
def set_farm_stores(farm, chemical_store=None, fertilizer_store=None):
    _require_admin()
    doc = frappe.get_doc("Farm", farm)
    doc.custom_chemical_store = chemical_store or None
    doc.custom_fertilizer_store = fertilizer_store or None
    doc.save(ignore_permissions=True)
    return {"farm": farm, "chemical_store": doc.custom_chemical_store,
            "fertilizer_store": doc.custom_fertilizer_store}
```
(If `users` may arrive as a JSON string, mirror however existing `set_farm_creators` parses it — reuse that same coercion.)

- [ ] **Step 2: Extend `list_farms_with_creators`**

In `list_farms_with_creators`, where each farm dict is built, also read the roster + stores. Add per farm:
```python
        store_keepers = frappe.get_all(
            "Farm Store Keeper",
            filters={"parent": farm_name, "parenttype": "Farm"},
            fields=["user", "full_name"],
        )
        farm_stores = frappe.db.get_value(
            "Farm", farm_name,
            ["custom_chemical_store", "custom_fertilizer_store"], as_dict=True
        ) or {}
        row["store_keepers"] = store_keepers
        row["chemical_store"] = farm_stores.get("custom_chemical_store")
        row["fertilizer_store"] = farm_stores.get("custom_fertilizer_store")
```
(Match the actual variable names for the per-farm dict and farm name used in the existing loop.)

- [ ] **Step 3: Verify via console**

Run: `bench --site kaitet.local console`:
```python
import frappe
frappe.set_user("Administrator")
from upande_scp.serverscripts.spray_plan_creator import admin
print(admin.list_store_warehouse_candidates()[:3])
print(admin.list_store_keeper_candidates()[:3])
farm = frappe.get_all("Farm", pluck="name")[0]
stores = admin.list_store_warehouse_candidates()
admin.set_farm_stores(farm, stores[0]["name"], stores[0]["name"])
print([f for f in admin.list_farms_with_creators() if f["farm"] == farm][0])
```
Expected: candidate lists print; the farm row now includes `store_keepers`, `chemical_store`, `fertilizer_store` with the value just set.

- [ ] **Step 4: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/admin.py
git commit -m "feat(admin): farm store-keeper roster, farm-store mapping, candidate lists"
```

---

### Task 5: Bootstrap exposes `farm_stores`

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/bootstrap.py`

**Interfaces:**
- Produces: `fetch_creator_bootstrap` return dict gains `farm_stores: {farm: {"chemical_store": str|None, "fertilizer_store": str|None}}`.

- [ ] **Step 1: Build and attach the map**

In `fetch_creator_bootstrap`, before the final return, add:
```python
    farm_store_rows = frappe.get_all(
        "Farm",
        fields=["name", "custom_chemical_store", "custom_fertilizer_store"],
    )
    farm_stores = {
        r["name"]: {
            "chemical_store": r.get("custom_chemical_store"),
            "fertilizer_store": r.get("custom_fertilizer_store"),
        }
        for r in farm_store_rows
    }
```
and include `"farm_stores": farm_stores` in the returned dict.

- [ ] **Step 2: Verify**

Run: `bench --site kaitet.local console`:
```python
import frappe
frappe.set_user("Administrator")
from upande_scp.serverscripts.spray_plan_creator.bootstrap import fetch_creator_bootstrap
print(fetch_creator_bootstrap().get("farm_stores"))
```
Expected: a dict keyed by farm with `chemical_store`/`fertilizer_store` values (the farm set in Task 4 shows its store).

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/bootstrap.py
git commit -m "feat(bootstrap): expose per-farm store mapping"
```

---

### Task 6: `get_bom_details` restricts warehouses to the farm's stores

**Files:**
- Modify: `upande_scp/serverscripts/scouting_metrics_api.py` (`get_bom_details`)

**Interfaces:**
- Consumes: farm mapping on `Farm.custom_chemical_store` / `custom_fertilizer_store`; `Warehouse.custom_farm`.
- Produces: `get_bom_details(..., greenhouse=None)` — when the greenhouse's farm has mapped stores, `chemical_warehouses` = `[chemical_store]`, `fertilizer_warehouses` = `[fertilizer_store]`, and each chemical's `balances` is trimmed to those warehouses. Unmapped farm / no greenhouse → unchanged behavior.

- [ ] **Step 1: Add an optional `greenhouse` arg and resolve the farm's stores**

Read `get_bom_details` to find where `chemical_warehouses`/`fertilizer_warehouses` and per-chemical `balances` are assembled. Add near the top:
```python
    restrict_chem = restrict_fert = None
    if greenhouse:
        farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm")
        if farm:
            stores = frappe.db.get_value(
                "Farm", farm,
                ["custom_chemical_store", "custom_fertilizer_store"], as_dict=True
            ) or {}
            restrict_chem = stores.get("custom_chemical_store")
            restrict_fert = stores.get("custom_fertilizer_store")
```
Then, where the warehouse lists are finalized:
```python
    if restrict_chem:
        chemical_warehouses = [restrict_chem]
    if restrict_fert:
        fertilizer_warehouses = [restrict_fert]
```
And where each chemical's `balances` dict is built, trim it to the allowed warehouses for its group (only when a restriction applies):
```python
        allowed = ([restrict_fert] if is_fertilizer else [restrict_chem])
        if allowed[0]:
            balances = {w: q for w, q in balances.items() if w in allowed}
```
(Adapt to the actual variable names; keep the fallback path — when `restrict_*` is falsy, do not filter.)

- [ ] **Step 2: Verify both paths**

Run: `bench --site kaitet.local console`:
```python
import frappe
frappe.set_user("Administrator")
from upande_scp.serverscripts.scouting_metrics_api import get_bom_details
gh = frappe.db.get_value("Warehouse", {"warehouse_type": "Greenhouse", "custom_farm": ("is","set")}, "name")
# ensure that gh's farm has a chemical store mapped (set one via admin.set_farm_stores if needed)
d = get_bom_details(<a real bom arg>, greenhouse=gh)
print(d["chemical_warehouses"], d["fertilizer_warehouses"])
```
Expected: with a mapped farm, both lists contain exactly the mapped store(s); calling without `greenhouse` returns the full lists as before.

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/scouting_metrics_api.py
git commit -m "feat(bom): restrict source warehouses to the greenhouse farm's mapped stores"
```

---

### Task 7: Store-keeper scoping + bucketed dashboard aggregates

**Files:**
- Modify: `upande_scp/serverscripts/store_keeper_api.py`
- Create: `upande_scp/serverscripts/tests/test_store_overview_buckets.py`

**Interfaces:**
- Consumes: existing `_check_perm()`, `_WRITE_ROLES`, `_CHEMICAL_GROUPS`, `chemical_stock_overview`, `chemical_store_levels`.
- Produces:
  - `_allowed_farms_for(user) -> list[str] | None` — `None` for admin/GM (see-all); else farms where user is in `store_keepers`.
  - `bucket_overview(items, warehouses, matrix, chem_group_items) -> dict` — pure; splits into `{"chemical": {...}, "fertilizer": {...}}`, each `{stores:[{warehouse,total_qty,item_count}], items:[{item_code,total_qty}], matrix:[...], total_qty}`.
  - `chemical_stock_overview` / `chemical_store_levels` scoped to allowed farms and returning the bucketed shape.

- [ ] **Step 1: Write the failing pure-bucketing test**

`test_store_overview_buckets.py`:
```python
import unittest
from upande_scp.serverscripts.store_keeper_api import bucket_overview


class TestBucketOverview(unittest.TestCase):
    def test_splits_and_totals_by_group(self):
        items = [
            {"item_code": "C1", "total_qty": 10},
            {"item_code": "F1", "total_qty": 4},
        ]
        warehouses = [{"warehouse": "W", "total_qty": 14, "item_count": 2}]
        matrix = [
            {"item_code": "C1", "warehouse": "W", "qty": 10},
            {"item_code": "F1", "warehouse": "W", "qty": 4},
        ]
        chem_items = {"C1"}  # everything else is fertilizer
        out = bucket_overview(items, warehouses, matrix, chem_items)
        self.assertAlmostEqual(out["chemical"]["total_qty"], 10)
        self.assertAlmostEqual(out["fertilizer"]["total_qty"], 4)
        self.assertEqual([i["item_code"] for i in out["chemical"]["items"]], ["C1"])
        self.assertEqual([i["item_code"] for i in out["fertilizer"]["items"]], ["F1"])
        self.assertEqual(out["chemical"]["stores"][0]["total_qty"], 10)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && python -m pytest upande_scp/serverscripts/tests/test_store_overview_buckets.py -v`
Expected: FAIL — `cannot import name 'bucket_overview'`.

- [ ] **Step 3: Implement `bucket_overview` (pure) and the scoping helper**

Add to `store_keeper_api.py`:
```python
def bucket_overview(items, warehouses, matrix, chem_group_items):
    """Split overview rows into chemical vs fertilizer buckets with per-store,
    per-item and grand totals. chem_group_items = set of item_codes in CHEMICALS."""
    def _bucket(is_chem):
        pick = [m for m in matrix if (m["item_code"] in chem_group_items) == is_chem]
        by_item, by_wh = {}, {}
        for m in pick:
            by_item[m["item_code"]] = by_item.get(m["item_code"], 0.0) + float(m["qty"] or 0)
            w = by_wh.setdefault(m["warehouse"], {"warehouse": m["warehouse"], "total_qty": 0.0, "item_count": 0})
            w["total_qty"] += float(m["qty"] or 0)
            w["item_count"] += 1
        return {
            "stores": sorted(by_wh.values(), key=lambda x: -x["total_qty"]),
            "items": sorted(({"item_code": k, "total_qty": v} for k, v in by_item.items()), key=lambda x: -x["total_qty"]),
            "matrix": pick,
            "total_qty": sum(by_item.values()),
        }
    return {"chemical": _bucket(True), "fertilizer": _bucket(False)}


def _allowed_farms_for(user=None):
    """None => user sees all stores (admin/GM). Else the list of farms where the
    user is an assigned store keeper."""
    user = user or frappe.session.user
    roles = set(frappe.get_roles(user))
    if roles & {"System Manager", "Administrator", "General Manager"}:
        return None
    return frappe.get_all(
        "Farm Store Keeper",
        filters={"user": user, "parenttype": "Farm"},
        pluck="parent",
    )
```

- [ ] **Step 4: Run to verify the pure test passes**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && python -m pytest upande_scp/serverscripts/tests/test_store_overview_buckets.py -v`
Expected: PASS.

- [ ] **Step 5: Apply farm scoping + bucketed return to the endpoints**

In `chemical_stock_overview` (after `_check_perm()`): compute `allowed = _allowed_farms_for()`. When `allowed is not None`, constrain the warehouse set to those with `custom_farm IN allowed` (empty list ⇒ no stores). Concretely, resolve allowed warehouses once:
```python
    allowed = _allowed_farms_for()
    allowed_whs = None
    if allowed is not None:
        allowed_whs = frappe.get_all(
            "Warehouse", filters={"custom_farm": ("in", allowed or [""])}, pluck="name"
        )
```
Add `AND warehouse IN %(allowed_whs)s` to the Bin SQL (and the CSU query) only when `allowed_whs is not None`; if `allowed_whs == []`, short-circuit to empty results. Then compute the chemical item-group set and return the bucketed payload alongside the existing keys:
```python
    chem_items = set(frappe.get_all("Item", filters={"item_group": "CHEMICALS"}, pluck="name"))
    buckets = bucket_overview(items, warehouses, matrix, chem_items)
    return {**existing_payload, "buckets": buckets, "allowed_farms": allowed}
```
Apply the same `allowed_whs` constraint to `chemical_store_levels`.

- [ ] **Step 6: Verify scoping against real data**

Run: `bench --site kaitet.local console`:
```python
import frappe
from upande_scp.serverscripts import store_keeper_api
frappe.set_user("Administrator")
allw = store_keeper_api.chemical_stock_overview()
print("admin stores:", len(allw["warehouses"]), "buckets:", allw["buckets"]["chemical"]["total_qty"], allw["buckets"]["fertilizer"]["total_qty"])
# now a plain store keeper with an assigned farm:
sk = frappe.get_all("Farm Store Keeper", pluck="user", limit=1)
if sk:
    frappe.set_user(sk[0])
    scoped = store_keeper_api.chemical_stock_overview()
    print("scoped stores:", [w["warehouse"] for w in scoped["warehouses"]])
```
Expected: admin sees all stores; the store keeper sees only warehouses whose `custom_farm` is in their assigned farms; both return `buckets.chemical`/`buckets.fertilizer` totals.

- [ ] **Step 7: Commit**

```bash
git add upande_scp/serverscripts/store_keeper_api.py upande_scp/serverscripts/tests/test_store_overview_buckets.py
git commit -m "feat(store-keeper): scope stock overview to assigned farms + chemical/fertilizer buckets"
```

---

### Task 8: Frontend — admin API + Access tab (store-keeper column + store selects)

**Files:**
- Modify: `frontend/src/lib/spray-plan-admin-api.ts`
- Modify: `frontend/src/components/spray-plan-access/CreatorChipPicker.tsx`
- Modify: `frontend/src/components/settings/AccessTab.tsx`

**Interfaces:**
- Consumes: Task 4 endpoints; the extended `list_farms_with_creators` fields (`store_keepers`, `chemical_store`, `fertilizer_store`).
- Produces: `setFarmStoreKeepers`, `setFarmStores`, `listStoreKeeperCandidates`, `listStoreWarehouseCandidates` in the admin api; `CreatorChipPicker` accepts `kind="storekeeper"`; AccessTab renders 5 per-farm columns.

- [ ] **Step 1: Add admin api wrappers**

In `spray-plan-admin-api.ts` (PREFIX `upande_scp.serverscripts.spray_plan_creator.admin`), mirror the existing `setFarmCreators`/`listCreatorCandidates` wrappers:
```ts
export const listStoreKeeperCandidates = (q?: string) =>
  call<Candidate[]>(`${PREFIX}.list_store_keeper_candidates`, { q });
export const listStoreWarehouseCandidates = (q?: string) =>
  call<{ name: string; custom_farm: string | null }[]>(`${PREFIX}.list_store_warehouse_candidates`, { q });
export const setFarmStoreKeepers = (farm: string, users: string[]) =>
  call(`${PREFIX}.set_farm_store_keepers`, { farm, users: JSON.stringify(users) });
export const setFarmStores = (farm: string, chemical_store: string | null, fertilizer_store: string | null) =>
  call(`${PREFIX}.set_farm_stores`, { farm, chemical_store, fertilizer_store });
```
Extend the `FarmWithCreators` type to include `store_keepers: {user:string; full_name:string}[]`, `chemical_store: string|null`, `fertilizer_store: string|null` (match the actual type name in the file).

- [ ] **Step 2: Add `storekeeper` to CreatorChipPicker**

In `CreatorChipPicker.tsx`, extend the `kind` union with `"storekeeper"` and route its candidate/save calls to `listStoreKeeperCandidates` / the parent-provided `onSave` (follow exactly how `creator`/`approver` map to their candidate fetchers and labels). Add the display label `"Store Keeper"`.

- [ ] **Step 3: Render the new columns in AccessTab**

In `AccessTab.tsx`, add a third `CreatorChipPicker` column (`kind="storekeeper"`, value `row.store_keepers`, `onSave={(users)=>setFarmStoreKeepers(row.farm, users)}`) next to Creators/Approvers, and two `<Select>` columns for Chemical Store / Fertilizer Store populated from `listStoreWarehouseCandidates()` (fetch once on mount into state), with `onValueChange` accumulating into per-row draft state and saved via `setFarmStores(row.farm, chem, fert)`. Reuse the existing per-row dirty/Save + "Save all" wiring so all five columns save consistently. Add table headers "Store Keepers", "Chemical Store", "Fertilizer Store".

- [ ] **Step 4: Typecheck / build**

Run: `cd frontend && npm run build`
Expected: `tsc -b` passes with no type errors; vite build succeeds.

- [ ] **Step 5: Drive the UI**

Use the `run` skill (or `bench --site kaitet.local serve` + open the SPA) → Settings → Access tab. Assign a store keeper and both stores to a farm, click Save, reload, confirm the values persist. Cross-check in console: `frappe.get_doc("Farm", "<farm>").store_keepers` and `custom_chemical_store`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/spray-plan-admin-api.ts frontend/src/components/spray-plan-access/CreatorChipPicker.tsx frontend/src/components/settings/AccessTab.tsx
git commit -m "feat(settings): store-keeper roster + farm-store mapping in Access tab"
```

---

### Task 9: Frontend — ApplicationPlan store lock + draft-aware availability (TDD on the math)

**Files:**
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/lib/stock-availability.ts`
- Create: `frontend/src/lib/stock-availability.test.ts`
- Modify: `frontend/src/lib/spray-plan-creator-api.ts` (bootstrap type `farm_stores`)
- Modify: `frontend/src/lib/scouting-api.ts` (`getBomDetails` passes `greenhouse`; reservations fetch)
- Modify: `frontend/src/pages/ApplicationPlan.tsx`

**Interfaces:**
- Consumes: `farm_stores` from bootstrap (Task 5); `get_bom_details(greenhouse=...)` (Task 6); `get_store_reservations` (Task 3).
- Produces: `availableStock({ onHand, reservedFromServer, draftFormUsage })` pure helper; ApplicationPlan locked to the mapped store with reservation-adjusted availability.

- [ ] **Step 1: Add a minimal vitest config**

`frontend/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```
Add to `frontend/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing availability test**

`frontend/src/lib/stock-availability.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { availableStock } from "./stock-availability";

describe("availableStock", () => {
  it("subtracts server reservations and current-form usage from on-hand", () => {
    expect(availableStock({ onHand: 60, reservedFromServer: 55, draftFormUsage: 0 })).toBe(5);
    expect(availableStock({ onHand: 60, reservedFromServer: 50, draftFormUsage: 3 })).toBe(7);
  });
  it("never returns negative", () => {
    expect(availableStock({ onHand: 5, reservedFromServer: 10, draftFormUsage: 0 })).toBe(0);
  });
  it("treats missing numbers as zero", () => {
    expect(availableStock({ onHand: 5 } as any)).toBe(5);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd frontend && npm run test`
Expected: FAIL — cannot find `./stock-availability`.

- [ ] **Step 4: Implement the pure helper**

`frontend/src/lib/stock-availability.ts`:
```ts
export function availableStock(opts: {
  onHand?: number;
  reservedFromServer?: number;
  draftFormUsage?: number;
}): number {
  const onHand = Number(opts.onHand || 0);
  const reserved = Number(opts.reservedFromServer || 0);
  const draft = Number(opts.draftFormUsage || 0);
  return Math.max(0, onHand - reserved - draft);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend && npm run test`
Expected: PASS.

- [ ] **Step 6: Wire bootstrap + BOM types**

In `spray-plan-creator-api.ts`, add to `CreatorBootstrap`: `farm_stores: Record<string, { chemical_store: string | null; fertilizer_store: string | null }>`. In `scouting-api.ts`, make `getBomDetails` accept and forward a `greenhouse` argument to the endpoint; add a `getStoreReservations(warehouse, itemCodes)` → `upande_scp.serverscripts.spray_plan_creator.reservations.get_store_reservations` returning `Record<string, number>`.

- [ ] **Step 7: Lock the store in ApplicationPlan**

In `ApplicationPlan.tsx`:
- Derive `mappedStores = bootstrap.farm_stores[greenhouseFarm]` (using the existing `greenhouseFarm` memo).
- Call `getBomDetails(..., greenhouse)` so the returned warehouse lists are already restricted.
- When `mappedStores?.chemical_store` (resp. fertilizer) exists: force each row's `source` to that store, and replace the per-row source `<Select>` (lines ~2018-2044) with a static read-only label of the mapped store. Keep the current `<Select>` only when the farm is unmapped (`!mappedStores?.chemical_store`).

- [ ] **Step 8: Make availability draft-aware**

- After BOM load / store resolution, call `getStoreReservations(store, itemCodes)` for the mapped chemical store (and fertilizer store) and hold the result in state `reserved: Record<item, qty>`.
- Compute per-row `draftFormUsage` = sum of `stock_qty` of *other* rows in the current form sharing the same `item_code` + `source`.
- Replace the raw availability used in `stockShortRows` (lines ~805-822) and the submit re-check (lines ~962-969) with `availableStock({ onHand: balances[source], reservedFromServer: reserved[item] ?? 0, draftFormUsage })`.
- Show the adjusted available next to on-hand in the stock cell so the planner sees "5 available (60 on hand, 55 reserved)".
- Refresh `reserved` after a draft is added (listen to the existing `spray-plan:draft-added` event) so successive plans in a session see the shrinking number.

- [ ] **Step 9: Typecheck / build**

Run: `cd frontend && npm run build`
Expected: passes.

- [ ] **Step 10: Drive the over-plan scenario**

Via the running SPA: pick a greenhouse on a mapped farm → confirm the source store is fixed (no dropdown) and shows only that store's stock. Plan quantities beyond the reservation-adjusted available → the existing short-stock guard must trip and disable submit. Add a draft, start a second plan for the same store/item → the available figure must be lower. Confirm an unmapped farm still shows the old dropdown.

- [ ] **Step 11: Commit**

```bash
git add frontend/vitest.config.ts frontend/package.json frontend/src/lib/stock-availability.ts frontend/src/lib/stock-availability.test.ts frontend/src/lib/spray-plan-creator-api.ts frontend/src/lib/scouting-api.ts frontend/src/pages/ApplicationPlan.tsx
git commit -m "feat(application-plan): lock store to farm mapping + draft-aware available stock"
```

---

### Task 10: Frontend — ChemicalDashboard table + bar + pie per store type

**Files:**
- Modify: `frontend/src/lib/store-keeper-api.ts` (type for `buckets`)
- Modify: `frontend/src/pages/ChemicalDashboard.tsx`

**Interfaces:**
- Consumes: `buckets` from `chemical_stock_overview` (Task 7): `{ chemical, fertilizer }`, each `{ stores:[{warehouse,total_qty,item_count}], items:[{item_code,total_qty}], matrix:[...], total_qty }`.
- Produces: dashboard shows, for chemical stores and fertilizer stores separately, an aggregate total KPI + table + bar chart + pie chart.

- [ ] **Step 1: Extend the overview type**

In `store-keeper-api.ts`, add to `ChemicalOverview`:
```ts
  buckets: {
    chemical: StoreBucket;
    fertilizer: StoreBucket;
  };
  allowed_farms: string[] | null;
```
with `type StoreBucket = { stores: {warehouse:string; total_qty:number; item_count:number}[]; items: {item_code:string; total_qty:number}[]; matrix: {item_code:string; warehouse:string; qty:number}[]; total_qty:number };`

- [ ] **Step 2: Render two bucket sections**

In `ChemicalDashboard.tsx`, add a small `<StoreBucketPanel title bucket />` (local component) that renders: a total-qty KPI (`bucket.total_qty` across allowed farms), a **table** (`bucket.stores` rows: store · total qty · item count), a **bar chart** (Recharts `BarChart` over `bucket.stores`, x=warehouse, y=total_qty — reuse the palette already imported in `ChemicalStoreComparison.tsx`), and a **pie chart** (`PieChart` over `bucket.stores` share of `total_qty`). Render `<StoreBucketPanel title="Chemical Stores" bucket={data.buckets.chemical} />` and `<StoreBucketPanel title="Fertilizer Stores" bucket={data.buckets.fertilizer} />`. Keep the existing per-warehouse selector/table if still useful, or fold it into the panels.

- [ ] **Step 3: Typecheck / build**

Run: `cd frontend && npm run build`
Expected: passes.

- [ ] **Step 4: Drive as admin and as store keeper**

Admin: dashboard shows both bucket panels with table+bar+pie and non-zero totals. Store keeper (with one assigned farm): only that farm's stores appear in both panels; totals match a manual bench sum for those warehouses. A store keeper with no assigned farm sees empty/zeroed panels (not everyone's stock).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/store-keeper-api.ts frontend/src/pages/ChemicalDashboard.tsx
git commit -m "feat(chemical-dashboard): per-store-type table, bar and pie aggregates for allowed farms"
```

---

## Self-Review

**Spec coverage:**
- Farm→store mapping (spec §1,§2) → Tasks 1, 4, 8. ✅
- ApplicationPlan store lock (spec §3) → Tasks 5, 6, 9. ✅
- Draft-aware stock / reservations (spec §4) → Tasks 2, 3, 9. ✅
- Store-keeper scoping + Access column (spec §5, §2) → Tasks 7, 8. ✅
- Dashboard table+bar+pie per bucket (spec §5, extra requirement) → Tasks 7, 10. ✅

**Placeholder scan:** No TBD/TODO; each code step carries real code. DB-integration steps use concrete bench verification scripts rather than hand-wavy "test it".

**Type consistency:** `farm_stores` shape identical in Task 5 (backend) / Task 9 (`CreatorBootstrap`). Reservation dict `{item_code: qty}` consistent Task 3 ↔ Task 9. `buckets`/`StoreBucket` shape identical Task 7 ↔ Task 10. Child field `store_keepers`, Link fields `custom_chemical_store`/`custom_fertilizer_store` consistent across Tasks 1, 4, 5, 6, 7.

**Note on adaptation:** Backend edits into existing functions (`list_farms_with_creators`, `get_bom_details`, `chemical_stock_overview`) must match the real local variable names — each such step says to read the function first. This is deliberate, not a placeholder.
