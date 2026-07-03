"""Rebrand the desk workspace to "Upande SCP" with the Upande logo tile, and
point the Create/Approve Spray Plan + Scout Map sidebar links at the /scp_app
frontend.

The workspace itself ships as a fixture (workspace/upande_scp), but the desk
tile name, its icon and the sidebar link targets live on auto-generated
``Workspace Sidebar`` and ``Desktop Icon`` records which are NOT fixtures — so
re-apply them here. Idempotent: safe to re-run and a no-op once applied.

Renaming the workspace leaves any child ``link_to`` that still points at the
OLD name dangling. On a site whose sidebar links weren't already rerouted, the
``rename_doc`` / ``save`` below would then re-validate those rows and blow up
with ``Could not find Row #1: Link To: Scouting & Crop Protection`` mid-migrate.
So we first repair every dangling reference via direct SQL (no validation)
before any doc save runs.
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
    # 0. Repair dangling references to the OLD workspace name BEFORE any rename
    #    or save can re-validate them (direct SQL → no LinkValidationError).
    #    The NEW workspace already exists at this point (synced from the fixture
    #    in sync_all, which runs before post_model_sync patches), so repointing
    #    to it is valid.
    if frappe.db.table_exists("Workspace Sidebar Item"):
        # a) The three SPA links become plain URLs (regardless of parent name).
        for label, url in REROUTES.items():
            frappe.db.sql(
                """UPDATE `tabWorkspace Sidebar Item`
                   SET link_type = 'URL', url = %s, link_to = NULL
                   WHERE label = %s""",
                (url, label),
            )
        # b) Anything else still pointing at the old workspace → the new one.
        frappe.db.sql(
            "UPDATE `tabWorkspace Sidebar Item` SET link_to = %s WHERE link_to = %s",
            (NEW, OLD),
        )
    for dt in ("Workspace Shortcut", "Workspace Link"):
        if frappe.db.table_exists(dt) and frappe.db.has_column(dt, "link_to"):
            frappe.db.sql(
                f"UPDATE `tab{dt}` SET link_to = %s WHERE link_to = %s", (NEW, OLD)
            )

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
    #    Safe to rename now: step 0 already cleared any dangling child link_to.
    if frappe.db.exists("Workspace Sidebar", OLD) and not frappe.db.exists(
        "Workspace Sidebar", NEW
    ):
        frappe.rename_doc("Workspace Sidebar", OLD, NEW, force=True)

    # 3. Belt-and-braces: make sure the reroutes stuck on the renamed sidebar
    #    (parent name changed in step 2, but the label-keyed SQL in step 0 also
    #    matched pre-rename rows, so this is normally a no-op).
    if frappe.db.exists("Workspace Sidebar", NEW) and frappe.db.table_exists(
        "Workspace Sidebar Item"
    ):
        for label, url in REROUTES.items():
            frappe.db.sql(
                """UPDATE `tabWorkspace Sidebar Item`
                   SET link_type = 'URL', url = %s, link_to = NULL
                   WHERE label = %s AND parent = %s""",
                (url, label, NEW),
            )

    # 4. Desktop Icon — display label, routing target and the Upande logo tile.
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
            {"label": NEW, "link_to": NEW, "logo_url": LOGO, "icon_image": LOGO},
        )

    frappe.clear_cache()
