# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""Taking a Custom HTML Block off the desk, and out of the site.

Two blocks shipped or landed on mona that nothing needs: SCP Dashboard, a Map +
Summary pair the workspace drew above the navigation, and SCP Scout Map, which
no workspace references at all and which arrived with a restored database.

Removing one is three steps, and missing any of them puts it back:

  * the workspace stops rendering it — but a fixture never overwrites a public
    workspace that already exists, so an existing site needs a patch
  * `fixtures/custom_html_block.json` stops shipping it — this is the one that
    bites, because `sync_fixtures` runs AFTER patches on every migrate and will
    recreate from the file what the patch just deleted
  * the hooks fixture filter stops exporting it

This module holds the site half. The file halves live in the app.
"""

import json

import frappe

WORKSPACE = "SCP"


def strip_from_workspace(block: str, workspace: str = WORKSPACE) -> bool:
	"""Remove the block from a workspace's rendered content."""
	if not frappe.db.exists("Workspace", workspace):
		return False

	try:
		blocks = json.loads(frappe.db.get_value("Workspace", workspace, "content") or "[]")
	except ValueError:
		# Not JSON we understand — leave it alone rather than rewriting it
		# into something worse.
		return False

	kept = [
		b
		for b in blocks
		if not (
			b.get("type") == "custom_block"
			and (b.get("data") or {}).get("custom_block_name") == block
		)
	]
	if len(kept) == len(blocks):
		return False

	frappe.db.set_value("Workspace", workspace, "content", json.dumps(kept))
	return True


def delete_block(block: str, workspace: str = WORKSPACE) -> bool:
	"""Delete the block itself, naming anything else that still points at it.

	A workspace somebody built by hand is not a patch's to edit, and a dangling
	reference that is named is easier to deal with than one that is not.
	"""
	if not frappe.db.exists("Custom HTML Block", block):
		return False

	others = frappe.db.sql(
		"""SELECT DISTINCT parent FROM `tabWorkspace Custom Block`
		   WHERE custom_block_name = %s AND parent != %s""",
		(block, workspace),
		pluck=True,
	)
	if others:
		frappe.log_error(
			title=f"{block} still referenced",
			message="Deleted the block; these workspaces still name it: " + ", ".join(others),
		)

	frappe.delete_doc("Custom HTML Block", block, force=True, ignore_permissions=True)
	return True
