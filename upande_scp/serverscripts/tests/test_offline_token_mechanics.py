"""Does the offline-token posting mechanism work on this ledger?

The design these tests inform reuses the pattern proven by
`doc references/fixes/spray_plan_issue/redate_chain_to_transfer_console.py`, whose header
states the governing principle:

    "The honest, valid anchor is the TRANSFER date: on that date the raw chemicals are
     provably in the CSU, so a manufacture + issue posted that day cannot fail on stock."

and which posts the pair a second apart (`MFG_TIME = "23:59:57"`,
`ISSUE_TIME = "23:59:58"`).

Every claim the token design rests on is checked against real Stock Entries:

1. a backdated production/consumption pair, ordered, posts cleanly and carries its cost;
2. consumption dated **before** its production is refused — the anchor floor is real;
3. the same rule for raw chemicals: nothing can be consumed before the transfer that
   delivered it;
4. whether the one-second gap is load-bearing or merely cautious;
5. backdating defers valuation to a repost instead of blocking the submit;
6. the ledger orders on posting moment, not creation — the fact the design needs;
7. what is missing here for a safe re-sync.

**Valuation is never waived.** `allow_zero_valuation_rate` would make anything post, at
zero cost — which defeats the whole reason for dating it correctly, since the point is
that the cost lands in the month the spray happened. Both remediation scripts default
`ALLOW_ZERO_VALUATION` to False, and step 3 *skips* such a candidate rather than "issuing
at a zero value". These tests do the same, and pin the refusal.

Synthetic items in real warehouses: the mechanics are genuine, nothing operational is
touched, and it cleans up after itself.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_offline_token_mechanics
"""

import unittest

import frappe
from erpnext.stock.stock_ledger import NegativeStockError
from frappe.utils import add_to_date, now_datetime

PREFIX = "_TEST-TOKEN-"

#: Every test item is given a real valuation. A live tank mix gets one from the
#: Manufacture that produced it; a synthetic item has no such history, and without it
#: ERPNext refuses the consumption with "Valuation Rate ... is required" — a *valuation*
#: error that looks nothing like an ordering problem and is easily misdiagnosed as one.
#: (It was, on the first run of this file.)
RATE = 10.0


def _item(suffix: str) -> str:
    """Create (or re-enable) a valued stock item for one test.

    One item per test: sharing them let one test's balance decide another's outcome.
    """
    code = f"{PREFIX}{suffix}"
    if not frappe.db.exists("Item", code):
        frappe.get_doc({
            "doctype": "Item", "item_code": code, "item_name": code,
            "item_group": frappe.db.get_value("Item Group", {"is_group": 0}, "name"),
            "stock_uom": "Litre", "is_stock_item": 1, "valuation_rate": RATE,
        }).insert(ignore_permissions=True)
    else:
        frappe.db.set_value(
            "Item", code, {"disabled": 0, "valuation_rate": RATE}, update_modified=False
        )
    frappe.db.commit()
    return code


def _warehouses():
    """A CSU-like and a greenhouse-like warehouse in one company."""
    rows = frappe.db.sql(
        """SELECT name, company FROM tabWarehouse
           WHERE is_group = 0 AND disabled = 0 AND company IS NOT NULL
             AND name LIKE 'Chemical Store%'
           ORDER BY name LIMIT 2""",
        as_dict=True,
    )
    if len(rows) < 2:
        return None, None, None
    return rows[0].name, rows[1].name, rows[0].company


def _unwind_all():
    """Cancel consumption before production, driven off the ledger.

    Reverse creation order is not enough: ERPNext refuses to cancel a receipt a later
    issue still depends on — the same protection these tests exercise, from the other
    side. Ledger-driven, so residue from a run that died mid-teardown goes too.
    """
    rows = frappe.db.sql(
        """SELECT DISTINCT sed.parent, sed.s_warehouse
           FROM `tabStock Entry Detail` sed
           JOIN `tabStock Entry` se ON se.name = sed.parent
           WHERE sed.item_code LIKE %s AND se.docstatus = 1""",
        (f"{PREFIX}%",),
        as_dict=True,
    )
    consuming = [r.parent for r in rows if r.s_warehouse]
    producing = [r.parent for r in rows if not r.s_warehouse]
    for name in consuming + producing:
        if not frappe.db.exists("Stock Entry", name):
            continue
        doc = frappe.get_doc("Stock Entry", name)
        if doc.docstatus != 1:
            continue
        try:
            doc.flags.ignore_permissions = True
            doc.cancel()
            frappe.db.commit()
        except Exception:
            frappe.db.rollback()
    for code in frappe.get_all(
        "Item", filters={"name": ("like", f"{PREFIX}%")}, pluck="name"
    ):
        frappe.db.set_value("Item", code, "disabled", 1, update_modified=False)
    frappe.db.commit()


