# Dashboard Aggregate Speedup (A1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the cold full-dashboard load from a measured 17.2 s to under 3 s, and the `heatmaps_grid` payload from 13.65 MB to under 5 MB, without changing a single number or pixel the dashboards display.

**Architecture:** Every dashboard endpoint funnels its date/crop/greenhouse filter through one function, `parent_filter_conditions()` in `_common.py`, and every one of the 12 parent→child join sites is written `FROM tabScouting Entry se JOIN tab<Child> c ON c.parent = se.name`. That shared shape is why one fix repairs all of them: we make the filter predicate index-usable (single column chosen by `warehouse_type` instead of `greenhouse OR block`), force the optimizer to drive from the parent, and add the covering child index the join needs. Then `heatmaps_grid` gets a payload split — the grid keeps the one date it renders, the other two move to an on-demand endpoint.

**Tech Stack:** Frappe 15 (Python 3.14), MariaDB, React 19 + TypeScript frontend. The Frappe test runner is unusable on this bench (see Global Constraints), so all verification runs through `bench --site kaitet.local execute <dotted.path>`.

## Global Constraints

- **The display must not change.** Same numbers, same colours, same cards, same filters. Every task that touches aggregation logic must prove output equivalence against a captured baseline before it is considered done.
- **No schema changes to doctypes.** Indexes only, added via a patch. No new columns, no new doctypes in this plan.
- **Measured baseline (kaitet.local, 291 542 Scouting Entries, `from_date=2026-07-01`, `to_date=2026-07-13`, `crop=Rose`):** `overview` 5 328 ms · `heatmaps_grid` 4 944 ms / 13 981 KB · `trends` 2 908 ms · `pests` 2 384 ms · `diseases` 832 ms · `greenhouse_detail` 824 ms · `traps` 21 ms · **total cold 17 241 ms**.
- **`traps` is the control.** It is the one endpoint that does not join a child table and it costs 21 ms. Any endpoint still >10× that after this work has an unfixed problem.
- **There is no usable Frappe test runner on this bench — do not try to use one.** Verified: (a) `Warehouse-custom_farm` became `reqd=1` on 2026-07-16, after `test_dashboard_aggregates_fixture.py` was written, so `insert_fixture()` raises; (b) any `FrappeTestCase` module crashes during category prep because Frappe's legacy shim imports ERPNext's `test_warehouse.py`, which needs a `Department: All Departments` master that kaitet.local does not have (it has only `All Departments - KR`). Both defects are pre-existing and out of scope.
  **Equivalence is verified instead by a read-only snapshot harness run through `bench execute`** (see Task 1). It calls the real endpoints against kaitet's real 291 542 entries over a fixed historical window and byte-compares canonicalised output. It writes nothing.
  ```bash
  bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify    # REQUIRED after every change
  bench --site kaitet.local run-tests ...                                                # FORBIDDEN — broken, and touches live data
  ```
  The window is pinned to 2026-07-01..2026-07-13 — dates in the past, so mobile syncs cannot shift the corpus under us. A backup was taken before execution began.
- **Commit ONLY the paths each task's commit step names.** The working tree has ~10 modified files from unrelated in-progress work. **Never use `git add -A`, `git add .`, or `git commit -a`** — doing so sweeps someone else's work into your commit. Stage the listed paths explicitly and leave everything else dirty.
- **No browser is installed on this host.** Task 6 Step 6 (visual check) cannot be performed by an implementer; it is handed to the human partner as a manual step. Do not block on it, and do not claim it was done.
- **Do not add a `Co-Authored-By` trailer to commits** (project rule, `CLAUDE.md`).
- Design rationale lives in `docs/Optimization/dataload-architecture.md` §6.2 (indexes), §12.3 (warehouse_type rule). Read it before Task 3.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `upande_scp/serverscripts/tests/bench_dashboard_aggregates.py` | Permanent timing + payload-size harness, runnable against a real dataset | **Create** |
| `upande_scp/serverscripts/tests/equivalence.py` | Read-only golden-output snapshot + verify harness (the safety net for every later task) | **Create** |
| `upande_scp/patches/v1_0/add_scouting_child_indexes.py` | Composite child-table indexes; idempotent, separately named so it actually runs | **Create** |
| `upande_scp/patches.txt` | Register the new patch | Modify |
| `upande_scp/serverscripts/dashboard_aggregates/_common.py` | `parent_filter_conditions()` — the single filter choke point; add scope partitioning | Modify |
| `upande_scp/serverscripts/dashboard_aggregates/_heatmaps.py` | Payload split: grid keeps `recent[0]`, rest on demand | Modify |
| `upande_scp/serverscripts/dashboard_aggregates/__init__.py` | Whitelist the new `heatmap_card_detail` endpoint | Modify |
| `frontend/src/pages/Heatmaps.tsx` | Fetch card detail when a card is opened | Modify |
| `frontend/src/hooks/use-dashboard-aggregate.ts` | Add the `heatmap_card_detail` endpoint name | Modify |

---

### Task 1: Benchmark + equivalence harness

Nothing else in this plan is safe without this. Task 1 captures what the endpoints return *today*; Tasks 3–6 must reproduce it exactly.

**Files:**
- Create: `upande_scp/serverscripts/tests/bench_dashboard_aggregates.py`
- Create: `upande_scp/serverscripts/tests/equivalence.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `bench_dashboard_aggregates.run(from_date=None, to_date=None, crop="Rose")` → prints a table, returns `dict[str, dict]` keyed by endpoint with `{"ms": float, "kb": float}`.
  - `bench_dashboard_aggregates.CASES` → `list[tuple[str, dict]]`, the canonical (endpoint_name, kwargs) list.
  - `equivalence.canonical(obj)` → `str`, stable JSON used for byte-comparison.
  - `equivalence.snapshot()` → writes `snapshots/<case>.json`, prints what it wrote.
  - `equivalence.verify()` → recomputes, diffs against snapshots, prints PASS/FAIL per case; raises `SystemExit(1)` if any case differs.

- [ ] **Step 1: Write the benchmark harness**

Create `upande_scp/serverscripts/tests/bench_dashboard_aggregates.py`:

```python
"""Timing + payload-size harness for the dashboard aggregate endpoints.

Read-only. Safe to run against a live dataset:

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.bench_dashboard_aggregates.run

Each endpoint is measured cold (force=1, bypasses Redis) and warm.
"""

