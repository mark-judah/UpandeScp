# Faster Data Loading & Sidebar Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the scouting payload cache to weekly granularity (server + pre-warm), make greenhouse/farm filters instant when data is already cached, replace the bottom loading strip with a centered progress overlay, and replace the sidebar "Exit" link with a profile component sourced from Frappe.

**Architecture:** Server caches and builds per ISO week (1/4 the payload, no full-month timeouts). The frontend already chunks weekly so its API contract is unchanged. `useScouting` is split into a hydration effect and a render/filter effect so changing greenhouse never flips the global loading state. A new `LoadingOverlay` consumes the existing `progress` value and reports `{loaded} of {total} weeks`. The sidebar footer renders an avatar + name + email + exit icon, with the avatar's `src` and `full_name` coming from an extended bootstrap payload.

**Tech Stack:** Frappe 15 (Python), React 19, Vite, TypeScript, Tailwind 4, shadcn/ui (Radix-based), IndexedDB. Backend tests use `frappe.tests.utils.FrappeTestCase` and run via `bench --site <site> run-tests --module …`.

**Spec:** [docs/superpowers/specs/2026-05-15-faster-data-loading-and-profile-design.md](../specs/2026-05-15-faster-data-loading-and-profile-design.md)

---

## Repo conventions to follow

- Existing tests: none — this plan creates the first test module under `upande_scp/serverscripts/tests/`. Use Frappe's `FrappeTestCase` for anything touching Redis or DB; use plain `unittest.TestCase` for pure helpers.
- Commit style mirrors recent history (`feat:` / `fix:` / `docs:` prefixes, short imperative subject).
- Backend test invocation:
  `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
  (Replace `upande.local` with the site name on the working environment — keep the same site for all tests in one run.)
- Frontend type-check + build:
  `cd frontend && npm run build`
- Dev server (used in manual verification):
  `cd frontend && npm run dev`

---

# Phase 1 — Backend: weekly cache + pre-warm

## Task 1: Set up backend test module

**Files:**
- Create: `upande_scp/serverscripts/tests/__init__.py`
- Create: `upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py`

- [ ] **Step 1: Create the `tests` package init**

```python
# upande_scp/serverscripts/tests/__init__.py
```
(empty file — just makes it a package.)

- [ ] **Step 2: Create a minimal failing test that asserts the new ISO-week helper exists**

```python
# upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py
import datetime
import unittest


