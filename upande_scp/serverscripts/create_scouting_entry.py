import json
import frappe
from shapely.geometry import Point, LineString

def get_zone_from_coordinates(latitude, longitude, bed, accuracy=15.0):
    try:
        lat = float(latitude)
        lon = float(longitude)
        accuracy_m = float(accuracy)
        
        # Create point from scout's coordinates
        scout_point = Point(lon, lat)  # GeoJSON uses lon, lat order
        
        # Get all zones for the specified bed
        zones = frappe.get_all(
            "Zone",
            filters={"bed": bed},
            fields=["name", "raw_geojson"]
        )
        
        if not zones:
            return None, 0.0, f"No zones found for bed: {bed}"
        
        # Adaptive buffer based on GPS accuracy
        # Convert meters to degrees (approximation at equator: 1 degree ≈ 111,000 meters)
        buffer_degrees = accuracy_m / 111000.0
        
        # Set reasonable bounds (3m minimum, 50m maximum)
        buffer_degrees = max(0.00003, min(buffer_degrees, 0.00045))
        
        closest_zone = None
        min_distance = float('inf')
        confidence = 0.0
        
        for zone in zones:
            try:
                if not zone.raw_geojson:
                    continue
                
                # Parse GeoJSON
                geojson_data = json.loads(zone.raw_geojson)
                
                if (geojson_data.get("type") == "FeatureCollection" and 
                    geojson_data.get("features")):
                    
                    feature = geojson_data["features"][0]
                    geometry = feature.get("geometry", {})
                    
                    if geometry.get("type") == "LineString":
                        coords = geometry.get("coordinates", [])
                        
                        if len(coords) >= 2:
                            line = LineString(coords)
                            distance = scout_point.distance(line)
                            
                            # Convert distance to meters for comparison
                            distance_m = distance * 111000.0
                            
                            # Create adaptive buffer based on GPS accuracy
                            zone_polygon = line.buffer(buffer_degrees)
                            
                            # Check if point is within buffered zone
                            if zone_polygon.contains(scout_point):
                                if distance < min_distance:
                                    min_distance = distance
                                    closest_zone = zone.name
                                    
                                    # Calculate confidence based on distance vs accuracy
                                    # Very confident if distance is much less than accuracy
                                    if distance_m <= accuracy_m * 0.3:
                                        confidence = 1.0  # Excellent - right on the line
                                    elif distance_m <= accuracy_m * 0.6:
                                        confidence = 0.9  # Very good
                                    elif distance_m <= accuracy_m:
                                        confidence = 0.8  # Good - within accuracy circle
                                    else:
                                        confidence = 0.7  # Acceptable - within buffer
                                        
                            # If not in buffer, still track closest zone
                            elif distance < min_distance:
                                min_distance = distance
                                closest_zone = zone.name
                                
                                # Lower confidence if outside buffer
                                distance_m = distance * 111000.0
                                if distance_m <= accuracy_m * 1.5:
                                    confidence = 0.5  # Fair - close but outside buffer
                                elif distance_m <= accuracy_m * 2.0:
                                    confidence = 0.3  # Poor - might be adjacent zone
                                else:
                                    confidence = 0.1  # Very poor - likely wrong zone
                
            except Exception as e:
                frappe.log_error(f"Error processing zone {zone.name}: {str(e)}")
                continue
        
        if closest_zone:
            min_distance_m = min_distance * 111000.0
            
            # Build detailed message
            message = {
                    "distance": f"{min_distance_m:.1f}",
                    "buffer": f"{buffer_degrees * 111000:.1f}"
                }
            return closest_zone, confidence, message
        else:
            return None, 0.0, f"No zone found within range (accuracy: {accuracy_m}m)"
            
    except Exception as e:
        error_msg = f"Error in get_zone_from_coordinates: {str(e)}"
        frappe.log_error(error_msg)
        return None, 0.0, error_msg


