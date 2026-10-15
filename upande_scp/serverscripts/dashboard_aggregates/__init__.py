"""Server-side aggregation endpoints for the /scp_app Dashboard.

Each whitelisted entry point delegates to a private module that does the
actual SQL and aggregation work.
"""

import frappe

from upande_scp.serverscripts.common import crop_catalog

from upande_scp.serverscripts.dashboard_aggregates._overview        import overview as _overview
from upande_scp.serverscripts.dashboard_aggregates._pests_diseases  import pests    as _pests
from upande_scp.serverscripts.dashboard_aggregates._pests_diseases  import diseases as _diseases
from upande_scp.serverscripts.dashboard_aggregates._traps           import traps    as _traps
from upande_scp.serverscripts.dashboard_aggregates._kpi_series import (
    kpi_series as _kpi_series,
)
from upande_scp.serverscripts.dashboard_aggregates._gh_detail       import (
    greenhouse_detail as _gh_detail,
)
from upande_scp.serverscripts.dashboard_aggregates._heatmap_poc     import (
    heatmap_poc as _heatmap_poc,
)
from upande_scp.serverscripts.dashboard_aggregates._heatmaps        import (
    heatmaps_grid as _heatmaps_grid,
)
from upande_scp.serverscripts.dashboard_aggregates._heatmaps import (
    heatmap_card_detail as _heatmap_card_detail,
    heatmap_terrain as _heatmap_terrain,
)
from upande_scp.serverscripts.dashboard_aggregates._heatmap_interventions import (
    heatmap_interventions as _heatmap_interventions,
)
from upande_scp.serverscripts.dashboard_aggregates._application_plan import (
    application_plan_diagnose as _application_plan_diagnose,
)
from upande_scp.serverscripts.dashboard_aggregates._trends import (
    trends as _trends,
)
from upande_scp.serverscripts.dashboard_aggregates._quality import (
    quality as _quality,
)
from upande_scp.serverscripts.dashboard_aggregates._gallery import (
    observation_gallery as _observation_gallery,
)
from upande_scp.serverscripts.dashboard_aggregates._photo_feed import (
    photo_feed as _photo_feed_impl,
)


def _truthy(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "y")


def _call(impl, **kwargs):
    """Common entry: read force flag, drop it, resolve the crop, delegate.

    The crop is canonicalised and access-checked here, once, so every aggregate's
    cache key holds `Rose` (never `rose`) and a user can never ask for a crop
    they may not see.
    """
    force = _truthy(kwargs.pop("force", "")) if "force" in kwargs else False
    if "crop" in kwargs:
        kwargs["crop"] = crop_catalog.resolve_crop(kwargs.get("crop"))
    return impl(kwargs, force=force)


@frappe.whitelist()
def overview(**kwargs):
    return _call(_overview, **kwargs)


@frappe.whitelist()
def pests(**kwargs):
    return _call(_pests, **kwargs)


@frappe.whitelist()
def diseases(**kwargs):
    return _call(_diseases, **kwargs)


@frappe.whitelist()
def traps(**kwargs):
    return _call(_traps, **kwargs)


@frappe.whitelist()
def kpi_series(**kwargs):
    return _call(_kpi_series, **kwargs)


@frappe.whitelist()
def greenhouse_detail(**kwargs):
    return _call(_gh_detail, **kwargs)


@frappe.whitelist()
def heatmap_poc(**kwargs):
    return _call(_heatmap_poc, **kwargs)


@frappe.whitelist()
def heatmaps_grid(**kwargs):
    return _call(_heatmaps_grid, **kwargs)


@frappe.whitelist()
def heatmap_card_detail(**kwargs):
    return _call(_heatmap_card_detail, **kwargs)


@frappe.whitelist()
def heatmap_terrain(**kwargs):
    return _call(_heatmap_terrain, **kwargs)


@frappe.whitelist()
def heatmap_interventions(**kwargs):
    return _call(_heatmap_interventions, **kwargs)


@frappe.whitelist()
def application_plan_diagnose(**kwargs):
    return _call(_application_plan_diagnose, **kwargs)


@frappe.whitelist()
def trends(**kwargs):
    return _call(_trends, **kwargs)


@frappe.whitelist()
def quality(**kwargs):
    """Coverage report: names scouts and their flags, so it is gated like the
    Scouts page — role first, then the user's own farms (and a named
    greenhouse must sit on one of them). The cache key is built from these
    already-checked filters, so one user's payload is never widened for another."""
    from upande_scp.serverscripts.scouting import scouting_metrics
    from upande_scp.serverscripts.scouts import api as scouts_api

    scouts_api._assert_role()
    crop = crop_catalog.resolve_crop(kwargs.get("crop")) if kwargs.get("crop") else None
    farms_map = scouting_metrics.get_farms_and_warehouses() or {}
    fs = scouts_api.farm_scope(crop, kwargs.get("farm"), farms_map)
    kwargs["farm"] = fs["farm"]
    greenhouse = (kwargs.get("greenhouse") or "").strip()
    if greenhouse:
        allowed = {w for f in fs["farms"] for w in (farms_map.get(f) or [])}
        if greenhouse not in allowed:
            frappe.throw(f"You cannot see greenhouse {greenhouse}.", frappe.PermissionError)
    # _call's force / crop handling, inline so the farms map read above is
    # passed on rather than read a second time.
    force = _truthy(kwargs.pop("force", "")) if "force" in kwargs else False
    if "crop" in kwargs:
        kwargs["crop"] = crop_catalog.resolve_crop(kwargs.get("crop"))
    return _quality(kwargs, force=force, farms_map=farms_map)


@frappe.whitelist()
def observation_gallery(**kwargs):
    return _call(_observation_gallery, **kwargs)


@frappe.whitelist()
def photo_feed(**kwargs):
    return _call(_photo_feed_impl, **kwargs)
