"""
Sprayer Movement — consolidated server script.

Handles the full lifecycle of a sprayer session in one module:
  startSprayerSession   — opens a Sprayer Movement Session, stamps actual_start_date
                          on the Work Order, and returns the session name so the app
                          can tag subsequent GPS pings.
  createSprayerEntry    — accepts one or more GPS movement points for an active session
                          and persists them as Sprayer GPS Log documents, rounding each
                          ping to the nearest zone and accumulating distance counters.
  stopSprayerSession    — closes an active session and stamps actual_end_date.

Mirrors the batch-tolerant pattern of create_scouting_entry.py.
The three separate scripts (start_sprayer_session.py, create_sprayer_entry.py,
stop_sprayer_session.py) are superseded by this file.
"""

import math
import frappe
from .geo_utils import get_zone_from_coordinates


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres between two WGS-84 points."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi    = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _resolve_employee(user_id):
    """Return the Employee name for a given user_id, or None."""
    rows = frappe.get_all(
        "Employee",
        filters={"user_id": user_id},
        fields=["name"],
    )
    return rows[0].name if rows else None


# ---------------------------------------------------------------------------
# startSprayerSession
# ---------------------------------------------------------------------------

@frappe.whitelist()
def startSprayerSession():
    """
    Called when the sprayer taps Start on an approved Work Order.

    Finds or creates a Sprayer Movement Session for the given work order +
    employee. Also stamps actual_start_date on the Work Order so the
    chemical-tab no longer needs to handle this step.

    Expected JSON body:
        {
            "work_order": "WO-YYYY-XXXXX",
            "user_id":    "sprayer@example.com"
        }

    Returns the session name and actual_start_date so the mobile app can
    update its local plan cache immediately.
    """
    try:
        data = frappe.request.get_json()
        frappe.log_error("Start Sprayer Session Payload", data)

        if not data:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Request body is missing.",
            }
            return

        work_order_name = data.get("work_order")
        user_id         = data.get("user_id")
        bypass          = bool(data.get("bypass", False))
        greenhouse_hint = str(data.get("greenhouse") or "")

        if not user_id:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "user_id is required.",
            }
            return

        if not bypass and not work_order_name:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "work_order is required for non-bypass sessions.",
            }
            return

        employee = _resolve_employee(user_id)
        if not employee and not bypass:
            frappe.response.http_status_code = 404
            frappe.response["data"] = {
                "status": "error",
                "message": f"No Employee record found for user: {user_id}",
            }
            return

        # ------------------------------------------------------------------
        # Bypass path — no Work Order required, session created directly
        # ------------------------------------------------------------------
        if bypass:
            now = frappe.utils.now_datetime()
            session_doc              = frappe.new_doc("Sprayer Movement Session")
            session_doc.work_order   = None
            session_doc.employee     = employee or ""
            session_doc.greenhouse   = greenhouse_hint
            session_doc.status       = "Active"
            session_doc.is_bypass    = 1
            session_doc.started_at   = now
            session_doc.insert(ignore_permissions=True)
            frappe.db.commit()

            frappe.response.http_status_code = 201
            frappe.response["data"] = {
                "status":            "started",
                "message":           "Bypass Sprayer Movement Session created.",
                "session":           session_doc.name,
                "started_at":        str(now),
                "actual_start_date": str(now),
                "work_order":        None,
                "employee":          employee or "",
            }
            return

        if not frappe.db.exists("Work Order", work_order_name):
            frappe.response.http_status_code = 404
            frappe.response["data"] = {
                "status": "error",
                "message": f"Work Order not found: {work_order_name}",
            }
            return

        wo = frappe.get_doc("Work Order", work_order_name)

        if wo.docstatus != 1:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Work Order must be submitted (approved) before starting a session.",
            }
            return

        if wo.status == "Completed":
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Cannot start a session for a completed Work Order.",
            }
            return

        # Resume an existing Active session rather than creating a duplicate
        existing = frappe.db.get_value(
            "Sprayer Movement Session",
            {"work_order": work_order_name, "employee": employee, "status": "Active"},
            ["name", "started_at"],
            as_dict=True,
        )
        if existing:
            frappe.response.http_status_code = 200
            frappe.response["data"] = {
                "status": "resumed",
                "message": "Active session already exists — resuming.",
                "session":          existing.name,
                "started_at":       str(existing.started_at),
                "actual_start_date": str(wo.actual_start_date or existing.started_at),
                "work_order":       work_order_name,
                "employee":         employee,
            }
            return

        now = frappe.utils.now_datetime()

        # Stamp actual_start_date on the Work Order — this replaces the step
        # that was previously done in the chemical tab.
        wo.db_set("actual_start_date", now, update_modified=False)

        if wo.status != "In Process":
            wo.db_set("status", "In Process", update_modified=False)

        greenhouse = getattr(wo, "custom_greenhouse", None)

        session_doc              = frappe.new_doc("Sprayer Movement Session")
        session_doc.work_order   = work_order_name
        session_doc.employee     = employee
        session_doc.greenhouse   = greenhouse
        session_doc.status       = "Active"
        session_doc.started_at   = now
        session_doc.insert(ignore_permissions=True)

        frappe.db.commit()

        frappe.response.http_status_code = 201
        frappe.response["data"] = {
            "status":           "started",
            "message":          "Sprayer Movement Session created successfully.",
            "session":          session_doc.name,
            "started_at":       str(session_doc.started_at),
            "actual_start_date": str(now),
            "work_order":       work_order_name,
            "employee":         employee,
        }

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error("Fatal error in startSprayerSession", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}


