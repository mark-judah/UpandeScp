"""In-app notifications: audience resolution, delivery, and read isolation.

The isolation tests matter most. Every endpoint resolves the user from the
session and none accepts a `for_user` — if that ever regressed, one user could
read or clear another's notifications, so it is asserted rather than assumed.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_notifications
"""

import unittest

import frappe

from upande_scp.serverscripts.common import notifications as N

U1 = "_test_scp_notif_1@example.com"
U2 = "_test_scp_notif_2@example.com"


def _ensure_user(email):
    if not frappe.db.exists("User", email):
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": email.split("@")[0],
            "send_welcome_email": 0, "enabled": 1,
        }).insert(ignore_permissions=True)


def _wipe(email):
    for n in frappe.get_all("Notification Log", filters={"for_user": email}, pluck="name"):
        frappe.delete_doc("Notification Log", n, force=True, ignore_permissions=True)


class TestNotifications(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        _ensure_user(U1)
        _ensure_user(U2)
        frappe.db.commit()

    def setUp(self):
        frappe.set_user("Administrator")
        _wipe(U1)
        _wipe(U2)
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        frappe.set_user("Administrator")
        _wipe(U1)
        _wipe(U2)
        frappe.db.commit()

    # -- delivery -------------------------------------------------------
    def test_notify_writes_one_row_per_user_with_the_category(self):
        sent = N.notify([U1, U2], "Loan requested", "body", "Chemical Transfer Request",
                        "CTR-TEST", category="loan")
        self.assertEqual(sorted(sent), sorted([U1, U2]))
        rows = frappe.get_all(
            "Notification Log",
            filters={"for_user": ("in", [U1, U2])},
            fields=["for_user", "subject", "scp_category", "document_name"],
        )
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r.scp_category == "loan" for r in rows))
        self.assertTrue(all(r.document_name == "CTR-TEST" for r in rows))

    def test_system_accounts_are_never_notified(self):
        # Administrator/Guest would otherwise collect every alert on the site.
        self.assertEqual(N.notify(["Administrator", "Guest", None, ""], "x"), [])

    def test_duplicate_recipients_get_one_row(self):
        N.notify([U1, U1, U1], "Once please", category="loan")
        self.assertEqual(frappe.db.count("Notification Log", {"for_user": U1}), 1)

    def test_no_recipients_is_a_no_op(self):
        self.assertEqual(N.notify([], "nobody"), [])

    def test_an_unknown_category_still_delivers(self):
        # A wrong category must not lose the message — it only costs filtering.
        sent = N.notify([U1], "odd", category="not-a-category")
        self.assertEqual(sent, [U1])

    # -- audience -------------------------------------------------------
    def test_users_for_role_excludes_system_accounts(self):
        users = N.users_for_role("System Manager")
        self.assertNotIn("Administrator", users)
        self.assertNotIn("Guest", users)

    def test_users_for_role_is_empty_for_no_role(self):
        self.assertEqual(N.users_for_role(""), [])
        self.assertEqual(N.users_for_role(None), [])

    def test_users_for_store_reads_the_keeper_warehouse(self):
        wh = frappe.db.get_value("Farm Store Keeper", {"warehouse": ("is", "set")}, "warehouse")
        if not wh:
            self.skipTest("no keeper bound to a store on this site")
        self.assertTrue(N.users_for_store(wh))

    def test_users_for_store_falls_back_to_the_farm(self):
        # An unmigrated store must still notify somebody rather than nobody.
        farm = frappe.db.get_value("Farm Store Keeper", {"parenttype": "Farm"}, "parent")
        if not farm:
            self.skipTest("no farm keepers on this site")
        wh = frappe.db.get_value(
            "Warehouse", {"custom_farm": farm, "is_group": 0}, "name"
        )
        if not wh:
            self.skipTest("farm has no warehouse")
        # A warehouse with no keeper row of its own resolves via its farm.
        if frappe.db.exists("Farm Store Keeper", {"warehouse": wh}):
            self.skipTest("warehouse has its own keeper row")
        self.assertTrue(N.users_for_store(wh))

    def test_no_store_or_farm_yields_nobody(self):
        self.assertEqual(N.users_for_store(None), [])
        self.assertEqual(N.users_for_farm(None), [])

    # -- read API isolation ---------------------------------------------
    def test_a_user_only_lists_their_own(self):
        N.notify([U1], "mine", category="loan")
        N.notify([U2], "theirs", category="loan")
        frappe.set_user(U1)
        subjects = [r.subject for r in N.list_notifications()["notifications"]]
        self.assertIn("mine", subjects)
        self.assertNotIn("theirs", subjects)

    def test_unread_count_is_per_user(self):
        N.notify([U1], "a")
        N.notify([U1], "b")
        N.notify([U2], "c")
        frappe.set_user(U1)
        self.assertEqual(N.unread_count(), 2)
        frappe.set_user(U2)
        self.assertEqual(N.unread_count(), 1)

    def test_mark_read_cannot_touch_another_users_row(self):
        N.notify([U2], "theirs")
        other = frappe.db.get_value("Notification Log", {"for_user": U2}, "name")
        frappe.set_user(U1)
        N.mark_read(names=[other])
        frappe.set_user("Administrator")
        self.assertEqual(
            frappe.db.get_value("Notification Log", other, "read"), 0,
            "another user's notification was marked read",
        )

    def test_mark_all_read_clears_only_the_session_user(self):
        N.notify([U1], "a")
        N.notify([U2], "b")
        frappe.set_user(U1)
        self.assertEqual(N.mark_read(all=1)["unread"], 0)
        frappe.set_user(U2)
        self.assertEqual(N.unread_count(), 1)

    def test_unread_only_filter(self):
        N.notify([U1], "one")
        N.notify([U1], "two")
        frappe.set_user(U1)
        first = N.list_notifications()["notifications"][0]["name"]
        N.mark_read(names=[first])
        self.assertEqual(len(N.list_notifications(unread_only=1)["notifications"]), 1)

    def test_category_filter(self):
        N.notify([U1], "loan one", category="loan")
        N.notify([U1], "stock one", category="stock")
        frappe.set_user(U1)
        rows = N.list_notifications(category="stock")["notifications"]
        self.assertEqual([r.subject for r in rows], ["stock one"])

    def test_limit_is_clamped_and_offset_paginates(self):
        for i in range(5):
            N.notify([U1], f"n{i}")
        frappe.set_user(U1)
        self.assertEqual(len(N.list_notifications(limit=2)["notifications"]), 2)
        self.assertEqual(len(N.list_notifications(limit=99999)["notifications"]), 5)
        self.assertEqual(len(N.list_notifications(limit=2, offset=4)["notifications"]), 1)
        # Junk paging must not throw.
        self.assertTrue(N.list_notifications(limit="x", offset="y")["notifications"])
