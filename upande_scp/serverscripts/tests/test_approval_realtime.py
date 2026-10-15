"""The approvals desk is told when an AFP Work Order appears or changes state.

Pure of the database apart from the doctype lookups, which are patched: the
point is the event name, payload, recipients and the state-change guard.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.spray_plan_ops import approval_realtime as RT


class FakeWO(dict):
    """Enough of a Work Order for the hooks."""

    def __init__(self, changed=True, in_insert=False, **fields):
        base = {
            "name": "WO-TEST-1", "custom_type": RT.AFP_TYPE, "custom_greenhouse": "GH 1 - X",
            "workflow_state": "Awaiting Approval",
            "custom_scheduled_application_time": "2026-10-15 08:00:00",
            "planned_start_date": "2026-10-14 06:00:00", "creation": "2026-10-13 09:00:00",
        }
        super().__init__({**base, **fields})
        self.name = self["name"]
        self.flags = SimpleNamespace(in_insert=in_insert)
        self._changed = changed

    def has_value_changed(self, fieldname):
        return self._changed


def run_with(fn, doc, users=("gm@example.com", "appr@example.com")):
    with patch.object(RT, "recipients", return_value=list(users)) as rec, \
         patch.object(RT.farm_map, "farm_for_warehouse", return_value="Farm X"), \
         patch.object(frappe, "publish_realtime") as pub:
        fn(doc)
    return rec, pub


class TestApprovalRealtime(unittest.TestCase):
    def test_event_name_is_stable(self):
        self.assertEqual(RT.EVENT, "scp:spray_plan")

    def test_insert_publishes_created_to_each_approver_after_commit(self):
        rec, pub = run_with(RT.after_insert, FakeWO())
        rec.assert_called_once_with("GH 1 - X")
        self.assertEqual(pub.call_count, 2)
        users = set()
        for call in pub.call_args_list:
            self.assertEqual(call.args[0], "scp:spray_plan")
            self.assertTrue(call.kwargs["after_commit"])
            users.add(call.kwargs["user"])
            body = call.args[1]
            self.assertEqual(body, {
                "change": "created", "name": "WO-TEST-1", "workflow_state": "Awaiting Approval",
                "date": "2026-10-15", "created": "2026-10-13", "farm": "Farm X", "greenhouse": "GH 1 - X",
            })
        self.assertEqual(users, {"gm@example.com", "appr@example.com"})

    def test_date_falls_back_to_planned_start(self):
        _rec, pub = run_with(RT.on_submit, FakeWO(custom_scheduled_application_time=None))
        body = pub.call_args_list[0].args[1]
        self.assertEqual((body["change"], body["date"]), ("submitted", "2026-10-14"))

    def test_state_change_publishes_only_when_workflow_state_moved(self):
        _rec, pub = run_with(RT.on_update, FakeWO(changed=True, workflow_state="Approved"))
        self.assertEqual(pub.call_args_list[0].args[1]["change"], "state_changed")
        self.assertEqual(pub.call_args_list[0].args[1]["workflow_state"], "Approved")
        _rec, pub = run_with(RT.on_update, FakeWO(changed=False))
        pub.assert_not_called()

    def test_the_insert_save_does_not_double_publish(self):
        _rec, pub = run_with(RT.on_update, FakeWO(in_insert=True))
        pub.assert_not_called()

    def test_other_work_orders_are_ignored(self):
        _rec, pub = run_with(RT.after_insert, FakeWO(custom_type="Production"))
        pub.assert_not_called()

    def test_a_publish_failure_never_breaks_the_save(self):
        with patch.object(RT, "recipients", side_effect=RuntimeError("redis down")), \
             patch.object(frappe, "log_error") as log:
            RT.after_insert(FakeWO())
        log.assert_called_once()

    def test_hooks_are_registered_on_work_order(self):
        from upande_scp import hooks
        wo = hooks.doc_events["Work Order"]
        base = "upande_scp.serverscripts.spray_plan_ops.approval_realtime."
        self.assertEqual(wo["after_insert"], base + "after_insert")
        self.assertEqual(wo["on_submit"], base + "on_submit")
        self.assertEqual(wo["on_update"], base + "on_update")


class TestRecipients(unittest.TestCase):
    def test_scope_filters_approvers_and_disabled_users_are_skipped(self):
        def allowed(user):
            return {"gm@example.com": None, "scoped@example.com": ["GH 9"], "off@example.com": None}[user]

        with patch.object(frappe, "get_all", return_value=["gm@example.com", "scoped@example.com", "off@example.com", "Guest"]), \
             patch.object(frappe.db, "get_value", side_effect=lambda dt, u, f: u != "off@example.com"), \
             patch.object(RT.approval, "_approver_allowed_greenhouses", side_effect=allowed), \
             patch.object(RT.crop_scope, "scoped_greenhouses", return_value=None):
            self.assertEqual(RT.recipients("GH 1 - X"), ["gm@example.com"])
            self.assertEqual(sorted(RT.recipients("GH 9")), ["gm@example.com", "scoped@example.com"])