import json
import time

from upande_scp.serverscripts import dashboard_aggregates as DA

DEFAULT_FROM = "2026-07-01"
DEFAULT_TO = "2026-07-13"
DEFAULT_GREENHOUSE = "Torongo GH 16 - KR"

CASES = [
    ("overview", {}),
    ("pests", {}),
    ("diseases", {}),
    ("trends", {}),
    ("heatmaps_grid", {}),
    ("traps", {}),
    ("greenhouse_detail", {"greenhouse": DEFAULT_GREENHOUSE}),
    ("application_plan_diagnose", {"greenhouse": DEFAULT_GREENHOUSE}),
]


def _args(extra, from_date, to_date, crop):
    base = {"from_date": from_date, "to_date": to_date, "crop": crop}
    base.update(extra)
    return base


def run(from_date=None, to_date=None, crop="Rose"):
    from_date = from_date or DEFAULT_FROM
    to_date = to_date or DEFAULT_TO

    results = {}
    print(f"{'endpoint':28s} {'cold':>9s} {'warm':>9s} {'payload':>11s}")
    print("-" * 60)
    total = 0.0
    for name, extra in CASES:
        fn = getattr(DA, name)
        args = _args(extra, from_date, to_date, crop)
        t = time.time()
        out = fn(**args, force=1)
        cold = time.time() - t
        t = time.time()
        fn(**args)
        warm = time.time() - t
        kb = len(json.dumps(out, default=str)) / 1024
        total += cold
        results[name] = {"ms": cold * 1000, "warm_ms": warm * 1000, "kb": kb}
        print(f"{name:28s} {cold * 1000:8.0f}ms {warm * 1000:8.0f}ms {kb:10.1f}KB")
    print("-" * 60)
    print(f"{'TOTAL COLD':28s} {total * 1000:8.0f}ms")
    results["_total"] = {"ms": total * 1000}
    return results
```

- [ ] **Step 2: Run it to capture the pre-change baseline**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.bench_dashboard_aggregates.run \
  > /tmp/baseline-before.txt 2>&1
cat /tmp/baseline-before.txt
```

Expected: a table whose `TOTAL COLD` is in the region of 17 000 ms. Keep `/tmp/baseline-before.txt` — Task 7 diffs against it.

- [ ] **Step 3: Write the equivalence harness**

Create `upande_scp/serverscripts/tests/equivalence.py`:

```python
"""Read-only golden-output harness for the dashboard aggregate endpoints.

The A1 optimisation must not change any endpoint's output. This snapshots
what each endpoint returns TODAY and byte-compares after each change.

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.equivalence.snapshot   # capture (once, before changes)
    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.equivalence.verify     # check (after every change)

Deliberately NOT a FrappeTestCase: the runner is broken on this bench, and
the real 291k-entry dataset is a better equivalence corpus than a 12-row
fixture anyway — it exercises null crops, block-based crops and all 97
greenhouses. Nothing here writes to the database.

The window is historical and therefore stable; do not change it without
re-snapshotting.
"""

import json
import pathlib

from upande_scp.serverscripts import dashboard_aggregates as DA

SNAP_DIR = pathlib.Path(__file__).parent / "snapshots"

WINDOW = {"from_date": "2026-07-01", "to_date": "2026-07-13"}
GH = "Torongo GH 16 - KR"     # warehouse_type Greenhouse
BLOCK = "MIMA BLK 1 - KL"     # warehouse_type Block

# Cases chosen to cover both location columns and the no-crop path.
CASES = [
    ("overview",                  dict(crop="Rose")),
    ("pests",                     dict(crop="Rose")),
    ("diseases",                  dict(crop="Rose")),
    ("trends",                    dict(crop="Rose")),
    ("heatmaps_grid",             dict(crop="Rose")),
    ("traps",                     dict(crop="Rose")),
    ("fcm",                       dict(crop="Rose")),
    ("greenhouse_detail",         dict(crop="Rose", greenhouse=GH)),
    ("application_plan_diagnose", dict(crop="Rose", greenhouse=GH)),
    ("overview_all_crops",        dict()),
    # Block-path coverage. Avocado entries set `block` and leave `zone` NULL,
    # so heatmaps_grid legitimately returns {"cards": []} for them — useless as
    # a regression detector. These four DO return real data and are what guards
    # Task 3's rewrite of the greenhouse/block predicate.
    ("overview_avocado",          dict(crop="Avocado")),
    ("pests_avocado",             dict(crop="Avocado")),
    ("trends_avocado",            dict(crop="Avocado")),
    ("gh_detail_block",           dict(crop="Avocado", greenhouse=BLOCK)),
]

# Cases whose name differs from the endpoint they call.
_ALIAS = {
    "overview_all_crops": "overview",
    "overview_avocado": "overview",
    "pests_avocado": "pests",
    "trends_avocado": "trends",
    "gh_detail_block": "greenhouse_detail",
}


def canonical(obj) -> str:
    """Stable JSON: sorted keys, fixed float precision, sets ordered."""

    def norm(o):
        if isinstance(o, float):
            return round(o, 6)
        if isinstance(o, dict):
            return {k: norm(v) for k, v in sorted(o.items())}
        if isinstance(o, (list, tuple)):
            return [norm(v) for v in o]
        if isinstance(o, set):
            return sorted(norm(v) for v in o)
        return o

    return json.dumps(norm(obj), sort_keys=True, indent=1, default=str)


def _run(case_name, extra):
    endpoint = _ALIAS.get(case_name, case_name)
    args = dict(WINDOW)
    args.update(extra)
    return getattr(DA, endpoint)(**args, force=1)


def snapshot():
    """Capture current output for every case. Overwrites existing snapshots."""
    SNAP_DIR.mkdir(exist_ok=True)
    for case_name, extra in CASES:
        text = canonical(_run(case_name, extra))
        (SNAP_DIR / f"{case_name}.json").write_text(text, encoding="utf-8")
        print(f"snapshot {case_name:28s} {len(text) / 1024:9.1f} KB")
    print(f"\nwrote {len(CASES)} snapshots to {SNAP_DIR}")


def verify():
    """Compare current output against the snapshots. Non-zero exit on drift."""
    missing, failed, passed = [], [], []
    for case_name, extra in CASES:
        snap = SNAP_DIR / f"{case_name}.json"
        if not snap.exists():
            missing.append(case_name)
            continue
        got = canonical(_run(case_name, extra))
        if got == snap.read_text(encoding="utf-8"):
            passed.append(case_name)
            print(f"PASS  {case_name}")
        else:
            failed.append(case_name)
            print(f"FAIL  {case_name}  (output changed)")

    print(f"\n{len(passed)} passed, {len(failed)} failed, {len(missing)} missing")
    if missing:
        print(f"missing snapshots: {missing} — run snapshot() first")
    if failed:
        print(f"CHANGED: {failed}")
        print("The display must not change. Investigate before proceeding.")
        raise SystemExit(1)
```

