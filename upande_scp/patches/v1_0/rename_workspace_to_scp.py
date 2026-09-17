"""Drop the "Upande" prefix from the desk workspace: "Upande SCP" → "SCP".

The farm is already inside Upande's ERP, so the prefix on the desk says nothing
the logo beside it does not already say. The Upande half is carried by the mark;
the word is the module. This mirrors what `upande_livestock` does, where the
desk reads "Livestock" and the package is still `upande_livestock`.

This is the same manoeuvre as `rebrand_workspace_upande_scp` — which renamed
"Scouting & Crop Protection" → "Upande SCP" — and it inherits that patch's
hard-won ordering, for the same reasons:

* The module workspace and the Workspace Sidebar ship in this app's folders and
  are synced from disk before post_model_sync patches run, so by the time we get
  here the NEW name may already exist and the OLD one still be lying beside it.
* A renamed workspace leaves every child `link_to` still pointing at the old
  name dangling, and the `rename_doc`/`save` below would re-validate those rows
  and abort the migration with `Could not find Row #1: Link To: Upande SCP`.
  So the references are repaired by direct SQL, with no validation, FIRST.
* `Desktop Icon` and `Workspace Sidebar` records are auto-generated and are NOT
  part of the workspace folder, so they have to be re-pointed by hand.

Idempotent: a no-op once applied, and safe on a site that never had the old
name (a fresh install syncs "SCP" straight from disk and every branch below
simply finds nothing to do).
"""

import frappe

OLD = "Upande SCP"
NEW = "SCP"
LOGO = "/assets/upande_scp/images/upande_logo.png"


def execute():
    # 0. Repair references to the OLD name before any rename can re-validate
    #    them. The NEW workspace already exists at this point (synced from the
    #    module workspace), so repointing to it is valid.
    for dt in ("Workspace Sidebar Item", "Workspace Shortcut", "Workspace Link"):
        if frappe.db.table_exists(dt) and frappe.db.has_column(dt, "link_to"):
            frappe.db.sql(
                f"UPDATE `tab{dt}` SET link_to = %s WHERE link_to = %s", (NEW, OLD)
            )

    # 1. Workspace. The module workspace now ships "SCP"; rename or drop any
    #    lingering "Upande SCP" so a site does not end up carrying both.
    if frappe.db.exists("Workspace", OLD):
        if frappe.db.exists("Workspace", NEW):
            frappe.delete_doc("Workspace", OLD, force=True, ignore_permissions=True)
        else:
            frappe.rename_doc("Workspace", OLD, NEW, force=True)
    if frappe.db.exists("Workspace", NEW):
        frappe.db.set_value("Workspace", NEW, {"label": NEW, "title": NEW})

    # 2. Workspace Sidebar — the desk heading and the sidebar's routing key.
    #    Safe to rename now: step 0 cleared the dangling child link_to rows.
    if frappe.db.exists("Workspace Sidebar", OLD):
        if frappe.db.exists("Workspace Sidebar", NEW):
            frappe.delete_doc(
                "Workspace Sidebar", OLD, force=True, ignore_permissions=True
            )
        else:
            frappe.rename_doc("Workspace Sidebar", OLD, NEW, force=True)
    if frappe.db.exists("Workspace Sidebar", NEW):
        frappe.db.set_value("Workspace Sidebar", NEW, {"title": NEW})

    # 3. Desktop Icon — the grid card's label, target and logo tile.
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
