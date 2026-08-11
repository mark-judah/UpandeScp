# Serverscripts Functional Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all 41 loose modules under `upande_scp/serverscripts/` into 7 functional subpackages, rewriting every dotted-path reference so nothing breaks at runtime.

**Architecture:** Pure relocation. Every cross-reference — internal and external — uses one of two absolute forms (`upande_scp.serverscripts.<mod>` or `from upande_scp.serverscripts import <mod>`); there are zero relative imports. A single scripted rewrite handles both forms uniformly and safely (an `_`-aware match prevents `scouting_metrics` from clobbering `scouting_metrics_api`). One package per task/commit, each self-verified by a resolver that confirms every frontend call-string still resolves to a whitelisted function.

**Tech Stack:** Frappe (Python), React/TypeScript frontend (call-strings), Python `unittest`, bash + Python helper scripts.

## Global Constraints

- **No behavior changes.** Pure move + reference rewrite. No signature, endpoint, or logic changes.
- **No compatibility shims.** All references are rewritten to the new path.
- **Do NOT touch** the existing subpackages' internal layout (`spray_plan_creator/`, `dashboard_aggregates/`, `mobile/`, `tests/`) — but their *files* that reference a moved module DO get their reference rewritten (e.g. `dashboard_aggregates/*.py` import `scouting_metrics`).
- **No `Co-Authored-By` trailer** on any commit (repo rule).
- **Only commit the refactor changes** — `git add upande_scp frontend/src` (never `git add -A`; the untracked `docs/` spec+plan and `.superpowers/` ledger stay out).
- **Do NOT rewrite** `.claude/settings.local.json` (developer-local bench-execute permission patterns) or `docs/**` (historical prose). The rewrite scope is code + shipped fixtures only.
- Paths: app root `/home/ubuntu/stive/code/frappe15/apps/upande_scp`; bench env python `/home/ubuntu/stive/code/frappe15/env/bin/python`; scratchpad `/tmp/claude-1001/-home-ubuntu-stive-code-frappe15-apps-upande-scp/a8af0d3e-4a44-44d3-8d59-aaabea670d65/scratchpad` (referred to below as `$SP`).
- Baseline backend test state (unrelated to this refactor, must not worsen): `unittest discover` over `serverscripts/tests` = **1 failure + 9 errors** (tests needing a live bench site).
- Never use any Kaitet MCP tool.

## Package → module map (all 41 modules)

| Package | Modules |
|---|---|
| `scouting/` | get_avocado_scouting, get_complete_scouting_entries, get_scouting_analysis, get_scouting_observations, get_scouting_report, scouting_metrics, scouting_metrics_api, scouting_prewarm, get_heatmap_data, observation_colors, get_trap_data, populate_severity_defaults |
| `geo/` | geo_builders, get_beds_and_zones, get_orchard_trees, bed_zone_automation, run_tree_automation, get_tanks_valves, warehouse_filter, populate_avocado |
| `reports/` | send_chemical_progress_email, send_daily_scouting_report, send_fcm_weekly_excel_report, send_weekly_trap_report, report_recipients |
| `store/` | store_keeper_api, store_label_printing, ordering_api, thresholds_api, get_bom_stock_balances, create_bom, create_application_work_order |
| `qr/` | qr_generator, regenerate_qrs |
| `spray_plan_ops/` | spray_plan_approval, spray_plan_labels, validate_frac_irac_guidelines |
| `common/` | cache_utils, _debug_errors, get_workspace_stats, weather |

Execution order (lowest blast radius first): qr → reports → spray_plan_ops → geo → store → scouting → common.

---

### Task 1: Tooling, baseline, and pilot package (`qr/`)

Builds the two reusable helper scripts + the per-package driver, records the resolver baseline, then executes the smallest package (`qr/`) end-to-end as the pilot.

