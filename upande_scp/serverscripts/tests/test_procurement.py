"""The procurement cycle: requirements → review → order → apportioned split.

What these protect, in order of how much damage getting them wrong would do:

* **A final figure is not changed.** Both the "no edit" guard and the
  re-consolidation path, because the second is the sneaky one — a settled number
  quietly moving when new requirements arrive.
* **Rejection routes through an amendment**, not free editing.
* **Every change is logged AND announced**, with the amount and the actor.
* **Credits carry between cycles** and reconcile with the pool.
* **A budget cut is not a debt.**

Runs against the live site: it creates its own farms, items and cycle, and cleans
them up. It does not submit stock movements — those need real stock, and the
apportionment maths is proved in `test_apportion` without a site.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_procurement
"""

import unittest

import frappe

from upande_scp.serverscripts.store import procurement as P

CYCLE_NAME = "_test_scp_cycle"
ITEM_A = "_test_scp_proc_a"
ITEM_B = "_test_scp_proc_b"
POOL_KEEPER = "_test_scp_pool_keeper@example.com"


def _company_with_farms():
    """A company that has a general store AND farms of its own.

    Not just any company: the first one alphabetically on this site is a fixture
    with neither, and a cycle there cannot raise a Material Request at all —
    which would look like a bug in the code rather than in the choice of company.
    """
    for company in frappe.get_all("Company", pluck="name"):
        if not P.general_store_for(company):
            continue
        farms = frappe.get_all(
            "Warehouse",
            filters={"company": company, "custom_farm": ("is", "set")},
            fields=["custom_farm"],
            distinct=True,
            limit_page_length=4,
        )
        names = sorted({f.custom_farm for f in farms if f.custom_farm})
        if len(names) >= 2:
            return company, names[:3]
    return None, []


