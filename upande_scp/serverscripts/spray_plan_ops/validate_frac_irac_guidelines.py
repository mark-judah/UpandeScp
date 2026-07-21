import frappe
import json
from frappe import _
from frappe.utils import add_days, now_datetime, get_datetime

# --- GUIDELINE VALIDATION FUNCTIONS (Utility functions remain unchanged) ---

def get_item_name(chemical_identifier):
    """Helper to get item_name from item_code or vice versa."""
    if frappe.db.exists("Item", chemical_identifier):
        return frappe.db.get_value("Item", chemical_identifier, "item_name")
    else:
        item_code = frappe.db.get_value("Item", {"item_name": chemical_identifier}, "item_code")
        if item_code:
            return frappe.db.get_value("Item", item_code, "item_name")
    return None


def matches_chemical(item_name, item_code, chemical_identifier, target_item_name):
    """Check if item matches the chemical we're looking for."""
    return (item_name == chemical_identifier or 
            item_code == chemical_identifier or 
            item_name == target_item_name or
            item_code == target_item_name)


def get_relevant_code(chemical_identifier, item_code_field, applicable_codes, chemical_type):
    """
    Retrieves the relevant code for rotation logic.
    Returns (code, item_name) tuple if a code is found, otherwise None.
    """
    # Try to find item by code first, then by name
    item_code = None
    if frappe.db.exists("Item", chemical_identifier):
        item_code = chemical_identifier
    else:
        item_code = frappe.db.get_value("Item", {"item_name": chemical_identifier}, "item_code")
    
    if not item_code:
        return None

    item_name = get_item_name(item_code) # Get the display name
    
    # Get item type efficiently
    item_custom_type = frappe.db.get_value("Item", item_code, "custom_type")
    
    if not item_custom_type:
        return None
    
    # --- Universal (Type-Based) Check ---
    if isinstance(applicable_codes, str):
        if item_custom_type == applicable_codes:
            # Code is the generic type, Item Name is for error reporting
            return (item_custom_type, item_name)
        return None
    
    # --- Selective (Code-Based) Check ---
    
    if chemical_type.lower() not in item_custom_type.lower():
        return None
        
    try:
        item = frappe.get_doc("Item", item_code)
    except frappe.DoesNotExistError:
        return None
    
    # Find the FIRST matching code
    for row in item.get(item_code_field, []):
        if row.code in applicable_codes:
            # Code is the specific IRAC/FRAC code, Item Name is for error reporting
            return (row.code, item_name)
    
    return None


def validate_alternate_moa(raw_data, greenhouse, guideline_doctype):
    """
    Unified validation for alternate MoA (FRAC or IRAC) by checking code rotation.
    """
    # Determine prefixes and fields based on DocType
    if guideline_doctype == "FRAC Guideline":
        code_list_field = "frac_code_filter"
        item_code_field = "custom_frac"
        resistance_prefix = "FRAC Resistance Risk"
        chemical_type = "Fungicide"
    else:
        code_list_field = "irac_code_filter"
        item_code_field = "custom_irac"
        resistance_prefix = "IRAC Resistance Risk"
        chemical_type = "Insecticide"
        
    try:
        guideline = frappe.get_doc(guideline_doctype, "Alternate MoA")
    except frappe.DoesNotExistError:
        return {"valid": True, "errors": []}
    
    if not guideline.enabled:
        return {"valid": True, "errors": []}
    
    # Implement "Empty Filter = Universal/Type-Based" logic
    filter_codes = guideline.get(code_list_field)
    if filter_codes:
        applicable_codes = {row.code for row in filter_codes}
    else:
        # Use the chemical type string for the Universal Check
        applicable_codes = chemical_type 
        
    max_consecutive = int(guideline.parameters)
    chemicals = raw_data.get("chemicals", [])
    
    # Get recent submitted work orders (approved spray plans)
    recent_work_orders = frappe.get_all(
        "Work Order",
        filters={
            "custom_greenhouse": greenhouse,
            "custom_type": "Application Floor Plan",
            "docstatus": 1
        },
        fields=["name"],
        order_by="creation desc",
        limit=10
    )
    
    # Build sequence of (Code, ItemName) tuples
    code_sequence_tuples = []
    
    # Historical codes from approved work orders
    for wo in reversed(recent_work_orders):
        wo_doc = frappe.get_doc("Work Order", wo.name)
        for item in wo_doc.get("required_items", []):
            result = get_relevant_code(item.item_name, item_code_field, applicable_codes, chemical_type)
            if result:
                code_sequence_tuples.append(result)
    
    # Current plan codes
    for chem in chemicals:
        result = get_relevant_code(chem["chemical"], item_code_field, applicable_codes, chemical_type)
        if result:
            code_sequence_tuples.append(result)
    
    if len(code_sequence_tuples) < 2:
        return {"valid": True, "errors": []}
    
    # Extract just the codes for comparison, but keep tuples for error reporting
    codes = [t[0] for t in code_sequence_tuples]
    
    # Check for violations
    errors = []
    consecutive_count = 1
    last_violation_code = None
    
    for i in range(1, len(codes)):
        current_code = codes[i]
        
        if current_code == codes[i-1]:
            consecutive_count += 1
            
            if consecutive_count > max_consecutive and current_code != last_violation_code:
                # The chemical that causes the current violation is the one at index i
                violating_item_name = code_sequence_tuples[i][1]
                
                # If using the generic type, replace it with the chemical name for clarity
                display_code = violating_item_name if current_code == chemical_type else current_code

                errors.append(
                    _("{0}: Chemical '{1}'  used {3} times consecutively (max: {4}). {5}").format(
                        resistance_prefix, 
                        violating_item_name,
                        current_code,
                        consecutive_count,
                        max_consecutive,
                        guideline.error_message
                    )
                )
                last_violation_code = current_code
        else:
            consecutive_count = 1
            last_violation_code = None
    
    return {"valid": len(errors) == 0, "errors": errors}

