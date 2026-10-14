"""Which pest or disease a chemical's cost belongs to - recorded first, then derived.

`allocate` is a pure function (no database): it splits one product line over
targets and says on what basis. It serves two paths:

  * SPRAY PLAN lines have a candidate set T (the plan's targets).
  * DIRECT material-issue lines have no plan, so no T (`candidates=None`).

Every product has a COST GROUP (Spray Product.custom_cost_group; blank = derived from
category / type): Pest control, Foliar, Adjuvant, pH buffer, Hygiene & sanitation, Post-harvest.
Only Pest control is attributed to pests. The rest is reported SEPARATELY, never added
into pest totals:
  Foliar, Adjuvant, pH buffer
      spray path  -> split equally over the plan's targets ("foliar_equal"); no T -> "foliar_farm".
      direct path -> not target-specific, not split ("foliar_farm").
  Hygiene & sanitation, Post-harvest
      never split to pests on either path ("non_pest"), their own lines.
An EXPLICIT group always wins. With none set: category Foliar / FER* / type Adjuvant / pH Buffer
give their group; a spray-plan line is Pest control; on the DIRECT path the evidence decides:
used on a spray plan in the last 365 days, or any ingredient / registration known -> Pest
control (its shares come from its spray-plan history); otherwise "Unclassified" (own line,
the GM is asked to set its group). No product is ever classified by name.

A CHEMICAL line, first that applies wins:

  recorded         the plan declares which of its targets this row is for
                   (Work Order Item.custom_targets): split equally across those. 100% credible.
  band1_ai_target  the product's active ingredients (plus its own registrations)
                   are known to work on targets in T. (est. 89%)
  band1_ai_class   the ingredient class splits T (Insecticide, Biological -> pests;
                   Fungicide -> diseases) and the subset is smaller than T. (est. 64%)
  band2_alone      counts of the product on SINGLE-target plans in the 180 days before
                   the line (>= 2 plans, a hit inside T): weight (count+0.25)^2. (est. 93%)
  band3_radar      fractional counts over all plans (>= 3 plans): (count+0.5)^2. (est. 67%)
  equal            equal over T, the last resort. (est. 38%)  T empty -> unattributed.

Inside a Band 1 subset the weights come from Band 2 counts if available, else
Band 3, else equal. Direct path chemicals: band1 (ingredient targets) -> band2
(targets it was used alone for) -> band3 -> unattributed. Scouting pressure is
NOT used (a backtest showed it lowers accuracy).

Shares always sum to 1 per line, so spend reconciles exactly.

Reference data (the plan history) is read by ONE aggregate query per report run
and cached for an hour per window.
"""

from __future__ import annotations

import json
import os
import re
from bisect import bisect_left
from functools import lru_cache

import frappe
from frappe.utils import add_days, flt, getdate, today

UNATTRIBUTED = "Unattributed"
WINDOW_DAYS = 180
MIN_ALONE_PLANS = 2
MIN_RADAR_PLANS = 3
ALONE_SMOOTH = 0.25
RADAR_SMOOTH = 0.5
NON_PROTECTIVE_TYPES = ("Adjuvant", "pH Buffer")
PEST_CLASSES = ("Insecticide", "Biological")
DISEASE_CLASSES = ("Fungicide",)

PEST_CONTROL = "Pest control"
COST_GROUPS = ("Pest control", "Foliar", "Adjuvant", "pH buffer", "Hygiene & sanitation", "Post-harvest")
UNCLASSIFIED = "Unclassified"
NON_PEST_GROUPS = COST_GROUPS[1:] + (UNCLASSIFIED,)
#: groups split equally over a plan's targets (farm-level without a plan)
SPLIT_GROUPS = ("Foliar", "Adjuvant", "pH buffer")
#: how each non-pest group is treated, for the UI and the export
GROUP_TREATMENT = {
	"Foliar": "split equally across the plan's targets; not target-specific on direct issues",
	"Adjuvant": "split equally across the plan's targets; not target-specific on direct issues",
	"pH buffer": "split equally across the plan's targets; not target-specific on direct issues",
	"Hygiene & sanitation": "not target-specific, never split to pests",
	"Post-harvest": "not target-specific, never split to pests",
	UNCLASSIFIED: "not placed: never used on a spray plan and no ingredient known. Set its cost group",
}


