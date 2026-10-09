"""Pure spray-compliance rules. No site needed:

    cd apps/upande_scp && ../../env/bin/python -m pytest upande_scp/serverscripts/tests/test_spray_compliance_rules.py -q
"""

import copy

from upande_scp.serverscripts.spray_compliance import ingredients as I
from upande_scp.serverscripts.spray_compliance import rules as R

P = {
	"DEL": {"name": "Delegate", "category": "Chemical", "type": "Insecticide",
	        "targets": ["Thrips", "Caterpillars"], "irac": ["5"], "frac": [], "ingredients": ["Spinetoram"]},
	"SUC": {"name": "Success", "category": "Chemical", "type": "Insecticide",
	        "targets": ["Thrips"], "irac": ["5"], "frac": [], "ingredients": ["Spinosad"]},
	"COL": {"name": "Collis", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew"], "irac": [], "frac": ["11", "7"], "ingredients": ["Kresoxim-methyl", "Boscalid"]},
	"AMI": {"name": "Amitiv", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew", "Botrytis"], "irac": [], "frac": ["11"], "ingredients": ["Azoxystrobin"]},
	"SUL": {"name": "Sulpow", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew"], "irac": [], "frac": ["M2"], "ingredients": ["Sulphur"]},
	"THI": {"name": "Thiovit", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew"], "irac": [], "frac": ["M2"], "ingredients": ["Sulphur"]},
	"ADJ": {"name": "Amisil", "category": "Chemical", "type": "Adjuvant",
	        "targets": [], "irac": [], "frac": [], "ingredients": ["Organosilicone"]},
	"FOL": {"name": "Foliar X", "category": "Foliar", "type": "Insecticide",
	        "targets": [], "irac": [], "frac": [], "ingredients": []},
	"UNT": {"name": "Untyped", "category": "Chemical", "type": "",
	        "targets": [], "irac": [], "frac": [], "ingredients": []},
	"MEL": {"name": "Melody", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Downy Mildew"], "irac": [], "frac": ["M1", "40"], "ingredients": ["Copper", "Iprovalicarb"]},
}


def ctx(mix, targets=("Thrips", "Powdery Mildew"), **extra):
	c = {"crop": "Rose", "targets": list(targets), "mix": list(mix), "products": copy.deepcopy(P),
	     "history": [], "guidelines": {"alternate_moa": {}, "max_sprays": [], "known_resistance": []},
	     "incompatibilities": [], "now": "2026-10-08 09:00:00"}
	c.update(extra)
	return c


# --- ingredients -------------------------------------------------------------

def test_split_and_normalise_sheet_strings():
	assert I.split_ingredients("Kresoxim-Methyl [100 g/L]; Boscalid (formerly nicobifen) [200 g/L]") == [
		"Kresoxim-Methyl", "Boscalid"]
	assert I.split_ingredients("Copper 406 g/kg + Iprovalicarb 84 g/kg") == ["Copper", "Iprovalicarb"]
	assert I.split_ingredients("Daminozide 850g/L") == ["Daminozide"]
	assert I.split_ingredients("Thiosultap-monosodium|Monosultap [400 g/kg]; Buprofezin [100 g/kg]") == [
		"Thiosultap-monosodium", "Buprofezin"]
	assert I.split_ingredients("Acetamiprid [20%]") == ["Acetamiprid"]
	assert I.split_ingredients("Fluxametamide 10EC") == ["Fluxametamide"]
	assert I.split_ingredients("") == []
	assert I.normalise("Kresoxim-Methyl") == I.normalise("kresoxim methyl")


def test_parse_entries_reads_concentration_and_unit():
	e = I.parse_entries
	assert [(x["name"], x["concentration"], x["unit"]) for x in e("Kresoxim-Methyl [100 g/L]; Boscalid (formerly nicobifen) [200 g/L]")] == [
		("Kresoxim-Methyl", 100.0, "g/L"), ("Boscalid", 200.0, "g/L")]
	assert [(x["name"], x["concentration"], x["unit"]) for x in e("Copper 406 g/kg + Iprovalicarb 84 g/kg")] == [
		("Copper", 406.0, "g/kg"), ("Iprovalicarb", 84.0, "g/kg")]
	assert (e("Spinetoram (sum of spinetoram-J and spinetoram-L) [250G/KG]")[0]["concentration"],
	        e("Spinetoram (sum of spinetoram-J and spinetoram-L) [250G/KG]")[0]["unit"]) == (250.0, "g/kg")
	assert e("Acetamiprid [20%]")[0]["unit"] == "%"
	assert e("50g/l Difenoconazole")[0] == {"raw": "50g/l Difenoconazole", "name": "Difenoconazole",
	                                        "concentration": 50.0, "unit": "g/L"}
	assert e("Lecanicillium Muscarium (Verticillium-Lecanii) [1X10E10 CFU/g]")[0]["concentration"] == 1e10
	c = e("Cryptophlebia leucotreta granulovirus ( CrleGV-SA): 2 × 1013 occlusion bodies/mL")[0]
	assert (c["name"], c["concentration"], c["unit"]) == ("Cryptophlebia leucotreta granulovirus", 2e13, "OB/mL")
	assert e("Fluxametamide 10EC")[0]["concentration"] is None
	assert e("Bacillus thuringensis subspecies kurstaki strain SA-12")[0]["concentration"] is None


def test_grams_per_unit():
	assert I.grams_per_unit(250, "g/L") == 250
	assert I.grams_per_unit(406, "g/kg") == 406
	assert I.grams_per_unit(20, "%") == 200
	assert I.grams_per_unit(1e10, "CFU/g") is None
	assert I.grams_per_unit(None, "g/L") is None


def test_match_ingredient_uses_aliases():
	idx = I.build_index([{"ingredient": "Bacillus thuringiensis kurstaki",
	                      "aliases": "Bacillus thuringensis\nBt kurstaki"},
	                     {"ingredient": "Emamectin benzoate", "aliases": "Emamectin\nEmmamectin benzoate\nEmmamectin"}])
	assert I.match_ingredient("Bacillus thuringensis subspecies kurstaki strain SA-12", idx) == "Bacillus thuringiensis kurstaki"
	assert I.match_ingredient("Emamectin [19.2 g/L]", idx) == "Emamectin benzoate"
	assert I.match_ingredient("Unobtainium", idx) is None


# --- classification ----------------------------------------------------------

def test_non_target_classification():
	assert R.is_non_target(P["ADJ"]) and R.is_non_target(P["FOL"])
	assert not R.is_non_target(P["UNT"])          # blank type = pest-control
	assert not R.is_non_target(None)              # unknown product = pest-control


def test_untargeted_is_pest_control_without_targets():
	assert R.is_untargeted(P["UNT"])
	assert not R.is_untargeted(None)              # not a Spray Product: nothing to hide
	assert not R.is_untargeted(P["DEL"])          # has targets
	assert not R.is_untargeted(P["ADJ"]) and not R.is_untargeted(P["FOL"])  # never need one


# --- target_match / coverage -------------------------------------------------

def test_target_match_flags_only_off_target_pest_control():
	v = R.target_match(ctx(["DEL", "COL", "ADJ", "FOL", "MEL"]))
	assert [x["products"] for x in v] == [["MEL"]]
	assert "Downy Mildew" in v[0]["message"]


def test_unknown_product_is_untargeted():
	v = R.target_match(ctx(["GHOST"]))
	assert v and v[0]["products"] == ["GHOST"]


def test_untyped_product_without_targets_is_flagged():
	assert R.target_match(ctx(["UNT"]))[0]["products"] == ["UNT"]


def test_target_coverage():
	assert R.target_coverage(ctx(["DEL", "COL"])) == []
	v = R.target_coverage(ctx(["COL"]))
	assert [x["targets"] for x in v] == [["Thrips"]]
	assert R.coverage(ctx(["DEL", "COL", "AMI"])) == [
		{"target": "Thrips", "products": ["DEL"]},
		{"target": "Powdery Mildew", "products": ["COL", "AMI"]}]


def test_no_targets():
	c = ctx(["DEL", "ADJ"], targets=())
	assert R.target_coverage(c) == []
	assert [x["products"] for x in R.target_match(c)] == [["DEL"]]


# --- same_moa_in_mix ---------------------------------------------------------

def test_same_group_in_mix():
	v = R.same_moa_in_mix(ctx(["DEL", "SUC"]))
	assert len(v) == 1 and v[0]["codes"] == ["IRAC 5"] and v[0]["products"] == ["DEL", "SUC"]
	v = R.same_moa_in_mix(ctx(["COL", "AMI"]))
	assert v[0]["codes"] == ["FRAC 11"]


def test_multisite_groups_may_share():
	assert R.same_moa_in_mix(ctx(["SUL", "THI"])) == []


def test_same_product_twice_is_not_a_moa_clash():
	assert R.same_moa_in_mix(ctx(["DEL", "DEL"])) == []


# --- tank_mix_incompatible ---------------------------------------------------

def test_incompatible_by_product_and_by_ingredient():
	inc = [{"product_a": "DEL", "product_b": None, "ingredient_a": None, "ingredient_b": "Copper",
	        "reason": "Copper degrades spinetoram"}]
	v = R.tank_mix_incompatible(ctx(["DEL", "MEL"], incompatibilities=inc))
	assert v and v[0]["products"] == ["DEL", "MEL"] and "Copper degrades" in v[0]["message"]
	assert R.tank_mix_incompatible(ctx(["DEL", "COL"], incompatibilities=inc)) == []


def test_incompatible_ignores_half_empty_rows_and_self_pairs():
	inc = [{"product_a": "DEL", "product_b": None, "ingredient_a": None, "ingredient_b": None, "reason": "x"},
	       {"product_a": "DEL", "product_b": "DEL", "ingredient_a": None, "ingredient_b": None, "reason": "x"}]
	assert R.tank_mix_incompatible(ctx(["DEL", "DEL"], incompatibilities=inc)) == []


def test_violation_key_is_stable():
	a = R.violation("same_moa_in_mix", "m", products=["SUC", "DEL"], codes=["IRAC 5"])
	b = R.violation("same_moa_in_mix", "other words", products=["DEL", "SUC"], codes=["IRAC 5"])
	assert a["key"] == b["key"] == "same_moa_in_mix:DEL|SUC||IRAC 5"


def test_repeated_code_on_one_product_is_not_a_clash():
	c = ctx(["DEL"])
	c["products"]["DEL"]["irac"] = ["5", "5"]
	assert R.same_moa_in_mix(c) == []


def test_incompatible_matches_in_reversed_orientation():
	inc = [{"product_a": None, "product_b": "DEL", "ingredient_a": "Copper", "ingredient_b": None,
	        "reason": "Copper degrades spinetoram"}]
	v = R.tank_mix_incompatible(ctx(["DEL", "MEL"], incompatibilities=inc))
	assert v and v[0]["products"] == ["DEL", "MEL"]
	v = R.tank_mix_incompatible(ctx(["MEL", "DEL"], incompatibilities=inc))
	assert v and v[0]["products"] == ["DEL", "MEL"]
