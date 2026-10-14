"""Namespace all app-owned roles under an ``SCP `` prefix.

The app used to check for plain role names (``Scout``, ``Store Keeper``,
``General Manager`` …) that it assumed the target site already provided. It now
ships and checks its own ``SCP `` roles so it is self-contained.

This patch runs **pre_model_sync** so the renamed roles exist before DocType
permission rows referencing them are synced.

It is non-destructive and idempotent:
  * creates any missing SCP role (no standalone permissions of their own —
    grants come from the app's DocType schema);
  * copies every ``Has Role`` assignment from each old role onto the matching
    SCP role, leaving the old assignment in place (old shared roles such as
    ``Scout`` may still be used elsewhere and are cleaned up by hand later).
"""

import frappe

# old role name -> new SCP role name
ROLE_MAP = {
    "General Manager": "SCP General Manager",
    "Spray Supervisor": "SCP Spray Supervisor",
    "Spray Plan Creator": "SCP Spray Plan Creator",
    "Spray Plan Approver": "SCP Spray Plan Approver",
    "Scout": "SCP Scout",
    "Store Keeper": "SCP Chemical Store Keeper",
    "Scouting & Crop Protection User": "SCP Scouting User",
}


def _ensure_role(role_name):
    if frappe.db.exists("Role", role_name):
        return
    frappe.get_doc(
        {
            "doctype": "Role",
            "role_name": role_name,
            "desk_access": 1,
            "is_custom": 0,
        }
    ).insert(ignore_permissions=True)
    print(f"[scp-roles] created role {role_name}")


def _copy_assignments(old_role, new_role):
    """Give every user who holds *old_role* the *new_role* too (if not already).

    We insert the ``Has Role`` child row directly instead of re-saving the whole
    User doc: some sites have users whose existing role rows / role profile point
    at roles that no longer exist, and a full ``user.save()`` would fail link
    validation on that pre-existing dirty data. A direct child insert with
    ``ignore_links`` touches only the one new assignment.
    """
    # A missing Role document means the mapping was RETIRED, not that its assignments
    # were orphaned by accident — so skip it.
    #
    # This guard was removed once, on the reasoning that assignments outlive the role they
    # name and the patch was therefore skipping populations that needed it. That was
    # backwards. `Store Keeper` and `Spray Plan Approver` are the only two whose Role
    # documents had been deleted, and they were deleted deliberately: `Store Keeper` on
    # kaitet is a generic warehouse role held by 110 people across the whole business, not
    # chemical store keepers. Their orphan `Has Role` rows granted nothing precisely
    # because the role was gone. Migrating them turned 110 dormant rows into real access
    # and took the SCP store keepers from 2 to 112.
    #
    # The deleted Role doc is a signal. If a mapping here should apply, restore the Role.
    if not frappe.db.exists("Role", old_role):
        return

    users = frappe.get_all(
        "Has Role",
        filters={"role": old_role, "parenttype": "User"},
        pluck="parent",
    )
    copied = 0
    for user in users:
        if not frappe.db.exists("User", user):
            continue
        if frappe.db.exists("Has Role", {"parent": user, "role": new_role, "parenttype": "User"}):
            continue
        frappe.get_doc(
            {
                "doctype": "Has Role",
                "parenttype": "User",
                "parentfield": "roles",
                "parent": user,
                "role": new_role,
            }
        ).insert(ignore_permissions=True, ignore_links=True)
        copied += 1
    if copied:
        print(f"[scp-roles] {old_role} -> {new_role}: added to {copied} user(s)")


def execute():
    # 1) make sure every SCP role exists before doctype perms reference it
    for new_role in ROLE_MAP.values():
        _ensure_role(new_role)

    # 2) carry existing user assignments over, non-destructively
    for old_role, new_role in ROLE_MAP.items():
        _copy_assignments(old_role, new_role)

    frappe.db.commit()
