import ast
import frappe
from datetime import datetime, timedelta
from .geo_utils import get_zone_from_coordinates


@frappe.whitelist()
def fetchTraps(greenhouse=None):
    try:
        filters = {}
        if greenhouse:
            filters["greenhouse"] = greenhouse

        traps = frappe.get_all(
            "Trap",
            filters=filters,
            fields=["name", "farm", "greenhouse", "trap_number", "location", "type"],
            order_by="trap_number asc"
        )

        frappe.response["data"] = traps
        frappe.response.http_status_code = 200

    except Exception as e:
        frappe.log_error("Error fetching traps", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}


@frappe.whitelist()
def fetchTrapPests():
    try:
        pests = frappe.get_all("Pest", fields=["name"], order_by="name asc")

        frappe.response["data"] = [{"name": p.name} for p in pests]
        frappe.response.http_status_code = 200

    except Exception as e:
        frappe.log_error("Error fetching trap pests", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {"status": "error", "message": str(e)}


def _is_duplicate_by_client_id(client_id):
    """
    Fast-path duplicate check using the client-generated ID stored in metadata.
    Returns the name of the existing Scouting Entry if found, otherwise None.
    Gracefully returns None if the client_id column does not yet exist in the schema.
    """
    if not client_id:
        return None
    try:
        existing = frappe.db.get_value(
            "Scouting Entry Metadata",
            {"client_id": client_id},
            "scouting_entry",
        )
        return existing or None
    except Exception:
        return None


def _is_duplicate_by_time_window(employee_name, greenhouse, date_of_capture, time_of_capture, bed, zone):
    """
    Fallback duplicate check: returns True if an entry exists within a 3-second
    window of time_of_capture for the same scout, greenhouse, date, bed, and zone.
    """
    try:
        time_obj = datetime.strptime(time_of_capture, "%H:%M:%S")
    except (ValueError, TypeError):
        # Cannot parse time — fall back to exact match
        filters = {
            "scouts_name": employee_name,
            "greenhouse": greenhouse,
            "date_of_capture": date_of_capture,
            "time_of_capture": time_of_capture,
        }
        if bed:
            filters["bed"] = bed
        if zone:
            filters["zone"] = zone
        return bool(frappe.db.exists("Scouting Entry", filters))

    time_minus = (time_obj - timedelta(seconds=3)).strftime("%H:%M:%S")
    time_plus  = (time_obj + timedelta(seconds=3)).strftime("%H:%M:%S")

    filters = {
        "scouts_name": employee_name,
        "greenhouse": greenhouse,
        "date_of_capture": date_of_capture,
        "time_of_capture": ["between", [time_minus, time_plus]],
    }
    if bed:
        filters["bed"] = bed
    if zone:
        filters["zone"] = zone

    return bool(frappe.db.get_value("Scouting Entry", filters, "name"))


@frappe.whitelist()
def createScoutingEntry():
    try:
        data = frappe.request.get_json()
        frappe.log_error("Scouting Payload", data)

        if not data:
            frappe.response.http_status_code = 400
            frappe.response["data"] = {
                "status": "error",
                "message": "Scouting data is missing from the request body."
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
                "message": "Expected a single scouting entry or a list of entries."
            }
            return

        results = []
        has_errors = False

        for entry_data in data_list:
            try:
                client_id       = entry_data.get('client_id')
                app             = (entry_data.get("app") or "").strip()
                latitude        = entry_data.get('latitude')
                longitude       = entry_data.get('longitude')
                accuracy        = entry_data.get('accuracy')
                bed             = entry_data.get('bed')
                quality_level   = entry_data.get('quality_level', 'unknown')
                samples_used    = entry_data.get('samples_used', 0)
                is_stationary   = entry_data.get('is_stationary', False)

                # --- Fast-path duplicate check by client_id ---
                # If this exact observation was already saved (e.g. the phone
                # synced while offline, then synced again), skip it without
                # re-creating the document.
                existing_entry = _is_duplicate_by_client_id(client_id)
                if existing_entry:
                    results.append({
                        "status": "error",
                        "message": f"Duplicate scouting entry: client_id already synced as {existing_entry}.",
                        "name": existing_entry,
                    })
                    continue

                if not latitude or not longitude:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "Latitude and longitude are required."
                    })
                    continue

                # --- Zone determination ---
                determined_zone = None
                confidence      = 0.0
                zone_message    = None

                if latitude and longitude and accuracy:
                    determined_zone, confidence, zone_message = get_zone_from_coordinates(
                        latitude, longitude, bed, accuracy
                    )

                # Normalize zone_message to a dict
                if not isinstance(zone_message, dict):
                    zone_message = {"distance": "0.0", "buffer": "0.0", "fallback": False}

                # Zone is required when a bed is provided
                if bed and not determined_zone:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": f"Could not determine zone for bed: {bed}. No zone geometry found.",
                        "coordinates": f"({latitude}, {longitude})",
                        "accuracy": accuracy,
                        "bed": bed
                    })
                    continue

                requires_review = confidence < 0.5 and determined_zone is not None

                # --- Employee lookup ---
                employee_rows = frappe.get_all(
                    "Employee",
                    fields=["name"],
                    filters={"user_id": entry_data.get('scouts_name')}
                )

                if not employee_rows:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": f"Employee not found: {entry_data.get('scouts_name')}"
                    })
                    continue

                employee_name = employee_rows[0].name

                # --- Time-window duplicate check (fallback when no client_id) ---
                if not client_id and _is_duplicate_by_time_window(
                    employee_name,
                    entry_data.get('greenhouse'),
                    entry_data.get('date_of_capture'),
                    entry_data.get('time_of_capture'),
                    bed,
                    determined_zone,
                ):
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "Duplicate scouting entry: an entry already exists within 3 seconds of this capture time."
                    })
                    continue

                # --- Create Scouting Entry ---
                scout_doc = frappe.new_doc("Scouting Entry")
                scout_doc.scouts_name     = employee_name
                scout_doc.greenhouse      = entry_data.get('greenhouse')
                scout_doc.bed             = bed
                scout_doc.zone            = determined_zone
                scout_doc.time_of_capture = entry_data.get('time_of_capture')
                scout_doc.date_of_capture = entry_data.get('date_of_capture')
                scout_doc.latitude        = latitude
                scout_doc.longitude       = longitude

                scout_metadata_doc = frappe.new_doc("Scouting Entry Metadata")
                scout_metadata_doc.app              = app or None
                scout_metadata_doc.latitude         = latitude
                scout_metadata_doc.longitude        = longitude
                scout_metadata_doc.calculated_zone  = determined_zone
                scout_metadata_doc.gps_accuracy     = accuracy
                scout_metadata_doc.gps_quality      = quality_level
                scout_metadata_doc.gps_confidence   = confidence
                scout_metadata_doc.gps_samples_used = samples_used
                scout_metadata_doc.stationary       = is_stationary
                scout_metadata_doc.zone_buffer      = zone_message["buffer"]
                scout_metadata_doc.distance         = zone_message["distance"]

                def add_child_items(parent_doc, parent_field, items_list):
                    if not items_list or not isinstance(items_list, list):
                        return
                    for item in items_list:
                        if not item:
                            continue
                        child_row = parent_doc.append(parent_field, {})

                        if parent_field == "predators_scouting_entry":
                            child_row.plant_section = item.get("plant_section")
                            child_row.predator      = item.get("predator")
                            child_row.stage         = item.get("stage")
                            child_row.count         = item.get("count")

                        elif parent_field == "diseases_scouting_entry":
                            child_row.plant_section = item.get("plant_section")
                            child_row.disease       = item.get("disease")
                            child_row.count         = item.get("count")
                            child_row.stage         = item.get("stage")

                        elif parent_field == "physiological_disorders_entry":
                            child_row.plant_section           = item.get("plant_section")
                            child_row.physiological_disorders = item.get("physiological_disorders")

                        elif parent_field == "crop_husbandry_practices_entry":
                            child_row.plant_section            = item.get("plant_section")
                            child_row.crop_husbandry_practices = item.get("crop_husbandry_practices")

                        elif parent_field == "weeds_scouting_entry":
                            child_row.weed = item.get("weed")

                        elif parent_field == "pests_scouting_entry":
                            child_row.plant_section = item.get("plant_section")
                            child_row.pest          = item.get("pest")
                            child_row.stage         = item.get("stage")
                            child_row.count         = item.get("count")

                        elif parent_field == "incidents_scouting_entry":
                            child_row.incident = item.get("incident")

                        elif parent_field == "trap_scouting_entry":
                            child_row.trap     = item.get("trap")
                            child_row.pest     = item.get("pest")
                            child_row.location = item.get("location", "Indoor")
                            child_row.count    = item.get("count")

                add_child_items(scout_doc, "predators_scouting_entry",       entry_data.get("predators_scouting_entry"))
                add_child_items(scout_doc, "diseases_scouting_entry",        entry_data.get("diseases_scouting_entry"))
                add_child_items(scout_doc, "physiological_disorders_entry",  entry_data.get("physiological_disorders_entry"))
                add_child_items(scout_doc, "crop_husbandry_practices_entry", entry_data.get("crop_husbandry_practices_entry"))
                add_child_items(scout_doc, "weeds_scouting_entry",           entry_data.get("weeds_scouting_entry"))
                add_child_items(scout_doc, "pests_scouting_entry",           entry_data.get("pests_scouting_entry"))
                add_child_items(scout_doc, "incidents_scouting_entry",       entry_data.get("incidents_scouting_entry"))
                add_child_items(scout_doc, "trap_scouting_entry",            entry_data.get("trap_scouting_entry"))

                scout_doc.insert()

                scout_metadata_doc.scouting_entry = scout_doc.name
                scout_metadata_doc.insert()

                # Store client_id in metadata for future fast-path duplicate detection.
                # Uses set_value to bypass doctype validation — if the field does not
                # exist yet, this silently no-ops rather than rolling back the insert.
                if client_id:
                    try:
                        frappe.db.set_value(
                            "Scouting Entry Metadata",
                            scout_metadata_doc.name,
                            "client_id",
                            client_id,
                            update_modified=False,
                        )
                    except Exception:
                        pass  # field not yet in schema — degrade to time-window check only

                result = {
                    "status": "success",
                    "message": "Scouting Entry created successfully.",
                    "name": scout_doc.name,
                    "metadata_name": scout_metadata_doc.name,
                    "determined_zone": determined_zone,
                    "zone_confidence": round(confidence * 100, 1) if determined_zone else 0.0,
                    "zone_fallback": zone_message.get("fallback", False),
                    "gps_accuracy": accuracy,
                    "quality_level": quality_level,
                    "zone_detection_details": zone_message,
                }

                if requires_review:
                    result["warning"] = (
                        f"Low confidence ({confidence * 100:.0f}%) - "
                        f"Zone may need manual verification"
                    )

                results.append(result)

            except Exception as e:
                has_errors = True
                frappe.log_error("Error creating scouting entry", str(e))
                results.append({"status": "error", "message": str(e)})

        # Single commit for the entire batch
        if any(r.get("status") == "success" for r in results):
            frappe.db.commit()
        else:
            frappe.db.rollback()

        if has_errors:
            if all(r.get("status") == "error" for r in results):
                frappe.response.http_status_code = 400
            else:
                frappe.response.http_status_code = 207  # Partial success
        else:
            frappe.response.http_status_code = 200

        frappe.response["data"] = results

    except Exception as e:
        frappe.response.http_status_code = 500
        frappe.log_error("Fatal error in createScoutingEntry", str(e))
        frappe.response["data"] = {"status": "error", "message": str(e)}


