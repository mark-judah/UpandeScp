"""Set sane defaults for the new Scouting and Crop Protection Settings threshold fields.

Idempotent - only writes a field if its current value is unset (None, 0,
empty) AND the field is now present on the doctype.
"""
import frappe


DEFAULTS = {
    "irac_rotation_window_days": 14,
    "frac_rotation_window_days": 21,
    "weather_wind_green_max_kmh": 10.0,
    "weather_wind_red_min_kmh": 15.0,
    "weather_rain_green_max_pct": 20.0,
    "weather_rain_red_min_pct": 50.0,
    "weather_temp_green_min_c": 10.0,
    "weather_temp_green_max_c": 28.0,
    "weather_temp_red_max_c": 32.0,
    "weather_temp_red_min_c": 8.0,
}


def execute() -> None:
    if not frappe.db.exists("DocType", "Scouting and Crop Protection Settings"):
        return
    settings = frappe.get_single("Scouting and Crop Protection Settings")
    dirty = False
    for field, default in DEFAULTS.items():
        if not hasattr(settings, field):
            continue
        current = getattr(settings, field)
        if current in (None, 0, 0.0, ""):
            setattr(settings, field, default)
            dirty = True
    if dirty:
        settings.save(ignore_permissions=True)
        frappe.db.commit()
