# Faster data loading, progress overlay, sidebar profile

**Status:** Approved (brainstorming)
**Date:** 2026-05-15
**Owner:** dev@upande.com

## Goal

Reduce perceived and actual scouting data load times across the SCP frontend, make
greenhouse/farm switching feel like instant filtering, replace the ambient loading
strip with a determinate progress overlay, and replace the sidebar's bare "Exit"
link with a profile component that surfaces the user's name and avatar.

## Why now

- A month of scouting entries can hit 100k–200k+ rows. The current server cache
  builds those in one shot, which is timeout-prone under load.
- The frontend chunks weekly but the server still works in months — so every weekly
  request fetches the full month from Redis and discards ~75%. That is ~4x wasted
  bandwidth per cache hit and 4x per-request overhead.
- Greenhouse/farm switches flash the loading bar even though the data is already
  in IDB, making filter changes feel like network reloads.
- The bottom pulsing strip is a faint signal — users have asked for a real
  progress indicator.
- The sidebar footer only offers "Exit", with no surface for the current user.

## Out of scope

- Switching to server-side aggregation (covered separately in
  `docs/future_server_aggregation.md`).
- Authentication/session changes.
- Any change to the IndexedDB schema beyond what's required to keep things working.

---

## Section 1 — Backend: weekly-granular cache & SQL

### Files

- `upande_scp/serverscripts/get_complete_scouting_entries.py`
- `upande_scp/serverscripts/cache_utils.py` (constants only, if needed)
- New: `upande_scp/serverscripts/scouting_prewarm.py`
- `hooks.py` (register scheduled prewarm)
- New tests under `upande_scp/serverscripts/tests/`

### Changes

1. **Cache key per ISO week** — `K_SCOUTING_PAYLOAD_PREFIX:v:YYYY-WNN` replaces
   the current monthly key. `scouting_payload_version()` still stamps the key so
   existing invalidation paths continue to work.

2. **`_fetch_month_entries` → `_fetch_week_entries(iso_year, iso_week)`.** SQL range
   is Monday→Sunday of that ISO week. Returns entries for one week. `_is_recent_month`
   becomes `_is_recent_week` checked against the same `CACHE_WINDOW_DAYS=90` cutoff.

3. **`_fetch_scouting_payload` walks ISO weeks** instead of months. Single-week
   requests = 1 Redis read + a small Python filter. Multi-week ranges stitch
   week slices.

4. **`_filter_entries` short-circuit** — when the caller's range covers an entire
   ISO week, skip the per-entry date check inside that week's payload. Greenhouse
   filter still applied.

5. **Pre-warm scheduled job** — `scouting_prewarm.daily_prewarm()` builds the
   current ISO week + previous 4. Registered under `scheduler_events.daily` in
   `hooks.py`. Idempotent.

6. **No API contract change.** `getScoutingEntriesChunk(from_date, to_date, …)`
   keeps its signature. The frontend keeps requesting weekly chunks; the server
   stops doing 4x work for each.

### Concurrency

We're not introducing Python-side threading. Frappe's gunicorn worker pool already
gives one process per request. Smaller per-request SQL work (1 week instead of 1
month) is the actual speedup.

### Tests

- `test_get_complete_scouting_entries.py`:
  - `_week_bounds` returns Monday→Sunday spans matching ISO 8601.
  - Cache key uses `YYYY-WNN` form and respects payload version.
  - First call to `_fetch_week_entries` builds + stores; second call hits cache.
  - Weeks outside the 90-day window are not cached.
  - `_filter_entries` returns identical results before/after the whole-week
    short-circuit (regression guard).
- `test_scouting_prewarm.py`:
  - `daily_prewarm()` populates N expected cache keys.
  - Safe to call twice in a row.

---

## Section 2 — Frontend: filter-from-cache UX

### Files

- `frontend/src/hooks/use-scouting.ts`
- `frontend/src/lib/scouting-sync.ts`

### Changes

1. **Export `getMissingWeeks(from, to): Promise<WeekSlot[]>`** from
   `scouting-sync.ts`. This is the existing computation inside `hydrateRange`,
   lifted to a peer function. `hydrateRange` consumes it to stay DRY.

2. **Probe before flipping `loading`.** In `useScouting`'s primary effect, call
   `getMissingWeeks(from, to)` first. If empty, skip `setLoading(true)` /
   `setProgress(*)` entirely — just call `refresh()` (IDB read + rebuild) and exit.

3. **Split into two effects:**
   - **Hydration effect** (deps: `from, to, tick`) — owns network fetches,
     `loading`, `progress`, `weeksLoaded`, `weeksTotal`.
   - **Filter/render effect** (deps: `from, to, greenhouse, greenhousesKey, crop,
     tick`) — owns IDB read + `ProcessedData` rebuild only. Never touches
     `loading` or `progress`.

   Changing greenhouse triggers only the filter effect. Sub-100ms on warm IDB.

4. **`progress` stays bound to hydration.** Filter changes leave `progress` at
   its last value (100 on a fully cached range), so the overlay reading
   `open = loading` stays hidden.

### Tradeoff

Both effects share `from` / `to` deps, so a date-range change fires both. That's
correct — a new range may need weeks not yet in IDB.

### Manual verification

- Cached range + greenhouse switch → no overlay flash, content updates instantly.
- Cached range + date range change to new month → overlay appears for the
  uncached portion only.

---

## Section 3 — Progress overlay component

### Files

- New: `frontend/src/components/LoadingOverlay.tsx`
- New: `frontend/src/components/ui/progress.tsx` (shadcn install)
- Every page that uses `useScouting` — swap `LoadingStrip` for `LoadingOverlay`.
- `frontend/src/components/LoadingStrip.tsx` — retained for code-load Suspense
  fallback only.

