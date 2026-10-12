"""A procurement cycle in money, and the ERPNext Budgets it drafts (B2, B3, B5).

The cycle's matrix is farm x item in quantities. Costing it needs three things
per line: the farm's split of the approved quantity, a rate and an expense
account. The split is the allocation the cycle will publish
(``procurement.preview_allocation``) with the rounding remainder folded into the
farm with the largest share, so the rows add up to exactly what is ordered.

Budgets (B1, B3): one per farm cost-centre GROUP x expense account x fiscal
year, every action Warn. ERPNext allows one Budget per cost centre x account x
overlapping fiscal year, so a year with several cycles gets ONE Budget whose
amount is the sum of every approved cycle in that year — re-drafting is
idempotent. SCP only touches Budgets it drafted (``custom_scp_procurement_cycle``)
that are still drafts; a submitted Budget, or one Accounts made, is reported and
left alone.
"""
from __future__ import annotations

import frappe
from frappe.utils import cint, flt, getdate

from upande_scp.serverscripts.finance import accounts as acc
from upande_scp.serverscripts.finance.cost_centres import farm_cost_center, farm_purchase_cost_center

CYCLE = "Chemical Procurement Cycle"
TAG = "custom_scp_procurement_cycle"
#: A cycle in one of these has an approved figure that commits money.
APPROVED_STATES = ("Approved", "Ordered", "Received", "Allocated", "Closed")
WARN = "Warn"


# ─────────────────────────────── pure parts ──────────────────────────────────


def fold_remainder(allocations: list[dict], remainder: float) -> dict[str, float]:
	"""``{farm: qty}`` from an apportionment, the remainder given to the largest share.

	Ties break on the larger request, then the farm name, so the answer never
	changes between runs. Pure.
	"""
	out = {a["farm"]: flt(a.get("allocated")) for a in allocations if a.get("farm")}
	if flt(remainder) > 0 and allocations:
		top = sorted(
			(a for a in allocations if a.get("farm")),
			key=lambda a: (-flt(a.get("allocated")), -flt(a.get("requested")), a["farm"]),
		)
		if top:
			out[top[0]["farm"]] = round(out[top[0]["farm"]] + flt(remainder), 9)
	return {f: q for f, q in out.items() if q > 0}


def group_budget_rows(lines: list[dict]) -> tuple[list[dict], list[dict]]:
	"""Fold costed lines into Budget rows: farm group x account. Pure.

	Each line needs ``farm``, ``farm_group``, ``account`` and ``value``. Lines
	without a group or an account cannot become a Budget and come back as skipped,
	with the reason.
	"""
	rows: dict = {}
	skipped = []
	for l in lines:
		if not flt(l.get("value")):
			continue
		if not l.get("farm_group"):
			skipped.append({**l, "why": "the farm has no cost-centre group (Farm.custom_cost_center)"})
			continue
		if not l.get("account"):
			skipped.append({**l, "why": "no expense account resolved"})
			continue
		key = (l["farm_group"], l["account"])
		r = rows.setdefault(key, {
			"cost_center": l["farm_group"], "account": l["account"], "farm": l.get("farm"),
			"amount": 0.0, "items": set(), "cycles": set(),
		})
		r["amount"] += flt(l["value"])
		r["items"].add(l.get("item_code"))
		if l.get("cycle"):
			r["cycles"].add(l["cycle"])
	out = []
	for (cc, account), r in sorted(rows.items()):
		out.append({**r, "amount": round(r["amount"], 2), "items": sorted(i for i in r["items"] if i),
		            "cycles": sorted(r["cycles"])})
	return out, skipped


def over_budget(committed: float, budget: float | None) -> bool:
	"""B5: warn when a farm's committed value exceeds a Budget that exists. Pure."""
	return budget is not None and flt(budget) > 0 and flt(committed) > flt(budget) + 0.005


# ─────────────────────────────── costing ─────────────────────────────────────


def _fiscal_year(date, company) -> str | None:
	from erpnext.accounts.utils import get_fiscal_year

	try:
		return get_fiscal_year(date, company=company)[0]
	except Exception:
		return None


