# Spray-plan Stock Accounting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rename the spray flow's Stock Entry Types, let Spray Plan Settings hard-override the Mixing/Spray debit-credit accounts (warehouse fallback), and add a static flowchart to Settings — all on a feature branch, gated by a stock↔GL reconciliation check.

**Architecture:** Custom `Stock Entry Type` records (spray-specific names, standard `purpose` underneath) shipped by a migrate patch; flow code sets those type names. A `Stock Entry` subclass overrides `get_gl_entries` to remap the stock-in-hand accounts on Manufacture + Material Issue spray SEs to the configured Settings accounts (warehouse account when blank). A read-only HTML field renders the flowchart.

**Tech Stack:** Frappe/ERPNext (Stock Entry, Stock Entry Type, GL entries, perpetual inventory), Python, migrate patches, `bench`.

## Global Constraints

- **Feature branch** off `kaitet` — `scp-spray-stock-accounting`. Do NOT build on `kaitet`.
- **`purpose` never changes.** Only the Stock Entry Type *name* changes; every `purpose`-based branch (`stock_entry_state.py`, `store_keeper_api._SE_PURPOSE`, `lifecycle.SE_PURPOSE`) must keep working. A custom Stock Entry Type carries a `purpose`; ERPNext derives `doc.purpose` from `stock_entry_type` on validate.
- **Type names** (placeholders except Loaning, which is final): `CSU Chemical Transfer` (Material Transfer for Manufacture), `Chemical Mixing` (Manufacture), `Chemical Spray` (Material Issue), `Chemical Loaning` (Material Transfer). Keep them as named constants in ONE module so renames are one-line.
- **Account override applies ONLY to Manufacture + Material Issue spray SEs.** The CSU Chemical Transfer step is never overridden (warehouse-to-warehouse, no P&L). Non-spray Stock Entries are untouched (delegate to `super()`).
- **Warehouse account is the fallback** when a Settings account field is blank.
- **No `Co-Authored-By` trailer.** Commit only the files each task names (never `git add -A`).
- Paths: app `/home/ubuntu/stive/code/frappe15/apps/upande_scp`; bench `/home/ubuntu/stive/code/frappe15`; env python `.../env/bin/python`; site `kaitet.local`. `StockEntry` = `erpnext.stock.doctype.stock_entry.stock_entry.StockEntry`; `get_gl_entries(self, inventory_account_map)`.
- Never use any Kaitet MCP tool.

---

### Task 1: Feature branch + named Stock Entry Types + flow wiring

**Files:**
- Create: `upande_scp/serverscripts/store/spray_stock_types.py` (name constants)
- Create: `upande_scp/patches/v1_0/create_spray_stock_entry_types.py` + add to `patches.txt`
- Modify: `mobile/start_work_order.py:277`, `spray_plan_ops/spray_plan_approval.py` (~316), `spray_plan_creator/spray_session.py` (~746 Manufacture build), `spray_plan_creator/auto_material_issue.py:161`, `spray_plan_creator/loaning.py:462`

**Interfaces:**
- Produces: constants `SE_TYPE_TRANSFER`, `SE_TYPE_MIX`, `SE_TYPE_SPRAY`, `SE_TYPE_LOAN` in `spray_stock_types.py` (used by Task 3 to identify spray SEs).

- [ ] **Step 1: Create the branch**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git checkout -b scp-spray-stock-accounting`
Expected: `Switched to a new branch 'scp-spray-stock-accounting'`.

- [ ] **Step 2: Name constants**

Create `upande_scp/serverscripts/store/spray_stock_types.py`:

```python
"""Spray-flow Stock Entry Type names. Renaming these + the patch is the ONLY
place type wording lives. `purpose` (unchanged) is derived by ERPNext from the
type, so all purpose-based dispatch is unaffected."""

SE_TYPE_TRANSFER = "CSU Chemical Transfer"          # purpose: Material Transfer for Manufacture
SE_TYPE_MIX = "Chemical Mixing"                     # purpose: Manufacture
SE_TYPE_SPRAY = "Chemical Spray"                    # purpose: Material Issue
SE_TYPE_LOAN = "Chemical Loaning"                   # purpose: Material Transfer

# type name -> purpose (for the migrate patch)
SPRAY_STOCK_ENTRY_TYPES = {
    SE_TYPE_TRANSFER: "Material Transfer for Manufacture",
    SE_TYPE_MIX: "Manufacture",
    SE_TYPE_SPRAY: "Material Issue",
    SE_TYPE_LOAN: "Material Transfer",
}
```

- [ ] **Step 3: Migrate patch to create the types (idempotent)**

Create `upande_scp/patches/v1_0/create_spray_stock_entry_types.py`:

```python
import frappe
from upande_scp.serverscripts.store.spray_stock_types import SPRAY_STOCK_ENTRY_TYPES


