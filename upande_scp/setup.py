import json
import frappe


def after_install():
    setup_scp_workspace()


def after_migrate():
    setup_scp_workspace()


def setup_scp_workspace():
    """Ensure all SCP custom blocks are linked to the workspace.
    Safe to run multiple times (idempotent)."""
    workspace_name = "Scouting & Crop Protection"
    blocks = [
        {"name": "SCP Dashboard",   "id": "scp-dashboard-block"},
        {"name": "SCP Scout Map",   "id": "scp-scout-map-block"},
        {"name": "SCP Navigation",  "id": "scp-nav-block"},
    ]

    if not frappe.db.exists("Workspace", workspace_name):
        return

    for idx, block in enumerate(blocks, start=1):
        block_name = block["name"]
        existing = frappe.db.sql(
            "SELECT name FROM `tabWorkspace Custom Block` WHERE parent = %s AND custom_block_name = %s",
            (workspace_name, block_name),
            as_list=True,
        )
        if not existing:
            frappe.db.sql(
                """INSERT INTO `tabWorkspace Custom Block`
                   (name, creation, modified, modified_by, owner, docstatus, idx,
                    custom_block_name, label, parent, parentfield, parenttype)
                   VALUES (%s, NOW(), NOW(), 'Administrator', 'Administrator', 0, %s,
                           %s, %s, %s, 'custom_blocks', 'Workspace')""",
                (frappe.generate_hash(length=10), idx,
                 block_name, block_name, workspace_name),
            )

    # Rebuild content with all three blocks in canonical order
    desired_content = [
        {"id": "scp-dashboard-block",  "type": "custom_block",
         "data": {"custom_block_name": "SCP Dashboard",  "col": 12}},
        {"id": "scp-scout-map-block",  "type": "custom_block",
         "data": {"custom_block_name": "SCP Scout Map",  "col": 12}},
        {"id": "scp-nav-block",        "type": "custom_block",
         "data": {"custom_block_name": "SCP Navigation", "col": 12}},
    ]

    # Always replace content with exactly our 3 blocks (removes stale entries)
    current = desired_content[:]

    frappe.db.sql(
        "UPDATE tabWorkspace SET content = %s, modified = NOW() WHERE name = %s",
        (json.dumps(current), workspace_name),
    )

    frappe.db.commit()
