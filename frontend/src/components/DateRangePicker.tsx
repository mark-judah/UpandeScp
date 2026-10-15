import { useEffect, useMemo, useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import type { DateRange as DayRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, parseYmd, ymd } from "@/lib/utils";

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface DateRangePreset {
  label: string;
  range: () => DateRange;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (next: DateRange) => void;
  /** earliest / latest selectable day, YYYY-MM-DD */
  min?: string;
  max?: string;
  /** extra quick presets, shown after the built-in ones */
  presets?: DateRangePreset[];
  /** a range may start and end on the same day (default true) */
  allowSingleDay?: boolean;
  /** 0 = Sunday … 6 = Saturday; default 1 (Monday) */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  disabled?: boolean;
  /** accessible name of the trigger, e.g. "Scouting range" */
  label?: string;
  className?: string;
  /** `field` is a bordered box for form dialogs (as DatePicker's) */
  variant?: "pill" | "field";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

/** Parse dd/mm/yyyy, d/m/yyyy or yyyy-mm-dd into an ISO string, or null. */
export function parseTypedDate(text: string): string | null {
  const s = text.trim();
  let y: number, m: number, d: number;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (hit) {
    y = +hit[1]; m = +hit[2]; d = +hit[3];
  } else if ((hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) {
    d = +hit[1]; m = +hit[2]; y = +hit[3];
  } else {
    return null;
  }
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return ymd(date);
}

const validIso = (s: string): boolean => !!s && parseTypedDate(s) === s;

/** "1 – 15 Oct 2026", "28 Sep – 3 Oct 2026", "15 Oct 2026". */
export function formatRange(r: DateRange): string {
  if (!validIso(r.from) || !validIso(r.to)) return "Pick a range";
  const a = parseYmd(r.from);
  const b = parseYmd(r.to);
  const mon = (d: Date) => MONTHS[d.getMonth()];
  if (r.from === r.to) return `${b.getDate()} ${mon(b)} ${b.getFullYear()}`;
  if (a.getFullYear() !== b.getFullYear()) {
    return `${a.getDate()} ${mon(a)} ${a.getFullYear()} – ${b.getDate()} ${mon(b)} ${b.getFullYear()}`;
  }
  if (a.getMonth() !== b.getMonth()) {
    return `${a.getDate()} ${mon(a)} – ${b.getDate()} ${mon(b)} ${b.getFullYear()}`;
  }
  return `${a.getDate()} – ${b.getDate()} ${mon(b)} ${b.getFullYear()}`;
}

const startOfWeek = (d: Date, weekStartsOn: number): Date =>
  addDays(d, -((d.getDay() - weekStartsOn + 7) % 7));

export function builtInPresets(weekStartsOn: number, now: () => Date = () => new Date()): DateRangePreset[] {
  const today = () => {
    const n = now();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  };
  const span = (a: Date, b: Date): DateRange => ({ from: ymd(a), to: ymd(b) });
  return [
    { label: "Today", range: () => span(today(), today()) },
    { label: "Yesterday", range: () => span(addDays(today(), -1), addDays(today(), -1)) },
    {
      label: "This week",
      range: () => {
        const s = startOfWeek(today(), weekStartsOn);
        return span(s, addDays(s, 6));
      },
    },
    { label: "Last 7 days", range: () => span(addDays(today(), -6), today()) },
    { label: "Last 14 days", range: () => span(addDays(today(), -13), today()) },
    {
      label: "This month",
      range: () => {
        const t = today();
        return span(new Date(t.getFullYear(), t.getMonth(), 1), new Date(t.getFullYear(), t.getMonth() + 1, 0));
      },
    },
    {
      label: "Last month",
      range: () => {
        const t = today();
        return span(new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0));
      },
    },
  ];
}

function useWide(): boolean {
  const q = "(min-width: 640px)";
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false);
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(q);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return wide;
}

/** Pill trigger, same look as DatePicker / the header filter pills. */
const PILL_TRIGGER =
  "h-9 gap-2 rounded-full border-transparent bg-card px-4 text-xs font-medium tabular-nums text-foreground shadow-[var(--sd-shadow-1)] hover:bg-card hover:text-foreground hover:shadow-[var(--sd-shadow-2)] [&>svg]:text-[var(--sd-quiet)]";

const FIELD_TRIGGER =
  "h-9 gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium tabular-nums text-foreground shadow-sm hover:bg-background hover:text-foreground [&>svg]:text-[var(--sd-quiet)]";

const FIELD_INPUT =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 aria-[invalid=true]:border-[var(--sd-data-red)]";

/**
 * One picker for a from/to range. Click a start day then an end day (the
 * second click earlier than the first swaps them), or type the dates, or pick
 * a preset. Two months side by side on wide screens, one on a phone.
 */
export function DateRangePicker({
  value,
  onChange,
  min,
  max,
  presets,
  allowSingleDay = true,
  weekStartsOn = 1,
  disabled,
  label = "Date range",
  className,
  variant = "pill",
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  // anchor = first click waiting for its second; null = nothing pending
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [month, setMonth] = useState<Date>(() => parseYmd(validIso(value.from) ? value.from : ymd(new Date())));
  const [fromText, setFromText] = useState(value.from);
  const [toText, setToText] = useState(value.to);
  const [error, setError] = useState("");
  const wide = useWide();

  const allPresets = useMemo(() => [...builtInPresets(weekStartsOn), ...(presets ?? [])], [weekStartsOn, presets]);

  const inBounds = (iso: string) => (!min || iso >= min) && (!max || iso <= max);
  const clamp = (iso: string) => (min && iso < min ? min : max && iso > max ? max : iso);

  // Keep the typed boxes and visible month in step with the committed value
  // whenever it changes from outside (or after a commit).
  useEffect(() => {
    setFromText(value.from);
    setToText(value.to);
  }, [value.from, value.to]);

  const openChange = (next: boolean) => {
    setOpen(next);
    setAnchor(null);
    setHover(null);
    setError("");
    if (next) {
      setMonth(parseYmd(validIso(value.from) ? value.from : ymd(new Date())));
      setFromText(value.from);
      setToText(value.to);
    }
  };

  const commit = (a: string, b: string) => {
    const [from, to] = a <= b ? [a, b] : [b, a];
    onChange({ from, to });
  };

  const onDay = (day: Date) => {
    const iso = ymd(day);
    if (!inBounds(iso)) return;
    if (anchor == null) {
      setAnchor(iso);
      setFromText(iso);
      setToText("");
      setError("");
      return;
    }
    if (iso === anchor && !allowSingleDay) return;
    commit(anchor, iso);
    setAnchor(null);
    setHover(null);
    setOpen(false);
  };

  const applyPreset = (p: DateRangePreset) => {
    const r = p.range();
    let from = clamp(r.from);
    let to = clamp(r.to);
    if (from > to) to = from;
    if (!allowSingleDay && from === to) return;
    onChange({ from, to });
    setOpen(false);
  };

  /** Validate and apply the two typed boxes; both must be good to commit. */
  const applyTyped = (nextFrom: string, nextTo: string) => {
    const f = parseTypedDate(nextFrom);
    const t = parseTypedDate(nextTo);
    if (!f || !t) {
      const bad = (!f && nextFrom.trim()) || (!t && nextTo.trim());
      setError(bad ? "Enter dates as dd/mm/yyyy or yyyy-mm-dd." : "");
      return;
    }
    if (!inBounds(f) || !inBounds(t)) {
      setError(`Dates must fall between ${min ?? "the earliest day"} and ${max ?? "the latest day"}.`);
      return;
    }
    if (!allowSingleDay && f === t) {
      setError("Pick two different days.");
      return;
    }
    setError("");
    setAnchor(null);
    setMonth(parseYmd(f <= t ? f : t));
    commit(f, t);
  };

  // What the calendar paints: a pending anchor with the hover as its preview,
  // otherwise the committed value.
  const shown: DayRange | undefined = useMemo(() => {
    if (anchor) {
      const other = hover ?? anchor;
      const [a, b] = anchor <= other ? [anchor, other] : [other, anchor];
      return { from: parseYmd(a), to: parseYmd(b) };
    }
    if (validIso(value.from) && validIso(value.to)) return { from: parseYmd(value.from), to: parseYmd(value.to) };
    return undefined;
  }, [anchor, hover, value.from, value.to]);

  const disabledDays = [
    ...(min ? [{ before: parseYmd(min) }] : []),
    ...(max ? [{ after: parseYmd(max) }] : []),
  ];

  const display = formatRange(value);
  const valid = validIso(value.from) && validIso(value.to);

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(variant === "field" ? FIELD_TRIGGER : PILL_TRIGGER, !valid && "text-muted-foreground", className)}
          aria-label={label}
          aria-haspopup="dialog"
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          {display}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={`${label} picker`}
        className="w-auto max-w-[calc(100vw-1rem)] p-0"
        align="start"
      >
        <div className="flex flex-col sm:flex-row">
          <div
            role="group"
            aria-label="Quick ranges"
            className="flex flex-row flex-wrap gap-1 border-b p-2 sm:w-32 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r"
          >
            {allPresets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="rounded-full px-3 py-1 text-left text-xs font-medium text-foreground hover:bg-[var(--sidebar-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div>
            <Calendar
              mode="range"
              numberOfMonths={wide ? 2 : 1}
              month={month}
              onMonthChange={setMonth}
              selected={shown}
              onSelect={() => {}}
              onDayClick={onDay}
              onDayMouseEnter={(d) => anchor && setHover(ymd(d))}
              onDayFocus={(d) => anchor && setHover(ymd(d))}
              onDayMouseLeave={() => setHover(null)}
              disabled={disabledDays}
              weekStartsOn={weekStartsOn}
              ISOWeek={weekStartsOn === 1}
              showWeekNumber={false}
              classNames={{ months: "relative flex flex-col gap-4 sm:flex-row sm:gap-6" }}
            />
            <div className="flex items-end gap-2 border-t p-3">
              <label className="flex flex-1 flex-col gap-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                From
                <input
                  aria-label="From date"
                  inputMode="numeric"
                  placeholder="dd/mm/yyyy"
                  value={fromText}
                  aria-invalid={!!error && !parseTypedDate(fromText)}
                  className={FIELD_INPUT}
                  onChange={(e) => setFromText(e.target.value)}
                  onBlur={() => applyTyped(fromText, toText)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyTyped(fromText, toText);
                    }
                  }}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
                To
                <input
                  aria-label="To date"
                  inputMode="numeric"
                  placeholder="dd/mm/yyyy"
                  value={toText}
                  aria-invalid={!!error && !parseTypedDate(toText)}
                  className={FIELD_INPUT}
                  onChange={(e) => setToText(e.target.value)}
                  onBlur={() => applyTyped(fromText, toText)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyTyped(fromText, toText);
                    }
                  }}
                />
              </label>
            </div>
            <p
              role="alert"
              className={cn("px-3 pb-2 text-[0.7rem] text-[var(--sd-data-red)]", !error && "sr-only")}
            >
              {error}
            </p>
            {anchor && (
              <p className="px-3 pb-2 text-[0.7rem] text-muted-foreground" aria-live="polite">
                Pick the end day.
              </p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