# ---------------------------------------------------------------------------
# createSprayerEntry  (GPS batch upload)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def createSprayerEntry():
    """
    Receives one or more GPS movement points for an active Sprayer Movement
    Session and saves them as Sprayer GPS Log documents.

    Each ping is rounded to the nearest zone using the shared UTM-projection
    geometry. Session distance/point counters are updated once per batch per
    session (single SQL UPDATE) rather than on every row insert.

    Expected JSON body (single entry or list):
        {
            "session":       "SMS-2026-00001",
            "latitude":      "-0.1234",
            "longitude":     "36.5678",
            "accuracy":      "4.2",
            "captured_at":   "2026-03-31 08:15:00",  // UTC datetime of the ping
            "quality_level": "good",
            "samples_used":  5,
            "is_stationary": false
        }
    """
    try:
        data = frappe.request.get_json()
        frappe.log_error("Sprayer GPS Payload", data)

        if not data:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "GPS data is missing from the request body.",
            }
            return

        if isinstance(data, dict):
            data_list = [data]
        elif isinstance(data, list):
            data_list = data
        else:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Expected a single GPS entry or a list of entries.",
            }
            return

        results      = []
        has_errors   = False
        # Per-session delta accumulators so session totals are updated once at
        # commit time, not on every individual row insert.
        # { session_name: {"points": int, "distance_m": float,
        #                   "prev_lat": float|None, "prev_lon": float|None} }
        session_deltas = {}

        for entry_data in data_list:
            try:
                session_name   = entry_data.get("session")
                latitude       = entry_data.get("latitude")
                longitude      = entry_data.get("longitude")
                accuracy       = entry_data.get("accuracy")
                captured_at    = entry_data.get("captured_at")
                quality_level  = entry_data.get("quality_level", "unknown")
                samples_used   = entry_data.get("samples_used", 0)
                is_stationary  = entry_data.get("is_stationary", False)

                if not session_name:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "session is required for every GPS entry.",
                    })
                    continue

                if not latitude or not longitude:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "latitude and longitude are required.",
                        "session": session_name,
                    })
                    continue

                if not captured_at:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "captured_at is required.",
                        "session": session_name,
                    })
                    continue

                # Verify session exists and is Active
                session_doc = frappe.db.get_value(
                    "Sprayer Movement Session",
                    session_name,
                    ["name", "work_order", "employee", "greenhouse", "status"],
                    as_dict=True,
                )

                if not session_doc:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": f"Session not found: {session_name}",
                    })
                    continue

                if session_doc.status != "Active":
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": (
                            f"Session {session_name} is not Active "
                            f"(current status: {session_doc.status})."
                        ),
                    })
                    continue

                # Zone determination — sprayer moves across the whole greenhouse,
                # so bed is None. The zone is rounded to the nearest geometry match.
                determined_zone = None
                confidence      = 0.0
                zone_message    = {"distance": "0.0", "buffer": "0.0"}

                if accuracy:
                    determined_zone, confidence, zone_message = get_zone_from_coordinates(
                        latitude, longitude, None, accuracy
                    )

                if not isinstance(zone_message, dict):
                    zone_message = {"distance": "0.0", "buffer": "0.0"}

                requires_review = confidence < 0.5 and determined_zone is not None

                # Persist the GPS log
                log_doc                  = frappe.new_doc("Sprayer GPS Log")
                log_doc.session          = session_name
                log_doc.work_order       = session_doc.work_order
                log_doc.employee         = session_doc.employee
                log_doc.greenhouse       = session_doc.greenhouse
                log_doc.captured_at      = captured_at
                log_doc.latitude         = str(latitude)
                log_doc.longitude        = str(longitude)
                log_doc.zone             = determined_zone
                log_doc.gps_accuracy     = str(accuracy) if accuracy else None
                log_doc.gps_quality      = quality_level
                log_doc.gps_confidence   = round(confidence, 4)
                log_doc.gps_samples_used = int(samples_used) if samples_used else 0
                log_doc.stationary       = 1 if is_stationary else 0
                log_doc.zone_buffer      = float(zone_message.get("buffer", 0.0))
                log_doc.zone_distance    = float(zone_message.get("distance", 0.0))
                log_doc.insert(ignore_permissions=True)

                # Accumulate per-session distance delta
                if session_name not in session_deltas:
                    # Seed previous coordinates from the last persisted log so
                    # distance is continuous across separate batch calls.
                    last_log = frappe.db.get_value(
                        "Sprayer GPS Log",
                        {"session": session_name},
                        ["latitude", "longitude"],
                        order_by="captured_at desc",
                        as_dict=True,
                    )
                    session_deltas[session_name] = {
                        "points":    0,
                        "distance_m": 0.0,
                        "prev_lat":  float(last_log.latitude)  if last_log else None,
                        "prev_lon":  float(last_log.longitude) if last_log else None,
                    }

                delta = session_deltas[session_name]
                delta["points"] += 1

                cur_lat = float(latitude)
                cur_lon = float(longitude)
                if delta["prev_lat"] is not None:
                    delta["distance_m"] += _haversine_m(
                        delta["prev_lat"], delta["prev_lon"], cur_lat, cur_lon
                    )
                delta["prev_lat"] = cur_lat
                delta["prev_lon"] = cur_lon

                result = {
                    "status":             "success",
                    "message":            "GPS log created successfully.",
                    "name":               log_doc.name,
                    "session":            session_name,
                    "determined_zone":    determined_zone,
                    "zone_confidence":    round(confidence * 100, 1) if determined_zone else 0.0,
                    "gps_accuracy":       accuracy,
                    "quality_level":      quality_level,
                    "captured_at":        captured_at,
                    "zone_detection_details": zone_message,
                }

                if requires_review:
                    result["warning"] = (
                        f"Low zone confidence ({confidence * 100:.0f}%) — "
                        "manual verification may be needed."
                    )

                results.append(result)

            except Exception as e:
                has_errors = True
                frappe.log_error("Error creating sprayer GPS log", str(e))
                results.append({"status": "error", "message": str(e)})

        # Flush session summary counters — one UPDATE per session, not per row
        if any(r.get("status") == "success" for r in results):
            for sname, delta in session_deltas.items():
                if delta["points"] == 0:
                    continue
                try:
                    frappe.db.sql(
                        """
                        UPDATE `tabSprayer Movement Session`
                        SET
                            total_gps_points = total_gps_points + %(pts)s,
                            total_distance_m = total_distance_m + %(dist)s,
                            modified         = NOW()
                        WHERE name = %(name)s
                        """,
                        {
                            "pts":  delta["points"],
                            "dist": round(delta["distance_m"], 2),
                            "name": sname,
                        },
                    )
                except Exception as e:
                    frappe.log_error(
                        f"Error updating session totals for {sname}", str(e)
                    )
            frappe.db.commit()
        else:
            frappe.db.rollback()

        if has_errors:
            frappe.response.http_status_code = (
                400 if all(r.get("status") == "error" for r in results) else 207
            )
        else:
            frappe.response.http_status_code = 200

        frappe.response["data"] = results

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error("Fatal error in createSprayerEntry", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}


