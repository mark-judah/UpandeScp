# Schedule: readable chips, crew availability per plan, and the weekly scout plan — design

Date: 2026-10-11. Built lean: one build, then one review. This extends `2026-10-11-crew-leave-check-and-schedule-design.md`.

## The request

1. The chip colours on the Gantt don't contrast with the text inside them, so they are hard to read (and the same on the calendar).
2. Show, on each plan in the Gantt and the calendar, whether each sprayer is available or not, based on leave.
3. "Since we have introduced the calendar we can schedule scouts to greenhouses … to make sure we have a plan for a week."

## Decisions

| # | Decision |
|---|---|
| C1 | **Contrast.** Chip and bar colours come from one helper, `scheduleColors(state)`, which returns `{bg, fg, border}` for each workflow state. Each state gets a light tint background with a dark, same-hue foreground, and the reverse in dark mode. Every pair must reach WCAG AA (≥ 4.5:1 for chip text). A vitest test checks the ratio for every state in both themes. The text never sits directly on a saturated colour. |
| C2 | **Availability on each plan.** Each plan carries `crewAvailability: [{employee, name, image, role, status}]` (status: `ok`, `on_leave`, `leave_pending`, `not_checked_in`). The date is the plan's date. "Today" rules apply only when the plan is today (check-in counts only today).<br>• **Gantt bar:** shows "9/12 available"; the bar gets a warning style when anyone is unavailable. Hovering or clicking opens a popover listing the crew, each with photo, name, role and a status pill (Available / On leave / Leave pending / Not clocked in).<br>• **Calendar chip:** shows the same count and opens the same popover. A view-wide toggle, **"Show unavailable only"**, filters plans to those with an unavailable member. |
| C3 | **Scout plan model.** A new doctype, **`Scout Assignment`**: `date`, `scout` (Employee — use the scout identity the Scouts page already resolves; record the Employee and keep the User if there is one), `greenhouse` (Link Warehouse; avocado blocks accepted the same way scouting accepts them), `farm`, `crop`, `notes`, `status` (Planned / Done / Missed, computed). It is unique on (date, scout, greenhouse). Applied with reload_doc. |
| C4 | **Scouts view in the Schedule page.** A third toggle sits alongside Spray Calendar and Gantt: **Scout plan**.<br>• **Layout:** a **week grid**, Mon–Sun columns by greenhouse rows, for one farm. You can flip it to scout rows.<br>• **Cells:** each cell holds the assigned scouts as avatar chips (Employee photo, initials only as a fallback).<br>• **Assigning:** pick scouts from a side list of the farm's scouts (from the Scouts page data) and click or drag them onto cells. Clicking a chip removes it.<br>• **Bulk actions:** "Copy last week" and "Clear week".<br>• **Leave:** scouts on approved leave that day are greyed in the picker and can't be dropped there. Pending leave only warns.<br>• **Who can edit:** saving is for users who manage the farm. Everyone else sees it read-only. |
| C5 | **Weekly check.** A summary bar for the week shows:<br>• greenhouses with no scout planned on any day of the week ("Not planned this week");<br>• each scout's planned house-days compared with the farm median;<br>• conflicts: one scout in two farms on the same day.<br>These are warnings only. |
| C6 | **Plan vs actual.** For past days, each assignment shows Done if that scout logged entries in that greenhouse that day, and Missed if not. Unplanned scouting (entries with no assignment) shows as a faint outlined chip. This uses the per-day quality partials and the scouting data already cached; it adds no new heavy scan. |
| C7 | **Endpoints** (in `schedule.py` or `scout_plan.py`):<br>• `get_scout_plan(crop, farm, week_start)` returns the farm's greenhouses, scouts, assignments, leaves and actuals.<br>• `save_scout_plan(crop, farm, week_start, assignments)` replaces the week's assignments for that farm. It refuses a scout on approved leave, a greenhouse outside the farm, or a farm outside the user's scope.<br>Roles: SCP General Manager, System Manager and SCP Scouting User can edit their farms. SCP Spray Plan Creator and Supervisor can read. |
| C9 | **Scouting respects approved leave** (added on review). Leave is read through `common/crew_availability.py` (approved = Leave Application docstatus 1; Open = pending, warn only). Besides C4/C7's greying and refusal when assigning:<br>• **Leave approved after a plan was saved:** the assignment shows an **On leave** pill (not Missed, unless the scout scouted anyway → Done), and the weekly check lists it under **"Planned scouts now on leave — reassign"** with the affected greenhouse-days.<br>• **Copy last week** skips a scout on approved leave on the target day and reports how many were skipped.<br>• **Picker:** each scout's leave days in the week are noted (e.g. "Leave Tue–Thu"; pending shown as such).<br>• **Scouts page ranking** (`get_scouts`, `common/scout_ranking.py`): approved-leave days in the range are excused. The "≥ 5 active days" eligibility is scaled to the days the scout was not on leave — required = max(1, ⌈5 × (range days − leave days) / range days⌉) — and each record shows "on leave N days". Effort is already per active day. |
| C8 | **Out of scope:** showing the plan to scouts in the mobile app (part of the Scout app revamp backlog); automatic scheduling or round-robin generation; notifications. |

## Testing

- Pure tests: the contrast ratio per state and theme; the weekly-check rules.
- DB tests (rolled back):
  - assignment save and replace;
  - leave refusal;
  - scope refusal;
  - Done/Missed from crafted entries.
- Vitest:
  - popovers and the count on the Gantt and calendar;
  - the "unavailable only" filter;
  - the scout grid: assign, remove, copy last week, leave greyed;
  - no left-border accent strips.
- A real run: build a plan for one Rose farm week from the last real week's actual scouting (copy actuals → plan), save it, and report coverage.
