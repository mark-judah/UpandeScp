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