def cycle_lines(cycle: str, _cache: dict | None = None) -> dict:
	"""Every item x farm line of a cycle, costed. Writes nothing."""
	from upande_scp.serverscripts.store import procurement as P

	cache = _cache if _cache is not None else {}
	doc = frappe.get_doc(CYCLE, cycle)
	company = doc.company
	preview = P.preview_allocation(cycle)
	published = {(a.item_code, a.farm): flt(a.allocated_qty) for a in doc.allocations}

	lines, warnings = [], []
	for pl in preview["lines"]:
		code = pl["item_code"]
		split = fold_remainder(pl["allocations"], pl["remainder"])
		requested = {a["farm"]: flt(a["requested"]) for a in pl["allocations"]}
		rk = ("rate", code, company)
		if rk not in cache:
			cache[rk] = acc.resolve_rate(code, company)
		rate = cache[rk]
		if rate["warning"]:
			warnings.append(f"{code}: {rate['warning']}")
		kind = P.item_kind(code)
		ak = ("acc", code, company)
		if ak not in cache:
			cache[ak] = acc.resolve_expense_account(code, company, kind)
		account = cache[ak]
		if not account["account"]:
			warnings.append(f"{code}: no expense account for {company}")
		unowned = round(flt(pl["received"]) - sum(split.values()), 9)
		if unowned > 1e-9 and not split:
			# Approved, but no farm's requirement claims it any more (a final line
			# whose requests were withdrawn). It is still ordered, so it is still a
			# line — with no farm, which the MR reports rather than hides.
			warnings.append(f"{code}: {unowned:g} approved with no farm requesting it")
			lines.append({
				"cycle": cycle, "item_code": code, "item_name": pl.get("item_name") or code,
				"uom": pl.get("uom"), "kind": kind, "farm": None, "farm_group": None,
				"cost_center": None, "requested_qty": 0.0, "approved_qty": unowned,
				"allocated_qty": 0.0, "rate": rate["rate"], "rate_source": rate["source"],
				"account": account["account"], "account_source": account["source"],
				"value": round(unowned * rate["rate"], 2),
			})
		for farm in sorted(set(split) | set(requested)):
			fk = ("farm", farm)
			if fk not in cache:
				cache[fk] = (farm_cost_center(farm), farm_purchase_cost_center(farm))
			group, purchase = cache[fk]
			qty = flt(split.get(farm))
			lines.append({
				"cycle": cycle,
				"item_code": code,
				"item_name": pl.get("item_name") or code,
				"uom": pl.get("uom"),
				"kind": kind,
				"farm": farm,
				"farm_group": group,
				"cost_center": purchase,
				"requested_qty": requested.get(farm, 0.0),
				"approved_qty": qty,
				"allocated_qty": published.get((code, farm), 0.0),
				"rate": rate["rate"],
				"rate_source": rate["source"],
				"account": account["account"],
				"account_source": account["source"],
				"value": round(qty * rate["rate"], 2),
			})
	return {"company": company, "doc": doc, "lines": lines, "warnings": sorted(set(warnings))}


def _existing_budgets(company: str, cost_centers: list[str], accounts: list[str], fy: str) -> list:
	if not (cost_centers and accounts and fy):
		return []
	start, end = frappe.db.get_value("Fiscal Year", fy, ["year_start_date", "year_end_date"])
	fields = ["name", "cost_center", "account", "budget_amount", "docstatus"]
	if frappe.db.has_column("Budget", TAG):
		fields.append(TAG)
	return frappe.db.sql(
		f"""SELECT {", ".join(f"b.`{f}`" for f in fields)} FROM `tabBudget` b
		   WHERE b.docstatus < 2 AND b.company = %(c)s AND b.budget_against = 'Cost Center'
		     AND b.cost_center IN %(cc)s AND b.account IN %(acc)s
		     AND (SELECT year_start_date FROM `tabFiscal Year` WHERE name = b.from_fiscal_year) <= %(end)s
		     AND (SELECT year_end_date FROM `tabFiscal Year` WHERE name = b.to_fiscal_year) >= %(start)s""",
		{"c": company, "cc": tuple(cost_centers), "acc": tuple(accounts), "start": start, "end": end},
		as_dict=True,
	)


def _fy_cycles(company: str, fy: str, include: str) -> list[str]:
	start, end = frappe.db.get_value("Fiscal Year", fy, ["year_start_date", "year_end_date"])
	names = frappe.get_all(
		CYCLE,
		filters={
			"company": company,
			"status": ("in", APPROVED_STATES),
			"period_start": ("between", [start, end]),
		},
		pluck="name",
	)
	if include not in names:
		names.append(include)
	return sorted(names)


