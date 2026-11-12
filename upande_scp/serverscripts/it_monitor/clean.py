# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt
"""Cleaning, clipping, versions, status and stuck rules for the SCP IT monitor.

Ported from upande_mobile (api/devices.py: _text/_clip/_flag/parse_version/install_status,
api/monitor.py: _num/_bool/event_time/clean_device/clean_event/health_flags) so the monitor
works on a site where upande_mobile is not installed. The functions here are pure (no
site, no database) apart from `to_site_time`, so they are unit-testable without a bench.

Nothing here refuses a report over one bad field: a value is clipped, coerced or dropped.
"""

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone

from upande_scp.serverscripts.it_monitor.fingerprint import normalise_message, path_template, stack_frames
from upande_scp.serverscripts.it_monitor.redaction import redact_text, redact_url, redact_value

MAX_DATA_LENGTH = 140
MAX_MESSAGE = 2000
MAX_STACK = 16000
MAX_EXTRA_BYTES = 4 * 1024
MAX_FUTURE = timedelta(hours=1)
MAX_EVENTS_PER_CALL = 200
MAX_PAYLOAD_BYTES = 512 * 1024

INSTALL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

KINDS = ("crash", "error", "api_error", "login", "logout", "sync", "warning")
LEVELS = ("fatal", "error", "warning", "info")
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
#: events that are not problems (they carry no message of their own and are not grouped as issues)
INFO_KINDS = ("login", "logout", "sync")
PROBLEM_KINDS = ("crash", "error", "api_error", "warning")

QUEUE_NAMES = ("scouting", "pest_images", "spray_sessions", "sprayer_gps", "traps", "team_journal", "other")
STUCK_AFTER_MINUTES = 30

APP_ROLES = ("scout", "chemical", "sprayer", "store")
DORMANT_DAYS = 7
LATEST_WINDOW_DAYS = 14

LOW_BATTERY = 0.2
LOW_STORAGE_BYTES = 512 * 1024 * 1024
LOW_STORAGE_FRACTION = 0.1


# --------------------------------------------------------------------------- #
# scalars
# --------------------------------------------------------------------------- #


def text(value, default=""):
	if value is None:
		return default
	value = str(value).strip()
	return value or default


def clip(value, length=MAX_DATA_LENGTH):
	return text(value)[:length]


def num(value, lo=None, hi=None):
	"""A float within lo..hi, or None for anything that is not a finite number."""
	if isinstance(value, bool):
		return None
	try:
		number = float(value)
	except (TypeError, ValueError):
		return None
	if number != number or number in (float("inf"), float("-inf")):
		return None
	if lo is not None:
		number = max(lo, number)
	if hi is not None:
		number = min(hi, number)
	return number


def to_int(value, lo=0, hi=1e15):
	n = num(value, lo, hi)
	return None if n is None else int(n)


def to_bool(value):
	"""True/False, or None when the value says nothing ("true"/"false" arrive as strings on a form body)."""
	if isinstance(value, bool):
		return value
	if isinstance(value, (int, float)):
		return bool(value)
	if isinstance(value, str) and value.strip().lower() in ("true", "false", "1", "0"):
		return value.strip().lower() in ("true", "1")
	return None


def flag(value):
	return 1 if to_bool(value) else 0


def utc_naive(value, now_utc=None, pin_future=True):
	"""A naive UTC datetime from an ISO string/datetime; the future is pinned to now. None when unreadable.

	A value with no zone is taken as UTC (the phone sends `toISOString()`).
	"""
	if value in (None, ""):
		return None
	if isinstance(value, datetime):
		parsed = value
	else:
		s = text(value)
		try:
			parsed = datetime.fromisoformat(s.replace("Z", "+00:00"))
		except ValueError:
			return None
	if parsed.tzinfo is not None:
		parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
	now_utc = now_utc or datetime.utcnow()
	if pin_future and parsed > now_utc + MAX_FUTURE:
		return now_utc
	return parsed


def to_site_time(utc_dt):
	"""A naive UTC datetime as the site's own timezone (how Datetime fields are stored). None stays None."""
	if utc_dt is None:
		return None
	from frappe.utils import convert_utc_to_system_timezone

	converted = convert_utc_to_system_timezone(utc_dt)
	return converted.replace(tzinfo=None) if getattr(converted, "tzinfo", None) else converted


def parse_payload(payload):
	"""The request's JSON object, or None when it is not one (or is absurdly large)."""
	if isinstance(payload, (bytes, bytearray)):
		payload = bytes(payload).decode("utf-8", "replace")
	if isinstance(payload, str):
		if len(payload) > MAX_PAYLOAD_BYTES:
			return None
		try:
			payload = json.loads(payload)
		except ValueError:
			return None
	return payload if isinstance(payload, dict) else None


