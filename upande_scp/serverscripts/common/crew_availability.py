"""Is this spray crew available on the spray date? Leave, and optionally a check-in.

A sprayer on approved leave who still sits on a spray team must not end up on the
**confirmed** crew in the morning. Two sources answer it:

* **Leave Application** (HRMS). Approved (docstatus 1) covering the date is
  ``on_leave``; an Open application covering it is ``leave_pending``, which only ever
  warns — it may yet be rejected. A half day still counts as on leave: the crew goes
  out in the morning, and the record does not say which half.
* **Employee Checkin**, only when ``crew_require_checkin`` is on: no IN punch since
  00:00 on the date is ``not_checked_in``. Attendance is not used — on live it is
  created around midnight, so at 06:00 it says nothing.

The status rules (``classify``, ``split``) are pure, so they are tested without a
database. ``availability`` is one batched query per table.

The setting (``crew_leave_check``) decides what a problem *does*:

* ``Off``   — nothing is checked.
* ``Warn``  — the crew is saved; the caller gets warnings and the plan a comment.
* ``Block`` — ``on_leave`` / ``not_checked_in`` refuse; ``leave_pending`` still warns.

Offline syncs and planning never block (``split(..., can_block=False)``): the spray has
already happened, or the plan date is days away.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

OFF, WARN, BLOCK = "Off", "Warn", "Block"
MODES = (OFF, WARN, BLOCK)
DEFAULT_MODE = WARN

ON_LEAVE = "on_leave"
LEAVE_PENDING = "leave_pending"
NOT_CHECKED_IN = "not_checked_in"
OK = "ok"

#: Statuses that refuse in Block mode. ``leave_pending`` is deliberately absent.
BLOCKING = frozenset({ON_LEAVE, NOT_CHECKED_IN})

LABELS = {
	ON_LEAVE: "On leave",
	LEAVE_PENDING: "Leave pending",
	NOT_CHECKED_IN: "Not clocked in",
	OK: "Available",
}


# ─────────────────────────────── pure rules ──────────────────────────────────


def _as_date(value) -> date | None:
	if value is None or value == "":
		return None
	if isinstance(value, datetime):
		return value.date()
	if isinstance(value, date):
		return value
	return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()


def normalise_mode(value) -> str:
	"""Blank or unknown reads as the default (Warn) — an unset Single must not mean Off."""
	text = (value or "").strip().title()
	return text if text in MODES else DEFAULT_MODE


def _covers(leave: dict, on_date: date) -> bool:
	start, end = _as_date(leave.get("from_date")), _as_date(leave.get("to_date"))
	return bool(start and end and start <= on_date <= end)


def _is_half_day(leave: dict, on_date: date) -> bool:
	if not int(leave.get("half_day") or 0):
		return False
	half = _as_date(leave.get("half_day_date"))
	if half:
		return half == on_date
	# A one-day application flagged half day carries no separate half-day date.
	return _as_date(leave.get("from_date")) == _as_date(leave.get("to_date")) == on_date


def _is_approved(leave: dict) -> bool:
	return int(leave.get("docstatus") or 0) == 1 and (leave.get("status") or "Approved") == "Approved"


def _is_open(leave: dict) -> bool:
	return int(leave.get("docstatus") or 0) == 0 and (leave.get("status") or "") == "Open"


def classify(
	on_date,
	leaves: list[dict],
	checked_in: bool = True,
	require_checkin: bool = False,
) -> dict:
	"""One employee's status on a date, from their leave rows and check-in.

	Priority: ``on_leave`` > ``not_checked_in`` > ``leave_pending`` > ``ok`` — a status
	that can block outranks one that can only warn.
	"""
	day = _as_date(on_date)
	approved = [lv for lv in leaves if _is_approved(lv) and _covers(lv, day)]
	pending = [lv for lv in leaves if _is_open(lv) and _covers(lv, day)]
	if approved:
		lv = approved[0]
		return {
			"status": ON_LEAVE,
			"half_day": _is_half_day(lv, day),
			"leave_application": lv.get("name"),
			"leave_type": lv.get("leave_type"),
		}
	if require_checkin and not checked_in:
		return {"status": NOT_CHECKED_IN, "half_day": False, "leave_application": None, "leave_type": None}
	if pending:
		lv = pending[0]
		return {
			"status": LEAVE_PENDING,
			"half_day": _is_half_day(lv, day),
			"leave_application": lv.get("name"),
			"leave_type": lv.get("leave_type"),
		}
	return {"status": OK, "half_day": False, "leave_application": None, "leave_type": None}


def describe(name: str, status: str, on_date, half_day: bool = False) -> str:
	"""The sentence a supervisor reads (and the Work Order comment carries)."""
	day = str(_as_date(on_date))
	who = name or "A crew member"
	if status == ON_LEAVE:
		return f"{who} was on approved leave on {day}" + (" (half day)" if half_day else "") + "."
	if status == LEAVE_PENDING:
		return f"{who} has a leave application pending for {day}."
	if status == NOT_CHECKED_IN:
		return f"{who} had not clocked in on {day}."
	return ""


def split(statuses: dict, mode: str, can_block: bool = True) -> tuple[list[dict], list[dict]]:
	"""(blocked, warned) entries for a mode.

	``statuses`` maps employee → ``classify`` output plus ``employee_name``. ``Off``
	yields nothing; ``can_block=False`` turns every would-be refusal into a warning.
	"""
	mode = normalise_mode(mode)
	blocked: list[dict] = []
	warned: list[dict] = []
	if mode == OFF:
		return blocked, warned
	for emp, st in statuses.items():
		status = st.get("status")
		if status == OK or not status:
			continue
		entry = {
			"employee": emp,
			"employee_name": st.get("employee_name") or emp,
			"status": status,
			"half_day": bool(st.get("half_day")),
			"leave_application": st.get("leave_application"),
		}
		if mode == BLOCK and can_block and status in BLOCKING:
			blocked.append(entry)
		else:
			warned.append(entry)
	return blocked, warned


# ─────────────────────────────── database ────────────────────────────────────


def settings() -> dict:
	"""``{"mode": Off|Warn|Block, "require_checkin": bool}`` from the Single."""
	import frappe

	single = "Scouting and Crop Protection Settings"
	mode = frappe.db.get_single_value(single, "crew_leave_check")
	require = frappe.db.get_single_value(single, "crew_require_checkin")
	return {"mode": normalise_mode(mode), "require_checkin": bool(int(require or 0))}


def leaves_between(employees, from_date, to_date, include_open: bool = True) -> list[dict]:
	"""Approved (and optionally Open) Leave Applications overlapping a range. One query."""
	import frappe

	emps = sorted({e for e in (employees or []) if e})
	if not emps or not frappe.db.table_exists("Leave Application"):
		return []
	states = "(docstatus = 1 AND status = 'Approved')"
	if include_open:
		states += " OR (docstatus = 0 AND status = 'Open')"
	return frappe.db.sql(
		f"""SELECT name, employee, employee_name, leave_type, from_date, to_date,
		           half_day, half_day_date, status, docstatus
		      FROM `tabLeave Application`
		     WHERE employee IN %(emps)s
		       AND from_date <= %(to)s AND to_date >= %(from)s
		       AND ({states})
		  ORDER BY docstatus DESC, from_date""",
		{"emps": tuple(emps), "from": str(_as_date(from_date)), "to": str(_as_date(to_date))},
		as_dict=True,
	)


def checked_in(employees, on_date) -> set[str]:
	"""Employees with an IN check-in between 00:00 on the date and 00:00 the next. One query."""
	import frappe

	emps = sorted({e for e in (employees or []) if e})
	if not emps or not frappe.db.table_exists("Employee Checkin"):
		return set()
	day = _as_date(on_date)
	rows = frappe.db.sql(
		"""SELECT DISTINCT employee FROM `tabEmployee Checkin`
		    WHERE employee IN %(emps)s AND log_type = 'IN'
		      AND time >= %(start)s AND time < %(end)s""",
		{"emps": tuple(emps), "start": f"{day} 00:00:00", "end": f"{day + timedelta(days=1)} 00:00:00"},
	)
	return {r[0] for r in rows}


def availability(employees, on_date, require_checkin: bool | None = None) -> dict:
	"""employee → {status, label, half_day, leave_application, leave_type, employee_name}."""
	import frappe

	emps = [e for e in dict.fromkeys(employees or []) if e]
	if not emps:
		return {}
	day = _as_date(on_date)
	if require_checkin is None:
		require_checkin = settings()["require_checkin"]

	by_emp: dict[str, list[dict]] = {}
	names: dict[str, str] = {}
	for lv in leaves_between(emps, day, day):
		by_emp.setdefault(lv["employee"], []).append(lv)
	punched = checked_in(emps, day) if require_checkin else set()
	for row in frappe.get_all(
		"Employee", filters={"name": ["in", emps]}, fields=["name", "employee_name"]
	):
		names[row["name"]] = row.get("employee_name") or row["name"]

	out: dict[str, dict] = {}
	for emp in emps:
		st = classify(day, by_emp.get(emp, []), emp in punched, require_checkin)
		st["label"] = LABELS[st["status"]]
		st["employee_name"] = names.get(emp, emp)
		out[emp] = st
	return out


def check_crew(employees, on_date, can_block: bool = True, mode: str | None = None) -> dict:
	"""Availability + what the setting makes of it, for an enforcement point.

	Returns ``{mode, on_date, availability, blocked, warnings, messages}``; ``messages``
	are the warning sentences. Off mode skips the queries entirely.
	"""
	cfg = settings()
	mode = normalise_mode(mode or cfg["mode"])
	day = _as_date(on_date)
	if mode == OFF or not day:
		return {"mode": mode, "on_date": str(day) if day else None, "availability": {},
				"blocked": [], "warnings": [], "messages": []}
	avail = availability(employees, day, cfg["require_checkin"])
	blocked, warned = split(avail, mode, can_block=can_block)
	return {
		"mode": mode,
		"on_date": str(day),
		"availability": avail,
		"blocked": blocked,
		"warnings": warned,
		"messages": [describe(w["employee_name"], w["status"], day, w["half_day"]) for w in warned],
	}


def refusal_message(blocked: list[dict], on_date) -> str:
	lines = [describe(b["employee_name"], b["status"], on_date, b["half_day"]) for b in blocked]
	return (
		"This crew cannot be confirmed (crew leave check is set to Block):\n- "
		+ "\n- ".join(lines)
		+ "\nRemove them from the crew, or ask a General Manager to change the setting."
	)


def comment_on_work_order(work_order: str, messages: list[str]) -> None:
	"""Add each warning to the Work Order once. Repeats (team save then start) are skipped."""
	import frappe

	for text in messages:
		if not text:
			continue
		content = f"Crew check: {text}"
		if frappe.db.exists(
			"Comment",
			{"reference_doctype": "Work Order", "reference_name": work_order,
			 "comment_type": "Comment", "content": content},
		):
			continue
		try:
			frappe.get_doc({
				"doctype": "Comment",
				"comment_type": "Comment",
				"reference_doctype": "Work Order",
				"reference_name": work_order,
				"content": content,
			}).insert(ignore_permissions=True)
		except Exception:
			frappe.log_error(frappe.get_traceback(), "crew_availability: comment failed")