class TestWeekHelpers(unittest.TestCase):
    def test_week_bounds_monday_to_sunday(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _week_bounds
        start, end = _week_bounds(2025, 18)  # ISO week 18 of 2025
        self.assertEqual(start, datetime.date(2025, 4, 28))   # Monday
        self.assertEqual(end, datetime.date(2025, 5, 4))      # Sunday

    def test_iso_year_week_for_date(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _iso_year_week
        self.assertEqual(_iso_year_week(datetime.date(2025, 1, 1)), (2025, 1))
        # 2025-12-29 is Monday of ISO week 1 of 2026
        self.assertEqual(_iso_year_week(datetime.date(2025, 12, 29)), (2026, 1))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run the test, verify both fail with ImportError**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
(All backend tests in this plan run under bench; the modules under test do `import frappe` at the top so plain `python -m unittest` won't resolve imports correctly.)
Expected: 2 ERRORS — `cannot import name '_week_bounds'`, `cannot import name '_iso_year_week'`.

- [ ] **Step 4: Commit the test skeleton**

```bash
git add upande_scp/serverscripts/tests/__init__.py upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py
git commit -m "test: scaffold tests for weekly scouting cache"
```

---

## Task 2: Add ISO-week helpers

**Files:**
- Modify: `upande_scp/serverscripts/get_complete_scouting_entries.py` (add functions; keep existing month-based ones intact for now)

- [ ] **Step 1: Add `_iso_year_week` and `_week_bounds` near the existing `_month_bounds`**

Insert above `_month_bounds`:

```python
def _iso_year_week(d):
    """Return ``(iso_year, iso_week)`` for a date. Follows ISO 8601 — the year
    of the Thursday in the same week, so the last few days of December may
    belong to ISO week 1 of the next year (and vice versa)."""
    iso = d.isocalendar()
    return (iso[0], iso[1])


def _week_bounds(iso_year, iso_week):
    """Return ``(monday_date, sunday_date)`` for an ISO ``(year, week)`` pair."""
    from datetime import date, timedelta

    # ISO uses Monday=1. ``date.fromisocalendar`` returns the Monday.
    monday = date.fromisocalendar(iso_year, iso_week, 1)
    sunday = monday + timedelta(days=6)
    return monday, sunday
```

- [ ] **Step 2: Run tests to verify both pass**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
(All backend tests in this plan run under bench; the modules under test do `import frappe` at the top so plain `python -m unittest` won't resolve imports correctly.)
Expected: 2 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/get_complete_scouting_entries.py
git commit -m "feat(scouting): add ISO-week helpers"
```

---

## Task 3: Walk weeks instead of months in the range expander

**Files:**
- Modify: `upande_scp/serverscripts/get_complete_scouting_entries.py`
- Modify: `upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py`

- [ ] **Step 1: Write the failing test**

Append to the test module:

```python
class TestWeeksInRange(unittest.TestCase):
    def test_single_week(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _weeks_in_range
        # 2025-04-28 (Mon) to 2025-05-04 (Sun) — one ISO week
        weeks = _weeks_in_range("2025-04-28", "2025-05-04")
        self.assertEqual(weeks, [(2025, 18)])

    def test_span_across_year_boundary(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _weeks_in_range
        # 2025-12-29 is ISO 2026-W01, 2026-01-05 is ISO 2026-W02
        weeks = _weeks_in_range("2025-12-29", "2026-01-05")
        self.assertEqual(weeks, [(2026, 1), (2026, 2)])

    def test_swapped_range_is_normalised(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _weeks_in_range
        a = _weeks_in_range("2025-04-28", "2025-05-04")
        b = _weeks_in_range("2025-05-04", "2025-04-28")
        self.assertEqual(a, b)
```

- [ ] **Step 2: Run, verify failures**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
(Bench runs the whole module; check the new TestWeeksInRange cases in the output.)
Expected: 3 ERRORS — `cannot import name '_weeks_in_range'`.

- [ ] **Step 3: Add `_weeks_in_range` next to `_months_in_range`**

```python
def _weeks_in_range(from_date, to_date):
    """List of ``(iso_year, iso_week)`` tuples covering [from_date, to_date].

    Order is monotonic in time. Inputs that arrive swapped are normalised.
    """
    start = _coerce_date(from_date)
    end = _coerce_date(to_date)
    if start > end:
        start, end = end, start
    seen = []
    seen_set = set()
    cur = start
    while cur <= end:
        key = _iso_year_week(cur)
        if key not in seen_set:
            seen_set.add(key)
            seen.append(key)
        # Step forward by 7 days; this can skip into the next ISO week.
        from datetime import timedelta
        cur = cur + timedelta(days=1)
        # Fast-forward to Monday of the week containing `cur` so we don't
        # iterate day-by-day across long ranges.
        weekday = cur.isoweekday()  # Mon=1..Sun=7
        if weekday != 1:
            cur = cur + timedelta(days=(8 - weekday))
    return seen
```

Note: the inner loop is "day step then skip to next Monday" — handles short ranges (≤7 days) and long ones equally without an O(days) walk.

- [ ] **Step 4: Run tests, verify all pass**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
(All backend tests in this plan run under bench; the modules under test do `import frappe` at the top so plain `python -m unittest` won't resolve imports correctly.)
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/get_complete_scouting_entries.py upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py
git commit -m "feat(scouting): expand date ranges into ISO weeks"
```

---

## Task 4: Add weekly cache key + fetch-week-entries

**Files:**
- Modify: `upande_scp/serverscripts/get_complete_scouting_entries.py`
- Modify: `upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py`

- [ ] **Step 1: Add a unit test for the new cache key**

Append:

```python
class TestWeekCacheKey(unittest.TestCase):
    def test_key_uses_iso_year_week(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _week_cache_key
        # Patch scouting_payload_version to a known stamp.
        import upande_scp.serverscripts.get_complete_scouting_entries as mod
        from unittest.mock import patch
        with patch.object(mod, "scouting_payload_version", return_value=7):
            self.assertEqual(_week_cache_key(2025, 18), "scp:scouting_payload_v2:7:2025-W18")
            self.assertEqual(_week_cache_key(2026, 1),  "scp:scouting_payload_v2:7:2026-W01")
```

- [ ] **Step 2: Run, verify it fails**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
Expected: ERROR — `cannot import name '_week_cache_key'`.

- [ ] **Step 3: Add `_week_cache_key` and `_is_recent_week` to the module**

Insert near the existing `_month_cache_key`:

```python
def _week_cache_key(iso_year, iso_week):
    """Per-ISO-week cache key.

    Mirrors the previous monthly key but is finer-grained. Filtering by
    greenhouse / block is still applied in-memory after the cache hit so
    we don't store the same source rows once per (greenhouse, all) shape.
    """
    v = scouting_payload_version()
    return f"{K_SCOUTING_PAYLOAD_PREFIX}:{v}:{iso_year:04d}-W{iso_week:02d}"


def _is_recent_week(iso_year, iso_week):
    """Whether (iso_year, iso_week) sits inside the rolling cache window."""
    from datetime import date, timedelta

    _, sunday = _week_bounds(iso_year, iso_week)
    cutoff = date.today() - timedelta(days=CACHE_WINDOW_DAYS)
    return sunday >= cutoff
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
(All backend tests in this plan run under bench; the modules under test do `import frappe` at the top so plain `python -m unittest` won't resolve imports correctly.)
Expected: 6 PASS.

- [ ] **Step 5: Add `_fetch_week_entries` (cached) — and the SQL underneath**

Insert below `_fetch_month_entries`:

```python
def _fetch_week_entries(iso_year, iso_week):
    """Return the normalized entries for one ISO week.

    Cached per-week, version-stamped, capped to the rolling
    ``CACHE_WINDOW_DAYS`` window. Greenhouse/block filtering is the caller's
    responsibility — keeping the cache key week-only avoids storing the same
    source rows once per filter shape.
    """
    cache = frappe.cache()
    cache_key = _week_cache_key(iso_year, iso_week)
    cached = cache.get_value(cache_key)
    if cached is not None:
        return cached

    monday, sunday = _week_bounds(iso_year, iso_week)
    entries = _build_month_entries(monday.isoformat(), sunday.isoformat())

    if _is_recent_week(iso_year, iso_week):
        cache.set_value(cache_key, entries, expires_in_sec=TTL_MEDIUM)
    return entries
```

(`_build_month_entries` is the existing SQL builder — its name is now slightly misleading but it accepts an arbitrary date range, so we reuse it as-is. We'll rename it in a later refactor only if it stays misleading.)

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/get_complete_scouting_entries.py upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py
git commit -m "feat(scouting): add per-week cache key and fetch helper"
```

---

## Task 5: Switch `_fetch_scouting_payload` to walk weeks

**Files:**
- Modify: `upande_scp/serverscripts/get_complete_scouting_entries.py`
- Modify: `upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py`

- [ ] **Step 1: Write a FrappeTestCase integration test**

Append:

```python
class TestFetchPayloadUsesWeeks(unittest.TestCase):
    """Integration check: _fetch_scouting_payload should hit _fetch_week_entries
    once per ISO week in range, not _fetch_month_entries."""

    def test_one_call_per_week(self):
        from unittest.mock import patch
        import upande_scp.serverscripts.get_complete_scouting_entries as mod

        with patch.object(mod, "_fetch_week_entries", return_value=[]) as wk:
            mod._fetch_scouting_payload("2025-04-28", "2025-05-11", None, include_meta=False)

        # 2025-04-28..2025-05-11 spans ISO weeks 18 + 19 + 20 of 2025
        called_args = sorted(c.args for c in wk.call_args_list)
        self.assertEqual(called_args, [(2025, 18), (2025, 19), (2025, 20)])
```

- [ ] **Step 2: Run, verify fail**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
Expected: FAIL — `wk.call_args_list` is empty because `_fetch_scouting_payload` still calls `_fetch_month_entries`.

- [ ] **Step 3: Update `_fetch_scouting_payload`**

Replace the function body:

```python
def _fetch_scouting_payload(from_date, to_date, greenhouse_filter, include_meta=True):
    """Cached wrapper. Stitches ISO-week cache slices and applies the
    greenhouse / block filter in-memory.

    On a warm cache this is one Redis read per week covered by the range,
    plus a Python list filter. On a miss only the missing weeks are built.
    """
    weeks = _weeks_in_range(from_date, to_date)
    all_entries = []
    for (iy, iw) in weeks:
        all_entries.extend(_fetch_week_entries(iy, iw))

    entries = _filter_entries(all_entries, from_date, to_date, greenhouse_filter)
    payload = {
        "entries": entries,
        "total_entries": len(entries),
        "filters_applied": {
            "from_date": str(from_date),
            "to_date": str(to_date),
            "greenhouse": greenhouse_filter,
        },
    }
    if include_meta:
        payload["pest_colors"] = _cached_pest_colors()
        payload["disease_colors"] = _cached_disease_colors()
        payload["zones_by_greenhouse"] = _cached_zones_by_greenhouse()
        payload["units_by_greenhouse"] = _cached_units_by_warehouse()
        payload["crops_scouted"] = _cached_crops_with_farms()
        payload["severity_thresholds"] = _cached_severity_thresholds()
    return payload
```

- [ ] **Step 4: Run all tests, verify pass**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
(All backend tests in this plan run under bench; the modules under test do `import frappe` at the top so plain `python -m unittest` won't resolve imports correctly.)
Expected: 7 PASS.

- [ ] **Step 5: Smoke-check the endpoint with bench**

Run (substitute the actual site):
```bash
bench --site upande.local execute upande_scp.serverscripts.get_complete_scouting_entries.getScoutingEntriesChunk \
  --kwargs '{"from_date": "2025-04-28", "to_date": "2025-05-04", "include_meta": 0}'
```
Expected: prints a dict with `total_entries` ≥ 0. No traceback.

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/get_complete_scouting_entries.py upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py
git commit -m "feat(scouting): payload walks ISO weeks instead of months"
```

---

## Task 6: Whole-week short-circuit in `_filter_entries`

**Files:**
- Modify: `upande_scp/serverscripts/get_complete_scouting_entries.py`
- Modify: `upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py`

The optimization: when the caller's `(from_date, to_date)` matches the bounds of one whole ISO week, skip the per-entry date check. Greenhouse filter still runs.

- [ ] **Step 1: Test parity between filtered and short-circuit paths**

Append:

```python
class TestFilterEntriesWholeWeek(unittest.TestCase):
    def test_whole_week_short_circuit_matches_filter(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _filter_entries

        entries = [
            {"date_of_capture": "2025-04-28", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-01", "greenhouse": "G2", "block": ""},
            {"date_of_capture": "2025-05-04", "greenhouse": "G1", "block": ""},
            # Outside the week (these shouldn't appear when stitched
            # from week 18 only, but the helper must still filter them).
            {"date_of_capture": "2025-04-27", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-05", "greenhouse": "G1", "block": ""},
        ]
        result = _filter_entries(entries, "2025-04-28", "2025-05-04", None)
        dates = sorted(e["date_of_capture"] for e in result)
        self.assertEqual(dates, ["2025-04-28", "2025-05-01", "2025-05-04"])

    def test_whole_week_short_circuit_with_greenhouse(self):
        from upande_scp.serverscripts.get_complete_scouting_entries import _filter_entries
        entries = [
            {"date_of_capture": "2025-04-28", "greenhouse": "G1", "block": ""},
            {"date_of_capture": "2025-05-01", "greenhouse": "G2", "block": ""},
        ]
        result = _filter_entries(entries, "2025-04-28", "2025-05-04", "G1")
        self.assertEqual([e["greenhouse"] for e in result], ["G1"])
```

- [ ] **Step 2: Run, verify the date-range tests still pass (no behaviour change yet)**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
Expected: 2 PASS (the existing filter already handles these correctly).

- [ ] **Step 3: Add the short-circuit branch**

Modify `_filter_entries`:

```python
def _filter_entries(entries, from_date, to_date, greenhouse_filter):
    from_d = _coerce_date(from_date)
    to_d = _coerce_date(to_date)
    gh = (greenhouse_filter or "").strip()

    # Short-circuit: if the requested range matches an ISO week, skip the
    # per-row date filter — entries pulled for one cached week already
    # satisfy it.
    from_is_monday = from_d.isoweekday() == 1
    range_is_one_week = (to_d - from_d).days == 6
    skip_date_filter = from_is_monday and range_is_one_week

    from_s = from_d.isoformat()
    to_s = to_d.isoformat()
    out = []
    for e in entries:
        d = e.get("date_of_capture")
        if not d:
            continue
        if not skip_date_filter:
            ds = str(d)[:10]
            if ds < from_s or ds > to_s:
                continue
        if gh and e.get("greenhouse") != gh and e.get("block") != gh:
            continue
        out.append(e)
    return out
```

- [ ] **Step 4: Run tests**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
(All backend tests in this plan run under bench; the modules under test do `import frappe` at the top so plain `python -m unittest` won't resolve imports correctly.)
Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/get_complete_scouting_entries.py upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py
git commit -m "perf(scouting): skip per-row date filter on whole-week ranges"
```

---

## Task 7: Pre-warm scheduled job

**Files:**
- Create: `upande_scp/serverscripts/scouting_prewarm.py`
- Modify: `upande_scp/hooks.py`
- Modify: `upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py` (one more test)

- [ ] **Step 1: Write the failing test**

Append:

```python
class TestPrewarm(unittest.TestCase):
    def test_prewarm_calls_fetch_for_recent_weeks(self):
        from unittest.mock import patch
        import datetime
        import upande_scp.serverscripts.scouting_prewarm as pre

        # Freeze "today" to a known Monday so we can assert exact weeks.
        FAKE_TODAY = datetime.date(2025, 5, 5)  # Monday, ISO week 19/2025

        with patch.object(pre, "_today", return_value=FAKE_TODAY), \
             patch("upande_scp.serverscripts.get_complete_scouting_entries._fetch_week_entries", return_value=[]) as wk:
            pre.daily_prewarm()

        called = sorted(c.args for c in wk.call_args_list)
        # Current week (W19) + previous 4 (W18, W17, W16, W15)
        self.assertEqual(called, [(2025, 15), (2025, 16), (2025, 17), (2025, 18), (2025, 19)])
```

- [ ] **Step 2: Run, verify ImportError**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
Expected: ERROR — module `scouting_prewarm` not found.

- [ ] **Step 3: Create `scouting_prewarm.py`**

```python
"""Daily background job that builds the current ISO week + previous 4 into
the scouting payload cache so the first user of the day always hits warm
keys. Idempotent — re-running it is a no-op when entries are already cached.
"""

import datetime

import frappe

from upande_scp.serverscripts.get_complete_scouting_entries import (
    _fetch_week_entries,
    _iso_year_week,
)


PREWARM_WEEKS = 5  # current + 4 previous


def _today():
    """Indirection so tests can pin a deterministic date."""
    return datetime.date.today()


def _recent_weeks():
    today = _today()
    out = []
    for offset in range(PREWARM_WEEKS):
        d = today - datetime.timedelta(days=7 * offset)
        out.append(_iso_year_week(d))
    return sorted(set(out))


def daily_prewarm():
    """Frappe scheduler entry point. Builds the cache for recent weeks."""
    for (iy, iw) in _recent_weeks():
        try:
            _fetch_week_entries(iy, iw)
        except Exception:
            frappe.log_error(
                f"daily_prewarm failed for {iy}-W{iw:02d}", "SCP prewarm",
            )
```

- [ ] **Step 4: Run test**

Run: `bench --site upande.local run-tests --module upande_scp.serverscripts.tests.test_get_complete_scouting_entries`
Expected: PASS.

- [ ] **Step 5: Register the daily scheduler entry in `hooks.py`**

Open `upande_scp/hooks.py`, find the `scheduler_events = { "cron": { … } }` block (starts at line ~210), and add a `"daily"` key alongside `"cron"`:

```python
scheduler_events = {
    "cron": {
        # …existing entries…
    },
    "daily": [
        "upande_scp.serverscripts.scouting_prewarm.daily_prewarm",
    ],
}
```

- [ ] **Step 6: Smoke-call the job via bench**

Run (substitute the actual site):
```bash
bench --site upande.local execute upande_scp.serverscripts.scouting_prewarm.daily_prewarm
```
Expected: returns without error.

- [ ] **Step 7: Commit**

```bash
git add upande_scp/serverscripts/scouting_prewarm.py upande_scp/hooks.py upande_scp/serverscripts/tests/test_get_complete_scouting_entries.py
git commit -m "feat(scouting): daily prewarm job for recent ISO weeks"
```

---

# Phase 2 — Frontend: filter-from-cache UX

## Task 8: Export `getMissingWeeks` from `scouting-sync.ts`

**Files:**
- Modify: `frontend/src/lib/scouting-sync.ts`

- [ ] **Step 1: Lift the existing computation in `hydrateRange` into a peer function**

Inside `scouting-sync.ts`, just below the `weeksBetween` helper and the `loadedWeeksSet` helper, add:

```typescript
/**
 * The set of ISO weeks touching [from, to] that aren't yet recorded in the
 * loaded-weeks registry. Returns empty when everything is cached — callers
 * can use that to skip the loading state entirely.
 */
export async function getMissingWeeks(
  from: string,
  to: string,
): Promise<WeekSlot[]> {
  const weeks = weeksBetween(from, to);
  if (!weeks.length) return [];
  const known = await loadedWeeksSet();
  return weeks.filter((w) => !known.has(w.key));
}
```

- [ ] **Step 2: Refactor `hydrateRange` to reuse the helper**

Replace the first three lines of `hydrateRange`'s body:

```typescript
export async function hydrateRange(
  from: string,
  to: string,
  onProgress?: (loaded: number, total: number, week: string) => void,
): Promise<void> {
  await clearLegacyMonthsRegistry();
  const missing = await getMissingWeeks(from, to);
  if (!missing.length) return;
  // …rest unchanged…
```

(The `weeksBetween` / `loadedWeeksSet` calls that previously lived here are now inside `getMissingWeeks`.)

- [ ] **Step 3: Type-check passes**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/scouting-sync.ts
git commit -m "refactor(scouting): expose getMissingWeeks helper"
```

---

## Task 9: Split `useScouting` into hydration + render effects

**Files:**
- Modify: `frontend/src/hooks/use-scouting.ts`

The result type also gains `weeksLoaded` and `weeksTotal` for the overlay to render counts (Task 12 consumes them; we add them here so the API is stable before consumers swap).

- [ ] **Step 1: Update the result interface**

Replace the `UseScoutingResult` interface:

```typescript
export interface UseScoutingResult {
  data: ProcessedData | null;
  meta: ScoutingMeta;
  loading: boolean;
  progress: number;
  weeksLoaded: number;
  weeksTotal: number;
  error: string | null;
  reload: () => void;
}
```

- [ ] **Step 2: Replace the hook body**

Replace the whole `useScouting` function (everything from `export function useScouting…` to the end of the file's last `useMemo`) with:

```typescript
export function useScouting({
  from,
  to,
  greenhouse,
  greenhouses,
  crop,
}: UseScoutingArgs): UseScoutingResult {
  const [data, setData] = useState<ProcessedData | null>(null);
  const [meta] = useState<ScoutingMeta>(EMPTY_META);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [weeksLoaded, setWeeksLoaded] = useState(0);
  const [weeksTotal, setWeeksTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const tokenRef = useRef(0);

  // Memoise the greenhouses list so we don't re-fire the render effect every
  // render when callers spread a fresh array literal.
  const greenhousesKey = greenhouses
    ? greenhouses.slice().sort().join("|")
    : "";

  // Shared filter+render — used by both effects below.
  const buildAndSet = async (token: number) => {
    if (tokenRef.current !== token) return;
    try {
      const processed = await loadAndProcess({
        from,
        to,
        greenhouse,
        greenhouses,
        crop,
      });
      if (tokenRef.current === token) setData(processed);
    } catch (e) {
      console.error("[scouting] processing failed", e);
    }
  };

  // Effect A — Hydration. Runs only when the date range (or a manual reload)
  // changes. Owns loading / progress / weeks counters. Skips the loading
  // state entirely when everything is already cached so greenhouse switches
  // (handled by Effect B) never flash a loading indicator.
  useEffect(() => {
    if (!from || !to || from > to) return;
    const token = ++tokenRef.current;
    setError(null);

    (async () => {
      const missing = await getMissingWeeks(from, to);
      if (tokenRef.current !== token) return;

      if (missing.length === 0) {
        // Cached path — Effect B will refresh data; nothing for us to do.
        setLoading(false);
        setProgress(100);
        setWeeksLoaded(0);
        setWeeksTotal(0);
        return;
      }

      setLoading(true);
      setProgress(0);
      setWeeksLoaded(0);
      setWeeksTotal(missing.length);

      try {
        await hydrateRange(from, to, (loaded, total, week) => {
          if (tokenRef.current !== token) return;
          setWeeksLoaded(loaded);
          setWeeksTotal(total);
          setProgress(Math.round((100 * loaded) / Math.max(1, total)));
          console.log(`[scouting] hydrated week ${week} (${loaded}/${total})`);
        });
        if (tokenRef.current !== token) return;
        setProgress(100);
      } catch (e: any) {
        if (tokenRef.current !== token) return;
        console.error("[scouting] hydrate failed", e);
        setError(e?.message || "Failed to load scouting data");
        return;
      } finally {
        if (tokenRef.current === token) setLoading(false);
      }

      // Background delta — quietly refresh when complete.
      void runDelta()
        .then(async ({ added }) => {
          if (added > 0 && tokenRef.current === token) {
            await buildAndSet(token);
          }
        })
        .catch((e) => console.error("[scouting] delta failed", e));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, tick]);

  // Effect B — Render. Runs whenever filters change (and also after Effect A
  // mutates IDB, because `tick` and range are shared). Pure IDB-read +
  // ProcessedData rebuild; never touches loading/progress.
  useEffect(() => {
    if (!from || !to || from > to) return;
    const token = tokenRef.current;
    void buildAndSet(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, greenhouse, greenhousesKey, crop, tick, weeksLoaded]);

  // Realtime: invalidate the affected month and re-render.
  useRealtime("scp:scouting:dirty", async (payload: { months?: string[] }) => {
    const months = payload?.months || [];
    if (!months.length) {
      await invalidateMonth(null);
    } else {
      await Promise.all(months.map(invalidateMonth));
    }
    setTick((n) => n + 1);
  });

  return useMemo(
    () => ({
      data,
      meta,
      loading,
      progress,
      weeksLoaded,
      weeksTotal,
      error,
      reload: () => {
        void primeAndDelta(from, to).catch(() => {});
        setTick((n) => n + 1);
      },
    }),
    [data, meta, loading, progress, weeksLoaded, weeksTotal, error, from, to],
  );
}
```

Note the new import — add `getMissingWeeks` to the existing import block at the top:

```typescript
import {
  getMissingWeeks,
  hydrateRange,
  invalidateMonth,
  primeAndDelta,
  readEntries,
  runDelta,
} from "@/lib/scouting-sync";
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors. Existing callers of `useScouting` continue to work — they only destructure `data, loading, error, reload`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/use-scouting.ts
git commit -m "feat(scouting): split hook into hydration + render effects"
```

---

# Phase 3 — Progress overlay

## Task 10: Install shadcn Progress component

**Files:**
- Modify: `frontend/package.json` (add `@radix-ui/react-progress`)
- Create: `frontend/src/components/ui/progress.tsx`

- [ ] **Step 1: Install the Radix progress primitive**

Run: `cd frontend && npm install @radix-ui/react-progress`
Expected: package added, no peer-dep warnings beyond existing ones.

- [ ] **Step 2: Create the shadcn wrapper**

```typescript
// frontend/src/components/ui/progress.tsx
import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-muted",
      className,
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-primary transition-transform duration-200"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
```

- [ ] **Step 3: Type-check / build**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/ui/progress.tsx
git commit -m "feat(ui): add shadcn Progress component"
```

---

## Task 11: Create `LoadingOverlay`

**Files:**
- Create: `frontend/src/components/LoadingOverlay.tsx`

- [ ] **Step 1: Write the component**

```typescript
// frontend/src/components/LoadingOverlay.tsx
import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface LoadingOverlayProps {
  open: boolean;
  progress: number;
  weeksLoaded?: number;
  weeksTotal?: number;
  className?: string;
}

/**
 * Centered modal overlay shown while scouting data is loading. Reads
 * `progress` (0-100) and the week counter from useScouting. Mount-gated on
 * `open` so an idle page doesn't keep an invisible div capturing pointer
 * events.
 */
export function LoadingOverlay({
  open,
  progress,
  weeksLoaded = 0,
  weeksTotal = 0,
  className,
}: LoadingOverlayProps) {
  if (!open) return null;
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const showCounter = weeksTotal > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm",
        "transition-opacity duration-200",
        className,
      )}
    >
      <div className="w-[min(90vw,24rem)] rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-3 mb-4">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="flex-1">
            <div className="text-sm font-medium">Loading scouting data…</div>
            {showCounter && (
              <div className="text-xs text-muted-foreground">
                {weeksLoaded} of {weeksTotal} weeks
              </div>
            )}
          </div>
          <div className="text-xs font-mono text-muted-foreground tabular-nums">
            {pct}%
          </div>
        </div>
        <Progress value={pct} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/LoadingOverlay.tsx
git commit -m "feat(ui): add LoadingOverlay for scouting data loads"
```

---

## Task 12: Swap LoadingStrip → LoadingOverlay in scouting pages

**Files (each one is the same shape of swap):**
- Modify: `frontend/src/pages/Dashboard.tsx`
- Modify: `frontend/src/pages/Trends.tsx`
- Modify: `frontend/src/pages/Observations.tsx`
- Modify: `frontend/src/pages/Heatmaps.tsx`
- Modify: `frontend/src/pages/RoseScouting.tsx`
- Modify: `frontend/src/pages/AvocadoMap.tsx`
- Modify: `frontend/src/pages/TrapsMap.tsx`
- Modify: `frontend/src/pages/ApplicationPlan.tsx`

(`Reports.tsx` and `Approvals.tsx` are left alone — they don't use `useScouting`; their `LoadingStrip` is tied to a non-progress-bearing `busy` state.)

For **each** of the 8 files above, do this swap:

- [ ] **Step 1: Update the import**

Replace:
```typescript
import { LoadingStrip } from "@/components/LoadingStrip";
```
With:
```typescript
import { LoadingOverlay } from "@/components/LoadingOverlay";
```

- [ ] **Step 2: Update the destructuring from `useScouting`**

In each file, find the line `const { data, loading, … } = useScouting(…);` and add `progress, weeksLoaded, weeksTotal`. For Dashboard at [pages/Dashboard.tsx:104](frontend/src/pages/Dashboard.tsx#L104):
```typescript
const { data, loading, progress, weeksLoaded, weeksTotal, error, reload } = useScouting({
  from,
  to,
  greenhouses: greenhouseScope,
  crop,
});
```
Mirror the same change in each consumer.

- [ ] **Step 3: Replace the JSX usage**

Find `<LoadingStrip active={…} />` in each file and replace with:
```tsx
<LoadingOverlay
  open={loading}
  progress={progress}
  weeksLoaded={weeksLoaded}
  weeksTotal={weeksTotal}
/>
```

Exception — `AvocadoMap.tsx:352` currently composes two busy sources:
```tsx
<LoadingStrip active={loading || loadingGeo} />
```
Replace with:
```tsx
<LoadingOverlay
  open={loading || loadingGeo}
  progress={loading ? progress : 100}
  weeksLoaded={weeksLoaded}
  weeksTotal={weeksTotal}
/>
```
When only `loadingGeo` is true, progress is forced to 100 — the overlay will spin and show "Loading scouting data…" with a full bar. If the wording bothers you in practice, follow-up by adding a `label` prop to `LoadingOverlay`; defer for now.

Exception — `ApplicationPlan.tsx:1565` composes three sources:
```tsx
<LoadingStrip active={loading || busy || bomLoading} />
```
Replace with:
```tsx
<LoadingOverlay
  open={loading || busy || bomLoading}
  progress={loading ? progress : 100}
  weeksLoaded={weeksLoaded}
  weeksTotal={weeksTotal}
/>
```

- [ ] **Step 4: Type-check / build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit (single commit for all 8 page swaps)**

```bash
git add frontend/src/pages/Dashboard.tsx frontend/src/pages/Trends.tsx \
        frontend/src/pages/Observations.tsx frontend/src/pages/Heatmaps.tsx \
        frontend/src/pages/RoseScouting.tsx frontend/src/pages/AvocadoMap.tsx \
        frontend/src/pages/TrapsMap.tsx frontend/src/pages/ApplicationPlan.tsx
git commit -m "feat(ui): swap LoadingStrip for LoadingOverlay on scouting pages"
```

(`LoadingStrip.tsx` itself stays — `App.tsx`'s `PageFallback` still uses it for Suspense code-load fallback, which isn't progress-bearing.)

---

# Phase 4 — Sidebar profile

## Task 13: Extend bootstrap with name + avatar

**Files:**
- Modify: `upande_scp/www/scp_app.py`

- [ ] **Step 1: Update the bootstrap dict at [scp_app.py:85-90](upande_scp/www/scp_app.py#L85-L90)**

Replace:

```python
context.bootstrap_json = json.dumps(
    {
        "user": frappe.session.user,
        "site_name": frappe.local.site,
    }
)
```

With:

```python
user_id = frappe.session.user
user_doc = frappe.db.get_value(
    "User", user_id, ["full_name", "user_image"], as_dict=True
) or {}
context.bootstrap_json = json.dumps(
    {
        "user": user_id,
        "full_name": user_doc.get("full_name") or user_id,
        "user_image": user_doc.get("user_image") or "",
        "site_name": frappe.local.site,
    }
)
```

- [ ] **Step 2: Smoke-render the page**

Run (substitute the site):
```bash
bench --site upande.local execute frappe.utils.response.json_handler --kwargs '{"obj": null}'
```
(Sanity that bench is healthy; then load the page in browser — see step 3.)

- [ ] **Step 3: Open the app page in browser and view source**

Visit `/scp_app` (or whichever path renders the SPA) while logged in. In the page source / dev-tools, search for `bootstrap` — confirm the inline JSON contains `full_name` and `user_image` keys.

- [ ] **Step 4: Commit**

```bash
git add upande_scp/www/scp_app.py
git commit -m "feat(scp_app): ship full_name and user_image in bootstrap"
```

---

## Task 14: Type the bootstrap accessor

**Files:**
- Modify: `frontend/src/lib/frappe.ts`

- [ ] **Step 1: Replace the `bootstrap` function and its `Window` types**

Replace lines 1-31 of `frappe.ts`:

```typescript
export interface ScpBootstrap {
  user: string;
  full_name: string;
  user_image: string;
  site_name: string;
}

declare global {
  interface Window {
    SCP?: {
      csrf_token?: string;
      bootstrap?: Partial<ScpBootstrap> & Record<string, unknown>;
    };
    csrf_token?: string;
  }
}

export class FrappeError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function csrf(): string {
  return (
    window.SCP?.csrf_token ||
    window.csrf_token ||
    ""
  );
}

export function bootstrap(): ScpBootstrap {
  const raw = window.SCP?.bootstrap || {};
  return {
    user: typeof raw.user === "string" ? raw.user : "",
    full_name: typeof raw.full_name === "string" ? raw.full_name : "",
    user_image: typeof raw.user_image === "string" ? raw.user_image : "",
    site_name: typeof raw.site_name === "string" ? raw.site_name : "",
  };
}
```

(The `call` function below is unchanged.)

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors. The previous generic `bootstrap<T>()` is removed — but it had no callers in the codebase (`grep` to confirm before commit).

- [ ] **Step 3: Verify no callers broke**

Run: `grep -rn "bootstrap<" frontend/src --include="*.ts" --include="*.tsx"`
Expected: no matches (the old generic was unused).

Run: `grep -rn "from \"@/lib/frappe\"" frontend/src --include="*.ts" --include="*.tsx" | head`
Expected: only files importing `call` and `FrappeError`. No file currently imports `bootstrap` — that's fine; Task 16 will be its first consumer.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/frappe.ts
git commit -m "feat(frappe): type ScpBootstrap with name + avatar fields"
```

---

## Task 15: Install shadcn Avatar component

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/components/ui/avatar.tsx`

- [ ] **Step 1: Install the Radix avatar primitive**

Run: `cd frontend && npm install @radix-ui/react-avatar`
Expected: package added.

- [ ] **Step 2: Create the shadcn wrapper**

```typescript
// frontend/src/components/ui/avatar.tsx
import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

export const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full",
      className,
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

export const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full object-cover", className)}
    {...props}
  />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

export const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-muted text-xs font-medium",
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/ui/avatar.tsx
git commit -m "feat(ui): add shadcn Avatar component"
```

---

## Task 16: Create `SidebarUser` component

**Files:**
- Create: `frontend/src/components/SidebarUser.tsx`

- [ ] **Step 1: Write the component**

```typescript
// frontend/src/components/SidebarUser.tsx
import { LogOut } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { bootstrap } from "@/lib/frappe";

function initialsOf(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const single = parts[0];
    // Emails fall back to the first character of the local-part.
    const local = single.includes("@") ? single.split("@")[0] : single;
    return (local[0] || "?").toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Bottom-of-sidebar profile chip. Renders the user's avatar (or initials
 * fallback) alongside their name and email, plus a small Exit icon that
 * matches the original "Exit to workspace" link. In collapsed sidebar
 * state name and email hide; avatar and exit icon remain stacked.
 */
export function SidebarUser() {
  const { user, full_name, user_image } = bootstrap();
  const displayName = full_name || user || "User";
  const initials = initialsOf(displayName);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div
          className={
            "flex items-center gap-2 px-2 py-1.5 " +
            "group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 " +
            "group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0"
          }
        >
          <Avatar className="h-8 w-8 shrink-0">
            {user_image ? <AvatarImage src={user_image} alt={displayName} /> : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div
            className={
              "grid min-w-0 flex-1 text-left text-xs leading-tight " +
              "group-data-[collapsible=icon]:hidden"
            }
          >
            <span className="truncate font-medium">{displayName}</span>
            <span className="truncate text-[0.7rem] text-muted-foreground">
              {user}
            </span>
          </div>
          <SidebarMenuButton
            asChild
            title="Exit to workspace"
            className={
              "size-8 shrink-0 p-0 justify-center " +
              "group-data-[collapsible=icon]:size-6"
            }
          >
            <a href="/app/scouting-&-crop-protection" aria-label="Exit to workspace">
              <LogOut className="h-4 w-4" />
            </a>
          </SidebarMenuButton>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/SidebarUser.tsx
git commit -m "feat(sidebar): add SidebarUser profile + exit chip"
```

---

## Task 17: Replace AppSidebar footer

**Files:**
- Modify: `frontend/src/components/AppSidebar.tsx`

- [ ] **Step 1: Drop the `LogOut` and unused sidebar imports**

In `AppSidebar.tsx`, remove `LogOut` from the lucide import block at lines 1-16. Add `SidebarUser` import:

```typescript
import { SidebarUser } from "@/components/SidebarUser";
```

- [ ] **Step 2: Replace the `<SidebarFooter>` body**

Replace lines 185-196 (the entire `<SidebarFooter>` block):

```tsx
<SidebarFooter>
  <SidebarUser />
</SidebarFooter>
```

- [ ] **Step 3: Type-check / build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AppSidebar.tsx
git commit -m "feat(sidebar): swap Exit link for profile chip"
```

---

# Phase 5 — Verification

## Task 18: Manual verification

(No code changes — runs through the spec's Section 5 checklist against a live dev server.)

- [ ] **Step 1: Start the dev environment**

In one shell:
```bash
bench --site upande.local serve
```
(or however the Frappe site is normally started; the SPA is served by Frappe at `/scp_app`.)

In another shell:
```bash
cd frontend && npm run dev
```

- [ ] **Step 2: Cached-range filter switch**

Open the app, pick a date range you've visited before. Open dev-tools → Network tab. Switch greenhouse via the dropdown.
Expected: no new requests fire to `getScoutingEntriesChunk`, no overlay appears, chart updates in well under one second.

- [ ] **Step 3: Uncached month range**

Clear IndexedDB for the site (DevTools → Application → IndexedDB → delete the SCP database). Reload. Pick a 1-month range.
Expected: overlay appears, shows "Loading scouting data…", "X of Y weeks", percentage climbs 0→100. Overlay disappears when complete. Network panel shows one request per ISO week in range.

- [ ] **Step 4: Bandwidth comparison**

In the Network panel, for the 1-month range, sum the response sizes of all `getScoutingEntriesChunk` requests. Compare against a record from before this change (in git history if available, or by reverting the server change temporarily — optional).
Expected: total bytes are ~1/4 of pre-change. The server short-circuit kicks in.

- [ ] **Step 5: Collapsed sidebar**

Collapse the sidebar (click the panel toggle in the top-left).
Expected: name and email hide. Avatar remains visible. Exit icon remains visible below the avatar.

- [ ] **Step 6: Missing avatar fallback**

In Frappe desk, open your User record and clear the `user_image` field. Reload the SPA.
Expected: avatar falls back to your initials (e.g., "KT" for "Kai Tetenge"). Page renders fine. Set the image back when done.

- [ ] **Step 7: Pre-warm runs without error**

Run:
```bash
bench --site upande.local execute upande_scp.serverscripts.scouting_prewarm.daily_prewarm
```
Expected: returns silently. In Redis, confirm keys exist:
```bash
bench --site upande.local console
>>> import frappe; frappe.cache().get_keys("scp:scouting_payload_v2:*")
```
Expected: at least 5 keys for recent weeks.

- [ ] **Step 8: Final report**

Tick this checklist:
- [ ] Filter switch on cached range = no overlay, instant.
- [ ] Uncached range shows overlay with progress and week counter.
- [ ] Overlay disappears at 100%.
- [ ] Network shows weekly chunks only, total bytes ≪ pre-change.
- [ ] Sidebar: profile shows full name + email + avatar.
- [ ] Collapsed sidebar: avatar + exit icon stacked.
- [ ] Avatar fallback works for users without an image.
- [ ] Pre-warm job populates Redis without errors.

---

## Notes for the executor

1. **Run the backend tests after each Phase-1 task.** They're fast (`< 1s`) and catch regressions immediately.
2. **The `_build_month_entries` function keeps its name** even though it now serves weeks. Renaming it is out of scope — the docstring already says it accepts any range. A rename would touch a lot of `git blame` lines for no functional gain.
3. **Don't delete `LoadingStrip.tsx`.** `App.tsx`'s `PageFallback` keeps using it for code-loading Suspense fallback. That's a different concern from data-loading and the thin strip is the right weight there.
4. **The old monthly cache keys (`scp:scouting_payload_v2:<v>:YYYY-MM`)** will orphan and TTL out — no manual flush needed. If you want them gone faster, `invalidate_scouting_payload()` (already exists) bumps the version stamp and nullifies them instantly.
5. **`useRealtime("scp:scouting:dirty", …)` still talks in months.** The handler calls `invalidateMonth(month)` which expands months into weeks via `weeksBetween` and clears those entries from the loaded-weeks registry — already correct, no change needed.
