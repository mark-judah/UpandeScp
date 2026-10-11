"""The weekly scout plan's rules — pure, so they are tested without a database.

A plan is a set of assignments ``{date, scout, greenhouse}`` for one farm's week
(Monday–Sunday). These functions answer:

* ``assignment_status`` — Planned / Done / Missed for one assignment, given whether
  the scout logged entries in that house that day (spec C6).
* ``weekly_check`` — the week's warnings (C5): houses nobody is planned for, each
  scout's planned house-days against the farm median, and a scout planned on two
  farms the same day. Warnings only; nothing here refuses.
* ``unplanned_actuals`` — scouting that happened with no assignment behind it.
* ``copy_week`` — last week's rows moved seven days on (the "Copy last week" bulk
  action and the real run's "actuals → plan").
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

PLANNED, DONE, MISSED = "Planned", "Done", "Missed"
#: A scout whose planned house-days differ from the farm median by more than this
#: share of the median is flagged high / low.
LOAD_TOLERANCE = 0.5


def as_date(value) -> date | None:
	if value is None or value == "":
		return None
	if isinstance(value, datetime):
		return value.date()
	if isinstance(value, date):
		return value
	return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()


def monday_of(value) -> date:
	d = as_date(value)
	return d - timedelta(days=d.weekday())


def week_days(week_start) -> list[date]:
	monday = monday_of(week_start)
	return [monday + timedelta(days=i) for i in range(7)]


def assignment_status(day, today, done: bool) -> str:
	"""Done as soon as the entries exist; Missed only once the day is over."""
	if done:
		return DONE
	return MISSED if as_date(day) < as_date(today) else PLANNED


def _median(values: list[float]) -> float:
	vals = sorted(values)
	if not vals:
		return 0.0
	mid = len(vals) // 2
	return float(vals[mid]) if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2


def _key(row: dict) -> tuple[str, str, str]:
	return (str(as_date(row["date"])), row["scout"], row["greenhouse"])


def weekly_check(houses, assignments, elsewhere=(), farm: str | None = None) -> dict:
	"""The week's warnings.

	``houses``      — the farm's greenhouses / blocks.
	``assignments`` — this farm's week, ``{date, scout, greenhouse}``.
	``elsewhere``   — the same scouts' assignments on other farms that week,
	                  ``{date, scout, farm}``.
	"""
	planned_houses = {a["greenhouse"] for a in assignments}
	unplanned = [h for h in houses if h not in planned_houses]

	house_days: dict[str, set] = {}
	for a in assignments:
		house_days.setdefault(a["scout"], set()).add((str(as_date(a["date"])), a["greenhouse"]))
	counts = {s: len(v) for s, v in house_days.items()}
	median = _median(list(counts.values()))
	load = []
	for scout, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
		flag = None
		if median > 0 and abs(n - median) > LOAD_TOLERANCE * median:
			flag = "high" if n > median else "low"
		load.append({"scout": scout, "houseDays": n, "diff": round(n - median, 1), "flag": flag})

	here_days = {(a["scout"], str(as_date(a["date"]))) for a in assignments}
	clash: dict[tuple[str, str], set] = {}
	for e in elsewhere or ():
		k = (e["scout"], str(as_date(e["date"])))
		if k in here_days and e.get("farm") and e.get("farm") != farm:
			clash.setdefault(k, set()).add(e["farm"])
	conflicts = [
		{"scout": s, "date": d, "farms": sorted(({farm} if farm else set()) | farms)}
		for (s, d), farms in sorted(clash.items(), key=lambda kv: (kv[0][1], kv[0][0]))
	]
	return {"unplanned": unplanned, "median": median, "load": load, "conflicts": conflicts}


def unplanned_actuals(actuals, assignments) -> list[dict]:
	"""``actuals`` rows ``{date, scout, greenhouse, entries}`` with no assignment."""
	planned = {_key(a) for a in assignments}
	return [a for a in actuals if _key(a) not in planned]


def copy_week(rows, days: int = 7) -> list[dict]:
	"""Rows moved ``days`` on, deduplicated on (date, scout, greenhouse)."""
	out: dict[tuple, dict] = {}
	for r in rows:
		moved = {"date": str(as_date(r["date"]) + timedelta(days=days)),
				 "scout": r["scout"], "greenhouse": r["greenhouse"]}
		if r.get("notes"):
			moved["notes"] = r["notes"]
		out.setdefault(_key(moved), moved)
	return list(out.values())