- [ ] **Step 4: Capture the snapshots, then prove they are stable**

Run snapshot once, then verify twice — the second verify is the real test:

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.snapshot
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify
```

Expected: 13 snapshots written, then `13 passed, 0 failed, 0 missing` twice.

A FAIL on an unchanged codebase means the endpoint is **non-deterministic** — an unstable sort, or a `set` serialised in iteration order. That is a real bug and you must fix it now, in the endpoint or in `canonical()`, before finishing. Every later task would otherwise see false failures. Report exactly what you found and how you fixed it.

If a case raises, do not delete it silently: report which one, the traceback, and whether it is a genuine endpoint bug or a bad argument on your side.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
# Snapshots are LOCAL artifacts — 22 MB, reproducible only against kaitet's
# dataset. They are git-ignored, not committed.
echo "upande_scp/serverscripts/tests/snapshots/" >> .gitignore
git add .gitignore \
        upande_scp/serverscripts/tests/bench_dashboard_aggregates.py \
        upande_scp/serverscripts/tests/equivalence.py
git commit -m "test(scp): read-only golden-output + benchmark harness for dashboard aggregates

Snapshots what each aggregate endpoint returns against kaitet's real
dataset so the A1 query work can be proven display-neutral. Uses
bench execute rather than run-tests: the Frappe runner is broken on this
bench (fixture predates a mandatory Warehouse field; the legacy test
shim imports an ERPNext test needing a Department master kaitet lacks).

Baseline: 17.0 s cold for a full dashboard load."
```

**Note:** delete the abandoned `upande_scp/serverscripts/tests/test_dashboard_equivalence.py` if it exists in your working tree — it depends on the broken runner and must not be committed.

---

### Task 2: Child-table composite indexes

The child tables carry only `PRIMARY(name)` and `parent`. With nothing else available the optimizer prefers to scan the child table whole and probe the parent by primary key — which is exactly the inverted plan we are fixing. The composite index makes the join covering so it never leaves the index.

**Files:**
- Create: `upande_scp/patches/v1_0/add_scouting_child_indexes.py`
- Modify: `upande_scp/patches.txt`

**Interfaces:**
- Consumes: nothing.
- Produces: indexes `pests_parent_cover`, `diseases_parent_cover`, `traps_parent_cover` on their respective child tables.

- [ ] **Step 1: Write the patch**

Create `upande_scp/patches/v1_0/add_scouting_child_indexes.py`:

```python
"""Composite covering indexes on the scouting child tables.

Every dashboard aggregate joins `tabScouting Entry` to a child table on
`c.parent = se.name` and then reads the observation columns. With only the
single-column `parent` index available, MariaDB must visit the clustered
index for every matched child row — and often decides to scan the child
table whole instead, inverting the join (see EXPLAIN in
docs/Optimization/dataload-architecture.md §2.2).

Leading with `parent` is essential: the filter is on `parent`, so an index
led by `pest` would be unusable here.

Idempotent — INFORMATION_SCHEMA is checked before each CREATE INDEX. This
is a NEW patch name rather than an edit to `add_scouting_indexes` because
Frappe records patches in `tabPatchLog` and never re-runs one; appending to
the old patch would be dead code.
"""

import frappe

_INDEXES = (
    ("tabPests Scouting Entry", "pests_parent_cover",
     ("parent", "pest", "plant_section", "stage", "count")),
    ("tabDiseases Scouting Entry", "diseases_parent_cover",
     ("parent", "disease", "plant_section", "stage")),
    ("tabTrap Scouting Entry", "traps_parent_cover",
     ("parent", "trap", "pest", "count")),
)


def _index_exists(table: str, name: str) -> bool:
    return bool(frappe.db.sql(
        """
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = %s AND INDEX_NAME = %s
        LIMIT 1
        """,
        (table, name),
    ))


def execute():
    for table, index_name, columns in _INDEXES:
        if not frappe.db.sql(
            "SELECT 1 FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s",
            (table,),
        ):
            continue
        if _index_exists(table, index_name):
            continue
        cols = ", ".join(f"`{c}`" for c in columns)
        frappe.db.sql(f"CREATE INDEX `{index_name}` ON `{table}` ({cols})")
        frappe.logger().info(
            f"add_scouting_child_indexes: created {index_name} on {table}"
        )
    frappe.db.commit()
```

- [ ] **Step 2: Register the patch**

Append to `upande_scp/patches.txt`, at the end of the post-model-sync section:

```
upande_scp.patches.v1_0.add_scouting_child_indexes
```

- [ ] **Step 3: Verify the indexes are absent, then apply**

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local mariadb -e "
SELECT table_name, index_name FROM information_schema.statistics
WHERE table_schema=DATABASE() AND index_name LIKE '%_parent_cover'
GROUP BY 1,2;"
```
Expected before: empty.

```bash
bench --site kaitet.local execute \
  upande_scp.patches.v1_0.add_scouting_child_indexes.execute
```

Re-run the same SELECT. Expected after: three rows — `pests_parent_cover`, `diseases_parent_cover`, `traps_parent_cover`.

- [ ] **Step 4: Confirm the patch is genuinely idempotent**

Run the same `bench execute` a second time. Expected: completes silently, still exactly three rows, no duplicate-key error.

- [ ] **Step 5: Measure the effect of indexes alone**

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.bench_dashboard_aggregates.run \
  > /tmp/after-task2.txt 2>&1
diff /tmp/baseline-before.txt /tmp/after-task2.txt
```

Record the numbers. The index alone may not flip the join order — that is Task 4's job — so a modest improvement here is expected and fine. Do not skip Task 4 if this looks disappointing.

- [ ] **Step 6: Commit**

