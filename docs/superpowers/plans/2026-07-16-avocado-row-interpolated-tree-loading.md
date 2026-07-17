# Avocado Row-Interpolated Tree Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the avocado map's tree payload from ~3.6 MB to tens of KB by sending per-row endpoints (or explicit coords for obstacle rows) and reconstructing interior trees on the client.

**Architecture:** A new cached endpoint `get_orchard_tree_rows` returns, per (block,row), either a LINEAR shape `{k:"l", p, a, b, n}` (uniform rows) or an EXPLICIT shape `{k:"e", c, n, p?/names?}` (obstacle rows / odd names), auto-classified server-side by whether even interpolation reproduces the row within a tolerance. A pure client helper `expandTreeRows` turns rows back into the exact `{names, coords}` (`OrchardTreePoints`) shape the existing `TreesLayer` already consumes — so culling, LOD, and per-scout coloring are untouched.

**Tech Stack:** Python + Frappe (serverscripts, Redis cache via `get_or_set`), `unittest` for backend tests; React + TypeScript, Vitest for frontend tests; Three.js/MapLibre `TreesLayer` (unchanged).

## Global Constraints

- **Commit messages:** NEVER add a `Co-Authored-By: Claude …` trailer (repo rule in CLAUDE.md).
- **Do not modify** `frontend/src/pages/maps/TreesLayer.ts` — culling/LOD/coloring stay as-is.
- **Interpolation tolerance:** a row is LINEAR only if even interpolation reproduces every tree within `POS_TOL_M = 1.5` metres; otherwise EXPLICIT.
- **Row shapes (verbatim):** LINEAR `{ "k":"l", "p":<prefix>, "a":[lng,lat], "b":[lng,lat], "n":<int> }`; EXPLICIT `{ "k":"e", "c":[lng,lat,…], "n":<int>, "p":<prefix> }`, or with `"names":[…]` instead of `"p"` when names don't fit the `<prefix><n>` pattern; `n==1` is always EXPLICIT.
- **Name reconstruction:** LINEAR + EXPLICIT-with-`p` → tree *i* (1-based) name is `p + i`; EXPLICIT-with-`names` → `names[i-1]`. Names must exactly equal the `Orchard Tree` name (they drive per-scout coloring).
- **Backend test command:** from `/home/ubuntu/stive/code/frappe15/apps/upande_scp`: `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows -v`
- **Frontend test command:** from `frontend/`: `yarn vitest run src/lib/orchard-rows.test.ts`
- **Live checks / SPA build:** site is `kaitet.local` on the `frappe15` bench; build with `yarn build` in `frontend/`.

## File Structure

- `upande_scp/serverscripts/get_orchard_trees.py` — **modify**: add `math` import, `POS_TOL_M`, pure helpers (`_strip_trailing_int`, `_interp_max_error_m`, `_row_payload`), coord/build helpers (`_coord_from_geojson`, `_rows_from_trees`, `_rows_for_block`, `_rows_for_farm`), and the whitelisted `get_orchard_tree_rows` endpoint. (Additive — leaves the existing points/geojson endpoints intact.)
- `upande_scp/serverscripts/cache_utils.py` — **modify**: add the `:rows:` cache keys to `invalidate_orchard_trees_for_block` and the farm branch of `invalidate_orchard_trees_for_doc`.
- `upande_scp/serverscripts/tests/test_orchard_tree_rows.py` — **create**: unittest for the pure helpers, the row builder, and the new invalidation keys.
- `frontend/src/lib/orchard-rows.ts` — **create**: `OrchardTreeRow` type + pure `expandTreeRows()`.
- `frontend/src/lib/orchard-rows.test.ts` — **create**: Vitest for `expandTreeRows`.
- `frontend/src/lib/scouting-api.ts` — **modify**: add `fetchOrchardTreeRows()` (fetch rows → `expandTreeRows`).
- `frontend/src/pages/AvocadoMap.tsx` — **modify**: swap `fetchOrchardTreePoints` → `fetchOrchardTreeRows` (import + one call site). Everything downstream unchanged.

---

## Task 1: Backend row classification (pure helpers)

**Files:**
- Modify: `upande_scp/serverscripts/get_orchard_trees.py`
- Test: `upande_scp/serverscripts/tests/test_orchard_tree_rows.py`

