"""Declarative custom fields on shared doctypes.

The app used to ship these as a Custom Field fixture. A fixture only restores
what some site last exported, so `Work Order.workflow_state` and
`Farm.spray_plan_approvers` — both read by live code, neither ever exported —
were simply absent on a fresh install, and the spray-plan draft and the
approvals page both died with::

    MySQLdb.OperationalError: (1054, "Unknown column 'workflow_state' in 'WHERE'")

These tests pin the properties that failure violated: every declared field
actually materialises, the two that went missing are declared, and the pruning
that keeps the spec authoritative never eats a field belonging to somebody else.

Run: bench --site <site> run-tests \
        --module upande_scp.serverscripts.tests.test_custom_fields
"""

import unittest

import frappe

from upande_scp.serverscripts.common import custom_fields as cf


class TestCustomFieldSpec(unittest.TestCase):
    """Spec-level checks. No database writes."""

    def test_the_two_fields_that_went_missing_are_declared(self):
        """Regression: both produced a 1054 on staging."""
        spec = cf._field_spec()
        wo = {r["fieldname"] for r in spec["Work Order"]}
        farm = {r["fieldname"] for r in spec["Farm"]}
        self.assertIn("workflow_state", wo)
        self.assertIn("spray_plan_approvers", farm)

    def test_workflow_state_matches_frappes_own_shape(self):
        """`allow_on_submit` is load-bearing, not cosmetic: AFP Work Orders are
        submitted and the entire lifecycle happens afterwards, so without it
        every state transition is refused on save."""
        row = next(
            r for r in cf._field_spec()["Work Order"] if r["fieldname"] == "workflow_state"
        )
        self.assertEqual(row["fieldtype"], "Link")
        self.assertEqual(row["options"], "Workflow State")
        self.assertEqual(row.get("allow_on_submit"), 1)
        self.assertEqual(row.get("no_copy"), 1)

    def test_every_row_declares_the_minimum(self):
        for doctype, rows in cf._field_spec().items():
            for row in rows:
                for key in ("fieldname", "label", "fieldtype", "insert_after"):
                    self.assertIn(key, row, f"{doctype}.{row.get('fieldname')} missing {key}")

    def test_fieldnames_are_unique_per_doctype(self):
        for doctype, rows in cf._field_spec().items():
            names = [r["fieldname"] for r in rows]
            self.assertEqual(len(names), len(set(names)), f"{doctype} has duplicates")

    def test_link_and_table_fields_name_their_target(self):
        for doctype, rows in cf._field_spec().items():
            for row in rows:
                if row["fieldtype"] in ("Link", "Table", "Table MultiSelect"):
                    self.assertTrue(
                        row.get("options"),
                        f"{doctype}.{row['fieldname']} is a {row['fieldtype']} with no options",
                    )

    def test_the_layout_tab_is_not_claimed_here(self):
        """`scouting_tab_layout` owns the tab break. Declaring it in both places
        would have the two modules fight over its `depends_on`."""
        for doctype, rows in cf._field_spec().items():
            self.assertNotIn(
                cf.TAB,
                {r["fieldname"] for r in rows},
                f"{doctype} claims the layout tab break",
            )

    def test_stock_entry_is_left_to_its_own_module(self):
        """One mechanism per doctype — `store.stock_entry_fields` owns these."""
        spec = cf._field_spec()
        self.assertNotIn("Stock Entry", spec)
        self.assertNotIn("Stock Entry Detail", spec)


class TestCustomFieldsMaterialise(unittest.TestCase):
    """Runs the ensure pass and checks the database agrees with the spec."""

    @classmethod
    def setUpClass(cls):
        frappe.set_user("Administrator")
        cf.ensure_scp_custom_fields()

    def test_every_declared_field_exists_on_its_doctype(self):
        missing = []
        for doctype, rows in cf._field_spec().items():
            if not frappe.db.table_exists(doctype):
                continue
            meta = frappe.get_meta(doctype, cached=False)
            for row in rows:
                if not meta.get_field(row["fieldname"]):
                    missing.append(f"{doctype}.{row['fieldname']}")
        self.assertEqual(missing, [], f"declared but absent: {missing}")

    def test_every_declared_field_has_a_column(self):
        """A field in meta with no column is what the 1054 actually was."""
        NO_COLUMN = {"Section Break", "Column Break", "Tab Break", "Table", "HTML"}
        missing = []
        for doctype, rows in cf._field_spec().items():
            if not frappe.db.table_exists(doctype):
                continue
            for row in rows:
                if row["fieldtype"] in NO_COLUMN:
                    continue
                if not frappe.db.has_column(doctype, row["fieldname"]):
                    missing.append(f"{doctype}.{row['fieldname']}")
        self.assertEqual(missing, [], f"no DB column: {missing}")

    def test_work_order_workflow_state_is_queryable(self):
        """The exact query shape that failed on staging."""
        frappe.db.sql(
            "SELECT name FROM `tabWork Order` WHERE workflow_state = %s LIMIT 1",
            ("Awaiting Approval",),
        )

    def test_running_twice_is_a_no_op(self):
        before = frappe.db.count("Custom Field", {"module": cf.MODULE})
        cf.ensure_scp_custom_fields()
        self.assertEqual(frappe.db.count("Custom Field", {"module": cf.MODULE}), before)


class TestPruningExemptions(unittest.TestCase):
    """What the spec-is-truth pruning must never delete."""

    def test_accounting_dimension_fields_are_protected(self):
        """Dropping one would strip attribution from the stock ledger and GL."""
        dims = cf._dimension_fieldnames()
        if not dims:
            self.skipTest("no Accounting Dimensions configured on this site")
        spec_fields = {
            r["fieldname"] for rows in cf._field_spec().values() for r in rows
        }
        self.assertEqual(dims & spec_fields, set(), "spec claims a dimension field")

    def test_sibling_module_fields_are_protected(self):
        """`farm_fields` owns custom_farm with create-only semantics; pruning
        must not treat it as stale just because this spec omits it."""
        self.assertIn("custom_farm", cf._sibling_owned())

    def test_a_stale_scp_field_is_pruned(self):
        name = None
        try:
            doc = frappe.get_doc({
                "doctype": "Custom Field",
                "dt": "Work Order",
                "fieldname": "custom_scp_test_stale_field",
                "label": "SCP Test Stale Field",
                "fieldtype": "Data",
                "module": cf.MODULE,
            }).insert(ignore_permissions=True)
            name = doc.name
            cf.ensure_scp_custom_fields()
            self.assertFalse(frappe.db.exists("Custom Field", name))
            name = None
        finally:
            if name and frappe.db.exists("Custom Field", name):
                frappe.delete_doc("Custom Field", name, force=True, ignore_permissions=True)

    def test_a_foreign_field_is_not_pruned(self):
        """Another app's field on a doctype we also write to stays put."""
        name = None
        try:
            doc = frappe.get_doc({
                "doctype": "Custom Field",
                "dt": "Work Order",
                "fieldname": "custom_scp_test_foreign_field",
                "label": "SCP Test Foreign Field",
                "fieldtype": "Data",
                "module": "Core",
            }).insert(ignore_permissions=True)
            name = doc.name
            cf.ensure_scp_custom_fields()
            self.assertTrue(frappe.db.exists("Custom Field", name))
        finally:
            if name and frappe.db.exists("Custom Field", name):
                frappe.delete_doc("Custom Field", name, force=True, ignore_permissions=True)
