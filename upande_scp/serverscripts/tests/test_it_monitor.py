import json
import unittest
from datetime import datetime, timedelta

import frappe
from frappe.utils import add_days, now_datetime

from upande_scp.serverscripts.it_monitor import clean as C
from upande_scp.serverscripts.it_monitor import dashboard as D
from upande_scp.serverscripts.it_monitor import ingest as I
from upande_scp.serverscripts.it_monitor import redaction as R


class TestCleaning(unittest.TestCase):
	"""Pure: no site needed beyond to_site_time, which these never call."""

	def test_redaction_of_secrets_in_messages(self):
		t = R.redact_text("failed with Authorization: Bearer abcdefghijklmnop and password=hunter2 ok")
		self.assertNotIn("abcdefghijklmnop", t)
		self.assertNotIn("hunter2", t)
		self.assertIn("[redacted]", t)

	def test_event_url_drops_host_and_query(self):
		ev = C.clean_event({"kind": "api_error", "req_url": "https://x.example/api/method/a.b?sid=SECRET&x=1", "req_status": 500})
		self.assertEqual(ev["req_url"], "/api/method/a.b")
		self.assertNotIn("SECRET", json.dumps(ev, default=str))

	def test_event_clipping_and_coercion(self):
		ev = C.clean_event({"kind": "bogus", "message": "m" * 5000, "count": "abc", "level": "x", "req_status": "99999", "fatal": "true"})
		self.assertEqual(ev["kind"], "error")
		self.assertEqual(len(ev["message"]) < 2100, True)
		self.assertEqual(ev["count"], 1)
		self.assertEqual(ev["level"], "error")
		self.assertEqual(ev["req_status"], 999)
		self.assertEqual(ev["fatal"], 1)

	def test_empty_event_dropped_but_login_kept(self):
		self.assertIsNone(C.clean_event({"kind": "error"}))
		self.assertIsNone(C.clean_event("nope"))
		self.assertEqual(C.clean_event({"kind": "login"})["level"], "info")

	def test_future_ts_pinned_and_crash_fatal(self):
		now = datetime(2026, 11, 12, 10, 0, 0)
		ev = C.clean_event({"kind": "crash", "message": "boom", "ts": "2030-01-01T00:00:00Z"}, now)
		self.assertEqual(ev["ts_utc"], now)
		self.assertEqual((ev["level"], ev["fatal"]), ("fatal", 1))

	def test_fingerprint_groups_numbers_and_splits_status(self):
		f = lambda m, s=500: C.event_fingerprint("api_error", "", "", "GET", "/api/resource/Item/ITM-0042", s, m)
		self.assertEqual(f("a"), C.event_fingerprint("api_error", "", "", "GET", "/api/resource/Item/ITM-0043", 500, "b"))
		self.assertNotEqual(f("a", 500), f("a", 404))
		g = lambda m: C.event_fingerprint("error", "TypeError", "", "", "", 0, m)
		self.assertEqual(g("Item 12 not found"), g("Item 99 not found"))
		self.assertNotEqual(g("alpha"), g("beta"))

	def test_status_computation(self):
		now = datetime(2026, 11, 12, 12, 0)
		ok = now - timedelta(hours=1)
		self.assertEqual(C.compute_status("1.0.11", ok, "1.0.12", now), "Behind")
		self.assertEqual(C.compute_status("1.0.12", ok, "1.0.12", now), "Current")
		self.assertEqual(C.compute_status("1.1.0", ok, "1.0.12", now), "Current")
		self.assertEqual(C.compute_status("", ok, "1.0.12", now), "Unknown")
		self.assertEqual(C.compute_status("1.0.12", ok, "", now), "Unknown")
		self.assertEqual(C.compute_status("1.0.12", now - timedelta(days=8), "1.0.12", now), "Dormant")
		self.assertEqual(C.highest_version(["1.0.9", "1.0.12", "junk"]), "1.0.12")

	def test_stuck_computation(self):
		now = datetime(2026, 11, 12, 12, 0)  # site time; to_site_time shifts UTC input by the site offset
		old = C.to_site_time(datetime(2026, 11, 12, 12, 0) - timedelta(hours=2))
		fresh = C.to_site_time(datetime(2026, 11, 12, 12, 0) - timedelta(minutes=5))
		# age is measured against site now, so build "now" from the same conversion
		site_now = C.to_site_time(datetime(2026, 11, 12, 12, 0))
		q = C.clean_queues(
			{
				"scouting": {"pending": 4, "failed": 1, "held": 0, "refused": 2, "oldest_at": "2026-11-12T10:00:00Z"},
				"pest_images": {"pending": 3, "oldest_at": "2026-11-12T11:55:00Z"},
				"mystery": {"pending": 1, "failed": 1},
				"traps": "bad",
			},
			site_now,
		)
		self.assertEqual(q["scouting"]["stuck"], 1 + 0 + 2 + 4)
		self.assertEqual(q["pest_images"]["stuck"], 0)
		self.assertEqual(q["other"]["stuck"], 1)
		self.assertNotIn("traps", q)
		pending, stuck, oldest = C.queue_totals(q)
		self.assertEqual((pending, stuck), (8, 8))
		self.assertEqual(oldest, q["scouting"]["oldest_at"])  # earliest of the two


