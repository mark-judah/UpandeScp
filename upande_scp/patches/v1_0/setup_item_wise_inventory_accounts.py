"""Map Item Group inventory/expense account defaults + enable item-wise
inventory accounts on stocked companies, so spray stock GL posts natively
(Chemical Mix on 'Chemicals and sprays' nets to zero; Chemical Spray issue
debits 'Chemicals Expense'). Covers ALL Item Groups (including group-nodes,
e.g. the 'All Item Groups' root) so every stocked item resolves a fallback
inventory account via its item_group, however it's parented. Idempotent.
NOT registered in patches.txt — run manually on kaitet.local; promote to
patches.txt for prod separately.

Note: Item Group rows are upserted directly against the child table
(`Item Default`, parenttype='Item Group') rather than via
`frappe.get_doc("Item Group", ...).save()`. Resaving the 'All Item Groups'
root through the full Item Group document would hit ERPNext's own
`ItemGroup.validate()` (which sets `parent_item_group = "All Item Groups"`
whenever it's blank) and throw `NestedSetRecursionError: Item cannot be
added to its own descendants" for the root itself. Writing the child rows
directly sidesteps that pre-existing framework quirk."""
import frappe

STOCKED = ["Karen Roses", "Kaitet Ltd.", "Westwood Dairies Limited"]
CHEM_GROUPS = {"CHEMICALS", "Fertilizer", "Chemical Mix"}
MIX_GROUP = "Chemical Mix"
SCP_COMPANY = "Karen Roses"


def _acct_if_exists(name):
    return name if (name and frappe.db.exists("Account", name)) else None


def _accounts(company):
    abbr = frappe.db.get_value("Company", company, "abbr")
    return {
        "chem": _acct_if_exists(f"1010010105 - Chemicals and sprays - {abbr}"),
        "expense": _acct_if_exists(f"50100301 - Chemicals Expense - {abbr}"),
        "stock": frappe.db.get_value("Company", company, "default_inventory_account"),
    }


def _upsert(gname, company, inv, expense):
    """Upsert the Item Default child row (parenttype='Item Group') for
    (gname, company) directly, without loading/saving the parent Item
    Group document."""
    existing = frappe.db.get_value(
        "Item Default",
        {"parenttype": "Item Group", "parent": gname, "company": company},
        ["name", "default_inventory_account", "expense_account"],
        as_dict=True,
    )
    if existing:
        updates = {}
        if inv and existing.default_inventory_account != inv:
            updates["default_inventory_account"] = inv
        if expense and existing.expense_account != expense:
            updates["expense_account"] = expense
        if updates:
            frappe.db.set_value("Item Default", existing.name, updates)
            return True
        return False
    else:
        max_idx = frappe.db.sql(
            """select max(idx) from `tabItem Default`
               where parenttype='Item Group' and parent=%s""",
            gname,
        )[0][0] or 0
        doc = frappe.get_doc(
            {
                "doctype": "Item Default",
                "parenttype": "Item Group",
                "parentfield": "item_group_defaults",
                "parent": gname,
                "idx": max_idx + 1,
                "company": company,
                "default_inventory_account": inv or None,
                "expense_account": expense or None,
            }
        )
        doc.insert(ignore_permissions=True)
        return True


def execute():
    acc = {c: _accounts(c) for c in STOCKED}
    all_groups = frappe.get_all("Item Group", pluck="name")
    saved = 0
    for gname in all_groups:
        changed = False
        for company in STOCKED:
            a = acc[company]
            inv = a["chem"] if (gname in CHEM_GROUPS and a["chem"]) else a["stock"]
            expense = a["expense"] if (gname == MIX_GROUP and a["expense"]) else None
            if _upsert(gname, company, inv, expense):
                changed = True
        if changed:
            saved += 1
    for company in STOCKED:
        frappe.db.set_value("Company", company, "enable_item_wise_inventory_account", 1)
    exp_kr = acc[SCP_COMPANY]["expense"]
    if exp_kr:
        frappe.db.set_value("Scouting and Crop Protection Settings", "Scouting and Crop Protection Settings",
                            "default_chemical_expense_account", exp_kr)
    frappe.db.commit()
    print(f"item-wise inventory accounts: mapped {saved} item groups, "
          f"toggled {STOCKED}, settings expense={exp_kr}")
