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


class TestCarryForward(unittest.TestCase):
    """Unused allocation carries forward as a per-farm credit.

    The invariant worth protecting is CONSERVATION: the credits must sum to the
    stock actually left in the general store. If they don't, the pool has no
    owner-by-owner explanation and the credits are just wishes.
    """

    def test_credits_sum_to_what_is_left_in_the_general_store(self):
        # 3 farms, awkward ratio, coarse step: guarantees a residue.
        reqs = {"A": 33, "B": 33, "C": 34}
        r = apportion(reqs, 100, step=10)
        self.assertAlmostEqual(
            sum(r.carried_forward.values()), r.remainder, places=7,
            msg="credits must account for exactly the leftover pool",
        )

    def test_a_farm_rounded_up_carries_a_debit(self):
        """Hamilton pays somebody ahead. Forgiving that would mint entitlement:
        the pool would owe more than it holds."""
        reqs = {"A": 10, "B": 10, "C": 10}
        r = apportion(reqs, 20, step=10)  # 2 steps for 3 farms
        got = [a for a in r.allocations if a.allocated > 0]
        self.assertEqual(len(got), 2)
        self.assertTrue(
            any(a.credit_out < 0 for a in got),
            "a farm given a spare step must carry a debit",
        )
        self.assertTrue(
            any(a.credit_out > 0 for a in r.allocations),
            "a farm that missed out must carry a credit",
        )

    def test_the_credit_is_added_to_the_next_cycles_basis(self):
        """The user's case: 0.4 owed to Farm A rides on its next request."""
        r = apportion({"A": 10, "B": 10}, 20, step=1, carried={"A": 0.4})
        by_farm = {a.farm: a for a in r.allocations}
        self.assertEqual(by_farm["A"].credit_in, 0.4)
        self.assertAlmostEqual(by_farm["A"].basis, 10.4)
        # 0.4 of a 1-unit step still isn't measurable, so it doesn't buy stock
        # yet — it must survive to the cycle after.
        self.assertGreater(r.carried_forward["A"], 0)

    def test_an_accumulated_credit_eventually_buys_a_whole_step(self):
        """Once the credit clears a step boundary it converts into real stock —
        the point of carrying it at all."""
        r = apportion({"A": 10, "B": 10}, 22, step=1, carried={"A": 1.5})
        by_farm = {a.farm: a.allocated for a in r.allocations}
        self.assertGreater(
            by_farm["A"], by_farm["B"],
            "a credit past one step must buy more stock than the plain request",
        )

    def test_a_budget_cut_is_not_a_credit(self):
        """Asked 10, budget allows 9 -> the missing 1 is a decision, not a debt.
        If cuts carried forward, a reduction would mean nothing next cycle."""
        r = apportion({f"F{i}": 10 for i in range(5)}, 45, step=1)
        self.assertEqual(set(alloc_map(r).values()), {9})
        self.assertEqual(
            r.carried_forward, {},
            "a clean proportional cut owes nobody anything",
        )

    def test_repeated_cycles_do_not_starve_the_same_farm(self):
        """Without carry-forward the small farm gets zero forever. With it, the
        credit accumulates until it clears a whole step."""
        reqs = {"Big": 95, "Small": 5}
        carried, small_got = {}, []
        for _ in range(6):
            r = apportion(reqs, 100, step=10, carried=carried)
            carried = r.carried_forward
            small_got.append({a.farm: a.allocated for a in r.allocations}.get("Small", 0))
        # Measured: the small farm is served every other cycle (0, 10, 0, 10 …)
        # instead of never, and the ledger clears itself each time it pays out.
        self.assertGreaterEqual(
            len([q for q in small_got if q > 0]), 2,
            f"the small farm must be served repeatedly, got {small_got}",
        )
        self.assertAlmostEqual(
            sum(small_got), 5 * len(small_got), places=6,
            msg="over several cycles the small farm must receive its true share",
        )

    def test_a_farm_that_sits_out_keeps_its_credit(self):
        r = apportion({"A": 10}, 10, step=1, carried={"B": 2.5})
        self.assertAlmostEqual(r.carried_forward.get("B", 0), 2.5)

    def test_a_debit_bigger_than_the_new_request_stays_outstanding(self):
        """Not forgiven, not made negative: it waits."""
        r = apportion({"A": 1, "B": 10}, 11, step=1, carried={"A": -4})
        by_farm = {a.farm: a for a in r.allocations}
        self.assertNotIn("A", by_farm, "a farm in net debit gets nothing")
        self.assertAlmostEqual(r.carried_forward["A"], -3.0)

    def test_a_sub_step_total_owes_everyone_their_share(self):
        r = apportion({"A": 10, "B": 30}, 7, step=10)
        self.assertEqual(r.allocations, ())
        self.assertAlmostEqual(sum(r.carried_forward.values()), 7, places=7)

    def test_float_dust_is_not_carried(self):
        r = apportion({"A": 10, "B": 10}, 20, step=1)
        self.assertEqual(r.carried_forward, {})

    def test_credits_never_over_allocate(self):
        """A big credit plus a request must still not exceed the stock on hand."""
        r = apportion({"A": 10, "B": 10}, 15, step=1, carried={"A": 50})
        self.assertLessEqual(r.distributed, 15)
