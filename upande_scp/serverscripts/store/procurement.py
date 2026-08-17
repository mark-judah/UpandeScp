"""Chemical procurement: farm requirements → review → one order → apportioned split.

The flow this replaces was manual at both ends. Planners raised orders for
everything, somebody merged them into one Material Request by hand, the purchase
landed in a single chemical store, and getting it out to the other farms was
whatever the store keeper remembered to do. Nothing recorded what a farm was
actually entitled to, so "which farm is using more than it budgeted" had no
answer.

What happens here:

1. **Each farm states its own requirement** — one `Chemical Purchase Requirement`
   per farm per cycle, with a line per chemical or foliar.
2. **Review 1, the farm's planner** confirms it is what the farm needs. Rejecting
   does NOT hand the lines back for free editing: the planner must raise a
   `Chemical Requirement Amendment`, so a change has a request, an author and a
   decision instead of appearing silently.
3. **Review 2, the GM** sees consolidated totals and makes the financial call —
   either a new absolute total or a percentage cut, per chemical. Once a line is
   marked final it is locked; changing it needs an amendment, not an edit.
4. **One Material Request** for the whole cycle, delivering into the general
   store.
5. **The receipt is apportioned** back to the farms proportionally, in amounts the
   store can physically measure, with each farm's unmeasurable fraction carried
   forward as a credit (see ``apportion``). The crumb that cannot be measured for
   anybody stays in the general store, and the credits sum to exactly that crumb —
   so the pool always has a per-farm explanation.
6. **Transfers** move each farm's allocation from the general store to its own.

Two rules run through all of it:

* **Nothing changes an allocation silently.** Every change is written to
  `Chemical Allocation Change` (what, who, from, to) and the affected farm's
  planners are notified. A planner discovering a changed allocation by noticing
  the stock did not match is the failure this exists to prevent.
* **A budget cut is not a debt.** The GM's reduction is a decision; only the
  rounding residue is carried forward. Otherwise every cut would quietly return
  as next cycle's entitlement.
"""
from __future__ import annotations

import json

import frappe
from frappe.utils import flt, now_datetime, nowdate

from upande_scp.serverscripts.common.notifications import notify, users_for_farm
from upande_scp.serverscripts.spray_plan_creator.loaning import (
	ELEVATED,
	_assert_farm_access,
	_ensure_creator,
	_user_farms,
)
from upande_scp.serverscripts.spray_plan_creator.loaning_v2 import (
	farm_company,
	item_kind,
	store_for,
)
from upande_scp.serverscripts.store.apportion import (
	CREDIT_EPSILON,
	apportion,
	default_step_for_uom,
)

CYCLE = "Chemical Procurement Cycle"
REQUIREMENT = "Chemical Purchase Requirement"
AMENDMENT = "Chemical Requirement Amendment"
CREDIT = "Chemical Allocation Credit"
CHANGE = "Chemical Allocation Change"

#: Requirement statuses a planner may still edit the lines of. Anything else needs
#: an amendment — that is the whole point of having one.
EDITABLE_STATES = ("Draft",)

#: Only these requirements count towards the consolidated total. A requirement
#: still in Draft is not a claim on the budget.
COUNTED_STATES = ("Planner Approved",)

GENERAL_STORE_PREFIX = "General Chemical Store"


# ─────────────────────────────── guards ──────────────────────────────────────


def _is_gm(user: str | None = None) -> bool:
	return bool(set(frappe.get_roles(user or frappe.session.user)) & ELEVATED)


def _assert_gm(what: str = "do this") -> None:
	if not _is_gm():
		frappe.throw(
			f"Only the SCP General Manager can {what}.", frappe.PermissionError
		)


def _assert_can_edit(req) -> None:
	"""A planner may edit their own farm's requirement, while it is editable."""
	_ensure_creator()
	_assert_farm_access(req.farm)
	if req.status not in EDITABLE_STATES:
		frappe.throw(
			f"{req.name} is {req.status.lower()} and can no longer be edited "
			"directly. Request an amendment instead — that keeps a record of what "
			"changed and why.",
		)


def _assert_line_open(cycle_doc, item_code: str):
	"""Refuse to touch a line the GM has already approved as final."""
	for line in cycle_doc.lines:
		if line.item_code == item_code:
			if line.final_approved:
				frappe.throw(
					f"{item_code} was approved as final on {cycle_doc.name}. A final "
					"figure is not changed — raise an amendment if it must move.",
				)
			return line
	frappe.throw(f"{item_code} is not on {cycle_doc.name}.")


# ──────────────────────── audit trail + notification ─────────────────────────


def log_change(
	cycle: str | None,
	what: str,
	qty_from: float,
	qty_to: float,
	item_code: str | None = None,
	farm: str | None = None,
	reason: str | None = None,
	notify_farms: bool = True,
) -> str:
	"""Record an allocation/quantity change and tell the affected planners.

	Deliberately one function: a change that is logged but not announced, or
	announced but not logged, is the half-measure that makes an audit trail
	untrustworthy. The notification names the amount, the actor and the direction
	because "your allocation changed" on its own is not actionable.
	"""
	doc = frappe.get_doc({
		"doctype": CHANGE,
		"cycle": cycle,
		"item_code": item_code,
		"farm": farm,
		"what": what,
		"qty_from": flt(qty_from),
		"qty_to": flt(qty_to),
		"changed_by": frappe.session.user,
		"changed_on": now_datetime(),
		"reason": reason,
	})
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)

	if notify_farms and farm:
		actor = frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
		label = frappe.db.get_value("Item", item_code, "item_name") or item_code or "—"
		subject = f"{what}: {label} {flt(qty_from):g} → {flt(qty_to):g}"
		body = (
			f"{actor} changed the {what.lower()} for {label} at {farm} from "
			f"{flt(qty_from):g} to {flt(qty_to):g}."
		)
		if reason:
			body += f"\n\nReason: {reason}"
		recipients = notify(
			users_for_farm(farm),
			subject,
			body,
			ref_doctype=CHANGE,
			ref_name=doc.name,
			category="procurement",
		)
		if recipients:
			frappe.db.set_value(
				CHANGE, doc.name, "notified", ", ".join(recipients),
				update_modified=False,
			)
	return doc.name


