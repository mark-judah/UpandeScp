# Sprayer register, chemical exposure and the Teams & KPIs page — design

Date: 2026-10-11. Built lean: one build and one review. The controller made the rulings below under the user's standing instruction ("take the recommended option").

## What the user asked for

- A **sprayer database**: sprayers are fetched from the Employee list, each gets its own unique ID and stays linked to their Employee.
- **Exposure to each chemical** is always tracked, using the time of each spray session.
- The chemical's **hazard** weighs that exposure.
- One page that shows the **scouting KPIs** and lets a manager **edit the spray teams of their assigned farms**.

## Facts we verified (kaitet.local)

- **`Spray Team`** has 12 teams, all enabled. Its member table, `Spray Team Details`, links each member (`name1`) to an Employee and gives a role: Sprayer, Pump Operator or Supervisor. There are 133 rows covering 131 employees.
  - Every team's `custom_farm` is empty. Farms are matched to teams by name in `spray_plan_creator/bootstrap.py`.
- **`Spray Application Logsheet` (SAL)** records who took part in each spray: 405 submitted, 2026-02-19 → 2026-09-03.
  - **Applicators** (`applicators` table): 3,786 rows covering 116 employees, each with `condition_of_ppe`.
  - **Others recorded:** `persons_mixing_1/2` and the supervisor.
  - **Chemicals:** in the `pesticides` table.
  - **Timing:** the date plus `application_start_time`/`application_stop_time` (time only); `custom_application_start_at`/`custom_application_stop_at` hold full datetimes but are rarely set.
- **`Sprayer Movement Session`** (378 rows, 14 employees) only ever records one employee, so it is a fallback source of duration, not of who took part.
- **Chemical hazard** lives on `Spray Product`: `toxicity` (I–IV), `reentry_interval_hrs` and GHS codes. Toxicity is set on 93 of 481 chemical products.
- Nothing tracks exposure today.
- **Assigned farms** come from `crop_scope` (`rostered_farms`, `visible_farms`).
- Active employees with sprayer designations number 152: Spray Applicator, Sprayer, Spray Supervisor and Spray Pump Operator.

## Decisions

| # | Decision |
|---|---|
| S1 | **`Sprayer` doctype**, named `SPR-.#####`, which is the sprayer's unique ID. Fields: `employee` (Link Employee, **unique**), `employee_name` (fetched), `farm` (Link Farm), `spray_team` (Link Spray Team), `role` (Sprayer / Pump Operator / Mixer / Supervisor), `status` (Active / Inactive), and read-only totals `hours_30d`, `weighted_30d`, `hours_total`, `weighted_total`, `last_exposure`. |
| S2 | **Populating the register:** `sync_sprayers()` creates a Sprayer for every Employee who is in a Spray Team, appears as a SAL applicator or mixer, or is an active employee with a designation in `SPRAYER_DESIGNATIONS` (Spray Applicator, Sprayer, Spray Supervisor, Spray Pump Operator). It is idempotent and never deletes. An Employee who is no longer Active → the Sprayer goes Inactive. The farm comes from the spray team's farm, else the Employee's `custom_farm`. It runs daily, from a desk button, and when a Spray Team is saved. |
| S3 | **`Sprayer Exposure` doctype** (a plain doctype, because the volume is high). Fields: sprayer, employee, spray_product, work_order, spray_application_logsheet, farm, greenhouse, date, started_at, ended_at, hours, role, toxicity, hazard_weight, weighted_hours, ppe_condition, source (SAL / Session), flags (e.g. "no duration", "hazard unknown"). One row per (SAL, employee, product), kept unique so that a rebuild is idempotent. |
| S4 | **What counts as exposure:** everyone named on the SAL (applicators, both mixers, the supervisor) is exposed to every product in its `pesticides` for the application's duration. Mixers get role Mixer. |
| S5 | **Duration**, tried in this order: (1) the custom start and stop datetimes; (2) the date plus the start and stop times, adding a day if the stop is before the start; (3) the WO's `Sprayer Movement Session` (`started_at`→`ended_at`). If none gives a time, hours = 0 and the row is flagged "no duration". Anything over 12 h is capped at 12 and flagged. |
| S6 | **Hazard weight** (constants in `common/exposure_rules.py`): toxicity I = 4, II = 3, III = 2, IV = 1. When toxicity is unknown, the weight is 2 and the row is flagged "hazard unknown"; the UI shows how many products lack a class. weighted_hours = hours × weight. |
| S7 | **When rows are written:** on SAL submit, its exposure rows are written; on cancel, they are deleted. A one-off backfill covers all 405 submitted SALs. After each write the Sprayer totals are recomputed (and nightly too, so the 30-day window rolls forward). |
| S8 | **Page "Teams & KPIs"** at `#/<crop>/teams`, in the sidebar for SCP General Manager, SCP Spray Supervisor and System Manager. It has three tabs:<br>(a) **Scouting KPIs**: the existing Data quality view (`DataQualityTab`, same aggregate, with its own farm and date filters). It also stays on the Dashboard.<br>(b) **Spray teams**: teams of the user's farms (`crop_scope`), where the user can add or remove members (Employee search limited to the farm's company), set roles, set the team's farm, and enable or disable the team. Saving calls `sync_sprayers` for the changed members.<br>(c) **Sprayers**: the register, showing ID, name, farm, team, role, hours and weighted hours for 30 days and in total, and last exposure, with search and sorting. A sprayer's detail panel shows exposure per product (hours, weighted hours, toxicity) and the latest sessions. |
| S9 | **Who can do what:** endpoints check the role. GM and System Manager can act on all their visible farms; an SCP Spray Supervisor only on the farms they are rostered on. Reads are limited to the same farms. |
| S10 | **One-off data fix:** set `Spray Team.custom_farm` using the existing name-matching rule (the `bootstrap.py` logic), and report any teams it could not match. |

## Out of scope

Alerts and emails about exposure limits (the email work comes last), editing Spray Product hazard data in bulk, medical surveillance records, and changes to the mobile app.

## Testing

- **Pure:** duration resolution (each source in the order above, overnight, cap, none) and the hazard weight.
- **DB** (fixture rolled back): sync idempotence, the unique employee, and inactive employees; on SAL submit, rows are written for applicators, mixers and the supervisor × every product, and cancel deletes them; totals; the permission refusal for an unrostered supervisor.
- **Vitest:** the page tabs, the team edit flow, the register and the detail panel.
- **Real run:** sync plus the backfill on kaitet.local, reporting sprayer counts per farm, the top exposures, and how many rows are flagged no duration or hazard unknown.
