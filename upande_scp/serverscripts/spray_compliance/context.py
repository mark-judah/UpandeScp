"""The only spray-compliance module that reads the database. Builds the plain
context dict that `rules.py` / `engine.py` evaluate (shape documented there)."""

import frappe
from frappe.utils import add_days, now_datetime

from ..spray_plan_creator import crop_settings
from . import rules as R
from .engine import RULES

ACTIVE_STATES = ("Approved", "Chemical Issued", "Tank Mix Manufactured", "Spraying In Progress", "Completed")
SETTINGS = "Scouting and Crop Protection Settings"


def crop_for_greenhouse(greenhouse: str) -> str:
	farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm") if greenhouse else None
	if not farm:
		return ""
	row = frappe.db.sql("""select parent from `tabFarm Filter` where farm=%s
	                       and parenttype='Crop Scouted' and parentfield='farms' order by idx limit 1""", farm)
	return row[0][0] if row else ""


def _child(table, field, parents):
	out = {}
	if not parents:
		return out
	for r in frappe.db.sql(f"""select parent, `{field}` v from `tab{table}`
	                           where parenttype='Spray Product' and parent in %(p)s order by idx""",
	                       {"p": tuple(parents)}, as_dict=True):
		if r.v and r.v not in out.get(r.parent, []):
			out.setdefault(r.parent, []).append(r.v)
	return out


def load_products(items) -> dict:
	items = sorted({i for i in items if i})
	if not items:
		return {}
	rows = frappe.db.sql("""select name, product_name, category, ifnull(type,'') type
	                        from `tabSpray Product` where name in %(i)s""", {"i": tuple(items)}, as_dict=True)
	names = [r.name for r in rows]
	# Hand-entered codes (top-up) ...
	irac, frac = _child("IRAC Code Filter", "code", names), _child("FRAC Code Filter", "code", names)
	# ... plus the codes of the linked ingredients, read live (spec D9).
	ingr = {}
	for r in frappe.db.sql("""select ai.parent, ai.active_ingredient ing, m.irac_code, m.frac_code
	                          from `tabActive Ingredient` ai
	                          left join `tabActive Ingredient MoA` m on m.name = ai.active_ingredient
	                          where ai.parenttype='Spray Product' and ai.parentfield='active_ingredients'
	                            and ai.parent in %(p)s order by ai.idx""",
	                       {"p": tuple(names or [""])}, as_dict=True):
		if r.ing:
			ingr.setdefault(r.parent, []).append(r.ing)
		for bucket, code in ((irac, r.irac_code), (frac, r.frac_code)):
			if code and code not in bucket.get(r.parent, []):
				bucket.setdefault(r.parent, []).append(code)
	targets = {}
	for r in frappe.db.sql("""select parent, ifnull(pest, disease) t from `tabChemical Targets`
	                          where parenttype='Spray Product' and parentfield='default_targets'
	                          and parent in %(p)s order by idx""", {"p": tuple(names or [""])}, as_dict=True):
		if r.t:
			targets.setdefault(r.parent, []).append(r.t)
	return {r.name: {"name": r.product_name or r.name, "category": r.category, "type": r.type,
	                 "targets": targets.get(r.name, []), "irac": irac.get(r.name, []),
	                 "frac": frac.get(r.name, []), "ingredients": ingr.get(r.name, [])}
	        for r in rows}


def load_history(greenhouse, crop, exclude_wo=None, now=None) -> list[dict]:
	if not greenhouse:
		return []
	now = now or now_datetime()
	days = max(int(crop_settings.value_for("irac_rotation_window_days", crop) or 0),
	           int(crop_settings.value_for("frac_rotation_window_days", crop) or 0), 1)
	# Max-sprays break periods can be longer than the rotation window.
	days = max([days] + [r["break_days"] for r in _max_sprays_rules()])
	rows = frappe.db.sql("""select wo.name wo, wo.custom_scheduled_application_time `when`, wi.item_code
	                        from `tabWork Order` wo join `tabWork Order Item` wi on wi.parent=wo.name
	                        where wo.custom_greenhouse=%(gh)s and wo.custom_type='Application Floor Plan'
	                          and wo.workflow_state in %(st)s and wo.name!=%(ex)s
	                          and wo.custom_scheduled_application_time >= %(cut)s
	                          and wo.custom_scheduled_application_time <= %(now)s
	                        order by wo.custom_scheduled_application_time, wo.name, wi.idx""",
	                     {"gh": greenhouse, "st": ACTIVE_STATES, "ex": exclude_wo or "",
	                      "cut": add_days(now, -days), "now": now}, as_dict=True)
	out, by = [], {}
	for r in rows:
		if r.wo not in by:
			by[r.wo] = {"wo": r.wo, "when": str(r.when)[:19], "items": []}
			out.append(by[r.wo])
		by[r.wo]["items"].append(r.item_code)
	return out


def _guideline(doctype, name):
	g = frappe.db.get_value(doctype, name, ["enabled", "parameters"], as_dict=True)
	return g.parameters if g and g.enabled else None


def _max_sprays_rules():
	return R.parse_max_sprays(_guideline("FRAC Guideline", "Max Number Of Sprays")) + \
	       R.parse_max_sprays(_guideline("IRAC Guideline", "Max Number Of Sprays"))


def load_guidelines() -> dict:
	return {
		"alternate_moa": {"irac": R.parse_alternate_moa(_guideline("IRAC Guideline", "Alternate MoA")),
		                  "frac": R.parse_alternate_moa(_guideline("FRAC Guideline", "Alternate MoA"))},
		"max_sprays": _max_sprays_rules(),
		"known_resistance": R.parse_known_resistance(_guideline("IRAC Guideline", "Target With Known Resistance"), "irac") +
		                    R.parse_known_resistance(_guideline("FRAC Guideline", "Target With Known Resistance"), "frac"),
	}


def load_incompatibilities() -> list[dict]:
	return frappe.get_all("Tank Mix Incompatibility", filters={"parent": SETTINGS, "parenttype": SETTINGS},
	                      fields=["product_a", "product_b", "ingredient_a", "ingredient_b", "reason"],
	                      order_by="idx")


def load_modes(crop) -> dict:
	return {r: crop_settings.value_for(f"rule_{r}", crop) or "Warn" for r in RULES}


def build_context(*, greenhouse, targets, mix, exclude_wo=None, crop=None) -> dict:
	crop = crop if crop is not None else crop_for_greenhouse(greenhouse)
	now = now_datetime()
	history = load_history(greenhouse, crop, exclude_wo, now)
	items = set(mix) | {i for h in history for i in h["items"]}
	return {
		"crop": crop, "targets": [t for t in targets or [] if t], "mix": [m for m in mix or [] if m],
		"products": load_products(items), "history": history, "guidelines": load_guidelines(),
		"incompatibilities": load_incompatibilities(), "modes": load_modes(crop),
		"now": now.strftime("%Y-%m-%d %H:%M:%S"),
	}


def context_for_wo(wo) -> dict:
	return build_context(greenhouse=wo.custom_greenhouse,
	                     targets=(wo.custom_targets or "").split("\n"),
	                     mix=[r.item_code for r in wo.required_items], exclude_wo=wo.name)


def pest_control_items() -> list[str]:
	return frappe.get_all("Spray Product", filters={"disabled": 0}, pluck="name")
