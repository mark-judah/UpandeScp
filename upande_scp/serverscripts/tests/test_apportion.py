"""Apportioning a reduced chemical quantity back to the farms that requested it.

The property under protection: proportional, measurable, and never starving the
small farms. Rounding each share DOWN to a step does starve them — a farm
entitled to 4.5g of a 10g step gets nothing — which is why this uses
largest-remainder apportionment in step units.

Pure functions, no site needed.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_apportion
"""

import unittest

from upande_scp.serverscripts.store.apportion import (
    apportion,
    default_step_for_uom,
)


def alloc_map(result):
    return {a.farm: a.allocated for a in result.allocations}


class TestApportion(unittest.TestCase):
    def test_the_canonical_case_five_farms_fifty_to_fortyfive(self):
        """The worked example: five farms wanting 10 each, total cut 50 -> 45.
        Nine each, and nothing left over."""
        reqs = {f"F{i}": 10 for i in range(1, 6)}
        r = apportion(reqs, 45, step=1)
        self.assertEqual(set(alloc_map(r).values()), {9})
        self.assertEqual(r.distributed, 45)
        self.assertEqual(r.remainder, 0)

    def test_a_small_farm_is_not_starved_by_the_step(self):
        """The bug this module exists to avoid.

        Five farms each entitled to 4.5g with a 10g step: rounding down gives
        every one of them zero and leaves the whole 22.5g in the general store.
        Largest-remainder gives two farms a 10g step each instead."""
        reqs = {f"F{i}": 10 for i in range(1, 6)}
        r = apportion(reqs, 22.5, step=10)
        self.assertGreater(r.distributed, 0, "everybody was starved")
        self.assertEqual(r.distributed, 20)
        self.assertEqual(sorted(alloc_map(r).values()), [0, 0, 0, 10, 10])
        self.assertAlmostEqual(r.remainder, 2.5)

    def test_every_allocation_is_a_whole_number_of_steps(self):
        reqs = {"A": 7, "B": 13, "C": 31}
        r = apportion(reqs, 37, step=10)
        for a in r.allocations:
            self.assertAlmostEqual(a.allocated % 10, 0, msg=f"{a.farm} unmeasurable")

    def test_it_never_hands_out_more_than_it_has(self):
        reqs = {"A": 100, "B": 100}
        r = apportion(reqs, 45, step=10)
        self.assertLessEqual(r.distributed, 45)

    def test_it_never_hands_out_more_than_was_asked_for(self):
        # A generous budget does not mean forcing stock on people.
        reqs = {"A": 5, "B": 5}
        r = apportion(reqs, 500, step=1)
        self.assertEqual(r.distributed, 10)

    def test_the_split_stays_proportional(self):
        reqs = {"Big": 90, "Small": 10}
        r = apportion(reqs, 100, step=1)
        m = alloc_map(r)
        self.assertEqual(m["Big"], 90)
        self.assertEqual(m["Small"], 10)

    def test_a_bigger_request_never_gets_less_than_a_smaller_one(self):
        reqs = {"A": 50, "B": 30, "C": 20}
        m = alloc_map(apportion(reqs, 63, step=1))
        self.assertGreaterEqual(m["A"], m["B"])
        self.assertGreaterEqual(m["B"], m["C"])

    def test_below_one_step_everything_waits_in_the_general_store(self):
        # Nobody can be given a measurable share, so nobody is given one.
        r = apportion({"A": 10, "B": 10}, 7, step=10)
        self.assertEqual(r.distributed, 0)
        self.assertAlmostEqual(r.remainder, 7)

    def test_remainder_plus_distributed_accounts_for_everything(self):
        reqs = {"A": 33, "B": 33, "C": 34}
        r = apportion(reqs, 47, step=10)
        self.assertAlmostEqual(r.distributed + r.remainder, 47)

    def test_it_is_deterministic_under_ties(self):
        # Identical requests, one spare step: the same farm must win every time,
        # or a rerun would silently reshuffle a published allocation.
        reqs = {"B": 10, "A": 10, "C": 10}
        first = alloc_map(apportion(reqs, 4, step=1))
        for _ in range(5):
            self.assertEqual(alloc_map(apportion(dict(reqs), 4, step=1)), first)

    def test_a_tie_breaks_on_request_size_then_name(self):
        reqs = {"Zeta": 10, "Alpha": 10}
        # One spare step between two equal claims -> alphabetical wins.
        m = alloc_map(apportion(reqs, 1, step=1))
        self.assertEqual(m["Alpha"], 1)
        self.assertEqual(m["Zeta"], 0)

    def test_farms_asking_for_nothing_get_nothing(self):
        r = apportion({"A": 10, "B": 0, "C": -5}, 10, step=1)
        self.assertEqual(set(alloc_map(r)), {"A"})

    def test_no_requests_is_not_an_error(self):
        r = apportion({}, 50, step=10)
        self.assertEqual(r.allocations, ())
        self.assertEqual(r.distributed, 0)

    def test_a_zero_reduction_gives_nobody_anything(self):
        r = apportion({"A": 10}, 0, step=1)
        self.assertEqual(r.distributed, 0)

    def test_a_negative_reduction_is_treated_as_zero(self):
        r = apportion({"A": 10}, -5, step=1)
        self.assertEqual(r.distributed, 0)

    def test_a_non_positive_step_is_refused(self):
        # Silently defaulting would hide a configuration mistake.
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                apportion({"A": 10}, 10, step=bad)

    def test_fractional_steps_work(self):
        # Kg at 0.1 — 4.75 becomes 4.7 handed out, 0.05 left.
        r = apportion({"A": 10}, 4.75, step=0.1)
        self.assertAlmostEqual(r.distributed, 4.7)
        self.assertAlmostEqual(r.remainder, 0.05)


class TestDefaultSteps(unittest.TestCase):
    def test_measurable_units_get_practical_steps(self):
        self.assertEqual(default_step_for_uom("Gram"), 10.0)
        self.assertEqual(default_step_for_uom("ml"), 10.0)
        self.assertEqual(default_step_for_uom("Kg"), 0.1)
        self.assertEqual(default_step_for_uom("Litre"), 0.1)

    def test_it_is_case_and_space_insensitive(self):
        self.assertEqual(default_step_for_uom("  GRAM "), 10.0)

    def test_countable_and_unknown_units_are_handed_over_whole(self):
        # Whole units are the safe fallback: handing over one of something is
        # always possible, where a guessed fraction may be unmeasurable.
        self.assertEqual(default_step_for_uom("Bottle"), 1.0)
        self.assertEqual(default_step_for_uom("Nos"), 1.0)
        self.assertEqual(default_step_for_uom("Sachet"), 1.0)
        self.assertEqual(default_step_for_uom(None), 1.0)
        self.assertEqual(default_step_for_uom(""), 1.0)
