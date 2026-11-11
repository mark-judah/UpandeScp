"""The only spray-compliance module that reads the database. Builds the plain
context dict that `rules.py` / `engine.py` evaluate (shape documented there)."""

import frappe
from frappe.utils import add_days, get_datetime, now_datetime

from ..common import crop_catalog
from ..spray_plan_creator import crop_settings
from . import rules as R
from .engine import RULES

# Every Application Floor Plan state that means approved-or-later, taken from the
# states present in the data (no Work Order workflow is installed on kaitet.local).
# Awaiting Approval / Pending Submission are drafts; a NULL state only occurs on
# draft or cancelled AFP rows, so it is excluded.
ACTIVE_STATES = ("Approved", "Chemical Issued", "Chemicals Issued Direct", "Tank Mix Manufactured",
                 "Spraying In Progress", "Completed")
SETTINGS = "Scouting and Crop Protection Settings"


def crop_for_greenhouse(greenhouse: str) -> str:
	"""The greenhouse's crop, or "" — kept as the "" -returning wrapper callers and
	`build_context` expect. The rule itself lives in `common.crop_catalog`."""
	return crop_catalog.crop_for_greenhouse(greenhouse) or ""


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
	for r in frappe.db.sql("""select parent, coalesce(nullif(pest,''), nullif(disease,'')) t from `tabChemical Targets`
	                          where parenttype='Spray Product' and parentfield='default_targets'
	                          and parent in %(p)s order by idx""", {"p": tuple(names or [""])}, as_dict=True):
		if r.t:
			targets.setdefault(r.parent, []).append(r.t)
	impacts = load_impacts(names)
	return {r.name: {"name": r.product_name or r.name, "category": r.category, "type": r.type,
	                 "targets": targets.get(r.name, []), "irac": irac.get(r.name, []),
	                 "frac": frac.get(r.name, []), "ingredients": ingr.get(r.name, []),
	                 "impacts": impacts.get(r.name, [])}
	        for r in rows}


def impact_class(value) -> int:
	"""'3 - Moderately harmful' -> 3; anything unreadable -> 0 (no claim)."""
	try:
		return int(str(value or "0").strip()[0])
	except (ValueError, IndexError):
		return 0


def load_impacts(products) -> dict:
	"""{spray product: [{ingredient, predator, stage, cls, mortality, persistence, verified}]} from
	the predator-impact rows of each product's active ingredients."""
	if not products:
		return {}
	out = {}
	for r in frappe.db.sql("""select ai.parent product, ai.active_ingredient ing, i.predator, i.stage, i.impact_class,
	                                 i.mortality_pct, i.persistence_days, i.verified
	                          from `tabActive Ingredient` ai
	                          join `tabActive Ingredient Predator Impact` i
	                            on i.parent = ai.active_ingredient and i.parenttype = 'Active Ingredient MoA'
	                           and i.parentfield = 'predator_impacts'
	                          where ai.parenttype='Spray Product' and ai.parentfield='active_ingredients'
	                            and ai.parent in %(p)s order by ai.idx, i.idx""",
	                       {"p": tuple(products)}, as_dict=True):
		out.setdefault(r.product, []).append({
			"ingredient": r.ing, "predator": r.predator, "stage": r.stage or "", "cls": impact_class(r.impact_class),
			"mortality": float(r.mortality_pct or 0), "persistence": int(r.persistence_days or 0),
			"verified": bool(r.verified)})
	return out


def presence_days(crop) -> int:
	try:
		return int(crop_settings.value_for("predator_presence_days", crop) or 14)
	except (TypeError, ValueError):
		return 14


def load_predators(greenhouse, now, days) -> list[dict]:
	"""Predators present in `greenhouse` in the `days` before `now`: submitted Biological Releases
	and predators counted in scouting. [{predator, stage, qty, when, source}]."""
	if not greenhouse or days <= 0:
		return []
	cut = add_days(now, -days)
	out = []
	for r in frappe.db.sql("""select predator, stage, quantity qty, released_at `when` from `tabBiological Release`
	                          where docstatus=1 and greenhouse=%(gh)s and released_at between %(cut)s and %(now)s""",
	                       {"gh": greenhouse, "cut": cut, "now": now}, as_dict=True):
		out.append({"predator": r.predator, "stage": r.stage or "", "qty": float(r.qty or 0),
		            "when": str(r.when)[:19], "source": "released"})
	for r in frappe.db.sql("""select p.predator, p.stage, p.count qty,
	                                 timestamp(s.date_of_capture, ifnull(s.time_of_capture, '00:00:00')) `when`
	                          from `tabPredators Scouting Entry` p join `tabScouting Entry` s on s.name = p.parent
	                          where s.greenhouse=%(gh)s and ifnull(p.count,0) > 0
	                            and s.date_of_capture between date(%(cut)s) and date(%(now)s)
	                          having `when` between %(cut)s and %(now)s""",
	                       {"gh": greenhouse, "cut": cut, "now": now}, as_dict=True):
		out.append({"predator": r.predator, "stage": r.stage or "", "qty": float(r.qty or 0),
		            "when": str(r.when)[:19], "source": "seen in scouting"})
	return out


