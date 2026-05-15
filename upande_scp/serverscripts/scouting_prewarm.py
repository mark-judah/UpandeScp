"""Daily background job that builds the current ISO week + previous 4 into
the scouting payload cache so the first user of the day always hits warm
keys. Idempotent — re-running it is a no-op when entries are already cached.
"""

import datetime

import frappe

from upande_scp.serverscripts.get_complete_scouting_entries import (
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