# --- REMAINING VALIDATION FUNCTIONS (Unchanged, as they don't rely on the code sequence tuple change) ---

def validate_max_sprays(raw_data, greenhouse, guideline_doctype):
    """
    Validates that chemicals don't exceed max spray count within required break period.
    """
    if guideline_doctype == "FRAC Guideline":
        resistance_prefix = "FRAC Resistance Risk"
    else:
        resistance_prefix = "IRAC Resistance Risk"

    try:
        guideline = frappe.get_doc(guideline_doctype, "Max Number Of Sprays")
    except frappe.DoesNotExistError:
        return {"valid": True, "errors": []}
    
    if not guideline.enabled:
        return {"valid": True, "errors": []}
    
    # Parse parameters: "Chemical:Sprays:RequiredBreakInDays"
    param_lines = guideline.parameters.replace(";", "\n").strip().split("\n")
    chemical_rules = {}
    
    for line in param_lines:
        parts = line.strip().split(":")
        if len(parts) == 3:
            chemical_name, max_sprays, break_days = parts
            chemical_rules[chemical_name.strip()] = {
                "max_sprays": int(max_sprays),
                "break_days": int(break_days)
            }
    
    if not chemical_rules:
        return {"valid": True, "errors": []}
    
    chemicals = raw_data.get("chemicals", [])
    errors = []
    
    # Check each chemical in current plan
    for chem in chemicals:
        chemical_identifier = chem["chemical"]
        
        # Find matching rule (by item_code or item_name)
        rule = None
        item_name = get_item_name(chemical_identifier)
        
        if item_name in chemical_rules:
            rule = chemical_rules[item_name]
        elif chemical_identifier in chemical_rules:
            rule = chemical_rules[chemical_identifier]
        
        if not rule:
            continue
        
        # Count recent uses within the break period
        cutoff_date = add_days(now_datetime(), -rule["break_days"])
        
        recent_uses = frappe.get_all(
            "Work Order",
            filters={
                "custom_greenhouse": greenhouse,
                "custom_type": "Application Floor Plan",
                "docstatus": 1,
                "creation": [">=", cutoff_date]
            },
            fields=["name", "creation"],
            order_by="creation desc"
        )
        
        usage_count = 0
        last_used_date = None
        
        for wo in recent_uses:
            wo_doc = frappe.get_doc("Work Order", wo.name)
            for item in wo_doc.get("required_items", []):
                if matches_chemical(item.item_name, item.item_code, chemical_identifier, item_name):
                    usage_count += 1
                    if not last_used_date or wo.creation > last_used_date:
                        last_used_date = wo.creation
                    break
        
        # Check if adding current spray would exceed limit
        if usage_count >= rule["max_sprays"]:
            final_chem_name = item_name or chemical_identifier
            
            if last_used_date:
                days_since_last_use = (now_datetime() - get_datetime(last_used_date)).days
                days_remaining = rule["break_days"] - days_since_last_use
                
                if days_remaining > 0:
                    errors.append(
                        _("{0}: {1} has been used {2} time(s) in the last {3} days (max: {4}). "
                          "Please wait {5} more day(s) before using this chemical again. {6}").format(
                            resistance_prefix,
                            final_chem_name,
                            usage_count,
                            rule["break_days"],
                            rule["max_sprays"],
                            days_remaining,
                            guideline.error_message
                        )
                    )
                else:
                    errors.append(
                        _("{0}: {1} has been used {2} time(s) in the last {3} days (max: {4}). {5}").format(
                            resistance_prefix,
                            final_chem_name,
                            usage_count,
                            rule["break_days"],
                            rule["max_sprays"],
                            guideline.error_message
                        )
                    )
    
    return {
        "valid": len(errors) == 0,
        "errors": errors
    }


