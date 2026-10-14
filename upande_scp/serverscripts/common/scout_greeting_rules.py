"""The scout greeting's rules, pure so they are tested without a database.

``choose(stats, today, user)`` turns a scout's numbers into one greeting, with the
priority birthday > milestone > encouragement, or ``None`` when there is nothing
honest to say. The wording comes from small template sets and the variant is
picked from a hash of (user, day, kind), so a scout sees the same text all day
and a different one tomorrow.

Not covered here: where the numbers come from (``scouts.greeting``).
"""

from __future__ import annotations

import zlib
from datetime import date, datetime, timedelta

#: Lifetime Scouting Entry counts worth a mention: 1,000, 5,000, then every 10,000.
ENTRY_MILESTONES = [1000, 5000] + list(range(10000, 1000001, 10000))
#: Consecutive working days scouted.
STREAK_MILESTONES = [5, 10, 20]
#: A milestone is news for this many days after it is crossed.
MILESTONE_DAYS = 7
#: 1 January is what 1,200+ employee records carry when the real date was unknown,
#: so it is never taken as a birthday.
PLACEHOLDER_BIRTHDAY = (1, 1)

_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]


def _d(value) -> date | None:
	if value in (None, ""):
		return None
	if isinstance(value, datetime):
		return value.date()
	if isinstance(value, date):
		return value
	return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()


def _word(n: int) -> str:
	return _WORDS[n] if 0 <= n < len(_WORDS) else str(n)


def _entries(n: int) -> str:
	return f"{n:,} " + ("entry" if n == 1 else "entries")


def _pick(options: list, user: str, today, kind: str):
	"""One option, the same for this user all day."""
	h = zlib.crc32(f"{user}|{_d(today).isoformat()}|{kind}".encode())
	return options[h % len(options)]


def first_name(full_name: str | None, first: str | None = None) -> str:
	"""A tidy first name from 'MARK KIPKOGEI BUNEI' -> 'Mark'."""
	raw = (first or "").strip() or ((full_name or "").strip().split(" ") or [""])[0]
	return raw.capitalize() if raw else ""


def is_birthday(dob, today) -> bool:
	"""Month and day match today's. 29 Feb is kept on 28 Feb in a non-leap year."""
	b, t = _d(dob), _d(today)
	if not b or not t or (b.month, b.day) == PLACEHOLDER_BIRTHDAY:
		return False
	if (b.month, b.day) == (2, 29):
		leap = t.year % 4 == 0 and (t.year % 100 != 0 or t.year % 400 == 0)
		return (t.month, t.day) == ((2, 29) if leap else (2, 28))
	return (b.month, b.day) == (t.month, t.day)


def crossed_entry_milestone(total_now: int, entries_in_window: int) -> int | None:
	"""The highest round number passed within the window, if any."""
	before = total_now - max(entries_in_window, 0)
	hit = [m for m in ENTRY_MILESTONES if before < m <= total_now]
	return max(hit) if hit else None


def streak_milestone(streak: int, streak_end, today) -> int | None:
	"""The highest streak mark reached within the last MILESTONE_DAYS days."""
	end, t = _d(streak_end), _d(today)
	if not streak or not end or not t:
		return None
	best = None
	for m in STREAK_MILESTONES:
		if streak >= m:
			reached = end - timedelta(days=streak - m)  # calendar approximation
			if (t - reached).days <= MILESTONE_DAYS:
				best = m
	return best


def streak_from_dates(dates, today) -> tuple[int, date | None]:
	"""(length, last day) of the run of consecutive scouted days ending today or
	yesterday. Sundays neither extend nor break a run."""
	t = _d(today)
	have = {_d(x) for x in dates if x}
	day = t
	if day not in have:
		day -= timedelta(days=1)
	while day.weekday() == 6 and day not in have:
		day -= timedelta(days=1)
	if day not in have:
		return 0, None
	end, n = day, 0
	while True:
		if day in have:
			n += 1
		elif day.weekday() != 6:
			break
		day -= timedelta(days=1)
	return n, end


# ---------------------------------------------------------------- wording

