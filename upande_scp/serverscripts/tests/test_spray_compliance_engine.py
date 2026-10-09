"""Engine: modes and overrides. Pure: ../../env/bin/python -m pytest <this file> -q"""

from upande_scp.serverscripts.spray_compliance import engine as E
from upande_scp.serverscripts.tests.test_spray_compliance_rules import ctx


def modes(**m):
	base = {r: "Warn" for r in E.RULES}
	base.update(m)
	return base


def test_clean_mix():
	r = E.check_mix(ctx(["DEL", "COL"], modes=modes()))
	assert r["violations"] == [] and r["status"] == "Clean" and not r["blocking"]


def test_warn_never_blocks():
	r = E.check_mix(ctx(["COL"], modes=modes()))
	assert r["status"] == "Warnings" and not r["blocking"] and r["violations"][0]["mode"] == "Warn"


def test_off_rules_are_not_evaluated():
	r = E.check_mix(ctx(["COL"], modes=modes(target_coverage="Off")))
	assert r["violations"] == []


def test_hard_block():
	r = E.check_mix(ctx(["COL"], modes=modes(target_coverage="Block")))
	assert r["blocking"] and not r["needs_override"] and r["status"] == "Blocked"


def test_gm_override_needed_then_given():
	c = ctx(["COL"], modes=modes(target_coverage="Block (GM override)"))
	r = E.check_mix(c)
	assert r["blocking"] and r["needs_override"] and r["status"] == "Awaiting Override"
	key = r["violations"][0]["key"]
	r = E.check_mix(c, overrides=[{"key": key, "reason": "Thrips spray tomorrow"}])
	assert not r["blocking"] and r["status"] == "Overridden" and r["violations"][0]["overridden"]


def test_blank_reason_is_not_an_override():
	c = ctx(["COL"], modes=modes(target_coverage="Block (GM override)"))
	key = E.check_mix(c)["violations"][0]["key"]
	assert E.check_mix(c, overrides=[{"key": key, "reason": "  "}])["blocking"]


def test_override_cannot_clear_a_hard_block():
	c = ctx(["COL"], modes=modes(target_coverage="Block"))
	key = E.check_mix(c)["violations"][0]["key"]
	assert E.check_mix(c, overrides=[{"key": key, "reason": "please"}])["blocking"]


def test_unknown_mode_is_treated_as_warn():
	r = E.check_mix(ctx(["COL"], modes=modes(target_coverage="Strict")))
	assert r["violations"][0]["mode"] == "Warn"


def test_evaluate_candidates():
	c = ctx(["DEL"], modes=modes(same_moa_in_mix="Block"))
	rows = {r["item"]: r for r in E.evaluate_candidates(c, ["COL", "SUC", "MEL", "ADJ", "UNT"])}
	assert rows["COL"]["eligible"] and rows["COL"]["codes"] == ["FRAC 11", "FRAC 7"]
	assert not rows["SUC"]["eligible"] and rows["SUC"]["worst_mode"] == "Block"
	assert not rows["MEL"]["eligible"] and "Downy Mildew" in rows["MEL"]["reasons"][0]
	assert rows["ADJ"]["eligible"] and rows["ADJ"]["non_target"]
	assert rows["COL"]["rules"] == [] and rows["ADJ"]["rules"] == []
	assert rows["SUC"]["rules"] == ["same_moa_in_mix"]
	assert "target_match" in rows["MEL"]["rules"]
	assert rows["UNT"]["untargeted"] and not rows["MEL"]["untargeted"] and not rows["ADJ"]["untargeted"]
