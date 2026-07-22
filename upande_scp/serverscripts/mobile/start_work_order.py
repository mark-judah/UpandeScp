# File: your_custom_app/your_custom_app/api.py
# Or add to an existing api.py file in your custom app

import frappe
from frappe import _
from frappe.utils import now_datetime

from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_TRANSFER

@frappe.whitelist()
def start_work_order(work_order_name, actual_start_date=None, actual_end_date=None):
    """
    Start a Work Order and create a draft Stock Entry for Material Transfer
    
    Args:
        work_order_name: Name of the Work Order to start
        actual_start_date: Optional actual start date to set
        actual_end_date: Optional actual end date to set
        
    Returns:
        dict: Response with success status, work order details, stock entry info, and scouts list
    """
    
    if not work_order_name:
        frappe.throw(_("work_order_name parameter is required"))
    
    try:
        # Get the Work Order document with all fields
        wo = frappe.get_doc("Work Order", work_order_name)
        
        # Get all fields of the Work Order
        wo_fields = wo.as_dict()
        
        # Check if work order is submitted
        if wo.docstatus != 1:
            frappe.throw(_("Work Order must be submitted before starting"))
        
        # Check current status
        if wo.status == "Completed":
            frappe.throw(_("Cannot start a completed Work Order"))
        
        if wo.status == "In Process":
            # Fetch scouts and calculate total required quantities
            scouts = get_scouts()
            total_required_qty = calculate_total_required_qty(wo)
            
            return {
                "success": True,
                "message": "Work Order is already in process",
                "work_order": wo_fields,
                "scouts": scouts,
                "total_required_quantity": total_required_qty,
                "status": wo.status
            }
        
        # Update status to In Process using db_set (bypasses submit restriction)
        wo.db_set("status", "In Process", update_modified=False)
        
        # Set actual start date (either provided or current datetime)
        if actual_start_date:
            wo.db_set("actual_start_date", actual_start_date, update_modified=False)
        elif not wo.actual_start_date:
            wo.db_set("actual_start_date", now_datetime(), update_modified=False)
        
        # Set actual end date if provided
        if actual_end_date:
            wo.db_set("actual_end_date", actual_end_date, update_modified=False)
        
        # Reload the document to get updated values
        wo.reload()
        
        # Create Stock Entry for Material Transfer for Manufacture
        stock_entry = create_material_transfer(wo)
        
        # Fetch scouts
        scouts = get_scouts()
        
        # Calculate total required quantity
        total_required_qty = calculate_total_required_qty(wo)
        
        frappe.db.commit()
        
        # Get all fields of the updated Work Order
        updated_wo_fields = wo.as_dict()
        
        return {
            "success": True,
            "message": f"Work Order {work_order_name} has been started and Stock Entry created",
            "work_order": updated_wo_fields,
            "scouts": scouts,
            "total_required_quantity": total_required_qty,
            "status": wo.status,
            "actual_start_date": str(wo.actual_start_date) if wo.actual_start_date else None,
            "actual_end_date": str(wo.actual_end_date) if wo.actual_end_date else None,
            "stock_entry": stock_entry.name if stock_entry else None,
            "stock_entry_status": "Draft"
        }
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Start Work Order Error")
        return {
            "success": False,
            "error": str(e)
        }


@frappe.whitelist()
def get_work_order_details(work_order_name):
    """
    Get complete Work Order details including all fields, scouts, and total required quantity
    
    Args:
        work_order_name: Name of the Work Order
        
    Returns:
        dict: Complete Work Order details
    """
    
    if not work_order_name:
        frappe.throw(_("work_order_name parameter is required"))
    
    try:
        # Get the Work Order document with all fields
        wo = frappe.get_doc("Work Order", work_order_name)
        
        # Get all fields of the Work Order
        wo_fields = wo.as_dict()
        
        # Fetch scouts
        scouts = get_scouts()
        
        # Calculate total required quantity
        total_required_qty = calculate_total_required_qty(wo)
        
        return {
            "success": True,
            "work_order": wo_fields,
            "scouts": scouts,
            "total_required_quantity": total_required_qty
        }
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get Work Order Details Error")
        return {
            "success": False,
            "error": str(e)
        }


@frappe.whitelist()
def update_work_order_dates(work_order_name, actual_start_date=None, actual_end_date=None):
    """
    Update Work Order actual start and end dates
    
    Args:
        work_order_name: Name of the Work Order
        actual_start_date: New actual start date (optional)
        actual_end_date: New actual end date (optional)
        
    Returns:
        dict: Response with success status and updated work order details
    """
    
    if not work_order_name:
        frappe.throw(_("work_order_name parameter is required"))
    
    try:
        # Get the Work Order document
        wo = frappe.get_doc("Work Order", work_order_name)
        
        # Update dates if provided
        if actual_start_date:
            wo.db_set("actual_start_date", actual_start_date, update_modified=False)
        
        if actual_end_date:
            wo.db_set("actual_end_date", actual_end_date, update_modified=False)
        
        # Reload the document to get updated values
        wo.reload()
        
        frappe.db.commit()
        
        # Get all fields of the updated Work Order
        wo_fields = wo.as_dict()
        
        # Fetch scouts
        scouts = get_scouts()
        
        # Calculate total required quantity
        total_required_qty = calculate_total_required_qty(wo)
        
        return {
            "success": True,
            "message": "Work Order dates updated successfully",
            "work_order": wo_fields,
            "scouts": scouts,
            "total_required_quantity": total_required_qty,
            "actual_start_date": str(wo.actual_start_date) if wo.actual_start_date else None,
            "actual_end_date": str(wo.actual_end_date) if wo.actual_end_date else None
        }
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Update Work Order Dates Error")
        return {
            "success": False,
            "error": str(e)
        }


def get_scouts():
    """
    Fetch all employees with designation 'Scouter'
    
    Returns:
        list: List of scouts with their details
    """
    try:
        scouts = frappe.get_all(
            "Employee",
            filters={
                "designation": "Scouter",
                "status": "Active"
            },
            fields=["*"],  # Get all fields
            order_by="employee_name asc"
        )
        
        return scouts
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get Scouts Error")
        return []


def calculate_total_required_qty(work_order):
    """
    Calculate total required quantity from required_items
    
    Args:
        work_order: Work Order document
        
    Returns:
        float: Total required quantity
    """
    try:
        total_qty = 0
        if hasattr(work_order, 'required_items') and work_order.required_items:
            for item in work_order.required_items:
                total_qty += item.get('required_qty', 0)
        
        return round(total_qty, 2)
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Calculate Total Required Qty Error")
        return 0


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

        # Resolve farm from the greenhouse warehouse's custom_farm link so
        # any farm configured in Scouting and Crop Protection Settings flows through unchanged.
        greenhouse = getattr(work_order, "custom_greenhouse", None)
        if greenhouse:
            farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm")
            if farm:
                stock_entry.custom_farm = farm
        
        # Stock Entry Type and Work Order fields
        stock_entry.stock_entry_type = SE_TYPE_TRANSFER
        stock_entry.work_order = work_order.name
        
        # Save as draft - items and other fields will auto-populate
        stock_entry.insert(ignore_permissions=True)
        
        frappe.msgprint(_("Stock Entry {0} created as draft").format(stock_entry.name))
        
        return stock_entry
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Create Material Transfer Error")
        frappe.throw(_("Error creating Stock Entry: {0}").format(str(e)))