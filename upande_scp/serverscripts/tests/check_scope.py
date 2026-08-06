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
