"""Indexes the scouting reads actually need — and a patch that cannot lie.

Why a new patch name rather than an edit to `add_scouting_indexes` /
`add_scouting_child_indexes`: Frappe records a patch in `tabPatchLog` and never
runs it again, so appending to either of those files is dead code on any site
that has already logged them.

Both of the originals ARE logged on the live v16 site — 25 ms apart, at
2026-08-18 12:17:20 — and **not one of their indexes exists there.** On that
date the site had no `Scouting Entry` table yet (scouting was migrated on
2026-09-01/02), and both patches open with a table-existence check that
`return`s quietly when the table is missing. They reported success, were logged
for ever, and did nothing. That silent return is the bug being fixed here as
much as the missing indexes.

So this patch:

* leads the composite with `greenhouse` / `block`, not with `date_of_capture`;
* **fails loudly** when a table it needs is absent, instead of returning;
* **verifies its own work** before it finishes, so a half-applied migration
  cannot be logged as complete.

## Why greenhouse-leading

Every scouting read is "one greenhouse (or block), over a date range". With
`(date_of_capture, greenhouse)` the date range is a range scan on the leading
column, so the greenhouse only filters *within* it: MariaDB estimates the same
row count as for the plain date index, and having estimated them equal it picks
the cheaper 4-byte key. Measured on production (v15, which has that index):

    free choice  -> key=date_of_capture_index  rows=439,024   1,946 ms
    FORCE INDEX  -> key=scouting_date_gh_idx   rows=439,024     153 ms

The index works — 12.7x — but it is never chosen, so it may as well not exist.
Leading with `greenhouse` makes the predicate an equality on the first column,
which collapses the estimate and the optimizer takes it unprompted. Measured on
a replica built to production's shape (891,411 rows / 212 dates / 97 greenhouses):

    FORCE date_of_capture only  (what production does today)   230.0 ms
    FORCE (date, greenhouse)    (what the old patch creates)    26.4 ms
    FORCE (greenhouse, date)    (this patch)                    13.1 ms
    optimizer, free choice, once (greenhouse,date) exists       15.9 ms

with the EXPLAIN estimate falling from 120,602 rows to 1,917. No query hint is
needed, which is why none was added.

The old `(date, …)` composites are left in place: they are harmless, and
dropping indexes on a 3M-row table during a migration is a far bigger risk than
the space they occupy.
"""

import frappe


_PARENT = "tabScouting Entry"

# (table, index name, columns). Leading column is the equality predicate.
_INDEXES = (
    # The scoping reads: WHERE greenhouse = %s AND date_of_capture BETWEEN …
    (_PARENT, "scouting_gh_date_idx", ("greenhouse", "date_of_capture")),
    # Block-grown crops (avocado, coffee) record the unit in `block` and leave
    # `greenhouse` NULL — the two columns are mutually exclusive across the
    # whole table, so each shape needs its own index.
    (_PARENT, "scouting_block_date_idx", ("block", "date_of_capture")),
    # Crop-scoped slices: the avocado map fetches per ISO week filtered by
    # crop, and without this a week scans ~154,460 rows to find ~1,300.
    (_PARENT, "scouting_crop_date_idx", ("crop_scouted", "date_of_capture")),
    # Child tables: every dashboard aggregate joins on `parent` and then reads
    # the observation columns. With only the single-column `parent` index
    # MariaDB visits the clustered index for every matched row.
    ("tabPests Scouting Entry", "pests_parent_cover",
     ("parent", "pest", "plant_section", "stage", "count")),
    ("tabDiseases Scouting Entry", "diseases_parent_cover",
     ("parent", "disease", "plant_section", "stage")),
    ("tabTrap Scouting Entry", "traps_parent_cover",
     ("parent", "trap", "pest", "count")),
)


def _table_exists(table: str) -> bool:
    return bool(frappe.db.sql(
        "SELECT 1 FROM information_schema.TABLES "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s LIMIT 1",
        (table,),
    ))


def _index_exists(table: str, name: str) -> bool:
    return bool(frappe.db.sql(
        "SELECT 1 FROM information_schema.STATISTICS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s "
        "AND INDEX_NAME = %s LIMIT 1",
        (table, name),
    ))


def execute():
    tables = {t for (t, _, _) in _INDEXES}
    missing = sorted(t for t in tables if not _table_exists(t))
    if missing:
        # Deliberately NOT a quiet return. A site without these tables is not a
        # site this patch should mark as done — that is exactly how the previous
        # pair came to be logged on a database they never touched.
        frappe.throw(
            "add_scouting_lookup_indexes: required tables are missing: "
            + ", ".join(missing)
            + ". Refusing to record this patch as applied — install the app's "
              "doctypes (or restore the scouting data) and migrate again."
        )

    created = []
    for table, index_name, columns in _INDEXES:
        if _index_exists(table, index_name):
            continue
        cols = ", ".join(f"`{c}`" for c in columns)
        frappe.db.sql(f"CREATE INDEX `{index_name}` ON `{table}` ({cols})")
        created.append(f"{table}.{index_name}")

    frappe.db.commit()

    # Verify rather than assume. CREATE INDEX on a 1.25 GB table is an online
    # DDL that takes real time and I/O; if a deploy timeout kills the migration
    # partway we must not leave a patch logged as complete over a half-built
    # schema. Re-reading INFORMATION_SCHEMA is the only honest confirmation.
    unverified = sorted(
        f"{t}.{n}" for (t, n, _) in _INDEXES if not _index_exists(t, n)
    )
    if unverified:
        frappe.throw(
            "add_scouting_lookup_indexes: these indexes are still absent after "
            "CREATE INDEX: " + ", ".join(unverified)
        )

    if created:
        frappe.logger().info(
            "add_scouting_lookup_indexes: created " + ", ".join(created)
        )