# ----------------------------------------------------------------------
# Backlog recovery
# ----------------------------------------------------------------------
# Replays Scouting Entries that failed to save during the SEM naming-counter
# outage (the mobile endpoint logs every payload to the Error Log as title
# "Scouting Payload"). This lives here (not in the System Console) because
# the console sandbox (safe_exec / RestrictedPython) forbids `import`, which
# recovery needs (ast parsing + geo zone lookup). It is whitelisted so it can
# be invoked from the System Console via frappe.call(...).
_RECOVERY_CHILD_FIELDS = (
    "predators_scouting_entry",
    "diseases_scouting_entry",
    "physiological_disorders_entry",
    "crop_husbandry_practices_entry",
    "weeds_scouting_entry",
    "pests_scouting_entry",
    "incidents_scouting_entry",
    "trap_scouting_entry",
)


def _recover_add_child_items(parent_doc, parent_field, items_list):
    """Identical mapping to add_child_items() inside createScoutingEntry."""
    if not items_list or not isinstance(items_list, list):
        return
    for item in items_list:
        if not item:
            continue
        child_row = parent_doc.append(parent_field, {})
        if parent_field == "predators_scouting_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.predator = item.get("predator")
            child_row.stage = item.get("stage")
            child_row.count = item.get("count")
        elif parent_field == "diseases_scouting_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.disease = item.get("disease")
            child_row.count = item.get("count")
            child_row.stage = item.get("stage")
        elif parent_field == "physiological_disorders_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.physiological_disorders = item.get("physiological_disorders")
        elif parent_field == "crop_husbandry_practices_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.crop_husbandry_practices = item.get("crop_husbandry_practices")
        elif parent_field == "weeds_scouting_entry":
            child_row.weed = item.get("weed")
        elif parent_field == "pests_scouting_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.pest = item.get("pest")
            child_row.stage = item.get("stage")
            child_row.count = item.get("count")
        elif parent_field == "incidents_scouting_entry":
            child_row.incident = item.get("incident")
        elif parent_field == "trap_scouting_entry":
            child_row.trap = item.get("trap")
            child_row.pest = item.get("pest")
            child_row.location = item.get("location", "Indoor")
            child_row.count = item.get("count")


