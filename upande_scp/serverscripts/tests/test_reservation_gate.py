"""enforce_stock_gate on AFP validate: stock and reservations are patched in."""
import unittest
from types import SimpleNamespace
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_plan_creator import reservations as R


def _doc(qty, batch=None, name="WO-NEW"):
	row = SimpleNamespace(item_code="I", source_warehouse="W", required_qty=qty,
		get=lambda k, d=None: batch if k == "custom_batch_no" else d)
	d = mock.MagicMock()
	d.get.side_effect = lambda k, dflt=None: {"custom_type": R.AFP, "required_items": [row],
		"workflow_state": "Pending Submission", "status": "Draft"}.get(k, dflt)
	d.docstatus = 0
	d.name = name
	d.is_new.return_value = False
	return d


class TestGate(unittest.TestCase):
	def _run(self, doc, ledger, rows, batches=None):
		with mock.patch.object(R, "_ledger", return_value=ledger), \
			mock.patch.object(R, "_reservation_rows", return_value=rows), \
			mock.patch("frappe.get_all", return_value=[frappe._dict(name="I")]), \
			mock.patch("upande_scp.serverscripts.store.batch_stock.available_in_store",
				return_value=batches or {}):
			R.enforce_stock_gate(doc)

	def test_passes_when_covered(self):
		self._run(_doc(5), {"I": 10.0}, [])

	def test_refuses_and_names_reserving_plan(self):
		rows = [{"wo": "WO-OTHER", "required_qty": 8, "item_code": "I", "batch_no": None}]
		with self.assertRaises(frappe.ValidationError) as c:
			self._run(_doc(5), {"I": 10.0}, rows)
		self.assertIn("WO-OTHER", str(c.exception))

	def test_batch_level(self):
		with self.assertRaises(frappe.ValidationError):
			self._run(_doc(5, "B1"), {"I": 100.0}, [],
				{("I", "W"): [{"batch_no": "B1", "qty": 3.0}]})

	def test_skips_issued(self):
		d = _doc(500)
		d.get.side_effect = lambda k, dflt=None: {"custom_type": R.AFP,
			"workflow_state": "Chemical Issued"}.get(k, dflt)
		self._run(d, {}, [])
