"""A tank-mix Manufacture consumes the batch that was transferred in for its plan.

Before, the Manufacture rows named no batch and ERPNext picked first-in-first-out over
the whole shared CSU: another plan's batch, or nothing at all when the transferred batch
had expired or the transfer was a legacy one with no batch. These tests post real Stock
Entries on two borrowed Application Floor Plan Work Orders and a throwaway chemical, run
the manufacture, and read back which batches its bundles name.

Every test runs inside one transaction that is rolled back: ``frappe.db.commit`` is a
no-op for the duration, and nothing it posts survives.

The pure rule (``transfer_batches.plan_item`` / ``balance_floor``) is tested on its own
first, so a failure there reads as the rule rather than as the ledger.

Run: see the DB test runner in the task notes (unittest against kaitet.local).
"""

import unittest
from unittest import mock

import frappe
from frappe.utils import add_days, add_to_date, flt, now_datetime, today

from upande_scp.serverscripts.spray_plan_creator import offline_session as OS
from upande_scp.serverscripts.spray_plan_creator import spray_session as SS
from upande_scp.serverscripts.spray_plan_creator import transfer_batches as TB

MTM = "Material Transfer for Manufacture"


# ─────────────────────────────── the pure rule ───────────────────────────────


class TestPlanItem(unittest.TestCase):
    def test_own_lot_first_even_when_an_older_batch_sits_in_the_csu(self):
        plan = TB.plan_item(
            1.0, [{"batch_no": "A", "qty": 1.0}], {"OLD": 5.0, "A": 1.0}, ["OLD", "A"]
        )
        self.assertEqual(plan["pieces"], [{"batch_no": "A", "qty": 1.0, "source": "transferred"}])
        self.assertEqual(plan["fallback"], [])

    def test_two_lots_split_in_transfer_order(self):
        plan = TB.plan_item(
            1.0,
            [{"batch_no": "A", "qty": 0.6}, {"batch_no": "C", "qty": 0.4}],
            {"A": 3.0, "C": 3.0},
            ["A", "C"],
        )
        self.assertEqual(
            [(p["batch_no"], round(p["qty"], 6)) for p in plan["pieces"]],
            [("A", 0.6), ("C", 0.4)],
        )

    def test_short_lot_is_topped_up_from_the_oldest_other_batch_and_noted(self):
        plan = TB.plan_item(
            1.0, [{"batch_no": "A", "qty": 1.0}], {"A": 0.7, "B": 2.0, "Z": 9.0}, ["B", "A", "Z"]
        )
        self.assertEqual(
            [(p["batch_no"], round(p["qty"], 6), p["source"]) for p in plan["pieces"]],
            [("A", 0.7, "transferred"), ("B", 0.3, "fallback")],
        )
        self.assertEqual(plan["short"], 0.0)
        note = TB.notes_for("CHEM", plan)[0]
        self.assertIn("batch B", note)
        self.assertIn("not transferred for this WO", note)

    def test_legacy_lot_takes_the_placeholder(self):
        plan = TB.plan_item(
            0.5, [{"batch_no": None, "qty": 0.5}],
            {"OLD": 5.0, "X-PREMIGRATION": 100.0}, ["OLD", "X-PREMIGRATION"],
            placeholder="X-PREMIGRATION",
        )
        self.assertEqual(plan["pieces"][0]["batch_no"], "X-PREMIGRATION")
        self.assertEqual(plan["fallback"], [])
        self.assertIn("carried no batch", TB.notes_for("CHEM", plan)[0])

    def test_nothing_in_the_csu_is_short(self):
        plan = TB.plan_item(1.0, [{"batch_no": "A", "qty": 1.0}], {}, [])
        self.assertEqual(plan["pieces"], [])
        self.assertAlmostEqual(plan["short"], 1.0)

    def test_balance_floor_is_the_lowest_balance_from_the_moment_on(self):
        t = now_datetime()
        moves = [
            {"batch_no": "A", "posting_datetime": add_to_date(t, days=-3), "qty": 1.0},
            {"batch_no": "A", "posting_datetime": add_to_date(t, days=-1), "qty": -0.6},
            {"batch_no": "A", "posting_datetime": add_to_date(t, hours=-1), "qty": 0.5},
            {"batch_no": "B", "posting_datetime": add_to_date(t, days=-1), "qty": 2.0},
        ]
        floor = TB.balance_floor(moves, add_to_date(t, days=-2))
        self.assertAlmostEqual(floor["A"], 0.4)
        self.assertAlmostEqual(floor["B"], 0.0)  # not there yet at the moment
        now = TB.balance_floor(moves, None)
        self.assertAlmostEqual(now["A"], 0.9)
        self.assertAlmostEqual(now["B"], 2.0)


