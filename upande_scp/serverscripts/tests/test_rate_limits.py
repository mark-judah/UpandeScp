"""A rate limit nobody set is not a limit of zero.

Every Spray Product on mona's live site carries
`default_lower_rate_limit = 0` and `default_upper_rate_limit = 0` — all 111 of
them, because nobody has filled the fields in yet. The validator read the 0 as
a real ceiling, so `rate > 0` was "above the configured upper limit of 0.0" and
the planner refused every chemical on the farm:

    ValidationError: CHE00037: rate 2 is above the configured upper limit of 0.0.

A zero here means "unconfigured", which is what a numeric field reads as before
anyone touches it. The farm that has set no limits should get no limits — not a
planner that refuses to plan.

The lower bound has the same shape and the opposite risk: a 0 lower limit is
satisfied by everything, so it never blocked anything, but treating it as a
real floor would be just as wrong the day someone types a rate of 0.5.
"""

import unittest

from upande_scp.serverscripts.spray_plan_creator import validation as val


class TestAnUnsetLimitDoesNotBlock(unittest.TestCase):
	def test_a_zero_upper_limit_lets_any_rate_through(self):
		"""The bug, in one line: 111 products at zero meant no plan could be
		made at all."""
		val.validate_rate_in_limits(
			"CHE00037", 2.0, {"CHE00037": {"lower": 0, "upper": 0}}
		)

	def test_a_zero_lower_limit_lets_a_small_rate_through(self):
		# Real plans use 0.15 and 0.3 of a litre. A floor of zero must not
		# become a floor of "something".
		val.validate_rate_in_limits(
			"CHE00037", 0.15, {"CHE00037": {"lower": 0, "upper": 0}}
		)

	def test_a_missing_limit_still_lets_anything_through(self):
		val.validate_rate_in_limits(
			"CHE00037", 99.0, {"CHE00037": {"lower": None, "upper": None}}
		)


class TestARealLimitStillHolds(unittest.TestCase):
	"""The point of the field is that a farm CAN cap a chemical. Unsetting the
	zero case must not unset the ones somebody configured on purpose."""

	LIMITS = {"CHE00037": {"lower": 1.0, "upper": 2.0}}

	def test_above_the_ceiling_is_refused(self):
		with self.assertRaises(Exception) as caught:
			val.validate_rate_in_limits("CHE00037", 2.5, self.LIMITS)
		self.assertIn("upper limit", str(caught.exception))

	def test_below_the_floor_is_refused(self):
		with self.assertRaises(Exception) as caught:
			val.validate_rate_in_limits("CHE00037", 0.5, self.LIMITS)
		self.assertIn("lower limit", str(caught.exception))

	def test_inside_the_range_is_fine(self):
		val.validate_rate_in_limits("CHE00037", 1.5, self.LIMITS)

	def test_exactly_on_the_boundary_is_fine(self):
		"""A limit of 2 means 2 is allowed — the farm said "up to 2", not
		"under 2"."""
		val.validate_rate_in_limits("CHE00037", 2.0, self.LIMITS)
		val.validate_rate_in_limits("CHE00037", 1.0, self.LIMITS)

	def test_a_ceiling_with_no_floor_still_caps(self):
		with self.assertRaises(Exception):
			val.validate_rate_in_limits(
				"CHE00037", 3.0, {"CHE00037": {"lower": 0, "upper": 2.0}}
			)

	def test_a_floor_with_no_ceiling_still_holds_the_bottom(self):
		with self.assertRaises(Exception):
			val.validate_rate_in_limits(
				"CHE00037", 0.2, {"CHE00037": {"lower": 1.0, "upper": 0}}
			)
