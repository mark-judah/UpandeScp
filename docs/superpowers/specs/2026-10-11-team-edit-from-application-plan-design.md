# Edit the spray team permanently from the Application Plan — design

Date: 2026-10-11. Built lean, with one build and then one review.

## What the user asked for

"Spray team edit from application plan — use a modal for this; let's have a button that edits the spray team permanently."

## Facts

- `components/spray-plan/SprayTeamEditor.tsx` sits on `pages/ApplicationPlan.tsx`. It has a team picker that seeds a roster for that plan from the master `Spray Team Details`. Edits stay on the plan (WO `custom_spray_plan_team_members`) and never reach the master team.
- The Teams page (Personnel → Teams) already edits master teams. The server side is `sprayers/api.save_spray_team(team, members, farm, enabled, crop)`. It is scoped to the farms on the user's spray plan creator, spray supervisor or manager roster, and it re-syncs the sprayer register on save. Members must be active employees of the team farm's company, with roles from `TEAM_ROLES`.

## Decisions

| # | Decision |
|---|---|
| E1 | Next to the team picker, show an **"Edit team"** button. It is enabled when a team is picked and the user can manage that team's farm (`get_context` or the team list already tells us). It opens a **modal** that shows the master team: members with Employee photo, name, ID, designation and role. In the modal you can add (Employee search scoped to the farm's company, as on the Teams page), remove, and change role. |
| E2 | The modal's primary action is **"Save to team"**. It calls `save_spray_team` and changes the master team permanently, for every future plan. The modal says this plainly ("Changes apply to <team> for all future plans"). There is no draft state. |
| E3 | After a save, the plan's roster is **re-seeded** from the saved team only when it still matched the old master list, i.e. the user had not customised it. If the plan roster was customised, it is kept, and a small note offers "Use the updated team for this plan". |
| E4 | The modal reuses the Teams page member editor component; the shared parts are extracted rather than copied. The per-plan roster editor stays as it is. |
| E5 | Permissions come from the server only: a user without rights to the team's farm does not see the button, and the server refuses if called anyway. Errors from the server are shown inside the modal and keep the user's edits. |

## Testing

- Vitest:
  - the button shows only when it should;
  - the modal adds, removes and changes roles, then saves through `save_spray_team`;
  - the re-seed rules in E3;
  - a server error keeps the edits.
- DB: the existing `test_personnel_access` covers server scoping. Add a case for the creator saving a team through the same endpoint with a member from another company, which is refused.