@frappe.whitelist()
def createScoutingEntry():
    try:
        data = frappe.request.get_json()
        if not data:
            frappe.throw("Scouting data is missing from the request body.")

        if isinstance(data, dict):
            data_list = [data]
        elif isinstance(data, list):
            data_list = data
        else:
            frappe.throw("Expected a single scouting entry or a list of entries.")

        results = []

        for entry_data in data_list:
            try:
                # Extract location data
                latitude = entry_data.get('latitude')
                longitude = entry_data.get('longitude')
                accuracy = entry_data.get('accuracy', 15.0)
                bed = entry_data.get('bed')
                
                # Extract optional metadata from Flutter
                quality_level = entry_data.get('quality_level', 'unknown')
                samples_used = entry_data.get('samples_used', 0)
                is_stationary = entry_data.get('is_stationary', False)
                
                # Validate required fields
                if not latitude or not longitude:
                    results.append({
                        "status": "error",
                        "message": "Latitude and longitude are required."
                    })
                    continue
                
                if not bed:
                    results.append({
                        "status": "error",
                        "message": "Bed is required to determine zone."
                    })
                    continue
                
                # Determine zone with accuracy-aware logic
                determined_zone, confidence, zone_message = get_zone_from_coordinates(
                    latitude, 
                    longitude, 
                    bed,
                    accuracy
                )
                
                if not determined_zone:
                    results.append({
                        "status": "error",
                        "message": f"Could not determine zone: {zone_message}",
                        "coordinates": f"({latitude}, {longitude})",
                        "accuracy": accuracy,
                        "bed": bed
                    })
                    continue
                
                # Warn if confidence is too low (but still allow submission)
                requires_review = confidence < 0.5
                
                # Check for duplicate entry
                duplicate_entry = frappe.db.exists(
                    "Scouting Entry", {
                        "scouts_name": entry_data.get('scouts_name'),
                        "greenhouse": entry_data.get('greenhouse'),
                        "bed": bed,
                        "zone": determined_zone,
                        "date_of_capture": entry_data.get('date_of_capture'),
                        "time_of_capture": entry_data.get('time_of_capture')
                    }
                )

                if duplicate_entry:
                    results.append({
                        "status": "error",
                        "message": "Duplicate scouting entry found for this scout, greenhouse, bed, zone, and time."
                    })
                    continue
                
                # Get employee ID
                employee_id = frappe.get_all(
                    "Employee",
                    fields=["name"],
                    filters={"employee_name": entry_data.get('scouts_name')}
                )
                
                if not employee_id:
                    results.append({
                        "status": "error",
                        "message": f"Employee not found: {entry_data.get('scouts_name')}"
                    })
                    continue
                
                # Create scouting entry
                scout_doc = frappe.new_doc("Scouting Entry")
                scout_doc.scouts_name = employee_id[0].name
                scout_doc.greenhouse = entry_data.get('greenhouse')
                scout_doc.bed = bed
                scout_doc.zone = determined_zone
                scout_doc.time_of_capture = entry_data.get('time_of_capture')
                scout_doc.date_of_capture = entry_data.get('date_of_capture')
                scout_doc.latitude = latitude
                scout_doc.longitude = longitude
                
                scout_metadata_doc = frappe.new_doc("Scouting Entry Metadata")
                scout_metadata_doc.latitude = latitude
                scout_metadata_doc.longitude = longitude
                scout_metadata_doc.calculated_zone = determined_zone
                scout_metadata_doc.gps_accuracy = accuracy
                scout_metadata_doc.gps_quality = quality_level
                scout_metadata_doc.gps_confidence = confidence
                scout_metadata_doc.gps_samples_used = samples_used
                scout_metadata_doc.stationary = is_stationary
                scout_metadata_doc.zone_buffer = zone_message["buffer"]
                scout_metadata_doc.distance = zone_message["distance"]
                
                def add_child_items(parent_doc, parent_field, items_list):
                    if items_list and isinstance(items_list, list):
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
                                child_row.physiological_disorders = item.get("disorder")

                            elif parent_field == "weeds_scouting_entry":
                                child_row.weed = item.get("weed")

                            elif parent_field == "pests_scouting_entry":
                                child_row.plant_section = item.get("plant_section")
                                child_row.pest = item.get("pest")
                                child_row.stage = item.get("stage")
                                child_row.count = item.get("count")

                            elif parent_field == "incidents_scouting_entry":
                                child_row.incident = item.get("incident")

                add_child_items(scout_doc, "predators_scouting_entry", entry_data.get("predators_scouting_entry"))
                add_child_items(scout_doc, "diseases_scouting_entry", entry_data.get("diseases_scouting_entry"))
                add_child_items(scout_doc, "physiological_disorders_entry", entry_data.get("physiological_disorders_entry"))
                add_child_items(scout_doc, "weeds_scouting_entry", entry_data.get("weeds_scouting_entry"))
                add_child_items(scout_doc, "pests_scouting_entry", entry_data.get("pests_scouting_entry"))
                add_child_items(scout_doc, "incidents_scouting_entry", entry_data.get("incidents_scouting_entry"))

                scout_doc.insert()
                scout_metadata_doc.insert()
                frappe.db.commit()
             
                # Build success response with detailed info
                result = {
                    "status": "success",
                    "message": "Scouting Entry created successfully.",
                    "name": scout_doc.name,
                    "determined_zone": determined_zone,
                    "zone_confidence": round(confidence * 100, 1),
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
                frappe.db.rollback()
                frappe.log_error(f"Error creating scouting entry: {str(e)}")
                results.append({
                    "status": "error",
                    "message": str(e)
                })
        
        frappe.response["data"] = results

    except Exception as e:
        frappe.log_error(f"Fatal error in createScoutingEntry: {str(e)}")
        frappe.response["data"] = {
            "status": "error",
            "message": str(e)
        }