**Interfaces:**
- Produces:
  - `POS_TOL_M: float = 1.5`
  - `_strip_trailing_int(name: str, n: int) -> str | None` — name minus trailing `str(n)`, else `None`.
  - `_interp_max_error_m(coords: list[tuple[float,float]]) -> float` — max metres between each point and its even-interpolation along the endpoint line (`len(coords) >= 2`).
  - `_row_payload(names: list[str], coords: list[tuple[float,float]]) -> dict | None` — one row dict (`k:"l"` or `k:"e"`) or `None` when empty.

- [ ] **Step 1: Write the failing test**

Create `upande_scp/serverscripts/tests/test_orchard_tree_rows.py`:

```python
import unittest


class TestRowPayload(unittest.TestCase):
    def _mod(self):
        from upande_scp.serverscripts import get_orchard_trees as g
        return g

    def test_strip_trailing_int(self):
        g = self._mod()
        self.assertEqual(g._strip_trailing_int("BLK_ROW1_T10", 10), "BLK_ROW1_T")
        self.assertIsNone(g._strip_trailing_int("BLK_ROW1_T10", 9))

    def test_even_row_is_linear(self):
        g = self._mod()
        names = [f"R_T{i}" for i in range(1, 6)]
        coords = [(0.0, 0.0), (0.001, 0.0), (0.002, 0.0), (0.003, 0.0), (0.004, 0.0)]
        row = g._row_payload(names, coords)
        self.assertEqual(row["k"], "l")
        self.assertEqual(row["p"], "R_T")
        self.assertEqual(row["a"], [0.0, 0.0])
        self.assertEqual(row["b"], [0.004, 0.0])
        self.assertEqual(row["n"], 5)
        self.assertNotIn("c", row)

    def test_gapped_row_is_explicit(self):
        g = self._mod()
        # 4 trees clustered near the ends with a big empty middle (obstacle).
        names = [f"R_T{i}" for i in range(1, 5)]
        coords = [(0.0, 0.0), (0.0002, 0.0), (0.01, 0.0), (0.0102, 0.0)]
        row = g._row_payload(names, coords)
        self.assertEqual(row["k"], "e")
        self.assertEqual(row["n"], 4)
        self.assertEqual(row["c"], [0.0, 0.0, 0.0002, 0.0, 0.01, 0.0, 0.0102, 0.0])
        self.assertEqual(row["p"], "R_T")

    def test_bad_prefix_row_ships_names(self):
        g = self._mod()
        names = ["ALPHA", "BETA", "GAMMA"]  # not <prefix><n>
        coords = [(0.0, 0.0), (0.001, 0.0), (0.002, 0.0)]
        row = g._row_payload(names, coords)
        self.assertEqual(row["k"], "e")
        self.assertEqual(row["names"], ["ALPHA", "BETA", "GAMMA"])
        self.assertNotIn("p", row)

    def test_single_tree_is_explicit(self):
        g = self._mod()
        row = g._row_payload(["R_T1"], [(1.0, 2.0)])
        self.assertEqual(row["k"], "e")
        self.assertEqual(row["n"], 1)
        self.assertEqual(row["c"], [1.0, 2.0])
        self.assertEqual(row["names"], ["R_T1"])

    def test_empty_is_none(self):
        g = self._mod()
        self.assertIsNone(g._row_payload([], []))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `/home/ubuntu/stive/code/frappe15/apps/upande_scp`):
`/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows -v`
Expected: FAIL — `AttributeError: module ... has no attribute '_strip_trailing_int'`.

- [ ] **Step 3: Write minimal implementation**

In `upande_scp/serverscripts/get_orchard_trees.py`, add `import math` to the imports at the top (next to `import json`), then add near the other helpers:

```python
POS_TOL_M = 1.5  # a row is "linear" if even interpolation reproduces every tree within this many metres


def _strip_trailing_int(name, n):
    """``name`` with the trailing ``str(n)`` removed, or ``None`` if it doesn't end with it."""
    suffix = str(n)
    if name and name.endswith(suffix):
        return name[: len(name) - len(suffix)]
    return None


