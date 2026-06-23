# Step 6 — Direct CSU drain (transfer-out + issue-out, no manufacture)

**Date:** 2026-06-21
**Status:** Approved (design) — pending spec review
**File to create:** `doc references/fixes/spray_plan_issue/new/6_direct_issue_console.py`

## Problem

The spray-plan RE-DATE runbook (steps 1–5) moves AFP Work Orders through:
plan → transfer into CSU (`Chemical Issued`) → **Manufacture** (CSU raw → tank-mix
FG into greenhouse, `Tank Mix Manufactured`) → **Material Issue** (FG out of the
greenhouse on its date).

A residue of WOs is stuck in `Chemical Issued`: their chemicals were transferred
into the CSU but they **cannot be manufactured** (step 3 skips them — transfer ≠
floor plan, CSU drained, no usable BOM, etc.). These have now been sitting in the
CSU for more than 5 days. We need to clear them so the CSU is drained and the cost
lands in the correct month, **without manufacturing a tank mix**.

## Approach (approved)

Replicate the *warehouse path* of the successful pipeline but skip the manufacture:
per WO, move the **individual raw chemicals** CSU → greenhouse (Material Transfer),
then issue those **individual chemicals** out of the greenhouse (Material Issue, à
la step 4). No finished good, no `Manufacture` Stock Entry.

The greenhouse hop is retained (two Stock Entries) so the stock leaves from the
greenhouse and the greenhouse cost centre carries the issue — mirroring the
manufacture pipeline, where the FG is produced into and issued from the greenhouse.

## Selection (scope)

Candidate WOs:
- `custom_type = "Application Floor Plan"`, `docstatus = 1`
- `workflow_state = "Chemical Issued"`
- latest **Material Transfer for Manufacture into the CSU** (`wip_warehouse`) date is
  **more than `STALE_DAYS` (default 5) days before today**.

Config knobs (match the other steps):
- `DRY_RUN = True` (default; nothing written until set False)
- `ONLY_WORK_ORDERS = []` allow-list (ignores STALE/batch when set)
- `BATCH_SIZE = 100` per run (re-run for the next batch; drained WOs leave scope)
- `STALE_DAYS = 5`
- `ALLOW_ZERO_VALUATION = True` (these are problem WOs we want cleared; zero-valued
  rows pass with `allow_zero_valuation_rate` + a printed warning)
- `SHOW_TRACEBACK = True` (full traceback to Error Log on failure, one-line ref printed)

## Per-WO procedure (two Stock Entries, one DB transaction)

For each candidate WO:

1. **Re-derive the greenhouse cost centre** via the shared `match_cost_center`
   fuzzy helper (explicit `custom_cost_center` → exact Cost Center name → `norm_key`
   fuzzy). No match → SKIP (`skip_no_cc`), no fallback centre.

2. **Build the chemical list** = `transferred_into(wo, wip_warehouse)` — the exact
   quantities this WO's submitted Material-Transfer-for-Manufacture delivered into
   the CSU. This is "floor-plan-is-truth" (same basis as step 3's
   `CONSUME_TRANSFERRED`): we clear what this WO actually put into the CSU, NOT the
   stale `required_qty` and NOT the shared live bin. Empty → SKIP (`skip_no_transfer`).

3. **Resolve the greenhouse warehouse** = `fg_warehouse` or `custom_greenhouse`.
   If it (or the CSU) is a disabled Warehouse → SKIP (`skip_disabled_wh`).

4. **Stock gate (skip, never error):** posting is backdated to the original transfer
   date, and the CSU bin is shared across WOs, so a backdated removal must not drive
   the bin negative at any point. For each chemical, require the **minimum running
   CSU balance over the window [transfer_date, now] ≥ qty**. Any shortfall → SKIP
   (`skip_short`) listing the short components. (ERPNext's own negative-stock check
   would also catch this on submit; the pre-check makes the skip clean and labelled.)

5. **Anchor date:** `anchor = latest_transfer_date(wo)` (the WO's last submitted
   Material-Transfer-into-CSU posting date). Falls back to today only if somehow
   absent (such a WO would not be in scope anyway).

6. **SE #1 — Material Transfer (CSU → greenhouse):**
   - `stock_entry_type = purpose = "Material Transfer"`
   - one row per chemical: `item_code`, `qty`, `s_warehouse = wip`, `t_warehouse = greenhouse`
   - `basic_rate` from the CSU bin valuation where > 0 (carries valuation across)
   - `cost_center` = greenhouse cost centre on each row
   - `set_posting_time = 1`, `posting_date = anchor`, `posting_time = "23:59:56"`
   - `remarks` name the WO and "step 6 direct drain"
   - insert + submit

