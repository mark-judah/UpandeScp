# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""Drop the "Upande" from what the desk calls this app.

The farm is already inside Upande's ERP by the time it sees a sidebar, so the
prefix says nothing and costs the width of a word on every screen. The desk
calls it SCP, which is what kaitet has called it since its own workspace was
built and what the workspace fixture now ships.

ONLY THE DESK TEXT MOVES. The package is still `upande_scp` and the module is
still "Upande Scp" — every doctype in the app is owned by that module. The
React app keeps its own headings; this is the desk.

THE WORKSPACE IS RENAMED, NOT MERELY RE-TITLED. Frappe autonames a Workspace
from its label and the desk grid slugs the card's href from the TITLE while the
router resolves routes by NAME, so setting the title alone aims the card at a
route nothing answers to. Livestock learned that the expensive way — see
`upande_livestock.patches.livestock_workspace_matches_its_name`.

AND THE SIDEBAR IS RENAMED WITH IT, which is the trap that hides behind the
first one. The desk decides whether to draw the app's card at all by looking
its sidebar up in the boot map:

    sidebar = bootinfo.workspace_sidebar_item.get(icon.label.lower())
    permitted = bool(sidebar and sidebar["items"])

and that map is keyed by the sidebar's NAME (frappe/boot.py: get_sidebar_items).
Move the Desktop Icon's label to "SCP" while the sidebar is still named
"Upande SCP" and the lookup misses, `permitted` is False, and the app VANISHES
from the desk entirely.

TWO OF THE THREE RECORDS ARE SITE-ONLY, which is why editing the fixture is not
enough. The Workspace ships in the app and arrives with migrate — but only on a
site that does not already have one, since Frappe will not overwrite a public
workspace it did not just create. The Workspace Sidebar and the Desktop Icon are
generated on the site and never shipped at all, so both keep the old text
forever unless something goes and changes them.

Idempotent: every step is a no-op once applied.
"""

import frappe

OLD = "Upande SCP"
NEW = "SCP"
LOGO = "/assets/upande_scp/images/upande_logo.png"


def execute():
	repoint_references()
	rename_workspace()
	rename_sidebar()
	point_the_desk_card()
	frappe.clear_cache()


def repoint_references():
	"""Move every row that names the workspace BEFORE anything re-validates it.

	Direct SQL, so no link validation runs: a child row still pointing at the
	old name would otherwise blow the rename up mid-migrate with "Could not
	find Row #1: Link To", which is how `rebrand_workspace_upande_scp` found
	out. `rename_doc` repoints links itself, but not for the delete branch
	below, and not for rows whose link field it does not know about.
	"""
	for dt in ("Workspace Sidebar Item", "Workspace Shortcut", "Workspace Link"):
		if frappe.db.table_exists(dt) and frappe.db.has_column(dt, "link_to"):
			frappe.db.sql(
				f"UPDATE `tab{dt}` SET link_to = %s WHERE link_to = %s", (NEW, OLD)
			)

	if frappe.db.has_column("User", "default_workspace"):
		frappe.db.sql(
			"UPDATE `tabUser` SET default_workspace = %s WHERE default_workspace = %s",
			(NEW, OLD),
		)

	frappe.db.sql(
		"UPDATE `tabWorkspace` SET parent_page = %s WHERE parent_page = %s", (NEW, OLD)
	)


def rename_workspace():
	if not frappe.db.exists("Workspace", OLD):
		return

	if frappe.db.exists("Workspace", NEW):
		# The renamed fixture already landed on this site, so the old row is a
		# leftover rather than the thing to rename.
		frappe.delete_doc("Workspace", OLD, force=True, ignore_permissions=True)
		return

	frappe.rename_doc("Workspace", OLD, NEW, force=True)
	# `label` is the autoname source and `title` is what the desk card slugs.
	# Renaming moves neither on its own, and leaving either behind rebuilds the
	# exact split this patch exists to close.
	frappe.db.set_value(
		"Workspace", NEW, {"label": NEW, "title": NEW}, update_modified=False
	)


def rename_sidebar():
	if frappe.db.exists("Workspace Sidebar", OLD):
		if frappe.db.exists("Workspace Sidebar", NEW):
			frappe.delete_doc(
				"Workspace Sidebar", OLD, force=True, ignore_permissions=True
			)
		else:
			frappe.rename_doc("Workspace Sidebar", OLD, NEW, force=True)

	if frappe.db.exists("Workspace Sidebar", NEW) and frappe.db.has_column(
		"Workspace Sidebar", "title"
	):
		frappe.db.set_value(
			"Workspace Sidebar", NEW, "title", NEW, update_modified=False
		)


def point_the_desk_card():
	"""The tile on the desk home.

	`label` is both the text and the key the sidebar is looked up by, and
	`link_to` is what it opens: they move together or the card goes dark. The
	row's own name is left alone — Desktop Icon is not a fixture in this app,
	so no sync will insert a second card beside it, and renaming it would only
	break anyone's bookmark of the record.
	"""
	names = set(
		frappe.get_all("Desktop Icon", filters={"link_to": ["in", [OLD, NEW]]}, pluck="name")
	)
	names |= set(frappe.get_all("Desktop Icon", filters={"label": OLD}, pluck="name"))

	for name in names:
		frappe.db.set_value(
			"Desktop Icon",
			name,
			{"label": NEW, "link_to": NEW, "logo_url": LOGO, "icon_image": LOGO},
			update_modified=False,
		)
