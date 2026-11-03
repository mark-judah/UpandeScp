"""Report sender suggestion and per-company resolution. Pure."""

import unittest
from unittest import mock

from upande_scp.serverscripts.reports import report_sender as R


def acct(name, last_hour=0, queued=0, failed=0, is_default=0):
    return {"name": name, "last_hour": last_hour, "queued": queued, "failed": failed, "is_default": is_default}


class TestSuggest(unittest.TestCase):
    def test_least_busy_wins(self):
        self.assertEqual(R.suggest([acct("A", last_hour=40), acct("B", last_hour=3)]), "B")

    def test_failing_account_never_beats_a_healthy_one(self):
        self.assertEqual(R.suggest([acct("A", failed=1), acct("B", last_hour=500)]), "B")

    def test_backlog_counts_as_busy(self):
        self.assertEqual(R.suggest([acct("A", last_hour=1, queued=90), acct("B", last_hour=20)]), "B")

    def test_tie_goes_to_the_default(self):
        self.assertEqual(R.suggest([acct("A"), acct("B", is_default=1)]), "B")

    def test_no_accounts(self):
        self.assertIsNone(R.suggest([]))


ADDR = {"Default Acct": "default@x.test", "Roses Acct": "roses@x.test", "Off Acct": None}


def _addr(name):
    return ADDR.get(name)


class TestReportSenderPerCompany(unittest.TestCase):
    """Resolution: the company's account, else the default, else None."""

    def resolve(self, company, per_company, default="Default Acct"):
        with mock.patch.object(R, "company_accounts", return_value=per_company), \
                mock.patch.object(R, "chosen_account", return_value=default), \
                mock.patch.object(R, "_usable_address", side_effect=_addr):
            return R.report_sender(company)

    def test_company_row_wins(self):
        self.assertEqual(self.resolve("Roses Co", {"Roses Co": "Roses Acct"}), "roses@x.test")

    def test_company_without_row_uses_default(self):
        self.assertEqual(self.resolve("Avocado Co", {"Roses Co": "Roses Acct"}), "default@x.test")

    def test_no_company_uses_default(self):
        self.assertEqual(self.resolve(None, {"Roses Co": "Roses Acct"}), "default@x.test")

    def test_unusable_company_account_falls_back_to_default(self):
        self.assertEqual(self.resolve("Roses Co", {"Roses Co": "Off Acct"}), "default@x.test")

    def test_deleted_company_account_falls_back_to_default(self):
        self.assertEqual(self.resolve("Roses Co", {"Roses Co": "Gone"}), "default@x.test")

    def test_nothing_usable_is_none(self):
        self.assertIsNone(self.resolve("Roses Co", {"Roses Co": "Off Acct"}, default=None))
        self.assertIsNone(self.resolve("Roses Co", {}, default="Off Acct"))

    def test_sole_company(self):
        self.assertEqual(R.sole_company(["A", "A", None]), "A")
        self.assertIsNone(R.sole_company(["A", "B"]))
        self.assertIsNone(R.sole_company([]))

    def test_farms_of_two_companies_use_the_default(self):
        owner = {"F1": "Roses Co", "F2": "Roses Co", "F3": "Avocado Co"}
        with mock.patch.object(R, "company_of_farm", side_effect=owner.get), \
                mock.patch.object(R, "report_sender", side_effect=lambda c=None: c or "DEFAULT"):
            self.assertEqual(R.sender_for_farms(["F1", "F2"]), "Roses Co")
            self.assertEqual(R.sender_for_farms(["F1", "F3"]), "DEFAULT")
            self.assertEqual(R.sender_for_farms([]), "DEFAULT")


if __name__ == "__main__":
    unittest.main()
