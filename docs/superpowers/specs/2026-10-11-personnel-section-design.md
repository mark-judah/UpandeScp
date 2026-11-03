# Personnel section (Scouts, Sprayers, Teams) and Coverage report — design

Date: 2026-10-11. Built lean: one build, then one review.

## What the user asked for

- **One Personnel section in the sidebar** with three pages:
  - **Scouts**: an individual record for each scout, plus a **ranking** of scouts. Greenhouse assignment will be added here later, but not now.
  - **Sprayers**: the sprayer register.
  - **Teams**: spray team configuration. This is the spray plan creator's page, so a creator sees only the teams under their own farms.
- **Coverage report:** today's "Scouting KPIs" / Data quality view moves under **Reports** as **"Coverage"**, unchanged ("it is perfect as it is").
- **Not in this piece:**
  - editing a spray team from the application plan and making the change permanent;
  - greenhouse assignment of scouts;
  - the leave/attendance check.

## Decisions

| # | Decision |
|---|---|
| P1 | **Sidebar.** A **Personnel** group holds three pages: Scouts `#/<crop>/scouts`, Sprayers `#/<crop>/sprayers` and Teams `#/<crop>/teams`. The single "Teams & KPIs" page is split up into these three, and its old link `#/<crop>/teams` now opens Teams. |
| P2 | **Coverage.** The Data quality view (`DataQualityTab` and the `quality` aggregate, unchanged) moves under the existing Reports group as **Coverage** (`#/<crop>/reports/coverage`, or whatever route pattern the Reports group already uses). The Dashboard's "Data quality" tab is removed and pointed at Coverage, so there is one place for it. |
| P3 | **Who can open what:**<br>• **Teams**: SCP Spray Plan Creator (farms on the `spray_plan_creators` roster), SCP Spray Supervisor (`spray_supervisors` roster), SCP General Manager and System Manager (all visible farms). A creator can edit only teams whose farm is one of their rostered farms. The `api.scope` rules are extended to cover the creator role.<br>• **Sprayers**: the same roles, with the same farm scope.<br>• **Scouts**: SCP General Manager, System Manager and SCP Scouting User, with farm scope from `crop_scope.visible_farms`.<br>• Every endpoint enforces these rules, not only the sidebar. |
| P4 | **Scouts page: list and ranking.** It covers the crop's scouts for the chosen date range and farm (default: the last 4 complete weeks). The data comes from the per-scout rows the `quality` aggregate already computes, so there is no new scan; the server adds a ranking on top.<br>**Score (0–100), shown with its parts:**<br>• **Effort, 40%:** stations per active day ÷ the farm's median for scouts, capped at 1.<br>• **Integrity, 30%:** 100 − (too-fast % + duplicate %), floored at 0.<br>• **GPS, 30%:** 100 − the scout's off-zone excess over their houses, floored at 0. A scout with no GPS metadata gets the farm average and a "no GPS data" note.<br>**Who is ranked:** only scouts with ≥ 5 active days in the range; the rest are listed as "not enough days". Ties are broken by entries. The weights are constants in `common/scout_ranking.py`, not settings. |
| P5 | **Scout record.** Clicking a scout opens their record: name, Employee photo (initials only as a fallback), farm(s), houses scouted with each house's share, entries per week (a small trend), active days, their figures against the farm median, their open quality flags (from `quality_rules`) and last active date. It is read-only. A clear "Greenhouse assignment — coming" placeholder is not shown; nothing is shown for assignment yet. |
| P6 | **Sprayers and Teams pages.** These reuse the existing tab components (`SprayersTab`, `SprayTeamsTab`) as full pages, with their behaviour unchanged except for the role and scope extension in P3. |

## Out of scope

- Greenhouse assignment of scouts.
- Editing a team from the application plan and making it permanent.
- The leave/attendance check.
- Factoring in predators.
- Linking finance to procurement.
- Emails.

## Testing

- **Pure:** the scout score from its parts, the median, the 5-day minimum and the tie-break.
- **DB:**
  - A spray plan creator sees and edits only their rostered farms' teams and is refused another farm's.
  - Scouts endpoint farm scoping.
- **Vitest:**
  - The sidebar Personnel group appears per role.
  - The Coverage route renders `DataQualityTab`, and the Dashboard has no Data quality tab.
  - The Scouts ranking table and record panel.
  - No left-border accent strips.
- **Real run:** the ranking for Rose over the last 4 weeks on kaitet.local, including the top and bottom 5.