# ─────────────────────────────── cycles ──────────────────────────────────────


def _has_field(doctype: str, fieldname: str) -> bool:
	"""Whether this site actually has a field.

	Custom fields with no owning module exist only where somebody added them, so
	an app that writes to one has to check first or it breaks every site that
	never had it.
	"""
	return bool(frappe.get_meta(doctype).get_field(fieldname))


def general_store_for(company: str) -> str | None:
	if not company:
		return None
	abbr = frappe.db.get_value("Company", company, "abbr")
	name = f"{GENERAL_STORE_PREFIX} - {abbr}"
	return name if frappe.db.exists("Warehouse", name) else None


@frappe.whitelist()
def companies_for_cycle() -> list[dict]:
	"""Companies a cycle can run in: the ones that have a general store.

	Filtered rather than listing every company, because a cycle without a pool
	cannot receive a purchase or apportion it — the Material Request has nowhere to
	deliver. Better to not offer the choice than to let it fail three steps later.
	"""
	out = []
	for company in frappe.get_all("Company", pluck="name"):
		store = general_store_for(company)
		if store:
			out.append({"company": company, "general_store": store})
	return out


@frappe.whitelist()
def create_cycle(cycle_name: str, company: str, period_start: str, period_end: str) -> str:
	_assert_gm("open a procurement cycle")
	doc = frappe.get_doc({
		"doctype": CYCLE,
		"cycle_name": cycle_name,
		"company": company,
		"period_start": period_start,
		"period_end": period_end,
		"status": "Collecting",
		"general_store": general_store_for(company),
	})
	doc.insert(ignore_permissions=True)
	frappe.db.commit()
	return doc.name


@frappe.whitelist()
def list_cycles(status: str | None = None, limit: int = 20) -> list[dict]:
	filters = {}
	if status:
		filters["status"] = status
	return frappe.get_all(
		CYCLE,
		filters=filters,
		fields=[
			"name", "cycle_name", "company", "period_start", "period_end",
			"status", "general_store", "material_request",
		],
		order_by="period_start desc",
		limit_page_length=int(limit or 20),
	)


# ───────────────────────── requirements (per farm) ───────────────────────────


def _requirement_dict(doc) -> dict:
	return {
		"name": doc.name,
		"farm": doc.farm,
		"cycle": doc.cycle,
		"status": doc.status,
		"reviewed_by": doc.reviewed_by,
		"reviewed_on": str(doc.reviewed_on) if doc.reviewed_on else None,
		"rejection_reason": doc.rejection_reason,
		"notes": doc.notes,
		"items": [
			{
				"item_code": r.item_code,
				"item_name": r.item_name,
				"uom": r.uom,
				"requested_qty": flt(r.requested_qty),
				"suggested_qty": flt(r.suggested_qty),
				"kind": r.kind,
				"note": r.note,
			}
			for r in doc.items
		],
	}


@frappe.whitelist()
def my_requirement(cycle: str, farm: str) -> dict:
	"""The farm's requirement for this cycle, created as a Draft if absent."""
	_ensure_creator()
	_assert_farm_access(farm)
	name = frappe.db.get_value(
		REQUIREMENT, {"cycle": cycle, "farm": farm, "status": ("!=", "Superseded")}, "name"
	)
	if name:
		return _requirement_dict(frappe.get_doc(REQUIREMENT, name))

	doc = frappe.get_doc({
		"doctype": REQUIREMENT,
		"cycle": cycle,
		"farm": farm,
		"company": farm_company(farm),
		"status": "Draft",
	})
	doc.insert(ignore_permissions=True)
	frappe.db.commit()
	return _requirement_dict(doc)


@frappe.whitelist()
def save_requirement(name: str, items, notes: str | None = None) -> dict:
	"""Replace the requirement's lines. Only while it is still editable."""
	doc = frappe.get_doc(REQUIREMENT, name)
	_assert_can_edit(doc)

	if isinstance(items, str):
		items = json.loads(items or "[]")

	doc.items = []
	for row in items or []:
		code = (row.get("item_code") or "").strip()
		qty = flt(row.get("requested_qty"))
		if not code or qty <= 0:
			continue
		doc.append("items", {
			"item_code": code,
			"uom": row.get("uom") or frappe.db.get_value("Item", code, "stock_uom"),
			"requested_qty": qty,
			"kind": item_kind(code),
			"note": row.get("note"),
		})
	doc.total_lines = len(doc.items)
	if notes is not None:
		doc.notes = notes
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return _requirement_dict(doc)


@frappe.whitelist()
def submit_requirement(name: str) -> dict:
	doc = frappe.get_doc(REQUIREMENT, name)
	_assert_can_edit(doc)
	if not doc.items:
		frappe.throw("Add at least one chemical before submitting.")
	doc.status = "Submitted"
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return _requirement_dict(doc)


@frappe.whitelist()
def review_requirement(name: str, decision: str, reason: str | None = None) -> dict:
	"""Review 1. `decision` is "approve" or "reject".

	A rejection is a full stop, not an invitation to edit: the requirement goes to
	Rejected and the planner's only route forward is an amendment request.
	"""
	doc = frappe.get_doc(REQUIREMENT, name)
	_ensure_creator()
	_assert_farm_access(doc.farm)
	if doc.status not in ("Submitted", "Amendment Requested"):
		frappe.throw(f"{name} is {doc.status.lower()}; there is nothing to review.")

	decision = (decision or "").lower()
	if decision not in ("approve", "reject"):
		frappe.throw("Decision must be approve or reject.")
	if decision == "reject" and not (reason or "").strip():
		frappe.throw("Say why it is rejected — the planner needs it to amend.")

	doc.status = "Planner Approved" if decision == "approve" else "Rejected"
	doc.reviewed_by = frappe.session.user
	doc.reviewed_on = now_datetime()
	doc.rejection_reason = reason if decision == "reject" else None
	doc.save(ignore_permissions=True)

	notify(
		users_for_farm(doc.farm),
		f"Requirement {doc.name} {doc.status.lower()}",
		(reason or f"{doc.farm}'s requirement for {doc.cycle} was {doc.status.lower()}."),
		ref_doctype=REQUIREMENT,
		ref_name=doc.name,
		category="procurement",
	)
	frappe.db.commit()
	return _requirement_dict(doc)


