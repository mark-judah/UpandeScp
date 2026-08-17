"""The app's one view of what time it is.

ERPNext's **System Settings → Time Zone** decides everything that matters: what
`frappe.utils.now_datetime()` returns, what gets written into every timestamp, and what
clock the scheduler evaluates cron expressions against (`ScheduledJobType.is_event_due`
calls `now_datetime()`). There is no second clock to be had.

That makes a wrong value expensive and silent. On kaitet it was still Frappe's
out-of-the-box ``Asia/Kolkata`` while every farm coordinate is Kenyan and both companies
are registered in Kenya — so every timestamp the app had ever written was **2h30m ahead
of local time**, and the `0 14 * * *` daily report fired at 11:30 Nairobi. Nothing
surfaced it, because a clock that is consistently wrong looks like a working clock.

So this module does three things:

* **reports** the ERP timezone rather than assuming it, and says what the app believes
  it *should* be from the farms' own coordinates — a mismatch is the signal that nobody
  ever set it;
* **holds an app display timezone**, which the operator asked for. It is honestly
  limited: it changes how this app renders times and nothing else. Stored timestamps and
  the scheduler follow ERP, because they must;
* **locks it.** Changing a timezone silently re-times every notification and scheduled
  report, so the setting refuses to move while `timezone_locked` is on, and every change
  is logged with who made it.
"""
from __future__ import annotations

from datetime import datetime, timezone as _tz
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import frappe

SETTINGS = "Scouting and Crop Protection Settings"

#: What the app falls back to describing when nothing is configured anywhere.
FALLBACK = "UTC"

#: Longitude/latitude boxes for the timezones this deployment plausibly runs in, used
#: only to say "the ERP setting looks wrong" — never to change anything. Deliberately
#: coarse: the point is to catch a default nobody touched, not to geolocate a farm.
_REGION_BOXES = (
	# (tz, lat_min, lat_max, lon_min, lon_max)
	("Africa/Nairobi", -5.0, 5.5, 33.5, 42.0),   # Kenya + immediate neighbours
	("Africa/Kampala", -1.5, 4.5, 29.5, 35.5),
	("Africa/Kigali", -3.0, -1.0, 28.8, 31.0),
	("Europe/Amsterdam", 50.5, 53.7, 3.2, 7.3),
)


def _single_value(doctype: str, field: str):
	try:
		return frappe.db.get_single_value(doctype, field)
	except Exception:
		return None


def erp_timezone() -> str:
	"""The site timezone — the only one that actually governs anything."""
	return str(_single_value("System Settings", "time_zone") or FALLBACK)


def app_timezone() -> str:
	"""The timezone this app renders in. Follows ERP unless overridden."""
	override = (_single_value(SETTINGS, "app_timezone") or "").strip()
	if override and is_valid(override):
		return override
	return erp_timezone()


def is_locked() -> bool:
	"""Whether the timezone is protected from change. Unset means **locked**.

	Read straight from `tabSingles` rather than through `get_single_value`, which returns
	`0` for a field that has never been stored — indistinguishable from a deliberate
	unlock. That would have defaulted the most consequential setting in the app to *open*
	on every fresh site, which is the opposite of the intent. Only an explicitly stored
	`0` unlocks it; no row, or a NULL, is locked.
	"""
	try:
		row = frappe.db.sql(
			"SELECT value FROM tabSingles WHERE doctype = %s AND field = %s",
			(SETTINGS, "timezone_locked"),
		)
	except Exception:
		return True
	if not row or row[0][0] is None or str(row[0][0]).strip() == "":
		return True
	try:
		return bool(int(row[0][0]))
	except (TypeError, ValueError):
		return True


def is_valid(name: str | None) -> bool:
	if not name:
		return False
	try:
		ZoneInfo(str(name))
		return True
	except (ZoneInfoNotFoundError, ValueError, TypeError):
		return False


