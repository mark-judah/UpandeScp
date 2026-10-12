# Finance and procurement on ERPNext cost centres and budgets — design

Date: 2026-10-12. Built lean: one build, then one review.

## What the user asked for

"Map that matrix against a cost center and the budget according to ERP defaults." Also, from 2026-10-11, finance and procurement are one money flow: purchase → stock → consumption → cost.

## Facts (read-only diagnosis, 2026-10-12)

**Finance report** (`reports/finances.py`, `Finance.tsx`)
- It values chemical and foliar stock leaving a store: qty × valuation on Stock Entry lines, either Material Transfer for Manufacture (store → CSU) or Material Issue not out of a CSU.
- It attributes that spend to a farm, a greenhouse and a target.
- It never reads the GL, accounts or Budgets.
- The ledger books the expense later, on the Chemical Spray issue, to `Chemicals Expense - KR` on the plan's greenhouse cost centre.

**Procurement** (`store/procurement.py`, `apportion.py`)
- The matrix is farm × item, in quantities only: requirement, the GM's cut, the allocation and credits, then transfers.
- No cycle doctype holds a rate, amount, account or cost centre.
- One draft Purchase Material Request per cycle, company-level, into the general store. It sets no rate (0), no farm and no cost centre, so its rows fall back to `Main - KR` and their budget check checks nothing.
- `consumption_vs_allocation` counts every outgoing movement, including transfers to the CSU, as consumption.

**ERPNext v16** (the new budget controller, `use_legacy_budget_controller = 0`)
- A Budget is one record per company × cost centre (or dimension) × expense account × period, with Stop/Warn/Ignore actions for MR, PO and actual expense.
- MR/PO rows are checked by their `cost_center` + `expense_account` + amount (rate × qty). Actual expense is checked from GL lines.
- A Budget on a **group** cost centre is copied onto each child, and each child is checked alone against the whole amount. The Budget Variance report does sum the subtree.

**kaitet.local data**
- There are 0 Budgets.
- The only Fiscal Year is 2026, but GL rows carry "2025".
- **Karen Roses cost centres**
  - The tree is farm group → greenhouse leaf: `Simotwo  Farm - KR` (double space) → `Simotwo GH14 - KR`.
  - Three nodes are filed under the wrong parent: `KarenGH10` and `Main - KR` sit under PH - Post Harvest, and `Torongo GH18` sits under Karen Farm.
  - 51% of chemical expense (83.2M) is on `Main - KR`.
- **Links**
  - `Warehouse.custom_cost_center`: 0 of 295 filled. Name matching resolves 101 of 121 greenhouse warehouses.
  - `Cost Center.custom_farm`: 0 filled.
  - Farm has no cost-centre link.
- Farm and Business Unit are accounting dimensions; `budget_against` cannot be Farm.
- **Expense accounts**
  - Karen Roses: CHEMICALS, Adjuvants and Chemical Mix → `Chemicals Expense - KR`; Fertilizer and Foliar Solutions → `Fertilizer Expenses - KR`. AVOCADO CHEMICALS and Weeding Solutions have none.
  - Kaitet Ltd. chemical groups have none; its account is `50101702 - Chemical Pest & Disease Control - KL`.
  - `default_chemical_expense_account` is one value for all companies.

## Decisions

The user chose B1, B2 and B3 on 2026-10-12. The rest follow the recommended options.

