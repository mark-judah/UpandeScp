# Gallery page and trap map motion — design

2026-10-11 · branch `kaitet` · follows the pest gallery pop-up (roadmap item 8)
and fixed trap locations (2026-10-10).

## A. Gallery page (`#/<crop>/gallery`)

**GP1 — Route and nav.** New view `gallery`, labelled "Gallery", in the
Scouting group next to Heatmaps/Traps on the rose, avocado, coffee and
default-crop sidebars. Same gating as the dashboard pages (no `requireRoles`,
hidden from an exclusive Store Keeper by the section's `hideForRoles`).

**GP2 — Server: `dashboard_aggregates.photo_feed`.** The pop-up's
`observation_gallery` needs one observation name, so a sibling endpoint
(`_photo_feed.py`) serves every `Scouting Entry Photo` in scope. It reuses the
pop-up's scoping exactly: `resolve_greenhouse_scope` → `_gallery._user_scope`
(the crop-scoped greenhouses of `crop_scope.scoped_greenhouses`; a named
greenhouse/farm outside them is a `PermissionError`) → `parent_filter_conditions`
(date range + crop). Filters: `farm`, `greenhouse`, `kind` (`pest` | `disease`
| blank), `name` (the photo's `subject`), `scout` (`scouts_name`), `from_date`,
`to_date`, `page`. Paging is the pop-up's: `PHOTOS_PER_PAGE` (24) per page,
page capped at `MAX_PAGE` (50), one extra row read to set `hasMore`.

* A photo's `kind` is derived from its subject: in the crop's pest list → pest,
  disease list → disease, otherwise `other` (General / unidentified). Without a
  crop, the Pest / Plant Disease masters decide. `kind` alone filters on that
  list; an off-crop `name` returns nothing (D4, as in the pop-up).
* Each photo carries `scoutImage` (Employee.image) so tiles show the face;
  initials are only the fallback.
* Page 0 also returns `facets` — the subjects (with kind and count) and scouts
  (name, image, count) among the photos in scope and range, ignoring the
  subject/scout filters — so the pickers only offer what has photos.
* **Uncached**, like the pop-up's photo list: the table is small and a new photo
  should show at once. No aggregate payload changes, so `K_DASH_AGG_SCHEMA`
  stays `psn1`.

**GP3 — Page.** Header + filter row (farm, greenhouse from `useCropFarms`;
kind + observation and scout from the facets; from/to `DatePicker`, default
last 30 days). Masonry with CSS columns (`columns-2 sm:3 lg:4 xl:5`,
`break-inside-avoid`) — natural image heights, no dependency. Each tile: the
photo, the observation name, house, scout avatar (`PersonAvatar`: Employee
photo, initials only when none) and date. Infinite scroll with an
`IntersectionObserver` sentinel plus a visible "Load more" button (fallback and
keyboard path). Empty state reuses the pop-up's `NO_PHOTOS_TEXT`.

**GP4 — Lightbox.** Click a tile → a dialog with the large photo, prev/next
buttons and ←/→ keys (next past the last loaded photo loads the next page),
and the details: observation + kind, caption, scout (avatar + name), house,
capture time, a link to the Scouting Entry.

## B. Trap map motion

**TM1 — Pulse scaling (pure, `lib/trap-pulse.ts`).** `trapPulse(count)` →
`{ size, scale, duration, pulse }`. Log scaling with a cap so a 5,000-catch
trap does not swamp the map: `s = min(1, log10(1 + count) / log10(1 + 200))`.
Core diameter `14 + 26·s` px (14 → 40), ring peak scale `1.25 + 1.15·s`
(1.25× → 2.4×), period `2.6 − 1.0·s` s (bigger traps beat a little faster).
Count ≤ 0 → an 8 px static dot, `pulse = false`. Sizes no longer depend on the
largest trap in view, so a trap keeps its size when filters change.

**TM2 — Animation.** One ring element per counted trap animates only
`transform: scale()` and `opacity` (compositor-only), with
`--trap-pulse-scale` / `--trap-pulse-dur` custom properties and a stagger
(`animation-delay` from a hash of the trap name) so hundreds of traps never beat
in lockstep. Off-screen traps are paused (`animation-play-state: paused`,
re-evaluated on `moveend`). `prefers-reduced-motion: reduce` → no ring is
rendered at all (JS check) and a CSS media query kills any animation as a
second guard.

* Rose (`TrapsMap`, Leaflet): the divIcon carries the core + ring.
* Avocado (`AvocadoTraps` via `AvocadoTreeMap`, MapLibre): a second circle
  layer `markers-pulse` under the core layer, radius/opacity driven by a
  `["%", ["+", t, phase], 1]` expression; one `setPaintProperty` per animation
  frame (≈30 fps), GPU-drawn so only on-screen traps cost anything; stopped on
  reduced motion and while the tab is hidden. The core circle uses the same
  `trapPulse` size.

**TM3 — Click → zoom → recorder card.** Clicking a trap flies the map to it
(`flyTo`, ~0.8 s; instant `setView` under reduced motion), then shows a card
over the map: the scout who recorded the **latest reading** in the window —
Employee photo (`PersonAvatar`), name — the reading's date + time of capture,
the count and pest, plus the trap's summary (house, cumulative, placement).
The card closes on ✕ / Escape / clicking another trap.

**TM4 — Server: `traps.trap_reading.get_latest_trap_reading(trap, from_date,
to_date)`.** The client aggregates traps from scouting entries, which carry
`scouts_name` but not the Employee photo, so a small endpoint returns the latest
reading for one trap in the window: entry, scout, `scoutName`, `image`
(Employee.image), date, time, count, pest, house. Scope: the trap's greenhouse
(or farm) must be in `crop_scope.scoped_greenhouses` / `scoped_farms` for the
user, else `PermissionError`; readings are limited to entries in the user's
scope. Not cached, not an aggregate → no schema bump. The card shows the
client-side latest reading at once and fills the photo/name from the server.