**Files:**
- Create (scratchpad, NOT committed): `$SP/rewrite_refs.py`, `$SP/resolve_check.py`, `$SP/run_group.sh`
- Move: `upande_scp/serverscripts/qr_generator.py`, `upande_scp/serverscripts/regenerate_qrs.py` → `upande_scp/serverscripts/qr/`
- Create: `upande_scp/serverscripts/qr/__init__.py`
- Modify (via rewrite): any file referencing `qr_generator` / `regenerate_qrs` — notably `spray_plan_approval.py` and `spray_plan_labels.py` (both import `qr_generator`).

**Interfaces:**
- Produces (for Tasks 2-7): `$SP/run_group.sh <package> <module...>` — creates the package, `git mv`s the modules, rewrites all references, and runs the zero-old-path / import / resolver checks. And the resolver baseline number recorded below.

- [ ] **Step 1: Write the reference-rewrite helper**

Create `$SP/rewrite_refs.py`:

```python
#!/usr/bin/env python3
"""Rewrite serverscripts dotted-path references after moving modules into a subpackage.

Usage: rewrite_refs.py <package> <module1> [<module2> ...]

For each module M, over git-tracked text files (frontend/src + upande_scp,
extensions .py/.ts/.tsx/.js/.json; excluding docs/, .claude/, node_modules,
*/dist/*, __pycache__):
  A) upande_scp.serverscripts.M   (M not followed by an identifier char)
        -> upande_scp.serverscripts.<package>.M
  B) from upande_scp.serverscripts import M
        -> from upande_scp.serverscripts.<package> import M
The '_'-aware negative lookahead means 'scouting_metrics' never matches inside
'scouting_metrics_api'. Prints per-file counts and a total.
"""
import re, subprocess, sys

pkg = sys.argv[1]
mods = sys.argv[2:]

files = subprocess.check_output(["git", "ls-files"], text=True).splitlines()

def keep(f):
    if f.startswith("docs/") or f.startswith(".claude/") or "node_modules/" in f:
        return False
    if "/dist/" in f or "__pycache__" in f:
        return False
    if not (f.startswith("frontend/src") or f.startswith("upande_scp/")):
        return False
    return f.endswith((".py", ".ts", ".tsx", ".js", ".json"))

files = [f for f in files if keep(f)]
total = 0
for m in mods:
    reA = re.compile(r"(upande_scp\.serverscripts\.)(" + re.escape(m) + r")(?![A-Za-z0-9_])")
    reB = re.compile(r"from\s+upande_scp\.serverscripts\s+import\s+(" + re.escape(m) + r")(?![A-Za-z0-9_])")
    for f in files:
        with open(f, encoding="utf-8") as fh:
            src = fh.read()
        new, nA = reA.subn(r"\g<1>" + pkg + r".\g<2>", src)
        new, nB = reB.subn("from upande_scp.serverscripts." + pkg + r" import \g<1>", new)
        if nA + nB:
            with open(f, "w", encoding="utf-8") as fh:
                fh.write(new)
            print(f"  {f}: +{nA + nB}")
            total += nA + nB
print(f"TOTAL replacements: {total}")
```

- [ ] **Step 2: Write the resolver check**

Create `$SP/resolve_check.py`:

```python
#!/usr/bin/env python3
"""Verify every serverscripts call-string in frontend/src resolves to a whitelisted fn.
Exits nonzero (and lists failures) if any does not. Run with the bench env python."""
import re, subprocess, sys
import frappe
try:
    frappe.init(site="kaitet.local")
except Exception:
    pass

files = subprocess.check_output(["git", "ls-files", "frontend/src"], text=True).splitlines()
pat = re.compile(r"upande_scp\.serverscripts\.[A-Za-z0-9_.]+")
paths = set()
for f in files:
    try:
        paths.update(pat.findall(open(f, encoding="utf-8").read()))
    except Exception:
        pass

bad = []
for p in sorted(paths):
    try:
        fn = frappe.get_attr(p)
    except Exception as e:
        bad.append((p, f"resolve error: {e}")); continue
    if not callable(fn):
        bad.append((p, "not callable"))
    elif not getattr(fn, "whitelisted", False):
        bad.append((p, "not whitelisted"))
print(f"call-strings: {len(paths)}; OK: {len(paths) - len(bad)}; FAILED: {len(bad)}")
for p, why in bad:
    print(f"  FAIL {p}: {why}")
sys.exit(1 if bad else 0)
```

