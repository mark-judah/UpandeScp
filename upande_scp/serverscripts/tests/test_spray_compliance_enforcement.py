"""Enforcement on kaitet.local. DB test — direct runner. Everything it writes is
rolled back by the runner (frappe.db.rollback) and by tearDown."""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_compliance import api
from upande_scp.serverscripts.spray_compliance import context as C
from upande_scp.serverscripts.spray_compliance import engine as E

S = "Scouting and Crop Protection Settings"


def _set_mode(rule, mode):
	frappe.db.set_single_value(S, f"rule_{rule}", mode)


class _Base(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self._modes = {r: frappe.db.get_single_value(S, f"rule_{r}") for r in E.RULES}
		for r in E.RULES:
			_set_mode(r, "Off")

	def tearDown(self):
		frappe.set_user("Administrator")
		for r, m in self._modes.items():
			_set_mode(r, m or "Warn")
		frappe.db.rollback()


def _payload(items, targets=("Thrips",)):
	return {"custom_greenhouse": "Nowhere", "custom_targets": list(targets),
	        "chemicals": [{"item_code": i} for i in items]}


class _WO:
	"""Minimal stand-in for the WO fields enforce_on_save writes."""
	def __init__(self):
		self.custom_compliance_status = None
		self.rows = []

	def set(self, field, rows):
		self.rows = rows


class TestSave(_Base):
	def test_warn_saves_and_marks_warnings(self):
		_set_mode("target_coverage", "Warn")
		wo = _WO()
		r = api.enforce_on_save(_payload([]), wo)
		self.assertEqual(wo.custom_compliance_status, "Warnings")
		self.assertFalse(r["blocking"])

	def test_hard_block_throws(self):
		_set_mode("target_coverage", "Block")
		with self.assertRaises(frappe.ValidationError):
			api.enforce_on_save(_payload([]), _WO())

	def test_gm_override_is_stored(self):
		_set_mode("target_coverage", "Block (GM override)")
		key = api.result_for_payload(_payload([]))["violations"][0]["key"]
		p = _payload([]) | {"spray_rule_overrides": [{"key": key, "rule": "target_coverage", "reason": "Outbreak"}]}
		wo = _WO()
		api.enforce_on_save(p, wo)
		self.assertEqual(wo.custom_compliance_status, "Overridden")
		self.assertEqual(wo.rows[0]["subject"], key)
		self.assertEqual(wo.rows[0]["overridden_by"], "Administrator")
		self.assertEqual(wo.rows[0]["reason"], "Outbreak")

	def test_blank_reason_override_is_not_stored(self):
		_set_mode("target_coverage", "Block (GM override)")
		key = api.result_for_payload(_payload([]))["violations"][0]["key"]
		p = _payload([]) | {"spray_rule_overrides": [{"key": key, "rule": "target_coverage", "reason": "  "}]}
		wo = _WO()
		api.enforce_on_save(p, wo)
		self.assertEqual(wo.custom_compliance_status, "Awaiting Override")
		self.assertEqual(wo.rows, [])

	def test_non_gm_override_is_ignored_and_draft_awaits(self):
		_set_mode("target_coverage", "Block (GM override)")
		key = api.result_for_payload(_payload([]))["violations"][0]["key"]
		p = _payload([]) | {"spray_rule_overrides": [{"key": key, "rule": "target_coverage", "reason": "x"}]}
		wo = _WO()
		with mock.patch.object(api, "can_override", return_value=False):
			api.enforce_on_save(p, wo)
		self.assertEqual(wo.custom_compliance_status, "Awaiting Override")
		self.assertEqual(wo.rows, [])


class TestApproval(_Base):
	def _wo(self, targets="Thrips", items=()):
		wo = frappe.new_doc("Work Order")
		wo.custom_greenhouse = "Nowhere"
		wo.custom_targets = targets
		wo.name = "TEST-WO-NOT-SAVED"
		for i in items:
			wo.append("required_items", {"item_code": i})
		return wo

	def _key(self, wo):
		return E.check_mix(C.context_for_wo(wo))["violations"][0]["key"]

	def test_blocked_plan_is_refused(self):
		_set_mode("target_coverage", "Block")
		self.assertIn("Thrips", api.enforce_on_approval(self._wo())["reason"])

	def test_awaiting_override_is_refused_until_overridden(self):
		_set_mode("target_coverage", "Block (GM override)")
		wo = self._wo()
		self.assertIsNotNone(api.enforce_on_approval(wo))
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": self._key(wo),
		                                          "reason": "ok", "overridden_by": "Administrator"})
		self.assertIsNone(api.enforce_on_approval(wo))

	def test_override_written_by_a_non_gm_does_not_unlock_approval(self):
		_set_mode("target_coverage", "Block (GM override)")
		wo = self._wo()
		key = self._key(wo)
		# Rows a non-GM could write straight onto the WO: wrong author, no author, blank reason.
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": key,
		                                          "reason": "ok", "overridden_by": "Guest"})
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": key, "reason": "ok"})
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": key,
		                                          "reason": " ", "overridden_by": "Administrator"})
		self.assertIsNotNone(api.enforce_on_approval(wo))

	def test_warn_only_is_approvable(self):
		_set_mode("target_coverage", "Warn")
		self.assertIsNone(api.enforce_on_approval(self._wo()))