# ──────────────────────── structured amendments ──────────────────────────────


@frappe.whitelist()
def request_amendment(requirement: str, items, reason: str) -> str:
	"""Ask for named lines to change, with the current and proposed quantities.

	The document could be edited in place; the point is that it is not. An
	amendment carries who asked, what they want each figure to become, and why,
	so the trail survives the change.
	"""
	if not (reason or "").strip():
		frappe.throw("An amendment needs a reason.")
	req = frappe.get_doc(REQUIREMENT, requirement)
	_ensure_creator()
	_assert_farm_access(req.farm)

	if isinstance(items, str):
		items = json.loads(items or "[]")
	if not items:
		frappe.throw("Name at least one line to amend.")

	current = {r.item_code: flt(r.requested_qty) for r in req.items}
	doc = frappe.get_doc({
		"doctype": AMENDMENT,
		"requirement": req.name,
		"farm": req.farm,
		"cycle": req.cycle,
		"status": "Pending",
		"requested_by": frappe.session.user,
		"requested_on": now_datetime(),
		"reason": reason,
	})
	for row in items:
		code = (row.get("item_code") or "").strip()
		if not code:
			continue
		doc.append("items", {
			"item_code": code,
			"current_qty": current.get(code, 0.0),
			"proposed_qty": flt(row.get("proposed_qty")),
			"uom": row.get("uom") or frappe.db.get_value("Item", code, "stock_uom"),
			"reason": row.get("reason"),
		})
	if not doc.items:
		frappe.throw("Name at least one line to amend.")
	doc.insert(ignore_permissions=True)

	frappe.db.set_value(REQUIREMENT, req.name, "status", "Amendment Requested")
	notify(
		users_for_farm(req.farm),
		f"Amendment requested on {req.name}",
		f"{len(doc.items)} line(s). Reason: {reason}",
		ref_doctype=AMENDMENT,
		ref_name=doc.name,
		category="procurement",
	)
	frappe.db.commit()
	return doc.name


@frappe.whitelist()
def decide_amendment(name: str, decision: str, note: str | None = None) -> dict:
	"""Grant or decline an amendment. Granting applies it and logs every line.

	Applied here rather than by letting the requester save the requirement: the
	change and its record are written together, so there is no state where the
	quantity has moved but nothing says who moved it.
	"""
	doc = frappe.get_doc(AMENDMENT, name)
	if doc.status != "Pending":
		frappe.throw(f"{name} was already {doc.status.lower()}.")
	_ensure_creator()
	_assert_farm_access(doc.farm)

	decision = (decision or "").lower()
	if decision not in ("grant", "decline"):
		frappe.throw("Decision must be grant or decline.")

	req = frappe.get_doc(REQUIREMENT, doc.requirement)
	if decision == "grant":
		lines = {r.item_code: r for r in req.items}
		for row in doc.items:
			before = flt(lines[row.item_code].requested_qty) if row.item_code in lines else 0.0
			if row.item_code in lines:
				lines[row.item_code].requested_qty = flt(row.proposed_qty)
			else:
				req.append("items", {
					"item_code": row.item_code,
					"uom": row.uom,
					"requested_qty": flt(row.proposed_qty),
					"kind": item_kind(row.item_code),
				})
			log_change(
				req.cycle, "Amendment Granted", before, flt(row.proposed_qty),
				item_code=row.item_code, farm=req.farm,
				reason=row.reason or doc.reason,
			)
		req.total_lines = len(req.items)
		# Back to Submitted, not Draft: the amendment settled the numbers, so what
		# it needs now is review 1 again — not another round of free editing.
		req.status = "Submitted"
		req.save(ignore_permissions=True)
	else:
		log_change(
			req.cycle, "Amendment Declined", 0, 0, farm=req.farm,
			reason=note or doc.reason, notify_farms=True,
		)
		frappe.db.set_value(REQUIREMENT, req.name, "status", "Rejected")

	doc.status = "Granted" if decision == "grant" else "Declined"
	doc.decided_by = frappe.session.user
	doc.decided_on = now_datetime()
	doc.decision_note = note
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return {"name": doc.name, "status": doc.status, "requirement": req.name}


@frappe.whitelist()
def list_amendments(cycle: str | None = None, status: str | None = None) -> list[dict]:
	filters = {}
	if cycle:
		filters["cycle"] = cycle
	if status:
		filters["status"] = status
	allowed = _user_farms()
	if allowed is not None:
		filters["farm"] = ("in", list(allowed) or [""])
	rows = frappe.get_all(
		AMENDMENT,
		filters=filters,
		fields=[
			"name", "requirement", "farm", "cycle", "status", "reason",
			"requested_by", "requested_on", "decided_by", "decision_note",
		],
		order_by="creation desc",
	)
	for r in rows:
		r["items"] = frappe.get_all(
			"Chemical Requirement Amendment Item",
			filters={"parent": r.name},
			fields=["item_code", "item_name", "current_qty", "proposed_qty", "uom", "reason"],
			order_by="idx asc",
		)
	return rows


# ──────────────────── consolidation + the GM's reduction ─────────────────────


