import { useEffect, useMemo, useState } from "react";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
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
  "h-9 gap-2 rounded-xl border border-input bg-background px-3 text-sm font-medium tabular-nums text-foreground shadow-sm hover:bg-background hover:text-foreground [&>svg]:text-[var(--sd-quiet)]";

/**
 * One picker for a from/to range. Click a start day then an end day (the
 * second click earlier than the first swaps them) or pick a preset. There are
 * no typed fields: picking is the only way in, and the chosen From / To read
 * back as labels. Click the month caption to zoom out to a month grid, and
 * again to a list of years, to jump far quickly. Two months side by side on
 * wide screens, one on a phone.
 */
type View = "days" | "months" | "years";

const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const nice = (iso: string): string => {
  const d = parseYmd(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const GRID_BTN =
  "rounded-full px-2 py-2 text-sm font-medium tabular-nums transition-[transform,background-color,color] duration-150 hover:bg-[var(--sidebar-accent)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:text-muted-foreground/40 disabled:hover:bg-transparent disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100";

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
  const [view, setView] = useState<View>("days");
  const [slide, setSlide] = useState<{ dir: "none" | "next" | "prev"; tick: 0 | 1 }>({ dir: "none", tick: 0 });
  const wide = useWide();

  const allPresets = useMemo(() => [...builtInPresets(weekStartsOn), ...(presets ?? [])], [weekStartsOn, presets]);

  const inBounds = (iso: string) => (!min || iso >= min) && (!max || iso <= max);
  const clamp = (iso: string) => (min && iso < min ? min : max && iso > max ? max : iso);

  const openChange = (next: boolean) => {
    setOpen(next);
    setAnchor(null);
    setHover(null);
    setView("days");
    setSlide({ dir: "none", tick: 0 });
    if (next) setMonth(parseYmd(validIso(value.from) ? value.from : ymd(new Date())));
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

  const changeMonth = (next: Date) => {
    const dir = next.getTime() === month.getTime() ? "none" : next > month ? "next" : "prev";
    setSlide((t) => ({ dir, tick: t.tick ? 0 : 1 }));
    setMonth(next);
  };

  const monthOk = (y: number, m: number) => {
    const first = ymd(new Date(y, m, 1));
    const last = ymd(new Date(y, m + 1, 0));
    return (!min || last >= min) && (!max || first <= max);
  };
  const yearOk = (y: number) => (!min || `${y}-12-31` >= min) && (!max || `${y}-01-01` <= max);

  const year = month.getFullYear();
  const yearStart = Math.floor(year / 12) * 12;

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
            <div
              className="flex items-center gap-x-2 gap-y-0.5 border-b px-3 py-2 text-xs tabular-nums"
              aria-live="polite"
              data-testid="range-readout"
            >
              <span className="text-muted-foreground">From</span>{" "}
              <span className="font-medium text-foreground">{anchor ? nice(anchor) : valid ? nice(value.from) : "—"}</span>{" "}
              <span className="text-muted-foreground">·</span>{" "}
              <span className="text-muted-foreground">To</span>{" "}
              <span className="font-medium text-foreground">
                {anchor ? "pick the end day" : valid ? nice(value.to) : "—"}
              </span>
            </div>
            {view === "days" && (
              <div
                className="scp-cal-slide"
                data-dir={slide.dir}
                data-tick={slide.tick}
                data-testid="day-view"
              >
                <Calendar
                  mode="range"
                  numberOfMonths={wide ? 2 : 1}
                  month={month}
                  onMonthChange={changeMonth}
                  onCaptionClick={() => setView("months")}
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
              </div>
            )}
            {view === "months" && (
              <div className="scp-cal-zoom w-[17.5rem] p-3 sm:w-[20rem]" data-testid="month-view">
                <div className="mb-2 flex items-center justify-between">
                  <button type="button" aria-label="Previous year" className={cn(GRID_BTN, "p-1.5")} onClick={() => changeMonth(new Date(year - 1, month.getMonth(), 1))}>
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button type="button" aria-label="Choose year" className={GRID_BTN} onClick={() => setView("years")}>
                    {year}
                  </button>
                  <button type="button" aria-label="Next year" className={cn(GRID_BTN, "p-1.5")} onClick={() => changeMonth(new Date(year + 1, month.getMonth(), 1))}>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {MONTH_LONG.map((name, i) => {
                    const chosen = [anchor ?? value.from, anchor ? null : value.to].some(
                      (iso) => iso && validIso(iso) && parseYmd(iso).getFullYear() === year && parseYmd(iso).getMonth() === i,
                    );
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-label={`${name} ${year}`}
                        disabled={!monthOk(year, i)}
                        className={cn(GRID_BTN, chosen && "bg-foreground/10 font-semibold")}
                        onClick={() => {
                          changeMonth(new Date(year, i, 1));
                          setView("days");
                        }}
                      >
                        {MONTHS[i]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {view === "years" && (
              <div className="scp-cal-zoom w-[17.5rem] p-3 sm:w-[20rem]" data-testid="year-view">
                <div className="mb-2 flex items-center justify-between">
                  <button type="button" aria-label="Previous years" className={cn(GRID_BTN, "p-1.5")} onClick={() => changeMonth(new Date(year - 12, month.getMonth(), 1))}>
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm font-medium tabular-nums">
                    {yearStart} – {yearStart + 11}
                  </span>
                  <button type="button" aria-label="Next years" className={cn(GRID_BTN, "p-1.5")} onClick={() => changeMonth(new Date(year + 12, month.getMonth(), 1))}>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {Array.from({ length: 12 }, (_, i) => yearStart + i).map((y) => (
                    <button
                      key={y}
                      type="button"
                      aria-label={`Year ${y}`}
                      disabled={!yearOk(y)}
                      className={cn(GRID_BTN, y === year && "bg-foreground/10 font-semibold")}
                      onClick={() => {
                        changeMonth(new Date(y, month.getMonth(), 1));
                        setView("months");
                      }}
                    >
                      {y}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
