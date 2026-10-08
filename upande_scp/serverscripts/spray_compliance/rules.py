"""Spray-plan compliance rules. Pure: every function takes the context dict built
by `context.py` and returns a list of violations. No frappe import — the rules
are tested without a site.

A violation does not know its mode; `engine.py` attaches that.
"""

from datetime import datetime, timedelta
from itertools import combinations

from .ingredients import normalise

NON_TARGET_TYPES = {"Adjuvant", "pH Buffer", "Plant Growth Regulator"}

# Groups that carry no cross-resistance meaning: FRAC multi-site (M*), biologicals
# (BM*), host-defence inducers (P*), unknown (U*/UN*), not classified (NC).
EXCLUDED_CODE_PREFIXES = ("M", "BM", "P", "U", "NC")


def is_non_target(product: dict | None) -> bool:
	if not product:
		return False
	return product.get("category") == "Foliar" or (product.get("type") or "") in NON_TARGET_TYPES


def _name(ctx, code):
	return (ctx["products"].get(code) or {}).get("name") or code


def _counts(code: str) -> bool:
	return bool(code) and not code.upper().startswith(EXCLUDED_CODE_PREFIXES)


def violation(rule, message, products=(), targets=(), codes=()) -> dict:
	products, targets, codes = sorted(set(products)), sorted(set(targets)), sorted(set(codes))
	return {
		"rule": rule, "message": message,
		"products": products, "targets": targets, "codes": codes,
		"key": f"{rule}:{'|'.join(products)}|{'|'.join(targets)}|{'|'.join(codes)}",
	}


def _unique_mix(ctx):
	seen, out = set(), []
	for item in ctx["mix"]:
		if item not in seen:
			seen.add(item)
			out.append(item)
	return out


def _pest_control(ctx):
	return [i for i in _unique_mix(ctx) if not is_non_target(ctx["products"].get(i))]


def target_match(ctx) -> list[dict]:
	wanted = set(ctx["targets"])
	out = []
	for item in _pest_control(ctx):
		registered = (ctx["products"].get(item) or {}).get("targets") or []
		if not wanted.intersection(registered):
			reg = ", ".join(registered) if registered else "no registered target"
			out.append(violation(
				"target_match",
				f"{_name(ctx, item)} is registered for {reg}, not for {', '.join(ctx['targets']) or 'any selected target'}.",
				products=[item]))
	return out


def coverage(ctx) -> list[dict]:
	mix = _pest_control(ctx)
	return [
		{"target": t, "products": [i for i in mix if t in ((ctx["products"].get(i) or {}).get("targets") or [])]}
		for t in ctx["targets"]
	]


def target_coverage(ctx) -> list[dict]:
	return [
		violation("target_coverage", f"Nothing in this mix is registered for {row['target']}.",
		          targets=[row["target"]])
		for row in coverage(ctx) if not row["products"]
	]


def _codes(product: dict | None) -> list[str]:
	p = product or {}
	return [f"IRAC {c}" for c in p.get("irac") or [] if _counts(c)] + \
	       [f"FRAC {c}" for c in p.get("frac") or [] if _counts(c)]


def same_moa_in_mix(ctx) -> list[dict]:
	by_code: dict[str, list[str]] = {}
	for item in _unique_mix(ctx):
		for code in dict.fromkeys(_codes(ctx["products"].get(item))):
			by_code.setdefault(code, []).append(item)
	return [
		violation("same_moa_in_mix",
		          f"{' and '.join(_name(ctx, i) for i in items)} are both {code} — one tank, one mode of action, no added protection and faster resistance.",
		          products=items, codes=[code])
		for code, items in sorted(by_code.items()) if len(items) > 1
	]


def _side_matches(ctx, item, product, ingredient) -> bool:
	if product:
		return item == product
	if ingredient:
		return ingredient in ((ctx["products"].get(item) or {}).get("ingredients") or [])
	return False


def tank_mix_incompatible(ctx) -> list[dict]:
	out, seen = [], set()
	mix = _unique_mix(ctx)
	for row in ctx["incompatibilities"]:
		a = (row.get("product_a"), row.get("ingredient_a"))
		b = (row.get("product_b"), row.get("ingredient_b"))
		if not any(a) or not any(b):
			continue
		for x, y in combinations(mix, 2):
			hit = (_side_matches(ctx, x, *a) and _side_matches(ctx, y, *b)) or \
			      (_side_matches(ctx, y, *a) and _side_matches(ctx, x, *b))
			if hit and (x, y) not in seen:
				seen.add((x, y))
				out.append(violation("tank_mix_incompatible",
				                     f"{_name(ctx, x)} and {_name(ctx, y)} must not be mixed: {row.get('reason') or 'listed as incompatible'}.",
				                     products=[x, y]))
	return out


