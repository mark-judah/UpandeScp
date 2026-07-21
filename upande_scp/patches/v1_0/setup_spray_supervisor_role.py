"""Create the Spray Supervisor role + Custom DocPerm entries that grant
the role access to the doctypes the mobile chemical/spray-application
flow touches.

Idempotent: re-runs are safe; existing rows are skipped or updated to
match the desired permission grid below.

Why a patch (not just a fixture import on install): the role needs to
exist on every site that already has this app installed, and assigning
it to existing mobile users requires referencing real user records that
fixtures can't safely create.
"""
from __future__ import annotations

import frappe

ROLE_NAME = "SCP Spray Supervisor"
DESC = (
    "Mobile spray-supervisor: starts and runs the spray application "
    "process on the field app. Granted Create + Submit on Stock Entry "
    "so the chemical-issue and tank-mix manufacture stock entries can "
    "be created from the mobile workflow."
)

# Permission grid for the mobile chemical/spray-application flow.
# Keys must match the DocPerm field names exactly. Any flag omitted
# defaults to 0.
PERM_GRID: dict[str, dict[str, int]] = {
    "Stock Entry": {
        "read": 1, "write": 1, "create": 1, "submit": 1,
        "print": 1, "report": 1, "email": 1, "share": 1, "export": 1,
    },
    "Stock Entry Detail": {"read": 1, "write": 1, "create": 1},
    "Work Order": {
        "read": 1, "write": 1, "report": 1, "print": 1,
        "email": 1, "share": 1, "export": 1,
    },
    "Work Order Item": {"read": 1, "write": 1, "create": 1},
    "Work Order Chemical Scan": {
        "read": 1, "write": 1, "create": 1, "submit": 1,
    },
    "Item": {"read": 1, "report": 1, "print": 1, "share": 1, "export": 1},
    "Warehouse": {"read": 1, "report": 1, "print": 1, "share": 1},
    "Bin": {"read": 1, "report": 1},
    "Stock Ledger Entry": {"read": 1, "report": 1},
    "BOM": {"read": 1, "report": 1, "print": 1, "share": 1},
    "BOM Item": {"read": 1},
    "Spray Application Logsheet": {
        "read": 1, "write": 1, "create": 1, "submit": 1,
        "print": 1, "report": 1, "share": 1,
    },
    "Sprayer Movement Session": {
        "read": 1, "write": 1, "create": 1, "submit": 1,
        "print": 1, "report": 1, "share": 1,
    },
}

# Mobile users we want to grant the role to immediately so testing
# can continue without waiting for a manual assignment in the desk.
SEED_USERS: list[str] = [
    "micah.kayoswo@karenroses.com",
]


def _ensure_role() -> None:
    if frappe.db.exists("Role", ROLE_NAME):
        # Keep the description fresh on re-runs so the desk shows the
        # latest rationale.
        role = frappe.get_doc("Role", ROLE_NAME)
        changed = False
        if role.disabled:
            role.disabled = 0
            changed = True
        if not role.desk_access:
            role.desk_access = 1
            changed = True
        if (role.description or "").strip() != DESC:
            role.description = DESC
            changed = True
        if changed:
            role.save(ignore_permissions=True)
        print(f"[ROLE] {ROLE_NAME} already exists; refreshed.")
        return
    frappe.get_doc(
        {
            "doctype": "Role",
            "role_name": ROLE_NAME,
            "desk_access": 1,
            "disabled": 0,
            "description": DESC,
        }
    ).insert(ignore_permissions=True)
    print(f"[ROLE] created {ROLE_NAME}")


def _ensure_perms() -> None:
    for doctype, flags in PERM_GRID.items():
        if not frappe.db.exists("DocType", doctype):
            print(f"[PERM] skipping {doctype}: doctype does not exist here.")
            continue

        existing = frappe.get_all(
            "Custom DocPerm",
            filters={
                "parent": doctype,
                "role": ROLE_NAME,
                "permlevel": 0,
            },
            fields=["name"],
            limit=1,
        )

        payload = {
            "parent": doctype,
            "parenttype": "DocType",
            "parentfield": "permissions",
            "role": ROLE_NAME,
            "permlevel": 0,
            **flags,
        }

        if existing:
            row_name = existing[0].name
            frappe.db.set_value("Custom DocPerm", row_name, payload, update_modified=True)
            print(f"[PERM] updated {doctype} for {ROLE_NAME}")
        else:
            frappe.get_doc({"doctype": "Custom DocPerm", **payload}).insert(
                ignore_permissions=True
            )
            print(f"[PERM] inserted {doctype} for {ROLE_NAME}")


def _seed_users() -> None:
    for user in SEED_USERS:
        if not frappe.db.exists("User", user):
            print(f"[USER] skipping {user}: not on this site.")
            continue
        already = frappe.db.exists(
            "Has Role",
            {"parent": user, "role": ROLE_NAME},
        )
        if already:
            print(f"[USER] {user} already has {ROLE_NAME}")
            continue
        u = frappe.get_doc("User", user)
        u.append("roles", {"role": ROLE_NAME})
        u.save(ignore_permissions=True)
        print(f"[USER] assigned {ROLE_NAME} to {user}")


def execute() -> None:
    _ensure_role()
    _ensure_perms()
    _seed_users()
    frappe.db.commit()
    # Permission changes are cached aggressively; clear so the next
    # request sees the new grid immediately.
    frappe.clear_cache()
    print("[DONE] Spray Supervisor role + perms set up.")
