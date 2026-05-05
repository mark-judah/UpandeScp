import re

import frappe

from upande_scp.serverscripts.cache_utils import (
    K_AFP_SPRAY_EQUIPMENT,
    K_AFP_WAREHOUSES,
    TTL_LONG,
    get_or_set,
)


_GH_PATTERN = re.compile(r"\bgh(?:\s*\d+)?\b")
_NUM_PATTERN = re.compile(r"(\d+)\s*(?:-\s*KR)?$")


def _load_settings():
    """Read allowed farms + exclude keywords from Spray Plan Settings."""
    farms = frappe.get_all(
        "Spray Plan Allowed Farm",
        filters={"parenttype": "Spray Plan Settings"},
        pluck="farm",
    )
    keywords = frappe.get_all(
        "Spray Plan Exclude Keyword",
        filters={"parenttype": "Spray Plan Settings"},
        pluck="keyword",
    )
    allowed = tuple(f for f in farms if f)
    exclude = tuple((k or "").lower() for k in keywords if k)
    return allowed, exclude


def _is_allowed(name_lower, allowed_lower, exclude):
    if not allowed_lower:
        return False
    if not any(farm in name_lower for farm in allowed_lower):
        return False
    if not _GH_PATTERN.search(name_lower):
        return False
    if any(kw in name_lower for kw in exclude):
        return False
    return True


def _sort_key(name, allowed_lower):
    lname = name.lower()
    farm_prefix = ""
    for farm in allowed_lower:
        if farm in lname:
            farm_prefix = farm
            break
    m = _NUM_PATTERN.search(name)
    number = int(m.group(1)) if m else 9999
    return (farm_prefix, number, lname)


def _build_warehouses():
    allowed, exclude = _load_settings()
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
        if _is_allowed((wh.get("name") or "").lower(), allowed_lower, exclude)
    ]
    filtered.sort(key=lambda wh: _sort_key(wh.get("name") or "", allowed_lower))
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
