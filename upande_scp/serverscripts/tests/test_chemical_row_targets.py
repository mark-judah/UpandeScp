"""Per-chemical targets on the Application Floor Plan: recorded, enforced server-side."""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_plan_creator import drafts
from upande_scp.serverscripts.spray_plan_creator import validation as V

CHEMICALS = {"CHEM1", "CHEM2"}


def needs(code):
	return code in CHEMICALS


class TestValidate(unittest.TestCase):
	def setUp(self):
		p = mock.patch.object(V, "needs_row_targets", side_effect=needs)
		p.start()
		self.addCleanup(p.stop)
		p2 = mock.patch.object(frappe.db, "get_value", side_effect=lambda dt, code, f=None, *a, **k: code)
		p2.start()
		self.addCleanup(p2.stop)

	def test_missing_targets_block(self):
		with self.assertRaises(frappe.ValidationError):
			V.validate_chemical_targets([{"item_code": "CHEM1", "item_name": "Chem 1"}], ["Mites"])

	def test_one_row_missing_blocks_even_when_others_have_targets(self):
		with self.assertRaises(frappe.ValidationError):
			V.validate_chemical_targets(
				[{"item_code": "CHEM1", "targets": ["Mites"]}, {"item_code": "CHEM2", "targets": []}], ["Mites"])

	def test_targets_must_be_on_the_plan(self):
		with self.assertRaises(frappe.ValidationError):
			V.validate_chemical_targets([{"item_code": "CHEM1", "targets": ["Thrips"]}], ["Mites"])

	def test_foliar_rows_need_no_targets_and_valid_rows_pass(self):
		V.validate_chemical_targets(
			[{"item_code": "CHEM1", "targets": ["Mites", "Thrips"]}, {"item_code": "FOLIAR1"}], ["Mites", "Thrips"])

	def test_split_targets_accepts_list_and_newline_string(self):
		self.assertEqual(V.split_targets("a\n b\n\na"), ["a", "b"])
		self.assertEqual(V.split_targets(["a", "", "b"]), ["a", "b"])


class TestDraftsEnforcement(unittest.TestCase):
	def payload(self, chems):
		return {"custom_targets": ["Mites"], "chemicals": chems, "custom_water_volume": 1000,
		        "_skip_target_validation": True, "_skip_bom_validation": True}

	def setUp(self):
		p = mock.patch.object(V, "needs_row_targets", side_effect=needs)
		p.start()
		self.addCleanup(p.stop)

	def test_draft_without_row_targets_is_rejected_server_side(self):
		with mock.patch.object(drafts, "validate_rate_in_limits"):
			with self.assertRaises(frappe.ValidationError):
				drafts._validate_payload(self.payload([{"item_code": "CHEM1", "application_rate": 1}]), {})

	def test_draft_with_row_targets_passes(self):
		with mock.patch.object(drafts, "validate_rate_in_limits"):
			drafts._validate_payload(self.payload([{"item_code": "CHEM1", "targets": ["Mites"], "application_rate": 1}]), {})

	def test_apply_payload_writes_targets_onto_the_work_order_item(self):
		wo = frappe.new_doc("Work Order")
		payload = {"custom_targets": ["Mites", "Thrips"], "chemicals": [
			{"item_code": "CHEM1", "item_name": "Chem 1", "application_rate": 1, "targets": ["Mites", "Thrips"]},
			{"item_code": "FOL1", "item_name": "Foliar", "application_rate": 2}]}
		with mock.patch.object(drafts, "_resolve_item_code", side_effect=lambda c: c):
			drafts._apply_payload(wo, payload)
		self.assertEqual(wo.required_items[0].custom_targets, "Mites\nThrips")
		self.assertEqual(wo.required_items[1].custom_targets, "")


class TestSubmitHook(unittest.TestCase):
	def doc(self, created, rows, plan="Mites"):
		d = frappe._dict(custom_type="Application Floor Plan", creation=created, custom_targets=plan)
		d.required_items = [frappe._dict(item_code=c, item_name=c, custom_targets=t) for c, t in rows]
		d.get = lambda k, default=None, _d=d: _d.__dict__.get(k, default) if k != "required_items" else _d["required_items"]
		return d

	def setUp(self):
		p = mock.patch.object(V, "needs_row_targets", side_effect=needs)
		p.start()
		self.addCleanup(p.stop)
		p2 = mock.patch.object(frappe.db, "get_value", side_effect=lambda dt, code, f=None, *a, **k: code)
		p2.start()
		self.addCleanup(p2.stop)

	def test_new_plan_without_targets_cannot_be_submitted(self):
		with self.assertRaises(frappe.ValidationError):
			V.enforce_row_targets_on_submit(self.doc("2026-10-20 10:00:00", [("CHEM1", "")]))

	def test_new_plan_with_targets_submits(self):
		V.enforce_row_targets_on_submit(self.doc("2026-10-20 10:00:00", [("CHEM1", "Mites")]))

	def test_old_plans_stay_valid(self):
		V.enforce_row_targets_on_submit(self.doc("2026-09-01 10:00:00", [("CHEM1", "")]))


class TestSuggest(unittest.TestCase):
	def test_single_plan_target_prefills(self):
		with mock.patch.object(V, "needs_row_targets", return_value=True):
			self.assertEqual(V.suggest_row_targets(["Mites"], ["C"])["C"]["targets"], ["Mites"])

	def test_registered_subset_prefills_otherwise_empty(self):
		from upande_scp.serverscripts.common import crop_protection as CP
		with mock.patch.object(V, "needs_row_targets", return_value=True), \
		     mock.patch.object(CP, "get_product_targets", side_effect=lambda c: [{"pest": "Mites"}] if c == "A" else []):
			out = V.suggest_row_targets(["Mites", "Thrips"], ["A", "B"])
		self.assertEqual(out["A"]["targets"], ["Mites"])
		self.assertEqual(out["B"]["targets"], [])

	def test_not_required_for_foliar(self):
		with mock.patch.object(V, "needs_row_targets", return_value=False):
			self.assertEqual(V.suggest_row_targets(["Mites"], ["F"])["F"], {"required": False, "targets": []})