def untargeted_items() -> list[str]:
	"""Items whose Spray Product is pest-control with no registered target
	(`rules.is_untargeted`, in SQL). They are never offered: the chemical search
	and the tank-mix list drop them on the server, so they are not even fetched."""
	return frappe.db.sql_list("""select sp.item from `tabSpray Product` sp
	                             where ifnull(sp.item,'')<>'' and ifnull(sp.category,'')<>'Foliar'
	                               and ifnull(sp.type,'') not in %(nt)s
	                               and not exists (select 1 from `tabChemical Targets` t
	                                               where t.parenttype='Spray Product' and t.parentfield='default_targets'
	                                                 and t.parent=sp.name
	                                                 and coalesce(nullif(t.pest,''), nullif(t.disease,'')) is not null)""",
	                          {"nt": tuple(R.NON_TARGET_TYPES)})


def boms_with_untargeted(boms) -> set[str]:
	"""The BOMs among `boms` that carry an untargeted item."""
	boms, bad = list(boms or []), untargeted_items()
	if not boms or not bad:
		return set()
	return set(frappe.db.sql_list("""select distinct parent from `tabBOM Item`
	                                 where parenttype='BOM' and parent in %(b)s and item_code in %(i)s""",
	                              {"b": tuple(boms), "i": tuple(bad)}))


def anchor(when=None):
	"""The moment a plan is judged at: its scheduled spray time, else now.
	Plans are made ahead, so "now" would miss approved sprays due before it."""
	return get_datetime(when) if when else now_datetime()


def load_history(greenhouse, crop, exclude_wo=None, when=None) -> list[dict]:
	"""Approved-or-later sprays on `greenhouse` scheduled before `when` (the
	plan's own spray time), within the longest window any rule looks back."""
	if not greenhouse:
		return []
	when = anchor(when)
	days = max(int(crop_settings.value_for("irac_rotation_window_days", crop) or 0),
	           int(crop_settings.value_for("frac_rotation_window_days", crop) or 0), 1)
	# Max-sprays break periods can be longer than the rotation window.
	days = max([days] + [r["break_days"] for r in _max_sprays_rules()])
	rows = frappe.db.sql("""select wo.name wo, wo.custom_scheduled_application_time `when`, wi.item_code
	                        from `tabWork Order` wo join `tabWork Order Item` wi on wi.parent=wo.name
	                        where wo.custom_greenhouse=%(gh)s and wo.custom_type='Application Floor Plan'
	                          and wo.workflow_state in %(st)s and wo.name!=%(ex)s
	                          and wo.custom_scheduled_application_time >= %(cut)s
	                          and wo.custom_scheduled_application_time < %(when)s
	                        order by wo.custom_scheduled_application_time, wo.name, wi.idx""",
	                     {"gh": greenhouse, "st": ACTIVE_STATES, "ex": exclude_wo or "",
	                      "cut": add_days(when, -days), "when": when}, as_dict=True)
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


def build_context(*, greenhouse, targets, mix, exclude_wo=None, crop=None, when=None) -> dict:
	"""`when` = the plan's scheduled spray time; history and the rules'
	"now" are anchored there (falls back to the current time)."""
	crop = crop if crop is not None else crop_for_greenhouse(greenhouse)
	now = anchor(when)
	history = load_history(greenhouse, crop, exclude_wo, now)
	items = set(mix) | {i for h in history for i in h["items"]}
	return {
		"crop": crop, "targets": [t.strip() for t in targets or [] if t and t.strip()], "mix": [m for m in mix or [] if m],
		"products": load_products(items), "history": history, "guidelines": load_guidelines(),
		"incompatibilities": load_incompatibilities(), "modes": load_modes(crop),
		"now": now.strftime("%Y-%m-%d %H:%M:%S"),
		"predators": load_predators(greenhouse, now, presence_days(crop)),
	}


def context_for_wo(wo) -> dict:
	return build_context(greenhouse=wo.custom_greenhouse,
	                     targets=(wo.custom_targets or "").split("\n"),
	                     mix=[r.item_code for r in wo.required_items], exclude_wo=wo.name,
	                     when=wo.custom_scheduled_application_time)


def pest_control_items() -> list[str]:
	return frappe.get_all("Spray Product", filters={"disabled": 0}, pluck="name")
