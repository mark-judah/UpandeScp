"""
scouting_metrics_api.py
=======================
Whitelisted, cached HTTP wrappers around ``scouting_metrics``. The dashboard
and any other UI consumer should call these endpoints so the raw SQL lives in
exactly one place.

Invalidation is driven by ``cache_utils.invalidate_on_change`` (hooked via
``hooks.py`` on Zone / Bed / Warehouse / Farm / Trap doc events), so the TTL
is mostly a safety net — edits flush immediately.
"""

import frappe

from upande_scp.serverscripts import scouting_metrics
from upande_scp.serverscripts.cache_utils import (
    K_CROPS_SCOUTED,
    K_SM_BEDS_BY_GH,
    K_SM_FARMS_AND_GHS,
    K_SM_FARMS_AND_WHS,
    K_SM_SEVERITY_THRESHOLDS,
    K_SM_TRAPS_BY_GH,
    K_SM_UNITS_BY_WH,
    K_SM_ZONES_BY_GH,
    TTL_LONG,
    TTL_MEDIUM,
    get_or_set,
)


@frappe.whitelist()
def get_farms_and_greenhouses():
    """{farm: [greenhouse_name, ...]} — active greenhouses only."""
    return get_or_set(
        K_SM_FARMS_AND_GHS,
        scouting_metrics.get_farms_and_greenhouses,
        ttl=TTL_MEDIUM,
    )


@frappe.whitelist()
def get_farms_and_warehouses():
    """{farm: [warehouse_name, ...]} — greenhouses *and* blocks (active only).

    Used by the scouting dashboard so block-based farms (orchards) appear
    alongside greenhouse-based farms in the Farm dropdown.
    """
    return get_or_set(
        K_SM_FARMS_AND_WHS,
        scouting_metrics.get_farms_and_warehouses,
        ttl=TTL_MEDIUM,
    )


@frappe.whitelist()
def get_units_by_warehouse():
    """{warehouse: {type: greenhouse|block, count, farm}} — pressure denominator."""
    return get_or_set(
        K_SM_UNITS_BY_WH,
        scouting_metrics.get_units_by_warehouse,
        ttl=TTL_LONG,
    )


@frappe.whitelist()
def get_crops_with_farms():
    """[{name, crop_name, farms: [...]}] — drives the dashboard Crop filter."""
    return get_or_set(
        K_CROPS_SCOUTED,
        scouting_metrics.get_crops_with_farms,
        ttl=TTL_MEDIUM,
    )


@frappe.whitelist()
def get_severity_thresholds():
    """{crop: {pests: {pest: {unit, low, moderate, high}}, diseases: {...}}}.

    Drives the dashboard pest/disease severity classifier. Cache key is
    invalidated by Crop Scouted / Pest Filter / Disease Filter doc events.
    """
    return get_or_set(
        K_SM_SEVERITY_THRESHOLDS,
        scouting_metrics.get_severity_thresholds,
        ttl=TTL_MEDIUM,
    )


@frappe.whitelist()
def get_beds_by_greenhouse(active_only=1):
    """{greenhouse: [{name, bed, unit_type, variety, bed__area}, ...]}.

    ``active_only`` defaults to 1; pass 0 to include retired beds.
    """
    active_only = bool(int(active_only)) if active_only is not None else True
    if active_only:
        return get_or_set(
            K_SM_BEDS_BY_GH,
            lambda: scouting_metrics.get_beds_by_greenhouse(active_only=True),
            ttl=TTL_LONG,
        )
    # Uncached when the caller explicitly asks for the full list — rare.
    return scouting_metrics.get_beds_by_greenhouse(active_only=False)


@frappe.whitelist()
def get_zones_by_greenhouse():
    """{greenhouse: [{name, bed, zone}, ...]}."""
    return get_or_set(
        K_SM_ZONES_BY_GH,
        scouting_metrics.get_zones_by_greenhouse,
        ttl=TTL_LONG,
    )


@frappe.whitelist()
def get_traps_by_greenhouse(trap_type=None):
    """{greenhouse: {"indoor": [...], "outdoor": [...]}}.

    ``trap_type`` — pass "FCM" to restrict to FCM traps.
    """
    if trap_type:
        # Don't cache per-type variants; cheap enough to recompute.
        return scouting_metrics.get_traps_by_greenhouse(trap_type=trap_type)
    return get_or_set(
        K_SM_TRAPS_BY_GH,
        scouting_metrics.get_traps_by_greenhouse,
        ttl=TTL_MEDIUM,
    )