@frappe.whitelist()
def cycle_money(cycle: str) -> dict:
	"""B5: the cycle in money, per farm, next to its Budget."""
	cache: dict = {}
	data = cycle_lines(cycle, cache)
	doc, company, lines = data["doc"], data["company"], data["lines"]
	fy = _fiscal_year(doc.period_start, company) if doc.period_start else None

	# What the farm has committed this fiscal year: this cycle plus every other
	# approved cycle in the year. That is what a Budget has to cover.
	committed: dict[str, float] = {}
	if fy:
		for other in _fy_cycles(company, fy, cycle):
			if other == cycle:
				continue
			for l in cycle_lines(other, cache)["lines"]:
				if not l["farm"]:
					continue
				committed[l["farm"]] = committed.get(l["farm"], 0.0) + l["value"]

	farms: dict[str, dict] = {}
	for l in lines:
		if not l["farm"]:
			continue
		f = farms.setdefault(l["farm"], {
			"farm": l["farm"], "cost_center": l["farm_group"], "purchase_cost_center": l["cost_center"],
			"requirement_value": 0.0, "approved_value": 0.0, "allocated_value": 0.0, "accounts": set(),
		})
		f["requirement_value"] += l["requested_qty"] * l["rate"]
		f["approved_value"] += l["value"]
		f["allocated_value"] += l["allocated_qty"] * l["rate"]
		if l["account"]:
			f["accounts"].add(l["account"])

	groups = sorted({f["cost_center"] for f in farms.values() if f["cost_center"]})
	all_accounts = sorted({a for f in farms.values() for a in f["accounts"]})
	budgets = _existing_budgets(company, groups, all_accounts, fy) if fy else []

	out = []
	for name in sorted(farms):
		f = farms[name]
		mine = [b for b in budgets if b.cost_center == f["cost_center"]]
		submitted = sum(flt(b.budget_amount) for b in mine if b.docstatus == 1)
		drafted = sum(flt(b.budget_amount) for b in mine if b.docstatus == 0)
		budget = submitted if any(b.docstatus == 1 for b in mine) else None
		fy_committed = committed.get(name, 0.0) + f["approved_value"]
		out.append({
			"farm": name,
			"cost_center": f["cost_center"],
			"purchase_cost_center": f["purchase_cost_center"],
			"requirement_value": round(f["requirement_value"], 2),
			"approved_value": round(f["approved_value"], 2),
			"allocated_value": round(f["allocated_value"], 2),
			"fy_committed": round(fy_committed, 2),
			"budget": round(budget, 2) if budget is not None else None,
			"draft_budget": round(drafted, 2) if any(b.docstatus == 0 for b in mine) else None,
			"budgets": [b.name for b in mine],
			"over_budget": over_budget(fy_committed, budget),
		})

	return {
		"cycle": cycle,
		"company": company,
		"fiscal_year": fy,
		"currency": frappe.db.get_value("Company", company, "default_currency") or "KES",
		"farms": out,
		"lines": lines,
		"warnings": data["warnings"],
		"over_budget": [f["farm"] for f in out if f["over_budget"]],
		"totals": {
			"requirement_value": round(sum(f["requirement_value"] for f in out), 2),
			"approved_value": round(sum(f["approved_value"] for f in out), 2),
			"allocated_value": round(sum(f["allocated_value"] for f in out), 2),
		},
	}


# ─────────────────────────────── drafting ────────────────────────────────────


def _budget_doc_values(company, cc, account, fy, amount, cycle, farm) -> dict:
	values = {
		"doctype": "Budget",
		"company": company,
		"budget_against": "Cost Center",
		"cost_center": cc,
		"account": account,
		"from_fiscal_year": fy,
		"to_fiscal_year": fy,
		"budget_amount": amount,
		"distribution_frequency": "Monthly",
		"distribute_equally": 1,
		# B1: Warn everywhere. A group Budget is copied onto each child cost centre
		# and each child is checked alone against the whole amount, so Stop would
		# block a greenhouse for its farm's total.
		"applicable_on_material_request": 1,
		"action_if_annual_budget_exceeded_on_mr": WARN,
		"action_if_accumulated_monthly_budget_exceeded_on_mr": WARN,
		"applicable_on_purchase_order": 1,
		"action_if_annual_budget_exceeded_on_po": WARN,
		"action_if_accumulated_monthly_budget_exceeded_on_po": WARN,
		"applicable_on_booking_actual_expenses": 1,
		"action_if_annual_budget_exceeded": WARN,
		"action_if_accumulated_monthly_budget_exceeded": WARN,
	}
	if frappe.db.has_column("Budget", TAG):
		values[TAG] = cycle
	if farm and frappe.db.has_column("Budget", "farm"):
		values["farm"] = farm
	return values


def _actual_spend(company, cc, account, fy) -> float:
	from erpnext.accounts.doctype.budget.budget import get_actual_expense

	start, end = frappe.db.get_value("Fiscal Year", fy, ["year_start_date", "year_end_date"])
	return flt(get_actual_expense(frappe._dict({
		"company": company, "account": account, "cost_center": cc,
		"budget_start_date": start, "budget_end_date": end,
		"budget_against_field": "cost_center", "budget_against_doctype": "Cost Center",
		"is_tree": True,
	})))


