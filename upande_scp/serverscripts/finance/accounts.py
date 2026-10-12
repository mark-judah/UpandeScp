"""Which expense account, and at what rate, a crop-protection line is costed (B2, B6).

Both answers are an ORDERED list of candidates, and the first one present wins.
The order is the decision; the lookups only fill the list. That split keeps the
order testable without a site (``first_present``) and lets a preview show the
user *where* each figure came from, not just the figure.

Expense account (B6):
    1. Item Default for (item, company)
    2. Item Group default for (group, company), nearest group first, then up the tree
    3. Scouting and Crop Protection Settings, per-company row: chemical or foliar column
    4. the old single ``default_chemical_expense_account`` — kept so a site that
       never filled the per-company table keeps working, and only when that account
       belongs to the company (it is one value for every company)
    5. the company's default expense account

Rate (B2), per stock UOM:
    1. the company's last purchase (Purchase Receipt, Purchase Invoice or Purchase Order)
    2. the Item's last purchase rate (ERPNext's own, not per company)
    3. the company's last valuation rate from the stock ledger
    4. the Item's valuation rate
    5. 0, with a warning — a zero is never silent
"""
from __future__ import annotations

import frappe
from frappe.utils import flt

from upande_scp.serverscripts.common import crop_protection

SETTINGS = "Scouting and Crop Protection Settings"
ACCOUNT_TABLE = "company_expense_accounts"


def first_present(candidates):
	"""``(value, source)`` of the first candidate with a value, else ``(None, None)``.

	``candidates`` is an iterable of ``(source, value)``; a value of 0, "" or None
	is absent. Pure.
	"""
	for source, value in candidates:
		if value:
			return value, source
	return None, None


def pick_rate(candidates) -> dict:
	"""The first positive rate, with where it came from; 0 and a warning otherwise."""
	value, source = first_present((s, flt(v) if flt(v) > 0 else 0) for s, v in candidates)
	if value:
		return {"rate": flt(value), "source": source, "warning": None}
	return {
		"rate": 0.0,
		"source": None,
		"warning": "no purchase or valuation rate on record — costed at 0",
	}


# ─────────────────────────────── accounts ────────────────────────────────────


def _item_group_chain(group: str | None) -> list[str]:
	"""The group and its ancestors, nearest first."""
	if not group:
		return []
	row = frappe.db.get_value("Item Group", group, ["lft", "rgt"], as_dict=True)
	if not row:
		return [group]
	return frappe.get_all(
		"Item Group",
		filters={"lft": ("<=", row.lft), "rgt": (">=", row.rgt)},
		order_by="lft desc",
		pluck="name",
	)


def settings_accounts(company: str) -> dict:
	"""``{"chemical": acc, "foliar": acc}`` from the per-company settings row."""
	if not company or not frappe.db.table_exists("SCP Company Expense Account"):
		return {}
	row = frappe.db.get_value(
		"SCP Company Expense Account",
		{"parent": SETTINGS, "parentfield": ACCOUNT_TABLE, "company": company},
		["chemical_expense_account", "foliar_expense_account"],
		as_dict=True,
	)
	if not row:
		return {}
	return {"chemical": row.chemical_expense_account, "foliar": row.foliar_expense_account}


def legacy_account(company: str) -> str | None:
	"""The old single setting, only where it belongs to `company`."""
	acc = frappe.db.get_single_value(SETTINGS, "default_chemical_expense_account")
	if acc and frappe.db.get_value("Account", acc, "company") == company:
		return acc
	return None


def expense_account_candidates(item_code: str, company: str, kind: str | None = None) -> list:
	group = frappe.db.get_value("Item", item_code, "item_group")
	kind = kind or crop_protection.classify_item_group(group) or "chemical"
	out = [(
		"item default",
		frappe.db.get_value(
			"Item Default", {"parent": item_code, "parenttype": "Item", "company": company},
			"expense_account",
		),
	)]
	for g in _item_group_chain(group):
		out.append((
			f"item group {g}",
			frappe.db.get_value(
				"Item Default",
				{"parent": g, "parenttype": "Item Group", "company": company},
				"expense_account",
			),
		))
	out.append((f"settings ({kind})", settings_accounts(company).get(kind)))
	out.append(("settings (single)", legacy_account(company)))
	out.append(("company default", frappe.db.get_value("Company", company, "default_expense_account")))
	return out


