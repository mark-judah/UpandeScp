"""The traceable chemical label code.

Two things are load-bearing and both are pinned here:

* **the width.** 33 digits fits QR v1 (21×21) at ECC-M, whose numeric capacity is 34.
  Go over and every label silently drops to v2 — smaller modules on a 203 dpi thermal
  printer — or loses its error correction. The whole "structured code AND better
  scannability" claim is that one number.
* **what a scan proves.** Before this, `qr_payload` was stored and never read: the only
  check was that a client-supplied `item_code` appeared on the work order, so a label
  from another greenhouse passed and so did a typed code with no scan at all.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_chemical_qr
"""

import random
import unittest

import frappe

from upande_scp.serverscripts.qr import chemical_labels as CL
from upande_scp.serverscripts.qr.chemical_code import (
	CODE_LENGTH,
	LAYOUT,
	QTY_OVERFLOW,
	VERSION,
	LAYOUTS,
	ref_capacity,
	numeric_tail,
	CodeError,
	decode,
	encode,
	encode_qty,
	looks_like_code,
	name_year,
	numeric_tail,
)

SAMPLE = dict(year=26, ref=2562406, item_id=347, wo_tail=5200)


class TestCodec(unittest.TestCase):
	def test_the_code_is_33_digits(self):
		code = encode(**SAMPLE, qty=2.25, rand=84915177)
		self.assertEqual(len(code), 33)
		self.assertEqual(len(code), CODE_LENGTH)
		self.assertTrue(code.isdigit())

	def test_the_width_stays_inside_qr_v1_at_ecc_m(self):
		"""The claim the design rests on: 33 digits at ECC-M is a v1 (21×21) symbol.

		Measured against the same library that prints the labels, not asserted from a
		capacity table. 35 digits would exceed v1-M's 34 and cost every label either a
		version or its error correction.
		"""
		import qrcode

		code = encode(**SAMPLE, qty=2.25, rand=84915177)
		qr = qrcode.QRCode(
			version=None,
			error_correction=qrcode.constants.ERROR_CORRECT_M,
			box_size=4,
			border=2,
		)
		qr.add_data(code)
		qr.make(fit=True)
		self.assertEqual(qr.version, 1, f"{len(code)} digits pushed the label to v2")
		self.assertLessEqual(CODE_LENGTH, 34)

	def test_every_segment_survives_a_round_trip(self):
		code = encode(**SAMPLE, qty=2.25, rand=84915177)
		got = decode(code)
		self.assertEqual(got.version, VERSION)
		self.assertEqual(got.year, 26)
		self.assertEqual(got.ref, 2562406)
		self.assertEqual(got.serial, 2562406)
		self.assertEqual(got.item_id, 347)
		self.assertEqual(got.wo_tail, 5200)
		self.assertEqual(got.random, 84915177)
		self.assertAlmostEqual(got.qty, 2.25)
		self.assertEqual(got.code, code, "re-encoding must reproduce the code exactly")

	def test_segments_are_read_at_the_right_offsets(self):
		"""A layout edit that shifts a boundary would still round-trip; this catches it
		by checking the digits land where the documented layout says."""
		code = encode(year=7, ref=1, item_id=2, wo_tail=3, qty=0.04, rand=5)
		at, seen = 0, {}
		for name, width in LAYOUT:
			seen[name] = code[at : at + width]
			at += width
		self.assertEqual(seen["version"], str(VERSION))
		self.assertEqual(seen["year"], "07")
		self.assertEqual(seen["ref"], "0000001")
		self.assertEqual(seen["item_id"], "0002")
		self.assertEqual(seen["qty_x100"], "00004")
		self.assertEqual(seen["wo_tail"], "000003")
		self.assertEqual(seen["random"], "00000005")

	def test_a_flipped_digit_produces_a_different_code(self):
		code = encode(**SAMPLE, qty=2.25, rand=84915177)
		flipped = code[:10] + ("9" if code[10] != "9" else "8") + code[11:]
		self.assertNotEqual(flipped, code)
		# It still parses — the protection is that it will not match a stored row.
		self.assertTrue(looks_like_code(flipped))

	def test_quantity_carries_two_decimals(self):
		self.assertEqual(encode_qty(2.25), 225)
		self.assertEqual(encode_qty(0.05), 5)
		self.assertEqual(encode_qty(10), 1000)
		self.assertAlmostEqual(decode(encode(**SAMPLE, qty=0.05, rand=1)).qty, 0.05)

	def test_a_quantity_too_large_to_fit_says_so_instead_of_lying(self):
		"""9,999.99 is the ceiling. Beyond it the sentinel means "read the document",
		which is safe because the document is authoritative on scan anyway."""
		self.assertEqual(encode_qty(1_200_000), QTY_OVERFLOW)
		got = decode(encode(**SAMPLE, qty=1_200_000, rand=1))
		self.assertTrue(got.qty_overflowed)
		self.assertIn("see document", got.describe())

	def test_a_negative_or_unparseable_quantity_overflows_rather_than_wrapping(self):
		self.assertEqual(encode_qty(-5), QTY_OVERFLOW)
		self.assertEqual(encode_qty(None), QTY_OVERFLOW)
		self.assertEqual(encode_qty("banana"), QTY_OVERFLOW)

	def test_a_segment_that_cannot_fit_is_refused_not_truncated(self):
		with self.assertRaises(CodeError):
			encode(year=26, ref=99_999_999, item_id=1, wo_tail=1, qty=1)
		with self.assertRaises(CodeError):
			encode(year=26, ref=1, item_id=99_999, wo_tail=1, qty=1)

	def test_junk_is_rejected(self):
		for bad in ("Score 250 EC\n10 L", "", "12345", "1" * 34, "abc" * 11, None):
			self.assertFalse(looks_like_code(bad))
		for bad in ("Score 250 EC\n10 L", "12345", "1" * 34):
			with self.assertRaises(CodeError):
				decode(bad)

	def test_a_future_format_version_is_refused_with_a_clear_reason(self):
		code = encode(**SAMPLE, qty=1, rand=1)
		future = "9" + code[1:]
		with self.assertRaises(CodeError) as cm:
			decode(future)
		self.assertIn("v9", str(cm.exception))

	def test_random_segments_differ_between_labels(self):
		codes = {encode(**SAMPLE, qty=1) for _ in range(50)}
		self.assertGreater(len(codes), 45, "the random segment is not varying")

	def test_it_is_reproducible_when_the_rng_is_given(self):
		a = encode(**SAMPLE, qty=1, rng=random.Random(7))
		b = encode(**SAMPLE, qty=1, rng=random.Random(7))
		self.assertEqual(a, b)


