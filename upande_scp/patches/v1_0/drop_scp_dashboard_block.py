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

import frappe

from upande_scp.patches.v1_0.scp_block_removal import delete_block, strip_from_workspace

BLOCK = "SCP Dashboard"


def execute():
	"""The workspace rendered SCP Dashboard — a Map + Summary pair on the desk —
	above the navigation tiles. It duplicated, worse, what the SPA already does.
	kaitet's workspace has only the navigation; mona now matches."""
	strip_from_workspace(BLOCK)
	delete_block(BLOCK)
	frappe.clear_cache()
