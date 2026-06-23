"""Spray-plan lifecycle aggregation for Application Floor Plan Work Orders.

One read-only surface that turns the existing state machine + linked documents
into a normalized 7-step timeline the frontend can render uniformly across the
Approvals (GM), Historical (creator) and Chemical Progress (storesman) pages.

The lifecycle the WO moves through (``workflow_state``):

    Pending Submission → Awaiting Approval → Approved → Chemical Issued
        → Tank Mix Manufactured → Spraying In Progress → Completed

We do NOT own any transition here — ``spray_plan_approval`` / ``spray_session``
/ ``stock_entry_state`` are the writers. This module only reads:

  * Work Order fields (workflow_state, status, scheduled/actual times, scans),
  * the Material-Transfer-for-Manufacture Stock Entry (approval + biometric
    issue + label-print flags),
  * Work Order "Workflow" comments (the actor + timestamp audit trail the
    writers already leave behind).

Endpoints:
  * ``get_lifecycle(work_order)``          — full per-WO timeline (on expand).
  * ``get_lifecycle_summary(...)``         — cheap batch rows for list/tabs.
"""
from __future__ import annotations

import re
from typing import Any

import frappe
from frappe.utils import get_datetime, now_datetime

AFP_TYPE = "Application Floor Plan"
SE_PURPOSE = "Material Transfer for Manufacture"

# Ordered states → rank. Anything not present (e.g. a freshly created WO with no
# workflow_state yet) is treated as rank -1 / "Pending Submission".
STATE_RANK = {
    "Pending Submission": 0,
    "Awaiting Approval": 1,
    "Approved": 2,
    "Chemical Issued": 3,
    "Tank Mix Manufactured": 4,
    "Spraying In Progress": 5,
    "Completed": 6,
}

# The "next milestone" step a WO in each state is working toward — used by the
# summary endpoint for list grouping and the storesman's current-stage badge.
STEP_FOR_STATE = {
    "Pending Submission": "created",
    "Awaiting Approval": "approved",
    "Approved": "chemical_issued",
    "Chemical Issued": "labels_scanned",
    "Tank Mix Manufactured": "spraying_started",
    "Spraying In Progress": "completed",
    "Completed": "completed",
}

ACCESS_ROLES = {
    "General Manager",
    "Spray Plan Approver",
    "Spray Plan Creator",
    "Store Keeper",
    "System Manager",
    "Administrator",
}


# ───────────────────────────────── permissions ───────────────────────────────


def _ensure_access() -> None:
    user = frappe.session.user
    if not user or user == "Guest":
        frappe.throw("Please log in.", frappe.PermissionError)
    if frappe.get_roles(user) and ACCESS_ROLES.intersection(frappe.get_roles(user)):
        return
    frappe.throw(
        "You do not have permission to view spray-plan lifecycle.",
        frappe.PermissionError,
    )


# ───────────────────────────────── helpers ───────────────────────────────────


def _rank(state: str | None) -> int:
    return STATE_RANK.get(state or "", 0)


def _full_name(user_id: str | None) -> str | None:
    if not user_id:
        return None
    return frappe.db.get_value("User", user_id, "full_name") or user_id


def _iso(value: Any) -> str | None:
    if not value:
        return None
    try:
        return get_datetime(value).isoformat(sep=" ", timespec="seconds")
    except Exception:
        return str(value)


def _workflow_comments(wo_name: str) -> list[dict]:
    """All 'Workflow' comments on a WO, oldest first.

    The transition writers (stock_entry_state / spray_session) leave a comment
    like ``… by user@x. State: A -> B.`` — our authoritative actor+time source.
    """
    return frappe.get_all(
        "Comment",
        filters={
            "comment_type": "Workflow",
            "reference_doctype": "Work Order",
            "reference_name": wo_name,
        },
        fields=["content", "creation", "owner"],
        order_by="creation asc",
    )


_BY_RE = re.compile(r"\bby\s+(\S+@\S+|\S+?)[.\s]", re.IGNORECASE)


def _find_transition(comments: list[dict], target_state: str) -> dict | None:
    """First comment recording a transition into ``target_state``.

    Returns ``{actor, actor_name, timestamp}`` or None. ``actor`` is the user id
    parsed from the "by <user>" phrase; falls back to the comment owner.
    """
    marker = f"-> {target_state}"
    for c in comments:
        content = c.get("content") or ""
        if marker in content:
            m = _BY_RE.search(content)
            actor = m.group(1).rstrip(".") if m else (c.get("owner") or None)
            return {
                "actor": actor,
                "actor_name": _full_name(actor),
                "timestamp": _iso(c.get("creation")),
            }
    return None


