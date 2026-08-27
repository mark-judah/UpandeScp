"""Label the crop-less scouting entries as Rose.

All 2,775 sit in a rose greenhouse, none carries a block or an orchard tree, and
between them they hold every trap scouting row on the site. They are trap
inspections — a trap hangs at greenhouse level, which is why they have no bed or
zone — and the crop was simply never set on the form.
"""

import frappe


def run(apply=False):
    names = frappe.get_all(
        "Scouting Entry",
        filters=[["crop_scouted", "in", [None, ""]]],
        pluck="name", limit_page_length=0,
    )
    print("crop-less entries:", len(names))

    # Guard: refuse to relabel anything carrying avocado infrastructure.
    wrong = frappe.get_all(
        "Scouting Entry",
        filters=[["crop_scouted", "in", [None, ""]], ["block", "is", "set"]],
        pluck="name", limit_page_length=0,
    ) + frappe.get_all(
        "Scouting Entry",
        filters=[["crop_scouted", "in", [None, ""]], ["tree", "is", "set"]],
        pluck="name", limit_page_length=0,
    )
    if wrong:
        print("REFUSING: {} of them carry a block or tree — not roses".format(len(wrong)))
        return
    print("none carries a block or tree — all rose infrastructure")

    if not apply:
        print("dry run — nothing written")
        return
    frappe.db.sql(
        """UPDATE `tabScouting Entry` SET crop_scouted='Rose', modified=NOW()
           WHERE crop_scouted IS NULL OR crop_scouted=''"""
    )
    frappe.db.commit()
    print("updated:", frappe.db.count("Scouting Entry", {"crop_scouted": "Rose"}), "rose entries now")
    print("remaining crop-less:", frappe.db.count("Scouting Entry", {"crop_scouted": ["in", [None, ""]]}))
