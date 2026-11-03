"""Early label printing: one sticker per chemical, checked against the item total."""

import unittest
from types import SimpleNamespace as NS

from upande_scp.serverscripts.qr.chemical_labels import _item_totals


def _doc(*rows):
	return NS(items=[NS(idx=i + 1, item_code=c, qty=q) for i, (c, q) in enumerate(rows)])


class TestItemTotals(unittest.TestCase):
	def test_one_entry_per_chemical_on_its_first_line(self):
		t = _item_totals(_doc(("A", 1.0), ("B", 2.0), ("A", 0.5)))
		self.assertEqual(t["A"][0], 1)
		self.assertAlmostEqual(t["A"][1], 1.5)
		self.assertEqual(t["B"][0], 2)
		self.assertAlmostEqual(t["B"][1], 2.0)

	def test_batch_split_keeps_the_total(self):
		# Submitting can split one draft line by batch; the early code printed for
		# the whole quantity must still match.
		draft = _item_totals(_doc(("A", 10.0)))
		submitted = _item_totals(_doc(("A", 6.0), ("A", 4.0)))
		self.assertAlmostEqual(draft["A"][1], submitted["A"][1])

	def test_blank_lines_ignored(self):
		self.assertEqual(_item_totals(_doc(("", 3.0))), {})