def _transfer_se(wo_name: str) -> dict | None:
    """The Material-Transfer-for-Manufacture SE for this WO (most recent
    non-cancelled), with the approval / biometric / label-print fields."""
    rows = frappe.get_all(
        "Stock Entry",
        filters={
            "work_order": wo_name,
            "purpose": SE_PURPOSE,
            "docstatus": ("<", 2),
        },
        fields=[
            "name",
            "owner",
            "creation",
            "docstatus",
            "custom_biometric_verified",
            "custom_labels_printed",
            "custom_labels_printed_on",
            "custom_labels_printed_by",
            "custom_labels_print_count",
        ],
        order_by="creation desc",
        limit=1,
    )
    return rows[0] if rows else None


def _biometric_issuer(se_name: str) -> str | None:
    """Full name of the employee whose biometric authorised the issue.

    The biometric child table's doctype name varies by site, so read it off the
    parent doc's ``custom_biometric_data`` field rather than hard-coding a
    child doctype that may not exist."""
    try:
        se = frappe.get_doc("Stock Entry", se_name)
        for row in (getattr(se, "custom_biometric_data", None) or []):
            name = getattr(row, "employee_name", None) or getattr(row, "employee", None)
            if name:
                return name
    except Exception:
        pass
    return None


def _scan_progress(wo) -> dict:
    required = {
        r.item_code
        for r in (wo.required_items or [])
        if getattr(r, "item_code", None)
    }
    scans = list(getattr(wo, "custom_chemical_scans", None) or [])
    scanned = {s.item_code for s in scans if getattr(s, "item_code", None)}
    last = None
    for s in scans:
        if getattr(s, "scanned_at", None):
            if last is None or get_datetime(s.scanned_at) >= get_datetime(last.scanned_at):
                last = s
    return {
        "required": len(required),
        "scanned": len(scanned & required) if required else len(scanned),
        "last_by": _full_name(getattr(last, "scanned_by", None)) if last else None,
        "last_at": _iso(getattr(last, "scanned_at", None)) if last else None,
    }


# ───────────────────────────────── get_lifecycle ─────────────────────────────


@frappe.whitelist()
def get_lifecycle(work_order: str) -> dict:
    """Full normalized 7-step timeline for one AFP Work Order."""
    _ensure_access()
    if not work_order:
        frappe.throw("work_order is required.")

    wo = frappe.get_doc("Work Order", work_order)
    if wo.custom_type != AFP_TYPE:
        frappe.throw(f"{work_order} is not an Application Floor Plan work order.")

    state = wo.workflow_state or "Pending Submission"
    cur = _rank(state)
    stopped = (wo.status or "") == "Stopped"
    comments = _workflow_comments(work_order)
    se = _transfer_se(work_order)
    scan = _scan_progress(wo)

    scheduled = _iso(wo.custom_scheduled_application_time)
    missed = bool(
        wo.custom_scheduled_application_time
        and get_datetime(wo.custom_scheduled_application_time) < now_datetime()
        and cur < STATE_RANK["Spraying In Progress"]
        and not stopped
    )

    printed = bool(se and se.get("custom_labels_printed"))
    print_count = int((se or {}).get("custom_labels_print_count") or 0)

    # ── per-step done flags (monotonic by rank; labels_printed special) ──
    done = {
        "created": True,
        "approved": cur >= STATE_RANK["Approved"] or bool(se),
        "chemical_issued": cur >= STATE_RANK["Chemical Issued"],
        "labels_printed": printed or cur >= STATE_RANK["Tank Mix Manufactured"],
        "labels_scanned": cur >= STATE_RANK["Tank Mix Manufactured"],
        "spraying_started": cur >= STATE_RANK["Spraying In Progress"],
        "completed": cur >= STATE_RANK["Completed"],
    }

    approved_tx = _find_transition(comments, "Approved")
    issued_tx = _find_transition(comments, "Chemical Issued")
    tankmix_tx = _find_transition(comments, "Tank Mix Manufactured")
    start_tx = _find_transition(comments, "Spraying In Progress")
    end_tx = _find_transition(comments, "Completed")

    steps: list[dict] = []

    # 1 — Created
    steps.append({
        "key": "created",
        "label": "Created",
        "actor": _full_name(wo.owner),
        "timestamp": _iso(wo.creation),
        "detail": wo.custom_greenhouse or None,
    })

    # 2 — Approved
    steps.append({
        "key": "approved",
        "label": "Approved",
        "actor": (approved_tx or {}).get("actor_name")
                 or (_full_name(se["owner"]) if se else None),
        "timestamp": (approved_tx or {}).get("timestamp")
                     or (_iso(se["creation"]) if se else None),
        "detail": f"Transfer {se['name']}" if se else None,
    })

    # 3 — Chemical Issued (biometric)
    issuer = _biometric_issuer(se["name"]) if se else None
    bio_ok = bool(se and se.get("custom_biometric_verified"))
    issued_detail = None
    if se:
        bits = []
        if bio_ok:
            bits.append("Biometric ✓")
        if issuer:
            bits.append(issuer)
        bits.append(se["name"])
        issued_detail = " · ".join(bits)
    steps.append({
        "key": "chemical_issued",
        "label": "Chemical Issued",
        "actor": issuer or (issued_tx or {}).get("actor_name"),
        "timestamp": (issued_tx or {}).get("timestamp"),
        "detail": issued_detail,
    })

    # 4 — Labels Printed
    steps.append({
        "key": "labels_printed",
        "label": "Labels Printed",
        "actor": (se or {}).get("custom_labels_printed_by") if printed else None,
        "timestamp": _iso((se or {}).get("custom_labels_printed_on")) if printed else None,
        "detail": (
            f"Printed ×{print_count}" if printed
            else ("Not recorded as printed" if done["labels_printed"] else "Not printed yet")
        ),
    })

    # 5 — Labels Scanned (CSU)
    scan_detail = f"{scan['scanned']} of {scan['required']} scanned" if scan["required"] else None
    steps.append({
        "key": "labels_scanned",
        "label": "Labels Scanned (CSU)",
        "actor": (tankmix_tx or {}).get("actor_name") or scan["last_by"],
        "timestamp": (tankmix_tx or {}).get("timestamp") or scan["last_at"],
        "detail": scan_detail,
    })

    # 6 — Spraying Started
    steps.append({
        "key": "spraying_started",
        "label": "Spraying Started",
        "actor": (start_tx or {}).get("actor_name"),
        "timestamp": (start_tx or {}).get("timestamp") or _iso(wo.actual_start_date),
        "detail": None,
    })

    # 7 — Completed
    steps.append({
        "key": "completed",
        "label": "Completed",
        "actor": (end_tx or {}).get("actor_name"),
        "timestamp": (end_tx or {}).get("timestamp") or _iso(wo.actual_end_date),
        "detail": None,
    })

    # ── assign status: done / current / pending / warning / skipped ──
    first_pending_assigned = False
    for step in steps:
        key = step["key"]
        if stopped and not done[key]:
            step["status"] = "skipped"
            continue
        if done[key]:
            step["status"] = "done"
            continue
        if key == "spraying_started" and missed:
            step["status"] = "warning"
            step["detail"] = (
                f"Did not start within scheduled window (scheduled {scheduled})"
            )
            first_pending_assigned = True
            continue
        if not first_pending_assigned:
            step["status"] = "current"
            first_pending_assigned = True
        else:
            step["status"] = "pending"

    return {
        "work_order": work_order,
        "current_state": state,
        "current_step": STEP_FOR_STATE.get(state, "created"),
        "scheduled": scheduled,
        "missed": missed,
        "stopped": stopped,
        "greenhouse": wo.custom_greenhouse,
        "spray_type": wo.custom_spray_type,
        "steps": steps,
    }


