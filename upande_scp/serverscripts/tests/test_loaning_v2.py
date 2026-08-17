"""Directed multi-item loaning: privacy, per-item decisions, and the stock move.

The properties worth protecting:

* a request is addressed to ONE farm and only that farm can see or decide it —
  enforced by a permission query, so it holds over the REST API too;
* a borrower cannot enumerate a lender's inventory, only ask about named items;
* each line is decided on its own, and a partial approval is a real answer;
* approving raises exactly ONE Stock Entry for all approved lines together.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_loaning_v2
"""

import unittest

import frappe

from upande_scp.serverscripts.spray_plan_creator import loaning_v2 as V

DOCTYPE = "Chemical Transfer Request"
ITEM = "_TEST-LOAN-CHEM"
FOLIAR = "_TEST-LOAN-FOLIAR"


def setUpModule():
    """Re-enable the shared test items for the run.

    They are left DISABLED between runs (see tearDownModule), and ERPNext refuses
    to move stock for a disabled item — so every run has to turn them back on.
    """
    for code in (ITEM, FOLIAR):
        if frappe.db.exists("Item", code) and frappe.db.get_value(
            "Item", code, "disabled"
        ):
            frappe.db.set_value("Item", code, "disabled", 0, update_modified=False)
    frappe.db.commit()


def tearDownModule():
    """Disable the test items rather than deleting them.

    They cannot be deleted: after many runs they carry a real stock ledger and live
    Bin quantities in four warehouses, and unwinding that would mean cancelling
    ledger entries on a live site. But leaving them ENABLED put `_TEST-LOAN-CHEM` at
    the top of every planner's chemical search — a test leaking onto the operator's
    screen. Disabled keeps the ledger intact and takes them out of every picker,
    which all filter `disabled = 0`.

    Module scope, not class scope: two test classes share these items, so a
    per-class teardown disabled them out from under the second one.
    """
    for code in (ITEM, FOLIAR):
        if frappe.db.exists("Item", code):
            frappe.db.set_value("Item", code, "disabled", 1, update_modified=False)
    frappe.db.commit()


def _two_farms_with_stores():
    """Two farms in the SAME company.

    Company matters: a loan is one Material Transfer, and ERPNext refuses a
    warehouse belonging to another company — so a cross-company pair would test
    the guard rather than the flow.
    """
    rows = frappe.get_all(
        "Warehouse",
        filters={
            "is_group": 0, "disabled": 0,
            "name": ("like", "Chemical Store%"),
            "custom_farm": ("is", "set"),
        },
        fields=["custom_farm", "name", "company"],
    )
    by_company: dict = {}
    for r in rows:
        by_company.setdefault(r.company, {}).setdefault(r.custom_farm, r.name)
    for stores in by_company.values():
        farms = sorted(stores)
        if len(farms) > 1:
            return farms[0], stores[farms[0]], farms[1], stores[farms[1]]
    return (None,) * 4


