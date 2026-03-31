import frappe


@frappe.whitelist()
def stopSprayerSession():
    """
    Called when a sprayer presses Stop, completing the movement session.

    Expected JSON body:
        {
            "session": "SMS-2026-00001"
        }
    """
    try:
        data = frappe.request.get_json()
        frappe.log_error("Stop Sprayer Session Payload", data)

        if not data:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {"status": "error", "message": "Request body is missing."}
            return

        session_name = data.get("session")
        if not session_name:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {"status": "error", "message": "session is required."}
            return

        if not frappe.db.exists("Sprayer Movement Session", session_name):
            frappe.response.http_status_code = 404
            frappe.response["data"] = {
                "status": "error",
                "message": f"Session not found: {session_name}"
            }
            return

        session_doc = frappe.get_doc("Sprayer Movement Session", session_name)

        if session_doc.status == "Completed":
            frappe.response.http_status_code = 200
            frappe.response["data"] = {
                "status": "already_completed",
                "message": "Session was already completed.",
                "session": session_name,
                "ended_at": str(session_doc.ended_at),
                "total_gps_points": session_doc.total_gps_points,
                "total_distance_m": session_doc.total_distance_m
            }
            return

        ended_at = frappe.utils.now_datetime()
        session_doc.db_set("status", "Completed", update_modified=True)
        session_doc.db_set("ended_at", ended_at, update_modified=False)

        frappe.db.commit()

        frappe.response.http_status_code = 200
        frappe.response["data"] = {
            "status": "completed",
            "message": "Sprayer Movement Session completed successfully.",
            "session": session_name,
            "ended_at": str(ended_at),
            "total_gps_points": session_doc.total_gps_points,
            "total_distance_m": session_doc.total_distance_m
        }

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error("Fatal error in stopSprayerSession", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}