def offset_minutes(name: str | None) -> int | None:
	"""Current UTC offset of a timezone, in minutes. None when unreadable.

	Computed for *now* rather than stored, because an offset is not a property of a
	timezone — it changes with daylight saving, and a cached number would be wrong twice
	a year for the deployments that observe it.
	"""
	if not is_valid(name):
		return None
	now = datetime.now(ZoneInfo(str(name)))
	delta = now.utcoffset()
	return int(delta.total_seconds() // 60) if delta else 0


def _fmt_offset(minutes: int | None) -> str:
	if minutes is None:
		return "?"
	sign = "+" if minutes >= 0 else "-"
	minutes = abs(minutes)
	return f"UTC{sign}{minutes // 60:02d}:{minutes % 60:02d}"


def expected_timezone() -> str | None:
	"""What the farms' own coordinates suggest the timezone should be.

	Used to *report* a suspicious ERP setting, never to change it. Returns None when the
	site has no coordinates to reason from, or when they do not fall in a region this
	knows about — an unknown answer is better than a confident wrong one.
	"""
	try:
		rows = frappe.get_all(
			"Farm Map Coordinate",
			fields=["lat", "lon"],
			limit_page_length=200,
		)
	except Exception:
		return None
	points = [
		(float(r.lat), float(r.lon))
		for r in rows
		if r.get("lat") not in (None, 0) and r.get("lon") not in (None, 0)
	]
	if not points:
		return None

	tally: dict[str, int] = {}
	for lat, lon in points:
		for tz, lat_min, lat_max, lon_min, lon_max in _REGION_BOXES:
			if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
				tally[tz] = tally.get(tz, 0) + 1
				break
	if not tally:
		return None
	return max(tally, key=lambda k: tally[k])


# ─────────────────────────────── the report ──────────────────────────────────


@frappe.whitelist()
def timezone_report() -> dict:
	"""Everything the settings screen needs to show, and nothing it has to compute.

	Readable by any signed-in user: knowing what clock the app runs on is not privileged,
	and every screen that renders a time benefits from being able to say so.
	"""
	erp = erp_timezone()
	app = app_timezone()
	expected = expected_timezone()
	erp_off = offset_minutes(erp)
	app_off = offset_minutes(app)
	expected_off = offset_minutes(expected) if expected else None

	warnings: list[str] = []
	if expected and expected != erp:
		drift = (
			abs((expected_off or 0) - (erp_off or 0)) if erp_off is not None else None
		)
		warnings.append(
			f"ERPNext is set to {erp} ({_fmt_offset(erp_off)}) but this site's farms are "
			f"in {expected} ({_fmt_offset(expected_off)})"
			+ (
				f" — every timestamp and scheduled job is {drift // 60}h"
				f"{drift % 60:02d}m out of step with the farms."
				if drift
				else "."
			)
		)
	if app != erp:
		warnings.append(
			f"This app displays times in {app} while ERPNext stores and schedules in "
			f"{erp}. Notifications, scheduled reports and every saved timestamp follow "
			f"{erp} — the override changes what is shown, not when anything happens."
		)
	if erp == FALLBACK and expected:
		warnings.append(
			"The site timezone has never been set away from the default."
		)

	return {
		"erp_timezone": erp,
		"erp_offset": _fmt_offset(erp_off),
		"app_timezone": app,
		"app_offset": _fmt_offset(app_off),
		"follows_erp": app == erp,
		"expected_timezone": expected,
		"expected_offset": _fmt_offset(expected_off) if expected else None,
		"locked": is_locked(),
		"warnings": warnings,
		# The clock as each party sees it, so a mismatch is visible rather than argued
		# about.
		"now_erp": str(frappe.utils.now_datetime()),
		"now_utc": datetime.now(_tz.utc).strftime("%Y-%m-%d %H:%M:%S"),
		"now_app": (
			datetime.now(ZoneInfo(app)).strftime("%Y-%m-%d %H:%M:%S")
			if is_valid(app)
			else None
		),
		"affected": [
			"every timestamp written by this app",
			"in-app and email notifications",
			"the daily scouting report, weekly trap report and chemical progress email",
			"the spray cutoff and postponement deadlines",
			"auto-cancel of dormant plans",
		],
	}


@frappe.whitelist()
def available_timezones() -> list[str]:
	"""Timezones worth offering, rather than all 600.

	The ERP value and the inferred one are always included even if they are outside the
	short list, so the screen can never show a setting it cannot represent.
	"""
	from zoneinfo import available_timezones as _all

	shortlist = {
		"Africa/Nairobi", "Africa/Kampala", "Africa/Kigali", "Africa/Dar_es_Salaam",
		"Africa/Addis_Ababa", "Africa/Johannesburg", "Africa/Lagos", "Africa/Cairo",
		"Europe/Amsterdam", "Europe/London", "Asia/Dubai", "Asia/Kolkata", "UTC",
	}
	shortlist.add(erp_timezone())
	expected = expected_timezone()
	if expected:
		shortlist.add(expected)
	known = _all()
	return sorted(tz for tz in shortlist if tz in known or tz == "UTC")


# ──────────────────────────────── the lock ───────────────────────────────────

ELEVATED = {"SCP General Manager", "System Manager", "Administrator"}


def _assert_gm() -> None:
	if not (set(frappe.get_roles(frappe.session.user)) & ELEVATED):
		frappe.throw(
			"Only the SCP General Manager can change the timezone.",
			frappe.PermissionError,
		)


@frappe.whitelist()
def set_lock(locked) -> dict:
	"""Lock or unlock the timezone. Unlocking is itself recorded.

	Two steps rather than one because the damage is silent: a changed timezone re-times
	every notification and scheduled report without any error appearing, so the operator
	has to say out loud that they mean to touch it.
	"""
	_assert_gm()
	want = bool(int(locked or 0)) if str(locked).isdigit() else bool(locked)
	frappe.db.set_single_value(SETTINGS, "timezone_locked", 1 if want else 0)
	frappe.clear_cache(doctype=SETTINGS)
	frappe.db.commit()
	_log(f"timezone {'locked' if want else 'UNLOCKED'} by {frappe.session.user}")
	return timezone_report()


@frappe.whitelist()
def set_app_timezone(name: str | None = None) -> dict:
	"""Set the app's display timezone. Blank means "follow ERPNext".

	Refuses while locked, and refuses an unknown zone rather than storing a string that
	silently falls back later — a setting that appears to have taken effect but has not
	is worse than a rejection.
	"""
	_assert_gm()
	if is_locked():
		frappe.throw(
			"The timezone is locked. Unlock it first — changing it re-times every "
			"notification, scheduled report and deadline in the app.",
		)

	value = (name or "").strip()
	if value and not is_valid(value):
		frappe.throw(f"{value} is not a timezone this system recognises.")

	before = app_timezone()
	frappe.db.set_single_value(SETTINGS, "app_timezone", value)
	frappe.clear_cache(doctype=SETTINGS)
	frappe.db.commit()
	after = app_timezone()
	_log(
		f"app display timezone {before} → {after} "
		f"(set to {value or 'follow ERPNext'}) by {frappe.session.user}"
	)
	return timezone_report()


def _log(message: str) -> None:
	"""Record a timezone change where somebody will find it afterwards.

	`frappe.log_error` rather than a comment on a Single: Singles have no timeline, and
	the Error Log is the one place already searched when times look wrong.
	"""
	try:
		frappe.log_error(message, "SCP timezone changed")
	except Exception:
		pass


# ───────────────────────── scheduler alignment ───────────────────────────────


@frappe.whitelist()
def scheduler_alignment() -> dict:
	"""When this app's scheduled jobs will actually next run.

	Directly the operator's question: a timezone change re-times every scheduled report,
	and the only honest answer is to ask the scheduler itself. `ScheduledJobType`
	evaluates cron against `frappe.utils.now_datetime()` — the site timezone — so a
	corrected clock moves every cron slot in real terms.

	Also flags jobs whose `last_execution` sits in the **future** relative to the
	corrected clock, which is what a backwards timezone correction leaves behind: their
	next slot is computed from that stale stamp, so they pause for up to the size of the
	correction and then resume. Reported rather than repaired, because shifting the
	stamps back would make a daily report whose slot falls inside the shifted window
	fire a second time — a delayed prewarm is harmless, a duplicate report to staff is
	not.
	"""
	now = frappe.utils.now_datetime()
	rows = frappe.get_all(
		"Scheduled Job Type",
		filters={"method": ("like", "%upande_scp%")},
		fields=["name", "method", "cron_format", "frequency", "last_execution", "stopped"],
	)
	jobs = []
	stale = 0
	for r in rows:
		entry = {
			"job": str(r.method).split(".")[-1],
			"method": r.method,
			"cron": r.cron_format or r.frequency,
			"last_execution": str(r.last_execution) if r.last_execution else None,
			"stopped": bool(r.stopped),
			"next_execution": None,
			"due_now": None,
			"last_execution_in_future": False,
		}
		if r.last_execution and r.last_execution > now:
			entry["last_execution_in_future"] = True
			stale += 1
		try:
			doc = frappe.get_doc("Scheduled Job Type", r.name)
			entry["next_execution"] = str(doc.get_next_execution())
			entry["due_now"] = bool(doc.is_event_due())
		except Exception:
			# A malformed cron on one job must not hide the rest.
			pass
		jobs.append(entry)

	jobs.sort(key=lambda j: (j["next_execution"] or "9999"))
	return {
		"now": str(now),
		"timezone": erp_timezone(),
		"jobs": jobs,
		"stale_last_execution": stale,
		"note": (
			"Cron is evaluated in the site timezone. A job whose last run is stamped in "
			"the future waits until its next slot after that stamp, then resumes — left "
			"alone on purpose, since rewinding the stamps could make a report send twice."
		),
	}
