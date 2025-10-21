import json
import frappe
from shapely.geometry import Point, LineString, Polygon

def get_zone_from_coordinates(latitude, longitude, bed):
    """
    Determines the zone based on coordinates and bed.
    Uses buffer around LineString to create polygons for zone detection.
    """
    try:
        lat = float(latitude)
        lon = float(longitude)
        
        # Create point from scout's coordinates
        scout_point = Point(lon, lat)  # Note: GeoJSON uses lon, lat order
        
        # Get all zones for the specified bed
        zones = frappe.get_all(
            "Zone",
            filters={"bed": bed},
            fields=["name", "raw_geojson"]
        )
        
        if not zones:
            frappe.log_error(f"No zones found for bed: {bed}")
            return None
        
        closest_zone = None
        min_distance = float('inf')
        
        for zone in zones:
            try:
                if not zone.raw_geojson:
                    continue
                
                # Parse GeoJSON
                geojson_data = json.loads(zone.raw_geojson)
                
                # Extract coordinates from the LineString
                if (geojson_data.get("type") == "FeatureCollection" and 
                    geojson_data.get("features")):
                    
                    feature = geojson_data["features"][0]
                    geometry = feature.get("geometry", {})
                    
                    if geometry.get("type") == "LineString":
                        coords = geometry.get("coordinates", [])
                        
                        if len(coords) >= 2:
                            # Create a LineString from coordinates
                            line = LineString(coords)
                            
                            # Calculate distance from point to line
                            distance = scout_point.distance(line)
                            
                            # Create a buffer around the line to check if point is within zone
                            # Buffer distance can be adjusted based on your needs (in degrees)
                            # ~0.00005 degrees ≈ 5-6 meters at the equator
                            buffer_distance = 0.00005
                            zone_polygon = line.buffer(buffer_distance)
                            
                            # Check if point is within the buffered zone
                            if zone_polygon.contains(scout_point):
                                if distance < min_distance:
                                    min_distance = distance
                                    closest_zone = zone.name
                            # If no zone contains the point, track the closest one
                            elif distance < min_distance:
                                min_distance = distance
                                closest_zone = zone.name
                
            except Exception as e:
                frappe.log_error(f"Error processing zone {zone.name}: {str(e)}")
                continue
        
        if closest_zone:
            frappe.log_error(f"Zone determined: {closest_zone} (distance: {min_distance})")
            return closest_zone
        else:
            frappe.log_error(f"Could not determine zone for coordinates: {lat}, {lon} in bed: {bed}")
            return None
            
    except Exception as e:
        frappe.log_error(f"Error in get_zone_from_coordinates: {str(e)}")
        return None

@frappe.whitelist()
def createScoutingEntry():
    try:
        data = frappe.request.get_json()
        if not data:
            frappe.throw(_("Scouting data is missing from the request body."))

        if isinstance(data, dict):
            data_list = [data]
        elif isinstance(data, list):
            data_list = data
        else:
            frappe.throw(_("Expected a single scouting entry or a list of entries."))

        results = []

        for entry_data in data_list:
            try:
                # Get latitude and longitude from entry data
                latitude = entry_data.get('latitude')
                longitude = entry_data.get('longitude')
                bed = entry_data.get('bed')
                
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
                
                # Determine zone from coordinates
                determined_zone = get_zone_from_coordinates(latitude, longitude, bed)
                
                if not determined_zone:
                    results.append({
                        "status": "error",
                        "message": f"Could not determine zone for coordinates ({latitude}, {longitude}) in bed {bed}."
                    })
                    continue
                
                # Check for duplicate entry with the determined zone
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
                scout_doc.zone = determined_zone  # Use the determined zone
                scout_doc.time_of_capture = entry_data.get('time_of_capture')
                scout_doc.date_of_capture = entry_data.get('date_of_capture')
                scout_doc.latitude = latitude
                scout_doc.longitude = longitude
                
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
                frappe.db.commit()

                results.append({
                    "status": "success",
                    "message": "Scouting Entry created successfully.",
                    "name": scout_doc.name,
                    "determined_zone": determined_zone
                })

            except Exception as e:
                frappe.db.rollback()
                results.append({
                    "status": "error",
                    "message": str(e)
                })
        
        frappe.response["data"] = results

    except Exception as e:
        frappe.response["data"] = str(e)