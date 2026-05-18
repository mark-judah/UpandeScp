"""Server-side aggregation endpoints for the /scp_app Dashboard.

Each whitelisted entry point delegates to a private module that does the
actual SQL and aggregation work.
"""

import frappe

from upande_scp.serverscripts.dashboard_aggregates._overview        import overview as _overview
from upande_scp.serverscripts.dashboard_aggregates._pests_diseases  import pests    as _pests
from upande_scp.serverscripts.dashboard_aggregates._pests_diseases  import diseases as _diseases
from upande_scp.serverscripts.dashboard_aggregates._traps           import traps    as _traps
from upande_scp.serverscripts.dashboard_aggregates._fcm             import fcm      as _fcm
from upande_scp.serverscripts.dashboard_aggregates._gh_detail       import (
    greenhouse_detail as _gh_detail,
)
from upande_scp.serverscripts.dashboard_aggregates._heatmap_poc     import (
    heatmap_poc as _heatmap_poc,
)
from upande_scp.serverscripts.dashboard_aggregates._heatmaps        import (
    heatmaps_grid as _heatmaps_grid,
)


def _truthy(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "y")


def _call(impl, **kwargs):
    """Common entry: read force flag, drop it, delegate to the impl."""
    force = _truthy(kwargs.pop("force", "")) if "force" in kwargs else False
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
def fcm(**kwargs):
    return _call(_fcm, **kwargs)


@frappe.whitelist()
def greenhouse_detail(**kwargs):
    return _call(_gh_detail, **kwargs)


@frappe.whitelist()
def heatmap_poc(**kwargs):
    return _call(_heatmap_poc, **kwargs)


@frappe.whitelist()
def heatmaps_grid(**kwargs):
    return _call(_heatmaps_grid, **kwargs)
