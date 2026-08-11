# Item-wise Inventory Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Set Item Group inventory/expense account defaults + enable `enable_item_wise_inventory_account` on the 3 stocked companies so ERPNext posts the spray stock GL natively (Chemical Mix nets to zero on `Chemicals and sprays`; Chemical Spray issue debits `Chemicals Expense`), leaving the `get_gl_entries` override as fallback.

**Architecture:** An idempotent patch function maps every leaf Item Group's per-company `default_inventory_account` (chemicals → `Chemicals and sprays`, everything else → `Stock In Hand`) + Chemical Mix's `expense_account`, flips the company toggle, and sets the Settings expense account. Run manually on `kaitet.local`; NOT added to `patches.txt` (prod untouched). Config/data only — no app-logic change.

**Tech Stack:** Frappe (Item Group / Item Default, Account, Company, Stock Entry GL), Python, `bench execute`.

## Global Constraints

- **Config/data only** on `kaitet.local`. No change to `spray_stock_entry.py` (override stays as fallback).
- Stocked companies: **Karen Roses, Kaitet Ltd., Westwood Dairies Limited** — the only ones with stock. Toggle stays OFF on the other 5.
- Mapping (per company `<abbr>`, per leaf Item Group `is_group=0`): `CHEMICALS`/`Fertilizer`/`Chemical Mix` → `1010010105 - Chemicals and sprays - <abbr>` **if that account exists for the company**, else the company `Stock In Hand`; every other group → the company's `default_inventory_account` (its `Stock In Hand`). `Chemical Mix` also gets `expense_account = 50100301 - Chemicals Expense - <abbr>` **if it exists**. Availability: KR has chem+expense; KL chem only; WDL neither.
- Also set `Spray Plan Settings.default_chemical_expense_account = 50100301 - Chemicals Expense - KR`.
- **Idempotent:** re-running updates existing `Item Default` rows in place (matched on company); never duplicates.
- **Do NOT add the patch to `patches.txt`.** Run via `bench --site kaitet.local execute upande_scp.patches.v1_0.setup_item_wise_inventory_accounts.execute`.
- No `Co-Authored-By` trailer. Branch `kaitet`. Commit only the patch file. Never use any Kaitet MCP tool.
- Paths: app `/home/ubuntu/stive/code/frappe15/apps/upande_scp`; bench `/home/ubuntu/stive/code/frappe15`; env python `.../env/bin/python`.

---

### Task 1: Idempotent mapping patch + apply + blast-radius = 0

**Files:**
- Create: `upande_scp/patches/v1_0/setup_item_wise_inventory_accounts.py` (NOT added to patches.txt)

- [ ] **Step 1: Write the patch**

Create `upande_scp/patches/v1_0/setup_item_wise_inventory_accounts.py`:

```python
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
        frappe.db.set_value("Spray Plan Settings", "Spray Plan Settings",
                            "default_chemical_expense_account", exp_kr)
    frappe.db.commit()
    print(f"item-wise inventory accounts: mapped {saved} item groups, "
          f"toggled {STOCKED}, settings expense={exp_kr}")
```

- [ ] **Step 2: Apply on kaitet.local**