def default_cost_group(product: dict, direct: bool = False, uses: int = 0, evidence: bool = False) -> str:
	"""The group when none is set: category Foliar / FER* -> Foliar, type Adjuvant -> Adjuvant,
	pH Buffer -> pH buffer, otherwise Pest control."""
	if product.get("category") == "Foliar" or (product.get("code") or "").upper().startswith("FER"):
		return "Foliar"
	if product.get("type") == "Adjuvant":
		return "Adjuvant"
	if product.get("type") == "pH Buffer":
		return "pH buffer"
	if direct and not uses and not evidence:
		return UNCLASSIFIED
	return PEST_CONTROL


def cost_group(product: dict, direct: bool = False, uses: int = 0, evidence: bool = False) -> str:
	g = product.get("cost_group")
	return g if g in COST_GROUPS else default_cost_group(product, direct, uses, evidence)


BASES = (
	"recorded",
	"band1_ai_target",
	"band1_ai_class",
	"band2_alone",
	"band3_radar",
	"equal",
	"foliar_equal",
	"foliar_farm",
	"non_pest",
	"unclassified",
	"unattributed",
)
#: bases that are not pest-control attribution
FOLIAR_BASES = ("foliar_equal", "foliar_farm", "non_pest", "unclassified")
#: Backtested accuracy per basis, by path (shown as a tooltip in the UI).
ACCURACY = {
	"spray": {
		"recorded": 1.0,
		"band1_ai_target": 0.89,
		"band1_ai_class": 0.64,
		"band2_alone": 0.93,
		"band3_radar": 0.67,
		"equal": 0.38,
	},
	"direct": {"band2_alone": 0.84, "band3_radar": 0.45},
}


def credibility(basis: str, path: str = "spray") -> dict:
	"""How far to trust a figure: Recorded (declared on the plan), Derived (est. accuracy),
	Foliar (a rule, not an estimate) or Unattributed."""
	if basis == "recorded":
		return {"kind": "recorded", "label": "Recorded", "accuracy": 1.0}
	if basis in FOLIAR_BASES:
		label = {"foliar_equal": "Split equally across plan targets",
		         "unclassified": "Unclassified \u2014 set its cost group"}.get(basis, "Not target-specific")
		return {"kind": "nonpest", "label": label, "accuracy": None}
	if basis == "unattributed":
		return {"kind": "unattributed", "label": "Unattributed", "accuracy": None}
	acc = (ACCURACY.get(path) or {}).get(basis)
	name = {
		"band1_ai_target": "active ingredient",
		"band1_ai_class": "ingredient class",
		"band2_alone": "used alone",
		"band3_radar": "usage radar",
		"equal": "equal split",
	}.get(basis, basis)
	if path == "direct" and basis in ("band2_alone", "band3_radar"):
		name += " in its spray-plan history"
	label = f"Derived \u2014 {name}" + (f", est. {round(acc * 100)}%" if acc is not None else ", accuracy not backtested")
	return {"kind": "derived", "label": label, "accuracy": acc}

_SEED = os.path.join(os.path.dirname(__file__), "attribution_seed.json")


@lru_cache(maxsize=1)
def load_seed() -> dict:
	with open(_SEED, encoding="utf-8") as f:
		return json.load(f)


def norm(s) -> str:
	"""Letters and digits only, lower case: the key every seed table uses."""
	return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def canon_ingredient(name, kb) -> str:
	k = norm(name)
	return (kb.get("alias") or {}).get(k, k)


# --- Product facts --------------------------------------------------------------


def match_product_name(names, kb) -> str | None:
	"""The seed `prod_ai` key matching a product name: exact, or a prefix either way
	with both sides at least 5 characters. The longest key wins."""
	table = kb.get("prod_ai") or {}
	best = None
	for n in names:
		nn = norm(n)
		if not nn:
			continue
		if nn in table:
			return nn
		if len(nn) < 5:
			continue
		for k in table:
			if len(k) >= 5 and (nn.startswith(k) or k.startswith(nn)):
				if best is None or len(k) > len(best):
					best = k
	return best


