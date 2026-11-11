"""Predator-harm rule, its modes and override, and the expected-mortality maths. Pure, no site:

    cd apps/upande_scp && ../../env/bin/python -m pytest upande_scp/serverscripts/tests/test_predator_harm_rules.py -q
"""

import copy

from upande_scp.serverscripts.biologicals import mortality as M
from upande_scp.serverscripts.spray_compliance import engine as E
from upande_scp.serverscripts.spray_compliance import rules as R

PP = "Phytoseiulus"


def imp(cls, predator=PP, stage="", ingredient="Abamectin", mortality=100.0, persistence=21):
	return {"ingredient": ingredient, "predator": predator, "stage": stage, "cls": cls,
	        "mortality": mortality, "persistence": persistence, "verified": False}


PRODUCTS = {
	"ABA": {"name": "Vertimec", "category": "Chemical", "type": "Insecticide", "targets": ["Spidermites"],
	        "irac": ["6"], "frac": [], "ingredients": ["Abamectin"], "impacts": [imp(4)]},
	"MOD": {"name": "Moderate", "category": "Chemical", "type": "Insecticide", "targets": ["Thrips"],
	        "irac": ["5"], "frac": [], "ingredients": ["X"], "impacts": [imp(3, ingredient="X", mortality=90)]},
	"SAFE": {"name": "Safe", "category": "Chemical", "type": "Insecticide", "targets": ["Thrips"],
	         "irac": ["28"], "frac": [], "ingredients": ["Y"], "impacts": [imp(2, ingredient="Y", mortality=55)]},
	"NONE": {"name": "NoData", "category": "Chemical", "type": "Insecticide", "targets": ["Thrips"],
	         "irac": ["1"], "frac": [], "ingredients": ["Z"], "impacts": []},
}


def ctx(mix, present=None, mode=None, **extra):
	c = {"crop": "Rose", "targets": ["Spidermites"], "mix": list(mix), "products": copy.deepcopy(PRODUCTS),
	     "history": [], "guidelines": {"alternate_moa": {}, "max_sprays": [], "known_resistance": []},
	     "incompatibilities": [], "now": "2026-11-11 09:00:00", "modes": {r: "Off" for r in E.RULES},
	     "predators": present if present is not None else
	     [{"predator": PP, "stage": "Adult", "qty": 2, "when": "2026-11-05 08:00:00", "source": "released"}]}
	if mode:
		c["modes"]["predator_harm"] = mode
	c.update(extra)
	return c


def test_rule_is_registered_and_defaults_to_warn():
	assert "predator_harm" in E.RULES
	assert E.mode_of({"modes": {}}, "predator_harm") == E.WARN


def test_harmful_ingredient_with_predator_present_is_a_violation():
	v = R.predator_harm(ctx(["ABA"]))
	assert len(v) == 1
	assert v[0]["rule"] == "predator_harm" and v[0]["products"] == ["ABA"] and v[0]["targets"] == [PP]
	assert "Vertimec" in v[0]["message"] and "harmful to Phytoseiulus" in v[0]["message"]
	assert "released 2026-11-05" in v[0]["message"] and "21 days" in v[0]["message"]


def test_moderately_harmful_counts_slightly_does_not():
	assert len(R.predator_harm(ctx(["MOD"]))) == 1
	assert R.predator_harm(ctx(["SAFE"])) == []
	assert R.predator_harm(ctx(["NONE"])) == []


def test_no_predator_present_no_violation():
	assert R.predator_harm(ctx(["ABA"], present=[])) == []


def test_other_predator_present_is_not_affected():
	other = [{"predator": "Neoseiulus californicus", "stage": "", "qty": 1, "when": "2026-11-09 08:00:00", "source": "seen in scouting"}]
	assert R.predator_harm(ctx(["ABA"], present=other)) == []


def test_stage_specific_impact_matches_only_that_stage():
	c = ctx(["ABA"])
	c["products"]["ABA"]["impacts"] = [imp(4, stage="Eggs")]
	assert R.predator_harm(c) == []  # adults present, impact is on eggs
	c["predators"][0]["stage"] = "Eggs"
	assert len(R.predator_harm(c)) == 1
	c["predators"][0]["stage"] = ""  # unknown stage: assume exposed
	assert len(R.predator_harm(c)) == 1


