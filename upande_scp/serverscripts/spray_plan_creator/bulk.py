"""Race-free bulk transitions: submit-for-approval and bulk-approve."""
from __future__ import annotations

import frappe

from .scope import _resolve_user_scope


def _user_has_role(user: str, role: str) -> bool:
    """Use a direct DB query instead of frappe.get_roles() because the Redis
    role cache may not see fresh test-time inserts."""
    if user == "Administrator":
        return True
    return bool(frappe.db.exists("Has Role", {"parent": user, "role": role}))


@frappe.whitelist()
def submit_drafts_for_approval(wo_names) -> dict:
    user = frappe.session.user
    if isinstance(wo_names, str):
        wo_names = frappe.parse_json(wo_names)
    if not wo_names:
        frappe.throw("No drafts to submit.")
    if not _user_has_role(user, "Spray Plan Creator"):
        frappe.throw("Only Spray Plan Creator can submit drafts.", title="Forbidden")
    scope = _resolve_user_scope(user)
    if not scope["farms"] and user != "Administrator":
        frappe.throw("You are not assigned to any farm.", title="No access")

    submitted: list[str] = []
    skipped: list[dict] = []

    for name in wo_names:
        row = frappe.db.sql(
            """SELECT name, docstatus, workflow_state, owner, custom_greenhouse
               FROM `tabWork Order` WHERE name=%s FOR UPDATE""",
            (name,), as_dict=True,
        )
        if not row:
            skipped.append({"name": name, "reason": "missing"})
            continue
        row = row[0]
        if row.owner != user and user != "Administrator":
            skipped.append({"name": name, "reason": "not owner"})
            continue
        if row.docstatus != 0 or row.workflow_state != "Pending Submission":
            skipped.append({"name": name, "reason": "already submitted"})
            continue
        if user != "Administrator":
            gh_farm = frappe.db.get_value("Warehouse", row.custom_greenhouse, "custom_farm")
            if gh_farm not in scope["farms"]:
                skipped.append({"name": name, "reason": "lost farm access"})
                continue
        # Bypass ERPNext's Work Order on_submit hook (which enforces wip_warehouse
        # and other manufacturing fields) since spray plans don't use those fields.
        # We only need to set docstatus=1 and workflow_state atomically.
        now = frappe.utils.now()
        frappe.db.sql(
            """UPDATE `tabWork Order`
               SET docstatus=1,
                   workflow_state='Awaiting Approval',
                   status='Not Started',
                   modified=%s
               WHERE name=%s""",
            (now, name),
        )
        # Add audit trail comment via a lightweight direct insert.
        frappe.get_doc({
            "doctype": "Comment",
            "comment_type": "Workflow",
            "reference_doctype": "Work Order",
            "reference_name": name,
            "content": (
                f"Submitted for approval by {user}. "
                "State: Pending Submission -> Awaiting Approval."
            ),
        }).insert(ignore_permissions=True)
        submitted.append(name)

    frappe.db.commit()
    return {"submitted": submitted, "skipped": skipped}


@frappe.whitelist()
def approve_drafts_bulk(wo_names) -> dict:
    """Race-free GM bulk approval: Awaiting Approval -> Approved.

    Single transaction with row locks, all-or-nothing. Does NOT yet call
    `approve_single_work_order` (which creates a Material Transfer SE) because
    that legacy endpoint runs heavy logic and we want this Part-A bulk endpoint
    isolated. Task 16 wires the legacy single-approver path to also set
    workflow_state; Part B will pair this bulk endpoint with the SE creation.
    """
    user = frappe.session.user
    if isinstance(wo_names, str):
        wo_names = frappe.parse_json(wo_names)
    if not wo_names:
        frappe.throw("No work orders to approve.")
    if user != "Administrator":
        # Use DB check (Redis cache may miss in tests)
        gm_or_sm = bool(frappe.db.sql(
            """SELECT 1 FROM `tabHas Role`
               WHERE parent=%s AND role IN ('General Manager', 'System Manager') LIMIT 1""",
            (user,),
        ))
        if not gm_or_sm:
            raise frappe.PermissionError("Only General Manager / System Manager can bulk-approve.")

    approved: list[str] = []
    skipped: list[dict] = []
    try:
        for name in wo_names:
            row = frappe.db.sql(
                """SELECT name, docstatus, workflow_state
                   FROM `tabWork Order` WHERE name=%s FOR UPDATE""",
                (name,), as_dict=True,
            )
            if not row:
                skipped.append({"name": name, "reason": "missing"}); continue
            row = row[0]
            if row.docstatus != 1 or row.workflow_state != "Awaiting Approval":
                skipped.append({"name": name, "reason": "not awaiting approval"}); continue
            # Flip state via raw SQL (avoids ERPNext on_update_after_submit hooks)
            frappe.db.sql(
                "UPDATE `tabWork Order` SET workflow_state=%s, modified=NOW() WHERE name=%s",
                ("Approved", name),
            )
            try:
                frappe.get_doc("Work Order", name).add_comment(
                    "Workflow",
                    f"Approved by {user}. State: Awaiting Approval -> Approved.",
                )
            except Exception:
                # Comment add failure must not block the approval
                pass
            approved.append(name)
        frappe.db.commit()
    except Exception:
        frappe.db.rollback()
        raise

    return {"approved": approved, "skipped": skipped}
