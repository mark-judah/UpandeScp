# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt
"""The phone's side of the SCP IT monitor: register a device, report events.

Ported in shape from upande_mobile (api/devices.register_install, api/monitor.ingest). Both
endpoints take any signed-in user, file everything under the session user (never one the
client claims), and never refuse over a bad field: values are clipped, coerced or ignored.
"""

import json
from datetime import datetime

import frappe
from frappe import _
from frappe.utils import add_days, now_datetime

from upande_scp.serverscripts.it_monitor import clean as C

DEVICE = "SCP Mobile Device"
EVENT = "SCP Mobile Event"
SETTINGS = "Scouting and Crop Protection Settings"
DEFAULT_RETENTION_DAYS = 60
MAX_RETENTION_DAYS = 365


def _utc_iso():
	return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _observed_ip():
	"""The caller's address as the server saw it, never one from the request body."""
	ip = C.text(getattr(frappe.local, "request_ip", None))
	return ip[: C.MAX_DATA_LENGTH]


# --------------------------------------------------------------------------- #
# latest version / user lookups
# --------------------------------------------------------------------------- #


def configured_latest():
	try:
		return C.text(frappe.db.get_single_value(SETTINGS, "it_latest_app_version"))
	except Exception:
		return ""


def latest_for_runtime(runtime_version=None, now_dt=None):
	"""The setting if set, else the highest app_version seen in the last 14 days on the same runtime."""
	configured = configured_latest()
	if configured:
		return configured
	now_dt = now_dt or now_datetime()
	cond, args = "last_seen >= %s", [add_days(now_dt, -C.LATEST_WINDOW_DAYS)]
	if C.text(runtime_version):
		cond += " AND runtime_version = %s"
		args.append(runtime_version)
	rows = frappe.db.sql(f"SELECT DISTINCT app_version FROM `tabSCP Mobile Device` WHERE {cond}", args)
	return C.highest_version(r[0] for r in rows)


def employee_of(user):
	if not user or user == "Guest":
		return None
	return frappe.db.get_value("Employee", {"user_id": user}, "name")


def rostered_farm(user):
	"""The farm this user is rostered on (first alphabetically when several), or None."""
	try:
		from upande_scp.serverscripts.common.crop_scope import ANY_ROSTER, rostered_farms

		farms = sorted(rostered_farms(ANY_ROSTER, user))
	except Exception:
		return None
	return farms[0] if farms else None


def resolve_farm(claimed, existing, user):
	"""Device payload farm if it is a real Farm, else what the device already has, else the user's rostered farm."""
	claimed = C.clip(claimed)
	if claimed and frappe.db.exists("Farm", claimed):
		return claimed
	return existing or rostered_farm(user)


# --------------------------------------------------------------------------- #
# register_device
# --------------------------------------------------------------------------- #


@frappe.whitelist(methods=["POST"])
def register_device(payload=None):
	"""Record or refresh this phone's row. Returns {install_id, status, latest_app_version, server_time}."""
	if frappe.session.user == "Guest":
		frappe.throw(_("Authentication required."), frappe.AuthenticationError)
	if payload is None:
		payload = (getattr(frappe.local, "form_dict", None) or {}).get("payload")
	data = C.parse_payload(payload)
	if data is None:
		frappe.throw(_("The report must be a JSON object."), frappe.ValidationError)
	install_id = C.text(data.get("install_id"))
	if not C.INSTALL_ID_PATTERN.match(install_id):
		frappe.throw(_("A valid install_id is required (8-64 characters of A-Z, a-z, 0-9, _ or -)."), frappe.ValidationError)

	user = frappe.session.user
	now_dt = now_datetime()
	reason = C.text(data.get("reason"), "launch").lower()
	is_login = C.flag(data.get("login")) == 1 or reason == "login"

	values = _device_values(data, user, now_dt)
	existing = frappe.db.get_value(
		DEVICE,
		install_id,
		["app_version", "runtime_version", "launches", "farm", "device_name"],
		as_dict=True,
	)
	if existing:
		values["farm"] = resolve_farm(data.get("farm"), existing.farm, user)
	else:
		values["farm"] = resolve_farm(data.get("farm"), None, user)

	app_version = values.get("app_version") or (existing.app_version if existing else "")
	runtime = values.get("runtime_version") or (existing.runtime_version if existing else "")
	latest = latest_for_runtime(runtime, now_dt)
	values["status"] = C.compute_status(app_version, now_dt, latest, now_dt)

	if existing:
		stored = C.text(existing.app_version)
		if values.get("app_version") and stored and values["app_version"] != stored:
			values["previous_app_version"] = stored
			values["version_changed_at"] = now_dt
		if reason in ("launch", "login") or is_login:
			values["launches"] = (existing.launches or 0) + 1
		if is_login:
			values["last_login_at"] = now_dt
		_write_values(install_id, values)
	else:
		values.update(
			{
				"doctype": DEVICE,
				"install_id": install_id,
				"first_seen": now_dt,
				"launches": 1,
				"last_login_at": now_dt if is_login else None,
			}
		)
		try:
			frappe.get_doc(values).insert(ignore_permissions=True)
		except frappe.DuplicateEntryError:
			# two first reports raced; the other one won
			frappe.db.rollback()
			values.pop("doctype", None)
			values.pop("install_id", None)
			values.pop("first_seen", None)
			values.pop("launches", None)
			_write_values(install_id, values)
	return {
		"install_id": install_id,
		"status": values["status"],
		"latest_app_version": latest,
		"server_time": _utc_iso(),
	}


