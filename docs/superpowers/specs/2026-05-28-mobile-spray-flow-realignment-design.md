# Mobile Spray Flow: Realign with Server-Side Lifecycle

**Date:** 2026-05-28
**Status:** Approved for implementation
**Touches:** `~/stive/code/reactnative/Upande-Scout/upande_scout_rn` (mobile) + `upande_scp` (cleanup script + small server hardening).

## Problem

The mobile chemical/spray flow is on the **legacy direct-REST path**, but the server-side spray pipeline was rewritten months ago around `register_csu_scan`. The two are now out of sync and the mismatch breaks every downstream guarantee:

- **Scans are local-only.** `handleConfirmChemicalScan` (`plan-details.tsx:522`) stores scans in local cache. `custom_chemical_scans` on the WO stays empty. Opening the card later shows "not scanned" because the server doesn't know.
- **Stock Entry created via direct REST.** The mobile calls `make_stock_entry` + `POST /api/resource/Stock Entry` + `PUT submit` (`api.ts:440-466`). The server's `register_csu_scan._promote_to_tank_mix_manufactured` (where the Manufacture SE creation, SAL creation, and `Tank Mix Manufactured` promotion live) is never invoked.
- **No SAL ever exists.** Because the promotion path doesn't run, `custom_spray_application_logsheet` stays `null`. "Finish spray plan" can't submit something that doesn't exist.
- **Mobile reads `status` instead of `workflow_state`.** ERPNext's `status` field flips to `Completed` when produced_qty hits qty — totally unrelated to the spray workflow. Mobile shows "Completed" while the spray hasn't even started.
- **Retries hit `DuplicateEntryForWorkOrderError`.** ERPNext correctly rejects a second Manufacture SE — but the mobile keeps offering the *Create Stock Entry* button because it doesn't know one already exists.

## Fix

### Mobile changes

1. **New API: `api.registerCsuScan(workOrder, itemCode, qrPayload, csuWarehouse)`** in `src/services/api.ts`.
   Calls `POST /api/method/upande_scp.serverscripts.spray_plan_creator.spray_session.register_csu_scan`. Returns `{workflow_state, all_scanned, scanned, manufacture_se?, sal?}`.

2. **`handleConfirmChemicalScan` (in `plan-details.tsx`) is the only callsite.** After local parse + validate, it calls `api.registerCsuScan(...)` *before* writing local state. On success, server is the source of truth — use the returned `workflow_state` and `scanned` list to update the card.

3. **Delete `createStockEntry` and the *Create Stock Entry* button.** The server creates the Manufacture SE on the last scan; no separate button is needed. Also delete `api.makeWorkOrderStockEntry`, `api.saveStockEntry`, `api.submitStockEntry`, `api.createAndSubmitWorkOrderStockEntry` from `src/services/api.ts` — they were the legacy path.

4. **Gate UI on `workflow_state`** read from the Work Order on plan refresh:

   | `workflow_state` | UI behaviour |
   |---|---|
   | `Approved` / `Chemical Issued` | Scan chemicals; per-scan call to `register_csu_scan` |
   | `Tank Mix Manufactured` | Show *Start Spray Programme*; hide scan UI |
   | `Spraying In Progress` | Show *Stop Spray* + GPS tracking |
   | `Completed` | Read-only summary |

5. **Replace `chemicalScans` (local-only) with derived state from server `custom_chemical_scans` child table.** When the plan is fetched, populate the per-item "scanned" badge from server data, not from local cache.

6. **Stop reading `plan.status` for the spray gate.** Replace every `status.includes("finished")` style check with a `workflow_state`-based check.

### Server-side

`register_csu_scan` already exists and is correct. Two small hardenings:

1. **Idempotent re-scan of the last chemical**: when the WO is *already* at `Tank Mix Manufactured`, a repeat call for any chemical should return the existing `manufacture_se` + `sal` names rather than throwing. Re-read the existing values from the WO and surface them. (Today's code path: if `all_scanned` is true AND `current_state == STATE_CHEMICAL_ISSUED`, it promotes — but if `current_state != STATE_CHEMICAL_ISSUED`, it silently doesn't promote, and never tells the caller what the SE/SAL names are.)

2. **No new doctype perms needed.** `register_csu_scan` uses `ignore_permissions=True` for the SE insert + submit and for the SAL creation. Spray Supervisor only needs the existing read perms on the involved doctypes (already granted).

### Cleanup for MFG-WO-2026-02396

User chose "Cancel + recreate". One-shot bench script `_kapkolia_cleanup.py` (in the gitignored `doc references/fixes/` folder, not part of the app):

1. Cancel `SE-2026-1737972` (the Manufacture SE) — sets docstatus=2.
2. Reset Work Order: `workflow_state = "Chemical Issued"`, clear `actual_start_date`, `actual_end_date`, `produced_qty = 0`. The MTM SE (SE-2026-1737971) stays submitted.
3. Wipe `custom_chemical_scans` so the new flow starts clean.

Then the user reruns the scan flow on the mobile — this time hitting `register_csu_scan` per chemical.

## Verification

After implementation:

1. Open `MFG-WO-2026-02396` on the mobile (post-cleanup).
2. Scan the three QRs.
3. Each scan should: succeed, show the chemical as "scanned" *on the server* (verify via `bench --site kaitet.local execute "frappe.get_doc('Work Order', 'MFG-WO-2026-02396').custom_chemical_scans"`).
4. The third scan should: trigger the promotion → workflow_state becomes `Tank Mix Manufactured`, a SAL is created and linked, a Manufacture SE is created and submitted.
5. The card refreshes and shows *Start Spray Programme*, not *Create Stock Entry*.
6. Pressing back into the same plan from the list later still shows the chemicals as scanned (read from server).

## Out of scope

- The `start_work_order` / `update_work_order_dates` / `update_work_order_team` endpoints. We're leaving those alone unless they break.
- The Spray Application Logsheet UI on the desk side. The mobile is the only thing changing.
- Other apps (frappe16). Not touched.

## Risk

- The mobile refactor changes the "happy path" for active spray operators. Roll out behind a feature flag if there's any concern, or ship with the existing legacy code commented out so it's a one-line rollback. *Current intent: just ship; this is a dev site.*
