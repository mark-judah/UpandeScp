# SCP Role Namespacing — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)
**Scope:** `upande_scp`

## Problem

The app's permission logic depends on plain role names that it assumes already
exist on the target site (`Scout`, `Store Keeper`, `Spray Plan Approver`, …) and
that overlap with generic org roles. When the app is deployed to a new site we
cannot rely on those roles existing, being spelled the same, or meaning the same
thing. We want the app to **carry its own roles and dependencies** so it is
self-contained.

## Goals

- Every app-owned role is namespaced with an `SCP ` prefix, Sentence case.
- The app creates its own roles; it does not depend on pre-existing site roles
  for its own logic.
- Existing users on sites that already have the old roles keep working — no loss
  of access on deploy.
- True platform/ERPNext/org roles are left untouched.

## Non-goals

- No new features or permission changes beyond the rename.
- We do **not** strip intrinsic DocType permissions (see "Permissions philosophy").
- We do not rename the look-alike child DocTypes (`Farm Spray Plan Creator`,
  `Farm Spray Plan Approver`, `Farm Store Keeper`) — those are data tables, not
  roles.

## Role mapping

### Internal — renamed, app-owned, auto-migrated

| Current role | New role |
|---|---|
| General Manager | SCP General Manager |
| Spray Supervisor | SCP Spray Supervisor |
| Spray Plan Creator | SCP Spray Plan Creator |
| Spray Plan Approver | SCP Spray Plan Approver |
| Scout | SCP Scout |
| Store Keeper | SCP Chemical Store Keeper |
| Scouting & Crop Protection User | SCP Scouting User |

### External — left untouched

Frappe/ERPNext/org built-ins the target site provides:
`System Manager`, `Administrator`, `CEO`, `Stock User`, `Stock Manager`,
`Item Manager`, `Manufacturing User`, `Purchase User`, `Accounts User`,
`Auditor`, `Sales User`, `Maintenance User`, `Desk User`, `Agriculture User`,
`AR Accountant`, `Assistant Packhouse Manager`.

There is **no** `SCP Farm Manager`: what was loosely called "Farm Manager" is the
same privileged tier as General Manager, now `SCP General Manager`.

## Permissions philosophy

- The app already stopped exporting `Custom DocPerm` fixtures (per prior change);
  it does not push permission overrides onto shared/core doctypes.
- The app's **own** DocTypes keep their intrinsic `permissions` rows — a DocType
  with zero permissions is inaccessible. This change only **renames the role**
  in those rows; it does not remove grants.
- New SCP roles are created with no standalone permissions of their own beyond
  what the app's DocType schema grants them.

## Change surface

Grounded in the full code inventory. Categories, in edit order:

1. **Central role-set constants** (edit first; they fan out):
   - `serverscripts/spray_plan_creator/loaning.py` — `ELEVATED`, `CREATOR_ROLES`
   - `serverscripts/spray_plan_creator/lifecycle.py` — `ACCESS_ROLES`
   - `serverscripts/spray_plan_approval.py` — `APPROVAL_ROLES`
   - `serverscripts/ordering_api.py`, `thresholds_api.py`, `store_keeper_api.py` — `_WRITE_ROLES`
   - Frontend `AppSidebar.tsx` `ELEVATED_ROLES`, `App.tsx` `elevated`
2. **Remaining Python role checks** — `has_role` / `get_roles` / Has Role filters /
   raw SQL in: `send_chemical_progress_email.py`, `store_keeper_api.py`,
   `spray_plan_approval.py`, `mobile/pest_image.py`, `spray_plan_creator/*.py`
   (`admin.py`, `bulk.py`, `stock.py`, `drafts.py`), `_debug_errors.py`, and the
   child-doctype validators `farm_spray_plan_creator.py`,
   `farm_spray_plan_approver.py`.
3. **App DocType JSON `permissions`** — `stage`, `pest_filter`, `disease_filter`,
   `chemical_transfer_request`, `chemical_stock_baseline`,
   `spray_application_logsheet` (roles: General Manager, Scout, CEO(external, keep),
   Scouting & Crop Protection User, Spray Plan Creator), plus workspace
   `upande_scp.json` roles child. Reports referencing only external roles are
   unchanged.
4. **Fixtures** — `role.json` expands to all 7 SCP roles; `client_script.json`
   `GM_ROLE` → `SCP General Manager`. `custom_html_block.json` gates only on
   `System Manager`/`Administrator` (external) — no change.
5. **Frontend** (`frontend/src`) — `App.tsx`, `AppSidebar.tsx`,
   `components/settings/AccessTab.tsx`, `pages/Settings.tsx`,
   `pages/SprayPlanAccess.tsx`, `pages/ChemicalLoaning.tsx`, `pages/Approvals.tsx`,
   `pages/ApplicationPlan.tsx`, `lib/*.ts`, `components/spray-plan-access/CreatorChipPicker.tsx`,
   and `__tests__/AppSidebar.test.tsx`. Then **`yarn build`** to regenerate
   `public/dist` bundles — never hand-edit those.
6. **Desk JS** — `public/js/spray_plan_transfers.js` (`SK_ROLE`).
7. **Existing role-setup patches** — `patches/v1_0/setup_spray_supervisor_role.py`
   and `create_spray_plan_creator_role.py` updated to the new names.

## Migration

One new **`pre_model_sync`** patch (runs before DocType sync so renamed DocPerm
`role` links resolve):

- **Create** any missing SCP role from the mapping (idempotent).
- **Copy assignments:** for each old→new pair, add a `Has Role` row on the new SCP
  role for every user who has the old role, if not already present. **Leave the
  old assignment in place** (non-destructive — a shared role like `Scout` may be
  used elsewhere; old roles cleaned up by hand later if desired).
- Safe to re-run.

## Verification

- Static: grep confirms zero remaining internal old-role strings in Python/TSX/JSON
  (excluding the migration patch's mapping table and generated bundles pre-rebuild).
- `bench --site kaitet.local migrate` runs clean; the patch creates the 7 roles
  and copies assignments; spot-check a Scout user now also has `SCP Scout`.
- Frontend `yarn build` succeeds; `AppSidebar.test.tsx` passes with new names.
- Drive one gated flow per tier (e.g. approver-only endpoint, store-keeper endpoint)
  to confirm access still resolves under the SCP role.

## Risks

- **Missed reference = access break.** Mitigated by the grounded inventory + a
  final grep gate.
- **Role must exist before DocPerm sync.** Mitigated by `pre_model_sync` timing.
- **Generated bundles** still carry old strings until `yarn build` — the rebuild
  is a required step, not optional.
