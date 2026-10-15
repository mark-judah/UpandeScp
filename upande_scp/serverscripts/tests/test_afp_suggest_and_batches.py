"""Application Floor Plan: suggested products, and the batch picker rules.

* `spray_compliance.suggest` — ranking maths (pure) and the endpoint against real stock:
  only products registered for the targets that pass the checks AND can be issued from the
  store (free stock after reservations, a usable batch for a batch-tracked item), clean
  ones before warned ones, hard-blocked ones left out.
* `get_item_availability` — a batch is greyed only when the rate ERPNext will use is <= 0,
  under both valuation methods (batch's own value / item moving average, including the
  Stock Settings "do not use batch-wise valuation" override), and the picker flags
  (`batch_required`, `no_batches`) follow `batch_requirement`.

DB tests run in one rolled-back transaction (LedgerCase). Direct runner:
  bench --site kaitet.local execute upande_scp.serverscripts.tests.test_afp_suggest_and_batches.run
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_compliance import context as C
from upande_scp.serverscripts.spray_compliance import suggest as S
from upande_scp.serverscripts.spray_plan_creator import reservations as RES
from upande_scp.serverscripts.store import batch_stock as BSK
from upande_scp.serverscripts.tests import test_tank_mix_zero_value as ZV
from upande_scp.serverscripts.tests.test_tank_mix_batch_resolution import LedgerCase


class TestRanking(unittest.TestCase):
	def test_dots(self):
		self.assertEqual([S.dots(x) for x in (0, 5, 20, 21, 59, 60, 100)], [1, 1, 1, 2, 3, 3, 5])

	def test_coverage_and_rotation_and_stock_points(self):
		self.assertEqual(S.coverage_points(1, 2), 25)
		self.assertEqual(S.rotation_points(None, 60), S.W_ROTATION)
		self.assertEqual(S.rotation_points(30, 60), S.W_ROTATION / 2)
		self.assertEqual(S.rotation_points(400, 60), S.W_ROTATION)
		self.assertEqual(S.stock_points(False, 0), S.W_STOCK)
		self.assertEqual(S.stock_points(True, 1), S.W_STOCK / 3)
		self.assertEqual(S.stock_points(True, 9), S.W_STOCK)

	def test_cost_points_cheapest_best_unknown_half(self):
		costs = [10, 20, 30, None]
		self.assertEqual(S.cost_points(10, costs), S.W_COST)
		self.assertEqual(S.cost_points(30, costs), 0)
		self.assertEqual(S.cost_points(None, costs), S.W_COST / 2)
		self.assertEqual(S.cost_points(10, [10]), S.W_COST / 2)

	def test_clean_first_then_warned_by_severity_then_score(self):
		def e(name, ok, mode, score):
			return {"item_name": name, "eligible": ok, "worst_mode": mode, "score": score}
		rows = S.rank([e("warn-hi", False, "Warn", 90), e("clean-lo", True, "Off", 10),
		               e("gm", False, "Block (GM override)", 95), e("clean-hi", True, "Off", 60)])
		self.assertEqual([r["item_name"] for r in rows], ["clean-hi", "clean-lo", "warn-hi", "gm"])

	def test_merge_is_eligible_only_if_eligible_everywhere_worst_mode_wins(self):
		a = [{"item": "X", "eligible": True, "worst_mode": "Off", "reasons": [], "rules": []}]
		b = [{"item": "X", "eligible": False, "worst_mode": "Warn", "reasons": ["r"], "rules": ["moa_rotation"]}]
		m = S.merge_verdicts([a, b])["X"]
		self.assertFalse(m["eligible"])
		self.assertEqual((m["worst_mode"], m["reasons"]), ("Warn", ["r"]))

	def test_batch_requirement(self):
		f = BSK.batch_requirement
		self.assertEqual(f(0, 0), {"tracked": False, "pickable": False, "required": False, "no_batches": False})
		self.assertTrue(f(1, 2)["required"] and not f(1, 2)["no_batches"])
		self.assertTrue(f(1, 0)["no_batches"] and not f(1, 0)["required"])


class TestAvailabilityAndSuggestions(LedgerCase):
	TARGET, OTHER = "Powdery Mildew", "Botrytis"

	def mk(self, name, batched=True):
		"""A throwaway item of its own (LedgerCase.item gives one per kind only)."""
		code = f"_TTMB-{self.tag}-{name}"
		frappe.get_doc({
			"doctype": "Item", "item_code": code, "item_name": code,
			"item_group": self.item_group, "stock_uom": self.uom, "is_stock_item": 1,
			"has_batch_no": 1 if batched else 0, "create_new_batch": 0, "valuation_rate": 10,
		}).insert(ignore_permissions=True)
		return code

	def product(self, item, target):
		# The Item hook may already have made the sidecar (when the group is a chemical group).
		d = frappe.get_doc("Spray Product", item) if frappe.db.exists("Spray Product", item) else \
			frappe.get_doc({"doctype": "Spray Product", "item": item, "product_name": item,
			                "category": "Chemical"})
		d.default_lower_rate_limit = 2
		d.set("default_targets", [{"disease": target}])
		d.save(ignore_permissions=True)

	def zero_batch(self, item, suffix, batchwise):
		b = self.batch(item, suffix)
		frappe.db.set_value("Batch", b, "use_batchwise_valuation", 1 if batchwise else 0)
		ZV.TestZeroValuedBatch._zero_receipt(self, item, b, 3, days_ago=8)
		return b

	def avail(self, item):
		return RES.get_item_availability(self.store, [item])[item]

	# ---- valuation-aware greying, both methods ----

	def _mixed_item(self, zero_batchwise):
		item = self.item()
		paid = self.batch(item, "PAID")
		frappe.db.set_value("Batch", paid, "use_batchwise_valuation", 1)
		self.receive(item, paid, 3, days_ago=7)
		zero = self.zero_batch(item, "ZERO", zero_batchwise)
		frappe.db.set_value("Bin", {"item_code": item, "warehouse": self.store}, "valuation_rate", 7)
		return item, paid, zero

	def test_batchwise_batch_at_zero_is_greyed_even_when_the_item_average_is_positive(self):
		item, paid, zero = self._mixed_item(zero_batchwise=True)
		by = {b["batch_no"]: b for b in self.avail(item)["batches"]}
		self.assertTrue(by[zero]["zero_valued"])
		self.assertFalse(by[paid]["zero_valued"])

	def test_moving_average_batch_is_priced_from_the_average_and_not_greyed(self):
		item, paid, zero = self._mixed_item(zero_batchwise=False)
		by = {b["batch_no"]: b for b in self.avail(item)["batches"]}
		self.assertFalse(by[zero]["zero_valued"])
		frappe.db.set_value("Bin", {"item_code": item, "warehouse": self.store}, "valuation_rate", 0)
		by = {b["batch_no"]: b for b in self.avail(item)["batches"]}
		self.assertTrue(by[zero]["zero_valued"])  # average gone: ERPNext cannot price it

	def test_stock_settings_override_makes_every_batch_of_a_moving_average_item_average_priced(self):
		item, paid, zero = self._mixed_item(zero_batchwise=True)
		real = frappe.get_single_value

		def setting(doctype, field, *a, **k):
			if (doctype, field) == ("Stock Settings", "do_not_use_batchwise_valuation"):
				return 1
			return real(doctype, field, *a, **k)

		frappe.db.set_value("Item", item, "valuation_method", "Moving Average")
		frappe.clear_document_cache("Item", item)
		with mock.patch.object(frappe, "get_single_value", side_effect=setting):
			by = {b["batch_no"]: b for b in self.avail(item)["batches"]}
		self.assertFalse(by[zero]["zero_valued"])
		self.assertEqual(
			BSK.batch_valuations({(item, zero, self.store)}).get((item, zero, self.store), {}).get("method"),
			"batchwise")  # without the override it is still batch-wise

	# ---- the picker flags ----

	def test_picker_flags(self):
		plain = self.item(batched=False)
		self.receive(plain, None, 4, days_ago=5)
		a = self.avail(plain)
		self.assertEqual((a["has_batch_no"], a["batch_required"], a["no_batches"]), (0, False, False))

		tracked_empty = self.item()
		a = self.avail(tracked_empty)
		self.assertEqual((a["has_batch_no"], a["batch_required"], a["no_batches"]), (1, False, True))

		held = self.item()
		self.receive(held, self.batch(held, "B1"), 2, days_ago=5)
		a = self.avail(held)
		self.assertEqual((a["batch_required"], a["no_batches"]), (True, False))

	# ---- suggestions ----

	def _stock(self):
		good = self.mk("GOOD")
		self.product(good, self.TARGET)
		self.receive(good, self.batch(good, "G1"), 6, days_ago=5)
		plain = self.mk("PLAIN", batched=False)
		self.product(plain, self.TARGET)
		self.receive(plain, None, 5, days_ago=5)
		free = self.mk("FREE")  # batch-tracked, only batch is valued at zero: cannot be issued
		self.product(free, self.TARGET)
		self.zero_batch(free, "Z", True)
		empty = self.mk("EMPTY")  # registered but no stock at the store
		self.product(empty, self.TARGET)
		elsewhere = self.mk("ELSE")  # in stock but registered for another target
		self.product(elsewhere, self.OTHER)
		self.receive(elsewhere, self.batch(elsewhere, "E1"), 3, days_ago=5)
		return good, plain, free, empty, elsewhere

	def suggest(self, current=None, modes=None, hide_covered=False, targets=None):
		patch = mock.patch.object(C, "load_modes", return_value=modes or {}) if modes is not None \
			else mock.patch.object(C, "load_modes", wraps=C.load_modes)
		with patch:
			return S.build_suggestions(targets or [self.TARGET], ["_TTMB NO GH"], self.store, current or [],
			                           limit=10_000, hide_covered=hide_covered)

	def stocked(self, name, targets, frac=None, ingredient=None):
		"""A batch-tracked, in-stock product registered for `targets`."""
		item = self.mk(name)
		self.product(item, targets[0])
		d = frappe.get_doc("Spray Product", item)
		d.set("default_targets", [{"disease": t} for t in targets])
		if frac:
			d.append("frac", {"code": frac})
		if ingredient:
			d.append("active_ingredients", ingredient)
		d.save(ignore_permissions=True)
		self.receive(item, self.batch(item, name[:6]), 6, days_ago=5)
		return item

	def test_only_registered_in_stock_issuable_products_are_suggested_and_ranked(self):
		good, plain, free, empty, elsewhere = self._stock()
		out = self.suggest(modes={})  # every rule Warn
		codes = [s["item_code"] for s in out["suggestions"]]
		self.assertEqual(sorted(set(codes) & {good, plain}), sorted([good, plain]))
		for absent in (free, empty, elsewhere):
			self.assertNotIn(absent, codes)
		top = {s["item_code"]: s for s in out["suggestions"]}[good]
		self.assertEqual((top["usable_batches"], top["batch_tracked"], top["default_rate"]), (1, True, 2.0))
		self.assertTrue(1 <= top["dots"] <= 5)
		self.assertIn("covers 1 of 1 target", top["reason"])
		self.assertIn("1 usable batch", top["reason"])
		self.assertEqual(out["needs"], None)

	def test_missing_inputs_say_what_is_needed(self):
		self.assertEqual(S.build_suggestions([], ["g"], self.store)["needs"], "targets")
		self.assertEqual(S.build_suggestions(["t"], [], self.store)["needs"], "greenhouse")
		self.assertEqual(S.build_suggestions(["t"], ["g"], "")["needs"], "store")

	def test_a_product_already_in_the_mix_is_not_suggested(self):
		good, plain, *_ = self._stock()
		codes = [s["item_code"] for s in self.suggest(current=[good])["suggestions"]]
		self.assertNotIn(good, codes)

	def test_warn_mode_lists_a_clashing_product_below_the_clean_ones_with_its_warning(self):
		good, plain, *_ = self._stock()
		# same hand-entered FRAC group in one tank
		for item in (good, plain):
			d = frappe.get_doc("Spray Product", item)
			d.append("frac", {"code": "7"})
			d.save(ignore_permissions=True)
		out = self.suggest(current=[plain], modes={"same_moa_in_mix": "Warn"})
		by = {s["item_code"]: s for s in out["suggestions"]}
		self.assertFalse(by[good]["eligible"])
		self.assertTrue(by[good]["warnings"])
		out = self.suggest(current=[plain], modes={"same_moa_in_mix": "Block"})
		self.assertNotIn(good, [s["item_code"] for s in out["suggestions"]])
		self.assertGreaterEqual(out["blocked"], 1)


	# ---- covered targets hide ----

	def test_targets_already_covered_by_the_mix_are_hidden_and_reported(self):
		a1 = self.stocked("A1", [self.TARGET])
		a2 = self.stocked("A2", [self.TARGET])
		b1 = self.stocked("B1", [self.OTHER])
		both = self.stocked("AB", [self.TARGET, self.OTHER])
		targets = [self.TARGET, self.OTHER]
		shown = lambda out: {s["item_code"] for s in out["suggestions"]}
		# nothing in the mix: everything registered for either target
		out = self.suggest(targets=targets, hide_covered=True, modes={})
		self.assertTrue({a1, a2, b1, both} <= shown(out))
		self.assertEqual(out["remaining_targets"], targets)
		# a1 covers TARGET: products that only serve TARGET disappear, the rest stay
		out = self.suggest(current=[a1], targets=targets, hide_covered=True, modes={})
		self.assertNotIn(a2, shown(out))
		self.assertTrue({b1, both} <= shown(out))
		self.assertEqual(out["remaining_targets"], [self.OTHER])
		self.assertEqual([(c["target"], c["items"]) for c in out["covered"]], [(self.TARGET, [a1])])
		by = {s["item_code"]: s for s in out["suggestions"]}
		self.assertEqual(by[both]["covered_targets"], [self.OTHER])
		# adding the B product covers everything: nothing left to suggest
		out = self.suggest(current=[a1, b1], targets=targets, hide_covered=True, modes={})
		self.assertEqual((out["suggestions"], out["all_covered"], out["remaining_targets"]), ([], True, []))
		# removing a1 brings TARGET suggestions back
		out = self.suggest(current=[b1], targets=targets, hide_covered=True, modes={})
		self.assertIn(a1, shown(out))
		self.assertNotIn(b1, shown(out))

	# ---- suggested tank mix ----

	def mix(self, targets=None, modes=None, incompat=None, current=None):
		with mock.patch.object(C, "load_modes", return_value=modes if modes is not None else {}), \
		     mock.patch.object(C, "load_incompatibilities", return_value=incompat or []):
			return S.build_mix(targets or [self.TARGET, self.OTHER], ["_TTMB NO GH"], self.store,
			                   current_items=current)

	def test_mix_covers_all_targets_fewest_products_first(self):
		a = self.stocked("MA", [self.TARGET], frac="7")
		b = self.stocked("MB", [self.OTHER], frac="9")
		ab = self.stocked("MAB", [self.TARGET, self.OTHER], frac="3")
		out = self.mix(current=["X"])
		self.assertEqual(out["replaces"], ["X"])
		sets = [sorted(p["item_code"] for p in m["products"]) for m in out["mixes"]]
		self.assertEqual(sets[0], [ab])
		self.assertIn(sorted([a, b]), sets)
		for m in out["mixes"]:
			self.assertTrue(all(m["covers"][t] for t in (self.TARGET, self.OTHER)))
			self.assertTrue(m["codes"])

	def test_mix_never_pairs_the_same_moa_group_but_does_when_the_rule_is_off(self):
		self.stocked("SA", [self.TARGET], frac="7")
		self.stocked("SB", [self.OTHER], frac="7")
		self.assertEqual(self.mix()["mixes"], [])
		out = self.mix(modes={"same_moa_in_mix": "Off", "moa_rotation": "Off"})
		self.assertEqual(len(out["mixes"]), 1)

	def test_mix_respects_tank_mix_incompatibility(self):
		a = self.stocked("IA", [self.TARGET], frac="7")
		b = self.stocked("IB", [self.OTHER], frac="9")
		c = self.stocked("IC", [self.OTHER], frac="12")
		inc = [{"product_a": a, "product_b": b, "ingredient_a": None, "ingredient_b": None, "reason": "no"}]
		sets = [sorted(p["item_code"] for p in m["products"]) for m in self.mix(incompat=inc)["mixes"]]
		self.assertEqual(sets, [sorted([a, c])])

	def test_mix_skips_products_without_usable_stock(self):
		a = self.stocked("UA", [self.TARGET], frac="7")
		out_of_stock = self.mk("UB")
		self.product(out_of_stock, self.OTHER)
		self.assertEqual(self.mix()["mixes"], [])

	def test_mix_asks_for_what_is_missing(self):
		self.assertEqual(S.build_mix([], ["g"], self.store)["needs"], "targets")
		self.assertEqual(S.build_mix(["t"], [], self.store)["needs"], "greenhouse")

	# ---- active ingredients of the mix rows ----

	def test_mix_ingredients_reads_the_product_live_and_computes_the_amount(self):
		from upande_scp.serverscripts.spray_compliance import active_ingredients as AI
		moa = frappe.get_doc({"doctype": "Active Ingredient MoA", "ingredient": f"_TTMB AI {self.tag}"})
		moa.insert(ignore_permissions=True)
		withai = self.stocked("AIA", [self.TARGET], ingredient={
			"ingredient": moa.name, "active_ingredient": moa.name, "concentration": 18,
			"concentration_unit": "g/L"})
		noconc = self.stocked("AIB", [self.TARGET], ingredient={
			"ingredient": moa.name, "active_ingredient": moa.name})
		out = AI.mix_ingredients([{"item_code": withai, "qty": 3, "uom": "Litre"},
		                          {"item_code": noconc, "qty": 3, "uom": "Litre"}], area=0.5)
		i = out[withai]["ingredients"][0]
		self.assertEqual((i["status"], i["amount"], i["amount_unit"], i["per_ha"], i["concentration_label"]),
		                 ("ok", 54.0, "g", 108.0, "18 g/L"))
		n = out[noconc]["ingredients"][0]
		self.assertEqual((n["status"], n["amount"], n["per_ha"]), ("no_concentration", None, None))
		# no area: per-ha stays empty
		self.assertIsNone(AI.mix_ingredients([{"item_code": withai, "qty": 3, "uom": "Litre"}])
		                  [withai]["ingredients"][0]["per_ha"])


def run():
	frappe.set_user("Administrator")
	r = unittest.TextTestRunner(verbosity=2).run(
		unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__, fromlist=["x"])))
	return r.wasSuccessful()
