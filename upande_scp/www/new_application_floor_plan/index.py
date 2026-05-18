import frappe

from upande_scp.serverscripts.cache_utils import (
    K_AFP_SPRAY_EQUIPMENT,
    K_AFP_WAREHOUSES,
    TTL_LONG,
    get_or_set,
)
from upande_scp.serverscripts.warehouse_filter import (
    gh_sort_key,
    is_greenhouse_allowed,
    load_settings,
)


def _build_warehouses():
    allowed, exclude = load_settings()
    allowed_lower = tuple(f.lower() for f in allowed)
    if not allowed_lower:
        return []
    warehouses = frappe.get_all(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse"},
        fields=["name", "custom_farm"],
        limit_page_length=0,
    )
    filtered = [
        wh
        for wh in warehouses
        if is_greenhouse_allowed(
            wh.get("name") or "",
            allowed_lower,
            exclude,
            has_farm=bool(wh.get("custom_farm")),
        )
    ]
    filtered.sort(
        key=lambda wh: gh_sort_key(wh.get("name") or "", allowed_lower),
    )
    return filtered


def _build_spray_equipment():
    return frappe.get_all(
        "Spray Equipment Details",
        fields=["kit", "warehouse"],
        order_by="idx ASC",
        limit_page_length=0,
    )


def get_context(context):
    context.no_cache = 1
    context.csrf_token = frappe.sessions.get_csrf_token()

    context.warehouses_list = get_or_set(K_AFP_WAREHOUSES, _build_warehouses, ttl=TTL_LONG)
    context.spray_equipment_list = get_or_set(
        K_AFP_SPRAY_EQUIPMENT, _build_spray_equipment, ttl=TTL_LONG
    )
    context.spray_settings_url = "/app/spray-plan-settings"
    return context