class TestDocumentNames(unittest.TestCase):
	def test_the_serial_is_read_not_the_amendment_counter(self):
		"""14 work orders on kaitet end in `-1`. Taking the trailing digits would put
		the amendment counter in the code where the work order number belongs."""
		self.assertEqual(numeric_tail("MFG-WO-2026-05200-1"), 5200)
		self.assertEqual(numeric_tail("MFG-WO-2026-05200"), 5200)
		self.assertEqual(numeric_tail("SE-2026-2562406"), 2562406)
		self.assertEqual(numeric_tail("MAT-STE-2026-00123"), 123)

	def test_both_live_stock_entry_series_read_the_same_way(self):
		# kaitet has both in use: 192 MAT-STE and 107 SE documents.
		self.assertEqual(numeric_tail("MAT-STE-2026-00192"), 192)
		self.assertEqual(numeric_tail("SE-2026-0000107"), 107)

	def test_a_missing_or_odd_name_is_zero_not_an_error(self):
		for bad in (None, "", "NO-DIGITS-HERE"):
			self.assertEqual(numeric_tail(bad), 0)
			self.assertEqual(name_year(bad), 0)

	def test_the_year_comes_out_as_two_digits(self):
		self.assertEqual(name_year("SE-2026-2562406"), 26)
		self.assertEqual(name_year("MFG-WO-2031-00001"), 31)


class TestSurrogate(unittest.TestCase):
	"""Item codes cannot be encoded directly: 15 of 695 chemical items are not
	numeric, so each item gets a small stable integer instead."""

	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")

	def test_a_non_numeric_item_code_still_gets_a_surrogate(self):
		# Raw SQL: Frappe has no "not regexp" filter operator.
		found = frappe.db.sql(
			"""SELECT i.name FROM tabItem i
			   JOIN `tabCrop Protection Item Group` g ON g.item_group = i.item_group
			   WHERE i.name NOT REGEXP '^[0-9]+$' LIMIT 1"""
		)
		row = found[0][0] if found else None
		if not row:
			self.skipTest("every item on this site has a numeric code")
		doctype, name = CL._sidecar_for(row)
		if not doctype:
			self.skipTest(f"{row} has no Chemical/Foliar sidecar")
		got = CL.item_surrogate(row)
		self.assertGreater(got, 0)
		self.assertEqual(CL.item_surrogate(row), got, "must be stable across calls")

	def test_the_surrogate_fits_the_field(self):
		# 4 digits: room for 9,999 against 697 items today.
		row = frappe.db.get_value("Spray Product", {}, "name")
		if not row:
			self.skipTest("no Spray Products on this site")
		self.assertLess(CL.item_surrogate(row), 10_000)

	def test_no_two_products_share_a_surrogate(self):
		"""One counter across every spray product, so a chemical and a foliar can
		never encode to the same digits.

		This used to need a join between two tables. Consolidating onto one
		doctype makes the property a plain uniqueness check — and removes the
		class of bug where a product moved between the two tables and was handed
		a second id.
		"""
		dupes = frappe.db.sql(
			"""SELECT qr_item_id, COUNT(*) n FROM `tabSpray Product`
			   WHERE qr_item_id > 0 GROUP BY qr_item_id HAVING n > 1"""
		)
		self.assertEqual(dupes, (), f"surrogate collision: {dupes}")

	def test_surrogates_are_unique_across_categories(self):
		dupes = frappe.db.sql(
			"""SELECT a.qr_item_id
			   FROM `tabSpray Product` a JOIN `tabSpray Product` b
			     ON b.qr_item_id = a.qr_item_id AND b.name != a.name
			   WHERE a.qr_item_id > 0 AND a.category != b.category"""
		)
		self.assertEqual(dupes, (), f"cross-category collision: {dupes}")