def _interp_max_error_m(coords):
    """Max distance (metres) between each tree and its even-interpolation along the
    endpoint line. ``coords`` is ``[(lng, lat), …]`` in tree order, ``len >= 2``."""
    a = coords[0]
    b = coords[-1]
    n = len(coords)
    mlng = 111320.0 * math.cos(math.radians(a[1]))
    mlat = 111320.0
    bx = (b[0] - a[0]) * mlng
    by = (b[1] - a[1]) * mlat
    maxerr = 0.0
    for i, p in enumerate(coords):
        f = i / (n - 1)
        ex = bx * f
        ey = by * f
        px = (p[0] - a[0]) * mlng
        py = (p[1] - a[1]) * mlat
        d = math.hypot(px - ex, py - ey)
        if d > maxerr:
            maxerr = d
    return maxerr


def _row_payload(names, coords):
    """Build one row dict from parallel ``names`` + ``coords`` (tree order, 1..N).

    LINEAR (``k="l"``) when the names fit the ``<prefix><n>`` pattern and even
    interpolation reproduces the row within ``POS_TOL_M``; EXPLICIT (``k="e"``)
    otherwise (obstacle rows, odd names, single tree).
    """
    n = len(coords)
    if n == 0:
        return None
    if n == 1:
        return {"k": "e", "c": [coords[0][0], coords[0][1]], "n": 1, "names": [names[0]]}
    prefix = _strip_trailing_int(names[0], 1)
    good_prefix = prefix is not None and names[-1] == f"{prefix}{n}"
    if good_prefix and _interp_max_error_m(coords) <= POS_TOL_M:
        a = coords[0]
        b = coords[-1]
        return {"k": "l", "p": prefix, "a": [a[0], a[1]], "b": [b[0], b[1]], "n": n}
    flat = []
    for c in coords:
        flat.append(c[0])
        flat.append(c[1])
    row = {"k": "e", "c": flat, "n": n}
    if good_prefix:
        row["p"] = prefix
    else:
        row["names"] = list(names)
    return row
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/get_orchard_trees.py upande_scp/serverscripts/tests/test_orchard_tree_rows.py
git commit -m "feat(avocado): row classification helpers for tree loading"
```

---

## Task 2: Backend row builder from tree records

**Files:**
- Modify: `upande_scp/serverscripts/get_orchard_trees.py`
- Test: `upande_scp/serverscripts/tests/test_orchard_tree_rows.py`

**Interfaces:**
- Consumes: `_row_payload` (Task 1).
- Produces:
  - `_coord_from_geojson(raw: str) -> tuple[float,float] | None`
  - `_rows_from_trees(tree_rows) -> {"rows": list[dict]}` — groups rows by `(block, row)`, orders each by integer `tree_number`, builds names+coords, calls `_row_payload`. `tree_rows` items expose `.name`, `.block`, `.row`, `.tree_number`, `.raw_geojson`.

- [ ] **Step 1: Write the failing test**

Append to `upande_scp/serverscripts/tests/test_orchard_tree_rows.py`:

```python
from types import SimpleNamespace


def _tree(name, block, row, num, lng, lat):
    gj = '{"type":"Feature","geometry":{"type":"Point","coordinates":[%r,%r]}}' % (lng, lat)
    return SimpleNamespace(name=name, block=block, row=row, tree_number=num, raw_geojson=gj)