- [ ] **Step 3: Write the per-package driver**

Create `$SP/run_group.sh`:

```bash
#!/usr/bin/env bash
# Usage: run_group.sh <package> <module1> [<module2> ...]
set -euo pipefail
APP=/home/ubuntu/stive/code/frappe15/apps/upande_scp
PY=/home/ubuntu/stive/code/frappe15/env/bin/python
SP=/tmp/claude-1001/-home-ubuntu-stive-code-frappe15-apps-upande-scp/a8af0d3e-4a44-44d3-8d59-aaabea670d65/scratchpad
cd "$APP"
PKG="$1"; shift
MODS=("$@")

echo "== create package upande_scp/serverscripts/$PKG =="
mkdir -p "upande_scp/serverscripts/$PKG"
[ -f "upande_scp/serverscripts/$PKG/__init__.py" ] || : > "upande_scp/serverscripts/$PKG/__init__.py"

echo "== git mv modules =="
for m in "${MODS[@]}"; do
  git mv "upande_scp/serverscripts/$m.py" "upande_scp/serverscripts/$PKG/$m.py"
done

echo "== rewrite references =="
"$PY" "$SP/rewrite_refs.py" "$PKG" "${MODS[@]}"

echo "== verify: zero old-path references =="
fail=0
for m in "${MODS[@]}"; do
  # Old-path leftover = `serverscripts.$m` where $m is NOT followed by an
  # identifier char. `.` MUST stay matchable (a leftover method ref is
  # `serverscripts.$m.func`); the correct new path `serverscripts.$PKG.$m`
  # never has $m right after `serverscripts.`, so it can't false-match.
  hits=$(grep -rnE "(upande_scp\.serverscripts\.$m([^A-Za-z0-9_]|$))|(from upande_scp\.serverscripts import $m([^A-Za-z0-9_]|$))" -- frontend/src upande_scp || true)
  if [ -n "$hits" ]; then echo "OLD-PATH LEFT for $m:"; echo "$hits"; fail=1; fi
done
[ "$fail" = 0 ] || { echo "FAILED: old-path references remain"; exit 1; }
echo "  OK: no old-path references"

echo "== verify: new modules import =="
"$PY" -c "import importlib
for m in '${MODS[*]}'.split():
    importlib.import_module('upande_scp.serverscripts.$PKG.' + m)
print('  OK: imports')"

echo "== resolver check (frontend call-strings) =="
"$PY" "$SP/resolve_check.py"
echo "== run_group DONE for $PKG =="
```

