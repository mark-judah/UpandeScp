"""Active-ingredient strings → canonical ingredient names. Pure, no frappe.

Registration labels write the same ingredient many ways — "Kresoxim-Methyl
[100 g/L]", "Copper 406 g/kg", "Thiosultap-monosodium|Monosultap" — so matching
is on a normalised form: lower case, letters and digits only, concentrations and
bracketed asides removed.
"""

import re

_BRACKETS = re.compile(r"\[[^\]]*\]|\([^)]*\)")
_SPLIT = re.compile(r";|\s\+\s|\+")
_UNIT = r"(g/l|g/kg|%|cfu/g|cfu/ml|ob/ml|occlusion bodies/ml)"
# "50g/l Difenoconazole" — concentration written first (existing kaitet rows).
_LEAD = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(g/l|g/kg|%)\s+(.+)$", re.I)
# "1X10E10 CFU/g", "2 × 1013 occlusion bodies/mL" (the sheet lost the superscript).
_SCI = re.compile(r"(\d+(?:[.,]\d+)?)\s*[x×]\s*10\s*(?:e|\^)?\s*(\d+)\s*" + _UNIT, re.I)
_TRAIL = re.compile(r"(\d+(?:[.,]\d+)?)\s*" + _UNIT, re.I)
UNITS = {"g/l": "g/L", "g/kg": "g/kg", "%": "%", "cfu/g": "CFU/g", "cfu/ml": "CFU/mL",
         "ob/ml": "OB/mL", "occlusion bodies/ml": "OB/mL"}


def normalise(s: str) -> str:
	return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _num(s):
	return float(s.replace(",", "."))


def parse_entries(s: str) -> list[dict]:
	"""One entry per ingredient: its name, and its concentration and unit when the
	label gives one. Verified against all 60 ingredients on the roses sheet."""
	out = []
	for part in _SPLIT.split(s or ""):
		raw = part.strip()
		if not raw:
			continue
		conc = unit = None
		body = raw
		if m := _LEAD.match(raw):
			conc, unit, body = _num(m.group(1)), m.group(2), m.group(3)
		elif m := _SCI.search(raw):
			conc, unit = _num(m.group(1)) * 10 ** int(m.group(2)), m.group(3)
		elif m := _TRAIL.search(raw):
			conc, unit = _num(m.group(1)), m.group(2)
		name = _BRACKETS.sub(" ", body).split("|")[0]
		name = re.split(r":|\s\d", name)[0]
		name = re.sub(r"\s+", " ", name).strip(" :-,")
		if name:
			out.append({"raw": raw, "name": name, "concentration": conc,
			            "unit": UNITS[unit.lower()] if unit else None})
	return out


def split_ingredients(s: str) -> list[str]:
	return [e["name"] for e in parse_entries(s)]


def grams_per_unit(concentration, unit) -> float | None:
	"""Grams of active ingredient per L or kg of product; None for counts (CFU, OB)."""
	if concentration is None:
		return None
	if unit in ("g/L", "g/kg"):
		return float(concentration)
	if unit == "%":
		return float(concentration) * 10
	return None


def build_index(rows: list[dict]) -> dict[str, str]:
	"""normalised name/alias → canonical ingredient."""
	idx = {}
	for r in rows:
		canon = r["ingredient"]
		for name in [canon, *((r.get("aliases") or "").splitlines())]:
			key = normalise(name)
			if key:
				idx[key] = canon
	return idx


def match_ingredient(raw: str, index: dict[str, str]) -> str | None:
	parts = split_ingredients(raw) or [raw]
	key = normalise(parts[0])
	if key in index:
		return index[key]
	# Longest known name that the raw string starts with ("Bacillus thuringensis
	# subspecies kurstaki strain SA-12" → "bacillus thuringensis").
	best = None
	for k, canon in index.items():
		if key.startswith(k + " ") or key == k:
			if best is None or len(k) > len(best[0]):
				best = (k, canon)
	return best[1] if best else None
