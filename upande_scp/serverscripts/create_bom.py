import frappe
import json

@frappe.whitelist()
def createBOM():
    try:
        data = frappe.form_dict
        if isinstance(data, str):
            data = json.loads(data)

        # === VALIDATE REQUIRED FIELDS ===
        required = ['item', 'custom_water_ph', 'custom_water_hardness', 'items']
        for field in required:
            if field not in data or data[field] is None:
                return {"status": "error", "message": f"Missing required field: {field}"}

        bom_item_name = str(data['item']).strip()
        if not bom_item_name:
            return {"status": "error", "message": "BOM name cannot be empty"}

        try:
            water_ph = float(data['custom_water_ph'])
            water_hardness = float(data['custom_water_hardness'])
            if water_ph <= 0 or water_hardness <= 0:
                raise ValueError()
        except (ValueError, TypeError):
            return {"status": "error", "message": "Water pH and hardness must be positive numbers"}

        chemicals = data['items']
        if not isinstance(chemicals, list) or len(chemicals) == 0:
            return {"status": "error", "message": "At least one chemical item is required"}

        # === CHECK FOR EXISTING IDENTICAL BOM ===
        existing_bom = check_duplicate_bom(bom_item_name, water_ph, water_hardness, chemicals)
        if existing_bom:
            return {
                "status": "duplicate",
                "message": f"A BOM with identical rates already exists: {existing_bom}",
                "bom_name": existing_bom,
                "action": "Would you like to use the existing BOM instead?"
            }

        # === ENSURE BOM ITEM EXISTS ===
        if not frappe.db.exists("Item", bom_item_name):
            item_doc = frappe.new_doc("Item")
            item_doc.item_code = bom_item_name
            item_doc.item_name = bom_item_name
            item_doc.item_group = "Chemical Mix"
            item_doc.stock_uom = "Tank Mix (1000L)"
            item_doc.is_stock_item = 1
            item_doc.insert(ignore_permissions=True)
            frappe.db.commit()

        # === CREATE BOM ===
        bom_doc = frappe.new_doc("BOM")
        bom_doc.item = bom_item_name
        bom_doc.custom_item_group="Chemical Mix"
        bom_doc.company = "Mona Flowers Limited"
        bom_doc.custom_farm = "Chepsito"
        bom_doc.custom_business_unit = "Roses"
        bom_doc.uom = "Tank Mix (1000L)"
        bom_doc.quantity = 1
        bom_doc.custom_water_ph = water_ph
        bom_doc.custom_water_hardness = water_hardness
        bom_doc.is_active = 1
        bom_doc.is_default = 1

        bom_items = []

        for idx, chem in enumerate(chemicals, start=1):
            item_code = str(chem.get("item_code") or "").strip()
            if not item_code:
                return {"status": "error", "message": f"Chemical code missing in row #{idx}"}

            rate = float(chem.get("custom_application_rate") or 0)
            if rate <= 0:
                return {"status": "error", "message": f"Rate must be > 0 for '{item_code}' (row #{idx})"}

            uom = str(chem.get("uom") or "").strip()

            item = frappe.get_doc("Item", item_code)
            if not item:
                return {
                    "status": "error",
                    "message": f"Chemical '{item_code}' not found."
                }

            item_name = item.item_name

            # === ADD BOM ITEM ===
            bom_doc.append("items", {
                "item_code": item_code,
                "item_name": item_name,
                "qty": rate,
                "stock_qty": rate,
                "uom": item.stock_uom,
                "stock_uom": item.stock_uom,
                "qty_consumed_per_unit": rate,
                "custom_application_rate": rate,
                "custom_application_rateper_ha_": rate,
                "description": item_name,
                "include_item_in_manufacturing": 1,
                "conversion_factor": 1
            })

            # Store for response
            bom_items.append({
                "item_code": item_code,
                "item_name": item_name,
                "custom_application_rate": rate,
                "uom": item.stock_uom
            })

        # === SAVE & SUBMIT ===
        bom_doc.insert(ignore_permissions=True)
        bom_doc.submit()
        frappe.db.commit()

        return {
            "status": "success",
            "message": "BOM created successfully",
            "bom_name": bom_doc.name,
            "bom_items": bom_items
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "BOM Creation Failed")
        return {"status": "error", "message": f"Failed to create BOM: {str(e)}"}


def check_duplicate_bom(bom_item_name, water_ph, water_hardness, chemicals):
    """
    Check if a BOM with identical composition already exists.
    Returns BOM name if found, None otherwise.
    """
    try:
        existing_boms = frappe.get_all("BOM",
            filters={
                "item": bom_item_name,
                "docstatus": 1
            },
            fields=["name", "custom_water_ph", "custom_water_hardness"]
        )

        for bom in existing_boms:
            if abs(bom.custom_water_ph - water_ph) > 0.1:
                continue
            if abs(bom.custom_water_hardness - water_hardness) > 0.1:
                continue

            bom_items = frappe.get_all("BOM Item",
                filters={"parent": bom.name},
                fields=["item_code", "qty", "custom_application_rate"]
            )

            if len(bom_items) != len(chemicals):
                continue

            existing_items = {
                item.item_code: (item.custom_application_rate or item.qty)
                for item in bom_items
            }
            new_items = {
                str(chem.get("item_code") or "").strip(): float(chem.get("custom_application_rate") or 0)
                for chem in chemicals
            }

            if existing_items.keys() == new_items.keys():
                if all(abs(existing_items[k] - new_items[k]) <= 0.001 for k in existing_items):
                    return bom.name

        return None

    except Exception as e:
        frappe.log_error(f"Error checking duplicate BOM: {str(e)}", "Duplicate BOM Check")
        return None


@frappe.whitelist()
def getAllChemicals():
    chemicals = frappe.get_all("Item",
        filters={'item_group': 'CHEMICALS'},
        fields=["name", "item_name", "stock_uom"],
        order_by="item_name"
    )

    seen_codes = set()
    chemical_list = []
    item_uom_map = {}

    for chemical in chemicals:
        code = chemical.name
        if code in seen_codes:
            continue
        seen_codes.add(code)
        name = chemical.item_name or code
        chemical_list.append({"item_code": code, "item_name": name})
        item_uom_map[code] = chemical.stock_uom

    return {
        "chemicals": chemical_list,
        "item_uom_map": item_uom_map,
    }


@frappe.whitelist()
def getChemicalUom(item_code):
    try:
        uom = frappe.db.get_value("Item", item_code, "stock_uom")
        return {"uom": uom or ""}
    except Exception as e:
        frappe.log_error(f"Error fetching UOM for '{item_code}': {str(e)}", "Get Chemical UOM Error")
        return {"uom": ""}