def resolve_product(product: dict, kb: dict, mona_ai_t: dict | None = None) -> dict:
	"""Derive what the bands need from a raw product (cached on the dict).

	product: {code, name, item_name, category, type, ingredients: [str], registered: [target],
	          irac: bool, frac: bool, cost_group: str}"""
	if "_r" in product:
		return product["_r"]
	mona_ai_t = mona_ai_t or {}
	ings = {canon_ingredient(i, kb) for i in product.get("ingredients") or [] if norm(i)}
	key = match_product_name([product.get("name"), product.get("item_name")], kb)
	if key:
		ings |= {canon_ingredient(i, kb) for i in kb["prod_ai"][key]}
	own = set(product.get("registered") or [])
	if key:
		own |= set((kb.get("prods") or {}).get(key) or [])
	s = set(own)
	for c in ings:
		s |= set((kb.get("ai_t") or {}).get(c) or {})
		s |= set(mona_ai_t.get(c) or {})
	kinds = {(kb.get("kind") or {}).get(c) for c in ings}
	if product.get("irac"):
		kinds.add("Insecticide")
	if product.get("frac"):
		kinds.add("Fungicide")
	r = {
		"code": product.get("code"),
		"ingredients": sorted(ings),
		"targets": s,
		"pest_class": bool(kinds & set(PEST_CLASSES)),
		"disease_class": bool(kinds & set(DISEASE_CLASSES)),
		"evidence": bool(ings or s),
	}
	product["_r"] = r
	return r


# --- History (Band 2 / Band 3) ----------------------------------------------------


def _window(refs, code, on_date, exclude_wo):
	"""Plans using `code` in the 180 days before `on_date` (all history when no date)."""
	entries = (refs.get("plans") or {}).get(code) or []
	if not on_date:
		return [e for e in entries if e[1] != exclude_wo]
	d = str(getdate(on_date))
	lo = str(add_days(d, -WINDOW_DAYS))
	dates = refs.setdefault("_dates", {}).get(code)
	if dates is None:
		dates = refs["_dates"][code] = [e[0] for e in entries]
	i, j = bisect_left(dates, lo), bisect_left(dates, d)
	return [e for e in entries[i:j] if e[1] != exclude_wo]


def history_counts(refs, code, on_date=None, exclude_wo=None) -> dict:
	"""{"alone": {plans, targets}, "radar": {plans, targets}} for one product."""
	alone = {"plans": 0, "targets": {}}
	radar = {"plans": 0, "targets": {}}
	for _d, _wo, ts in _window(refs, code, on_date, exclude_wo):
		radar["plans"] += 1
		for t in ts:
			radar["targets"][t] = radar["targets"].get(t, 0.0) + 1.0 / len(ts)
		if len(ts) == 1:
			alone["plans"] += 1
			alone["targets"][ts[0]] = alone["targets"].get(ts[0], 0.0) + 1.0
	return {"alone": alone, "radar": radar}


def _norm_shares(weights: dict) -> dict:
	tot = sum(weights.values())
	return {t: w / tot for t, w in weights.items()} if tot else {}


def _weigh(subset, hist) -> dict:
	"""Shares over `subset`: Band 2 counts if usable, else Band 3, else equal."""
	subset = list(subset)
	a, r = hist["alone"], hist["radar"]
	if a["plans"] >= MIN_ALONE_PLANS and any(a["targets"].get(t) for t in subset):
		return _norm_shares({t: (flt(a["targets"].get(t)) + ALONE_SMOOTH) ** 2 for t in subset})
	if r["plans"] >= MIN_RADAR_PLANS:
		return _norm_shares({t: (flt(r["targets"].get(t)) + RADAR_SMOOTH) ** 2 for t in subset})
	return {t: 1.0 / len(subset) for t in subset}


