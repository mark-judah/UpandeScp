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


def _safe_call(fn, *args, **kwargs):
	"""Best-effort prefetch — never let a server-side hiccup break page render.

	The React app already falls back to fetching each endpoint on its own if
	the inlined payload is missing or empty, so a failure here just means the
	first paint pays a network round-trip instead of being instant."""
	try:
		return fn(*args, **kwargs)
	except Exception:
		frappe.log_error(title="scp_app prefetch failed")
		return None


def _build_prefetch():
	"""Resolve the long-lived reference payloads ApplicationPlan / Dashboard
	read on mount, so the HTML shell ships them inline. Keyed to match the
	``cached()`` keys in ``frontend/src/lib/scouting-api.ts`` — the client
	seeds its in-memory cache from these on boot.
	"""
	from upande_scp.serverscripts.scouting import scouting_metrics_api as api

	return {
		"plan_bootstrap": _safe_call(api.get_application_plan_bootstrap),
		"beds_by_gh": _safe_call(api.get_beds_by_greenhouse, active_only=1),
		"farms_and_warehouses": _safe_call(api.get_farms_and_warehouses),
		"map_settings": _safe_call(api.get_map_settings),
	}


def get_context(context):
	if frappe.session.user == "Guest":
		raise frappe.PermissionError(_("Login required"))

	context.no_cache = 1
	context.show_sidebar = 0

	manifest = _read_manifest()
	entry = manifest.get("index.html") or manifest.get("src/main.tsx") or {}

	js_file = entry.get("file") or "scp.js"
	css_files = entry.get("css") or [manifest.get("style.css", {}).get("file") or "scp.css"]

	# Vite hashes the entry filename (scp-[hash].js / scp-[hash].css), so the
	# URL itself busts the browser cache on every build. A ?v= suffix on the
	# entry script would create two distinct module URLs — chunks import the
	# entry by its bare hashed name, while the <script> tag would carry the
	# query — and the browser would instantiate React twice, crashing hooks
	# with the "Invalid hook call" / error #321.
	context.scp_js = "/assets/upande_scp/dist/" + js_file
	context.scp_css = "/assets/upande_scp/dist/" + css_files[0]

	user_id = frappe.session.user
	user_doc = frappe.db.get_value(
		"User", user_id, ["full_name", "user_image"], as_dict=True
	) or {}
	user_roles = list(frappe.get_roles(user_id) or [])
	# Frappe doesn't include 'Administrator' in get_roles() output for the
	# Administrator user - they're a special case that bypasses role checks.
	# We surface it explicitly so frontend role gates honour the pseudo-role.
	if user_id == "Administrator" and "Administrator" not in user_roles:
		user_roles.append("Administrator")
	csrf_token = frappe.sessions.get_csrf_token()
	context.bootstrap_json = json.dumps(
		{
			"user": user_id,
			"full_name": user_doc.get("full_name") or user_id,
			"user_image": user_doc.get("user_image") or "",
			"site_name": frappe.local.site,
			"roles": user_roles,
			"csrf_token": csrf_token,
		}
	)
	context.prefetch_json = json.dumps(_build_prefetch(), default=str)
	context.csrf_token = csrf_token
	return context


def _(msg):
	return frappe._(msg)