class TestRowsFromTrees(unittest.TestCase):
    def _mod(self):
        from upande_scp.serverscripts import get_orchard_trees as g
        return g

    def test_groups_and_orders_by_tree_number(self):
        g = self._mod()
        # Deliberately out of order and with string tree_numbers "1".."3".
        trees = [
            _tree("B_R1_T3", "B", "R1", "3", 0.002, 0.0),
            _tree("B_R1_T1", "B", "R1", "1", 0.0, 0.0),
            _tree("B_R1_T2", "B", "R1", "2", 0.001, 0.0),
        ]
        out = g._rows_from_trees(trees)
        self.assertEqual(len(out["rows"]), 1)
        row = out["rows"][0]
        self.assertEqual(row["k"], "l")
        self.assertEqual(row["p"], "B_R1_T")
        self.assertEqual(row["n"], 3)
        self.assertEqual(row["a"], [0.0, 0.0])
        self.assertEqual(row["b"], [0.002, 0.0])

    def test_two_rows_two_payloads(self):
        g = self._mod()
        trees = [
            _tree("B_R1_T1", "B", "R1", "1", 0.0, 0.0),
            _tree("B_R1_T2", "B", "R1", "2", 0.001, 0.0),
            _tree("B_R2_T1", "B", "R2", "1", 0.0, 0.01),
            _tree("B_R2_T2", "B", "R2", "2", 0.001, 0.01),
        ]
        out = g._rows_from_trees(trees)
        self.assertEqual(len(out["rows"]), 2)

    def test_skips_unparseable_geojson(self):
        g = self._mod()
        bad = SimpleNamespace(name="B_R1_T1", block="B", row="R1", tree_number="1", raw_geojson="not json")
        out = g._rows_from_trees([bad])
        self.assertEqual(out["rows"], [])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows -v`
Expected: FAIL — `AttributeError: ... has no attribute '_rows_from_trees'`.

- [ ] **Step 3: Write minimal implementation**

In `get_orchard_trees.py`, add:

```python
def _coord_from_geojson(raw):
    try:
        feat = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if isinstance(feat, dict) and feat.get("type") == "FeatureCollection":
        feat = (feat.get("features") or [None])[0]
    if not isinstance(feat, dict):
        return None
    c = (feat.get("geometry") or {}).get("coordinates")
    if isinstance(c, (list, tuple)) and len(c) >= 2:
        return (c[0], c[1])
    return None


def _tree_num(t):
    try:
        return int(t.tree_number)
    except (TypeError, ValueError):
        return 0


def _rows_from_trees(tree_rows):
    from collections import defaultdict

    groups = defaultdict(list)
    for t in tree_rows:
        groups[(t.block, t.row)].append(t)

    out = []
    for key in groups:
        trees = sorted(groups[key], key=_tree_num)
        names = []
        coords = []
        for t in trees:
            c = _coord_from_geojson(t.raw_geojson)
            if c is None:
                continue
            names.append(t.name)
            coords.append(c)
        row = _row_payload(names, coords)
        if row:
            out.append(row)
    return {"rows": out}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows -v`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/get_orchard_trees.py upande_scp/serverscripts/tests/test_orchard_tree_rows.py
git commit -m "feat(avocado): build per-row tree payloads from Orchard Tree records"
```

---

## Task 3: Endpoint + cache invalidation

**Files:**
- Modify: `upande_scp/serverscripts/get_orchard_trees.py`
- Modify: `upande_scp/serverscripts/cache_utils.py:220-252`
- Test: `upande_scp/serverscripts/tests/test_orchard_tree_rows.py`

**Interfaces:**
- Consumes: `_rows_from_trees` (Task 2); `K_ORCHARD_TREES_PREFIX`, `TTL_LONG`, `get_or_set` (already imported in the module).
- Produces: whitelisted `get_orchard_tree_rows(block=None, farm=None) -> {"rows": [...]}`; cache keys `{K_ORCHARD_TREES_PREFIX}:rows:{block}` and `{K_ORCHARD_TREES_PREFIX}:rows:farm:{farm}` invalidated alongside the existing `:` and `:pts:` keys.

- [ ] **Step 1: Write the failing test (invalidation keys)**

Append to `upande_scp/serverscripts/tests/test_orchard_tree_rows.py`:

```python
from unittest.mock import patch


class TestRowsInvalidation(unittest.TestCase):
    def test_block_invalidation_includes_rows_key(self):
        from upande_scp.serverscripts import cache_utils as cu
        with patch.object(cu, "invalidate") as inv:
            cu.invalidate_orchard_trees_for_block("BLK1")
        called = [c.args[0] for c in inv.call_args_list]
        self.assertIn(f"{cu.K_ORCHARD_TREES_PREFIX}:rows:BLK1", called)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows.TestRowsInvalidation -v`
Expected: FAIL — `AssertionError: '...:rows:BLK1' not found in [...]`.

- [ ] **Step 3: Write minimal implementation**

In `cache_utils.py`, update `invalidate_orchard_trees_for_block`:

```python
def invalidate_orchard_trees_for_block(block):
    if not block:
        return
    invalidate(f"{K_ORCHARD_TREES_PREFIX}:{block}")
    invalidate(f"{K_ORCHARD_TREES_PREFIX}:pts:{block}")
    invalidate(f"{K_ORCHARD_TREES_PREFIX}:rows:{block}")
```