def execute():
    for type_name, purpose in SPRAY_STOCK_ENTRY_TYPES.items():
        if frappe.db.exists("Stock Entry Type", type_name):
            # keep purpose in sync in case a name was reused
            frappe.db.set_value("Stock Entry Type", type_name, "purpose", purpose)
            continue
        doc = frappe.new_doc("Stock Entry Type")
        doc.name = type_name
        doc.purpose = purpose
        doc.is_standard = 0
        doc.insert(ignore_permissions=True)
    frappe.db.commit()
```

Add to `upande_scp/patches.txt` (under `[post_model_sync]`):
`upande_scp.patches.v1_0.create_spray_stock_entry_types`

- [ ] **Step 4: Point the flow at the new type names**

Set `stock_entry_type` to the constant at each creation site (import from `spray_stock_types`); leave/allow `purpose` to derive:
- `mobile/start_work_order.py:277`: `stock_entry.stock_entry_type = SE_TYPE_TRANSFER`
- `spray_plan_ops/spray_plan_approval.py` (~316, after `_make_se(...)`): set `se_data.stock_entry_type = SE_TYPE_TRANSFER` (or set on the doc before insert). Keep the `purpose="Material Transfer for Manufacture"` arg to `_make_se`.
- `spray_plan_creator/spray_session.py` (~746 Manufacture dict): add/replace `"stock_entry_type": SE_TYPE_MIX` (keep `"purpose": "Manufacture"`).
- `spray_plan_creator/auto_material_issue.py:161`: `"stock_entry_type": SE_TYPE_SPRAY` (keep `"purpose": "Material Issue"`).
- `spray_plan_creator/loaning.py:462`: `se.stock_entry_type = SE_TYPE_LOAN`.

- [ ] **Step 5: Migrate + verify dispatch unchanged**

Run:
```bash
cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate 2>&1 | tail -3
env/bin/python - <<'PY'
import frappe
frappe.init(site="kaitet.local", sites_path="/home/ubuntu/stive/code/frappe15/sites"); frappe.connect()
from upande_scp.serverscripts.store.spray_stock_types import SPRAY_STOCK_ENTRY_TYPES
for t,p in SPRAY_STOCK_ENTRY_TYPES.items():
    got = frappe.db.get_value("Stock Entry Type", t, "purpose")
    print(f"{t!r}: purpose={got!r} {'OK' if got==p else 'MISMATCH'}")
PY
```
Expected: migrate clean; each type exists with the correct `purpose`. (Dispatch keys on purpose → unchanged.)

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/store/spray_stock_types.py upande_scp/patches/v1_0/create_spray_stock_entry_types.py upande_scp/patches.txt upande_scp/serverscripts/mobile/start_work_order.py upande_scp/serverscripts/spray_plan_ops/spray_plan_approval.py upande_scp/serverscripts/spray_plan_creator/spray_session.py upande_scp/serverscripts/spray_plan_creator/auto_material_issue.py upande_scp/serverscripts/spray_plan_creator/loaning.py
git commit -m "feat(scp): name spray-flow Stock Entry Types (purpose unchanged)"
```

---

### Task 2: Spray Plan Settings — Stock Accounting account fields

**Files:**
- Modify: `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json`
- Modify: `upande_scp/serverscripts/spray_plan_creator/settings.py` (get-dict ~line 75; `scalar_fields` ~line 125)

**Interfaces:**
- Produces: three Link(Account) fields on Spray Plan Settings — `spray_raw_chemical_account`, `spray_tank_mix_account`, `spray_expense_account` — read by Task 3.

- [ ] **Step 1: Add the fields to the doctype JSON**

Add a `stock_accounting_section` (Section Break, label "Stock Accounting (Mixing & Spray)") after `default_chemical_difference_account`, then three fields (add to `field_order` and `fields`):

```json
  { "fieldname": "stock_accounting_section", "fieldtype": "Section Break", "label": "Stock Accounting (Mixing & Spray)" },
  { "fieldname": "spray_raw_chemical_account", "fieldtype": "Link", "options": "Account", "label": "Raw Chemical Account (credited on Mixing)", "description": "Overrides the raw-consumption credit on Chemical Mixing. Blank = source warehouse account." },
  { "fieldname": "spray_tank_mix_account", "fieldtype": "Link", "options": "Account", "label": "Tank-Mix / WIP Account (debited on Mixing, credited on Spray)", "description": "Shared account: tank-mix value in on Mixing (incl. valuation difference), out on Spray. Blank = CSU/WIP warehouse account." },
  { "fieldname": "spray_expense_account", "fieldtype": "Link", "options": "Account", "label": "Spray Expense Account (debited on Spray)", "description": "P&L expense debited on Chemical Spray. Blank = default chemical expense account, then item expense account." }
```

