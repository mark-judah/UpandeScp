"""
Shared GPS / zone-detection utilities used by scouting and sprayer entry scripts.
"""
import json
import frappe
from shapely.geometry import Point, LineString
from shapely.ops import transform
from pyproj import Transformer


def get_dynamic_utm_epsg(latitude, longitude):
    """Calculates the correct UTM EPSG code based on a point's coordinates."""

    # 1. Determine Zone Number (1 to 60)
    zone_number = int((longitude + 180) / 6) + 1

    # 2. Determine Hemisphere Prefix (326 for N, 327 for S)
    if latitude >= 0:
        epsg_prefix = 326  # Northern Hemisphere
    else:
        epsg_prefix = 327  # Southern Hemisphere

    # 3. Construct the full EPSG code string
    return f"EPSG:{epsg_prefix}{zone_number:02d}"


def get_zone_from_coordinates(latitude, longitude, bed, accuracy):
    try:
        lat = float(latitude)
        lon = float(longitude)
        accuracy_m = float(accuracy)

        scout_point = Point(lon, lat)          # GeoJSON: lon, lat

        if bed is None or bed == "":
            # No bed filter – search all zones
            filters = {}
            no_bed_msg = " (all beds)"
        else:
            filters = {"bed": bed}
            no_bed_msg = f" for bed: {bed}"

        zones = frappe.get_all(
            "Zone",
            filters=filters,
            fields=["name", "raw_geojson"]
        )

        if not zones:
            return None, 0.0, f"No zones found{no_bed_msg}"

        utm_epsg = get_dynamic_utm_epsg(lat, lon)

        project_to_utm = Transformer.from_crs(
            "EPSG:4326",
            utm_epsg,
            always_xy=True
        ).transform

        scout_point_utm = transform(project_to_utm, scout_point)

        buffer_m = max(3.0, min(accuracy_m, 50.0))

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
                            # Create line in WGS84
                            line = LineString(coords)

                            # Transform line to UTM (meters)
                            line_utm = transform(project_to_utm, line)

                            # Calculate distance in meters (now accurate!)
                            distance_m = scout_point_utm.distance(line_utm)

                            # Create adaptive buffer in meters (not degrees!)
                            zone_polygon_utm = line_utm.buffer(buffer_m)

                            # Check if point is within buffered zone
                            if zone_polygon_utm.contains(scout_point_utm):
                                if distance_m < min_distance:
                                    min_distance = distance_m
                                    closest_zone = zone.name

                                    # Calculate confidence based on distance vs accuracy
                                    if distance_m <= accuracy_m * 0.3:
                                        confidence = 1.0  # Excellent - right on the line
                                    elif distance_m <= accuracy_m * 0.6:
                                        confidence = 0.9  # Very good
                                    elif distance_m <= accuracy_m:
                                        confidence = 0.8  # Good - within accuracy circle
                                    else:
                                        confidence = 0.7  # Acceptable - within buffer

                            # If not in buffer, still track closest zone
                            elif distance_m < min_distance:
                                min_distance = distance_m
                                closest_zone = zone.name

                                # Lower confidence if outside buffer
                                if distance_m <= accuracy_m * 1.5:
                                    confidence = 0.5  # Fair - close but outside buffer
                                elif distance_m <= accuracy_m * 2.0:
                                    confidence = 0.3  # Poor - might be adjacent zone
                                else:
                                    confidence = 0.1  # Very poor - likely wrong zone

            except Exception as e:
                frappe.log_error(f"Error processing zone {zone.name}", str(e))
                continue

        if closest_zone:
            return closest_zone, confidence, {
                "distance": f"{min_distance:.1f}",
                "buffer": f"{buffer_m:.1f}",
            }

        return None, 0.0, f"No zone found within range (accuracy: {accuracy_m}m)"

    except Exception as e:
        error_msg = f"Error in get_zone_from_coordinates: {str(e)}"
        frappe.log_error("Error", error_msg)
        return None, 0.0, error_msg