and the farm branch of `invalidate_orchard_trees_for_doc`:

```python
        farm = frappe.db.get_value("Warehouse", block, "custom_farm")
        if farm:
            invalidate(f"{K_ORCHARD_TREES_PREFIX}:farm:{farm}")
            invalidate(f"{K_ORCHARD_TREES_PREFIX}:pts:farm:{farm}")
            invalidate(f"{K_ORCHARD_TREES_PREFIX}:rows:farm:{farm}")
```

In `get_orchard_trees.py`, add the DB builders + endpoint (after `_rows_from_trees`):

```python
def _rows_for_block(block):
    trees = frappe.get_all(
        "Orchard Tree",
        filters={"block": block, "geojson": ["is", "set"]},
        fields=["name", "block", "row", "tree_number", "geojson as raw_geojson"],
        limit_page_length=0,
    )
    return _rows_from_trees(trees)


def _rows_for_farm(farm):
    blocks = frappe.get_all(
        "Warehouse",
        filters={
            "custom_farm": farm,
            "warehouse_type": ["in", ["Block", "Greenhouse"]],
            "disabled": 0,
        },
        pluck="name",
    )
    if not blocks:
        return {"rows": []}
    trees = frappe.get_all(
        "Orchard Tree",
        filters={"block": ["in", blocks], "geojson": ["is", "set"]},
        fields=["name", "block", "row", "tree_number", "geojson as raw_geojson"],
        limit_page_length=0,
    )
    return _rows_from_trees(trees)


@frappe.whitelist()
def get_orchard_tree_rows(block=None, farm=None):
    block = block or frappe.form_dict.get("block")
    farm = farm or frappe.form_dict.get("farm")
    if block:
        return get_or_set(
            f"{K_ORCHARD_TREES_PREFIX}:rows:{block}",
            lambda: _rows_for_block(block),
            ttl=TTL_LONG,
        )
    if farm:
        return get_or_set(
            f"{K_ORCHARD_TREES_PREFIX}:rows:farm:{farm}",
            lambda: _rows_for_farm(farm),
            ttl=TTL_LONG,
        )
    return {"rows": []}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows -v`
Expected: PASS (10 tests total).

- [ ] **Step 5: Live integration check on `kaitet.local`**

Write `/tmp/verify_rows.py`:

```python
def run():
    import frappe, json
    from upande_scp.serverscripts.get_orchard_trees import get_orchard_tree_rows
    res = get_orchard_tree_rows(farm="Lokitela")
    rows = res["rows"]
    linear = sum(1 for r in rows if r["k"] == "l")
    explicit = sum(1 for r in rows if r["k"] == "e")
    trees = sum(r["n"] for r in rows)
    size = len(json.dumps(res))
    with open("/tmp/verify_rows.out", "w") as f:
        f.write("rows=%d linear=%d explicit=%d trees=%d bytes=%d\n" % (len(rows), linear, explicit, trees, size))
run()
```