- [ ] **Step 4: Record the resolver baseline (before any move)**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python "$SP/resolve_check.py"` (substitute the real `$SP` path).
Expected: prints `call-strings: <N>; OK: <N>; FAILED: 0`. **Record N and the FAILED count.** If FAILED > 0 at baseline, those are pre-existing; note each — later runs must not exceed this count. (Exit code nonzero only if FAILED>0; that's the pre-existing state, not this task's fault.)

- [ ] **Step 5: Run the pilot package `qr/`**

Run: `bash "$SP/run_group.sh" qr qr_generator regenerate_qrs`
Expected: creates `qr/__init__.py`, moves both files, rewrites references (expect hits in at least `spray_plan_approval.py`, `spray_plan_labels.py`, `regenerate_qrs.py` itself), prints `OK: no old-path references`, `OK: imports`, and resolver `FAILED: 0` (or == baseline).

- [ ] **Step 6: Frontend build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: succeeds, no TS errors (pre-existing chunk-size warnings are fine).

- [ ] **Step 7: Backend test suite unchanged**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest discover -s upande_scp/serverscripts/tests -p 'test_*.py' 2>&1 | tail -3`
Expected: same as baseline — `FAILED (failures=1, errors=9)`. Not worse.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp frontend/src
git commit -m "refactor(scp): group qr serverscripts into serverscripts/qr/"
```

---

### Task 2: `reports/`

**Files:**
- Move → `upande_scp/serverscripts/reports/`: send_chemical_progress_email, send_daily_scouting_report, send_fcm_weekly_excel_report, send_weekly_trap_report, report_recipients (+ create `reports/__init__.py`)
- Modify (via rewrite): `upande_scp/hooks.py` (scheduler entries for the four `send_*` jobs); the `send_*` modules that import `report_recipients`.

- [ ] **Step 1: Run the package move + rewrite + verify**

Run: `bash "$SP/run_group.sh" reports send_chemical_progress_email send_daily_scouting_report send_fcm_weekly_excel_report send_weekly_trap_report report_recipients`
Expected: `OK: no old-path references`, `OK: imports`, resolver `FAILED: 0` (or == baseline).

- [ ] **Step 2: Confirm the hooks.py scheduler paths were rewritten**

Run: `grep -nE "serverscripts\.(reports\.)?(send_chemical_progress_email|send_daily_scouting_report|send_fcm_weekly_excel_report|send_weekly_trap_report)" upande_scp/hooks.py`
Expected: every hit shows `serverscripts.reports.<module>` — no bare `serverscripts.<send_module>` remains.

- [ ] **Step 3: Frontend build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: succeeds, no TS errors.

- [ ] **Step 4: Backend test suite unchanged**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest discover -s upande_scp/serverscripts/tests -p 'test_*.py' 2>&1 | tail -3`
Expected: `FAILED (failures=1, errors=9)`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp frontend/src
git commit -m "refactor(scp): group report/email serverscripts into serverscripts/reports/"
```

---

### Task 3: `spray_plan_ops/`

**Files:**
- Move → `upande_scp/serverscripts/spray_plan_ops/`: spray_plan_approval, spray_plan_labels, validate_frac_irac_guidelines (+ create `spray_plan_ops/__init__.py`)
- Modify (via rewrite): `send_chemical_progress_email.py` (now in `reports/`; imports `spray_plan_approval._derive_farm`), `store_label_printing.py` (imports `spray_plan_labels`), frontend Approvals refs to `spray_plan_approval`.
- Modify (manual, Step 2): `upande_scp/shared/label_tiers.json` — the `_doc` comment naming `upande_scp.serverscripts.spray_plan_labels` (prose accuracy).

- [ ] **Step 1: Run the package move + rewrite + verify**

Run: `bash "$SP/run_group.sh" spray_plan_ops spray_plan_approval spray_plan_labels validate_frac_irac_guidelines`
Expected: `OK: no old-path references`, `OK: imports`, resolver `FAILED: 0` (or == baseline).

- [ ] **Step 2: Update the label_tiers.json doc comment**

Edit `upande_scp/shared/label_tiers.json`: in the `_doc` string, change `upande_scp.serverscripts.spray_plan_labels` to `upande_scp.serverscripts.spray_plan_ops.spray_plan_labels`. (Comment-only; the rewrite script already covers `.json`, so this may already be done — verify with `grep -n spray_plan_labels upande_scp/shared/label_tiers.json` and only edit if the old path remains.)

- [ ] **Step 3: Frontend build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: succeeds, no TS errors.

- [ ] **Step 4: Backend test suite unchanged**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest discover -s upande_scp/serverscripts/tests -p 'test_*.py' 2>&1 | tail -3`
Expected: `FAILED (failures=1, errors=9)`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp frontend/src
git commit -m "refactor(scp): group spray-plan ops serverscripts into serverscripts/spray_plan_ops/"
```

---

### Task 4: `geo/`

**Files:**
- Move → `upande_scp/serverscripts/geo/`: geo_builders, get_beds_and_zones, get_orchard_trees, bed_zone_automation, run_tree_automation, get_tanks_valves, warehouse_filter, populate_avocado (+ create `geo/__init__.py`)
- Modify (via rewrite): `upande_scp/public/js/bed_and_zone_automation.js` (method `bed_zone_automation.create_beds_and_zones`); `scouting_metrics_api.py` + `scouting_metrics.py` (import `geo_builders` / `warehouse_filter`); `geo_builders.py` (imports `warehouse_filter`); `tests/test_orchard_tree_rows.py` (imports `get_orchard_trees`).

- [ ] **Step 1: Run the package move + rewrite + verify**

Run: `bash "$SP/run_group.sh" geo geo_builders get_beds_and_zones get_orchard_trees bed_zone_automation run_tree_automation get_tanks_valves warehouse_filter populate_avocado`
Expected: `OK: no old-path references`, `OK: imports`, resolver `FAILED: 0` (or == baseline).

- [ ] **Step 2: Confirm the public/js method path was rewritten**

Run: `grep -n "serverscripts" upande_scp/public/js/bed_and_zone_automation.js`
Expected: shows `upande_scp.serverscripts.geo.bed_zone_automation.create_beds_and_zones`.

- [ ] **Step 3: Frontend build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: succeeds, no TS errors.

- [ ] **Step 4: Backend test suite unchanged**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest discover -s upande_scp/serverscripts/tests -p 'test_*.py' 2>&1 | tail -3`
Expected: `FAILED (failures=1, errors=9)`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp frontend/src
git commit -m "refactor(scp): group geo/orchard serverscripts into serverscripts/geo/"
```

---

### Task 5: `store/`

**Files:**
- Move → `upande_scp/serverscripts/store/`: store_keeper_api, store_label_printing, ordering_api, thresholds_api, get_bom_stock_balances, create_bom, create_application_work_order (+ create `store/__init__.py`)
- Modify (via rewrite): frontend (`store-keeper-api.ts`, `labels-api.ts`, and any other call-strings); `store_label_printing.py` (`from upande_scp.serverscripts import store_keeper_api`); `scouting_metrics_api.py` (imports `get_bom_stock_balances`); `tests/` importing `store_keeper_api` (e.g. `test_store_overview_buckets.py`, `test_transfer_submit.py`).

- [ ] **Step 1: Run the package move + rewrite + verify**

Run: `bash "$SP/run_group.sh" store store_keeper_api store_label_printing ordering_api thresholds_api get_bom_stock_balances create_bom create_application_work_order`
Expected: `OK: no old-path references`, `OK: imports`, resolver `FAILED: 0` (or == baseline).

- [ ] **Step 2: Confirm the test imports were rewritten (the feature we just shipped)**

Run: `grep -rn "serverscripts.*store_keeper_api" upande_scp/serverscripts/tests`
Expected: every hit is `upande_scp.serverscripts.store.store_keeper_api` — no bare `serverscripts.store_keeper_api`.

- [ ] **Step 3: Run the store/biometric unit tests explicitly**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest upande_scp.serverscripts.tests.test_transfer_submit upande_scp.serverscripts.tests.test_store_overview_buckets -v 2>&1 | tail -5`
Expected: all pass (imports now resolve at the new path).

