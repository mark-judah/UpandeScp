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


class TestApprovalReview(_Base):
	def test_codes_come_from_spray_product(self):
		from upande_scp.serverscripts.spray_plan_creator import approval_review as AR
		row = frappe.db.sql("""select parent, code from `tabIRAC Code Filter` where parenttype='Spray Product'
		                       and parentfield='irac' and ifnull(code,'')!='' limit 1""")
		if not row:
			self.skipTest("no Spray Product IRAC rows on this site")
		self.assertIn(row[0][1], AR._get_item_codes(row[0][0], AR._IRAC_CHILD_TABLE, "irac", "code"))