_BIRTHDAY = [
	("Happy birthday, {name}", "Everyone on the team wishes you a good day and a good year ahead. Thank you for the care you put into the crop."),
	("Happy birthday, {name}", "Today is your day. Thank you for the work you do in the houses every week, and have a good one."),
	("Happy birthday, {name}", "Wishing you health and a good year. The team is glad to have you."),
]
_ENTRIES = [
	("{n} entries scouted", "You have passed {n} scouting entries in total. That is a lot of steady work, and the crop is better for it."),
	("{n} entries scouted", "Your {n}th entry is behind you. Careful, regular scouting like yours is what catches problems early."),
	("{n} entries scouted", "Over {n} entries recorded. Thank you for the consistency."),
]
_STREAK = [
	("{n} working days in a row", "You have scouted {n} working days running. Steady rounds make for reliable data."),
	("{n} working days in a row", "That is {n} days in a row on the round. Well done, keep the rhythm."),
]
_PLAN_PARTIAL = [
	("{done} of {total} greenhouses done", "{done} of {total} greenhouses done this week, {left} to go. You are on your way."),
	("{done} of {total} greenhouses done", "This week's plan: {done} of {total} complete and {left} still to do. A little each day gets it there."),
]
_PLAN_ALL = [
	("This week's plan is complete", "All {total} greenhouses on your plan are done this week. Thank you."),
	("This week's plan is complete", "You have covered every greenhouse planned for you this week. Well done."),
]
_PLAN_NONE = [
	("{total} greenhouses planned this week", "Your plan this week has {total} greenhouses and none are done yet. Today is a good day to begin."),
	("{total} greenhouses planned this week", "{total} greenhouses are waiting on your plan this week. Start when you are ready."),
]
_AHEAD = [
	("Ahead of last week", "You have recorded {week} so far this week, against {last} at this point last week. Good progress."),
	("Ahead of last week", "{week} so far this week, up from {last} by the same day last week. Keep it up."),
]
_STEADY = [
	("Thank you for your scouting", "{week} recorded so far this week. Careful rounds are how problems are caught early."),
	("Thank you for your scouting", "You have {week} this week so far. Every round you walk protects the crop."),
]
_GENERAL = [
	("Thank you for your scouting", "A new week of rounds. What you record in the houses guides every decision about the crop."),
	("Thank you for your scouting", "Every round you walk helps the team catch problems early. Thank you."),
]


def _stats_out(s: dict) -> dict:
	keys = ("entries_week", "plan_done", "plan_total", "lifetime", "streak")
	return {k: s.get(k) for k in keys if s.get(k) is not None}


def choose(stats: dict, today, user: str) -> dict:
	"""``{kind, title, message, stats}``; kind None when there is nothing to say.

	``stats`` keys (all optional): first_name, date_of_birth, lifetime,
	entries_last7, streak, streak_end, plan_total, plan_done, entries_week,
	entries_last_week_same_span, entries_recent (any activity in the last month).
	"""
	s = dict(stats or {})
	name = s.get("first_name") or "there"

	def out(kind, tpl, **kw):
		title, message = _pick(tpl, user, today, kind)
		return {"kind": kind, "title": title.format(name=name, **kw), "message": message.format(name=name, **kw),
				"stats": _stats_out(s)}

	if is_birthday(s.get("date_of_birth"), today):
		return out("birthday", _BIRTHDAY)

	if s.get("lifetime"):
		m = crossed_entry_milestone(int(s["lifetime"]), int(s.get("entries_last7") or 0))
		if m:
			return out("milestone", _ENTRIES, n=f"{m:,}")
	sm = streak_milestone(int(s.get("streak") or 0), s.get("streak_end"), today)
	if sm:
		return out("milestone", _STREAK, n=sm)

	total, done = int(s.get("plan_total") or 0), int(s.get("plan_done") or 0)
	if total:
		if done >= total:
			return out("encouragement", _PLAN_ALL, total=total)
		if done:
			return out("encouragement", _PLAN_PARTIAL, done=done, total=total, left=_word(total - done))
		return out("encouragement", _PLAN_NONE, total=total)
	week, last = int(s.get("entries_week") or 0), int(s.get("entries_last_week_same_span") or 0)
	if week and last and week > last:
		return out("encouragement", _AHEAD, week=_entries(week), last=_entries(last))
	if week:
		return out("encouragement", _STEADY, week=_entries(week))
	if s.get("entries_recent"):
		return out("encouragement", _GENERAL)
	return {"kind": None, "title": "", "message": "", "stats": {}}