class TestEndpoints(unittest.TestCase):
	"""Real doctypes on kaitet.local; everything is rolled back."""

	def setUp(self):
		frappe.flags.in_test = True
		frappe.set_user("Administrator")

	def tearDown(self):
		frappe.db.rollback()
		frappe.set_user("Administrator")

	def _reg(self, install_id, **kw):
		payload = {
			"install_id": install_id, "platform": "android", "device_brand": "Samsung", "device_model": "A14",
			"app_version": "1.0.11", "runtime_version": "1.0", "reason": "launch", "login": True, "app_role": "scout",
			"device_info": {"battery_level": 0.1, "battery_state": "unplugged", "storage_free_bytes": 100 * 1024 * 1024,
			                "storage_total_bytes": 32 * 1024**3, "is_connected": True},
			"queues": {"scouting": {"pending": 5, "failed": 1, "oldest_at": "2020-01-01T00:00:00Z"}},
		}
		payload.update(kw)
		return I.register_device(json.dumps(payload))

	def test_register_and_status(self):
		a = self._reg("TESTDEV-AAAA1111", app_version="1.0.11")
		self.assertEqual(set(a), {"install_id", "status", "latest_app_version", "server_time"})
		self._reg("TESTDEV-BBBB2222", app_version="1.0.12")
		row = frappe.get_doc("SCP Mobile Device", "TESTDEV-AAAA1111")
		self.assertEqual(row.launches, 1)
		self.assertEqual(row.stuck_total, 6)
		self.assertEqual(row.pending_total, 5)
		self.assertEqual(row.connectivity, "online")
		self.assertTrue(row.last_login_at)
		# second report: upgrade, still one row
		r = self._reg("TESTDEV-AAAA1111", app_version="1.0.12", reason="heartbeat", login=False)
		self.assertEqual(r["status"], "Current")
		row.reload()
		self.assertEqual((row.previous_app_version, row.app_version, row.launches), ("1.0.11", "1.0.12", 1))
		# garbage never refuses
		self._reg("TESTDEV-CCCC3333", app_version="zzz", device_info={"battery_level": "nan", "storage_free_bytes": "x"}, queues="bad", clock_skew_seconds="q")
		self.assertEqual(frappe.db.get_value("SCP Mobile Device", "TESTDEV-CCCC3333", "status"), "Unknown")
		with self.assertRaises(frappe.ValidationError):
			I.register_device({"install_id": "x"})

	def test_setting_overrides_latest(self):
		frappe.db.set_single_value("Scouting and Crop Protection Settings", "it_latest_app_version", "2.0.0")
		self.assertEqual(self._reg("TESTDEV-DDDD4444", app_version="1.0.12")["status"], "Behind")

	def test_events_dedupe_and_redaction(self):
		self._reg("TESTDEV-EEEE5555")
		evs = [
			{"event_id": "e1", "kind": "crash", "message": "boom token=abc123456789", "stack": "Error: x\n at f (app/a.js:1:2)", "ts": "2026-11-12T08:00:00Z"},
			{"event_id": "e2", "kind": "api_error", "req_method": "POST", "req_url": "https://h/api/method/x.y?key=SECRET", "req_status": 500, "ts": "2026-11-12T08:01:00Z"},
			{"event_id": "e1", "kind": "crash", "message": "dup in batch"},
			{"event_id": "e3", "kind": "sync", "message": "ok"},
			{"kind": "error"},  # empty: ignored
		]
		self.assertEqual(I.report_events("TESTDEV-EEEE5555", json.dumps(evs)), {"accepted": 3, "duplicates": 1})
		self.assertEqual(I.report_events("TESTDEV-EEEE5555", evs), {"accepted": 0, "duplicates": 4})
		stored = frappe.get_all("SCP Mobile Event", filters={"install_id": "TESTDEV-EEEE5555"}, fields=["message", "req_url", "fingerprint", "kind", "user"])
		blob = json.dumps(stored)
		self.assertNotIn("abc123456789", blob)
		self.assertNotIn("SECRET", blob)
		self.assertTrue(all(e.user == "Administrator" for e in stored))
		self.assertEqual({e.kind for e in stored if e.fingerprint}, {"crash", "api_error"})
		# capped at 200 per call
		many = [{"event_id": f"m{i}", "kind": "error", "message": f"m{i}"} for i in range(250)]
		self.assertEqual(I.report_events("TESTDEV-EEEE5555", many)["accepted"], 200)

	def test_overview_devices_device_issues_logins_data_flow(self):
		self._reg("TESTDEV-FFFF6666", app_version="1.0.11")
		self._reg("TESTDEV-GGGG7777", app_version="1.0.12", device_info={"battery_level": 0.9, "is_connected": False}, queues={"traps": {"pending": 1}})
		stale = self._reg("TESTDEV-HHHH8888", app_version="1.0.12")
		frappe.db.set_value("SCP Mobile Device", "TESTDEV-HHHH8888", "last_seen", add_days(now_datetime(), -10))
		for dev in ("TESTDEV-FFFF6666", "TESTDEV-GGGG7777"):
			I.report_events(dev, [
				{"event_id": "c1", "kind": "crash", "message": "boom 12", "stack": "Error\n at f (app/a.js:1:2)"},
				{"event_id": "l1", "kind": "login", "message": "signed in"},
			])
		ov = D.overview(7)
		self.assertEqual(set(ov), {"devices", "versions", "latest_app_version", "errors", "logins_today", "stuck_by_queue"})
		self.assertEqual(set(ov["devices"]), {"total", "active_24h", "behind", "dormant", "low_battery", "low_storage", "with_stuck"})
		self.assertGreaterEqual(ov["devices"]["total"], 3)
		self.assertGreaterEqual(ov["devices"]["dormant"], 1)
		self.assertGreaterEqual(ov["devices"]["low_battery"], 1)
		self.assertGreaterEqual(ov["devices"]["with_stuck"], 1)
		self.assertGreaterEqual(ov["errors"]["crashes"], 2)
		self.assertTrue(all({"app_version", "runtime_version", "devices"} <= set(v) for v in ov["versions"]))
		self.assertGreaterEqual(ov["stuck_by_queue"].get("scouting", 0), 6)

		rows = D.devices(search="TESTDEV-FFFF")
		self.assertEqual([r.install_id for r in rows], ["TESTDEV-FFFF6666"])
		self.assertEqual(rows[0].status, "Behind")
		self.assertIsInstance(rows[0].queues, dict)
		self.assertIn("low_battery", rows[0].flags)
		self.assertEqual([r.install_id for r in D.devices(status="Dormant", search="TESTDEV")], ["TESTDEV-HHHH8888"])
		self.assertTrue(all(r.stuck_total > 0 for r in D.devices(stuck_only=1)))

		d = D.device("TESTDEV-FFFF6666")
		self.assertEqual(set(d), {"device", "events", "queues", "snapshot", "latest_app_version"})
		self.assertEqual(len(d["events"]), 2)
		self.assertEqual(d["snapshot"]["battery_level"], 0.1)
		with self.assertRaises(frappe.DoesNotExistError):
			D.device("NOPE-NOPE-NOPE")

		iss = D.issues(7)
		mine = [i for i in iss if i["title"].startswith("boom")]
		self.assertEqual(len(mine), 1)  # two devices, one fingerprint
		self.assertEqual((mine[0]["devices"], mine[0]["events"]), (2, 2))
		self.assertEqual(set(mine[0]), {"fingerprint", "kind", "level", "title", "events", "users", "devices", "first_seen", "last_seen", "last_version"})
		self.assertEqual(D.issues(7, kind="api_error") == [] or all(i["kind"] == "api_error" for i in D.issues(7, kind="api_error")), True)

		lg = D.logins(7)
		self.assertEqual(set(lg), {"days", "summary", "rows"})
		self.assertEqual(set(lg["summary"]), {"success", "failed", "logouts"})
		device_rows = [r for r in lg["rows"] if r["source"] == "device"]
		self.assertGreaterEqual(len(device_rows), 2)
		self.assertTrue(all(r["install_id"] for r in device_rows))

		df = D.data_flow(7)
		self.assertEqual(set(df), {"from_date", "to_date", "daily", "scouting_by_scout", "device_queues"})
		self.assertEqual(len(df["daily"]), 7)
		self.assertEqual(set(df["daily"][0]), {"date", "scouting_entries", "scouts", "pest_photos", "csu_scans", "spray_pending", "spray_synced", "spray_held", "spray_partial", "spray_refused"})
		self.assertGreaterEqual(df["device_queues"]["scouting"]["stuck"], 6)
		self.assertGreaterEqual(df["device_queues"]["traps"]["pending"], 1)
		self.assertEqual(len(D.data_flow(30, farm=frappe.db.get_value("Farm", {}, "name"))["daily"]), 30)

	def test_permission(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			D.overview()
		with self.assertRaises(frappe.AuthenticationError):
			I.register_device({"install_id": "TESTDEV-ZZZZ0000"})

	def test_retention_purges_old_events(self):
		self._reg("TESTDEV-IIII9999")
		I.report_events("TESTDEV-IIII9999", [{"event_id": "old", "kind": "error", "message": "old one", "ts": "2020-01-01T00:00:00Z"}])
		frappe.db.set_value("SCP Mobile Event", {"event_id": "old", "install_id": "TESTDEV-IIII9999"}, "ts", add_days(now_datetime(), -90))
		self.assertGreaterEqual(I.purge_old_events(commit=False), 1)
		self.assertFalse(frappe.db.exists("SCP Mobile Event", {"event_id": "old", "install_id": "TESTDEV-IIII9999"}))