- [ ] **Step 4: Frontend build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: succeeds, no TS errors.

- [ ] **Step 5: Backend test suite unchanged**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest discover -s upande_scp/serverscripts/tests -p 'test_*.py' 2>&1 | tail -3`
Expected: `FAILED (failures=1, errors=9)`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp frontend/src
git commit -m "refactor(scp): group store/chemical serverscripts into serverscripts/store/"
```

---

### Task 6: `scouting/`

**Files:**
- Move → `upande_scp/serverscripts/scouting/`: get_avocado_scouting, get_complete_scouting_entries, get_scouting_analysis, get_scouting_observations, get_scouting_report, scouting_metrics, scouting_metrics_api, scouting_prewarm, get_heatmap_data, observation_colors, get_trap_data, populate_severity_defaults (+ create `scouting/__init__.py`)
- Modify (via rewrite): `upande_scp/hooks.py` (`observation_colors.after_migrate`; `scouting_prewarm.daily_prewarm`/`hourly_prewarm`); `upande_scp/www/scp_app.py` (`from upande_scp.serverscripts import scouting_metrics_api as api`); `upande_scp/fixtures/custom_html_block.json` (`get_scouting_analysis.getScoutingAnalysis`); `dashboard_aggregates/*.py` (7 files: `from upande_scp.serverscripts import scouting_metrics`); internal scouting cross-imports (`get_complete_scouting_entries`, `scouting_metrics_api`, `observation_colors`); heavy frontend call-strings.

