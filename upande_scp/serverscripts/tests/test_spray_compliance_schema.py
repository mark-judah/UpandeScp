"""Schema for spray compliance exists after migrate. DB test — direct runner.

    cd sites && ../env/bin/python -c "import frappe, unittest; \
        frappe.init(site='kaitet.local'); frappe.connect(); \
        frappe.set_user('Administrator'); \
        from upande_scp.serverscripts.tests import test_spray_compliance_schema as T; \
        unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromModule(T))"
"""

import unittest

import frappe

RULES = ["target_match", "target_coverage", "same_moa_in_mix", "moa_rotation",
         "max_sprays", "known_resistance", "tank_mix_incompatible"]
MODES = ["Off", "Warn", "Block (GM override)", "Block"]


class TestSchema(unittest.TestCase):
	def test_active_ingredient_moa(self):
		meta = frappe.get_meta("Active Ingredient MoA")
		for f in ("ingredient", "aliases", "kind", "frac_code", "irac_code", "notes"):
			self.assertTrue(meta.get_field(f), f)
		self.assertEqual(meta.get_field("frac_code").options, "FRAC Code")
		self.assertEqual(meta.get_field("irac_code").options, "IRAC Code")

	def test_rule_modes_on_settings(self):
		meta = frappe.get_meta("Scouting and Crop Protection Settings")
		for r in RULES:
			f = meta.get_field(f"rule_{r}")
			self.assertTrue(f, r)
			self.assertEqual(f.options.split("\n"), MODES)
			self.assertEqual(f.default, "Warn")
		self.assertEqual(meta.get_field("tank_mix_incompatibilities").options,
		                 "Tank Mix Incompatibility")

	def test_rule_modes_are_crop_overridable(self):
		from upande_scp.serverscripts.spray_plan_creator.crop_settings import OVERRIDABLE
		for r in RULES:
			self.assertIn(f"rule_{r}", OVERRIDABLE)

	def test_work_order_fields(self):
		meta = frappe.get_meta("Work Order")
		self.assertEqual(meta.get_field("custom_spray_rule_overrides").options, "Spray Rule Override")
		self.assertIn("Awaiting Override", meta.get_field("custom_compliance_status").options)

	def test_active_ingredient_row_has_link_and_concentration(self):
		meta = frappe.get_meta("Active Ingredient")
		self.assertEqual(meta.get_field("active_ingredient").options, "Active Ingredient MoA")
		self.assertEqual(meta.get_field("concentration").fieldtype, "Float")
		self.assertEqual(meta.get_field("concentration_unit").options.split("\n"),
		                 ["", "g/L", "g/kg", "%", "CFU/g", "CFU/mL", "OB/mL"])
		self.assertEqual(meta.get_field("ingredient").label, "As on label")

	def test_spray_product_type_has_pgr(self):
		opts = frappe.get_meta("Spray Product").get_field("type").options.split("\n")
		self.assertIn("Plant Growth Regulator", opts)
