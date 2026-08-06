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