### Component contract

```ts
interface LoadingOverlayProps {
  open: boolean;
  progress: number;          // 0–100
  weeksLoaded?: number;
  weeksTotal?: number;
}
```

### Visual

- Backdrop: `fixed inset-0 z-50 bg-background/60 backdrop-blur-sm`,
  pointer-events captured.
- Centered card: `max-w-sm rounded-lg border bg-card p-6 shadow-lg`.
- Body: lucide `Loader2` (slow spin), title "Loading scouting data…", subtitle
  "{weeksLoaded} of {weeksTotal} weeks" when totals are present, shadcn Progress
  bar bound to `progress`, right-aligned "{progress}%".
- Fade in/out via `transition-opacity duration-200`.
- Accessibility: `role="status"`, `aria-live="polite"`, `aria-valuenow={progress}`,
  `aria-valuemin={0}`, `aria-valuemax={100}`.
- Mount-gated on `open === true` so an idle page never has a hidden overlay
  blocking pointer events.

### Wiring

1. Install `@radix-ui/react-progress`, add shadcn `progress.tsx`.
2. Extend `UseScoutingResult` with `weeksLoaded: number` and `weeksTotal: number`.
   Populate from the existing `onProgress(loaded, total, week)` callback inside
   `hydrateRange`.
3. In each consumer page, replace
   `<LoadingStrip active={loading} />`
   with
   `<LoadingOverlay open={loading} progress={progress} weeksLoaded={weeksLoaded} weeksTotal={weeksTotal} />`.
4. Pages with non-scouting busy states (Reports, Approvals) keep `LoadingStrip`
   for those — they aren't progress-bearing.
5. `App.tsx`'s `PageFallback` keeps `LoadingStrip` — code-loading is a different
   concern from data-loading and a thin strip is the right weight.

---

## Section 4 — Sidebar profile component

### Files

- `upande_scp/www/scp_app.py` (bootstrap extension)
- `frontend/src/lib/frappe.ts` (typed bootstrap accessor)
- `frontend/src/components/AppSidebar.tsx` (footer swap)
- New: `frontend/src/components/ui/avatar.tsx` (shadcn)
- New: `frontend/src/components/SidebarUser.tsx`

### Bootstrap extension

In `scp_app.py`:

```python
user_id = frappe.session.user
user_doc = frappe.db.get_value(
    "User", user_id, ["full_name", "user_image"], as_dict=True
) or {}
context.bootstrap_json = json.dumps({
    "user": user_id,
    "full_name": user_doc.get("full_name") or user_id,
    "user_image": user_doc.get("user_image") or "",
    "site_name": frappe.local.site,
})
```

One additional `frappe.db.get_value` per page render. Falls back to email if name
or image are missing.

### Frontend typing

```ts
export interface ScpBootstrap {
  user: string;
  full_name: string;
  user_image: string;
  site_name: string;
}
export function bootstrap(): ScpBootstrap { … }
```

### Avatar

Standard shadcn `avatar.tsx` (`@radix-ui/react-avatar`). Install as a peer.

### `SidebarUser` component

```
SidebarUser
  ├─ Avatar
  │   ├─ AvatarImage src={user_image}
  │   └─ AvatarFallback>{initials(full_name)}</AvatarFallback>
  ├─ Stack
  │   ├─ Name (truncated)
  │   └─ Email (subdued, truncated)
  └─ Exit icon button (LogOut, links to /app/scouting-&-crop-protection)
```

- Initials: `"Kai Tetenge" → "KT"`, `"alice@upande.com" → "A"`. Single helper
  inside `SidebarUser.tsx`.
- `user_image` may be `/files/...`, absolute URL, or empty. `AvatarImage`
  falls back automatically on load error.
- Collapsed sidebar state (`group-data-[collapsible=icon]:hidden`) hides name
  and email only. Avatar **and** Exit icon both remain visible (stacked
  vertically) so users keep a way back to the workspace from collapsed mode.
  Matches the header pattern at `AppSidebar.tsx:123-139` where the logo
  persists in collapsed view.

### Layout

```
┌────────────────────────────────────┐
│ [Avatar]  Kai Tetenge       [⏻ Exit] │
│           kai@upande.com           │
└────────────────────────────────────┘
```

In collapsed state:

```
┌────┐
│[Av]│
│ ⏻  │
└────┘
```

---

## Section 5 — Testing & verification

### Backend (automated)

- `test_get_complete_scouting_entries.py` — described under Section 1.
- `test_scouting_prewarm.py` — described under Section 1.

### Frontend (manual)

1. Cached range + greenhouse switch → no overlay flash, instant render.
2. Uncached month range → overlay appears, progress 0→100, week counter ticks.
3. Reload mid-fetch → overlay closes when fetch completes.
4. Collapse sidebar → avatar persists, name/email hide, Exit icon hides.
5. User without `user_image` → initials render in fallback.
6. Network panel: confirm 1 request per week, no monthly duplication.

### Performance check

- Before: pick a 1-month range, record bytes transferred.
- After: same range, confirm transferred bytes are ~1/4 of before.

---

## Open questions

None — all answered during brainstorming.

## Risks

- **Pre-warm job runtime.** If the daily prewarm runs against a cold Redis after
  a deploy, it has to build 5 weeks back-to-back. Tracked as a follow-up: time
  the first prewarm run in production and decide whether to stagger.
- **IDB schema continuity.** The frontend's `loaded_weeks` registry already uses
  ISO-week keys, so the cache layer change is transparent to it. No client-side
  migration needed.
