# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt
"""The IT monitor's read API (SCP IT, System Manager and SCP General Manager).

Shapes are the contract in docs/superpowers/specs/2026-11-12-scp-it-monitor.md. Device status is
computed live here (a silent phone turns Dormant/Behind without sending anything); the stored
status column is only a convenience for the desk list.
"""

import json
from collections import defaultdict
from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import add_days, cint, getdate, now_datetime

from upande_scp.serverscripts.it_monitor import clean as C
from upande_scp.serverscripts.it_monitor.ingest import latest_for_runtime

ALLOWED_ROLES = {"SCP IT", "System Manager", "SCP General Manager"}
MAX_DAYS = 90
DEVICE_FIELDS = [
	"d.name AS install_id", "d.user", "d.employee", "d.farm", "d.app_role", "d.status",
	"d.platform", "d.device_brand", "d.device_model", "d.device_name", "d.os_version", "d.is_physical_device",
	"d.app_version", "d.runtime_version", "d.update_id", "d.channel", "d.build_type",
	"d.previous_app_version", "d.version_changed_at",
	"d.first_seen", "d.last_seen", "d.last_login_at", "d.launches", "d.ip_address",
	"d.battery_level", "d.battery_state", "d.low_power", "d.storage_free_bytes", "d.storage_total_bytes",
	"d.memory_total_bytes", "d.network_type", "d.connectivity", "d.clock_skew_seconds",
	"d.last_sync_at", "d.last_sync_ok_at", "d.last_sync_error",
	"d.pending_total", "d.stuck_total", "d.oldest_pending_at", "d.queues", "d.it_notes",
	"u.full_name AS user_full_name", "e.employee_name AS employee_name",
]


def _require():
	if frappe.session.user == "Guest" or not (ALLOWED_ROLES & set(frappe.get_roles())):
		frappe.throw(_("The IT monitor is for SCP IT, System Managers and SCP General Managers."), frappe.PermissionError)


def _days(days, default=7):
	return max(1, min(cint(days) or default, MAX_DAYS))


def _json(value, default):
	if isinstance(value, (dict, list)):
		return value
	try:
		return json.loads(value) if value else default
	except ValueError:
		return default


def _device_rows(farm=None):
	"""Every device (a few hundred) with user/employee names, status computed live, queues parsed."""
	now_dt = now_datetime()
	where, args = "", []
	if farm:
		where, args = "WHERE d.farm = %s", [farm]
	rows = frappe.db.sql(
		f"""SELECT {", ".join(DEVICE_FIELDS)}
		    FROM `tabSCP Mobile Device` d
		    LEFT JOIN `tabUser` u ON u.name = d.user
		    LEFT JOIN `tabEmployee` e ON e.name = d.employee
		    {where} ORDER BY d.last_seen DESC""",
		args,
		as_dict=True,
	)
	latest_cache = {}
	for r in rows:
		rt = r.runtime_version or ""
		if rt not in latest_cache:
			latest_cache[rt] = latest_for_runtime(rt, now_dt)
		r.status = C.compute_status(r.app_version, r.last_seen, latest_cache[rt], now_dt)
		r.queues = _json(r.queues, {})
		r.flags = C.health_flags(r)
	return rows


