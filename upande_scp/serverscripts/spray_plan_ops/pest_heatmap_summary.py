"""What the GM needs beside a pest's heatmap: the figure, its trend, its bands.

Serves ``PestHeatmapModal``. The map itself comes from the existing
``heatmap_card_detail`` aggregate; this adds the station-prevalence summary for
ONE (greenhouse, pest or disease) over the last N scouted weeks, and the
threshold band that figure is judged against (the same ``band_spec`` /
``house_value`` the dashboard alerts use), so the modal can never disagree with
the alert that sent the GM here.
"""

import frappe
from frappe.utils import add_days, getdate, today

from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows
from upande_scp.serverscripts.dashboard_aggregates._common import band_spec

MAX_WEEKS = 8


def _band_json(spec):
    if not spec:
        return None
    return {"low": spec["low"], "moderate": spec["mod"], "high": spec["high"], "measure": spec["measure"]}


def build(greenhouse, obs_name, obs_kind, crop, from_date, to_date) -> dict:
    weeks = _prevalence_rows.StationWeeks.load(
        from_date, to_date, crop, [greenhouse], lookback_days=0, weeks=_prevalence_rows.WINDOW,
    )
    spec = band_spec(crop, obs_kind, obs_name, "")
    count = bool(spec and spec["measure"] == B.COUNT)
    series = []
    for wk in weeks.weeks(greenhouse):
        fig = weeks.figures(greenhouse, wk, obs_kind, obs_name)
        if not fig:
            continue
        value = fig.get("prevalence")
        if count:
            cfig = weeks.count_figures(
                greenhouse, wk, obs_kind, obs_name,
                stages=spec["count_stages"], weights=spec.get("count_weights"),
            )
            value = cfig["value"] if cfig else None
        series.append({
            "week": wk,
            "value": value,
            "prevalence": fig.get("prevalence"),
            "reliability": fig.get("reliability"),
            "band": (B.band_of(value, spec["low"], spec["mod"], spec["high"]) or None) if spec and value is not None else None,
        })
    latest = series[-1] if series else None
    latest_fig = weeks.figures(greenhouse, latest["week"], obs_kind, obs_name) if latest else None
    return {
        "greenhouse": greenhouse,
        "obsName": obs_name,
        "obsKind": obs_kind,
        "from_date": from_date,
        "to_date": to_date,
        "measure": B.COUNT if count else B.PERCENTAGE,
        "threshold": _band_json(spec),
        "latest": ({**P.public(latest_fig), "value": latest["value"], "band": latest["band"]} if latest_fig else None),
        "series": series,
    }


def resolve_kind(obs_name: str) -> str:
    """A spray plan's targets are bare names; say which master holds this one."""
    if frappe.db.exists("Pest", obs_name):
        return "pest"
    if frappe.db.exists("Plant Disease", obs_name):
        return "disease"
    return "pest"


@frappe.whitelist()
def get_pest_heatmap_summary(greenhouse=None, obs_name=None, obs_kind="pest", crop=None, weeks=2, to_date=None):
    greenhouse = (greenhouse or "").strip()
    obs_name = (obs_name or "").strip()
    if obs_kind not in ("pest", "disease"):
        obs_kind = resolve_kind(obs_name)
    if not greenhouse or not obs_name:
        return {"series": [], "latest": None, "threshold": None}
    n = max(1, min(int(weeks or 2), MAX_WEEKS))
    to_date = str(getdate(to_date or today()))
    # Whole ISO weeks, like the heatmap's own default range.
    from_date = str(add_days(to_date, -(7 * n) + 1))
    return build(greenhouse, obs_name, obs_kind, crop_catalog.resolve_crop(crop), from_date, to_date)