```bash
git add upande_scp/patches/v1_0/add_scouting_child_indexes.py upande_scp/patches.txt
git commit -m "perf(scp): covering indexes on scouting child tables

(parent, obs, plant_section, stage[, count]) so aggregate joins never
leave the index. New patch name: Frappe never re-runs a recorded patch,
so appending to add_scouting_indexes would not have applied."
```

---

### Task 2b: Make aggregate output deterministic

**Discovered during Task 2, and it blocks everything after it.** Adding the child indexes changed MariaDB's scan order, and 9 of 14 equivalence cases changed output — not because the index is wrong, but because the endpoints pick *arbitrarily among tied rows*.

Root cause, `_overview.py:263-283`:

```python
out.sort(key=lambda a: a["date"], reverse=True)
out.sort(key=lambda a: a["severity"] != "high")
return out[:n]                    # n = 8
```

Two stable sorts with no tie-break, then truncation, over rows from a query with no `ORDER BY`. Which 8 alerts survive is decided by physical row order. A scan of all ten modules found **36 order-dependent sorts/slices**: `_overview` 10, `_pests_diseases` 7, `_gh_detail` 4, `_fcm`/`_common`/`_heatmaps`/`_traps` 3 each, `_application_plan`/`_trends`/`_heatmap_poc` 1 each.

This is a **live production bug**, not merely a test artifact: MariaDB may change plans on its own as tables grow, silently changing which alerts a supervisor sees. Tasks 3-6 all change the plan deliberately, so this must be fixed first or every later equivalence result is noise.

**Ruling (human partner, recorded):** determinism wins over byte-identical display. Some top-N lists may show a different — equally valid — selection among ties. That is accepted.

**Files:**
- Modify: all ten modules under `upande_scp/serverscripts/dashboard_aggregates/`
- Modify: `upande_scp/serverscripts/tests/equivalence.py` (only if a new case is needed)

**Interfaces:**
- Consumes: `equivalence.verify()` / `equivalence.snapshot()` from Task 1.
- Produces: no signature changes. Same payload shape; defined ordering.

- [ ] **Step 1: Enumerate every order-dependent site**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/dashboard_aggregates
grep -nE "\.sort\(|sorted\(|\[:[0-9]+\]|\[:n\]|most_common" _*.py
```

Record the list. You will confirm completeness empirically in Step 4 — the grep is your starting map, not your proof.

- [ ] **Step 2: Give every sort and truncation a total order**

The rule: **any sort whose result is truncated, or whose order reaches the payload, must have a tie-break that makes the ordering total.** Append a unique-enough field (name, zone, obs name, date) as the final key so no two elements can compare equal.

Apply to `_overview.py:263-283`:

```python
    # Total order: severity, then date, then name — the trailing keys are the
    # tie-break. Without them the [:n] truncation below picks arbitrarily among
    # tied alerts, so which alerts a supervisor sees depends on the query plan.
    out.sort(key=lambda a: (
        a.get("severity") != "high",
        _neg_date(a.get("date")),
        a.get("greenhouse") or "",
        a.get("obsName") or "",
    ))
    return out[:n]
```

with, near the top of the module:

```python
def _neg_date(d) -> str:
    """Descending-date sort key for use inside an ascending tuple sort.
    ISO dates sort lexicographically, so invert each character's ordinal."""
    return "".join(chr(255 - ord(c)) for c in str(d or ""))
```

Then apply the same treatment at every other site from Step 1. Where a SQL query feeds a truncated list, also add an explicit `ORDER BY` matching the Python sort, so the database and Python agree.

**Do not change which fields are computed, any arithmetic, any counts, or any grouping.** Ordering and tie-breaks only.

- [ ] **Step 3: Re-baseline**

The old snapshots are stale (they encode arbitrary order, and were overwritten during Task 2's investigation). Regenerate:

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.snapshot
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify
```
Expected: 14 written, then `14 passed, 0 failed, 0 missing`.

- [ ] **Step 4: The real acceptance test — prove determinism by changing the plan**

This is what proves you found all 36, and it is the only proof that counts. Changing the indexes changes the scan order; deterministic code must produce **byte-identical** output regardless.

```bash
cd /home/ubuntu/stive/code/frappe15
# with indexes (already present) — snapshots were taken in this state
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify

# drop them, forcing a different plan
bench --site kaitet.local mariadb -e "
  DROP INDEX pests_parent_cover    ON \`tabPests Scouting Entry\`;
  DROP INDEX diseases_parent_cover ON \`tabDiseases Scouting Entry\`;
  DROP INDEX traps_parent_cover    ON \`tabTrap Scouting Entry\`;"
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify

# restore them
bench --site kaitet.local execute \
  upande_scp.patches.v1_0.add_scouting_child_indexes.execute
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify
```

**All three verify runs must report `14 passed, 0 failed, 0 missing`.** A FAIL on the middle run means an order-dependent site remains — find it (the failing case name tells you which endpoint), fix it, re-snapshot, and repeat the whole cycle until all three pass.

This simultaneously proves two things: the code is deterministic, and the Task 2 indexes are display-neutral.

- [ ] **Step 5: Commit (both the determinism fix and the Task 2 index patch)**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/dashboard_aggregates/ \
        upande_scp/patches/v1_0/add_scouting_child_indexes.py \
        upande_scp/patches.txt
git commit -m "fix(scp): give every aggregate sort a total order

36 sorts/truncations across the dashboard endpoints picked arbitrarily
among tied rows, so which items survived a top-N slice depended on the
physical scan order. Adding the child-table covering indexes changed that
order and moved 9 of 14 equivalence cases — the indexes were correct; the
ordering was undefined.

This is a latent production bug: MariaDB can change plans on its own as
tables grow, silently changing which alerts a supervisor sees.

Verified deterministic by running the equivalence harness with the indexes
present, dropped, and restored — byte-identical all three times, which also
proves the indexes are display-neutral.

Ships the child-table indexes alongside, since the two are only provable
together."
```

---

### Task 3: Index-usable greenhouse predicate

`parent_filter_conditions()` currently emits `(se.greenhouse IN (…) OR se.block IN (…))`. That disjunction defeats the planner's selectivity estimate, so neither `scouting_date_gh_idx` nor `scouting_date_block_idx` is used. Verified on kaitet: the two columns are mutually exclusive (0 rows have both, 0 have neither), and the discriminator is the location's `warehouse_type`, not the crop — 2 775 entries have `crop_scouted = NULL` and use `greenhouse`.

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py:323-350`
- Create: `upande_scp/serverscripts/tests/check_scope.py`