@frappe.whitelist(methods=["GET"])
def overview(days=7, farm=None):
	_require()
	days = _days(days)
	now_dt = now_datetime()
	rows = _device_rows(farm or None)
	latest = latest_for_runtime(None, now_dt)

	day_ago = add_days(now_dt, -1)
	versions = defaultdict(int)
	stuck_by_queue = defaultdict(int)
	devices = {"total": len(rows), "active_24h": 0, "behind": 0, "dormant": 0, "low_battery": 0, "low_storage": 0, "with_stuck": 0}
	for r in rows:
		if r.last_seen and r.last_seen >= day_ago:
			devices["active_24h"] += 1
		if r.status == "Behind":
			devices["behind"] += 1
		elif r.status == "Dormant":
			devices["dormant"] += 1
		if "low_battery" in r.flags:
			devices["low_battery"] += 1
		if "low_storage" in r.flags:
			devices["low_storage"] += 1
		if cint(r.stuck_total) > 0:
			devices["with_stuck"] += 1
		versions[(r.app_version or "", r.runtime_version or "")] += 1
		for name, q in r.queues.items():
			if cint(q.get("stuck")):
				stuck_by_queue[name] += cint(q["stuck"])
	version_rows = sorted(
		({"app_version": v, "runtime_version": rt, "devices": n} for (v, rt), n in versions.items()),
		key=lambda x: (C.parse_version(x["app_version"]) or (-1,), x["devices"]),
		reverse=True,
	)

	since = add_days(now_dt, -days)
	extra, args = "", [since, ("crash", "error", "api_error")]
	if farm:
		extra = " AND install_id IN %s"
		args.append(tuple(r.install_id for r in rows) or ("",))
	ev = frappe.db.sql(
		f"""SELECT COUNT(*) AS events, COUNT(DISTINCT fingerprint) AS issues,
		           COALESCE(SUM(kind = 'crash'), 0) AS crashes
		    FROM `tabSCP Mobile Event`
		    WHERE ts >= %s AND kind IN %s{extra}""",
		args,
		as_dict=True,
	)[0]
	errors = {"events": cint(ev.events), "issues": cint(ev.issues), "crashes": cint(ev.crashes)}

	return {
		"devices": devices,
		"versions": version_rows,
		"latest_app_version": latest,
		"errors": errors,
		"logins_today": _logins_today(farm, rows, now_dt),
		"stuck_by_queue": dict(stuck_by_queue),
	}


def _logins_today(farm, rows, now_dt):
	start = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)
	cond, args = "", [start]
	if farm:
		users = tuple({r.user for r in rows if r.user}) or ("",)
		cond, args = " AND user IN %s", [start, users]
	return cint(
		frappe.db.sql(
			f"""SELECT COUNT(*) FROM `tabActivity Log`
			    WHERE creation >= %s AND operation = 'Login' AND status = 'Success'{cond}""",
			args,
		)[0][0]
	)


@frappe.whitelist(methods=["GET"])
def devices(farm=None, status=None, search=None, stuck_only=0, limit=500):
	"""A list of device rows (see DEVICE_FIELDS): status live, `queues` parsed, `flags` = why it needs attention."""
	_require()
	rows = _device_rows(farm or None)
	if status:
		rows = [r for r in rows if r.status == status]
	if cint(stuck_only):
		rows = [r for r in rows if cint(r.stuck_total) > 0]
	term = C.text(search).lower()
	if term:
		rows = [
			r
			for r in rows
			if term in " ".join(
				str(r.get(k) or "")
				for k in ("install_id", "user", "user_full_name", "employee_name", "device_name", "device_model", "device_brand")
			).lower()
		]
	return rows[: max(1, min(cint(limit) or 500, 2000))]


EVENT_FIELDS = (
	"name, event_id, kind, level, ts, received_at, user, message, error_name, stack, fatal, `count`, screen, "
	"app_version, runtime_version, update_id, req_method, req_url, req_status, req_duration_ms, req_error, "
	"fingerprint, extra"
)


@frappe.whitelist(methods=["GET"])
def device(install_id):
	"""{device, events (last 200, newest first), queues, snapshot, latest_app_version}."""
	_require()
	install_id = C.text(install_id)
	rows = [r for r in _device_rows() if r.install_id == install_id]
	if not rows:
		frappe.throw(_("Device {0} not found.").format(install_id), frappe.DoesNotExistError)
	row = rows[0]
	snapshot = _json(frappe.db.get_value("SCP Mobile Device", install_id, "device_snapshot"), {})
	events = frappe.db.sql(
		f"SELECT {EVENT_FIELDS} FROM `tabSCP Mobile Event` WHERE install_id = %s ORDER BY ts DESC LIMIT 200",
		install_id,
		as_dict=True,
	)
	for e in events:
		e.extra = _json(e.extra, None)
	return {
		"device": row,
		"events": events,
		"queues": row.queues,
		"snapshot": snapshot,
		"latest_app_version": latest_for_runtime(row.runtime_version),
	}


