import re

import frappe

from upande_scp.serverscripts.cache_utils import (
    K_AFP_SPRAY_EQUIPMENT,
    K_AFP_WAREHOUSES,
    TTL_LONG,
    get_or_set,
)


ALLOWED_FARMS = ("Chepsito", "Kaptumbo", "Kapkolia", "Torongo", "Simotwo")
EXCLUDE_KEYWORDS = ("phase", "tunnel", "ipm", "wetland")
_GH_PATTERN = re.compile(r"\bgh(?:\s*\d+)?\b")
_NUM_PATTERN = re.compile(r"(\d+)\s*(?:-\s*KR)?$")


def _is_allowed(name_lower):
    if not any(farm in name_lower for farm in (f.lower() for f in ALLOWED_FARMS)):
        return False
    if not _GH_PATTERN.search(name_lower):
        return False
    if any(kw in name_lower for kw in EXCLUDE_KEYWORDS):
        return False
    return True


def _sort_key(name):
    lname = name.lower()
    farm_prefix = ""
    for farm in ALLOWED_FARMS:
        if farm.lower() in lname:
            farm_prefix = farm.lower()
            break
    m = _NUM_PATTERN.search(name)
    number = int(m.group(1)) if m else 9999
    return (farm_prefix, number, lname)


def _build_warehouses():
    warehouses = frappe.db.get_list(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse"},
        fields=["name", "custom_farm"],
        limit_page_length=0,
    )
    filtered = [wh for wh in warehouses if _is_allowed((wh.get("name") or "").lower())]
    filtered.sort(key=lambda wh: _sort_key(wh.get("name") or ""))
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
    return context
