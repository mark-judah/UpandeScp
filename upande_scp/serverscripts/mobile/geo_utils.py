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

    zone_number = int((longitude + 180) / 6) + 1

    if latitude >= 0:
        epsg_prefix = 326  # Northern Hemisphere
    else:
        epsg_prefix = 327  # Southern Hemisphere

    return f"EPSG:{epsg_prefix}{zone_number:02d}"


def get_zone_from_coordinates(latitude, longitude, bed, accuracy):
    try:
        lat = float(latitude)
        lon = float(longitude)
        accuracy_m = float(accuracy)

        scout_point = Point(lon, lat)  # GeoJSON: lon, lat

        # Try bed-specific zones first. If none are configured for this bed,
        # fall back to all zones so we always resolve to the geographically
        # nearest zone rather than returning None.
        used_fallback = False
        if bed and bed != "":
            zones = frappe.get_all(
                "Zone",
                filters={"bed": bed},
                fields=["name", "raw_geojson"]
            )
            if not zones:
                zones = frappe.get_all("Zone", fields=["name", "raw_geojson"])
                used_fallback = True
        else:
            zones = frappe.get_all("Zone", fields=["name", "raw_geojson"])

        if not zones:
            return None, 0.0, "No zones configured in the system"

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

                geojson_data = json.loads(zone.raw_geojson)

                if (geojson_data.get("type") == "FeatureCollection" and
                        geojson_data.get("features")):

                    feature = geojson_data["features"][0]
                    geometry = feature.get("geometry", {})

                    if geometry.get("type") == "LineString":
                        coords = geometry.get("coordinates", [])

                        if len(coords) >= 2:
                            line = LineString(coords)
                            line_utm = transform(project_to_utm, line)
                            distance_m = scout_point_utm.distance(line_utm)
                            zone_polygon_utm = line_utm.buffer(buffer_m)

                            if zone_polygon_utm.contains(scout_point_utm):
                                if distance_m < min_distance:
                                    min_distance = distance_m
                                    closest_zone = zone.name

                                    if distance_m <= accuracy_m * 0.3:
                                        confidence = 1.0
                                    elif distance_m <= accuracy_m * 0.6:
                                        confidence = 0.9
                                    elif distance_m <= accuracy_m:
                                        confidence = 0.8
                                    else:
                                        confidence = 0.7

                            elif distance_m < min_distance:
                                min_distance = distance_m
                                closest_zone = zone.name

                                if distance_m <= accuracy_m * 1.5:
                                    confidence = 0.5
                                elif distance_m <= accuracy_m * 2.0:
                                    confidence = 0.3
                                else:
                                    confidence = 0.1

            except Exception as e:
                frappe.log_error(f"Error processing zone {zone.name}", str(e))
                continue

        if closest_zone:
            return closest_zone, confidence, {
                "distance": f"{min_distance:.1f}",
                "buffer": f"{buffer_m:.1f}",
                "fallback": used_fallback,
            }

        return None, 0.0, f"No zone geometry found within range (accuracy: {accuracy_m}m)"

    except Exception as e:
        error_msg = f"Error in get_zone_from_coordinates: {str(e)}"
        frappe.log_error("Error", error_msg)
        return None, 0.0, error_msg
