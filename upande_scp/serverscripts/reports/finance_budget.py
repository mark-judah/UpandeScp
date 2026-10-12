"""Finance, Budget view: what the ledger says each farm spent, against its Budget (B7).

Per farm, per kind (chemical, foliar):

* **actual** — GL Entry on the company's chemical/foliar expense accounts, summed
  over the farm's cost-centre subtree (``Farm.custom_cost_center``) for the period.
  This is what ERPNext's Budget Variance report would show for the same tree.
* **budget** — submitted ERPNext Budgets on that subtree and those accounts, for
  the fiscal years the period touches (annual amounts, as ERPNext holds them),
  with SCP's own drafts shown apart.
* **approved** — the value of procurement cycles approved for periods that
  overlap the chosen one (``finance.budgets``).
* **stock based** — the target report's figure: product valued as it leaves the
  store for use (``reports.finances``).
* **reconciling** — stock based minus actual. Mostly product moved into a CSU but
  not yet sprayed: the stock report counts it on the transfer, the ledger books
  the expense on the spray. A large figure the other way is usually expense
  booked to a farm cost centre from somewhere SCP does not see.

Spend on the same accounts booked outside every mapped farm's tree (``Main - KR``)
is listed under ``outside`` rather than spread across farms it may not belong to.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt, getdate, now_datetime

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.finance import accounts as acc
from upande_scp.serverscripts.finance import budgets as fb
from upande_scp.serverscripts.finance.cost_centres import farm_company, farm_cost_center
from upande_scp.serverscripts.reports.finances import UNASSIGNED_FARM, _ensure_finance_role

KINDS = ("chemical", "foliar")


# ─────────────────────────────── pure parts ──────────────────────────────────


def reconcile(stock_based: float, actual: float | None) -> float | None:
	"""Stock-based minus GL; None when the farm has no cost centre to read. Pure."""
	if actual is None:
		return None
	return round(flt(stock_based) - flt(actual), 2)


def _blank() -> dict:
	return {"actual": 0.0, "budget": 0.0, "draft_budget": 0.0, "approved": 0.0, "stock_based": 0.0}


def shape_farm(farm: str, company: str | None, cost_center: str | None, kinds: dict) -> dict:
	"""One farm's row, both kinds and their sum, with the reconciling line. Pure."""
	mapped = bool(cost_center)
	out_kinds = {}
	for k in KINDS:
		v = {**_blank(), **(kinds.get(k) or {})}
		actual = round(v["actual"], 2) if mapped else None
		out_kinds[k] = {
			"actual": actual,
			"budget": round(v["budget"], 2),
			"draft_budget": round(v["draft_budget"], 2),
			"approved": round(v["approved"], 2),
			"stock_based": round(v["stock_based"], 2),
			"reconciling": reconcile(v["stock_based"], actual),
		}
	total = {
		key: (None if not mapped and key in ("actual", "reconciling")
		      else round(sum(flt(out_kinds[k][key]) for k in KINDS), 2))
		for key in ("actual", "budget", "draft_budget", "approved", "stock_based", "reconciling")
	}
	return {
		"farm": farm,
		"company": company,
		"cost_center": cost_center,
		"mapped": mapped,
		"kinds": out_kinds,
		**total,
	}


# ─────────────────────────────── the report ──────────────────────────────────


def _visible_farms(farm_scope) -> list[str]:
	if farm_scope is not None:
		return sorted(farm_scope)
	rows = frappe.get_all("Farm", pluck="name")
	# Unscoped: farms that take part in crop protection at all.
	return sorted(
		f for f in rows
		if farm_cost_center(f)
		or frappe.db.get_value("Farm", f, "custom_chemical_store")
		or frappe.db.get_value("Farm", f, "custom_fertilizer_store")
	)


def _subtree(cc: str) -> tuple[int, int] | None:
	row = frappe.db.get_value("Cost Center", cc, ["lft", "rgt"], as_dict=True)
	return (row.lft, row.rgt) if row else None


def _fiscal_years(company: str, from_date, to_date) -> list[str]:
	return frappe.db.sql_list(
		"""SELECT fy.name FROM `tabFiscal Year` fy
		   WHERE fy.disabled = 0 AND fy.year_start_date <= %(t)s AND fy.year_end_date >= %(f)s
		     AND (NOT EXISTS (SELECT 1 FROM `tabFiscal Year Company` c WHERE c.parent = fy.name)
		          OR EXISTS (SELECT 1 FROM `tabFiscal Year Company` c
		                     WHERE c.parent = fy.name AND c.company = %(c)s))
		   ORDER BY fy.year_start_date""",
		{"f": from_date, "t": to_date, "c": company},
	)


