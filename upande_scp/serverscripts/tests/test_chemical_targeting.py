"""Chemical targeting enforcement: Strict blocks an unregistered product for a target at drafts,
approval and submit; Warn allows it with warnings, still requires row targets."""

import unittest
from unittest import mock

import frappe

from upande_scp.patches.v1_0 import set_chemical_targeting_warn as PATCH
from upande_scp.serverscripts.spray_compliance import api as A
from upande_scp.serverscripts.spray_compliance import engine as E
from upande_scp.serverscripts.spray_compliance import targeting as T
from upande_scp.serverscripts.spray_plan_creator import validation as V

PRODUCTS = {
	"REG": {"name": "Registered", "category": "Chemical", "type": "Fungicide", "targets": ["Mildew"], "ai_targets": [],
	        "irac": [], "frac": [], "ingredients": []},
	"AI": {"name": "By ingredient", "category": "Chemical", "type": "Insecticide", "targets": [], "ai_targets": ["Mites"],
	       "irac": [], "frac": [], "ingredients": []},
	"NONE": {"name": "Nothing known", "category": "Chemical", "type": "Insecticide", "targets": [], "ai_targets": [],
	         "irac": [], "frac": [], "ingredients": []},
	"FOL": {"name": "Foliar feed", "category": "Foliar", "type": "", "targets": [], "ai_targets": [], "irac": [],
	        "frac": [], "ingredients": []},
}


def ctx(targeting, rows, mix=None, targets=("Mildew", "Mites"), modes=None):
	base = {"target_match": "Block", "target_coverage": "Block (GM override)", "same_moa_in_mix": "Warn",
	        "moa_rotation": "Block", "max_sprays": "Block (GM override)", "known_resistance": "Block",
	        "tank_mix_incompatible": "Block"}
	base.update(modes or {})
	return {"crop": "Rose", "targets": list(targets), "mix": mix or [r["item"] for r in rows], "products": PRODUCTS,
	        "history": [], "guidelines": {"alternate_moa": {"irac": [], "frac": []}, "max_sprays": [], "known_resistance": []},
	        "incompatibilities": [], "targeting": targeting, "rows": rows, "now": "2026-10-14 10:00:00",
	        "modes": T.apply_mode(base, targeting)}


class TestModes(unittest.TestCase):
	def test_warn_softens_targeting_and_rotation_rules_only(self):
		m = T.apply_mode({"target_match": "Block", "target_coverage": "Block (GM override)", "moa_rotation": "Block",
		                  "max_sprays": "Block", "known_resistance": "Block (GM override)", "same_moa_in_mix": "Block",
		                  "tank_mix_incompatible": "Block", "x": "Off"}, "Warn")
		for r in T.TARGETING_RULES:
			self.assertEqual(m[r], "Warn")
		self.assertEqual((m["same_moa_in_mix"], m["tank_mix_incompatible"]), ("Block", "Block"))

	def test_warn_keeps_an_off_rule_off_and_strict_changes_nothing(self):
		self.assertEqual(T.apply_mode({"target_match": "Off"}, "Warn")["target_match"], "Off")
		cfg = {"target_match": "Block", "moa_rotation": "Block (GM override)"}
		self.assertEqual(T.apply_mode(cfg, "Strict"), cfg)

	def test_default_is_strict_when_nothing_is_stored(self):
		with mock.patch.object(frappe.db, "get_single_value", return_value=None):
			self.assertEqual(T.mode(), "Strict")
		with mock.patch.object(frappe.db, "get_single_value", return_value="Warn"):
			self.assertEqual(T.mode(), "Warn")


class TestEngine(unittest.TestCase):
	def test_strict_blocks_a_product_not_valid_for_the_row_target(self):
		res = E.check_mix(ctx("Strict", [{"item": "REG", "targets": ["Mites"]}]))
		v = [x for x in res["violations"] if x["rule"] == "row_target"]
		self.assertEqual([x["mode"] for x in v], ["Block"])
		self.assertTrue(res["blocking"])
		self.assertIn("not registered for Mites", v[0]["message"])

	def test_strict_accepts_registered_and_ingredient_valid_targets(self):
		res = E.check_mix(ctx("Strict", [{"item": "REG", "targets": ["Mildew"]}, {"item": "AI", "targets": ["Mites"]}]))
		self.assertEqual([x for x in res["violations"] if x["rule"] in ("row_target", "untargeted")], [])

	def test_strict_refuses_a_product_with_no_registered_or_known_target(self):
		res = E.check_mix(ctx("Strict", [{"item": "NONE", "targets": ["Mites"]}]))
		self.assertEqual({x["rule"]: x["mode"] for x in res["violations"] if x["rule"] in ("untargeted", "row_target")},
		                 {"untargeted": "Block", "row_target": "Block"})

	def test_warn_allows_anything_with_warnings_and_never_blocks_or_needs_override(self):
		rows = [{"item": "REG", "targets": ["Mites"]}, {"item": "NONE", "targets": ["Mildew"]}]
		res = E.check_mix(ctx("Warn", rows))
		self.assertFalse(res["blocking"])
		self.assertFalse(res["needs_override"])
		self.assertEqual(res["status"], "Warnings")
		self.assertTrue(res["violations"])
		self.assertTrue(all(v["mode"] == "Warn" for v in res["violations"] if v["rule"] != "same_moa_in_mix"))

	def test_foliar_rows_are_never_target_checked(self):
		res = E.check_mix(ctx("Strict", [{"item": "FOL", "targets": ["Anything"]}]))
		self.assertEqual([x for x in res["violations"] if x["rule"] in ("row_target", "untargeted")], [])

	def test_a_context_without_a_targeting_mode_is_unchanged(self):
		c = ctx("Strict", [{"item": "REG", "targets": ["Mites"]}])
		c.pop("targeting")
		self.assertEqual([x for x in E.check_mix(c)["violations"] if x["rule"] in ("row_target", "untargeted")], [])


