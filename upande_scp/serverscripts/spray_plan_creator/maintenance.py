"""Scheduled maintenance for the Application Floor Plan spray flow.

``auto_cancel_dormant_plans`` runs daily (wired in hooks.py) and stops AFP
Work Orders that were **submitted for approval but never approved** for more
than N days since creation. The clock starts at creation (per design)
regardless of intervening edits — a submitted-but-unapproved plan older than
the window is considered abandoned and gets ERPNext-Stopped (the same terminal
state an approver's manual "Stop" produces; reversible via un-stop).

The GM controls the job from the Spray Plan Settings page:
  * ``auto_cancel_enabled`` — master on/off. When OFF the job is a no-op.
  * ``auto_cancel_apply_to_backlog`` — when OFF, only plans created after
    auto-cancel was first enabled (``auto_cancel_activated_on``) are eligible,
    so the rule applies going forward rather than mass-stopping the historical
    backlog. When ON, every existing dormant plan is eligible too.
  * ``auto_cancel_dormant_days`` — the window (default 3).

Scope is deliberately narrow for safety:
  * Only ``docstatus = 1`` (submitted) WOs in ``Awaiting Approval``. Incomplete
    drafts (``docstatus = 0`` / Pending Submission) were never submitted for
    approval, so we leave them alone — never delete.
  * Anything that reached ``Approved`` or beyond is left strictly alone.

Each plan is handled in its own transaction (commit per plan) so one failure
never aborts the batch.
"""
from __future__ import annotations

import frappe
from frappe.utils import add_to_date, now_datetime

AFP_TYPE = "Application Floor Plan"
DEFAULT_DORMANT_DAYS = 3


def auto_cancel_dormant_plans(dry_run: bool = False) -> dict:
    """Stop AFP plans submitted-but-unapproved beyond the dormant window.

    Honours the GM's Spray Plan Settings toggles. ``dry_run=True`` reports what
    *would* be stopped without changing anything — useful for inspecting the
    backlog before enabling the job for real."""
    settings = frappe.get_single("Spray Plan Settings")
    if not settings.auto_cancel_enabled:
        return {"enabled": False, "examined": 0, "cancelled": [], "failed": []}

    days = int(settings.auto_cancel_dormant_days or DEFAULT_DORMANT_DAYS)
    cutoff = add_to_date(now_datetime(), days=-days)
    only_after = (
        None if settings.auto_cancel_apply_to_backlog
        else (settings.auto_cancel_activated_on or None)
    )

    filters = {
        "custom_type": AFP_TYPE,
        "creation": ("<", cutoff),
        "status": ("!=", "Stopped"),
        "docstatus": 1,
        "workflow_state": "Awaiting Approval",
    }
    if only_after:
        # Going-forward: created on/after first-enable AND older than the window.
        filters["creation"] = ("between", [str(only_after), str(cutoff)])

    candidates = frappe.get_all(
        "Work Order",
        filters=filters,
        fields=["name", "docstatus", "owner", "creation", "custom_greenhouse"],
        limit_page_length=0,
    )

    if dry_run:
        return {
            "dry_run": True,
            "enabled": True,
            "cutoff": str(cutoff),
            "only_after": str(only_after) if only_after else None,
            "would_stop": [c.name for c in candidates],
            "count": len(candidates),
        }

    cancelled, failed = [], []
    for wo in candidates:
        try:
            _stop_submitted(wo)
            _notify_creator(wo)
            frappe.db.commit()
            cancelled.append(wo.name)
        except Exception:
            frappe.db.rollback()
            failed.append(wo.name)
            frappe.log_error(
                frappe.get_traceback(),
                f"auto_cancel_dormant_plans: {wo.name}",
            )

    summary = {
        "cutoff": str(cutoff),
        "only_after": str(only_after) if only_after else None,
        "examined": len(candidates),
        "cancelled": cancelled,
        "failed": failed,
    }
    if candidates:
        frappe.logger("spray_plan").info(f"auto_cancel_dormant_plans: {summary}")
    return summary


def _stop_submitted(wo) -> None:
    """Submitted-but-unapproved WO → ERPNext Stopped (mirrors the manual
    'Stop' action approvers use), with an audit comment."""
    from erpnext.manufacturing.doctype.work_order.work_order import stop_unstop

    stop_unstop(wo.name, "Stopped")
    try:
        doc = frappe.get_doc("Work Order", wo.name)
        doc.add_comment(
            "Workflow",
            f"Auto-cancelled: unapproved for more than {DORMANT_DAYS} days "
            f"(created {wo.creation}).",
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "auto_cancel: add_comment failed")


def _notify_creator(wo) -> None:
    """Drop a Notification Log entry for the plan's creator."""
    if not wo.owner or wo.owner in ("Administrator", "Guest"):
        return
    try:
        notif = frappe.get_doc({
            "doctype": "Notification Log",
            "for_user": wo.owner,
            "type": "Alert",
            "subject": (
                f"Spray plan {wo.name} auto-cancelled — unapproved for over "
                f"{DORMANT_DAYS} days"
            ),
            "email_content": (
                f"Your spray plan for {wo.custom_greenhouse or 'a greenhouse'} "
                f"(created {wo.creation}) was automatically cancelled because it "
                f"was not approved within {DORMANT_DAYS} days."
            ),
            "document_type": "Work Order",
            "document_name": wo.name,
        })
        notif.insert(ignore_permissions=True)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "auto_cancel: notify failed")
