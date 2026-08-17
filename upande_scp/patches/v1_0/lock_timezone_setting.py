"""Turn the timezone lock on for sites that already exist.

A Check field's `default` only applies to documents created after it is added, and the
settings Single predates this field on every existing site — so without this the most
consequential setting in the app would sit unlocked everywhere it already runs.

Also *reports* whether the site timezone looks wrong, without touching it. On kaitet it
was still Frappe's out-of-the-box `Asia/Kolkata` while every farm coordinate is Kenyan,
putting every timestamp and every scheduled job 2h30m out of step. A patch must not
silently re-time another deployment's notifications, so this only says so in the migrate
log, loudly enough to be acted on.
"""

import frappe

SETTINGS = "Scouting and Crop Protection Settings"


def execute():
	if not frappe.db.exists("DocType", SETTINGS):
		return

	current = frappe.db.get_single_value(SETTINGS, "timezone_locked")
	if not current:
		frappe.db.set_single_value(SETTINGS, "timezone_locked", 1)
		print("[lock_timezone_setting] timezone lock turned on")

	try:
		from upande_scp.serverscripts.common.timezone import (
			erp_timezone,
			expected_timezone,
			timezone_report,
		)

		erp = erp_timezone()
		expected = expected_timezone()
		if expected and expected != erp:
			for warning in timezone_report()["warnings"]:
				print(f"[lock_timezone_setting] WARNING: {warning}")
			print(
				"[lock_timezone_setting] Fix it in System Settings → Time Zone. Not "
				"changed automatically: re-timing a live site's notifications and "
				"scheduled reports is not a patch's decision."
			)
		else:
			print(f"[lock_timezone_setting] site timezone {erp} looks right")
	except Exception:
		# A reporting step must never fail a migration.
		frappe.log_error(frappe.get_traceback(), "lock_timezone_setting: report failed")