class TestBulk(_Base):
	def test_bulk_skips_only_the_blocked_plan(self):
		from upande_scp.serverscripts.spray_plan_creator import bulk
		calls = []
		with mock.patch.object(bulk, "create_transfer_stock_entry", side_effect=lambda n: calls.append(n)), \
		     mock.patch.object(bulk, "_compliance_block", side_effect=lambda n: {"reason": "blocked"} if n == "B" else None), \
		     mock.patch.object(bulk.frappe.db, "sql", return_value=[frappe._dict(name="X", docstatus=1, workflow_state="Awaiting Approval")]), \
		     mock.patch.object(bulk.frappe, "get_doc", side_effect=frappe.DoesNotExistError), \
		     mock.patch.object(bulk.frappe.db, "commit"):
			r = bulk.approve_drafts_bulk(["A", "B", "C"])
		self.assertEqual(r["approved"], ["A", "C"])
		self.assertEqual([s["name"] for s in r["skipped"] if "blocked" in s["reason"]], ["B"])
		self.assertEqual(calls, ["A", "C"])

	def test_bulk_skips_a_plan_whose_check_cannot_run(self):
		from upande_scp.serverscripts.spray_plan_creator import bulk
		calls = []

		def check(n):
			if n == "B":
				raise RuntimeError("boom")

		with mock.patch.object(bulk, "create_transfer_stock_entry", side_effect=lambda n: calls.append(n)), \
		     mock.patch.object(bulk, "_compliance_block", side_effect=check), \
		     mock.patch.object(bulk.frappe.db, "sql", return_value=[frappe._dict(name="X", docstatus=1, workflow_state="Awaiting Approval")]), \
		     mock.patch.object(bulk.frappe, "get_doc", side_effect=frappe.DoesNotExistError), \
		     mock.patch.object(bulk.frappe, "log_error") as log, \
		     mock.patch.object(bulk.frappe.db, "commit"):
			r = bulk.approve_drafts_bulk(["A", "B", "C"])
		self.assertEqual(r["approved"], ["A", "C"])
		self.assertEqual(r["skipped"], [{"name": "B", "reason": "spray check could not run"}])
		self.assertEqual(calls, ["A", "C"])
		log.assert_called_once()


NO_TARGET = "ZZ Spray Check Test Target"


def _real_plan(state):
	"""An existing spray plan in `state`, retargeted at a pest nothing covers (rolled back)."""
	name = frappe.db.get_value("Work Order", {"custom_type": "Application Floor Plan", "workflow_state": state,
	                                          "docstatus": ("<", 2)}, "name")
	if not name:
		raise unittest.SkipTest(f"no spray plan in {state} on this site")
	frappe.db.set_value("Work Order", name, {"custom_targets": NO_TARGET, "custom_compliance_status": ""},
	                    update_modified=False)
	frappe.db.delete("Spray Rule Override", {"parent": name, "parenttype": "Work Order"})
	return name


