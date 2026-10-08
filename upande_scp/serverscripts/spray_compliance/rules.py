"""Spray-plan compliance rules. Pure: every function takes the context dict built
by `context.py` and returns a list of violations. No frappe import — the rules
are tested without a site.

A violation does not know its mode; `engine.py` attaches that.
"""

from itertools import combinations

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
		for code in _codes(ctx["products"].get(item)):
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
