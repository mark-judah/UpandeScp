"""Daily background job that builds the current ISO week + previous 4 into
the scouting payload cache so the first user of the day always hits warm
keys. Idempotent — re-running it is a no-op when entries are already cached.
"""

import datetime

import frappe

from upande_scp.serverscripts.scouting.get_complete_scouting_entries import (
    _fetch_week_entries,
    _iso_year_week,
)


PREWARM_WEEKS = 5  # current + 4 previous


def _today():
    """Indirection so tests can pin a deterministic date."""
    return datetime.date.today()


def _recent_weeks():
    today = _today()
    out = []
    for offset in range(PREWARM_WEEKS):
        d = today - datetime.timedelta(days=7 * offset)
        out.append(_iso_year_week(d))
    return sorted(set(out))


def daily_prewarm():
    """Frappe scheduler entry point. Builds the cache for recent weeks."""
    for (iy, iw) in _recent_weeks():
        try:
            _fetch_week_entries(iy, iw)
        except Exception:
            frappe.log_error(
                f"daily_prewarm failed for {iy}-W{iw:02d}", "SCP prewarm",
            )


def hourly_prewarm():
    """Keep the most-viewed weeks hot ALL DAY.

    The per-week payload cache has a 1-hour TTL, and a write busts the week it
    touches — so over the day the current ISO week repeatedly falls cold and the
    next map open pays a full-week SQL rebuild. The map pages now view at most
    one week at a time, so re-warming the current + previous ISO week every hour
    means a user almost always lands on a warm key. Idempotent — if the week is
    still cached, ``_fetch_week_entries`` is a no-op Redis read.
    """
    today = _today()
    weeks = sorted(
        {
            _iso_year_week(today),
            _iso_year_week(today - datetime.timedelta(days=7)),
        }
    )
    for (iy, iw) in weeks:
        try:
            _fetch_week_entries(iy, iw)
        except Exception:
            frappe.log_error(
                f"hourly_prewarm failed for {iy}-W{iw:02d}", "SCP prewarm",
            )