class TestApprovalReview(_Base):
	def test_codes_are_ingredient_and_hand_entered(self):
		from upande_scp.serverscripts.spray_plan_creator import approval_review as AR
		# Link a plan product's ingredient row to an ingredient carrying an IRAC
		# code that is not hand-entered on it (all rolled back): the review must show it.
		row = frappe.db.sql("""select wi.parent, wi.item_code, ai.name from `tabWork Order Item` wi
		    join `tabWork Order` wo on wo.name=wi.parent and wo.custom_type='Application Floor Plan'
		    join `tabActive Ingredient` ai on ai.parent=wi.item_code and ai.parenttype='Spray Product'
		    order by wo.creation desc limit 1""")
		if not row:
			self.skipTest("no plan product with an ingredient row on this site")
		wo, item, ai_row = row[0]
		code = next(c for c in frappe.get_all("IRAC Code", pluck="name")
		            if c not in (C.load_products([item]).get(item) or {}).get("irac", []))
		frappe.get_doc({"doctype": "Active Ingredient MoA", "name": "ZZ Test Ingredient",
		                "ingredient": "ZZ Test Ingredient", "irac_code": code}).db_insert()
		frappe.db.set_value("Active Ingredient", ai_row, "active_ingredient", "ZZ Test Ingredient",
		                    update_modified=False)
		p = C.load_products([item])[item]
		self.assertIn(code, p["irac"])
		chem = next(c for c in AR.get_approval_review(wo)["chemicals"] if c["item_code"] == item)
		self.assertEqual((chem["irac_codes"], chem["frac_codes"]), (p["irac"], p["frac"]))

	def test_review_marks_unhonoured_overrides(self):
		from upande_scp.serverscripts.spray_plan_creator import approval_review as AR
		wo = frappe.new_doc("Work Order")
		wo.custom_greenhouse, wo.custom_targets, wo.name = "Nowhere", "Thrips", "TEST-WO-NOT-SAVED"
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": "k", "reason": "ok",
		                                          "overridden_by": "Administrator"})
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": "k", "reason": "ok",
		                                          "overridden_by": "Guest"})
		self.assertEqual([o["honoured"] for o in AR._compliance(wo)["overrides"]], [True, False])

	def test_review_says_whether_the_viewer_can_override(self):
		from upande_scp.serverscripts.spray_plan_creator import approval_review as AR
		wo = frappe.new_doc("Work Order")
		wo.custom_greenhouse, wo.custom_targets, wo.name = "Nowhere", "Thrips", "TEST-WO-NOT-SAVED"
		self.assertTrue(AR._compliance(wo)["can_override"])
		frappe.set_user("Guest")
		self.assertFalse(AR._compliance(wo)["can_override"])


class TestOverrideEndpoint(_Base):
	def setUp(self):
		super().setUp()
		_set_mode("target_coverage", "Block (GM override)")
		self.name = _real_plan("Awaiting Approval")

	def _key(self):
		return E.check_mix(C.context_for_wo(frappe.get_doc("Work Order", self.name)))["violations"][0]["key"]

	def test_gm_override_unlocks_approval(self):
		wo = frappe.get_doc("Work Order", self.name)
		self.assertIsNotNone(api.enforce_on_approval(wo))
		r = api.override_spray_plan(self.name, [{"rule": "target_coverage", "key": self._key(), "reason": "Outbreak"}])
		self.assertEqual(r["status"], "Overridden")
		wo = frappe.get_doc("Work Order", self.name)
		self.assertEqual(wo.custom_compliance_status, "Overridden")
		self.assertEqual([(o.subject, o.reason, o.overridden_by) for o in wo.custom_spray_rule_overrides],
		                 [(self._key(), "Outbreak", "Administrator")])
		self.assertIsNone(api.enforce_on_approval(wo))

	def test_unknown_key_is_not_stored(self):
		api.override_spray_plan(self.name, [{"rule": "target_coverage", "key": "no-such-violation", "reason": "x"}])
		self.assertEqual(frappe.get_doc("Work Order", self.name).custom_spray_rule_overrides, [])

	def test_non_gm_is_refused(self):
		with mock.patch.object(api, "can_override", return_value=False), self.assertRaises(frappe.PermissionError):
			api.override_spray_plan(self.name, [{"rule": "target_coverage", "key": self._key(), "reason": "x"}])

	def test_blank_reason_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			api.override_spray_plan(self.name, [{"rule": "target_coverage", "key": self._key(), "reason": "  "}])

	def test_approved_plan_is_refused(self):
		name = _real_plan("Approved")
		with self.assertRaises(frappe.ValidationError):
			api.override_spray_plan(name, [{"rule": "target_coverage", "key": "k", "reason": "x"}])


