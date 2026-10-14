"""Turns rule violations into a decision. Pure, no frappe.

Each rule has a mode (spec D5). `Off` rules are not run. A `Block (GM override)`
violation is cleared only by an override carrying the violation's `key` and a
non-blank reason; whether the caller may override at all is `api.py`'s concern.
"""

from . import rules as R

RULES = ("target_match", "target_coverage", "same_moa_in_mix", "moa_rotation",
	"max_sprays", "known_resistance", "tank_mix_incompatible")
OFF, WARN, GM, BLOCK = "Off", "Warn", "Block (GM override)", "Block"
#: rules whose mode is decided by the targeting mode alone (Strict blocks, Warn warns)
TARGETING_ONLY = ("untargeted", "row_target")
MODES = (OFF, WARN, GM, BLOCK)
_SEVERITY = {OFF: 0, WARN: 1, GM: 2, BLOCK: 3}


def mode_of(ctx, rule) -> str:
	m = (ctx.get("modes") or {}).get(rule) or WARN
	return m if m in _SEVERITY else WARN


def _raw(ctx, skip=()):
	out = []
	for rule in RULES:
		if rule in skip:
			continue
		mode = mode_of(ctx, rule)
		if mode == OFF:
			continue
		for v in getattr(R, rule)(ctx):
			out.append({**v, "mode": mode})
	# Chemical targeting enforcement (Strict / Warn): not per-rule configurable, set by the mode.
	targeting = ctx.get("targeting")
	if targeting:
		m = BLOCK if targeting == "Strict" else WARN
		for rule in TARGETING_ONLY:
			if rule in skip:
				continue
			for v in getattr(R, rule)(ctx):
				out.append({**v, "mode": m})
	return out


def check_mix(ctx, overrides=()) -> dict:
	given = {o["key"] for o in overrides or () if (o.get("reason") or "").strip() and o.get("key")}
	violations = []
	for v in _raw(ctx):
		violations.append({**v, "overridden": v["mode"] == GM and v["key"] in given})
	hard = any(v["mode"] == BLOCK for v in violations)
	pending = any(v["mode"] == GM and not v["overridden"] for v in violations)
	if hard:
		status = "Blocked"
	elif pending:
		status = "Awaiting Override"
	elif any(v["overridden"] for v in violations):
		status = "Overridden"
	elif violations:
		status = "Warnings"
	else:
		status = "Clean"
	return {"violations": violations, "blocking": hard or pending, "needs_override": pending and not hard,
		"status": status, "coverage": R.coverage(ctx)}


def evaluate_candidates(ctx, candidates) -> list[dict]:
	base = list(ctx["mix"])
	out = []
	for item in candidates:
		trial = {**ctx, "mix": base + [item]}
		mine = [v for v in _raw(trial, skip=("target_coverage",)) if item in v["products"]]
		worst = max((v["mode"] for v in mine), key=_SEVERITY.get, default=OFF)
		product = ctx["products"].get(item) or {}
		out.append({
			"item": item,
			"eligible": not mine,
			"worst_mode": worst,
			"reasons": [v["message"] for v in mine],
			# Which rules it breaks: the picker hides only off-target products
			# ("target_match") and greys the rest.
			"rules": list(dict.fromkeys(v["rule"] for v in mine)),
			"codes": R.display_codes(product),
			"targets": list(product.get("targets") or []),
			"non_target": R.is_non_target(product),
			"untargeted": R.is_untargeted(product),
			"valid_targets": R.valid_targets(product),
		})
	return out