def allocate(
	product: dict,
	candidates,
	refs: dict,
	kb: dict,
	kinds: dict | None = None,
	on_date=None,
	exclude_wo=None,
	recorded=None,
) -> dict:
	"""Split one product line over targets. Returns {"shares": {target: share}, "basis": str}.

	candidates: the plan's targets (spray path) or None (direct path, no plan).
	recorded: the targets the plan declares for this chemical row, if any."""
	r = resolve_product(product, kb, refs.get("mona_ai_t"))
	kinds = kinds or {}

	uses = (refs.get("uses") or {}).get(product.get("code"), 0)
	group = cost_group(product, candidates is None, uses, r["evidence"])
	if group == UNCLASSIFIED and not any(recorded or []):
		return {"shares": {}, "basis": "unclassified", "group": group}
	if group in ("Hygiene & sanitation", "Post-harvest"):
		return {"shares": {}, "basis": "non_pest", "group": group}
	if group in SPLIT_GROUPS:
		T = list(dict.fromkeys(t for t in (candidates or []) if t))
		if T:
			return {"shares": {t: 1.0 / len(T) for t in T}, "basis": "foliar_equal", "group": group}
		return {"shares": {}, "basis": "foliar_farm", "group": group}

	rec = list(dict.fromkeys(t for t in (recorded or []) if t))
	if rec:
		return {"shares": {t: 1.0 / len(rec) for t in rec}, "basis": "recorded"}

	hist = history_counts(refs, product.get("code"), on_date, exclude_wo)
	if candidates is None:
		return _allocate_direct(r, hist)

	T = list(dict.fromkeys(t for t in candidates if t))
	if not T:
		return {"shares": {}, "basis": "unattributed"}
	hit = [t for t in T if t in r["targets"]]
	if hit:
		return {"shares": _weigh(hit, hist), "basis": "band1_ai_target"}

	subset = [
		t
		for t in T
		if (kinds.get(t) == "pest" and r["pest_class"]) or (kinds.get(t) == "disease" and r["disease_class"])
	]
	if subset and len(subset) < len(T):
		return {"shares": _weigh(subset, hist), "basis": "band1_ai_class"}

	a, rd = hist["alone"], hist["radar"]
	if a["plans"] >= MIN_ALONE_PLANS and any(a["targets"].get(t) for t in T):
		w = {t: (flt(a["targets"].get(t)) + ALONE_SMOOTH) ** 2 for t in T}
		return {"shares": _norm_shares(w), "basis": "band2_alone"}
	if rd["plans"] >= MIN_RADAR_PLANS:
		w = {t: (flt(rd["targets"].get(t)) + RADAR_SMOOTH) ** 2 for t in T}
		return {"shares": _norm_shares(w), "basis": "band3_radar"}
	return {"shares": {t: 1.0 / len(T) for t in T}, "basis": "equal"}


def _allocate_direct(r: dict, hist: dict) -> dict:
	"""No plan, so no candidate set: ingredient targets, alone, radar, else unattributed."""
	a, rd = hist["alone"], hist["radar"]
	if r["targets"]:
		subset = sorted(r["targets"])
		if a["plans"] >= MIN_ALONE_PLANS and any(a["targets"].get(t) for t in subset):
			w = {t: (flt(a["targets"].get(t)) + ALONE_SMOOTH) ** 2 for t in subset}
		elif rd["plans"] >= MIN_RADAR_PLANS and any(rd["targets"].get(t) for t in subset):
			w = {t: (flt(rd["targets"].get(t)) + RADAR_SMOOTH) ** 2 for t in subset}
		else:
			w = {t: 1.0 for t in subset}
		return {"shares": _norm_shares(w), "basis": "band1_ai_target"}
	if a["plans"] >= MIN_ALONE_PLANS and a["targets"]:
		w = {t: (c + ALONE_SMOOTH) ** 2 for t, c in a["targets"].items()}
		return {"shares": _norm_shares(w), "basis": "band2_alone"}
	if rd["plans"] >= MIN_RADAR_PLANS and rd["targets"]:
		w = {t: (c + RADAR_SMOOTH) ** 2 for t, c in rd["targets"].items()}
		return {"shares": _norm_shares(w), "basis": "band3_radar"}
	return {"shares": {}, "basis": "unattributed"}


