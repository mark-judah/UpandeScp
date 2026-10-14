"""Chemical exposure rules — pure, no frappe.

An exposure row is "this person was near this product for this long". Two
questions decide its weight, and both are answered here so they can be tested
without a database:

* **how long** (`resolve_duration`) — the application's own clock, tried in a
  fixed order of trust (spec S5);
* **how hazardous** (`hazard_weight`) — the product's WHO toxicity class
  (spec S6).

weighted_hours = hours × hazard weight.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

#: WHO-style toxicity class → weight. Class I is the most hazardous.
HAZARD_WEIGHTS = {"I": 4, "II": 3, "III": 2, "IV": 1}

#: Weight used when a product carries no class. Middling on purpose: an unknown
#: hazard must not read as harmless, nor as the worst case.
UNKNOWN_HAZARD_WEIGHT = 2

#: Longer than this is a clock left running, not a spray session.
MAX_HOURS = 12

FLAG_NO_DURATION = "no duration"
FLAG_HAZARD_UNKNOWN = "hazard unknown"
FLAG_CAPPED = "over 12 h"
FLAG_TIMES_REVERSED = "times reversed"

SOURCE_CUSTOM = "custom datetimes"
SOURCE_TIMES = "date + times"
SOURCE_SESSION = "movement session"


def normalise_toxicity(value) -> str | None:
	"""'II', ' ii ', 'Class II', 'WHO II' → 'II'; anything else → None."""
	if not value:
		return None
	text = str(value).strip().upper()
	for prefix in ("WHO", "CLASS"):
		if text.startswith(prefix):
			text = text[len(prefix):].strip(" :-")
	return text if text in HAZARD_WEIGHTS else None


def hazard_weight(toxicity) -> tuple[int, bool]:
	"""(weight, known). Unknown class → (UNKNOWN_HAZARD_WEIGHT, False)."""
	cls = normalise_toxicity(toxicity)
	if cls is None:
		return UNKNOWN_HAZARD_WEIGHT, False
	return HAZARD_WEIGHTS[cls], True


def _as_time(value) -> time | None:
	"""A Frappe Time comes back as timedelta from the DB, str from a doc."""
	if value is None or value == "":
		return None
	if isinstance(value, time):
		return value
	if isinstance(value, timedelta):
		secs = int(value.total_seconds()) % 86400
		return time(secs // 3600, (secs % 3600) // 60, secs % 60)
	text = str(value).split(".")[0]
	parts = [int(p) for p in text.split(":")]
	while len(parts) < 3:
		parts.append(0)
	return time(parts[0] % 24, parts[1], parts[2])


def _as_date(value) -> date | None:
	if not value:
		return None
	if isinstance(value, datetime):
		return value.date()
	if isinstance(value, date):
		return value
	return date.fromisoformat(str(value)[:10])


def _as_datetime(value) -> datetime | None:
	if not value:
		return None
	if isinstance(value, datetime):
		return value
	return datetime.fromisoformat(str(value).split(".")[0])


def _span(start: datetime | None, end: datetime | None):
	"""A usable (start, end) pair, or None. A zero or negative span is no time."""
	if start and end and end > start:
		return start, end
	return None


def resolve_duration(
	*,
	custom_start=None,
	custom_stop=None,
	on_date=None,
	start_time=None,
	stop_time=None,
	sessions=(),
) -> dict:
	"""The application's duration, by the first source that gives one.

	1. ``custom_start``/``custom_stop`` — full datetimes;
	2. ``on_date`` + ``start_time``/``stop_time`` — a stop before the start is
	   a typing slip (nobody sprays overnight), so these times are skipped and
	   flagged "times reversed";
	3. ``sessions`` — (started_at, ended_at) pairs from the work order's
	   Sprayer Movement Sessions, earliest start to latest end.

	Returns {started_at, ended_at, hours, source, flags}. No source → hours 0
	and the "no duration" flag. Over MAX_HOURS → capped and flagged.
	"""
	span, source, flags = None, None, []

	span = _span(_as_datetime(custom_start), _as_datetime(custom_stop))
	if span:
		source = SOURCE_CUSTOM

	if not span:
		d, t0, t1 = _as_date(on_date), _as_time(start_time), _as_time(stop_time)
		if d and t0 and t1 and t0 != t1:
			start = datetime.combine(d, t0)
			end = datetime.combine(d, t1)
			if end < start:
				flags.append(FLAG_TIMES_REVERSED)
			span = _span(start, end)
			if span:
				source = SOURCE_TIMES

	if not span:
		pairs = [
			(_as_datetime(s), _as_datetime(e))
			for s, e in (sessions or ())
		]
		pairs = [(s, e) for s, e in pairs if s and e and e > s]
		if pairs:
			span = (min(s for s, _ in pairs), max(e for _, e in pairs))
			source = SOURCE_SESSION
			# Sessions may sit on different days: count the time in them,
			# not the gap between the first start and the last end.
			# Overlapping sessions (two crew phones) are merged, not added twice.
			merged = []
			for s, e in sorted(pairs):
				if merged and s <= merged[-1][1]:
					merged[-1][1] = max(merged[-1][1], e)
				else:
					merged.append([s, e])
			session_hours = sum((e - s).total_seconds() for s, e in merged) / 3600.0

	if not span:
		return {
			"started_at": None,
			"ended_at": None,
			"hours": 0.0,
			"source": None,
			"flags": flags + [FLAG_NO_DURATION],
		}

	start, end = span
	hours = (end - start).total_seconds() / 3600.0
	if source == SOURCE_SESSION:
		hours = session_hours
	if hours > MAX_HOURS:
		hours = float(MAX_HOURS)
		flags.append(FLAG_CAPPED)
	return {
		"started_at": start,
		"ended_at": end,
		"hours": round(hours, 4),
		"source": source,
		"flags": flags,
	}


#: When one person holds several places on a logsheet, the most exposed wins.
ROLE_PRECEDENCE = ("Sprayer", "Mixer", "Supervisor")


def participants(applicators, mixers, supervisor) -> dict:
	"""{employee: {"role", "ppe_condition"}} — everyone named on a logsheet.

	``applicators`` is [(employee, ppe_condition)], ``mixers`` a list of
	employees, ``supervisor`` one employee (or None). One entry per person.
	"""
	out: dict = {}

	def put(emp, role, ppe=None):
		if not emp:
			return
		cur = out.get(emp)
		if cur is None or ROLE_PRECEDENCE.index(role) < ROLE_PRECEDENCE.index(cur["role"]):
			out[emp] = {"role": role, "ppe_condition": ppe or (cur or {}).get("ppe_condition")}
		elif ppe and not cur.get("ppe_condition"):
			cur["ppe_condition"] = ppe

	for emp, ppe in applicators or ():
		put(emp, "Sprayer", ppe)
	for emp in mixers or ():
		put(emp, "Mixer")
	put(supervisor, "Supervisor")
	return out


def match_team_farm(team_name: str, farms) -> str | None:
	"""The farm a team belongs to, by the farm name inside its name.

	The bootstrap rule (spec S10): "CHEPSITO CSU 1" is Chepsito's. When several
	farm names occur ("SIMOTWO CSU 1" contains both SIMO and Simotwo) the
	longest wins — it is the more specific one.
	"""
	name = (team_name or "").lower()
	hits = [f for f in farms or () if f and f.lower() in name]
	if not hits:
		return None
	hits.sort(key=lambda f: (-len(f), f))
	return hits[0]