class TestStampHook(_Base):
	def test_hook_is_registered(self):
		path = "upande_scp.serverscripts.spray_compliance.api.stamp_overrides"
		self.assertIn(path, frappe.get_hooks("doc_events")["Work Order"]["validate"])

	def test_new_row_is_signed_by_the_saver(self):
		wo = frappe.get_doc("Work Order", _real_plan("Pending Submission"))
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": "k", "reason": "x",
		                                          "overridden_by": "Administrator"})
		frappe.set_user("Guest")
		api.stamp_overrides(wo)
		self.assertEqual(wo.custom_spray_rule_overrides[0].overridden_by, "Guest")
		self.assertFalse(api.override_counts(wo.custom_spray_rule_overrides[0]))

	def test_unchanged_row_keeps_its_stored_signature(self):
		name = _real_plan("Pending Submission")
		frappe.get_doc({"doctype": "Spray Rule Override", "parent": name, "parenttype": "Work Order",
		                "parentfield": "custom_spray_rule_overrides", "idx": 1, "rule": "target_coverage",
		                "subject": "k", "reason": "x", "overridden_by": "Administrator",
		                "overridden_on": "2026-10-01 08:00:00"}).db_insert()
		wo = frappe.get_doc("Work Order", name)
		wo.custom_spray_rule_overrides[0].overridden_by = "Guest"  # forged in the payload
		frappe.set_user("Guest")
		api.stamp_overrides(wo)
		self.assertEqual(wo.custom_spray_rule_overrides[0].overridden_by, "Administrator")
		wo.custom_spray_rule_overrides[0].reason = "changed"
		api.stamp_overrides(wo)
		self.assertEqual(wo.custom_spray_rule_overrides[0].overridden_by, "Guest")

	def test_other_work_orders_are_left_alone(self):
		wo = frappe.new_doc("Work Order")
		wo.custom_type = "Manufacture"
		wo.append("custom_spray_rule_overrides", {"subject": "k", "reason": "x", "overridden_by": "Administrator"})
		frappe.set_user("Guest")
		api.stamp_overrides(wo)
		self.assertEqual(wo.custom_spray_rule_overrides[0].overridden_by, "Administrator")


class TestDraftWiring(_Base):
	"""create/update_draft_plan with every write patched out: the check runs
	before the BOM is minted and before the WO is written."""

	def _patches(self):
		from upande_scp.serverscripts.spray_plan_creator import bom_resolver, drafts as D
		self.D = D
		self.bom = frappe.db.get_value("BOM", {"docstatus": 1, "is_active": 1}, ["name", "company"], as_dict=True)
		self.mint = mock.Mock(return_value=None)
		self.write = mock.Mock()
		return [
			mock.patch.object(D, "_require_creator", return_value="Administrator"),
			mock.patch.object(D, "_resolve_user_scope", return_value={"farms": ["x"]}),
			mock.patch.object(D, "_assert_in_scope"), mock.patch.object(D, "_validate_payload"),
			mock.patch.object(D, "_derive_plan_company", return_value=self.bom.company),
			mock.patch.object(D, "_resolve_cost_center_with_override", return_value=None),
			mock.patch.object(D, "_assert_same_company"),
			mock.patch.object(D, "_resolve_kit_warehouse", return_value=None),
			mock.patch.object(bom_resolver, "create_bom_for_plan", self.mint),
			mock.patch("frappe.model.document.Document.insert", self.write),
			mock.patch("frappe.model.document.Document.save", self.write),
		]

	def _run(self, fn):
		from contextlib import ExitStack
		with ExitStack() as st:
			for p in self._patches():
				st.enter_context(p)
			return fn()

	def _payload(self):
		return {"custom_greenhouse": "Nowhere", "custom_targets": ["Thrips"], "chemicals": [],
		        "production_item": self.bom.name}

	def _draft(self):
		wo = frappe.new_doc("Work Order")
		wo.name, wo.custom_type, wo.company = "TEST-WO-NOT-SAVED", "Application Floor Plan", self.bom.company
		wo.workflow_state = "Pending Submission"
		return wo

	def test_create_hard_block_writes_nothing(self):
		_set_mode("target_coverage", "Block")
		with self.assertRaises(frappe.ValidationError):
			self._run(lambda: self.D.create_draft_spray_plan(self._payload()))
		self.mint.assert_not_called()
		self.write.assert_not_called()

	def test_create_returns_compliance(self):
		r = self._run(lambda: self.D.create_draft_spray_plan(self._payload()))
		self.assertEqual(r["compliance"]["status"], "Clean")
		self.mint.assert_called_once()
		self.write.assert_called_once()

	def test_update_hard_block_writes_nothing(self):
		_set_mode("target_coverage", "Block")

		def go():
			with mock.patch.object(self.D, "_own_draft", return_value=self._draft()):
				return self.D.update_draft_plan("TEST-WO-NOT-SAVED", self._payload())
		with self.assertRaises(frappe.ValidationError):
			self._run(go)
		self.mint.assert_not_called()
		self.write.assert_not_called()

	def test_update_returns_compliance(self):
		_set_mode("target_coverage", "Warn")

		def go():
			with mock.patch.object(self.D, "_own_draft", return_value=self._draft()):
				return self.D.update_draft_plan("TEST-WO-NOT-SAVED", self._payload())
		r = self._run(go)
		self.assertEqual(r["compliance"]["status"], "Warnings")
		self.write.assert_called_once()