@frappe.whitelist()
def consolidate(cycle: str) -> dict:
	"""Sum the planner-approved requirements into the cycle's lines.

	Re-runnable: totals are recomputed from the requirements each time, because
	requirements keep arriving. Lines already approved as final keep their
	approved quantity — that figure is settled and re-consolidating must not
	quietly move it.
	"""
	_assert_gm("consolidate a cycle")
	doc = frappe.get_doc(CYCLE, cycle)

	reqs = frappe.get_all(
		REQUIREMENT,
		filters={"cycle": cycle, "status": ("in", COUNTED_STATES)},
		pluck="name",
	)
	totals: dict[str, float] = {}
	if reqs:
		rows = frappe.get_all(
			"Chemical Purchase Requirement Item",
			filters={"parent": ("in", reqs)},
			fields=["item_code", "uom", "requested_qty"],
		)
		for r in rows:
			totals[r.item_code] = totals.get(r.item_code, 0.0) + flt(r.requested_qty)

	# Snapshot what the GM has already decided, then rebuild the table. Rebuilding
	# rather than patching in place keeps the row order meaningful (biggest ask
	# first) without leaving stale idx values behind.
	prior = {
		l.item_code: {
			"reduction_mode": l.reduction_mode,
			"reduction_value": flt(l.reduction_value),
			"allocation_step": flt(l.allocation_step),
			"approved_qty": flt(l.approved_qty),
			"allocated_total": flt(l.allocated_total),
			"remainder": flt(l.remainder),
			"final_approved": int(l.final_approved or 0),
			"total_requested": flt(l.total_requested),
			"uom": l.uom,
		}
		for l in doc.lines
	}
	# A chemical nobody asks for any more drops off — unless its figure was
	# approved as final, in which case it is already a commitment.
	codes = sorted(totals, key=lambda c: (-totals[c], c)) + sorted(
		c for c, p in prior.items() if c not in totals and p["final_approved"]
	)

	doc.lines = []
	for code in codes:
		p = prior.get(code, {})
		uom = p.get("uom") or frappe.db.get_value("Item", code, "stock_uom")
		total = flt(totals.get(code, p.get("total_requested", 0.0)))
		row = {
			"item_code": code,
			"uom": uom,
			"total_requested": total,
			"reduction_mode": p.get("reduction_mode") or "None",
			"reduction_value": p.get("reduction_value", 0.0),
			"allocation_step": p.get("allocation_step") or default_step_for_uom(uom),
			"allocated_total": p.get("allocated_total", 0.0),
			"remainder": p.get("remainder", 0.0),
			"final_approved": p.get("final_approved", 0),
		}
		# A final figure is kept exactly as approved; everything else re-resolves
		# from the refreshed total.
		row["approved_qty"] = (
			p["approved_qty"] if p.get("final_approved")
			else _resolve_reduction(total, row["reduction_mode"], row["reduction_value"])
		)
		doc.append("lines", row)
	if doc.status in ("Draft", "Collecting"):
		doc.status = "GM Review"
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return get_cycle(cycle)


def _resolve_reduction(total: float, mode: str | None, value: float | None) -> float:
	"""Both entry modes collapse to one target quantity.

	Absolute is the new total; Percentage is the size of the cut. Clamped to the
	request, because approving more than anybody asked for is not a reduction and
	would apportion stock nobody wanted.
	"""
	total = flt(total)
	if mode == "Absolute":
		return max(0.0, min(flt(value), total))
	if mode == "Percentage":
		pct = min(max(flt(value), 0.0), 100.0)
		return round(total * (1.0 - pct / 100.0), 9)
	return total


@frappe.whitelist()
def set_reduction(cycle: str, item_code: str, mode: str, value=None, reason: str | None = None) -> dict:
	"""Review 2: the GM's financial call on one chemical."""
	_assert_gm("reduce a chemical's total")
	doc = frappe.get_doc(CYCLE, cycle)
	line = _assert_line_open(doc, item_code)

	if mode not in ("None", "Absolute", "Percentage"):
		frappe.throw("Reduction mode must be None, Absolute or Percentage.")

	before = flt(line.approved_qty)
	line.reduction_mode = mode
	line.reduction_value = flt(value)
	line.approved_qty = _resolve_reduction(line.total_requested, mode, value)
	doc.save(ignore_permissions=True)

	if abs(line.approved_qty - before) > CREDIT_EPSILON:
		# Every farm that asked for this chemical is affected, so every one of
		# their planners hears about it — with the numbers, not just the fact.
		for farm in _farms_requesting(cycle, item_code):
			log_change(
				cycle, "Approved Total", before, flt(line.approved_qty),
				item_code=item_code, farm=farm, reason=reason,
			)
	frappe.db.commit()
	return get_cycle(cycle)


@frappe.whitelist()
def finalise_line(cycle: str, item_code: str) -> dict:
	"""Lock a line: "the one approved as final is not changed"."""
	_assert_gm("approve a figure as final")
	doc = frappe.get_doc(CYCLE, cycle)
	line = _assert_line_open(doc, item_code)
	line.final_approved = 1
	doc.save(ignore_permissions=True)
	log_change(
		cycle, "Approved Total", flt(line.approved_qty), flt(line.approved_qty),
		item_code=item_code, reason="approved as final", notify_farms=False,
	)
	frappe.db.commit()
	return get_cycle(cycle)


def _farms_requesting(cycle: str, item_code: str) -> list[str]:
	rows = frappe.db.sql(
		"""SELECT DISTINCT r.farm
		   FROM `tabChemical Purchase Requirement Item` i
		   JOIN `tabChemical Purchase Requirement` r ON r.name = i.parent
		   WHERE r.cycle = %s AND i.item_code = %s AND r.status IN %s""",
		(cycle, item_code, COUNTED_STATES),
		as_dict=True,
	)
	return [r.farm for r in rows if r.farm]


@frappe.whitelist()
def get_cycle(cycle: str) -> dict:
	doc = frappe.get_doc(CYCLE, cycle)
	return {
		"name": doc.name,
		"cycle_name": doc.cycle_name,
		"company": doc.company,
		"period_start": str(doc.period_start) if doc.period_start else None,
		"period_end": str(doc.period_end) if doc.period_end else None,
		"status": doc.status,
		"general_store": doc.general_store,
		"material_request": doc.material_request,
		"notes": doc.notes,
		"lines": [
			{
				"item_code": l.item_code,
				"item_name": l.item_name,
				"uom": l.uom,
				"total_requested": flt(l.total_requested),
				"reduction_mode": l.reduction_mode,
				"reduction_value": flt(l.reduction_value),
				"approved_qty": flt(l.approved_qty),
				"allocation_step": flt(l.allocation_step),
				"allocated_total": flt(l.allocated_total),
				"remainder": flt(l.remainder),
				"final_approved": bool(l.final_approved),
			}
			for l in doc.lines
		],
		"allocations": [
			{
				"item_code": a.item_code,
				"farm": a.farm,
				"uom": a.uom,
				"requested_qty": flt(a.requested_qty),
				"credit_in": flt(a.credit_in),
				"basis_qty": flt(a.basis_qty),
				"allocated_qty": flt(a.allocated_qty),
				"steps": int(a.steps or 0),
				"credit_out": flt(a.credit_out),
				"target_warehouse": a.target_warehouse,
				"stock_entry": a.stock_entry,
				"transferred": bool(a.transferred),
			}
			for a in doc.allocations
		],
	}


