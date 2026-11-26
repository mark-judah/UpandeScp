"""Spray ticket preview (MOLFM27 layout): method field, builder, print format.

Run: bench --site mutara.local run-tests \
        --module upande_scp.serverscripts.tests.test_spray_ticket
"""

import unittest

import frappe


class TestMethodField(unittest.TestCase):
	def test_field_exists_with_options(self):
		f = frappe.get_meta("Work Order").get_field("custom_method_of_application")
		self.assertIsNotNone(f)
		self.assertTrue(
			{"Spraying (foliar)", "Dusting", "Chemigation"} <= set(f.options.split("\n"))
		)

	def test_draft_defaults_method(self):
		from upande_scp.serverscripts.spray_plan_creator.drafts import _apply_method_default

		self.assertEqual(
			_apply_method_default({"custom_kit": "K"})["custom_method_of_application"],
			"Spraying (foliar)",
		)
		self.assertEqual(
			_apply_method_default({"custom_method_of_application": "Dusting"})[
				"custom_method_of_application"
			],
			"Dusting",
		)
		self.assertEqual(
			_apply_method_default({"custom_method_of_application": ""})[
				"custom_method_of_application"
			],
			"Spraying (foliar)",
		)


def _steps(done=("created", "approved", "chemical_issued", "labels_scanned",
                 "spraying_started", "completed"), stopped_after=None):
	out = []
	for key in ("created", "approved", "chemical_issued", "labels_printed", "labels_scanned",
	            "spraying_started", "completed"):
		is_done = key in done
		out.append({
			"key": key,
			"status": "done" if is_done else ("skipped" if stopped_after else "pending"),
			"actor": f"Actor {key}" if is_done else None,
			"timestamp": f"2026-11-0{len(out) + 1}T08:00:00" if is_done else None,
			"detail": None,
		})
	return out


def full_ctx(**over):
	ctx = {
		"work_order": "MFG-WO-2026-00001",
		"stopped": False,
		"steps": _steps(),
		"block": "P1-B1",
		"farm": "Mutara",
		"location": "P1",
		"area_ha": 2.13,
		"crop": "Avocado",
		"variety": "Hass",
		"crop_stage": "Fruit development",
		"app_week": "W48 2026",
		"operator": "Jane Doe (Supervisor), John Roe",
		"products": [
			{"item_code": "CHEM-1", "qty": 1.278, "uom": "Litre",
			 "rate": "0.6 Litre per 1000 Litre", "reason": None, "ingredients": ["Copper 500 g/L"],
			 "per_litre": "0.0006 Litre per litre"},
		],
		"equipment": "Mutara Knapsack Kit 1",
		"method": "Spraying (foliar)",
		"water_l": 2130.0,
		"water_required": True,
		"spray": {"targets": "Mites", "classification": "Preventive", "reentry": "12 h", "phi": "7 days"},
	}
	ctx.update(over)
	return ctx


def lines_by_key(t):
	return {l["key"]: l for l in t["lines"]}