Run:
```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local console < /tmp/verify_rows.py >/dev/null 2>&1; cat /tmp/verify_rows.out
```
Expected (approx): `rows≈1870 linear≈1860 explicit≈10 trees=53699 bytes<250000`. **`trees=53699` must hold exactly** (round-trip completeness); `bytes` should be well under the ~3.6 MB `get_orchard_tree_points` payload.

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/get_orchard_trees.py upande_scp/serverscripts/cache_utils.py upande_scp/serverscripts/tests/test_orchard_tree_rows.py
git commit -m "feat(avocado): get_orchard_tree_rows endpoint + rows cache invalidation"
```

---

## Task 4: Frontend row expansion (pure)

**Files:**
- Create: `frontend/src/lib/orchard-rows.ts`
- Test: `frontend/src/lib/orchard-rows.test.ts`

**Interfaces:**
- Consumes: `OrchardTreePoints` (type-only import from `./scouting-api`).
- Produces:
  - `type OrchardTreeRow` (discriminated union on `k`).
  - `expandTreeRows(rows: OrchardTreeRow[]): OrchardTreePoints`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/orchard-rows.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { expandTreeRows, type OrchardTreeRow } from "./orchard-rows";

describe("expandTreeRows", () => {
  it("interpolates a linear row evenly and rebuilds names", () => {
    const rows: OrchardTreeRow[] = [
      { k: "l", p: "R_T", a: [0, 0], b: [4, 0], n: 5 },
    ];
    const { names, coords } = expandTreeRows(rows);
    expect(names).toEqual(["R_T1", "R_T2", "R_T3", "R_T4", "R_T5"]);
    expect(coords).toEqual([0, 0, 1, 0, 2, 0, 3, 0, 4, 0]);
  });

  it("uses explicit coords verbatim with prefix names", () => {
    const rows: OrchardTreeRow[] = [
      { k: "e", p: "R_T", c: [0, 0, 9, 9], n: 2 },
    ];
    const { names, coords } = expandTreeRows(rows);
    expect(names).toEqual(["R_T1", "R_T2"]);
    expect(coords).toEqual([0, 0, 9, 9]);
  });

  it("uses explicit names when provided", () => {
    const rows: OrchardTreeRow[] = [
      { k: "e", names: ["A", "B"], c: [1, 1, 2, 2], n: 2 },
    ];
    const { names } = expandTreeRows(rows);
    expect(names).toEqual(["A", "B"]);
  });

  it("handles a single-tree linear row", () => {
    const rows: OrchardTreeRow[] = [{ k: "l", p: "R_T", a: [3, 7], b: [3, 7], n: 1 }];
    const { names, coords } = expandTreeRows(rows);
    expect(names).toEqual(["R_T1"]);
    expect(coords).toEqual([3, 7]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `yarn vitest run src/lib/orchard-rows.test.ts`
Expected: FAIL — cannot resolve `./orchard-rows`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/orchard-rows.ts`:

```typescript
import type { OrchardTreePoints } from "./scouting-api";

/**
 * A row of orchard trees as sent by ``get_orchard_tree_rows``.
 *  - ``k:"l"`` LINEAR: interior trees are interpolated between endpoints ``a``/``b``.
 *  - ``k:"e"`` EXPLICIT: ``c`` holds every tree's [lng,lat] verbatim (obstacle rows).
 * Names are ``p + i`` (1-based) unless an explicit ``names`` array is given.
 */
export type OrchardTreeRow =
  | { k: "l"; p: string; a: [number, number]; b: [number, number]; n: number }
  | { k: "e"; c: number[]; n: number; p?: string; names?: string[] };

/** Expand rows into the flat ``{names, coords}`` the TreesLayer consumes. */
export function expandTreeRows(rows: OrchardTreeRow[]): OrchardTreePoints {
  const names: string[] = [];
  const coords: number[] = [];
  for (const row of rows) {
    if (row.k === "l") {
      const { p, a, b, n } = row;
      for (let i = 1; i <= n; i++) {
        const f = n === 1 ? 0 : (i - 1) / (n - 1);
        names.push(p + i);
        coords.push(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      }
    } else {
      const { c, n } = row;
      for (let i = 1; i <= n; i++) {
        names.push(row.names ? row.names[i - 1] : (row.p || "") + i);
        coords.push(c[(i - 1) * 2], c[(i - 1) * 2 + 1]);
      }
    }
  }
  return { names, coords };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run src/lib/orchard-rows.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/orchard-rows.ts frontend/src/lib/orchard-rows.test.ts
git commit -m "feat(avocado): pure expandTreeRows client helper"
```

---

## Task 5: Wire the frontend fetch + AvocadoMap

**Files:**
- Modify: `frontend/src/lib/scouting-api.ts` (near `fetchOrchardTreePoints`)
- Modify: `frontend/src/pages/AvocadoMap.tsx:17-23` (import) and `:159-169` (fetch effect)

**Interfaces:**
- Consumes: `expandTreeRows`, `OrchardTreeRow` (Task 4); existing `call`, `cached`, `OrchardTreePoints`.
- Produces: `fetchOrchardTreeRows(args?: { block?: string; farm?: string }): Promise<OrchardTreePoints>` — fetches rows and returns the expanded points (same shape as `fetchOrchardTreePoints`).

- [ ] **Step 1: Add `fetchOrchardTreeRows` to `scouting-api.ts`**

Add the import near the top of `frontend/src/lib/scouting-api.ts` (with the other local imports):

```typescript
import { expandTreeRows, type OrchardTreeRow } from "./orchard-rows";
```

