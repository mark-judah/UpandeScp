"""Spray-compliance endpoints for the creator UI, plus helpers the save and
approval paths share. The server decides; the UI only shows the decision."""

import frappe

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
