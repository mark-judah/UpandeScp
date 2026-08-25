"""Drop the pre-convergence `Chemical` columns.

Frappe removes a field from the form and meta but leaves the DB column behind.
Those orphan columns are worse than clutter: `lower_rate_limit` and
`upper_rate_limit` still existed, all zero, and a query against them returned
an empty result instead of an error — which is exactly how the spray-plan
bootstrap came to report "no rate limits" after the rename, silently.

Only columns confirmed to carry no data are dropped. `converge_chemical_to_
kaitet_schema` has already copied any values across.
"""
from __future__ import annotations

import frappe

DEAD = ("lower_rate_limit", "upper_rate_limit", "targets", "pack_rate")


def _has_column(table: str, column: str) -> bool:
    return bool(frappe.db.sql(
        """SELECT 1 FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = %s AND column_name = %s""",
        (table, column),
    ))


def execute():
    for column in DEAD:
        if not _has_column("tabChemical", column):
            continue
        non_zero = frappe.db.sql(
            f"SELECT COUNT(*) FROM `tabChemical` WHERE IFNULL(`{column}`, 0) <> 0"
        )[0][0]
        if non_zero:
            frappe.log_error(
                f"tabChemical.{column} still holds {non_zero} non-zero values; not dropped",
                "drop_dead_chemical_rate_columns",
            )
            continue
        frappe.db.sql_ddl(f"ALTER TABLE `tabChemical` DROP COLUMN `{column}`")
    frappe.clear_cache(doctype="Chemical")
