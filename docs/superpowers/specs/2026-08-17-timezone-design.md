# Timezone — design and the fix

**Date:** 2026-08-17
**Status:** implemented; site corrected

## The bug

`kaitet.local` ran its entire life on Frappe's out-of-the-box **`Asia/Kolkata`**.

Both companies (`Kaitet Ltd.`, `Karen Roses`) are registered in **Kenya** and every farm
coordinate is Kenyan — latitudes −1.34 to 0.99, longitudes 34.86 to 36.76. So:

```
site now (before)  2026-08-17 19:19   Asia/Kolkata   UTC+05:30
actual Nairobi     2026-08-17 16:49   Africa/Nairobi UTC+03:00
drift                        +2h30m
```

Everything downstream inherited it, because `frappe.utils.now_datetime()` returns site
time and there is no second clock:

* every timestamp the app has ever written — scan times, session start/end, notification
  times — reads **2h30m later** than the event;
* `ScheduledJobType.is_event_due` evaluates cron against `now_datetime()`, so the
  `0 14 * * *` daily scouting report fired at **11:30 Nairobi**, the `0 5 * * 1` trap
  report at 02:30, and the `0 8 * * 2` FCM report at 05:30;
* the new spray cutoff would have compared a 06:00 Nairobi spray against a Kolkata
  clock.

Nothing ever surfaced it. A clock that is consistently wrong looks like a working clock.

## What was fixed

**System Settings → Time Zone is now `Africa/Nairobi`.** That is the whole substantive
fix; everything else exists so it cannot happen again silently.

### It was safe to change, and that was checked first

Correcting the setting does **not** rewrite stored timestamps, so historical rows stay
2h30m ahead. The question is whether that matters, and it was measured rather than
assumed:

```
scouting entries                                    297,131
stored with a time between 00:00 and 02:29                0   (0.00%)
```

Zero. Shifting historical timestamps back by 2h30m would move **no record across a date
boundary**, so every date-grouped dashboard, aggregate and report is unaffected — which
makes sense, since scouts work in daylight. The drift only ever misreported the
*time of day*. **No historical migration was run, and none is needed for reporting.**

### No report will double-send

A *backwards* correction leaves `last_execution` stamps in the future — 3 SCP jobs and
43 site-wide. Their next slot is computed from that stale stamp, so they pause and then
resume. Verified with the scheduler's own methods:

| job | cron | next run | due now |
| --- | --- | --- | --- |
| send_fcm_weekly_excel_report | `0 8 * * 2` | 2026-08-18 08:00 | no |
| send_daily_scouting_report | `0 14 * * *` | 2026-08-18 14:00 | no |
| send_weekly_trap_report | `0 5 * * 1` | 2026-08-24 05:00 | no |

Left alone deliberately. Rewinding the stamps to match the new clock could put a daily
report's slot inside the shifted window and make it fire a second time; a delayed
prewarm is harmless, a duplicate report to staff is not.

**The reports now land 2h30m later in real terms** than staff are used to — at the local
times their crons always asked for.

## What was built

`serverscripts/common/timezone.py`:

**It reads ERP rather than assuming.** `erp_timezone()` is the only value that governs
anything, and the settings screen shows it **read-only**. A second place to change it is
a second place for the two to disagree, so the change is made in ERPNext, where the
setting lives.

**It infers what the timezone *should* be**, from the farms' own coordinates
(`expected_timezone()`, coarse lat/lon boxes). This is the part that would have caught
the original bug: `timezone_report()` says

> ERPNext is set to Asia/Kolkata (UTC+05:30) but this site's farms are in
> Africa/Nairobi (UTC+03:00) — every timestamp and scheduled job is 2h30m out of step
> with the farms.

Used only to report. A patch that re-times a live site's notifications on inference is
not a decision code should make, so `lock_timezone_setting` prints the warning at migrate
time and changes nothing.

**An app display timezone**, as asked for — and honestly bounded. `app_timezone` follows
ERP unless overridden, and an override changes only what this app *renders*. Stored
timestamps, notification timing and the scheduler follow ERP because they must, and the
report warns in those words whenever the two differ. Claiming otherwise would be the more
dangerous bug of the two.

**A lock**, on by default. `timezone_locked` must be turned off before the app timezone
can move, and every change is written to the Error Log under "SCP timezone changed".
Read from `tabSingles` directly, not through `get_single_value` — that returns `0` for a
never-stored field, indistinguishable from a deliberate unlock, which would have
defaulted the app's most consequential setting to *open* on every fresh site.

**`scheduler_alignment()`** answers the operator's actual question — when will my reports
next run — by asking the scheduler, and flags stale stamps without repairing them.

## Tests

`test_timezone.py`, 22 cases. The load-bearing ones:

* the drift is detected from coordinates, with the exact Kolkata-vs-Kenya message;
* an override warns that scheduling does not follow it;
* the lock defaults **closed** when nothing is stored;
* an unknown zone is refused rather than stored to silently fall back;
* **the live site's timezone matches where its farms are** — a guard that fails loudly if
  it ever drifts back;
* the scheduler's clock is within 2 minutes of farm-local time;
* no report job is due immediately (the duplicate-send check);
* a `0 14 * * *` job next runs at 14:00 local, not 14:00 somewhere else.

## Still outstanding

Historical timestamps remain 2h30m ahead. Harmless for date-grouped reporting (measured
above) but wrong if anyone reads a time-of-day off an old record. A migration is possible
and was not run: it touches many doctypes, and the benefit is cosmetic against a real
risk of corrupting rows that other calculations already depend on.
