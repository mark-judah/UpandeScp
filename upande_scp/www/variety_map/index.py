import frappe


def get_context(context):
	context.no_cache = 1
	map_settings = frappe.get_doc("Map Settings", "Map Settings")
	context.lat = map_settings.lat
	context.lon = map_settings.lon
	context.default_zoom = map_settings.default_zoom
	return context