@frappe.whitelist()
def budget_vs_actual(from_date: str, to_date: str, crop: str | None = None) -> dict:
	_ensure_finance_role()
	canon = crop_catalog.resolve_crop(crop) if crop else ""
	farm_scope = crop_scope.scoped_farms(canon or None)
	farms = _visible_farms(farm_scope)

	info = {f: {"company": farm_company(f), "cc": farm_cost_center(f)} for f in farms}
	companies = sorted({v["company"] for v in info.values() if v["company"]})
	kinds: dict[str, dict] = {f: {k: _blank() for k in KINDS} for f in farms}
	outside: list[dict] = []
	notes: list[str] = []
	years: dict[str, list[str]] = {}

	for company in companies:
		kind_accounts = {k: acc.accounts_for_kind(company, k) for k in KINDS}
		account_kind = {a: k for k in KINDS for a in kind_accounts[k]}
		if not account_kind:
			notes.append(f"{company}: no chemical or foliar expense account is configured.")
			continue
		mine = [f for f in farms if info[f]["company"] == company]
		trees = {f: _subtree(info[f]["cc"]) for f in mine if info[f]["cc"]}

		# actual: one GL pass for the company, mapped onto farm subtrees
		gl = frappe.db.sql(
			"""SELECT g.cost_center, g.account, cc.lft, SUM(g.debit - g.credit) amt
			   FROM `tabGL Entry` g LEFT JOIN `tabCost Center` cc ON cc.name = g.cost_center
			   WHERE g.company = %s AND g.is_cancelled = 0 AND g.account IN %s
			     AND g.posting_date BETWEEN %s AND %s
			   GROUP BY g.cost_center, g.account""",
			(company, tuple(account_kind), from_date, to_date),
			as_dict=True,
		)
		all_trees = [
			_subtree(c) for c in frappe.get_all(
				"Farm", filters={"custom_cost_center": ("is", "set")}, pluck="custom_cost_center"
			) if frappe.db.get_value("Cost Center", c, "company") == company
		] if frappe.db.has_column("Farm", "custom_cost_center") else []
		for r in gl:
			k = account_kind.get(r.account)
			owner = next(
				(f for f, t in trees.items() if t and r.lft is not None and t[0] <= r.lft <= t[1]), None
			)
			if owner:
				kinds[owner][k]["actual"] += flt(r.amt)
			elif not any(t and r.lft is not None and t[0] <= r.lft <= t[1] for t in all_trees) and flt(r.amt):
				outside.append({"company": company, "cost_center": r.cost_center or "(none)",
				                "kind": k, "amount": flt(r.amt)})

		# budgets: submitted, and SCP's drafts apart
		fys = _fiscal_years(company, from_date, to_date)
		years[company] = fys
		if fys and trees:
			buds = frappe.db.sql(
				"""SELECT b.cost_center, b.account, b.budget_amount, b.docstatus, cc.lft
				   FROM `tabBudget` b JOIN `tabCost Center` cc ON cc.name = b.cost_center
				   WHERE b.docstatus < 2 AND b.company = %s AND b.budget_against = 'Cost Center'
				     AND b.account IN %s AND b.from_fiscal_year IN %s""",
				(company, tuple(account_kind), tuple(fys)),
				as_dict=True,
			)
			for b in buds:
				owner = next((f for f, t in trees.items() if t and t[0] <= b.lft <= t[1]), None)
				if not owner:
					continue
				key = "budget" if b.docstatus == 1 else "draft_budget"
				kinds[owner][account_kind[b.account]][key] += flt(b.budget_amount)

		# approved cycle value, for cycles whose period overlaps
		cycles = frappe.get_all(
			fb.CYCLE,
			filters={
				"company": company,
				"status": ("in", fb.APPROVED_STATES),
				"period_start": ("<=", to_date),
				"period_end": (">=", from_date),
			},
			pluck="name",
		)
		cache: dict = {}
		for c in cycles:
			for l in fb.cycle_lines(c, cache)["lines"]:
				if l["farm"] in kinds:
					kinds[l["farm"]][l["kind"] if l["kind"] in KINDS else "chemical"]["approved"] += l["value"]

	# stock based, from the target report (same scope)
	from upande_scp.serverscripts.reports.finances import chemical_cost_by_target

	stock = chemical_cost_by_target(from_date, to_date, crop=crop)
	unassigned = 0.0
	for fo in stock["farms"]:
		for row in fo["rows"]:
			if fo["farm"] in kinds:
				kinds[fo["farm"]][row["kind"]]["stock_based"] += flt(row["total"])
			else:
				unassigned += flt(row["total"])
	for u in stock["unattributed"]:
		if u["farm"] in kinds:
			kinds[u["farm"]][u["kind"]]["stock_based"] += flt(u["value"])
		else:
			unassigned += flt(u["value"])

	out = [shape_farm(f, info[f]["company"], info[f]["cc"], kinds[f]) for f in farms]
	outside_sorted = sorted(
		({**o, "amount": round(o["amount"], 2)} for o in outside), key=lambda o: -o["amount"]
	)
	unmapped = [o["farm"] for o in out if not o["mapped"]]
	if unmapped:
		notes.append(
			"No cost-centre group on " + ", ".join(unmapped)
			+ " — set the farm's cost-centre group (Farm.custom_cost_center; the mapping"
			" audit proposes one) to read their ledger."
		)
	mapped = [o for o in out if o["mapped"]]
	return {
		"as_of": now_datetime().isoformat(timespec="seconds"),
		"currency": frappe.db.get_default("currency") or "KES",
		"from_date": str(getdate(from_date)),
		"to_date": str(getdate(to_date)),
		"fiscal_years": years,
		"farms": out,
		"outside": outside_sorted,
		"outside_total": round(sum(o["amount"] for o in outside_sorted), 2),
		"stock_unassigned": round(unassigned, 2),
		"totals": {
			key: round(sum(flt(o[key]) for o in mapped), 2)
			for key in ("actual", "budget", "draft_budget", "approved", "stock_based", "reconciling")
		},
		"notes": notes,
	}