**Interfaces:**
- Consumes: `scouting_metrics.get_units_by_warehouse()` → `{warehouse: {"type": "greenhouse"|"block", …}}` (already cached under `K_SM_UNITS_BY_WH`, 24 h TTL).
- Produces: `_common.partition_scope(names) -> tuple[list, list]` returning `(greenhouse_names, block_names)`. `parent_filter_conditions()` keeps its existing signature and return type `(sql: str, params: dict)`.

- [ ] **Step 1: Write the failing test**

Create `upande_scp/serverscripts/tests/check_scope.py`. These are plain asserts run via `bench execute` — `partition_scope` is pure when `units` is passed explicitly, and `parent_filter_conditions` only needs a Frappe context for `frappe.db.escape`:

```python
def run():
    _splits_by_warehouse_type()
    _defaults_unknown_to_greenhouse()
    _greenhouse_only_emits_no_OR()
    _mixed_scope_covers_both()
    print('check_scope: 4 passed')


def _splits_by_warehouse_type():
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        partition_scope,
    )
    units = {"GH A": {"type": "greenhouse"}, "BLK B": {"type": "block"}}
    ghs, blocks = partition_scope(["GH A", "BLK B"], units=units)
    assert ghs == ["GH A"], ghs
    assert blocks == ["BLK B"], blocks

def _defaults_unknown_to_greenhouse():
    """Unknown names must fall to `greenhouse`: 2775 kaitet entries carry a
    NULL crop and use the greenhouse column."""
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        partition_scope,
    )
    ghs, blocks = partition_scope(["Mystery"], units={})
    assert ghs == ["Mystery"], ghs
    assert blocks == [], blocks

def _greenhouse_only_emits_no_OR():
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        parent_filter_conditions,
    )
    sql, _ = parent_filter_conditions(
        "2026-01-01", "2026-01-31", "Rose", ["GH A"],
        units={"GH A": {"type": "greenhouse"}},
    )
    assert "se.greenhouse IN" in sql, sql
    assert "se.block" not in sql, sql
    assert " OR " not in sql, sql

def _mixed_scope_covers_both():
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        parent_filter_conditions,
    )
    sql, _ = parent_filter_conditions(
        "2026-01-01", "2026-01-31", "", ["GH A", "BLK B"],
        units={"GH A": {"type": "greenhouse"}, "BLK B": {"type": "block"}},
    )
    assert "se.greenhouse IN" in sql, sql
    assert "se.block IN" in sql, sql
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.check_scope.run
```
Expected: FAIL — `ImportError: cannot import name 'partition_scope'`.

- [ ] **Step 3: Implement**

In `_common.py`, replace `parent_filter_conditions` (currently lines 323-350) with:

```python
def partition_scope(names, units=None) -> tuple:
    """Split warehouse names into (greenhouse-type, block-type).

    The location column a Scouting Entry populates is decided by the
    warehouse's type, not by the crop: on kaitet 293 769 entries resolve
    via `greenhouse` (warehouse_type 'Greenhouse') and 3 362 via `block`
    ('Block'), with zero rows carrying both or neither. Keying on type
    rather than crop also means a new block-based crop needs no code change.

    Unknown names default to greenhouse — 2 775 kaitet entries have a NULL
    crop and use the greenhouse column, and dropping them would silently
    change every dashboard number.
    """
    if units is None:
        from upande_scp.serverscripts.scouting import scouting_metrics
        units = scouting_metrics.get_units_by_warehouse() or {}
    ghs, blocks = [], []
    for n in names:
        if (units.get(n) or {}).get("type") == "block":
            blocks.append(n)
        else:
            ghs.append(n)
    return ghs, blocks


def parent_filter_conditions(
    from_date: str,
    to_date: str,
    crop: str,
    greenhouse_scope: list | None,
    units=None,
) -> tuple:
    """Build a ``(sql_where, params_dict)`` pair restricting tabScouting Entry.

    Returns ('1=0', {}) if greenhouse_scope is an empty list (i.e. farm with
    no greenhouses — filter excludes everything). None means no greenhouse
    filter at all.

    A single-column predicate is emitted whenever the scope is all one
    warehouse type, which is what lets scouting_date_gh_idx /
    scouting_date_block_idx drive the query. Mixed scopes keep the
    disjunction; that is rare and correctness wins over the index.
    """
    if greenhouse_scope == []:
        return "1=0", {}

    parts = ["se.date_of_capture BETWEEN %(from_date)s AND %(to_date)s"]
    params = {"from_date": from_date, "to_date": to_date}

    if crop:
        parts.append("se.crop_scouted = %(crop)s")
        params["crop"] = crop

    if greenhouse_scope is not None:
        ghs, blocks = partition_scope(greenhouse_scope, units=units)
        gh_sql = ", ".join(frappe.db.escape(g) for g in ghs)
        blk_sql = ", ".join(frappe.db.escape(b) for b in blocks)
        if ghs and blocks:
            parts.append(
                f"(se.greenhouse IN ({gh_sql}) OR se.block IN ({blk_sql}))"
            )
        elif blocks:
            parts.append(f"se.block IN ({blk_sql})")
        else:
            parts.append(f"se.greenhouse IN ({gh_sql})")

    return " AND ".join(parts), params
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.check_scope.run
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.equivalence.verify
```
Expected: `check_scope: 4 passed`, then `14 passed, 0 failed, 0 missing`. The equivalence test passing is the important one — it proves the predicate change did not alter any endpoint's output.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_common.py \
        upande_scp/serverscripts/tests/check_scope.py
git commit -m "perf(scp): index-usable greenhouse predicate in aggregate filters