# --- guideline parsing -------------------------------------------------------
# The FRAC/IRAC Guideline parameters are free strings today (spec D7). Every
# parser skips a line it cannot read instead of raising: a typo in a settings
# record must not stop spray plans being saved.

def _lines(text):
	return [ln.strip() for ln in (text or "").replace("\r", "\n").split("\n") if ln.strip()]


def parse_alternate_moa(text) -> int | None:
	try:
		n = int(str(text).strip())
	except (TypeError, ValueError):
		return None
	return n if n > 0 else None


def parse_max_sprays(text) -> list[dict]:
	out = []
	for ln in _lines(text):
		parts = [p.strip() for p in ln.split(":")]
		if len(parts) != 3 or not parts[0]:
			continue
		try:
			out.append({"subject": parts[0], "sprays": int(parts[1]), "break_days": int(parts[2])})
		except ValueError:
			continue
	return out


def parse_known_resistance(text, kind) -> list[dict]:
	out = []
	for ln in _lines(text):
		target, _, code = ln.partition(":")
		target, code = target.strip(), code.strip()
		if target and code:
			out.append({"kind": kind, "target": target, "code": code})
	return out


def _dt(s):
	return datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")


# --- history rules -----------------------------------------------------------

def moa_rotation(ctx) -> list[dict]:
	out = []
	limits = ctx["guidelines"].get("alternate_moa") or {}
	sprays = [h["items"] for h in ctx["history"]] + [_unique_mix(ctx)]
	for kind in ("irac", "frac"):
		n = limits.get(kind)
		if not n:
			continue
		label = kind.upper()
		current = {}
		for item in sprays[-1]:
			for c in dict.fromkeys((ctx["products"].get(item) or {}).get(kind) or []):
				if _counts(c):
					current.setdefault(c, item)
		for code, item in sorted(current.items()):
			run = 0
			for items in reversed(sprays):
				if any(code in ((ctx["products"].get(i) or {}).get(kind) or []) for i in items):
					run += 1
				else:
					break
			if run > n:
				out.append(violation("moa_rotation",
				                     f"{label} {code} ({_name(ctx, item)}) would be the {run} spray in a row on this greenhouse; the limit is {n}. Rotate to another group.",
				                     products=[item], codes=[f"{label} {code}"]))
	return out


def _carries(ctx, item, subject) -> bool:
	p = ctx["products"].get(item) or {}
	s = normalise(subject)
	return s in (normalise(p.get("name")), normalise(item)) or s in {normalise(i) for i in p.get("ingredients") or []}


def max_sprays(ctx) -> list[dict]:
	out = []
	now = _dt(ctx["now"])
	for rule in ctx["guidelines"].get("max_sprays") or []:
		cutoff = now - timedelta(days=rule["break_days"])
		for item in _unique_mix(ctx):
			if not _carries(ctx, item, rule["subject"]):
				continue
			used = sum(1 for h in ctx["history"]
			           if _dt(h["when"]) >= cutoff and any(_carries(ctx, i, rule["subject"]) for i in h["items"]))
			if used >= rule["sprays"]:
				out.append(violation("max_sprays",
				                     f"{rule['subject']} ({_name(ctx, item)}) was already sprayed {used} time(s) in the last {rule['break_days']} days; the limit is {rule['sprays']}.",
				                     products=[item]))
	return out


def known_resistance(ctx) -> list[dict]:
	out = []
	wanted = set(ctx["targets"])
	for row in ctx["guidelines"].get("known_resistance") or []:
		if row["target"] not in wanted:
			continue
		for item in _unique_mix(ctx):
			if row["code"] in ((ctx["products"].get(item) or {}).get(row["kind"]) or []):
				out.append(violation("known_resistance",
				                     f"{row['target']} is known to resist {row['kind'].upper()} {row['code']}, which {_name(ctx, item)} is.",
				                     products=[item], targets=[row["target"]], codes=[f"{row['kind'].upper()} {row['code']}"]))
	return out