class TestBuildTicket(unittest.TestCase):
	def build(self, **over):
		from upande_scp.serverscripts.spray_plan_ops.spray_ticket import build_ticket

		return build_ticket(full_ctx(**over))

	def test_full_ctx_is_100_and_printable(self):
		t = self.build()
		self.assertEqual(t["percent"], 100)
		self.assertTrue(t["printable"])
		self.assertEqual(t["missing"], [])
		self.assertEqual(len([l for l in t["lines"] if l["group"] != "spray"]), 19)
		self.assertEqual(
			[l["key"] for l in t["lines"]],
			["block", "farm", "location", "area_ha", "crop", "variety", "crop_stage", "app_week",
			 "operator", "products", "composition", "equipment", "method", "water",
			 "prepared", "authorized", "issued", "collected", "applied",
			 "targets", "classification", "reentry", "phi"],
		)

	def test_blank_stage_is_missing_with_hint(self):
		t = self.build(crop_stage=None)
		line = lines_by_key(t)["crop_stage"]
		self.assertFalse(line["filled"])
		self.assertEqual(line["hint"], "Set the crop stage on the crop cycle in Production")
		self.assertEqual(t["percent"], 94)
		self.assertFalse(t["printable"])
		self.assertIn(line["label"], t["missing"])

	def test_product_without_rate_is_missing(self):
		prods = full_ctx()["products"] + [
			{"item_code": "CHEM-2", "qty": 2, "uom": "Kg", "rate": None,
			 "reason": "No rate set for CHEM-2", "ingredients": ["Sulphur"], "per_litre": None},
		]
		t = self.build(products=prods)
		line = lines_by_key(t)["products"]
		self.assertFalse(line["filled"])
		self.assertIn("CHEM-2", line["hint"])
		self.assertNotIn(" 0 ", line["value"] or "")

	def test_product_without_ingredients_leaves_composition_missing(self):
		prods = [dict(full_ctx()["products"][0], ingredients=[])]
		t = self.build(products=prods)
		self.assertFalse(lines_by_key(t)["composition"]["filled"])

	def test_no_products_is_missing(self):
		t = self.build(products=[])
		self.assertFalse(lines_by_key(t)["products"]["filled"])
		self.assertFalse(lines_by_key(t)["composition"]["filled"])

	def test_no_cycle_no_crash(self):
		t = self.build(crop_stage=None, variety=None, crop=None)
		self.assertLess(t["percent"], 100)

	def test_area_only_plan_needs_no_water(self):
		t = self.build(water_l=None, water_required=False)
		self.assertTrue(lines_by_key(t)["water"]["filled"])
		t = self.build(water_l=None, water_required=True)
		self.assertFalse(lines_by_key(t)["water"]["filled"])

	def test_spray_lines_do_not_count(self):
		t = self.build(spray={"targets": None, "classification": None, "reentry": None, "phi": None})
		self.assertEqual(t["percent"], 100)
		self.assertFalse(lines_by_key(t)["phi"]["filled"])
		self.assertEqual(t["missing"], [])

	def test_stopped_plan_never_printable(self):
		t = self.build(stopped=True, steps=_steps(done=("created", "approved"), stopped_after=True))
		self.assertFalse(t["printable"])
		self.assertFalse(lines_by_key(t)["applied"]["filled"])
		t = self.build(stopped=True)
		self.assertFalse(t["printable"])

	def test_signoff_values(self):
		t = self.build()
		v = lines_by_key(t)["authorized"]["value"]
		self.assertIn("Actor approved", v)
		self.assertIn("2026-11-02", v)
		applied = lines_by_key(t)["applied"]["value"]
		self.assertIn("2026-11-06", applied)
		self.assertIn("2026-11-07", applied)


class TestPrintFormat(unittest.TestCase):
	TICKET_MODULE = "upande_scp.serverscripts.spray_plan_ops.spray_ticket"

	def _wo(self):
		wo = frappe.db.get_value(
			"Work Order", {"custom_type": "Application Floor Plan"}, "name"
		)
		if not wo:
			self.skipTest("no Application Floor Plan Work Order on this site")
		return wo

	def _mock_ticket(self, wo, **over):
		from unittest.mock import patch

		from upande_scp.serverscripts.spray_plan_ops import spray_ticket as T

		t = T.build_ticket(full_ctx(work_order=wo, **over))
		return patch(f"{self.TICKET_MODULE}.get_spray_ticket", return_value=t)

	def test_print_renders_complete(self):
		wo = self._wo()
		with self._mock_ticket(wo):
			html = frappe.get_print("Work Order", wo, "SCP Spray Ticket", no_letterhead=1)
		self.assertIn("Field/FSQM/2", html)
		self.assertIn("P1-B1", html)
		self.assertNotIn("INCOMPLETE", html)

	def test_print_marks_incomplete(self):
		wo = self._wo()
		with self._mock_ticket(wo, crop_stage=None):
			html = frappe.get_print("Work Order", wo, "SCP Spray Ticket", no_letterhead=1)
		self.assertIn("INCOMPLETE — 94%", html)

	def test_print_refuses_without_access(self):
		from upande_scp.serverscripts.spray_plan_ops.spray_ticket import ticket_for_print

		wo = self._wo()
		email = "spray.ticket.noaccess@example.com"
		if not frappe.db.exists("User", email):
			frappe.get_doc({
				"doctype": "User", "email": email, "first_name": "NoAccess",
				"send_welcome_email": 0, "roles": [],
			}).insert(ignore_permissions=True)
		prev = frappe.session.user
		try:
			frappe.set_user(email)
			with self.assertRaises(frappe.PermissionError):
				ticket_for_print(wo)
		finally:
			frappe.set_user(prev)
			frappe.delete_doc("User", email, force=True, ignore_permissions=True)
