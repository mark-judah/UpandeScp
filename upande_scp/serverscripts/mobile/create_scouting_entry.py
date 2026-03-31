import frappe
from .geo_utils import get_zone_from_coordinates


@frappe.whitelist()
def fetchTraps(greenhouse=None):
    """
    Fetches all traps, optionally filtered by greenhouse.
    """
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
        frappe.response["data"] = {
            "status": "error",
            "message": str(e)
        }


@frappe.whitelist()
def fetchTrapPests():
    """
    Fetches all pests that can be recorded in traps.
    You can filter this based on which pests are commonly found in traps.
    """
    try:
        pests = frappe.get_all(
            "Pest",
            fields=["name"],
            order_by="name asc"
        )

        formatted_pests = []
        for pest in pests:
            formatted_pests.append({
                "name": pest.name
            })

        frappe.response["data"] = formatted_pests
        frappe.response.http_status_code = 200

    except Exception as e:
        frappe.log_error("Error fetching trap pests", str(e))
        frappe.response.http_status_code = 500
        frappe.response["data"] = {
            "status": "error",
            "message": str(e)
        }
        
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
                # Extract location data
                latitude = entry_data.get('latitude')
                longitude = entry_data.get('longitude')
                accuracy = entry_data.get('accuracy')
                # Bed is now optional (can be None)
                bed = entry_data.get('bed') 

                # Extract optional metadata from Flutter
                quality_level = entry_data.get('quality_level', 'unknown')
                samples_used = entry_data.get('samples_used', 0)
                is_stationary = entry_data.get('is_stationary', False)

                # Validate required fields
                if not latitude or not longitude:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "Latitude and longitude are required."
                    })
                    continue

                # --- START OF CHANGE: Conditional logic for Bed and Zone determination ---
                determined_zone = None
                confidence = 0.0
                zone_message = None
                
                # We only need to attempt zone determination if we have coordinates
                if latitude and longitude and accuracy:
                    # Determine zone with accuracy-aware logic
                    determined_zone, confidence, zone_message = get_zone_from_coordinates(
                        latitude,
                        longitude,
                        bed, # Pass bed, which can be None or ""
                        accuracy
                    )

                # If zone determination was attempted but failed, log it as a non-fatal error 
                # UNLESS 'bed' was provided, which suggests the client expected a zone.
                # However, for maximum flexibility, we only halt if bed was provided AND zone failed.
                # If bed is missing, we allow zone to be None (for non-bed-based scouting)
                if bed and not determined_zone:
                    has_errors = True
                    # Use a default message if zone_message isn't set due to an earlier error in get_zone_from_coordinates
                    msg = zone_message or f"Could not determine zone for provided Bed: {bed}"
                    results.append({
                        "status": "error",
                        "message": f"Could not determine zone: {msg}",
                        "coordinates": f"({latitude}, {longitude})",
                        "accuracy": accuracy,
                        "bed": bed
                    })
                    continue
                
                # Set default zone message structure if zone determination was skipped or failed without a detailed message
                if not zone_message:
                     zone_message = {
                        "distance": "0.0",
                        "buffer": "0.0"
                    }
                
                # The 'bed' field in the document will be the value from the payload (even if None/empty)
                # The 'zone' field in the document will be the determined_zone (which can be None if not found/needed)
                
                # --- END OF CHANGE: Conditional logic for Bed and Zone determination ---
                
                # Warn if confidence is too low (but still allow submission)
                requires_review = confidence < 0.5 and determined_zone is not None

                # Check for duplicate entry - ONLY IF we have a determined_zone
                duplicate_filters = {
                    "scouts_name": entry_data.get('scouts_name'),
                    "greenhouse": entry_data.get('greenhouse'),
                    "date_of_capture": entry_data.get('date_of_capture'),
                    "time_of_capture": entry_data.get('time_of_capture')
                }
                
                # Only add bed and zone to duplicate check if they exist
                if bed:
                    duplicate_filters["bed"] = bed
                if determined_zone:
                    duplicate_filters["zone"] = determined_zone

                duplicate_entry = frappe.db.exists("Scouting Entry", duplicate_filters)

                if duplicate_entry:
                    # This is still an error even if no bed/zone, as it's a time-based duplicate
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": "Duplicate scouting entry found for this scout, greenhouse, and time."
                    })
                    continue

                # Get employee ID
                employee_id = frappe.get_all(
                    "Employee",
                    fields=["name"],
                    filters={"user_id": entry_data.get('scouts_name')}
                )

                if not employee_id:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": f"Employee not found: {entry_data.get('scouts_name')}"
                    })
                    continue

                # Create scouting entry
                scout_doc = frappe.new_doc("Scouting Entry")
                scout_doc.scouts_name = employee_id[0].name
                scout_doc.greenhouse = entry_data.get('greenhouse')
                scout_doc.bed = bed # Stays the provided value (can be None)
                scout_doc.zone = determined_zone # Stays the determined value (can be None)
                scout_doc.time_of_capture = entry_data.get('time_of_capture')
                scout_doc.date_of_capture = entry_data.get('date_of_capture')
                scout_doc.latitude = latitude
                scout_doc.longitude = longitude

                # Create metadata document (will be inserted after scout_doc)
                scout_metadata_doc = frappe.new_doc("Scouting Entry Metadata")
                scout_metadata_doc.latitude = latitude
                scout_metadata_doc.longitude = longitude
                scout_metadata_doc.calculated_zone = determined_zone
                scout_metadata_doc.gps_accuracy = accuracy
                scout_metadata_doc.gps_quality = quality_level
                scout_metadata_doc.gps_confidence = confidence
                scout_metadata_doc.gps_samples_used = samples_used
                scout_metadata_doc.stationary = is_stationary
                # Use values from the (potentially default) zone_message
                scout_metadata_doc.zone_buffer = zone_message["buffer"]
                scout_metadata_doc.distance = zone_message["distance"]

                def add_child_items(parent_doc, parent_field, items_list):
                    if items_list and isinstance(items_list, list):
                        for item in items_list:
                            if not item:
                                continue

                            child_row = parent_doc.append(parent_field, {})

                            if parent_field == "predators_scouting_entry":
                                child_row.plant_section = item.get(
                                    "plant_section")
                                child_row.predator = item.get("predator")
                                child_row.stage = item.get("stage")
                                child_row.count = item.get("count")

                            elif parent_field == "diseases_scouting_entry":
                                child_row.plant_section = item.get(
                                    "plant_section")
                                child_row.disease = item.get("disease")
                                child_row.count = item.get("count")
                                child_row.stage = item.get("stage")

                            elif parent_field == "physiological_disorders_entry":
                                child_row.plant_section = item.get(
                                    "plant_section")
                                child_row.physiological_disorders = item.get(
                                    "physiological_disorders")

                            elif parent_field == "crop_husbandry_practices_entry":
                                child_row.plant_section = item.get(
                                    "plant_section")
                                child_row.crop_husbandry_practices = item.get(
                                    "crop_husbandry_practices")

                            elif parent_field == "weeds_scouting_entry":
                                child_row.weed = item.get("weed")

                            elif parent_field == "pests_scouting_entry":
                                child_row.plant_section = item.get(
                                    "plant_section")
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

                add_child_items(scout_doc, "predators_scouting_entry",
                                entry_data.get("predators_scouting_entry"))
                add_child_items(scout_doc, "diseases_scouting_entry",
                                entry_data.get("diseases_scouting_entry"))
                add_child_items(scout_doc, "physiological_disorders_entry", entry_data.get(
                    "physiological_disorders_entry"))
                add_child_items(scout_doc, "crop_husbandry_practices_entry", entry_data.get(
                    "crop_husbandry_practices_entry"))
                add_child_items(scout_doc, "weeds_scouting_entry",
                                entry_data.get("weeds_scouting_entry"))
                add_child_items(scout_doc, "pests_scouting_entry",
                                entry_data.get("pests_scouting_entry"))
                add_child_items(scout_doc, "incidents_scouting_entry",
                                entry_data.get("incidents_scouting_entry"))
                add_child_items(scout_doc, "trap_scouting_entry",
                                entry_data.get("trap_scouting_entry"))
                # Insert scout entry first
                scout_doc.insert()

                # Link metadata to scout entry and insert
                scout_metadata_doc.scouting_entry = scout_doc.name
                scout_metadata_doc.insert()

                # Build success response with detailed info
                result = {
                    "status": "success",
                    "message": "Scouting Entry created successfully.",
                    "name": scout_doc.name,
                    "metadata_name": scout_metadata_doc.name,
                    "determined_zone": determined_zone,
                    "zone_confidence": round(confidence * 100, 1) if determined_zone else 0.0,
                    "gps_accuracy": accuracy,
                    "quality_level": quality_level,
                    "zone_detection_details": zone_message
                }

                # Add warning if confidence is low
                if requires_review:
                    result["warning"] = (f"Low confidence ({confidence*100:.0f}%) - "
                                         f"Zone may need manual verification")

                results.append(result)

            except Exception as e:
                has_errors = True
                frappe.log_error("Error creating scouting entry", str(e))
                results.append({
                    "status": "error",
                    "message": str(e)
                })

        # Commit once for the entire batch (or rollback if all failed)
        if any(r.get("status") == "success" for r in results):
            frappe.db.commit()
        else:
            frappe.db.rollback()

        # Set appropriate HTTP status code based on results
        if has_errors:
            if len(results) > 0 and all(r.get("status") == "error" for r in results):
                # All entries failed
                frappe.response.http_status_code = 400
            else:
                # Partial success (some succeeded, some failed)
                frappe.response.http_status_code = 207  # Multi-Status
        else:
            # All succeeded
            frappe.response.http_status_code = 200

        frappe.response["data"] = results

    except Exception as e:
        frappe.response.http_status_code = 500
        frappe.log_error("Fatal error in createScoutingEntry",str(e))
        frappe.response["data"] = {
            "status": "error",
            "message": str(e)
        }
