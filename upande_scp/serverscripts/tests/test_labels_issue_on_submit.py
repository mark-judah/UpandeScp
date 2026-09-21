"""Labels belong to what moved, not to what was proposed.

QR labels used to be generated at approval, against a *draft* Material Transfer.
A draft's quantities are a proposal the storesman can still edit, so the sticker
could carry a number that was never issued — and drafts that are never submitted
got labels at all. Labels are now issued when the storesman submits the transfer,
which is the moment the quantity becomes a settled fact.

(kaitet reaches the same conclusion with a richer traceable-code scheme built on
its Spray Product doctype; mona keeps its own simpler QR payload, but the timing
is the part that was wrong.)
"""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.qr import chemical_labels
from upande_scp.serverscripts.spray_plan_creator import stock_entry_state


class _SE:
    """A Stock Entry stand-in.

    Deliberately not ``frappe._dict``: ``items`` is dict's own method there, so
    ``doc.items`` returns the bound method rather than the child rows.
    """

    def __init__(self, name, work_order, items):
        self.name = name
        self.purpose = "Material Transfer for Manufacture"
        self.work_order = work_order
        self.items = items

    def insert(self, **kwargs):
        return None

    def save(self, **kwargs):
        return None


def _se(name="MAT-STE-1", work_order="WO-1", items=("CHEM-A", "CHEM-B")):
    return _SE(
        name,
        work_order,
        [
            frappe._dict(
                item_code=code,
                item_name=code,
                qty=2.0,
                stock_uom="Litre",
                s_warehouse="Store",
                t_warehouse="CSU",
            )
            for code in items
        ],
    )


class _Recorder:
    """Stands in for the QR generator, recording what got attached."""

    def __init__(self):
        self.attached = []

    def attach(self, doctype, name, fname, png_b64):
        self.attached.append((doctype, name, fname))

    def generate(self, payload):
        return "iVBORw0-fake-png"


class TestLabelsAreIssuedOnSubmit(unittest.TestCase):
    def test_submitting_a_spray_transfer_issues_a_label_per_item(self):
        rec = _Recorder()
        doc = _se()
        with mock.patch.object(chemical_labels, "attach_qr_to_document", rec.attach), \
             mock.patch.object(chemical_labels, "generate_qr_base64", rec.generate), \
             mock.patch.object(
                 chemical_labels.frappe, "db",
                 mock.Mock(get_value=mock.Mock(return_value="GH 1")),
             ), \
             mock.patch.object(chemical_labels.frappe, "get_doc",
                               mock.Mock(return_value=frappe._dict(
                                   custom_greenhouse="GH 1", wip_warehouse="CSU"))):
            chemical_labels.issue_for_stock_entry(doc)

        self.assertEqual(
            len(rec.attached), 2,
            "each transferred chemical must get a label once the transfer is submitted",
        )
        self.assertTrue(all(a[1] == "MAT-STE-1" for a in rec.attached))

    def test_the_submit_hook_issues_the_labels(self):
        """on_submit is the hook the storesman's submit actually runs."""
        called = []
        doc = _se()
        db = mock.Mock()
        db.get_value.side_effect = lambda dt, name, field: {
            "custom_type": "Application Floor Plan",
            "workflow_state": "Approved",
        }.get(field)
        with mock.patch.object(stock_entry_state.frappe, "db", db), \
             mock.patch.object(stock_entry_state.frappe, "get_doc",
                               mock.Mock(return_value=mock.Mock())), \
             mock.patch.object(stock_entry_state, "issue_for_stock_entry",
                               lambda d: called.append(d.name), create=True):
            stock_entry_state.on_submit(doc, "on_submit")

        self.assertEqual(
            called, ["MAT-STE-1"],
            "submitting the transfer must issue its labels",
        )


class TestApprovalIssuesNoLabels(unittest.TestCase):
    def test_creating_the_draft_transfer_attaches_nothing(self):
        from upande_scp.serverscripts.spray_plan_ops import spray_plan_approval as sa

        rec = _Recorder()
        se_doc = _se()

        with mock.patch.object(sa.frappe, "get_all", mock.Mock(return_value=[])), \
             mock.patch.object(sa.frappe, "get_doc", mock.Mock(return_value=se_doc)), \
             mock.patch.object(sa, "_patch_zero_rates", mock.Mock(return_value=False)), \
             mock.patch(
                 "erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry",
                 mock.Mock(return_value=se_doc),
             ), \
             mock.patch.object(chemical_labels, "attach_qr_to_document", rec.attach):
            sa.create_transfer_stock_entry("WO-1", frappe._dict(
                custom_greenhouse="GH 1", wip_warehouse="CSU"))

        self.assertEqual(
            rec.attached, [],
            "approval must not label a draft — the quantity is still a proposal",
        )


if __name__ == "__main__":
    unittest.main()