- [ ] **Step 1: Run the package move + rewrite + verify**

Run: `bash "$SP/run_group.sh" scouting get_avocado_scouting get_complete_scouting_entries get_scouting_analysis get_scouting_observations get_scouting_report scouting_metrics scouting_metrics_api scouting_prewarm get_heatmap_data observation_colors get_trap_data populate_severity_defaults`
Expected: `OK: no old-path references`, `OK: imports`, resolver `FAILED: 0` (or == baseline).

- [ ] **Step 2: Confirm the critical non-frontend references were rewritten**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
grep -nE "serverscripts\.(scouting\.)?(observation_colors|scouting_prewarm)" upande_scp/hooks.py
grep -n "serverscripts" upande_scp/www/scp_app.py
grep -o "upande_scp\.serverscripts\.[a-zA-Z0-9_.]*" upande_scp/fixtures/custom_html_block.json | sort -u
grep -rn "from upande_scp.serverscripts import scouting_metrics" upande_scp/serverscripts/dashboard_aggregates
```
Expected: hooks show `serverscripts.scouting.observation_colors` / `.scouting.scouting_prewarm`; `scp_app.py` shows `from upande_scp.serverscripts.scouting import scouting_metrics_api as api`; the fixture shows `serverscripts.scouting.get_scouting_analysis...` (and the still-unmoved `get_workspace_stats`); `dashboard_aggregates` grep returns **no** hits (all rewritten to `.scouting import scouting_metrics`).

- [ ] **Step 3: Frontend build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build`
Expected: succeeds, no TS errors.

- [ ] **Step 4: Backend test suite unchanged + dashboard tests pass**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
/home/ubuntu/stive/code/frappe15/env/bin/python -m unittest discover -s upande_scp/serverscripts/tests -p 'test_*.py' 2>&1 | tail -3
```
Expected: `FAILED (failures=1, errors=9)` — unchanged (the dashboard_aggregates tests that import scouting_metrics still import/collect the same way).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp frontend/src
git commit -m "refactor(scp): group scouting serverscripts into serverscripts/scouting/"
```

---

### Task 7: `common/` + final sweep

**Files:**
- Move → `upande_scp/serverscripts/common/`: cache_utils, _debug_errors, get_workspace_stats, weather (+ create `common/__init__.py`)
- Modify (via rewrite): `upande_scp/hooks.py` (`_SCP_CACHE_INVALIDATOR = cache_utils.invalidate_on_change`, `_SCP_REALTIME_DIRTY = cache_utils.publish_scouting_dirty`); `upande_scp/fixtures/custom_html_block.json` (`get_workspace_stats.getWorkspaceStats`); the many modules importing `cache_utils` (Pattern A and B); `tests/test_cache_invalidation.py` (`from upande_scp.serverscripts import cache_utils as cu`).

- [ ] **Step 1: Run the package move + rewrite + verify**

Run: `bash "$SP/run_group.sh" common cache_utils _debug_errors get_workspace_stats weather`
Expected: `OK: no old-path references`, `OK: imports`, resolver `FAILED: 0` (or == baseline).

