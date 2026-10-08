"""Spray-compliance endpoints for the creator UI, plus helpers the save and
approval paths share. The server decides; the UI only shows the decision."""

import frappe
from frappe.utils import now_datetime

from . import context as C
from . import engine as E

OVERRIDE_ROLES = {"SCP General Manager", "System Manager"}
_SEVERITY = {E.OFF: 0, E.WARN: 1, E.GM: 2, E.BLOCK: 3}


def _list(v):
	if v is None or v == "":
		return []
	return frappe.parse_json(v) if isinstance(v, str) else list(v)


def can_override(user=None) -> bool:
	user = user or frappe.session.user
	return user == "Administrator" or bool(OVERRIDE_ROLES & set(frappe.get_roles(user)))


def _honoured(overrides):
	"""Overrides count only when the caller is allowed to give them."""
	return _list(overrides) if can_override() else []


@frappe.whitelist()
def check_spray_plan(greenhouse, targets, items, overrides=None, exclude_wo=None):
	ctx = C.build_context(greenhouse=greenhouse, targets=_list(targets), mix=_list(items), exclude_wo=exclude_wo)
	result = E.check_mix(ctx, _honoured(overrides))
	result["can_override"] = can_override()
	return result


@frappe.whitelist()
def eligible_products(greenhouse, targets, items=None, candidates=None):
	ctx = C.build_context(greenhouse=greenhouse, targets=_list(targets), mix=_list(items))
	cands = _list(candidates) or C.pest_control_items()
	ctx["products"].update(C.load_products([c for c in cands if c not in ctx["products"]]))
	rows = E.evaluate_candidates(ctx, cands)
	for r in rows:
		r["name"] = (ctx["products"].get(r["item"]) or {}).get("name") or r["item"]
	rows.sort(key=lambda r: (not r["eligible"], r["non_target"], _SEVERITY[r["worst_mode"]], r["name"].lower()))
	return rows


@frappe.whitelist()
def eligible_boms(greenhouse, targets, boms):
	boms = _list(boms)
	if not boms:
		return []
	items = {}
	for r in frappe.db.sql("""select parent, item_code from `tabBOM Item` where parent in %(b)s order by idx""",
	                       {"b": tuple(boms)}, as_dict=True):
		items.setdefault(r.parent, []).append(r.item_code)
	ctx = C.build_context(greenhouse=greenhouse, targets=_list(targets), mix=[])
	ctx["products"].update(C.load_products({i for v in items.values() for i in v} - set(ctx["products"])))
	out = []
	for bom in boms:
		res = E.check_mix({**ctx, "mix": items.get(bom, [])})
		out.append({"bom": bom, "eligible": not res["violations"], "status": res["status"],
		            "coverage": res["coverage"], "reasons": [v["message"] for v in res["violations"]],
		            "worst_mode": max((v["mode"] for v in res["violations"]), key=_SEVERITY.get, default=E.OFF)})
	return out


def result_for_payload(payload, exclude_wo=None) -> dict:
	ctx = C.build_context(greenhouse=payload.get("custom_greenhouse"),
	                      targets=payload.get("custom_targets") or [],
	                      mix=[c.get("item_code") for c in payload.get("chemicals") or []],
	                      exclude_wo=exclude_wo)
	return E.check_mix(ctx, payload.get("spray_rule_overrides") or [] if can_override() else [])


def _message(result) -> str:
	return "\n".join(f"• {v['message']}" for v in result["violations"]
	                 if v["mode"] in (E.BLOCK, E.GM) and not v["overridden"])


def stored_overrides(wo) -> list[dict]:
	"""The WO's override rows that still count: given by someone allowed to
	override, with a reason. A row a non-GM wrote straight onto the WO does not."""
	return [{"key": r.subject, "reason": r.reason}
	        for r in wo.get("custom_spray_rule_overrides") or []
	        if r.subject and (r.reason or "").strip() and r.overridden_by and can_override(r.overridden_by)]


def enforce_on_save(payload, wo, exclude_wo=None) -> dict:
	"""Check a draft before it is written. A hard block throws; otherwise the
	status and the honoured overrides are written onto `wo`."""
	overrides = [o for o in payload.get("spray_rule_overrides") or []
	             if o.get("key") and (o.get("reason") or "").strip()]
	if overrides and not can_override():
		overrides = []
	result = result_for_payload({**payload, "spray_rule_overrides": overrides}, exclude_wo)
	if any(v["mode"] == E.BLOCK for v in result["violations"]):
		frappe.throw(_message(result), title="Spray check failed")
	wo.custom_compliance_status = result["status"]
	by_key = {o["key"]: o for o in overrides}
	now = now_datetime()
	wo.set("custom_spray_rule_overrides", [
		{"rule": v["rule"], "subject": v["key"], "reason": by_key[v["key"]]["reason"].strip(),
		 "overridden_by": frappe.session.user, "overridden_on": now}
		for v in result["violations"] if v["overridden"]
	])
	result["can_override"] = can_override()
	return result


def enforce_on_approval(wo) -> dict | None:
	"""None when the WO may be approved, else {"reason": ...}."""
	result = E.check_mix(C.context_for_wo(wo), stored_overrides(wo))
	if result["blocking"]:
		return {"reason": _message(result)}
	return None