# ─────────────────────────────── on the ledger ───────────────────────────────


def _two_plans_sharing_a_csu():
    rows = frappe.db.sql(
        """SELECT wo.name, wo.wip_warehouse, wo.company
           FROM `tabWork Order` wo
           WHERE wo.custom_type = %s AND wo.docstatus = 1 AND wo.status = 'Not Started'
             AND wo.produced_qty = 0 AND wo.wip_warehouse IS NOT NULL
             AND wo.bom_no IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM `tabStock Entry` se
                             WHERE se.work_order = wo.name AND se.docstatus < 2)
           ORDER BY wo.creation DESC LIMIT 200""",
        (SS.AFP_TYPE,),
        as_dict=True,
    )
    by_csu: dict = {}
    for r in rows:
        by_csu.setdefault(r.wip_warehouse, []).append(r)
        if len(by_csu[r.wip_warehouse]) == 2:
            return by_csu[r.wip_warehouse]
    return None


class LedgerCase(unittest.TestCase):
    """Real entries, one transaction, rolled back after every test."""

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        pair = _two_plans_sharing_a_csu()
        if not pair:
            raise unittest.SkipTest("no two untouched floor plans share a CSU on this site")
        cls.wo1, cls.wo2 = pair[0].name, pair[1].name
        cls.csu = pair[0].wip_warehouse
        cls.company = pair[0].company
        cls.store = frappe.db.get_value(
            "Warehouse",
            {"company": cls.company, "is_group": 0, "disabled": 0, "name": ["!=", cls.csu]},
            "name",
        )
        cls.item_group = frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name")[0]
        cls.uom = "Litre" if frappe.db.exists("UOM", "Litre") else "Nos"

    def setUp(self):
        frappe.set_user("Administrator")
        frappe.db.rollback()
        patcher = mock.patch.object(frappe.db, "commit", lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(frappe.db.rollback)
        self.addCleanup(frappe.set_user, "Administrator")
        sal = mock.patch.object(SS, "_create_sal_draft", return_value=None)
        sal.start()
        self.addCleanup(sal.stop)
        self.tag = frappe.generate_hash(length=6).upper()
        self.t0 = now_datetime().replace(microsecond=0)

    # ── fixtures ──

    def item(self, batched=True):
        code = f"_TTMB-{self.tag}-{'B' if batched else 'N'}"
        if not frappe.db.exists("Item", code):
            frappe.get_doc({
                "doctype": "Item", "item_code": code, "item_name": code,
                "item_group": self.item_group, "stock_uom": self.uom,
                "is_stock_item": 1, "has_batch_no": 1 if batched else 0,
                "create_new_batch": 0, "valuation_rate": 10,
            }).insert(ignore_permissions=True)
        return code

    def batch(self, item, suffix, expiry=None):
        name = f"{item}-{suffix}"
        frappe.get_doc({
            "doctype": "Batch", "batch_id": name, "item": item,
            "expiry_date": expiry,
        }).insert(ignore_permissions=True)
        return name

    def _se(self, purpose, rows, days_ago, work_order=None):
        doc = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": purpose,
            "purpose": purpose,
            "company": self.company,
            "work_order": work_order,
            "fg_completed_qty": 1 if work_order else 0,
            "set_posting_time": 1,
            "posting_date": add_to_date(self.t0, days=-days_ago).date(),
            "posting_time": add_to_date(self.t0, days=-days_ago).time(),
            "items": [
                dict(
                    r, basic_rate=10,
                    use_serial_batch_fields=1 if r.get("batch_no") else 0,
                )
                for r in rows
            ],
        })
        doc.flags.ignore_permissions = True
        doc.insert()
        doc.submit()
        return doc

    def receive(self, item, batch, qty, days_ago, warehouse=None):
        return self._se("Material Receipt", [{
            "item_code": item, "qty": qty, "t_warehouse": warehouse or self.store,
            "batch_no": batch,
        }], days_ago)

    def transfer(self, wo, item, batch, qty, days_ago):
        return self._se(MTM, [{
            "item_code": item, "qty": qty, "s_warehouse": self.store,
            "t_warehouse": self.csu, "batch_no": batch,
        }], days_ago, work_order=wo)

    def issue_from_csu(self, item, batch, qty, days_ago):
        return self._se("Material Issue", [{
            "item_code": item, "qty": qty, "s_warehouse": self.csu, "batch_no": batch,
        }], days_ago)

    def plan(self, wo, items):
        """Make ``items`` ({item: qty}) the plan's required chemicals."""
        frappe.db.delete("Work Order Item", {"parent": wo, "parenttype": "Work Order"})
        for i, (code, qty) in enumerate(items.items(), start=1):
            frappe.get_doc({
                "doctype": "Work Order Item", "parent": wo, "parenttype": "Work Order",
                "parentfield": "required_items", "idx": i, "item_code": code,
                "item_name": code, "required_qty": qty, "source_warehouse": self.store,
                "stock_uom": self.uom,
            }).db_insert()

    def manufacture(self, wo, posting_moment=None):
        doc = frappe.get_doc("Work Order", wo)
        name, _ = SS._promote_to_tank_mix_manufactured(doc, None, posting_moment=posting_moment)
        return frappe.get_doc("Stock Entry", name)

    @staticmethod
    def consumed(se, item):
        """batch -> qty consumed of ``item`` by the Manufacture, from its bundles."""
        out = {}
        for row in se.items:
            if row.item_code != item or not row.s_warehouse or row.t_warehouse:
                continue
            if not row.serial_and_batch_bundle:
                out[None] = out.get(None, 0.0) + flt(row.qty)
                continue
            for e in frappe.get_all(
                "Serial and Batch Entry",
                filters={"parent": row.serial_and_batch_bundle},
                fields=["batch_no", "qty"],
            ):
                out[e.batch_no] = round(out.get(e.batch_no, 0.0) + abs(flt(e.qty)), 6)
        return out