# --- Reference data: one aggregate query per report run ---------------------------


def valid_targets_and_kinds() -> dict:
	kinds = {n: "disease" for n in frappe.get_all("Plant Disease", pluck="name")}
	kinds.update({n: "pest" for n in frappe.get_all("Pest", pluck="name")})
	return kinds


def build_plans(rows, valid_targets) -> dict:
	"""{item_code: [(date, wo, [targets])] sorted by date} from (wo, targets, item_code, date) rows.
	Each (plan, item) counts once; a plan with no valid target counts for nothing."""
	valid = set(valid_targets)
	plan_ts: dict = {}
	seen = set()
	out: dict = {}
	for r in rows:
		wo = r["wo"]
		if wo not in plan_ts:
			ts = []
			for t in (r.get("targets") or "").split("\n"):
				t = t.strip()
				if t and t in valid and t not in ts:
					ts.append(t)
			plan_ts[wo] = ts
		ts = plan_ts[wo]
		if not ts or (wo, r["item_code"]) in seen:
			continue
		seen.add((wo, r["item_code"]))
		out.setdefault(r["item_code"], []).append((str(r["date"])[:10], wo, ts))
	for v in out.values():
		v.sort(key=lambda e: e[0])
	return out


def mona_ingredient_targets(kb) -> dict:
	"""{canonical ingredient: {target: products}} from this site's own Spray Product
	registrations, aggregated by shared ingredient."""
	rows = frappe.db.sql(
		"""SELECT ai.parent, ai.active_ingredient, ai.ingredient,
		          COALESCE(NULLIF(ct.pest,''), NULLIF(ct.disease,'')) AS t
		   FROM `tabActive Ingredient` ai
		   JOIN `tabChemical Targets` ct ON ct.parent = ai.parent AND ct.parenttype = 'Spray Product'
		        AND ct.parentfield = 'default_targets'
		   WHERE ai.parenttype = 'Spray Product' AND ai.parentfield = 'active_ingredients'""",
		as_dict=True,
	)
	out: dict = {}
	seen = set()
	for r in rows:
		if not r.t:
			continue
		c = canon_ingredient(r.active_ingredient or r.ingredient, kb)
		if not c or (r.parent, c, r.t) in seen:
			continue
		seen.add((r.parent, c, r.t))
		d = out.setdefault(c, {})
		d[r.t] = d.get(r.t, 0) + 1
	return out


def plan_uses(end, days: int = 365) -> dict:
	"""{item_code: number of submitted spray plans that used it} over the `days` before `end`."""
	rows = frappe.db.sql(
		"""SELECT ri.item_code, COUNT(DISTINCT wo.name) AS n
		   FROM `tabWork Order` wo JOIN `tabWork Order Item` ri ON ri.parent = wo.name
		   WHERE wo.docstatus = 1 AND wo.custom_type = 'Application Floor Plan'
		     AND DATE(COALESCE(wo.custom_scheduled_application_time, wo.creation)) BETWEEN %(a)s AND %(b)s
		   GROUP BY ri.item_code""",
		{"a": add_days(end, -days), "b": str(end)},
	)
	return {c: int(n) for c, n in rows}