def _write_values(install_id, values):
	frappe.db.set_value(DEVICE, install_id, values, update_modified=False)


def _device_values(data, user, now_dt):
	"""Every column this report sets (columns it says nothing about are left alone)."""
	v = {
		"user": user,
		"employee": employee_of(user),
		"last_seen": now_dt,
		"ip_address": _observed_ip(),
	}
	role = C.clip(data.get("app_role"), 40).lower()
	if role:
		v["app_role"] = role
	platform = C.clip(data.get("platform"), 40).lower()
	if platform:
		v["platform"] = platform
	for key in (
		"device_brand",
		"device_model",
		"device_name",
		"os_version",
		"app_version",
		"runtime_version",
		"update_id",
		"channel",
		"build_type",
	):
		value = C.clip(data.get(key))
		if value:
			v[key] = value
	if data.get("is_physical_device") is not None:
		physical = C.to_bool(data.get("is_physical_device"))
		if physical is not None:
			v["is_physical_device"] = 1 if physical else 0

	info = C.clean_device_info(data.get("device_info"))
	if info:
		for key in ("battery_level", "battery_state", "storage_free_bytes", "storage_total_bytes", "memory_total_bytes", "network_type"):
			if key in info:
				v[key] = info[key]
		if "low_power" in info:
			v["low_power"] = 1 if info["low_power"] else 0
		conn = C.connectivity_of(info)
		if conn:
			v["connectivity"] = conn
		v["device_snapshot"] = json.dumps(info, default=str)
	skew = C.to_int(data.get("clock_skew_seconds"), -10**7, 10**7)
	if skew is not None:
		v["clock_skew_seconds"] = skew

	for key in ("last_sync_at", "last_sync_ok_at"):
		if key in data:
			t = C.to_site_time(C.utc_naive(data.get(key)))
			if t:
				v[key] = t
	if "last_sync_error" in data:
		v["last_sync_error"] = C.redact_text(data.get("last_sync_error"), 500)

	if "queues" in data:
		queues = C.clean_queues(data.get("queues"), now_dt)
		pending, stuck, oldest = C.queue_totals(queues)
		v["queues"] = json.dumps(queues, default=str)
		v["pending_total"] = pending
		v["stuck_total"] = stuck
		v["oldest_pending_at"] = oldest
	return v


# --------------------------------------------------------------------------- #
# report_events
# --------------------------------------------------------------------------- #


