"""Sprayer register + exposure ledger, over kaitet.local. Every test rolls back.

Run:
    cd sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local');
    frappe.connect(); frappe.set_user('Administrator'); import importlib;
    M=importlib.import_module('upande_scp.serverscripts.tests.test_sprayer_register');
    unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M))"
"""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common import exposure_rules as R
from upande_scp.serverscripts.sprayers import api, exposure, register

SAL = "Spray Application Logsheet"


def _employees(n):
	rows = frappe.get_all(
		"Employee",
		filters={"status": "Active", "company": "Karen Roses"},
		fields=["name"],
		order_by="name",
		limit_page_length=n,
	)
	assert len(rows) == n, "need active Karen Roses employees"
	return [r.name for r in rows]


def _product(toxicity):
	cond = "toxicity = %(t)s" if toxicity else "IFNULL(toxicity, '') = ''"
	row = frappe.db.sql(
		f"""SELECT name, product_name FROM `tabSpray Product`
		     WHERE {cond} AND IFNULL(product_name, '') != '' ORDER BY name LIMIT 1""",
		{"t": toxicity},
		as_dict=True,
	)
	return row[0]


class _Base(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		crop_scope.clear_cache()

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")
		crop_scope.clear_cache()


class TestSync(_Base):
	def test_idempotent(self):
		emps = _employees(3)
		frappe.db.delete("Sprayer", {"employee": ["in", emps]})
		# Put them on a logsheet-free footing: a team makes them sprayers.
		team = frappe.get_doc({
			"doctype": "Spray Team", "team_name": "_TEST SPRAYER TEAM", "enabled": 1,
			"team": [{"name1": e, "role": "Sprayer"} for e in emps],
		}).insert(ignore_permissions=True)
		first = register.sync_sprayers(emps)
		self.assertEqual(frappe.db.count("Sprayer", {"employee": ["in", emps]}), 3)
		again = register.sync_sprayers(emps)
		self.assertEqual(again["created"], 0)
		self.assertEqual(again["updated"], 0)
		self.assertGreaterEqual(first["total"], 3)
		self.assertEqual(
			set(frappe.get_all("Sprayer", filters={"employee": ["in", emps]}, pluck="spray_team")),
			{team.name},
		)

	def test_team_save_hook_syncs_and_clears_removed(self):
		emps = _employees(2)
		frappe.db.delete("Sprayer", {"employee": ["in", emps]})
		team = frappe.get_doc({
			"doctype": "Spray Team", "team_name": "_TEST SPRAYER TEAM", "enabled": 1,
			"team": [{"name1": e, "role": "Pump Operator"} for e in emps],
		}).insert(ignore_permissions=True)
		team.save(ignore_permissions=True)  # on_update fires on insert too; save is a re-run
		self.assertEqual(
			frappe.db.get_value("Sprayer", {"employee": emps[0]}, "role"), "Pump Operator"
		)
		team.set("team", [{"name1": emps[1], "role": "Sprayer"}])
		team.save(ignore_permissions=True)
		other_team = frappe.get_all(
			"Spray Team Details", filters={"name1": emps[0], "parenttype": "Spray Team"}, pluck="parent"
		)
		got = frappe.db.get_value("Sprayer", {"employee": emps[0]}, "spray_team")
		self.assertEqual(got, other_team[0] if other_team else None)

	def test_unique_employee(self):
		emp = _employees(1)[0]
		frappe.db.delete("Sprayer", {"employee": emp})
		frappe.get_doc({"doctype": "Sprayer", "employee": emp}).insert(ignore_permissions=True)
		with self.assertRaises((frappe.UniqueValidationError, frappe.DuplicateEntryError)):
			frappe.get_doc({"doctype": "Sprayer", "employee": emp}).insert(ignore_permissions=True)

	def test_inactive_employee_goes_inactive(self):
		emp = _employees(1)[0]
		frappe.db.delete("Sprayer", {"employee": emp})
		frappe.get_doc({
			"doctype": "Spray Team", "team_name": "_TEST SPRAYER TEAM", "enabled": 1,
			"team": [{"name1": emp, "role": "Sprayer"}],
		}).insert(ignore_permissions=True)
		self.assertEqual(frappe.db.get_value("Sprayer", {"employee": emp}, "status"), "Active")
		frappe.db.set_value("Employee", emp, "status", "Left", update_modified=False)
		register.sync_sprayers([emp])
		self.assertEqual(frappe.db.get_value("Sprayer", {"employee": emp}, "status"), "Inactive")


class TestExposure(_Base):
	def _sal(self, emps, products, **kw):
		doc = frappe.get_doc({
			"doctype": SAL,
			"date": "2026-10-01",
			"farm": "Chepsito",
			"crop": frappe.db.get_value(SAL, {"docstatus": 1}, "crop"),
			"weather": "Cool",
			"application_start_time": "08:00:00",
			"application_stop_time": "09:30:00",
			"persons_mixing_1": emps[2],
			"supervisor_name": emps[3],
			"applicators": [
				{"applicator_name": emps[0], "condition_of_ppe": "Good"},
				{"applicator_name": emps[1], "condition_of_ppe": "Poor"},
			],
			"pesticides": [{"pesticide_name": p} for p in products],
			**kw,
		})
		doc.insert(ignore_permissions=True)
		doc.submit()
		return doc

	def test_submit_writes_everyone_times_every_product_and_cancel_deletes(self):
		emps = _employees(4)
		known, unknown = _product("I"), _product(None)
		sal = self._sal(emps, [known.product_name, unknown.product_name, known.product_name])
		rows = frappe.get_all(
			"Sprayer Exposure", filters={"spray_application_logsheet": sal.name},
			fields=["employee", "role", "spray_product", "hours", "weighted_hours", "hazard_weight", "flags", "sprayer", "ppe_condition"],
		)
		self.assertEqual(len(rows), 4 * 2)
		roles = {r.employee: r.role for r in rows}
		self.assertEqual(roles[emps[0]], "Sprayer")
		self.assertEqual(roles[emps[2]], "Mixer")
		self.assertEqual(roles[emps[3]], "Supervisor")
		for r in rows:
			self.assertEqual(r.hours, 1.5)
			self.assertTrue(r.sprayer)
			if r.spray_product == known.name:
				self.assertEqual(r.hazard_weight, 4)
				self.assertEqual(r.weighted_hours, 6.0)
			else:
				self.assertEqual(r.hazard_weight, R.UNKNOWN_HAZARD_WEIGHT)
				self.assertIn(R.FLAG_HAZARD_UNKNOWN, r.flags)
		self.assertEqual({r.ppe_condition for r in rows if r.employee == emps[1]}, {"Poor"})

		# Totals land on the Sprayer.
		sp = frappe.db.get_value("Sprayer", {"employee": emps[0]}, ["name", "hours_total", "weighted_total"], as_dict=True)
		expect = frappe.db.sql(
			"SELECT SUM(hours), SUM(weighted_hours) FROM `tabSprayer Exposure` WHERE sprayer=%s", sp.name
		)[0]
		self.assertAlmostEqual(sp.hours_total, float(expect[0]), places=3)
		self.assertAlmostEqual(sp.weighted_total, float(expect[1]), places=3)

		# Rebuild is idempotent.
		exposure.rebuild(sal.name)
		self.assertEqual(frappe.db.count("Sprayer Exposure", {"spray_application_logsheet": sal.name}), 8)

		sal.reload()
		sal.cancel()
		self.assertEqual(frappe.db.count("Sprayer Exposure", {"spray_application_logsheet": sal.name}), 0)
		after = frappe.db.get_value("Sprayer", sp.name, "hours_total")
		self.assertAlmostEqual(after, sp.hours_total - 3.0, places=3)  # 2 products × 1.5 h

	def test_no_duration_flag(self):
		emps = _employees(4)
		sal = self._sal(emps, [_product("I").product_name], application_stop_time="08:00:00")
		flags = frappe.get_all("Sprayer Exposure", filters={"spray_application_logsheet": sal.name}, pluck="flags")
		self.assertTrue(flags and all(R.FLAG_NO_DURATION in f for f in flags))


class TestPermissions(_Base):
	def _unrostered_supervisor(self):
		row = frappe.db.sql(
			"""SELECT u.name FROM tabUser u
			     JOIN `tabHas Role` r ON r.parent = u.name AND r.role = 'SCP Spray Supervisor'
			    WHERE u.enabled = 1
			      AND u.name NOT IN (SELECT parent FROM `tabHas Role`
			                          WHERE role IN ('SCP General Manager', 'System Manager'))
			      AND u.name NOT IN (SELECT IFNULL(user, '') FROM `tabFarm Spray Supervisor`)
			    LIMIT 1"""
		)
		if not row:
			self.skipTest("no unrostered supervisor on this site")
		return row[0][0]

	def test_unrostered_supervisor_cannot_edit_a_farm_team(self):
		team = frappe.get_doc({
			"doctype": "Spray Team", "team_name": "_TEST SPRAYER TEAM", "enabled": 1,
			"custom_farm": "Chepsito", "team": [],
		}).insert(ignore_permissions=True)
		frappe.set_user(self._unrostered_supervisor())
		crop_scope.clear_cache()
		self.assertEqual(api.get_spray_teams(), [])
		with self.assertRaises(frappe.PermissionError):
			api.save_spray_team(team.name, members="[]")
		with self.assertRaises(frappe.PermissionError):
			api.search_employees("Chepsito", "")

	def test_role_less_user_is_refused(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			api.get_sprayers()

	def test_manager_sees_team_and_can_save(self):
		emps = _employees(2)
		team = frappe.get_doc({
			"doctype": "Spray Team", "team_name": "_TEST SPRAYER TEAM", "enabled": 1,
			"custom_farm": "Chepsito", "team": [],
		}).insert(ignore_permissions=True)
		out = api.save_spray_team(
			team.name, members=frappe.as_json([{"employee": e, "role": "Sprayer"} for e in emps]), enabled=0
		)
		self.assertEqual(out["enabled"], 0)
		self.assertEqual([m["employee"] for m in out["members"]], emps)
		self.assertTrue(all(m["sprayer"] for m in out["members"]))