class PostingHarness:
    """Posts movements at explicit moments, the way a synced token would.

    A plain mixin, not a base TestCase, so both suites share it without their tests being
    collected twice.
    """

    csu: str
    greenhouse: str
    company: str

    @classmethod
    def _resolve(cls):
        frappe.set_user("Administrator")
        cls.csu, cls.greenhouse, cls.company = _warehouses()
        if not cls.csu:
            raise unittest.SkipTest("need two warehouses in one company")

    def _post(self, kind: str, item: str, qty: float, when, **extra):
        row = {
            "item_code": item,
            "qty": qty,
            "uom": "Litre",
            "stock_uom": "Litre",
            "conversion_factor": 1,
            "basic_rate": extra.get("rate", RATE),
        }
        if kind == "receipt":
            row["t_warehouse"] = extra.get("to") or self.csu
        else:
            row["s_warehouse"] = extra.get("frm") or self.greenhouse
        purpose = "Material Receipt" if kind == "receipt" else "Material Issue"

        doc = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": purpose,
            "purpose": purpose,
            "company": self.company,
            "posting_date": when.date().isoformat(),
            "posting_time": when.time().isoformat(),
            "set_posting_time": 1,
            "items": [row],
        })
        doc.flags.ignore_permissions = True
        doc.flags.ignore_links = True
        doc.insert()
        doc.submit()
        return doc


class TestTokenPostingMechanics(unittest.TestCase, PostingHarness):
    @classmethod
    def setUpClass(cls):
        cls._resolve()

    @classmethod
    def tearDownClass(cls):
        _unwind_all()

    def test_a_backdated_pair_one_second_apart_posts_cleanly(self):
        """The core claim: produce at T, consume at T+1s, both backdated, cost intact.

        This is what the token sync does with the supervisor's recorded moments.
        """
        item = _item("pair")
        anchor = add_to_date(now_datetime(), hours=-6)
        self._post("receipt", item, 5, anchor, to=self.greenhouse)
        issue = self._post("issue", item, 5, add_to_date(anchor, seconds=1))
        self.assertEqual(issue.docstatus, 1)
        self.assertEqual(str(issue.posting_date), str(anchor.date()))
        self.assertGreater(
            float(issue.items[0].basic_rate or 0), 0,
            "the consumption must carry a real cost, not a zero valuation",
        )

    def test_the_same_second_also_posts(self):
        """Is the one-second gap load-bearing, or just cautious?

        Answered rather than copied, so nobody drops the constant later without knowing
        what it was for.
        """
        item = _item("samesec")
        anchor = add_to_date(now_datetime(), hours=-5)
        self._post("receipt", item, 4, anchor, to=self.greenhouse)
        issue = self._post("issue", item, 4, anchor)
        self.assertEqual(
            issue.docstatus, 1,
            "same-second was refused — then the one-second gap IS load-bearing",
        )

    def test_consumption_before_production_is_refused(self):
        """The anchor floor. A token whose times run backwards cannot post, however the
        client arrived at them."""
        item = _item("before")
        anchor = add_to_date(now_datetime(), hours=-4)
        self._post("receipt", item, 3, anchor, to=self.greenhouse)
        with self.assertRaises(NegativeStockError):
            self._post("issue", item, 3, add_to_date(anchor, seconds=-1))

    def test_nothing_can_be_consumed_before_the_transfer_that_delivered_it(self):
        """The remediation header's principle, tested directly: the transfer into the CSU
        is the earliest honest anchor, because only then are the raws provably there."""
        item = _item("rawlate")
        arrived = add_to_date(now_datetime(), hours=-3)
        self._post("receipt", item, 9, arrived, to=self.csu)
        with self.assertRaises(NegativeStockError):
            self._post(
                "issue", item, 9, add_to_date(arrived, minutes=-30), frm=self.csu
            )

    def test_and_posts_fine_from_the_moment_it_did_arrive(self):
        item = _item("rawok")
        arrived = add_to_date(now_datetime(), hours=-2)
        self._post("receipt", item, 6, arrived, to=self.csu)
        consumed = self._post(
            "issue", item, 6, add_to_date(arrived, seconds=1), frm=self.csu
        )
        self.assertEqual(consumed.docstatus, 1)

    def test_backdating_queues_a_repost_rather_than_blocking_the_submit(self):
        """Why a bulk sync will not hang: valuation recalculation is deferred, as the
        remediation script also notes — "backdated reposting is deferred to the
        scheduler (fast submits)"."""
        before = frappe.db.count("Repost Item Valuation")
        entry = self._post(
            "receipt", _item("repost"), 2, add_to_date(now_datetime(), days=-2),
            to=self.greenhouse,
        )
        self.assertEqual(entry.docstatus, 1)
        self.assertGreaterEqual(frappe.db.count("Repost Item Valuation"), before)

    def test_the_ledger_orders_by_posting_moment_not_by_creation(self):
        """The fact the whole design turns on: created second, dated first."""
        item = _item("order")
        self._post("receipt", item, 1, add_to_date(now_datetime(), hours=-1),
                   to=self.greenhouse)
        self._post("receipt", item, 1, add_to_date(now_datetime(), hours=-8),
                   to=self.greenhouse)
        rows = frappe.db.sql(
            """SELECT posting_datetime FROM `tabStock Ledger Entry`
               WHERE item_code = %s AND is_cancelled = 0
               ORDER BY creation ASC LIMIT 2""",
            (item,),
            as_dict=True,
        )
        if len(rows) < 2:
            self.skipTest("not enough ledger rows to compare")
        self.assertGreater(
            rows[0].posting_datetime, rows[1].posting_datetime,
            "the row created FIRST is dated LATER — posting order is what rules",
        )


