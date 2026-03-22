import frappe
import re

def get_context(context):
    context.no_cache = 1
    csrf_token = frappe.sessions.get_csrf_token()
    context.csrf_token = csrf_token
    
    ALLOWED_FARMS = ["Chepsito", "Kaptumbo", "Kapkolia", "Torongo", "Simotwo"]
    EXCLUDE_KEYWORDS = ["phase", "tunnel", "ipm", "wetland"]

    warehouses = frappe.db.get_list(
        "Warehouse",
        filters={"warehouse_type": "Greenhouse"},
        fields=["name", "custom_farm"]
    )

    def is_allowed(wh):
        name = wh.get("name", "").lower()
        
        # Must contain one of the allowed farm names
        if not any(farm.lower() in name for farm in ALLOWED_FARMS):
            return False
        
        # Must contain "gh"
        if not re.search(r"\bgh(?:\s*\d+)?\b", name):
            return False
        
        # Must not contain any excluded keywords
        if any(kw in name for kw in EXCLUDE_KEYWORDS):
            return False
        
        return True

    def sort_key(wh):
        name = wh.get("name", "")
        
        farm_prefix = ""
        for farm in ALLOWED_FARMS:
            if farm.lower() in name.lower():
                farm_prefix = farm
                break
        
        number_match = re.search(r'(\d+)\s*(?:-\s*KR)?$', name)
        number = int(number_match.group(1)) if number_match else 9999
        
        return (farm_prefix.lower(), number, name.lower())

    filtered = [wh for wh in warehouses if is_allowed(wh)]
    sorted_warehouses = sorted(filtered, key=sort_key)

    context.warehouses_list = sorted_warehouses

    spray_equipment = frappe.get_all(
        "Spray Equipment Details",
        fields=["kit", "warehouse"],
        order_by="idx ASC"
    )
    context.spray_equipment_list = spray_equipment

    return context