@frappe.whitelist()
def recoverScoutingBacklog(dry_run=1, outage_start="2026-05-25 09:35:00", max_create=0, commit_every=200):
    """Recover Scouting Entries that failed during the SEM naming-counter outage.

    Reads the "Scouting Payload" Error Logs since `outage_start`, de-duplicates
    by client_id, SKIPS anything already saved (so it is idempotent / safe to
    re-run), preserves each entry's original date_of_capture / time_of_capture,
    and mirrors createScoutingEntry's per-entry creation.

    Run AFTER the naming counter has been fixed. From the System Console:

        print(frappe.call(
            "upande_scp.serverscripts.mobile.create_scouting_entry.recoverScoutingBacklog",
            dry_run=1))

    Review the summary, then call again with dry_run=0 to apply. Re-run until
    "created" is 0 to confirm the backlog is fully drained. Use max_create to
    process in bounded chunks if the request would otherwise time out.
    """
    dry_run = int(dry_run)
    max_create = int(max_create or 0)
    commit_every = int(commit_every or 200)

    logs = frappe.db.sql(
        """
        SELECT error FROM `tabError Log`
        WHERE method = 'Scouting Payload' AND creation >= %s
        ORDER BY creation ASC
        """,
        (outage_start,),
    )

    entries_by_cid = {}
    no_client_id = 0
    parse_fail = 0
    for (err,) in logs:
        try:
            data = ast.literal_eval(err)
        except Exception:
            parse_fail += 1
            continue
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            continue
        for e in data:
            if not isinstance(e, dict):
                continue
            cid = e.get("client_id")
            if not cid:
                no_client_id += 1
                continue
            entries_by_cid.setdefault(cid, e)

    saved_rows = frappe.db.sql(
        "SELECT client_id FROM `tabScouting Entry Metadata` "
        "WHERE client_id IS NOT NULL AND client_id != ''"
    )
    saved_cids = set(r[0] for r in saved_rows)
    candidates = [(cid, e) for cid, e in entries_by_cid.items() if cid not in saved_cids]

    summary = {
        "dry_run": bool(dry_run),
        "payload_logs": len(logs),
        "parse_failures": parse_fail,
        "without_client_id": no_client_id,
        "unique_client_ids": len(entries_by_cid),
        "already_saved": len(entries_by_cid) - len(candidates),
        "candidates": len(candidates),
        "created": 0,
        "skipped_no_coords": 0,
        "skipped_no_zone": 0,
        "skipped_no_employee": 0,
        "errors": 0,
        "examples": {"no_zone": [], "no_employee": [], "error": []},
    }

    emp_cache = {}
    _MISSING = object()

    for cid, entry_data in candidates:
        if max_create and summary["created"] >= max_create:
            break
        try:
            latitude = entry_data.get("latitude")
            longitude = entry_data.get("longitude")
            accuracy = entry_data.get("accuracy")
            bed = entry_data.get("bed")
            app = (entry_data.get("app") or "").strip()
            quality_level = entry_data.get("quality_level", "unknown")
            samples_used = entry_data.get("samples_used", 0)
            is_stationary = entry_data.get("is_stationary", False)

            if not latitude or not longitude:
                summary["skipped_no_coords"] += 1
                continue

            determined_zone, confidence, zone_message = (None, 0.0, None)
            if latitude and longitude and accuracy:
                determined_zone, confidence, zone_message = get_zone_from_coordinates(
                    latitude, longitude, bed, accuracy
                )
            if not isinstance(zone_message, dict):
                zone_message = {"distance": "0.0", "buffer": "0.0", "fallback": False}

            if bed and not determined_zone:
                summary["skipped_no_zone"] += 1
                if len(summary["examples"]["no_zone"]) < 5:
                    summary["examples"]["no_zone"].append(cid)
                continue

            scout_user = entry_data.get("scouts_name")
            employee_name = emp_cache.get(scout_user, _MISSING)
            if employee_name is _MISSING:
                rows = frappe.get_all("Employee", fields=["name"], filters={"user_id": scout_user})
                employee_name = rows[0].name if rows else None
                emp_cache[scout_user] = employee_name
            if not employee_name:
                summary["skipped_no_employee"] += 1
                if len(summary["examples"]["no_employee"]) < 5:
                    summary["examples"]["no_employee"].append("%s -> %s" % (cid, scout_user))
                continue

            if dry_run:
                summary["created"] += 1
                continue

            scout_doc = frappe.new_doc("Scouting Entry")
            scout_doc.scouts_name = employee_name
            scout_doc.greenhouse = entry_data.get("greenhouse")
            scout_doc.bed = bed
            scout_doc.zone = determined_zone
            scout_doc.time_of_capture = entry_data.get("time_of_capture")
            scout_doc.date_of_capture = entry_data.get("date_of_capture")
            scout_doc.latitude = latitude
            scout_doc.longitude = longitude
            for f in _RECOVERY_CHILD_FIELDS:
                _recover_add_child_items(scout_doc, f, entry_data.get(f))
            scout_doc.insert(ignore_permissions=True)

            meta = frappe.new_doc("Scouting Entry Metadata")
            meta.scouting_entry = scout_doc.name
            meta.app = app or None
            meta.latitude = latitude
            meta.longitude = longitude
            meta.calculated_zone = determined_zone
            meta.gps_accuracy = accuracy
            meta.gps_quality = quality_level
            meta.gps_confidence = confidence
            meta.gps_samples_used = samples_used
            meta.stationary = is_stationary
            meta.zone_buffer = zone_message.get("buffer")
            meta.distance = zone_message.get("distance")
            meta.insert(ignore_permissions=True)
            frappe.db.set_value(
                "Scouting Entry Metadata", meta.name, "client_id", cid, update_modified=False
            )

            saved_cids.add(cid)
            summary["created"] += 1
            if summary["created"] % commit_every == 0:
                frappe.db.commit()

        except Exception as e:
            summary["errors"] += 1
            if not dry_run:
                frappe.db.rollback()
            if len(summary["examples"]["error"]) < 10:
                summary["examples"]["error"].append("%s -> %s" % (cid, str(e)[:160]))

    if not dry_run:
        frappe.db.commit()

    return summary