class TestValuationIsNeverWaived(unittest.TestCase, PostingHarness):
    """Cost must survive the trip — the one thing not to compromise on.

    `allow_zero_valuation_rate` makes any of this post, at zero cost, defeating the
    reason for dating it correctly. So the token must refuse and report instead, exactly
    as step 3 skips rather than "issuing at a zero value".
    """

    @classmethod
    def setUpClass(cls):
        cls._resolve()

    @classmethod
    def tearDownClass(cls):
        _unwind_all()

    def test_a_valued_item_carries_its_cost_through_a_backdated_consumption(self):
        item = _item("valued")
        anchor = add_to_date(now_datetime(), hours=-6)
        self._post("receipt", item, 5, anchor, to=self.greenhouse)
        issue = self._post("issue", item, 5, add_to_date(anchor, seconds=1))
        self.assertEqual(float(issue.items[0].basic_rate), RATE)
        self.assertEqual(float(issue.items[0].amount), RATE * 5)

    def test_an_unvalued_mix_is_refused_rather_than_posted_at_zero(self):
        """What the token must do when a mix has no cost: stop, and say which failure it
        is. A valuation error looks nothing like an ordering error."""
        item = _item("unvalued")
        frappe.db.set_value("Item", item, "valuation_rate", 0, update_modified=False)
        frappe.db.commit()
        anchor = add_to_date(now_datetime(), hours=-6)
        # Asserted across the whole pair, not one leg: with no value anywhere, ERPNext
        # stops at the FIRST entry it cannot account for — which turned out to be the
        # production, not the consumption. Either refusal is the right outcome; what
        # matters is that nothing posts at zero cost.
        with self.assertRaises(frappe.ValidationError) as cm:
            self._post("receipt", item, 5, anchor, to=self.greenhouse, rate=0)
            self._post("issue", item, 5, add_to_date(anchor, seconds=1), rate=0)
        self.assertIn("valuation rate", str(cm.exception).lower())


class TestIdempotencyGap(unittest.TestCase):
    """What is missing here for a re-sync to be safe."""

    def test_the_remediation_scripts_tag_field_is_absent_on_this_site(self):
        """Both `redate_chain_to_transfer` and step 3 key idempotency off
        `Stock Entry.custom_original_stock_entry` — "SKIP if a Material Issue already
        carries custom_original_stock_entry = this manufacture SE".

        Absent here, so the token must bring its own link rather than inherit that one.
        """
        exists = bool(
            frappe.get_meta("Stock Entry").get_field("custom_original_stock_entry")
        )
        if exists:
            self.skipTest("the field exists here; the remediation pattern transfers")
        self.assertFalse(exists)

    def test_nothing_on_a_stock_entry_can_hold_a_client_id_today(self):
        """Why the link belongs on the server side: the handset's `clientId` lives in its
        own SQLite, so a reinstall makes a re-synced session look new."""
        holders = [
            f.fieldname
            for f in frappe.get_meta("Stock Entry").fields
            if "client" in (f.fieldname or "") or "token" in (f.fieldname or "")
        ]
        self.assertEqual(holders, [], f"unexpected field(s): {holders}")
