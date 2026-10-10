# Scout capture settings — design

Date: 2026-10-10. Pieces 5 and 6 of the scouting programme: **5** port Mona's scout photo + comment capture to kaitet, toggled by the manager; **6** replace the scout app's hard-coded count limit (15) with a server setting. Both travel to the handset in the same payload, so they share one spec.

## Verified facts (2026-10-10)

- Mona (`~/stive/code/mona/apps/upande_scp`, branch `mona`; commits f5f6392, b338508, da18194): `allow_scout_photos` / `allow_scout_comments` Checks on its settings single; `scouting/capture_settings.py` (`allows`, `as_payload`, raw `tabSingles` read, missing row = allowed); child **Scouting Entry Photo** (`image`, `caption`, `subject`, `captured_on`) as `photos_scouting_entry`; child **Comments Scouting Entry** (`comment`) as `comments_scouting_entry`; `mobile/pest_image.attach_scouting_photo` (form_dict `client_id, pest, disease, trap, caption, subject, file`; deterministic short file name; idempotent; private file; child row via `row.insert(ignore_permissions=True)`; GM email only for unidentified subjects; alias `attach_unidentified_pest_image`); `getObservationsDetails` adds a `Comments` category and `capture` block; `createScoutingEntry` writes comments. Tests in `test_scouting_metadata.py`.
- Kaitet: none of that exists. `attach_unidentified_pest_image` (`mobile/pest_image.py:39`) stores a bare File on the entry, long raw file names, always emails the GM. Settings single **Scouting and Crop Protection Settings** has a placeholder `scouting_tab` + `scouting_note`. SCP Settings page edits it through `get_settings_bundle` / `save_spray_plan_settings` (`spray_plan_creator/settings.py`), toggles live in `SprayPlanTab.tsx`.
- RN (`upande_scout_rn`, branch `kaitet-frappe16`): already supports a `Comments` category (sends `comments_scouting_entry`); trap photos only (one per "unidentified" pest, camera + SQLite queue `pestImageQueue` → `uploadPestImage` → `attach_unidentified_pest_image`); `parseObservationCategories` drops unknown keys; config cached in SQLite `observations` row. Hard-coded 15 at `app/(tabs)/index.tsx:307`, `app/(tabs)/traps/index.tsx:694` and `:760`.

## Decisions

Autonomous build per the user; each is the recommended option, recorded as a ruling.

| # | Decision |
|---|---|
| P1 | Settings live on **Scouting and Crop Protection Settings → Scouting** tab: `allow_scout_photos` (Check, default 1), `allow_scout_comments` (Check, default 1), `max_count_per_observation` (Int, default 15, must be 1–10000). A missing value reads as the default (Mona's raw-singles rule), so nothing changes until the manager edits. |
| P2 | Port Mona's server code as-is with kaitet names: `capture_settings.py` (+ `max_count()`), the two child doctypes, `attach_scouting_photo` with `attach_unidentified_pest_image` kept as the alias old handsets call, GM role **SCP General Manager**, comments in `createScoutingEntry`. |
| P3 | `getObservationsDetails` returns `capture: {photos, comments, max_count}`; the `Comments` category is included only when comments are allowed. |
| P4 | Editing: a **Scouting capture** card on the SCP Settings → Spray plan tab (where the other GM toggles are), saved through `save_spray_plan_settings`; GM/admin only (existing `_require_admin`). |
| P5 | Handset photos: when photos are allowed, the scouting form gets a **Photo** button per observation row with data and one per entry ("General"); each photo carries `subject` (the pest/disease name or "General"), an optional caption; at most 5 photos per entry. Queued through the existing pest-image queue, uploaded to `attach_scouting_photo` with `subject`/`caption`/`pest`/`disease`. Trap "unidentified" photos keep working unchanged. When photos are off, the buttons are hidden and the server refuses uploads. |
| P6 | Handset comments: the Comments tab shows only when the server says comments are allowed. |
| P7 | Handset count cap: observation counts and trap counts use `capture.max_count` (cached with the observations config); fallback 15 when the server has not sent one (old server). The dialog text names the configured number. |
| P8 | Mona's General Manager email for unidentified subjects is kept (role SCP General Manager); named subjects never email. |

## Testing

- Server (DB runner, rolled back): flags default allowed when unset; payload carries `capture`; Comments category gated; `attach_scouting_photo` refuses when photos off, pending without entry, idempotent retry, child row on a submitted entry, short file name, alias works; comments written by `createScoutingEntry`; settings save validates 1–10000; GM-only save.
- Frontend (vitest): the Scouting capture card loads/saves the three values; invalid max count error.
- RN (jest where present, else typecheck): config parsing keeps `capture`; cap uses the server value and falls back to 15; photo buttons hidden when off; queue item carries subject/caption.

## Out of scope

Per-crop caps; photo review UI in SCP beyond the entry form's attachment table; the email provider fix (left alone per the user).