Run: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local execute upande_scp.patches.v1_0.setup_item_wise_inventory_accounts.execute`
Expected: prints the mapped-group count + the 3 companies + the KR expense account; no traceback.

- [ ] **Step 3: Blast-radius recheck — 0 throwers**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15
env/bin/python - <<'PY'
import frappe
frappe.init(site="kaitet.local", sites_path="/home/ubuntu/stive/code/frappe15/sites"); frappe.connect()
gdefs={(d.parent,d.company):d.default_inventory_account for d in frappe.get_all(
  "Item Default", filters={"parenttype":"Item Group"},
  fields=["parent","company","default_inventory_account"]) if d.default_inventory_account}
rows=frappe.db.sql("""SELECT w.company, b.item_code, i.item_group
  FROM `tabBin` b JOIN `tabWarehouse` w ON w.name=b.warehouse JOIN `tabItem` i ON i.name=b.item_code
  WHERE b.actual_qty>0 GROUP BY w.company,b.item_code""", as_dict=True)
from collections import Counter
miss=Counter()
for r in rows:
    if (r.item_group, r.company) not in gdefs: miss[r.company]+=1
print("stocked items that would THROW per company:", dict(miss) or "NONE (0)")
for c in ["Karen Roses","Kaitet Ltd.","Westwood Dairies Limited"]:
    print(c, "toggle:", frappe.db.get_value("Company",c,"enable_item_wise_inventory_account"))
PY
```
Expected: `NONE (0)` — every stocked item resolves a group inventory account; all 3 toggles = 1.

- [ ] **Step 4: Commit the patch (dormant)**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/patches/v1_0/setup_item_wise_inventory_accounts.py
git commit -m "feat(scp): patch to set item-group inventory/expense defaults + enable item-wise inventory accounts (run manually)"
```
(Do NOT modify `patches.txt`.)

---

### Task 2: Live GL smoke (go/no-go), self-cleaning

No repo changes. Proves the native posting is correct with the toggle ON.

- [ ] **Step 1: Post + inspect a Chemical Mixing SE**

Via env python (`frappe.init(..., sites_path=".../sites"); frappe.connect(); frappe.set_user("Administrator")`), build+submit a `Chemical Mixing` (Manufacture) SE on a Karen Roses AFP Work Order consuming a `CHEMICALS` item with stock and producing its `Chemical Mix` FG. Inspect `tabGL Entry` for the voucher.
Expected: both the raw-out (Cr) and FG-in (Dr) legs are on `1010010105 - Chemicals and sprays - KR`; they net to ≈0; debits==credits. (No warehouse-account leg — item-group account won.)

- [ ] **Step 2: Post + inspect a Chemical Spray SE**

Build+submit a `Chemical Spray` (Material Issue) SE consuming that `Chemical Mix` FG on the same WO/company. Inspect GL.
Expected: Cr `1010010105 - Chemicals and sprays - KR`, Dr `50100301 - Chemicals Expense - KR`; balanced.

- [ ] **Step 3: Inertness — ordinary non-chemical issue**

Build+submit a plain Material Issue for a non-chemical item (e.g. a `PACKAGING MATERIALS` or `HARDWARE` item with stock) — no spray `stock_entry_type`. Inspect GL.
Expected: posts to that company's `Stock In Hand` account, no throw; the `SprayStockEntry` override left it untouched.

- [ ] **Step 4: Clean up**

Cancel every test SE created in Steps 1–3 (`doc.cancel()`); confirm none remain at docstatus 0/1; `frappe.db.commit()`. Leave the item-group defaults + toggle in place (that's the delivered config).

- [ ] **Step 5: Verdict**

Report each leg's actual GL. PASS if Mixing nets to zero on `Chemicals and sprays`, Spray debits `Chemicals Expense`, and the non-chemical issue posts to `Stock In Hand` with no throw. If any leg is wrong, report BLOCKED with the GL rows (do not fix code — the override/native interaction would be re-examined).

---

## Final verification checklist

- [ ] Patch idempotent (a second `execute()` run reports 0 or same mappings, no duplicate `Item Default` rows).
- [ ] Blast-radius = 0 throwers on KR/KL/WDL; all 3 toggles = 1.
- [ ] `Spray Plan Settings.default_chemical_expense_account = 50100301 - Chemicals Expense - KR`.
- [ ] Live smoke: Mixing nets ~0 on Chemicals and sprays; Spray debits Chemicals Expense; non-chemical issue → Stock In Hand, no throw; test SEs cleaned up.
- [ ] Only the patch file committed; `patches.txt` unchanged; no `Co-Authored-By` trailer.