class TestOnlineManufacture(LedgerCase):
    def test_own_batch_is_consumed_not_the_older_batch_another_plan_transferred(self):
        """The 05229 / 05204 case: FIFO would take the other plan's older batch."""
        item = self.item()
        old, own = self.batch(item, "OLD"), self.batch(item, "OWN")
        self.receive(item, old, 2, days_ago=6)
        self.receive(item, own, 2, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.plan(self.wo2, {item: 1})
        self.transfer(self.wo2, item, old, 1, days_ago=5)   # older, the other plan's
        self.transfer(self.wo1, item, own, 1, days_ago=4)

        se = self.manufacture(self.wo1)
        self.assertEqual(se.docstatus, 1)
        self.assertEqual(self.consumed(se, item), {own: 1.0})
        rec = SS.build_manufacture_reconciliation(frappe.get_doc("Work Order", self.wo1), se)
        self.assertEqual(rec["batch_notes"], [])
        chem = next(c for c in rec["chemicals"] if c["item_code"] == item)
        self.assertEqual([b["batch_no"] for b in chem["batches"]], [own])
        self.assertTrue(chem["batches"][0]["transferred"])

    def test_two_transferred_batches_are_split(self):
        item = self.item()
        a, c = self.batch(item, "A"), self.batch(item, "C")
        self.receive(item, a, 2, days_ago=6)
        self.receive(item, c, 2, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, a, 0.6, days_ago=5)
        self.transfer(self.wo1, item, c, 0.4, days_ago=4)

        se = self.manufacture(self.wo1)
        self.assertEqual(self.consumed(se, item), {a: 0.6, c: 0.4})

    def test_short_transferred_batch_is_topped_up_from_another_and_noted(self):
        item = self.item()
        own, other = self.batch(item, "OWN"), self.batch(item, "OTHER")
        self.receive(item, other, 2, days_ago=7, warehouse=self.csu)
        self.receive(item, own, 2, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=5)
        self.issue_from_csu(item, own, 0.3, days_ago=4)   # someone took some

        se = self.manufacture(self.wo1)
        self.assertEqual(se.docstatus, 1)
        self.assertEqual(self.consumed(se, item), {own: 0.7, other: 0.3})
        rec = SS.build_manufacture_reconciliation(frappe.get_doc("Work Order", self.wo1), se)
        self.assertEqual(len(rec["batch_notes"]), 1)
        self.assertIn(f"took 0.3 of {item} from batch {other}", rec["batch_notes"][0])
        self.assertIn("not transferred for this WO", rec["batch_notes"][0])
        self.assertIn("not transferred", se.remarks or "")

    def test_no_stock_at_all_in_the_csu_refuses(self):
        item = self.item()
        own = self.batch(item, "OWN")
        self.receive(item, own, 1, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=5)
        self.issue_from_csu(item, own, 1, days_ago=4)
        with self.assertRaises(frappe.ValidationError) as ctx:
            self.manufacture(self.wo1)
        self.assertIn("batches there hold only 0", str(ctx.exception))

    def test_legacy_unbatched_transfer_takes_the_premigration_placeholder(self):
        item = self.item()
        # The transfer happens while the item is not batch-tracked, as legacy ones did.
        frappe.db.set_value("Item", item, "has_batch_no", 0)
        frappe.clear_document_cache("Item", item)
        self.receive(item, None, 2, days_ago=8)
        self.plan(self.wo1, {item: 0.5})
        self.transfer(self.wo1, item, None, 0.5, days_ago=7)
        frappe.db.set_value("Item", item, "has_batch_no", 1)
        frappe.clear_document_cache("Item", item)
        older = self.batch(item, "OLDER")
        self.receive(item, older, 3, days_ago=6, warehouse=self.csu)
        placeholder = self.batch(item, "PREMIGRATION")
        self.receive(item, placeholder, 100, days_ago=5, warehouse=self.csu)

        se = self.manufacture(self.wo1)
        self.assertEqual(self.consumed(se, item), {placeholder: 0.5})
        rec = SS.build_manufacture_reconciliation(frappe.get_doc("Work Order", self.wo1), se)
        self.assertIn("carried no batch", rec["batch_notes"][0])

    def test_expired_transferred_batch_is_still_consumed(self):
        """05179 / KPK-2601: it is in the tank, so it is what the mix consumed."""
        item = self.item()
        own, fresh = self.batch(item, "OWN"), self.batch(item, "FRESH")
        self.receive(item, fresh, 2, days_ago=7, warehouse=self.csu)
        self.receive(item, own, 1, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=5)
        frappe.db.set_value("Batch", own, "expiry_date", add_days(today(), -2))
        frappe.clear_document_cache("Batch", own)

        se = self.manufacture(self.wo1)
        self.assertEqual(se.docstatus, 1)
        self.assertEqual(self.consumed(se, item), {own: 1.0})
        row = next(r for r in se.items if r.item_code == item)
        self.assertTrue(row.serial_and_batch_bundle)
        self.assertFalse(row.batch_no)

    def test_non_batch_item_is_one_plain_row(self):
        item = self.item(batched=False)
        self.receive(item, None, 2, days_ago=6)
        self.plan(self.wo1, {item: 0.5})
        self.transfer(self.wo1, item, None, 0.5, days_ago=5)

        se = self.manufacture(self.wo1)
        rows = [r for r in se.items if r.item_code == item]
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(flt(rows[0].qty), 0.5)
        self.assertFalse(rows[0].serial_and_batch_bundle)
        self.assertFalse(rows[0].batch_no)

    def test_a_supervisor_without_stock_user_can_manufacture(self):
        item = self.item()
        own = self.batch(item, "OWN")
        self.receive(item, own, 1, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=5)

        email = f"ttmb-{self.tag.lower()}@example.com"
        user = frappe.get_doc({
            "doctype": "User", "email": email, "first_name": "TTMB",
            "send_welcome_email": 0, "user_type": "System User",
            "roles": [{"role": "SCP Spray Supervisor"}],
        })
        user.insert(ignore_permissions=True)
        roles = set(frappe.get_roles(email))
        for r in ("Stock User", "Stock Manager", "Item Manager", "System Manager"):
            self.assertNotIn(r, roles)

        frappe.set_user(email)
        se = self.manufacture(self.wo1)
        self.assertEqual(frappe.session.user, email)   # restored after the submit
        frappe.set_user("Administrator")
        self.assertEqual(se.docstatus, 1)
        self.assertEqual(se.owner, email)
        self.assertEqual(self.consumed(se, item), {own: 1.0})


class TestTheCallersSessionSurvives(LedgerCase):
    """C1: `frappe.set_user` (used for the elevated submit) replaces the live web
    session's sid and data (user, csrf_token) and form_dict; all must be put back, or
    the supervisor's cookie session breaks after Confirm Tank Mix."""

    def test_sid_user_csrf_and_form_dict_survive_a_supervisor_manufacture(self):
        item = self.item()
        own = self.batch(item, "OWN")
        self.receive(item, own, 1, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=5)
        email = f"ttmb-{self.tag.lower()}@example.com"
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": "TTMB",
            "send_welcome_email": 0, "user_type": "System User",
            "roles": [{"role": "SCP Spray Supervisor"}],
        }).insert(ignore_permissions=True)

        frappe.set_user(email)
        session = frappe.local.session
        session.sid = "real-cookie-sid"
        session.data = frappe._dict(user=email, csrf_token="tok-123", session_expiry="240:00:00")
        form = frappe._dict(work_order=self.wo1)
        frappe.local.form_dict = form

        se = self.manufacture(self.wo1)

        self.assertIs(frappe.local.session, session)
        self.assertEqual(frappe.session.sid, "real-cookie-sid")
        self.assertEqual(frappe.session.user, email)
        self.assertEqual(frappe.session.data.user, email)
        self.assertEqual(frappe.session.data.csrf_token, "tok-123")
        self.assertIs(frappe.local.form_dict, form)
        self.assertEqual(se.docstatus, 1)
        self.assertEqual(self.consumed(se, item), {own: 1.0})


    def test_a_frozen_stock_date_is_refused_for_the_real_user_despite_the_elevated_submit(self):
        item = self.item()
        own = self.batch(item, "OWN")
        self.receive(item, own, 1, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=5)
        email = f"ttmb-{self.tag.lower()}@example.com"
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": "TTMB",
            "send_welcome_email": 0, "user_type": "System User",
            "roles": [{"role": "SCP Spray Supervisor"}],
        }).insert(ignore_permissions=True)
        frappe.db.set_single_value("Stock Settings", "stock_frozen_upto", add_days(today(), -3))
        frappe.db.set_single_value("Stock Settings", "stock_auth_role", "Stock Manager")
        frappe.clear_document_cache("Stock Settings", "Stock Settings")
        self.addCleanup(frappe.clear_document_cache, "Stock Settings", "Stock Settings")
        frappe.set_user(email)
        from erpnext.stock.doctype.stock_ledger_entry.stock_ledger_entry import StockFreezeError
        with self.assertRaises(StockFreezeError):
            self.manufacture(self.wo1, posting_moment=add_to_date(self.t0, days=-4))


