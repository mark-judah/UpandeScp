"""When a spray plan is late, and when it is missed.

One definition, used by the lifecycle endpoints, the progress emails and (through the
payload) the web pages and the handset, so they cannot disagree.

A plan is **missed** only after its planned day's cutoff: never before, because a
sprayer working offline may still sync a spray that happened on time. Before that it
is *late* in degrees, graded across the window between the planned time and the
cutoff: amber from the planned time, orange from half-way, red in the last 10 %.
It is a label only - nothing is stopped or postponed by it.

The cutoff is ``spray_cutoff_time``, overridable per crop; unset (or midnight, which
means the same) falls back to 22:00.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import frappe
from frappe.utils import get_datetime, getdate, now_datetime

DEFAULT_CUTOFF = "22:00:00"

#: Levels, in order of increasing urgency.
LEVELS = ("none", "amber", "orange", "red", "missed")


def cutoff_for(crop: str | None = None) -> str:
	"""The daily cutoff as ``HH:MM:SS`` for a crop (22:00 when unset)."""
	value = None
	try:
		from upande_scp.serverscripts.spray_plan_creator import crop_settings

		value = crop_settings.value_for("spray_cutoff_time", crop or "")
	except Exception:
		value = None
	text = str(value or "").strip()
	if not text or set(text) <= set("0:. "):
		return DEFAULT_CUTOFF
	parts = text.split(":")
	try:
		h, m = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
		s = int(float(parts[2])) if len(parts) > 2 else 0
	except ValueError:
		return DEFAULT_CUTOFF
	return f"{h:02d}:{m:02d}:{s:02d}"


def deadline_of(scheduled, cutoff: str) -> datetime:
	"""The planned day's cutoff, never earlier than the plan itself."""
	sched = get_datetime(scheduled)
	deadline = get_datetime(f"{getdate(sched)} {cutoff}")
	if deadline <= sched:
		deadline = sched + timedelta(minutes=30)
	return deadline


def grade(scheduled, now=None, cutoff: str = DEFAULT_CUTOFF, open_plan: bool = True) -> dict:
	"""``{level, missed, deadline}`` for one plan.

	``open_plan`` is False once the plan has started spraying, or been stopped:
	such a plan is never late.
	"""
	if not scheduled or not open_plan:
		return {"level": "none", "missed": False, "deadline": None}
	sched = get_datetime(scheduled)
	now = get_datetime(now) if now else now_datetime()
	deadline = deadline_of(sched, cutoff)
	if now > deadline:
		level = "missed"
	elif now < sched:
		level = "none"
	else:
		frac = (now - sched) / (deadline - sched)
		level = "red" if frac >= 0.9 else "orange" if frac >= 0.5 else "amber"
	return {"level": level, "missed": level == "missed", "deadline": str(deadline)}


def crop_of_greenhouse(greenhouse: str | None) -> str | None:
	try:
		from upande_scp.serverscripts.common import crop_catalog

		return crop_catalog.crop_for_greenhouse(greenhouse)
	except Exception:
		return None


def make_grader(now=None):
	"""A cached ``(scheduled, greenhouse, open_plan) -> grade`` for use over many rows."""
	now = get_datetime(now) if now else now_datetime()
	cutoffs: dict = {}

	def _grade(scheduled, greenhouse=None, open_plan=True):
		crop = crop_of_greenhouse(greenhouse)
		if crop not in cutoffs:
			cutoffs[crop] = cutoff_for(crop)
		return grade(scheduled, now, cutoffs[crop], open_plan)

	return _grade


# ───────────────────────────── postponement marks ────────────────────────────


def postponed_map(work_orders) -> dict:
	"""``{work_order: from_datetime}`` for plans whose latest approved postponement
	is the one that put them on their current date."""
	names = [w for w in set(work_orders or []) if w]
	if not names or not frappe.db.table_exists("Spray Plan Postponement"):
		return {}
	rows = frappe.get_all(
		"Spray Plan Postponement",
		filters={"work_order": ("in", names), "status": "Approved"},
		fields=["work_order", "from_datetime", "to_datetime"],
		order_by="decided_on asc, creation asc",
		limit_page_length=0,
	)
	out: dict = {}
	for r in rows:
		out[r.work_order] = r  # last approved wins
	if not out:
		return {}
	current = {
		w.name: (w.custom_scheduled_application_time or w.planned_start_date)
		for w in frappe.get_all(
			"Work Order",
			filters={"name": ("in", list(out))},
			fields=["name", "custom_scheduled_application_time", "planned_start_date"],
			limit_page_length=0,
		)
	}
	res = {}
	for name, r in out.items():
		cur = current.get(name)
		if cur and r.to_datetime and getdate(cur) == getdate(r.to_datetime):
			res[name] = str(r.from_datetime) if r.from_datetime else None
	return res