7. **SE #2 — Material Issue (greenhouse → out):** (mirrors step 4)
   - `stock_entry_type = purpose = "Material Issue"`, `company` from the WO
   - one row per chemical: `item_code`, `qty`, `s_warehouse = greenhouse`,
     `expense_account = CHEMICALS_EXPENSE_ACCOUNT`, `cost_center` = greenhouse centre
   - `difference_account = CHEMICALS_EXPENSE_ACCOUNT` (SE-level balancing leg also
     hits Chemicals Expense, not the default Stock Adjustment account)
   - `set_posting_time = 1`, `posting_date = anchor`, `posting_time = "23:59:57"`
     (just after the transfer, so the greenhouse holds the stock)
   - `custom_employee_data` = one employee resolved per-WO by the **same**
     `resolve_issuer` chain as step 4 (spray-team supervisor text → WO structured
     team → Spray Team master → `ISSUING_EMPLOYEE` fallback). Satisfies the PPE
     server-script guard ("PPE Issuance Assignment Creation" rejects any Material
     Issue lacking exactly one employee). Chemicals here are NOT PPE items, so no
     Employee PPE Assignment is created — the employee is ceremonial.
   - `custom_original_stock_entry = <SE #1 name>` (links the pair for audit)
   - `allow_zero_valuation_rate = 1` per row when `ALLOW_ZERO_VALUATION`
   - `remarks` name the WO + the transfer SE
   - insert + submit

8. **End state:** `frappe.db.set_value("Work Order", wo, "workflow_state",
   "Chemicals Issued Direct")` (direct field write, bypassing workflow transitions —
   the same mechanism every other step uses). Add a Workflow comment naming both SEs.
   This removes the WO from the `Chemical Issued` selection.

9. **Transaction:** do NOT commit between the two SEs. After both submit and the
   state is set, `frappe.db.commit()` once. Any exception → `frappe.db.rollback()`
   (undoes both uncommitted SEs and the state change) + log to Error Log.

## Idempotency

The `workflow_state → "Chemicals Issued Direct"` transition removes a drained WO
from the `Chemical Issued` selection, so a re-run never re-drains it. Per-WO commit
means a mid-run failure leaves earlier WOs done and the failed WO fully rolled back.

## Cost / GL summary

- Material Transfer: stock-to-stock, no expense GL; valuation carried CSU→GH; rows
  carry the greenhouse cost centre.
- Material Issue: debits **Chemicals Expense** (`50100301 - Chemicals Expense - KR`),
  cost centre = the greenhouse's, posted on the original transfer date so the cost
  lands in the month the chemicals were committed.

## Output

Header echoing config; per-WO lines (greenhouse, cost centre, chemical list, dates,
employee, the two SE names); and a summary block: in-scope total, this batch,
drained, skipped (no-cc / no-transfer / short / disabled-wh), errors, and total
value issued with a value-by-month breakdown. Dry-run prints "WOULD" actions.

## Shared helpers (lifted from steps 3/4, kept RestrictedPython-safe)

`flt`, `norm_key`, `match_cost_center`, `latest_transfer_date`, `transferred_into`,
`bin_qty`, the `resolve_issuer` family (`name_of`, `best_by_role`, `from_roster_text`,
`from_wo_team`, `from_team_master`), `disabled_warehouses`. New helper:
`min_csu_balance_since(item, warehouse, on_date)` — cumulative running balance from
`tabStock Ledger Entry` ordered by posting datetime, returning the minimum over the
window, for the negative-stock-safe stock gate.

## Constants

- `AFP_TYPE = "Application Floor Plan"`
- `STATE_IN = "Chemical Issued"`
- `STATE_OUT = "Chemicals Issued Direct"`
- `CHEMICALS_EXPENSE_ACCOUNT = "50100301 - Chemicals Expense - KR"`
- `ISSUING_EMPLOYEE = "101394"` (fallback)
- `EMPLOYEE_ROLE_PRIORITY = ["Supervisor", "Pump Operator", "Sprayer"]`
- `TRANSFER_TIME = "23:59:56"`, `ISSUE_TIME = "23:59:57"`, `TOL = 0.0001`

## Out of scope

- No changes to steps 1–5 or to any app code; this is a standalone console script.
- No manufacture / BOM / finished-good handling.
- No reversal companion (the existing 2a/2b/3r reversers are not needed here; if a
  step-6 run must be undone, cancel the two SEs and reset the state manually).