def parse_list(value):
	if isinstance(value, str):
		if len(value) > MAX_PAYLOAD_BYTES:
			return []
		try:
			value = json.loads(value)
		except ValueError:
			return []
	return value if isinstance(value, list) else []


# --------------------------------------------------------------------------- #
# versions and status
# --------------------------------------------------------------------------- #


def parse_version(value):
	"""(major, minor, patch) from "1.2.3" / "v1.2.3-rc1"; None when unparseable."""
	s = text(value).lstrip("vV").split("-")[0].split("+")[0]
	parts = s.split(".")
	if not parts or not parts[0].isdigit():
		return None
	nums = []
	for part in parts[:3]:
		if not part.isdigit():
			return None
		nums.append(int(part))
	while len(nums) < 3:
		nums.append(0)
	return tuple(nums)


def highest_version(versions):
	"""The highest parseable version string in `versions` (original spelling), or ""."""
	best, best_key = "", None
	for v in versions:
		key = parse_version(v)
		if key and (best_key is None or key > best_key):
			best, best_key = text(v), key
	return best


def compute_status(app_version, last_seen, latest, now_dt, dormant_days=DORMANT_DAYS):
	"""Current / Behind / Dormant / Unknown for one device (the spec's rule).

	Dormant if last_seen is older than `dormant_days`; Unknown when there is no parseable
	version (or no latest to compare with); Behind if app_version < latest.
	"""
	if last_seen and _naive(last_seen) < now_dt - timedelta(days=dormant_days):
		return "Dormant"
	installed = parse_version(app_version)
	if not installed or not parse_version(latest):
		return "Unknown"
	return "Behind" if installed < parse_version(latest) else "Current"


def _naive(value):
	if isinstance(value, datetime):
		return value.replace(tzinfo=None)
	from frappe.utils import get_datetime

	return get_datetime(value).replace(tzinfo=None)


# --------------------------------------------------------------------------- #
# queues and stuck
# --------------------------------------------------------------------------- #


def clean_queues(raw, now_dt):
	"""{name: {pending, failed, held, refused, oldest_at, stuck}} for the known queue names.

	`oldest_at` is the phone's ISO UTC time of its oldest pending item, kept as a naive site-time string
	(`now_dt` is the site's now, to age it). `stuck` = failed + held + refused + the pending items when the
	oldest has waited more than 30 minutes. Unknown queue names fold into "other".
	"""
	out = {}
	if not isinstance(raw, dict):
		return out
	for name, q in raw.items():
		if not isinstance(q, dict):
			continue
		key = clip(name, 40).lower()
		key = key if key in QUEUE_NAMES else "other"
		row = out.setdefault(key, {"pending": 0, "failed": 0, "held": 0, "refused": 0, "oldest_at": None, "stuck": 0})
		for field in ("pending", "failed", "held", "refused"):
			row[field] += to_int(q.get(field), 0, 10_000_000) or 0
		oldest = to_site_time(utc_naive(q.get("oldest_at")))
		if oldest and (row["oldest_at"] is None or oldest < row["oldest_at"]):
			row["oldest_at"] = oldest
	for row in out.values():
		stale = bool(row["oldest_at"]) and row["oldest_at"] < now_dt - timedelta(minutes=STUCK_AFTER_MINUTES)
		row["stuck"] = row["failed"] + row["held"] + row["refused"] + (row["pending"] if stale else 0)
		row["oldest_at"] = str(row["oldest_at"].replace(microsecond=0)) if row["oldest_at"] else None
	return out


def queue_totals(queues):
	"""(pending_total, stuck_total, oldest_pending_at as str or None)."""
	pending = sum(q.get("pending", 0) for q in queues.values())
	stuck = sum(q.get("stuck", 0) for q in queues.values())
	olds = [q["oldest_at"] for q in queues.values() if q.get("oldest_at") and q.get("pending")]
	return pending, stuck, (min(olds) if olds else None)


# --------------------------------------------------------------------------- #
# device facts
# --------------------------------------------------------------------------- #


def clean_device_info(raw):
	"""The whitelisted, typed device health facts (ported from upande_mobile.api.monitor.clean_device)."""
	raw = raw if isinstance(raw, dict) else {}
	out = {}
	for key in ("battery_state", "network_type", "locale", "timezone"):
		value = clip(raw.get(key), 100)
		if value:
			out[key] = value
	for key in ("low_power", "is_connected", "is_internet_reachable"):
		value = to_bool(raw.get(key))
		if value is not None:
			out[key] = value
	if raw.get("battery_level") not in ("", None):
		battery = num(raw.get("battery_level"), 0, 1)
		if battery is not None:
			out["battery_level"] = round(battery, 3)
	for key in ("storage_free_bytes", "storage_total_bytes", "memory_total_bytes"):
		value = to_int(raw.get(key))
		if value is not None:
			out[key] = value
	return out