class TestProcurement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.company, cls.farms = _company_with_farms()
        if not cls.company:
            raise unittest.SkipTest(
                "no company on this site has a general store and two farms"
            )

        group = frappe.db.get_value("Item Group", {"is_group": 0}, "name")
        for code in (ITEM_A, ITEM_B):
            if not frappe.db.exists("Item", code):
                frappe.get_doc({
                    "doctype": "Item", "item_code": code, "item_name": code,
                    "item_group": group, "stock_uom": "Gram", "is_stock_item": 1,
                }).insert(ignore_permissions=True)

        cls.cycle = P.create_cycle(
            CYCLE_NAME, cls.company, "2026-08-01", "2026-08-31"
        )
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        for dt, filters in (
            (P.CHANGE, {"cycle": cls.cycle}),
            (P.AMENDMENT, {"cycle": cls.cycle}),
            (P.REQUIREMENT, {"cycle": cls.cycle}),
            (P.CREDIT, {"item_code": ("in", [ITEM_A, ITEM_B])}),
        ):
            for name in frappe.get_all(dt, filters=filters, pluck="name"):
                frappe.delete_doc(dt, name, force=True, ignore_permissions=True)
        frappe.delete_doc(P.CYCLE, cls.cycle, force=True, ignore_permissions=True)
        for code in (ITEM_A, ITEM_B):
            if frappe.db.exists("Item", code):
                frappe.delete_doc("Item", code, force=True, ignore_permissions=True)
        frappe.db.commit()

    def setUp(self):
        """Reset the cycle between tests.

        They share one cycle (creating a farm set per test would be slower and no
        more honest), so `final_approved`, reductions and credits from one test
        would otherwise decide the next one's outcome.
        """
        frappe.set_user("Administrator")
        doc = frappe.get_doc(P.CYCLE, self.cycle)
        doc.lines = []
        doc.allocations = []
        doc.status = "Collecting"
        doc.material_request = None
        doc.save(ignore_permissions=True)
        for dt, filters in (
            (P.CREDIT, {"item_code": ("in", [ITEM_A, ITEM_B])}),
            (P.CHANGE, {"cycle": self.cycle}),
            (P.AMENDMENT, {"cycle": self.cycle}),
            (P.REQUIREMENT, {"cycle": self.cycle}),
        ):
            for name in frappe.get_all(dt, filters=filters, pluck="name"):
                frappe.delete_doc(dt, name, force=True, ignore_permissions=True)
        frappe.db.commit()

    # ─────────────────────────── helpers ────────────────────────────

    def _requirement(self, farm, items, approve=True):
        req = P.my_requirement(self.cycle, farm)
        P.save_requirement(req["name"], items)
        P.submit_requirement(req["name"])
        if approve:
            P.review_requirement(req["name"], "approve")
        return req["name"]

    def _fresh_requirements(self):
        """Two farms asking for ITEM_A, so consolidation has something to sum."""
        self._requirement(self.farms[0], [{"item_code": ITEM_A, "requested_qty": 30}])
        self._requirement(self.farms[1], [{"item_code": ITEM_A, "requested_qty": 70}])
        frappe.db.commit()

    # ───────────────────── requirements + review 1 ──────────────────

    def test_a_requirement_is_created_once_per_farm_and_cycle(self):
        a = P.my_requirement(self.cycle, self.farms[0])
        b = P.my_requirement(self.cycle, self.farms[0])
        self.assertEqual(a["name"], b["name"], "a second call must not fork a new draft")

    def test_an_empty_requirement_cannot_be_submitted(self):
        req = P.my_requirement(self.cycle, self.farms[0])
        P.save_requirement(req["name"], [])
        with self.assertRaises(frappe.ValidationError):
            P.submit_requirement(req["name"])

    def test_an_approved_requirement_cannot_be_edited_directly(self):
        """The core structural rule: past review, editing goes through amendment."""
        name = self._requirement(
            self.farms[0], [{"item_code": ITEM_A, "requested_qty": 10}]
        )
        with self.assertRaises(frappe.ValidationError) as cm:
            P.save_requirement(name, [{"item_code": ITEM_A, "requested_qty": 999}])
        self.assertIn("amendment", str(cm.exception).lower())

    def test_a_rejection_needs_a_reason(self):
        req = P.my_requirement(self.cycle, self.farms[1])
        P.save_requirement(req["name"], [{"item_code": ITEM_A, "requested_qty": 5}])
        P.submit_requirement(req["name"])
        with self.assertRaises(frappe.ValidationError):
            P.review_requirement(req["name"], "reject")
        out = P.review_requirement(req["name"], "reject", "too much for the block")
        self.assertEqual(out["status"], "Rejected")
        self.assertEqual(out["rejection_reason"], "too much for the block")

    # ─────────────────────────── amendments ─────────────────────────

    def test_a_granted_amendment_applies_the_figure_and_logs_it(self):
        name = self._requirement(
            self.farms[0], [{"item_code": ITEM_A, "requested_qty": 40}]
        )
        amd = P.request_amendment(
            name,
            [{"item_code": ITEM_A, "proposed_qty": 25}],
            "block was replanted, needs less",
        )
        self.assertEqual(
            frappe.db.get_value(P.REQUIREMENT, name, "status"), "Amendment Requested"
        )
        P.decide_amendment(amd, "grant")

        row = frappe.db.get_value(
            "Chemical Purchase Requirement Item",
            {"parent": name, "item_code": ITEM_A}, "requested_qty",
        )
        self.assertEqual(row, 25)
        # A granted amendment goes back for review 1 rather than to Draft: the
        # numbers are settled, what's needed is the confirmation.
        self.assertEqual(frappe.db.get_value(P.REQUIREMENT, name, "status"), "Submitted")

        change = frappe.get_all(
            P.CHANGE,
            filters={"cycle": self.cycle, "item_code": ITEM_A,
                     "what": "Amendment Granted"},
            fields=["qty_from", "qty_to", "changed_by"],
        )
        self.assertTrue(change, "granting an amendment must leave an audit row")
        self.assertEqual((change[-1].qty_from, change[-1].qty_to), (40.0, 25.0))

    def test_an_amendment_is_decided_once(self):
        name = self._requirement(
            self.farms[1], [{"item_code": ITEM_A, "requested_qty": 12}]
        )
        amd = P.request_amendment(
            name, [{"item_code": ITEM_A, "proposed_qty": 8}], "less"
        )
        P.decide_amendment(amd, "decline", "keep the original")
        with self.assertRaises(frappe.ValidationError):
            P.decide_amendment(amd, "grant")

    def test_an_amendment_needs_a_reason_and_a_line(self):
        name = self._requirement(
            self.farms[0], [{"item_code": ITEM_A, "requested_qty": 3}]
        )
        with self.assertRaises(frappe.ValidationError):
            P.request_amendment(name, [{"item_code": ITEM_A, "proposed_qty": 1}], "")
        with self.assertRaises(frappe.ValidationError):
            P.request_amendment(name, [], "because")

    # ─────────────────── consolidation + the reduction ──────────────

    def test_consolidation_sums_only_approved_requirements(self):
        self._fresh_requirements()
        # A third farm's draft must not count towards the budget.
        if len(self.farms) > 2:
            draft = P.my_requirement(self.cycle, self.farms[2])
            P.save_requirement(draft["name"], [{"item_code": ITEM_A, "requested_qty": 500}])

        cycle = P.consolidate(self.cycle)
        line = next(l for l in cycle["lines"] if l["item_code"] == ITEM_A)
        self.assertEqual(line["total_requested"], 100)
        self.assertEqual(line["approved_qty"], 100, "no reduction means no change")

    def test_both_reduction_modes_resolve_to_a_quantity(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)

        cycle = P.set_reduction(self.cycle, ITEM_A, "Absolute", 80)
        line = next(l for l in cycle["lines"] if l["item_code"] == ITEM_A)
        self.assertEqual(line["approved_qty"], 80)

        cycle = P.set_reduction(self.cycle, ITEM_A, "Percentage", 25)
        line = next(l for l in cycle["lines"] if l["item_code"] == ITEM_A)
        self.assertEqual(line["approved_qty"], 75, "25% off 100")

    def test_a_reduction_cannot_exceed_the_request(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        cycle = P.set_reduction(self.cycle, ITEM_A, "Absolute", 5000)
        line = next(l for l in cycle["lines"] if l["item_code"] == ITEM_A)
        self.assertEqual(
            line["approved_qty"], 100,
            "approving more than anybody asked for is not a reduction",
        )

    def test_a_reduction_notifies_every_affected_farms_planners(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        before = frappe.db.count(P.CHANGE, {"cycle": self.cycle, "what": "Approved Total"})
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 60, reason="budget")
        rows = frappe.get_all(
            P.CHANGE,
            filters={"cycle": self.cycle, "what": "Approved Total"},
            fields=["farm", "qty_from", "qty_to", "reason", "changed_by"],
        )
        self.assertGreater(len(rows), before)
        recent = [r for r in rows if r.qty_to == 60]
        self.assertEqual(
            {r.farm for r in recent}, set(self.farms[:2]),
            "both requesting farms must be told",
        )
        self.assertTrue(all(r.reason == "budget" for r in recent))
        self.assertTrue(all(r.changed_by for r in recent), "a change needs an author")

    def test_a_final_figure_is_locked(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 90)
        P.finalise_line(self.cycle, ITEM_A)
        with self.assertRaises(frappe.ValidationError) as cm:
            P.set_reduction(self.cycle, ITEM_A, "Absolute", 10)
        self.assertIn("final", str(cm.exception).lower())

    def test_reconsolidating_does_not_move_a_final_figure(self):
        """The subtle one: new requirements arrive and the settled number holds."""
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 90)
        P.finalise_line(self.cycle, ITEM_A)

        # A third farm's approved requirement raises the total.
        if len(self.farms) > 2:
            self._requirement(
                self.farms[2], [{"item_code": ITEM_A, "requested_qty": 400}]
            )
        cycle = P.consolidate(self.cycle)
        line = next(l for l in cycle["lines"] if l["item_code"] == ITEM_A)
        self.assertEqual(line["approved_qty"], 90, "a final figure must not drift")
        self.assertTrue(line["final_approved"])
        if len(self.farms) > 2:
            self.assertEqual(
                line["total_requested"], 500,
                "the request total must still refresh, so the GM can see it moved",
            )

    # ───────────────────── allocation + credits ─────────────────────

    def test_the_preview_splits_by_request_and_writes_nothing(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 100)

        out = P.preview_allocation(self.cycle)
        line = next(l for l in out["lines"] if l["item_code"] == ITEM_A)
        got = {a["farm"]: a["allocated"] for a in line["allocations"]}
        self.assertEqual(got.get(self.farms[1]), 70)
        self.assertEqual(got.get(self.farms[0]), 30)
        self.assertEqual(
            frappe.db.count(P.CREDIT, {"item_code": ITEM_A}), 0,
            "a preview must not write credits",
        )

    def test_publishing_writes_credits_that_reconcile_with_the_pool(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        # 33 with a 10g step: 3 whole steps to split between a 30/70 ask, so
        # there is a real residue to carry.
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 33)
        P.publish_allocation(self.cycle)

        cycle = P.get_cycle(self.cycle)
        line = next(l for l in cycle["lines"] if l["item_code"] == ITEM_A)
        credits = frappe.get_all(
            P.CREDIT, filters={"item_code": ITEM_A}, fields=["farm", "credit_qty"]
        )
        self.assertTrue(credits, "an unmeasurable residue must be carried")
        self.assertAlmostEqual(
            sum(c.credit_qty for c in credits), line["remainder"], places=6,
            msg="the credits must account for exactly what is left in the pool",
        )

    def test_a_carried_credit_is_spent_in_the_next_cycle(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 33)
        P.publish_allocation(self.cycle)
        carried = P.credits_for(ITEM_A)
        self.assertTrue(carried)

        second = P.preview_allocation(self.cycle, received={ITEM_A: 100})
        line = next(l for l in second["lines"] if l["item_code"] == ITEM_A)
        by_farm = {a["farm"]: a for a in line["allocations"]}
        for farm, credit in carried.items():
            if farm in by_farm:
                self.assertAlmostEqual(
                    by_farm[farm]["credit_in"], credit, places=6,
                    msg="the next split must start from the carried credit",
                )

    def test_a_budget_cut_is_not_carried_as_a_debt(self):
        """The credit is the ROUNDING residue, never the size of the cut.

        30/70 cut from 100 to 50 with a 10 g step: shares are 15 and 35, which
        round to 10 and 40. The farm asking 30 lost 15 g to the budget and a
        further 5 g to the step — only the 5 is owed. Crediting the 15 would make
        the reduction meaningless next cycle.
        """
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 50)
        P.publish_allocation(self.cycle)

        carried = P.credits_for(ITEM_A)
        small, big = self.farms[0], self.farms[1]
        self.assertAlmostEqual(carried.get(small, 0.0), 5.0, places=6)
        self.assertAlmostEqual(carried.get(big, 0.0), -5.0, places=6)
        step = 10.0
        for farm, qty in carried.items():
            self.assertLess(
                abs(qty), step,
                f"{farm} carries {qty}, which is more than one step — that is a "
                "cut being repaid, not a rounding residue",
            )

    def test_publishing_logs_each_allocation(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 100)
        P.publish_allocation(self.cycle)
        rows = frappe.get_all(
            P.CHANGE,
            filters={"cycle": self.cycle, "what": "Allocation", "item_code": ITEM_A},
            fields=["farm", "qty_to"],
        )
        self.assertEqual({r.farm for r in rows}, set(self.farms[:2]))

    def test_the_pool_view_pairs_stock_with_who_is_owed_it(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 33)
        P.publish_allocation(self.cycle)
        pool = P.pool_status(self.company)
        self.assertIn("credits", pool)
        self.assertTrue(
            any(c["item_code"] == ITEM_A for c in pool["credits"]),
            "the keeper must be able to see what the pool owes",
        )

    # ───────────────────────── permissions ─────────────────────────

    def test_only_the_gm_consolidates_reduces_and_publishes(self):
        # Iterate rather than taking the first planner: several of them also hold
        # System Manager, and testing a refusal against an elevated user would
        # prove nothing.
        user = None
        for candidate in frappe.get_all(
            "Has Role",
            filters={"role": "SCP Spray Plan Creator", "parenttype": "User"},
            pluck="parent",
            limit_page_length=60,
        ):
            if candidate == "Administrator":
                continue
            if set(frappe.get_roles(candidate)) & P.ELEVATED:
                continue
            user = candidate
            break
        if not user:
            self.skipTest("every planner on this site is also elevated")

        frappe.set_user(user)
        try:
            for fn, args in (
                (P.consolidate, (self.cycle,)),
                (P.set_reduction, (self.cycle, ITEM_A, "Absolute", 1)),
                (P.finalise_line, (self.cycle, ITEM_A)),
                (P.publish_allocation, (self.cycle,)),
            ):
                with self.assertRaises(frappe.PermissionError):
                    fn(*args)
        finally:
            frappe.set_user("Administrator")

    def test_the_material_request_is_raised_once(self):
        self._fresh_requirements()
        P.consolidate(self.cycle)
        P.set_reduction(self.cycle, ITEM_A, "Absolute", 40)
        mr = None
        try:
            mr = P.create_material_request(self.cycle)
            self.assertTrue(frappe.db.exists("Material Request", mr))
            self.assertEqual(
                frappe.db.get_value("Material Request", mr, "docstatus"), 0,
                "the MR must be left as a draft for purchasing to submit",
            )
            self.assertEqual(
                frappe.db.count("Material Request Item", {"parent": mr}), 1,
                "one consolidated request, one line per chemical",
            )
            with self.assertRaises(frappe.ValidationError) as cm:
                P.create_material_request(self.cycle)
            self.assertIn("already", str(cm.exception).lower())
        finally:
            if mr and frappe.db.exists("Material Request", mr):
                frappe.delete_doc("Material Request", mr, force=True, ignore_permissions=True)
            frappe.db.set_value(P.CYCLE, self.cycle, "material_request", None)
            frappe.db.commit()


