def run():
    _splits_by_warehouse_type()
    _defaults_unknown_to_greenhouse()
    _greenhouse_only_emits_no_OR()
    _mixed_scope_covers_both()
    _data_invariant_holds()
    print('check_scope: 5 passed')


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

def _data_invariant_holds():
    """partition_scope routes on warehouse_type and defaults unknown names
    to greenhouse; get_units_by_warehouse only sees non-disabled, non-group
    warehouses. Nothing enforces that the invariant this all rests on
    actually holds — e.g. disabling a Block warehouse would silently drop
    it from get_units_by_warehouse, default it to the greenhouse column,
    and the query would just return zero rows instead of erroring. Assert
    the invariant directly against the live data instead of trusting it:

        se.greenhouse populated -> warehouse_type Greenhouse : 100%
        se.block      populated -> warehouse_type Block      : 100%
        rows with BOTH columns set                           : 0
        greenhouse/block names matching no Warehouse         : 0

    Read-only (COUNT queries); asserts the invariant (zero violations), not
    the absolute row counts, since the data grows.
    """
    import frappe

    bad_gh = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabScouting Entry` se
        JOIN `tabWarehouse` w ON w.name = se.greenhouse
        WHERE se.greenhouse IS NOT NULL AND se.greenhouse != ''
          AND w.warehouse_type != 'Greenhouse'
    """)[0][0]
    assert bad_gh == 0, f"{bad_gh} se.greenhouse rows point at a non-Greenhouse warehouse"

    bad_block = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabScouting Entry` se
        JOIN `tabWarehouse` w ON w.name = se.block
        WHERE se.block IS NOT NULL AND se.block != ''
          AND w.warehouse_type != 'Block'
    """)[0][0]
    assert bad_block == 0, f"{bad_block} se.block rows point at a non-Block warehouse"

    both = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabScouting Entry`
        WHERE greenhouse IS NOT NULL AND greenhouse != ''
          AND block IS NOT NULL AND block != ''
    """)[0][0]
    assert both == 0, f"{both} Scouting Entry rows populate BOTH greenhouse and block"

    orphaned = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabScouting Entry` se
        LEFT JOIN `tabWarehouse` gw ON gw.name = se.greenhouse
        LEFT JOIN `tabWarehouse` bw ON bw.name = se.block
        WHERE (se.greenhouse IS NOT NULL AND se.greenhouse != '' AND gw.name IS NULL)
           OR (se.block IS NOT NULL AND se.block != '' AND bw.name IS NULL)
    """)[0][0]
    assert orphaned == 0, (
        f"{orphaned} Scouting Entry rows name a greenhouse/block with no matching Warehouse"
    )
