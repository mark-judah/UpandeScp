"""Behavioural check for Task 5: the diagnose row cache must be keyed on
(greenhouse, window, crop) only — NOT on the pest/section/stage chips.

Before the fix, `application_plan_diagnose` mixed the chips into the same
cache key it used for the underlying SQL, so every chip click minted a
fresh Redis key and recomputed the identical rows from scratch. This
monkeypatches `_query_kind` to count how many times the SQL actually runs
and asserts that changing the pest chip does not trigger a second run.

Not a FrappeTestCase (`bench run-tests` is broken on this bench); run via:

    bench --site kaitet.local execute \\
        upande_scp.serverscripts.tests.check_diagnose_cache.run
"""


def run():
    _chip_change_reuses_the_row_cache()
    print("check_diagnose_cache: 1 passed")


def _chip_change_reuses_the_row_cache():
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
            "from_date": "2026-07-01", "to_date": "2026-07-13",
            "crop": "Rose", "greenhouse": "Torongo GH 16 - KR", "job_id": "",
        }
        first_result = _application_plan.application_plan_diagnose(
            dict(base), force=True,
        )
        first = len(calls)
        assert first > 0, "expected _query_kind to run on the cold/forced call"

        pests = first_result["filterOpts"]["pests"]
        pest = pests[0] if pests else "_no_pest_present_in_fixture"

        _application_plan.application_plan_diagnose(dict(base, pest=pest))
        assert len(calls) == first, (
            f"changing the pest chip re-ran the SQL ({len(calls)} calls total, "
            f"expected to stay at {first}); the row cache key must exclude "
            "pest/section/stage"
        )
    finally:
        _application_plan._query_kind = original
