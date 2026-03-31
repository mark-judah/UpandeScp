import frappe


@frappe.whitelist()
def startSprayerSession():
    """
    Called when a sprayer presses Start on an approved Work Order.

    Finds or creates a Sprayer Movement Session for the given work order +
    employee. Returns the session name so the app can tag subsequent GPS logs.

    Expected JSON body:
        {
            "work_order": "WO-YYYY-XXXXX",
            "user_id":    "sprayer@example.com"
        }
    """
    try:
        data = frappe.request.get_json()
        frappe.log_error("Start Sprayer Session Payload", data)

        if not data:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {"status": "error", "message": "Request body is missing."}
            return

        work_order_name = data.get("work_order")
        user_id = data.get("user_id")

        if not work_order_name or not user_id:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "work_order and user_id are required."
            }
            return

        # Resolve employee from user_id
        employee_list = frappe.get_all(
            "Employee",
            filters={"user_id": user_id},
            fields=["name"]
        )
        if not employee_list:
            frappe.response.http_status_code = 404
            frappe.response["data"] = {
                "status": "error",
                "message": f"No Employee record found for user: {user_id}"
            }
            return

        employee = employee_list[0].name

        # Validate the Work Order
        if not frappe.db.exists("Work Order", work_order_name):
            frappe.response.http_status_code = 404
            frappe.response["data"] = {
                "status": "error",
                "message": f"Work Order not found: {work_order_name}"
            }
            return

        wo = frappe.get_doc("Work Order", work_order_name)

        if wo.docstatus != 1:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Work Order must be submitted (approved) before starting a session."
            }
            return

        if wo.status == "Completed":
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Cannot start a session for a completed Work Order."
            }
            return

        # Return existing Active session rather than creating a duplicate
        existing = frappe.db.get_value(
            "Sprayer Movement Session",
            {"work_order": work_order_name, "employee": employee, "status": "Active"},
            ["name", "started_at"],
            as_dict=True
        )
        if existing:
            frappe.response.http_status_code = 200
            frappe.response["data"] = {
                "status": "resumed",
                "message": "Active session already exists — resuming.",
                "session": existing.name,
                "started_at": str(existing.started_at),
                "work_order": work_order_name,
                "employee": employee
            }
            return

        # Flip Work Order to In Process if needed
        if wo.status != "In Process":
            wo.db_set("status", "In Process", update_modified=False)
            if not wo.actual_start_date:
                wo.db_set("actual_start_date", frappe.utils.now_datetime(), update_modified=False)

        greenhouse = getattr(wo, "custom_greenhouse", None)

        session_doc = frappe.new_doc("Sprayer Movement Session")
        session_doc.work_order = work_order_name
        session_doc.employee = employee
        session_doc.greenhouse = greenhouse
        session_doc.status = "Active"
        session_doc.started_at = frappe.utils.now_datetime()
        session_doc.insert(ignore_permissions=True)

        frappe.db.commit()

        frappe.response.http_status_code = 201
        frappe.response["data"] = {
            "status": "started",
            "message": "Sprayer Movement Session created successfully.",
            "session": session_doc.name,
            "started_at": str(session_doc.started_at),
            "work_order": work_order_name,
            "employee": employee
        }

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error("Fatal error in startSprayerSession", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}
