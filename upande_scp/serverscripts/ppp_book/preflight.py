"""Pre-deployment check for the crop-protection / foliar-finance change.

Read-only. Answers, for a given site, the questions that decide whether the
migration lands cleanly:

  * are the Item Groups named what the config patch expects?
  * is there data in the pre-rename Chemical columns that must be carried over?
  * does anything still depend on the Item `custom_*` chemical fields?
  * can a BOM's Company be resolved without the old hardcoded literal?
  * how far will the reported finance total move?

Run:  bench --site <site> execute upande_scp.serverscripts.ppp_book.preflight.check
"""
from __future__ import annotations

import frappe

EXPECTED_CHEMICAL_GROUPS = ("Chemicals",)
EXPECTED_FOLIAR_GROUPS = ("Fertilizers",)

CONSUMPTION = ("Material Transfer for Manufacture", "Material Issue")


def _has_column(table, column):
    return bool(frappe.db.sql(
        """SELECT 1 FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = %s AND column_name = %s""",
        (table, column),
    ))


def _spend(purposes, groups):
    if not groups:
        return 0.0
    rows = frappe.db.sql(
        """SELECT ROUND(SUM(sed.amount), 2)
           FROM `tabStock Entry` se
           JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
           JOIN `tabItem` i ON i.name = sed.item_code
           WHERE se.docstatus = 1 AND se.purpose IN %(p)s AND i.item_group IN %(g)s""",
        {"p": purposes, "g": tuple(groups)},
    )
    return float(rows[0][0] or 0) if rows else 0.0


@frappe.whitelist()
def check():
    out = []
    blockers = []
    warnings = []

    def line(text):
        out.append(text)

    line("=" * 72)
    line("CROP-PROTECTION PRE-FLIGHT — %s" % frappe.local.site)
    line("=" * 72)

    # 1 — Item Groups. The one thing that silently empties the spray picker.
    line("")
    line("1. Item Groups")
    all_groups = frappe.get_all("Item Group", pluck="name")
    found_chem = [g for g in EXPECTED_CHEMICAL_GROUPS if g in all_groups]
    found_fol = [g for g in EXPECTED_FOLIAR_GROUPS if g in all_groups]
    line("   expected chemical groups %s -> found %s" % (list(EXPECTED_CHEMICAL_GROUPS), found_chem))
    line("   expected foliar   groups %s -> found %s" % (list(EXPECTED_FOLIAR_GROUPS), found_fol))
    if not found_chem or not found_fol:
        candidates = [g for g in all_groups
                      if "hemical" in g or "ertiliz" in g or "oliar" in g]
        line("   candidates on this site: %s" % candidates)
        blockers.append(
            "Item Group names differ. Edit EXPECTED_* here and WANTED in "
            "patches/v1_0/configure_crop_protection_item_groups.py before migrating, "
            "or the spray picker will list nothing."
        )
    for group in found_chem + found_fol:
        count = frappe.db.count("Item", {"item_group": group, "disabled": 0})
        line("   %-24s %s active items" % (group, count))

    # 2 — pre-rename Chemical data that the converge patch must carry.
    line("")
    line("2. Chemical schema")
    if not frappe.db.table_exists("Chemical"):
        line("   no Chemical table yet — it will be created by migrate")
    else:
        line("   Chemical rows: %s" % frappe.db.count("Chemical"))
        for column in ("lower_rate_limit", "upper_rate_limit"):
            if not _has_column("tabChemical", column):
                line("   %-20s absent (already converged)" % column)
                continue
            n = frappe.db.sql(
                "SELECT COUNT(*) FROM `tabChemical` WHERE IFNULL(`%s`, 0) <> 0" % column
            )[0][0]
            line("   %-20s present, %s non-zero values to carry over" % (column, n))
        legacy = frappe.db.sql(
            """SELECT COUNT(*) FROM `tabChemical Targets`
               WHERE parenttype = 'Chemical' AND parentfield = 'targets'"""
        )[0][0]
        line("   target rows still on the old parentfield: %s" % legacy)

    # 3 — Item custom_* fields. Losing these silently is the risk.
    line("")
    line("3. Legacy Item chemical fields")
    groups = list(found_chem)
    for column in ("custom_lower_rate_limit", "custom_upper_rate_limit", "custom_application_rate"):
        if not _has_column("tabItem", column) or not groups:
            line("   %-28s absent" % column)
            continue
        n = frappe.db.sql(
            "SELECT COUNT(*) FROM `tabItem` WHERE item_group IN %%(g)s AND IFNULL(`%s`, 0) <> 0"
            % column, {"g": tuple(groups)},
        )[0][0]
        line("   %-28s %s populated" % (column, n))
        if n:
            warnings.append(
                "%s holds %s values. The new code reads the Chemical/Foliar sidecar "
                "only — confirm backfill_chemical_master has carried them over."
                % (column, n)
            )

    # 4 — BOM company, which used to be a hardcoded literal.
    line("")
    line("4. BOM company resolution")
    companies = frappe.get_all("Company", pluck="name")
    default_company = frappe.defaults.get_global_default("company")
    line("   companies: %s" % companies)
    line("   global default: %s" % (default_company or "(none)"))
    if not default_company and len(companies) != 1:
        warnings.append(
            "No default Company and more than one exists. Tank-mix creation will "
            "rely on the greenhouse's Warehouse company; make sure those are set."
        )

    # 5 — how far the headline number moves.
    line("")
    line("5. Finance impact")
    all_groups_found = found_chem + found_fol
    before = _spend(("Material Transfer for Manufacture",), all_groups_found)
    after = _spend(CONSUMPTION, all_groups_found)
    line("   currently reported (transfers only) : %.2f" % before)
    line("   will be reported (incl. issues)     : %.2f" % after)
    if before:
        line("   change                              : x%.1f" % (after / before))
    warnings.append(
        "Reported spend changes from %.0f to %.0f. This is a change of definition, "
        "not of data — tell the finance users before they see it." % (before, after)
    )

    line("")
    line("=" * 72)
    if blockers:
        line("BLOCKERS — do not migrate until resolved:")
        for item in blockers:
            line("  * %s" % item)
    else:
        line("No blockers.")
    if warnings:
        line("")
        line("Check before proceeding:")
        for item in warnings:
            line("  - %s" % item)
    line("=" * 72)

    print("\n".join(out))
    return {"blockers": blockers, "warnings": warnings}
