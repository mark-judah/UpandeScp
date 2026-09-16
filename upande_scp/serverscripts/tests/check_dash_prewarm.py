"""Checks for the dashboard-aggregate prewarm and the lookup indexes.

Not a FrappeTestCase (`bench run-tests` is broken on this bench); run via:

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.check_dash_prewarm.run

Read-only against the data: the prewarm only fills Redis keys, and the index
check only reads INFORMATION_SCHEMA. Nothing writes to a scouting table.

What is being pinned, and why each one earns its place:

  1. The prewarm warms the keys the FRONTEND ACTUALLY ASKS FOR. Captured from
     the live app: a dashboard opens with {from_date: today-30d, to_date: today,
     crop, farm: "", greenhouse: ""}. Warming any other key is wasted work and
     leaves the real one cold, which is the failure this whole change exists to
     fix — so the window is asserted, not assumed.
  2. `job_id` must stay OUT of the cache key, or every request is a unique key
     and the cache can never hit at all.
  3. The prewarm is idempotent: a second run must be cache reads, not rebuilds.
  4. The greenhouse/block/crop-leading indexes exist AND the optimizer chooses
     them without a hint. An index that exists but is never selected buys
     nothing — that is precisely the state production v15 is in.
"""

import datetime
import time

import frappe


def run():
    _warms_the_window_the_frontend_asks_for()
    _job_id_is_not_in_the_cache_key()
    _second_run_is_cheap()
    _indexes_exist_and_are_chosen()
    print("check_dash_prewarm: 4 passed")


def _warms_the_window_the_frontend_asks_for():
    from upande_scp.serverscripts.dashboard_aggregates import prewarm

    from_date, to_date = prewarm._default_window()
    today = datetime.date.today()
    assert to_date == today.isoformat(), f"to_date should be today, got {to_date}"
    expected_from = (today - datetime.timedelta(days=30)).isoformat()
    assert from_date == expected_from, (
        f"the app opens on a 30-day window; prewarm used {from_date}..{to_date}"
    )

    out = prewarm.prewarm_dashboard_aggregates()
    assert out["failed"] == 0, f"prewarm reported failures: {out}"
    assert out["warmed"] > 0, f"prewarm warmed nothing: {out}"

    # The key the prewarm filled must be the key a default dashboard open reads.
    from upande_scp.serverscripts.dashboard_aggregates._common import (
        _build_key,
    )
    key = _build_key(
        "overview",
        {
            "from_date": from_date,
            "to_date": to_date,
            "crop": "",
            "farm": "",
            "greenhouse": "",
        },
    )
    assert frappe.cache().get_value(key) is not None, (
        "prewarm ran but the default overview key is cold — it is warming "
        f"something else. key={key}"
    )


def _job_id_is_not_in_the_cache_key():
    """A per-request id inside the key would make every request a miss."""
    # NB: import the module by its full path. The package `__init__` rebinds
    # the name `_overview` to the overview *function*, so
    # `from ...dashboard_aggregates import _overview` hands back a function,
    # not the module.
    from upande_scp.serverscripts.dashboard_aggregates._overview import overview

    base = dict(
        from_date="2026-07-01", to_date="2026-07-13",
        crop="Rose", farm="", greenhouse="",
    )
    a = overview(dict(base, job_id="job-aaaa"), force=False)
    t0 = time.time()
    b = overview(dict(base, job_id="job-bbbb"), force=False)
    second = time.time() - t0

    assert a == b, "same filters with a different job_id returned different data"
    assert second < 0.5, (
        f"a different job_id forced a rebuild ({second:.2f}s) — job_id has "
        "leaked into the cache key and the cache will never hit"
    )


def _second_run_is_cheap():
    from upande_scp.serverscripts.dashboard_aggregates import prewarm

    prewarm.prewarm_dashboard_aggregates()          # ensure warm
    t0 = time.time()
    out = prewarm.prewarm_dashboard_aggregates()    # must be Redis reads
    elapsed = time.time() - t0
    assert out["failed"] == 0, f"second prewarm reported failures: {out}"
    assert elapsed < 3.0, (
        f"second prewarm took {elapsed:.1f}s — it is rebuilding rather than "
        "reading cached keys, so running it every 10 minutes would be costly"
    )


def _indexes_exist_and_are_chosen():
    expected = {
        "tabScouting Entry": [
            ("scouting_gh_date_idx", "greenhouse,date_of_capture"),
            ("scouting_block_date_idx", "block,date_of_capture"),
            ("scouting_crop_date_idx", "crop_scouted,date_of_capture"),
        ],
        "tabPests Scouting Entry": [("pests_parent_cover", None)],
        "tabDiseases Scouting Entry": [("diseases_parent_cover", None)],
        "tabTrap Scouting Entry": [("traps_parent_cover", None)],
    }
    for table, indexes in expected.items():
        for name, cols in indexes:
            rows = frappe.db.sql(
                "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) "
                "FROM information_schema.STATISTICS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s "
                "AND INDEX_NAME = %s",
                (table, name),
            )
            got = rows[0][0] if rows else None
            assert got, f"{table}.{name} is missing — run add_scouting_lookup_indexes"
            if cols:
                assert got == cols, f"{table}.{name} is ({got}), expected ({cols})"

    # Existing is not enough: production v15 HAS a usable composite and the
    # optimizer refuses it, which is worth exactly nothing. Assert the choice.
    gh = frappe.db.sql(
        "SELECT greenhouse FROM `tabScouting Entry` "
        "WHERE greenhouse IS NOT NULL AND greenhouse != '' LIMIT 1"
    )
    if gh:
        plan = frappe.db.sql(
            "EXPLAIN SELECT COUNT(*) FROM `tabScouting Entry` "
            "WHERE greenhouse = %s AND date_of_capture BETWEEN %s AND %s",
            (gh[0][0], "2026-01-01", "2026-12-31"),
            as_dict=True,
        )
        chosen = (plan[0] or {}).get("key") if plan else None
        assert chosen == "scouting_gh_date_idx", (
            f"optimizer chose {chosen!r} for a greenhouse+date-range read, not "
            "scouting_gh_date_idx — the index exists but is not being used"
        )
