"""Move mona's `Chemical` onto kaitet's field names.

mona's Chemical was a generation behind: `targets`, `lower_rate_limit` and
`upper_rate_limit` where kaitet uses `default_targets`,
`default_lower_rate_limit` and `default_upper_rate_limit`. The ported
`crop_protection` module reads only the kaitet names, so the data has to move
with the schema.

Kept from mona's schema: `allowed` (read by the settings editor's chemical
gating) and `application_rate` (still referenced by the work-order path) and
`description` (has data, no kaitet equivalent). Dropped: `pack_rate` and
`crop_scouted`, both empty.

Child rows carry a `parentfield`, so renaming the table field means repointing
them — a rename on the parent doctype does not do it.

Idempotent: every step is a no-op once applied.
"""
from __future__ import annotations

import frappe

SCALAR_RENAMES = {
    "lower_rate_limit": "default_lower_rate_limit",
    "upper_rate_limit": "default_upper_rate_limit",
}
CHILD_RENAMES = {"targets": "default_targets"}


def _has_column(table: str, column: str) -> bool:
    return bool(frappe.db.sql(
        """SELECT 1 FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = %s AND column_name = %s""",
        (table, column),
    ))


def execute():
    # 1. Carry scalar values across, only where the old column still exists and
    #    the new one is empty.
    for old, new in SCALAR_RENAMES.items():
        if not _has_column("tabChemical", old) or not _has_column("tabChemical", new):
            continue
        frappe.db.sql(
            f"""UPDATE `tabChemical`
                SET `{new}` = `{old}`
                WHERE IFNULL(`{new}`, 0) = 0 AND IFNULL(`{old}`, 0) <> 0"""
        )

    # 2. Repoint child rows onto the new parentfield.
    for old, new in CHILD_RENAMES.items():
        frappe.db.sql(
            """UPDATE `tabChemical Targets`
               SET parentfield = %s
               WHERE parenttype = 'Chemical' AND parentfield = %s""",
            (new, old),
        )

    frappe.db.commit()
    frappe.clear_cache(doctype="Chemical")
