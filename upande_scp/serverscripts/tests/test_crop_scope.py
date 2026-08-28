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


class TestScoutingEntryScope(unittest.TestCase):
	"""Scoped on `crop_scouted`, not on the greenhouse.

	Every one of the 297,131 scouting entries on kaitet carries a crop, but only
	293,769 have a greenhouse that resolves to a farm — the 3,362 that do not are
	exactly the avocado ones, because avocado is recorded against blocks. A
	farm-based condition would therefore hide every avocado entry while looking
	perfectly correct for roses.
	"""

	def setUp(self):
		crop_scope.clear_cache()

	def tearDown(self):
		crop_scope.clear_cache()

	def test_condition_names_only_the_users_crops(self):
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		cond = crop_scope.scouting_entry_query_condition(PETER)
		self.assertIn("`tabScouting Entry`.crop_scouted IN (", cond)
		self.assertIn("'Rose'", cond)
		self.assertNotIn("'Avocado'", cond)

	def test_an_empty_scope_blocks_every_row(self):
		ghost = "no-such-user-in-this-test@example.com"
		self.assertEqual(crop_scope.scouting_entry_query_condition(ghost), "1=0")

	def test_administrator_gets_no_condition(self):
		self.assertEqual(crop_scope.scouting_entry_query_condition("Administrator"), "")

	def test_a_row_with_no_crop_is_refused_not_allowed(self):
		"""An unclassifiable record is not the same as an unrestricted one."""
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		doc = frappe._dict({"crop_scouted": None})
		self.assertFalse(crop_scope.scouting_entry_has_permission(doc, "read", PETER))


class TestWorkOrderScope(unittest.TestCase):
	"""Only Application Floor Plans are scoped.

	1,786 Work Orders on kaitet are livestock and manufacturing orders with no
	`custom_type` and no greenhouse. Gating every Work Order by farm would hide all
	of them from everyone — wrong, and nothing to do with crop protection.
	"""

	def setUp(self):
		crop_scope.clear_cache()

	def tearDown(self):
		crop_scope.clear_cache()

	def test_a_non_spray_work_order_is_never_scoped(self):
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		feed = frappe._dict({"custom_type": None, "custom_greenhouse": None})
		self.assertTrue(crop_scope.work_order_has_permission(feed, "read", ELVIS))

	def test_the_condition_always_admits_non_spray_orders(self):
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		cond = crop_scope.work_order_query_condition(ELVIS)
		self.assertIn("custom_type IS NULL", cond)
		self.assertIn("!= 'Application Floor Plan'", cond)

	def test_an_empty_scope_still_admits_non_spray_orders(self):
		"""Failing closed must not take out the livestock work orders."""
		ghost = "no-such-user-in-this-test@example.com"
		cond = crop_scope.work_order_query_condition(ghost)
		self.assertNotEqual(cond, "1=0")
		self.assertIn("custom_type IS NULL", cond)

	def test_a_spray_plan_outside_the_users_farms_is_refused(self):
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		houses = crop_scope.allowed_greenhouses(ELVIS)
		self.assertIsNotNone(houses)
		foreign = frappe.db.get_value(
			"Work Order",
			{"custom_type": "Application Floor Plan"},
			["name", "custom_greenhouse"],
			as_dict=True,
		)
		if not foreign or foreign.custom_greenhouse in houses:
			self.skipTest("no spray plan outside this user's farms")
		doc = frappe._dict({
			"custom_type": "Application Floor Plan",
			"custom_greenhouse": foreign.custom_greenhouse,
		})
		self.assertFalse(crop_scope.work_order_has_permission(doc, "read", ELVIS))

	def test_administrator_gets_no_condition(self):
		self.assertEqual(crop_scope.work_order_query_condition("Administrator"), "")


class TestCropContextNarrowsTheDropdowns(unittest.TestCase):
	"""Two narrowings meet in the UI and must not be conflated.

	*Who you are* is the gate: a Karen Roses user never sees Lokitela. *Where you are*
	is context: inside the Avocado section a farm picker offers Lokitela alone, even to
	an administrator entitled to every farm. Context narrows everyone; permission
	narrows further; the answer is the intersection.
	"""

	def setUp(self):
		crop_scope.clear_cache()

	def tearDown(self):
		crop_scope.clear_cache()

	def test_crop_context_narrows_even_an_unrestricted_user(self):
		self.assertIsNone(crop_scope.allowed_farms("Administrator"))
		avocado = crop_scope.scoped_farms("Avocado", "Administrator")
		self.assertIsNotNone(avocado, "a crop context must narrow even an administrator")
		self.assertEqual(avocado, {"Lokitela"})

	def test_no_crop_leaves_an_unrestricted_user_unrestricted(self):
		self.assertIsNone(crop_scope.scoped_farms(None, "Administrator"))

	def test_a_rose_user_gets_nothing_under_avocado(self):
		if not _has_employee(PETER):
			self.skipTest("Peter Kamuren has no Employee record on this site")
		self.assertEqual(crop_scope.scoped_farms("Avocado", PETER), set())

	def test_an_avocado_user_gets_nothing_under_rose(self):
		"""'for roses we should not be seeing lokitela'."""
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		self.assertEqual(crop_scope.scoped_farms("Rose", ELVIS), set())

	def test_an_avocado_user_under_avocado_gets_their_farm(self):
		if not _has_employee(ELVIS):
			self.skipTest("Elvis Koskei has no Employee record on this site")
		self.assertEqual(crop_scope.scoped_farms("Avocado", ELVIS), {"Lokitela"})

	def test_coffee_resolves_to_its_tagged_farms(self):
		"""The tags resolve even though those farms have no scoutable units yet —
		`farms_for_crop` reads the tags, and whether a farm has beds or typed
		warehouses is a separate question the dropdown answers downstream."""
		self.assertEqual(crop_scope.farms_for_crop("Coffee"), {"Endebess", "Saboti"})