@frappe.whitelist()
def requirements_for(cycle: str) -> list[dict]:
	"""Every farm's requirement on a cycle, scoped to what the user may see."""
	filters = {"cycle": cycle}
	allowed = _user_farms()
	if allowed is not None:
		filters["farm"] = ("in", list(allowed) or [""])
	rows = frappe.get_all(
		REQUIREMENT,
		filters=filters,
		fields=["name", "farm", "status", "total_lines", "reviewed_by", "rejection_reason"],
		order_by="farm asc",
	)
	for r in rows:
		r["items"] = frappe.get_all(
			"Chemical Purchase Requirement Item",
			filters={"parent": r.name},
			fields=["item_code", "item_name", "uom", "requested_qty", "kind", "note"],
			order_by="idx asc",
		)
	return rows


# ─────────────────────────── the Material Request ────────────────────────────


@frappe.whitelist()
def create_material_request(cycle: str, schedule_date: str | None = None) -> str:
	"""One Material Request for the whole cycle, delivering into the general store.

	One document rather than one per chemical or per farm: that consolidation is
	the manual step this feature exists to remove, and a single MR is what the
	purchasing side already expects.

	Left as a **draft** on purpose. Submitting is purchasing's decision, made in
	ERPNext with its own validations (price lists, letter heads, approvals) — and
	auto-submitting from a crop-protection screen would remove that checkpoint
	from a document that commits money.
	"""
	_assert_gm("raise the Material Request")
	doc = frappe.get_doc(CYCLE, cycle)
	if doc.material_request and frappe.db.exists("Material Request", doc.material_request):
		frappe.throw(
			f"{cycle} already has {doc.material_request}. Amend that request rather "
			"than raising a second one for the same cycle.",
		)
	if not doc.general_store:
		frappe.throw(
			"This cycle has no general store, so there is nowhere for the purchase "
			"to land. Set one before raising the request.",
		)
	lines = [l for l in doc.lines if flt(l.approved_qty) > 0]
	if not lines:
		frappe.throw("Nothing approved to order yet.")

	mr = frappe.get_doc({
		"doctype": "Material Request",
		"material_request_type": "Purchase",
		"company": doc.company,
		"transaction_date": nowdate(),
		"schedule_date": schedule_date or doc.period_end or nowdate(),
		"set_warehouse": doc.general_store,
	})
	purpose = f"Chemical procurement cycle {doc.name} ({doc.cycle_name})"
	for l in lines:
		row = {
			"item_code": l.item_code,
			"qty": flt(l.approved_qty),
			"uom": l.uom or frappe.db.get_value("Item", l.item_code, "stock_uom"),
			"warehouse": doc.general_store,
			"schedule_date": schedule_date or doc.period_end or nowdate(),
		}
		if _has_field("Material Request Item", "custom_purpose"):
			row["custom_purpose"] = purpose
		mr.append("items", row)

	# Some sites add their own mandatory fields to Material Request — kaitet makes
	# `custom_farm` required. They are site customisations (no owning module), so
	# they are filled when present and never assumed.
	if _has_field("Material Request", "custom_purpose"):
		mr.custom_purpose = "Production"
	if _has_field("Material Request", "custom_farm"):
		# Deliberately left blank: a consolidated cycle order belongs to the
		# company, not to one farm, and naming an arbitrary farm would make the
		# order look like that farm's. Mandatory-checking is waived for this one
		# document rather than inventing an owner.
		mr.flags.ignore_mandatory = True

	mr.flags.ignore_permissions = True
	mr.insert(ignore_permissions=True)

	doc.material_request = mr.name
	doc.status = "Approved"
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return mr.name


# ──────────────────────── allocation + carry-forward ─────────────────────────


def credits_for(item_code: str) -> dict[str, float]:
	"""Carried credits per farm for one item."""
	rows = frappe.get_all(
		CREDIT, filters={"item_code": item_code}, fields=["farm", "credit_qty"]
	)
	return {r.farm: flt(r.credit_qty) for r in rows if r.farm}


def _requested_by_farm(cycle: str, item_code: str) -> dict[str, float]:
	rows = frappe.db.sql(
		"""SELECT r.farm, SUM(i.requested_qty) q
		   FROM `tabChemical Purchase Requirement Item` i
		   JOIN `tabChemical Purchase Requirement` r ON r.name = i.parent
		   WHERE r.cycle = %s AND i.item_code = %s AND r.status IN %s
		   GROUP BY r.farm""",
		(cycle, item_code, COUNTED_STATES),
		as_dict=True,
	)
	return {r.farm: flt(r.q) for r in rows if r.farm}


@frappe.whitelist()
def preview_allocation(cycle: str, received: str | None = None) -> dict:
	"""What the split would look like, without writing anything.

	`received` optionally maps item_code -> quantity actually received, for when
	the delivery differs from the order — the split must follow what arrived, not
	what was hoped for.
	"""
	doc = frappe.get_doc(CYCLE, cycle)
	if isinstance(received, str):
		received = json.loads(received or "{}")
	received = received or {}

	out = []
	for line in doc.lines:
		qty = flt(received.get(line.item_code, line.approved_qty))
		step = flt(line.allocation_step) or default_step_for_uom(line.uom)
		result = apportion(
			_requested_by_farm(cycle, line.item_code),
			qty,
			step,
			carried=credits_for(line.item_code),
		)
		out.append({
			"item_code": line.item_code,
			"item_name": line.item_name,
			"uom": line.uom,
			"received": qty,
			"step": step,
			"distributed": result.distributed,
			"remainder": result.remainder,
			"allocations": [
				{
					"farm": a.farm,
					"requested": a.requested,
					"credit_in": a.credit_in,
					"basis": a.basis,
					"allocated": a.allocated,
					"steps": a.steps,
					"credit_out": a.credit_out,
				}
				for a in result.allocations
			],
			"carried_forward": result.carried_forward,
		})
	return {"cycle": cycle, "lines": out}