def _save_budget(doc, spent: float) -> None:
	"""Save a draft Budget, even when the year's spend already exceeds it.

	ERPNext refuses a Budget below what was already spent in its year
	(``validate_existing_expenses``) — on save, not only on submit. A cycle's
	purchase is often a fraction of the year's spend, so that check would stop the
	draft from existing at all. The draft is saved with ERPNext's other checks run
	by hand (fiscal-year dates, duplicates, account, applicability, the monthly
	distribution) and carries the warning; the GM meets ERPNext's own check when
	submitting, which is the honest place for it.
	"""
	if spent <= flt(doc.budget_amount):
		if doc.is_new():
			doc.insert(ignore_permissions=True)
		else:
			doc.save(ignore_permissions=True)
		return
	doc.set_fiscal_year_dates()
	doc.validate_budget_amount()
	doc.validate_fiscal_year()
	doc.validate_duplicate()
	doc.validate_account()
	doc.set_null_value()
	doc.validate_applicable_for()
	doc.allocate_budget()
	doc.budget_distribution_total = sum(flt(r.amount) for r in doc.budget_distribution)
	doc.flags.ignore_validate = True
	if doc.is_new():
		doc.insert(ignore_permissions=True)
	else:
		doc.save(ignore_permissions=True)


@frappe.whitelist()
def draft_budgets(cycle: str, dry_run=False) -> dict:
	"""B3: write (or show) the draft Budgets this cycle's fiscal year calls for.

	Does not commit; a whitelisted call is committed by the request.
	"""
	from upande_scp.serverscripts.store.procurement import _assert_gm

	_assert_gm("draft budgets")
	dry_run = bool(cint(dry_run))
	doc = frappe.get_doc(CYCLE, cycle)
	company = doc.company
	fy = _fiscal_year(doc.period_start, company) if doc.period_start else None
	if not fy:
		return {"cycle": cycle, "fiscal_year": None, "rows": [], "skipped": [],
		        "error": f"No fiscal year covers {doc.period_start} for {company}."}

	cache: dict = {}
	lines = []
	for name in _fy_cycles(company, fy, cycle):
		lines += cycle_lines(name, cache)["lines"]
	rows, skipped = group_budget_rows(lines)

	existing = {
		(b.cost_center, b.account): b
		for b in _existing_budgets(
			company, sorted({r["cost_center"] for r in rows}), sorted({r["account"] for r in rows}), fy
		)
	}
	out = []
	for r in rows:
		key = (r["cost_center"], r["account"])
		b = existing.get(key)
		row = {**r, "fiscal_year": fy, "budget": b.name if b else None, "warning": None}
		if b and (b.docstatus == 1 or not b.get(TAG)):
			row["action"] = "left alone"
			row["warning"] = (
				f"{b.name} is submitted" if b.docstatus == 1 else f"{b.name} was made outside SCP"
			) + " — SCP does not change it."
			out.append(row)
			continue
		spent = _actual_spend(company, r["cost_center"], r["account"], fy)
		row["spent_in_year"] = round(spent, 2)
		if spent > r["amount"]:
			row["warning"] = (
				f"{fy} spend on this cost centre and account is already {spent:,.0f}, above "
				f"this {r['amount']:,.0f}. ERPNext will refuse to submit it until the amount "
				"covers the year."
			)
		if b and abs(flt(b.budget_amount) - r["amount"]) < 0.005 and b.get(TAG) == cycle:
			row["action"] = "unchanged"
			out.append(row)
			continue
		row["action"] = "update" if b else "create"
		if not dry_run:
			if b:
				bd = frappe.get_doc("Budget", b.name)
				bd.update({k: v for k, v in _budget_doc_values(
					company, r["cost_center"], r["account"], fy, r["amount"], cycle, r["farm"]
				).items() if k != "doctype"})
			else:
				bd = frappe.get_doc(_budget_doc_values(
					company, r["cost_center"], r["account"], fy, r["amount"], cycle, r["farm"]
				))
			_save_budget(bd, spent)
			row["budget"] = bd.name
		out.append(row)

	return {
		"cycle": cycle,
		"company": company,
		"fiscal_year": fy,
		"dry_run": dry_run,
		"cycles": _fy_cycles(company, fy, cycle),
		"rows": out,
		"skipped": [
			{k: s.get(k) for k in ("cycle", "farm", "item_code", "value", "why")} for s in skipped
		],
	}
