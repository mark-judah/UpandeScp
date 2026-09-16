"""Keep the dashboard aggregate cache warm, so no operator pays the cold path.

The aggregates have been Redis-cached and shared across users since the cache
key carries no user id — one build serves everybody. Nothing ever *warmed* them
though: ``scouting_prewarm`` warms the scouting week payloads, which are a
different cache. So the first person after every invalidation rebuilt them by
hand, in the foreground, while looking at empty KPI cards.

Measured on kaitetv16 in a real browser, ``/scp_app#/rose/dashboard``:

    overview lands, warm cache      2,555 ms   (9 api calls)
    overview lands, cold cache     16,178 ms   (37 api calls — 28 are progress polls)

Invalidation is a global version stamp bumped at most once per
``DASH_AGG_BUMP_DEBOUNCE``. This job runs more often than that window, so the
first run after a bump rebuilds and every later run is a plain Redis read —
``cached_aggregate`` returns the cached payload untouched when the key is
present. Idempotent by construction; no force flag is ever passed.

Scope is deliberately the *default view only* — the filters the app sends when
a dashboard or trends page is opened with nothing selected, captured from the
live frontend:

    {"from_date": <today-30d>, "to_date": <today>, "crop": <c>,
     "farm": "", "greenhouse": ""}

Those are the keys that are hit on cold open. Warming every farm and greenhouse
combination would be a large amount of background work for keys nobody asks
for, and the per-greenhouse path is already fast once the indexes exist.
"""

import datetime

import frappe

from upande_scp.serverscripts.dashboard_aggregates._overview import overview as _overview
from upande_scp.serverscripts.dashboard_aggregates._trends import trends as _trends


# The window the frontend opens with: the last 30 days, ending today.
DEFAULT_WINDOW_DAYS = 30

# (label, impl) pairs. Both are landing pages — Dashboards calls ``overview``
# and Trends calls ``trends`` on mount. The other endpoints (pests, diseases,
# traps, heatmaps_grid) load on a tab click rather than on open; heatmaps_grid
# in particular costs ~11.6s and 6.2 MB to build, which is not worth spending
# every cycle for a tab that may never be opened.
ENDPOINTS = (
    ("overview", _overview),
    ("trends", _trends),
)


def _today():
    """Indirection so tests can pin a deterministic date."""
    return datetime.date.today()


def _default_window():
    today = _today()
    start = today - datetime.timedelta(days=DEFAULT_WINDOW_DAYS)
    return start.isoformat(), today.isoformat()


def _crops():
    """Every crop the app can scope to, plus the unscoped view.

    "" is the all-crops view that Trends opens with; each named crop is what a
    crop-namespaced dashboard sends. Falls back to the unscoped view alone if
    the doctype cannot be read, so a broken master never fails the job.
    """
    crops = [""]
    try:
        crops.extend(
            sorted(r.name for r in frappe.get_all("Crop Scouted", fields=["name"]))
        )
    except Exception:
        frappe.log_error("prewarm: could not read Crop Scouted", "SCP dash prewarm")
    return crops


def prewarm_dashboard_aggregates():
    """Frappe scheduler entry point.

    Runs every 10 minutes (see hooks.py) — more often than the invalidation
    debounce, so a bumped stamp is re-warmed well before the next operator
    arrives. Each endpoint is guarded separately: one failing crop must not
    stop the rest from warming.
    """
    from_date, to_date = _default_window()
    warmed, failed = 0, 0

    for crop in _crops():
        args = {
            "from_date": from_date,
            "to_date": to_date,
            "crop": crop,
            "farm": "",
            "greenhouse": "",
        }
        for label, impl in ENDPOINTS:
            try:
                impl(dict(args), force=False)
                warmed += 1
            except Exception:
                failed += 1
                frappe.log_error(
                    f"prewarm {label} failed for crop={crop or '(all)'} "
                    f"{from_date}..{to_date}",
                    "SCP dash prewarm",
                )

    return {"warmed": warmed, "failed": failed, "from": from_date, "to": to_date}
