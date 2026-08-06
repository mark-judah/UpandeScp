"""Composite covering indexes on the scouting child tables.

Every dashboard aggregate joins `tabScouting Entry` to a child table on
`c.parent = se.name` and then reads the observation columns. With only the
single-column `parent` index available, MariaDB must visit the clustered
index for every matched child row — and often decides to scan the child
table whole instead, inverting the join (see EXPLAIN in
docs/Optimization/dataload-architecture.md §2.2).

Leading with `parent` is essential: the filter is on `parent`, so an index
led by `pest` would be unusable here.

Idempotent — INFORMATION_SCHEMA is checked before each CREATE INDEX. This
is a NEW patch name rather than an edit to `add_scouting_indexes` because
Frappe records patches in `tabPatchLog` and never re-runs one; appending to
the old patch would be dead code.
"""

import frappe

_INDEXES = (
    ("tabPests Scouting Entry", "pests_parent_cover",
     ("parent", "pest", "plant_section", "stage", "count")),
    ("tabDiseases Scouting Entry", "diseases_parent_cover",
     ("parent", "disease", "plant_section", "stage")),
    ("tabTrap Scouting Entry", "traps_parent_cover",
     ("parent", "trap", "pest", "count")),
)


def _index_exists(table: str, name: str) -> bool:
    return bool(frappe.db.sql(
        """
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = %s AND INDEX_NAME = %s
        LIMIT 1
        """,
        (table, name),
    ))


def execute():
    for table, index_name, columns in _INDEXES:
        if not frappe.db.sql(
            "SELECT 1 FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s",
            (table,),
        ):
            continue
        if _index_exists(table, index_name):
            continue
        cols = ", ".join(f"`{c}`" for c in columns)
        frappe.db.sql(f"CREATE INDEX `{index_name}` ON `{table}` ({cols})")
        frappe.logger().info(
            f"add_scouting_child_indexes: created {index_name} on {table}"
        )
    frappe.db.commit()
