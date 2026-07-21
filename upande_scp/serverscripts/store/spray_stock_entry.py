"""Hard-override of stock-in-hand GL accounts for spray Manufacture (Chemical
Mixing) and Material Issue (Chemical Spray). Configured accounts win; blank ->
warehouse account (super's default). All other Stock Entries are untouched.

Accepted tradeoff (per design): posting stock value to a non-warehouse account
makes ERPNext's Stock<->GL comparison report diverge for those warehouses.
Double-entry still balances. This is a deliberate trial on a branch.
"""
import frappe
from erpnext.stock.doctype.stock_entry.stock_entry import StockEntry
from frappe.utils import flt

from upande_scp.serverscripts.store.spray_stock_types import SE_TYPE_MIX, SE_TYPE_SPRAY

AFP_TYPE = "Application Floor Plan"


def _cfg(field):
    return frappe.db.get_single_value("Spray Plan Settings", field) or None


def _swap(row, account):
    row["account"] = account
    # keep against/cost_center/dimensions; only the account label changes


class SprayStockEntry(StockEntry):
    def get_gl_entries(self, inventory_account_map):
        gl = super().get_gl_entries(inventory_account_map)
        stype = getattr(self, "stock_entry_type", None)

        if stype == SE_TYPE_MIX:
            # Manufacture purpose preserves work_order; require it to be an AFP WO.
            wo = getattr(self, "work_order", None)
            if not wo or frappe.db.get_value("Work Order", wo, "custom_type") != AFP_TYPE:
                return gl
        elif stype != SE_TYPE_SPRAY:
            # Not a spray-related Stock Entry type at all.
            return gl
        # else stype == SE_TYPE_SPRAY: purpose is Material Issue, and ERPNext core's
        # validate_work_order() unconditionally nulls self.work_order for any purpose
        # other than Material Transfer -- so work_order never survives to this point
        # for a real Chemical Spray SE. The stock_entry_type itself is a sufficient,
        # exclusive signal (only the spray flow creates this type), so it is gated
        # on stype alone, with no work_order requirement.

        # Warehouse stock accounts we may remap (values of inventory_account_map,
        # which on this ERPNext version are account-info dicts, not plain strings).
        wh_accounts = {
            (v.get("account") if isinstance(v, dict) else v)
            for v in (inventory_account_map or {}).values()
        }
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

        # Mixing valuation residual/difference (debit) side: fold any leftover
        # non-warehouse debit row (e.g. a rounding/difference row ERPNext posts
        # outside the warehouse accounts) into the tank-mix account. Rows already
        # remapped above to raw/tank are left as-is (re-assigning tank is a no-op).
        if stype == SE_TYPE_MIX and tank:
            for row in gl:
                if row.get("account") not in wh_accounts and flt(row.get("debit")):
                    _swap(row, tank)

        return gl