# ---------------------------------------------------------------------------
# stopSprayerSession
# ---------------------------------------------------------------------------

@frappe.whitelist()
def stopSprayerSession():
    """
    Called when the sprayer taps Stop, completing the movement session.
    Also stamps actual_end_date on the Work Order.

    Expected JSON body:
        {
            "session":          "SMS-2026-00001",
            "actual_end_date":  "2026-03-31 10:00:00"   // optional; defaults to now
        }
    """
    try:
        data = frappe.request.get_json()
        frappe.log_error("Stop Sprayer Session Payload", data)

        if not data:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Request body is missing.",
            }
            return

        session_name    = data.get("session")
        actual_end_date = data.get("actual_end_date")

        if not session_name:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "session is required.",
            }
            return

        if not frappe.db.exists("Sprayer Movement Session", session_name):
            frappe.response.http_status_code = 404
            frappe.response["data"] = {
                "status": "error",
                "message": f"Session not found: {session_name}",
            }
            return

        session_doc = frappe.get_doc("Sprayer Movement Session", session_name)

        if session_doc.status == "Completed":
            frappe.response.http_status_code = 200
            frappe.response["data"] = {
                "status":            "already_completed",
                "message":           "Session was already completed.",
                "session":           session_name,
                "ended_at":          str(session_doc.ended_at),
                "total_gps_points":  session_doc.total_gps_points,
                "total_distance_m":  session_doc.total_distance_m,
            }
            return

        ended_at = actual_end_date or frappe.utils.now_datetime()

        session_doc.db_set("status",   "Completed",  update_modified=True)
        session_doc.db_set("ended_at", ended_at,     update_modified=False)

        # Stamp actual_end_date on the Work Order
        work_order_name = session_doc.work_order
        if work_order_name and frappe.db.exists("Work Order", work_order_name):
            wo = frappe.get_doc("Work Order", work_order_name)
            wo.db_set("actual_end_date", ended_at, update_modified=False)
            # Mark Work Order as Completed
            wo.db_set("status", "Completed", update_modified=False)

        frappe.db.commit()

        frappe.response.http_status_code = 200
        frappe.response["data"] = {
            "status":           "completed",
            "message":          "Sprayer Movement Session completed successfully.",
            "session":          session_name,
            "ended_at":         str(ended_at),
            "actual_end_date":  str(ended_at),
            "total_gps_points": session_doc.total_gps_points,
            "total_distance_m": session_doc.total_distance_m,
        }

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error("Fatal error in stopSprayerSession", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}
