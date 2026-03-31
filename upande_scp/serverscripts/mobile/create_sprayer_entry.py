import math
import frappe
from .geo_utils import get_zone_from_coordinates


def _haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres between two WGS-84 points."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@frappe.whitelist()
def createSprayerEntry():
    """
    Receives one or more GPS movement points for an active Sprayer Movement
    Session and saves them as Sprayer GPS Log documents.

    Mirrors the batch-tolerant pattern of createScoutingEntry:
    - Accepts a single dict or a list of dicts.
    - Runs zone determination using the shared UTM-projection logic.
    - Updates the parent session's total_gps_points and total_distance_m once
      per batch per session (single SQL UPDATE), not on every row.
    - Returns per-entry results with an appropriate HTTP status code.

    Expected JSON body (single entry or list):
        {
            "session":       "SMS-2026-00001",       // required
            "latitude":      "-0.1234",               // required
            "longitude":     "36.5678",               // required
            "accuracy":      "4.2",                   // required
            "captured_at":   "2026-03-31 08:15:00",  // required (UTC datetime)
            "quality_level": "good",                  // optional
            "samples_used":  5,                       // optional
            "is_stationary": false                    // optional
        }
    """
    try:
        data = frappe.request.get_json()
        frappe.log_error("Sprayer GPS Payload", data)

        if not data:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "GPS data is missing from the request body."
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
                "message": "Expected a single GPS entry or a list of entries."
            }
            return

        results = []
        has_errors = False

        # Per-session accumulators so session totals are updated once at commit,
        # not on every individual log insert.
        # { session_name: {"points": int, "distance_m": float,
        #                   "prev_lat": float|None, "prev_lon": float|None} }
        session_deltas = {}

        for entry_data in data_list:
            try:
                session_name = entry_data.get("session")
                latitude = entry_data.get("latitude")
                longitude = entry_data.get("longitude")
                accuracy = entry_data.get("accuracy")
                captured_at = entry_data.get("captured_at")

                quality_level = entry_data.get("quality_level", "unknown")
                samples_used = entry_data.get("samples_used", 0)
                is_stationary = entry_data.get("is_stationary", False)

                # Validate required fields
                if not session_name:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "session is required for every GPS entry."
                    })
                    continue

                if not latitude or not longitude:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "latitude and longitude are required.",
                        "session": session_name
                    })
                    continue

                if not captured_at:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "captured_at is required.",
                        "session": session_name
                    })
                    continue

                # Validate session exists and is Active
                session_doc = frappe.db.get_value(
                    "Sprayer Movement Session",
                    session_name,
                    ["name", "work_order", "employee", "greenhouse", "status"],
                    as_dict=True
                )

                if not session_doc:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": f"Session not found: {session_name}"
                    })
                    continue

                if session_doc.status != "Active":
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": (
                            f"Session {session_name} is not Active "
                            f"(current status: {session_doc.status})."
                        )
                    })
                    continue

                # Zone determination — bed is None for sprayer entries because a
                # sprayer moves across the whole greenhouse, not a single bed.
                determined_zone = None
                confidence = 0.0
                zone_message = {"distance": "0.0", "buffer": "0.0"}

                if accuracy:
                    determined_zone, confidence, zone_message = get_zone_from_coordinates(
                        latitude, longitude, None, accuracy
                    )

                if not isinstance(zone_message, dict):
                    zone_message = {"distance": "0.0", "buffer": "0.0"}

                requires_review = confidence < 0.5 and determined_zone is not None

                # Create Sprayer GPS Log
                log_doc = frappe.new_doc("Sprayer GPS Log")
                log_doc.session = session_name
                log_doc.work_order = session_doc.work_order
                log_doc.employee = session_doc.employee
                log_doc.greenhouse = session_doc.greenhouse
                log_doc.captured_at = captured_at
                log_doc.latitude = str(latitude)
                log_doc.longitude = str(longitude)
                log_doc.zone = determined_zone
                log_doc.gps_accuracy = str(accuracy) if accuracy else None
                log_doc.gps_quality = quality_level
                log_doc.gps_confidence = round(confidence, 4)
                log_doc.gps_samples_used = int(samples_used) if samples_used else 0
                log_doc.stationary = 1 if is_stationary else 0
                log_doc.zone_buffer = float(zone_message.get("buffer", 0.0))
                log_doc.zone_distance = float(zone_message.get("distance", 0.0))
                log_doc.insert(ignore_permissions=True)

                # Accumulate per-session deltas
                if session_name not in session_deltas:
                    # Seed prev coordinates from the last persisted log for this
                    # session so distance is continuous across separate batch calls.
                    last_log = frappe.db.get_value(
                        "Sprayer GPS Log",
                        {"session": session_name},
                        ["latitude", "longitude"],
                        order_by="captured_at desc",
                        as_dict=True
                    )
                    session_deltas[session_name] = {
                        "points": 0,
                        "distance_m": 0.0,
                        "prev_lat": float(last_log.latitude) if last_log else None,
                        "prev_lon": float(last_log.longitude) if last_log else None,
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
                    "status": "success",
                    "message": "GPS log created successfully.",
                    "name": log_doc.name,
                    "session": session_name,
                    "determined_zone": determined_zone,
                    "zone_confidence": round(confidence * 100, 1) if determined_zone else 0.0,
                    "gps_accuracy": accuracy,
                    "quality_level": quality_level,
                    "zone_detection_details": zone_message
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
            for session_name, delta in session_deltas.items():
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
                            "pts": delta["points"],
                            "dist": round(delta["distance_m"], 2),
                            "name": session_name,
                        }
                    )
                except Exception as e:
                    frappe.log_error(
                        f"Error updating session totals for {session_name}", str(e)
                    )

            frappe.db.commit()
        else:
            frappe.db.rollback()

        # HTTP status
        if has_errors:
            if all(r.get("status") == "error" for r in results):
                frappe.response.http_status_code = 400
            else:
                frappe.response.http_status_code = 207  # Partial success
        else:
            frappe.response.http_status_code = 200

        frappe.response["data"] = results

    except Exception as e:
        frappe.db.rollback()
        frappe.log_error("Fatal error in createSprayerEntry", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}