@frappe.whitelist()
def publish_allocation(cycle: str, received: str | None = None) -> dict:
	"""Commit the split: write the allocation rows and the carried credits.

	Credits are replaced wholesale from `carried_forward` rather than incremented,
	because that map is complete — it already contains the farms that sat the
	cycle out. Adding to the old value instead would double-count them.
	"""
	_assert_gm("publish an allocation")
	doc = frappe.get_doc(CYCLE, cycle)
	preview = preview_allocation(cycle, received)

	before = {(a.item_code, a.farm): flt(a.allocated_qty) for a in doc.allocations}
	doc.allocations = []
	for line in preview["lines"]:
		code = line["item_code"]
		for a in line["allocations"]:
			if a["allocated"] <= 0 and a["credit_out"] <= CREDIT_EPSILON:
				continue
			doc.append("allocations", {
				"item_code": code,
				"farm": a["farm"],
				"uom": line["uom"],
				"requested_qty": a["requested"],
				"credit_in": a["credit_in"],
				"basis_qty": a["basis"],
				"allocated_qty": a["allocated"],
				"steps": a["steps"],
				"credit_out": a["credit_out"],
				"target_warehouse": store_for(a["farm"], code),
			})
		for l in doc.lines:
			if l.item_code == code:
				l.allocated_total = line["distributed"]
				l.remainder = line["remainder"]
		_write_credits(code, line["carried_forward"], cycle, line["uom"])

	doc.status = "Allocated"
	doc.save(ignore_permissions=True)

	for a in doc.allocations:
		was = before.get((a.item_code, a.farm), 0.0)
		if abs(flt(a.allocated_qty) - was) > CREDIT_EPSILON:
			log_change(
				cycle, "Allocation", was, flt(a.allocated_qty),
				item_code=a.item_code, farm=a.farm,
			)
	frappe.db.commit()
	return get_cycle(cycle)


def _write_credits(item_code: str, carried: dict, cycle: str, uom: str | None) -> None:
	"""Persist the carry-forward ledger for one item.

	Farms whose credit has settled get their row deleted rather than zeroed: a
	long tail of zero rows would bury the ones the general store keeper actually
	needs to act on.
	"""
	carried = {f: flt(q) for f, q in (carried or {}).items()}
	existing = {
		r.farm: r.name
		for r in frappe.get_all(CREDIT, filters={"item_code": item_code}, fields=["name", "farm"])
	}
	for farm, qty in carried.items():
		if abs(qty) <= CREDIT_EPSILON:
			continue
		if farm in existing:
			frappe.db.set_value(CREDIT, existing[farm], {
				"credit_qty": qty,
				"last_cycle": cycle,
				"updated_on": now_datetime(),
			}, update_modified=False)
		else:
			row = frappe.get_doc({
				"doctype": CREDIT,
				"farm": farm,
				"item_code": item_code,
				"uom": uom,
				"credit_qty": qty,
				"last_cycle": cycle,
				"updated_on": now_datetime(),
			})
			row.insert(ignore_permissions=True)
	for farm, name in existing.items():
		if abs(carried.get(farm, 0.0)) <= CREDIT_EPSILON:
			frappe.delete_doc(CREDIT, name, force=True, ignore_permissions=True)


@frappe.whitelist()
def transfer_allocation(cycle: str) -> dict:
	"""Move each farm's allocation out of the general store into its own.

	One Stock Entry per farm: the farm is the unit the movement is about, and a
	keeper receiving eight chemicals wants one document to check against, not
	eight. Rows with no target store are skipped and reported rather than
	silently dropped — an unmapped farm is a configuration problem somebody has
	to see.
	"""
	_assert_gm("transfer an allocation")
	doc = frappe.get_doc(CYCLE, cycle)
	if not doc.general_store:
		frappe.throw("This cycle has no general store to transfer from.")

	by_farm: dict[str, list] = {}
	skipped = []
	for a in doc.allocations:
		if a.transferred or flt(a.allocated_qty) <= 0:
			continue
		if not a.target_warehouse:
			skipped.append({"farm": a.farm, "item_code": a.item_code,
			                "why": "no store mapped for this item's kind"})
			continue
		by_farm.setdefault(a.farm, []).append(a)

	entries = []
	for farm, rows in sorted(by_farm.items()):
		se = frappe.get_doc({
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Transfer",
			"purpose": "Material Transfer",
			"company": doc.company,
			"posting_date": nowdate(),
		})
		for a in rows:
			se.append("items", {
				"item_code": a.item_code,
				"qty": flt(a.allocated_qty),
				"uom": a.uom or frappe.db.get_value("Item", a.item_code, "stock_uom"),
				"stock_uom": frappe.db.get_value("Item", a.item_code, "stock_uom"),
				"conversion_factor": 1,
				"s_warehouse": doc.general_store,
				"t_warehouse": a.target_warehouse,
			})
		se.flags.ignore_permissions = True
		se.insert(ignore_permissions=True)
		se.submit()
		for a in rows:
			a.stock_entry = se.name
			a.transferred = 1
		entries.append({"farm": farm, "stock_entry": se.name, "lines": len(rows)})

		notify(
			users_for_farm(farm),
			f"Chemical allocation transferred to {farm}",
			f"{len(rows)} line(s) moved from {doc.general_store} — {se.name}.",
			ref_doctype="Stock Entry",
			ref_name=se.name,
			category="procurement",
		)

	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return {"cycle": cycle, "entries": entries, "skipped": skipped}


# ───────────────────── the general store keeper's view ───────────────────────