class TestVerifyScan(unittest.TestCase):
	"""What a scan actually proves now."""

	ITEM = "_TEST-QR-CHEM"

	@classmethod
	def setUpClass(cls):
		frappe.set_user("Administrator")
		cls.made: list[tuple[str, str]] = []

	@classmethod
	def tearDownClass(cls):
		for doctype, name in reversed(cls.made):
			if frappe.db.exists(doctype, name):
				frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)
		frappe.db.commit()

	def _label(self, **overrides):
		"""A stored label row, standing in for one issued by a real transfer."""
		se = frappe.db.get_value(
			"Stock Entry", {"docstatus": 1}, "name"
		)
		if not se:
			self.skipTest("no submitted Stock Entry on this site")
		payload = {
			"doctype": CL.LABEL,
			"code": encode(**SAMPLE, qty=2.25),
			"stock_entry": se,
			"se_line_idx": 1,
			"work_order": None,
			"item_code": frappe.db.get_value("Item", {"disabled": 0}, "name"),
			"qty": 2.25,
		}
		payload.update(overrides)
		doc = frappe.get_doc(payload)
		doc.flags.ignore_permissions = True
		doc.flags.ignore_links = True
		doc.insert(ignore_permissions=True)
		frappe.db.commit()
		self.made.append((CL.LABEL, doc.name))
		return doc

	def test_a_legacy_text_label_is_allowed_but_not_called_verified(self):
		"""Those stickers are in circulation. Refusing them would stop work; calling
		them verified would make the audit trail a lie."""
		out = CL.verify_scan("Score 250 EC\n10 L", "MFG-WO-2026-00001", "ANY")
		self.assertFalse(out["verified"])
		self.assertIn("reprint", out["why"])

	def test_a_code_that_was_never_issued_is_refused(self):
		"""The structured segments are guessable; the 8 random digits are not, and they
		have to match a row that exists."""
		fabricated = encode(**SAMPLE, qty=2.25, rand=12345678)
		with self.assertRaises(CL.ScanRefused) as cm:
			CL.verify_scan(fabricated, "MFG-WO-2026-00001", "ANY")
		self.assertIn("never issued", str(cm.exception))

	def test_a_label_from_another_plan_is_refused(self):
		"""The check the old flow could not make at all."""
		wo = frappe.db.get_value("Work Order", {}, "name")
		if not wo:
			self.skipTest("no Work Orders on this site")
		label = self._label(work_order=wo)
		with self.assertRaises(CL.ScanRefused) as cm:
			CL.verify_scan(label.code, "MFG-WO-9999-99999", label.item_code)
		self.assertIn(wo, str(cm.exception))

	def test_a_label_for_another_chemical_is_refused(self):
		label = self._label()
		other = frappe.db.get_value(
			"Item", {"name": ("!=", label.item_code), "disabled": 0}, "name"
		)
		with self.assertRaises(CL.ScanRefused) as cm:
			CL.verify_scan(label.code, label.work_order or "", other)
		self.assertIn(label.item_code, str(cm.exception))

	def test_a_cancelled_transfers_label_is_dead(self):
		"""9 of 12 transfer Stock Entries on kaitet are cancelled, so a voided label in
		somebody's hand is the normal case."""
		cancelled = frappe.db.get_value("Stock Entry", {"docstatus": 2}, "name")
		if not cancelled:
			self.skipTest("no cancelled Stock Entry on this site")
		label = self._label(stock_entry=cancelled)
		with self.assertRaises(CL.ScanRefused) as cm:
			CL.verify_scan(label.code, label.work_order or "", label.item_code)
		self.assertIn("cancelled", str(cm.exception))

	def test_a_good_label_verifies(self):
		label = self._label()
		out = CL.verify_scan(label.code, label.work_order or "", label.item_code)
		self.assertTrue(out["verified"])
		self.assertEqual(out["code"], label.code)
		self.assertAlmostEqual(out["qty"], 2.25)

	def test_explain_code_reads_the_segments_back_for_a_human(self):
		label = self._label()
		out = CL.explain_code(label.code)
		self.assertTrue(out["valid"])
		self.assertTrue(out["issued"])
		self.assertEqual(out["segments"]["label_serial"], SAMPLE["ref"])
		self.assertEqual(out["segments"]["work_order_tail"], SAMPLE["wo_tail"])
		self.assertAlmostEqual(out["segments"]["qty"], 2.25)

	def test_explain_code_on_a_legacy_payload_says_so(self):
		out = CL.explain_code("Score 250 EC\n10 L")
		self.assertFalse(out["valid"])


