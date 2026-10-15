"""Chemical-store freshness feed for the Chemical Stock treemap."""

import unittest
from datetime import date, datetime, timedelta
from unittest import mock

from upande_scp.serverscripts.spray_plan_creator import stock


class TestStoreFreshness(unittest.TestCase):
	def test_cohorts_get_age_and_batches_get_days_to_expiry(self):
		now = datetime(2026, 10, 15, 12, 0, 0)
		cohorts = {
			("ITM", "Chemical Store A"): [
				{"added_on": now - timedelta(days=100), "qty": 4.0, "greenhouse": None},
				{"added_on": now - timedelta(days=2), "qty": 6.0, "greenhouse": None},
			]
		}
		batch_rows = [
			{"name": "B1", "item": "ITM", "expiry_date": date(2026, 10, 25), "batch_qty": 7},
			{"name": "B2", "item": "ITM", "expiry_date": None, "batch_qty": 3},
		]
		with mock.patch.object(stock, "_csu_age_cohorts", return_value=cohorts) as walk, \
				mock.patch.object(stock.frappe.db, "sql", return_value=batch_rows):
			out_c, out_b = stock._store_freshness(
				{("ITM", "Chemical Store A"): 10.0}, ["ITM"], now
			)
		# the longer store horizon is requested, not the 60-day CSU one
		self.assertEqual(walk.call_args.kwargs["horizon_days"], stock._STORE_AGE_HORIZON_DAYS)
		ages = [c["age_days"] for c in out_c[("ITM", "Chemical Store A")]]
		self.assertEqual(ages, [100.0, 2.0])
		self.assertEqual(out_b["ITM"][0]["days_to_expiry"], 10)
		self.assertEqual(out_b["ITM"][0]["expiry_date"], "2026-10-25")
		self.assertIsNone(out_b["ITM"][1]["days_to_expiry"])