def test_worst_class_wins_per_predator():
	c = ctx(["ABA"])
	c["products"]["ABA"]["impacts"] = [imp(3, mortality=90), imp(4, stage="", mortality=100)]
	v = R.predator_harm(c)
	assert len(v) == 1 and "about 100% mortality" in v[0]["message"]


def test_modes_warn_block_gm_and_off():
	assert E.check_mix(ctx(["ABA"], mode="Warn"))["status"] == "Warnings"
	assert E.check_mix(ctx(["ABA"], mode="Block"))["status"] == "Blocked"
	r = E.check_mix(ctx(["ABA"], mode="Block (GM override)"))
	assert r["status"] == "Awaiting Override" and r["blocking"]
	off = E.check_mix(ctx(["ABA"], mode="Off"))
	assert off["violations"] == [] and off["status"] == "Clean"


def test_gm_override_with_reason_clears_it():
	c = ctx(["ABA"], mode="Block (GM override)")
	key = E.check_mix(c)["violations"][0]["key"]
	assert not E.check_mix(c, [{"key": key, "reason": ""}])["status"] == "Overridden"
	r = E.check_mix(c, [{"key": key, "reason": "Predators re-released after the spray"}])
	assert r["status"] == "Overridden" and not r["blocking"]


def test_candidate_with_harmful_ingredient_is_not_eligible():
	rows = E.evaluate_candidates(ctx([], mode="Warn"), ["ABA", "SAFE"])
	by = {r["item"]: r for r in rows}
	assert not by["ABA"]["eligible"] and by["ABA"]["rules"] == ["predator_harm"]
	assert by["SAFE"]["eligible"]


def test_impact_class_parsing():
	from upande_scp.serverscripts.spray_compliance.context import impact_class
	assert impact_class("4 - Harmful") == 4 and impact_class("") == 0 and impact_class(None) == 0


# --- expected mortality -------------------------------------------------------

def rel(i, when, qty, gh="GH1", predator=PP):
	return {"id": i, "greenhouse": gh, "predator": predator, "stage": "Adult", "qty": qty, "uom": "Bottle", "when": when}


def spray(wo, when, pcts, gh="GH1", predator=PP):
	return {"wo": wo, "greenhouse": gh, "when": when, "products": ["P"], "mortality": {predator: pcts}}


def test_combined_mortality_compounds():
	assert M.combined_mortality([100]) == 100
	assert M.combined_mortality([50, 50]) == 75
	assert M.combined_mortality([]) == 0


def test_expected_kill_is_release_times_mortality():
	rows = M.expected_kills([rel("R1", "2026-11-01 08:00:00", 10)], [spray("W1", "2026-11-03 09:00:00", [90])], 14)
	assert len(rows) == 1 and rows[0]["present"] == 10 and rows[0]["expected_kill"] == 9 and rows[0]["mortality_pct"] == 90


def test_two_sprays_draw_the_same_pool_down():
	rows = M.expected_kills([rel("R1", "2026-11-01 08:00:00", 100)],
	                        [spray("W1", "2026-11-02 09:00:00", [50]), spray("W2", "2026-11-03 09:00:00", [50])], 14)
	assert [r["expected_kill"] for r in rows] == [50, 25]


def test_release_after_spray_or_outside_window_or_other_greenhouse_is_ignored():
	s = spray("W1", "2026-11-10 09:00:00", [100])
	assert M.expected_kills([rel("R1", "2026-11-11 08:00:00", 5)], [s], 14) == []
	assert M.expected_kills([rel("R1", "2026-10-01 08:00:00", 5)], [s], 14) == []
	assert M.expected_kills([rel("R1", "2026-11-09 08:00:00", 5, gh="GH2")], [s], 14) == []


def test_summary_totals():
	rows = M.expected_kills([rel("R1", "2026-11-01 08:00:00", 10), rel("R2", "2026-11-01 08:00:00", 10, gh="GH2")],
	                        [spray("W1", "2026-11-02 09:00:00", [50]), spray("W2", "2026-11-02 09:00:00", [100], gh="GH2")], 14)
	s = M.summarise(rows)
	assert s["total"] == 15 and s["by_greenhouse"] == {"GH1": 5, "GH2": 10} and s["by_predator"] == {PP: 15}