@frappe.whitelist()
def pool_status(company: str | None = None) -> dict:
	"""What is sitting in the general store, and who is owed it.

	The keeper's question is not "how much is here" but "why is it here and who
	should get it next" — so on-hand and the outstanding credits are one view.
	"""
	store = general_store_for(company or frappe.defaults.get_user_default("Company"))
	on_hand = []
	if store:
		on_hand = frappe.get_all(
			"Bin",
			filters={"warehouse": store, "actual_qty": (">", 0)},
			fields=["item_code", "actual_qty", "stock_uom"],
			order_by="actual_qty desc",
		)
	credits = frappe.get_all(
		CREDIT,
		fields=["farm", "item_code", "item_name", "uom", "credit_qty", "last_cycle"],
		order_by="item_code asc, credit_qty desc",
	)
	owed: dict[str, float] = {}
	for c in credits:
		if flt(c.credit_qty) > 0:
			owed[c.item_code] = owed.get(c.item_code, 0.0) + flt(c.credit_qty)
	return {
		"store": store,
		"on_hand": on_hand,
		"credits": credits,
		"owed_by_item": owed,
	}


@frappe.whitelist()
def consumption_vs_allocation(cycle: str) -> list[dict]:
	"""Allocation against what each farm actually consumed — the budget question.

	Loans count: a farm that borrows raises its consumption without raising its
	allocation, so leaving loans out would make every borrower look like an
	overspender.
	"""
	doc = frappe.get_doc(CYCLE, cycle)
	start, end = doc.period_start, doc.period_end
	out = []
	for a in doc.allocations:
		store = a.target_warehouse
		consumed = 0.0
		if store and start and end:
			row = frappe.db.sql(
				"""SELECT COALESCE(SUM(-sle.actual_qty), 0) q
				   FROM `tabStock Ledger Entry` sle
				   WHERE sle.item_code = %s AND sle.warehouse = %s
				     AND sle.posting_date BETWEEN %s AND %s
				     AND sle.actual_qty < 0 AND sle.is_cancelled = 0""",
				(a.item_code, store, start, end),
				as_dict=True,
			)
			consumed = flt(row[0]["q"]) if row else 0.0
		out.append({
			"farm": a.farm,
			"item_code": a.item_code,
			"allocated": flt(a.allocated_qty),
			"consumed": consumed,
			"over": round(consumed - flt(a.allocated_qty), 6),
		})
	return out


# ───────────────── requests against the general-store pool ──────────────────
# Step 8 of the flow: what could not be apportioned sits in the general store, and
# a planner who needs some of it asks the keeper for it.
#
# These reuse `Chemical Transfer Request` rather than introducing a parallel
# doctype. A pool draw IS a directed request whose lender happens to be the shared
# store: same lines, same per-line decisions, same history. What differs is that
# there is no lender farm (`from_general_store` marks it) and the decision belongs
# to the store keeper, not to another farm's planner.

TRANSFER_REQUEST = "Chemical Transfer Request"


def _pool_on_hand(store: str, item_code: str) -> float:
	if not store:
		return 0.0
	return flt(
		frappe.db.get_value("Bin", {"warehouse": store, "item_code": item_code}, "actual_qty")
	)


def _reserved_from_pool(store: str, item_code: str, exclude: str | None = None) -> float:
	"""Approved-but-not-yet-moved quantity already promised out of the pool.

	Without this, two planners can each be approved for the last 5 kg and the
	second transfer fails at the stock ledger — after the keeper has already told
	them yes.
	"""
	rows = frappe.db.sql(
		"""SELECT COALESCE(SUM(i.approved_qty), 0) q
		   FROM `tabChemical Transfer Request Item` i
		   JOIN `tabChemical Transfer Request` r ON r.name = i.parent
		   WHERE r.from_general_store = 1 AND r.lender_warehouse = %s
		     AND i.item_code = %s AND i.status = 'Approved'
		     AND (i.stock_entry IS NULL OR i.stock_entry = '')
		     AND r.name != %s""",
		(store, item_code, exclude or ""),
		as_dict=True,
	)
	return flt(rows[0]["q"]) if rows else 0.0


def _keeper_of(store: str, user: str | None = None) -> bool:
	"""Whether this user keeps that store."""
	user = user or frappe.session.user
	if _is_gm(user):
		return True
	return bool(
		frappe.db.exists("Farm Store Keeper", {"warehouse": store, "user": user})
	)


@frappe.whitelist()
def pool_availability(company: str | None = None, item_codes=None) -> dict:
	"""Pool stock for named items, net of what is already promised."""
	store = general_store_for(company or frappe.defaults.get_user_default("Company"))
	if isinstance(item_codes, str):
		item_codes = json.loads(item_codes or "[]")
	out = {}
	for code in item_codes or []:
		on_hand = _pool_on_hand(store, code)
		reserved = _reserved_from_pool(store, code)
		out[code] = {
			"on_hand": on_hand,
			"reserved": reserved,
			"available": round(on_hand - reserved, 6),
			"uom": frappe.db.get_value("Item", code, "stock_uom"),
		}
	return {"store": store, "items": out}


@frappe.whitelist()
def request_from_pool(requesting_farm: str, items, reason: str | None = None) -> dict:
	"""A planner asks the general store keeper for stock from the shared pool."""
	_ensure_creator()
	_assert_farm_access(requesting_farm)
	if isinstance(items, str):
		items = json.loads(items or "[]")
	if not items:
		frappe.throw("Name at least one chemical to request.")

	company = farm_company(requesting_farm)
	store = general_store_for(company)
	if not store:
		frappe.throw(
			f"{company or 'This company'} has no general store, so there is no pool "
			"to draw from.",
		)

	doc = frappe.get_doc({
		"doctype": TRANSFER_REQUEST,
		"requesting_farm": requesting_farm,
		"from_general_store": 1,
		"lender_warehouse": store,
		"workflow_state": "Pending Approval",
		"reason": reason,
	})
	short = []
	for row in items:
		code = (row.get("item_code") or "").strip()
		qty = flt(row.get("requested_qty"))
		if not code or qty <= 0:
			continue
		available = _pool_on_hand(store, code) - _reserved_from_pool(store, code)
		if qty > available:
			short.append(code)
		doc.append("items", {
			"item_code": code,
			"uom": row.get("uom") or frappe.db.get_value("Item", code, "stock_uom"),
			"requested_qty": qty,
			"status": "Pending",
			"lender_on_hand": available,
		})
	if not doc.items:
		frappe.throw("Name at least one chemical to request.")
	doc.flags.ignore_mandatory = True
	doc.insert(ignore_permissions=True)

	credits = {
		r.item_code: flt(r.credit_qty)
		for r in frappe.get_all(
			CREDIT,
			filters={"farm": requesting_farm,
			         "item_code": ("in", [i.item_code for i in doc.items])},
			fields=["item_code", "credit_qty"],
		)
	}
	owed = ", ".join(f"{k} {v:g}" for k, v in credits.items() if v > 0)
	notify(
		_keepers_of(store),
		f"{requesting_farm} is asking for {len(doc.items)} item(s) from the pool",
		(reason or "") + (f"\n\nAlready owed to this farm: {owed}." if owed else ""),
		ref_doctype=TRANSFER_REQUEST,
		ref_name=doc.name,
		category="transfer",
	)
	frappe.db.commit()
	# `short` is reported, not refused: the keeper may know stock is arriving, and
	# a planner should not have to guess the pool's contents to ask a question.
	return {"name": doc.name, "over_available": short, "credits": credits}