# ───────────────────────────── get_lifecycle_summary ─────────────────────────


@frappe.whitelist()
def get_lifecycle_summary(
    from_date: str | None = None,
    to_date: str | None = None,
    farm: str | None = None,
    greenhouse: str | None = None,
    states: str | list | None = None,
) -> list[dict]:
    """Cheap batch rows for list views / stage tabs. No comment parsing."""
    _ensure_access()

    filters: dict[str, Any] = {"custom_type": AFP_TYPE, "docstatus": ("<", 2)}
    if greenhouse:
        filters["custom_greenhouse"] = greenhouse
    if from_date:
        filters["creation"] = (">=", from_date)
    if states:
        if isinstance(states, str):
            states = [s.strip() for s in states.split(",") if s.strip()]
        if states:
            filters["workflow_state"] = ("in", states)

    rows = frappe.get_all(
        "Work Order",
        filters=filters,
        fields=[
            "name",
            "workflow_state",
            "status",
            "custom_greenhouse",
            "custom_spray_type",
            "custom_scheduled_application_time",
            "creation",
        ],
        order_by="creation desc",
        limit_page_length=500,
    )

    now = now_datetime()
    out = []
    for r in rows:
        # to_date filters on creation upper bound (creation filter above only
        # set the lower bound to keep the dict-filter simple).
        if to_date and r.creation and get_datetime(r.creation) > get_datetime(f"{to_date} 23:59:59"):
            continue
        if farm and not (r.custom_greenhouse or "").startswith(farm):
            continue
        state = r.workflow_state or "Pending Submission"
        stopped = (r.status or "") == "Stopped"
        missed = bool(
            r.custom_scheduled_application_time
            and get_datetime(r.custom_scheduled_application_time) < now
            and _rank(state) < STATE_RANK["Spraying In Progress"]
            and not stopped
        )
        out.append({
            "name": r.name,
            "current_state": state,
            "current_step": STEP_FOR_STATE.get(state, "created"),
            "stopped": stopped,
            "missed": missed,
            "greenhouse": r.custom_greenhouse,
            "spray_type": r.custom_spray_type,
            "scheduled": _iso(r.custom_scheduled_application_time),
        })
    return out
