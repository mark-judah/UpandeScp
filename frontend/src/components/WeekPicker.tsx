import { useMemo, useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn, isoWeek, parseYmd, ymd } from "@/lib/utils";

export interface WeekRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface WeekPickerProps {
  value: WeekRange;
  onChange: (next: WeekRange) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
}

const MON = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const mondayOf = (d: Date): Date => {
  const x = new Date(d);
  const wd = (x.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  x.setDate(x.getDate() - wd);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const shortDate = (s: string): string => {
  const d = parseYmd(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/**
 * Week-first range picker. Selecting any date highlights its whole ISO week
 * (Mon–Sun) and sets the range to that week. A Mon–Sun chip row below the
 * calendar narrows the range to specific days within the selected week: tap a
 * start day, then an end day; "Whole week" resets. The value is always a
 * from/to pair that stays inside one ISO week.
 */
export function WeekPicker({
  value,
  onChange,
  label,
  className,
  disabled,
}: WeekPickerProps) {
  const [open, setOpen] = useState(false);
  // Pending start day while building a sub-range from the chips.
  const [pendingStart, setPendingStart] = useState<string | null>(null);

  const anchorMonday = useMemo(
    () => mondayOf(parseYmd(value.from || ymd(new Date()))),
    [value.from],
  );
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => ymd(addDays(anchorMonday, i))),
    [anchorMonday],
  );
  const weekNo = useMemo(() => isoWeek(anchorMonday), [anchorMonday]);
  const isWholeWeek = value.from === weekDays[0] && value.to === weekDays[6];

  const display = useMemo(() => {
    if (!value.from) return "Pick a week";
    if (isWholeWeek) return `W${weekNo} · ${shortDate(value.from)} – ${shortDate(value.to)}`;
    if (value.from === value.to) return `W${weekNo} · ${shortDate(value.from)}`;
    return `W${weekNo} · ${shortDate(value.from)} – ${shortDate(value.to)}`;
  }, [value.from, value.to, isWholeWeek, weekNo]);

  // Highlight the selected week in the calendar grid.
  const weekModifier = useMemo(() => weekDays.map((s) => parseYmd(s)), [weekDays]);

  const selectWeek = (d: Date) => {
    const mon = mondayOf(d);
    setPendingStart(null);
    onChange({ from: ymd(mon), to: ymd(addDays(mon, 6)) });
  };

  const tapDay = (day: string) => {
    if (pendingStart == null) {
      setPendingStart(day);
      onChange({ from: day, to: day });
      return;
    }
    const a = pendingStart < day ? pendingStart : day;
    const b = pendingStart < day ? day : pendingStart;
    setPendingStart(null);
    onChange({ from: a, to: b });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            // Pill trigger — matches the DatePicker / header dropdowns.
            "h-9 gap-2 rounded-full border-transparent bg-card px-4 text-xs font-medium tabular-nums text-foreground shadow-[var(--sd-shadow-1)] hover:bg-card hover:text-foreground hover:shadow-[var(--sd-shadow-2)] [&>svg]:text-[var(--sd-quiet)]",
            !value.from && "text-muted-foreground",
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
          selected={value.from ? parseYmd(value.from) : undefined}
          onSelect={(d) => {
            if (d) selectWeek(d);
          }}
          modifiers={{ week: weekModifier }}
          modifiersClassNames={{
            week: "bg-accent/60 text-accent-foreground rounded-none",
          }}
        />
        <div className="border-t p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[0.7rem] uppercase tracking-wide font-semibold text-muted-foreground">
              {pendingStart ? "Tap the end day" : "Narrow to days"}
            </span>
            <button
              type="button"
              className="text-[0.65rem] px-2 py-0.5 rounded border bg-card hover:bg-muted"
              onClick={() => {
                setPendingStart(null);
                onChange({ from: weekDays[0], to: weekDays[6] });
              }}
            >
              Whole week
            </button>
          </div>
          <div className="flex gap-1">
            {weekDays.map((day, i) => {
              const inRange = day >= value.from && day <= value.to && !pendingStart;
              const isPending = pendingStart === day;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => tapDay(day)}
                  className={cn(
                    "flex flex-col items-center justify-center rounded-md border w-9 py-1 text-[0.65rem] tabular-nums transition-colors hover:bg-muted",
                    (inRange || isPending) &&
                      "bg-primary text-primary-foreground border-primary hover:bg-primary",
                  )}
                  title={day}
                >
                  <span className="opacity-80">{MON[i]}</span>
                  <span className="font-semibold">{parseYmd(day).getDate()}</span>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
