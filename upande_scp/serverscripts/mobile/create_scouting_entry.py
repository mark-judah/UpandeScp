import frappe
from datetime import datetime, timedelta
from .geo_utils import get_zone_from_coordinates, get_tree_from_coordinates


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


def _is_duplicate_by_time_window(
    employee_name,
    date_of_capture,
    time_of_capture,
    greenhouse=None,
    bed=None,
    zone=None,
    block=None,
    row=None,
    tree=None,
):
    """
    Fallback duplicate check: returns True if an entry exists within a 3-second
    window of time_of_capture for the same scout, date, and location. The
    location fields are passed per-flow — only the ones that are set are added
    to the filter.
    """
    base_filters = {
        "scouts_name": employee_name,
        "date_of_capture": date_of_capture,
    }
    if greenhouse:
        base_filters["greenhouse"] = greenhouse
    if bed:
        base_filters["bed"] = bed
    if zone:
        base_filters["zone"] = zone
    if block:
        base_filters["block"] = block
    if row:
        base_filters["row"] = row
    if tree:
        base_filters["tree"] = tree

    try:
        time_obj = datetime.strptime(time_of_capture, "%H:%M:%S")
    except (ValueError, TypeError):
        filters = dict(base_filters, time_of_capture=time_of_capture)
        return bool(frappe.db.exists("Scouting Entry", filters))

    time_minus = (time_obj - timedelta(seconds=3)).strftime("%H:%M:%S")
    time_plus  = (time_obj + timedelta(seconds=3)).strftime("%H:%M:%S")

    filters = dict(
        base_filters,
        time_of_capture=["between", [time_minus, time_plus]],
    )
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
                app             = entry_data.get('app')
                latitude        = entry_data.get('latitude')
                longitude       = entry_data.get('longitude')
                accuracy        = entry_data.get('accuracy')
                greenhouse      = entry_data.get('greenhouse')
                bed             = entry_data.get('bed')
                block           = entry_data.get('block')
                row             = entry_data.get('row')
                tree            = entry_data.get('tree')
                quality_level   = entry_data.get('quality_level', 'unknown')
                samples_used    = entry_data.get('samples_used', 0)
                is_stationary   = entry_data.get('is_stationary', False)

                is_block_flow = bool(block or row or tree)
                # Greenhouse/Bed flow: GPS rounds to nearest Zone (filtered by bed).
                # Block/Row flow:      GPS rounds to nearest Tree (filtered by row).
                bed_for_zone = bed if not is_block_flow else None
                row_for_tree = row if is_block_flow else None

                # --- Fast-path duplicate check by client_id ---
                # If this exact observation was already saved (e.g. the phone
                # synced while offline, then synced again), skip it without
                # re-creating the document.
                existing_entry = _is_duplicate_by_client_id(client_id)
                if existing_entry:
                    # Structured "duplicate" status (not a generic error) so the
                    # client can mark the local row synced without string-matching.
                    results.append({
                        "status": "duplicate",
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

                # --- Zone / Tree determination ---
                determined_zone = None
                determined_tree = None
                confidence      = 0.0
                zone_message    = None

                if latitude and longitude and accuracy and bed_for_zone:
                    determined_zone, confidence, zone_message = get_zone_from_coordinates(
                        latitude, longitude, bed_for_zone, accuracy
                    )
                elif latitude and longitude and accuracy and row_for_tree:
                    determined_tree, confidence, zone_message = get_tree_from_coordinates(
                        latitude, longitude, row_for_tree, accuracy, block=block
                    )

                # Normalize zone_message to a dict
                if not isinstance(zone_message, dict):
                    zone_message = {"distance": "0.0", "buffer": "0.0", "fallback": False}

                # Zone is required when a bed is provided (Greenhouse flow).
                if bed_for_zone and not determined_zone:
                    has_errors = True
                    results.append({
                        "status": "error",
                        "message": f"Could not determine zone for bed: {bed_for_zone}. No zone geometry found.",
                        "coordinates": f"({latitude}, {longitude})",
                        "accuracy": accuracy,
                        "bed": bed_for_zone
                    })
                    continue

                # Tree detection is best-effort in the Block flow — if no tree
                # matches the GPS point (e.g. row has no trees with raw_geojson
                # yet), persist the entry at block/row granularity without a tree.
                if row_for_tree and not determined_tree:
                    frappe.log_error(
                        "Scouting: tree not determined",
                        f"row={row_for_tree} block={block} coords=({latitude},{longitude}) accuracy={accuracy}",
                    )

                requires_review = confidence < 0.5 and (determined_zone or determined_tree) is not None

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
                    entry_data.get('date_of_capture'),
                    entry_data.get('time_of_capture'),
                    greenhouse=greenhouse,
                    bed=bed,
                    zone=determined_zone,
                    block=block,
                    row=row,
                    tree=tree,
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
                if is_block_flow:
                    scout_doc.block = block
                    scout_doc.row   = row
                    scout_doc.tree  = determined_tree or tree
                else:
                    scout_doc.greenhouse = greenhouse
                    scout_doc.bed        = bed
                    scout_doc.zone       = determined_zone
                scout_doc.time_of_capture = entry_data.get('time_of_capture')
                scout_doc.date_of_capture = entry_data.get('date_of_capture')
                scout_doc.latitude        = latitude
                scout_doc.longitude       = longitude
                scout_doc.crop_scouted    = entry_data.get('crop_scouted')

                scout_metadata_doc = frappe.new_doc("Scouting Entry Metadata")
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

                        elif parent_field == "crop_modelling_entry":
                            child_row.tree        = item.get("tree")
                            child_row.leaf_size   = item.get("leaf_size")
                            child_row.leaf_color  = item.get("leaf_color")
                            child_row.fruit_stage = item.get("fruit_stage")
                            child_row.root_flush  = 1 if item.get("root_flush") else 0

                add_child_items(scout_doc, "predators_scouting_entry",       entry_data.get("predators_scouting_entry"))
                add_child_items(scout_doc, "diseases_scouting_entry",        entry_data.get("diseases_scouting_entry"))
                add_child_items(scout_doc, "physiological_disorders_entry",  entry_data.get("physiological_disorders_entry"))
                add_child_items(scout_doc, "crop_husbandry_practices_entry", entry_data.get("crop_husbandry_practices_entry"))
                add_child_items(scout_doc, "weeds_scouting_entry",           entry_data.get("weeds_scouting_entry"))
                add_child_items(scout_doc, "pests_scouting_entry",           entry_data.get("pests_scouting_entry"))
                add_child_items(scout_doc, "incidents_scouting_entry",       entry_data.get("incidents_scouting_entry"))
                add_child_items(scout_doc, "trap_scouting_entry",            entry_data.get("trap_scouting_entry"))
                add_child_items(scout_doc, "crop_modelling_entry",           entry_data.get("crop_modelling_entry"))

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
                if app:
                    try:
                        frappe.db.set_value(
                            "Scouting Entry Metadata",
                            scout_metadata_doc.name,
                            "app",
                            app,
                            update_modified=False,
                        )
                    except Exception:
                        pass

                result = {
                    "status": "success",
                    "message": "Scouting Entry created successfully.",
                    "name": scout_doc.name,
                    "metadata_name": scout_metadata_doc.name,
                    "determined_zone": determined_zone,
                    "determined_tree": determined_tree,
                    "zone_confidence": round(confidence * 100, 1) if (determined_zone or determined_tree) else 0.0,
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


@frappe.whitelist()
def reconcileScoutingEntries():
    """Reconcile a list of client_ids against what the server already stored.

    The mobile app sends the client_ids of its un-synced (pending/stuck) rows;
    we return the subset that already exist as Scouting Entries (mapped to their
    docname). The app marks those rows synced locally — recovering entries the
    server saved but never acked (network dropped after the save) — and re-pushes
    only the ones genuinely missing. Read-only; never writes.

    Request body: {"client_ids": ["...", "..."]}  (JSON list or JSON string)
    Response:     {"existing": {client_id: scouting_entry_name, ...}}
    """
    try:
        raw = frappe.form_dict.get("client_ids")
        if isinstance(raw, str):
            try:
                client_ids = frappe.parse_json(raw)
            except Exception:
                client_ids = [raw]
        else:
            client_ids = raw or []

        # Dedupe + drop blanks; cap the batch so a huge queue can't build a
        # pathological IN (...) clause.
        client_ids = [c for c in dict.fromkeys(client_ids) if c][:500]

        existing = {}
        if client_ids:
            rows = frappe.get_all(
                "Scouting Entry Metadata",
                filters={"client_id": ["in", client_ids]},
                fields=["client_id", "scouting_entry"],
            )
            for r in rows:
                if r.get("client_id") and r.get("scouting_entry"):
                    existing[r["client_id"]] = r["scouting_entry"]

        frappe.response.http_status_code = 200
        frappe.response["data"] = {"existing": existing}

    except Exception as e:
        frappe.response.http_status_code = 500
        frappe.log_error("Error in reconcileScoutingEntries", str(e))
        frappe.response["data"] = {"status": "error", "message": str(e)}
