# Crew leave check (a setting) and the Schedule page — design

Date: 2026-10-11. Built lean, with one build and one review. The user chose both views (calendar and Gantt).

## The request
- A sprayer who is on leave and sits on a spray team must not be allowed on the **confirmed** spray crew in the morning.
- The check is a **setting**.
- A **Schedule page** shows it, in a calendar view and a Gantt view.

## Facts (from the diagnosis on 2026-10-11)
- **Where the crew lives.** Each plan's crew is the Work Order child table `custom_spray_plan_team_members` (employee, role).
  - The planner edits it on `ApplicationPlan.tsx` (`SprayTeamEditor`) and saves it in `drafts.py`.
  - The phone app confirms it with the "Confirm Spray Team" button (`plan-details.tsx` :1964). That button only sets `team_approved` on the phone. The server first hears of the crew through `update_work_order_team` (spray_session.py :1353), called just before `start_spray_session` (:1187).
  - Offline replays go through `offline_session.sync_spray_session` (:321), which calls `update_work_order_team` with `enforce_cutoff=False`.
- **Leave data.** HRMS is installed. kaitet.local holds `Leave Application` (≈2.4k, pulled from live) and `Employee Checkin` (pulled from live).
  - On live, Attendance is created around midnight, so it is useless at 6 am.
  - More than a quarter of leave is entered after it has started.
  - Sprayers clock in between 05:00 and 07:00.
- **Plans.** Application plans are Work Orders with `custom_type='Application Floor Plan'`. Each has `planned_start_date`, `actual_start_date`/`actual_end_date`, `custom_greenhouse`, `custom_spray_team`, `workflow_state` and the crew.
  - kaitet.local has no plans within ±30 days of today. The latest plan is dated 2026-09-06.
- **Settings and front end.** Settings live in the single doctype "Scouting and Crop Protection Settings", on the Spray Plan tab (it has a "Postponement & Spray Cutoff" section). There is no calendar or Gantt library; only `date-fns` is installed.

