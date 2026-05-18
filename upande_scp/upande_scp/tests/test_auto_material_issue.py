"""Tests for the auto-Material-Issue hook on Manufacture Stock Entry submit."""
from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
    on_manufacture_submit,
)


class _FakeSE:
    """Minimal stand-in for a Stock Entry doc — only the fields the handler reads."""

    def __init__(self, purpose: str = "Manufacture", work_order: str | None = None):
        self.purpose = purpose
        self.work_order = work_order


class TestAutoMaterialIssueNoOp(FrappeTestCase):
    def test_non_manufacture_purpose_is_noop(self):
        """A Material Transfer SE must not trigger the auto-issue handler."""
        se = _FakeSE(purpose="Material Transfer", work_order="MFG-WO-FAKE")
        # Should return None and raise nothing.
        self.assertIsNone(on_manufacture_submit(se, method="on_submit"))

    def test_manufacture_without_work_order_is_noop(self):
        se = _FakeSE(purpose="Manufacture", work_order=None)
        self.assertIsNone(on_manufacture_submit(se, method="on_submit"))