def _title(e):
	if e.kind == "api_error" and e.req_url:
		from upande_scp.serverscripts.it_monitor.fingerprint import path_template

		return f"{e.req_method or 'GET'} {path_template(e.req_url)} → {e.req_status or e.req_error or 'error'}"[:300]
	first = (e.message or "").strip().splitlines()[0] if (e.message or "").strip() else (e.error_name or e.kind)
	if e.error_name and not first.startswith(e.error_name):
		first = f"{e.error_name}: {first}"
	return first[:300]


@frappe.whitelist(methods=["GET"])
def issues(days=7, kind=None):
	"""Problems grouped by fingerprint, most recent first."""
	_require()
	since = add_days(now_datetime(), -_days(days))
	kinds = (kind,) if kind in C.PROBLEM_KINDS else C.PROBLEM_KINDS
	groups = frappe.db.sql(
		"""SELECT fingerprint, SUM(`count`) AS events, COUNT(DISTINCT user) AS users,
		          COUNT(DISTINCT install_id) AS devices, MIN(ts) AS first_seen, MAX(ts) AS last_seen
		   FROM `tabSCP Mobile Event`
		   WHERE ts >= %s AND kind IN %s AND fingerprint != ''
		   GROUP BY fingerprint ORDER BY last_seen DESC LIMIT 300""",
		(since, kinds),
		as_dict=True,
	)
	if not groups:
		return []
	latest = frappe.db.sql(
		"""SELECT e.fingerprint, e.kind, e.level, e.app_version, e.message, e.error_name, e.req_method,
		          e.req_url, e.req_status, e.req_error
		   FROM `tabSCP Mobile Event` e
		   JOIN (SELECT fingerprint, MAX(ts) AS mts FROM `tabSCP Mobile Event`
		         WHERE ts >= %s AND kind IN %s AND fingerprint != '' GROUP BY fingerprint) m
		     ON m.fingerprint = e.fingerprint AND m.mts = e.ts
		   WHERE e.kind IN %s""",
		(since, kinds, kinds),
		as_dict=True,
	)
	by_fp = {}
	for e in latest:
		by_fp.setdefault(e.fingerprint, e)
	out = []
	for g in groups:
		e = by_fp.get(g.fingerprint)
		if not e:
			continue
		out.append(
			{
				"fingerprint": g.fingerprint,
				"kind": e.kind,
				"level": e.level,
				"title": _title(e),
				"events": cint(g.events),
				"users": cint(g.users),
				"devices": cint(g.devices),
				"first_seen": g.first_seen,
				"last_seen": g.last_seen,
				"last_version": e.app_version or "",
			}
		)
	return out


