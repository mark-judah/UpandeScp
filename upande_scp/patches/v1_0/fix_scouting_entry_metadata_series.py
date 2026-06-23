"""Seed the Scouting Entry Metadata naming counter after switching its
autoname from `format:SEM-{###}` to the old-style `SEM-.#####`.

Background
----------
`format:SEM-{###}` stored its counter under the EMPTY-STRING key in
`tabSeries` (Frappe parses each {..} brace param in isolation, so the
{###} digit group gets an empty prefix). That empty-key counter was
reset below the highest existing record, so every insert regenerated an
existing `SEM-NNN` and raised IntegrityError 1062, which made the mobile
endpoint roll the whole scouting entry back -- scouts could save nothing.

The doctype now uses `SEM-.#####`, whose counter lives under the proper
`SEM-` key. This patch seeds that `SEM-` counter to the highest existing
metadata number so the next generated name is max+1 and cannot collide.

Idempotent: only ever raises the counter, never lowers it.
"""

import frappe


def execute():
    max_num = frappe.db.sql(
        """
        SELECT MAX(CAST(SUBSTRING_INDEX(name, '-', -1) AS UNSIGNED))
        FROM `tabScouting Entry Metadata`
        WHERE name LIKE 'SEM-%'
        """
    )[0][0]
    max_num = int(max_num or 0)

    current = frappe.db.sql("SELECT `current` FROM `tabSeries` WHERE name = 'SEM-'")
    current = int(current[0][0]) if current else None

    if current is None:
        frappe.db.sql(
            "INSERT INTO `tabSeries` (`name`, `current`) VALUES ('SEM-', %s)", (max_num,)
        )
        frappe.logger().info(f"Seeded SEM- naming counter to {max_num}")
    elif current < max_num:
        frappe.db.sql(
            "UPDATE `tabSeries` SET `current` = %s WHERE name = 'SEM-'", (max_num,)
        )
        frappe.logger().info(
            f"Advanced SEM- naming counter from {current} to {max_num}"
        )

    frappe.db.commit()