- [ ] **Step 2: Load + save the new fields**

In `settings.py` get-dict (after the `default_chemical_difference_account` line), add:
```python
            "spray_raw_chemical_account": settings.spray_raw_chemical_account or "",
            "spray_tank_mix_account": settings.spray_tank_mix_account or "",
            "spray_expense_account": settings.spray_expense_account or "",
```
And add the three fieldnames to `scalar_fields`.

- [ ] **Step 3: Migrate + smoke**

Run: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate && bench --site kaitet.local execute upande_scp.serverscripts.spray_plan_creator.settings.get_settings_bundle 2>&1 | tail -20`
Expected: the three keys appear (blank) in the returned `spray_plan` block.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json upande_scp/serverscripts/spray_plan_creator/settings.py
git commit -m "feat(scp): add spray stock-accounting override fields to Spray Plan Settings"
```

---

### Task 3: `get_gl_entries` override (the hard-override)

**Files:**
- Create: `upande_scp/serverscripts/store/spray_stock_entry.py`
- Modify: `upande_scp/hooks.py` (enable `override_doctype_class`)

**Interfaces:**
- Consumes: `spray_stock_types` constants; Settings account fields (Task 2).
- Produces: `SprayStockEntry` bound to `Stock Entry`.

- [ ] **Step 1: Write the subclass + account remap**

Create `upande_scp/serverscripts/store/spray_stock_entry.py`:

```python
"""Hard-override of stock-in-hand GL accounts for spray Manufacture (Chemical
Mixing) and Material Issue (Chemical Spray). Configured accounts win; blank ->
warehouse account (super's default). All other Stock Entries are untouched.

Accepted tradeoff (per design): posting stock value to a non-warehouse account
makes ERPNext's Stock<->GL comparison report diverge for those warehouses.
Double-entry still balances. This is a deliberate trial on a branch.
"""
import frappe
from erpnext.stock.doctype.stock_entry.stock_entry import StockEntry

from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_MIX, SE_TYPE_SPRAY

AFP_TYPE = "Application Floor Plan"


def _cfg(field):
    return frappe.db.get_single_value("Spray Plan Settings", field) or None


class SprayStockEntry(StockEntry):
    def get_gl_entries(self, inventory_account_map):
        gl = super().get_gl_entries(inventory_account_map)
        stype = getattr(self, "stock_entry_type", None)
        if stype not in (SE_TYPE_MIX, SE_TYPE_SPRAY):
            return gl
        wo = getattr(self, "work_order", None)
        if not wo or frappe.db.get_value("Work Order", wo, "custom_type") != AFP_TYPE:
            return gl

        # Warehouse stock accounts we may remap (values of inventory_account_map).
        wh_accounts = set((inventory_account_map or {}).values())
        raw = _cfg("spray_raw_chemical_account")
        tank = _cfg("spray_tank_mix_account")
        expense = _cfg("spray_expense_account")

        for row in gl:
            acct = row.get("account")
            if acct not in wh_accounts:
                continue  # leave non-stock rows (e.g. expense/difference) to the expense remap below
            debit = flt(row.get("debit"))
            credit = flt(row.get("credit"))
            if stype == SE_TYPE_MIX:
                # raw out = credit; tank-mix in = debit
                if credit and raw:
                    _swap(row, raw)
                elif debit and tank:
                    _swap(row, tank)
            elif stype == SE_TYPE_SPRAY:
                # tank-mix out = credit
                if credit and tank:
                    _swap(row, tank)
        # Spray expense (debit) side: retarget any expense row to spray_expense_account.
        if stype == SE_TYPE_SPRAY and expense:
            for row in gl:
                if row.get("account") not in wh_accounts and flt(row.get("debit")):
                    _swap(row, expense)
        return gl


from frappe.utils import flt  # noqa: E402


def _swap(row, account):
    row["account"] = account
    # keep against/cost_center/dimensions; only the account label changes
```

- [ ] **Step 2: Bind the class in hooks**

In `upande_scp/hooks.py`, replace the commented `override_doctype_class` block with:
```python
override_doctype_class = {
    "Stock Entry": "upande_scp.serverscripts.store.spray_stock_entry.SprayStockEntry",
}
```

- [ ] **Step 3: Migrate + import smoke**

