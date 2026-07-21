# Submit without biometric (GM-gated) — Design

**Date:** 2026-07-21
**Status:** Approved (design), pending implementation plan
**Scope:** SCP Spray Plan Transfers — add a manager-gated path to submit a
Material-Transfer-for-Manufacture Stock Entry *without* a biometric scan, and
clearly surface which submissions were biometric-authorised vs. manual.

## Problem

Today the only submit path for a `Material Transfer for Manufacture` Stock
Entry from the Spray Plan Transfers page is `submit_with_biometric`
(`store_keeper_api.py`). It demands a fresh `Biometric Logs` scan matching the
SE's `bio_employee`. When the biometric device is down (or unavailable), a
store keeper is fully blocked and cannot release chemicals.

We need a **fallback** submit path, controlled by a manager toggle, plus a
clear indication of which entries were released with biometric verification and
which were released manually.

## Key facts established during exploration

- **`upande_ta` does not block submission server-side.** There is no
  `on_submit` guard that rejects an unverified Stock Entry. `auto_verify_biometric`
  (Stock Entry `validate` hook) only *sets* `biometric_status`; it never throws.
  The biometric *enforcement* lives entirely in SCP's `submit_with_biometric`.
  Therefore a manual path is simply a second, gated SCP endpoint — it does not
  fight upande_ta.
- `biometric_status` (owned by `upande_ta`) has options `Pending / Verified /
  Failed` only. There is **no "Bypassed" value** and we are not adding one.
- The requirement to use biometric at all is driven by the Stock Entry Type's
  `require_biometric` → the SE's read-only `requires_biometric` field.

## Canonical discriminator (no new schema)

Per decision: **reuse existing fields only.** On a **submitted** SE:

- `biometric_status == "Verified"` (with a `matched_biometric_log`) ⇒
  **biometric-authorised**.
- anything else (stays `"Pending"`, no matched log) ⇒ **manual / no biometric**.

The submitting user is captured by Frappe's built-in `modified_by` / `owner`.
No custom fields are added. This single rule is used everywhere the method is
displayed.

> Note on ambiguity: on a *draft* SE, `"Pending"` is genuinely ambiguous
> (un-acted vs. deliberately-manual). The discriminator is only meaningful on
> **submitted** SEs, which is where every display below applies.

## Components

### 1. Setting (schema)

`upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json`:
add a Check field in the existing **Submission Gating** section, immediately
after `bypass_owner_check`.

- fieldname: `allow_submit_without_biometric`
- fieldtype: `Check`, default `0`
- label: `Allow submit without biometric (device-down fallback)`
- description: explains it is an emergency fallback; when off, biometric is
  required as today.

### 2. Settings load/save

`spray_plan_creator/settings.py`:
- `get_spray_plan_settings`: add
  `"allow_submit_without_biometric": int(settings.allow_submit_without_biometric or 0)`
  to the returned dict (next to `bypass_owner_check`, ~line 77).
- `save_spray_plan_settings`: add `"allow_submit_without_biometric"` to the
  `scalar_fields` list (~line 126).

### 3. Backend submit path

`store_keeper_api.py`:
- `_allow_submit_without_biometric() -> bool` — reads the single value via
  `frappe.db.get_single_value("Spray Plan Settings", "allow_submit_without_biometric")`.
- Refactor the per-SE submit loop currently inside `submit_with_biometric` into
  a shared helper (e.g. `_submit_transfers(names, verify_fn)`), so both paths
  share draft/purpose/`bio_employee` validation and differ **only** in the
  verification step. This avoids duplicating the ~40-line loop.
- New `@frappe.whitelist() submit_without_biometric(names)`:
  - `_check_perm()` (same store-keeper permission as the biometric path).
  - **Throw if `_allow_submit_without_biometric()` is false** — message directs
    the user to ask a manager to enable it in Spray Plan Settings.
  - Per SE: must be a draft with purpose `_SE_PURPOSE`; `bio_employee` must be
    assigned (the receiving employee is still recorded). **No scan check.** Do
    NOT set `biometric_status` to Verified, do NOT set `matched_biometric_log`
    or `biometric_verified_at` — the status stays `"Pending"`. Save + submit.
  - Returns the same shape as the biometric path plus `"method": "manual"`:
    `{ok, failed, results, method}`. (`submit_with_biometric` returns
    `method: "biometric"` for symmetry.)
- `list_draft_transfers`: include `allow_submit_without_biometric` (bool) in the
  response so the page knows whether to render the manual button.
- `list_submitted_transfers`: include `biometric_status` and
  `matched_biometric_log` per row so the history view can badge each entry.

### 4. Frontend

`frontend/src/lib/store-keeper-api.ts`:
- add `submitWithoutBiometric(names)` calling
  `upande_scp.serverscripts.store_keeper_api.submit_without_biometric`.
- extend the draft-transfers response type with
  `allow_submit_without_biometric: boolean`.
- extend the submitted-transfers row type with `biometric_status` +
  `matched_biometric_log`.

`frontend/src/pages/SprayPlanTransfers.tsx`:
- When `allow_submit_without_biometric` is true, render a secondary **outline**
  button "Submit without biometric" beside the primary "Submit with biometric",
  behind a confirmation dialog ("Biometric will be skipped. This is recorded
  against your user."). When false, the button is absent (today's behavior).
- The result panel labels which method was used (biometric vs manual).
- Submitted/history view: badge each row — "Biometric ✓" when
  `biometric_status === "Verified"`, else "Manual (no biometric)". Distinct
  colors so the two are visually separable at a glance.

`frontend/src/components/settings/SprayPlanTab.tsx` + `settings-api.ts`:
- add `allow_submit_without_biometric: number` to the `SprayPlanSettings`
  interface.
- add a checkbox in the **Submission Gating** section next to
  `bypass_owner_check`.

### 5. Highlight in lifecycle

`spray_plan_creator/lifecycle.py`, "Chemical Issued" step (~line 280): when the
SE is submitted, append `"Biometric ✓"` if `biometric_status == "Verified"`,
else `"No biometric"`. The frontend timeline already renders this `detail`
string, so the method shows either way with no frontend change required there.

## Testing

Backend (`serverscripts/tests/`):
- `submit_without_biometric` throws when the setting is OFF.
- with the setting ON: submits the SE, leaves `biometric_status == "Pending"`,
  sets no `matched_biometric_log`, `docstatus == 1`.
- per-row failure isolation: one bad SE in the batch does not abort the others
  (mirrors the biometric path's rollback-and-continue behavior).
- `bio_employee` unassigned → that row fails with a clear error.

Frontend:
- "Submit without biometric" button renders only when the flag is true.
- submitted-view badge reflects `biometric_status` correctly for both cases.

## Out of scope

- Reorganising `serverscripts/` into functional packages — tracked as a
  separate effort (next).
- Any change to `upande_ta` (its biometric fields and hooks are untouched).
- A "Bypassed" `biometric_status` value (explicitly rejected; we reuse
  existing fields).
