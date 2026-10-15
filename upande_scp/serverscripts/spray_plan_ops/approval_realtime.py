"""Live updates for the Spray Plan Approvals page.

An Application Floor Plan Work Order that is created, submitted or changes
``workflow_state`` publishes ``scp:spray_plan`` (Frappe realtime / socket.io) to
the users who can approve plans for its greenhouse. The page listens, filters by
the date it is showing, and re-reads the list.

Realtime is an optimisation, never the source of truth: the page also polls and
refreshes on focus, and the event carries no plan content beyond identifiers, so a
missed or duplicate event costs nothing. Publishing must never break a save, so
every failure here is swallowed and logged.
"""

import frappe

from upande_scp.serverscripts.common import crop_scope, farm_map
from upande_scp.serverscripts.spray_plan_ops import spray_plan_approval as approval

EVENT = "scp:spray_plan"
AFP_TYPE = approval.AFP_TYPE


def _day(value) -> str:
    return str(value)[:10] if value else ""


def payload_for(doc, change: str) -> dict:
    """The event body: which plan, what happened, which date/farm/greenhouse."""
    gh = doc.get("custom_greenhouse") or ""
    return {
        "change": change,                      # created | submitted | state_changed
        "name": doc.name,
        "workflow_state": doc.get("workflow_state") or "",
        # The two dates the page can filter on.
        "date": _day(doc.get("custom_scheduled_application_time") or doc.get("planned_start_date")),
        "created": _day(doc.get("creation")),
        "farm": farm_map.farm_for_warehouse(gh) or "",
        "greenhouse": gh,
    }


def recipients(greenhouse: str) -> list[str]:
    """Enabled approvers whose farm scope includes ``greenhouse``."""
    users = set(
        frappe.get_all(
            "Has Role",
            filters={"role": ["in", list(approval.APPROVAL_ROLES)], "parenttype": "User"},
            pluck="parent",
            limit_page_length=0,
        )
    )
    users.discard("Guest")
    out = []
    for user in sorted(users):
        if not frappe.db.get_value("User", user, "enabled"):
            continue
        limits = [approval._approver_allowed_greenhouses(user), crop_scope.scoped_greenhouses(None, user)]
        if any(lim is not None and greenhouse and greenhouse not in lim for lim in limits):
            continue
        out.append(user)
    return out


def _publish(doc, change: str) -> None:
    try:
        if doc.get("custom_type") != AFP_TYPE:
            return
        body = payload_for(doc, change)
        for user in recipients(body["greenhouse"]):
            frappe.publish_realtime(EVENT, body, user=user, after_commit=True)
    except Exception:
        frappe.log_error(title="Spray plan realtime publish failed")


def after_insert(doc, method=None):
    _publish(doc, "created")


def on_submit(doc, method=None):
    _publish(doc, "submitted")


def on_update(doc, method=None):
    # A save that does not move the workflow is not news to the approvals desk.
    if doc.flags.in_insert or not doc.has_value_changed("workflow_state"):
        return
    _publish(doc, "state_changed")