## Decisions
| # | Decision |
|---|---|
| L1 | **Settings** go in a new section, **"Crew availability"**, on the Spray Plan tab:<br>• `crew_leave_check`: Select **Off / Warn / Block**. Default **Warn**.<br>• `crew_require_checkin`: Check, default 0. When on, a crew member must also have an IN check-in on the spray date to be confirmable.<br>Both fields go into `get_settings_bundle` and the SCP settings UI. |
| L2 | **`common/crew_availability.py`:** `availability(employees, on_date)` → per employee, one of these statuses:<br>• `on_leave`: an approved Leave Application (docstatus 1) covers the date. A half day is noted but still counts as on leave for a morning crew.<br>• `leave_pending`: an Open application covers the date. This only ever warns.<br>• `not_checked_in`: only when `crew_require_checkin` is on and there is no IN check-in since 00:00 that day.<br>• `ok`.<br>It is one batched query per table, and it is pure where it can be (the status rules are tested without the DB). |
| L3 | **Enforcement:**<br>• `update_work_order_team` and `start_spray_session`:<br>  – **Block** mode refuses with the names and reasons.<br>  – **Warn** mode allows the save, returns `crew_warnings`, and adds a Comment on the Work Order ("<name> was on approved leave on <date>").<br>• **Offline sync** never refuses, because the spray has already happened. It records the warning on the Work Order Comment and on the session token.<br>• **Planning** (`drafts.py` save) only ever warns: the plan date may be days away.<br>• The plan date is `planned_start_date` (for start, today's date). |
| L4 | **Showing it before confirmation:**<br>• A new whitelisted endpoint, `get_crew_availability(work_order=None, employees=None, on_date=None)`.<br>• The `ApplicationPlan` crew editor shows a badge on each member (On leave / Leave pending / Not clocked in) for the plan date.<br>• The phone app's Confirm Spray Team modal shows the same badges. In Block mode, on-leave members cannot be ticked and a short reason is shown. In Warn mode they can be ticked, with a warning. |
| L5 | **The Schedule page** is at `#/<crop>/schedule`, under the spray-plan group in the sidebar. It has one endpoint, `schedule.get_schedule(crop, farm, from_date, to_date, team=None, state=None)`, which returns the plans with their crews and the crew leaves in that range, scoped by `crop_scope` (farms visible to the user). Roles: SCP Spray Plan Creator, Approver and Supervisor, General Manager, System Manager.<br>There are two views, behind a toggle that is remembered locally:<br>• **Calendar**: a month or week grid. Each day lists its plans as chips (greenhouse, team, coloured by workflow state). A plan with a crew member on leave shows a warning badge.<br>• **Gantt**: rows are greenhouses or teams (toggle), and the columns are days.<br>  – Plan bars run from planned start to actual end, or a one-day bar if the plan has not ended.<br>  – In team rows, a member's leave shows as a hatched bar beneath the team, labelled with the person.<br>  – There is a today line, a horizontal scroll, and a sticky row header.<br>Filters: farm, team, state, and a date range (default: this month). Clicking a plan opens its Application Plan page. When the range is empty, a **"Jump to latest plans"** button moves to the newest month that has plans.<br>Both views are built in the app with `date-fns` and CSS grid, with no new heavy dependency. They render at phone width with a horizontal scroll, and there are no left-border accent strips. |
| L6 | **Settings UI:** the SCP Settings page (Spray Plan tab) gets the two fields, with a one-line explanation of each mode. |

## Out of scope
- Attendance-based checks (Attendance doesn't exist at 6 am).
- Shift rosters.
- Leave approval workflows.
- Notifying supervisors (the email work is last).

## Testing
- **Pure tests:** the status rules (approved vs open, half day, check-in window, Off/Warn/Block).
- **Database tests** (fixture, rolled back):
  - In Block mode, `update_work_order_team` refuses an on-leave member.
  - In Warn mode it allows the save, adds a comment and returns warnings.
  - Offline sync never refuses.
  - `get_schedule` scoping and its payload.
- **Vitest:**
  - The calendar and Gantt render plans and leave bars, and the toggle works.
  - Jump to latest.
  - The crew editor badges.
- **Jest (phone app):** the confirm modal disables on-leave members in Block mode.
- **Real run:** the Schedule for Rose in Aug–Sep 2026, with counts of plans whose crew includes someone on approved leave on the plan date.

## Clarifications from review

| # | Finding | Ruling / fix |
|---|---|---|
| R1 | Handset marked the plan "In Progress" before the server calls; a Block refusal (417) silently closed the dialog. | Server first: `update_work_order_team` then `start_spray_session` (`src/services/sprayStart.ts`); local In Progress only on success. A crew refusal withdraws the journalled start (`unrecordStart`), keeps the prior state and reopens the crew modal with the server's message (names + reasons); a non-crew refusal (cutoff) shows a dialog. If the availability check fails *online* while the last-seen mode is Block, Approve waits on "Could not check leave — retry" (fail-closed); in Warn/unknown it says so and the server judges at Start. Offline flow unchanged and never refused. |
| R2 | `enforce_leave` (and `enforce_cutoff` on `start_spray_session`) were whitelisted arguments, so a client could send `0` to bypass Block / the cutoff. | Whitelisted `update_work_order_team(work_order, team)` and `start_spray_session(work_order, started_at, employee)` always enforce. The replay switches live on server-internal `_update_work_order_team` / `_start_spray_session`, called only by the offline sync. |
| R3 | Confirmation checked the plan's planned date; start checked today. | Crew confirmation and live start check **today** (the day the crew sprays); the handset Confirm modal asks for today's availability. Planning (draft saves, ApplicationPlan crew editor badges, Schedule flags) uses the planned date. An offline replay checks the day the spray happened and never refuses. |
| R4 | `get_schedule` refused ranges over 186 days and had no clamp. | Capped at 93 days: `from_date` is pulled up to `to_date − 93`, response carries `clamped: true`, `range` and `max_range_days`; the page shows a note and draws the effective range. |
| R5 | Team filter options came from the team-filtered payload, so picking a team left only that team. | `teams` is collected before the team filter on the server; the page keeps options across team-filtered responses. |
| R6 | Fast month-stepping could land an older response last; plans that began before the range were dropped by the calendar. | `load()` ignores all but the newest request (request id). Calendar shows a running plan on the first visible day with a "continues" chevron; Gantt clips the bar at the left edge (`data-clipped="start"`). |