def _keepers_of(store: str) -> list[str]:
	users = frappe.get_all("Farm Store Keeper", filters={"warehouse": store}, pluck="user")
	return users or []


@frappe.whitelist()
def list_pool_requests(box: str = "incoming") -> list[dict]:
	"""`incoming` = waiting on the keeper; `outgoing` = raised by my farms."""
	filters = {"from_general_store": 1}
	if box == "outgoing":
		allowed = _user_farms()
		if allowed is not None:
			filters["requesting_farm"] = ("in", list(allowed) or [""])
	rows = frappe.get_all(
		TRANSFER_REQUEST,
		filters=filters,
		fields=[
			"name", "requesting_farm", "lender_warehouse", "workflow_state",
			"reason", "rejected_reason", "creation", "owner",
		],
		order_by="creation desc",
		limit_page_length=100,
	)
	for r in rows:
		r["items"] = frappe.get_all(
			"Chemical Transfer Request Item",
			filters={"parent": r.name},
			fields=[
				"item_code", "item_name", "uom", "requested_qty", "status",
				"approved_qty", "lender_on_hand", "stock_entry",
			],
			order_by="idx asc",
		)
	return rows


@frappe.whitelist()
def decide_pool_request(request: str, decisions, reason: str | None = None) -> dict:
	"""The general store keeper's per-line decision, then one Stock Entry.

	Availability is re-checked here rather than trusted from request time: the
	pool is shared, and the number the planner saw may be minutes old.
	"""
	doc = frappe.get_doc(TRANSFER_REQUEST, request)
	if not doc.from_general_store:
		frappe.throw(f"{request} is not a pool request.")
	if not _keeper_of(doc.lender_warehouse):
		frappe.throw(
			"Only the keeper of the general store can decide this request.",
			frappe.PermissionError,
		)
	if doc.workflow_state not in ("Pending Approval", "Draft"):
		frappe.throw(f"{request} is already {doc.workflow_state.lower()}.")

	if isinstance(decisions, str):
		decisions = json.loads(decisions or "[]")
	wanted = {d.get("item_code"): d for d in decisions or []}
	if not wanted:
		frappe.throw("Nothing decided.")

	for row in doc.items:
		d = wanted.get(row.item_code)
		if not d:
			continue
		status = d.get("status")
		if status not in ("Approved", "Rejected"):
			frappe.throw(f"{row.item_code}: decide Approved or Rejected.")
		if status == "Rejected":
			row.status = "Rejected"
			row.approved_qty = 0
			continue
		qty = flt(d.get("approved_qty") or row.requested_qty)
		available = _pool_on_hand(doc.lender_warehouse, row.item_code) - _reserved_from_pool(
			doc.lender_warehouse, row.item_code, exclude=doc.name
		)
		if qty > available:
			frappe.throw(
				f"{row.item_code}: only {available:g} is still free in the pool "
				f"(the rest is already promised).",
			)
		row.status = "Approved"
		row.approved_qty = qty

	approved = [r for r in doc.items if r.status == "Approved" and flt(r.approved_qty) > 0]
	if approved:
		se = _move_from_pool(doc, approved)
		for r in approved:
			r.stock_entry = se
		doc.workflow_state = "Fulfilled"
	else:
		doc.workflow_state = "Rejected"
		doc.rejected_reason = reason
	doc.flags.ignore_mandatory = True
	doc.save(ignore_permissions=True)

	notify(
		users_for_farm(doc.requesting_farm),
		f"Pool request {doc.name} {doc.workflow_state.lower()}",
		"\n".join(
			f"{r.item_code}: {r.status}"
			+ (f" {flt(r.approved_qty):g} {r.uom or ''}" if r.status == "Approved" else "")
			for r in doc.items
		),
		ref_doctype=TRANSFER_REQUEST,
		ref_name=doc.name,
		category="transfer",
	)
	frappe.db.commit()
	return {"name": doc.name, "state": doc.workflow_state}


def _move_from_pool(doc, rows) -> str:
	"""One Material Transfer out of the pool into the farm's own stores.

	Per-row target warehouse, because a chemical and a foliar in the same request
	belong in different stores at the destination.
	"""
	company = frappe.db.get_value("Warehouse", doc.lender_warehouse, "company")
	se = frappe.get_doc({
		"doctype": "Stock Entry",
		"stock_entry_type": "Material Transfer",
		"purpose": "Material Transfer",
		"company": company,
		"posting_date": nowdate(),
	})
	for r in rows:
		target = store_for(doc.requesting_farm, r.item_code)
		if not target:
			frappe.throw(
				f"{doc.requesting_farm} has no store for {r.item_code}, so there is "
				"nowhere to transfer it to.",
			)
		se.append("items", {
			"item_code": r.item_code,
			"qty": flt(r.approved_qty),
			"uom": r.uom or frappe.db.get_value("Item", r.item_code, "stock_uom"),
			"stock_uom": frappe.db.get_value("Item", r.item_code, "stock_uom"),
			"conversion_factor": 1,
			"s_warehouse": doc.lender_warehouse,
			"t_warehouse": target,
		})
	se.flags.ignore_permissions = True
	se.insert(ignore_permissions=True)
	se.submit()
	return se.name
