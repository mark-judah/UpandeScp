"""Pure exposure rules: duration resolution, hazard weight, participants, team→farm."""

from datetime import date, datetime, timedelta

from upande_scp.serverscripts.common import exposure_rules as R


def test_custom_datetimes_win():
	d = R.resolve_duration(
		custom_start="2026-07-01 08:00:00",
		custom_stop="2026-07-01 09:30:00",
		on_date="2026-07-01",
		start_time="10:00:00",
		stop_time="11:00:00",
	)
	assert d["source"] == R.SOURCE_CUSTOM
	assert d["hours"] == 1.5
	assert d["flags"] == []


def test_date_plus_times_when_custom_missing():
	d = R.resolve_duration(
		custom_stop="2026-07-01 09:30:00",  # stop alone is not a span
		on_date=date(2026, 7, 1),
		start_time=timedelta(hours=10),
		stop_time=timedelta(hours=10, minutes=45, microseconds=12),
	)
	assert d["source"] == R.SOURCE_TIMES
	assert d["started_at"] == datetime(2026, 7, 1, 10, 0)
	assert d["hours"] == 0.75


def test_reversed_times_are_skipped_and_flagged():
	d = R.resolve_duration(on_date="2026-07-01", start_time="16:00:00", stop_time="08:00:00")
	assert d["hours"] == 0.0
	assert R.FLAG_TIMES_REVERSED in d["flags"] and R.FLAG_NO_DURATION in d["flags"]


def test_reversed_times_fall_back_to_the_session():
	d = R.resolve_duration(
		on_date="2026-07-01", start_time="16:00:00", stop_time="08:00:00",
		sessions=[("2026-07-01 08:00:00", "2026-07-01 09:00:00")],
	)
	assert d["hours"] == 1.0
	assert d["source"] == R.SOURCE_SESSION
	assert d["flags"] == [R.FLAG_TIMES_REVERSED]


def test_session_fallback_merges_overlapping_sessions():
	d = R.resolve_duration(
		on_date="2026-07-01",
		start_time="10:00:00",
		stop_time="10:00:00",  # equal: no time
		sessions=[
			("2026-07-01 08:00:00", "2026-07-01 08:30:00"),
			("2026-07-01 08:15:00", "2026-07-01 09:00:00"),
			(None, "2026-07-01 12:00:00"),
		],
	)
	assert d["source"] == R.SOURCE_SESSION
	assert d["hours"] == 1.0


def test_over_twelve_hours_is_capped_and_flagged():
	d = R.resolve_duration(custom_start="2026-07-01 06:00:00", custom_stop="2026-07-01 20:30:00")
	assert d["hours"] == 12.0
	assert R.FLAG_CAPPED in d["flags"]


def test_no_source_is_zero_and_flagged():
	d = R.resolve_duration(on_date="2026-07-01")
	assert d["hours"] == 0.0
	assert d["flags"] == [R.FLAG_NO_DURATION]
	assert d["started_at"] is None


def test_hazard_weights():
	assert R.hazard_weight("I") == (4, True)
	assert R.hazard_weight("II") == (3, True)
	assert R.hazard_weight("III") == (2, True)
	assert R.hazard_weight("IV") == (1, True)
	assert R.hazard_weight(" class ii ") == (3, True)
	assert R.hazard_weight(None) == (R.UNKNOWN_HAZARD_WEIGHT, False)
	assert R.hazard_weight("V") == (2, False)


def test_participants_one_entry_per_person_most_exposed_role():
	p = R.participants(
		applicators=[("E1", "Good"), ("E2", None)],
		mixers=["E2", "E3", None],
		supervisor="E1",
	)
	assert p["E1"] == {"role": "Sprayer", "ppe_condition": "Good"}
	assert p["E2"]["role"] == "Sprayer"
	assert p["E3"]["role"] == "Mixer"
	assert len(p) == 3


def test_supervisor_alone():
	assert R.participants([], [], "S")["S"]["role"] == "Supervisor"


def test_match_team_farm_longest_wins():
	farms = ["SIMO", "Simotwo", "Karen", "Chepsito"]
	assert R.match_team_farm("SIMOTWO CSU 2", farms) == "Simotwo"
	assert R.match_team_farm("CHEPSITO CSU 1", farms) == "Chepsito"
	assert R.match_team_farm("CROP PROTECTION IPM", farms) is None


def test_sessions_on_different_days_count_their_own_time():
	d = R.resolve_duration(sessions=[
		("2026-07-01 08:00:00", "2026-07-01 09:00:00"),
		("2026-07-03 08:00:00", "2026-07-03 08:30:00"),
	])
	assert d["hours"] == 1.5
	assert R.FLAG_CAPPED not in d["flags"]