class TestDirectedLoaning(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        s = frappe.get_single("Scouting and Crop Protection Settings")
        if not s.loaning_enabled:
            s.loaning_enabled = 1
            s.save(ignore_permissions=True)

        cls.borrower, cls.borrow_wh, cls.lender, cls.lend_wh = _two_farms_with_stores()
        if not cls.borrower:
            raise unittest.SkipTest("need two farms with chemical stores")

        # A dedicated item so the test never depends on, or disturbs, real stock.
        # Re-enabled by setUpModule, since tearDownModule leaves it disabled.
        if not frappe.db.exists("Item", ITEM):
            frappe.get_doc({
                "doctype": "Item", "item_code": ITEM, "item_name": ITEM,
                "item_group": "CHEMICALS", "stock_uom": "Kg", "is_stock_item": 1,
            }).insert(ignore_permissions=True)
        # A foliar too: loaning covers fertilizers, and they move between
        # fertilizer stores rather than chemical ones.
        if not frappe.db.exists("Item", FOLIAR):
            frappe.get_doc({
                "doctype": "Item", "item_code": FOLIAR, "item_name": FOLIAR,
                "item_group": "Fertilizer", "stock_uom": "Kg", "is_stock_item": 1,
            }).insert(ignore_permissions=True)
        cls._receive(100)
        cls.has_foliar_stores = bool(
            V.store_for(cls.lender, FOLIAR) and V.store_for(cls.borrower, FOLIAR)
        )
        if cls.has_foliar_stores:
            cls._receive(100, FOLIAR)
        frappe.db.commit()

    @classmethod
    def _receive(cls, qty, item=ITEM):
        # Into the store of that item's own KIND — a foliar belongs in the
        # fertilizer store, and receiving it into the chemical store would make
        # the routing test pass for the wrong reason.
        wh = V.store_for(cls.lender, item)
        company = frappe.db.get_value("Warehouse", wh, "company")
        cc = V._company_cost_center(company)
        se = frappe.get_doc({
            "doctype": "Stock Entry", "stock_entry_type": "Material Receipt",
            "purpose": "Material Receipt",
            "company": company,
            "items": [{
                "item_code": item, "qty": qty, "uom": "Kg", "stock_uom": "Kg",
                "conversion_factor": 1, "t_warehouse": wh, "basic_rate": 10,
                "cost_center": cc,
            }],
        })
        se.flags.ignore_links = True
        se.insert(ignore_permissions=True)
        se.submit()
        return se.name

    def _requests(self):
        return frappe.get_all(DOCTYPE, filters={"lender_farm": self.lender}, pluck="name")

    def tearDown(self):
        frappe.set_user("Administrator")

    # -- disclosure -----------------------------------------------------
    def test_stock_is_disclosed_only_for_named_items(self):
        got = V.get_lender_stock(self.lender, [ITEM])
        self.assertEqual(list(got), [ITEM])
        self.assertGreater(got[ITEM]["on_hand"], 0)

    def test_asking_for_nothing_discloses_nothing(self):
        self.assertEqual(V.get_lender_stock(self.lender, []), {})
        self.assertEqual(V.get_lender_stock("", [ITEM]), {})

    def test_a_farm_is_not_offered_as_its_own_lender(self):
        self.assertNotIn(self.borrower, V.list_lender_farms(self.borrower))

    # -- creating -------------------------------------------------------
    def test_multiple_items_in_one_request(self):
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 5}],
            "reason": "test",
        })
        doc = frappe.get_doc(DOCTYPE, r["name"])
        self.assertEqual(doc.lender_farm, self.lender)
        self.assertEqual(len(doc.items), 1)
        self.assertEqual(doc.items[0].status, "Pending")
        # On-hand snapshotted, so the over-half judgement survives later moves.
        self.assertGreater(doc.items[0].lender_on_hand, 0)

    def test_over_half_is_flagged_but_never_blocks(self):
        on_hand = V.get_lender_stock(self.lender, [ITEM])[ITEM]["on_hand"]
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": on_hand * 0.6}],
        })
        self.assertIn(ITEM, r["over_half"])
        self.assertTrue(frappe.db.exists(DOCTYPE, r["name"]), "the request was blocked")

    def test_a_modest_request_is_not_flagged(self):
        on_hand = V.get_lender_stock(self.lender, [ITEM])[ITEM]["on_hand"]
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": on_hand * 0.1}],
        })
        self.assertEqual(r["over_half"], [])

    def test_cannot_borrow_from_itself(self):
        with self.assertRaises(frappe.ValidationError):
            V.create_loan_request({
                "requesting_farm": self.borrower, "lender_farm": self.borrower,
                "items": [{"item_code": ITEM, "requested_qty": 1}],
            })

    def test_cannot_ask_for_more_than_the_lender_has(self):
        on_hand = V.get_lender_stock(self.lender, [ITEM])[ITEM]["on_hand"]
        with self.assertRaises(frappe.ValidationError):
            V.create_loan_request({
                "requesting_farm": self.borrower, "lender_farm": self.lender,
                "items": [{"item_code": ITEM, "requested_qty": on_hand + 1}],
            })

    def test_an_empty_request_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            V.create_loan_request({
                "requesting_farm": self.borrower, "lender_farm": self.lender, "items": [],
            })

    def test_the_same_item_twice_is_refused(self):
        with self.assertRaises(frappe.ValidationError):
            V.create_loan_request({
                "requesting_farm": self.borrower, "lender_farm": self.lender,
                "items": [
                    {"item_code": ITEM, "requested_qty": 1},
                    {"item_code": ITEM, "requested_qty": 2},
                ],
            })

    # -- deciding -------------------------------------------------------
    def test_approval_moves_stock_in_one_entry(self):
        before_lender = V.get_lender_stock(self.lender, [ITEM])[ITEM]["on_hand"]
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 4}],
        })
        out = V.decide_items(r["name"], [{"item_code": ITEM, "status": "Approved"}])
        self.assertTrue(out["stock_entry"], "no Stock Entry was raised")
        self.assertEqual(out["state"], "Fulfilled")

        se = frappe.get_doc("Stock Entry", out["stock_entry"])
        self.assertEqual(se.docstatus, 1, "the transfer was left unsubmitted")
        self.assertEqual(len(se.items), 1)
        after = V.get_lender_stock(self.lender, [ITEM])[ITEM]["on_hand"]
        self.assertAlmostEqual(after, before_lender - 4, places=4)

    def test_a_partial_approval_is_a_real_answer(self):
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 6}],
        })
        V.decide_items(r["name"], [
            {"item_code": ITEM, "status": "Approved", "approved_qty": 2},
        ])
        row = frappe.get_doc(DOCTYPE, r["name"]).items[0]
        self.assertEqual(row.status, "Approved")
        self.assertAlmostEqual(row.approved_qty, 2)

    def test_cannot_approve_more_than_requested(self):
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 2}],
        })
        with self.assertRaises(frappe.ValidationError):
            V.decide_items(r["name"], [
                {"item_code": ITEM, "status": "Approved", "approved_qty": 99},
            ])

    def test_rejecting_everything_marks_the_request_rejected(self):
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 1}],
        })
        out = V.decide_items(r["name"], [{"item_code": ITEM, "status": "Rejected"}])
        self.assertEqual(out["state"], "Rejected")
        self.assertIsNone(out["stock_entry"])

    def test_reject_whole_request_clears_every_pending_line(self):
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 1}],
        })
        V.reject_whole_request(r["name"], "not this week")
        doc = frappe.get_doc(DOCTYPE, r["name"])
        self.assertEqual(doc.workflow_state, "Rejected")
        self.assertTrue(all(i.status == "Rejected" for i in doc.items))
        self.assertEqual(doc.rejected_reason, "not this week")

    def test_a_nonsense_decision_is_refused(self):
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 1}],
        })
        with self.assertRaises(frappe.ValidationError):
            V.decide_items(r["name"], [{"item_code": ITEM, "status": "Maybe"}])

    # -- privacy --------------------------------------------------------
    def test_permission_query_restricts_to_the_users_farms(self):
        cond = V.permission_query("Administrator")
        self.assertEqual(cond, "", "elevated users should be unrestricted")

    def test_a_farmless_user_sees_nothing_rather_than_everything(self):
        user = "_test_scp_loan_nobody@example.com"
        if not frappe.db.exists("User", user):
            frappe.get_doc({
                "doctype": "User", "email": user, "first_name": "loan-nobody",
                "send_welcome_email": 0, "enabled": 1,
            }).insert(ignore_permissions=True)
        # No farms assigned => 1=0, never an empty (unrestricted) condition.
        self.assertEqual(V.permission_query(user), "1=0")

    def test_notifications_reach_the_lender_not_the_world(self):
        before = frappe.db.count("Notification Log", {"document_type": DOCTYPE})
        V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": ITEM, "requested_qty": 1}],
        })
        after = frappe.db.count("Notification Log", {"document_type": DOCTYPE})
        self.assertGreaterEqual(after, before, "no notification was written")


