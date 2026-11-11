"""The old server_clock zone error: tokens recorded with it are put back, and no
synced moment may be later than the server's own clock."""
import unittest
from unittest import mock

import frappe
from frappe.utils import get_datetime

from upande_scp.serverscripts.spray_plan_creator import offline_session as O


class TestZoneSkew(unittest.TestCase):
	def setUp(self):
		self.p = [mock.patch.object(O, "offset_minutes", return_value=180), mock.patch.object(O, "erp_timezone", return_value="Africa/Nairobi")]
		for x in self.p: x.start()

	def tearDown(self):
		for x in self.p: x.stop()

	def test_server_clock_sends_utc(self):
		c = O.server_clock()
		self.assertEqual(c["server_now"], c["utc_now"])
		self.assertIn("site_now", c)

	def test_recognises_the_zone_error(self):
		self.assertEqual(O.zone_skew_correction({"device_skew_seconds": -10801}), 10800)
		self.assertEqual(O.zone_skew_correction({"device_skew_seconds": -10500}), 10800)
		self.assertEqual(O.zone_skew_correction({"device_skew_seconds": -40}), 0)
		self.assertEqual(O.zone_skew_correction({"device_skew_seconds": 7200}), 0)
		self.assertEqual(O.zone_skew_correction({}), 0)

	def test_live_example_is_put_back(self):
		# Chepsito GH 10, 2026-11-11: started 06:54 site time, synced 08:38, skew -10801.
		# The phone sent UTC stamps three hours late; they must land at 06:54 / 07:34.
		payload = {"device_skew_seconds": -10801, "mix_at": "2026-11-11T06:50:00.000Z",
		           "started_at": "2026-11-11T06:54:01.918Z", "ended_at": "2026-11-11T07:34:20.246Z"}
		with mock.patch.object(O, "now_datetime", return_value=get_datetime("2026-11-11 08:38:53")), \
		     mock.patch.object(O, "_moment", side_effect=lambda v: get_datetime(v.replace("T", " ").replace("Z", "")) + __import__("datetime").timedelta(hours=3) if v else None):
			m = O.resolve_moments(payload, None)
		self.assertEqual(str(m["started_at"])[:16], "2026-11-11 06:54")
		self.assertEqual(str(m["ended_at"])[:16], "2026-11-11 07:34")

	def test_nothing_later_than_now(self):
		payload = {"device_skew_seconds": 0, "ended_at": "x"}
		with mock.patch.object(O, "now_datetime", return_value=get_datetime("2026-11-11 08:00:00")), \
		     mock.patch.object(O, "_moment", side_effect=lambda v: get_datetime("2026-11-11 12:00:00") if v else None):
			m = O.resolve_moments(payload, None)
		# Clamped to now; the end then sits one ordering step after the (also clamped) mix.
		self.assertLessEqual(str(m["ended_at"]), "2026-11-11 08:00:01")
		self.assertLessEqual(str(m["mix_at"]), "2026-11-11 08:00:00")
