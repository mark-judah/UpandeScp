"""Bulk approval must produce the same artefacts as single approval.

`approve_drafts_bulk` used to flip a Work Order to ``Approved`` without ever
creating its Material Transfer for Manufacture Stock Entry. The store page
lists only *existing* draft transfers, so a bulk-approved plan silently
vanished from the store side — and because `approve_single_work_order` only
acts on WOs still in ``Awaiting Approval``, the plan could never be recovered
by approving it again. 34 live Work Orders were stranded this way.

These tests pin the two invariants that were missing: every bulk-approved WO
gets a transfer, and a WO whose transfer cannot be created is left in
``Awaiting Approval`` rather than stranded in ``Approved``.
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_plan_creator import bulk


class _FakeDB:
    """Records the state flips bulk approval performs."""

    def __init__(self, awaiting):
        # wo name -> workflow_state
        self.state = {name: "Awaiting Approval" for name in awaiting}
        self.committed = False
        self.rolled_back = False

    def sql(self, query, values=None, as_dict=False):
        q = " ".join(query.split())
        if q.startswith("SELECT 1 FROM `tabHas Role`"):
            return [[1]]
        if "FROM `tabWork Order` WHERE name=" in q and "FOR UPDATE" in q:
            name = values[0]
            if name not in self.state:
                return []
            return [
                frappe._dict(
                    name=name, docstatus=1, workflow_state=self.state[name]
                )
            ]
        if q.startswith("UPDATE `tabWork Order` SET workflow_state="):
            new_state, name = values
            self.state[name] = new_state
            return []
        raise AssertionError(f"unexpected query: {q}")

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def exists(self, *a, **k):
        return True


def _run_bulk(names, transfer_maker):
    """Call approve_drafts_bulk with its collaborators faked out.

    ``transfer_maker`` stands in for the real Stock Entry creation; it records
    which Work Orders actually got a transfer.
    """
    db = _FakeDB(names)
    session = mock.Mock(user="gm@example.com")
    with mock.patch.object(bulk.frappe, "db", db), \
         mock.patch.object(bulk.frappe, "session", session), \
         mock.patch.object(bulk.frappe, "get_doc", mock.Mock()), \
         mock.patch.object(bulk, "create_transfer_stock_entry", transfer_maker, create=True):
        result = bulk.approve_drafts_bulk(names)
    return db, result


class TestBulkApproveCreatesTransfer(unittest.TestCase):
    def test_every_bulk_approved_work_order_gets_a_material_transfer(self):
        made = []
        _run_bulk(
            ["WO-1", "WO-2"],
            lambda wo_name: made.append(wo_name) or f"MAT-STE-{wo_name}",
        )

        self.assertEqual(
            made,
            ["WO-1", "WO-2"],
            "bulk approval left a Work Order with no Material Transfer — "
            "the store side would never see it",
        )

    def test_work_order_is_left_awaiting_approval_when_its_transfer_fails(self):
        def flaky(wo_name):
            if wo_name == "WO-2":
                raise Exception("no stock available")
            return f"MAT-STE-{wo_name}"

        db, result = _run_bulk(["WO-1", "WO-2", "WO-3"], flaky)

        self.assertEqual(
            db.state["WO-2"],
            "Awaiting Approval",
            "a WO whose transfer could not be created must stay approvable; "
            "flipping it to Approved strands it permanently",
        )
        self.assertNotIn("WO-2", result["approved"])


if __name__ == "__main__":
    unittest.main()
