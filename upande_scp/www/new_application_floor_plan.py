import re

import frappe


def _doctype_exists(doctype):
    return bool(frappe.db.exists("DocType", doctype))

def get_context(context):
    context.no_cache = 1
    csrf_token = frappe.sessions.get_csrf_token()
    context.csrf_token = csrf_token
    warehouses = []
    if _doctype_exists("Warehouse"):
        all_warehouses = frappe.db.get_list(
            "Warehouse",
            filters={"warehouse_type": "Greenhouse"},
            fields=["name", "custom_farm"]
        )
        allowed_farms = ["Chepsito", "Kaptumbo", "Kapkolia", "Torongo", "Simotwo","Main"]
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

        filtered = [wh for wh in all_warehouses if is_allowed(wh)]
        warehouses = sorted(filtered, key=sort_key)

    context.warehouses_list = warehouses

    spray_equipment = []
    if _doctype_exists("Spray Equipment Details"):
        spray_equipment = frappe.get_all(
            "Spray Equipment Details",
            fields=["kit", "warehouse"],
            order_by="idx ASC"
        )
    context.spray_equipment_list = spray_equipment
    return context

@frappe.whitelist()
def get_scouted_greenhouses_by_date(date):
    if not _doctype_exists("Warehouse") or not _doctype_exists("Scouting Entry"):
        return {"greenhouses": []}
    if not date:
        warehouses = frappe.db.get_list(
            "Warehouse",
            filters={"warehouse_type": "Greenhouse"},
            fields=["name"],
            order_by="name asc"
        )
        return {"greenhouses": warehouses}

    scouting_rows = frappe.get_all(
        "Scouting Entry",
        filters={"date_of_capture": date},
        fields=["greenhouse"],
        group_by="greenhouse"
    )
    scouted_names = [row.greenhouse for row in scouting_rows if row.greenhouse]

    if not scouted_names:
        return {"greenhouses": []}

    warehouses = frappe.db.get_list(
        "Warehouse",
        filters={
            "warehouse_type": "Greenhouse",
            "name": ["in", scouted_names]
        },
        fields=["name"],
        order_by="name asc"
    )
    return {"greenhouses": warehouses}

@frappe.whitelist()
def get_targets_for_autocomplete():
    targets = []
    if _doctype_exists("Pest"):
        pests = frappe.get_all("Pest", fields=["name", "common_name"], order_by="idx ASC")
        targets.extend(
            {"name": p.common_name or p.name, "type": "Pest"}
            for p in pests
            if p.common_name or p.name
        )
    if _doctype_exists("Plant Disease"):
        diseases = frappe.get_all(
            "Plant Disease", fields=["name", "common_name"], order_by="idx ASC"
        )
        targets.extend(
            {"name": d.common_name or d.name, "type": "Disease"}
            for d in diseases
            if d.common_name or d.name
        )
    unique = {}
    for target in targets:
        if target["name"] not in unique:
            unique[target["name"]] = target
    return {"targets": list(unique.values())}