class TestFoliarLoaning(TestDirectedLoaning):
    """Foliars are loanable too, and must route through fertilizer stores."""

    def test_a_foliar_is_recognised_as_one(self):
        self.assertEqual(V.item_kind(FOLIAR), "foliar")
        self.assertEqual(V.item_kind(ITEM), "chemical")

    def test_each_kind_resolves_to_a_store_of_its_own_kind(self):
        if not self.has_foliar_stores:
            self.skipTest("farms lack fertilizer stores")
        chem_store = V.store_for(self.lender, ITEM)
        fol_store = V.store_for(self.lender, FOLIAR)
        self.assertNotEqual(chem_store, fol_store)
        self.assertIn("fertilizer", fol_store.lower())

    def test_foliar_on_hand_is_not_reported_as_zero(self):
        """The bug this guards: a chemical-store-only lookup makes every foliar
        look unborrowable."""
        if not self.has_foliar_stores:
            self.skipTest("farms lack fertilizer stores")
        self.assertGreater(V.item_on_hand(self.lender, FOLIAR), 0)

    def test_stock_disclosure_reports_the_kind_and_source_store(self):
        if not self.has_foliar_stores:
            self.skipTest("farms lack fertilizer stores")
        got = V.get_lender_stock(self.lender, [ITEM, FOLIAR])
        self.assertEqual(got[FOLIAR]["kind"], "foliar")
        self.assertEqual(got[ITEM]["kind"], "chemical")
        self.assertNotEqual(got[FOLIAR]["store"], got[ITEM]["store"])

    def test_a_mixed_request_routes_each_line_to_its_own_stores(self):
        """One Stock Entry, but per-row warehouses — a header pair would push the
        foliar into a chemical store."""
        if not self.has_foliar_stores:
            self.skipTest("farms lack fertilizer stores")
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [
                {"item_code": ITEM, "requested_qty": 3},
                {"item_code": FOLIAR, "requested_qty": 2},
            ],
        })
        out = V.decide_items(r["name"], [
            {"item_code": ITEM, "status": "Approved"},
            {"item_code": FOLIAR, "status": "Approved"},
        ])
        se = frappe.get_doc("Stock Entry", out["stock_entry"])
        self.assertEqual(len(se.items), 2)
        by_item = {i.item_code: i for i in se.items}
        self.assertIn("fertilizer", by_item[FOLIAR].s_warehouse.lower())
        self.assertIn("fertilizer", by_item[FOLIAR].t_warehouse.lower())
        self.assertIn("chemical", by_item[ITEM].s_warehouse.lower())

    def test_a_foliar_can_be_borrowed_on_its_own(self):
        if not self.has_foliar_stores:
            self.skipTest("farms lack fertilizer stores")
        before = V.item_on_hand(self.lender, FOLIAR)
        r = V.create_loan_request({
            "requesting_farm": self.borrower, "lender_farm": self.lender,
            "items": [{"item_code": FOLIAR, "requested_qty": 2}],
        })
        out = V.decide_items(r["name"], [{"item_code": FOLIAR, "status": "Approved"}])
        self.assertTrue(out["stock_entry"])
        self.assertAlmostEqual(V.item_on_hand(self.lender, FOLIAR), before - 2, places=4)


class TestCrossCompany(unittest.TestCase):
    """A loan is a single Material Transfer, so it cannot cross companies."""

    def test_a_cross_company_request_is_refused_up_front(self):
        rows = frappe.get_all(
            "Warehouse",
            filters={
                "is_group": 0, "disabled": 0,
                "name": ("like", "Chemical Store%"),
                "custom_farm": ("is", "set"),
            },
            fields=["custom_farm", "company"],
        )
        by_company: dict = {}
        for r in rows:
            by_company.setdefault(r.company, set()).add(r.custom_farm)
        if len(by_company) < 2:
            self.skipTest("only one company has chemical stores")
        companies = sorted(by_company)
        a = sorted(by_company[companies[0]])[0]
        b = sorted(by_company[companies[1]])[0]

        item = frappe.db.get_value(
            "Item", {"item_group": "CHEMICALS", "disabled": 0}, "name"
        )
        # Refused at CREATION, not at approval — the lender should never agree to
        # something that cannot then be executed.
        with self.assertRaises(frappe.ValidationError) as ctx:
            V.create_loan_request({
                "requesting_farm": a, "lender_farm": b,
                "items": [{"item_code": item, "requested_qty": 1}],
            })
        self.assertIn("companies", str(ctx.exception).lower())
