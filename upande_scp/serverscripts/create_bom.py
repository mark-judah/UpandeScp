import frappe
import json
from frappe import _

@frappe.whitelist()
def createBOM():
    try:
        raw_data = frappe.form_dict.get('data')
        if isinstance(raw_data, str):
            data = json.loads(raw_data)
        else:
            data = raw_data

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

        # === ENSURE BOM ITEM EXISTS ===
        if not frappe.db.exists("Item", bom_item_name):
            item_doc = frappe.new_doc("Item")
            item_doc.item_code = bom_item_name
            item_doc.item_name = bom_item_name
            item_doc.stock_uom = "Tank Mix (1000L)"
            item_doc.is_stock_item = 1
            item_doc.insert(ignore_permissions=True)
            frappe.db.commit()

        # === CREATE BOM ===
        bom_doc = frappe.new_doc("BOM")
        bom_doc.item = bom_item_name
        bom_doc.custom_item_group="Chemical Mix"
        bom_doc.company = "Karen Roses"
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
            item_name = str(chem.get("item_name") or "").strip()
            if not item_name:
                return {"status": "error", "message": f"Chemical name missing in row #{idx}"}

            rate = float(chem.get("custom_application_rate") or 0)
            if rate <= 0:
                return {"status": "error", "message": f"Rate must be > 0 for '{item_name}' (row #{idx})"}

            uom = str(chem.get("uom") or "").strip()

            # === RESOLVE ITEM CODE FROM ITEM NAME ===
            item_code = frappe.db.get_value(
                "Item",
                {"item_name": item_name, "disabled": 0},
                "name"
            )
            if not item_code:
                return {
                    "status": "error",
                    "message": f"Chemical '{item_name}' not found. Check spelling or create the item."
                }

            item = frappe.get_doc("Item", item_code)

            # === VALIDATE UOM MATCH (optional strictness) ===
            if uom and uom != item.stock_uom:
                frappe.log_error(
                    f"UOM mismatch: Frontend sent '{uom}', but item has '{item.stock_uom}'",
                    "BOM UOM Warning"
                )

            # === ADD BOM ITEM ===
            bom_item = bom_doc.append("items", {})
            bom_item.item_code = item_code
            bom_item.item_name = item_name
            bom_item.qty = rate
            bom_item.uom = item.stock_uom
            bom_item.stock_uom = item.stock_uom
            bom_item.conversion_factor = 1

            # Custom fields
            bom_item.custom_application_rate = rate

            # Store for response
            bom_items.append({
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
    
@frappe.whitelist()
def getAllChemicals():
    # Get both item code (name) and item name (item_name)
    chemicals = frappe.get_all("Item", 
        filters={'item_group': 'CHEMICALS'},
        fields=["name", "item_name", "stock_uom"],
        order_by="item_name"
    )
    
    # Build lists and maps
    chemical_names = []
    item_uom_map = {}
    item_code_map = {}  # Maps display name to item code
    
    for chemical in chemicals:
        display_name = chemical.item_name or chemical.name
        chemical_names.append(display_name)
        item_uom_map[display_name] = chemical.stock_uom
        item_code_map[display_name] = chemical.name  # Store the actual item code
    
    return {
        "chemicals": sorted(list(set(chemical_names))),  # Remove duplicates and sort
        "item_uom_map": item_uom_map,
        "item_code_map": item_code_map  # Frontend can use this if needed for backend calls
    }
    
@frappe.whitelist()
def getChemicalUom(chemical):
    try:
        # Try to find by item_name first, then by name (item code)
        item = frappe.db.get_value("Item", 
            {"item_name": chemical}, 
            ["name", "stock_uom"]
        )
        
        if not item:
            # Try by item code if item_name search failed
            item = frappe.db.get_value("Item", chemical, ["name", "stock_uom"])
        
        if item:
            return {"uom": item[1] if isinstance(item, tuple) else item.stock_uom}
        
        return {"uom": ""}
    except Exception as e:
        frappe.log_error(f"Error fetching UOM for {chemical}: {str(e)}")
        return {"uom": ""}