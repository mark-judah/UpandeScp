"""Tests for the water-volume rebase helper in bulk.submit_drafts_for_approval.

The helper exists as a safety net for legacy drafts whose required_qty is
still the raw BOM line value (the pre-fix frontend never multiplied through
by water volume). The risk is that it also clobbers operator-entered
overrides — a per-1000-L rate the operator manually adjusted in the form
to differ from the BOM default. These tests pin down which side wins.
"""
from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.bulk import (
    _recalc_required_qty_from_water_volume,
)


class TestRecalcRequiredQty(FrappeTestCase):
    """Cover three kinds of draft state the rebase helper can see."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Use synthetic item codes — we never feed these through ERPNext's
        # WO save path, only the rebase helper, which just joins by code.
        cls.item_code = "RECALC-TEST-CHEM"
        cls.fg_code = "RECALC-TEST-MIX"

        # The rebase helper only reads two BOM fields: `parent` (the WO's
        # bom_no) and the line's `stock_qty`. Skip the full BOM doctype
        # plumbing (custom_farm, custom_business_unit, etc.) and stamp the
        # rows directly. Insert tracking flags only as needed — this is a
        # synthetic fixture, not an end-to-end test.
        cls.bom_no = "BOM-RECALC-TEST-DIRECT"
        cls.bom_rate = 2.0
        # Idempotent setup: an earlier failed run may have left stale rows.
        frappe.db.sql("DELETE FROM `tabBOM Item` WHERE parent=%s", (cls.bom_no,))
        frappe.db.sql("DELETE FROM `tabBOM` WHERE name=%s", (cls.bom_no,))
        frappe.db.sql(
            """INSERT INTO `tabBOM`
                  (name, creation, modified, modified_by, owner, docstatus,
                   item, quantity, is_active, is_default)
                VALUES (%s, NOW(), NOW(), 'Administrator', 'Administrator',
                        1, %s, 1, 1, 1)""",
            (cls.bom_no, cls.fg_code),
        )
        frappe.db.sql(
            """INSERT INTO `tabBOM Item`
                  (name, creation, modified, modified_by, owner, docstatus,
                   parent, parenttype, parentfield, idx,
                   item_code, qty, stock_qty, uom, stock_uom, conversion_factor)
                VALUES (%s, NOW(), NOW(), 'Administrator', 'Administrator', 1,
                        %s, 'BOM', 'items', 1,
                        %s, %s, %s, 'Litre', 'Litre', 1)""",
            ("recalc-test-bom-row", cls.bom_no, cls.item_code,
             cls.bom_rate, cls.bom_rate),
        )
        frappe.db.commit()

    @classmethod
    def tearDownClass(cls):
        # Direct SQL teardown matches the direct SQL insert in setUpClass.
        frappe.db.sql("DELETE FROM `tabBOM Item` WHERE parent=%s", (cls.bom_no,))
        frappe.db.sql("DELETE FROM `tabBOM` WHERE name=%s", (cls.bom_no,))
        super().tearDownClass()

    # ──────────────────────────────────────────────────────────────────
    # Helper: stamp a WO + Work Order Item directly via SQL. The rebase
    # helper only reads `custom_type`, `bom_no`, `custom_water_volume`
    # from the WO and `item_code` + `required_qty` from the item — going
    # through frappe.get_doc("Work Order").insert() drags in ERPNext's
    # full manufacturing validation chain (item enabled, warehouse,
    # company, BOM consistency, …) which isn't relevant here.
    # ──────────────────────────────────────────────────────────────────
    def _make_wo(self, *, required_qty: float, water_volume: float) -> str:
        from uuid import uuid4
        wo_name = f"RECALC-WO-{uuid4().hex[:8]}"
        woi_name = f"recalc-woi-{uuid4().hex[:8]}"
        frappe.db.sql(
            """INSERT INTO `tabWork Order`
                  (name, creation, modified, modified_by, owner, docstatus,
                   production_item, bom_no, qty, custom_type,
                   custom_water_volume, custom_area)
                VALUES (%s, NOW(), NOW(), 'Administrator', 'Administrator', 0,
                        %s, %s, 1, 'Application Floor Plan', %s, 0.5)""",
            (wo_name, self.fg_code, self.bom_no, water_volume),
        )
        frappe.db.sql(
            """INSERT INTO `tabWork Order Item`
                  (name, creation, modified, modified_by, owner, docstatus,
                   parent, parenttype, parentfield, idx,
                   item_code, item_name, required_qty, stock_uom)
                VALUES (%s, NOW(), NOW(), 'Administrator', 'Administrator', 0,
                        %s, 'Work Order', 'required_items', 1,
                        %s, 'Recalc Test Chemical', %s, 'Litre')""",
            (woi_name, wo_name, self.item_code, required_qty),
        )
        self.addCleanup(self._delete_wo, wo_name)
        return wo_name

    def _delete_wo(self, name: str) -> None:
        frappe.db.sql(
            "DELETE FROM `tabWork Order Item` WHERE parent=%s", (name,)
        )
        frappe.db.sql("DELETE FROM `tabWork Order` WHERE name=%s", (name,))

    def _row_qty(self, wo_name: str) -> float:
        return float(frappe.db.sql(
            "SELECT required_qty FROM `tabWork Order Item` WHERE parent=%s",
            (wo_name,),
        )[0][0])

    # ──────────────────────────────────────────────────────────────────
    # Cases
    # ──────────────────────────────────────────────────────────────────

    def test_legacy_unscaled_draft_gets_rebased(self):
        """Pre-fix frontend stored raw BOM qty (2.0) regardless of water
        volume. With wv=500, the correct target is 2.0 × 500/1000 = 1.0.
        The rebase should fix this."""
        name = self._make_wo(required_qty=self.bom_rate, water_volume=500)
        _recalc_required_qty_from_water_volume(name)
        self.assertAlmostEqual(self._row_qty(name), 1.0, places=4)

    def test_already_scaled_draft_is_left_alone(self):
        """New frontend already submits bom_rate × wv/1000. No-op rebase."""
        name = self._make_wo(required_qty=1.0, water_volume=500)
        _recalc_required_qty_from_water_volume(name)
        self.assertAlmostEqual(self._row_qty(name), 1.0, places=4)

    def test_operator_override_is_preserved(self):
        """Operator manually bumped the per-1000-L rate to 5 (vs BOM's 2)
        in the form; stock_qty becomes 5 × 500/1000 = 2.5. The rebase
        must NOT overwrite this back to 1.0 — that silently throws away
        the operator's deliberate override."""
        name = self._make_wo(required_qty=2.5, water_volume=500)
        _recalc_required_qty_from_water_volume(name)
        self.assertAlmostEqual(self._row_qty(name), 2.5, places=4)

    def test_no_op_when_water_volume_is_1000(self):
        """At wv=1000 the scaled and unscaled values are identical, so the
        helper has no signal to act on. It should leave required_qty
        untouched even if it equals the BOM rate."""
        name = self._make_wo(required_qty=self.bom_rate, water_volume=1000)
        _recalc_required_qty_from_water_volume(name)
        self.assertAlmostEqual(self._row_qty(name), 2.0, places=4)