@frappe.whitelist(methods=["GET"])
def logins(days=7, farm=None):
	"""{days, summary: {success, failed, logouts}, rows} newest first.

	Each row is an Activity Log Login/Logout (source "server") matched, when the same user's phone
	reported a login/logout event within 5 minutes, to that device and app version; phone login events
	with no Activity Log row (an offline sign-in) are added with source "device".
	"""
	_require()
	days = _days(days)
	since = add_days(now_datetime(), -days)
	users = None
	if farm:
		users = tuple({r.user for r in _device_rows(farm) if r.user}) or ("",)
	cond, args = "", [since]
	if users is not None:
		cond, args = " AND a.user IN %s", [since, users]
	log = frappe.db.sql(
		f"""SELECT a.creation AS ts, a.user, u.full_name AS user_full_name, a.operation, a.status,
		           a.ip_address, a.subject
		    FROM `tabActivity Log` a LEFT JOIN `tabUser` u ON u.name = a.user
		    WHERE a.creation >= %s AND a.operation IN ('Login', 'Logout'){cond}
		    ORDER BY a.creation DESC LIMIT 2000""",
		args,
		as_dict=True,
	)
	dev_cond, dev_args = "", [since]
	if users is not None:
		dev_cond, dev_args = " AND e.user IN %s", [since, users]
	dev_events = frappe.db.sql(
		f"""SELECT e.ts, e.user, e.kind, e.install_id, e.app_version, e.level, e.message,
		           d.device_model, d.device_brand, d.farm, u.full_name AS user_full_name
		    FROM `tabSCP Mobile Event` e
		    LEFT JOIN `tabSCP Mobile Device` d ON d.name = e.install_id
		    LEFT JOIN `tabUser` u ON u.name = e.user
		    WHERE e.ts >= %s AND e.kind IN ('login', 'logout'){dev_cond}
		    ORDER BY e.ts DESC LIMIT 2000""",
		dev_args,
		as_dict=True,
	)
	window = timedelta(minutes=5)
	pool = defaultdict(list)
	for e in dev_events:
		pool[(e.user, e.kind)].append(e)
	used = set()
	rows = []
	for a in log:
		match = None
		for e in pool.get((a.user, a.operation.lower()), []):
			if id(e) not in used and abs(e.ts - a.ts) <= window:
				match = e
				break
		if match:
			used.add(id(match))
		rows.append(
			{
				"ts": a.ts,
				"user": a.user,
				"user_full_name": a.user_full_name,
				"operation": a.operation,
				"status": a.status,
				"ip_address": a.ip_address,
				"subject": a.subject,
				"source": "server",
				"install_id": match.install_id if match else None,
				"app_version": match.app_version if match else None,
				"device_model": match.device_model if match else None,
				"farm": match.farm if match else None,
			}
		)
	for e in dev_events:
		if id(e) in used:
			continue
		rows.append(
			{
				"ts": e.ts,
				"user": e.user,
				"user_full_name": e.user_full_name,
				"operation": e.kind.capitalize(),
				"status": "Failed" if e.level in ("error", "warning", "fatal") else "Success",
				"ip_address": None,
				"subject": e.message,
				"source": "device",
				"install_id": e.install_id,
				"app_version": e.app_version,
				"device_model": e.device_model,
				"farm": e.farm,
			}
		)
	rows.sort(key=lambda r: r["ts"], reverse=True)
	return {
		"days": days,
		"summary": {
			"success": sum(1 for r in rows if r["operation"] == "Login" and r["status"] == "Success"),
			"failed": sum(1 for r in rows if r["operation"] == "Login" and r["status"] != "Success"),
			"logouts": sum(1 for r in rows if r["operation"] == "Logout"),
		},
		"rows": rows,
	}