def validate_known_resistance(raw_data, guideline_doctype):
    """
    Validates that chemicals used do not belong to FRAC/IRAC codes known to have 
    resistance issues with the targets specified in the spray plan.
    """
    # Determine prefixes and fields based on DocType
    if guideline_doctype == "FRAC Guideline":
        item_code_field = "custom_frac"
        resistance_prefix = "FRAC Resistance Risk"
    else:
        item_code_field = "custom_irac"
        resistance_prefix = "IRAC Resistance Risk"
        
    try:
        guideline = frappe.get_doc(guideline_doctype, "Target With Known Resistance")
    except frappe.DoesNotExistError:
        return {"valid": True, "errors": []}
    
    if not guideline.enabled:
        return {"valid": True, "errors": []}

    # 1. Parse Guideline Parameters ("Target:Code\nTarget2:Code2")
    resistance_rules = {}
    param_lines = guideline.parameters.replace(";", "\n").strip().split("\n")
    
    for line in param_lines:
        parts = line.strip().split(":")
        if len(parts) == 2:
            target, code = parts
            target = target.strip()
            code = code.strip()
            # Store as {Target: [Code1, Code2, ...]}
            if target not in resistance_rules:
                resistance_rules[target] = set()
            resistance_rules[target].add(code)
    
    if not resistance_rules:
        return {"valid": True, "errors": []}

    # 2. Get Targets in the Current Spray Plan
    targets_in_plan = raw_data.get("custom_targets", [])
    if isinstance(targets_in_plan, str):
        targets_in_plan = [t.strip() for t in targets_in_plan.split('\n') if t.strip()]

    # 3. Identify Applicable Resistance Codes
    forbidden_codes = set()
    for target in targets_in_plan:
        if target in resistance_rules:
            forbidden_codes.update(resistance_rules[target])

    if not forbidden_codes:
        return {"valid": True, "errors": []}

    # 4. Check Chemicals in Payload against Forbidden Codes
    chemicals = raw_data.get("chemicals", [])
    errors = []
    
    for chem in chemicals:
        chemical_name = chem["chemical"]
        item_code = frappe.db.get_value("Item", {"item_name": chemical_name}, "item_code")
        
        if not item_code:
            continue
            
        try:
            item = frappe.get_doc("Item", item_code)
        except frappe.DoesNotExistError:
            continue

        # Check the relevant FRAC/IRAC child table on the Item document
        for row in item.get(item_code_field, []):
            if row.code in forbidden_codes:
                # Found a violation
                errors.append(
                    _("{0}: Chemical '{1}' contains code '{2}', which has known resistance for target(s) {3}. {4}").format(
                        resistance_prefix,
                        chemical_name,
                        row.code,
                        ", ".join([t for t, codes in resistance_rules.items() if row.code in codes and t in targets_in_plan]),
                        guideline.error_message
                    )
                )
                # Break to avoid duplicate errors for the same chemical
                break 

    return {"valid": len(errors) == 0, "errors": errors}

# --- MAIN API FUNCTION (Unchanged) ---

@frappe.whitelist()
def validateGuidelines(payload):
    """
    API endpoint to validate spray plan against FRAC/IRAC resistance management guidelines.
    """
    try:
        data = json.loads(payload) if isinstance(payload, str) else payload
        raw_data = data.get("raw_data", {})
        
        greenhouse = raw_data.get("custom_greenhouse")

        chemicals = raw_data.get("chemicals", [])
        
        if not greenhouse or not chemicals:
            return {
                "valid": False,
                "errors": [_("Missing greenhouse or chemicals in spray plan")]
            }
        
        all_errors = []
        
        # Run all validations - collect errors from each
        validations = [
            ("FRAC Alternate MoA", validate_alternate_moa, [raw_data, greenhouse, "FRAC Guideline"]),
            ("IRAC Alternate MoA", validate_alternate_moa, [raw_data, greenhouse, "IRAC Guideline"]),
            ("FRAC Max Sprays", validate_max_sprays, [raw_data, greenhouse, "FRAC Guideline"]),
            ("IRAC Max Sprays", validate_max_sprays, [raw_data, greenhouse, "IRAC Guideline"]),
            ("FRAC Known Resistance", validate_known_resistance, [raw_data, "FRAC Guideline"]), 
            ("IRAC Known Resistance", validate_known_resistance, [raw_data, "IRAC Guideline"])
        ]
        
        for name, func, args in validations:
            try:
                result = func(*args) 
                if not result["valid"]:
                    all_errors.extend(result["errors"])
            except Exception as e:
                frappe.log_error(
                    title=f"Validation Error: {name}",
                    message=f"Error: {str(e)}\n{frappe.get_traceback()}"
                )
        
        return {
            "valid": len(all_errors) == 0,
            "errors": all_errors,
        }
        
    except Exception as e:
        frappe.log_error(title="Spray Plan Validation Error", message=frappe.get_traceback())
        return {
            "valid": False,
            "errors": [_("Validation error: {0}").format(str(e))],
        }