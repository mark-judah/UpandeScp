"""Rebrand the desk workspace to "Upande SCP" with the Upande logo tile, and
point the Create/Approve Spray Plan + Scout Map sidebar links at the /scp_app
frontend.

The workspace itself ships as a fixture (workspace/upande_scp), but the desk
tile name, its icon and the sidebar link targets live on auto-generated
``Workspace Sidebar`` and ``Desktop Icon`` records which are NOT fixtures — so
re-apply them here. Idempotent: safe to re-run and a no-op once applied.
"""

import frappe

OLD = "Scouting & Crop Protection"
NEW = "Upande SCP"
LOGO = "/assets/upande_scp/images/upande_logo.png"
REROUTES = {
    "Scout Map": "/scp_app#/rose/scouting-map",
    "Create Spray Plan": "/scp_app#/rose/application-plan",
    "Approve Spray Plan": "/scp_app#/rose/approvals",
}


def execute():
    # 1. Workspace — the fixture ships "Upande SCP"; rename/clean any lingering
    #    old doc so a site doesn't end up with both.
    if frappe.db.exists("Workspace", OLD):
        if frappe.db.exists("Workspace", NEW):
            frappe.delete_doc("Workspace", OLD, force=True, ignore_permissions=True)
        else:
            frappe.rename_doc("Workspace", OLD, NEW, force=True)
    if frappe.db.exists("Workspace", NEW):
        frappe.db.set_value("Workspace", NEW, {"label": NEW, "title": NEW})

    # 2. Workspace Sidebar — supplies the desk heading + the sidebar routing key.
    if frappe.db.exists("Workspace Sidebar", OLD) and not frappe.db.exists(
        "Workspace Sidebar", NEW
    ):
        frappe.rename_doc("Workspace Sidebar", OLD, NEW, force=True)

    # 3. Reroute the spray-plan / scout-map sidebar links to the /scp_app SPA.
    if frappe.db.exists("Workspace Sidebar", NEW):
        sb = frappe.get_doc("Workspace Sidebar", NEW)
        dirty = False
        for it in sb.items:
            target = REROUTES.get(it.label)
            if target and (it.url != target or it.link_type != "URL"):
                it.url = target
                it.link_type = "URL"
                it.link_to = None
                dirty = True
        if dirty:
            sb.save(ignore_permissions=True)

    # 4. Desktop Icon — display label + the Upande logo on the tile.
    di_names = set(
        frappe.get_all(
            "Desktop Icon", filters={"link_to": ["in", [OLD, NEW]]}, pluck="name"
        )
    )
    di_names |= {n for n in (OLD, NEW) if frappe.db.exists("Desktop Icon", n)}
    for name in di_names:
        frappe.db.set_value(
            "Desktop Icon",
            name,
            {"label": NEW, "logo_url": LOGO, "icon_image": LOGO},
        )

    frappe.clear_cache()