Partition the scope by Warehouse.warehouse_type and emit a single-column
IN when the scope is homogeneous, instead of (greenhouse OR block) which
defeated the planner. Unknown names default to greenhouse so the 2775
NULL-crop entries keep counting."
```

---

### Task 4: Force parent-first join order

With the index (Task 2) and the clean predicate (Task 3) in place, the optimizer *should* drive from the parent — but "should" is not a plan. `STRAIGHT_JOIN` makes it explicit, and the measured effect on the diagnose query was 423 ms → 179 ms.

**Files:**
- Modify: `_overview.py:123,132,141` · `_trends.py:98,106` · `_gh_detail.py:45,53,61` · `_fcm.py:52,64` · `_heatmaps.py:114` · `_application_plan.py:200` · `_pests_diseases.py:72`

**Interfaces:**
- Consumes: `parent_filter_conditions()` from Task 3.
- Produces: no signature changes. Behaviour identical, plan different.

- [ ] **Step 1: Confirm the bad plan is still in force**

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local mariadb -e "
EXPLAIN SELECT se.zone, c.pest, COUNT(*)
FROM \`tabScouting Entry\` se JOIN \`tabPests Scouting Entry\` c ON c.parent = se.name
WHERE se.greenhouse='Torongo GH 16 - KR'
  AND se.date_of_capture BETWEEN '2026-05-15' AND '2026-07-13'
GROUP BY 1,2;"
```
Record which table appears first and what `key` each uses. If `tabPests Scouting Entry` is still first with `type=ALL`, the join order needs forcing.

- [ ] **Step 2: Add STRAIGHT_JOIN to every parent→child aggregate query**

In each of the 12 sites listed under **Files**, change the SELECT keyword so the parent drives. For example in `_heatmaps.py:116`:

```python
        f"""
        SELECT STRAIGHT_JOIN
            COALESCE(NULLIF(se.greenhouse, ''), se.block)   AS greenhouse,
            c.{col}                                         AS obs_name,
            DATE_FORMAT(se.date_of_capture, '%%Y-%%m-%%d')  AS d,
            se.zone                                         AS zone,
            c.stage                                         AS stage,
            {count_expr}                                    AS n
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}
          AND se.zone IS NOT NULL AND se.zone != ''
        GROUP BY 1, 2, 3, 4, 5
        """
```

Apply the same `SELECT` → `SELECT STRAIGHT_JOIN` edit at each site. **Only** for queries whose `FROM` is `tabScouting Entry` with a child JOIN — do not touch `_overview.py:95-97`, which joins `tabWarehouse` and whose current order is correct.

- [ ] **Step 3: Verify the plan flipped**

Re-run the EXPLAIN from Step 1 with `SELECT STRAIGHT_JOIN`. Expected: `tabScouting Entry` first using `scouting_date_gh_idx`, then the child as `ref` on `pests_parent_cover` with `Using index`.

- [ ] **Step 4: Prove the output is unchanged, then measure**

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.equivalence.verify
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.bench_dashboard_aggregates.run \
  > /tmp/after-task4.txt 2>&1
diff /tmp/baseline-before.txt /tmp/after-task4.txt
```
Expected: equivalence PASSES, and `TOTAL COLD` drops substantially from 17 241 ms. If equivalence fails, `STRAIGHT_JOIN` has changed a result — revert the offending query and investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/
git commit -m "perf(scp): drive aggregate joins from Scouting Entry

STRAIGHT_JOIN so cost tracks the filtered slice instead of the whole
child table. Measured 423ms -> 179ms on the diagnose query; the plan
previously scanned the child table whole regardless of date window."
```

---

### Task 5: Split the diagnose cache key and push filters into SQL

`application_plan_diagnose` puts `pest`/`section`/`stage` in the cache key, but `_build` ignores them until it post-filters in Python at `_application_plan.py:106`. So every chip click mints a new cache entry *and* recomputes the identical SQL. Two fixes: compute the unfiltered rows under a key that excludes the chips, and filter in SQL.

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_application_plan.py:24-44,60-73,101-113`

**Interfaces:**
- Consumes: `cached_aggregate(endpoint, filters, compute, force)` from `_common.py`.
- Produces: unchanged return shape — `{zoneObs, latestDate, filterOpts, totalRows, targets}`.

- [ ] **Step 1: Write the failing test**

Add to `upande_scp/serverscripts/tests/test_dashboard_equivalence.py`:

```python
def test_chip_change_reuses_the_row_cache(self):
    """Changing pest/section/stage must not re-run the underlying SQL."""
    from upande_scp.serverscripts.dashboard_aggregates import _application_plan

    calls = []
    original = _application_plan._query_kind

    def counting(filters, kind):
        calls.append(kind)
        return original(filters, kind)

    _application_plan._query_kind = counting
    try:
        base = {
            "from_date": FIXTURE_FROM, "to_date": FIXTURE_TO,
            "crop": "Rose", "greenhouse": "_TEST GH 1", "job_id": "",
        }
        _application_plan.application_plan_diagnose(dict(base), force=True)
        first = len(calls)
        _application_plan.application_plan_diagnose(
            dict(base, pest="_TEST Thrips")
        )
        self.assertEqual(
            len(calls), first,
            "changing the pest chip re-ran the SQL; the row cache key "
            "must exclude pest/section/stage",
        )
    finally:
        _application_plan._query_kind = original
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.equivalence.verify
```
Expected: FAIL — the assertion reports more calls after the chip change.

- [ ] **Step 3: Implement the key split**

In `_application_plan.py`, replace the body of `application_plan_diagnose` (lines 24-44) with:

```python
def application_plan_diagnose(args: dict, force: bool = False) -> dict:
    greenhouse = (args.get("greenhouse") or "").strip()
    if not greenhouse:
        return _empty()

    # Rows depend only on scope + window. The chips are applied afterwards,
    # so they must NOT be part of this cache key — otherwise every chip
    # click recomputes identical SQL under a fresh key.
    row_filters = {
        "greenhouse": greenhouse,
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
    }
    job_id = (args.get("job_id") or "").strip()
    rows = cached_aggregate(
        "application_plan_rows",
        row_filters,
        lambda: _load_rows(row_filters, job_id),
        force=force,
    )

    chips = {
        "pest":    (args.get("pest") or "").strip(),
        "section": (args.get("section") or "").strip(),
        "stage":   (args.get("stage") or "").strip(),
    }
    return _shape(rows, chips)


def _load_rows(filters: dict, job_id: str = "") -> list:
    publish_progress(job_id, 10, "loading pest rows")
    pest_rows = _query_kind(filters, "pest")
    publish_progress(job_id, 40, "loading disease rows")
    disease_rows = _query_kind(filters, "disease")
    publish_progress(job_id, 70, "")
    return pest_rows + disease_rows