class TestOfflineReplay(LedgerCase):
    def _session(self, mix_at):
        return {
            "token": f"_ttmb-{self.tag}",
            "work_order": self.wo1,
            "scans": [{"item_code": self.chem, "scanned_at": str(mix_at)}],
            "mix_at": str(mix_at),
            "started_at": str(add_to_date(mix_at, minutes=10)),
            "ended_at": str(add_to_date(mix_at, minutes=60)),
        }

    def _later_draw(self, with_cover):
        """Own lot of 1.0 transferred 3 days ago, 0.6 of it drawn yesterday.

        At a mix two days ago the batch held 1.0, but only 0.4 of that can be consumed
        then without yesterday's draw going negative.
        """
        self.chem = item = self.item()
        own = self.batch(item, "OWN")
        cover = self.batch(item, "COVER") if with_cover else None
        if cover:
            self.receive(item, cover, 2, days_ago=6, warehouse=self.csu)
        self.receive(item, own, 1, days_ago=4)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=3)
        self.issue_from_csu(item, own, 0.6, days_ago=1)
        frappe.db.set_value("Work Order", self.wo1, "workflow_state", SS.STATE_CHEMICAL_ISSUED)
        return own, cover

    def test_backdated_replay_uses_the_as_of_balance_capped_by_later_entries(self):
        own, cover = self._later_draw(with_cover=True)
        mix_at = add_to_date(self.t0, days=-2)
        check = OS.preflight(self._session(mix_at))
        self.assertTrue(check["ok"], check["problems"])
        self.assertTrue(any(cover in n for n in check["notes"]), check["notes"])

        se = self.manufacture(self.wo1, posting_moment=mix_at)
        self.assertEqual(se.docstatus, 1)
        self.assertEqual(str(se.posting_date), str(mix_at.date()))
        self.assertEqual(self.consumed(se, self.chem), {own: 0.4, cover: 0.6})

    def test_presync_check_catches_a_real_batch_shortfall(self):
        """Old check: 1.0 of the item in the CSU at the anchor, so OK — then the replay
        failed at sync. The batch-aware check sees only 0.4 can be taken."""
        self._later_draw(with_cover=False)
        mix_at = add_to_date(self.t0, days=-2)
        check = OS.preflight(self._session(mix_at))
        self.assertFalse(check["ok"])
        self.assertTrue(
            any(self.chem in p and "0.4" in p for p in check["problems"]), check["problems"]
        )