Add directly after the existing `fetchOrchardTreePoints` function:

```typescript
/** Row-interpolated orchard-tree payload for the 3D map: per-row endpoints
 *  (or explicit coords for obstacle rows), expanded client-side into the same
 *  ``{names, coords}`` shape as ``fetchOrchardTreePoints`` but a fraction of the
 *  bytes. See ``get_orchard_tree_rows`` + ``expandTreeRows``. */
export async function fetchOrchardTreeRows(
  args: { block?: string; farm?: string } = {},
): Promise<OrchardTreePoints> {
  const key = `orchard_rows:${args.block || ""}:${args.farm || ""}`;
  return cached(key, async () => {
    try {
      const r = await call<{ rows: OrchardTreeRow[] }>(
        "upande_scp.serverscripts.get_orchard_trees.get_orchard_tree_rows",
        args,
      );
      return r && Array.isArray(r.rows)
        ? expandTreeRows(r.rows)
        : { names: [], coords: [] };
    } catch {
      return { names: [], coords: [] };
    }
  });
}
```

- [ ] **Step 2: Swap the call in `AvocadoMap.tsx`**

Change the import block (`frontend/src/pages/AvocadoMap.tsx:17-23`) — replace `fetchOrchardTreePoints,` with `fetchOrchardTreeRows,`:

```typescript
import {
  fetchBlocksGeojson,
  fetchOrchardTreeRows,
  fetchTanksValvesGeojson,
  type GeoJsonFC,
  type OrchardTreePoints,
} from "@/lib/scouting-api";
```

Change the fetch effect (`:159-169`) — replace `fetchOrchardTreePoints({ farm })` with `fetchOrchardTreeRows({ farm })`:

```typescript
  useEffect(() => {
    const farm = filters.farm === ALL ? undefined : filters.farm;
    let cancelled = false;
    setTreesPlacing(true);
    fetchOrchardTreeRows({ farm }).then((p) => {
      if (cancelled) return;
      // Nothing to place (e.g. "All farms" returns no trees) → clear the
      // loader immediately; otherwise the chunked build clears it on ready.
      if (!p.names.length) setTreesPlacing(false);
      setTreePoints(p);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.farm]);
```

- [ ] **Step 3: Typecheck + build**

Run (from `frontend/`): `yarn build`
Expected: build succeeds, no TypeScript errors. (`fetchOrchardTreePoints` may now be unused in `AvocadoMap.tsx` — the replacement removes its only use there; it remains exported from `scouting-api.ts`, so no error.)

- [ ] **Step 4: Full unit-test sweep**

Run (from `frontend/`): `yarn vitest run src/lib/orchard-rows.test.ts`
Expected: PASS. Then backend: from `apps/upande_scp` run `/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_orchard_tree_rows -v` → PASS.

- [ ] **Step 5: Manual verification on the live map**

Deploy the built assets and reload:
```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local clear-cache
```
Open the avocado scouts map for **Lokitela** (hard-refresh). Verify:
- Trees appear in place across all blocks; the loader clears once placed.
- Scouted trees are colored per scout (coloring works → names reconstructed correctly).
- `AIRSTRIP BLK 10` rows show the gap (no trees planted across the hill) — no ghost trees.
- Pan/zoom culling + LOD behave as before.
- Network tab: the `get_orchard_tree_rows` response is tens of KB (vs the old ~3.6 MB `get_orchard_tree_points`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/scouting-api.ts frontend/src/pages/AvocadoMap.tsx
git commit -m "feat(avocado): load trees via row-interpolated endpoint"
```

---

## Notes for the implementer

- The existing `get_orchard_tree_points` endpoint and `fetchOrchardTreePoints` are left in place intentionally (rollback safety); a later cleanup can remove them once the rows path is confirmed in production.
- Do not touch `TreesLayer.ts`. If a change there seems necessary, stop — the design guarantees the `{names, coords}` output is identical in shape, so the layer needs nothing.
- `POS_TOL_M` (1.5 m) is the one knob: raising it sends more rows as LINEAR (smaller payload, looser placement); lowering it sends more EXPLICIT (larger, more exact). The measured data leaves a wide margin (linear rows ≤ 0.5 m, obstacle rows ≫ 40 m).