class TestPoolRequests(unittest.TestCase):
    """Drawing on the general store's shared pool.

    The one that matters is reservation: two planners must not both be approved
    for the same last kilo, because the keeper has already said yes by the time
    the stock ledger objects.
    """

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cls.company, cls.farms = _company_with_farms()
        if not cls.company:
            raise unittest.SkipTest("no company with a general store and two farms")
        cls.store = P.general_store_for(cls.company)
        group = frappe.db.get_value("Item Group", {"is_group": 0}, "name")
        if not frappe.db.exists("Item", ITEM_B):
            frappe.get_doc({
                "doctype": "Item", "item_code": ITEM_B, "item_name": ITEM_B,
                "item_group": group, "stock_uom": "Gram", "is_stock_item": 1,
            }).insert(ignore_permissions=True)
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        cls._clear()
        if frappe.db.exists("Item", ITEM_B):
            frappe.delete_doc("Item", ITEM_B, force=True, ignore_permissions=True)
        if frappe.db.exists("User", POOL_KEEPER):
            frappe.delete_doc("User", POOL_KEEPER, force=True, ignore_permissions=True)
        frappe.db.commit()

    @classmethod
    def _clear(cls):
        for name in frappe.get_all(
            P.TRANSFER_REQUEST,
            filters={"from_general_store": 1, "requesting_farm": ("in", cls.farms)},
            pluck="name",
        ):
            frappe.delete_doc(P.TRANSFER_REQUEST, name, force=True, ignore_permissions=True)
        frappe.db.commit()

    def setUp(self):
        frappe.set_user("Administrator")
        self._clear()

    def test_a_request_names_the_pool_and_not_a_lender_farm(self):
        out = P.request_from_pool(
            self.farms[0], [{"item_code": ITEM_B, "requested_qty": 5}], "short this week"
        )
        doc = frappe.get_doc(P.TRANSFER_REQUEST, out["name"])
        self.assertTrue(doc.from_general_store)
        self.assertEqual(doc.lender_warehouse, self.store)
        self.assertFalse(doc.lender_farm, "a pool draw has no lender farm")
        self.assertEqual(doc.workflow_state, "Pending Approval")

    def test_asking_for_more_than_the_pool_holds_is_reported_not_refused(self):
        """The keeper may know stock is arriving; a planner should be able to ask."""
        out = P.request_from_pool(
            self.farms[0], [{"item_code": ITEM_B, "requested_qty": 10 ** 6}]
        )
        self.assertIn(ITEM_B, out["over_available"])
        self.assertTrue(frappe.db.exists(P.TRANSFER_REQUEST, out["name"]))

    def test_an_empty_request_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            P.request_from_pool(self.farms[0], [])

    def test_approved_but_unmoved_stock_is_reserved_against_the_next_request(self):
        """Set up an approved line by hand (no real stock to move), then check the
        availability arithmetic sees it."""
        out = P.request_from_pool(
            self.farms[0], [{"item_code": ITEM_B, "requested_qty": 4}]
        )
        doc = frappe.get_doc(P.TRANSFER_REQUEST, out["name"])
        doc.items[0].status = "Approved"
        doc.items[0].approved_qty = 4
        doc.flags.ignore_mandatory = True
        doc.save(ignore_permissions=True)
        frappe.db.commit()

        self.assertEqual(
            P._reserved_from_pool(self.store, ITEM_B), 4.0,
            "an approved, unmoved line must count as promised",
        )
        # A second request now sees less available than raw on-hand.
        avail = P.pool_availability(self.company, [ITEM_B])["items"][ITEM_B]
        self.assertEqual(avail["reserved"], 4.0)
        self.assertAlmostEqual(avail["available"], avail["on_hand"] - 4.0)

    def test_a_transferred_line_stops_being_reserved(self):
        """Once the stock has actually moved it is out of the pool, and counting it
        as promised as well would hide it twice."""
        out = P.request_from_pool(
            self.farms[0], [{"item_code": ITEM_B, "requested_qty": 4}]
        )
        doc = frappe.get_doc(P.TRANSFER_REQUEST, out["name"])
        doc.items[0].status = "Approved"
        doc.items[0].approved_qty = 4
        doc.flags.ignore_mandatory = True
        doc.save(ignore_permissions=True)
        # Stamped straight onto the row: the point is the availability query, and
        # borrowing a real Stock Entry would tie the test to this site's stock.
        se = frappe.db.get_value("Stock Entry", {"docstatus": 1}, "name")
        if not se:
            self.skipTest("no submitted Stock Entry on this site to reference")
        frappe.db.set_value(
            "Chemical Transfer Request Item", doc.items[0].name, "stock_entry", se,
            update_modified=False,
        )
        frappe.db.commit()
        self.assertEqual(P._reserved_from_pool(self.store, ITEM_B), 0.0)

    def test_only_the_stores_keeper_decides(self):
        out = P.request_from_pool(
            self.farms[0], [{"item_code": ITEM_B, "requested_qty": 1}]
        )
        user = None
        for candidate in frappe.get_all(
            "Has Role",
            filters={"role": "SCP Spray Plan Creator", "parenttype": "User"},
            pluck="parent", limit_page_length=60,
        ):
            if candidate == "Administrator":
                continue
            if set(frappe.get_roles(candidate)) & P.ELEVATED:
                continue
            if frappe.db.exists("Farm Store Keeper", {"warehouse": self.store,
                                                      "user": candidate}):
                continue
            user = candidate
            break
        if not user:
            self.skipTest("no planner who is not also the general store keeper")

        frappe.set_user(user)
        try:
            with self.assertRaises(frappe.PermissionError):
                P.decide_pool_request(
                    out["name"], [{"item_code": ITEM_B, "status": "Approved"}]
                )
        finally:
            frappe.set_user("Administrator")

    def test_approving_more_than_is_free_is_refused(self):
        first = P.request_from_pool(
            self.farms[0], [{"item_code": ITEM_B, "requested_qty": 3}]
        )
        doc = frappe.get_doc(P.TRANSFER_REQUEST, first["name"])
        doc.items[0].status = "Approved"
        doc.items[0].approved_qty = 3
        doc.flags.ignore_mandatory = True
        doc.save(ignore_permissions=True)

        second = P.request_from_pool(
            self.farms[1], [{"item_code": ITEM_B, "requested_qty": 3}]
        )
        frappe.db.commit()
        with self.assertRaises(frappe.ValidationError) as cm:
            P.decide_pool_request(
                second["name"], [{"item_code": ITEM_B, "status": "Approved"}]
            )
        self.assertIn("promised", str(cm.exception).lower())

    def test_rejecting_every_line_rejects_the_request(self):
        out = P.request_from_pool(
            self.farms[0], [{"item_code": ITEM_B, "requested_qty": 2}]
        )
        res = P.decide_pool_request(
            out["name"],
            [{"item_code": ITEM_B, "status": "Rejected"}],
            reason="keeping it for the sprayers",
        )
        self.assertEqual(res["state"], "Rejected")
        self.assertEqual(
            frappe.db.get_value(P.TRANSFER_REQUEST, out["name"], "rejected_reason"),
            "keeping it for the sprayers",
        )

    def test_a_pool_request_is_visible_to_the_general_store_keeper(self):
        """Row-level visibility: the keeper has no lender farm to match on.

        A keeper row is created for the test rather than skipping when the site has
        none — nobody keeps the general store on kaitet yet, and skipping would
        leave the clause that makes pool requests visible completely unproven.
        """
        from upande_scp.serverscripts.spray_plan_creator import loaning_v2 as L

        # Both real store keepers on kaitet also hold System Manager, and an
        # elevated user short-circuits the query to "" — which would prove nothing.
        # So the test brings its own plain user.
        user = POOL_KEEPER
        if not frappe.db.exists("User", user):
            frappe.get_doc({
                "doctype": "User", "email": user, "first_name": "scp-pool-keeper",
                "send_welcome_email": 0, "enabled": 1,
            }).insert(ignore_permissions=True)
            frappe.db.commit()

        existing = frappe.db.exists(
            "Farm Store Keeper", {"warehouse": self.store, "user": user}
        )
        row = None
        if not existing:
            row = frappe.get_doc({
                "doctype": "Farm Store Keeper",
                "parent": "Scouting and Crop Protection Settings",
                "parenttype": "Scouting and Crop Protection Settings",
                "parentfield": "general_store_keepers",
                "user": user,
                "warehouse": self.store,
            })
            row.flags.ignore_links = True
            row.insert(ignore_permissions=True)
            frappe.db.commit()
        try:
            clause = L.permission_query(user)
            self.assertIn("from_general_store", clause)
            self.assertIn(self.store, clause)
            self.assertTrue(
                P._keeper_of(self.store, user),
                "the keeper of the store must be recognised as its decider",
            )
        finally:
            if row:
                frappe.delete_doc(
                    "Farm Store Keeper", row.name, force=True, ignore_permissions=True
                )
                frappe.db.commit()
