# Scheduled Application Time Implementation Plan

> **REVISION (2026-07-22):** After the combined-picker build below shipped, the
> direction changed to **two separate pills** — the existing `DatePicker` plus a
> new themed **`TimePicker`** with an odometer-roll counter animation (Poppins +
> `tabular-nums`, 5-min minutes carrying into the hour). The combined
> `DateTimePicker` was removed. Tasks 1's helpers still stand and were extended
> with a pure `stepTime` helper. See `/home/ubuntu/.claude/plans/contonue-with-the-deisgn-parallel-harbor.md`
> for the delta plan. Tasks 2–3 below are historical (the combined picker).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator pick a time alongside the date in the Application Plan form, so `custom_scheduled_application_time` (and the mirrored `planned_start_date`) carry the real spray time instead of always landing at midnight.

**Architecture:** Pure frontend change. Add unit-tested datetime helpers to `src/lib/utils.ts`, build a thin `DateTimePicker` component that composes the existing `Calendar` + a native time input, and swap it into `ApplicationPlan.tsx`. The shared `DatePicker` and its 12 date-only consumers are untouched. Backend already stores the field as `Datetime` and mirrors it to `planned_start_date` — no server changes.

**Tech Stack:** React + TypeScript, Vite, Vitest, shadcn/ui (Radix Popover + react-day-picker Calendar), Tailwind.

## Global Constraints

- Do NOT modify the shared `DatePicker` component or its consumers.
- Do NOT add a `Co-Authored-By` trailer to commits (repo rule).
- Only commit when the executor is explicitly running this plan's commit steps; do not push.
- Datetime string format on the wire: `YYYY-MM-DD HH:mm:00` (seconds always `00`, naive local time — matches existing storage/display convention).
- Default spray-start time: `06:00`. Time input granularity: 5-minute steps (`step="300"`), any minute typeable.
- No backend edits, no data migration, no timezone conversion.

---

### Task 1: Datetime merge/split helpers (unit-tested)

**Files:**
- Modify: `frontend/src/lib/utils.ts` (append new exports after `parseYmd`, ~line 39)
- Test: `frontend/src/lib/datetime.test.ts` (create)

**Interfaces:**
- Consumes: existing `ymd(date: Date): string` from the same module.
- Produces:
  - `splitDateTime(value: string): { date: string; time: string }` — splits a `"YYYY-MM-DD HH:mm:ss"` (or bare `"YYYY-MM-DD"`) string into a `date` (`YYYY-MM-DD`, `""` if absent) and a `time` (`HH:mm`, defaults to `"06:00"` when the time part is missing/blank).
  - `mergeDateTime(date: string, time: string): string` — returns `"YYYY-MM-DD HH:mm:00"`; if `date` is empty returns `""`; if `time` is empty uses `"06:00"`.
  - `todayAt(time: string): string` — returns today's date (via `ymd(new Date())`) merged with `time`, e.g. `"2026-07-22 06:00:00"`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/datetime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeDateTime, splitDateTime } from "./utils";

describe("splitDateTime", () => {
  it("splits a full datetime into date and HH:mm", () => {
    expect(splitDateTime("2026-07-22 06:30:00")).toEqual({
      date: "2026-07-22",
      time: "06:30",
    });
  });

  it("defaults time to 06:00 for a date-only string", () => {
    expect(splitDateTime("2026-07-22")).toEqual({
      date: "2026-07-22",
      time: "06:00",
    });
  });

  it("returns empty date and default time for an empty value", () => {
    expect(splitDateTime("")).toEqual({ date: "", time: "06:00" });
  });
});

