"""Birthday, milestone and encouragement greeting for the logged-in scout (Scout
app home card).

``get_scout_greeting()`` resolves the scout's Employee from the session user,
gathers a few cheap numbers and lets ``scout_greeting_rules.choose`` pick the
message. One call, cached per user per day.

Cost. Scouting Entry has no index on the scout, so everything per scout reads a
42-day window through the date index, once a day. A lifetime total would be a
full-table scan (about 80 s for one scout on 2M rows); it is instead one
``GROUP BY`` over all scouts, run in a background job once a week
(``build_lifetime_baseline``). Until that job has run the entry-count milestone
is simply absent; streak milestones, birthdays and encouragement do not wait.

``scout_greetings_enabled`` (Scouting and Crop Protection Settings) off returns
kind null.
"""

from __future__ import annotations

from datetime import timedelta

import frappe
from frappe.utils import add_days, getdate, nowdate

from upande_scp.serverscripts.common import scout_greeting_rules as R
from upande_scp.serverscripts.scouting import capture_settings

WINDOW_DAYS = 42
BASELINE_KEY = "scp:scout_greeting:baseline:{cutoff}"
BASELINE_TTL = 21 * 24 * 3600
DAY_TTL = 26 * 3600
EMPTY = {"kind": None, "title": "", "message": "", "stats": {}}


def _monday(day):
	return day - timedelta(days=day.weekday())


def _employee(user: str) -> dict | None:
	rows = frappe.get_all(
		"Employee",
		filters={"user_id": user, "status": "Active"},
		fields=["name", "first_name", "employee_name", "date_of_birth"],
		limit_page_length=1,
	)
	return rows[0] if rows else None


def _window_rows(emp: str, today) -> list:
	"""[(date, greenhouse, entries)] for the scout over the window, date-indexed."""
	return frappe.db.sql(
		"""SELECT date_of_capture, greenhouse, COUNT(*)
		   FROM `tabScouting Entry`
		   WHERE date_of_capture BETWEEN %s AND %s AND scouts_name = %s AND docstatus < 2
		   GROUP BY date_of_capture, greenhouse""",
		(add_days(today, -WINDOW_DAYS), today, emp),
	)


def _plan_rows(emp: str, monday, sunday) -> list:
	return frappe.get_all(
		"Scout Assignment",
		filters={"scout": emp, "date": ["between", [str(monday), str(sunday)]]},
		fields=["date", "greenhouse"],
		limit_page_length=0,
	)


def build_lifetime_baseline(cutoff=None) -> int:
	"""Count every scout's entries before ``cutoff`` (default: last week's Monday)
	in one scan and cache the map. Run weekly from the scheduler or on demand."""
	cutoff = getdate(cutoff) if cutoff else _monday(getdate(nowdate())) - timedelta(days=7)
	rows = frappe.db.sql(
		"""SELECT scouts_name, COUNT(*) FROM `tabScouting Entry`
		   WHERE date_of_capture < %s AND docstatus < 2 AND IFNULL(scouts_name, '') != ''
		   GROUP BY scouts_name""",
		(str(cutoff),),
	)
	frappe.cache().set_value(
		BASELINE_KEY.format(cutoff=cutoff), {k: int(v) for k, v in rows}, expires_in_sec=BASELINE_TTL
	)
	return len(rows)


def _baseline(today) -> tuple[dict, object] | tuple[None, None]:
	"""The newest cached baseline (cutoff, this week's or the last two) — or ask
	the background job for one and return None meanwhile."""
	monday = _monday(today)
	cache = frappe.cache()
	for back in (7, 14, 21):
		cutoff = monday - timedelta(days=back)
		got = cache.get_value(BASELINE_KEY.format(cutoff=cutoff))
		if got is not None:
			return got, cutoff
	try:
		frappe.enqueue(
			"upande_scp.serverscripts.scouts.greeting.build_lifetime_baseline",
			queue="long", timeout=1800, job_id="scp_scout_greeting_baseline", deduplicate=True,
		)
	except Exception:
		pass  # greetings never fail a scout's app
	return None, None


def gather(emp: dict, today) -> dict:
	"""The numbers ``choose`` needs, from the window and the plan."""
	rows = _window_rows(emp["name"], today)
	by_day: dict = {}
	for d, _gh, n in rows:
		by_day[d] = by_day.get(d, 0) + int(n)
	monday = _monday(today)
	span = (today - monday).days
	last_monday = monday - timedelta(days=7)
	week = sum(n for d, n in by_day.items() if d >= monday)
	last_same = sum(n for d, n in by_day.items() if last_monday <= d <= last_monday + timedelta(days=span))
	last7 = sum(n for d, n in by_day.items() if d > today - timedelta(days=7))
	streak, streak_end = R.streak_from_dates(by_day.keys(), today)

	plan = _plan_rows(emp["name"], monday, monday + timedelta(days=6))
	scouted = {(d, gh) for d, gh, _n in rows}
	done = sum(1 for p in plan if (getdate(p["date"]), p["greenhouse"]) in scouted)

	stats = {
		"first_name": R.first_name(emp.get("employee_name"), emp.get("first_name")),
		"date_of_birth": emp.get("date_of_birth"),
		"entries_week": week,
		"entries_last_week_same_span": last_same,
		"entries_last7": last7,
		"entries_recent": sum(by_day.values()),
		"streak": streak,
		"streak_end": streak_end,
		"plan_total": len(plan),
		"plan_done": done,
	}
	if last7:  # an entry milestone needs entries to have just been added
		base, cutoff = _baseline(today)
		if base is not None:
			stats["lifetime"] = base.get(emp["name"], 0) + sum(n for d, n in by_day.items() if d >= cutoff)
	return stats


def greeting_for(user: str, today) -> dict:
	"""Uncached, setting-aware greeting for ``user`` on ``today``."""
	if not capture_settings.greetings_enabled():
		return dict(EMPTY)
	emp = _employee(user)
	if not emp:
		return dict(EMPTY)
	return R.choose(gather(emp, today), today, user)


@frappe.whitelist()
def get_scout_greeting() -> dict:
	"""``{kind: birthday|milestone|encouragement|None, title, message, stats, date}``."""
	user = frappe.session.user
	today = getdate(nowdate())
	if user in ("Guest", "Administrator") or not capture_settings.greetings_enabled():
		return {**EMPTY, "date": str(today)}
	cache = frappe.cache()
	key = f"scp:scout_greeting:{user}:{today}"
	hit = cache.get_value(key)
	if hit is not None:
		return hit
	try:
		out = {**greeting_for(user, today), "date": str(today)}
	except Exception:
		frappe.log_error(title="scout greeting")
		return {**EMPTY, "date": str(today)}
	cache.set_value(key, out, expires_in_sec=DAY_TTL)
	return out
