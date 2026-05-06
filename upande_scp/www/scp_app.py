import json
import re

import frappe


def _doctype_exists(doctype):
    return bool(frappe.db.exists("DocType", doctype))


def _greenhouses():
    if not _doctype_exists("Warehouse"):
        return []
    if frappe.session.user == "Guest":
        return []
    try:
        rows = frappe.db.get_list(
            "Warehouse",
            filters={"warehouse_type": "Greenhouse"},
            fields=["name", "custom_farm"],
        )
    except frappe.PermissionError:
        return []
    allowed_farms = ["Chepsito", "Kaptumbo", "Kapkolia", "Torongo", "Simotwo", "Main"]
    exclude_keywords = ["phase", "tunnel", "ipm", "wetland"]

    def is_allowed(wh):
        name = (wh.get("name") or "").lower()
        if not any(farm.lower() in name for farm in allowed_farms):
            return False
        if " gh " not in name and not re.search(r"\bgh\b", name):
            return False
        if any(kw in name for kw in exclude_keywords):
            return False
        return True

    def sort_key(wh):
        name = wh.get("name") or ""
        farm_prefix = ""
        for farm in allowed_farms:
            if farm.lower() in name.lower():
                farm_prefix = farm
                break
        number_match = re.search(r"(\d+)\s*(?:-\s*MFL)?$", name)
        number = int(number_match.group(1)) if number_match else 9999
        return (farm_prefix.lower(), number, name.lower())

    return sorted([wh for wh in rows if is_allowed(wh)], key=sort_key)


def _spray_equipment():
    if not _doctype_exists("Spray Equipment Details"):
        return []
    if frappe.session.user == "Guest":
        return []
    try:
        return frappe.get_all(
            "Spray Equipment Details",
            fields=["kit", "warehouse"],
            order_by="idx ASC",
        )
    except frappe.PermissionError:
        return []


def get_context(context):
    context.no_cache = 1
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.user = frappe.session.user
    context.bootstrap_json = json.dumps(
        {
            "greenhouses": _greenhouses(),
            "sprayEquipment": _spray_equipment(),
        }
    )
    return context
