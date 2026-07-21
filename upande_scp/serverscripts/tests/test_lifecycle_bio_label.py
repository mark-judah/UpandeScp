import unittest

from upande_scp.serverscripts.spray_plan_creator.lifecycle import (
    _issue_biometric_label,
)


class TestIssueBiometricLabel(unittest.TestCase):
    def test_verified_shows_biometric_check(self):
        self.assertEqual(_issue_biometric_label("Verified"), "Biometric ✓")

    def test_pending_shows_no_biometric(self):
        self.assertEqual(_issue_biometric_label("Pending"), "No biometric")

    def test_none_shows_no_biometric(self):
        self.assertEqual(_issue_biometric_label(None), "No biometric")

    def test_failed_shows_no_biometric(self):
        self.assertEqual(_issue_biometric_label("Failed"), "No biometric")
