import frappe
from frappe.tests.utils import FrappeTestCase

from upande_scp.serverscripts.spray_plan_creator.validation import (
    derive_cost_center, validate_preventive_reason, validate_rate_in_limits,
    validate_targets_in_scope,
)


class TestValidationHelpers(FrappeTestCase):
    def test_preventive_reason_short_raises(self):
        with self.assertRaisesRegex(frappe.ValidationError, "20 characters"):
            validate_preventive_reason("Preventive", "too short")

    def test_preventive_reason_ok(self):
        validate_preventive_reason("Preventive", "Routine prophylactic spray as per agronomy schedule.")

    def test_curative_reason_ignored(self):
        # Curative plans don't need a reason; should never raise
        validate_preventive_reason("Curative", "")

    def test_rate_below_limit_raises(self):
        with self.assertRaisesRegex(frappe.ValidationError, "lower"):
            validate_rate_in_limits("XYZ", 0.1, {"XYZ": {"lower": 1.0, "upper": 5.0}})

    def test_rate_above_limit_raises(self):
        with self.assertRaisesRegex(frappe.ValidationError, "upper"):
            validate_rate_in_limits("XYZ", 6.0, {"XYZ": {"lower": 1.0, "upper": 5.0}})

    def test_rate_within_ok(self):
        validate_rate_in_limits("XYZ", 3.0, {"XYZ": {"lower": 1.0, "upper": 5.0}})

    def test_rate_no_limits_ok(self):
        validate_rate_in_limits("XYZ", 100.0, {})

    def test_derive_cost_center_missing_raises(self):
        with self.assertRaisesRegex(frappe.ValidationError, "Cost Center"):
            derive_cost_center("DoesNotExist GH 99 - ZZ")

    def test_targets_curative_unknown_raises(self):
        with self.assertRaises(frappe.ValidationError):
            validate_targets_in_scope("Curative", ["NeverObservedPest"],
                                       greenhouse="NonexistentGH", days=60)

    def test_targets_preventive_empty_list_raises(self):
        with self.assertRaises(frappe.ValidationError):
            validate_targets_in_scope("Preventive", [], greenhouse=None)
