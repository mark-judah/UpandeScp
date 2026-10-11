"""Pure crew-availability rules: approved vs open leave, half day, check-in, Off/Warn/Block."""

from datetime import date

from upande_scp.serverscripts.common import crew_availability as CA
from upande_scp.serverscripts.spray_plan_ops.schedule import NO_TEAM, resolve_team

DAY = date(2026, 9, 3)


def _leave(status="Approved", docstatus=1, frm="2026-09-01", to="2026-09-05", **kw):
	return {"name": "HR-LAP-1", "status": status, "docstatus": docstatus,
			"from_date": frm, "to_date": to, "leave_type": "Annual Leave", **kw}


def test_approved_leave_covering_the_date_is_on_leave():
	st = CA.classify(DAY, [_leave()])
	assert st["status"] == CA.ON_LEAVE
	assert st["leave_application"] == "HR-LAP-1"


def test_leave_outside_the_date_is_ok():
	assert CA.classify(DAY, [_leave(frm="2026-09-04", to="2026-09-06")])["status"] == CA.OK
	assert CA.classify(DAY, [_leave(frm="2026-08-30", to="2026-09-02")])["status"] == CA.OK


def test_the_range_is_inclusive_at_both_ends():
	assert CA.classify(DAY, [_leave(frm="2026-09-03", to="2026-09-03")])["status"] == CA.ON_LEAVE


def test_open_application_is_only_pending():
	st = CA.classify(DAY, [_leave(status="Open", docstatus=0)])
	assert st["status"] == CA.LEAVE_PENDING


def test_rejected_and_cancelled_are_ignored():
	assert CA.classify(DAY, [_leave(status="Rejected", docstatus=0)])["status"] == CA.OK
	assert CA.classify(DAY, [_leave(status="Cancelled", docstatus=2)])["status"] == CA.OK


def test_approved_outranks_pending():
	st = CA.classify(DAY, [_leave(status="Open", docstatus=0), _leave()])
	assert st["status"] == CA.ON_LEAVE


def test_half_day_still_counts_as_on_leave_and_is_noted():
	st = CA.classify(DAY, [_leave(frm="2026-09-03", to="2026-09-03", half_day=1)])
	assert st["status"] == CA.ON_LEAVE and st["half_day"] is True
	st = CA.classify(DAY, [_leave(half_day=1, half_day_date="2026-09-03")])
	assert st["status"] == CA.ON_LEAVE and st["half_day"] is True
	st = CA.classify(DAY, [_leave(half_day=1, half_day_date="2026-09-05")])
	assert st["status"] == CA.ON_LEAVE and st["half_day"] is False


def test_check_in_only_matters_when_required():
	assert CA.classify(DAY, [], checked_in=False, require_checkin=False)["status"] == CA.OK
	assert CA.classify(DAY, [], checked_in=False, require_checkin=True)["status"] == CA.NOT_CHECKED_IN
	assert CA.classify(DAY, [], checked_in=True, require_checkin=True)["status"] == CA.OK


def test_leave_outranks_not_checked_in_which_outranks_pending():
	assert CA.classify(DAY, [_leave()], checked_in=False, require_checkin=True)["status"] == CA.ON_LEAVE
	st = CA.classify(DAY, [_leave(status="Open", docstatus=0)], checked_in=False, require_checkin=True)
	assert st["status"] == CA.NOT_CHECKED_IN


def test_mode_defaults_to_warn():
	assert CA.normalise_mode(None) == CA.WARN
	assert CA.normalise_mode("") == CA.WARN
	assert CA.normalise_mode("nonsense") == CA.WARN
	assert CA.normalise_mode("block") == CA.BLOCK
	assert CA.normalise_mode("Off") == CA.OFF


STATUSES = {
	"E1": {"status": CA.ON_LEAVE, "employee_name": "Alice"},
	"E2": {"status": CA.LEAVE_PENDING, "employee_name": "Bob"},
	"E3": {"status": CA.NOT_CHECKED_IN, "employee_name": "Carol"},
	"E4": {"status": CA.OK, "employee_name": "Dan"},
}


def test_off_reports_nothing():
	assert CA.split(STATUSES, CA.OFF) == ([], [])


def test_warn_warns_on_everything_and_blocks_nothing():
	blocked, warned = CA.split(STATUSES, CA.WARN)
	assert blocked == []
	assert {w["employee"] for w in warned} == {"E1", "E2", "E3"}


def test_block_refuses_leave_and_no_check_in_but_only_warns_pending():
	blocked, warned = CA.split(STATUSES, CA.BLOCK)
	assert {b["employee"] for b in blocked} == {"E1", "E3"}
	assert {w["employee"] for w in warned} == {"E2"}


def test_block_never_blocks_when_blocking_is_not_allowed():
	blocked, warned = CA.split(STATUSES, CA.BLOCK, can_block=False)
	assert blocked == []
	assert {w["employee"] for w in warned} == {"E1", "E2", "E3"}


def test_the_comment_sentence():
	assert CA.describe("Alice", CA.ON_LEAVE, "2026-09-03") == "Alice was on approved leave on 2026-09-03."
	assert "half day" in CA.describe("Alice", CA.ON_LEAVE, DAY, half_day=True)
	assert "pending" in CA.describe("Bob", CA.LEAVE_PENDING, DAY)


def test_team_resolution():
	names = {"CSU 1", "CSU 2"}
	members = {"E1": {"CSU 1"}, "E2": {"CSU 2"}, "E3": {"CSU 2"}}
	assert resolve_team("CSU 1", ["E2", "E3"], names, members) == "CSU 1"
	assert resolve_team("Alice - Sprayer\nBob - Supervisor", ["E1", "E2", "E3"], names, members) == "CSU 2"
	assert resolve_team("", [], names, members) == NO_TEAM
