# File: your_custom_app/your_custom_app/api.py
# Or add to an existing api.py file in your custom app

import frappe
from frappe import _

@frappe.whitelist()
def start_work_order(work_order_name):
    """
    Start a Work Order and create a draft Stock Entry for Material Transfer
    
    Args:
        work_order_name: Name of the Work Order to start
        
    Returns:
        dict: Response with success status, work order details, and stock entry info
    """
    
    if not work_order_name:
        frappe.throw(_("work_order_name parameter is required"))
    
    try:
        # Get the Work Order document
        wo = frappe.get_doc("Work Order", work_order_name)
        
        # Check if work order is submitted
        if wo.docstatus != 1:
            frappe.throw(_("Work Order must be submitted before starting"))
        
        # Check current status
        if wo.status == "Completed":
            frappe.throw(_("Cannot start a completed Work Order"))
        
        if wo.status == "In Process":
            return {
                "success": True,
                "message": "Work Order is already in process",
                "work_order": work_order_name,
                "status": wo.status
            }
        
        # Update status to In Process using db_set (bypasses submit restriction)
        wo.db_set("status", "In Process", update_modified=False)
        
        # Set actual start date if not already set
        if not wo.actual_start_date:
            wo.db_set("actual_start_date", frappe.utils.now_datetime(), update_modified=False)
        
        # Reload the document to get updated values
        wo.reload()
        
        # Create Stock Entry for Material Transfer for Manufacture
        stock_entry = create_material_transfer(wo)
        
        frappe.db.commit()
        
        return {
            "success": True,
            "message": f"Work Order {work_order_name} has been started and Stock Entry created",
            "work_order": work_order_name,
            "status": wo.status,
            "actual_start_date": str(wo.actual_start_date),
            "stock_entry": stock_entry.name if stock_entry else None,
            "stock_entry_status": "Draft"
        }
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Start Work Order Error")
        return {
            "success": False,
            "error": str(e)
        }


def create_material_transfer(work_order):
    """
    Create a draft Stock Entry for Material Transfer for Manufacture
    Items will auto-populate when work_order is set and document is saved
    """
    try:
        # Create new Stock Entry
        stock_entry = frappe.new_doc("Stock Entry")
        
        # Mandatory fields
        stock_entry.company = work_order.company
        
        # Extract custom_farm from custom_greenhouse (first part before space)
        if hasattr(work_order, 'custom_greenhouse') and work_order.custom_greenhouse:
            # Split by space and take the first part
            # Example: "Chepsito GH 07 - KR" -> "Chepsito"
            custom_farm = work_order.custom_greenhouse.split()[0]
            stock_entry.custom_farm = custom_farm
        
        # Stock Entry Type and Work Order fields
        stock_entry.stock_entry_type = "Material Transfer for Manufacture"
        stock_entry.work_order = work_order.name
        
        # Save as draft - items and other fields will auto-populate
        stock_entry.insert(ignore_permissions=True)
        
        frappe.msgprint(_("Stock Entry {0} created as draft").format(stock_entry.name))
        
        return stock_entry
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Create Material Transfer Error")
        frappe.throw(_("Error creating Stock Entry: {0}").format(str(e)))