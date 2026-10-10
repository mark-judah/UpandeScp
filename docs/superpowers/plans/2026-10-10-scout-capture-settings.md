# Scout Capture Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pieces 5 and 6 of the scouting programme. **5**: port Mona's scout photo and comment capture to kaitet. The General Manager decides on the SCP Settings page whether scouts may attach photos (each with its own caption, at most 5 per entry, one button per observed finding plus "General") and write comments. **6**: the scout app's hard-coded count limit of 15 becomes a server setting, `max_count_per_observation` (1–10000, default 15). All three values reach the handset in the `capture` block of `getObservationsDetails`, cached with the observations. Old handsets and old servers keep working: the old upload endpoint stays as an alias, and a handset with no `capture` block keeps the cap at 15 and shows no photo buttons.

**Architecture:** One server module, `scouting/capture_settings.py`, answers "may they?" and "how many?" by reading `tabSingles` directly. A missing row reads as the default (Mona's da18194 rule). The Single's controller and `ensure_defaults` (schema step + `after_migrate`) make sure a save never writes Frappe's cast `0` over a default that was never stored. The SCP settings API (`get_settings_bundle` / `save_spray_plan_settings`) carries the three values, and a **Scouting capture** card on the Spray plan tab edits them. Two child doctypes, **Comments Scouting Entry** and **Scouting Entry Photo**, hang off Scouting Entry. `createScoutingEntry` writes comments. `mobile/pest_image.attach_scouting_photo` stores a captioned photo row on the entry, and `attach_unidentified_pest_image` is the same function. On the handset, `src/services/scoutCapture.ts` parses and caches `capture`, and both count caps read it. `src/services/scoutPhotos.ts` holds the pure photo rules. The scouting form gets a photo bar and a camera modal, and its photos ride the existing pest-image queue with `subject` / `caption` / `photo_id`.

**Tech Stack:** Frappe v16 / Python 3.14, MariaDB; React 19 + TypeScript + Vite + vitest (jsdom, @testing-library/react) in `frontend/`; Expo SDK 54 React Native + TypeScript + jest (`jest-expo` preset, no RN testing library) in `upande_scout_rn/`.

**Spec:** `docs/superpowers/specs/2026-10-10-scout-capture-settings-design.md` (binding; decisions P1–P8 are rulings). Mona source (READ-ONLY, never modify): `/home/ubuntu/stive/code/mona/apps/upande_scp`, branch `mona`, HEAD `76129b2`, commits `f5f6392`, `b338508`, `da18194` (+ `8be897b` for the comments doctype and the `createScoutingEntry` branch). All kaitet line numbers below are verified against HEAD `adbe4cb`. All RN line numbers are verified against `upande_scout_rn` HEAD `83b4c05` (branch `kaitet-frappe16`).

## Global Constraints

- Site is **`kaitet.local`** only (read-only SQL: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT …"`). **Never use the Kaitet MCP** (`mcp__claude_ai_Kaitet*`), for anything.
- **Never modify the Mona repo.** Read it with `git -C /home/ubuntu/stive/code/mona/apps/upande_scp show <rev>:<path>` only.
- Commits in **every** repo: **no `Co-Authored-By` trailer** (CLAUDE.md overrides any default). upande_scp style `feat(scp): …` / `fix(scp): …` / `feat(scp-ui): …`, lowercase sentence.
- upande_scp staging: explicit `git add <paths>` only. **Never stage** the unrelated uncommitted store/batch-transfer work: `frontend/src/components/store/TransferBatchPanel.tsx`, `frontend/src/lib/store-keeper-api.ts`, `frontend/src/pages/SprayPlanTransfers.tsx`, `upande_scp/serverscripts/store/batch_suggestion.py`, `upande_scp/serverscripts/store/store_keeper_api.py`, `upande_scp/serverscripts/tests/test_batch_suggestion.py`, `upande_scp/serverscripts/tests/test_transfer_batch_apply.py`, `upande_scp/serverscripts/tests/test_transfer_batch_gating.py`, `upande_scp/serverscripts/tests/test_transfer_batch_split.py`. Never `git add -A` / `git add .` / `git commit -a`. **Never `git stash`.** Run `git status --short` before every commit.
- **NEVER restart anything on this server**: no `supervisorctl restart`, no `bench restart`, no MariaDB/Redis restart — another live site streams data on this server. `yarn build` is allowed. Consequence: the running web workers keep the old Python until someone else restarts them, so every server-side check in this plan runs **in-process through the DB runner**, never through the web server.
- Schema changes go through doctype JSON, applied with the DB runner (`frappe.reload_doc(..., force=True)`) as each task spells out. **Never `bench migrate`** in this plan. `Scouting Entry` holds ~1.96 M rows, so Task 3 runs a no-op ALTER pre-check before it reloads that doctype. The new fields are Table fields and add no column to `tabScouting Entry`. On 2026-10-10 the DB-vs-meta diff for `tabScouting Entry` was empty.
- **No email is sent during tests**: every test that can reach `frappe.sendmail` patches it (`patch.object(frappe, "sendmail")`). Every test also patches `frappe.db.commit`, because `attach_scouting_photo` and `createScoutingEntry` commit, and rolls back in `tearDown`. P8: the GM email fires only for an unidentified subject. kaitet.local has **39** enabled `SCP General Manager` users, so one unidentified photo = one email to 39 addresses (unchanged behaviour).
- Indentation matches each file: 4 spaces in `scouting/*`, `mobile/*`, `spray_plan_creator/*` and every test module; **tabs** in `hooks.py`, the new doctype controllers and `scouting_entry.py`. `scouting_and_crop_protection_settings.py` uses **4 spaces**. 1 space in doctype JSON; 2 spaces in TS/TSX (both frontends).
- UI (SCP and handset): **no vertical accent strips and no coloured left-border bars**. Tiles use a full `border`; accent goes through text colour, a tinted background or a pill.
- Exact spec values and strings: fields **`allow_scout_photos`** (Check, default 1), **`allow_scout_comments`** (Check, default 1), **`max_count_per_observation`** (Int, default **15**, valid **1–10000**). The payload is **`capture: {photos, comments, max_count}`**. The category is **`{"category": "Comments", "type": "text", "fields": []}`**, present only when comments are allowed. Child doctypes are **`Scouting Entry Photo`** (`image`, `caption`, `subject`, `captured_on`) as `photos_scouting_entry`, and **`Comments Scouting Entry`** (`comment`) as `comments_scouting_entry`. Endpoint **`mobile/pest_image.attach_scouting_photo`**, with alias **`attach_unidentified_pest_image`** (the same function object). GM role **`SCP General Manager`**. At most **5** photos per entry. The general subject is **`General`**. The invalid max-count message is **`Max count per observation must be a whole number from 1 to 10000.`**. The refusal is **`{"status": "refused", "reason": "photos-off", …}`**.
- Test commands (upande_scp):
  - DB (direct runner; tests roll back in `tearDown`): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); import importlib; M=importlib.import_module('upande_scp.serverscripts.tests.<module>'); r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M)); raise SystemExit(not r.wasSuccessful())"`. Written below as **DB-RUN `<module>`**.
  - One-off DB runner (schema): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe; frappe.init(site='kaitet.local'); frappe.connect(); <statements>; frappe.db.commit()"`. Written below as **DB-EXEC `<statements>`**.
  - Frontend: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run <path>`; typecheck `npx tsc --noEmit -p tsconfig.app.json`; build `yarn build`.
- Server regression gate. All of these must be green at the end of every server task, except a module that also fails at HEAD `adbe4cb`: Task 1 Step 0 records that baseline. Modules: `test_postponement` (it saves the Single through `save_spray_plan_settings` and **commits**), `test_crop_settings`, `test_crop_protection`, `test_spray_compliance_schema`, `test_loaning_v2`, `test_procurement`, `test_manager_permissions`, `test_crop_scoped_observations`.
- DB tests seed raw-SQL rows named **`_TEST-SE-CAP-*`** (Scouting Entry), **`_TEST-SEM-CAP-*`** (Scouting Entry Metadata) and **`_TEST-FILE-CAP-*`** (File), with client ids starting `_test-scp-capture|` and dated **2031-05-12**. No real scouting exists then. `frappe.utils.file_manager.save_file` is patched to a fake that inserts a raw `tabFile` row and writes nothing to disk, so no test leaves a file in `sites/kaitet.local/private/files`.

### RN repo (Upande-Scout) constraints

- Git root is **`/home/ubuntu/stive/code/reactnative/Upande-Scout`** (the parent of `upande_scout_rn`). Branch **`kaitet-frappe16`**. Paths in `git add` are relative to that root (`upande_scout_rn/…`). The tree was **clean** on 2026-10-10 (`git status --short` printed nothing). Even so: run `git -C /home/ubuntu/stive/code/reactnative/Upande-Scout status --short` before every commit and **never stage a file you did not change**. Explicit `git add <paths>` only. Never `git add -A` / `.` / `commit -a`, never `git stash`, never push.
- Commit style there is `feat(scout): …` / `fix(scout): …` / `feat(mobile): …`, lowercase, **no `Co-Authored-By` trailer**. **Do not** bump the app version, edit the changelog or cut a `release:` commit. Releasing is the user's call.
- Test commands (run from `/home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn`):
  - jest: `npx jest <path>` (whole suite: `npx jest`; 51 suites / 688 tests green at `83b4c05`, ~9 s).
  - Typecheck: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | grep -v -e "app/(auth)/configure.tsx([0-9]*,[0-9]*): error TS2367" -e "src/services/locationDb.ts([0-9]*,[0-9]*): error TS2349"`. Written below as **RN-TSC**. **Expected: no output.** HEAD has exactly those two pre-existing errors (`configure.tsx` "'error' and 'fetching' have no overlap", `locationDb.ts` "not callable"). Anything else is yours. `tsconfig.json` includes every `**/*.ts(x)` under strict mode, so the new jest test files are typechecked too.
  - There is no React Native testing library, so screen wiring is covered by **pure-module jest tests + RN-TSC**. Keep every rule a test needs in `src/services/*.ts`, never inline in a screen.
- `expo-sqlite` is mocked in jest with a small fake (pattern: `src/services/__tests__/spraySessionDb.test.ts`). Jest factory variables must start with `mock`.

## Review Focus

The five failure modes most likely to slip past the tests, each with the test that pins it:

1. **A save of the Single silently switches capture off.** Frappe casts a Check with no `tabSingles` row to `0` when it loads a Single (`base_document._fix_numeric_types`). It casts an Int `None` to `0` when it saves one (`get_valid_dict`). So the first save of *any* setting would write `allow_scout_photos = 0` and `max_count = 0`, and Mona's bundle (`0 if settings.allow_scout_photos == 0 else 1`) would show "off" for a switch that is on. → Task 1 `test_a_save_without_capture_rows_keeps_capture_on`, `test_ensure_defaults_writes_only_absent_rows`, `test_a_desk_zero_max_count_reads_as_fifteen_not_an_error`. Task 2 `test_the_bundle_reads_unset_as_on`, `test_a_save_of_other_fields_leaves_capture_alone`.
2. **Two photos of one subject collapse into one.** Mona names the file deterministically from `client_id|subject`, and its duplicate check matches on that name. A scout who takes two "General" photos (or two of Thrips) would lose the second as a "duplicate". A retry of the *same* photo must still be one row. → Task 4 `test_two_photos_of_one_subject_are_two_rows`, `test_a_retry_of_the_same_photo_is_one_row_and_its_caption_updates`, `test_an_old_handset_name_hashes_as_before`.
3. **Trap "unidentified" photos break.** This happens when the GM switches photos off, or when an old handset calls the old endpoint. The trap tab *demands* a photo for an unidentified pest, and that photo is the GM's alarm. → Task 4 `test_an_unidentified_photo_is_accepted_with_photos_off`, `test_the_old_endpoint_name_is_the_same_endpoint`. Task 7 `a trap photo keeps the old endpoint and fields`.
4. **A refused photo loops through retries, or a lost session is mistaken for a refusal.** If "photos off" were a `PermissionError` (Mona), the handset would re-upload a 1600 px JPEG over GPRS 8 times. An expired session also answers 403, so treating 403 as "refused" would delete photos the server would have taken. → Task 4 `test_photos_off_refuses_a_documentation_photo` (HTTP 200, `status: "refused"`, nothing stored). Task 7 `isRefused only reads the server's status` and `refused rows leave the queue and the badge`.
5. **Old server or missing `capture`.** A handset that gets no `capture` block must keep the cap at 15 and show **no** photo buttons, because the old server's endpoint emails all GMs for every photo it receives. A useless stored cap (0, 20000) must never reach the handset. → Task 1 `test_a_stored_max_count_is_served_and_a_useless_one_reads_fifteen`. Task 6 `an old server gets 15 and no photo buttons`, `falls back to 15 for a max count no handset could use`, `a cached row with no capture reads as legacy`. Task 7 `no subjects at all when photos are off`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `upande_scp/serverscripts/scouting/capture_settings.py` (new) | `allows`, `max_count`, `clean_max_count`, `as_payload`, `as_settings`, `fill_unset`, `ensure_defaults`; field names, defaults, limits |
| `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json` (mod) | `scout_capture_section`, `allow_scout_photos`, `allow_scout_comments`, `max_count_per_observation` on the Scouting tab |
| `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.py` (mod) | `validate` fills unset capture fields and checks the max count |
| `upande_scp/hooks.py` (mod) | `after_migrate` + `capture_settings.ensure_defaults` |
| `upande_scp/serverscripts/spray_plan_creator/settings.py` (mod) | Bundle carries the three values; save validates and stores them |
| `upande_scp/upande_scp/doctype/comments_scouting_entry/*` (new) | Child doctype `Comments Scouting Entry` |
| `upande_scp/upande_scp/doctype/scouting_entry_photo/*` (new) | Child doctype `Scouting Entry Photo` |
| `upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json` (mod) | `comments_scouting_entry`, `photos_scouting_entry` tables after Incidents |
| `upande_scp/serverscripts/mobile/create_scouting_entry.py` (mod) | `add_child_items` lifted to module level as `_add_child_items`; comments branch + call |
| `upande_scp/serverscripts/mobile/get_observations_details.py` (mod) | `Comments` category gated; `capture` block |
| `upande_scp/serverscripts/mobile/pest_image.py` (rewrite) | `attach_scouting_photo` (+ alias), `_short_file_name` with `photo_id`, `_record_on_entry`, refusal |
| `upande_scp/serverscripts/tests/test_scout_capture.py` (new) | Settings, settings page, tables and comments, payload, photo upload (DB) |
| `frontend/src/components/settings/ScoutCaptureCard.tsx` (new) | The Scouting capture card + `maxCountError` |
| `frontend/src/components/settings/SprayPlanTab.tsx` (mod) | Renders the card; save disabled on an invalid max count |
| `frontend/src/lib/settings-api.ts` (mod) | Three fields on `SprayPlanSettings` |
| `frontend/src/components/settings/__tests__/ScoutCaptureCard.test.tsx` (new) | Card + save round trip + validation |
| `upande_scout_rn/src/services/scoutCapture.ts` (+ `__tests__/scoutCapture.test.ts`) (new) | `CaptureSettings`, `parseCaptureSettings`, `resolveCapture`, `LEGACY_CAPTURE`, cap helpers |
| `upande_scout_rn/src/services/scoutingCacheDb.ts` (+ `__tests__/scoutingCacheCapture.test.ts`) (mod) | `observations.capture` column; `setCachedObservations(…, capture)`; `getCachedCaptureSettings` |
| `upande_scout_rn/app/(tabs)/index.tsx` (mod) | Cap from `capture`; photo bar, camera, photos queued on submit |
| `upande_scout_rn/app/(tabs)/traps/index.tsx` (mod) | Trap caps from the cached `capture` |
| `upande_scout_rn/app/(auth)/configure.tsx`, `app/(tabs)/profile/index.tsx`, `app/(tabs)/profile/cached-data.tsx` (mod) | Pass `capture` to `setCachedObservations` |
| `upande_scout_rn/src/services/scoutPhotos.ts` (+ `__tests__/scoutPhotos.test.ts`) (new) | Subjects, limit, queue args, upload fields, refusal |
| `upande_scout_rn/src/services/pestImageQueue.ts` (+ `__tests__/pestImageQueue.test.ts`) (mod) | `disease` / `subject` / `caption` / `photo_id` columns; `refused` status |
| `upande_scout_rn/src/services/pestImageSync.ts`, `src/services/api.ts`, `components/PestImageQueuePanel.tsx` (mod) | Carry the new fields; endpoint by kind; refused handling |
| `upande_scout_rn/components/ScoutPhotoBar.tsx`, `components/ScoutCameraModal.tsx` (new) | Photo buttons + captions; camera capture + compression |

---

### Task 1: Capture settings on the Single, read raw, defaults that survive a save

