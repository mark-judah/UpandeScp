"""The patch fills cost groups from structured fields only, never by product name."""

import inspect
import unittest

from upande_scp.patches.v1_0 import add_spray_product_cost_group as P


class TestStructuredGroup(unittest.TestCase):
	def test_structured_fields(self):
		self.assertEqual(P.structured_group("Foliar", "Insecticide", "CHE1"), "Foliar")
		self.assertEqual(P.structured_group("Chemical", "Fungicide", "FER0004"), "Foliar")
		self.assertEqual(P.structured_group("Chemical", "Adjuvant", "CHE2"), "Adjuvant")
		self.assertEqual(P.structured_group("Chemical", "pH Buffer", "CHE3"), "pH buffer")

	def test_everything_else_is_left_empty(self):
		self.assertIsNone(P.structured_group("Chemical", "Insecticide", "CHE00007"))
		self.assertIsNone(P.structured_group("Chemical", "", "CHE9"))

	def test_no_product_names_in_the_patch(self):
		src = inspect.getsource(P).lower()
		for name in ("chrysal", "agrowipe", "peroxide", "flower dust", "velum"):
			self.assertNotIn(name, src)