def reference_data_for(start, end, kinds=None, kb=None) -> dict:
	"""History covering lines dated `start`..`end`: the 180 days before `start` through `end`.
	One query; the cache key is the window end."""
	kb = kb or load_seed()
	end = min(str(getdate(end)), str(getdate(today())))
	start = str(getdate(start))
	key = f"scp:attribution_refs:{start}:{end}"
	cache = frappe.cache()
	hit = cache.get_value(key)
	if hit:
		data = json.loads(hit) if isinstance(hit, (str, bytes)) else hit
	else:
		kinds_ = kinds if kinds is not None else valid_targets_and_kinds()
		rows = frappe.db.sql(
			"""
			SELECT wo.name AS wo, wo.custom_targets AS targets, ri.item_code,
			       DATE(COALESCE(wo.custom_scheduled_application_time, wo.creation)) AS date
			FROM `tabWork Order` wo
			JOIN `tabWork Order Item` ri ON ri.parent = wo.name
			WHERE wo.docstatus = 1 AND wo.custom_type = 'Application Floor Plan'
			  AND IFNULL(wo.custom_targets, '') != ''
			  AND DATE(COALESCE(wo.custom_scheduled_application_time, wo.creation)) BETWEEN %(a)s AND %(b)s
			""",
			{"a": add_days(start, -WINDOW_DAYS - 1), "b": end},
			as_dict=True,
		)
		data = {"plans": build_plans(rows, kinds_.keys()), "mona_ai_t": mona_ingredient_targets(kb),
		        "uses": plan_uses(end)}
		cache.set_value(key, json.dumps(data), expires_in_sec=3600)
	data["plans"] = {c: [(d, w, ts) for d, w, ts in v] for c, v in data["plans"].items()}
	return data


# --- Raw product facts for a set of item codes -----------------------------------


def raw_products(codes, kb=None) -> dict:
	"""{item_code: raw product dict for `allocate`}. Batched queries."""
	from upande_scp.serverscripts.spray_compliance import ingredients as ING

	codes = sorted({c for c in codes if c})
	if not codes:
		return {}
	grp = ", IFNULL(custom_cost_group,'') AS cost_group" if frappe.db.has_column("Spray Product", "custom_cost_group") else ""
	sp = {
		r.name: r
		for r in frappe.db.sql(
			f"SELECT name, product_name, category, IFNULL(type,'') AS type{grp} FROM `tabSpray Product` WHERE name IN %(c)s",
			{"c": tuple(codes)},
			as_dict=True,
		)
	}
	item_names = dict(
		frappe.db.sql("SELECT name, item_name FROM `tabItem` WHERE name IN %(c)s", {"c": tuple(codes)})
	)
	registered: dict = {}
	for r in frappe.db.sql(
		"""SELECT parent, COALESCE(NULLIF(pest,''), NULLIF(disease,'')) AS t FROM `tabChemical Targets`
		   WHERE parenttype='Spray Product' AND parentfield='default_targets' AND parent IN %(c)s""",
		{"c": tuple(codes)},
		as_dict=True,
	):
		if r.t:
			registered.setdefault(r.parent, []).append(r.t)

	moa = frappe.get_all("Active Ingredient MoA", fields=["ingredient", "aliases", "irac_code", "frac_code"])
	index = ING.build_index(moa)
	by_canon = {m["ingredient"]: m for m in moa}
	ings: dict = {}
	classes: dict = {}
	for r in frappe.db.sql(
		"""SELECT parent, active_ingredient, ingredient FROM `tabActive Ingredient`
		   WHERE parenttype='Spray Product' AND parentfield='active_ingredients' AND parent IN %(c)s""",
		{"c": tuple(codes)},
		as_dict=True,
	):
		candidates = [r.active_ingredient, r.ingredient, *ING.split_ingredients(r.ingredient or "")]
		canon = next((index[k] for k in (ING.normalise(c or "") for c in candidates) if k in index), None)
		ings.setdefault(r.parent, []).append(canon or r.active_ingredient or r.ingredient or "")
		m = by_canon.get(canon)
		if m:
			c = classes.setdefault(r.parent, {"irac": False, "frac": False})
			c["irac"] = c["irac"] or bool(m.get("irac_code"))
			c["frac"] = c["frac"] or bool(m.get("frac_code"))

	out = {}
	for code in codes:
		p = sp.get(code)
		cls = classes.get(code) or {}
		out[code] = {
			"code": code,
			"name": (p.product_name if p else None) or item_names.get(code) or code,
			"item_name": item_names.get(code) or code,
			"category": p.category if p else None,
			"type": p.type if p else None,
			"cost_group": (p.get("cost_group") if p else None) or None,
			"ingredients": ings.get(code, []),
			"registered": registered.get(code, []),
			"irac": cls.get("irac", False),
			"frac": cls.get("frac", False),
			"has_spray_product": bool(p),
		}
	return out