def resolve_expense_account(item_code: str, company: str, kind: str | None = None) -> dict:
	account, source = first_present(expense_account_candidates(item_code, company, kind))
	return {"account": account, "source": source}


def accounts_for_kind(company: str, kind: str) -> list[str]:
	"""Every expense account crop-protection spend of this kind can land on.

	What the Finance Budget view sums the GL over: the group defaults of the
	configured chemical/foliar groups, the settings row, and the legacy single.
	"""
	accs: list[str] = []
	groups = crop_protection.product_groups(kind)
	if groups:
		accs += frappe.get_all(
			"Item Default",
			filters={"parenttype": "Item Group", "parent": ("in", list(groups)),
			         "company": company, "expense_account": ("is", "set")},
			pluck="expense_account",
		)
	accs.append(settings_accounts(company).get(kind))
	if kind == "chemical":
		accs.append(legacy_account(company))
	out = []
	for a in accs:
		if a and a not in out:
			out.append(a)
	return out


# ──────────────────────────────── rates ──────────────────────────────────────


_PURCHASE_SQL = {
	"Purchase Receipt": (
		"""SELECT c.base_net_rate / NULLIF(c.conversion_factor, 0) AS r
		   FROM `tabPurchase Receipt Item` c JOIN `tabPurchase Receipt` p ON p.name = c.parent
		   WHERE p.docstatus = 1 AND p.company = %s AND c.item_code = %s AND c.base_net_rate > 0
		   ORDER BY p.posting_date DESC, p.posting_time DESC LIMIT 1"""
	),
	"Purchase Invoice": (
		"""SELECT c.base_net_rate / NULLIF(c.conversion_factor, 0) AS r
		   FROM `tabPurchase Invoice Item` c JOIN `tabPurchase Invoice` p ON p.name = c.parent
		   WHERE p.docstatus = 1 AND p.company = %s AND c.item_code = %s AND c.base_net_rate > 0
		   ORDER BY p.posting_date DESC LIMIT 1"""
	),
	"Purchase Order": (
		"""SELECT c.base_net_rate / NULLIF(c.conversion_factor, 0) AS r
		   FROM `tabPurchase Order Item` c JOIN `tabPurchase Order` p ON p.name = c.parent
		   WHERE p.docstatus = 1 AND p.company = %s AND c.item_code = %s AND c.base_net_rate > 0
		   ORDER BY p.transaction_date DESC LIMIT 1"""
	),
}


def _company_purchase_rate(item_code: str, company: str) -> float:
	for sql in _PURCHASE_SQL.values():
		rows = frappe.db.sql(sql, (company, item_code))
		if rows and flt(rows[0][0]) > 0:
			return flt(rows[0][0])
	return 0.0


def _company_valuation_rate(item_code: str, company: str) -> float:
	rows = frappe.db.sql(
		"""SELECT valuation_rate FROM `tabStock Ledger Entry`
		   WHERE item_code = %s AND company = %s AND is_cancelled = 0 AND valuation_rate > 0
		   ORDER BY posting_datetime DESC, creation DESC LIMIT 1""",
		(item_code, company),
	)
	return flt(rows[0][0]) if rows else 0.0


def rate_candidates(item_code: str, company: str) -> list:
	item = frappe.db.get_value(
		"Item", item_code, ["last_purchase_rate", "valuation_rate"], as_dict=True
	) or frappe._dict()
	return [
		("last purchase (company)", _company_purchase_rate(item_code, company)),
		("last purchase rate (item)", item.last_purchase_rate),
		("valuation (company)", _company_valuation_rate(item_code, company)),
		("valuation rate (item)", item.valuation_rate),
	]


def resolve_rate(item_code: str, company: str) -> dict:
	return pick_rate(rate_candidates(item_code, company))