- [ ] **Step 2: Confirm the cache-invalidator hook vars + fixture were rewritten**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
grep -nE "serverscripts\.(common\.)?cache_utils" upande_scp/hooks.py
grep -o "upande_scp\.serverscripts\.[a-zA-Z0-9_.]*" upande_scp/fixtures/custom_html_block.json | sort -u
```
Expected: hooks show `serverscripts.common.cache_utils.invalidate_on_change` and `...publish_scouting_dirty`; fixture shows `serverscripts.common.get_workspace_stats.getWorkspaceStats` (and `serverscripts.scouting.get_scouting_analysis...` from Task 6).

- [ ] **Step 3: Final sweep — no loose module remains anywhere**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
echo "=== loose .py still at serverscripts top level (want only __init__.py) ==="
ls upande_scp/serverscripts/*.py
echo "=== any old-shape references remaining across the whole app ==="
/home/ubuntu/stive/code/frappe15/env/bin/python - <<'PY'
import re, subprocess
PKGS = {"scouting","geo","reports","store","qr","spray_plan_ops","common",
        "spray_plan_creator","dashboard_aggregates","mobile","tests"}
files = subprocess.check_output(["git","ls-files"], text=True).splitlines()
pat = re.compile(r"upande_scp\.serverscripts\.([A-Za-z0-9_]+)")
bad = []
for f in files:
    if f.startswith("docs/") or f.startswith(".claude/") or "node_modules/" in f: continue
    if not (f.startswith("frontend/src") or f.startswith("upande_scp/")): continue
    if not f.endswith((".py",".ts",".tsx",".js",".json")): continue
    try: src = open(f, encoding="utf-8").read()
    except Exception: continue
    for lineno, line in enumerate(src.splitlines(), 1):
        for seg in pat.findall(line):
            if seg not in PKGS:   # first segment must be a package now
                bad.append(f"{f}:{lineno}: upande_scp.serverscripts.{seg}")
for b in bad: print("  STALE:", b)
print(f"stale references: {len(bad)}")
PY
```
Expected: `ls` prints only `upande_scp/serverscripts/__init__.py`; the sweep prints `stale references: 0`. Also check the `from upande_scp.serverscripts import <mod>` form is fully migrated:
```bash
grep -rnE "from upande_scp\.serverscripts import [a-z]" -- frontend/src upande_scp | grep -vE "import (scouting|geo|reports|store|qr|spray_plan_ops|common|spray_plan_creator|dashboard_aggregates|mobile|tests)\b" || echo "  none (all module-object imports migrated)"
```
Expected: `none`.

- [ ] **Step 4: Frontend build + full backend suite**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && yarn build && yarn test
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && /home/ubuntu/stive/code/frappe15/env/bin/python -m unittest discover -s upande_scp/serverscripts/tests -p 'test_*.py' 2>&1 | tail -3
```
Expected: build clean; Vitest 21/21; backend `FAILED (failures=1, errors=9)` (unchanged baseline).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp frontend/src
git commit -m "refactor(scp): group common/util serverscripts into serverscripts/common/"
```

---

## Final verification checklist (after all 7 tasks)

- [ ] `upande_scp/serverscripts/` top level contains only `__init__.py` + subpackages.
- [ ] The Task-7 stale-reference sweep reports `stale references: 0`.
- [ ] Resolver check `FAILED` count == the Task-1 baseline (ideally 0).
- [ ] `yarn build` clean; Vitest 21/21; backend suite still `1 failure + 9 errors` (no new breakage).
- [ ] `git log --oneline` shows 7 focused `refactor(scp): group … serverscripts` commits.

## Manual/runtime verification note

The resolver confirms every frontend call-string imports and is whitelisted, but does not exercise the live endpoints, scheduler jobs, `after_migrate`, or the custom-HTML-block fixture in a running site. After merge, on `kaitet.local`, sanity-check: (1) `bench --site kaitet.local migrate` runs (exercises `after_migrate` → `scouting.observation_colors`); (2) the scouting map / dashboard pages load (frontend call-strings); (3) a scheduled report can be triggered. These are smoke checks, not blockers to the code refactor.

## `.claude/settings.local.json` note

That file's bench-execute permission patterns for `serverscripts._debug_errors.*` (and an ad-hoc `serverscripts._bio_smoke.run`) will go stale once `_debug_errors` moves to `common/`. It is developer-local config (not shipped, deliberately excluded from the rewrite). Update those patterns locally only if the stale permission prompts become annoying; not part of this refactor.