# ─────────────────────────── no planning in the past ─────────────────────────

#: Request latency only: a plan picked "now" reaches the server a moment later.
PAST_TOLERANCE_SECONDS = 60


def assert_not_in_past(scheduled, previous=None, now=None) -> None:
	"""Refuse a spray plan scheduled earlier than now (site time).

	A date alone means "that day": today is allowed, an earlier day is not. When
	``previous`` (the plan's existing schedule) is given and the date has not
	changed, nothing is checked - editing a draft whose day has since passed must
	not be blocked by a field the user did not touch.

	Skipped under the test runner (many fixtures use fixed dates) unless
	``frappe.flags.enforce_past_guard`` is set.
	"""
	if not scheduled:
		return
	if frappe.flags.in_test and not frappe.flags.get("enforce_past_guard"):
		return
	text = str(scheduled).strip()
	now = get_datetime(now) if now else now_datetime()
	if previous:
		try:
			if get_datetime(previous).replace(second=0, microsecond=0) == get_datetime(
				text
			).replace(second=0, microsecond=0):
				return
		except Exception:
			pass
	date_only = len(text) <= 10
	try:
		target = get_datetime(text)
	except Exception:
		return
	if date_only:
		late = getdate(target) < getdate(now)
	else:
		late = target < now - timedelta(seconds=PAST_TOLERANCE_SECONDS)
	if late:
		frappe.throw(
			f"A spray plan cannot be scheduled in the past ({text.replace('T', ' ')[:16]}). "
			f"It is {now.strftime('%Y-%m-%d %H:%M')} now - pick a time from now on.",
			frappe.ValidationError,
		)


# ───────────────────────── sessions that arrive after the cutoff ─────────────────────────

CUT_OFF_MESSAGE = (
	"This spray was sent after the {hhmm} cut-off for {day}, so the site no longer "
	"takes it. Ask a manager to allow it if it really happened."
)


def spray_date_of(work_order: str):
	"""The day a plan is to be sprayed: its planned date, or the new date of its
	latest Approved postponement when that is later (a postponement moves the plan)."""
	wo = frappe.db.get_value(
		"Work Order", work_order,
		["custom_scheduled_application_time", "planned_start_date", "custom_greenhouse"],
		as_dict=True,
	)
	if not wo:
		return None, None
	value = wo.custom_scheduled_application_time or wo.planned_start_date
	day = getdate(value) if value else None
	if frappe.db.table_exists("Spray Plan Postponement"):
		to = frappe.get_all(
			"Spray Plan Postponement",
			filters={"work_order": work_order, "status": "Approved"},
			fields=["to_datetime"],
			order_by="decided_on desc, creation desc",
			limit_page_length=1,
		)
		if to and to[0].to_datetime:
			moved = getdate(to[0].to_datetime)
			if day is None or moved > day:
				day = moved
	return day, wo.custom_greenhouse


def session_cutoff(work_order: str):
	"""``(deadline_datetime, 'HH:MM', date)`` for the plan's spray day, or None."""
	day, greenhouse = spray_date_of(work_order)
	if not day:
		return None
	cutoff = cutoff_for(crop_of_greenhouse(greenhouse))
	return get_datetime(f"{day} {cutoff}"), cutoff[:5], day


def is_allowed_after_cutoff(token: str | None = None, work_order: str | None = None) -> bool:
	"""A manager let this token (or, for an online step with no token, a session on
	this plan) through after the cutoff."""
	if not frappe.db.table_exists("Spray Session Token"):
		return False
	if token:
		if frappe.db.get_value("Spray Session Token", token, "allow_after_cutoff"):
			return True
	elif work_order:
		return bool(frappe.db.exists(
			"Spray Session Token",
			{"work_order": work_order, "allow_after_cutoff": 1, "status": ("!=", "Synced")},
		))
	return False


def assert_session_in_time(work_order: str, token: str | None = None, now=None) -> None:
	"""Refuse a spray session that reaches the server after its day's cutoff, unless
	a manager allowed it. Site time. Skipped for a plan with no date, and under the test
	runner (fixtures use fixed past dates) unless ``frappe.flags.enforce_session_cutoff``."""
	if not work_order:
		return
	if frappe.flags.in_test and not frappe.flags.get("enforce_session_cutoff"):
		return
	info = session_cutoff(work_order)
	if not info:
		return
	deadline, hhmm, day = info
	now = get_datetime(now) if now else now_datetime()
	if now <= deadline:
		return
	if is_allowed_after_cutoff(token, None if token else work_order):
		return
	frappe.throw(CUT_OFF_MESSAGE.format(hhmm=hhmm, day=day), frappe.ValidationError)
