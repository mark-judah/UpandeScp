"""Correct the "Scouting Obeservations Report" shortcut label on the desk.

The workspace ships as a fixture, but Frappe only *creates* a public workspace
— it will not overwrite one that already exists, since that would discard
whatever the site has customised on it. Editing the fixture therefore reaches
a fresh install and nobody else, so an existing site needs this.

Only the *label* is corrected. ``link_to`` has to keep matching the Report's
own name, which carries the same typo in its folder, its JSON and its module;
renaming the Report is a larger job and wants its own patch.

Idempotent: the UPDATE matches nothing once applied.
"""

import frappe

WORKSPACE = "Upande SCP"
OLD_LABEL = "Scouting Obeservations Report"
NEW_LABEL = "Scouting Observations Report"


def execute():
    if not frappe.db.exists("Workspace", WORKSPACE):
        return
    frappe.db.sql(
        """UPDATE `tabWorkspace Shortcut`
              SET label = %s
            WHERE parent = %s AND label = %s""",
        (NEW_LABEL, WORKSPACE, OLD_LABEL),
    )
    frappe.db.commit()