| # | Decision |
|---|---|
| B1 | **Budget level: each farm's cost-centre group, Warn only.**<br>• One ERPNext Budget per farm group cost centre × expense account (chemical, and foliar/fertiliser separately) × fiscal year (or cycle period).<br>• Actions are **Warn** on MR, PO and actual expense, because v16 copies a group budget to each child.<br>• The Budget Variance report gives the true farm total. SCP enforces the farm total itself in procurement (B5). |
| B2 | **The procurement MR: one MR per cycle, with one row per item × farm.**<br>Each row carries:<br>• `cost_center` = the farm's cost centre for purchases (B4);<br>• `farm` = the Farm dimension;<br>• `expense_account` = resolved Item → Item Group → company default (B6);<br>• `rate` = last purchase rate for the company, else valuation rate, else 0 with a warning.<br>The MR stays a draft for purchasing (unchanged decision). The rows match the allocation line by line. |
| B3 | **Budgets come from the cycle: SCP drafts them, the GM submits.**<br>• Closing (approving) a cycle writes **draft** Budgets: approved qty × rate per farm, grouped per farm cost centre × account × the cycle's fiscal year.<br>• The GM reviews and submits them in ERPNext; Accounts can still edit them.<br>• It is idempotent: it updates SCP-drafted Budgets that are still drafts, never submitted ones. It is tagged so SCP knows which are its own (a custom field `custom_scp_procurement_cycle` on Budget). |
| B4 | **Farm ↔ cost centre.**<br>• New SCP custom field `Farm.custom_cost_center` (Link Cost Center, **group**): the farm's cost-centre tree.<br>• New field `Farm.custom_purchase_cost_center` (Link Cost Center, **leaf**, optional): where farm-level purchases and unattributed issues book.<br>• When the purchase field is empty, a leaf named `<Farm> Crop Protection - <abbr>` under the farm group is used. A one-off helper offers to create it; it is not auto-created on live.<br>• `match_cost_center` checks `Warehouse.custom_cost_center` first, as today. |
| B5 | **The farm total in procurement.**<br>• The cycle shows money next to quantities: requirement, approved and allocated value per farm (qty × rate) and the farm's Budget, if one exists.<br>• Approval warns when a farm's approved value exceeds its Budget. It warns, never blocks, in line with B1. |
| B6 | **Accounts.**<br>• `default_chemical_expense_account` becomes a per-company table in Scouting and Crop Protection Settings, with a row per company and a chemical account and a foliar account.<br>• The single field is kept as the fallback for existing sites.<br>• The expense account is resolved per row as Item Default → Item Group default → settings row → company default expense account. |
| B7 | **Finance: actual vs budget.**<br>• A new **Budget** view on the Finance page shows, per farm, the GL expense on the chemical and foliar accounts for the farm cost-centre subtree, against the submitted ERPNext Budgets and the cycle's approved value.<br>• Actual spend comes from GL Entry. The **stock-based target report stays** for the per-pest breakdown.<br>• A reconciling line explains the difference: stock moved to a CSU but not yet sprayed (stock-based minus GL).<br>• Scope: the user's visible farms; the crop filter applies via farm. |
| B8 | **Mapping repair, one-off and safe.**<br>`scripts`/a whitelisted admin function `cost_centre_mapping.audit(company, apply=False)`:<br>• fills `Warehouse.custom_cost_center` from the existing matcher;<br>• fills `Cost Center.custom_farm` for each farm group and its leaves;<br>• proposes `Farm.custom_cost_center`;<br>• lists unmatched warehouses and misfiled leaves (a greenhouse leaf under the wrong farm, or under Post Harvest).<br>It is **dry run by default** and never moves cost centres. Moving `Main - KR`, `KarenGH10` or `Torongo GH18` is reported for Accounts to decide. Apply it on kaitet.local only. |
| B9 | **No silent fallback to `Main - KR`.**<br>• When SCP stamps a cost centre (issues, CSU transfers, loans, procurement MR) and no farm or greenhouse cost centre resolves, it uses the farm's purchase cost centre (B4).<br>• If there is still none, it logs a warning on the document (a Comment) and in the SCP log, instead of silently falling back to the company default.<br>• It does not block; a later setting can. |
| B10 | **`consumption_vs_allocation` counts consumption only:** Material Issue and the Chemical Spray issue out of the farm's stores and CSUs, not transfers between the farm's own stores. |
| B11 | **Out of scope:**<br>• moving cost centres;<br>• creating Fiscal Year 2025 (reported as a data gap);<br>• Purchase Orders and Receipts, which aren't loaded locally (the PO inherits MR rows by ERPNext default);<br>• the per-target cost (finance item 9, already built);<br>• the Kaitet Ltd. coffee and avocado block cost-centre restructure (reported only).<br>`custom_business_unit` remains as it is. |

## Testing

- **Pure tests:**
  - the rate resolution order;
  - the account resolution order;
  - grouping allocation into Budget rows;
  - the reconciling line.
- **DB tests (rolled back):**
  - the MR has a row per item × farm with cost_center, farm, expense_account and rate;
  - draft Budgets are written and updated idempotently, and submitted ones are untouched;
  - the B5 warning;
  - B9 never falls back silently;
  - the mapping audit dry run changes nothing and apply fills the links;
  - B10 excludes internal transfers.
- **Vitest:** the Finance Budget view, and the procurement money columns and warning.
- **Real run on kaitet.local:**
  - the mapping audit dry run, then apply;
  - re-create the MR for the latest cycle as a dry-run preview (no insert) and show its rows;
  - draft Budgets for that cycle;
  - the Finance Budget view numbers for Karen Roses by farm.
