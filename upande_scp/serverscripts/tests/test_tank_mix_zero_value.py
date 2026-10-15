"""A tank mix whose consumed batch was received at zero cost still posts.

Plan MFG-WO-2026-05599: the chemical's batch was received at no cost, the transfer into
the CSU carried a zero rate, and the Manufacture refused ("Valuation Rate for the Item
... is required") so the sprayer could not make the mix. Cost data must not stop a spray:
the rows are flagged ``allow_zero_valuation_rate``, no price is invented, and the plan
carries a comment saying the mix went in at zero value. A normally valued batch is left
exactly as it was. Refusals reach the app as plain text and are written to the Error Log
once per plan + message per 10 minutes.
"""

import unittest

import frappe
from frappe.utils import add_to_date

from upande_scp.serverscripts.spray_plan_creator import refusals as R
from upande_scp.serverscripts.spray_plan_creator import spray_session as SS
from upande_scp.serverscripts.tests.test_tank_mix_batch_resolution import LedgerCase


class TestZeroValuedBatch(LedgerCase):
	"""Valuation is never waived: a zero-valued batch is refused, plainly."""

	def _zero_receipt(self, item, batch, qty, days_ago):
		doc = frappe.get_doc({
			"doctype": "Stock Entry", "stock_entry_type": "Material Receipt",
			"purpose": "Material Receipt", "company": self.company,
			"set_posting_time": 1,
			"posting_date": add_to_date(self.t0, days=-days_ago).date(),
			"posting_time": add_to_date(self.t0, days=-days_ago).time(),
			"items": [{"item_code": item, "qty": qty, "t_warehouse": self.store,
			           "batch_no": batch, "use_serial_batch_fields": 1,
			           "basic_rate": 0, "allow_zero_valuation_rate": 1}],
		})
		doc.flags.ignore_permissions = True
		doc.insert()
		doc.submit()

	def test_manufacture_refuses_a_zero_valued_batch_in_plain_text(self):
		item = self.item()
		b = self.batch(item, "FREE")
		frappe.db.set_value("Batch", b, "use_batchwise_valuation", 1)
		self._zero_receipt(item, b, 2, days_ago=6)
		self.plan(self.wo1, {item: 0.46})
		self.transfer(self.wo1, item, b, 0.46, days_ago=5)
		with self.assertRaises(frappe.ValidationError) as cm:
			self.manufacture(self.wo1)
		msg = str(cm.exception)
		self.assertIn(f"Tank mix can't be posted: batch {b} of {item} was issued with no valuation rate", msg)
		self.assertIn("confirm the mix again", msg)
		self.assertNotIn("<", msg)
		self.assertEqual(frappe.db.count("Stock Entry", {"work_order": self.wo1, "purpose": "Manufacture", "docstatus": 1}), 0)

	def test_a_valued_batch_is_unchanged(self):
		item = self.item()
		b = self.batch(item, "PAID")
		self.receive(item, b, 2, days_ago=6)
		self.plan(self.wo1, {item: 0.5})
		self.transfer(self.wo1, item, b, 0.5, days_ago=5)
		se = self.manufacture(self.wo1)
		self.assertEqual(se.docstatus, 1)
		self.assertFalse(any(r.allow_zero_valuation_rate for r in se.items))


class TestNothingWaivesValuation(unittest.TestCase):
	def test_no_allow_zero_valuation_rate_assignment_in_spray_or_store_code(self):
		import pathlib, re
		root = pathlib.Path(__file__).resolve().parents[1]
		pat = re.compile(r"allow_zero_valuation_rate[\"']?\s*(=|:)\s*1")
		hits = []
		for d in ("spray_plan_creator", "store", "spray_plan_ops"):
			for f in (root / d).glob("*.py"):
				for n, line in enumerate(f.read_text().splitlines(), 1):
					if pat.search(line) and not line.lstrip().startswith(("#", "*")):
						hits.append(f"{f.name}:{n}")
		self.assertEqual(hits, [])


