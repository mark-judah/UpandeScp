"""Cumulative per-hectare scouting figures for block-grown crops — the pure rules.

An orchard block is too large to scout in one pass. A scouting *round* is the
window over which a block's scouting is added up (one ISO week by default, set
by ``scouting_round_days``), and the figure a block is judged on is

    cumulative count of a pest over the round  /  block area in hectares

— never "per tree": the trees walked on any one day are a sample of the block,
so a per-tree average moves with how many trees the scout happened to reach.

No frappe import: runs under plain pytest.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta

DEFAULT_ROUND_DAYS = 7
MAX_ROUND_DAYS = 60
#: A Monday. Rounds of N days tile the calendar from here, so a 7-day round is
#: exactly the ISO week (Mon-Sun) and any other length is stable across years.
ROUND_ANCHOR = date(2026, 1, 5)

PEST = "pest"
DISEASE = "disease"


def as_date(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()


def clean_round_days(value) -> int:
    """The round length in days: a positive whole number up to ``MAX_ROUND_DAYS``;
    blank, zero, negative or junk means the default week."""
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return DEFAULT_ROUND_DAYS
    return n if 1 <= n <= MAX_ROUND_DAYS else DEFAULT_ROUND_DAYS


def round_bounds(day, round_days=DEFAULT_ROUND_DAYS) -> tuple[date, date]:
    """``(start, end)`` inclusive of the round holding ``day``."""
    n = clean_round_days(round_days)
    d = as_date(day)
    start = ROUND_ANCHOR + timedelta(days=((d - ROUND_ANCHOR).days // n) * n)
    return start, start + timedelta(days=n - 1)


def per_ha(total, area_ha):
    """``total`` over hectares, 2 dp; ``None`` without a usable area — dividing
    by a missing denominator would invent a figure."""
    try:
        area = float(area_ha or 0)
    except (TypeError, ValueError):
        return None
    if area <= 0:
        return None
    return round(float(total or 0) / area, 2)


def daily_series(rows) -> list[dict]:
    """``rows`` — ``{"date", "count"}`` (any number per day) — as the day-by-day
    series, oldest first: ``[{"date", "count", "running"}]``. One entry per
    scouting day that recorded the observation."""
    by_day: dict = {}
    for r in rows:
        d = as_date(r["date"])
        by_day[d] = by_day.get(d, 0.0) + float(r.get("count") or 0)
    out, running = [], 0.0
    for d in sorted(by_day):
        running += by_day[d]
        out.append({"date": d, "count": by_day[d], "running": running})
    return out


def crossing_day(series, area_ha, threshold):
    """The first scouting day on which the running per-ha figure reached
    ``threshold`` (inclusive, like the band rules), else ``None``."""
    if not threshold or float(threshold) <= 0:
        return None
    for s in series:
        v = per_ha(s["running"], area_ha)
        if v is not None and v >= float(threshold):
            return s["date"]
    return None


def should_alert(per_ha_value, threshold, already_alerted) -> bool:
    """One alert per block x observation x round: the figure is at or over a
    configured threshold and this round has not been alerted yet."""
    if already_alerted or per_ha_value is None:
        return False
    try:
        return float(threshold or 0) > 0 and float(per_ha_value) >= float(threshold)
    except (TypeError, ValueError):
        return False


def alert_key(block, kind, observation, round_start) -> str:
    """The dedupe record's name: stable for one block x observation x round."""
    raw = "|".join([block or "", kind or "", observation or "", str(as_date(round_start))])
    return f"CPA-{as_date(round_start):%Y%m%d}-{hashlib.sha1(raw.encode()).hexdigest()[:10]}"


def fmt_count(value) -> str:
    """``2`` for 2.0, ``2.5`` for 2.5."""
    v = float(value or 0)
    return str(int(v)) if v == int(v) else f"{v:.1f}"


def fmt_per_ha(value) -> str:
    """One decimal from 10 up, two below: 12.4, 0.46 (a block of several
    hectares with a handful of pests lives in the fractions)."""
    if value is None:
        return "—"
    v = round(float(value), 2)
    return f"{v:.1f}" if abs(v) >= 10 else f"{v:.2f}"