**Files:**
- Create: `upande_scp/serverscripts/scouting/capture_settings.py`
- Modify: `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json` (`field_order` ends at `"scouting_note"`; the `fields` array ends with the `scouting_note` object; `"modified"` line 643)
- Modify: `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.py` (imports lines 4–5, `validate` lines 9–17)
- Modify: `upande_scp/hooks.py` (`after_migrate`, last entry line 150)
- Test: `upande_scp/serverscripts/tests/test_scout_capture.py` (new; classes `CaptureCase`, `TestCaptureSettings`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `CS.SETTINGS`, `CS.PHOTOS_FIELD`, `CS.COMMENTS_FIELD`, `CS.MAX_COUNT_FIELD`, `CS.FIELDS`, `CS.DEFAULTS`, `CS.DEFAULT_MAX_COUNT = 15`, `CS.MAX_COUNT_MIN = 1`, `CS.MAX_COUNT_MAX = 10000`, `CS.MAX_COUNT_MESSAGE`
  - `CS.allows("photos" | "comments") -> bool` (unset → True; unknown key → `ValueError`)
  - `CS.max_count() -> int` (unset or unusable → 15)
  - `CS.clean_max_count(value) -> int` (raises `frappe.ValidationError` outside 1–10000 or non-whole)
  - `CS.as_payload() -> {"photos": bool, "comments": bool, "max_count": int}`
  - `CS.as_settings() -> {"allow_scout_photos": 0|1, "allow_scout_comments": 0|1, "max_count_per_observation": int}`
  - `CS.fill_unset(doc) -> list[str]` (honours `doc.flags.capture_explicit`)
  - `CS.ensure_defaults() -> list[str]` (fields written)
  - Test helpers in `test_scout_capture.py`: `CaptureCase` (patches commit + sendmail, rolls back), `_raw`, `_unset`, `_set`.

- [ ] **Step 0: Baseline the regression gate**

Run **DB-RUN** for each gate module: `test_postponement`, `test_crop_settings`, `test_crop_protection`, `test_spray_compliance_schema`, `test_loaning_v2`, `test_procurement`, `test_manager_permissions`, `test_crop_scoped_observations`. Record which pass at HEAD `adbe4cb`. A module that already fails here is not this plan's to fix. Note it in the hand-off and do not count it against any later step.

- [ ] **Step 1: Write the failing tests**

Create `upande_scp/serverscripts/tests/test_scout_capture.py`:

```python
"""Scout capture settings (pieces 5–6): the GM's two switches and the max count,
what the handset is told, comments and captioned photos on the entry.

Ported from Mona's test_scouting_metadata.py (f5f6392 / b338508 / da18194) onto
kaitet's Single, Scouting and Crop Protection Settings. DB test — direct runner.
Every test rolls back in tearDown: the code under test calls frappe.db.commit,
which is patched out, and frappe.sendmail is patched so nothing is ever sent.
"""

import hashlib
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.scouting import capture_settings as CS

SETTINGS = "Scouting and Crop Protection Settings"
GH = "Chepsito GH 01 - KR"
ENTRY = "_TEST-SE-CAP-1"
CLIENT_ID = "_test-scp-capture|2031-05-12|08:00:00|Chepsito GH 01 - KR|Bed 1"


def _raw(field):
    row = frappe.db.sql(
        "SELECT value FROM tabSingles WHERE doctype = %s AND field = %s", (SETTINGS, field)
    )
    return row[0][0] if row else None


def _unset(*fields):
    """What a site that never saved these fields looks like: no tabSingles row."""
    frappe.db.sql(
        "DELETE FROM tabSingles WHERE doctype = %s AND field IN %s",
        (SETTINGS, tuple(fields or CS.FIELDS)),
    )


def _set(**values):
    for field, value in values.items():
        frappe.db.set_single_value(SETTINGS, field, value)


class CaptureCase(unittest.TestCase):
    def setUp(self):
        frappe.set_user("Administrator")
        self._patches = [patch.object(frappe.db, "commit"), patch.object(frappe, "sendmail")]
        _commit, self.sendmail = (p.start() for p in self._patches)

    def tearDown(self):
        frappe.db.rollback()
        for p in reversed(self._patches):
            p.stop()
        frappe.set_user("Administrator")


class TestCaptureSettings(CaptureCase):
    def test_the_fields_live_on_the_scouting_tab(self):
        meta = frappe.get_meta(SETTINGS)
        self.assertTrue(meta.issingle)
        got = {f: (meta.get_field(f).fieldtype, meta.get_field(f).default) for f in CS.FIELDS}
        self.assertEqual(got, {
            "allow_scout_photos": ("Check", "1"),
            "allow_scout_comments": ("Check", "1"),
            "max_count_per_observation": ("Int", "15"),
        })
        order = [f.fieldname for f in meta.fields]
        self.assertLess(order.index("scouting_tab"), order.index("allow_scout_photos"))

    def test_nothing_stored_reads_as_allowed_and_fifteen(self):
        _unset()
        self.assertTrue(CS.allows("photos"))
        self.assertTrue(CS.allows("comments"))
        self.assertEqual(CS.max_count(), 15)
        self.assertEqual(CS.as_payload(), {"photos": True, "comments": True, "max_count": 15})
        self.assertEqual(CS.as_settings(), {"allow_scout_photos": 1, "allow_scout_comments": 1,
                                            "max_count_per_observation": 15})

    def test_allows_reads_the_switches(self):
        _set(allow_scout_photos=1, allow_scout_comments=0)
        self.assertEqual((CS.allows("photos"), CS.allows("comments")), (True, False))
        _set(allow_scout_photos=0, allow_scout_comments=1)
        self.assertEqual((CS.allows("photos"), CS.allows("comments")), (False, True))

    def test_an_unknown_switch_is_a_programming_error(self):
        with self.assertRaises(ValueError):
            CS.allows("videos")

    def test_a_stored_max_count_is_served_and_a_useless_one_reads_fifteen(self):
        _set(max_count_per_observation=40)
        self.assertEqual(CS.max_count(), 40)
        for useless in ("0", "20000", "-3", "lots"):
            frappe.db.sql("UPDATE tabSingles SET value = %s WHERE doctype = %s AND field = %s",
                          (useless, SETTINGS, CS.MAX_COUNT_FIELD))
            self.assertEqual(CS.max_count(), 15, useless)

    def test_clean_max_count_takes_1_to_10000_only(self):
        for good, want in ((1, 1), (10000, 10000), ("25", 25), (25.0, 25)):
            self.assertEqual(CS.clean_max_count(good), want)
        for bad in (0, 10001, -3, 2.5, "x", None, ""):
            with self.assertRaises(frappe.ValidationError, msg=repr(bad)):
                CS.clean_max_count(bad)

    def test_a_save_without_capture_rows_keeps_capture_on(self):
        # Review focus 1: a loaded Single casts a missing Check to 0, and a save
        # casts a None Int to 0. Without fill_unset, saving ANY setting would
        # switch photos and comments off and set the cap to 0.
        _unset()
        doc = frappe.get_single(SETTINGS)
        self.assertEqual(doc.allow_scout_photos, 0)              # Frappe's cast, documented
        doc.save(ignore_permissions=True)
        self.assertEqual(CS.as_payload(), {"photos": True, "comments": True, "max_count": 15})
        self.assertEqual((_raw("allow_scout_photos"), _raw("max_count_per_observation")), ("1", "15"))

    def test_an_explicit_off_in_the_same_save_is_kept(self):
        _unset()
        doc = frappe.get_single(SETTINGS)
        doc.flags.capture_explicit = {CS.PHOTOS_FIELD}
        doc.allow_scout_photos = 0
        doc.save(ignore_permissions=True)
        self.assertEqual((CS.allows("photos"), CS.allows("comments")), (False, True))

    def test_a_desk_zero_max_count_reads_as_fifteen_not_an_error(self):
        # An Int cannot tell 0 from unset; refusing it would block every save of
        # the Single. Out of range the other way is a real mistake and refused.
        doc = frappe.get_single(SETTINGS)
        doc.max_count_per_observation = 0
        doc.save(ignore_permissions=True)
        self.assertEqual(_raw("max_count_per_observation"), "15")
        doc = frappe.get_single(SETTINGS)
        doc.max_count_per_observation = 20000
        with self.assertRaises(frappe.ValidationError):
            doc.save(ignore_permissions=True)

    def test_ensure_defaults_writes_only_absent_rows(self):
        _unset(CS.COMMENTS_FIELD, CS.MAX_COUNT_FIELD)
        _set(allow_scout_photos=0)
        self.assertEqual(CS.ensure_defaults(), [CS.COMMENTS_FIELD, CS.MAX_COUNT_FIELD])
        self.assertEqual((_raw("allow_scout_photos"), _raw("allow_scout_comments"),
                          _raw("max_count_per_observation")), ("0", "1", "15"))
        self.assertEqual(CS.ensure_defaults(), [])               # the GM's 0 is never overwritten

    def test_after_migrate_seeds_the_defaults(self):
        import upande_scp.hooks as H
        self.assertIn("upande_scp.serverscripts.scouting.capture_settings.ensure_defaults", H.after_migrate)
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_scout_capture`**
Expected: ERROR on import, `ImportError: cannot import name 'capture_settings' from 'upande_scp.serverscripts.scouting'`.

- [ ] **Step 3: The module**

Create `upande_scp/serverscripts/scouting/capture_settings.py`:

```python
"""What a scout may record on the ground beyond the counts, and the highest
count one observation may carry (scout capture settings spec, P1–P3).

Ported from Mona (`scouting/capture_settings.py`, f5f6392 / b338508 / da18194)
onto kaitet's Single, Scouting and Crop Protection Settings → Scouting, plus
``max_count`` (piece 6).

Three places need the same answers and must not each decide: the payload the
handset reads (``mobile/get_observations_details``), the photo upload
(``mobile/pest_image.attach_scouting_photo``) and the SCP settings page
(``spray_plan_creator/settings``). They ask here.

ABSENT MEANS THE DEFAULT. A site that never saved these fields has no
``tabSingles`` row for them. ``get_single_value`` and a loaded Single both cast
a missing Check to 0, so "nobody ever touched it" and "the GM switched it off"
would arrive identical (Mona hit exactly that restoring production, da18194).
Every reader here goes to ``tabSingles`` directly.

A SAVE MUST NOT WRITE THE CAST 0 EITHER. The Single's ``validate`` calls
``fill_unset``, which puts the default back on any capture field that has no
row and was not set explicitly in this save. ``ensure_defaults`` (schema step
and ``after_migrate``) writes the rows, so the gap closes for good.
"""

import frappe
from frappe import _

SETTINGS = "Scouting and Crop Protection Settings"

PHOTOS_FIELD = "allow_scout_photos"
COMMENTS_FIELD = "allow_scout_comments"
MAX_COUNT_FIELD = "max_count_per_observation"

#: The switches ``allows`` answers for, and the field behind each.
_SWITCHES = {"photos": PHOTOS_FIELD, "comments": COMMENTS_FIELD}

DEFAULT_MAX_COUNT = 15
MAX_COUNT_MIN = 1
MAX_COUNT_MAX = 10000
MAX_COUNT_MESSAGE = "Max count per observation must be a whole number from 1 to 10000."

#: Every capture field and the value it reads as when nothing is stored.
DEFAULTS = {PHOTOS_FIELD: 1, COMMENTS_FIELD: 1, MAX_COUNT_FIELD: DEFAULT_MAX_COUNT}
FIELDS = tuple(DEFAULTS)


def _raw(fieldname):
    """The stored value, or None when the Single has no row for it.

    Plain SQL: ``get_value`` orders by ``creation`` and tabSingles has no such
    column — it is a key/value table, not a doctype table."""
    row = frappe.db.sql(
        "SELECT value FROM tabSingles WHERE doctype = %s AND field = %s",
        (SETTINGS, fieldname),
    )
    value = row[0][0] if row else None
    return None if value in (None, "") else value


def allows(what: str) -> bool:
    """Is this kind of capture allowed? ``what`` is "photos" or "comments".

    Anything else is a programming error and says so: a typo that read as
    "allowed" would hand scouts a capability the GM had switched off."""
    try:
        fieldname = _SWITCHES[what]
    except KeyError:
        raise ValueError(
            f"{what!r} is not a scouting capture switch — expected one of "
            f"{', '.join(sorted(_SWITCHES))}"
        ) from None
    value = _raw(fieldname)
    if value is None:
        return True
    try:
        return bool(int(float(value)))
    except (TypeError, ValueError):
        return True


def _as_max_count(value):
    """``value`` as a whole number in 1–10000, else None."""
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if not number.is_integer():
        return None
    number = int(number)
    return number if MAX_COUNT_MIN <= number <= MAX_COUNT_MAX else None


def max_count() -> int:
    """The highest count the handset accepts for one observation or one trap
    pest (piece 6). Unset — or a stored value no handset could use — reads 15,
    so a bad row can never make every count unrecordable."""
    value = _raw(MAX_COUNT_FIELD)
    return (_as_max_count(value) if value is not None else None) or DEFAULT_MAX_COUNT


def clean_max_count(value) -> int:
    """The settings page's guard: a whole number from 1 to 10000, or a
    ValidationError that saves nothing."""
    number = _as_max_count(value)
    if number is None:
        frappe.throw(_(MAX_COUNT_MESSAGE), title=_("Invalid max count"))
    return number


def as_payload() -> dict:
    """The ``capture`` block of getObservationsDetails. It rides with the
    observations because the handset decides what to draw while it builds the
    round, and a second request is one more thing to fail with no signal."""
    return {"photos": allows("photos"), "comments": allows("comments"), "max_count": max_count()}


def as_settings() -> dict:
    """The three values as the SCP settings page edits them. Never read them
    off a loaded Single: its Checks are cast to 0 when no row is stored."""
    return {
        PHOTOS_FIELD: int(allows("photos")),
        COMMENTS_FIELD: int(allows("comments")),
        MAX_COUNT_FIELD: max_count(),
    }


def fill_unset(doc) -> list:
    """Called from the Single's ``validate``: give every capture field that has
    no stored row its default, unless this save set it on purpose
    (``doc.flags.capture_explicit``, filled by ``save_spray_plan_settings``).
    Returns the fields filled."""
    explicit = set(doc.flags.get("capture_explicit") or ())
    filled = []
    for field, default in DEFAULTS.items():
        if field in explicit or _raw(field) is not None:
            continue
        doc.set(field, default)
        filled.append(field)
    return filled


def ensure_defaults() -> list:
    """``after_migrate`` (and Task 1's schema step): write each capture default
    whose row is absent, and never touch a stored value. Writes rows directly,
    no document save, so nothing else on the Single is re-validated."""
    if not frappe.db.exists("DocType", SETTINGS):
        return []
    meta = frappe.get_meta(SETTINGS)
    written = []
    for field, default in DEFAULTS.items():
        if meta.get_field(field) is None or _raw(field) is not None:
            continue
        frappe.db.set_single_value(SETTINGS, field, default)
        written.append(field)
    return written
```

- [ ] **Step 4: The doctype JSON**

In `scouting_and_crop_protection_settings.json`:

(a) `field_order`: after `"scouting_note"` (the last entry) append `"scout_capture_section", "allow_scout_photos", "allow_scout_comments", "max_count_per_observation"`.

(b) `fields`: append after the `scouting_note` object (the last one):

```json
  {
   "description": "What a scout may record on a round beyond the counts. The scout app reads these with its observations; switched off, the camera or the Comments tab is not shown at all.",
   "fieldname": "scout_capture_section",
   "fieldtype": "Section Break",
   "label": "Scout capture"
  },
  {
   "default": "1",
   "description": "A scout may photograph what they find, one photo button per observed pest, disease or other finding plus a General photo, each with its own caption, at most 5 per entry. A photo of something unidentified is always accepted.",
   "fieldname": "allow_scout_photos",
   "fieldtype": "Check",
   "label": "Scouts can attach photos"
  },
  {
   "default": "1",
   "description": "A free-text note on the entry. Off: the Comments tab does not appear in the app.",
   "fieldname": "allow_scout_comments",
   "fieldtype": "Check",
   "label": "Scouts can write comments"
  },
  {
   "default": "15",
   "description": "The highest count the scout app accepts for one observation or one trap pest (1-10000).",
   "fieldname": "max_count_per_observation",
   "fieldtype": "Int",
   "label": "Max count per observation",
   "non_negative": 1
  }
```

(c) `"modified"` (line 643) becomes `"2026-10-10 20:00:00.000000"`.

- [ ] **Step 5: The controller and the hook**

In `scouting_and_crop_protection_settings.py`, add after `from frappe.model.document import Document` (line 5):

```python

from upande_scp.serverscripts.scouting import capture_settings
```

and append to the end of `validate` (after the overlap `frappe.throw`, line 17; 4-space file):

```python

        # Scout capture (pieces 5–6). A loaded Single reads a missing Check as 0
        # and saves a None Int as 0; never let that switch capture off or zero
        # the cap. An Int cannot tell 0 from unset, so 0 means the default.
        capture_settings.fill_unset(self)
        if not self.max_count_per_observation:
            self.max_count_per_observation = capture_settings.DEFAULT_MAX_COUNT
        self.max_count_per_observation = capture_settings.clean_max_count(
            self.max_count_per_observation
        )
```

In `upande_scp/hooks.py`, append inside `after_migrate` after `"upande_scp.serverscripts.geo.field_unit_types.after_migrate",` (line 150; tabs):

```python
	# Scout capture defaults (photos / comments on, max count 15) as real rows on
	# the Single: a missing Check row is cast to 0 on load, so a farm that never
	# opened the settings page would otherwise be switched off by its first save.
	"upande_scp.serverscripts.scouting.capture_settings.ensure_defaults",
```

- [ ] **Step 6: Apply the schema and seed**

Run: **DB-EXEC** `frappe.reload_doc('upande_scp', 'doctype', 'scouting_and_crop_protection_settings', force=True); from upande_scp.serverscripts.scouting import capture_settings as CS; print(CS.ensure_defaults()); print(CS.as_payload(), CS.as_settings())`
Expected: `['allow_scout_photos', 'allow_scout_comments', 'max_count_per_observation']` (kaitet.local had no row for any of them), then `{'photos': True, 'comments': True, 'max_count': 15} {'allow_scout_photos': 1, 'allow_scout_comments': 1, 'max_count_per_observation': 15}`. A second run prints `[]`.

- [ ] **Step 7: Run to pass, plus the gate**

Run: **DB-RUN `test_scout_capture`**, then the gate modules from Step 0.
Expected: `test_scout_capture` OK (11 tests). The gate matches the Step 0 baseline. `test_postponement` saves the Single and commits, so afterwards confirm `CS.as_settings()` still reads `1, 1, 15`: **DB-EXEC** `from upande_scp.serverscripts.scouting import capture_settings as CS; print(CS.as_settings())`.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/scouting/capture_settings.py upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.py upande_scp/hooks.py upande_scp/serverscripts/tests/test_scout_capture.py
git commit -m "feat(scp): scout capture settings on the scouting tab, read raw so an unsaved farm keeps photos, comments and a cap of 15"
```

---

### Task 2: The SCP settings API carries and validates the three values

**Files:**
- Modify: `upande_scp/serverscripts/spray_plan_creator/settings.py` (docstring lines 3–17, imports lines 23–31, bundle `csu_scan_verification` block lines 114–121, `save_spray_plan_settings` lines 142–187)
- Test: `upande_scp/serverscripts/tests/test_scout_capture.py` (class `TestSettingsPage`)

**Interfaces:**
- Consumes: Task 1 `CS.as_settings`, `CS.clean_max_count`, `CS.FIELDS`, `CS.PHOTOS_FIELD`, `CS.COMMENTS_FIELD`, `CS.MAX_COUNT_FIELD`.
- Produces: `get_settings_bundle()["spray_plan"]` gains `allow_scout_photos`, `allow_scout_comments` (0/1), `max_count_per_observation` (int). `save_spray_plan_settings(payload)` stores them. It raises `frappe.ValidationError` with `CS.MAX_COUNT_MESSAGE` on a bad max count and saves nothing, and it sets `settings.flags.capture_explicit`.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_scout_capture.py`:

```python
class TestSettingsPage(CaptureCase):
    def setUp(self):
        super().setUp()
        from upande_scp.serverscripts.spray_plan_creator import settings as S
        self.S = S

    def bundle(self):
        return self.S.get_settings_bundle()["spray_plan"]

    def test_the_bundle_carries_the_three_values(self):
        _set(allow_scout_photos=0, allow_scout_comments=1, max_count_per_observation=40)
        got = self.bundle()
        self.assertEqual((got["allow_scout_photos"], got["allow_scout_comments"],
                          got["max_count_per_observation"]), (0, 1, 40))

    def test_the_bundle_reads_unset_as_on(self):
        _unset()
        got = self.bundle()
        self.assertEqual((got["allow_scout_photos"], got["allow_scout_comments"],
                          got["max_count_per_observation"]), (1, 1, 15))

    def test_a_save_round_trips(self):
        self.S.save_spray_plan_settings(json.dumps(
            {"allow_scout_photos": 0, "allow_scout_comments": 0, "max_count_per_observation": 40}))
        self.assertEqual(CS.as_payload(), {"photos": False, "comments": False, "max_count": 40})
        self.S.save_spray_plan_settings(json.dumps({"allow_scout_photos": True, "allow_scout_comments": "1"}))
        self.assertEqual((_raw("allow_scout_photos"), _raw("allow_scout_comments")), ("1", "1"))

    def test_a_save_of_other_fields_leaves_capture_alone(self):
        _unset()
        hours = self.bundle()["loaning_timeout_hours"]
        self.S.save_spray_plan_settings(json.dumps({"loaning_timeout_hours": hours}))
        self.assertEqual(CS.as_payload(), {"photos": True, "comments": True, "max_count": 15})

    def test_max_count_must_be_1_to_10000(self):
        _set(max_count_per_observation=40)
        for bad in (0, 10001, -1, 2.5, "lots", None):
            with self.assertRaises(frappe.ValidationError, msg=repr(bad)) as ctx:
                self.S.save_spray_plan_settings(json.dumps(
                    {"max_count_per_observation": bad, "allow_scout_photos": 0}))
            self.assertIn("whole number from 1 to 10000", str(ctx.exception))
            self.assertEqual((CS.max_count(), CS.allows("photos")), (40, True))   # nothing saved

    def test_only_a_gm_or_admin_may_read_or_save(self):
        frappe.set_user("Guest")
        with self.assertRaises(frappe.ValidationError):
            self.S.save_spray_plan_settings(json.dumps({"allow_scout_photos": 0}))
        with self.assertRaises(frappe.ValidationError):
            self.S.get_settings_bundle()
        frappe.set_user("Administrator")
        self.assertTrue(CS.allows("photos"))
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_scout_capture`**
Expected: the `TestSettingsPage` tests FAIL or ERROR: `KeyError: 'allow_scout_photos'` on the bundle, `AssertionError` on the round trip (the fields are not in `scalar_fields`), and no ValidationError for a bad max count. The Task 1 tests still pass.

- [ ] **Step 3: Implement**

In `upande_scp/serverscripts/spray_plan_creator/settings.py`:

(a) In the module docstring, after item 4 (line 14), add:

```
  5. Scouting capture — whether a scout may photograph what they find and
     write a comment, and the highest count one observation may carry. Three
     fields on the same Single, read on the handset's side through
     ``serverscripts.scouting.capture_settings`` (pieces 5–6).
```

(b) After `from upande_scp.serverscripts.common.cache_utils import K_AFP_WAREHOUSES, invalidate` (line 23) add:

```python
from upande_scp.serverscripts.scouting import capture_settings
```

(c) In `get_settings_bundle`, after the `"csu_scan_verification": (…),` entry (ends line 121) and before `"allowed_farms": allowed_farms,`, insert:

```python
            # Scout capture (pieces 5–6). Read through capture_settings, never
            # off `settings`: a loaded Single casts a missing Check to 0, which
            # would show the GM "off" for a switch that is on.
            **capture_settings.as_settings(),
```

(d) In `save_spray_plan_settings`, add to the end of the `scalar_fields` list (after `"csu_scan_verification",`, line 184):

```python
        # Scout capture (pieces 5–6), validated just below before anything is set.
        "allow_scout_photos",
        "allow_scout_comments",
        "max_count_per_observation",
```

and insert immediately before `for f in scalar_fields:` (line 185):

```python
    # A bad max count saves nothing (it throws before any field is set); the
    # switches are stored as 0 / 1. `capture_explicit` tells the Single's
    # validate which capture fields this save set on purpose, so its
    # unset-means-default guard never overrides the GM.
    if capture_settings.MAX_COUNT_FIELD in payload:
        payload[capture_settings.MAX_COUNT_FIELD] = capture_settings.clean_max_count(
            payload[capture_settings.MAX_COUNT_FIELD]
        )
    for f in (capture_settings.PHOTOS_FIELD, capture_settings.COMMENTS_FIELD):
        if f in payload:
            payload[f] = 1 if frappe.utils.cint(payload[f]) else 0
    settings.flags.capture_explicit = {f for f in capture_settings.FIELDS if f in payload}
```

- [ ] **Step 4: Run to pass, plus the gate**

Run: **DB-RUN `test_scout_capture`**, **DB-RUN `test_postponement`** (its `TestSettingsRoundTrip` is the existing "every scalar survives a save" guard), then the rest of the gate.
Expected: all OK (or matching the Step 0 baseline).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/spray_plan_creator/settings.py upande_scp/serverscripts/tests/test_scout_capture.py
git commit -m "feat(scp): the settings page reads and saves scout capture, and refuses a max count outside 1 to 10000"
```

---

### Task 3: Comments and photo tables on the entry; createScoutingEntry keeps the comments

**Files:**
- Create: `upande_scp/upande_scp/doctype/comments_scouting_entry/__init__.py` (empty), `comments_scouting_entry.json`, `comments_scouting_entry.py`
- Create: `upande_scp/upande_scp/doctype/scouting_entry_photo/__init__.py` (empty), `scouting_entry_photo.json`, `scouting_entry_photo.py`
- Modify: `upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json` (`field_order` line 33, `incidents_scouting_entry` field object at line ~195, `"modified"` line 238)
- Modify: `upande_scp/serverscripts/mobile/create_scouting_entry.py` (nested `add_child_items` lines 313–364 and its calls 366–374)
- Test: `upande_scp/serverscripts/tests/test_scout_capture.py` (class `TestTablesAndComments`)

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: child doctypes `Comments Scouting Entry` (`comment` Small Text) and `Scouting Entry Photo` (`image` Attach Image reqd, `caption` Small Text, `subject` Data, `captured_on` Datetime read-only). Scouting Entry fields `comments_scouting_entry`, `photos_scouting_entry`. `create_scouting_entry._add_child_items(parent_doc, parent_field, items_list)` at module level, behaviour-identical for every existing table, plus `comments_scouting_entry` (strip; drop blank).

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_scout_capture.py`:

```python
class TestTablesAndComments(CaptureCase):
    def test_the_child_doctypes(self):
        photo = frappe.get_meta("Scouting Entry Photo")
        self.assertTrue(photo.istable)
        self.assertEqual({f: photo.get_field(f).fieldtype for f in ("image", "caption", "subject", "captured_on")},
                         {"image": "Attach Image", "caption": "Small Text", "subject": "Data",
                          "captured_on": "Datetime"})
        comment = frappe.get_meta("Comments Scouting Entry")
        self.assertTrue(comment.istable)
        self.assertEqual(comment.get_field("comment").fieldtype, "Small Text")

    def test_the_entry_has_both_tables_after_incidents(self):
        meta = frappe.get_meta("Scouting Entry")
        for field, options in (("comments_scouting_entry", "Comments Scouting Entry"),
                               ("photos_scouting_entry", "Scouting Entry Photo")):
            df = meta.get_field(field)
            self.assertEqual((df.fieldtype, df.options), ("Table", options))
        order = [f.fieldname for f in meta.fields]
        at = order.index("incidents_scouting_entry")
        self.assertEqual(order[at + 1:at + 3], ["comments_scouting_entry", "photos_scouting_entry"])

    def test_comments_are_trimmed_and_blanks_dropped(self):
        from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
        doc = frappe.new_doc("Scouting Entry")
        CSE._add_child_items(doc, "comments_scouting_entry", [
            {"comment": "  Webbing under the leaves  "}, {"comment": "   "}, {}, None, {"comment": None},
        ])
        self.assertEqual([r.comment for r in doc.comments_scouting_entry], ["Webbing under the leaves"])
        self.assertEqual(doc.comments_scouting_entry[0].doctype, "Comments Scouting Entry")

    def test_the_other_tables_fill_as_before(self):
        from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
        doc = frappe.new_doc("Scouting Entry")
        CSE._add_child_items(doc, "pests_scouting_entry",
                             [{"pest": "Thrips", "plant_section": "buds", "stage": "Adult", "count": 3}])
        CSE._add_child_items(doc, "incidents_scouting_entry", "not a list")
        row = doc.pests_scouting_entry[0]
        self.assertEqual((row.pest, row.plant_section, row.stage, row.count), ("Thrips", "buds", "Adult", 3))
        self.assertEqual(doc.incidents_scouting_entry, [])

    def test_create_scouting_entry_writes_the_comments(self):
        from upande_scp.serverscripts.mobile import create_scouting_entry as CSE
        zone, bed, gh = frappe.db.sql(
            "SELECT z.name, z.bed, b.greenhouse FROM tabZone z JOIN tabBed b ON b.name = z.bed LIMIT 1")[0]
        user = frappe.db.get_value("Employee", {"status": "Active", "user_id": ["like", "%@%"]}, "user_id")
        entry = {
            "client_id": CLIENT_ID + "|comments", "scouts_name": user, "greenhouse": gh, "bed": bed,
            "latitude": "-0.1", "longitude": "35.1", "accuracy": 3, "crop_scouted": "Rose",
            "date_of_capture": "2031-05-12", "time_of_capture": "08:00:00",
            "comments_scouting_entry": [{"comment": "  Webbing under the leaves  "}, {"comment": " "}],
        }
        prev = getattr(frappe.local, "request", None)
        try:
            frappe.local.request = SimpleNamespace(get_json=lambda: entry)
            frappe.local.response = frappe._dict()
            with patch.object(CSE, "get_zone_from_coordinates",
                              return_value=(zone, 0.9, {"distance": "0.1", "buffer": "0.5", "fallback": False})), \
                 patch.object(frappe, "publish_realtime"):
                CSE.createScoutingEntry()
            result = frappe.local.response["data"][0]
        finally:
            frappe.local.request = prev
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(
            frappe.get_all("Comments Scouting Entry", filters={"parent": result["name"]}, pluck="comment"),
            ["Webbing under the leaves"])

    def test_a_caption_survives_on_the_row(self):
        doc = frappe.new_doc("Scouting Entry")
        doc.append("photos_scouting_entry", {"image": "/private/files/x.jpg",
                                             "caption": "Webbing on the underside", "subject": "Spider Mites"})
        row = doc.photos_scouting_entry[0]
        self.assertEqual((row.caption, row.subject), ("Webbing on the underside", "Spider Mites"))
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_scout_capture`**
Expected: `TestTablesAndComments` ERRORs with `DoesNotExistError: DocType Scouting Entry Photo not found` and `AttributeError: module '…create_scouting_entry' has no attribute '_add_child_items'`.

- [ ] **Step 3: The two child doctypes**

Create `upande_scp/upande_scp/doctype/comments_scouting_entry/__init__.py` and `upande_scp/upande_scp/doctype/scouting_entry_photo/__init__.py` as empty files.

Create `upande_scp/upande_scp/doctype/comments_scouting_entry/comments_scouting_entry.json`:

```json
{
 "actions": [],
 "creation": "2026-10-10 20:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": [
  "comment"
 ],
 "fields": [
  {
   "fieldname": "comment",
   "fieldtype": "Small Text",
   "in_list_view": 1,
   "label": "Comment"
  }
 ],
 "index_web_pages_for_search": 0,
 "istable": 1,
 "links": [],
 "modified": "2026-10-10 20:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Comments Scouting Entry",
 "owner": "Administrator",
 "permissions": [],
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": []
}
```

Create `upande_scp/upande_scp/doctype/comments_scouting_entry/comments_scouting_entry.py` (tabs):

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class CommentsScoutingEntry(Document):
	"""A free-text note a scout wrote on an entry (piece 5, ported from Mona 8be897b).

	The handset has posted `comments_scouting_entry` for months; until this
	doctype existed on kaitet the rows were silently dropped on the way in.
	"""

	pass
```

Create `upande_scp/upande_scp/doctype/scouting_entry_photo/scouting_entry_photo.json`:

```json
{
 "actions": [],
 "creation": "2026-10-10 20:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": [
  "image",
  "caption",
  "subject",
  "captured_on"
 ],
 "fields": [
  {
   "fieldname": "image",
   "fieldtype": "Attach Image",
   "in_list_view": 1,
   "label": "Photo",
   "reqd": 1
  },
  {
   "columns": 4,
   "description": "The scout's own words about this picture.",
   "fieldname": "caption",
   "fieldtype": "Small Text",
   "in_list_view": 1,
   "label": "Caption"
  },
  {
   "columns": 2,
   "description": "What the photo is of: the pest, disease or finding the scout recorded, or General.",
   "fieldname": "subject",
   "fieldtype": "Data",
   "in_list_view": 1,
   "label": "Subject"
  },
  {
   "fieldname": "captured_on",
   "fieldtype": "Datetime",
   "label": "Captured On",
   "read_only": 1
  }
 ],
 "index_web_pages_for_search": 0,
 "istable": 1,
 "links": [],
 "modified": "2026-10-10 20:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Scouting Entry Photo",
 "owner": "Administrator",
 "permissions": [],
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": []
}
```

Create `upande_scp/upande_scp/doctype/scouting_entry_photo/scouting_entry_photo.py` (tabs):

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ScoutingEntryPhoto(Document):
	"""One picture a scout took on a round, with the words about it (piece 5,
	ported from Mona f5f6392).

	The picture itself is a private File attached to the parent Scouting Entry;
	this row is what makes it visible on the entry and pairs it with a caption.
	"""

	pass
```

- [ ] **Step 4: The Scouting Entry tables**

In `upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json`:

(a) `field_order`: after `"incidents_scouting_entry",` (line 33) insert `"comments_scouting_entry", "photos_scouting_entry",`.

(b) `fields`: insert right after the `incidents_scouting_entry` field object (it starts at line ~195 and is followed by `section_break_betj`):

```json
  {
   "fieldname": "comments_scouting_entry",
   "fieldtype": "Table",
   "label": "Comments",
   "options": "Comments Scouting Entry"
  },
  {
   "fieldname": "photos_scouting_entry",
   "fieldtype": "Table",
   "label": "Photos",
   "options": "Scouting Entry Photo"
  },
```

(c) `"modified"` (line 238) becomes `"2026-10-10 20:00:00.000000"`.

- [ ] **Step 5: Comments in createScoutingEntry**

In `upande_scp/serverscripts/mobile/create_scouting_entry.py`:

(a) Delete the nested `def add_child_items(…)` block (lines 313–364, the def through the `crop_modelling_entry` branch). Add it at **module level**, directly above `@frappe.whitelist()` of `createScoutingEntry` (line 114), dedented and with the comments branch added. Every other branch stays character-for-character:

```python
def _add_child_items(parent_doc, parent_field, items_list):
    """Append one child row per item of `items_list` to `parent_field`.

    Lifted out of createScoutingEntry unchanged so it can be tested; the one
    addition is `comments_scouting_entry` (piece 5, ported from Mona 8be897b):
    free text, stripped, and a whitespace-only comment is dropped rather than
    carried into every report that reads the table."""
    if not items_list or not isinstance(items_list, list):
        return
    for item in items_list:
        if not item:
            continue

        if parent_field == "comments_scouting_entry":
            comment = (item.get("comment") or "").strip()
            if comment:
                parent_doc.append(parent_field, {"comment": comment})
            continue

        child_row = parent_doc.append(parent_field, {})

        if parent_field == "predators_scouting_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.predator      = item.get("predator")
            child_row.stage         = item.get("stage")
            child_row.count         = item.get("count")

        elif parent_field == "diseases_scouting_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.disease       = item.get("disease")
            child_row.count         = item.get("count")
            child_row.stage         = item.get("stage")

        elif parent_field == "physiological_disorders_entry":
            child_row.plant_section           = item.get("plant_section")
            child_row.physiological_disorders = item.get("physiological_disorders")

        elif parent_field == "crop_husbandry_practices_entry":
            child_row.plant_section            = item.get("plant_section")
            child_row.crop_husbandry_practices = item.get("crop_husbandry_practices")

        elif parent_field == "weeds_scouting_entry":
            child_row.weed = item.get("weed")

        elif parent_field == "pests_scouting_entry":
            child_row.plant_section = item.get("plant_section")
            child_row.pest          = item.get("pest")
            child_row.stage         = item.get("stage")
            child_row.count         = item.get("count")

        elif parent_field == "incidents_scouting_entry":
            child_row.incident = item.get("incident")

        elif parent_field == "trap_scouting_entry":
            child_row.trap     = item.get("trap")
            child_row.pest     = item.get("pest")
            child_row.location = item.get("location", "Indoor")
            child_row.count    = item.get("count")

        elif parent_field == "crop_modelling_entry":
            child_row.tree        = item.get("tree")
            child_row.leaf_size   = item.get("leaf_size")
            child_row.leaf_color  = item.get("leaf_color")
            child_row.fruit_stage = item.get("fruit_stage")
            child_row.root_flush  = 1 if item.get("root_flush") else 0
```

(Before writing it, diff the existing nested block against this text: `sed -n 313,364p upande_scp/serverscripts/mobile/create_scouting_entry.py`. Only the indentation, the docstring and the comments branch may differ.)

(b) The nine calls (lines 366–374) become `_add_child_items(…)` with the same arguments, plus a tenth after `crop_modelling_entry`:

```python
                _add_child_items(scout_doc, "comments_scouting_entry",        entry_data.get("comments_scouting_entry"))
```

- [ ] **Step 6: Apply the schema (no-op ALTER pre-check first)**

Run the pre-check. It computes what Frappe would ALTER on `tabScouting Entry` (~1.96 M rows) **without** executing anything:
**DB-EXEC** `from frappe.database.mariadb.schema import MariaDBTable; t = MariaDBTable('Scouting Entry'); t.setup_table_columns(); [c.build_for_alter_table(t.current_columns.get(c.fieldname.lower())) for c in t.columns.values()]; print({k: [c.fieldname for c in getattr(t, k)] for k in ('add_column', 'change_type', 'set_default', 'change_nullability', 'add_unique', 'add_index')})`
Expected: every list empty (verified on 2026-10-10). **If any list is non-empty, STOP and report to the user.** That ALTER would rewrite a 2 M-row table while the site is live. The JSON change adds Table fields only, which never become columns.

Then: **DB-EXEC** `frappe.reload_doc('upande_scp', 'doctype', 'comments_scouting_entry', force=True); frappe.reload_doc('upande_scp', 'doctype', 'scouting_entry_photo', force=True); frappe.reload_doc('upande_scp', 'doctype', 'scouting_entry', force=True); print(frappe.db.table_exists('Comments Scouting Entry'), frappe.db.table_exists('Scouting Entry Photo'), [f.fieldname for f in frappe.get_meta('Scouting Entry').get_table_fields() if f.fieldname in ('comments_scouting_entry', 'photos_scouting_entry')])`
Expected: `True True ['comments_scouting_entry', 'photos_scouting_entry']`.

- [ ] **Step 7: Run to pass, plus the gate**

Run: **DB-RUN `test_scout_capture`**, **DB-RUN `test_manager_permissions`** (its `test_a_real_scout_can_create_a_scouting_entry`), then the rest of the gate.
Expected: all OK. Afterwards: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT COUNT(*) FROM \`tabComments Scouting Entry\`; SELECT COUNT(*) FROM \`tabScouting Entry\` WHERE date_of_capture = '2031-05-12';"` → `0`, `0`.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/upande_scp/doctype/comments_scouting_entry upande_scp/upande_scp/doctype/scouting_entry_photo upande_scp/upande_scp/doctype/scouting_entry/scouting_entry.json upande_scp/serverscripts/mobile/create_scouting_entry.py upande_scp/serverscripts/tests/test_scout_capture.py
git commit -m "feat(scp): comments and captioned photos have a home on the scouting entry, and the comments the app sends are kept"
```

(`git add` on the two new doctype directories adds exactly their three files each. Check `git status --short` shows no `__pycache__`; `.gitignore` already excludes it.)

---

### Task 4: The handset is told; a scout may photograph anything, each photo its own row

**Files:**
- Modify: `upande_scp/serverscripts/mobile/get_observations_details.py` (import line 1, before `# Plant sections allowed` line 350, response lines 361–364)
- Rewrite: `upande_scp/serverscripts/mobile/pest_image.py` (whole file, 119 lines)
- Test: `upande_scp/serverscripts/tests/test_scout_capture.py` (classes `TestObservationsPayload`, `TestPhotoUpload`)

**Interfaces:**
- Consumes: Task 1 `CS.allows`, `CS.as_payload`; Task 3 `photos_scouting_entry`.
- Produces:
  - `getObservationsDetails(crop)` → `{"data", "allowed_plant_sections", "capture": {"photos", "comments", "max_count"}}`. When comments are allowed, `data` ends with `{"category": "Comments", "type": "text", "fields": []}`.
  - `PI.attach_scouting_photo()` (whitelisted), form fields `client_id`, `pest`, `disease`, `subject`, `caption`, `photo_id`, `trap`, file `file`. Its `frappe.response["data"]` is one of: `{"status": "refused", "reason": "photos-off", "message"}`, `{"status": "pending"}`, `{"status": "ok", "duplicate": True, "entry"}`, or `{"status": "ok", "file", "entry", "subject", "caption", "notified"}`.
  - `PI.attach_unidentified_pest_image is PI.attach_scouting_photo`.
  - `PI._short_file_name(raw_name, client_id, subject_name, photo_id="") -> str`, `PI._is_unidentified(name) -> bool`, `PI.MAX_FILE_NAME = 140`, `PI.REFUSED_MESSAGE`.

- [ ] **Step 1: Write the failing tests**

Append to `upande_scp/serverscripts/tests/test_scout_capture.py`:

```python
class TestObservationsPayload(CaptureCase):
    def observations(self, crop=None):
        from upande_scp.serverscripts.mobile import get_observations_details as GOD
        frappe.local.response = frappe._dict()
        return GOD.getObservationsDetails(crop)

    def test_the_payload_carries_capture(self):
        _set(allow_scout_photos=1, allow_scout_comments=0, max_count_per_observation=40)
        got = self.observations()
        self.assertEqual(got["capture"], {"photos": True, "comments": False, "max_count": 40})
        self.assertIn("data", got)
        self.assertIn("allowed_plant_sections", got)

    def test_nothing_stored_sends_the_defaults(self):
        _unset()
        self.assertEqual(self.observations()["capture"], {"photos": True, "comments": True, "max_count": 15})

    def test_the_comments_category_follows_its_switch(self):
        _set(allow_scout_comments=0)
        self.assertNotIn("Comments", [c["category"] for c in self.observations()["data"]])
        _set(allow_scout_comments=1)
        data = self.observations()["data"]
        self.assertEqual(data[-1], {"category": "Comments", "type": "text", "fields": []})

    def test_the_crop_payload_is_otherwise_unchanged(self):
        _set(allow_scout_comments=1)
        cats = [c["category"] for c in self.observations("Rose")["data"]]
        self.assertIn("Pests", cats)
        self.assertEqual(cats.count("Comments"), 1)


class _Upload:
    def __init__(self, data=b"\xff\xd8jpeg", filename="Thrips-_test.jpg"):
        self.filename = filename
        self.stream = io.BytesIO(data)


class TestPhotoUpload(CaptureCase):
    def setUp(self):
        super().setUp()
        from upande_scp.serverscripts.mobile import pest_image as PI
        self.PI = PI
        self.saved = []
        frappe.db.sql("""INSERT INTO `tabScouting Entry` (name, creation, modified, owner, modified_by, docstatus, idx,
                             greenhouse, date_of_capture, time_of_capture, crop_scouted)
                         VALUES (%s, NOW(), '2031-05-12 08:00:00', 'Administrator', 'Administrator', 0, 0,
                                 %s, '2031-05-12', '08:00:00', 'Rose')""", (ENTRY, GH))
        frappe.db.sql("""INSERT INTO `tabScouting Entry Metadata` (name, creation, modified, owner, modified_by,
                             docstatus, idx, scouting_entry, client_id)
                         VALUES ('_TEST-SEM-CAP-1', NOW(), NOW(), 'Administrator', 'Administrator', 0, 0, %s, %s)""",
                      (ENTRY, CLIENT_ID))
        _set(allow_scout_photos=1)
        self._save = patch("frappe.utils.file_manager.save_file", side_effect=self._fake_save_file)
        self._save.start()
        self._prev_request = getattr(frappe.local, "request", None)

    def tearDown(self):
        self._save.stop()
        frappe.local.request = self._prev_request
        super().tearDown()

    def _fake_save_file(self, fname, content, dt, dn, is_private=1):
        """Stands in for save_file: a raw, rolled-back File row and no disk write."""
        url = f"/private/files/{fname}"
        frappe.db.sql("""INSERT INTO tabFile (name, creation, modified, owner, modified_by, docstatus, idx,
                             file_name, file_url, attached_to_doctype, attached_to_name, is_private, is_folder)
                         VALUES (%s, NOW(), NOW(), 'Administrator', 'Administrator', 0, 0, %s, %s, %s, %s, %s, 0)""",
                      (f"_TEST-FILE-CAP-{len(self.saved) + 1}", fname, url, dt, dn, is_private))
        self.saved.append({"fname": fname, "dt": dt, "dn": dn, "is_private": is_private})
        return frappe._dict(file_url=url)

    def post(self, file=True, **form):
        form.setdefault("client_id", CLIENT_ID)
        frappe.local.form_dict = frappe._dict(form)
        frappe.local.request = SimpleNamespace(files={"file": _Upload()} if file else {})
        frappe.local.response = frappe._dict()
        self.PI.attach_scouting_photo()
        return frappe.local.response.get("data")

    def rows(self):
        return frappe.get_all("Scouting Entry Photo", filters={"parent": ENTRY, "parenttype": "Scouting Entry"},
                              fields=["image", "caption", "subject", "captured_on"], order_by="idx")

    def test_photos_off_refuses_a_documentation_photo(self):
        _set(allow_scout_photos=0)
        got = self.post(pest="Thrips", subject="Thrips", photo_id="p1")
        self.assertEqual((got["status"], got["reason"]), ("refused", "photos-off"))
        self.assertEqual((self.saved, self.rows()), ([], []))
        self.sendmail.assert_not_called()

    def test_an_unidentified_photo_is_accepted_with_photos_off(self):
        _set(allow_scout_photos=0)
        got = self.post(pest="Unidentified pest", trap="Trap 3")
        self.assertEqual((got["status"], got["notified"]), ("ok", True))
        self.assertEqual(len(self.rows()), 1)
        self.sendmail.assert_called_once()
        self.assertIn("Unidentified pest photo", self.sendmail.call_args.kwargs["subject"])

    def test_pending_until_the_entry_syncs(self):
        got = self.post(client_id="_test-scp-capture|never-synced", subject="General", photo_id="p1")
        self.assertEqual(got, {"status": "pending"})
        self.assertEqual(self.saved, [])

    def test_a_photo_lands_on_the_entry_with_its_caption(self):
        before = frappe.db.get_value("Scouting Entry", ENTRY, "modified")
        got = self.post(pest="Thrips", subject="Thrips", caption="  Webbing on the underside ", photo_id="p1")
        self.assertEqual((got["status"], got["subject"], got["caption"], got["notified"]),
                         ("ok", "Thrips", "Webbing on the underside", False))
        [row] = self.rows()
        self.assertEqual((row.subject, row.caption, row.image), ("Thrips", "Webbing on the underside", got["file"]))
        self.assertIsNotNone(row.captured_on)
        [saved] = self.saved
        self.assertEqual((saved["dt"], saved["dn"], saved["is_private"]), ("Scouting Entry", ENTRY, 1))
        self.assertTrue(saved["fname"].startswith("Thrips-"))
        self.assertLessEqual(len(saved["fname"]), self.PI.MAX_FILE_NAME)
        self.sendmail.assert_not_called()
        # The child row is written directly: the 2 M-row parent is never re-saved.
        self.assertEqual(frappe.db.get_value("Scouting Entry", ENTRY, "modified"), before)

    def test_a_general_photo_needs_no_pest(self):
        got = self.post(subject="General", caption="Broken vent", photo_id="g1")
        self.assertEqual((got["status"], got["notified"]), ("ok", False))
        self.assertEqual([r.subject for r in self.rows()], ["General"])
        self.sendmail.assert_not_called()

    def test_a_retry_of_the_same_photo_is_one_row_and_its_caption_updates(self):
        self.post(subject="General", caption="first words", photo_id="g1")
        again = self.post(subject="General", caption="Updated", photo_id="g1")
        self.assertEqual((again["status"], again["duplicate"]), ("ok", True))
        self.assertEqual([(r.subject, r.caption) for r in self.rows()], [("General", "Updated")])
        self.assertEqual(len(self.saved), 1)

    def test_two_photos_of_one_subject_are_two_rows(self):
        self.post(subject="General", caption="north vent", photo_id="g1")
        self.post(subject="General", caption="south vent", photo_id="g2")
        self.assertEqual([r.caption for r in self.rows()], ["north vent", "south vent"])
        self.assertEqual(len({s["fname"] for s in self.saved}), 2)

    def test_an_old_handset_name_hashes_as_before(self):
        # A handset without photo_id keeps Mona's deterministic name, so its
        # retries still find the first upload.
        digest = hashlib.sha1(f"{CLIENT_ID}|Unidentified pest".encode()).hexdigest()[:10]
        self.assertEqual(self.PI._short_file_name("x.jpg", CLIENT_ID, "Unidentified pest"),
                         f"Unidentified-pest-{digest}.jpg")
        self.assertNotEqual(self.PI._short_file_name("x.jpg", CLIENT_ID, "Unidentified pest", "p1"),
                            self.PI._short_file_name("x.jpg", CLIENT_ID, "Unidentified pest"))

    def test_a_long_client_id_still_fits(self):
        name = self.PI._short_file_name("IMG_0042.jpg", "x" * 300, "y" * 300, "z" * 64)
        self.assertLessEqual(len(name), self.PI.MAX_FILE_NAME)
        self.assertTrue(name.endswith(".jpg"))

    def test_the_old_endpoint_name_is_the_same_endpoint(self):
        self.assertIs(self.PI.attach_unidentified_pest_image, self.PI.attach_scouting_photo)
        self.assertIn(self.PI.attach_scouting_photo, frappe.whitelisted)

    def test_missing_file_or_client_id_throws(self):
        with self.assertRaises(frappe.ValidationError):
            self.post(file=False, subject="General", photo_id="g1")
        with self.assertRaises(frappe.ValidationError):
            self.post(client_id="", subject="General", photo_id="g1")

    def test_is_unidentified_mirrors_the_handset(self):
        self.assertTrue(self.PI._is_unidentified("Unidentified pest"))
        self.assertTrue(self.PI._is_unidentified(""))
        self.assertFalse(self.PI._is_unidentified("Downy Mildew"))
        self.assertFalse(self.PI._is_unidentified("General"))
```

- [ ] **Step 2: Run to see it fail**

Run: **DB-RUN `test_scout_capture`**
Expected: `TestObservationsPayload` FAILs with `KeyError: 'capture'`. `TestPhotoUpload` ERRORs with `AttributeError: module '…pest_image' has no attribute 'attach_scouting_photo'`. Tasks 1–3 tests still pass.

- [ ] **Step 3: The observations payload**

In `upande_scp/serverscripts/mobile/get_observations_details.py`:

(a) After `import frappe` (line 1) add:

```python

from upande_scp.serverscripts.scouting import capture_settings
```

(b) Insert before `    # Plant sections allowed for this crop` (line 350):

```python
    # COMMENTS — a free-text note on the entry as a whole (piece 5, Mona
    # f5f6392). Not driven by master data like the categories above; driven by
    # the GM's switch. The app shows the tab only when this category is
    # present, so the switch has to reach the category itself, not only the
    # flag in `capture`. The app supplies its own field when `fields` is empty
    # (use-scouting-utils.ts, `commentField`); rows arrive as
    # comments_scouting_entry.
    if capture_settings.allows("comments"):
        observation_types.append({
            "category": "Comments",
            "type": "text",
            "fields": [],
        })

```

(c) The response (lines 361–364) becomes:

```python
    frappe.response["message"] = {
        "data": observation_types,
        "allowed_plant_sections": allowed_plant_sections,
        # What the handset may offer on the ground, and its count cap
        # (pieces 5–6). Rides here because the app decides what to draw while
        # it builds the round; a second request is one more thing to fail.
        "capture": capture_settings.as_payload(),
    }
```

- [ ] **Step 4: The photo endpoint**

Replace the whole of `upande_scp/serverscripts/mobile/pest_image.py` with:

```python
"""Attach a scouting photo to its Scouting Entry, and alert the GM when it is
of something the scout could not name (piece 5; ported from Mona f5f6392 /
8be897b, kaitet names).

A scout may photograph anything on a round: a finding they recorded (the pest,
disease or other observation is its `subject`), or the entry in general
(`subject` "General"). Every picture carries its own caption, stored on a
**Scouting Entry Photo** row of the entry; the picture itself is a private File
attached to the entry. Whether the scouting form offers a camera at all is the
General Manager's (`scouting.capture_settings`).

The handset uploads the compressed photo out-of-band, keyed by the parent
submission's `client_id`. We resolve the Scouting Entry from that id (via
Scouting Entry Metadata). If the entry has not synced yet we answer
`{"status": "pending"}` and the phone retries later.

TWO KINDS, ONE ENDPOINT. A photo of something unidentified is the trap tab's
alarm: the app demands it, and it emails every SCP General Manager. It is
always accepted, photos switch or not (spec P5: trap photos keep working). Any
other photo is documentation: quiet, and refused when the GM switched photos
off. The refusal is an ordinary `{"status": "refused"}` answer, not a
PermissionError: an expired session also answers 403, and the handset must
not throw away a photo the server would have taken.
"""

import hashlib
import os
import re

import frappe

from upande_scp.serverscripts.scouting import capture_settings

REFUSED_MESSAGE = (
    "Photos are switched off for this farm in Scouting and Crop Protection Settings."
)

# Frappe's File.file_name is Data(140).
MAX_FILE_NAME = 140
_SUBJECT_LIMIT = 40
_DIGEST_LEN = 10
_PHOTO_ID_LIMIT = 64


def _gm_recipients():
    """Email addresses of enabled users holding the SCP General Manager role."""
    users = frappe.get_all(
        "Has Role",
        filters={"role": "SCP General Manager", "parenttype": "User"},
        pluck="parent",
    )
    out = []
    for u in set(users):
        if u in ("Administrator", "Guest"):
            continue
        row = frappe.db.get_value("User", u, ["enabled", "email"], as_dict=True)
        if not row or not row.enabled:
            continue
        addr = row.email or u
        if addr and "@" in addr:
            out.append(addr)
    return out


def _is_unidentified(name):
    """Does this photo show something the scout could not name?

    Mirrors the client's own rule: `needsPhoto` in traps/index.tsx tests the
    pest name for "unidentified". The app always sends a name, so a missing
    name alone is not the test — but nothing named at all still is."""
    return not name or "unidentified" in name.lower()


def _short_file_name(raw_name, client_id, subject_name, photo_id=""):
    """A short, portable, deterministic name for the stored photo.

    The client names the upload from the raw client_id, which percent-encodes
    past 140 characters and made the File insert fail; only its extension is
    used. Deterministic because the duplicate check matches on file_name: a
    retry after a lost response must find the first upload. Keyed on
    client_id + subject (Mona), plus the handset's per-photo `photo_id` when it
    sends one, so two photos of one subject on one entry are two photos. An old
    handset sends no photo_id and hashes exactly as before."""
    ext = re.sub(r"[^A-Za-z0-9.]+", "", os.path.splitext(raw_name or "")[1])[:8] or ".jpg"
    subject = re.sub(r"[^A-Za-z0-9]+", "-", subject_name or "").strip("-")
    subject = subject[:_SUBJECT_LIMIT] or "photo"
    key = f"{client_id}|{subject_name}" + (f"|{photo_id}" if photo_id else "")
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()
    return f"{subject}-{digest[:_DIGEST_LEN]}{ext}"[:MAX_FILE_NAME]


@frappe.whitelist()
def attach_scouting_photo():
    """Store one photo against its Scouting Entry, with the caption it carries."""
    client_id = frappe.form_dict.get("client_id")
    pest = (frappe.form_dict.get("pest") or "").strip()
    disease = (frappe.form_dict.get("disease") or "").strip()
    trap = frappe.form_dict.get("trap") or ""
    caption = (frappe.form_dict.get("caption") or "").strip()
    photo_id = (frappe.form_dict.get("photo_id") or "").strip()[:_PHOTO_ID_LIMIT]

    # pest / disease stay ahead of `subject` for the handsets that only name them.
    subject_name = pest or disease or (frappe.form_dict.get("subject") or "").strip()
    is_unidentified = _is_unidentified(subject_name)

    if not is_unidentified and not capture_settings.allows("photos"):
        # The app is told before it draws the camera, so arriving here means a
        # stale handset or a switch flipped mid-round. Nothing is stored.
        frappe.response["data"] = {
            "status": "refused",
            "reason": "photos-off",
            "message": REFUSED_MESSAGE,
        }
        return

    files = getattr(frappe.request, "files", None)
    file_obj = files.get("file") if files else None
    if not client_id or file_obj is None:
        frappe.throw("client_id and file are required")

    entry = frappe.db.get_value(
        "Scouting Entry Metadata", {"client_id": client_id}, "scouting_entry"
    )
    if not entry:
        # Parent Scouting Entry hasn't synced yet — retry later.
        frappe.response["data"] = {"status": "pending"}
        return

    content = file_obj.stream.read()
    fname = _short_file_name(file_obj.filename, client_id, subject_name, photo_id)

    # Idempotent against client retries after a lost success response.
    existing = frappe.db.get_value(
        "File",
        {
            "attached_to_doctype": "Scouting Entry",
            "attached_to_name": entry,
            "file_name": fname,
        },
        "name",
    )
    if existing:
        # Already here; a retry may still carry a caption the first attempt
        # never delivered, so the row is reconciled either way.
        _record_on_entry(entry, frappe.db.get_value("File", existing, "file_url"), caption, subject_name)
        frappe.response["data"] = {"status": "ok", "duplicate": True, "entry": entry}
        return

    # Frappe's File.write_file() does NOT create the files directory.
    os.makedirs(frappe.get_site_path("private", "files"), exist_ok=True)

    from frappe.utils.file_manager import save_file

    saved = save_file(fname, content, "Scouting Entry", entry, is_private=1)
    _record_on_entry(entry, saved.file_url, caption, subject_name)
    frappe.db.commit()

    # Best-effort GM email (P8: only for something unnamed) — a mail failure
    # must not fail the upload; the photo is already on the entry.
    try:
        recipients = _gm_recipients() if is_unidentified else []
        if recipients:
            gh = frappe.db.get_value("Scouting Entry", entry, "greenhouse") or ""
            esc = frappe.utils.escape_html
            label = subject_name or "Unidentified pest"
            frappe.sendmail(
                recipients=recipients,
                subject=f"Unidentified pest photo — {label}",
                message=(
                    "<p>A scout flagged an unidentified pest and attached a photo.</p>"
                    "<ul>"
                    f"<li><b>Pest:</b> {esc(label)}</li>"
                    f"<li><b>Trap:</b> {esc(trap) or '—'}</li>"
                    f"<li><b>Greenhouse:</b> {esc(gh) or '—'}</li>"
                    f"<li><b>Scouting Entry:</b> {entry}</li>"
                    + (f"<li><b>Caption:</b> {esc(caption)}</li>" if caption else "")
                    + "</ul><p>Photo attached.</p>"
                ),
                attachments=[{"fname": fname, "fcontent": content}],
            )
    except Exception:
        frappe.log_error("attach_scouting_photo: GM email failed", frappe.get_traceback())

    frappe.response["data"] = {
        "status": "ok",
        "file": saved.file_url,
        "entry": entry,
        "subject": subject_name or "Unidentified",
        "caption": caption,
        "notified": is_unidentified,
    }


#: The name the handsets in the field call. A phone updates when its owner is
#: next on wifi, not the week the server does, so the old route keeps
#: answering — it IS the new endpoint, not a copy of it.
attach_unidentified_pest_image = attach_scouting_photo


def _record_on_entry(entry, file_url, caption, subject_name):
    """Put the picture on the entry itself, not only in the File table. Keyed
    by file_url, so a retry updates the words rather than adding a picture."""
    if not file_url:
        return

    doc = frappe.get_doc("Scouting Entry", entry)
    for row in doc.get("photos_scouting_entry") or []:
        if row.image == file_url:
            if caption and row.caption != caption:
                row.db_set("caption", caption, update_modified=False)
            return

    row = doc.append(
        "photos_scouting_entry",
        {
            "image": file_url,
            "caption": caption,
            "subject": subject_name,
            "captured_on": frappe.utils.now(),
        },
    )
    # The child is written directly rather than through a parent save: the
    # upload is decoupled from the sync on purpose, and re-saving the entry
    # would re-run its validation and hooks for a picture.
    row.insert(ignore_permissions=True)
```

- [ ] **Step 5: Run to pass, plus the gate**

Run: **DB-RUN `test_scout_capture`**, then the gate.
Expected: all OK. One harmless side effect: Frappe's `attach_files_to_document` (an `on_update` hook on every doc) may try to attach the faked URL to the child row and log an `Error Attaching File` Error Log row. That row is rolled back.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add upande_scp/serverscripts/mobile/get_observations_details.py upande_scp/serverscripts/mobile/pest_image.py upande_scp/serverscripts/tests/test_scout_capture.py
git commit -m "feat(scp): the handset is told what it may capture, and a scout may photograph anything with a caption, each photo its own row"
```

---

### Task 5: The Scouting capture card on the SCP Settings page

**Files:**
- Create: `frontend/src/components/settings/ScoutCaptureCard.tsx`
- Modify: `frontend/src/components/settings/SprayPlanTab.tsx` (imports lines 38–42, before the "Auto-cancel dormant plans" card line 430, `save` lines 98–111, Save button line 726)
- Modify: `frontend/src/lib/settings-api.ts` (`SprayPlanSettings`, after `progress_email_hour: number;` line 67)
- Test: `frontend/src/components/settings/__tests__/ScoutCaptureCard.test.tsx` (new)

**Interfaces:**
- Consumes: Task 2's bundle fields `allow_scout_photos`, `allow_scout_comments`, `max_count_per_observation`.
- Produces: `ScoutCaptureCard({ value, onChange })`, `ScoutCaptureValues`, `maxCountError(v) -> string | null`, `MAX_COUNT_MIN = 1`, `MAX_COUNT_MAX = 10000`. `SprayPlanSettings` gains the three fields.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/settings/__tests__/ScoutCaptureCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveSprayPlanSettings = vi.fn();
vi.mock("@/lib/settings-api", () => ({
  saveSprayPlanSettings: (...a: unknown[]) => saveSprayPlanSettings(...a),
}));
vi.mock("@/components/settings/TimezoneCard", () => ({ TimezoneCard: () => null }));

import { SprayPlanTab } from "@/components/settings/SprayPlanTab";
import { ScoutCaptureCard, maxCountError } from "@/components/settings/ScoutCaptureCard";
import type { SprayPlanSettings } from "@/lib/settings-api";

const initial: SprayPlanSettings = {
  intro_note: "",
  irac_rotation_window_days: 14,
  frac_rotation_window_days: 14,
  weather_wind_green_max_kmh: 0,
  weather_wind_red_min_kmh: 0,
  weather_rain_green_max_pct: 0,
  weather_rain_red_min_pct: 0,
  weather_temp_green_min_c: 0,
  weather_temp_green_max_c: 0,
  weather_temp_red_max_c: 0,
  weather_temp_red_min_c: 0,
  default_chemical_expense_account: "",
  default_chemical_difference_account: "",
  spray_raw_chemical_account: "",
  spray_tank_mix_account: "",
  spray_expense_account: "",
  stamp_transfer_cost_center: 0,
  bypass_owner_check: 0,
  allow_submit_without_biometric: 0,
  auto_cancel_enabled: 0,
  auto_cancel_apply_to_backlog: 0,
  auto_cancel_dormant_days: 3,
  auto_cancel_activated_on: "",
  spray_cutoff_time: "10:00:00",
  postponement_max_days: 7,
  postponement_grace_minutes: 0,
  loaning_enabled: 0,
  allocation_balancing_enabled: 0,
  loaning_depletion_pct: 15,
  loaning_timeout_hours: 72,
  progress_email_enabled: 0,
  progress_email_hour: 18,
  allow_scout_photos: 1,
  allow_scout_comments: 1,
  max_count_per_observation: 15,
  csu_scan_verification: "labels",
  allowed_farms: [],
  exclude_keywords: [],
};

beforeEach(() => {
  saveSprayPlanSettings.mockReset().mockResolvedValue({ ok: true });
});

describe("maxCountError", () => {
  it("takes whole numbers from 1 to 10000 only", () => {
    expect([1, 15, 10000].map(maxCountError)).toEqual([null, null, null]);
    for (const bad of [0, 10001, -1, 2.5, Number.NaN]) {
      expect(maxCountError(bad)).toMatch(/whole number from 1 to 10000/);
    }
  });
});

describe("ScoutCaptureCard", () => {
  it("shows each switch and the cap as the server sent them, with no side strip", () => {
    const { container } = render(
      <ScoutCaptureCard
        value={{ allow_scout_photos: 0, allow_scout_comments: 1, max_count_per_observation: 40 }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /scouts can attach photos/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /scouts can write comments/i })).toBeChecked();
    expect(screen.getByLabelText(/max count per observation/i)).toHaveValue(40);
    expect(container.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});

describe("SprayPlanTab scouting capture", () => {
  it("saves the three values through the spray plan save", async () => {
    render(<SprayPlanTab initial={initial} farms={[]} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /scouts can attach photos/i }));
    const max = screen.getByLabelText(/max count per observation/i);
    await userEvent.clear(max);
    await userEvent.type(max, "40");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(saveSprayPlanSettings).toHaveBeenCalledWith(
      expect.objectContaining({ allow_scout_photos: 0, allow_scout_comments: 1, max_count_per_observation: 40 }),
    );
  });

  it("refuses a max count outside 1 to 10000 before it reaches the server", async () => {
    render(<SprayPlanTab initial={initial} farms={[]} />);
    const max = screen.getByLabelText(/max count per observation/i);
    await userEvent.clear(max);
    await userEvent.type(max, "0");
    expect(screen.getByText(/whole number from 1 to 10000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
    await userEvent.clear(max);
    await userEvent.type(max, "10001");
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
    expect(saveSprayPlanSettings).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/components/settings/__tests__/ScoutCaptureCard.test.tsx`
Expected: FAIL with `Failed to resolve import "@/components/settings/ScoutCaptureCard"`.

- [ ] **Step 3: The API type**

In `frontend/src/lib/settings-api.ts`, after `progress_email_hour: number;` (line 67) add:

```ts
  /**
   * Scouting capture (pieces 5–6), read by the scout app with its
   * observations. 1 = the app draws the camera / the Comments tab; 0 = it does
   * not offer them at all. The server reads an unset switch as 1.
   */
  allow_scout_photos: number;
  allow_scout_comments: number;
  /** Highest count one observation or trap pest may carry on the handset (1–10000). */
  max_count_per_observation: number;
```

- [ ] **Step 4: The card**

Create `frontend/src/components/settings/ScoutCaptureCard.tsx`:

```tsx
/**
 * Scouting capture (pieces 5–6): what a scout may record beyond the counts,
 * and the highest count one observation may carry. The scout app reads all
 * three with its observations (getObservationsDetails → `capture`); switched
 * off, the camera or the Comments tab is not drawn at all rather than drawn
 * and refused. Saved with the rest of the Spray plan tab.
 */

import { Camera } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const MAX_COUNT_MIN = 1;
export const MAX_COUNT_MAX = 10000;

export interface ScoutCaptureValues {
  allow_scout_photos: number;
  allow_scout_comments: number;
  max_count_per_observation: number;
}

/** The server's rule, checked here first so a bad value never leaves the page. */
export function maxCountError(value: number): string | null {
  return Number.isInteger(value) && value >= MAX_COUNT_MIN && value <= MAX_COUNT_MAX
    ? null
    : "Max count must be a whole number from 1 to 10000.";
}

export function ScoutCaptureCard({
  value,
  onChange,
}: {
  value: ScoutCaptureValues;
  onChange: (key: keyof ScoutCaptureValues, value: number) => void;
}) {
  const error = maxCountError(value.max_count_per_observation);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Camera className="h-4 w-4 text-muted-foreground" />
          Scouting capture
        </CardTitle>
        <CardDescription>
          What a scout may record on a round beyond the counts. The app reads
          these when it loads its observations.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <Checkbox
            id="allow_scout_photos"
            checked={value.allow_scout_photos !== 0}
            onCheckedChange={(v) => onChange("allow_scout_photos", v ? 1 : 0)}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="allow_scout_photos" className="text-xs font-semibold cursor-pointer">
              Scouts can attach photos
            </Label>
            <p className="text-[0.65rem] text-muted-foreground leading-snug">
              One photo button per finding the scout records, plus a General
              photo, each with its own caption, up to 5 per entry. A photo of
              something unidentified on a trap is always accepted.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <Checkbox
            id="allow_scout_comments"
            checked={value.allow_scout_comments !== 0}
            onCheckedChange={(v) => onChange("allow_scout_comments", v ? 1 : 0)}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="allow_scout_comments" className="text-xs font-semibold cursor-pointer">
              Scouts can write comments
            </Label>
            <p className="text-[0.65rem] text-muted-foreground leading-snug">
              A free-text note on the entry. Off: the Comments tab does not
              appear in the app.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
          <Label htmlFor="max_count_per_observation" className="text-xs font-semibold">
            Max count per observation
          </Label>
          <Input
            id="max_count_per_observation"
            type="number"
            min={MAX_COUNT_MIN}
            max={MAX_COUNT_MAX}
            step={1}
            value={Number.isFinite(value.max_count_per_observation) ? value.max_count_per_observation : ""}
            onChange={(e) =>
              onChange(
                "max_count_per_observation",
                e.target.value === "" ? Number.NaN : Number(e.target.value),
              )
            }
            aria-invalid={error ? true : undefined}
            className="h-9 w-32 tabular-nums"
          />
          <p
            className={
              error
                ? "text-[0.65rem] text-destructive leading-snug"
                : "text-[0.65rem] text-muted-foreground leading-snug"
            }
          >
            {error ?? "The highest count the app accepts for one observation or one trap pest. 15 until changed."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Wire it into the Spray plan tab**

In `frontend/src/components/settings/SprayPlanTab.tsx`:

(a) After `import { Checkbox } from "@/components/ui/checkbox";` (line 38) add:

```tsx
import { ScoutCaptureCard, maxCountError } from "@/components/settings/ScoutCaptureCard";
```

(b) After the `dirty` memo (ends line 71) add:

```tsx
  const captureError = maxCountError(draft.max_count_per_observation);
```

(c) In `save` (line 98), make the first line of the function body:

```tsx
    if (captureError) return;
```

(d) Immediately before `      <Card className="lg:col-span-2">` that opens **Auto-cancel dormant plans** (line 430), insert:

```tsx
      <ScoutCaptureCard value={draft} onChange={(key, value) => set(key, value)} />

```

(e) The Save button (line 726) becomes `<Button onClick={save} disabled={!dirty || saving || !!captureError} size="lg">`.

- [ ] **Step 6: Run to pass, typecheck, build**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/components/settings && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: all pass (`ThresholdsTab.test.tsx` included). No type errors: `CropOverridesCard.tsx` and `AccountsTab.tsx` use `SprayPlanSettings` but build no literal of it. The build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short
git add frontend/src/components/settings/ScoutCaptureCard.tsx frontend/src/components/settings/SprayPlanTab.tsx frontend/src/lib/settings-api.ts frontend/src/components/settings/__tests__/ScoutCaptureCard.test.tsx
```

If `yarn build` changed tracked build output (check `git status --short` for `upande_scp/public/…` paths), add those exact paths too, and nothing else. Then:

```bash
git commit -m "feat(scp-ui): a scouting capture card where the general manager switches photos and comments and sets the max count"
```

---

### Task 6: The handset caches `capture` and both count caps read it

**Files** (all under `/home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn`):
- Create: `src/services/scoutCapture.ts`
- Modify: `src/services/scoutingCacheDb.ts` (`addColumnIfMissing` calls lines 104–105, `setCachedObservations` lines 464–481, after `getCachedPlantSections` line 499)
- Modify: `app/(tabs)/index.tsx` (imports lines 63–81, `FieldInput` props lines 128–145 and cap lines 307–314, state after line 368, `loadData` lines 1112–1180, `renderCategoryContentForPart` `<FieldInput>` × 2 lines 1701 / 1734 and deps lines 1767–1774)
- Modify: `app/(tabs)/traps/index.tsx` (imports line 57, state near line 160, `useFocusEffect` lines 411–418, caps lines 694–700 and 760–766)
- Modify: `app/(auth)/configure.tsx` (lines 1539–1546), `app/(tabs)/profile/index.tsx` (lines 950–955), `app/(tabs)/profile/cached-data.tsx` (lines 603–610, 660–667)
- Test: `src/services/__tests__/scoutCapture.test.ts`, `src/services/__tests__/scoutingCacheCapture.test.ts` (new)

**Interfaces:**
- Consumes: Task 4's `capture: {photos, comments, max_count}` in the `getObservationsDetails` body.
- Produces:
  - `CaptureSettings = { photos: boolean; comments: boolean; maxCount: number }`; `DEFAULT_MAX_COUNT = 15`, `MAX_COUNT_LIMIT = 10000`, `LEGACY_CAPTURE = { photos: false, comments: true, maxCount: 15 }`
  - `parseCaptureSettings(res) -> CaptureSettings | null` (null = server sent none)
  - `resolveCapture(c) -> CaptureSettings` (null/undefined → `LEGACY_CAPTURE`)
  - `cleanMaxCount(v) -> number`, `exceedsMaxCount(n, max) -> boolean`, `maxCountMessage(max) -> string`, `trapMaxCountMessage(max, pest?) -> string`
  - `setCachedObservations(payload, crop?, plantSections?, capture?: CaptureSettings | null)`. `undefined` leaves the stored capture alone; `null` stores "server sent none". `getCachedCaptureSettings(): Promise<CaptureSettings>`.

- [ ] **Step 1: Write the failing tests**

Create `src/services/__tests__/scoutCapture.test.ts`:

```ts
/**
 * Pieces 5–6: the server says what a scout may capture and the highest count
 * one observation may carry. An old server says nothing — then the handset
 * keeps the old cap of 15 and draws no photo buttons, because the old server's
 * photo endpoint emails every general manager for every photo it receives.
 */
import {
  DEFAULT_MAX_COUNT,
  LEGACY_CAPTURE,
  cleanMaxCount,
  exceedsMaxCount,
  maxCountMessage,
  parseCaptureSettings,
  resolveCapture,
  trapMaxCountMessage,
} from "../scoutCapture";

const body = (capture?: unknown) => ({
  message: {
    data: [{ category: "Pests", type: "mixed", fields: [] }],
    allowed_plant_sections: null,
    ...(capture === undefined ? {} : { capture }),
  },
});

describe("parseCaptureSettings", () => {
  it("keeps the server's capture block", () => {
    expect(parseCaptureSettings(body({ photos: true, comments: false, max_count: 40 }))).toEqual({
      photos: true,
      comments: false,
      maxCount: 40,
    });
  });

  it("is null when the server sent none (an old server)", () => {
    expect(parseCaptureSettings(body())).toBeNull();
    expect(parseCaptureSettings(null)).toBeNull();
    expect(parseCaptureSettings({ message: "not json" })).toBeNull();
  });

  it("reads a string-encoded message", () => {
    const res = { message: JSON.stringify(body({ photos: false, comments: true, max_count: 20 }).message) };
    expect(parseCaptureSettings(res)).toEqual({ photos: false, comments: true, maxCount: 20 });
  });

  it("falls back to 15 for a max count no handset could use", () => {
    for (const bad of [0, -1, 10001, 2.5, "x", null, undefined]) {
      expect(parseCaptureSettings(body({ photos: true, comments: true, max_count: bad }))?.maxCount).toBe(15);
    }
  });

  it("treats only an explicit true as photos on", () => {
    expect(parseCaptureSettings(body({ photos: "yes", comments: true, max_count: 15 }))?.photos).toBe(false);
  });
});

describe("resolveCapture", () => {
  it("an old server gets 15 and no photo buttons", () => {
    expect(resolveCapture(null)).toEqual(LEGACY_CAPTURE);
    expect(resolveCapture(undefined)).toEqual({ photos: false, comments: true, maxCount: DEFAULT_MAX_COUNT });
  });

  it("passes a server block through, cleaning the cap", () => {
    expect(resolveCapture({ photos: true, comments: false, maxCount: 40 })).toEqual({
      photos: true,
      comments: false,
      maxCount: 40,
    });
    expect(resolveCapture({ photos: true, comments: true, maxCount: 0 }).maxCount).toBe(15);
  });
});

describe("the cap", () => {
  it("allows the cap itself and refuses one more", () => {
    expect([exceedsMaxCount(15, 15), exceedsMaxCount(16, 15)]).toEqual([false, true]);
    expect([exceedsMaxCount(40, 40), exceedsMaxCount(41, 40)]).toEqual([false, true]);
    expect(exceedsMaxCount(Number.NaN, 15)).toBe(false);
    expect(cleanMaxCount("25")).toBe(25);
  });

  it("names the configured number", () => {
    expect(maxCountMessage(40)).toBe("The highest count you can record for one observation is 40.");
    expect(trapMaxCountMessage(40)).toBe("Maximum count is 40");
    expect(trapMaxCountMessage(40, "Thrips")).toBe("Maximum count is 40 for Thrips");
  });
});
```

Create `src/services/__tests__/scoutingCacheCapture.test.ts`:

```ts
/**
 * The capture block is cached with the observations (same row), so a scout who
 * loads a round offline still gets the GM's cap and switches.
 */
const mockRun = jest.fn(async (_sql: string, _params: any[]) => ({ changes: 1 }));
let mockRow: Record<string, any> | null = null;

const mockDb = {
  execAsync: jest.fn(async () => undefined),
  runAsync: mockRun,
  getAllAsync: jest.fn(async () => []),
  getFirstAsync: jest.fn(async () => mockRow),
};

jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(async () => mockDb),
}));

import { getCachedCaptureSettings, setCachedObservations } from "../scoutingCacheDb";
import { LEGACY_CAPTURE } from "../scoutCapture";

beforeEach(() => {
  mockRun.mockClear();
  mockRow = null;
});

describe("capture rides with the cached observations", () => {
  it("adds the capture column to an existing cache", async () => {
    await getCachedCaptureSettings();
    const ddl = (mockDb.execAsync.mock.calls as any[]).map((c) => String(c[0]));
    expect(ddl).toContain("ALTER TABLE observations ADD COLUMN capture TEXT");
  });

  it("stores the server's block as JSON", async () => {
    await setCachedObservations([], "Rose", null, { photos: true, comments: false, maxCount: 40 });
    const [sql, params] = mockRun.mock.calls[mockRun.mock.calls.length - 1];
    expect(sql).toContain("capture = excluded.capture");
    expect(params).toContain(JSON.stringify({ photos: true, comments: false, maxCount: 40 }));
  });

  it("leaves the stored block alone when a caller passes none", async () => {
    await setCachedObservations([], "Rose", null);
    const [sql] = mockRun.mock.calls[mockRun.mock.calls.length - 1];
    expect(sql).not.toContain("capture");
  });

  it("reads the block back, cleaned", async () => {
    mockRow = { capture: JSON.stringify({ photos: true, comments: true, maxCount: 40 }) };
    await expect(getCachedCaptureSettings()).resolves.toEqual({ photos: true, comments: true, maxCount: 40 });
  });

  it("a cached row with no capture reads as legacy", async () => {
    mockRow = { capture: null };
    await expect(getCachedCaptureSettings()).resolves.toEqual(LEGACY_CAPTURE);
    mockRow = { capture: "{broken" };
    await expect(getCachedCaptureSettings()).resolves.toEqual(LEGACY_CAPTURE);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn && npx jest src/services/__tests__/scoutCapture.test.ts src/services/__tests__/scoutingCacheCapture.test.ts`
Expected: FAIL with `Cannot find module '../scoutCapture'`.

- [ ] **Step 3: The pure module**

Create `src/services/scoutCapture.ts`:

```ts
/**
 * What the server lets a scout capture beyond the counts, and the highest
 * count one observation may carry (scout capture settings, pieces 5–6).
 *
 * It arrives as the `capture` block of getObservationsDetails —
 * `{ photos, comments, max_count }` — and is cached with the observations.
 *
 * An old server sends no block. Then the handset keeps the old cap of 15 and
 * shows no photo buttons: that server's upload endpoint emails every general
 * manager for every photo it gets, so documentation photos must not reach it.
 * Comments need no flag here: the server drops the Comments category itself.
 */

export type CaptureSettings = {
  photos: boolean;
  comments: boolean;
  maxCount: number;
};

export const DEFAULT_MAX_COUNT = 15;
export const MAX_COUNT_LIMIT = 10000;

export const LEGACY_CAPTURE: CaptureSettings = {
  photos: false,
  comments: true,
  maxCount: DEFAULT_MAX_COUNT,
};

/** A whole number from 1 to 10000, else the old 15 — never a cap that makes
 *  every count unrecordable. */
export const cleanMaxCount = (value: unknown): number => {
  if (value === null || value === undefined || value === "") return DEFAULT_MAX_COUNT;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_COUNT_LIMIT ? n : DEFAULT_MAX_COUNT;
};

const rootOf = (res: any): Record<string, any> | null => {
  let root = res?.message ?? res?.data ?? res;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      return null;
    }
  }
  if (Array.isArray(root)) root = root[0];
  return root && typeof root === "object" ? root : null;
};

/** The server's capture block, or null when it sent none (an old server). */
export const parseCaptureSettings = (res: any): CaptureSettings | null => {
  const cap = rootOf(res)?.capture;
  if (!cap || typeof cap !== "object") return null;
  return {
    photos: cap.photos === true,
    comments: cap.comments !== false,
    maxCount: cleanMaxCount(cap.max_count),
  };
};

/** What the screens use: the server's block, or LEGACY_CAPTURE without one. */
export const resolveCapture = (
  capture: CaptureSettings | null | undefined,
): CaptureSettings =>
  capture
    ? {
        photos: capture.photos === true,
        comments: capture.comments !== false,
        maxCount: cleanMaxCount(capture.maxCount),
      }
    : LEGACY_CAPTURE;

export const exceedsMaxCount = (n: number, maxCount: number): boolean =>
  Number.isFinite(n) && n > maxCount;

export const maxCountMessage = (maxCount: number): string =>
  `The highest count you can record for one observation is ${maxCount}.`;

export const trapMaxCountMessage = (maxCount: number, pest?: string): string =>
  pest ? `Maximum count is ${maxCount} for ${pest}` : `Maximum count is ${maxCount}`;
```

- [ ] **Step 4: The cache**

In `src/services/scoutingCacheDb.ts`:

(a) After `import * as SQLite from "expo-sqlite";` (line 2) add:

```ts
import {
  resolveCapture,
  type CaptureSettings,
} from "./scoutCapture";
```

(b) After `await addColumnIfMissing(db, "observations", "plant_sections", "TEXT");` (line 105) add:

```ts
    await addColumnIfMissing(db, "observations", "capture", "TEXT");
```

(c) Replace `setCachedObservations` (lines 464–481) with:

```ts
/** `capture` (pieces 5–6): the server's capture block for this payload. Pass
 *  `null` when the server sent none (an old server); leave it `undefined` to
 *  keep whatever is stored. */
export const setCachedObservations = async (
  payload: any[],
  crop?: string | null,
  plantSections?: string[] | null,
  capture?: CaptureSettings | null,
) => {
  await initScoutingCacheDb();
  return queueDbOp(async () => {
    const db = await getDb();
    const psJson =
      plantSections && plantSections.length
        ? JSON.stringify(plantSections)
        : null;
    if (capture === undefined) {
      await db.runAsync(
        "INSERT INTO observations (id, payload, crop, plant_sections, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, crop = excluded.crop, plant_sections = excluded.plant_sections, updated_at = excluded.updated_at",
        [JSON.stringify(payload), crop ?? null, psJson, Date.now()],
      );
      return;
    }
    await db.runAsync(
      "INSERT INTO observations (id, payload, crop, plant_sections, capture, updated_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, crop = excluded.crop, plant_sections = excluded.plant_sections, capture = excluded.capture, updated_at = excluded.updated_at",
      [
        JSON.stringify(payload),
        crop ?? null,
        psJson,
        capture === null ? null : JSON.stringify(capture),
        Date.now(),
      ],
    );
  });
};
```

(d) After `getCachedPlantSections` (ends line 499) add:

```ts
/** The cached capture block, resolved: LEGACY_CAPTURE (cap 15, no photo
 *  buttons) when nothing usable is stored. */
export const getCachedCaptureSettings = async (): Promise<CaptureSettings> => {
  await initScoutingCacheDb();
  return queueDbOp(async () => {
    const db = await getDb();
    const row = await db.getFirstAsync<{ capture: string | null }>(
      "SELECT capture FROM observations WHERE id = 1",
      [],
    );
    if (!row?.capture) return resolveCapture(null);
    try {
      return resolveCapture(JSON.parse(row.capture));
    } catch {
      return resolveCapture(null);
    }
  });
};
```

- [ ] **Step 5: Every caller passes the block**

(a) `app/(auth)/configure.tsx` lines 1539–1546 become:

```tsx
        const categoriesData = parseObservationCategories(obsRes);
        const plantSections = parseAllowedPlantSections(obsRes);
        if (categoriesData.length > 0) {
          await setCachedObservations(
            categoriesData,
            selectedCrop || null,
            plantSections,
            parseCaptureSettings(obsRes),
          );
        }
```

and add `import { parseCaptureSettings } from "../../src/services/scoutCapture";` next to the `use-configure-utils` import (line ~95).

(b) `app/(tabs)/profile/index.tsx` line 954 becomes `await setCachedObservations(categoriesData, priorCrop, plantSections, parseCaptureSettings(obsRes));`. Add `import { parseCaptureSettings } from "../../../src/services/scoutCapture";`.

(c) `app/(tabs)/profile/cached-data.tsx`: in both refresh blocks (lines 605–609 and 662–666) add a fourth argument `parseCaptureSettings(obsRes),` after `cachedPlantSections,`. Add `import { parseCaptureSettings } from "../../../src/services/scoutCapture";`.

(d) `app/(tabs)/index.tsx`:

- Add `getCachedCaptureSettings,` to the `scoutingCacheDb` import (lines 63–75), and below the `use-configure-utils` import (line 81) add:

```tsx
import {
  LEGACY_CAPTURE,
  exceedsMaxCount,
  maxCountMessage,
  parseCaptureSettings,
  resolveCapture,
  type CaptureSettings,
} from "../../src/services/scoutCapture";
```

- In `FieldInput`'s destructured props (line 145, after `isHighlighted,`) add `maxCount,`. Replace the cap (lines 307–314) with:

```tsx
              if (exceedsMaxCount(num, maxCount)) {
                showDialog({
                  title: "Limit exceeded",
                  body: maxCountMessage(maxCount),
                  tone: "warning",
                });
                return;
              }
```

- After the `allowedPlantSections` state (line 368) add:

```tsx
  // What the server lets a scout capture (photos, comments, the count cap),
  // cached with the observations. Legacy until the cache answers: no photo
  // buttons and the old cap of 15.
  const [capture, setCapture] = useState<CaptureSettings>(LEGACY_CAPTURE);
```

- In `loadData`: after `setAllowedPlantSections(cachedPlantSections);` in the cached branch (line 1120) add `setCapture(await getCachedCaptureSettings());`. In the background refresh (lines 1133–1139), the block becomes:

```tsx
              const cats = parseObservationCategories(res);
              const ps = parseAllowedPlantSections(res);
              const cap = parseCaptureSettings(res);
              if (cats.length > 0) {
                setCategories(cats);
                setAllowedPlantSections(ps);
                setCapture(resolveCapture(cap));
                await setCachedObservations(cats, cropValue || null, ps, cap);
              }
```

  In the fallback branch, after `setAllowedPlantSections(cachedPlantSections);` (line 1157) add `setCapture(await getCachedCaptureSettings());`. The online refresh there (lines 1168–1178) becomes:

```tsx
            const categoriesData = parseObservationCategories(res);
            const plantSections = parseAllowedPlantSections(res);
            const captureData = parseCaptureSettings(res);
            if (categoriesData.length > 0) {
              setCategories(categoriesData);
              setAllowedPlantSections(plantSections);
              setCapture(resolveCapture(captureData));
              await setCachedObservations(
                categoriesData,
                cropValue || null,
                plantSections,
                captureData,
              );
            }
```

- Both `<FieldInput …>` in `renderCategoryContentForPart` (lines 1701, 1734) gain `maxCount={capture.maxCount}`, and its dependency list (lines 1767–1774) gains `capture.maxCount`.

(e) `app/(tabs)/traps/index.tsx`:

- Add `getCachedCaptureSettings,` to the existing `scoutingCacheDb` import (lines 36–42), and add `import { DEFAULT_MAX_COUNT, trapMaxCountMessage } from "../../../src/services/scoutCapture";`.
- After the `camPermission` line (160) add:

```tsx
  // Pieces 5–6: the GM's count cap, cached with the observations. 15 until the
  // cache answers (and on a handset that never talked to a new server).
  const [maxCount, setMaxCount] = useState(DEFAULT_MAX_COUNT);
```

- In the `useFocusEffect` callback (line 413, after `loadPestsFromDb();`) add:

```tsx
      getCachedCaptureSettings()
        .then((c) => setMaxCount(c.maxCount))
        .catch(() => setMaxCount(DEFAULT_MAX_COUNT));
```

- The FCM cap (lines 694–700) becomes `if (count > maxCount) { showDialog({ title: "Limit exceeded", body: trapMaxCountMessage(maxCount), tone: "warning" }); return; }`. The per-pest cap (lines 760–766) becomes `if (parsed > maxCount) { showDialog({ title: "Limit exceeded", body: trapMaxCountMessage(maxCount, pestName), tone: "warning" }); return; }`.
- Confirm no literal `15` cap is left: `grep -n "> 15\|is 15" app/\(tabs\)/index.tsx app/\(tabs\)/traps/index.tsx` → no output.

- [ ] **Step 6: Run to pass, the suite and the typecheck**

Run: `cd /home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn && npx jest src/services/__tests__/scoutCapture.test.ts src/services/__tests__/scoutingCacheCapture.test.ts && npx jest` and then **RN-TSC**.
Expected: the new suites pass. The whole suite is green (53 suites). RN-TSC prints nothing.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/stive/code/reactnative/Upande-Scout && git status --short
git add upande_scout_rn/src/services/scoutCapture.ts upande_scout_rn/src/services/scoutingCacheDb.ts upande_scout_rn/src/services/__tests__/scoutCapture.test.ts upande_scout_rn/src/services/__tests__/scoutingCacheCapture.test.ts "upande_scout_rn/app/(tabs)/index.tsx" "upande_scout_rn/app/(tabs)/traps/index.tsx" "upande_scout_rn/app/(auth)/configure.tsx" "upande_scout_rn/app/(tabs)/profile/index.tsx" "upande_scout_rn/app/(tabs)/profile/cached-data.tsx"
git commit -m "feat(scout): the count cap comes from the server with the observations, 15 when an old server says nothing"
```

---

### Task 7: Photos on the scouting form, through the existing pest-image queue

**Files** (all under `/home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn`):
- Create: `src/services/scoutPhotos.ts`, `components/ScoutPhotoBar.tsx`, `components/ScoutCameraModal.tsx`
- Modify: `src/services/pestImageQueue.ts` (type lines 14–26, `initPestImageDb` lines 39–60, `enqueuePestImage` lines 62–76, `mapRow` lines 78–88, `getActivePestImageCount` lines 160–167, `retryFailedPestImages` lines 183–194; add `markPestImageRefused`)
- Modify: `src/services/pestImageSync.ts` (loop lines 33–60), `src/services/api.ts` (`uploadPestImage` lines 353–378), `components/PestImageQueuePanel.tsx` (lines 36–41, 56)
- Modify: `app/(tabs)/index.tsx` (imports; state + handlers above `handleSubmit` line 1429; `handleSubmit` after `trySyncSubmissions();` line 1513; `FlatList` `ListFooterComponent` line ~2091; camera modal before `</KeyboardAvoidingView>`)
- Test: `src/services/__tests__/scoutPhotos.test.ts`, `src/services/__tests__/pestImageQueue.test.ts` (new)

**Interfaces:**
- Consumes: Task 6 `CaptureSettings`, `capture` state in `index.tsx`; Task 4's endpoint contract.
- Produces:
  - `MAX_PHOTOS_PER_ENTRY = 5`, `GENERAL_SUBJECT = "General"`, `CAPTION_MAX = 280`
  - `PhotoSubject = { key; subject; category }`, `ScoutPhoto = { photoId; localUri; subject; category; caption }`
  - `photoSubjects(observations, capture) -> PhotoSubject[]` (`[]` when photos are off; else one per observed finding, deduped by category + name, then General)
  - `canAddPhoto(photos)`, `newPhotoId(now?, rand?)`, `photoQueueArgs(clientId, photo)`, `photoUploadFields(args) -> { path, fields, fileName }`, `isRefused(res)`, `SCOUTING_PHOTO_PATH`, `LEGACY_PHOTO_PATH`
  - Queue rows gain `disease`, `subject`, `caption`, `photoId`, and status `"refused"`; `markPestImageRefused(row, reason)`.

- [ ] **Step 1: Write the failing tests**

Create `src/services/__tests__/scoutPhotos.test.ts`:

```ts
/**
 * Piece 5: a scout may photograph each finding they recorded, or the entry in
 * general — at most five photos per entry, each with its own caption — and the
 * photos ride the existing pest-image queue to `attach_scouting_photo`.
 */
import {
  CAPTION_MAX,
  GENERAL_SUBJECT,
  LEGACY_PHOTO_PATH,
  MAX_PHOTOS_PER_ENTRY,
  SCOUTING_PHOTO_PATH,
  canAddPhoto,
  isRefused,
  newPhotoId,
  photoQueueArgs,
  photoSubjects,
  photoUploadFields,
  type ScoutPhoto,
} from "../scoutPhotos";

const on = { photos: true };
const obs = (category: string, fieldName: string, data: any, plantPart = "buds") => ({
  [`${plantPart}_${category}_${fieldName}`]: { category, fieldName, plantPart, data },
});

describe("photoSubjects", () => {
  it("no subjects at all when photos are off", () => {
    expect(photoSubjects(obs("Pests", "Thrips-Adult", { count: 3 }), { photos: false })).toEqual([]);
  });

  it("only General when nothing has been recorded", () => {
    expect(photoSubjects({}, on)).toEqual([{ key: "General|General", subject: GENERAL_SUBJECT, category: "General" }]);
  });

  it("one per observed finding, by name not stage, then General", () => {
    const observations = {
      ...obs("Pests", "Thrips-Adult", { count: 3 }),
      ...obs("Pests", "Thrips-Larva", { count: 1 }, "top"),
      ...obs("Diseases", "Downy Mildew-Fresh", { value: 2 }),
      ...obs("Weeds", "Couch-grass", { is_present: true }),
      ...obs("Pests", "Aphids-Adult", { count: 0 }),
      ...obs("Comments", "comment", { value: "busy bed" }),
    };
    expect(photoSubjects(observations, on).map((s) => [s.category, s.subject])).toEqual([
      ["Pests", "Thrips"],
      ["Diseases", "Downy Mildew"],
      ["Weeds", "Couch-grass"],
      ["General", "General"],
    ]);
  });
});

describe("the limit", () => {
  const photo = (i: number): ScoutPhoto => ({ photoId: `p${i}`, localUri: `file:///p${i}.jpg`, subject: "General", category: "General", caption: "" });
  it("takes five photos and no more", () => {
    expect(MAX_PHOTOS_PER_ENTRY).toBe(5);
    expect(canAddPhoto([0, 1, 2, 3].map(photo))).toBe(true);
    expect(canAddPhoto([0, 1, 2, 3, 4].map(photo))).toBe(false);
  });
  it("gives every photo its own id", () => {
    expect(newPhotoId(1_700_000_000_000, () => 0.5)).not.toEqual(newPhotoId(1_700_000_000_000, () => 0.25));
  });
});

describe("photoQueueArgs", () => {
  it("names the pest or the disease, and always the subject and caption", () => {
    const base = { photoId: "p1", localUri: "file:///p1.jpg", caption: "  webbing  " };
    expect(photoQueueArgs("cid", { ...base, subject: "Thrips", category: "Pests" })).toEqual({
      clientId: "cid", pest: "Thrips", disease: "", subject: "Thrips", caption: "webbing",
      photoId: "p1", trap: "", localUri: "file:///p1.jpg",
    });
    expect(photoQueueArgs("cid", { ...base, subject: "Downy Mildew", category: "Diseases" })).toMatchObject({ pest: "", disease: "Downy Mildew" });
    expect(photoQueueArgs("cid", { ...base, subject: "General", category: "General" })).toMatchObject({ pest: "", disease: "", subject: "General" });
    expect(photoQueueArgs("cid", { ...base, caption: "x".repeat(400), subject: "General", category: "General" }).caption).toHaveLength(CAPTION_MAX);
  });
});

describe("photoUploadFields", () => {
  it("a scouting photo goes to attach_scouting_photo with every field", () => {
    const got = photoUploadFields({ localUri: "u", clientId: "cid", pest: "Thrips", subject: "Thrips", caption: "webbing", photoId: "p1" });
    expect(got.path).toBe(SCOUTING_PHOTO_PATH);
    expect(got.fields).toEqual([["client_id", "cid"], ["pest", "Thrips"], ["subject", "Thrips"], ["caption", "webbing"], ["photo_id", "p1"]]);
    expect(got.fileName).toBe("Thrips-p1.jpg");
  });

  it("a trap photo keeps the old endpoint and fields", () => {
    const got = photoUploadFields({ localUri: "u", clientId: "a@b|2026-10-10|08:00:00", pest: "Unidentified pest", trap: "Trap 3" });
    expect(got.path).toBe(LEGACY_PHOTO_PATH);
    expect(got.fields).toEqual([["client_id", "a@b|2026-10-10|08:00:00"], ["pest", "Unidentified pest"], ["trap", "Trap 3"]]);
    expect(got.fileName).toBe("Unidentified_pest-a@b|2026-10-10|08:00:00.jpg");
  });
});

describe("isRefused only reads the server's status", () => {
  it("is the server's answer, never an HTTP error", () => {
    expect(isRefused({ status: "refused" })).toBe(true);
    expect(isRefused({ status: "ok" })).toBe(false);
    expect(isRefused({ status: "pending" })).toBe(false);
    expect(isRefused(undefined)).toBe(false);
  });
});
```

Create `src/services/__tests__/pestImageQueue.test.ts`:

```ts
/**
 * The queue carries what a scouting photo is of and the scout's caption, and a
 * photo the server refused leaves the queue instead of burning retries.
 */
const mockExec = jest.fn(async (_sql: string) => undefined);
const mockRun = jest.fn(async (_sql: string, _params: any[]) => ({ changes: 1 }));
const mockDb = {
  execAsync: mockExec,
  runAsync: mockRun,
  getAllAsync: jest.fn(async (sql: string) =>
    sql.startsWith("PRAGMA table_info")
      ? ["id", "client_id", "pest", "trap", "local_uri", "status", "retry_count", "last_error", "created_at"].map((name) => ({ name }))
      : [],
  ),
  getFirstAsync: jest.fn(async () => ({ count: 0 })),
};
const mockDelete = jest.fn(async (..._args: any[]) => undefined);

jest.mock("expo-sqlite", () => ({ openDatabaseAsync: jest.fn(async () => mockDb) }));
jest.mock("expo-file-system/legacy", () => ({ deleteAsync: (...a: any[]) => mockDelete(...a) }));

import {
  enqueuePestImage,
  getActivePestImageCount,
  markPestImageRefused,
  retryFailedPestImages,
  type PestImageRow,
} from "../pestImageQueue";

const lastRun = () => mockRun.mock.calls[mockRun.mock.calls.length - 1];

describe("the pest-image queue carries scouting photos", () => {
  it("adds the four photo columns to an existing queue", async () => {
    await getActivePestImageCount();
    const ddl = mockExec.mock.calls.map((c) => String(c[0]));
    for (const col of ["disease", "subject", "caption", "photo_id"]) {
      expect(ddl).toContain(`ALTER TABLE pest_images ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  });

  it("queue item carries subject and caption", async () => {
    await enqueuePestImage({ clientId: "cid", pest: "", disease: "", subject: "General", caption: "broken vent", photoId: "p1", localUri: "file:///p1.jpg" });
    const [sql, params] = lastRun();
    expect(sql).toContain("subject, caption, photo_id");
    expect(params).toEqual(expect.arrayContaining(["cid", "General", "broken vent", "p1", "file:///p1.jpg"]));
  });

  it("a trap photo still enqueues with blanks for the new fields", async () => {
    await enqueuePestImage({ clientId: "cid", pest: "Unidentified pest", trap: "Trap 3", localUri: "file:///t.jpg" });
    const [, params] = lastRun();
    expect(params.slice(-4)).toEqual(["", "", "", ""]);
  });
});

describe("refused rows leave the queue and the badge", () => {
  const row = { id: 7, localUri: "file:///p1.jpg" } as PestImageRow;

  it("marks the row refused and deletes its file", async () => {
    await markPestImageRefused(row, "Photos are switched off on the server");
    const [sql, params] = lastRun();
    expect(sql).toContain("status = 'refused'");
    expect(params).toEqual(["Photos are switched off on the server", 7]);
    expect(mockDelete).toHaveBeenCalledWith("file:///p1.jpg", { idempotent: true });
  });

  it("the badge and the retry button ignore refused rows", async () => {
    await getActivePestImageCount();
    const countSql = String((mockDb.getFirstAsync.mock.calls as any[]).slice(-1)[0][0]);
    expect(countSql).toContain("NOT IN ('done','refused')");
    await retryFailedPestImages();
    expect(String(lastRun()[0])).toContain("status != 'refused'");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd /home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn && npx jest src/services/__tests__/scoutPhotos.test.ts src/services/__tests__/pestImageQueue.test.ts`
Expected: FAIL. `Cannot find module '../scoutPhotos'`, and in the queue suite `markPestImageRefused is not a function` / missing ALTER statements.

- [ ] **Step 3: The pure photo rules**

Create `src/services/scoutPhotos.ts`:

```ts
/**
 * Scouting-form photos (scout capture settings, P5).
 *
 * When the server allows photos, the form offers one camera button per finding
 * the scout has recorded on this entry (by pest / disease / finding name, not
 * per stage) and one "General" button; at most five photos per entry, each
 * with its own caption. They ride the existing pest-image queue under the
 * entry's client_id to `attach_scouting_photo`, which pins each one to its
 * Scouting Entry. Trap "unidentified" photos are untouched: no subject, the
 * old endpoint name, the old fields.
 */
import type { CaptureSettings } from "./scoutCapture";

export const MAX_PHOTOS_PER_ENTRY = 5;
export const GENERAL_SUBJECT = "General";
export const CAPTION_MAX = 280;

export const SCOUTING_PHOTO_PATH =
  "/api/method/upande_scp.serverscripts.mobile.pest_image.attach_scouting_photo";
export const LEGACY_PHOTO_PATH =
  "/api/method/upande_scp.serverscripts.mobile.pest_image.attach_unidentified_pest_image";

export type PhotoSubject = { key: string; subject: string; category: string };

export type ScoutPhoto = {
  photoId: string;
  localUri: string;
  subject: string;
  category: string;
  caption: string;
};

export type PhotoUploadArgs = {
  localUri: string;
  clientId: string;
  pest: string;
  trap?: string;
  disease?: string;
  subject?: string;
  caption?: string;
  photoId?: string;
};

/** Categories whose field id is `<name>-<stage>` (see getFieldId). */
const NAMED_BY_STAGE = new Set(["Pests", "Diseases", "Predators"]);

const hasData = (data: any): boolean => {
  if (!data || typeof data !== "object") return false;
  if (typeof data.count === "number") return data.count > 0;
  if (data.is_present === true) return true;
  return data.value !== undefined && data.value !== null && String(data.value).trim() !== "";
};

/** The camera buttons for this entry: none when photos are off. */
export const photoSubjects = (
  observations: Record<string, any>,
  capture: Pick<CaptureSettings, "photos">,
): PhotoSubject[] => {
  if (!capture.photos) return [];
  const seen = new Set<string>();
  const out: PhotoSubject[] = [];
  for (const obs of Object.values(observations || {})) {
    if (!obs || obs.category === "Comments" || !hasData(obs.data)) continue;
    const field = String(obs.fieldName || "");
    const parts = field.split("-");
    const subject = NAMED_BY_STAGE.has(obs.category) && parts.length > 1 ? parts[0] : field;
    if (!subject) continue;
    const key = `${obs.category}|${subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, subject, category: obs.category });
  }
  out.push({ key: `General|${GENERAL_SUBJECT}`, subject: GENERAL_SUBJECT, category: "General" });
  return out;
};

export const canAddPhoto = (photos: ScoutPhoto[]): boolean =>
  photos.length < MAX_PHOTOS_PER_ENTRY;

/** Unique per photo, so two photos of one subject are two photos on the server. */
export const newPhotoId = (now: number = Date.now(), rand: () => number = Math.random): string =>
  `${now.toString(36)}-${Math.floor(rand() * 1e8).toString(36)}`;

/** What `enqueuePestImage` stores for one scouting photo. */
export const photoQueueArgs = (clientId: string, photo: ScoutPhoto) => ({
  clientId,
  pest: photo.category === "Pests" ? photo.subject : "",
  disease: photo.category === "Diseases" ? photo.subject : "",
  subject: photo.subject,
  caption: photo.caption.trim().slice(0, CAPTION_MAX),
  photoId: photo.photoId,
  trap: "",
  localUri: photo.localUri,
});

/** The multipart request for one queued photo. A row with a subject is a
 *  scouting photo (new endpoint); a row without one is a trap photo and keeps
 *  exactly the old path, fields and file name. */
export const photoUploadFields = (args: PhotoUploadArgs) => {
  const fields: Array<[string, string]> = [
    ["client_id", args.clientId],
    ["pest", args.pest || ""],
  ];
  if (args.trap) fields.push(["trap", args.trap]);
  if (args.disease) fields.push(["disease", args.disease]);
  if (args.subject) fields.push(["subject", args.subject]);
  if (args.caption) fields.push(["caption", args.caption]);
  if (args.photoId) fields.push(["photo_id", args.photoId]);
  const label = (args.subject || args.pest || "photo").replace(/[^a-z0-9]+/gi, "_");
  return {
    path: args.subject ? SCOUTING_PHOTO_PATH : LEGACY_PHOTO_PATH,
    fields,
    fileName: `${label}-${args.photoId || args.clientId}.jpg`,
  };
};

/** The server switched photos off and will never take this one. Read from its
 *  answer only: an HTTP 403 is also what an expired session gets. */
export const isRefused = (res: { status?: string } | null | undefined): boolean =>
  String(res?.status || "") === "refused";
```

- [ ] **Step 4: The queue, the uploader, the panel**

(a) `src/services/pestImageQueue.ts`:

- `PestImageStatus` becomes `"pending" | "uploading" | "done" | "failed" | "refused"`. `PestImageRow` gains `disease: string; subject: string; caption: string; photoId: string;` after `trap: string;`.
- In `initPestImageDb`, after the `CREATE INDEX` (line 59) and before `initialized = true;`:

```ts
  // Scouting-form photos (P5) carry what they are of, the scout's caption and
  // a per-photo id. Added in place so a handset's queued trap photos survive.
  const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(pest_images)");
  const have = new Set(cols.map((c) => c.name));
  for (const col of ["disease", "subject", "caption", "photo_id"]) {
    if (!have.has(col)) {
      await db.execAsync(`ALTER TABLE pest_images ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }
```

- `enqueuePestImage` becomes:

```ts
export const enqueuePestImage = async (args: {
  clientId: string;
  pest: string;
  trap?: string;
  localUri: string;
  disease?: string;
  subject?: string;
  caption?: string;
  photoId?: string;
}): Promise<void> => {
  await initPestImageDb();
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO pest_images
       (client_id, pest, trap, local_uri, status, retry_count, last_error, created_at,
        disease, subject, caption, photo_id)
     VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, ?, ?, ?)`,
    [
      args.clientId,
      args.pest,
      args.trap ?? "",
      args.localUri,
      Date.now(),
      args.disease ?? "",
      args.subject ?? "",
      args.caption ?? "",
      args.photoId ?? "",
    ],
  );
};
```

- `mapRow` gains `disease: r.disease ?? "", subject: r.subject ?? "", caption: r.caption ?? "", photoId: r.photo_id ?? "",`.
- After `markPestImageDone` add:

```ts
/** The server has photos switched off and will never take this one: it leaves
 *  the queue (no retries burnt re-uploading 1600px over GPRS) and its file goes. */
export const markPestImageRefused = async (row: PestImageRow, reason: string) => {
  const db = await getDb();
  await db.runAsync(
    "UPDATE pest_images SET status = 'refused', last_error = ? WHERE id = ?",
    [reason, row.id],
  );
  try {
    await FileSystem.deleteAsync(row.localUri, { idempotent: true });
  } catch {
    /* file already gone — fine */
  }
};
```

- `getActivePestImageCount`'s query becomes `"SELECT COUNT(*) as count FROM pest_images WHERE status NOT IN ('done','refused')"`. `retryFailedPestImages`'s `WHERE` becomes `WHERE (status = 'failed' OR retry_count >= ?) AND status != 'refused'`.

(b) `src/services/api.ts`: add `import { photoUploadFields, type PhotoUploadArgs } from "./scoutPhotos";` to the imports. Replace `uploadPestImage` (lines 353–378) with:

```ts
  uploadPestImage: async (args: PhotoUploadArgs): Promise<{ status: string }> => {
    const client = await getClient();
    const { path, fields, fileName } = photoUploadFields(args);
    const form = new FormData();
    for (const [key, value] of fields) form.append(key, value);
    form.append("file", {
      uri: args.localUri,
      name: fileName,
      type: "image/jpeg",
    } as any);
    const response = await client.post(path, form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 60_000,
    });
    const body = response.data;
    const data = body?.data ?? body?.message ?? body;
    return { status: String(data?.status || "ok") };
  },
```

(c) `src/services/pestImageSync.ts`: add `markPestImageRefused` to the queue import and `import { isRefused } from "./scoutPhotos";`. In the loop, the upload call passes `disease: row.disease, subject: row.subject, caption: row.caption, photoId: row.photoId` too. The branch after it becomes:

```ts
        if (res.status === "pending") {
          // Parent entry not synced yet — retry later, don't count as failure.
          await markPestImageWaiting(row.id);
        } else if (isRefused(res)) {
          // The GM switched photos off: the server will never take it.
          await markPestImageRefused(row, "Photos are switched off on the server");
        } else {
          await markPestImageDone(row);
          console.log(
            `[PestImageSync] uploaded ${row.subject || row.pest} for ${row.clientId}`,
          );
        }
```

(d) `components/PestImageQueuePanel.tsx`: add `refused: "#6b7280", // grey — the server has photos switched off` to `STATUS_COLORS` (lines 36–41). Line 56 becomes `const showThumb = row.status !== "done" && row.status !== "refused";`.

- [ ] **Step 5: The photo bar and the camera**

Create `components/ScoutCameraModal.tsx`:

```tsx
import React, { useRef, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Button, Text } from "react-native-paper";
import { CameraView } from "expo-camera";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { showDialog } from "./AppDialog";
import { toFriendlyMessage } from "../src/services/friendlyMessage";

/**
 * Full-screen camera for a scouting-form photo (P5). Same compression as the
 * trap tab's unidentified-pest photo: longest side ~1600px, JPEG q0.7 — sharp
 * enough to identify an insect, small enough for GPRS. Hands back the local
 * file; queueing happens on submit.
 */
export default function ScoutCameraModal({
  visible,
  label,
  onCancel,
  onCaptured,
}: {
  visible: boolean;
  label: string;
  onCancel: () => void;
  onCaptured: (localUri: string) => void;
}) {
  const cameraRef = useRef<CameraView | null>(null);
  const [capturing, setCapturing] = useState(false);

  const capture = async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });
      if (!photo?.uri) return;
      const manip = await manipulateAsync(photo.uri, [{ resize: { width: 1600 } }], {
        compress: 0.7,
        format: SaveFormat.JPEG,
      });
      const dir = `${FileSystem.documentDirectory}scout-photos/`;
      try {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      } catch {
        /* dir exists */
      }
      const safe = label.replace(/[^a-z0-9]+/gi, "_");
      const dest = `${dir}${Date.now()}-${safe}.jpg`;
      await FileSystem.copyAsync({ from: manip.uri, to: dest });
      onCaptured(dest);
    } catch (e: any) {
      showDialog({ title: "Photo failed", body: toFriendlyMessage(e, "generic"), tone: "error" });
    } finally {
      setCapturing(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.screen}>
        {visible ? <CameraView ref={cameraRef} style={StyleSheet.absoluteFillObject} facing="back" /> : null}
        <View style={styles.footer}>
          <Text style={styles.label}>{label || "Photo"}</Text>
          <View style={styles.row}>
            <Button mode="outlined" onPress={onCancel} textColor="#fff" style={{ borderColor: "#fff" }}>
              Cancel
            </Button>
            <Button
              mode="contained"
              loading={capturing}
              disabled={capturing}
              onPress={capture}
              buttonColor="#fff"
              textColor="#000"
            >
              Capture
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  footer: { position: "absolute", bottom: 0, left: 0, right: 0, padding: 24, alignItems: "center" },
  label: { color: "#fff", fontSize: 16, fontWeight: "600", marginBottom: 12, textAlign: "center" },
  row: { flexDirection: "row", gap: 16 },
});
```

Create `components/ScoutPhotoBar.tsx`:

```tsx
import React from "react";
import { Image, StyleSheet, View } from "react-native";
import { Button, Card, IconButton, Text, TextInput } from "react-native-paper";
import {
  CAPTION_MAX,
  MAX_PHOTOS_PER_ENTRY,
  canAddPhoto,
  type PhotoSubject,
  type ScoutPhoto,
} from "../src/services/scoutPhotos";

type Colors = { Black: string; Graphite: string; DimGrey: string; White: string };

/**
 * The entry's photos (P5): one camera button per finding recorded on this
 * entry plus "General", at most five photos, each with its own caption.
 * Renders nothing when `subjects` is empty — which is what `photoSubjects`
 * returns when the server has photos off or is too old to say — so the camera
 * is never drawn and then refused. Full borders only: no side strip.
 */
export default function ScoutPhotoBar({
  subjects,
  photos,
  onAdd,
  onRemove,
  onCaption,
  colors,
}: {
  subjects: PhotoSubject[];
  photos: ScoutPhoto[];
  onAdd: (subject: PhotoSubject) => void;
  onRemove: (photoId: string) => void;
  onCaption: (photoId: string, caption: string) => void;
  colors: Colors;
}) {
  if (subjects.length === 0) return null;
  const full = !canAddPhoto(photos);
  return (
    <Card mode="outlined" style={[styles.card, { backgroundColor: colors.White, borderColor: colors.DimGrey }]}>
      <Card.Content>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.Black }]}>Photos</Text>
          <Text style={{ color: colors.DimGrey }}>{`${photos.length}/${MAX_PHOTOS_PER_ENTRY}`}</Text>
        </View>
        <View style={styles.buttons}>
          {subjects.map((s) => (
            <Button
              key={s.key}
              mode="outlined"
              icon="camera"
              compact
              disabled={full}
              onPress={() => onAdd(s)}
              textColor={colors.Graphite}
              style={[styles.button, { borderColor: colors.DimGrey }]}
            >
              {s.subject}
            </Button>
          ))}
        </View>
        {full ? (
          <Text style={[styles.hint, { color: colors.DimGrey }]}>
            {`${MAX_PHOTOS_PER_ENTRY} photos is the most one entry can carry.`}
          </Text>
        ) : null}
        {photos.map((p) => (
          <View key={p.photoId} style={styles.photoRow}>
            <Image source={{ uri: p.localUri }} style={styles.thumb} />
            <View style={styles.photoText}>
              <Text style={{ color: colors.Graphite, fontWeight: "600" }}>{p.subject}</Text>
              <TextInput
                mode="outlined"
                dense
                placeholder="Caption (optional)"
                value={p.caption}
                maxLength={CAPTION_MAX}
                onChangeText={(t) => onCaption(p.photoId, t)}
                outlineColor={colors.DimGrey}
                activeOutlineColor={colors.Black}
                textColor={colors.Graphite}
                style={{ backgroundColor: colors.White }}
              />
            </View>
            <IconButton
              icon="close"
              accessibilityLabel={`Remove ${p.subject} photo`}
              onPress={() => onRemove(p.photoId)}
              iconColor={colors.DimGrey}
            />
          </View>
        ))}
      </Card.Content>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 80 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title: { fontSize: 16, fontWeight: "600" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { borderWidth: 1 },
  hint: { marginTop: 8, fontSize: 12 },
  photoRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  thumb: { width: 56, height: 56, borderRadius: 6 },
  photoText: { flex: 1, gap: 4 },
});
```

- [ ] **Step 6: Wire the scouting screen**

In `app/(tabs)/index.tsx`:

(a) Imports (after the Task 6 `scoutCapture` import):

```tsx
import { useCameraPermissions } from "expo-camera";
import { enqueuePestImage } from "../../src/services/pestImageQueue";
import { trySyncPestImages } from "../../src/services/pestImageSync";
import {
  canAddPhoto,
  newPhotoId,
  photoQueueArgs,
  photoSubjects,
  type PhotoSubject,
  type ScoutPhoto,
} from "../../src/services/scoutPhotos";
import ScoutPhotoBar from "../../components/ScoutPhotoBar";
import ScoutCameraModal from "../../components/ScoutCameraModal";
```

(b) Immediately above `  const handleSubmit = async () => {` (line 1429) insert:

```tsx
  // Scouting-form photos (P5). Held per bed in memory, like the observations
  // the scout is building; queued on submit under the entry's client_id.
  const [photosByBed, setPhotosByBed] = useState<Record<string, ScoutPhoto[]>>({});
  const [cameraSubject, setCameraSubject] = useState<PhotoSubject | null>(null);
  const [camPermission, requestCamPermission] = useCameraPermissions();
  const entryPhotos = useMemo(() => photosByBed[bed] ?? [], [photosByBed, bed]);
  const subjectsForPhotos = useMemo(
    () => photoSubjects(observations, capture),
    [observations, capture],
  );

  const openPhoto = useCallback(
    async (subject: PhotoSubject) => {
      if (!bed) {
        showDialog({ title: "Photo", body: `Select a ${unitLabel.toLowerCase()} first`, tone: "warning" });
        return;
      }
      if (!canAddPhoto(entryPhotos)) return;
      if (!camPermission?.granted) {
        const res = await requestCamPermission();
        if (!res.granted) {
          showDialog({ title: "Camera permission", body: "Camera access is needed to take a photo.", tone: "warning" });
          return;
        }
      }
      setCameraSubject(subject);
    },
    [bed, entryPhotos, camPermission, requestCamPermission, unitLabel],
  );

  const onPhotoCaptured = useCallback(
    (localUri: string) => {
      const subject = cameraSubject;
      setCameraSubject(null);
      if (!subject || !bed) return;
      setPhotosByBed((prev) => {
        const list = prev[bed] ?? [];
        if (!canAddPhoto(list)) return prev;
        const photo: ScoutPhoto = {
          photoId: newPhotoId(),
          localUri,
          subject: subject.subject,
          category: subject.category,
          caption: "",
        };
        return { ...prev, [bed]: [...list, photo] };
      });
    },
    [cameraSubject, bed],
  );

  const removePhoto = useCallback(
    (photoId: string) =>
      setPhotosByBed((prev) => ({
        ...prev,
        [bed]: (prev[bed] ?? []).filter((p) => p.photoId !== photoId),
      })),
    [bed],
  );

  const captionPhoto = useCallback(
    (photoId: string, caption: string) =>
      setPhotosByBed((prev) => ({
        ...prev,
        [bed]: (prev[bed] ?? []).map((p) => (p.photoId === photoId ? { ...p, caption } : p)),
      })),
    [bed],
  );

```

(c) In `handleSubmit`, right after `trySyncSubmissions();` (line 1513) insert:

```tsx
      // The entry's photos ride the pest-image queue under the entry's own
      // client_id, so the server pins each to this Scouting Entry once it
      // lands (or refuses it, if the GM switched photos off meanwhile). A
      // failure here must not fail a submit that is already queued.
      const photos = photosByBed[bed] ?? [];
      try {
        for (const photo of photos) {
          await enqueuePestImage(photoQueueArgs(clientId, photo));
        }
        if (photos.length > 0) void trySyncPestImages();
      } catch (photoErr) {
        console.warn("[Scouting] photo enqueue failed", photoErr);
      }
      setPhotosByBed((prev) => {
        if (!(bed in prev)) return prev;
        const next = { ...prev };
        delete next[bed];
        return next;
      });
```

(d) On the `FlatList` (line 2045), add after `contentContainerStyle={styles.content}`:

```tsx
          ListFooterComponent={
            <ScoutPhotoBar
              subjects={subjectsForPhotos}
              photos={entryPhotos}
              onAdd={openPhoto}
              onRemove={removePhoto}
              onCaption={captionPhoto}
              colors={COLORS}
            />
          }
```

(e) Immediately before `      </KeyboardAvoidingView>` (line ~2107) insert:

```tsx
        <ScoutCameraModal
          visible={cameraSubject !== null}
          label={cameraSubject?.subject ?? ""}
          onCancel={() => setCameraSubject(null)}
          onCaptured={onPhotoCaptured}
        />
```

- [ ] **Step 7: Run to pass, the suite and the typecheck**

Run: `cd /home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn && npx jest src/services/__tests__/scoutPhotos.test.ts src/services/__tests__/pestImageQueue.test.ts && npx jest` and then **RN-TSC**.
Expected: the new suites pass. The whole suite is green (55 suites). RN-TSC prints nothing. If RN-TSC flags another reader of `PestImageStatus` or `PestImageRow` that builds a literal, add the new fields or status there, and only there.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/stive/code/reactnative/Upande-Scout && git status --short
git add upande_scout_rn/src/services/scoutPhotos.ts upande_scout_rn/src/services/pestImageQueue.ts upande_scout_rn/src/services/pestImageSync.ts upande_scout_rn/src/services/api.ts upande_scout_rn/components/PestImageQueuePanel.tsx upande_scout_rn/components/ScoutPhotoBar.tsx upande_scout_rn/components/ScoutCameraModal.tsx "upande_scout_rn/app/(tabs)/index.tsx" upande_scout_rn/src/services/__tests__/scoutPhotos.test.ts upande_scout_rn/src/services/__tests__/pestImageQueue.test.ts
git commit -m "feat(scout): a scout may photograph each finding or the entry, with a caption, when the general manager allows it"
```

---

### Task 8: Final regression and an in-process check on the real data

**Files:** none changed (unless a check fails — then fix in the owning task's files and re-run that task's tests).

- [ ] **Step 1: Server suites, one module per DB-RUN**

New: `test_scout_capture`.
Regression: `test_postponement`, `test_crop_settings`, `test_crop_protection`, `test_spray_compliance_schema`, `test_loaning_v2`, `test_procurement`, `test_manager_permissions`, `test_crop_scoped_observations`.
Expected: every module OK, or matching the Task 1 Step 0 baseline. Then confirm nothing leaked: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SET SQL_BIG_SELECTS=1; SELECT COUNT(*) FROM \`tabScouting Entry\` WHERE name LIKE '\_TEST-SE-CAP%' OR date_of_capture = '2031-05-12'; SELECT COUNT(*) FROM \`tabScouting Entry Metadata\` WHERE client_id LIKE '\_test-scp-capture%'; SELECT COUNT(*) FROM tabFile WHERE name LIKE '\_TEST-FILE-CAP%'; SELECT COUNT(*) FROM \`tabScouting Entry Photo\`; SELECT COUNT(*) FROM \`tabComments Scouting Entry\`; SELECT field, value FROM tabSingles WHERE doctype = 'Scouting and Crop Protection Settings' AND field IN ('allow_scout_photos', 'allow_scout_comments', 'max_count_per_observation');"`. Expect `0`, `0`, `0`, `0`, `0`, and the three rows `1`, `1`, `15`.

- [ ] **Step 2: Frontend**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run && npx tsc --noEmit -p tsconfig.app.json && yarn build`
Expected: the whole vitest suite passes, no type errors, the build succeeds. The built assets are served at once. The web workers keep the old Python until **the user** restarts them, so against old workers the bundle carries no capture fields and the card shows undefined values: the checkboxes read "on" (`!== 0`) and the max count blank with its error. Never restart anything yourself.

- [ ] **Step 3: RN**

Run: `cd /home/ubuntu/stive/code/reactnative/Upande-Scout/upande_scout_rn && npx jest` and **RN-TSC**.
Expected: 55 suites green; RN-TSC prints nothing.

- [ ] **Step 4: In-process check on the real data, rolled back**

```bash
cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "
import time, frappe
from unittest.mock import patch
frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator')
from upande_scp.serverscripts.mobile import get_observations_details as GOD
from upande_scp.serverscripts.spray_plan_creator import settings as S
from upande_scp.serverscripts.scouting import capture_settings as CS
try:
    with patch.object(frappe.db, 'commit'), patch.object(frappe, 'sendmail') as mail:
        for crop in ('Rose', 'Avocado', None):
            frappe.local.response = frappe._dict()
            t = time.time(); got = GOD.getObservationsDetails(crop); dt = time.time() - t
            print(crop, '%.2fs' % dt, got['capture'], [c['category'] for c in got['data']][-2:])
        b = S.get_settings_bundle()['spray_plan']
        print('bundle', {k: b[k] for k in CS.FIELDS})
        S.save_spray_plan_settings('{\"allow_scout_comments\": 0, \"max_count_per_observation\": 25}')
        frappe.local.response = frappe._dict()
        got = GOD.getObservationsDetails('Rose')
        print('after save', got['capture'], 'Comments' in [c['category'] for c in got['data']])
        assert not mail.called
finally:
    frappe.db.rollback()
print('rolled back', CS.as_payload())
"
```

Expected: each crop answers well under a second, with `{'photos': True, 'comments': True, 'max_count': 15}` and `Comments` as the last category. `bundle {'allow_scout_photos': 1, 'allow_scout_comments': 1, 'max_count_per_observation': 15}`. `after save {'photos': True, 'comments': False, 'max_count': 25} False`. `rolled back {'photos': True, 'comments': True, 'max_count': 15}`.

- [ ] **Step 5: Hand-off notes**

Report to the user, with the Step 4 numbers:
- The backend (capture block, Comments category, `attach_scouting_photo`) goes live only after the **user** restarts the web and worker processes. Nothing was restarted here. Until then, live handsets see no `capture` block: cap 15, no photo buttons, which is the designed old-server fallback.
- The handset changes are committed on `kaitet-frappe16` but **not released**. No version bump, changelog or EAS build was made. That is the user's call.
- Comments now appear in the app as soon as the backend is live (the switch defaults on). Before, kaitet dropped every comment the app sent.
- P8 unchanged: one unidentified photo still emails all **39** enabled SCP General Managers on kaitet.local.
- List any gate module that already failed at HEAD (Task 1 Step 0).

- [ ] **Step 6: Confirm the trees are clean of this work**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && git status --short && git log --oneline adbe4cb..HEAD` and `git -C /home/ubuntu/stive/code/reactnative/Upande-Scout status --short && git -C /home/ubuntu/stive/code/reactnative/Upande-Scout log --oneline 83b4c05..HEAD`.
Expected: upande_scp has only the unrelated store/batch-transfer files left modified/untracked, plus five commits (Tasks 1–5). The RN repo is clean, plus two commits (Tasks 6–7). No commit in either repo carries a `Co-Authored-By` trailer: `git log --format=%B adbe4cb..HEAD | grep -c Co-Authored-By` → `0`, and the same for the RN range.

---

## Ambiguities resolved

1. **Two photos of one subject.** Mona's deterministic file name (`client_id|subject`) would merge them. The handset now sends a per-photo `photo_id` that joins the hash. Without one (old handsets) the name hashes exactly as Mona's did, so their retries still dedupe.
2. **"Server refuses uploads" is a `{"status": "refused"}` answer, not a `PermissionError`.** A 403 is also what an expired session gets, so the handset could not tell the two apart. A refused row leaves the queue with no retries, and its file is deleted.
3. **Unidentified photos are always accepted, even with photos off.** They are the trap tab's demanded alarm, and P5 says trap photos keep working unchanged. The switch governs documentation photos.
4. **No `capture` block (an old server).** The handset caps at 15 and shows **no** photo buttons, because the old endpoint emails every GM for every photo. Comments need no handset flag: the server already omits the category.
5. **"A Photo button per observation row with data"** is rendered as one photo bar under the form. It has one button per observed finding, keyed by pest, disease or finding name rather than per stage, plus General. `FieldInput` is memoized and per stage, and per-stage buttons would repeat one pest three times.
6. **Photos are held per bed in memory** and cleared on submit. They are not persisted across an app restart (the observations are).
7. **Comments are written whenever sent**, as Mona does. An entry queued offline before the GM switched comments off still carries words the scout already wrote. The switch governs what the handset offers.
8. **Defaults survive saves.** Frappe casts a missing Check to 0 on load and a None Int to 0 on save. So `ensure_defaults` seeds the rows (schema step + `after_migrate`), the controller's `validate` fills unset fields, `save_spray_plan_settings` flags the fields it sets explicitly, and the bundle reads raw.
9. **A max count of 0 saved from the desk reads as 15**, because an Int cannot tell 0 from unset and refusing it would block every save of the Single. The settings page refuses 0, and the desk refuses values above 10000 or below 0. A useless stored value is served to the handset as 15.
10. **The 5-photo limit and the count cap are handset rules.** The server neither caps photos (a trap submission can carry one unidentified photo per trap) nor rejects counts above the cap (entries captured under an older cap must still sync).
11. **Scouting Entry is not submittable on kaitet**, so the spec's "child row on a submitted entry" becomes "the child row lands without saving the entry" (its `modified` is unchanged). Mona's direct child insert is kept.
12. **Placement.** The fields go in a new "Scout capture" section after `scouting_note` on the Scouting tab. The card goes on the Spray plan tab, before Auto-cancel (P4). Trap counts (FCM and per pest) use the same cap (P7).
