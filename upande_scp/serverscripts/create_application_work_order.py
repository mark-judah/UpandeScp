import frappe
import json
from frappe import _

@frappe.whitelist()
def createApplicationWorkOrder():
    try:
        payload_body = frappe.form_dict.get("data") or frappe.form_dict

        if isinstance(payload_body, str):
            payload_body = json.loads(payload_body)

        raw_data = payload_body.get("payload", {}).get("raw_data", {})
        
        if not raw_data:
            raw_data = payload_body
        
        bom_name = raw_data.get("production_item")
        greenhouse = raw_data.get("custom_greenhouse")

        spray_team = raw_data.get("custom_spray_team")
        area = raw_data.get("custom_area")
        qty_to_manufacture = max(1, frappe.utils.cint(raw_data.get("qty") or 1))
        target_list = raw_data.get("custom_targets", [])
        chemicals_data = raw_data.get("chemicals", [])
        
        if not bom_name:
            frappe.msgprint(_("BOM name is a required field."))
            return

        bom_doc = frappe.get_doc("BOM", bom_name)
        production_item = bom_doc.get("item")

        if not production_item:
            frappe.msgprint(
                _("The selected BOM does not have a defined production item."))
            return

        spray_team_doc = frappe.get_doc("Spray Team", spray_team)
        team_members_data = spray_team_doc.get("team")
        
        employee_ids = []
        if team_members_data:
            employee_ids = [member.get('name1') for member in team_members_data if member.get('name1')]

        name_lookup_map = {}
        if employee_ids:
            employee_data = frappe.get_all(
                "Employee",
                filters={"name": ["in", employee_ids]},
                fields=["name", "employee_name"]
            )
            name_lookup_map = {item['name']: item['employee_name'] for item in employee_data}

        formatted_members = []
        if team_members_data:
            for member in team_members_data:
                employee_id = member.get('name1')
                role = member.get('role')

                display_name = name_lookup_map.get(
                    employee_id, employee_id)

                if display_name and role:
                    formatted_line = f"{display_name} - {role}"
                    formatted_members.append(formatted_line)

            spray_team_data = "\n".join(formatted_members)
        else:
            spray_team_data = ""

        formatted_targets = [target for target in target_list]
        formatted_string = "\n".join(formatted_targets)

        chemical_names = [c.get("chemical") for c in chemicals_data]
        items_map = frappe.get_all(
            "Item", filters={"item_name": ["in", chemical_names]}, fields=["item_name", "item_code"]
        )
        item_name_to_code = {i["item_name"]: i["item_code"] for i in items_map}
        item_code_to_name = {i["item_code"]: i["item_name"] for i in items_map}

        try:
            area_float = float(area)
        except (ValueError, TypeError):
            area_float = 1.0

        se_items = []
        all_required_items = []

        for chem in chemicals_data:
            chemical_name = chem.get("chemical")
            item_code = item_name_to_code.get(chemical_name)

            if not item_code:
                frappe.throw(
                    f"Item not found for chemical: {chemical_name}")

            qty_raw = float(chem.get("quantity"))
            qty = qty_raw * area_float
            source_warehouse = chem.get("source_warehouse")
            uom = chem.get("uom")

            se_items.append({
                "item_code": item_code, "qty": qty, "uom": uom,
                "s_warehouse": source_warehouse, "t_warehouse": "Work In Progress - KR"
            })
            
            all_required_items.append({
                "item_code": item_code,
                "item_name": chemical_name,
                "required_qty": qty,
                "uom": uom,
                "source_warehouse": source_warehouse,
            })

        se = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Material Transfer for Manufacture",
            "company": "Karen Roses",
            "purpose": "Material Transfer for Manufacture",
            "custom_farm": greenhouse.split()[0],
            "items": se_items
        })
        se.insert(ignore_permissions=True) 
        frappe.db.commit()

        se_item_rate_map = {item.item_code: item for item in se.items}

        final_required_items = []

        for item_data in all_required_items:
            item_code = item_data["item_code"]
            se_item = se_item_rate_map.get(item_code)
            
            if se_item:
                fifo_rate = se_item.valuation_rate or se_item.basic_rate
                amount = item_data["required_qty"] * fifo_rate

                final_required_items.append({
                    "item_code": item_code,
                    "item_name": item_data["item_name"],
                    "required_qty": item_data["required_qty"],
                    "uom": item_data["uom"],
                    "source_warehouse": item_data["source_warehouse"],
                    "rate": fifo_rate,
                    "amount": amount
                })

        work_order_doc = frappe.get_doc({
            "doctype": "Work Order",
            "production_item": production_item,
            "qty": qty_to_manufacture,
            "bom_no": bom_name,
            "company": "Karen Roses",
            "wip_warehouse": "Work In Progress - KR",
            "fg_warehouse": greenhouse,
            "custom_type": raw_data.get("custom_type"),
            "custom_greenhouse": greenhouse,
            "custom_variety": raw_data.get("custom_variety"),
            "custom_targets": formatted_string,
            "custom_spray_type": raw_data.get("custom_spray_type"),
            "custom_kit": raw_data.get("custom_kit"),
            "custom_scope": raw_data.get("custom_scope"),
            "custom_scope_details": raw_data.get("custom_scope_details"),
            "custom_water_ph": raw_data.get("custom_water_ph"),
            "custom_water_hardness": raw_data.get("custom_water_hardness"),
            "custom_water_volume": raw_data.get("custom_water_volume"),
            "custom_area": area,
            "custom_spray_team": spray_team_data,
            "required_items": final_required_items 
        })

        work_order_doc.insert()
        se.delete()
        frappe.db.commit()

        return {
            "status": "success",
            "work_order_name": work_order_doc.name,
            "message": f"Work Order {work_order_doc.name} created successfully!"
        }

    except Exception as e:
        error_message = str(e)
        frappe.log_error(title="Work Order Creation Error", message=frappe.get_traceback())
        return {
            "status": "error",
            "message": _("Error creating Work Order: {0}").format(error_message),
            "qty":qty_to_manufacture
        }