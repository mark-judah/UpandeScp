"""The Farm accounting dimension on a plan's Stock Entries is the plan's own farm.

Two throwaway plans on two farms; the entries are made by a user whose default
Farm User Permission is the OTHER farm (the Kapkolia-on-Chepsito bug), and each
chain must still carry its own plan's farm on the parent and every row.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_farm_dimension
"""

import unittest

import frappe

from upande_scp.serverscripts.store import farm_dimension as FD
from upande_scp.serverscripts.tests.afp_fixture import MTM, ThrowawayPlan, wipe

USER = "_test_scp_farm_dim@example.com"


class TestFarmDimension(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		farms = frappe.get_all("Farm", pluck="name", limit=2, order_by="name")
		if len(farms) < 2:
			raise unittest.SkipTest("needs two Farms")
		cls.farm_a, cls.farm_b = farms
		cls.a = ThrowawayPlan("FDA").build()
		cls.b = ThrowawayPlan("FDB").build()
		frappe.db.set_value("Warehouse", cls.a.gh, "custom_farm", cls.farm_a)
		frappe.db.set_value("Warehouse", cls.b.gh, "custom_farm", cls.farm_b)
		cls.a.wo = cls.a.add_plan(transfer=False)
		cls.b.wo = cls.b.add_plan(transfer=False)
		if not frappe.db.exists("User", USER):
			frappe.get_doc({"doctype": "User", "email": USER, "first_name": "FD",
				"send_welcome_email": 0, "roles": [{"role": "Stock User"}, {"role": "Manufacturing User"}]}
			).insert(ignore_permissions=True)
		frappe.db.delete("User Permission", {"user": USER})
		# The user's default Farm is farm_a, so a Stock Entry made for plan B inherits the wrong one.
		frappe.get_doc({"doctype": "User Permission", "user": USER, "allow": "Farm",
			"for_value": cls.farm_a, "is_default": 1, "apply_to_all_doctypes": 1}).insert(ignore_permissions=True)
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		frappe.db.delete("User Permission", {"user": USER})
		for p in (cls.a, cls.b):
			wipe(p.prefix)
		frappe.delete_doc("User", USER, force=True, ignore_permissions=True)
		frappe.db.commit()

	def _transfer_as_user(self, plan):
		from erpnext.manufacturing.doctype.work_order.work_order import make_stock_entry

		frappe.set_user(USER)
		try:
			doc = frappe.get_doc(make_stock_entry(work_order_id=plan.wo.name, purpose=MTM))
		finally:
			frappe.set_user("Administrator")
		return doc

	def test_user_default_farm_is_what_erpnext_hands_us(self):
		# the precondition: the creator's default Farm lands on a fresh Stock Entry
		frappe.set_user(USER)
		try:
			self.assertEqual(frappe.new_doc("Stock Entry").get("farm"), self.farm_a)
		finally:
			frappe.set_user("Administrator")

	def test_each_chain_takes_its_own_plans_farm(self):
		made = []
		try:
			for plan, farm in ((self.a, self.farm_a), (self.b, self.farm_b)):
				doc = self._transfer_as_user(plan)
				doc.flags.ignore_permissions = True
				if not doc.items:
					doc.append("items", {"item_code": plan.chem, "qty": 1, "s_warehouse": plan.store,
						"t_warehouse": plan.csu, "basic_rate": 10, "batch_no": plan.batch,
						"use_serial_batch_fields": 1})
				doc.insert()  # items fill in on save; the hook stamps before validate
				made.append(doc.name)
				self.assertEqual(frappe.db.get_value("Stock Entry", doc.name, "farm"), farm)
				rows = frappe.db.sql_list(
					"select distinct farm from `tabStock Entry Detail` where parent=%s", doc.name)
				self.assertTrue(rows)
				self.assertEqual(set(rows), {farm})
		finally:
			for n in made:
				frappe.delete_doc("Stock Entry", n, force=True, ignore_permissions=True)

	def test_mixing_and_spray_follow_the_plan_greenhouse(self):
		mix = frappe.new_doc("Stock Entry")
		mix.update({"stock_entry_type": "Chemical Mixing", "work_order": self.b.wo.name, "farm": self.farm_a})
		mix.append("items", {"item_code": self.b.chem, "farm": self.farm_a})
		FD.stamp(mix)
		self.assertEqual((mix.farm, mix.items[0].farm), (self.farm_b, self.farm_b))
		spray = frappe.new_doc("Stock Entry")
		spray.update({"stock_entry_type": "Chemical Spray", "custom_spray_plan": self.a.wo.name, "farm": self.farm_b})
		spray.append("items", {"item_code": self.a.chem, "farm": self.farm_b})
		FD.stamp(spray)
		self.assertEqual((spray.farm, spray.items[0].farm), (self.farm_a, self.farm_a))

	def test_non_plan_entries_are_left_alone(self):
		doc = frappe.new_doc("Stock Entry")
		doc.stock_entry_type = "Material Receipt"
		doc.farm = self.farm_a
		self.assertIsNone(FD.plan_farm(doc))
		FD.stamp(doc)
		self.assertEqual(doc.farm, self.farm_a)

	def test_loaning_is_left_alone(self):
		doc = frappe.new_doc("Stock Entry")
		doc.stock_entry_type = "Chemical Loaning"
		doc.work_order = self.b.wo.name
		self.assertIsNone(FD.plan_farm(doc))