```

Then rename `_build(filters, job_id)` to `_shape(all_rows, chips)`: delete its first three lines (the two `_query_kind` calls and the `all_rows = pest_rows + disease_rows` join), take `all_rows` as a parameter, and read `pest = chips["pest"]`, `section = chips["section"]`, `stage = chips["stage"]` in place of the current `filters[...]` reads at lines 102-104. Everything from `pests_avail = sorted(...)` onward is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.equivalence.verify
```
Expected: PASS, including the snapshot comparison — the returned payload must be identical, only the caching changed.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_application_plan.py \
        upande_scp/serverscripts/tests/test_dashboard_equivalence.py
git commit -m "perf(scp): cache diagnose rows independently of the filter chips

The row query depends only on (greenhouse, window, crop); pest/section/
stage are applied afterwards. Keying the cache on all of them meant every
chip click recomputed identical SQL under a fresh key."
```

---

### Task 6: Split the heatmaps_grid payload

Measured: 709 cards, 13.65 MB, of which `recent[]` is 13.53 MB (99%) — `zoneStages` alone is 9.90 MB. But `Heatmaps.tsx:425` renders the grid thumbnail from `recent[0]` only; `recent[1]` and `recent[2]` are read solely inside the opened-card modal at line 567. Moving those two dates to an on-demand fetch removes ~2/3 of the payload while rendering exactly the same pixels.

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_heatmaps.py:134-194`
- Modify: `upande_scp/serverscripts/dashboard_aggregates/__init__.py`
- Modify: `frontend/src/hooks/use-dashboard-aggregate.ts:5-14,43-54`
- Modify: `frontend/src/pages/Heatmaps.tsx:439,560-580`

**Interfaces:**
- Consumes: `_build_cards(rows, mode, color_map)`.
- Produces:
  - `_heatmaps.heatmap_card_detail(args, force=False) -> {"recent": [...]}` where `args` carries `from_date`, `to_date`, `crop`, `greenhouse`, `obs_name`, `obs_kind`.
  - Whitelisted as `dashboard_aggregates.heatmap_card_detail`.
  - Grid cards keep every existing key; `recent` now has length ≤1 instead of ≤3.

- [ ] **Step 1: Write the failing test**

Add to `upande_scp/serverscripts/tests/test_dashboard_equivalence.py`:

```python
def test_grid_ships_only_the_rendered_date(self):
    out = self._run_case("heatmaps_grid", {})
    for card in out["cards"]:
        self.assertLessEqual(
            len(card["recent"]), 1,
            "grid cards must carry only recent[0]; the modal fetches the rest",
        )

def test_card_detail_returns_the_full_three_dates(self):
    from upande_scp.serverscripts.dashboard_aggregates import _heatmaps
    grid = self._run_case("heatmaps_grid", {})
    if not grid["cards"]:
        self.skipTest("fixture produced no cards")
    card = grid["cards"][0]
    detail = _heatmaps.heatmap_card_detail({
        "from_date": FIXTURE_FROM, "to_date": FIXTURE_TO, "crop": "Rose",
        "greenhouse": card["greenhouse"], "obs_name": card["obsName"],
        "obs_kind": card["obsKind"],
    }, force=True)
    self.assertGreaterEqual(len(detail["recent"]), 1)
    self.assertLessEqual(len(detail["recent"]), 3)
    # recent[0] must match what the grid already showed, or the thumbnail
    # would jump when the modal opens.
    self.assertEqual(detail["recent"][0]["date"], card["recent"][0]["date"])
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.equivalence.verify
```
Expected: FAIL — cards currently carry 3 entries, and `heatmap_card_detail` does not exist.

- [ ] **Step 3: Implement the split**

In `_heatmaps.py`, add a `limit` parameter to `_build_cards` and a new endpoint. Change the `_build_cards` signature and its `recent` construction:

```python
def _build_cards(rows: list, mode: str, color_map: dict, dates_limit: int = 3) -> list:
```

and inside the card loop replace the `dates` line with:

```python
            dates = sorted(bucket["by_date"].keys(), reverse=True)[:dates_limit]
```

In `_build`, request one date for the grid:

```python
    cards = _build_cards(pest_rows, "pest", pest_color_map, dates_limit=1)
    cards.extend(_build_cards(disease_rows, "disease", disease_color_map, dates_limit=1))
```

Then append the detail endpoint:

```python
def heatmap_card_detail(args: dict, force: bool = False) -> dict:
    """The 3 most-recent dates for ONE (greenhouse, observation) card.

    The grid ships only recent[0] — the thumbnail's date — because the full
    three-date detail is 99% of a 13.65 MB payload and is read only when a
    card is opened.
    """
    greenhouse = (args.get("greenhouse") or "").strip()
    obs_name = (args.get("obs_name") or "").strip()
    obs_kind = (args.get("obs_kind") or "pest").strip()
    if not greenhouse or not obs_name or obs_kind not in _KIND_TABLE:
        return {"recent": []}

    filters = {
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       (args.get("crop") or "").strip(),
        "greenhouse": greenhouse,
        "obs_name":   obs_name,
        "obs_kind":   obs_kind,
    }

    def build():
        where, params = parent_filter_conditions(
            filters["from_date"], filters["to_date"], filters["crop"],
            [greenhouse],
        )
        rows = _query_kind(where, params, obs_kind)
        rows = [r for r in rows if (r.get("obs_name") or "") == obs_name]
        color_map = {obs_name: ""}
        cards = _build_cards(rows, obs_kind, color_map, dates_limit=3)
        return {"recent": cards[0]["recent"] if cards else []}

    return cached_aggregate("heatmap_card_detail", filters, build, force=force)
```

In `dashboard_aggregates/__init__.py`, add the import beside the existing `_heatmaps_grid` import:

```python
from upande_scp.serverscripts.dashboard_aggregates._heatmaps import (
    heatmap_card_detail as _heatmap_card_detail,
)
```

and the whitelisted wrapper at the end of the file:

```python
@frappe.whitelist()
def heatmap_card_detail(**kwargs):
    return _call(_heatmap_card_detail, **kwargs)
```

- [ ] **Step 4: Wire the frontend**

In `frontend/src/hooks/use-dashboard-aggregate.ts`, add `"heatmap_card_detail"` to the `Endpoint` union (line 5-14) and this entry to `METHOD` (line 43-54):

```ts
  heatmap_card_detail:
    "upande_scp.serverscripts.dashboard_aggregates.heatmap_card_detail",
```

