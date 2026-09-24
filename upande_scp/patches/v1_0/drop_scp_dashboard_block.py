# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""Take the SCP Dashboard block off the workspace, and out of the site.

The workspace rendered two custom blocks: SCP Dashboard (a Map + Summary pair
drawn on the desk) above SCP Navigation (the tiles that link into /scp_app).
The dashboard duplicated, worse, what the SPA already does — and kaitet's
workspace has only the navigation. mona now matches.

WHY A PATCH AND NOT JUST THE FIXTURE. Frappe only *creates* a public workspace
from its fixture and will not overwrite one that already exists, since that
would discard whatever the site has customised on it. Editing the fixture
reaches a fresh install and nobody else; an existing site changes only because
this runs.

The block record goes too, not merely the reference to it — "we do not need it"
was the instruction, and a Custom HTML Block nothing points at is just something
for the next person to wonder about. Anything else still pointing at it is left
alone and named in the log rather than silently broken.

Idempotent: re-running finds nothing to do.
"""

import json

import frappe

BLOCK = "SCP Dashboard"
WORKSPACE = "SCP"


def execute():
	_strip_from_workspace()
	_delete_the_block()
	frappe.clear_cache()


def _strip_from_workspace():
	if not frappe.db.exists("Workspace", WORKSPACE):
		return

	content = frappe.db.get_value("Workspace", WORKSPACE, "content")
	try:
		blocks = json.loads(content or "[]")
	except ValueError:
		# Not JSON we understand — leave the workspace alone rather than
		# rewriting it into something worse.
		return

	kept = [
		b
		for b in blocks
		if not (
			b.get("type") == "custom_block"
			and (b.get("data") or {}).get("custom_block_name") == BLOCK
		)
	]
	if len(kept) == len(blocks):
		return

	frappe.db.set_value("Workspace", WORKSPACE, "content", json.dumps(kept))


def _delete_the_block():
	if not frappe.db.exists("Custom HTML Block", BLOCK):
		return

	# Whatever else references it stays as it is: a workspace on this site that
	# someone built by hand is not this patch's to edit, and a dangling
	# reference that is named is easier to deal with than one that is not.
	others = frappe.db.sql(
		"""SELECT DISTINCT parent FROM `tabWorkspace Custom Block`
		   WHERE custom_block_name = %s AND parent != %s""",
		(BLOCK, WORKSPACE),
		pluck=True,
	)
	if others:
		frappe.log_error(
			title=f"{BLOCK} still referenced",
			message="Deleted the block; these workspaces still name it: "
			+ ", ".join(others),
		)

	frappe.delete_doc("Custom HTML Block", BLOCK, force=True, ignore_permissions=True)
