"""Add composite indexes used by the scouting payload + delta endpoints.

The payload builder filters Scouting Entry by `date_of_capture` (always)
and optionally `greenhouse` / `block`. The delta endpoint filters by
`modified > since`. Without these indexes MariaDB falls back to a full
scan once the table grows past a few hundred thousand rows, and the
tmp-table spill is what bit us in production.

Idempotent: re-runs are no-ops because we look up `INFORMATION_SCHEMA`
before issuing CREATE INDEX.
"""

import frappe


_INDEX_TABLE = "tabScouting Entry"

_INDEXES = (
    # Most date-range reads also scope by greenhouse OR block, so the
    # leading column is `date_of_capture`. The two split indexes cover
    # both filter shapes without forcing a fat (gh + block) covering
    # index that wastes space.
    ("scouting_date_gh_idx", ("date_of_capture", "greenhouse")),
    ("scouting_date_block_idx", ("date_of_capture", "block")),
    # Delta sync: WHERE modified > :since, ORDER BY modified ASC.
    ("scouting_modified_idx", ("modified",)),
    # Crop filter narrows the result before grouping in some reports.
    ("scouting_crop_idx", ("crop_scouted",)),
)


def _index_exists(table, name):
    rows = frappe.db.sql(
        """
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = %s
          AND INDEX_NAME = %s
        LIMIT 1
        """,
        (table, name),
    )
    return bool(rows)


def execute():
    if not frappe.db.table_exists("Scouting Entry"):
        return

    for index_name, columns in _INDEXES:
        if _index_exists(_INDEX_TABLE, index_name):
            continue
        col_sql = ", ".join(f"`{c}`" for c in columns)
        frappe.db.sql(
            f"CREATE INDEX `{index_name}` ON `{_INDEX_TABLE}` ({col_sql})"
        )
        frappe.logger().info(
            f"add_scouting_indexes: created {index_name} on ({col_sql})"
        )

    frappe.db.commit()
