"""Map Item Group inventory/expense account defaults + enable item-wise
inventory accounts on stocked companies, so spray stock GL posts natively
(Chemical Mix on 'Chemicals and sprays' nets to zero; Chemical Spray issue
debits 'Chemicals Expense'). Idempotent. NOT registered in patches.txt — run
manually on kaitet.local; promote to patches.txt for prod separately."""
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


def _upsert(group_doc, company, inv, expense):
    row = next((d for d in group_doc.item_group_defaults if d.company == company), None)
    if not row:
        row = group_doc.append("item_group_defaults", {"company": company})
    changed = False
    if inv and row.default_inventory_account != inv:
        row.default_inventory_account = inv
        changed = True
    if expense and row.expense_account != expense:
        row.expense_account = expense
        changed = True
    return changed


def execute():
    acc = {c: _accounts(c) for c in STOCKED}
    leaf_groups = frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name")
    saved = 0
    for gname in leaf_groups:
        g = frappe.get_doc("Item Group", gname)
        changed = False
        for company in STOCKED:
            a = acc[company]
            inv = a["chem"] if (gname in CHEM_GROUPS and a["chem"]) else a["stock"]
            expense = a["expense"] if (gname == MIX_GROUP and a["expense"]) else None
            if _upsert(g, company, inv, expense):
                changed = True
        if changed:
            g.save(ignore_permissions=True)
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
