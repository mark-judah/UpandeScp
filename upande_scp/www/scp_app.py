import json
import os

import frappe

no_cache = 1


def _read_manifest():
	"""Read Vite manifest if present so we can resolve hashed asset names.

	The Vite config writes fixed names (scp.js / scp.css) so this is mostly a
	belt-and-braces helper for future hashed builds.
	"""
	app_path = frappe.get_app_path("upande_scp")
	manifest_path = os.path.join(app_path, "public", "dist", ".vite", "manifest.json")
	if not os.path.exists(manifest_path):
		return {}
	try:
		with open(manifest_path, "r", encoding="utf-8") as fh:
			return json.load(fh)
	except (OSError, ValueError):
		return {}


def get_context(context):
	if frappe.session.user == "Guest":
		raise frappe.PermissionError(_("Login required"))

	context.no_cache = 1
	context.show_sidebar = 0

	manifest = _read_manifest()
	entry = manifest.get("index.html") or manifest.get("src/main.tsx") or {}

	js_file = entry.get("file") or "scp.js"
	css_files = entry.get("css") or [manifest.get("style.css", {}).get("file") or "scp.css"]

	context.scp_js = "/assets/upande_scp/dist/" + js_file
	context.scp_css = "/assets/upande_scp/dist/" + css_files[0]

	context.bootstrap_json = json.dumps(
		{
			"user": frappe.session.user,
			"site_name": frappe.local.site,
		}
	)
	context.csrf_token = frappe.sessions.get_csrf_token()
	return context


def _(msg):
	return frappe._(msg)
