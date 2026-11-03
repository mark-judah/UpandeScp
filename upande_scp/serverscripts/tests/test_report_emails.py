"""Report sender suggestion and the weekly greenhouse coverage rows. Pure."""

import unittest
from datetime import date
from unittest import mock

from upande_scp.serverscripts.reports import report_sender as R
from upande_scp.serverscripts.reports import send_weekly_coverage_report as C


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


class TestCoverageRows(unittest.TestCase):
    MON = date(2026, 10, 5)

    def test_rows(self):
        week = [
            {"station": "GH 1", "scout": "E1", "day": date(2026, 10, 5), "n": 30},
            {"station": "GH 1", "scout": "E2", "day": date(2026, 10, 7), "n": 50},
            {"station": "GH 1", "scout": "E1", "day": date(2026, 10, 7), "n": 5},
            {"station": "Elsewhere", "scout": "E1", "day": date(2026, 10, 6), "n": 9},
        ]
        rows = C.build_rows(
            ["GH 1", "GH 2", "GH 3"], self.MON, week,
            {"GH 2": date(2026, 9, 28)}, {"E1": "Ann", "E2": "Ben"},
        )
        # Unscouted first, then by name; a house off the farm list is ignored.
        self.assertEqual([r["station"] for r in rows], ["GH 2", "GH 3", "GH 1"])
        gh1 = rows[2]
        self.assertTrue(gh1["scouted"])
        self.assertEqual(gh1["days"], [0, 2])
        self.assertEqual(gh1["entries"], 85)
        self.assertEqual(gh1["scouts"], [{"name": "Ben", "entries": 50}, {"name": "Ann", "entries": 35}])
        self.assertEqual(rows[0]["last_seen"], date(2026, 9, 28))
        self.assertIsNone(rows[1]["last_seen"])

    def test_last_week_start_is_previous_monday(self):
        self.assertEqual(C.last_week_start("2026-10-28"), date(2026, 10, 19))
        self.assertEqual(C.last_week_start("2026-10-26"), date(2026, 10, 19))
        self.assertEqual(C.last_week_start("2026-10-25"), date(2026, 10, 12))


if __name__ == "__main__":
    unittest.main()
