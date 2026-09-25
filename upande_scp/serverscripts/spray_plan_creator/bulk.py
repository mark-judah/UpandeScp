"""Race-free bulk transitions: submit-for-approval and bulk-approve."""
from __future__ import annotations

import frappe

from upande_scp.serverscripts.spray_plan_ops.spray_plan_approval import (
    create_transfer_stock_entry,
)

from .scope import _resolve_user_scope
from upande_scp.serverscripts.roles import spellings


def _user_has_role(user: str, role: str) -> bool:
    """Use a direct DB query instead of frappe.get_roles() because the Redis
    role cache may not see fresh test-time inserts.

    Compared bare, like every other gate: mona carries both "General Manager"
    and "SCP General Manager" and they mean the same thing."""
    if user == "Administrator":
        return True
    return any(
        frappe.db.exists("Has Role", {"parent": user, "role": name})
        for name in spellings(role)
    )


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

    bypass_owner_check = bool(frappe.db.get_single_value("Spray Plan Settings", "bypass_owner_check"))

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
        if row.owner != user and user != "Administrator" and not bypass_owner_check:
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

    Single transaction with row locks. Each Work Order gets its Material
    Transfer for Manufacture created *before* its state is flipped, so bulk
    approval produces exactly what single approval produces.

    This endpoint used to flip the state without creating the transfer. The
    store page lists only existing draft transfers, so those plans silently
    disappeared from the store side — and since the approval paths only act on
    WOs still in 'Awaiting Approval', flipping the state without a transfer
    stranded them permanently. A WO whose transfer cannot be created is
    therefore left alone and reported in ``skipped``, never half-approved.
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
            # The transfer must exist before the state moves. If it cannot be
            # created, leave the WO in 'Awaiting Approval' so it stays
            # approvable rather than becoming invisible to the store.
            try:
                create_transfer_stock_entry(name)
            except Exception:
                frappe.log_error(frappe.get_traceback(), f"Bulk approve – create SE: {name}")
                skipped.append({"name": name, "reason": "could not create material transfer"})
                continue
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
