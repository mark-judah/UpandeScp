"""History/guideline rules. Pure: ../../env/bin/python -m pytest <this file> -q"""

from upande_scp.serverscripts.spray_compliance import rules as R
from upande_scp.serverscripts.tests.test_spray_compliance_rules import ctx


def hist(*sprays):
	"""sprays: (when, [items]) oldest first"""
	return [{"wo": f"WO-{n}", "when": when, "items": items} for n, (when, items) in enumerate(sprays)]


def g(alt=None, max_sprays=(), known=()):
	return {"alternate_moa": alt or {}, "max_sprays": list(max_sprays), "known_resistance": list(known)}


# --- parsers -----------------------------------------------------------------

def test_parse_alternate_moa():
	assert R.parse_alternate_moa("2") == 2
	assert R.parse_alternate_moa(" 3\n") == 3


def test_parse_alternate_moa_tolerates_garbage():
	assert R.parse_alternate_moa("") is None
	assert R.parse_alternate_moa("two") is None
	assert R.parse_alternate_moa(None) is None


def test_parse_max_sprays():
	assert R.parse_max_sprays("Tebuconazole:2:14\r\nLevo 2.4SL:1:20") == [
		{"subject": "Tebuconazole", "sprays": 2, "break_days": 14},
		{"subject": "Levo 2.4SL", "sprays": 1, "break_days": 20}]


def test_parse_max_sprays_tolerates_garbage():
	assert R.parse_max_sprays("Tebuconazole:2\n:1:2\nX:a:3\n\n") == []
	assert R.parse_max_sprays(None) == []


def test_parse_known_resistance():
	assert R.parse_known_resistance("Thrips:UN\nMealybugs : 4A", "irac") == [
		{"kind": "irac", "target": "Thrips", "code": "UN"},
		{"kind": "irac", "target": "Mealybugs", "code": "4A"}]


def test_parse_known_resistance_tolerates_garbage():
	assert R.parse_known_resistance("Powdery Mildew:\n:11\nnonsense", "frac") == []


# --- moa_rotation ------------------------------------------------------------

def test_rotation_allows_up_to_n_in_a_row():
	c = ctx(["DEL"], history=hist(("2026-10-01 07:00:00", ["SUC"])), guidelines=g(alt={"irac": 2}))
	assert R.moa_rotation(c) == []


def test_rotation_blocks_the_n_plus_first():
	c = ctx(["DEL"], history=hist(("2026-09-24 07:00:00", ["DEL"]), ("2026-10-01 07:00:00", ["SUC"])),
	        guidelines=g(alt={"irac": 2}))
	v = R.moa_rotation(c)
	assert len(v) == 1 and v[0]["codes"] == ["IRAC 5"] and "3" in v[0]["message"]


def test_rotation_resets_after_a_different_group():
	c = ctx(["DEL"], history=hist(("2026-09-17 07:00:00", ["DEL"]), ("2026-09-24 07:00:00", ["COL"]),
	                              ("2026-10-01 07:00:00", ["SUC"])), guidelines=g(alt={"irac": 2}))
	assert R.moa_rotation(c) == []


def test_rotation_ignores_multisite_and_unset_limits():
	c = ctx(["SUL"], history=hist(("2026-09-24 07:00:00", ["THI"]), ("2026-10-01 07:00:00", ["SUL"])),
	        guidelines=g(alt={"frac": 1}))
	assert R.moa_rotation(c) == []
	c = ctx(["DEL"], history=hist(("2026-10-01 07:00:00", ["DEL"])), guidelines=g(alt={}))
	assert R.moa_rotation(c) == []


def test_rotation_one_product_repeating_a_code_counts_once():
	c = ctx(["DEL"], guidelines=g(alt={"irac": 1}))
	c["products"]["DEL"]["irac"] = ["5", "5"]
	c["history"] = hist(("2026-10-01 07:00:00", ["SUC"]))
	assert len(R.moa_rotation(c)) == 1


# --- max_sprays --------------------------------------------------------------

def test_max_sprays_by_product_name_within_window():
	rule = {"subject": "Delegate", "sprays": 1, "break_days": 14}
	c = ctx(["DEL"], history=hist(("2026-10-01 07:00:00", ["DEL"])), guidelines=g(max_sprays=[rule]))
	assert R.max_sprays(c)[0]["products"] == ["DEL"]
	c = ctx(["DEL"], history=hist(("2026-09-01 07:00:00", ["DEL"])), guidelines=g(max_sprays=[rule]))
	assert R.max_sprays(c) == []


def test_max_sprays_by_ingredient():
	rule = {"subject": "Azoxystrobin", "sprays": 1, "break_days": 30}
	c = ctx(["AMI"], history=hist(("2026-10-01 07:00:00", ["AMI"])), guidelines=g(max_sprays=[rule]))
	assert R.max_sprays(c)


def test_max_sprays_counts_a_spray_once_even_with_two_matching_products():
	rule = {"subject": "Sulphur", "sprays": 2, "break_days": 30}
	c = ctx(["SUL"], history=hist(("2026-10-01 07:00:00", ["SUL", "THI"])), guidelines=g(max_sprays=[rule]))
	assert R.max_sprays(c) == []


# --- known_resistance --------------------------------------------------------

def test_known_resistance_only_for_selected_targets():
	known = [{"kind": "frac", "target": "Powdery Mildew", "code": "11"}]
	v = R.known_resistance(ctx(["AMI", "COL", "SUL"], guidelines=g(known=known)))
	assert sorted(x["products"][0] for x in v) == ["AMI", "COL"]
	assert R.known_resistance(ctx(["AMI"], targets=["Botrytis"], guidelines=g(known=known))) == []