describe("mergeDateTime", () => {
  it("merges date and time into YYYY-MM-DD HH:mm:00", () => {
    expect(mergeDateTime("2026-07-22", "06:30")).toBe("2026-07-22 06:30:00");
  });

  it("forces seconds to 00 even if time has seconds", () => {
    expect(mergeDateTime("2026-07-22", "06:30:45")).toBe("2026-07-22 06:30:00");
  });

  it("falls back to 06:00 when time is empty", () => {
    expect(mergeDateTime("2026-07-22", "")).toBe("2026-07-22 06:00:00");
  });

  it("returns empty string when date is empty", () => {
    expect(mergeDateTime("", "06:30")).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && yarn vitest run src/lib/datetime.test.ts`
Expected: FAIL — `mergeDateTime` / `splitDateTime` are not exported from `./utils`.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/src/lib/utils.ts` (after the existing `parseYmd` function, before `currentWeekRange`):

```ts
const DEFAULT_TIME = "06:00";

/**
 * Split a scheduled-application datetime string into its date and HH:mm parts.
 * Accepts a full ``YYYY-MM-DD HH:mm:ss`` string or a bare ``YYYY-MM-DD``.
 * Missing/blank time defaults to the spray-start default (06:00).
 */
export function splitDateTime(value: string): { date: string; time: string } {
  if (!value) return { date: "", time: DEFAULT_TIME };
  const [datePart, timePart] = value.split(" ");
  const time = timePart ? timePart.slice(0, 5) : DEFAULT_TIME;
  return { date: datePart || "", time: time || DEFAULT_TIME };
}

/**
 * Merge a ``YYYY-MM-DD`` date and an ``HH:mm`` time into the wire format
 * ``YYYY-MM-DD HH:mm:00``. Seconds are always forced to ``00``. Returns an
 * empty string when no date is set; falls back to 06:00 when no time is set.
 */
export function mergeDateTime(date: string, time: string): string {
  if (!date) return "";
  const hhmm = (time || DEFAULT_TIME).slice(0, 5);
  return `${date} ${hhmm}:00`;
}

/** Today's date merged with the given ``HH:mm`` time, e.g. "2026-07-22 06:00:00". */
export function todayAt(time: string): string {
  return mergeDateTime(ymd(new Date()), time);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && yarn vitest run src/lib/datetime.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/utils.ts frontend/src/lib/datetime.test.ts
git commit -m "feat(scp-fe): add datetime merge/split helpers for scheduled application time"
```

---

### Task 2: `DateTimePicker` component

**Files:**
- Create: `frontend/src/components/DateTimePicker.tsx`
- Reference (do not modify): `frontend/src/components/DatePicker.tsx`

**Interfaces:**
- Consumes: `splitDateTime`, `mergeDateTime` from `@/lib/utils`; `parseYmd`, `ymd`, `isoWeek`, `cn` from `@/lib/utils`; `Calendar`, `Button`, `Popover*` from the same paths `DatePicker` uses.
- Produces:
  - `DateTimePicker` React component with props
    `{ value: string; onChange: (next: string) => void; label?: string; className?: string; disabled?: boolean }`.
    `value` is `YYYY-MM-DD HH:mm:ss`; `onChange` emits the same format via `mergeDateTime`.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/DateTimePicker.tsx`:

```tsx
import { useMemo, useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  cn,
  isoWeek,
  mergeDateTime,
  parseYmd,
  splitDateTime,
  ymd,
} from "@/lib/utils";

export interface DateTimePickerProps {
  value: string; // YYYY-MM-DD HH:mm:ss
  onChange: (next: string) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Combined date + time picker for the scheduled spray application. Mirrors
 * DatePicker's pill trigger and ISO-week readout, but the popover also carries
 * a native time input (5-minute steps). Picking a day keeps the current time
 * and vice-versa; emits ``YYYY-MM-DD HH:mm:00``.
 */
export function DateTimePicker({
  value,
  onChange,
  label,
  className,
  disabled,
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const { date, time } = useMemo(() => splitDateTime(value), [value]);
  const dateObj = useMemo(() => (date ? parseYmd(date) : undefined), [date]);
  const display = useMemo(() => {
    if (!dateObj) return "Pick a date & time";
    const wk = isoWeek(dateObj);
    return `${date} ${time} · W${wk}`;
  }, [dateObj, date, time]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-9 gap-2 rounded-full border-transparent bg-card px-4 text-xs font-medium tabular-nums text-foreground shadow-[var(--sd-shadow-1)] hover:bg-card hover:text-foreground hover:shadow-[var(--sd-shadow-2)] [&>svg]:text-[var(--sd-quiet)]",
            !dateObj && "text-muted-foreground",
            className,
          )}
          aria-label={label}
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          {display}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={dateObj}
          onSelect={(d) => {
            if (d) {
              onChange(mergeDateTime(ymd(d), time));
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-xs text-muted-foreground">Time</span>
          <input
            type="time"
            step={300}
            value={time}
            onChange={(e) =>
              onChange(mergeDateTime(date || ymd(new Date()), e.target.value))
            }
            className="h-8 rounded-md border bg-background px-2 text-xs tabular-nums"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd frontend && yarn tsc -b`
Expected: no errors referencing `DateTimePicker.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/DateTimePicker.tsx
git commit -m "feat(scp-fe): add DateTimePicker (calendar + time input) component"
```

---

### Task 3: Wire `DateTimePicker` into `ApplicationPlan.tsx`

**Files:**
- Modify: `frontend/src/pages/ApplicationPlan.tsx` (import ~line 22; state ~line 239; render ~line 1690-1693; reset ~line 1219; payload line 1201 unchanged)

**Interfaces:**
- Consumes: `DateTimePicker` from `@/components/DateTimePicker`; `todayAt` from `@/lib/utils`.
- Produces: no new exports.

- [ ] **Step 1: Add imports**

Add near the existing `DatePicker` import (line 22):

```tsx
import { DateTimePicker } from "@/components/DateTimePicker";
```

Ensure `todayAt` is imported from `@/lib/utils` (add it to the existing utils import in this file; if there is no utils import, add `import { todayAt } from "@/lib/utils";`).

- [ ] **Step 2: Change the state default (line 239)**

Replace:

```tsx
  const [sprayDate, setSprayDate] = useState<string>(ymd(new Date()));
```

with:

```tsx
  // Holds a full datetime string ("YYYY-MM-DD HH:mm:ss"); defaults to today 06:00.
  const [sprayDate, setSprayDate] = useState<string>(todayAt("06:00"));
```

- [ ] **Step 3: Swap the picker in the render (lines 1690-1693)**

Replace:

```tsx
              <div className="flex flex-col gap-1 col-span-2">
                <Label>Scheduled Application Date</Label>
                <DatePicker value={sprayDate} onChange={setSprayDate} />
              </div>
```

with:

```tsx
              <div className="flex flex-col gap-1 col-span-2">
                <Label>Scheduled Application</Label>
                <DateTimePicker value={sprayDate} onChange={setSprayDate} />
              </div>
```

- [ ] **Step 4: Fix the reset-after-add default (line 1219)**

Replace:

```tsx
      setSprayDate(ymd(new Date()));
```

with:

```tsx
      setSprayDate(todayAt("06:00"));
```

- [ ] **Step 5: Confirm the payload line is unchanged**

Verify line ~1201 still reads (no edit needed — it now carries the datetime):

```tsx
        custom_scheduled_application_time: sprayDate || null,
```

- [ ] **Step 6: Verify the full build**

Run: `cd frontend && yarn build`
Expected: `tsc -b` clean and `vite build` succeeds. If `ymd` is now unused in `ApplicationPlan.tsx`, remove it from the import to satisfy `noUnusedLocals` (only if the build reports it).

- [ ] **Step 7: Run the unit tests**

Run: `cd frontend && yarn vitest run`
Expected: all tests pass, including `src/lib/datetime.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/ApplicationPlan.tsx
git commit -m "feat(scp-fe): schedule spray applications by datetime, default 06:00"
```

---

## Manual Verification (after all tasks)

On the `:99` dev instance (`kaitet.local` backend):

1. Open Application Plan → the "Scheduled Application" pill shows today at `06:00` with the ISO week.
2. Change the time to `06:30`; reopen the popover — day is preserved, time is `06:30`.
3. Change the day to a future date — time stays `06:30`.
4. Add a plan to the batch; create the Work Order.
5. Verify both fields carry the time:
   ```bash
   cd /home/ubuntu/stive/code/frappe15
   bench --site kaitet.local mariadb -e "SELECT name, custom_scheduled_application_time, planned_start_date FROM \`tabWork Order\` WHERE custom_type='Application Floor Plan' ORDER BY creation DESC LIMIT 3;"
   ```
   Expected: `custom_scheduled_application_time` and `planned_start_date` both show the chosen `HH:mm`.
6. History / Labels render the chosen time (`HH:mm`).
7. Attempt a duplicate same-day/greenhouse plan — still blocked by the `DATE(...)` dedup.
