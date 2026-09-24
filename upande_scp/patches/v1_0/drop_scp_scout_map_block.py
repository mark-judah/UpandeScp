# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

"""Take the SCP Scout Map block out of the site.

Unlike SCP Dashboard, this one was never on the workspace. It is a Custom HTML
Block that arrived with a restored production database, is rendered by no
workspace, is exported by no fixture and is named nowhere in this app or its
frontend. A record like that only survives long enough for the next person to
ask what draws it — and the map that matters is the one the SPA already draws.

The workspace is still checked before the record is deleted, defensively: if a
site somewhere did put it on the desk, the reference goes first so the desk is
never left pointing at a block that no longer exists.

Idempotent: re-running finds nothing to do.
"""

import frappe

from upande_scp.patches.v1_0.scp_block_removal import delete_block, strip_from_workspace

BLOCK = "SCP Scout Map"


def execute():
	"""A Custom HTML Block no workspace renders and no fixture ships — left over
	from a restored database. The SPA draws the scouting map."""
	strip_from_workspace(BLOCK)
	delete_block(BLOCK)
	frappe.clear_cache()
