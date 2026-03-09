import frappe
import json
from frappe import _


@frappe.whitelist()
def createApplicationWorkOrder():
    try:
        # -------------------------------------------------- 1. Parse payload (ROBUST)
        payload = frappe.form_dict.get("payload")
        if not payload:
            frappe.throw(_("Payload is missing."))

        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError as e:
                frappe.throw(_("Invalid JSON: {0}").format(str(e)))

        if not isinstance(payload, dict):
            frappe.throw(_("Payload must be a JSON object."))

        raw_data = payload.get("raw_data") or payload

        # -------------------------------------------------- 2. Extract required fields
        bom_name = raw_data.get("production_item")
        greenhouse = raw_data.get("custom_greenhouse")
        area_ha = float(raw_data.get("custom_area") or 0)
        water_volume_l = float(raw_data.get("custom_water_volume") or 0)
        chemicals = raw_data.get("chemicals", [])
        kit_warehouse = raw_data.get("custom_kit_warehouse", "").strip()
        wip_warehouse = kit_warehouse if kit_warehouse else "Work In Progress - KR"
        scheduled_application_time = raw_data.get("custom_scheduled_application_time") or None

        if not bom_name:
            frappe.throw(_("BOM is required. 'production_item' not found."))
        if not greenhouse:
            frappe.throw(_("Greenhouse is required."))
        if area_ha <= 0:
            frappe.throw(_("Area must be > 0."))
        if water_volume_l <= 0:
            frappe.throw(_("Water volume must be > 0."))

        # -------------------------------------------------- 3. Load BOM (safe)
        if not frappe.db.exists("BOM", bom_name):
            frappe.throw(_("BOM {0} does not exist.").format(bom_name))

        template_bom = frappe.get_doc("BOM", bom_name)
        if not template_bom.is_active:
            frappe.throw(_("BOM {0} is not active.").format(bom_name))
        if template_bom.company != "Karen Roses":
            frappe.throw(_("BOM {0} is not for Karen Roses.").format(bom_name))

        production_item = template_bom.item

        # -------------------------------------------------- 4. Work Order qty = number of 1000L tanks
        # Round to 2 decimal places to match ERPNext's internal quantity precision.
        # This prevents "Quantity must not be more than X" errors on material transfer,
        # which occur when wo_qty has more decimals than ERPNext stores internally (e.g.
        # 0.8665 gets displayed/stored as 0.87 but required_qty stays 0.8665, causing a
        # mismatch when the operator tries to transfer materials).
        wo_qty = round(water_volume_l / 1000.0, 2)  # e.g. 866.55 L → 0.87, 620.34 L → 0.62

        # -------------------------------------------------- 5. Dynamic BOM? (only chemicals + rates)
        bom_to_use = bom_name
        needs_dynamic = False

        try:
            needs_dynamic = should_create_dynamic_bom(template_bom=template_bom, user_chemicals=chemicals)

            if needs_dynamic:
                dynamic_bom_name = create_dynamic_bom(
                    template_bom=template_bom,
                    user_chemicals=chemicals,
                    area_ha=area_ha,
                    water_volume_l=water_volume_l,
                    greenhouse=greenhouse,
                    raw_data=raw_data
                )
                bom_to_use = dynamic_bom_name
                frappe.msgprint(f"Dynamic BOM: <b>{dynamic_bom_name}</b>", indicator="blue")
            else:
                frappe.msgprint("Using template BOM", indicator="green")

        except Exception as e:
            frappe.log_error(frappe.get_traceback(), "Dynamic BOM Failed")
            frappe.msgprint(f"Using template BOM: {str(e)}", indicator="orange")
            bom_to_use = bom_name

        # -------------------------------------------------- 5.5. Get BOM UOM for Work Order
        bom_doc = frappe.get_doc("BOM", bom_to_use)
        bom_uom = bom_doc.uom

        # -------------------------------------------------- 6. Build SE items (valuation)
        # Use the same wo_qty (rounded to 2dp) so SE quantities are consistent
        # with what the Work Order will expect during material transfer.
        se_items = []
        item_map = {}
        for chem in chemicals:
            name = chem["chemical"]
            rate = float(chem.get("application_rate") or 0)
            source_wh = chem.get("source_warehouse")

            item = frappe.db.get_value(
                "Item", {"item_name": name, "disabled": 0},
                ["name", "item_name", "stock_uom"], as_dict=1
            )
            if not item:
                frappe.throw(f"Item not found: {name}")
            item_map[name] = item

            se_items.append({
                "item_code": item.name,
                "qty": round(rate * wo_qty, 2),  # match 2dp rounding
                "uom": chem.get("uom") or item.stock_uom,
                "s_warehouse": source_wh,
                "t_warehouse": wip_warehouse
            })

        # -------------------------------------------------- 7. Temp Stock Entry
        se = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Material Transfer for Manufacture",
            "company": "Karen Roses",
            "purpose": "Material Transfer for Manufacture",
            "custom_farm": greenhouse.split()[0],
            "items": se_items
        })
        se.insert(ignore_permissions=True)
        se.submit()
        frappe.db.commit()

        # -------------------------------------------------- 8. Extract rates
        val_rate_map = {i.item_code: i.valuation_rate for i in se.items}

        # -------------------------------------------------- 9. required_items (per 1000L)
        # Round required_qty to 2dp to stay consistent with wo_qty precision.
        # ERPNext recomputes transfer quantities from wo_qty internally, so if
        # required_qty has more decimal places than wo_qty it will throw a
        # "Quantity must not be more than X" validation error on WO start.
        required_items = []
        for chem in chemicals:
            name = chem["chemical"]
            item = item_map[name]

            application_rate = float(chem.get("application_rate") or 0)
            val_rate = val_rate_map.get(item.name) or 0.0

            required_qty = round(application_rate * wo_qty, 2)  # 2dp to match wo_qty

            required_items.append({
                "item_code": item.name,
                "item_name": name,
                "required_qty": required_qty,
                "uom": chem.get("uom") or item.stock_uom,
                "source_warehouse": chem.get("source_warehouse"),
                "rate": val_rate,
                "amount": round(required_qty * val_rate, 2),
                "include_item_in_manufacturing": 1  # CRITICAL: Enable material transfer
            })

        # -------------------------------------------------- 10. Format team
        team_str = format_spray_team(raw_data.get("custom_spray_team"))

        # -------------------------------------------------- 11. Create Work Order
        wo = frappe.get_doc({
            "doctype": "Work Order",
            "production_item": production_item,
            "bom_no": bom_to_use,
            "qty": wo_qty,
            "stock_uom": bom_uom,
            "company": "Karen Roses",
            "wip_warehouse": wip_warehouse,
            "fg_warehouse": greenhouse,
            "custom_type": raw_data.get("custom_type"),
            "custom_greenhouse": greenhouse,
            "custom_variety": raw_data.get("custom_variety"),
            "custom_targets": "\n".join(raw_data.get("custom_targets", [])),
            "custom_spray_type": raw_data.get("custom_spray_type"),
            "custom_kit": raw_data.get("custom_kit"),
            "custom_scope": raw_data.get("custom_scope"),
            "custom_scope_details": raw_data.get("custom_scope_details"),
            "custom_water_ph": raw_data.get("custom_water_ph"),
            "custom_water_hardness": raw_data.get("custom_water_hardness"),
            "custom_water_volume": water_volume_l,
            "custom_area": area_ha,
            "custom_spray_team": team_str,
            "custom_scheduled_application_time": scheduled_application_time,
            "required_items": required_items
        })
        wo.insert(ignore_permissions=True)

        # -------------------------------------------------- 11.5. Replace auto-generated items with ours
        # ERPNext auto-populated required_items from BOM during insert.
        # Clear them and set our custom ones instead.
        wo.set("required_items", [])
        for ri in required_items:
            wo.append("required_items", ri)

        wo.save(ignore_permissions=True)
        frappe.db.commit()

        # -------------------------------------------------- 12. Delete temp SE
        try:
            se.cancel()
            se.delete()
            frappe.db.commit()
        except Exception as e:
            frappe.log_error(f"Failed to delete temp SE {se.name}: {str(e)}")

        return {
            "status": "success",
            "work_order_name": wo.name,
            "bom_used": bom_to_use,
            "work_order_qty": wo_qty,
            "message": f"Work Order {wo.name} created for {water_volume_l:.1f} L ({wo_qty:.2f} tanks)"
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Work Order Creation Failed")
        return {"status": "error", "message": str(e)}


# ----------------------------------------------------------------------
# HELPER: Should create dynamic BOM? (only chemicals + rates)
# ----------------------------------------------------------------------
def should_create_dynamic_bom(template_bom, user_chemicals):
    template_items = {
        i.item_name: float(i.custom_application_rate or 0)
        for i in template_bom.get("items", [])
    }
    user_items = {
        c["chemical"]: float(c.get("application_rate") or 0)
        for c in user_chemicals
    }

    if set(template_items.keys()) != set(user_items.keys()):
        return True

    for name, t_rate in template_items.items():
        u_rate = user_items[name]
        if abs(t_rate - u_rate) > 0.001:
            return True

    return False


# ----------------------------------------------------------------------
# HELPER: Create dynamic BOM (1 × 1000L tank)
# ----------------------------------------------------------------------
def create_dynamic_bom(template_bom, user_chemicals, area_ha, water_volume_l, greenhouse, raw_data):
    items = []
    for c in user_chemicals:
        name = c["chemical"]
        rate = float(c.get("application_rate") or 0)
        item = frappe.db.get_value("Item", {"item_name": name}, ["name", "stock_uom"], as_dict=1)
        if not item:
            frappe.throw(f"Item not found: {name}")

        # Round BOM item qty to 2dp to stay consistent with wo_qty precision
        qty = round(rate, 2)

        items.append({
            "item_code": item.name,
            "item_name": name,
            "qty": qty,
            "stock_qty": qty,
            "qty_consumed_per_unit": qty,
            "uom": c.get("uom") or item.stock_uom,
            "stock_uom": item.stock_uom,
            "conversion_factor": 1,
            "custom_application_rate": str(qty),
            "custom_rate_unit": "Per 1000L",
            "include_item_in_manufacturing": 1,  # CRITICAL: Enable material transfer
            "description": name
        })

    desc = [
        f"Auto-BOM for {greenhouse}",
        f"Area: {area_ha:.4f} ha",
        f"Volume: {water_volume_l:.0f} L",
        f"Targets: {', '.join(raw_data.get('custom_targets', [])) or 'N/A'}"
    ]

    bom = frappe.get_doc({
        "doctype": "BOM",
        "item": template_bom.item,
        "custom_item_group": template_bom.custom_item_group,
        "quantity": 1,
        "uom": "Tank Mix (1000L)",
        "company": template_bom.company,
        "is_active": 1,
        "is_default": 0,
        "custom_farm": template_bom.custom_farm,
        "custom_business_unit": template_bom.custom_business_unit,
        "custom_water_ph": raw_data.get("custom_water_ph"),
        "custom_water_hardness": raw_data.get("custom_water_hardness"),
        "items": items,
        "description": "\n".join(desc)
    })
    bom.insert(ignore_permissions=True)
    bom.submit()
    frappe.db.commit()
    return bom.name


# ----------------------------------------------------------------------
# HELPER: Format spray team
# ----------------------------------------------------------------------
def format_spray_team(team_name):
    if not team_name:
        return ""
    try:
        team = frappe.get_doc("Spray Team", team_name)
        lines = []
        for m in team.get("team", []):
            emp = m.name1
            role = m.role
            if emp and role:
                name = frappe.db.get_value("Employee", emp, "employee_name") or emp
                lines.append(f"{name} - {role}")
        return "\n".join(lines)
    except Exception:
        return ""