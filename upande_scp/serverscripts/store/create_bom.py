import frappe
import json

from upande_scp.upande_scp.doctype.scouting_and_crop_protection_settings.scouting_and_crop_protection_settings import (
    get_allowed_farms,
)
from upande_scp.serverscripts.common.crop_protection import get_product_rate


def _resolve_bom_farm(data):
    """Pick the farm to attach to a new BOM.

    Priority: an explicit ``custom_farm`` from the caller, then the
    greenhouse warehouse's ``custom_farm``, then the first allowed farm
    from Scouting and Crop Protection Settings. Returns ``None`` if nothing resolves so the
    BOM is created without a farm rather than with a stale default.
    """
    farm = (data.get("custom_farm") or "").strip()
    if farm:
        return farm

    greenhouse = (data.get("custom_greenhouse") or "").strip()
    if greenhouse:
        gh_farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm")
        if gh_farm:
            return gh_farm

    allowed = get_allowed_farms()
    return allowed[0] if allowed else None


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
        bom_doc.custom_item_group = "Chemical Mix"
        bom_doc.company = "Karen Roses"
        bom_farm = _resolve_bom_farm(data)
        if bom_farm:
            bom_doc.custom_farm = bom_farm
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

            # === RATE LIMIT GUARD ===
            # Block under/over-dosing when limits are set. Resolved via the
            # Chemical/Foliar sidecar (authoritative), falling back to the
            # legacy Item custom fields. Limits are per 1000L; ``rate`` is in
            # the same unit (see BOM Item.custom_application_rate convention).
            _lower, _upper = get_product_rate(item_code)
            lower = float(_lower or 0)
            upper = float(_upper or 0)
            if lower and rate < lower:
                return {
                    "status": "error",
                    "message": (
                        f"Rate {rate} for '{item_name}' is below the configured "
                        f"lower limit of {lower} per 1000L."
                    ),
                }
            if upper and rate > upper:
                return {
                    "status": "error",
                    "message": (
                        f"Rate {rate} for '{item_name}' exceeds the configured "
                        f"upper limit of {upper} per 1000L."
                    ),
                }

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
                "custom_application_rateper_ha_": rate,  # Add this too
                "description": item_name,
                "include_item_in_manufacturing": 1,
                "conversion_factor": 1
            })

            # Store for response
            bom_items.append({
                "item_name": item_name,
                "custom_application_rate": rate,
                "uom": item.stock_uom
            })

        # === SAVE & SUBMIT - Use insert then submit ===
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
        # Get all BOMs for this item
        existing_boms = frappe.get_all("BOM", 
            filters={
                "item": bom_item_name,
                "docstatus": 1  # Only submitted BOMs
            },
            fields=["name", "custom_water_ph", "custom_water_hardness"]
        )

        for bom in existing_boms:
            # Check water parameters (with small tolerance for floating point)
            if abs(bom.custom_water_ph - water_ph) > 0.1:
                continue
            if abs(bom.custom_water_hardness - water_hardness) > 0.1:
                continue

            # Get BOM items
            bom_items = frappe.get_all("BOM Item",
                filters={"parent": bom.name},
                fields=["item_code", "item_name", "qty", "custom_application_rate"]
            )

            # Check if same number of items
            if len(bom_items) != len(chemicals):
                continue

            # Build comparison sets
            existing_items = {}
            for item in bom_items:
                # Resolve item_code from item_name for comparison
                key = item.item_name or item.item_code
                rate = item.custom_application_rate or item.qty
                existing_items[key] = rate

            new_items = {}
            for chem in chemicals:
                item_name = str(chem.get("item_name") or "").strip()
                rate = float(chem.get("custom_application_rate") or 0)
                new_items[item_name] = rate

            # Compare items and rates
            if existing_items.keys() == new_items.keys():
                all_match = True
                for key in existing_items:
                    if abs(existing_items[key] - new_items[key]) > 0.001:  # Small tolerance
                        all_match = False
                        break
                
                if all_match:
                    return bom.name

        return None

    except Exception as e:
        frappe.log_error(f"Error checking duplicate BOM: {str(e)}", "Duplicate BOM Check")
        return None
    
@frappe.whitelist()
@frappe.whitelist()
def get_chemical_rate_limits():
    """Return a compact map of per-chemical rate limits for live validation.

    Shape::

        {
          "ITEM-CODE-001": {"lower": 5.0, "upper": 15.0, "label": "Glyphosate 41%"},
          ...
        }

    Chemicals whose Item has neither limit set are omitted so the client
    can use ``in``-checks rather than special-casing zero values. The
    extra label is purely a convenience so the toast messages don't have
    to round-trip item_code → item_name."""
    rows = frappe.get_all(
        "Item",
        filters={"item_group": "CHEMICALS", "disabled": 0},
        fields=[
            "name",
            "item_name",
            "custom_lower_rate_limit",
            "custom_upper_rate_limit",
        ],
    )
    out = {}
    for r in rows:
        lower = float(r.get("custom_lower_rate_limit") or 0)
        upper = float(r.get("custom_upper_rate_limit") or 0)
        if not lower and not upper:
            continue
        out[r.name] = {
            "lower": lower or None,
            "upper": upper or None,
            "label": r.item_name or r.name,
        }
    return out


@frappe.whitelist()
def getAllChemicals():
    # Fetch both chemicals and fertilizers in one query
    items = frappe.get_all(
        "Item",
        filters={"item_group": ["in", ["CHEMICALS", "Fertilizer"]], "disabled": 0},
        fields=[
            "name",
            "item_name",
            "stock_uom",
            "item_group",
            "custom_lower_rate_limit",
            "custom_upper_rate_limit",
        ],
        order_by="item_name",
    )

    chemical_names = []
    fertilizer_names = []
    item_uom_map = {}
    item_code_map = {}
    item_type_map = {}
    # Rate limits are only ever set on CHEMICALS, but we publish them for
    # every row in the map so the client can look them up by display name
    # without branching on type.
    item_rate_limits_map = {}

    for it in items:
        display_name = it.item_name or it.name
        item_type = "fertilizer" if it.item_group == "Fertilizer" else "chemical"
        if item_type == "fertilizer":
            fertilizer_names.append(display_name)
        else:
            chemical_names.append(display_name)
        item_uom_map[display_name] = it.stock_uom
        item_code_map[display_name] = it.name
        item_type_map[display_name] = item_type
        lower = float(it.get("custom_lower_rate_limit") or 0)
        upper = float(it.get("custom_upper_rate_limit") or 0)
        if lower or upper:
            item_rate_limits_map[display_name] = {
                "lower": lower or None,
                "upper": upper or None,
            }

    return {
        "chemicals": sorted(set(chemical_names)),
        "fertilizers": sorted(set(fertilizer_names)),
        "item_uom_map": item_uom_map,
        "item_code_map": item_code_map,
        "item_type_map": item_type_map,
        "item_rate_limits_map": item_rate_limits_map,
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
        frappe.log_error(f"Error fetching UOM for chemical '{chemical}': {str(e)}", "Get Chemical UOM Error")
        return {"uom": ""}