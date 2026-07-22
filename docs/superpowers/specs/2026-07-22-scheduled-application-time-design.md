# Scheduled Application Time — Design

**Date:** 2026-07-22
**Status:** Approved
**Scope:** Frontend-only (SCP React app). No backend or data migration.

## Problem

The Work Order field `custom_scheduled_application_time` is a **Datetime**, and the
entire backend chain already treats it as one:

- `drafts.py::_apply_payload` stores it verbatim (`pass_fields`) and mirrors it into
  ERPNext's `planned_start_date`, which drives the Application Floor Plan / WO
  scheduling timeline.
- Labels, Historical, and Approvals render the `HH:mm` portion.
- Floor-plan ordering coalesces and sorts by `custom_scheduled_application_time`.

But `ApplicationPlan.tsx` only offers a date-only `DatePicker` and sends
`sprayDate` as `YYYY-MM-DD`. The Datetime column reads that as `00:00:00`, so:

- Every plan lands at midnight.
- Plans on the same day have no intra-day ordering, and the floor plan cannot
  sequence by spray time.

This is a **pure frontend gap** — the server already accepts and propagates the
full timestamp with no changes.

## Goal

Let the operator pick a **time alongside the date** in the Application Plan form,
send a full `YYYY-MM-DD HH:mm:ss` datetime, so `custom_scheduled_application_time`
and (via the existing mirror) `planned_start_date` carry the real spray time.

## Decisions (from brainstorming)

- **UI:** Two **separate** pills side-by-side — the existing themed `DatePicker`
  for the date, and a new dedicated `TimePicker` for the time. (An earlier
  iteration used one combined `DateTimePicker`; superseded — see the plan doc.)
- **Time picker style:** Must match the app theme/font (same pill idiom as
  `DatePicker`, Poppins + `tabular-nums`). Uses an **odometer-roll** counter
  animation: HH and MM columns each with up/down chevrons, digits roll vertically.
- **Default time:** Fixed spray-start time **06:00**, applied to new plans.
- **Granularity:** Minutes step by **5** and carry into the hour like a real clock
  (`06:55 → 07:00`, `23:55 → 00:00`); hours wrap `23 → 00`.
- **Do NOT modify the shared `DatePicker`** — it is used in 12 date-only places
  (scouting weeks, report ranges). Reuse it as-is; add `TimePicker` alongside.

## Design

State stays a single `sprayDate` datetime string (`YYYY-MM-DD HH:mm:ss`, default
`todayAt("06:00")`). The two pills each edit one half via the pure helpers
`splitDateTime` / `mergeDateTime` (`frontend/src/lib/utils.ts`), so the payload
contract is unchanged.

### Reused: `frontend/src/components/DatePicker.tsx`

Unchanged. In `ApplicationPlan` it now edits only the date half:
`value={splitDateTime(sprayDate).date}`, and on change re-merges the current time.

### New component: `frontend/src/components/TimePicker.tsx`

- **Props:** `value: string` (`HH:mm`), `onChange`, `label?`, `className?`,
  `disabled?`.
- **Trigger:** same pill className as `DatePicker` (rounded-full, `bg-card`,
  `--sd-shadow-1/2`, muted glyph), leading lucide `Clock` icon, readout `06:30`.
- **Popover:** two odometer **DigitColumn**s (hours `00..23`, minutes `00,05..55`)
  separated by `:`, each with `ChevronUp`/`ChevronDown` stepper buttons.
- **Odometer roll:** each column renders the full ordered value strip; a fixed
  34px cell height (px, not rem — the app root is 85%) with a 3-cell window and a
  CSS `mask-image` fade top/bottom; selected value centered and emphasized,
  neighbors at `opacity-40`. Position via `translateY` with a
  `transition-transform` (cubic-bezier); a wrap step (index delta > 1, e.g.
  `23 → 00`) drops the transition for that render so it snaps instead of sliding
  the long way. `motion-reduce:transition-none` honors reduced-motion.
- **Stepping:** chevrons call `onChange(stepTime(value, field, ±1))` — the pure
  carry/wrap helper in `@/lib/utils`.

### Changes in `frontend/src/pages/ApplicationPlan.tsx`

1. **State init:** `sprayDate` defaults to `todayAt("06:00")`.
2. **Field render:** `<DatePicker>` + `<TimePicker>` inside a
   `flex flex-wrap items-center gap-2` row under one "Scheduled Application" label;
   each edits its half via `splitDateTime`/`mergeDateTime`.
3. **Payload:** unchanged — `custom_scheduled_application_time: sprayDate || null`
   carries the full datetime.
4. **Reset-after-add:** reset to `todayAt("06:00")`.

### Backend

No changes. `_apply_payload` sets the field and mirrors `planned_start_date`; the
same-day dedup query already wraps the field in `DATE(...)`, so per-day uniqueness
holds regardless of time. Existing plans stored at `00:00` continue to work and
simply sort at midnight.

## Non-goals

- No change to the shared `DatePicker` or its 12 other consumers.
- No re-dating of existing Work Orders.
- No timezone handling beyond the site's existing convention (values are naive
  local datetimes, consistent with how the field is already stored/displayed).

## Testing

- `yarn build` passes (TypeScript compile clean).
- Manual verify on the `:99` dev instance:
  - New plan defaults to `06:00`.
  - Changing the time keeps the selected day; changing the day keeps the time.
  - Created WO's `custom_scheduled_application_time` **and** `planned_start_date`
    both carry the chosen time (`bench --site kaitet.local`).
  - Historical / Labels render the chosen `HH:mm`.
  - Same-day dedup still blocks a duplicate greenhouse/day plan.