class TestWhoMayManufacture(LedgerCase):
    """The submit runs elevated, so the caller check is what stands in front of it."""

    def setUp(self):
        super().setUp()
        self.wo = frappe.get_doc("Work Order", self.wo1)
        self.farm = frappe.db.get_value("Warehouse", self.wo.custom_greenhouse, "custom_farm")
        made = mock.patch.object(SS, "_manufacture_tank_mix", return_value={"ok": True})
        self.made = made.start()
        self.addCleanup(made.stop)

    def user(self, roles=(), roster=False):
        email = f"ttmb-{frappe.generate_hash(length=6).lower()}@example.com"
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": "TTMB",
            "send_welcome_email": 0, "user_type": "System User",
            "roles": [{"role": r} for r in roles],
        }).insert(ignore_permissions=True)
        if roster:
            if not self.farm:
                self.skipTest("the borrowed plan's greenhouse has no farm")
            frappe.get_doc({
                "doctype": "Farm Spray Supervisor", "parent": self.farm,
                "parenttype": "Farm", "parentfield": "spray_supervisors",
                "user": email, "idx": 999,
            }).db_insert()
        return email

    def test_a_supervisor_on_the_farm_roster_may(self):
        frappe.set_user(self.user(["SCP Spray Supervisor"], roster=True))
        self.assertEqual(SS.manufacture_tank_mix(self.wo1), {"ok": True})

    def test_a_plain_user_is_refused_before_any_stock_work(self):
        frappe.set_user(self.user(["SCP Scout"]))
        with self.assertRaises(frappe.PermissionError):
            SS.manufacture_tank_mix(self.wo1)
        self.made.assert_not_called()

    def test_a_supervisor_role_without_the_roster_is_refused(self):
        frappe.set_user(self.user(["SCP Spray Supervisor"]))
        with self.assertRaises(frappe.PermissionError):
            SS.manufacture_tank_mix(self.wo1)

    def test_a_general_manager_may(self):
        frappe.set_user(self.user(["SCP General Manager"]))
        self.assertEqual(SS.manufacture_tank_mix(self.wo1), {"ok": True})

    def test_the_plans_assigned_supervisor_may(self):
        email = self.user(["SCP Spray Supervisor"])
        # Borrow an existing employee (rolled back) rather than insert one: this
        # site's Employee validation is unrelated and strict.
        emp_name = frappe.db.get_value("Employee", {"status": "Active"}, "name")
        frappe.db.set_value("Employee", emp_name, "user_id", email, update_modified=False)
        emp = frappe._dict(name=emp_name)
        wo = frappe.get_doc("Work Order", self.wo1)
        if not wo.meta.has_field("custom_spray_plan_team_members"):
            self.skipTest("no per-plan team on this site")
        child = wo.append("custom_spray_plan_team_members", {"employee": emp.name, "role": "Supervisor"})
        child.db_insert()
        frappe.set_user(email)
        self.assertEqual(SS.manufacture_tank_mix(self.wo1), {"ok": True})

    # ── offline replay ──

    def _sync_as(self, syncer, recorder=None):
        token = f"_ttmb-{frappe.generate_hash(length=6)}"
        if recorder:
            frappe.set_user(recorder)
            frappe.get_doc({"doctype": OS.TOKEN, "token": token, "work_order": self.wo1,
                            "status": "Refused"}).insert(ignore_permissions=True)
        frappe.set_user(syncer)
        payload = {"token": token, "work_order": self.wo1, "scans": []}
        with mock.patch.object(OS, "preflight", return_value={
            "ok": True, "problems": [], "notes": [], "anchor": None, "resolved": {}}), \
             mock.patch.object(OS, "_replay_scans"), \
             mock.patch.object(OS, "_upsert_token"), \
             mock.patch.object(OS, "_stamp_result"), \
             mock.patch.object(OS, "_result", return_value={"synced": True}):
            frappe.db.set_value("Work Order", self.wo1, "workflow_state", SS.STATE_CHEMICAL_ISSUED)
            return OS.sync_spray_session(payload)

    def test_offline_replay_by_the_sessions_supervisor_goes_through(self):
        sup = self.user(["SCP Spray Supervisor"], roster=True)
        self.assertEqual(self._sync_as(sup), {"synced": True})
        self.made.assert_called_once()

    def test_offline_replay_recorded_by_a_supervisor_and_pushed_by_someone_else_goes_through(self):
        sup = self.user(["SCP Spray Supervisor"], roster=True)
        clerk = self.user(["SCP Scout"])
        self.assertEqual(self._sync_as(clerk, recorder=sup), {"synced": True})
        self.made.assert_called_once()

    def test_offline_replay_by_a_plain_user_is_refused(self):
        clerk = self.user(["SCP Scout"])
        with self.assertRaises(frappe.PermissionError):
            self._sync_as(clerk)
        self.made.assert_not_called()