Run: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate 2>&1 | tail -3 && env/bin/python -c "from upande_scp.serverscripts.store.spray_stock_entry import SprayStockEntry; print('import OK')"`
Expected: migrate clean; import OK. (Non-spray Stock Entry behaviour is delegated to super — the reconciliation test in Task 5 confirms the spray remap.)

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/serverscripts/store/spray_stock_entry.py upande_scp/hooks.py
git commit -m "feat(scp): override Stock Entry GL accounts for spray Mixing/Spray steps"
```

---

### Task 4: Static flowchart in Spray Plan Settings

**Files:**
- Modify: `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json` (add a `flow_section` + read-only `HTML` field `spray_flow_diagram`)

- [ ] **Step 1: Add an HTML field with the static diagram**

Add a `flow_section` (Section Break, "Flow") and an `HTML` field `spray_flow_diagram` whose `options` is inline HTML/SVG showing the 7 stages and, for the stock steps, the debit/credit accounts:

```json
  { "fieldname": "flow_section", "fieldtype": "Section Break", "label": "Flow" },
  { "fieldname": "spray_flow_diagram", "fieldtype": "HTML", "options": "<div style=\"font:13px/1.5 sans-serif\">…7-stage flow with CSU Chemical Transfer → Chemical Mixing (Cr raw / Dr tank-mix) → Chemical Spray (Cr tank-mix / Dr expense)…</div>" }
```

(Author the full inline HTML/SVG: boxes for Pending→…→Completed, and the three stock steps annotated Dr/Cr with the account roles. Static markup only — no external libs.)

- [ ] **Step 2: Migrate + eyeball in Desk**

Run: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate 2>&1 | tail -2`
Then open Spray Plan Settings in Desk → the Flow section renders the diagram.

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp
git add upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json
git commit -m "feat(scp): add spray-flow diagram to Spray Plan Settings"
```

---

### Task 5: Full-cycle reconciliation test (branch go/no-go)

No repo changes — this is the acceptance gate for the hard-override.

- [ ] **Step 1: Configure the three accounts**

In Desk (or via `frappe.db.set_single_value`), set `spray_raw_chemical_account`, `spray_tank_mix_account`, `spray_expense_account` on Spray Plan Settings to real Accounts on the test company.

- [ ] **Step 2: Run a full plan cycle**

Drive one AFP plan through: approve → CSU Chemical Transfer (biometric submit) → Chemical Mixing (CSU scans → Manufacture SE) → start → Chemical Spray (end session → Material Issue SE). Record the three SE names.

- [ ] **Step 3: Inspect GL per SE**

For the Manufacture + Material Issue SEs:
```bash
cd /home/ubuntu/stive/code/frappe15
env/bin/python - <<'PY'
import frappe
frappe.init(site="kaitet.local", sites_path="/home/ubuntu/stive/code/frappe15/sites"); frappe.connect()
for se in ["<MIX_SE>", "<SPRAY_SE>"]:
    rows = frappe.get_all("GL Entry", filters={"voucher_no": se},
        fields=["account","debit","credit"], order_by="account")
    tot_d = sum(r.debit for r in rows); tot_c = sum(r.credit for r in rows)
    print(se, "balanced" if round(tot_d-tot_c,2)==0 else "UNBALANCED", tot_d, tot_c)
    for r in rows: print("  ", r.account, r.debit, r.credit)
PY
```
Expected: Mixing → Cr `spray_raw_chemical_account`, Dr `spray_tank_mix_account`; Spray → Cr `spray_tank_mix_account`, Dr `spray_expense_account`; each SE debits == credits.

- [ ] **Step 4: Confirm fallback**

Blank one field, re-run a cycle → that side posts to the warehouse account instead (no error).

- [ ] **Step 5: Note the reconciliation divergence (expected)**

In Desk run **Stock and Account Value Comparison** (or Stock Ledger vs GL) for the affected warehouses/accounts and record the expected divergence. This is the documented tradeoff — its acceptability is the go/no-go call for merging the branch.

- [ ] **Step 6: Verdict**

If GL posts the configured accounts, balances, and the divergence is acceptable → the branch is a keep. Otherwise fall back to the warehouse-account approach (drop Task 3's remap, keep the named types + Settings display).

---

## Final checklist

- [ ] All four Stock Entry Types exist with correct `purpose`; flow sets the new type names; purpose-based dispatch unchanged.
- [ ] Three account fields on Spray Plan Settings; load/save works.
- [ ] `get_gl_entries` override remaps only spray Mixing/Spray SEs; non-spray SEs untouched; blank field → warehouse fallback.
- [ ] Flowchart renders in Settings.
- [ ] Full cycle: GL uses configured accounts, balances; reconciliation divergence recorded; go/no-go decided.
- [ ] All commits on `scp-spray-stock-accounting`; no `Co-Authored-By` trailer.
