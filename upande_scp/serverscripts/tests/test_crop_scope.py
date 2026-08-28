"""The crop access gate, checked against the real people it was built for.

Peter Kamuren is a general manager at Karen Roses and should see roses only — the
general-manager role is deliberately not a bypass, because a manager belongs to a
company like anyone else. Elvis Koskei is at Kaitet Ltd. and should see coffee and
avocado. A user at `Kaitet Group`, the parent, should see all three without any rule
of their own — that falls out of the nested set.
"""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_scope

PETER = "pkamuren@karenroses.com"
ELVIS = "koskey@lokitelaorchards.com"


def _has_employee(user):
	return bool(frappe.db.exists("Employee", {"user_id": user}))


class TestTheChain(unittest.TestCase):
	def setUp(self):
		crop_scope.clear_cache()

	def tearDown(self):
		crop_scope.clear_cache()

	def test_a_manager_at_karen_roses_sees_roses_only(self):
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		self.assertEqual(crop_scope.allowed_crops(PETER), {"Rose"})

	def test_a_manager_is_not_a_bypass(self):
		"""The whole point of the previous test: SCP General Manager is scoped."""
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		self.assertIn("SCP General Manager", frappe.get_roles(PETER))
		self.assertFalse(crop_scope.is_unrestricted(PETER))

	def test_kaitet_ltd_sees_coffee_and_avocado(self):
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		self.assertEqual(crop_scope.allowed_crops(ELVIS), {"Coffee", "Avocado"})

	def test_kaitet_ltd_does_not_see_roses(self):
		"""`Rose -> Vale` was bad input; Vale is a Kaitet Ltd. farm."""
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		self.assertNotIn("Rose", crop_scope.allowed_crops(ELVIS))

	def test_the_parent_company_sees_every_child_crop(self):
		"""No rule of its own — a parent's [lft, rgt] contains every child's."""
		if not frappe.db.exists("Company", "Kaitet Group"):
			self.skipTest("no Kaitet Group on this site")
		companies = frappe.get_all(
			"Company", filters={"name": "Kaitet Group"}, fields=["lft", "rgt"]
		)[0]
		children = frappe.get_all(
			"Company",
			filters={"lft": [">=", companies.lft], "rgt": ["<=", companies.rgt]},
			pluck="name",
		)
		self.assertIn("Karen Roses", children)
		self.assertIn("Kaitet Ltd.", children)


class TestFailsClosed(unittest.TestCase):
	def setUp(self):
		crop_scope.clear_cache()

	def tearDown(self):
		crop_scope.clear_cache()

	def test_a_user_with_no_employee_sees_nothing(self):
		ghost = "no-such-user-in-this-test@example.com"
		self.assertEqual(crop_scope.allowed_companies(ghost), set())
		self.assertEqual(crop_scope.allowed_farms(ghost), set())
		self.assertEqual(crop_scope.allowed_crops(ghost), set())

	def test_an_empty_scope_is_not_an_unrestricted_scope(self):
		"""The distinction the whole module turns on: `None` != `set()`."""
		ghost = "no-such-user-in-this-test@example.com"
		self.assertIsNotNone(crop_scope.allowed_crops(ghost))

	def test_an_empty_scope_blocks_the_query_rather_than_opening_it(self):
		ghost = "no-such-user-in-this-test@example.com"
		self.assertEqual(crop_scope.crop_query_condition(ghost), "1=0")

	def test_administrator_is_unrestricted(self):
		self.assertTrue(crop_scope.is_unrestricted("Administrator"))
		self.assertIsNone(crop_scope.allowed_crops("Administrator"))
		self.assertEqual(crop_scope.crop_query_condition("Administrator"), "")

	def test_assert_crop_refuses_a_crop_outside_the_scope(self):
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		with self.assertRaises(frappe.PermissionError):
			crop_scope.assert_crop("Coffee", PETER)
		crop_scope.assert_crop("Rose", PETER)  # must not raise


class TestTheQueryCondition(unittest.TestCase):
	def setUp(self):
		crop_scope.clear_cache()

	def tearDown(self):
		crop_scope.clear_cache()

	def test_the_condition_actually_filters_the_list(self):
		"""End to end: this is what makes the workspace tiles correct, because the
		navigation block reads `Crop Scouted` through a permission-checked
		`frappe.db.get_list` and needs no change of its own."""
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		condition = crop_scope.crop_query_condition(PETER)
		self.assertIn("Rose", condition)
		self.assertNotIn("Coffee", condition)

	def test_the_condition_is_escaped(self):
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		condition = crop_scope.crop_query_condition(ELVIS)
		self.assertIn("`tabCrop Scouted`.name IN (", condition)
		self.assertIn("'Coffee'", condition)

	def test_has_permission_agrees_with_the_condition(self):
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		rose = frappe.get_doc("Crop Scouted", "Rose")
		self.assertTrue(crop_scope.crop_has_permission(rose, "read", PETER))
		if frappe.db.exists("Crop Scouted", "Coffee"):
			coffee = frappe.get_doc("Crop Scouted", "Coffee")
			self.assertFalse(crop_scope.crop_has_permission(coffee, "read", PETER))