class TestDeskDraftLeavesNoBundles(LedgerCase):
    def test_deleting_a_desk_draft_manufacture_removes_its_bundles(self):
        from erpnext.manufacturing.doctype.work_order.work_order import make_stock_entry

        item = self.item()
        own = self.batch(item, "OWN")
        self.receive(item, own, 1, days_ago=6)
        self.plan(self.wo1, {item: 1})
        self.transfer(self.wo1, item, own, 1, days_ago=5)

        se = frappe.get_doc(make_stock_entry(work_order_id=self.wo1, purpose="Manufacture"))
        se.flags.ignore_permissions = True
        se.insert()   # before_validate builds the batch bundle
        bundles = [r.serial_and_batch_bundle for r in se.items if r.serial_and_batch_bundle]
        self.assertEqual(len(bundles), 1)
        self.assertEqual(
            frappe.db.get_value("Serial and Batch Bundle", bundles[0], "voucher_no"), se.name
        )
        se.save()     # re-validate keeps the same bundle, makes no new one
        self.assertEqual(
            [r.serial_and_batch_bundle for r in se.items if r.serial_and_batch_bundle], bundles
        )
        frappe.delete_doc("Stock Entry", se.name, ignore_permissions=True)
        self.assertFalse(frappe.db.exists("Serial and Batch Bundle", bundles[0]))

if __name__ == "__main__":
    unittest.main()