class TestLayoutVersions(unittest.TestCase):
	"""Slot 3 stopped being a number we borrow, and old stickers still scan."""

	def test_a_v1_sticker_still_decodes_after_v2_shipped(self):
		"""The version digit is first so this is possible. Until now `decode` threw on
		any version but the current one, so the promise in the docstring was not kept —
		and shipping v2 would have bricked every label already on a shelf."""
		v1 = encode(**SAMPLE, qty=2.25, rand=84915177, version=1)
		got = decode(v1)
		self.assertEqual(got.version, 1)
		self.assertEqual(got.code, v1, "a v1 code must re-encode to itself, not to v2")
		self.assertTrue(looks_like_code(v1))

	def test_slot_three_is_named_for_what_it_holds(self):
		v1 = decode(encode(**SAMPLE, qty=1, rand=1, version=1))
		v2 = decode(encode(**SAMPLE, qty=1, rand=1))
		self.assertEqual((v1.se_tail, v1.serial), (SAMPLE["ref"], None))
		self.assertEqual((v2.serial, v2.se_tail), (SAMPLE["ref"], None))
		self.assertIn("stock entry", v1.describe())
		self.assertIn("label #", v2.describe())

	def test_an_unknown_layout_is_refused_by_name(self):
		future = "9" + "0" * (CODE_LENGTH - 1)
		self.assertFalse(looks_like_code(future))
		with self.assertRaises(CodeError) as ctx:
			decode(future)
		self.assertIn("v9", str(ctx.exception))

	def test_every_layout_is_the_same_length(self):
		"""A shorter or longer layout would change the printed symbol size and break
		the length check that tells our codes from a legacy text payload."""
		for version, layout in LAYOUTS.items():
			self.assertEqual(sum(w for _, w in layout), CODE_LENGTH, f"v{version}")
			self.assertEqual(layout[0], ("version", 1), f"v{version}")

	def test_the_nine_digit_name_that_started_this_is_still_refused(self):
		"""MAT-STE-2026-100001717. Slot 3 is seven digits and that has not changed —
		what changed is that we no longer put a borrowed number in it."""
		with self.assertRaises(CodeError):
			encode(year=26, ref=100001717, item_id=1, wo_tail=4045, qty=1)

	def test_the_slot_holds_ten_million(self):
		self.assertEqual(ref_capacity(), 10_000_000)
		self.assertEqual(encode(year=26, ref=9_999_999, item_id=1, wo_tail=1,
		                        qty=1, rand=1)[3:10], "9999999")


class TestBorrowedNumbersCannotBreakALabel(unittest.TestCase):
	"""The residual risk after the serial: `wo_tail` is still Frappe's number."""

	def test_a_tail_is_kept_to_its_slot(self):
		"""A Work Order series repaired the way MAT-STE- was would push this past six
		digits and, unbounded, take every label down with it."""
		self.assertEqual(numeric_tail("MFG-WO-2026-100004045", 6), 4045)
		self.assertEqual(numeric_tail("MFG-WO-2026-05200", 6), 5200)
		self.assertEqual(numeric_tail("MFG-WO-2026-05200-1", 6), 5200)

	def test_unbounded_is_still_the_default(self):
		self.assertEqual(numeric_tail("MFG-WO-2026-100004045"), 100004045)

	def test_a_label_survives_a_work_order_series_jump(self):
		"""End to end through the encoder: the label is still issued, and the tail it
		shows is the low-order digits — which is what `…5200` already meant."""
		code = encode(
			year=26, ref=1, item_id=1, qty=1,
			wo_tail=numeric_tail("MFG-WO-2026-100004045", 6), rand=1,
		)
		self.assertEqual(decode(code).wo_tail, 4045)