def connectivity_of(info):
	"""'online' / 'offline' / '' (unknown) from the reported network flags."""
	if info.get("is_connected") is False or info.get("is_internet_reachable") is False:
		return "offline"
	if info.get("is_connected") or info.get("is_internet_reachable"):
		return "online"
	return ""


def health_flags(row):
	"""Why a device needs attention, from a device row (ported from upande_mobile health_flags)."""
	flags = []
	battery = float(row.get("battery_level") or 0)
	if 0 < battery < LOW_BATTERY and row.get("battery_state") not in ("charging", "full"):
		flags.append("low_battery")
	total, free = int(row.get("storage_total_bytes") or 0), int(row.get("storage_free_bytes") or 0)
	if total > 0 and (free < LOW_STORAGE_BYTES or free < total * LOW_STORAGE_FRACTION):
		flags.append("low_storage")
	if row.get("connectivity") == "offline":
		flags.append("offline")
	if int(row.get("stuck_total") or 0) > 0:
		flags.append("stuck")
	return flags


# --------------------------------------------------------------------------- #
# events
# --------------------------------------------------------------------------- #


def event_fingerprint(kind, error_name, stack, req_method, req_url, req_status, message):
	"""sha1 of kind | error_name | first stack frame | req path, per the spec.

	Deviation kept small and documented in the spec: an API error also keys on method and status (a 404 and a
	500 on one path are different problems), and an event with neither a frame nor a path keys on its normalised
	message so unrelated message-only errors do not all collapse into one issue.
	"""
	frames = stack_frames(stack, 1)
	path = path_template(req_url) if text(req_url) else ""
	parts = [kind, text(error_name)[:60], frames[0] if frames else "", path]
	if kind == "api_error":
		parts += [text(req_method).upper(), str(req_status or 0)]
	elif not frames and not path:
		parts.append(normalise_message(message))
	return hashlib.sha1("|".join(parts).encode()).hexdigest()


def clean_event(raw, now_utc=None):
	"""One reported event as the dict to store, or None when it is not an event."""
	if not isinstance(raw, dict):
		return None
	now_utc = now_utc or datetime.utcnow()
	kind = text(raw.get("kind"), "error").lower()
	if kind not in KINDS:
		kind = "error"
	level = text(raw.get("level")).lower()
	if level not in LEVELS:
		level = {"crash": "fatal", "api_error": "warning", "warning": "warning"}.get(kind)
		level = level or ("info" if kind in INFO_KINDS else "error")
	message = redact_text(raw.get("message"), MAX_MESSAGE)
	stack = redact_text(raw.get("stack"), MAX_STACK)
	req_url = redact_url(path_only(raw.get("req_url")), (), 500) if text(raw.get("req_url")) else ""
	if not message and not stack and not req_url and kind not in INFO_KINDS:
		return None
	method = text(raw.get("req_method")).upper()
	method = method if method in HTTP_METHODS else ("GET" if req_url else "")
	status = to_int(raw.get("req_status"), 0, 999) or 0
	duration = to_int(raw.get("req_duration_ms"), 0, 3_600_000) or 0
	extra = raw.get("extra")
	if isinstance(extra, dict):
		extra = redact_value(extra)
		if len(json.dumps(extra, default=str)) > MAX_EXTRA_BYTES:
			extra = {"truncated": True}
	else:
		extra = None
	error_name = clip(raw.get("error_name"), 100)
	fatal = 1 if (kind == "crash" or to_bool(raw.get("fatal"))) else 0
	ts = utc_naive(raw.get("ts"), now_utc) or now_utc
	event_id = clip(raw.get("event_id"), 64)
	if not event_id:
		# an event with no id still dedupes on its content
		event_id = hashlib.sha1(f"{ts}|{kind}|{message}|{stack[:200]}|{req_url}".encode()).hexdigest()
	return {
		"event_id": event_id,
		"kind": kind,
		"level": level,
		"ts_utc": ts,
		"message": message,
		"error_name": error_name,
		"stack": stack,
		"fatal": fatal,
		"count": max(1, min(to_int(raw.get("count"), 1, 100000) or 1, 100000)),
		"screen": clip(raw.get("screen"), 140),
		"req_method": method,
		"req_url": req_url,
		"req_status": status,
		"req_duration_ms": duration,
		"req_error": redact_text(raw.get("req_error"), 300),
		"fingerprint": event_fingerprint(kind, error_name, stack, method, req_url, status, message)
		if kind in PROBLEM_KINDS
		else "",
		"extra": extra,
	}


def path_only(url):
	"""The URL's path with no host or query: only a path is ever stored (query strings can carry tokens)."""
	from urllib.parse import urlsplit

	s = text(url)
	try:
		return urlsplit(s).path or s.split("?")[0]
	except ValueError:
		return s.split("?")[0]