@frappe.whitelist(methods=["POST"])
def report_events(install_id=None, events=None):
	"""Store a batch (max 200) of phone events. Dedupes on (install_id, event_id). Returns {accepted, duplicates}."""
	if frappe.session.user == "Guest":
		frappe.throw(_("Authentication required."), frappe.AuthenticationError)
	install_id = C.text(install_id)
	if not C.INSTALL_ID_PATTERN.match(install_id):
		frappe.throw(_("A valid install_id is required (8-64 characters of A-Z, a-z, 0-9, _ or -)."), frappe.ValidationError)

	user = frappe.session.user
	now_utc = datetime.utcnow()
	now_dt = now_datetime()
	cleaned, seen = [], set()
	duplicates = 0
	for raw in C.parse_list(events)[: C.MAX_EVENTS_PER_CALL]:
		ev = C.clean_event(raw, now_utc)
		if not ev:
			continue
		if ev["event_id"] in seen:
			duplicates += 1
			continue
		seen.add(ev["event_id"])
		cleaned.append(ev)
	if not cleaned:
		return {"accepted": 0, "duplicates": duplicates}

	_ensure_device(install_id, user, now_dt)
	have = set(
		frappe.db.sql_list(
			"SELECT event_id FROM `tabSCP Mobile Event` WHERE install_id = %s AND event_id IN %s",
			(install_id, tuple(seen)),
		)
	)
	app_version, runtime_version, update_id = frappe.db.get_value(
		DEVICE, install_id, ["app_version", "runtime_version", "update_id"]
	) or ("", "", "")

	accepted = 0
	for ev in cleaned:
		if ev["event_id"] in have:
			duplicates += 1
			continue
		doc = {
			k: v
			for k, v in ev.items()
			if k not in ("ts_utc", "extra")
		}
		doc.update(
			{
				"doctype": EVENT,
				"install_id": install_id,
				"device": install_id,
				"user": user,
				"ts": C.to_site_time(ev["ts_utc"]),
				"received_at": now_dt,
				"app_version": app_version or "",
				"runtime_version": runtime_version or "",
				"update_id": update_id or "",
				"extra": json.dumps(ev["extra"], default=str) if ev["extra"] else None,
			}
		)
		try:
			# a savepoint so a unique-key clash (a batch retried in parallel) costs only this event
			frappe.db.savepoint("scp_ev")
			frappe.get_doc(doc).insert(ignore_permissions=True, ignore_links=True)
			accepted += 1
		except frappe.DuplicateEntryError:
			frappe.db.rollback(save_point="scp_ev")
			duplicates += 1
	return {"accepted": accepted, "duplicates": duplicates}


def _ensure_device(install_id, user, now_dt):
	"""Events can arrive before the first register call; make a bare row for them to hang on."""
	if frappe.db.exists(DEVICE, install_id):
		return
	try:
		frappe.get_doc(
			{
				"doctype": DEVICE,
				"install_id": install_id,
				"user": user,
				"employee": employee_of(user),
				"farm": rostered_farm(user),
				"status": "Unknown",
				"first_seen": now_dt,
				"last_seen": now_dt,
				"launches": 0,
			}
		).insert(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		frappe.db.rollback()


# --------------------------------------------------------------------------- #
# daily jobs
# --------------------------------------------------------------------------- #


def retention_days():
	try:
		days = int(frappe.db.get_single_value(SETTINGS, "it_event_retention_days") or 0)
	except Exception:
		days = 0
	days = days or DEFAULT_RETENTION_DAYS
	return max(1, min(days, MAX_RETENTION_DAYS))


def purge_old_events(batch=2000, max_batches=200, commit=True):
	"""Delete SCP Mobile Events older than the retention window, in batches. Returns the number deleted."""
	cutoff = add_days(now_datetime(), -retention_days())
	total = 0
	for _i in range(max_batches):
		frappe.db.sql("DELETE FROM `tabSCP Mobile Event` WHERE ts < %s LIMIT %s", (cutoff, batch))
		n = frappe.db.sql("SELECT ROW_COUNT()")[0][0]
		if commit:
			frappe.db.commit()
		total += n
		if n < batch:
			break
	return total


def recompute_statuses():
	"""Re-derive each device's stored status (dormant/behind drift while a phone is silent)."""
	now_dt = now_datetime()
	rows = frappe.db.sql(
		"SELECT name, app_version, runtime_version, last_seen, status FROM `tabSCP Mobile Device`",
		as_dict=True,
	)
	cache = {}
	for r in rows:
		rt = r.runtime_version or ""
		if rt not in cache:
			cache[rt] = latest_for_runtime(rt, now_dt)
		new = C.compute_status(r.app_version, r.last_seen, cache[rt], now_dt)
		if new != r.status:
			frappe.db.set_value(DEVICE, r.name, "status", new, update_modified=False)


def daily():
	"""Scheduler entry: expire old events, then refresh stored statuses."""
	purge_old_events()
	recompute_statuses()
	frappe.db.commit()
