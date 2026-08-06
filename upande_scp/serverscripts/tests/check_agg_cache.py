"""Behavioural + perf check for the debounced dashboard-aggregate cache.

Verifies the design in dashboard_aggregates._common (DASH_AGG_TTL comment):

  1. A warm hit is a real cache hit — dramatically faster than cold, i.e.
     no recompute happens on the second call.
  2. A scouting write bumps the version stamp once; a burst of further
     writes inside the debounce window does NOT bump it again.
  3. After the debounce window elapses, a write bumps it again.

Not a FrappeTestCase (`bench run-tests` is broken on this bench); run via:

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.check_agg_cache.run

Read-only against the database: only Redis cache keys are touched (set /
delete), `tabScouting Entry` is never written to. The "scouting write"
trigger is simulated by calling ``bump_dash_agg_version()`` directly — the
exact call ``cache_utils.publish_scouting_dirty`` makes on every real
scouting write — instead of inserting rows. The debounce window's elapse
is simulated by deleting the lock key directly rather than sleeping the
real 60s, since the mechanism only cares whether the lock key exists.
"""

import time


def run():
    _warm_hit_skips_recompute()
    _debounce_suppresses_burst_bumps()
    _bump_resumes_after_debounce_window()
    print("check_agg_cache: 3 passed")


def _warm_hit_skips_recompute():
    from upande_scp.serverscripts import dashboard_aggregates as DA

    args = dict(from_date="2026-07-01", to_date="2026-07-13", crop="Rose")

    t0 = time.time()
    DA.overview(**args, force=1)
    cold_ms = (time.time() - t0) * 1000

    t0 = time.time()
    DA.overview(**args)
    warm_ms = (time.time() - t0) * 1000

    assert warm_ms < cold_ms / 10, (
        f"warm call ({warm_ms:.1f}ms) was not dramatically faster than cold "
        f"({cold_ms:.1f}ms) -- looks like a cache miss / recompute"
    )
    print(f"  warm hit: cold={cold_ms:.1f}ms warm={warm_ms:.1f}ms")


def _debounce_suppresses_burst_bumps():
    from upande_scp.serverscripts.dashboard_aggregates import _common as C

    cache = C.frappe.cache()
    cache.delete_value(C.K_DASH_AGG_BUMP_LOCK)  # start from a clean window

    before = C.dash_agg_version()
    C.bump_dash_agg_version()
    after_first = C.dash_agg_version()
    assert after_first == before + 1, (
        f"first write in a clean window should bump the stamp: {before} -> {after_first}"
    )

    for _ in range(5):
        C.bump_dash_agg_version()
    after_burst = C.dash_agg_version()
    assert after_burst == after_first, (
        f"a burst of writes inside the debounce window must not bump again: "
        f"{after_first} -> {after_burst}"
    )
    print(f"  debounce: write#1 {before}->{after_first}, burst of 5 held at {after_burst}")


def _bump_resumes_after_debounce_window():
    from upande_scp.serverscripts.dashboard_aggregates import _common as C

    before = C.dash_agg_version()

    # Simulate the debounce window elapsing: the mechanism only checks
    # whether the lock key exists, so deleting it is equivalent to waiting
    # out DASH_AGG_BUMP_DEBOUNCE (60s) without a real sleep.
    cache = C.frappe.cache()
    cache.delete_value(C.K_DASH_AGG_BUMP_LOCK)

    C.bump_dash_agg_version()
    after = C.dash_agg_version()
    assert after == before + 1, (
        f"a write after the debounce window elapsed should bump again: {before} -> {after}"
    )
    print(f"  post-window bump: {before} -> {after}")
