"""Pure weekly scout-plan rules: status, the weekly check, unplanned, copy week."""

from datetime import date

from upande_scp.serverscripts.common import scout_plan_rules as R


def _a(day, scout, house):
	return {"date": day, "scout": scout, "greenhouse": house}


def test_week_days_run_monday_to_sunday_from_any_day():
	days = R.week_days("2026-10-08")  # a Thursday
	assert days[0] == date(2026, 10, 5) and days[-1] == date(2026, 10, 11)
	assert len(days) == 7


def test_status_done_missed_planned():
	today = date(2026, 10, 8)
	assert R.assignment_status("2026-10-06", today, True) == R.DONE
	assert R.assignment_status("2026-10-06", today, False) == R.MISSED
	# today is not over yet: not missed
	assert R.assignment_status("2026-10-08", today, False) == R.PLANNED
	assert R.assignment_status("2026-10-08", today, True) == R.DONE
	assert R.assignment_status("2026-10-10", today, False) == R.PLANNED


def test_check_lists_houses_nobody_is_planned_for():
	out = R.weekly_check(["GH1", "GH2", "GH3"], [_a("2026-10-05", "S1", "GH1"), _a("2026-10-06", "S1", "GH3")])
	assert out["unplanned"] == ["GH2"]


def test_check_compares_house_days_with_the_farm_median():
	rows = (
		[_a(f"2026-10-0{d}", "S1", "GH1") for d in range(5, 10)]  # 5 house-days
		+ [_a("2026-10-05", "S2", "GH2"), _a("2026-10-06", "S2", "GH2")]  # 2
		+ [_a("2026-10-05", "S3", "GH3"), _a("2026-10-06", "S3", "GH3"), _a("2026-10-07", "S3", "GH3")]  # 3
	)
	# a duplicate of the same house-day does not count twice
	rows.append(_a("2026-10-05", "S2", "GH2"))
	out = R.weekly_check(["GH1", "GH2", "GH3"], rows)
	assert out["median"] == 3
	load = {r["scout"]: r for r in out["load"]}
	assert load["S1"]["houseDays"] == 5 and load["S1"]["flag"] == "high"
	assert load["S2"]["houseDays"] == 2 and load["S2"]["flag"] is None
	assert load["S3"]["diff"] == 0


def test_check_flags_a_scout_on_two_farms_the_same_day():
	rows = [_a("2026-10-05", "S1", "GH1"), _a("2026-10-06", "S2", "GH2")]
	elsewhere = [
		{"date": "2026-10-05", "scout": "S1", "farm": "Torongo"},
		{"date": "2026-10-07", "scout": "S2", "farm": "Torongo"},  # different day: fine
	]
	out = R.weekly_check(["GH1", "GH2"], rows, elsewhere, farm="Chepsito")
	assert out["conflicts"] == [{"scout": "S1", "date": "2026-10-05", "farms": ["Chepsito", "Torongo"]}]


def test_unplanned_actuals_are_those_with_no_assignment():
	plan = [_a("2026-10-05", "S1", "GH1")]
	acts = [{**_a("2026-10-05", "S1", "GH1"), "entries": 40}, {**_a("2026-10-05", "S2", "GH1"), "entries": 5}]
	assert R.unplanned_actuals(acts, plan) == [acts[1]]


def test_copy_week_moves_seven_days_and_dedupes():
	rows = [_a("2026-09-28", "S1", "GH1"), {**_a("2026-09-28", "S1", "GH1"), "entries": 3}, _a("2026-10-04", "S2", "GH2")]
	out, skipped = R.copy_week(rows)
	assert sorted((r["date"], r["scout"]) for r in out) == [("2026-10-05", "S1"), ("2026-10-11", "S2")]
	assert skipped == 0


def test_copy_week_skips_approved_leave_on_the_target_day_and_counts_it():
	rows = [_a("2026-09-28", "S1", "GH1"), _a("2026-09-29", "S1", "GH1"), _a("2026-09-28", "S2", "GH2")]
	leaves = {"S1": {"2026-10-05": "on_leave", "2026-10-06": "leave_pending"}}
	out, skipped = R.copy_week(rows, leaves=leaves)
	assert skipped == 1
	assert sorted((r["date"], r["scout"]) for r in out) == [("2026-10-05", "S2"), ("2026-10-06", "S1")]


def test_status_on_leave_beats_missed_but_not_done():
	today = date(2026, 10, 8)
	assert R.assignment_status("2026-10-06", today, False, on_leave=True) == R.ON_LEAVE
	assert R.assignment_status("2026-10-10", today, False, on_leave=True) == R.ON_LEAVE
	assert R.assignment_status("2026-10-06", today, True, on_leave=True) == R.DONE


def test_check_lists_planned_scouts_now_on_leave():
	rows = [_a("2026-10-06", "S1", "GH1"), _a("2026-10-06", "S1", "GH2"), _a("2026-10-07", "S2", "GH1")]
	leaves = {"S1": {"2026-10-06": "on_leave"}, "S2": {"2026-10-07": "leave_pending"}}
	out = R.weekly_check(["GH1", "GH2"], rows, leaves=leaves)
	assert out["onLeave"] == [
		{"scout": "S1", "date": "2026-10-06", "greenhouse": "GH1"},
		{"scout": "S1", "date": "2026-10-06", "greenhouse": "GH2"},
	]