class TestRefusals(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def test_plain_text(self):
		html = '<ul><li>Row <a href="/x">1</a></li><li>needs &amp; more</li></ul>'
		self.assertEqual(R.plain_text(html), "Row 1\nneeds & more")

	def test_a_refusal_is_plain_logged_once(self):
		wo = "TEST-WO-REFUSAL-" + frappe.generate_hash(length=6)

		@R.log_refusals("manufacture_tank_mix")
		def refuse(work_order):
			frappe.throw('Cannot: <a href="/app/item/th">th</a> <li>needs rate</li>')

		before = frappe.db.count("Error Log", {"method": R.TITLE})
		for _ in range(3):
			with self.assertRaises(frappe.ValidationError) as cm:
				refuse(work_order=wo)
			self.assertNotIn("<", str(cm.exception))
		self.assertNotIn("<", frappe.local.message_log[-1] if isinstance(frappe.local.message_log[-1], str) else str(frappe.local.message_log[-1]).replace("{", ""))
		rows = frappe.get_all("Error Log", filters={"method": R.TITLE, "reference_name": wo},
		                      fields=["error"])
		self.assertEqual(len(rows), 1)
		self.assertIn(wo, rows[0].error)
		self.assertIn("Administrator", rows[0].error)
		self.assertIn("Cannot: th", rows[0].error)
		self.assertGreaterEqual(frappe.db.count("Error Log", {"method": R.TITLE}), before + 1)
		frappe.db.rollback()


# ───────────── prevention at the source: the store and the floor plan ─────────────

from upande_scp.serverscripts.spray_plan_creator import reservations as RES
from upande_scp.serverscripts.store import batch_suggestion as BS
from upande_scp.serverscripts.store import store_keeper_api as SK
from upande_scp.serverscripts.store import transfer_stock_gate as GATE
from upande_scp.serverscripts.store.batch_stock import available_in_store, zero_valued_batches


class TestEffectiveValuation(unittest.TestCase):
	def ev(self, **kw):
		from upande_scp.serverscripts.store.batch_stock import effective_valuation as f
		base = dict(batchwise=True, qty_net=5, value_net=0, qty_in=5, value_in=0, avg_rate=0)
		base.update(kw)
		return f(**base)

	def test_batchwise_zero_is_blocked(self):
		self.assertTrue(self.ev(batchwise=True, avg_rate=250)["invalid"])
		self.assertEqual(self.ev(batchwise=True)["method"], "batchwise")

	def test_batchwise_negative_is_blocked(self):
		self.assertTrue(self.ev(batchwise=True, value_net=-2178)["invalid"])

	def test_batchwise_valued_is_allowed(self):
		self.assertFalse(self.ev(batchwise=True, value_net=50)["invalid"])

	def test_non_batchwise_uses_the_item_average_not_the_batch_value(self):
		r = self.ev(batchwise=False, value_net=0, avg_rate=178)
		self.assertFalse(r["invalid"])
		self.assertEqual(r["method"], "moving_average")
		self.assertEqual(r["rate"], 178)

	def test_non_batchwise_blocked_only_when_the_average_is_not_positive(self):
		self.assertTrue(self.ev(batchwise=False, value_net=999, avg_rate=0)["invalid"])
		self.assertTrue(self.ev(batchwise=False, avg_rate=-1)["invalid"])

	def test_a_drawn_down_batchwise_batch_is_judged_by_what_it_came_in_at(self):
		self.assertTrue(self.ev(qty_net=0, value_net=0, qty_in=5, value_in=0)["invalid"])
		self.assertFalse(self.ev(qty_net=0, value_net=0, qty_in=5, value_in=40)["invalid"])


class TestPureRules(unittest.TestCase):
	POOL = [
		{"batch_no": "FREE", "qty": 5, "expiry_date": None, "created": "2026-01-01", "zero_valued": True},
		{"batch_no": "PAID", "qty": 5, "expiry_date": None, "created": "2026-02-01"},
	]

	def test_a_zero_valued_batch_is_never_suggested(self):
		plan = BS.allocate(1, self.POOL, "2026-10-15")
		self.assertEqual([p["batch_no"] for p in plan["picks"]], ["PAID"])
		self.assertEqual([b["batch_no"] for b in BS.rank_batches(self.POOL, "2026-10-15")], ["PAID"])

	def test_even_a_hand_preferred_zero_valued_batch_is_not_used(self):
		plan = BS.allocate(1, self.POOL, "2026-10-15", prefer="FREE")
		self.assertEqual([p["batch_no"] for p in plan["picks"]], ["PAID"])

	def test_it_is_described_as_unvalued(self):
		d = BS.describe(self.POOL[0], "2026-10-15")
		self.assertEqual(d["status"], "unvalued")
		self.assertTrue(d["zero_valued"])

	def test_the_gate_refuses_the_row_with_the_plain_message(self):
		rows = [{"transfer": "T1", "item_code": "I", "warehouse": "S", "qty": 1, "batch_no": "FREE"}]
		out = GATE.evaluate(rows, {("I", "S"): 5}, {("I", "S", "FREE"): 5}, {"I"},
		                    unvalued={("I", "S", "FREE")})
		self.assertFalse(out["T1"]["ok"])
		msg = GATE.short_message(out["T1"]["shorts"])
		self.assertEqual(
			msg,
			"I batch FREE in S has no valuation rate (0). Correct its valuation (e.g. a Stock "
			"Reconciliation or the purchase receipt rate) before issuing it.",
		)

	def test_a_valued_row_passes(self):
		rows = [{"transfer": "T1", "item_code": "I", "warehouse": "S", "qty": 1, "batch_no": "PAID"}]
		out = GATE.evaluate(rows, {("I", "S"): 5}, {("I", "S", "PAID"): 5}, {"I"},
		                    unvalued={("I", "S", "FREE")})
		self.assertTrue(out["T1"]["ok"])


class TestStoreSide(TestZeroValuedBatch):
	def _setup_batches(self):
		item = self.item()
		free, paid = self.batch(item, "FREE"), self.batch(item, "PAID")
		for b in (free, paid):
			frappe.db.set_value("Batch", b, "use_batchwise_valuation", 1)
		self._zero_receipt(item, free, 3, days_ago=8)
		self.receive(item, paid, 3, days_ago=7)
		return item, free, paid

	def _draft(self, item, batch=None):
		row = {"item_code": item, "qty": 0.5, "s_warehouse": self.store,
		       "t_warehouse": self.csu, "basic_rate": 10}
		if batch:
			row.update(batch_no=batch, use_serial_batch_fields=1)
		doc = frappe.get_doc({
			"doctype": "Stock Entry", "stock_entry_type": "Material Transfer for Manufacture",
			"purpose": "Material Transfer for Manufacture", "company": self.company,
			"work_order": self.wo1, "fg_completed_qty": 1, "items": [row],
		})
		doc.flags.ignore_permissions = True
		doc.insert()
		return doc

	def test_ledger_flags_the_zero_valued_batch(self):
		item, free, paid = self._setup_batches()
		pool = {b["batch_no"]: b for b in available_in_store([(item, self.store)])[(item, self.store)]}
		self.assertTrue(pool[free]["zero_valued"])
		self.assertFalse(pool[paid]["zero_valued"])
		self.assertEqual(zero_valued_batches({(item, free, self.store), (item, paid, self.store)}),
		                 {(item, free, self.store)})

	def test_suggestion_skips_it_and_the_picker_shows_it_disabled(self):
		item, free, paid = self._setup_batches()
		draft = self._draft(item)
		out = SK.suggest_transfer_batches(draft.name)
		row = out["rows"][0]
		self.assertEqual(row["suggestion"], paid)
		opts = {o["batch_no"]: o for o in row["options"]}
		self.assertTrue(opts[free]["zero_valued"])
		self.assertEqual(opts[free]["status"], "unvalued")
		self.assertFalse(opts[paid].get("zero_valued"))

	def test_autofill_never_picks_it(self):
		item, free, paid = self._setup_batches()
		draft = self._draft(item)
		SK.autofill_batches(draft)
		self.assertEqual([r.batch_no for r in draft.items], [paid])

	def test_choosing_it_by_hand_is_refused_in_plain_text(self):
		item, free, paid = self._setup_batches()
		draft = self._draft(item)
		with self.assertRaises(frappe.ValidationError) as cm:
			SK.apply_transfer_batches(draft.name, frappe.as_json({"1": free}))
		self.assertIn(f"{item} batch {free} in {self.store} has no valuation rate (0)", str(cm.exception))

	def test_a_transfer_already_naming_it_is_refused_at_submit(self):
		item, free, paid = self._setup_batches()
		draft = self._draft(item, batch=free)
		err = SK._stock_gate_error(draft.name)
		self.assertIn(f"{item} batch {free} in {self.store} has no valuation rate (0). Correct its valuation", err)
		self.assertNotIn("<", err)
		ok = self._draft(item, batch=paid)
		self.assertIsNone(SK._stock_gate_error(ok.name))

	def test_floor_plan_picker_marks_it_and_it_is_not_expired(self):
		item, free, paid = self._setup_batches()
		out = RES.get_item_availability(self.store, [item])
		by = {b["batch_no"]: b for b in out[item]["batches"]}
		self.assertTrue(by[free]["zero_valued"])
		self.assertFalse(by[free]["expired"])
		self.assertFalse(by[paid]["zero_valued"])

	def test_a_non_batchwise_batch_is_priced_at_the_item_average_so_it_is_allowed(self):
		item, free, paid = self._setup_batches()
		frappe.db.set_value("Batch", free, "use_batchwise_valuation", 0)
		# the store's moving average for the item is > 0 (the paid batch is in it)
		self.assertGreater(frappe.db.get_value("Bin", {"item_code": item, "warehouse": self.store}, "valuation_rate") or 0, 0)
		self.assertEqual(zero_valued_batches({(item, free, self.store)}), set())
		pool = {b["batch_no"]: b for b in available_in_store([(item, self.store)])[(item, self.store)]}
		self.assertFalse(pool[free]["zero_valued"])
		self.assertEqual(pool[free]["valuation_method"], "moving_average")
		self.assertTrue(zero_valued_batches({(item, paid, self.store)}) == set())
		# ... and it may be suggested again
		self.assertIn(free, [b["batch_no"] for b in BS.rank_batches([pool[free]], "2026-10-15")])

	def test_the_zero_valued_list(self):
		item, free, paid = self._setup_batches()
		rows = SK.get_zero_valued_batches()["rows"]
		hit = [r for r in rows if r["item_code"] == item]
		self.assertEqual([(r["batch_no"], r["warehouse"], r["qty"], r["method"]) for r in hit],
		                 [(free, self.store, 3.0, "batchwise")])