In `frontend/src/pages/Heatmaps.tsx`, fetch detail when a card is opened. Add beside the existing `picked` state:

```tsx
  const [pickedDetail, setPickedDetail] = useState<CardRecent[] | null>(null);

  useEffect(() => {
    if (!picked) { setPickedDetail(null); return; }
    let cancelled = false;
    setPickedDetail(null);
    call<{ message?: { recent: CardRecent[] } }>(
      "upande_scp.serverscripts.dashboard_aggregates.heatmap_card_detail",
      {
        from_date: from, to_date: to, crop,
        greenhouse: picked.greenhouse,
        obs_name: picked.obsName,
        obs_kind: picked.obsKind,
      },
    )
      .then((r) => {
        if (cancelled) return;
        setPickedDetail((r as any)?.message?.recent ?? (r as any)?.recent ?? []);
      })
      .catch(() => !cancelled && setPickedDetail(picked.recent));
    return () => { cancelled = true; };
  }, [picked, from, to, crop]);
```

Then in the modal at line 560, read from the fetched detail and fall back to what the grid already has so the first date renders instantly with no flash:

```tsx
              const modalRecent = pickedDetail ?? picked.recent;
```

Replace the two `picked.recent` reads inside the modal body (lines 560 and 567) with `modalRecent`. Declare `CardRecent` as a named type alias for the existing inline `recent` element type at line 104 and use it in the card interface, so the new state is typed.

- [ ] **Step 5: Run tests, typecheck, and measure**

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.equivalence.verify
cd apps/upande_scp/frontend && yarn tsc --noEmit && yarn build
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.bench_dashboard_aggregates.run \
  > /tmp/after-task6.txt 2>&1
diff /tmp/baseline-before.txt /tmp/after-task6.txt
```
Expected: tests PASS, typecheck clean, and `heatmaps_grid` payload drops from ~13 981 KB to roughly 4 500 KB.

**Regenerate the `heatmaps_grid` snapshot deliberately** — its payload legitimately changed:
```bash
SCP_REGENERATE_SNAPSHOTS=1 bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.equivalence.verify
git diff upande_scp/serverscripts/tests/snapshots/heatmaps_grid.json
```
Review that diff: the **only** change may be shorter `recent` arrays. Any change to `totalObs`, `zonesAffected`, `lastDate`, `color` or card count is a bug.

- [ ] **Step 6: Verify in the browser**

Open the Heatmaps page, confirm the grid thumbnails render as before, then open a card and confirm all three dates still appear left-to-right. This is the one change a test cannot fully cover.

- [ ] **Step 7: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/ \
        upande_scp/serverscripts/tests/ \
        frontend/src/pages/Heatmaps.tsx \
        frontend/src/hooks/use-dashboard-aggregate.ts
git commit -m "perf(scp): fetch heatmap card detail on demand

recent[] was 99% of a 13.65MB grid payload (zoneStages alone 9.9MB) but
only recent[0] is rendered in the grid; the other two dates are read
inside the opened card. Grid now ships one date, modal fetches three."
```

---

### Task 7: Measure, record, and close out

**Files:**
- Modify: `docs/Optimization/dataload-architecture.md`

- [ ] **Step 1: Take the final measurement**

```bash
cd /home/ubuntu/stive/code/frappe15
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.bench_dashboard_aggregates.run \
  > /tmp/after-final.txt 2>&1
diff /tmp/baseline-before.txt /tmp/after-final.txt
```

- [ ] **Step 2: Check the cost is now slice-proportional**

The real test of A1 is not the absolute number — it is that a wider window now costs more than a narrow one (before, 1 day and 60 days both cost 0.42 s):

```bash
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.bench_dashboard_aggregates.run \
  --kwargs '{"from_date":"2026-07-13","to_date":"2026-07-13"}'
bench --site kaitet.local execute \
  upande_scp.serverscripts.tests.bench_dashboard_aggregates.run \
  --kwargs '{"from_date":"2026-07-01","to_date":"2026-07-13"}'
```
Expected: the one-day run is materially faster. If the two are still equal, the join is *still* inverted — re-check the EXPLAIN from Task 4 Step 3.

- [ ] **Step 3: Record results in the design doc**

Add a short "A1 — measured result" block to `docs/Optimization/dataload-architecture.md` under the A1 section: the before/after table per endpoint, the total, and whether cost became slice-proportional. Then rebuild the HTML:

```bash
python3 apps/upande_scp/docs/Optimization/build_html.py
```

- [ ] **Step 4: Run the full affected test suite**

```bash
bench --site kaitet.local execute upande_scp.serverscripts.tests.check_scope.run
bench --site kaitet.local execute upande_scp.serverscripts.tests.equivalence.verify
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/Optimization/
git commit -m "docs(scp): record measured A1 result for the dashboard endpoints"
```

---

## Self-Review

**Spec coverage.** Every item in the brief maps to a task: inverted join → Task 4; child-table composite indexes → Task 2; `warehouse_type` predicate → Task 3; filter push-down and cache key split → Task 5; `heatmaps_grid` 13.7 MB → Task 6; the 17.2 s baseline → Tasks 1 and 7.

**Deliberately out of scope.** The nginx config wins (W1 gzip / W2 http2) are a separate change to a production host awaiting sign-off; the `redis_socketio` repoint (W3) belongs with the live-sync work; A2's IDB-page migration is a separate plan; the coarse rollup (A3) comes after A2. `_overview.py:95-97` joins `tabWarehouse`, not a child table, and is left alone.

**Known risk.** `STRAIGHT_JOIN` removes the optimizer's freedom. If a future query genuinely benefits from child-first (a highly selective observation filter with a very wide date range), it will be locked into the slower plan. The equivalence tests catch correctness regressions but not performance ones — hence Task 7 Step 2, which verifies slice-proportionality rather than trusting a single number.

**Type consistency.** `partition_scope(names, units=None) -> (list, list)` is defined in Task 3 and used only there. `_build_cards(rows, mode, color_map, dates_limit=3)` gains its parameter in Task 6 and every call site is updated in the same task. `_shape(all_rows, chips)` in Task 5 replaces `_build(filters, job_id)`; the only caller is `application_plan_diagnose`, rewritten in the same step. `CardRecent` is introduced in Task 6 Step 4 before first use.