@frappe.whitelist(methods=["GET"])
def data_flow(days=7, farm=None):
	"""What reached the server per day, plus what phones say is still waiting.

	{from_date, to_date,
	 daily: [{date, scouting_entries, scouts, pest_photos, csu_scans, spray_pending, spray_synced,
	          spray_held, spray_partial, spray_refused}]   (every date in range, zero-filled)
	 scouting_by_scout: [{date, scout, scout_name, entries}],
	 device_queues: {queue: {pending, failed, held, refused, stuck, devices}}}
	"""
	_require()
	days = _days(days)
	to_d = getdate()
	from_d = to_d - timedelta(days=days - 1)
	farm = farm or None

	# Scouting Entry: date_of_capture first (indexed), farm via the greenhouse/block Warehouse.
	farm_join, farm_cond, fargs = "", "", []
	if farm:
		farm_join = "JOIN `tabWarehouse` w ON w.name = COALESCE(NULLIF(e.greenhouse, ''), e.block)"
		farm_cond = " AND w.custom_farm = %s"
		fargs = [farm]
	by_scout = frappe.db.sql(
		f"""SELECT e.date_of_capture AS date, e.scouts_name AS scout, COUNT(*) AS entries
		    FROM `tabScouting Entry` e {farm_join}
		    WHERE e.date_of_capture BETWEEN %s AND %s{farm_cond}
		    GROUP BY e.date_of_capture, e.scouts_name""",
		[from_d, to_d] + fargs,
		as_dict=True,
	)
	names = {}
	scout_ids = {r.scout for r in by_scout if r.scout}
	if scout_ids:
		names = dict(frappe.db.sql("SELECT name, employee_name FROM `tabEmployee` WHERE name IN %s", (tuple(scout_ids),)))

	photos = frappe.db.sql(
		f"""SELECT e.date_of_capture AS date, COUNT(*) AS n
		    FROM `tabScouting Entry Photo` p
		    JOIN `tabScouting Entry` e ON e.name = p.parent {farm_join}
		    WHERE e.date_of_capture BETWEEN %s AND %s{farm_cond}
		    GROUP BY e.date_of_capture""",
		[from_d, to_d] + fargs,
		as_dict=True,
	)

	csu_join, csu_cond = "", ""
	cargs = []
	if farm:
		csu_join = "JOIN `tabWarehouse` w ON w.name = s.csu_warehouse"
		csu_cond = " AND w.custom_farm = %s"
		cargs = [farm]
	scans = frappe.db.sql(
		f"""SELECT DATE(s.scanned_at) AS date, COUNT(*) AS n
		    FROM `tabWork Order Chemical Scan` s {csu_join}
		    WHERE s.scanned_at >= %s AND s.scanned_at < %s{csu_cond}
		    GROUP BY DATE(s.scanned_at)""",
		[from_d, add_days(to_d, 1)] + cargs,
		as_dict=True,
	)

	tok_cond, targs = "", []
	if farm:
		tok_cond, targs = " AND farm = %s", [farm]
	tokens = frappe.db.sql(
		f"""SELECT DATE(creation) AS date, status, COUNT(*) AS n
		    FROM `tabSpray Session Token`
		    WHERE creation >= %s AND creation < %s{tok_cond}
		    GROUP BY DATE(creation), status""",
		[from_d, add_days(to_d, 1)] + targs,
		as_dict=True,
	)

	daily = {}
	d = from_d
	while d <= to_d:
		daily[d] = {
			"date": str(d), "scouting_entries": 0, "scouts": 0, "pest_photos": 0, "csu_scans": 0,
			"spray_pending": 0, "spray_synced": 0, "spray_held": 0, "spray_partial": 0, "spray_refused": 0,
		}
		d += timedelta(days=1)
	for r in by_scout:
		row = daily.get(getdate(r.date))
		if row:
			row["scouting_entries"] += cint(r.entries)
			row["scouts"] += 1 if r.scout else 0
	for r in photos:
		if getdate(r.date) in daily:
			daily[getdate(r.date)]["pest_photos"] += cint(r.n)
	for r in scans:
		if getdate(r.date) in daily:
			daily[getdate(r.date)]["csu_scans"] += cint(r.n)
	for r in tokens:
		row = daily.get(getdate(r.date))
		if not row:
			continue
		status = C.text(r.status).lower()
		key = "spray_held" if status.startswith("held") else f"spray_{status}"
		if key in row:
			row[key] += cint(r.n)

	queues = defaultdict(lambda: {"pending": 0, "failed": 0, "held": 0, "refused": 0, "stuck": 0, "devices": 0})
	for r in _device_rows(farm):
		for name, q in r.queues.items():
			agg = queues[name]
			for k in ("pending", "failed", "held", "refused", "stuck"):
				agg[k] += cint(q.get(k))
			if cint(q.get("pending")) or cint(q.get("stuck")):
				agg["devices"] += 1

	return {
		"from_date": str(from_d),
		"to_date": str(to_d),
		"daily": list(daily.values()),
		"scouting_by_scout": sorted(
			(
				{"date": str(getdate(r.date)), "scout": r.scout, "scout_name": names.get(r.scout) or r.scout, "entries": cint(r.entries)}
				for r in by_scout
			),
			key=lambda x: (x["date"], -x["entries"]),
		),
		"device_queues": dict(queues),
	}