class TestEnforcement(unittest.TestCase):
	"""Drafts (create / update), approval (single + bulk) and submit all go through these."""

	def payload(self):
		return {"custom_greenhouse": "GH", "custom_targets": ["Mildew", "Mites"],
		        "chemicals": [{"item_code": "REG", "targets": ["Mites"]}]}

	def test_strict_blocks_at_the_draft(self):
		with mock.patch.object(A.C, "build_context", return_value=ctx("Strict", [{"item": "REG", "targets": ["Mites"]}])):
			with self.assertRaises(frappe.ValidationError):
				A.enforce_on_save(self.payload(), frappe._dict())

	def test_warn_saves_the_draft_with_warnings(self):
		wo = frappe._dict()
		wo.set = lambda k, v: wo.__setitem__(k, v)
		with mock.patch.object(A.C, "build_context", return_value=ctx("Warn", [{"item": "REG", "targets": ["Mites"]}])):
			res = A.enforce_on_save(self.payload(), wo)
		self.assertEqual(res["status"], "Warnings")
		self.assertEqual(wo.custom_compliance_status, "Warnings")

	def test_approval_single_and_bulk_use_the_same_check(self):
		wo = frappe._dict(name="W")
		with mock.patch.object(A.C, "context_for_wo", return_value=ctx("Strict", [{"item": "REG", "targets": ["Mites"]}])), \
		     mock.patch.object(A, "stored_overrides", return_value=[]):
			self.assertIn("not registered for Mites", A.enforce_on_approval(wo)["reason"])
		with mock.patch.object(A.C, "context_for_wo", return_value=ctx("Warn", [{"item": "REG", "targets": ["Mites"]}])), \
		     mock.patch.object(A, "stored_overrides", return_value=[]):
			self.assertIsNone(A.enforce_on_approval(wo))

	def doc(self, chems=(("REG", "Mites"),)):
		d = frappe._dict(custom_type="Application Floor Plan", creation="2026-10-20 10:00:00", custom_targets="Mildew\nMites")
		d.required_items = [frappe._dict(item_code=c, item_name=c, custom_targets=t) for c, t in chems]
		d.get = lambda k, default=None, _d=d: _d.__dict__.get(k, default)
		return d

	def test_submit_blocks_in_strict_and_passes_in_warn(self):
		with mock.patch.object(V, "needs_row_targets", return_value=True), \
		     mock.patch.object(frappe.db, "get_value", side_effect=lambda dt, c, f=None, *a, **k: c):
			with mock.patch("upande_scp.serverscripts.spray_compliance.api.enforce_on_approval",
			                return_value={"reason": "• Registered is not registered for Mites."}):
				with self.assertRaises(frappe.ValidationError):
					V.enforce_row_targets_on_submit(self.doc())
			with mock.patch("upande_scp.serverscripts.spray_compliance.api.enforce_on_approval", return_value=None):
				V.enforce_row_targets_on_submit(self.doc())

	def test_warn_still_requires_row_targets(self):
		with mock.patch.object(T.frappe.db, "get_single_value", return_value="Warn"), \
		     mock.patch.object(V, "needs_row_targets", return_value=True), \
		     mock.patch.object(frappe.db, "get_value", side_effect=lambda dt, c, f=None, *a, **k: c):
			with self.assertRaises(frappe.ValidationError):
				V.validate_chemical_targets([{"item_code": "NONE", "item_name": "Nothing known"}], ["Mites"])


class TestSetterAndPatch(unittest.TestCase):
	def test_only_a_gm_can_change_the_mode(self):
		with mock.patch.object(A, "can_override", return_value=False):
			with self.assertRaises(frappe.PermissionError):
				A.set_targeting_mode("Strict")

	def test_gm_sets_a_valid_mode_and_an_invalid_one_is_refused(self):
		doc = mock.MagicMock()
		doc.get.return_value = "Warn"
		with mock.patch.object(A, "can_override", return_value=True), \
		     mock.patch.object(frappe, "get_single", return_value=doc), \
		     mock.patch.object(A, "get_targeting_mode", return_value={"mode": "Strict"}):
			A.set_targeting_mode("Strict")
			doc.set.assert_called_with("chemical_targeting_mode", "Strict")
			doc.save.assert_called_once()
			with self.assertRaises(frappe.ValidationError):
				A.set_targeting_mode("Lax")

	def test_the_settings_document_keeps_version_history(self):
		self.assertEqual(frappe.get_meta(T.SETTINGS).track_changes, 1)

	def test_patch_sets_existing_sites_to_warn_once(self):
		with mock.patch.object(frappe.db, "sql", return_value=[]), \
		     mock.patch.object(frappe.db, "set_single_value") as s:
			PATCH.execute()
			s.assert_called_once_with(T.SETTINGS, "chemical_targeting_mode", "Warn")

	def test_patch_never_overwrites_an_explicit_choice(self):
		with mock.patch.object(frappe.db, "sql", return_value=[("Strict",)]), \
		     mock.patch.object(frappe.db, "set_single_value") as s:
			PATCH.execute()
			s.assert_not_called()

	def test_new_sites_default_to_strict(self):
		f = frappe.get_meta(T.SETTINGS).get_field("chemical_targeting_mode")
		self.assertEqual((f.default, f.options.split("\n")), ("Strict", ["Strict", "Warn"]))
