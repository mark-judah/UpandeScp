"""Put Spray Product on the desk workspace.

The consolidation made Spray Product the chemical master — rate limits, IRAC
and FRAC codes, per-crop rates all live on it — and nothing on the desk pointed
at it, so it was reachable only by typing the URL. It sits beside the other
chemical masters rather than at the end of the list.

Why a patch and not just the fixture: Frappe only *creates* a public workspace
from its fixture and will not overwrite one that already exists, since that
would discard whatever the site has customised on it. The fixture edit reaches
a fresh install; an existing site changes only because this runs.

It **throws** rather than returning quietly when Spray Product is missing.
A patch that no-ops still gets written to the Patch Log, and Frappe never
re-runs a logged patch — so a silent skip here would mean the shortcut could
never be added to that site by any amount of re-migrating, and the only fix
would be a patch under a new name. That has already happened once on this
site. Failing loudly is recoverable; succeeding quietly is not.

Idempotent: re-running adds nothing.
"""

import frappe

WORKSPACE = "Upande SCP"
PRODUCT = "Spray Product"
ANCHOR = "Chemicals"  # the shortcut we want to sit next to


def execute():
    if not frappe.db.exists("Workspace", WORKSPACE):
        return

    if not frappe.db.exists("DocType", PRODUCT):
        frappe.throw(
            f"{PRODUCT} does not exist, so its workspace shortcut cannot be "
            "added. consolidate_spray_products should have created it earlier "
            "in this migrate — check that it ran before this patch."
        )

    if frappe.db.exists(
        "Workspace Shortcut", {"parent": WORKSPACE, "link_to": PRODUCT}
    ):
        return

    ws = frappe.get_doc("Workspace", WORKSPACE)
    row = ws.append(
        "shortcuts",
        {
            "type": "DocType",
            "link_to": PRODUCT,
            "label": "Spray Products",
            "color": "Grey",
            "doc_view": "List",
        },
    )

    # append() puts it last; move it beside the other chemical masters and
    # renumber, since idx is what the desk orders shortcuts by.
    anchor = next((s for s in ws.shortcuts if s.label == ANCHOR), None)
    if anchor:
        ws.shortcuts.remove(row)
        ws.shortcuts.insert(ws.shortcuts.index(anchor), row)
        for i, s in enumerate(ws.shortcuts, start=1):
            s.idx = i

    ws.save(ignore_permissions=True)
    frappe.db.commit()
